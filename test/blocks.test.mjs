// 区块划分与锚点解析的断言测试（失败以非零退出码结束）。
// 跑法：node plugin/test/blocks.test.mjs
import { canCompressZone, isTurnBoundaryPair, lastCompressibleTurn, parseHeader, readZones, resolveTurnAnchor, resolveZoneIndex, turnBounds } from '../lib/blocks.js'

let failed = 0
let total = 0
const check = (name, cond, detail) => {
  total++
  if (cond) return
  console.error(`FAIL ${name}${detail ? ' :: ' + detail : ''}`)
  failed++
}

// 造一个"宿主原位替换过"的表层：
//   下标 0 系统提示（seq 5）
//   第 1 轮的 turn/start 事件号是 9（只进日志，不是表层节点）；下标 1 是它的 user 消息（seq 10）
//   下标 2 第 1 轮的工具结果——被 pruner 原位替换过，事件号变成 100（比第 2 轮轮首还大）
//   下标 3 第 2 轮的 user 消息（seq 50，轮首）
//   下标 4 第 2 轮的 assistant 消息（seq 60）
const nodes = [5, 10, 100, 50, 60]
const messages = [
  { role: 'system', content: [{ type: 'text', text: 'sys' }] },
  { role: 'user', content: [{ type: 'text', text: 'T1 的问题' }] },
  { role: 'tool', content: [{ type: 'text', text: '被剪过的工具结果' }], sourceEventSeqs: [100] },
  { role: 'user', content: [{ type: 'text', text: 'T2 的问题' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'T2 的回答' }] },
]
const session = { surface: { nodes }, deriveMessages: () => messages }
const ctx = {
  get: (name) => (name === 'sessionProjections'
    ? { stateOf: () => ({ turns: [{ turn: 1, seq: 9 }, { turn: 2, seq: 49 }] }) }
    : null),
}

const zones = readZones(ctx, session)
const pruned = zones.zones.l0.find((n) => n.seq === 100)
check('被替换过的工具结果算第 1 轮（按表层位置，不按事件号）', pruned && pruned.turn === 1, pruned ? `实际 turn=${pruned.turn}` : '没找到该节点')

const anchor = resolveTurnAnchor(zones, 'T1')
check('T1 锚点落在那一轮最后仍在表层的节点上', anchor.ok && anchor.seq === 100, JSON.stringify(anchor))

const t2 = resolveTurnAnchor(zones, 'T2')
check('当前轮不能被压', !t2.ok && /还没结束/.test(t2.reason), JSON.stringify(t2))

// 整轮边界：这是"节点数≠消息数"时唯一还算得准的安全判据，它只依赖表层节点与轮次大纲。
const bounds = turnBounds(zones)
check(
  '整轮边界按表层下标算出来',
  Array.isArray(bounds) && bounds.length === 2 && bounds[0].start === 1 && bounds[0].end === 2 && bounds[1].start === 3 && bounds[1].end === 4,
  JSON.stringify(bounds),
)
check('整轮区间被放行', isTurnBoundaryPair(zones, 1, 2) === true, String(isTurnBoundaryPair(zones, 1, 2)))
check('从表层最前面开始切也放行', isTurnBoundaryPair(zones, 0, 2) === true, String(isTurnBoundaryPair(zones, 0, 2)))
check('切在一轮中间要被拦下（终点不是轮末）', isTurnBoundaryPair(zones, 1, 1) === false)
check('切在一轮中间要被拦下（起点不是轮首）', isTurnBoundaryPair(zones, 2, 4) === false)
check('拿不到轮次大纲时返回 null（判不了）', isTurnBoundaryPair({ nodes, turnStarts: null, turnStartIndex: new Map() }, 1, 2) === null)

// 第二张表：第 1 轮的轮首被压成检查点块（新事件号 9000，比第 2 轮起点还大）。
// 这是"轮号对齐"最容易出事的地方：块占了轮首的位置，但它的号码在日志末尾。
// 规则要求：这一轮**不再有地标**（标签塌缩、被相邻轮吸收），而不是随便指一个位置。
const blockNodes = [5, 9000, 50, 60]
const blockMessages = [
  { role: 'system', content: [{ type: 'text', text: 'sys' }] },
  {
    role: 'user',
    content: [{ type: 'text', text: '〔L1｜T1–T1｜ev 10–40〕第 1 轮的结论' }],
    source: { kind: 'compact-checkpoint', compactionId: 'c1' },
  },
  { role: 'user', content: [{ type: 'text', text: 'T2 的问题' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'T2 的回答' }] },
]
const blockZones = readZones(ctx, { surface: { nodes: blockNodes }, deriveMessages: () => blockMessages })
const blockBounds = turnBounds(blockZones)
check(
  '轮首被块占掉的那一轮不当地标：只剩第 2 轮的区间',
  Array.isArray(blockBounds) && blockBounds.length === 1 && blockBounds[0].turn === 2 && blockBounds[0].start === 2 && blockBounds[0].end === 3,
  JSON.stringify(blockBounds),
)
check('块所在的位置不被当成可切起点（保守拒绝）', isTurnBoundaryPair(blockZones, 1, 3) === false)
check('真正的轮首照常放行', isTurnBoundaryPair(blockZones, 2, 3) === true)
const goneAnchor = resolveTurnAnchor(blockZones, 'T1')
check(
  '第 1 轮在表层上已经没有原文时说清楚，而不是乱指',
  !goneAnchor.ok && /找不到第 1 轮/.test(goneAnchor.reason),
  JSON.stringify(goneAnchor),
)

// 第三组：每层最后一块不能压、原文区保住最后 N 轮。
// 这两条不只是"少压一点"——它们决定级联会不会把整批锁死，所以必须被测试钉住。
const fake = {
  nodes: [],
  turnStarts: [],
  turnStartIndex: new Map(),
  currentTurn: 5,
  zones: {
    l0: [],
    l1: [{ seq: 1, text: 'a' }, { seq: 2, text: 'b' }, { seq: 3, text: 'c' }],
    l2: [{ seq: 4, text: 'd' }],
    l3: [],
  },
}
const lastBlock = resolveZoneIndex(fake, 'l1', 3)
check('该区最后一块不能压（写满到区尾要被拒）', !lastBlock.ok && /最后一块不能压/.test(lastBlock.reason), JSON.stringify(lastBlock))
check('倒数第二块照常放行', resolveZoneIndex(fake, 'l1', 2).ok, JSON.stringify(resolveZoneIndex(fake, 'l1', 2)))
const single = resolveZoneIndex(fake, 'l2', 1)
check('该区只有 1 块时说清楚"暂时没得压"', !single.ok && /只有 1 块/.test(single.reason), JSON.stringify(single))

check('keepTurns 只在最后几轮上生效：keep=0 时 T1 可压', resolveTurnAnchor(zones, 'T1', 0).ok)
check('keep=1 时 T1 仍可压（当前第 2 轮）', resolveTurnAnchor(zones, 'T1', 1).ok, JSON.stringify(resolveTurnAnchor(zones, 'T1', 1)))
const kept = resolveTurnAnchor(zones, 'T1', 2)
check('keepTurns 把可压范围吃光时说清楚"现在才第几轮"', !kept.ok && /可压范围是空的/.test(kept.reason), JSON.stringify(kept))
const wide = { ...zones, currentTurn: 5 }
check('keepTurns 只挡最近几轮，更早的仍可压', resolveTurnAnchor(wide, 'T1', 2).ok, JSON.stringify(resolveTurnAnchor(wide, 'T1', 2)))
const rawT4 = { zones: { l0: [{ seq: 1, turn: 4 }], l1: [], l2: [], l3: [] }, currentTurn: 5, turnStarts: [], turnStartIndex: new Map(), nodes: [1] }
const tooNew = resolveTurnAnchor(rawT4, 'T4', 2)
check('越过保护圈的轮号被拒并给出上限', !tooNew.ok && /最多压到 T3/.test(tooNew.reason), JSON.stringify(tooNew))
check('最远可压轮号 = 当前轮 − keepTurns', lastCompressibleTurn(zones, 1) === 1 && lastCompressibleTurn(zones, 3) === null)

// 级联判据是"还能压"：某层只剩 1 块时不该再逼着一起压，否则整批永远过不去。
check('L1 有 3 块：算可压', canCompressZone(fake, 'l1', 0) === true)
check('L2 只有 1 块：不算可压（不逼着一起压）', canCompressZone(fake, 'l2', 0) === false)
const onlyKeptRaw = {
  nodes: [],
  turnStarts: [],
  turnStartIndex: new Map(),
  currentTurn: 2,
  zones: { l0: [{ seq: 1, turn: 1 }], l1: [], l2: [], l3: [] },
}
check('原文区只剩被保住的轮：不算可压', canCompressZone(onlyKeptRaw, 'l0', 2) === false)
check('原文区有可压轮：算可压', canCompressZone(onlyKeptRaw, 'l0', 1) === true)

// 第四组：轮次大纲自检（缺轮/乱序/当前轮没有节点）与"空节点 + 已有块"的歧义。
// 这四条对应审计 A1 / A2 / A3：都是在"不报错的情况下压错轮"的路子上。
const gapCtx = {
  get: (name) => (name === 'sessionProjections'
    ? { stateOf: () => ({ turns: [{ turn: 1, seq: 9 }, { turn: 2, seq: 49 }, { turn: 4, seq: 55 }] }) }
    : null),
}
const gapZones = readZones(gapCtx, session)
check('大纲缺一轮（1,2,4）能认出来', gapZones.outlineFault === 'gap', String(gapZones.outlineFault))

const orderCtx = {
  get: (name) => (name === 'sessionProjections'
    ? { stateOf: () => ({ turns: [{ turn: 1, seq: 9 }, { turn: 2, seq: 9 }] }) }
    : null),
}
check('两轮抢同一个起点 seq 能认出来（顺序不可靠）', readZones(orderCtx, session).outlineFault === 'order')

const farCtx = {
  get: (name) => (name === 'sessionProjections'
    ? { stateOf: () => ({ turns: [{ turn: 1, seq: 9 }, { turn: 2, seq: 49 }, { turn: 3, seq: 500 }] }) }
    : null),
}
// 2026-10-31 审计 F1：'current' 不是故障（宿主每轮第 1 步都这样），只记成 currentEmpty。
const far = readZones(farCtx, session)
check('当前轮还没有节点时不算大纲故障（那是宿主的正常时序）', far.outlineFault === null, String(far.outlineFault))
check('当前轮还没有节点时 currentEmpty 为真（地图据此说这一轮还没内容）', far.currentEmpty === true)
check('大纲正常时没有 fault', zones.outlineFault === null, String(zones.outlineFault))

// 大纲不可靠时 l0 必须算「压不了」：否则级联会一直要求带上一个必然被拒的 l0，
// 连带把 l1 / l2 / l3 一起锁死（整会话压不动），而地图还在说「l1 / l2 不受影响」。
check('大纲缺轮时 l0 不算可压（级联不该逼着带它）', canCompressZone(gapZones, 'l0', 0) === false)
check('大纲缺轮时 l1 照旧看块数（不被 l0 连坐）', canCompressZone({ ...fake, outlineFault: 'gap' }, 'l1', 0) === true)
// 正文放大到门槛之上：l0 还要过"压了能不能比原文小"的收益门槛（MIN_L0_COST）。
const fatSession = { surface: { nodes: session.surface.nodes }, deriveMessages: () => session.deriveMessages().map((m) => ({ ...m, content: [{ type: 'text', text: '长'.repeat(1200) }] })) }
const thinSession = { surface: { nodes: session.surface.nodes }, deriveMessages: () => session.deriveMessages().map((m) => ({ ...m, content: [{ type: 'text', text: '短' }] })) }
check('当前轮还没有节点时 l0 照常可压（不再被伪故障拦下）', canCompressZone(readZones(farCtx, fatSession), 'l0', 0) === true)
check('原文区剩余不足门槛：l0 不算可压（压了也会被收益校验拒）', canCompressZone(readZones(farCtx, thinSession), 'l0', 0) === false)

// 空节点让 messages 比 nodes 少一条：
//  - 表层没有块 → 每条消息都是原文，按下标分类与对齐无关，整表按原文处理即可（保住可压性）；
//  - 表层已经有块 → 块在哪一行推不出来，必须报"歧义"，由上层整批拒绝。
const holeSession = { surface: { nodes: [5, 10, 11, 100, 50] }, deriveMessages: () => messages.slice(0, 4) }
const holeZones = readZones(ctx, holeSession)
check('空节点 + 没有块：不报歧义', holeZones.ambiguous === false)
check('空节点 + 没有块：尾节点不被丢掉', holeZones.zones.l0.length === 4, String(holeZones.zones.l0.length))

const holeBlockSession = { surface: { nodes: [5, 9000, 50, 60] }, deriveMessages: () => blockMessages.slice(0, 3) }
const holeBlockZones = readZones(ctx, holeBlockSession)
check('空节点 + 已经有块：报歧义（块的位置推不出来）', holeBlockZones.ambiguous === true)

// 带 "+" 的块头必须能被自己解析回来：`frame()` 在轮号不明时会写 `T16–T19+`，
// 若解析器读不懂这个后缀，那块就永远没有轮号，覆盖它的 l0 会被一次次拒。
const openHeader = parseHeader('〔L2｜T16–T19+｜ev 4121–4390〕标题')
const openMeta = openHeader.meta || {}
check('带 + 的块头能解析出轮号', openMeta.turns && openMeta.turns[0] === 16 && openMeta.turns[1] === 19, JSON.stringify(openMeta))
check('带 + 的块头标记轮号未封口', openMeta.turnsOpen === true, String(openMeta.turnsOpen))
check('带 + 的块头层级与事件号照样读得回', openMeta.tier === 2 && openMeta.events[0] === 4121 && openMeta.events[1] === 4390, JSON.stringify(openMeta))
const closedHeader = parseHeader('〔L1｜T16–T19｜ev 4121–4390〕标题')
check('不带 + 的块头不算未封口', closedHeader.meta && closedHeader.meta.turnsOpen === false, String(closedHeader.meta && closedHeader.meta.turnsOpen))

// node 0 的判定要看书里那一条自己的消息，不能拿 messages[0] 顶替：
// 空 system 消息在宿主投影里被跳过，messages[0] 其实是第二个节点。
const holeHeadSession = { surface: { nodes: [5, 6, 7] }, deriveMessages: () => messages.slice(1, 3) }
const holeHeadZones = readZones(ctx, holeHeadSession)
check('数量对不上时头部一律当保护，不把 node 0 算进原文区', holeHeadZones.zones.l0.every((n) => n.seq !== 5), JSON.stringify(holeHeadZones.zones.l0.map((n) => n.seq)))

// 精确映射：宿主公开了 `session.log` 与 `session.deriveEventMessage(event)`，
// 于是"消息数少于节点数"不再等于"认不出块"。这一条是那个
// 「空节点 + 已经有块 → 此后一次都压不了、而且只增不减」永久死锁的根治回归。
const exactLog = []
exactLog[5] = { type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: 'sys' }] } } }
exactLog[9000] = { type: 'user/message', data: blockMessages[1] }
exactLog[77] = { type: 'assistant/message', data: { message: { role: 'assistant', content: [] } } }
exactLog[50] = { type: 'user/message', data: blockMessages[2] }
exactLog[60] = { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'T2 的回答' }] } } }
// 与宿主 deriveEventMessage 同一套规则：空内容的 system/developer/assistant 投影成 null。
const exactSession = {
  surface: { nodes: [5, 9000, 77, 50, 60] },
  log: exactLog,
  deriveEventMessage: (event) => {
    if (!event) return null
    if (event.type === 'user/message') return event.data
    if (event.type === 'tool/result') return event.data.message
    const m = event.data && event.data.message
    if (!m) return null
    return (m.content || []).length ? m : null
  },
  // 宿主会跳过空节点：5 条节点只派生出 4 条消息。
  deriveMessages: () => [blockMessages[0], blockMessages[1], blockMessages[2], blockMessages[3]],
}
const exactZones = readZones(ctx, exactSession)
check('有精确映射时不再报歧义（空节点不再让会话永久压不动）', exactZones.ambiguous === false)
check('有精确映射时块照旧认得出（落在 L1 区）', exactZones.zones.l1.length === 1 && exactZones.zones.l1[0].seq === 9000, JSON.stringify(exactZones.zones.l1.map((b) => b.seq)))
check('空节点既不进原文区、也不丢尾节点', exactZones.zones.l0.every((n) => n.seq !== 77) && exactZones.zones.l0.some((n) => n.seq === 60), JSON.stringify(exactZones.zones.l0.map((n) => n.seq)))
check('按节点取消息能拿到那一条自己的消息', (exactZones.messageFor(50) || {}).content !== undefined && exactZones.messageFor(77) === null)

// 某些装配里根本没有 turnOutline 投影（它是可选依赖）。这时不许整个插件变哑：
// 宿主每开一轮都 append("turn/start", { turn })，事件号就是下标，自己扫一遍即可。
{
  const log = []
  log[9] = { type: 'turn/start', data: { turn: 1 } }
  log[10] = { type: 'user/message', data: {} }
  log[49] = { type: 'turn/start', data: { turn: 2 } }
  log[50] = { type: 'user/message', data: {} }
  const bare = {
    surface: { nodes: [5, 10, 50] },
    log,
    deriveMessages: () => [
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      { role: 'user', content: [{ type: 'text', text: 'T1' }] },
      { role: 'user', content: [{ type: 'text', text: 'T2' }] },
    ],
  }
  const bareZones = readZones({ get: () => null }, bare)
  check(
    '没有轮次大纲投影时，从日志的 turn/start 读出轮号（不再永久压不动）',
    Array.isArray(bareZones.turnStarts) && bareZones.turnStarts.length === 2 && bareZones.currentTurn === 2,
    JSON.stringify(bareZones.turnStarts),
  )
}

// 投影自己也可能是坏的（缺轮、乱序）。这时不能一口咬定"大纲不连续"就永久拒压：
// 日志里的 turn/start 是完备的，换那条路读出来的串是连续的，就该照它干。
{
  const log = []
  log[9] = { type: 'turn/start', data: { turn: 1 } }
  log[19] = { type: 'turn/start', data: { turn: 2 } }
  log[29] = { type: 'turn/start', data: { turn: 3 } }
  const fixable = {
    surface: { nodes: [5, 10, 20, 30] },
    log,
    deriveMessages: () => [
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      { role: 'user', content: [{ type: 'text', text: 'T1' }] },
      { role: 'user', content: [{ type: 'text', text: 'T2' }] },
      { role: 'user', content: [{ type: 'text', text: 'T3' }] },
    ],
  }
  const brokenProjection = {
    get: (name) =>
      name === 'sessionProjections'
        ? { stateOf: () => ({ turns: [{ turn: 1, seq: 9 }, { turn: 3, seq: 29 }] }) }
        : null,
  }
  const fixedZones = readZones(brokenProjection, fixable)
  check(
    '投影缺轮时改用日志的 turn/start，大纲故障不再永久拒压',
    Array.isArray(fixedZones.turnStarts) && fixedZones.turnStarts.length === 3 && fixedZones.outlineFault === null,
    JSON.stringify({ starts: fixedZones.turnStarts, fault: fixedZones.outlineFault }),
  )
}

if (failed) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log(`blocks 断言测试全部通过（${total} 项）`)