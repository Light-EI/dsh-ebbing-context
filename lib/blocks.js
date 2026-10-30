// 表层分诊：只用两个公开面就把当前表层分成四区。
//   - session.surface.nodes  → 节点 seq（模型可见顺序）
//   - session.deriveMessages() → 与 nodes 一一对应的消息（含 source）
// 不读事件日志（eventAt / snapshotEvents / ownEvents 均已 @deprecated，禁止新增调用）。
//
// 块的层级与覆盖范围不靠日志反推，而是**写在块自己身上**：
// 正文第一行是 〔L2｜T16–T19｜ev 4121–4390〕标题
// 这样插件不需要任何台账：重启、换机器、甚至卸载插件之后，块仍然是自解释的一行消息。

const CHECKPOINT_KIND = 'compact-checkpoint'
const MAX_TIER = 3

// 〔L2｜T16–T19｜ev 4121–4390〕标题
const HEADER_RE = /^〔([^〕]*)〕(.*)$/

// 兜底认法：宿主写在检查点正文开头的那句固定前导语（我们逐字节复刻过）。
// 万一 source 标记变了或这条被别的工具重写过，也不能把它当成普通原文去压。
const PREAMBLE_HEAD = 'This is an automatically generated checkpoint'
function looksLikeCheckpointText(text) {
  return typeof text === 'string' && text.trimStart().startsWith(PREAMBLE_HEAD)
}

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

// 轮号来源：宿主的轮次大纲投影（key = turnOutline，state = { turns: [{turn, seq}] }）。
// 拿不到就退回自己扫日志（见 turnsFromLog）——绝不猜。
// 投影本身也可能是坏的（缺轮、乱序）：那就换日志那条路，只要日志那串是连续的。
function soundnessOf(starts) {
  if (!starts || !starts.length) return 'gap'
  for (let i = 1; i < starts.length; i += 1) {
    if (starts[i].turn !== starts[i - 1].turn + 1) return 'gap'
    if (starts[i].seq <= starts[i - 1].seq) return 'order'
  }
  return null
}

function readTurnStarts(ctx, session) {
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
  // 投影没挂上（某些装配里 turnOutline 并不存在），或投影自己缺轮/乱序：
  // 都改读日志。宿主每开一轮都 `session.append("turn/start", { turn })`（dsh-agent-loop:731），
  // 事件号就是下标，信息是完备的——投影只是快路径，不是更准的来源。
  const fromLog = turnsFromLog(session)
  if (projected && !soundnessOf(projected)) return projected
  if (fromLog && !soundnessOf(fromLog)) return fromLog
  return projected || fromLog
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

export function readZones(ctx, session) {
  const nodes = session.surface.nodes
  const messages = session.deriveMessages()
  const nodeIndex = new Map()
  nodes.forEach((seq, i) => nodeIndex.set(seq, i))

  // 当前轮之前（严格小于它）的节点才可压；当前轮由宿主写在时间上下文里，取不到就整区不压。
  const starts = readTurnStarts(ctx, session)
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

  // 大纲自检（O(轮数)）：轮号必须连续、seq 必须严格递增，且当前轮必须在表层上还有节点。
  // 少了任何一条，"某轮的地标"就可能指到别的轮上，于是 `to` 会静默压掉不在它名下的一轮。
  // 这类故障在宿主侧属于异常恢复情形（投影超前或滞后、缺轮），插件不发号施令，只拒绝 l0。
  let outlineFault = null
  if (starts) {
    for (let i = 1; i < starts.length; i += 1) {
      if (starts[i].turn !== starts[i - 1].turn + 1) { outlineFault = 'gap'; break }
      if (starts[i].seq <= starts[i - 1].seq) { outlineFault = 'order'; break }
    }
    if (outlineFault === null && startIndex.get(currentTurn) === null) outlineFault = 'current'
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
      if (m && m.role === 'user' && ((m.source && m.source.kind === CHECKPOINT_KIND) || looksLikeCheckpointText(messageText(m)))) {
        blockLike += 1
      }
    }
  }
  const ambiguous = !aligned && blockLike > 0
  const trusted = exact !== null || messages.length === nodes.length
  const firstMessage = messages[0] || null

  nodes.forEach((seq, index) => {
    const message = messageOf(index, seq)
    // 空的节点没有消息（宿主跳过了它）：从分类里整体跳过。
    // 只有在"能确认这个节点确实没有消息"时才跳过——否则老退化路径下会把整表丢掉。
    if (index > 0 && !message && trusted) return
    const source = (message && message.source) || {}
    // 节点 0 的判定只能用"节点 0 自己的消息"。以前用的是 messages[0]（第一条第派生消息），
    // 一旦节点 0 是空系统消息被宿主跳过，messages[0] 就是第 2 个节点的消息，于是节点 0
    // 掉进原文区——之后任何覆盖它的 l0 压缩都会被宿主的 node0 保护拒掉，而且每次失败。
    // 数量不等时分不清节点 0 到底是什么，按"头部"处理：宁可少压一条，也不去碰宿主那一道闸。
    const isHead = index === 0 && sys.length === 0 &&
      (!aligned || (message && (message.role === 'system' || message.role === 'developer')))
    if (isHead) {
      sys.push(seq)
      info.set(seq, { kind: 'sys' })
      return
    }
    if (message && message.role === 'user' && (source.kind === CHECKPOINT_KIND || looksLikeCheckpointText(messageText(message)))) {
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
    turnStarts: starts,
    turnStartIndex: startIndex,
    aligned,
    ambiguous,
    outlineFault,
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
    const cutoff = zones.currentTurn - keepTurns
    if (cutoff < 1) {
      return {
        ok: false,
        reason:
          `现在才第 ${zones.currentTurn} 轮，而 keepTurns=${keepTurns} 要把最近 ${keepTurns} 轮全留住，` +
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
  return { ok: true, seq: hit.seq }
}

export function resolveZoneIndex(zones, zoneName, index) {
  const list = zones.zones[zoneName]
  const n = Number(index)
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
// 拿不到轮号时返回 null（调用方据此说"判不了轮"，不要说"没有原文"）。
export function lastCompressibleTurn(zones, keepTurns = 0) {
  if (typeof zones.currentTurn !== 'number') return null
  const cutoff = zones.currentTurn - Math.max(0, keepTurns)
  return cutoff >= 1 ? cutoff : null
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
    return zones.zones.l0.some((n) => typeof n.turn === 'number' && n.turn <= cutoff)
  }
  // l3 收的是"整个 L3 区"，也允许把单块再收一次（产物仍是 L3 块）——
  // 所以判据是"非空"，不是"≥2 块"。这里曾写成 `>= 2`，与 compress.js 的
  // buildOp（l3 允许 1 块）口径不一：级联于是少要一层、地图也说不可压。
  if (key === 'l3') return (zones.zones.l3 || []).length >= 1
  return (zones.zones[key] || []).length >= 2
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

export { CHECKPOINT_KIND, MAX_TIER }
