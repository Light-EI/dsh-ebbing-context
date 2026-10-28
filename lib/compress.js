// 一次压缩的事务：校验 -> 按"从最前面往后"的顺序逐个落盘。
// 每个子事务四步：压缩开始 -> 摘要 -> 替代表层 -> 压缩结束。
// 失败必须补结束事件：留下未配对的开始会让这条会话此后任何压缩都被拒。

import { userMessage } from './messages.js'
import { estimateTokens } from './tokens.js'
import {
  CHECKPOINT_PREAMBLE,
  SUMMARY_CLOSE_TAG,
  SUMMARY_OPEN_TAG,
  TITLE_CLOSE,
  TITLE_OPEN,
} from './config.js'
import { readZones, resolveTurnAnchor, resolveZoneIndex, stripTitle } from './blocks.js'
import { check, consume } from './license.js'

const CHECKPOINT_KIND = 'compact-checkpoint'
const TIER_OF_KEY = { l0: 1, l1: 2, l2: 3, l3: 3 }
const KEYS = ['l3', 'l2', 'l1', 'l0']
const FIELD_NAMES = ['title', 'summary', 'to']

// 填表格式校验：格式错就一次性说清楚错在哪、该长什么样，别让模型猜。
function checkShape(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, reason: '参数必须是对象，形如 {"l1":{"title":"…","summary":"…","to":"T19"}}' }
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
        reason: `${key}.to 要么是轮锚点 "T19"，要么是该区从 1 起的块序号（数字或字符串）；l3 不写 to`,
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
  const cascade = checkCascade(args, zones)
  if (!cascade.ok) return fail(cascade.reason)

  // 3) 逐个子事务落盘（按表层位置从最前到最后）
  ops.sort((a, b) => a.startIdx - b.startIdx)
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
    const r = resolveTurnAnchor(zones, spec.to)
    if (!r.ok) return { ok: false, reason: r.reason }
    const first = zones.zones.l0[0]
    if (!first) return { ok: false, reason: '原文区已经空了，没有可压的原文' }
    return { ok: true, op: makeOp(key, first.seq, r.seq, zones, { title, summary, title, summary }) }
  }

  if (key === 'l1') {
    const r = resolveZoneIndex(zones, 'l1', spec.to)
    if (!r.ok) return { ok: false, reason: r.reason }
    const first = zones.zones.l1[0]
    if (!first) return { ok: false, reason: 'L1 区是空的，没有可合并的块' }
    return { ok: true, op: makeOp(key, first.seq, r.seq, zones, { title, summary, title, summary }) }
  }

  if (key === 'l2') {
    const r = resolveZoneIndex(zones, 'l2', spec.to)
    if (!r.ok) return { ok: false, reason: r.reason }
    const first = zones.zones.l2[0]
    if (!first) return { ok: false, reason: 'L2 区是空的，没有可合并的块' }
    // 区间先只取 L2 区；落盘时再往前吃掉 L3 区（见 commitOne 的 absorbTopL3）。
    // 这样和同批的 l3 不会重叠：l3 先把整个 L3 区重写成一块，l2 再来吃那一块。
    return {
      ok: true,
      op: makeOp(key, first.seq, r.seq, zones, { title, summary, absorbTopL3: true, l2To: spec.to }),
    }
  }

  // l3：整个 L3 区压成一块，不接受 to
  if (spec.to !== undefined) return { ok: false, reason: 'l3 不需要写 to：它一次把整个 L3 区压成一块' }
  const list = zones.zones.l3
  if (!list.length) return { ok: false, reason: 'L3 区是空的，没有可缩句的块' }
  return {
    ok: true,
    op: makeOp('l3', list[0].seq, list[list.length - 1].seq, zones, { title, summary }),
  }
}

function makeOp(key, startSeq, endSeq, zones, extra) {
  const startIdx = zones.nodes.indexOf(startSeq)
  const endIdx = zones.nodes.indexOf(endSeq)
  return { key, startSeq, endSeq, startIdx, endIdx, ...extra }
}

function overlaps(a, b) {
  return a.startIdx <= b.endIdx && b.startIdx <= a.endIdx
}

// 级联前提：要压某一层，比它浅的、还有内容可压的层必须同时压。
// 浅层空了就不要求（那层已经没东西可压）；当前轮的原文不算"可压内容"，否则永远欠一层。
function checkCascade(args, zones) {
  const order = ['l0', 'l1', 'l2', 'l3']
  const label = { l0: '原文区', l1: 'L1 区', l2: 'L2 区' }
  const pending = (key) => {
    const list = zones.zones[key] || []
    if (key !== 'l0') return list.length
    return list.filter((n) => typeof n.turn === 'number' && n.turn < (zones.currentTurn ?? Infinity)).length
  }
  for (const key of ['l3', 'l2', 'l1']) {
    if (!args[key]) continue
    const shallower = order.slice(0, order.indexOf(key))
    const missing = shallower.filter((k) => !args[k] && pending(k) > 0)
    if (!missing.length) continue
    const detail = missing.map((k) => `${label[k]}还有 ${pending(k)} ${k === 'l0' ? '段原文' : '块'}没压`).join('、')
    return {
      ok: false,
      reason:
        `要压 ${key}，就必须同时压 ${missing.join('、')}——${detail}。` +
        '一次调用把所有该压的键一起给完（填表顺序 l3 → l2 → l1 → l0），别只动深层。',
    }
  }
  return { ok: true }
}

function commitOne(ctx, session, agent, op, meter, config, zones) {
  // l2 的区间要往前吃掉 L3 区。同批若有 l3，它已经把整个 L3 区重写过了，
  // 所以这里必须按"当前表层"重算，而不是用建表时的区间。
  let live = zones
  let body = op.summary
  let startSeq = op.startSeq
  let endSeq = op.endSeq
  if (op.absorbTopL3) {
    live = readZones(ctx, session)
    const target = live.zones.l2[Number(op.l2To) - 1]
    if (!target) {
      return { ok: false, reason: 'L2 区的块在写入前变了（同一次调用里被前面的操作改过），请重新取一次地图' }
    }
    const top = live.zones.l3[0]
    // L3 区可能不止一块：从最上面那块起一起吃掉，正文按表层顺序接上去，一块都不能丢。
    const prefix = live.zones.l3.map((b) => stripTags(stripTitle(b.text))).filter(Boolean).join('\n\n')
    startSeq = top ? top.seq : live.zones.l2[0].seq
    endSeq = target.seq
    body = prefix ? `${prefix}\n\n${op.summary}` : op.summary
  }

  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(startSeq)
  const endIdx = nodes.indexOf(endSeq)
  if (startIdx < 0 || endIdx < 0 || startIdx > endIdx) {
    return { ok: false, reason: `${op.key} 选的区间在表层上已经找不到了（地图过期或被别的东西改过），请重新取一次地图` }
  }

  // 表层节点与派生消息必须一一对应：宿主的 deriveMessages() 会跳过派生为空的节点，
  // 一旦数量不等，后面按下标算区间、算工具调用配对就全是错的。对不上就响亮拒绝。
  const messages = session.deriveMessages()
  if (messages.length !== nodes.length) {
    return {
      ok: false,
      reason:
        `会话派生消息数（${messages.length}）与表层节点数（${nodes.length}）对不上，` +
        '这一版没法安全地算区间和工具调用配对，压缩被拒绝——请先手动 /compact 或换新会话继续。',
    }
  }

  const unbalanced = checkPairing(messages, startIdx, endIdx)
  if (unbalanced) return { ok: false, reason: `${op.key}：${unbalanced}` }

  const shadowedSeqs = nodes.slice(startIdx, endIdx + 1)
  const product = frame(op.key, op.title, body, shadowedSeqs, live, session)

  const compactionId = `ic-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  // 块正文自带一行取回线索：模型要知道"这块底下压着的原文还能按事件编号读回来"，
  // 否则它永远等于不知道有取回这回事，只会越写越啰嗦。
  const hint = `\n\n〔这块压掉了 ${shadowedSeqs.length} 条消息（事件号 ${shadowedSeqs[0]}–${shadowedSeqs[shadowedSeqs.length - 1]}）。需要原文时用会话搜索按事件号查看。〕`
  const message = userMessage({
    content: [{ type: 'text', text: product + hint }],
    source: { kind: CHECKPOINT_KIND, compactionId },
  })

  // 收益校验：用我们自己的估算器。宿主那份按 text.length/4 定价，中英文混排时
  // 两侧偏差不同（英文几乎准、中文低估约 4 倍），比值会失真得很厉害。
  // 事件里的 shadowedTokenCount 仍用宿主的口径，那是宿主的账。
  const before = measureRange(meter, session, shadowedSeqs)
  // 我们自己那份估值；取不到正文（0）时退回宿主口径，别把校验变成"永远不通过"。
  const beforeOwnRaw = ownTokens(messages, startIdx, endIdx)
  const beforeOwn = beforeOwnRaw > 0 ? beforeOwnRaw : before
  // 实际写进表层的正文含取回线索，校验必须按它算，否则"通过"之后写出来反而更大。
  const afterOwn = estimateTokens(product + hint)
  if (afterOwn >= beforeOwn) {
    return {
      ok: false,
      reason:
        `${op.key} 压完反而更大（被压 ${beforeOwn} token，压后 ${afterOwn} token），整批没有写入。` +
        '宿主要求替换的内容必须比被替换的更小——把摘要写短一点，或者把区间往大了取。',
    }
  }

  const route = (agent && agent.options) || {}
  const turn = live.currentTurn
  let started = false
  try {
    const startEvent = session.append('compaction/start', { compactionId, turn })
    started = true
    const summaryData = {
      compactionId,
      summary: [{ type: 'text', text: body }],
      shadowedRange: { start: startSeq, end: endSeq },
      shadowedSeqs,
      shadowedTokenCount: before,
      // 路由可能为空：空值不能写 undefined，否则整条记录判为非 JSON 可序列化
      ...(route.provider ? { provider: route.provider } : {}),
      ...(route.model ? { model: route.model } : {}),
    }
    const summaryEvent = session.append('compaction/summary', summaryData)
    session.append('user/message', message, {
      surfaceOp: { op: 'replace', startSeq, endSeq },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
    })
    session.append('compaction/end', { compactionId, turn })
  } catch (error) {
    // 必须补结束，否则这条会话此后所有压缩都会被拒。
    // 但如果开始事件本身就没写进去，补一条结束反而制造孤儿记录。
    if (started) {
      try {
        session.append('compaction/end', {
          compactionId,
          turn,
          error: String(error && error.message ? error.message : error),
        })
      } catch {}
    }
    return { ok: false, reason: `${op.key} 写入失败：${error && error.message ? error.message : error}` }
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
function checkPairing(messages, startIdx, endIdx) {
  const calls = new Set()
  const results = new Set()
  for (let i = startIdx; i <= endIdx; i++) {
    const message = messages[i]
    const content = message && message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'tool-call' && block.toolCallId) calls.add(String(block.toolCallId))
      if (block.type === 'tool-result' && block.toolCallId) results.add(String(block.toolCallId))
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
function ownTokens(messages, startIdx, endIdx) {
  let total = 0
  for (let i = startIdx; i <= endIdx; i++) {
    const message = messages[i]
    const content = message && message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') total += estimateTokens(block.text)
      else if (block.type === 'image') total += 800
    }
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
function frame(key, title, body, shadowedSeqs, zones, session) {
  const tier = key === 'l0' ? 1 : key === 'l1' ? 2 : 3
  let lo = null, hi = null, evLo = null, evHi = null
  for (const seq of shadowedSeqs) {
    const entry = zones.info.get(seq)
    let turns = null, events = null
    if (entry && entry.kind === 'block') {
      turns = entry.block.turns
      events = entry.block.events
    } else {
      const raw = zones.zones.l0.find((n) => n.seq === seq)
      if (raw) { turns = [raw.turn, raw.turn]; events = [raw.originSeq, raw.originSeq] }
    }
    if (turns) {
      for (const t of turns) if (typeof t === 'number') { lo = lo === null ? t : Math.min(lo, t); hi = hi === null ? t : Math.max(hi, t) }
    }
    if (events) {
      for (const e of events) if (typeof e === 'number') { evLo = evLo === null ? e : Math.min(evLo, e); evHi = evHi === null ? e : Math.max(evHi, e) }
    }
  }
  const turnPart = lo === null ? 'T?' : lo === hi ? `T${lo}` : `T${lo}–T${hi}`
  const evPart = evLo === null ? '' : `｜ev ${evLo}–${evHi}`
  const head = `${TITLE_OPEN}L${tier}｜${turnPart}${evPart}${TITLE_CLOSE}${title}`
  return `${head}\n${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}${body}${SUMMARY_CLOSE_TAG}`
}

function stripTags(text) {
  return text.split(SUMMARY_OPEN_TAG).join('').split(SUMMARY_CLOSE_TAG).join('').trim()
}

function fail(reason, partial) {
  return { ok: false, reason, partial: partial || [] }
}
