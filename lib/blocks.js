// 表层分诊：只用两个公开面就把当前表层分成四区。
//   - session.surface.nodes  → 节点 seq（模型可见顺序）
//   - session.deriveMessages() → 与 nodes 一一对应的消息（含 source）
// 不读事件日志（eventAt / snapshotEvents / ownEvents 均已 @deprecated，禁止新增调用）。
//
// 块的层级与覆盖范围不靠日志反推，而是**写在块自己身上**：
// 正文第一行是 〔L2｜T16–T19｜ev 4121–4390〕标题
// 这样插件不需要任何台账：重启、换机器、甚至卸载插件之后，块仍然是自解释的一行消息。

import { messageTokens, IMAGE_TOKENS } from './tokens.js'
import { imagePrices } from './imageprice.js'

const CHECKPOINT_KIND = 'compact-checkpoint'
const MARKER_KIND = 'ebbing-context-marker'
const MAX_TIER = 3

// 〔L2｜T16–T19｜ev 4121–4390〕标题
const HEADER_RE = /^〔([^〕]*)〕(.*)$/

// 认检查点只认来源标记：宿主写检查点时自己带 `source.kind = compact-checkpoint`
// （`ref/pkg-0.2.2-alpha.2/dsh-compaction-basic-0.2.2-alpha.2/lib/index.js` 的
// `createUserMessage({ ..., source: compactCheckpointSource(...) })`）。
// 以前还按正文开头那句英文前导语兜底，但那是在猜：人把这段话贴进对话、或模型引用
// 这段话，就会被误当成外来块，而旧日志里没有来源标记的检查点也认不出来——两头都不对。
// 代价：老会话里没有来源标记的检查点会退化成普通原文，可能被压进 L1。
// 这是显式接受的取舍（见 SPEC §3.5）。

export function parseHeader(text) {
  const first = (text || '').split('\n', 1)[0] || ''
  const m = HEADER_RE.exec(first)
  if (!m) return { meta: null, title: '', rest: text || '' }
  const fields = m[1].split('｜').map((s) => s.trim())
  const meta = { tier: null, turns: [null, null], events: [null, null], turnsOpen: false }
  for (const f of fields) {
    const lv = /^L([1-3])$/.exec(f)
    if (lv) meta.tier = Number(lv[1])
    // 末尾的 `+` 表示"至少到这里、实际可能更宽"（块里吸收过轮号未知的块时才会写）。
    // 必须能读回来：我们自己写的块读不回来，它就会永远没有轮号，之后任何覆盖它的 l0 压缩
    // 都会被拒，地图也再列不出真实轮号——写出去的身份自己先不认了。
    const tp = /^T(\d+)(?:[–-]T?(\d+))?(\+)?$/.exec(f)
    if (tp) {
      meta.turns = [Number(tp[1]), Number(tp[2] ?? tp[1])]
      meta.turnsOpen = tp[3] === '+'
    }
    const ev = /^ev\s*(\d+)(?:[–-](\d+))?$/.exec(f)
    if (ev) meta.events = [Number(ev[1]), Number(ev[2] ?? ev[1])]
  }
  return { meta, title: m[2].trim(), rest: text.slice(first.length).replace(/^\n/, '') }
}

// 兼容旧写法 〔标题〕：没有元信息时当成没有 header。
export function readTitle(text) {
  const first = (text || '').split('\n', 1)[0] || ''
  const m = HEADER_RE.exec(first)
  if (!m) {
    if (first.startsWith('〔') && first.endsWith('〕')) return first.slice(1, -1)
    return ''
  }
  const parsed = parseHeader(text)
  if (parsed.title) return parsed.title
  // 元信息后面没写标题时，退回元信息本身当可读名
  return parsed.meta ? m[1] : ''
}

export function stripTitle(text) {
  const first = (text || '').split('\n', 1)[0] || ''
  if (!HEADER_RE.test(first) && !(first.startsWith('〔') && first.endsWith('〕'))) return text || ''
  return (text || '').slice(first.length).replace(/^\n/, '')
}

// 逐个节点精确投影，得到「这个节点有没有消息」。
//
// 为什么要这么绕：`deriveMessages()` 会**跳过**内容为空的 system/developer/assistant
// 节点（`ref/pkg-0.2.1-rc.3/dsh-session/index.js:225` 的 `if (event.data.message.content.length === 0) return null`），
// 于是两张表按下标对不上；而对不上的时候拿 `messages[index]` 去认块会张冠李戴。
// 好消息：宿主并没有把这个能力藏起来——`session.log` 是公开字段（`:504`/`:519`），
// `session.deriveEventMessage(event)` 是公开方法（`:555`/`:1694`），于是可以一个节点
// 一个节点地问，得到精确映射，根本不需要「按下标对齐」这个前提。
//
// 任何一步不满足（没有 session、没有 log、事件缺失、投影抛错）就返回 null，
// 由调用方退回旧的按下标路径——宁可降级，也不猜。
function deriveExactly(session, nodes) {
  if (!session || typeof session.deriveEventMessage !== 'function') return null
  const log = session.log
  if (!Array.isArray(log)) return null
  const bySeq = new Map()
  for (const seq of nodes) {
    const event = log[seq]
    if (!event || typeof event !== 'object') return null
    try {
      bySeq.set(seq, session.deriveEventMessage(event) || null)
    } catch {
      return null
    }
  }
  return { bySeq }
}

function messageText(message) {
  const content = message && message.content
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('')
}

// 轮号来源：宿主的轮次大纲投影（key = turnOutline，state = { turns: [{turn, seq}] }）
// 与日志里的 turn/start，两个独立来源。选择规则（回归修复）：
//
//   1. 先各自体检：轮号与事件号都必须严格递增（重号、倒序都说明这一串自己不可信）；
//   2. 健全的一源优先（投影优先——它是宿主对同一份日志的官方解释）；
//   3. 用另一源补"这一源没有、补进去仍然单调"的轮。补不进就记一条留痕，**不报坏**：
//      fork / 迁移 / 异常重试都会在日志里留下投影故意丢弃的轮号（宿主 `turn-outline:86`
//      对 `turn <= last.turn` 直接 return），把它当损坏就会让任何人 fork 出来的会话永久停摆；
//   4. 只有两源都不可信（各自都不单调）时才报坏——那是真的没法定轮。
//
// 缺轮不在这里报坏：缺的那一轮边界确实不可知，交给 readZones 记成 `missing`，
// 压缩上界被夹到缺轮之前（准确性优先），会话照常可用（稳定性也保住）。
function usableStarts(starts) {
  if (!Array.isArray(starts) || !starts.length) return false
  for (let i = 1; i < starts.length; i += 1) {
    if (starts[i].turn <= starts[i - 1].turn) return false
    if (starts[i].seq <= starts[i - 1].seq) return false
  }
  return true
}

function soundnessOf(starts) {
  if (!Array.isArray(starts) || !starts.length) return 'gap'
  for (let i = 1; i < starts.length; i += 1) {
    if (starts[i].seq <= starts[i - 1].seq) return 'order'
  }
  for (let i = 1; i < starts.length; i += 1) {
    if (starts[i].turn <= starts[i - 1].turn) return 'turn-order'
  }
  return null
}

// 把 extra 里 base 没有的轮补进来——只接受"补进去之后整串仍然严格单调"的那些。
// 同一轮两边都有时以 base 为准（不覆盖：优先来源是权威，覆盖等于让次优来源改结果）。
function supplement(base, extra, notes) {
  if (!base || !extra) return base
  const out = base.slice()
  for (const s of extra) {
    if (out.some((x) => x.turn === s.turn)) {
      const kept = out.find((x) => x.turn === s.turn)
      if (kept && kept.seq !== s.seq) notes.push({ turn: s.turn, reason: 'seq-differs' })
      continue
    }
    let at = 0
    while (at < out.length && out[at].turn < s.turn) at += 1
    const probe = out.slice(0, at).concat([s], out.slice(at))
    if (!usableStarts(probe)) {
      notes.push({ turn: s.turn, reason: 'not-monotone' })
      continue
    }
    out.length = 0
    out.push(...probe)
  }
  return out
}

function readTurnStarts(ctx, session) {
  const notes = []
  let projected = null
  try {
    const projections = ctx && typeof ctx.get === 'function' ? ctx.get('sessionProjections') : null
    if (projections && typeof projections.stateOf === 'function') {
      const state = projections.stateOf(session, 'turnOutline')
      if (state && Array.isArray(state.turns) && state.turns.length) {
        const starts = []
        for (const entry of state.turns) {
          if (!entry || typeof entry.turn !== 'number' || typeof entry.seq !== 'number') continue
          starts.push({ turn: entry.turn, seq: entry.seq })
        }
        if (starts.length) {
          starts.sort((a, b) => a.seq - b.seq)
          projected = starts
        }
      }
    }
  } catch {}
  // 投影没挂上（某些装配里 turnOutline 并不存在），或投影自己缺轮/乱序：都改读日志。
  // 宿主每开一轮都 `session.append("turn/start", { turn })`（dsh-agent-loop:731），
  // 事件号就是下标，信息是完备的——投影只是快路径，不是更准的来源。
  const fromLog = turnsFromLog(session)
  const projOk = usableStarts(projected)
  const logOk = usableStarts(fromLog)
  if (projOk) {
    return { starts: supplement(projected, fromLog, notes), notes, fault: null, faultDetail: null }
  }
  if (logOk) {
    notes.push({ reason: 'used-log' })
    return { starts: supplement(fromLog, projected, notes), notes, fault: null, faultDetail: null }
  }
  const merged = mergeStarts(projected, fromLog)
  if (usableStarts(merged)) {
    notes.push({ reason: 'used-merged' })
    return { starts: merged, notes, fault: null, faultDetail: null }
  }
  // 两个来源都"看不到"（投影没挂上、日志里一条 turn/start 都没有）不是损坏，是看不见：
  // 宿主换了装载方式、测试桩、从中间截断的日志都会长这样。这种情况一律降级（starts=null），
  // 由上层给"拿不到轮号"的文案，绝不许当成损坏把整条对话停掉（SPEC §3.6）。
  if (!projected && !fromLog) {
    notes.push({ reason: 'no-source' })
    return { starts: null, notes, fault: null, faultDetail: null }
  }
  // 两源都不可信：这才报坏。写清两边的症状，别只给一句"轮次大纲损坏"。
  // 轮号在时间上倒退（先 T5 后 T3）与事件号乱序一样，都归 'order'（fatalOutline 只认这两个值）。
  const broken = soundnessOf(merged)
  const parts = []
  if (projected) parts.push(`投影 ${soundnessOf(projected) === 'order' ? '事件号不单调' : soundnessOf(projected) === 'turn-order' ? '轮号不前进' : '为空'}`)
  if (fromLog) parts.push(`日志 ${soundnessOf(fromLog) === 'order' ? '事件号不单调' : soundnessOf(fromLog) === 'turn-order' ? '轮号不前进' : '为空'}`)
  return {
    starts: merged,
    notes,
    fault: 'order',
    faultDetail: `轮次大纲的两个来源都不可信（${parts.join('、') || '都拿不到'}），算不出每一轮的边界`,
  }
}

// 轮号 → 起点 seq。两边都有时以优选来源为准（见 readTurnStarts 的三条规则）。
function mergeStarts(projected, fromLog) {
  // 只有单一来源时，先按轮号去重、保首现——与宿主 turn-outline 的 keep-first 同口径。
  // fork / 迁移 / 异常重试会在日志里留下重号的 turn/start，那是痕迹不是损坏；
  // 不先去重就会让"没有投影装配 + 日志重号"直接判成 order，把整条对话停掉（回归修复）。
  // 真正的倒退（先 T5 后 T3）去重之后仍然不单调，照样判坏，检测力不丢。
  if (!projected) return dedupeByTurn(fromLog)
  if (!fromLog) return dedupeByTurn(projected)
  const byTurn = new Map()
  for (const s of projected) byTurn.set(s.turn, s)
  for (const s of fromLog) byTurn.set(s.turn, s)
  return [...byTurn.values()].sort((a, b) => a.turn - b.turn)
}

function dedupeByTurn(list) {
  if (!Array.isArray(list) || list.length === 0) return null
  const seen = new Map()
  for (const s of list) if (!seen.has(s.turn)) seen.set(s.turn, s)
  return [...seen.values()]
}

// 按会话缓存：turn/start 一旦写下就不会变，只需要补扫新增的尾巴。
// 不用 session.seq 当键——它每一步都在变，那样等于每次都全扫。
const turnLogCache = new WeakMap()

function turnsFromLog(session) {
  const log = session && session.log
  if (!Array.isArray(log)) return null
  let cache = turnLogCache.get(session)
  if (!cache || cache.scanned > log.length) cache = { scanned: 0, starts: [] }
  for (let seq = cache.scanned; seq < log.length; seq += 1) {
    const event = log[seq]
    if (!event || event.type !== 'turn/start') continue
    const turn = event.data && event.data.turn
    if (typeof turn !== 'number') continue
    cache.starts.push({ turn, seq })
  }
  cache.scanned = log.length
  turnLogCache.set(session, cache)
  if (!cache.starts.length) return null
  return cache.starts.slice().sort((a, b) => a.seq - b.seq)
}

// 这个会话里真正发生过的压缩事务 id：宿主 /compact、compaction-basic 的自动压缩、
// 以及我们自己的压缩，都会先写 `compaction/start`、再写带摘要的事件，两条带同一个 id。
// 拿它来核对"外来检查点"的出身（只有对得上的才允许升 L3，见 foreignBlock.proven）。
// 记一条"这个节点已经报过出身对不上"，避免每个 pre-step 都往日志里刷同一条。
const unprovenLogged = new WeakMap()
const NO_IDS = new Set()

// 这个会话里真正发生过的压缩事务 id：宿主 /compact、compaction-basic 的自动压缩、
// 以及我们自己的压缩，都会先写 `compaction/start`、再写带摘要的事件，两条带同一个 id。
// 只有表层里真有"没有块头的外来检查点"时才会走到这里，一次全扫实测 50k 事件 0.24ms，
// 所以不做缓存——缓存的失效条件（截断、重写、同长度改写）比它省下的那点时间更危险。
function compactionIds(session) {
  const log = session && Array.isArray(session.log) ? session.log : null
  if (!log) return NO_IDS
  const ids = new Set()
  for (const ev of log) {
    if (!ev || typeof ev !== 'object') continue
    if (ev.type !== 'compaction/start' && ev.type !== 'compaction/summary') continue
    const id = ev.data && ev.data.compactionId
    if (typeof id === 'string' && id) ids.add(id)
  }
  return ids
}
function noteUnproven(session, seq, compactionId, log) {
  if (typeof log !== 'function') return
  let seen = unprovenLogged.get(session)
  if (!seen) {
    seen = new Set()
    unprovenLogged.set(session, seen)
  }
  if (seen.has(seq)) return
  seen.add(seq)
  log('foreign-block-unproven', { seq, compactionId: compactionId || null })
}

export function readZones(ctx, session, agent, log) {
  const nodes = session.surface.nodes
  const messages = session.deriveMessages()
  // 图片真实价（A4）：地图的"可压原文合计"、叫醒门槛、MIN_L0_COST 与压缩收益校验
  // 必须用同一把尺子，否则会出现"地图说太少、真压却很赚"或反向的两套账。
  // 路由从 agent.options 取；拿不到就退回固定 800（不报错、不中断）。
  const route = (agent && agent.options) || null
  const imagePricer = route && ctx && typeof ctx.get === 'function'
    ? (images) => imagePrices(ctx, route, images, log)
    : null
  const nodeIndex = new Map()
  nodes.forEach((seq, i) => nodeIndex.set(seq, i))

  // 当前轮之前（严格小于它）的节点才可压；当前轮由宿主写在时间上下文里，取不到就整区不压。
  const turnInfo = readTurnStarts(ctx, session)
  const starts = turnInfo.starts
  const currentTurn = starts && starts.length ? starts[starts.length - 1].turn : null

  // 轮次归属不能只看事件号。宿主在 pruner 剪枝时做的是"原位替换"：
  // 替换事件拿到一个**新的、更靠后的事件号**，但它在表层上仍然待在原来的位置。
  // （图片离线化不是这样：它是 message 投影，不换 surface 的事件号，对判轮没有影响。）
  // 只按事件号比大小，会把旧轮的工具结果算成当前轮，于是 T1 的区间漏掉它、配对检查失败。
  // 所以优先用**表层下标**判轮：轮首节点在表层上的下标才是位置的真相。
  // 轮首本身也被替换掉时（旧轮的 user/message 被压成检查点），退回按事件号比较。
  // 界标取"事件号不小于本轮的起点里最小的那个节点"。
  //
  // 为什么不按窗口 [本轮起点, 下一轮起点) 去卡：原位替换会把被替换节点的**新事件号顶到后面**，
  // 于是"第 1 轮的工具结果"可能带着比第 2 轮起点还大的号码（下面测试里就是这样）。
  // 按窗口卡会在遇到这种节点时提前停手，反而把地标认错。
  //
  // 这条规则的**安全性质**（比正确性更重要）：地标要么落在某轮真正的第一个原件节点上，
  // 要么落在"后面某轮的第一个节点"上——两者都是真起点，绝不会落在某一对的中间。
  // 它唯一的缺点是标签会塌缩：某一轮的首节点被替换过（事件号变很大）时，
  // 这一轮就没有地标了，区间把它并进相邻轮次。标签粗一点，但不会切错。
  const startIndex = new Map()
  for (const s of starts || []) {
    let boundarySeq = null
    for (const seq of nodes) {
      if (seq >= s.seq && (boundarySeq === null || seq < boundarySeq)) boundarySeq = seq
    }
    startIndex.set(s.turn, boundarySeq === null ? null : nodeIndex.get(boundarySeq))
  }
  const turnOfIndex = (index, seq) => {
    if (!starts) return null
    let lo = null
    for (const s of starts) {
      const boundary = startIndex.get(s.turn)
      const inside = boundary === null || boundary === undefined ? s.seq <= seq : index >= boundary
      if (inside) lo = s.turn
      else if (boundary !== null && boundary !== undefined) break
    }
    return lo
  }

  // 轮号自检只在两源都不可信时才有 fault（判据在 readTurnStarts）。
  // 缺轮不报红：缺的那一轮边界确实不可知，但那是宿主恢复（fork/迁移）的正常痕迹，
  // 报红会让整条对话永久停摆。现在的处理是「先补、再跨」——标记声称的轮直接补成起点
  // （见下面的标记段），补不上的允许跨缺口切（见 resolveTurnAnchor），
  // 切点仍落在下一个已知边界上，所以准确性不打折，会话也照常能用。
  // 缺轮与可压上界要等标记补过之后再算：标记本身就能把缺的轮补回来，
  // 先算一遍再补等于白拦一道。
  let outlineFault = turnInfo.fault
  let outlineFaultDetail = turnInfo.faultDetail
  let currentEmpty = false
  if (starts) {
    // 「当前轮在表层上一个节点都没有」不是故障，是宿主的正常时序：
    // 它先 append turn/start、再从 inbox 认领用户消息、最后才派发 agent/pre-step，
    // 而用户消息要等 pre-step 返回之后才写进表层。于是每一轮第 1 步都必然看到
    // 「当前轮 0 节点」——以前把它当成 outlineFault='current'，结果每轮都报红、
    // 每条消息都被吞掉（真机回归修复）。这里只记成 currentEmpty，不参与判坏。
    currentEmpty = startIndex.get(currentTurn) === null
  }

  const sys = []
  const zones = { l3: [], l2: [], l1: [], l0: [], unknown: [] }
  const info = new Map()

  // 宿主会跳过内容为空的节点（空的 assistant/system/developer 消息），于是
  // `deriveMessages()` 可能比表层节点少几条，两张表按下标就对不上了。
  //
  // 以前这里只能退化成"整表当原文"，于是"既有空节点、又有压缩块"变成一个
  // **只增不减、且每次压缩必拒**的永久状态（空节点不会自己消失，而唯一能压的 l0
  // 又因为怕把旧摘要当原文再压一遍而停下）。那不是解析难题，是取错了 API：
  // `session.deriveEventMessage(event)` 是公开方法，`session.log[seq]` 是公开字段，
  // 逐个节点投影就能拿到**精确**的"这个节点有没有消息"，完全不需要按下标对齐。
  const exact = deriveExactly(session, nodes)
  const messageOf = (index, seq) => {
    if (exact) return exact.bySeq.get(seq) || null
    return messages.length === nodes.length ? messages[index] || null : null
  }
  const aligned = exact !== null || messages.length === nodes.length
  let blockLike = 0
  if (!aligned) {
    for (const m of messages) {
      if (m && m.role === 'user' && m.source && m.source.kind === CHECKPOINT_KIND) {
        blockLike += 1
      }
    }
  }
  const ambiguous = !aligned && blockLike > 0
  const trusted = exact !== null || messages.length === nodes.length
  const firstMessage = messages[0] || null

  // 标记即锚点（回归修复）：〔轮次标记〕是我们自己写在轮与轮交界处的路标，
  // 它在上下文里的**位置**就是"这一轮从哪开始"的地面真值。
  //
  // 为什么不能只靠事件号：宿主做原位替换（pruneFirst 剪枝、我们自己的压缩产物）时，
  // 替换出来的节点拿一个**新的、更大的事件号**，但位置没变。上面那套"取事件号 ≥
  // 本轮起点里最小的节点"于是会把交界认到前面去（即上面注释承认的"标签塌缩"），
  // 这一轮的标记就被算到后一轮——地图上的 T 号会和上下文里写死的标记对不上，
  // 模型照着 `to` 压就会选错区间。所以凡是有标记的轮，一律用标记的位置修正边界。
  //
  // 只修正、不报红：塌缩是宿主的正常态，不是损坏（把它报成损坏会停用整条对话，
  // 而且触发它的正是我们自己的剪枝和压缩）。
  const markerNotes = []
  if (starts) {
    for (let i = 0; i < nodes.length; i += 1) {
      const message = messageOf(i, nodes[i])
      if (!message || !message.source || message.source.kind !== MARKER_KIND) continue
      const hit = /〔轮次标记〕\s*(?:本轮\s*T(\d+)|下一轮\s*T(\d+))/.exec(messageText(message))
      if (!hit) continue
      const claimed = Number(hit[1] || hit[2])
      // 「本轮 TN」自己就是 T N 的第一个节点；「下一轮 TN」写在第 N−1 轮末尾，
      // 它后面紧跟的第一条才是 T N 的内容。
      const boundary = hit[1] ? i : i + 1
      if (boundary >= nodes.length) continue
      const known = starts.some((s) => s.turn === claimed)
      if (!known) {
        // 标记补缺轮（设计约束）：标记是我们自己写的，位置就是地面真值。
        // 它说了一个记录里没有的轮，说明那一轮的 `turn/start` 丢了（fork / 迁移 /
        // 日志被截断），但内容还在表层上。补回去，缺轮就消失了。
        const seq = nodes[boundary]
        const at = starts.findIndex((s) => s.turn > claimed)
        const pos = at < 0 ? starts.length : at
        const prev = starts[pos - 1]
        const next = starts[pos]
        // 补进去必须仍然"轮号递增、事件号递增"，否则宁可少一条证据。
        if (typeof seq === 'number' && (!prev || prev.seq < seq) && (!next || next.seq > seq)) {
          starts.splice(pos, 0, { turn: claimed, seq })
          startIndex.set(claimed, boundary)
          markerNotes.push({ turn: claimed, boundary, reason: 'healed' })
        } else {
          markerNotes.push({ turn: claimed, boundary, reason: 'heal-rejected' })
        }
        continue
      }
      // 标记说了算：边界直接改成标记给出的位置（两个方向都要改——塌缩会让事件号法算早，
      // 也可能算晚）。两道护栏：
      //   · 不能越过上一轮的交界，否则会把上一轮的内容吞进来；
      //   · 不能越过下一轮的交界，否则会把下一轮的开头吞进这一轮。
      // 护栏命中说明这条标记与已知边界打架（正常流程产生不出来：标记和块都是我们写的）。
      // 这时**不报红**——报红会让整条对话停摆，而"标记过期"完全是可恢复的：
      // 记一条 notes，退回算法算出来的结果（准确性优先：宁可少用一条证据，也不用一条坏证据）。
      const prevBoundary = claimed > 1 ? startIndex.get(claimed - 1) : null
      if (typeof prevBoundary === 'number' && boundary < prevBoundary) {
        markerNotes.push({ turn: claimed, boundary, reason: 'before-prev' })
        continue
      }
      const nextBoundary = startIndex.get(claimed + 1)
      if (typeof nextBoundary === 'number' && boundary >= nextBoundary) {
        markerNotes.push({ turn: claimed, boundary, reason: 'after-next' })
        continue
      }
      startIndex.set(claimed, boundary)
    }
    currentEmpty = startIndex.get(currentTurn) === null
  }

  // 缺轮（标记补过之后仍有）：只留痕，不拦可压范围（设计约束）。
  // 缺轮意味着"那一轮从哪开始"不可知，但它前面的轮一直延续到下一个已知边界，
  // 所以 `to: T{缺轮前一} ` 会把缺轮的内容一起压掉——标签粗一点，切点仍然是真边界。
  const missingTurns = []
  if (starts) {
    for (let i = 1; i < starts.length; i += 1) {
      const gap = starts[i].turn - starts[i - 1].turn
      if (gap > 1) for (let t = starts[i - 1].turn + 1; t < starts[i].turn; t += 1) missingTurns.push(t)
    }
  }
  let maxTurn = starts && starts.length ? starts[starts.length - 1].turn : null

  nodes.forEach((seq, index) => {
    const message = messageOf(index, seq)
    // 空的节点没有消息（宿主跳过了它）：从分类里整体跳过。
    // 只有在"能确认这个节点确实没有消息"时才跳过——否则老退化路径下会把整表丢掉。
    // 仍记一条 `empty`：它占着一个事件号，压缩区间跨过它时块头的事件号范围要算上，
    // 否则块尾写的"事件号 a–b"会比真实遮蔽范围窄，取回线索也可能指向一条空事件。
    if (index > 0 && !message && trusted) {
      info.set(seq, { kind: 'empty' })
      return
    }
    const source = (message && message.source) || {}
    // 节点 0 的判定只能用"节点 0 自己的消息"。以前用的是 messages[0]（第一条第派生消息），
    // 一旦节点 0 是空系统消息被宿主跳过，messages[0] 就是第 2 个节点的消息，于是节点 0
    // 掉进原文区——之后任何覆盖它的 l0 压缩都会被宿主的 node0 保护拒掉，而且每次失败。
    // 所以"精确映射可用、但节点 0 没有消息"也要按表头处理（空系统节点曾被算进原文区）。
    // 数量不等时分不清节点 0 到底是什么，按"头部"处理：宁可少压一条，也不去碰宿主那一道闸。
    const isHead = index === 0 && sys.length === 0 &&
      (!aligned || !message || message.role === 'system' || message.role === 'developer')
    if (isHead) {
      sys.push(seq)
      info.set(seq, { kind: 'sys' })
      return
    }
    if (message && message.role === 'user' && source.kind === CHECKPOINT_KIND) {
      const text = messageText(message)
      const parsed = parseHeader(text)
      // 不是我们写的块（例如手动 /compact 产生的）：没有那一行身份证，层级推不出来。
      // 按 1 级收纳——已经在最底层，能被 l1/l2 吸收，不会卡住后续压缩。
      // 只在地图上标一句"外来块"，提醒人这一段不是我们写的。
      if (!parsed.meta) {
        // 外来块也必须有完整字段：地图和压缩都会读 turns/title/block，
        // 少一个就会在渲染或吸收时抛 TypeError。
        const head = String(text || '').trim().split('\n')[0] || ''
        const foreignBlock = {
          seq,
          tier: 1,
          text,
          compactionId: source.compactionId,
          title: head.slice(0, 40),
          turns: [null, null],
          events: [null, null],
          foreign: true,
          // 出身核对（设计约束）：只有"日志里真有这次压缩事务"的检查点才算数——
          // 别人手写一条 kind 冒充检查点，内容是什么谁也不知道，不能当 L3。
          proven: typeof source.compactionId === 'string' && source.compactionId !== '' &&
            compactionIds(session).has(source.compactionId),
        }
        if (!foreignBlock.proven && typeof log === 'function') {
          noteUnproven(session, seq, source.compactionId, log)
        }
        zones.l1.push(foreignBlock)
        info.set(seq, { kind: 'block', tier: 1, foreign: true, block: foreignBlock })
        return
      }
      const tier = parsed.meta && parsed.meta.tier ? parsed.meta.tier : 1
      const block = {
        seq,
        tier: Math.min(MAX_TIER, tier),
        text,
        compactionId: source.compactionId,
        title: parsed.title || readTitle(text),
        turns: parsed.meta ? parsed.meta.turns : [null, null],
        events: parsed.meta ? parsed.meta.events : [null, null],
        turnsOpen: parsed.meta ? parsed.meta.turnsOpen === true : false,
      }
      zones[tier === 3 ? 'l3' : tier === 2 ? 'l2' : 'l1'].push(block)
      info.set(seq, { kind: 'block', tier: block.tier, block })
      return
    }
    const originSeq = message && Array.isArray(message.sourceEventSeqs) && message.sourceEventSeqs.length
      ? message.sourceEventSeqs[0]
      : seq
    zones.l0.push({ seq, originSeq, kind: 'raw', turn: turnOfIndex(index, seq) })
    info.set(seq, { kind: 'raw' })
  })

  // 标记已经在上面当锚点用过了（修正边界），这里不再做"对不上就报红"的交叉校验：
  // 那个判据会被我们自己的剪枝/压缩触发（回归修复），把正常会话打成红错。
  // 现在的一致性靠"以标记为准"保证：地图上的 T 号由标记位置决定，不会和上下文打架。

  // 宿主拍平之后只剩它一个内容节点时，把它登记成 L3（设计约束）：
  // 那是"整个历史被替换成一个摘要"留下的位置，也就是金字塔的最底层。登记成 L3 之后
  // `l3` 就能把它折成我们自己的块（带块头），L2/L1 随之恢复；留在 L1 的话它确实
  // "能被 l1/l2 吸收"，但永远吸不走、也永远不会被再压一次。
  // 只有"除表头外只剩它"才这么做——夹在原文中间的外来块位置无从推断，仍按 L1 收纳。
  const foreignInL1 = zones.l1.filter((b) => b.foreign)
  const contentCount = zones.l0.length + zones.l1.length + zones.l2.length + zones.l3.length
  // 只有出身对得上的检查点才升 L3（设计约束）：别人手写一条 kind 冒充检查点，
  // 内容是什么谁也不知道，放进 L3 会被当成"整段历史"再压一次。
  if (foreignInL1.length === 1 && contentCount === 1 && foreignInL1[0].proven) {
    const block = foreignInL1[0]
    zones.l1.length = 0
    block.tier = 3
    zones.l3.push(block)
    info.set(block.seq, { kind: 'block', tier: 3, foreign: true, block })
  }

  return {
    nodes,
    messages,
    nodeIndex,
    // 按节点取消息（精确映射时与下标无关；退化时按下标，对不上就返回 null）。
    messageFor: (seq) => messageOf(nodeIndex.get(seq), seq),
    sys,
    zones,
    info,
    currentTurn,
    // 图片真实价的取数口（拿不到就是 null，调用方退回固定 800）。
    imagePricer,
    // 可压上界（缺轮之前的那一轮）：`to` 不许越过它——越过就压到边界不可知的区间。
    maxTurn,
    turnStarts: starts,
    turnStartIndex: startIndex,
    // 轮号来源的留痕（不是故障）：走了日志、补了重叠、缺了哪几轮、两边起点不一致。
    turnNotes: turnInfo.notes.concat(missingTurns.map((t) => ({ turn: t, reason: 'missing' }))),
    aligned,
    ambiguous,
    outlineFault,
    outlineFaultDetail,
    currentEmpty,
    // 标记被护栏挡下来的记录（只用于日志/排查，不参与任何判定）。
    markerNotes,
  }
}

// 锚点解析：
//   Tn  -> 第 n 轮里当前仍在表层的最后一个原文节点（只允许已结束的轮）
//   数字 -> 该区从 1 起的序号（l1 / l2 用；l3 不收）
export function resolveTurnAnchor(zones, label, keepTurns = 0) {
  const m = /^T(\d+)$/.exec(String(label || '').trim())
  if (!m) return { ok: false, reason: '锚点写法不对：轮锚点要写成 T19 这种形式' }
  const turn = Number(m[1])
  if (zones.turnStarts === null) {
    return {
      ok: false,
      reason:
        '拿不到轮号（宿主的轮次大纲投影没挂载），所以这一版压不了 l0：它的 to 只能是轮号。' +
        'l1 / l2 的位置不受影响（它们按块序号）；但 l0 还能压时，级联仍要求同一批里给它。' +
        '别用宿主自带的 /compact 顶替——它会把分层拍平、原文再也取不回',
    }
  }
  if (typeof zones.currentTurn === 'number') {
    if (turn >= zones.currentTurn) {
      return { ok: false, reason: `第 ${turn} 轮还没结束（当前是第 ${zones.currentTurn} 轮），只能压已经结束的轮次` }
    }
    const cutoff = zones.currentTurn - 1 - keepTurns
    if (cutoff < 1) {
      return {
        ok: false,
        reason:
          `现在才第 ${zones.currentTurn} 轮，而 keepTurns=${keepTurns} 要把最近 ${keepTurns} 个已结束的轮全留住，` +
          '可压范围是空的：这次压不了原文区（把 keepTurns 调小，或等轮次多了再压）',
      }
    }
    if (turn > cutoff) {
      return {
        ok: false,
        reason: `最后 ${keepTurns} 轮要留着，最多压到 T${cutoff}（收到的是 T${turn}）；这是设置项 keepTurns`,
      }
    }
  }
  let hit = null
  for (const n of zones.zones.l0) if (n.turn !== null && n.turn <= turn) hit = n
  if (!hit) return { ok: false, reason: `找不到第 ${turn} 轮还留在表层上的原文` }
  if (hit.turn !== turn) {
    return { ok: false, reason: `第 ${turn} 轮在表层上已经没有原文了，最后一个可压的位置是第 ${hit.turn} 轮的 T${hit.turn}` }
  }
  // 切点 = 下一个**已知**轮的起点 − 1（设计约束）。
  //
  // 缺轮（比如 T4 没有 `turn/start`）时，下一条已知边界就是 T5：于是 `to: T3`
  // 会把 T5 之前的内容整段压掉——T4 的内容本来就在表层上挂着 T3 的标签
  // （标签塌缩），压掉它并不违反"整轮边界"这条硬约束：切点仍然落在真边界上。
  // 用户的原话：「只要可压范围能盖住正确的范围就行，即便里面缺了个标签」。
  // 连续缺轮同理：下一条已知边界可能很远，一次跨过好几个缺口，切点依然是真的。
  const starts = zones.turnStarts || []
  const index = zones.turnStartIndex
  const nodeIndex = zones.nodeIndex && typeof zones.nodeIndex.get === 'function' ? zones.nodeIndex : null
  let nextStart = null
  let nextKnown = null
  for (const s of starts) {
    if (s.turn <= turn) continue
    const at = index.get(s.turn)
    if (typeof at !== 'number') continue
    if (nextStart === null || at < nextStart) {
      nextStart = at
      nextKnown = s.turn
    }
  }
  const curStart = typeof zones.currentTurn === 'number' ? index.get(zones.currentTurn) : null
  let cut = nextStart !== null ? nextStart - 1 : null
  if (typeof curStart === 'number' && (cut === null || cut > curStart - 1)) cut = curStart - 1
  const swallowed = []
  if (nextKnown !== null) {
    for (let t = turn + 1; t < nextKnown; t += 1) swallowed.push(t)
  }
  let anchor = hit
  // cut 算不出来（连当前轮的起点都不在起点表里）时退回 hit：它是"标签 ≤ to 的最后一个原文节点"，
  // 按构造不可能包含当前轮的内容。宁可少压一点，也不能把当前轮扫进去。
  if (nodeIndex && cut !== null) {
    for (const n of zones.zones.l0) {
      const at = nodeIndex.get(n.seq)
      if (typeof at !== 'number') continue
      if (at <= cut) anchor = n
    }
  }
  if (!anchor) return { ok: false, reason: `找不到第 ${turn} 轮还留在表层上的原文` }
  return { ok: true, seq: anchor.seq, swallowed }
}

export function resolveZoneIndex(zones, zoneName, index) {
  const list = zones.zones[zoneName]
  // 只收十进制裸串（与 l0 的 `T数字` 同一个严格度）：`Number()` 会把 "0x2"/"1.0"/"1 " 也
  // 解释成合法序号，静默接受模型的错误写法，等地图一变就压错边界。
  const raw = typeof index === 'number' ? String(index) : String(index === undefined || index === null ? '' : index).trim()
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN
  if (!Number.isInteger(n) || n < 1) {
    return { ok: false, reason: `${zoneName} 的位置要从 1 开始数，收到的是 ${String(index)}` }
  }
  if (n > list.length) {
    return { ok: false, reason: `${zoneName} 区现在只有 ${list.length} 块，取不到第 ${n} 块——照本次结果里附的新地图改一处再试` }
  }
  // 每层最后一块是这一层与新内容的接口，永远不压：压掉它这一层就没有"最新的那一块"了。
  if (n >= list.length) {
    const max = list.length - 1
    return {
      ok: false,
      reason:
        max <= 0
          ? `${zoneName} 区现在只有 1 块，最后一块不能压，暂时没得压（先压 l0 再回来）`
          : `${zoneName} 区最后一块不能压，最多写到 ${max}（收到的是 ${n}）`,
    }
  }
  return { ok: true, seq: list[n - 1].seq, block: list[n - 1] }
}

// 最远能压到哪一轮：currentTurn 之前的轮次里，再留掉最后 keepTurns 轮。
// 还要再压一道：只到"表层上真有原文的最后一轮"为止（边界情形）。
// 为什么：轮次大纲里有 turn/start 不代表那一轮有正文（整轮被取消、或内容早被压进块里），
// 地图若把空轮当可压范围，模型照着写 `to: T7` 会立刻被拒（"这一轮在表层上找不到原文"）。
// 拿不到轮号时返回 null（调用方据此说"判不了轮"，不要说"没有原文"）。
export function lastCompressibleTurn(zones, keepTurns = 0) {
  if (typeof zones.currentTurn !== 'number') return null
  // keepTurns 保的是"最近 N 个**已经结束**的轮"（设计约束）：
  // 当前轮永远不压，所以可压上界是"当前轮 − 1 − N"，而不是"当前轮 − N"。
  // 旧算式会多留 / 少留一轮：keepTurns=0 时把当前轮和它的前一轮算进可压范围，
  // keepTurns=2 时实际只保住了 1 个已完成轮。
  let cutoff = zones.currentTurn - 1 - Math.max(0, keepTurns)
  // 缺轮不再夹上界（设计约束）：缺轮没有自己的边界，但它的内容会跟着前一轮的标签
  // 一起被压掉，切点由 resolveTurnAnchor 落在下一个已知边界上。`zones.maxTurn` 只用于
  // 地图展示"最后一个已知轮"，不参与这里的收窄（放了会是恒等运算）。
  const raw = zones.zones && Array.isArray(zones.zones.l0) ? zones.zones.l0 : []
  let lastRaw = null
  for (const node of raw) {
    if (typeof node.turn !== 'number') continue
    if (lastRaw === null || node.turn > lastRaw) lastRaw = node.turn
  }
  if (lastRaw !== null) cutoff = Math.min(cutoff, lastRaw)
  return cutoff >= 1 ? cutoff : null
}

// 压掉这么一点点原文，连块自己的固定开销都盖不住时，compress 一定会拒绝
// （"压完必须比被压内容小"），那就别把这一层算成"可压"，免得每轮白叫醒一次。
// 300 是取整后的门槛（用户要求 定）：块头 + 摘要须知 + 交界声明 + 图片台账的固定开销。
const MIN_L0_COST = 300
const rawCostCache = new WeakMap()

// 一条消息的成本：文本按自己的估算器，图片按路由真实价（A4 统一口径）。
// 拿不到真实价时退回固定 800——两处口径必须同时退化，不能"地图按 800、收益按真价"。
export function costOfMessage(zones, msg) {
  const pricer = zones && zones.imagePricer
  const content = Array.isArray(msg.content) ? msg.content : []
  const images = content.filter((b) => b && b.type === 'image')
  if (!pricer || !images.length) return messageTokens(msg)
  const prices = pricer(images)
  if (!prices || prices.length !== images.length) return messageTokens(msg)
  let i = 0
  return messageTokens(msg, () => {
    const price = prices[Math.min(i, prices.length - 1)]
    i += 1
    return typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : IMAGE_TOKENS
  })
}

function rawCostOf(zones, nodes) {
  // 缓存键要带上"这次算的是哪些节点"（回归修复）：zones 是同一个对象被不同区间复用，
  // 只按 zones 缓存的话，第二个调用点会拿到第一段区间的和。
  const key = nodes.length
  const cached = rawCostCache.get(zones)
  if (cached && cached.key === key) return cached.sum
  let sum = 0
  try {
    for (const node of nodes) {
      const msg = typeof zones.messageFor === 'function' ? zones.messageFor(node.seq) : null
      if (!msg) return Infinity // 拿不到正文就别替它下结论：按"可压"处理，让 compress 自己去判
      sum += costOfMessage(zones, msg)
    }
  } catch {
    return Infinity
  }
  rawCostCache.set(zones, { key, sum })
  return sum
}

// 这一层现在还能不能压：级联只把"确实可压"的浅层算作必须一起压的层，
// 否则会出现"某层只剩 1 块 / 原文区只剩被保护的最后几轮"导致的死锁。
export function canCompressZone(zones, key, keepTurns = 0) {
  if (key === 'l0') {
    // 轮次大纲不可靠时 l0 一律算"压不了"：判不准每一轮到哪儿结束，压下去可能切错轮。
    // 这条必须和 compress.js 里 l0 的拒绝条件一致——否则级联会一直要求带一个必然被拒的 l0，
    // 结果是 l1 / l2 / l3 也全都压不动（整会话死锁），而地图还在说"l1 / l2 不受影响"。
    if (zones.outlineFault) return false
    const cutoff = lastCompressibleTurn(zones, keepTurns)
    if (cutoff === null) return false
    const left = zones.zones.l0.filter((n) => typeof n.turn === 'number' && n.turn <= cutoff)
    if (!left.length) return false
    // 压完还得比被压的内容小（compress.js 的硬约束）。剩下的一小段连"块头 + 摘要须知 +
    // 交界声明 + 图片台账"的固定开销都盖不住时，压了一定被拒——那就别算"可压"，
    // 否则每轮把模型叫醒一次、它压一次被拒一次（回归修复）。
    // 这里判的是**结构**：拿不到正文（cost 为 Infinity）时仍算"可能可压"，因为级联前提
    // 用这个函数——量不出来就判死会把整批锁死。"值不值得把模型叫醒"另由
    // `worthCompressing()` 判（回归修复）。
    const cost = rawCostOf(zones, left)
    if (Number.isFinite(cost) && cost < MIN_L0_COST) return false
    return true
  }
  // l3 收的是"整个 L3 区"，也允许把单块再收一次（产物仍是 L3 块）——
  // 所以判据是"非空"，不是"≥2 块"。这里曾写成 `>= 2`，与 compress.js 的
  // buildOp（l3 允许 1 块）口径不一：级联于是少要一层、地图也说不可压。
  if (key === 'l3') return (zones.zones.l3 || []).length >= 1
  return (zones.zones[key] || []).length >= 2
}

// 「值得把模型叫醒」比「结构上可压」多一条要求（成本口径）：
// 拿不到原文正文时成本估不出来（Infinity），结构上也许能压，但叫醒它只会换来一次失败。
// 叫醒路径用这个；级联前提仍用 canCompressZone（否则某个量不出来就会把整批锁死）。
export function worthCompressing(zones, key, keepTurns = 0) {
  if (!canCompressZone(zones, key, keepTurns)) return false
  if (key !== 'l0') return true
  const { cutoff, cost } = l0CostOf(zones, keepTurns)
  if (cutoff === null) return false
  return Number.isFinite(cost) && cost > 0
}

// 可压原文的合计成本与上界：地图要据此区分"太少"和"量不出来"——后者说"等它再长一点"是假话。
export function l0CostOf(zones, keepTurns = 0) {
  const cutoff = lastCompressibleTurn(zones, keepTurns)
  if (cutoff === null) return { cutoff: null, cost: 0 }
  const left = zones.zones.l0.filter((n) => typeof n.turn === 'number' && n.turn <= cutoff)
  return { cutoff, cost: left.length ? rawCostOf(zones, left) : 0 }
}

// 整轮边界表：每一轮在表层上占的下标区间。
// 只用到 nodes 与轮次大纲，**不看消息**——所以"节点数≠消息数"时照样成立。
// start = 该轮第一个落在表层上的节点；end = 下一轮 start 的前一个节点（最后一轮取表尾）。
export function turnBounds(zones) {
  const nodes = zones.nodes || []
  const starts = zones.turnStarts
  const index = zones.turnStartIndex
  if (!starts || !index) return null
  const entries = starts.filter((s) => typeof index.get(s.turn) === 'number')
  const bounds = []
  for (let i = 0; i < entries.length; i += 1) {
    const start = index.get(entries[i].turn)
    const next = i + 1 < entries.length ? index.get(entries[i + 1].turn) : nodes.length
    // 空轮（轮首与下一轮轮首落在同一个下标）直接跳过，避免产出 start > end 的区间。
    if (next <= start) continue
    bounds.push({ turn: entries[i].turn, start, end: next - 1 })
  }
  return bounds
}

// 区间两端是否都落在整轮边界上。
// true = 是（切出来的是若干个完整轮次，轮内工具调用与结果天然成对）
// false = 不是（可能切开一对调用/结果，必须拒绝）
// null = 拿不到轮次大纲，判不了
export function isTurnBoundaryPair(zones, startIdx, endIdx) {
  const bounds = turnBounds(zones)
  if (!bounds || !bounds.length) return null
  // 表层最前面可能是系统/开发者消息（不属于任何轮），从 0 开始切是安全的。
  const startOk = startIdx === 0 || bounds.some((b) => b.start === startIdx)
  const endOk = bounds.some((b) => b.end === endIdx && b.start <= endIdx)
  return startOk && endOk
}

// 表层顺序自检（防护性检查）：正常金字塔从上到下必须是 L3 → L2 → L1 → 原文。
// 批次写到一半失败（或别的插件乱写）可能留下"层级倒挂"：浅层块排在深层块上面，
// 或者原文区里夹着一块。这种表层还能发请求，但之后每次压缩都会走错路，
// 而且错会一代代传下去——所以由 pre-step 报红，让人看见并修，而不是让它静默恶化。
// 只报"确定不对"的两种情形；外来块（没有我们写的块头）不参与判断，免得误报。
export function zoneOrderFault(zones) {
  if (!zones || !Array.isArray(zones.nodes)) return null
  let lastTier = 3
  let sawRaw = false
  for (const seq of zones.nodes) {
    const entry = zones.info && zones.info.get ? zones.info.get(seq) : null
    if (!entry || entry.kind === 'sys') continue
    if (entry.kind === 'raw') { sawRaw = true; continue }
    if (entry.kind !== 'block') continue
    const block = entry.block || {}
    if (block.foreign) continue
    const tier = typeof block.tier === 'number' ? block.tier : 1
    if (sawRaw) {
      return (
        `原文区下面还压着一块 L${tier}（块头「${block.title || '无标题'}」）——层级顺序倒挂了。` +
        '这种表层还能继续对话，但再压下去会静默错位。'
      )
    }
    if (tier > lastTier) {
      return (
        `块的层级顺序倒挂了：L${tier} 块排在了 L${lastTier} 块下面（块头「${block.title || '无标题'}」）。` +
        '正常金字塔从上到下必须是 L3 → L2 → L1 → 原文。'
      )
    }
    lastTier = tier
  }
  return null
}

export { CHECKPOINT_KIND, MAX_TIER }
