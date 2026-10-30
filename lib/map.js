// 地图：给模型看当前表层的结构与占用。压缩前必调。
// 原则：地图只给模型自己算不出来的东西（位置、配额、结构），不给正文内容。

import { lastCompressibleTurn, readZones } from './blocks.js'
import { estimateTokens, messageTokens } from './tokens.js'

const ZONE_LABEL = { l3: 'L3', l2: 'L2', l1: 'L1', l0: '原文' }

export function renderMap(ctx, agent, config, usage = null) {
  const session = ctx.sessions.get(agent.id)
  if (!session) return { text: '拿不到当前会话。' }

  const zones = readZones(ctx, session)
  const window = readWindow(ctx, session, config)
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
  // 总量只报一个数，用宿主账单口径（上次请求真实用量 + 之后的估算增量），和提醒线同源。
  // 分层占比仍用自估，并明确标注——不然模型会看到两个互相打架的百分比。
  if (usage && typeof usage.used === 'number') {
    const hostPct = usage.ratio != null ? Math.round(usage.ratio * 1000) / 10 : null
    lines.push(`上下文 ${fmt(usage.used)} token（按宿主账单口径，与提醒线同源）${window ? ` / 可用输入 ${fmt(window)}（${hostPct}%）` : ''}`)
    lines.push(`下面是分层占用，用插件自估（中文 1 字≈1 token，会略高于真实账单，只看相对大小）：自估合计 ${fmt(total)}${pct === null ? '' : `（${pct}%）`}`)
  } else {
    lines.push(`上下文 ${fmt(total)} token（插件自估口径；取不到宿主账单时才会走到这里）${window ? ` / 可用输入 ${fmt(window)}（${pct}%）` : ''}`)
  }
  lines.push('')
  lines.push('区域   已用（占可用输入）  区上限（参考）  单块上限')
  const share = (n) => (window && window > 0 ? `（${(Math.round((n / window) * 1000) / 10).toFixed(1)}%）` : '')
  for (const name of ['l3', 'l2', 'l1']) {
    // 取整方式要和提醒判定（index.js 的 readZoneOver 用 Math.round）一致，
    // 否则同一条线在地图上显示"已超"、在提醒里却不触发，最多差 1 token。
    const cap = window ? Math.round(window * config.budget[name]) : null
    const over = cap !== null && used[name] > cap ? ' ⚠已超设计容量（只影响提醒，不阻止压缩）' : ''
    lines.push(`${ZONE_LABEL[name].padEnd(6)}${(fmt(used[name]) + share(used[name])).padEnd(20)}${(cap === null ? '—' : fmt(cap)).padEnd(16)}${config.segment[name]} token${over}`)
  }
  lines.push(`原文  ${(fmt(used.l0) + share(used.l0)).padEnd(20)}—               —`)

  // 宿主的 deriveMessages() 会跳过派生为空的节点（截断的空助手回复、空注入）。
  // 这不影响压缩：插件按节点逐个投影（`blocks.js` 的 `deriveExactly`），空节点只是被跳过。
  // 但要在图上说明，否则"节点数≠消息数"看起来像 bug。
  const emptyNodes = zones.messages ? zones.nodes.length - zones.messages.length : 0
  if (emptyNodes > 0) {
    // 这些节点没有消息，但它们仍然占着表层位置。插件按节点逐个投影（见 blocks.js 的
    // `deriveExactly`），所以它们只是被跳过，不影响判断块在哪、也不影响区间划分。
    lines.push(`注意 表层 ${zones.nodes.length} 个节点里有 ${emptyNodes} 个空节点（宿主写的空消息，不产生请求内容）：它们会被跳过，不影响压缩。`)
  }

  // 块的序号按区各自从 1 起：`to` 就是这个序号，别混着用。
  const order = []
  for (const name of ['l3', 'l2', 'l1']) {
    const list = zones.zones[name]
    const ordered = name === 'l3' ? list : list.slice()
    ordered.forEach((b, i) => order.push({ ...b, zone: name, no: i + 1 }))
  }

  if (order.length) {
    const foreign = order.filter((b) => b.foreign).length
    if (foreign) lines.push(`（其中 ${foreign} 块不是本插件写的，按 L1 收纳：外来检查点的层级推不出来）`)
    lines.push('')
    lines.push('块（序号按区各自从 1 起，1 = 该区最老，新压出的块追加在本区末尾）')
    lines.push('序  区    覆盖轮次    token   标题')
    order.forEach((b) => {
      // `+` 表示"覆盖到 T19 之后还没封口"：不显示它，模型会以为这块只盖到 19。
      const turns = b.turns[0] === null
        ? '—'
        : `轮 ${b.turns[0]}–${b.turns[1]}${b.turnsOpen ? '+' : ''}`
      lines.push(`${String(b.no).padEnd(4)}${ZONE_LABEL[b.zone].padEnd(6)}${turns.padEnd(12)}${String(prices.get(b.seq) || 0).padStart(6)} token  ${b.title || '（无标题）'}`)
    })
  } else {
    lines.push('')
    lines.push('块：还没有任何压缩块。')
  }

  lines.push('')
  lines.push('可压位置（to 就从这里抄，别自己数）')
  if (zones.ambiguous) {
    lines.push(
      '这张地图只供查看：表层里有内容为空的步骤（宿主把它们跳过了），而表层上已经有压缩块，' +
        '块的位置推不出来。这一版整批拒绝压缩，免得把旧摘要再压成一份新的。别用宿主自带的压缩顶替（那会把分层拍平）'
    )
    // 下面每一行都是"可写 to=…"，在这个状态下它们全是假话（compress 会整批拒绝），
    // 同一张地图里既说"压不了"又说"可写 to=T16"只会把模型骗去撞一次拒绝。直接收尾。
    return { text: lines.join('\n') }
  }
  const keepTurns = Math.max(0, Number(config.keepTurns) || 0)
  const cutoff = lastCompressibleTurn(zones, keepTurns)
  const rawTurns = zones.zones.l0
    .filter((n) => typeof n.turn === 'number' && cutoff !== null && n.turn <= cutoff)
    .map((n) => n.turn)
  const rawTurnList = Array.from(new Set(rawTurns)).sort((a, b) => a - b)
  // 只列真实还有原文、且不在 keepTurns 保护圈里的轮号：早被压进摘要块的轮在表层上已经不存在。
  const rawTurnShown = rawTurnList.slice(0, 14).map((t) => `T${t}`).join(' ')
  const rawTurnMore = rawTurnList.length > 14 ? ` …（共 ${rawTurnList.length} 个）` : ''
  const kept = keepTurns > 0 ? `、最后 ${keepTurns} 轮要留着` : ''
  const keepEatsAll = zones.turnStarts !== null && cutoff === null && keepTurns > 0
  const oldest = rawTurnList.length ? rawTurnList[0] : null
  lines.push(
    `l0  压原文区最旧的一段 -> ` +
      (zones.outlineFault === 'current'
        ? '暂不可用：当前轮在表层上一个节点都没有（轮次大纲可能超前），这一版不敢把任何一轮当已结束轮。l1 / l2 的 to 不受影响'
        : zones.outlineFault
          ? '暂不可用：轮次大纲不连续（缺轮或乱序），判不准每一轮到哪儿结束。l1 / l2 的 to 不受影响'
          : zones.turnStarts === null
        ? '暂不可用：拿不到轮号（宿主的轮次大纲投影没挂载）。这不是"没有原文"，是这一版判不了轮的边界'
        : keepEatsAll
          ? `暂不可用：keepTurns=${keepTurns} 把现有轮次全保住了（当前才第 ${zones.currentTurn ?? '?'} 轮），可压范围是空的；把 keepTurns 调小或等轮次多了再压`
          : rawTurnList.length
            ? `可写 to=T${oldest}–T${cutoff}（原文区最老的是 T${oldest}，当前第 ${zones.currentTurn ?? '?'} 轮${kept}）；` +
              `落在表层上的轮：${rawTurnShown}${rawTurnMore}。` +
              (cutoff > oldest
                ? `写到 T${oldest} 只并最早的一轮；写到 T${cutoff} 把这几轮全并成一块，细节只留在摘要里`
                : `写到 T${oldest} 就是最早的一轮`)
            : `暂不可用：没有可压的原文（当前是第 ${zones.currentTurn ?? '?'} 轮${kept}）`)
  )
  const maxL1 = zones.zones.l1.length - 1
  const maxL2 = zones.zones.l2.length - 1
  lines.push(
    `l1  压 L1 区最老的前 N 块 -> ` +
      (maxL1 >= 1
        ? `可写 to=1–${maxL1}（该区共 ${zones.zones.l1.length} 块，1 最老；最后一块不能压）。` +
          `to=1 只并最老的一块；to=${maxL1} 一次并 ${maxL1} 块`
        : '暂不可用：L1 区不足 2 块（最后一块不能压）')
  )
  lines.push(
    `l2  压 L2 区最老的前 N 块（产物是新的 L3 块，旧 L3 不动）-> ` +
      (maxL2 >= 1
        ? `可写 to=1–${maxL2}（该区共 ${zones.zones.l2.length} 块，1 最老；最后一块不能压）。` +
          `to=1 只并最老的一块；to=${maxL2} 一次并 ${maxL2} 块`
        : '暂不可用：L2 区不足 2 块（最后一块不能压）')
  )
  lines.push(`l3  把整个 L3 区压成一块（不写 to）-> ${zones.zones.l3.length ? `现在有 ${zones.zones.l3.length} 块，可压` : '暂不可用：L3 区为空'}`)

  lines.push('')
  lines.push('压缩须知')
  lines.push('· 只压已经结束、结果已落地的轮次；当前轮和进行中的步骤不可压。')
  lines.push('· 级联：压 l1/l2/l3 时，比它浅、且还能压的层要同批一起给，只给深层会整批被拒。')
  lines.push('· 压完必须比被压掉的内容小，不达标整批不写并返回两侧实测值；区间取多大由你权衡（越大省得越多、细节留得越少）。')

  return { text: lines.join('\n') }
}

// 用插件自己的估算器给每个节点计价：中文按 1 字 1 token，不会被宿主的口径低估 4 倍。
function ownPrices(zones) {
  const prices = new Map()
  for (const name of ['l1', 'l2', 'l3']) {
    for (const b of zones.zones[name]) prices.set(b.seq, estimateTokens(b.text || ''))
  }
  for (const n of zones.zones.l0) {
    prices.set(n.seq, messageTokens(zones.messageFor(n.seq)))
  }
  for (const seq of zones.sys) {
    prices.set(seq, messageTokens(zones.messageFor(seq)))
  }
  return prices
}

// 可用输入预算 = 总窗口 − 输出预留（与提醒线同一口径）。
// 输出预留：优先读这条路由真实用的 maxTokens，读不到用配置兜底。
function reserveOf(ctx, session, config) {
  try {
    const h = session && session.requestHeader ? session.requestHeader() : undefined
    const mt = h && h.config && h.config.maxTokens
    if (typeof mt === "number" && mt > 0) return mt
  } catch {}
  const f = config && config.reservedTokens
  return typeof f === "number" && f > 0 ? f : 0
}

function readWindow(ctx, session, config) {
  // 分母必须和 readUsage 用的"可用输入预算"是同一个数，否则会出现
  // "占用 40% 却显示 分母 5000" 这种自相矛盾的展示（reservedTokens 配得离谱时）。
  const budgetOf = (win) => Math.max(Math.floor(win * 0.1), win - reserveOf(ctx, session, config))
  try {
    const rc = session.requestContext && session.requestContext()
    if (rc && typeof rc.contextWindow === 'number') return budgetOf(rc.contextWindow)
  } catch {}
  // 0.2.1 的 tokenMeter 没有 contextPressure()，只有 0.2.2 才有；先试服务方法，再退回投影。
  try {
    const tm = ctx.tokenMeter
    if (tm && typeof tm.contextPressure === 'function') {
      const p = tm.contextPressure(session)
      if (p && typeof p.contextWindow === 'number') return budgetOf(p.contextWindow)
    }
  } catch {}
  try {
    const state = ctx.sessionProjections?.stateOf?.(session, 'contextPressure')
    if (state && typeof state.contextWindow === 'number') return budgetOf(state.contextWindow)
  } catch {}
  return null
}

function fmt(n) {
  if (typeof n !== 'number') return '—'
  return n.toLocaleString('en-US')
}
