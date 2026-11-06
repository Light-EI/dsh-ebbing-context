// 地图：给模型看当前表层的结构与占用。压缩前必调。
// 原则：地图只给模型自己算不出来的东西（位置、配额、结构），不给正文内容。

import { MIN_L0_COST, costOfMessage, costOfTurns, productFloor, worthCompressing, l0CostOf, lastCompressibleTurn, readZones, writableTo, zoneRangeCost } from './blocks.js'
import { estimateTokens, messageTokens } from './tokens.js'
import { makeLogger } from './log.js'

// 地图自己拿一个写日志的入口：renderMap 可能在 apply() 的作用域之外被调用，
// 拿不到那边的 log（scope 测试会拦这种写法）。延迟到第一次渲染地图时再建，
// 免得"只是 import 了地图"就顺手解析日志路径。
let mapLog = null
function logger() {
  if (!mapLog) mapLog = makeLogger('ebbing-context')
  return mapLog
}

const ZONE_LABEL = { l3: 'L3', l2: 'L2', l1: 'L1', l0: '原文' }

export function renderMap(ctx, agent, config, usage = null) {
  const session = ctx.sessions.get(agent.id)
  if (!session) return { text: '拿不到当前会话。' }

  const zones = readZones(ctx, session, agent, logger())
  // 分母与提醒线必须是同一个数（口径一致）：调用方已经算好了就照用，
  // 不要在这里用另一套实现重新推一遍——两处一旦漂移，地图和提醒会互相打架。
  const window = (usage && typeof usage.budget === 'number') ? usage.budget : readWindow(ctx, session, config)
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
    lines.push(`下面是分层占用，用插件自估（中文 1 字≈0.6 token、英文 1 字≈0.3 token，按真实用量校准）：自估合计 ${fmt(total)}${pct === null ? '' : `（${pct}%）`}`)
  } else {
    lines.push(`上下文 ${fmt(total)} token（插件自估口径；取不到宿主账单时才会走到这里）${window ? ` / 可用输入 ${fmt(window)}（${pct}%）` : ''}`)
  }
  lines.push('层序：l3 最深 ← l2 ← l1 ← l0 原文（最浅）；压某层时，比它浅且还能压的层要同批一起给')
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
    // 只有"宿主压缩留下、前面没有任何内容"的检查点会进 L3（见 blocks.js）；其余外来检查点
    // 已经按原文处理，不出现在块表里（回归修复）。
    const foreign = order.filter((b) => b.foreign).length
    if (foreign) {
      lines.push(`（其中 ${foreign} 块是宿主压缩留下来的、没有我们的块头：按 L3 收纳，l3 可以把它再折一次）`)
    }
    lines.push('')
    lines.push('块（序号按区各自从 1 起，1 = 该区最老，新压出的块追加在本区末尾）')
    lines.push('序  区    覆盖轮次    token   标题')
    order.forEach((b) => {
      // `+` 表示"覆盖到 T19 之后还没封口"：不显示它，模型会以为这块只盖到 19。
      // 下界未知、上界已知：写 `轮 ?–2`，别只写 `—`（那会让模型以为这块没有轮次信息）。
      const turns = b.turns[0] === null
        ? (typeof b.turns[1] === 'number' ? `轮 ?–${b.turns[1]}${b.turnsOpen ? '+' : ''}` : '—')
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
    return { text: lines.join('\n'), zones }
  }
  const keepTurns = Math.max(0, Number(config.keepTurns) || 0)
  const cutoff = lastCompressibleTurn(zones, keepTurns)
  // 给模型看的数字必须真能写：物理切点落在缺轮上时，可写的 to 要往回退一格（见 writableTo）。
  const writable = writableTo(zones, keepTurns)
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
  // 「只写到最早那轮」是否值得压：那一轮自己太小的话，压完不会更小，compress 必拒。
  const oldestCost = oldest === null ? null : costOfTurns(zones, [oldest])
  // 整段可压原文的合计（与 compress 的收益校验同一口径）：用来陈述"这一段一共多少 token"。
  const totalL0Cost = l0CostOf(zones, keepTurns).cost
  // 缺轮不是故障，但必须说出来：不然模型只看到"最多压到 T1"却不知道为什么（设计约束）。
  const missing = (Array.isArray(zones.turnNotes) ? zones.turnNotes : [])
    .filter((n) => n && n.reason === 'missing')
    .map((n) => n.turn)
  // 原文区里混进过来历不明的压缩摘要（查不到压缩事务）：按原文算，会跟着同一段一起被压成摘要块。
  const foreignRaw = (zones.zones && Array.isArray(zones.zones.l0) ? zones.zones.l0 : []).filter((n) => n && n.foreign).length
  // 首界标之前的无主原文（回归修复）：没有轮号可归，地图必须点出来，否则模型按轮号索引
  // 会以为那段内容不存在（这些内容会被一起压进第一块）。
  const orphan = zones.orphan
  const orphanNote = orphan
    ? `（原文区最早还有 ${orphan.count} 条没有轮号的消息（事件号 ${orphan.firstSeq === orphan.lastSeq ? String(orphan.firstSeq) : `${orphan.firstSeq}–${orphan.lastSeq}`}）——最早的轮次记录丢了；这些内容会被一起压进第一块，块头会标"T?–"）`
    : ''
  const foreignRawNote = foreignRaw
    ? `（原文区里有 ${foreignRaw} 段来历不明的压缩摘要，已按普通原文算：它没有可核对的边界，会跟着同一段一起压进摘要块）`
    : ''
  // 可写区间内、却又写不得的轮号（缺轮）：单独列出来，别让模型照着主句的区间照抄（审查 A#2）。
  const missingInRange = missing
    .filter((t) => typeof t === 'number' && oldest !== null && t >= oldest && t <= cutoff)
    .sort((a, b) => a - b)
  const missingNote = missing.length
    ? `（轮次记录里缺了${missing.length > 2 ? `第 ${missing[0]} 轮等 ${missing.length} 个轮次` : `第 ${missing.join('、')} 轮`}；它没有自己的边界，压到它前一轮时会把它的内容一起压进块里——标签会粗一档，切点仍然是真边界）`
    : ''
  const l0Base = zones.outlineFault
    ? `暂不可用：轮次大纲损坏（${zones.outlineFault === 'gap' ? '缺轮' : '乱序'}），判不准每一轮到哪儿结束。l1 / l2 的 to 不受影响`
    : zones.turnStarts === null
    ? '暂不可用：拿不到轮号（宿主的轮次大纲投影没挂载）。这不是"没有原文"，是这一版判不了轮的边界'
    : keepEatsAll
      ? `暂不可用：keepTurns=${keepTurns} 把现有轮次全保住了（当前才第 ${zones.currentTurn ?? '?'} 轮），可压范围是空的；把 keepTurns 调小或等轮次多了再压`
      : rawTurnList.length
          ? (worthCompressing(zones, 'l0', keepTurns)
            ? `可写 to=${writable === oldest ? `T${oldest}` : `T${oldest}–T${writable}`}（原文区最老的是 T${oldest}，当前第 ${zones.currentTurn ?? '?'} 轮${kept}）；` +
              `落在表层上的轮：${rawTurnShown}${rawTurnMore}。` +
              (missingInRange.length
                ? `缺的轮号 ${missingInRange.map((t) => `T${t}`).join('、')} 写不得——它们没有 ` +
                  'turn/start，边界不可知，写了必被拒；写到缺轮前一轮时会把它们的内容一起带走（块头会标 +）。'
                : '') +
              (writable !== null && writable > oldest
                ? (Number.isFinite(oldestCost) && oldestCost < MIN_L0_COST
                  // 只给两端的事实：最早那一轮自己压不动，是因为它连块头开销都盖不住。
                  // 不写"该并到哪一轮"——那等于替模型选区间（SPEC §6：只陈述事实）。
                  ? `最早那一轮（T${oldest}）单独是 ${oldestCost} token（${MIN_L0_COST} 是整段的叫醒门槛，不管单轮；能不能压要看地板 ${productFloor('l0', config)}）；T${oldest}–T${writable} 整段合计 ${Number.isFinite(totalL0Cost) ? totalL0Cost : '?'} token`
                  : `T${oldest} 单独是 ${oldestCost} token；T${oldest}–T${writable} 整段合计 ${Number.isFinite(totalL0Cost) ? totalL0Cost : '?'} token`)
                : `只写 T${oldest}：被压 ${oldestCost === null ? '?' : oldestCost} token`)
            // 压完必须比被压内容小（§4.7）：剩下这一小段连块头开销都盖不住时，
            // 地图先说"压不了"，别把模型叫来压一次然后被拒（口径一致）。
            : (Number.isFinite(l0CostOf(zones, keepTurns).cost)
              ? `未列入提醒范围：可压的原文合计低于叫醒门槛（${MIN_L0_COST} token）。这是"值不值得叫醒"的门槛，不是压不动的硬边界（地板是 ${productFloor('l0', config)}）；这么短的段落压完通常省不了多少`
              : `暂不可用：可压原文的成本量不出来（有正文取不回），别按'等它再长'理解；真的要压的时候会自己再判一次`))
          : `暂不可用：没有可压的原文（当前是第 ${zones.currentTurn ?? '?'} 轮${kept}）`
  // orphanNote 必须无条件带上：无主原文最常见的情形恰恰是"算不出可压轮次"那几条分支，
  // 只在可压分支里说，等于最需要说的时候不说（回归修复）。
  lines.push(`l0  压原文区最旧的一段 -> ` + l0Base + orphanNote + missingNote + foreignRawNote)
  // 轮次标记：模型在写 to 时唯一能把"轮号"落到"表层里那一段"的锚。
  // 装插件之前的老轮次没有标记，所以还得回到"按地图给的轮号认"这条老路。
  if (zones.zones.l0.length) {
    lines.push('    （原文区里每条〔轮次标记〕后面紧跟的就是它写的那一轮；装插件之前的老轮次没有标记，按上面给的轮号认）')
  }
  const maxL1 = zones.zones.l1.length - 1
  const maxL2 = zones.zones.l2.length - 1
  // 成本判据：可压区间连改写开销都盖不住时，compress 一定拒——地图先说清楚，
  // 别让模型照着"可写"去撞一次（与 compress 的收益校验同一口径）。
  const floorTok = (key) => productFloor(key, config)
  const costL1 = zoneRangeCost(zones, 'l1')
  const costL2 = zoneRangeCost(zones, 'l2')
  const costL3 = zoneRangeCost(zones, 'l3')
  // 两边的事实：可压段一共多少 token、以及留给"摘要+标题"的剩余预算。
  // 后者 = 可压段 − 一块的最小产物成本（摘要≈0 时的开销），所以模型写得比它长就过不了收益校验。
  const budgetOf = (cost, key) => Math.max(0, cost - floorTok(key))
  const tooSmall = (cost, key) =>
    `暂不可用：可压的块合计 ${cost} token，盖不住一块的最小产物成本（约 ${floorTok(key)} token），压完反而更大`
  const budgetNote = (cost, key) => `这一段合计 ${cost} token；摘要+标题合计不超过 ${budgetOf(cost, key)} token 才过收益校验`
  // 只并第一块时的预算：整段的数字对 to=1 是虚构的（97 的块配不下 119 的预算）。
  const firstOnly = (key) => {
    const list = zones.zones[key] || []
    const first = list.length > 0 ? zones.messageFor(list[0].seq) : null
    return first ? costOfMessage(zones, first) : 0
  }
  const firstOk = (key) => { const cost = firstOnly(key); return !cost || cost >= floorTok(key) }
  const firstNote = (key) => {
    const cost = firstOnly(key)
    if (!cost) return ''
    return cost >= floorTok(key)
      ? `to=1 只并最老的一块（${cost} token，够改写开销）`
      : `to=1 只并最老的一块（${cost} token，单独写必被拒）`
  }
  lines.push(
    // 标题里直接写真实可写范围：写「前 N 块」会让模型以为 N 是个要它自己算的占位符，
    // 而压不动的时候那句话又变成半截话（"前 N 块 -> 暂不可用"）。
    `l1  压 L1 区最老的${maxL1 >= 1 ? ` 1–${maxL1} 块` : '一段'} -> ` +
      (maxL1 >= 1
        ? (costL1 >= floorTok('l1')
          ? `${firstOk('l1') || maxL1 < 2 ? `可写 to=1–${maxL1}` : `可写 to=2–${maxL1}（to=1 单独不可行）`}（该区共 ${zones.zones.l1.length} 块，1 最老；最后一块不能压）。` +
            `${firstNote('l1')}；to=${maxL1} 一次并 ${maxL1} 块。${budgetNote(costL1, 'l1')}`
          : tooSmall(costL1, 'l1'))
        : '暂不可用：L1 区不足 2 块（最后一块不能压）')
  )
  lines.push(
    `l2  压 L2 区最老的${maxL2 >= 1 ? ` 1–${maxL2} 块` : '一段'}（产物是新的 L3 块，旧 L3 不动）-> ` +
      (maxL2 >= 1
        ? (costL2 >= floorTok('l2')
          ? `${firstOk('l2') || maxL2 < 2 ? `可写 to=1–${maxL2}` : `可写 to=2–${maxL2}（to=1 单独不可行）`}（该区共 ${zones.zones.l2.length} 块，1 最老；最后一块不能压）。` +
            `${firstNote('l2')}；to=${maxL2} 一次并 ${maxL2} 块。${budgetNote(costL2, 'l2')}`
          : tooSmall(costL2, 'l2'))
        : '暂不可用：L2 区不足 2 块（最后一块不能压）')
  )
  lines.push(`l3  把整个 L3 区压成一块（不写 to）-> ${
    zones.zones.l3.length
      ? (costL3 >= floorTok('l3') ? `现在有 ${zones.zones.l3.length} 块，可压。${budgetNote(costL3, 'l3')}` : tooSmall(costL3, 'l3'))
      : '暂不可用：L3 区为空'}`)

  lines.push('')
  lines.push('压缩须知')
  lines.push('· 只压已经结束、结果已落地的轮次；当前轮和进行中的步骤不可压。')
  lines.push('· 级联：压 l1/l2/l3 时，比它浅、且还能压的层要同批一起给，只给深层会整批被拒。')
  lines.push('· 压完必须比被压掉的内容小，不达标整批不写并返回两侧实测值；区间取多大由你权衡（越大省得越多、细节留得越少）。')

  return { text: lines.join('\n'), zones }
}

// 用插件自己的估算器给每个节点计价：中文 0.6 token/字、英文 0.3 token/字，
// 和真实账单只差几个百分点（宿主按 4 字 1 token，对中文低估约 2.4 倍）。
// 原文区（含系统头）走 costOfMessage：本步有路由图片价时按真实价，否则退回 800。
// 判定链（叫醒/MIN_L0_COST/收益校验）用的是同一把尺子，这里不许另开一套。
function ownPrices(zones) {
  const prices = new Map()
  for (const name of ['l1', 'l2', 'l3']) {
    for (const b of zones.zones[name]) prices.set(b.seq, estimateTokens(b.text || ''))
  }
  for (const n of zones.zones.l0) {
    prices.set(n.seq, costOfMessage(zones, zones.messageFor(n.seq)))
  }
  for (const seq of zones.sys) {
    prices.set(seq, costOfMessage(zones, zones.messageFor(seq)))
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
