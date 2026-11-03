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
// keepTurns 保的是「最近 N 个已结束的轮」（设计约束）：当前是第 2 轮时，
// 已结束的只有 T1，keep=1 就该把它留住——一个都不压。
check('keep=1 时第 2 轮已无可压（唯一结束的轮被保住）', !resolveTurnAnchor(zones, 'T1', 1).ok, JSON.stringify(resolveTurnAnchor(zones, 'T1', 1)))
const kept = resolveTurnAnchor(zones, 'T1', 2)
check('keepTurns 把可压范围吃光时说清楚"现在才第几轮"', !kept.ok && /可压范围是空的/.test(kept.reason), JSON.stringify(kept))
const wide = { ...zones, currentTurn: 5 }
check('keepTurns 只挡最近几轮，更早的仍可压', resolveTurnAnchor(wide, 'T1', 2).ok, JSON.stringify(resolveTurnAnchor(wide, 'T1', 2)))
const rawT4 = { zones: { l0: [{ seq: 1, turn: 4 }], l1: [], l2: [], l3: [] }, currentTurn: 5, turnStarts: [], turnStartIndex: new Map(), nodes: [1] }
const tooNew = resolveTurnAnchor(rawT4, 'T4', 2)
check('越过保护圈的轮号被拒并给出上限', !tooNew.ok && /最多压到 T2/.test(tooNew.reason), JSON.stringify(tooNew))
check('最远可压轮号 = 当前轮 − 1 − keepTurns', lastCompressibleTurn(zones, 0) === 1 && lastCompressibleTurn(zones, 1) === null)

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
check('原文区只剩被保住的轮：不算可压', canCompressZone(onlyKeptRaw, 'l0', 1) === false)
check('原文区有可压轮：算可压', canCompressZone(onlyKeptRaw, 'l0', 0) === true)

// 第四组：轮次大纲自检（缺轮/乱序/当前轮没有节点）与"空节点 + 已有块"的歧义。
// 这四条对应回归修复 / A2 / A3：都是在"不报错的情况下压错轮"的路子上。
const gapCtx = {
  get: (name) => (name === 'sessionProjections'
    ? { stateOf: () => ({ turns: [{ turn: 1, seq: 9 }, { turn: 2, seq: 49 }, { turn: 4, seq: 55 }] }) }
    : null),
}
const gapZones = readZones(gapCtx, session)
// 缺轮不再报红、也不再夹上界（回归修复）：缺的那一轮没有自己的边界，
// 但它的内容一直延续到下一个已知边界——`to` 写到它前一轮，切点落在 T4 起点之前，
// 顺手把缺掉的轮一起压掉。标签粗一点，切点仍然是真边界。
check('大纲缺一轮（1,2,4）不再报红', gapZones.outlineFault === null, String(gapZones.outlineFault))
check('缺轮不再夹上界（可压上界=最后一个已知轮）', gapZones.maxTurn === 4, String(gapZones.maxTurn))
check('缺轮记进 turnNotes（排查时看得到，不当故障）', gapZones.turnNotes.some((n) => n.turn === 3 && n.reason === 'missing'))
const gapAnchor = resolveTurnAnchor(gapZones, 'T2')
check('缺轮时 to=T2 照常可压，切点落在下一个已知边界之前', gapAnchor.ok === true, JSON.stringify(gapAnchor))
check('压 T2 会把缺掉的 T3 一起吞进来（切点= T4 起点 − 1）', Array.isArray(gapAnchor.swallowed) && gapAnchor.swallowed.join() === '3', JSON.stringify(gapAnchor))

const orderCtx = {
  get: (name) => (name === 'sessionProjections'
    ? { stateOf: () => ({ turns: [{ turn: 1, seq: 9 }, { turn: 2, seq: 9 }] }) }
    : null),
}
check('两轮抢同一个起点 seq 能认出来（顺序不可靠）', readZones(orderCtx, session).outlineFault === 'order')

// 两个来源都"看不到"轮号（投影没挂、日志里也没有 turn/start）不是损坏，只降级。
// 宿主换装载方式、测试桩、从中间截断的日志都会长这样；判成损坏等于把正常会话锁死
// （隔离实验抓到的回归，SPEC §3.6）。
const noSourceCtx = { get: () => null }
const noSource = readZones(noSourceCtx, { surface: { nodes: [5, 11, 12] }, log: [null, { type: 'user/message' }, { type: 'assistant/message' }] , deriveMessages: () => [], deriveEventMessage: () => null })
check('两个来源都拿不到轮号：不报红（只降级）', noSource.outlineFault === null, String(noSource.outlineFault))
check('两个来源都拿不到轮号：turnStarts 为 null（上层给"拿不到轮号"的文案）', noSource.turnStarts === null)

const farCtx = {
  get: (name) => (name === 'sessionProjections'
    ? { stateOf: () => ({ turns: [{ turn: 1, seq: 9 }, { turn: 2, seq: 49 }, { turn: 3, seq: 500 }] }) }
    : null),
}
// 回归修复：'current' 不是故障（宿主每轮第 1 步都这样），只记成 currentEmpty。
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

// 没有投影 + 日志里有重号 turn/start（fork/迁移/异常重试的痕迹）：必须去重救回来，
// 不能因为"单一来源没去重"就判 order、把整条对话停掉（回归修复）。
{
  const log = []
  log[5] = { type: 'turn/start', data: { turn: 1 } }
  log[10] = { type: 'turn/start', data: { turn: 2 } }
  log[99] = { type: 'turn/start', data: { turn: 2 } }
  const dirty = {
    surface: { nodes: [5, 10, 99] },
    log,
    deriveMessages: () => [
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      { role: 'user', content: [{ type: 'text', text: 'T1' }] },
      { role: 'user', content: [{ type: 'text', text: 'T2' }] },
    ],
  }
  const dirtyZones = readZones({ get: () => null }, dirty)
  check(
    '没有投影 + 日志重号：按轮号去重保首现，不判损坏',
    dirtyZones.outlineFault === null && Array.isArray(dirtyZones.turnStarts) && dirtyZones.turnStarts.length === 2,
    JSON.stringify({ fault: dirtyZones.outlineFault, starts: dirtyZones.turnStarts }),
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

// 第八组：标记即锚点（回归修复）。标记是上下文里写死的轮号，边界以它为准。
// 场景：T1 里某个节点被宿主机原位替换（pruneFirst 剪枝），拿到一个比 T2 起点更大的事件号，
// 但位置仍在 T1 —— 按事件号算出来的交界会落到 T2 的「下一轮 T2」标记上，把 T1 的尾巴错算成 T2。
// 以前的处理是报 outlineFault='marker' 停用整条对话，而触发它的正是我们自己的剪枝/压缩。
const mkLog = []
mkLog[3] = { type: 'turn/start', data: { turn: 1 } }
mkLog[7] = { type: 'turn/start', data: { turn: 2 } }
mkLog[1] = { type: 'message', data: { message: { role: 'system', content: [{ type: 'text', text: 'sys' }] } } }
mkLog[5] = { type: 'message', data: { message: { role: 'user', content: [{ type: 'text', text: 'T1 question' }] } } }
mkLog[20] = { type: 'message', data: { message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'T1 pruned result' }] } } }
mkLog[8] = {
  type: 'message',
  data: {
    message: {
      role: 'user',
      source: { kind: 'ebbing-context-marker' },
      content: [{ type: 'text', text: '〔轮次标记〕下一轮 T2' }],
    },
  },
}
mkLog[9] = { type: 'message', data: { message: { role: 'user', content: [{ type: 'text', text: 'T2 question' }] } } }
const repaired = readZones(
  { get: () => null },
  {
    surface: { nodes: [1, 5, 20, 8, 9] },
    log: mkLog,
    deriveEventMessage: (event) => (event && event.data ? event.data.message : null),
    deriveMessages: () => [],
  },
)
check(
  '标记与事件号不一致不再报红（outlineFault 为 null）',
  repaired.outlineFault === null,
  String(repaired.outlineFault),
)
check(
  '「下一轮 T2」把 T2 的交界钉在它后面一格（不是那条被替换节点）',
  repaired.turnStartIndex.get(2) === 4,
  String(repaired.turnStartIndex.get(2)),
)
const markerEntry = repaired.zones.l0.find((n) => n.seq === 8)
check(
  '标记自己仍算在 T1（不被事件号法抢到 T2）',
  markerEntry && markerEntry.turn === 1,
  markerEntry ? String(markerEntry.turn) : 'missing',
)

// 第十组：标记补缺轮（设计约束）。投影里 T3 的 turn/start 丢了（fork / 迁移常见），
// 但「本轮 T3」的标记还在表层上——标记是我们自己写的，位置就是地面真值，用它补回去。
const healLog = []
healLog[1] = { type: 'message', data: { message: { role: 'system', content: [{ type: 'text', text: 'sys' }] } } }
healLog[3] = { type: 'turn/start', data: { turn: 1 } }
healLog[4] = { type: 'message', data: { message: { role: 'user', content: [{ type: 'text', text: 'q1' }] } } }
healLog[6] = { type: 'turn/start', data: { turn: 2 } }
healLog[7] = { type: 'message', data: { message: { role: 'user', content: [{ type: 'text', text: 'q2' }] } } }
healLog[9] = {
  type: 'message',
  data: {
    message: {
      role: 'user',
      source: { kind: 'ebbing-context-marker' },
      content: [{ type: 'text', text: '〔轮次标记〕本轮 T3' }],
    },
  },
}
healLog[10] = { type: 'message', data: { message: { role: 'user', content: [{ type: 'text', text: 'q3' }] } } }
healLog[12] = { type: 'turn/start', data: { turn: 5 } }
healLog[13] = { type: 'message', data: { message: { role: 'user', content: [{ type: 'text', text: 'q5' }] } } }
const healCtx = {
  get: (name) => (name === 'sessionProjections'
    ? { stateOf: () => ({ turns: [{ turn: 1, seq: 3 }, { turn: 2, seq: 6 }, { turn: 5, seq: 12 }] }) }
    : null),
}
const healed = readZones(healCtx, {
  surface: { nodes: [1, 3, 4, 6, 7, 9, 10, 12, 13] },
  log: healLog,
  deriveEventMessage: (event) => (event && event.data ? event.data.message : null),
  deriveMessages: () => [],
})
check('缺轮被标记补回来（T3 重新出现在轮次表里）', healed.turnStarts.some((s) => s.turn === 3), JSON.stringify(healed.turnStarts))
check('补回来的 T3 不再记 missing', !healed.turnNotes.some((n) => n.turn === 3 && n.reason === 'missing'), JSON.stringify(healed.turnNotes))
check('补回来的 T3 边界落在标记那个节点上', healed.turnStartIndex.get(3) === 5, String(healed.turnStartIndex.get(3)))
check('补轮不改 keepTurns 语义：可直接压到 T3', resolveTurnAnchor(healed, 'T3', 1).ok === true, JSON.stringify(resolveTurnAnchor(healed, 'T3', 1)))

// 第九组：node 0 是空系统节点、但精确映射可用（边界情形）。
// 以前 condition 要求"节点 0 有消息且是 system"，空节点就被算进原文区，
// 于是 l0 的区间永远从下标 0 开始 → 每次都被宿主的 node0 保护拒掉。
const evNode = (message) => ({ type: 'message', data: { message } })
const logE = []
logE[3] = evNode(null)
logE[4] = evNode({ role: 'user', content: [{ type: 'text', text: 'q' }] })
logE[5] = evNode({ role: 'assistant', content: [{ type: 'text', text: 'a' }] })
const emptyHead = {
  surface: { nodes: [3, 4, 5] },
  log: logE,
  deriveEventMessage: (event) => (event && event.data ? event.data.message : null),
  deriveMessages: () => [
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
  ],
}
const eh = readZones({ get: () => null }, emptyHead)
check(
  'node 0 没有消息（精确映射可用）→ 算表头，原文区从下一个节点开始',
  eh.sys.length === 1 && eh.sys[0] === 3 && eh.zones.l0.length === 2 && eh.zones.l0[0].seq === 4,
  JSON.stringify({ sys: eh.sys, l0: eh.zones.l0.map((n) => n.seq) }),
)

// 第十组：区间里的空派生节点记一条 empty，事件号范围不会因此变窄。
const logF = []
logF[1] = evNode({ role: 'system', content: [{ type: 'text', text: 'sys' }] })
logF[2] = evNode({ role: 'user', content: [{ type: 'text', text: 'q1' }] })
logF[3] = evNode(null)
logF[4] = evNode({ role: 'assistant', content: [{ type: 'text', text: 'a1' }] })
const gapSession = {
  surface: { nodes: [1, 2, 3, 4] },
  log: logF,
  deriveEventMessage: (event) => (event && event.data ? event.data.message : null),
  deriveMessages: () => [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'q1' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
  ],
}
const gz = readZones({ get: () => null }, gapSession)
check(
  '空派生节点被记成 empty（不占原文区，但保留事件号）',
  gz.info.get(3) && gz.info.get(3).kind === 'empty' && gz.zones.l0.length === 2,
  JSON.stringify({ info: [...gz.info.keys()], l0: gz.zones.l0.map((n) => n.seq) }),
)

// 第十一组：l1/l2 的 `to` 只认十进制裸串（与 l0 的严格度对齐）。
const zidx = { zones: { l1: [{ seq: 10 }, { seq: 11 }, { seq: 12 }], l2: [], l3: [] }, info: new Map(), nodes: [] }
check('序号 "2" 正常解析', resolveZoneIndex(zidx, 'l1', '2').ok === true)
for (const bad of ['0x2', '1.0', ' 2x', 'two', '1e1']) {
  check(
    `序号 ${JSON.stringify(bad)} 被拒（不再被 Number() 静默接受）`,
    resolveZoneIndex(zidx, 'l1', bad).ok === false,
  )
}

// 第十二组：认检查点只认来源标记，不再靠正文前面的那句英文（设计约束）。
// 用户把那段英文贴进对话、或模型引用它，都不该被当成外来块。
const preambleSession = {
  surface: { nodes: [5, 10, 20] },
  deriveMessages: () => [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'This is an automatically generated checkpoint. 这是我从 README 里粘过来的示例。' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  ],
}
const pz = readZones({ get: () => null }, preambleSession)
check(
  '没有来源标记、只以那句英文开头的用户消息算原文（不再被猜成外来块）',
  pz.zones.l0.length === 2 && pz.zones.l1.length === 0,
  JSON.stringify({ l0: pz.zones.l0.length, l1: pz.zones.l1.length }),
)

// 第十三组：宿主拍平之后只剩一个检查点 → 登记成 L3（设计约束）。
// 只有"除表头外只剩它"才这么做；夹在原文中间的仍按外来块进 L1（位置无从推断）。
const flatSession = {
  surface: { nodes: [5, 9000] },
  // 出身核对：日志里真有这次压缩事务（compaction/start + compaction/summary 同 id），
  // 才算"宿主真的压过"，这是升 L3 的前提（设计约束）。
  log: [
    { type: 'compaction/start', data: { compactionId: 'host1' } },
    { type: 'compaction/summary', data: { compactionId: 'host1' } },
  ],
  deriveMessages: () => [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: '宿主压缩后的摘要正文……' }], source: { kind: 'compact-checkpoint', compactionId: 'host1' } },
  ],
}
const fz = readZones({ get: () => null }, flatSession)
check(
  '只剩宿主检查点时登记成 L3（不是 L1）',
  fz.zones.l3.length === 1 && fz.zones.l1.length === 0 && fz.zones.l3[0].foreign === true && fz.zones.l3[0].tier === 3,
  JSON.stringify({ l3: fz.zones.l3.length, l1: fz.zones.l1.length }),
)
check('L3 里那个外来块的 info 也是 tier 3', fz.info.get(9000) && fz.info.get(9000).tier === 3, JSON.stringify(fz.info.get(9000)))

// 冒充的检查点：kind 对、compactionId 也有，但日志里根本没有这次压缩事务。
// 内容是什么谁也不知道，只能当外来块留在 L1，绝不升 L3（设计约束）。
const fakeLog = []
const fakeSession = {
  surface: { nodes: [5, 9000] },
  log: [{ type: 'compaction/summary', data: { compactionId: 'other' } }],
  deriveMessages: () => [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: '伪装成宿主摘要的一段话' }], source: { kind: 'compact-checkpoint', compactionId: 'host-forged' } },
  ],
}
const forged = readZones({ get: () => null }, fakeSession, null, (event, data) => fakeLog.push([event, data]))
check(
  '出身对不上的检查点：留在 L1，不升 L3',
  forged.zones.l1.length === 1 && forged.zones.l3.length === 0 && forged.zones.l1[0].proven === false,
  JSON.stringify({ l1: forged.zones.l1.length, l3: forged.zones.l3.length, proven: forged.zones.l1[0].proven }),
)
check('出身对不上会记一条 foreign-block-unproven', fakeLog.some(([event]) => event === 'foreign-block-unproven'), JSON.stringify(fakeLog.map(([e]) => e)))
// 同一条里只报一次：每个 pre-step 都报一遍会把滚动日志刷满（找茬意见 2）。
const before = fakeLog.length
readZones({ get: () => null }, fakeSession, null, (event, data) => fakeLog.push([event, data]))
check('同一条未证实的块不重复刷日志', fakeLog.length === before, `${before} -> ${fakeLog.length}`)

// 缓存不能只看长度：日志被改写但长度不变时，出身判定必须跟着变（找茬报告的真缺陷 1）。
const rewriteLog = [{ type: 'compaction/start', data: { compactionId: 'a' } }]
const rewriteSession = {
  surface: { nodes: [5, 9000] },
  log: rewriteLog,
  deriveMessages: () => [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'compact-checkpoint', compactionId: 'a' } },
  ],
}
const rw1 = readZones({ get: () => null }, rewriteSession)
rewriteLog[0] = { type: 'compaction/start', data: { compactionId: 'b' } } // 同长度改写
const rw2 = readZones({ get: () => null }, rewriteSession)
rewriteLog[0] = { type: 'compaction/start', data: { compactionId: 'a' } }
const rw3 = readZones({ get: () => null }, rewriteSession)
check(
  '同长度改写日志后重新核对出身（改掉 → 不认；改回 → 又认）',
  rw1.zones.l3.length === 1 && rw2.zones.l3.length === 0 && rw2.zones.l1[0].proven === false && rw3.zones.l3.length === 1,
  JSON.stringify({ rw1: rw1.zones.l3.length, rw2: rw2.zones.l3.length, rw3: rw3.zones.l3.length }),
)

const mixedSession = {
  surface: { nodes: [5, 9000, 20, 30] },
  deriveMessages: () => [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: '宿主压缩后的摘要正文……' }], source: { kind: 'compact-checkpoint', compactionId: 'host1' } },
    { role: 'user', content: [{ type: 'text', text: '后来的问题' }] },
    { role: 'assistant', content: [{ type: 'text', text: '后来的回答' }] },
  ],
}
const mz = readZones({ get: () => null }, mixedSession)
check(
  '检查点夹在原文中间时仍是外来块（进 L1，不进 L3）',
  mz.zones.l1.length === 1 && mz.zones.l3.length === 0,
  JSON.stringify({ l1: mz.zones.l1.length, l3: mz.zones.l3.length }),
)

// 第十四组：标记与已知边界打架时只记 notes、不抛错（设计约束）。
const clashSession = {
  surface: { nodes: [5, 10, 50, 60] },
  deriveMessages: () => [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'T1 的问题' }] },
    { role: 'user', content: [{ type: 'text', text: 'T2 的问题' }] },
    { role: 'user', content: [{ type: 'text', text: '〔轮次标记〕本轮 T1' }], source: { kind: 'ebbing-context-marker' } },
  ],
}
const clashCtx = {
  get: (name) => (name === 'sessionProjections'
    ? { stateOf: () => ({ turns: [{ turn: 1, seq: 9 }, { turn: 2, seq: 49 }] }) }
    : null),
}
const cz = readZones(clashCtx, clashSession)
check(
  '前后都有边界的越界标记被挡下来、记进 markerNotes，不抛错',
  Array.isArray(cz.markerNotes) && cz.markerNotes.length === 1 && cz.markerNotes[0].turn === 1,
  JSON.stringify(cz.markerNotes),
)

// 第十八组：块头写了 `T?+`（盖到哪几轮不可知）的 L3 块，照样能被 l3 再收一次。
// 宿主拍平之后我们只能把那个检查点登记成 L3；它的轮号永远是"不知道"，
// 但 l3 按块收、不看轮号——不能因为轮号糊了就把整条 L3 判死（用户 0.1.16 追问）。
const unknownHeadSession = {
  surface: { nodes: [5, 70, 80] },
  deriveMessages: () => [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: '〔L3｜T?+｜ev 12–40〕宿主拍平之后留下的那一块\n正文 A' }], source: { kind: 'compact-checkpoint' } },
    { role: 'user', content: [{ type: 'text', text: '〔L3｜T4–T6｜ev 90–120〕我们自己压出来的一块\n正文 B' }], source: { kind: 'compact-checkpoint' } },
  ],
}
const unknownCtx = {
  get: (name) => (name === 'sessionProjections' ? { stateOf: () => ({ turns: [{ turn: 1, seq: 9 }] }) } : null),
}
const uz = readZones(unknownCtx, unknownHeadSession)
check('`T?+` 的块被认成 L3 块（不是原文、不是外来孤儿）', uz.zones.l3.length === 2 && uz.zones.l0.length === 0, JSON.stringify(uz.zones.l3.length))
check('`T?+` 解析成"轮号未知"，不会被误读成某个具体轮', (() => {
  const meta = parseHeader('〔L3｜T?+｜ev 12–40〕标题').meta
  return meta && meta.tier === 3 && meta.turns[0] === null && meta.turns[1] === null
})())
check('L3 里有一块轮号未知，但 l3 仍然可压（按块收，不看轮号）', canCompressZone(uz, 'l3') === true)

// 第十九组：日志里有没有没闭合的压缩事务（写前预检，避免再写第二个 start）。
{
  const { openCompaction } = await import('../lib/blocks.js')
  const mk = (types) => ({ log: types.map((t, i) => ({ seq: i, type: t, data: { compactionId: 'c1' } })) })
  check('openCompaction：start 后面有 end → 不算开着', openCompaction(mk(['compaction/start', 'compaction/summary', 'compaction/end'])) === null)
  const stuck = openCompaction(mk(['turn/start', 'compaction/start', 'compaction/summary']))
  check('openCompaction：只有 start 没有 end → 认为开着', stuck && stuck.compactionId === 'c1' && stuck.seq === 1)
  check('openCompaction：被 session/end-seed 认领成孤儿 → 不算开着', openCompaction(mk(['compaction/start', 'session/end-seed'])) === null)
  check('openCompaction：没有日志 → null', openCompaction({}) === null && openCompaction(null) === null)
}

// 第二十组：含空节点的原文区，成本要按"空节点 = 0"算，不能整段算成量不出来。
// 否则 canCompressZone 永远说可压、绕过 300 token 闸门，而 compress 一比就永久拒（疑点 a 的真形态）。
{
  const mkZones = (chars) => ({
    currentTurn: 4,
    outlineFault: null,
    zones: { l0: [{ seq: 1, turn: 1 }, { seq: 2, turn: 1 }, { seq: 3, turn: 2 }], l1: [], l2: [], l3: [] },
    messageFor: (seq) => (seq === 2 ? null : { role: 'user', content: [{ type: 'text', text: '字'.repeat(chars) }] }),
    imagePricer: null,
  })
  check('空节点算 0：整段才 60 token → 不够 300，不算可压', canCompressZone(mkZones(30), 'l0', 0) === false)
  check('对照：同样的结构换成大段原文 → 可压', canCompressZone(mkZones(400), 'l0', 0) === true)
}

if (failed) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log(`blocks 断言测试全部通过（${total} 项）`)
