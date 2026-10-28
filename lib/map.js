// 地图：给模型看当前表层的结构与占用。压缩前必调。
// 原则：地图只给模型自己算不出来的东西（位置、配额、结构），不给正文内容。

import { readZones } from './blocks.js'
import { estimateTokens } from './tokens.js'

const ZONE_LABEL = { l3: 'L3', l2: 'L2', l1: 'L1', l0: '原文' }

export function renderMap(ctx, agent, config) {
  const session = ctx.sessions.get(agent.id)
  if (!session) return { text: '拿不到当前会话。' }

  const zones = readZones(ctx, session)
  const window = readWindow(ctx, session)
  const prices = ownPrices(zones)

  const used = { l3: 0, l2: 0, l1: 0, l0: 0 }
  for (const name of ['l3', 'l2', 'l1']) {
    for (const b of zones.zones[name]) used[name] += prices.get(b.seq) || 0
  }
  for (const n of zones.zones.l0) used.l0 += prices.get(n.seq) || 0
  const sysTokens = zones.sys.length ? prices.get(zones.sys[0]) || 0 : 0
  const total = sysTokens + used.l3 + used.l2 + used.l1 + used.l0
  const pct = window ? Math.round((total / window) * 1000) / 10 : null

  const lines = []
  lines.push(`上下文 ${fmt(total)} token（按插件自己的估算口径，中文按 1 字 1 token；宿主的估算器按 4 字 1 token，中文会低估）${window ? ` / 窗口 ${fmt(window)}（${pct}%）` : ''}`)
  lines.push('')
  lines.push('区域   已用        区上限（参考）  单块上限')
  for (const name of ['l3', 'l2', 'l1']) {
    const cap = window ? Math.floor(window * config.budget[name]) : null
    const over = cap !== null && used[name] > cap ? ' ⚠已超设计容量（只影响提醒，不阻止压缩）' : ''
    lines.push(`${ZONE_LABEL[name].padEnd(6)}${fmt(used[name]).padEnd(12)}${(cap === null ? '—' : fmt(cap)).padEnd(16)}${config.segment[name]} token${over}`)
  }
  lines.push(`原文  ${fmt(used.l0)}       —               —`)

  // 块的序号按区各自从 1 起：`to` 就是这个序号，别混着用。
  const order = []
  for (const name of ['l3', 'l2', 'l1']) {
    const list = zones.zones[name]
    const ordered = name === 'l3' ? list : list.slice()
    ordered.forEach((b, i) => order.push({ ...b, zone: name, no: i + 1 }))
  }

  if (order.length) {
    lines.push('')
    lines.push('块（序号按区各自从 1 起；L1/L2 区 1 = 该区最老，新压出的块追加在本区末尾；L3 区 1 = 最上面那块，也就是最新的）')
    lines.push('序  区    覆盖轮次    token   标题')
    order.forEach((b) => {
      const turns = b.turns[0] === null ? '—' : `轮 ${b.turns[0]}–${b.turns[1]}`
      lines.push(`${String(b.no).padEnd(4)}${ZONE_LABEL[b.zone].padEnd(6)}${turns.padEnd(12)}${String(prices.get(b.seq) || 0).padStart(6)} token  ${b.title || '（无标题）'}`)
    })
  } else {
    lines.push('')
    lines.push('块：还没有任何压缩块。')
  }

  lines.push('')
  lines.push('可压位置（to 就从这里抄，别自己数）')
  const rawTurns = zones.zones.l0
    .filter((n) => typeof n.turn === 'number' && n.turn < (zones.currentTurn ?? Infinity))
    .map((n) => n.turn)
  const maxRawTurn = rawTurns.length ? Math.max(...rawTurns) : null
  lines.push(`l0  压原文区最旧的一段 -> ${maxRawTurn !== null ? `to 可写 T1 … T${maxRawTurn}（当前是第 ${zones.currentTurn ?? '?'} 轮，当前轮不可压；越靠后区间越大）` : '暂不可用：没有已结束轮次的原文'}`)
  lines.push(`l1  压 L1 区最老的前 N 块 -> ${zones.zones.l1.length ? `to 可写 1 … ${zones.zones.l1.length}` : '暂不可用：L1 区为空'}`)
  lines.push(`l2  压 L2 区最老的前 N 块（会把 L3 区一起吸收）-> ${zones.zones.l2.length ? `to 可写 1 … ${zones.zones.l2.length}` : '暂不可用：L2 区为空'}`)
  lines.push(`l3  把整个 L3 区压成一块（不写 to）-> ${zones.zones.l3.length ? `现在有 ${zones.zones.l3.length} 块，可压` : '暂不可用：L3 区为空'}`)

  lines.push('')
  lines.push('压缩须知')
  lines.push('· 当前轮和进行中的步骤不可压，只压已经结束、结果已落地的轮次。')
  lines.push('· 一次调用可以给多个键，一起给只断一次前缀缓存；填表顺序 l3 → l2 → l1 → l0。')
  lines.push('· 压完不够短会被拒并返回实测数字，把区间往大了取，被拒不丢内容。')

  return { text: lines.join('\n') }
}

// 用插件自己的估算器给每个节点计价：中文按 1 字 1 token，不会被宿主的口径低估 4 倍。
function ownPrices(zones) {
  const prices = new Map()
  for (const name of ['l1', 'l2', 'l3']) {
    for (const b of zones.zones[name]) prices.set(b.seq, estimateTokens(b.text || ''))
  }
  for (const n of zones.zones.l0) {
    const index = zones.nodeIndex.get(n.seq)
    const message = index === undefined ? null : zones.messages[index]
    prices.set(n.seq, estimateTokens(textOf(message)))
  }
  for (const seq of zones.sys) {
    const index = zones.nodeIndex.get(seq)
    const message = index === undefined ? null : zones.messages[index]
    prices.set(seq, estimateTokens(textOf(message)))
  }
  return prices
}

function textOf(message) {
  const content = message && message.content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') text += block.text
    else if (block.type === 'image') text += 'x'.repeat(800)
  }
  return text
}

function readWindow(ctx, session) {
  try {
    const rc = session.requestContext && session.requestContext()
    if (rc && typeof rc.contextWindow === 'number') return rc.contextWindow
  } catch {}
  try {
    const state = ctx.sessionProjections?.stateOf?.(session, 'contextPressure')
    if (state && typeof state.contextWindow === 'number') return state.contextWindow
  } catch {}
  return null
}

function fmt(n) {
  if (typeof n !== 'number') return '—'
  return n.toLocaleString('en-US')
}
