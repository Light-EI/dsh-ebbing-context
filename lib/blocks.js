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

export function parseHeader(text) {
  const first = (text || '').split('\n', 1)[0] || ''
  const m = HEADER_RE.exec(first)
  if (!m) return { meta: null, title: '', rest: text || '' }
  const fields = m[1].split('｜').map((s) => s.trim())
  const meta = { tier: null, turns: [null, null], events: [null, null] }
  for (const f of fields) {
    const lv = /^L([1-3])$/.exec(f)
    if (lv) meta.tier = Number(lv[1])
    const tp = /^T(\d+)(?:[–-]T?(\d+))?$/.exec(f)
    if (tp) meta.turns = [Number(tp[1]), Number(tp[2] ?? tp[1])]
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

function messageText(message) {
  const content = message && message.content
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('')
}

// 轮号来源：宿主的轮次大纲投影（key = turnOutline，state = { turns: [{turn, seq}] }）。
// 拿不到就返回 null，由上层决定是降级还是明确报错——绝不猜。
function readTurnStarts(ctx, session) {
  try {
    const projections = ctx && typeof ctx.get === 'function' ? ctx.get('sessionProjections') : null
    if (!projections || typeof projections.stateOf !== 'function') return null
    const state = projections.stateOf(session, 'turnOutline')
    if (!state || !Array.isArray(state.turns) || !state.turns.length) return null
    const starts = []
    for (const entry of state.turns) {
      if (!entry || typeof entry.turn !== 'number' || typeof entry.seq !== 'number') continue
      starts.push({ turn: entry.turn, seq: entry.seq })
    }
    if (!starts.length) return null
    starts.sort((a, b) => a.seq - b.seq)
    return starts
  } catch {
    return null
  }
}

export function readZones(ctx, session) {
  const nodes = session.surface.nodes
  const messages = session.deriveMessages()
  const bySeq = new Map()
  const nodeIndex = new Map()
  nodes.forEach((seq, i) => nodeIndex.set(seq, i))

  // 当前轮之前（严格小于它）的节点才可压；当前轮由宿主写在时间上下文里，取不到就整区不压。
  const starts = readTurnStarts(ctx, session)
  const currentTurn = starts && starts.length ? starts[starts.length - 1].turn : null

  const turnOf = (seq) => {
    if (!starts) return null
    let lo = null
    for (const s of starts) {
      if (s.seq <= seq) lo = s.turn
      else break
    }
    return lo
  }
  const startSeqOfTurn = (turn) => {
    if (!starts) return null
    const hit = starts.find((s) => s.turn === turn)
    return hit ? hit.seq : null
  }

  const sys = []
  const zones = { l3: [], l2: [], l1: [], l0: [], unknown: [] }
  const info = new Map()

  nodes.forEach((seq, index) => {
    const message = messages[index]
    if (!message) return
    const source = message.source || {}
    if (message.role === 'system' && index === 0 && sys.length === 0) {
      sys.push(seq)
      info.set(seq, { kind: 'sys' })
      return
    }
    if (message.role === 'user' && source.kind === CHECKPOINT_KIND) {
      const text = messageText(message)
      const parsed = parseHeader(text)
      // 不是我们写的块（例如手动 /compact 产生的）：没有那一行身份证，
      // 层级推不出来。宁可单独标出来让上层拒压，也不要静默当 L1 造成层级错位。
      if (!parsed.meta) {
        zones.unknown.push({ seq, text })
        info.set(seq, { kind: 'unknown' })
        return
      }
      const tier = parsed.meta && parsed.meta.tier ? parsed.meta.tier : 1
      const block = {
        seq,
        tier: Math.min(MAX_TIER, tier),
        text,
        compactionId: source.compactionId,
        title: parsed.title || readTitle(text),
        chars: [...stripTitle(text)].length,
        turns: parsed.meta ? parsed.meta.turns : [null, null],
        events: parsed.meta ? parsed.meta.events : [null, null],
      }
      zones[tier === 3 ? 'l3' : tier === 2 ? 'l2' : 'l1'].push(block)
      info.set(seq, { kind: 'block', tier: block.tier, block })
      return
    }
    const originSeq = Array.isArray(message.sourceEventSeqs) && message.sourceEventSeqs.length
      ? message.sourceEventSeqs[0]
      : seq
    zones.l0.push({ seq, originSeq, kind: 'raw', turn: turnOf(seq) })
    info.set(seq, { kind: 'raw' })
  })

  return {
    nodes,
    messages,
    bySeq,
    nodeIndex,
    sys,
    zones,
    info,
    currentTurn,
    turnStarts: starts,
    turnOf,
    startSeqOfTurn,
  }
}

// 锚点解析：
//   Tn  -> 第 n 轮里当前仍在表层的最后一个原文节点（只允许已结束的轮）
//   数字 -> 该区从 1 起的序号（l1 / l2 用；l3 不收）
export function resolveTurnAnchor(zones, label) {
  const m = /^T(\d+)$/.exec(String(label || '').trim())
  if (!m) return { ok: false, reason: '锚点写法不对：轮锚点要写成 T19 这种形式' }
  const turn = Number(m[1])
  if (zones.turnStarts === null) {
    return { ok: false, reason: '拿不到轮号信息（宿主的轮次大纲投影没挂载），这一版还不能用 T 锚点；改用不带 to 的写法之前，请先告诉我' }
  }
  if (typeof zones.currentTurn === 'number' && turn >= zones.currentTurn) {
    return { ok: false, reason: `第 ${turn} 轮还没结束（当前是第 ${zones.currentTurn} 轮），只能压已经结束的轮次` }
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
    return { ok: false, reason: `${zoneName} 区现在只有 ${list.length} 块，取不到第 ${n} 块；请重新取一次地图` }
  }
  return { ok: true, seq: list[n - 1].seq, block: list[n - 1] }
}

export { CHECKPOINT_KIND, MAX_TIER }
