// 一次压缩的事务：校验 -> 按"从最前面往后"的顺序逐个落盘。
// 每个子事务四步：压缩开始 -> 摘要 -> 替代表层 -> 压缩结束。
// 失败必须补结束事件：留下未配对的开始会让这条会话此后任何压缩都被拒。

import { userMessage } from './messages.js'
import { estimateTokens, hostTokens, messageTokens } from './tokens.js'
import {
  CHECKPOINT_PREAMBLE,
  SUMMARY_CLOSE_TAG,
  SUMMARY_OPEN_TAG,
  TITLE_CLOSE,
  TITLE_OPEN,
} from './config.js'
import { canCompressZone, isTurnBoundaryPair, lastCompressibleTurn, readZones, resolveTurnAnchor, resolveZoneIndex, stripTitle } from './blocks.js'
import { check, consume } from './license.js'

const CHECKPOINT_KIND = 'compact-checkpoint'
const TIER_OF_KEY = { l0: 1, l1: 2, l2: 3, l3: 3 }
const KEYS = ['l3', 'l2', 'l1', 'l0']
const FIELD_NAMES = ['title', 'summary', 'to']

// 填表格式校验：格式错就一次性说清楚错在哪、该长什么样，别让模型猜。
function checkShape(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, reason: '参数必须是对象，形如 {"l0":{"title":"…","summary":"…","to":"T19"},"l1":{"title":"…","summary":"…","to":"3"}}（l0 的 to 是轮号，l1/l2 的 to 是块序号，l3 不写 to）' }
  }
  const unknown = Object.keys(args).filter((k) => !KEYS.includes(k))
  if (unknown.length) {
    return {
      ok: false,
      reason: `不认识这些键：${unknown.join('、')}。只能写 l3 / l2 / l1 / l0，每个键的值是 {title, summary, to}（l3 不写 to）`,
    }
  }
  const given = KEYS.filter((k) => args[k] !== undefined)
  if (!given.length) return { ok: false, reason: '至少要给 l3 / l2 / l1 / l0 里的一个键' }
  for (const key of given) {
    const spec = args[key]
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      return { ok: false, reason: `${key} 的值必须是一个对象，形如 {"title":"…","summary":"…","to":"…"}` }
    }
    const extra = Object.keys(spec).filter((k) => !FIELD_NAMES.includes(k))
    if (extra.length) {
      return { ok: false, reason: `${key} 里不认识这些字段：${extra.join('、')}；只接受 title / summary / to` }
    }
    if (typeof spec.title !== 'string') return { ok: false, reason: `${key}.title 必须是字符串` }
    if (typeof spec.summary !== 'string') return { ok: false, reason: `${key}.summary 必须是字符串` }
    const to = spec.to
    if (to !== undefined && typeof to !== 'string' && typeof to !== 'number') {
      return {
        ok: false,
        reason: `${key}.to 要写成字符串：l0 写 "T19" 这种轮号，l1/l2 写 "3" 这种块序号（都从地图抄）；l3 不写 to`,
      }
    }
    if (key === 'l3' && to !== undefined) return { ok: false, reason: 'l3 不写 to：它一次把整个 L3 区压成一块' }
    if (key !== 'l3' && to === undefined) {
      return { ok: false, reason: `${key} 必须写 to：${key === 'l0' ? '轮锚点 T19' : '该区从 1 起的块序号'}，从地图里抄` }
    }
  }
  return { ok: true }
}

export async function runCompress(ctx, agent, args, config) {
  const session = ctx.sessions.get(agent.id)
  if (!session) return fail('拿不到当前会话，无法压缩')

  // 先查许可证：没看过地图、或地图之后表层被改过，都不许压。
  const license = check(agent.id, session)
  if (license) return fail(license)

  // 0) 先看填表格式对不对：格式错就没必要再往下算区间了
  const shape = checkShape(args)
  if (!shape.ok) return fail(shape.reason)

  // 0.5) 让宿主先剪一遍超大的工具结果：单条太大归它，条数太多归我们。
  //      pruner 与宿主的 auto 无关，但关掉 auto 之后没人叫它，所以由我们在压缩前显式调。
  let prunedChars = 0
  if (config.pruneFirst) {
    try {
      const pruner = ctx.get('toolResultPruner')
      if (pruner) {
        const r = pruner.pruneSession(session)
        prunedChars = (r && typeof r.charsRemoved === 'number') ? r.charsRemoved : 0
      }
    } catch { /* 剪枝失败不影响压缩本身 */ }
  }

  // 读一次表层：四区、当前轮、每个块的身份都从它推出来（不读日志、不读台账）。
  const zones = readZones(ctx, session)
  const meter = ctx.tokenMeter

  // 表层里有内容为空的节点、而且已经有压缩块时，块在哪一行推不出来。
  // 注意这里已经不是"宿主的常态"：`deriveExactly()` 能逐个节点投影（见 blocks.js），
  // 只有那条路也失效（`session.log` 不是数组、事件读不到、投影抛错）才会走到这里。
  // 所以这句话要说得比"这一版压不了"更准确：是宿主接口退化，不是历史坏了。
  if (zones.ambiguous) {
    return fail(
      '这一版不敢压：表层里有空步骤（宿主把没内容的消息跳过了），而表层上已经有压缩块，' +
      '插件拿不到逐节点的映射，块的位置推不出来。压错了会把旧摘要再压成一份新的，原文找不回来。' +
      '别用宿主自带的 /compact 顶替（它会把分层拍平）；先照常对话，等宿主恢复逐节点投影后会自动好转'
    )
  }

  // 1) 先把每个键翻译成一段真实区间，全部算完再落盘（一个键失败整批不写）。
  //    遍历顺序按时间线：最老的一层先算，跟模型填表的顺序一致。
  const ops = []
  for (const key of ['l3', 'l2', 'l1', 'l0']) {
    const spec = args[key]
    if (!spec) continue
    const built = buildOp(key, spec, zones, config, meter)
    if (!built.ok) return fail(built.reason)
    ops.push(built.op)
  }
  if (!ops.length) return fail('没有指定要压哪一层：至少要给 l0 / l1 / l2 / l3 里的一个')

  // 2) 区间不能重叠
  for (let i = 0; i < ops.length; i++) {
    for (let j = i + 1; j < ops.length; j++) {
      if (overlaps(ops[i], ops[j])) {
        return fail(`${ops[i].key} 和 ${ops[j].key} 选的区间有重叠，一次只能压互不相交的几段`)
      }
    }
  }

  // 3) 级联前提：压第 n 层，比它浅的层必须一起压。
  //    模型可能只想动 l2，但 l0/l1 还没压完——那样 l2 的产物底下压着的原文并没有变少。
  const cascade = checkCascade(args, zones, config.keepTurns)
  if (!cascade.ok) return fail(cascade.reason)

  // 4) 整批预演：每一层先在"只校验、不写入"的模式下走一遍。
  //    任何一层过不了，整批一个字都不写——不会出现"前面的写进去了、后面的不合格"。
  ops.sort((a, b) => a.startIdx - b.startIdx)
  for (const op of ops) {
    const pre = commitOne(ctx, session, agent, op, meter, config, zones, true)
    if (!pre.ok) return fail(`整批预演没通过，一个字都没写。${pre.reason}`)
  }

  // 5) 逐个子事务落盘（按表层位置从最前到最后）
  const results = []
  for (const op of ops) {
    // 每个子事务前重算一次被遮蔽节点：前面的写入会改变下标
    const r = commitOne(ctx, session, agent, op, meter, config, zones)
    if (!r.ok) return fail(r.reason, results)
    results.push(r.result)
  }
  // 压成功了，这张地图用掉了：想再压必须重新看一遍地图。
  consume(agent.id)
  return { ok: true, results, prunedChars }
}

function buildOp(key, spec, zones, config, meter) {
  const title = typeof spec.title === 'string' ? spec.title.trim() : ''
  const summary = typeof spec.summary === 'string' ? spec.summary : ''
  const maxTitle = (config.title && config.title.maxTokens) || 50
  if (!title) return { ok: false, reason: `${key} 少了一句标题：地图每块只显示这一句，必须给` }
  const titleTokens = estimateTokens(title)
  if (titleTokens > maxTitle) {
    return { ok: false, reason: `${key} 的标题约 ${titleTokens} token，上限 ${maxTitle}，请改成电报体` }
  }
  if (!summary.trim()) return { ok: false, reason: `${key} 的摘要正文是空的` }
  // 长度按等效 token 算（中文 1 字 = 1，其他 4 字符 = 1）：同一把尺子，中英文不会被同一个数字卡出两种结果。
  const summaryTokens = estimateTokens(summary)
  const targetLayer = key === 'l0' ? 'l1' : key === 'l1' ? 'l2' : 'l3'
  const cap = config.segment[targetLayer]
  if (summaryTokens > cap) {
    return {
      ok: false,
      reason: `${key} 的摘要正文约 ${summaryTokens} token，超过 ${targetLayer.toUpperCase()} 单块上限 ${cap}`,
    }
  }

  if (key === 'l0') {
    const r = resolveTurnAnchor(zones, spec.to, config.keepTurns)
    if (!r.ok) return { ok: false, reason: r.reason }
    // 大纲自检没过时，锚点可能指到别的轮上；这类情况只有 l0 受影响（l1/l2 按块序号）。
    if (zones.outlineFault) {
      return {
        ok: false,
        reason:
          (zones.outlineFault === 'current'
            ? '轮次大纲跟表层对不上：当前轮在表层上一个节点都没有（大纲可能超前）。这一版不敢压 l0，怕把正在进行的轮当已结束轮压掉。'
            : '轮次大纲不连续（缺轮或乱序），这一版判不准每一轮到哪儿结束，压不了 l0。') +
          '别用宿主自带的 /compact 顶替——它会把分层拍平、原文再也取不回。l1 / l2 的位置不受影响；但 l0 还能压时，级联仍要求同一批里给它',
      }
    }
    const first = zones.zones.l0[0]
    if (!first) return { ok: false, reason: '原文区已经空了，没有可压的原文' }
    const op = makeOp(key, first.seq, r.seq, zones, { title, summary })
    const impure = impureRange(key, op, zones)
    if (impure) return { ok: false, reason: impure }
    // 区间里夹着的旧块，块头写的上限轮不能超过 to，否则说明块头快照跟实际对不上，
    // 压下去会把不在 to 名下的内容一起吸走（块头的轮号还会被新一代继承，错了会一直传）。
    const toTurn = Number(/^T(\d+)$/.exec(String(spec.to || '').trim())[1])
    for (let i = op.startIdx; i <= op.endIdx; i += 1) {
      const entry = zones.info.get(zones.nodes[i])
      if (!entry || entry.kind !== 'block') continue
      const turns = entry.block && Array.isArray(entry.block.turns) ? entry.block.turns : []
      // 块头知道自己盖到哪儿才有资格比较：`T?`（完全没有轮号）和 `T16–T19+`
      // （下限，实际更宽）都不能用来证明"这块在 to 以内"。宁可拒这一次。
      if (entry.block.turnsOpen || turns.some((t) => typeof t !== 'number')) {
        return {
          ok: false,
          reason:
            `区间里有一块（L${entry.block.tier}）的块头没有轮号，查不出它盖到第几轮，` +
            '压下去可能把 to 之外的轮次一并吸走。先把这块往深层压（l1 / l2），把原文区让出来再压 l0',
        }
      }
      const hi = turns[1]
      if (typeof hi === 'number' && hi > toTurn) {
        return {
          ok: false,
          reason:
            `区间里有一块（L${entry.block.tier}，块头写着盖到 T${hi}）超出了 to=T${toTurn} 的范围，` +
            '说明这一块的轮号跟表层对不上，压下去会把它一并吸走。先别压 l0——重看一次地图，或者先把这块往深层压',
        }
      }
    }
    return { ok: true, op }
  }

  if (key === 'l1') {
    const r = resolveZoneIndex(zones, 'l1', spec.to)
    if (!r.ok) return { ok: false, reason: r.reason }
    const first = zones.zones.l1[0]
    if (!first) return { ok: false, reason: 'L1 区是空的，没有可合并的块' }
    const op = makeOp(key, first.seq, r.seq, zones, { title, summary })
    const impure = impureRange(key, op, zones)
    if (impure) return { ok: false, reason: impure }
    return { ok: true, op }
  }

  if (key === 'l2') {
    const r = resolveZoneIndex(zones, 'l2', spec.to)
    if (!r.ok) return { ok: false, reason: r.reason }
    const first = zones.zones.l2[0]
    if (!first) return { ok: false, reason: 'L2 区是空的，没有可合并的块' }
    // 区间只取 L2 区，不吸收 L3 区：产物自成一块落在 L2 区原位（替换后自然顶到旧 L3 块下面），
    // 旧的 L3 块原样不动、不拼接、不合并（见 commitOne 里 op.l2Recompute 分支）。
    const op = makeOp(key, first.seq, r.seq, zones, { title, summary, l2Recompute: true, l2To: spec.to })
    const impure = impureRange(key, op, zones)
    if (impure) return { ok: false, reason: impure }
    return { ok: true, op }
  }

  // l3：整个 L3 区压成一块，不接受 to
  if (spec.to !== undefined) return { ok: false, reason: 'l3 不能写 to：它一次把整个 L3 区压成一块' }
  const list = zones.zones.l3
  if (!list.length) return { ok: false, reason: 'L3 区是空的，没有可压缩的块' }
  const l3op = makeOp('l3', list[0].seq, list[list.length - 1].seq, zones, { title, summary })
  const l3impure = impureRange('l3', l3op, zones)
  if (l3impure) return { ok: false, reason: l3impure }
  return { ok: true, op: l3op }
}

function makeOp(key, startSeq, endSeq, zones, extra) {
  const startIdx = zones.nodes.indexOf(startSeq)
  const endIdx = zones.nodes.indexOf(endSeq)
  return { key, startSeq, endSeq, startIdx, endIdx, ...extra }
}

// 区间里是不是只有"本区的东西"。
//
// 为什么必须查：块是按**块头**分层的（blocks.js 只看 `〔L2｜…〕` 那行），不看它在表层上的位置。
// 只要出现一个"块头层级与位置不一致"的块（用户先跑过宿主 /compact、别的插件写过检查点、
// 文件被手改过），l1 的区间就可能从第一块量到最后一块、中间夹着原文甚至当前轮。
// 宿主对 replace 只拦 node 0 和工具结果改写，不拦"横跨区界"，于是当前轮会被一起压掉，
// 或者一对调用/结果被切开——下一次请求直接被服务端 400 拒。
// 所以每一层都要求：区间内每个节点的身份都必须属于这一层。
// 导出只为测试：区间纯度与批次快照的判定都要能单独喂样例。
export function impureRange(key, op, zones) {
  if (op.startIdx < 0 || op.endIdx >= zones.nodes.length || op.endIdx < op.startIdx) {
    return (
      `${key} 的区间在表层上找不到（起止下标 ${op.startIdx}/${op.endIdx}，表层共 ${zones.nodes.length} 个节点）` +
      '——重看一次地图再压'
    )
  }
  const want = key === 'l0' ? null : key === 'l1' ? 1 : key === 'l2' ? 2 : 3
  for (let i = op.startIdx; i <= op.endIdx; i += 1) {
    const entry = zones.info.get(zones.nodes[i])
    const isBlock = !!(entry && entry.kind === 'block')
    if (want === null) {
      if (isBlock) {
        return (
          `原文区这一段的中间夹着一个压缩块（L${entry.block.tier}，块头写着 ${entry.block.title || '无标题'}）。` +
          '块的位置和它的层级对不上，直接压会把这块前后的内容一起遮掉。' +
          '先把这块往深层压（l1 / l2 能吸收它），把原文区腾成纯原文再压 l0'
        )
      }
      continue
    }
    if (!isBlock) {
      return (
        `${key} 的区间里混进了原文（第 ${i} 个节点不是 ${key.toUpperCase()} 块）。` +
        '块的层级和位置对不上，这一段不能整段替换——先把原文区清干净，或者改压别的层'
      )
    }
    if (entry.block.tier !== want) {
      return (
        `${key} 的区间里混进了一个 L${entry.block.tier} 块（第 ${i} 个节点），` +
        `不是 ${key.toUpperCase()} 块。块的层级和位置对不上，这一段不能整段替换——先把它按真层级压上去`
      )
    }
  }
  return null
}

function overlaps(a, b) {
  return a.startIdx <= b.endIdx && b.startIdx <= a.endIdx
}

// 级联前提：要压某一层，比它浅的、还能压的层必须同时压。
// 判据是"还能压"而不是"还有内容"——某层只剩 1 块（最后一块不压）、或者原文区只剩
// 被 keepTurns 护住的最后几轮时，那一层本来就没得压，再要求它一起压就会把整批锁死。
function checkCascade(args, zones, keepTurns = 0) {
  const order = ['l0', 'l1', 'l2', 'l3']
  const label = { l0: '原文区', l1: 'L1 区', l2: 'L2 区' }
  // 报"可压的张数"，不是"张数"：l1/l2 的最后一块按设计不压，
  // 报总数会把模型引去压那一块，然后被"最后一块不能压，最多写到 N−1"再顶回来，白跑一趟。
  const pending = (key) => {
    if (key === 'l0') {
      const cutoff = lastCompressibleTurn(zones, keepTurns)
      if (cutoff === null) return 0
      return (zones.zones.l0 || []).filter((n) => typeof n.turn === 'number' && n.turn <= cutoff).length
    }
    return Math.max(0, (zones.zones[key] || []).length - 1)
  }
  for (const key of ['l3', 'l2', 'l1']) {
    if (!args[key]) continue
    const shallower = order.slice(0, order.indexOf(key))
    const missing = shallower.filter((k) => !args[k] && canCompressZone(zones, k, keepTurns))
    if (!missing.length) continue
    const detail = missing.map((k) => `${label[k]}还有 ${pending(k)} ${k === 'l0' ? '段原文' : '块'}没压`).join('、')
    const hints = missing.map((k) => `${k} 的 to 可以写 ${anchorHint(zones, k, keepTurns)}`).join('；')
    return {
      ok: false,
      reason:
        `要压 ${key}，就必须同时压 ${missing.join('、')}——${detail}。` +
        '一次调用把所有该压的键一起给完（填表顺序 l3 → l2 → l1 → l0），别只动深层。' +
        `补的时候：${hints}`,
    }
  }
  return { ok: true }
}

// 拒绝时直接告诉模型"那一层的 to 能写什么"，省掉它再算一遍（多数拒绝只差这一个数字）。
function anchorHint(zones, key, keepTurns = 0) {
  if (key === 'l0') {
    const cutoff = lastCompressibleTurn(zones, keepTurns)
    if (cutoff === null) return '（暂时没有可压的轮）'
    const lo = zones.zones.l0.filter((n) => typeof n.turn === 'number' && n.turn <= cutoff).map((n) => n.turn)
    if (!lo.length) return '（暂时没有可压的轮）'
    const first = Math.min(...lo)
    return first === cutoff ? `T${first}` : `T${first}–T${cutoff} 里的一个`
  }
  const list = zones.zones[key] || []
  const max = list.length - 1
  if (max < 1) return '（这一层暂时没得压）'
  return max === 1 ? '1' : `1–${max} 里的一个`
}

function commitOne(ctx, session, agent, op, meter, config, zones, dry = false) {
  // 每次落盘前重读一次表层：同批里排在前面（更老）的层已经写进去了，
  // 它们的替换会把后面的节点下标整体往前挪。沿用批次开始时的快照，
  // 就会出现"用新下标去比旧边界表"——非 exact 分支（消息数与节点数不等）会因此
  // 在第二个键上判边界失败，甚至在偏移后巧合命中别的轮的边界而放行一个没对齐的区间。
  let live = readZones(ctx, session)
  let body = op.summary
  let startSeq = op.startSeq
  let endSeq = op.endSeq
  // L3 区是多块区：L2 的产物自成一块，落在 L3 区末尾（区间起点就是 L2 区第一块，
  // 替换之后新块自然顶到旧 L3 块的下面 = L3 区尾部）。旧 L3 块原样不动，不拼接、不合并。
  if (op.l2Recompute) {
    const target = live.zones.l2[Number(op.l2To) - 1]
    if (!target) {
      return { ok: false, reason: 'L2 区的块在写入前变了（同一次调用里被前面的操作改过）——照本次结果里附的新地图改一处再试' }
    }
    startSeq = live.zones.l2[0].seq
    endSeq = target.seq
    body = op.summary
  }

  const nodes = live.nodes
  const startIdx = nodes.indexOf(startSeq)
  const endIdx = nodes.indexOf(endSeq)
  if (startIdx < 0 || endIdx < 0 || startIdx > endIdx) {
    return { ok: false, reason: `${op.key} 选的区间在表层上已经找不到了（地图过期或被别的东西改过）——照本次结果里附的新地图改一处再试` }
  }

  // 表层节点与派生消息不一定一一对应：宿主会把派生为空的节点跳过（被 max_tokens 截断的空
  // 助手消息、空的注入消息）。以前这里一律拒绝，结果是一条会话一旦出现空节点，此后永远压不了。
  // 现在：只要能按节点认出"这一条的消息"（`live.messageFor`，来自 blocks.js 的精确投影），
  // 就照旧逐条查工具调用配对（最严，且对块起点也成立）；
  // 只有连精确映射都拿不到时，才退回"区间两端必须是整轮边界"这条更粗的判据。
  const messages = session.deriveMessages()
  const mapped = live.aligned === true
  if (mapped) {
    const unbalanced = checkPairing(live, startIdx, endIdx)
    if (unbalanced) return { ok: false, reason: `${op.key}：${unbalanced}` }
  } else {
    const aligned = isTurnBoundaryPair(live, startIdx, endIdx)
    if (aligned === null) {
      return {
        ok: false,
        reason:
          `会话派生消息数（${messages.length}）与表层节点数（${nodes.length}）对不上，` +
          '而且拿不到轮次大纲，就没法确认区间两端落在整轮边界上。' +
          '这一版压不了——不是坏了，等宿主把轮次大纲投影挂上就能继续。' +
          '宿主自带的 /compact 会把分层全部拍平、原文再也取不回，不要用它代替 compress。',
      }
    }
    if (!aligned) {
      return {
        ok: false,
        reason:
          `${op.key} 这个区间两端没落在整轮边界上（拿到的起止下标 ${startIdx}/${endIdx}）。` +
          `这次会话里有 ${nodes.length - messages.length} 个空节点，宿主会跳过它们，消息与节点对不上，` +
          '所以只能整轮整轮地压。把 to 挪到某一轮真正结束的位置（对照地图上可压的轮号），' +
          '（to 只能往回调，不能往前加。）',
      }
    }
  }

  const shadowedSeqs = nodes.slice(startIdx, endIdx + 1)
  const product = frame(op.key, op.title, body, shadowedSeqs, live, session)

  const compactionId = `ic-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  // 块正文自带一行取回线索：模型要知道"这块底下压着的原文还能按事件编号读回来"，
  // 否则它永远等于不知道有取回这回事，只会越写越啰嗦。
  const hint = `\n\n〔这块压掉了 ${shadowedSeqs.length} 条消息（事件号 ${shadowedSeqs[0]}–${shadowedSeqs[shadowedSeqs.length - 1]}）。需要原文时用会话搜索按事件号查看。〕`
  // 图片台账落在块正文的**最后一行**（规范 §17）：取回线索常驻、台账按需有，
  // 顺序反了的话，模型顺着"末行"去找会先撞上取回线索。
  const ledger = imageLedger(live, shadowedSeqs).line
  const message = userMessage({
    content: [{ type: 'text', text: product + hint + ledger }],
    source: { kind: CHECKPOINT_KIND, compactionId },
  })

  // 收益校验：用我们自己的估算器。宿主那份按 text.length/4 定价，中英文混排时
  // 两侧偏差不同（英文几乎准、中文低估约 4 倍），比值会失真得很厉害。
  // 事件里的 shadowedTokenCount 仍用宿主的口径，那是宿主的账。
  const before = measureRange(meter, session, shadowedSeqs)
  // 我们自己那份估值；取不到正文（0）时退回宿主口径，别把校验变成"永远不通过"。
  // 消息与节点对不上时没法按下标取原文，只能把尺子整体降级成宿主口径——但两侧仍然同一把，
  // 不做一边宿主一边自研这种不可比的比较。下面 beforeOwn/afterOwn 的成对选择已经保证了这点。
  const beforeOwnRaw = mapped ? ownTokens(live, startIdx, endIdx) : 0
  // 实际写进表层的正文含取回线索，校验必须按它算，否则"通过"之后写出来反而更大。
  // 两侧必须同一把尺子：区间里没有我们能估的内容时（例如整段是未支持的块），
  // 两侧一起退回宿主的 text.length/4，绝不允许一边宿主一边自研——那样比值会失真到没有意义。
  const beforeOwn = beforeOwnRaw > 0 ? beforeOwnRaw : before
  const afterOwn = beforeOwnRaw > 0 ? estimateTokens(product + hint + ledger) : hostTokens(product + hint + ledger)
  if (afterOwn >= beforeOwn) {
    return {
      ok: false,
      reason:
        `${op.key} 压完反而更大（被压 ${beforeOwn} token，压后 ${afterOwn} token），这一层没有写入（同批里排在它前面的层可能已经写进去了）。` +
        '宿主要求替换的内容必须比被替换的更小——把摘要写短一点，或者把区间往大了取。',
    }
  }

  const route = (agent && agent.options) || {}
  const turn = live.currentTurn
  // 预演：所有校验都过了就停在这里，一个字都不写。
  // 调用方先让整批每一层都过一遍预演，全部通过才真的落盘——
  // 这样"第二层不合格"不会发生在"第一层已经写进去"之后。
  if (dry) return { ok: true, result: { key: op.key, dry: true } }
  let started = false
  let stage = 'start'
  try {
    const startEvent = session.append('compaction/start', { compactionId, turn })
    started = true
    stage = 'summary'
    const summaryData = {
      compactionId,
      summary: [{ type: 'text', text: body }],
      shadowedRange: { start: startSeq, end: endSeq },
      shadowedSeqs,
      shadowedTokenCount: before,
      // provider/model 是宿主记录里的常驻字段：读不到路由时写空串而不是省略。
      // 省略在现存日志里没问题，但旧日志升 v4 时会被 assertReleasedEventPayload 判缺字段拒掉。
      provider: typeof route.provider === 'string' ? route.provider : '',
      model: typeof route.model === 'string' ? route.model : '',
    }
    const summaryEvent = session.append('compaction/summary', summaryData)
    stage = 'replace'
    session.append('user/message', message, {
      surfaceOp: { op: 'replace', startSeq, endSeq },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
    })
    stage = 'end'
    session.append('compaction/end', { compactionId, turn })
  } catch (error) {
    const why = String(error && error.message ? error.message : error)
    // 必须补结束，否则这条会话此后所有压缩都会被拒。
    // 但如果开始事件本身就没写进去，补一条结束反而制造孤儿记录。
    if (started) {
      try {
        session.append('compaction/end', { compactionId, turn, error: why })
      } catch (endError) {
        // 补不上就是真的补不上了：宿主会把这条会话的压缩锁一直当成"进行中"，
        // 它自己的 /compact 与自动压缩都会报 busy，只有开新会话能解开。
        // 这件事不能只用一个空 catch 吞掉——必须说给模型和人听。
        return {
          ok: false,
          reason:
            `${op.key} 写到 ${stage} 这一步时失败：${why}；` +
            `而且结束记录也补不上（${String(endError && endError.message ? endError.message : endError)}）。` +
            '这条会话在宿主眼里可能一直停在「压缩进行中」，宿主自带的 /compact 会一直报 busy——' +
            '建议开一条新会话接着做，不要再在这条会话里压。',
        }
      }
    }
    // 已经写进去的 start / summary 会留在日志里：宿主不会因此误锁（它有配对的 end），
    // 但那条 summary 描述了一次没发生的压缩，所以把停在哪一步讲清楚，别让人以为整批都没写。
    const where = stage === 'start' ? '连开始记录都没写进去' : `停在 ${stage} 这一步（前面已写入的记录补了结束标记）`
    return { ok: false, reason: `${op.key} 写入失败：${why}（${where}）` }
  }

  return {
    ok: true,
    result: {
      key: op.key,
      compactionId,
      title: op.title,
      shadowedCount: shadowedSeqs.length,
      shadowedTokenCount: before,
      framedTokenCount: afterOwn,
      savedTokens: Math.max(0, beforeOwn - afterOwn),
    },
  }
}

// 区间边界不能切开一对工具调用与它的结果：切开之后下一轮请求会被服务端拒。
// 判据：区间内开着的工具调用，必须在区间内全部有结果；区间内的结果，也必须有对应的调用。
function checkPairing(zones, startIdx, endIdx) {
  const calls = new Set()
  const results = new Set()
  for (let i = startIdx; i <= endIdx; i++) {
    const seq = zones.nodes[i]
    // 有精确映射时按节点取消息（空节点取到 null，正好跳过），否则退回按下标。
    const message = zones.messageFor ? zones.messageFor(seq) : zones.messages[i]
    if (!message || typeof message !== 'object') continue
    // 结果也可能是独立的 role:'tool' 消息，id 挂在消息顶层（不一定是 content 里的块）。
    if (message.role === 'tool' && message.toolCallId) results.add(String(message.toolCallId))
    const content = message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const id = block.toolCallId || block.id
      if (block.type === 'tool-call' && id) calls.add(String(id))
      if (block.type === 'tool-result' && id) results.add(String(id))
    }
  }
  const unanswered = [...calls].filter((id) => !results.has(id))
  const orphaned = [...results].filter((id) => !calls.has(id))
  if (!unanswered.length && !orphaned.length) return null
  const parts = []
  if (unanswered.length) parts.push(`有 ${unanswered.length} 个工具调用没有结果跟着一起被压`)
  if (orphaned.length) parts.push(`有 ${orphaned.length} 个工具结果找不到对应的调用`)
  return (
    `这个边界会把工具调用和它的结果切开（${parts.join('、')}），` +
    '切开之后下一轮请求会被服务端拒。把 to 往前挪，让整对调用和结果都落在区间里。'
  )
}


// 用我们自己的估算器给一段区间计价：按派生消息里可见的文本累加。
// 不碰 session.eventAt（官方已标弃用、禁止新增调用）。
function safeJson(value) {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}
function ownTokens(zones, startIdx, endIdx) {
  let total = 0
  for (let i = startIdx; i <= endIdx; i++) {
    const seq = zones.nodes[i]
    total += messageTokens(zones.messageFor ? zones.messageFor(seq) : zones.messages[i])
  }
  return total
}
function measureRange(meter, session, seqs) {
  if (!meter || typeof meter.measure !== 'function') return 0
  const m = meter.measure(session)
  const prices = new Map((m.nodes || []).map((n) => [n.seq, n.tokens]))
  let total = 0
  for (const seq of seqs) total += prices.get(seq) || 0
  return total
}

// 块头自带元信息：插件以后不需要任何台账就能知道它是哪一层、盖了哪些轮。
//   〔L2｜T16–T19｜ev 4121–4390〕标题
//
// 图片台账：压掉一块之后，那块里的图片在模型眼里就彻底消失了（宿主的图片离线化只处理
// "最老的图片"，不会因为压缩而单独记一笔）。所以在块正文末尾留一行"这块里有几张图、事件号
// 是多少"，需要看图时能按事件号取回。没有图片时不写这一行——绝大多数块都没有。
function imageSeqs(zones, shadowedSeqs) {
  const out = []
  if (!zones || typeof zones.messageFor !== 'function') return out
  for (const seq of shadowedSeqs) {
    let msg = null
    try { msg = zones.messageFor(seq) } catch { msg = null }
    if (!msg || !Array.isArray(msg.content)) continue
    if (msg.content.some((part) => part && part.type === 'image')) out.push(seq)
  }
  return out
}

// 台账行的拼装单独抽出来，好让测试直接断言"有图才写、写的是哪几个事件号"。
export function imageLedger(zones, shadowedSeqs) {
  const seqs = imageSeqs(zones, shadowedSeqs)
  const line = seqs.length === 0
    ? ''
    : `\n\n〔这块压掉了 ${seqs.length} 张图片（事件号 ${seqs.slice(0, 6).join('、')}${seqs.length > 6 ? ' 等' : ''}）。需要看图时用会话搜索按事件号查看。〕`
  return { seqs, line }
}

function frame(key, title, body, shadowedSeqs, zones, session) {
  const tier = key === 'l0' ? 1 : key === 'l1' ? 2 : 3
  let lo = null, hi = null, evLo = null, evHi = null
  let turnsUnknown = false
  for (const seq of shadowedSeqs) {
    const entry = zones.info.get(seq)
    let turns = null, events = null
    if (entry && entry.kind === 'block') {
      turns = entry.block.turns
      events = entry.block.events
      // 块头带 `+`：说明这块吸收过轮号未知的内容，它写的 hi 只是下限。
      // 再把它吸收一次时，新一代的块头必须继续带 `+`，否则界限会被收窄、越传越窄。
      if (entry.block.turnsOpen) turnsUnknown = true
    } else {
      const raw = zones.zones.l0.find((n) => n.seq === seq)
      if (raw) { turns = [raw.turn, raw.turn]; events = [raw.originSeq, raw.originSeq] }
    }
    if (turns) {
      for (const t of turns) {
        if (typeof t === 'number') { lo = lo === null ? t : Math.min(lo, t); hi = hi === null ? t : Math.max(hi, t) }
        else turnsUnknown = true
      }
    }
    if (events) {
      for (const e of events) if (typeof e === 'number') { evLo = evLo === null ? e : Math.min(evLo, e); evHi = evHi === null ? e : Math.max(evHi, e) }
    }
  }
  // 吸收进来的块里只要有一块不知道自己盖了哪些轮（外来检查点、旧版本写的块），
  // 块头就写成 `T16–T19+`：加号表示"至少到这里，实际可能更宽"。
  // 不标的话，块头会报得比实际窄，之后 l0 的越界检查（块头 hi > to 就拒）就看不见它，
  // 会把不在 to 名下的轮次一起吸进新摘要——静默多压，而且错会被下一代块继承下去。
  const turnPart = lo === null ? 'T?' : (lo === hi ? `T${lo}` : `T${lo}–T${hi}`) + (turnsUnknown ? '+' : '')
  const evPart = evLo === null ? '' : `｜ev ${evLo}–${evHi}`
  const head = `${TITLE_OPEN}L${tier}｜${turnPart}${evPart}${TITLE_CLOSE}${title}`
  return `${head}\n${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}${body}${SUMMARY_CLOSE_TAG}`
}

// 只取 <compacted-summary> 里的正文：块头、宿主前导语、取回线索都是包装，
// 每次吸收都把它们拼进新正文，会让框架文字越滚越多。
function summaryBodyOf(text) {
  const s = String(text || '')
  const open = s.indexOf('<compacted-summary>')
  const close = s.indexOf('</compacted-summary>')
  if (open >= 0 && close > open) return s.slice(open + '<compacted-summary>'.length, close).trim()
  // 没有标签：多半是外来块，保守保留它的整段正文（不猜、不丢）
  return stripTags(stripTitle(s)).trim()
}

function stripTags(text) {
  return text.split(SUMMARY_OPEN_TAG).join('').split(SUMMARY_CLOSE_TAG).join('').trim()
}

function fail(reason, partial) {
  // 万一真写到一半断了：把"哪几层已经进去了"直接写进给人看的话里，
  // 不能只说"整批没写"——那会让模型和人都以为表层没变，接着拿旧地图去压。
  const done = Array.isArray(partial) && partial.length
    ? partial.map((r) => r && r.key ? r.key : '?').join('、')
    : ''
  const text = done ? `${reason}\n（注意：${done} 这几层已经写进会话表层了，旧地图作废，照本次结果里附的新地图再继续。）` : reason
  return { ok: false, reason: text, partial: partial || [] }
}
