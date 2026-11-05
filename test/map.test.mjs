// 地图内容契约的断言测试（失败以非零退出码结束）。
//
// 为什么单独钉这一份：地图是设计稿里的核心手段——「提醒里直接带地图」「地图给的是索引与
// 压力，不是内容替代品」「地图必调」。它一旦被"省 token"改瘦，压缩成功率会直接掉，
// 而且这种退化在单测里看不出来（compress 仍然能跑，只是模型越来越猜）。
// 所以这里把设计稿要求的三样写死成断言：
//   ① 每层压力（已用 / 区上限 / 单块上限）
//   ② 每段的标题（块表：序号 + 区 + 覆盖轮次 + 每块 token + 标题）
//   ③ 可压区间（to 能抄什么），以及压缩须知
import { renderMap } from '../lib/map.js'

let failed = 0
let total = 0
const check = (name, cond, detail) => {
  total++
  if (cond) return
  console.error(`FAIL ${name}${detail ? ' :: ' + detail : ''}`)
  failed++
}

const nodes = [5, 9000, 50, 60]
const messages = [
  { role: 'system', content: [{ type: 'text', text: 'sys' }] },
  {
    role: 'user',
    content: [{ type: 'text', text: '〔L1｜T1–T2｜ev 10–40〕git 基线与环境事实' }],
    source: { kind: 'compact-checkpoint', compactionId: 'c1' },
  },
  { role: 'user', content: [{ type: 'text', text: 'T2 的问题' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'T2 的回答' }] },
]
const session = {
  surface: { nodes },
  deriveMessages: () => messages,
  requestContext: () => ({ contextWindow: 200000 }),
  requestHeader: () => ({ config: { maxTokens: 8000 } }),
}
const ctx = {
  sessions: { get: () => session },
  get: (name) => (name === 'sessionProjections'
    ? { stateOf: () => ({ turns: [{ turn: 1, seq: 9 }, { turn: 2, seq: 49 }] }) }
    : null),
}
const config = {
  keepTurns: 0,
  triggerPct: 0.75,
  budget: { l1: 0.1, l2: 0.06, l3: 0.03 },
  segment: { l1: 5000, l2: 2000, l3: 5000 },
  reservedTokens: 8000,
}
const agent = { id: 'a1' }
const usage = { used: 90000, ratio: 0.9, window: 192000 }
const text = renderMap(ctx, agent, config, usage).text

check('地图带每层压力表头（含每区占比）', /区域\s+已用（占可用输入）\s+区上限/.test(text) && /（\d+\.\d%）/.test(text), text.slice(0, 300))
check('地图带区上限数值（L1/L2/L3 三行都在）', /L3/.test(text) && /L2/.test(text) && /L1/.test(text))
check('地图带块表（序号/区/覆盖轮次/token/标题）', /序号?按区各自从 1 起/.test(text) && /覆盖轮次/.test(text), text.slice(0, 400))
check('地图里能看见块的标题', /git 基线与环境事实/.test(text))
// 区上限那一列必须真在，而且超线时要标 ⚠（第六轮审查 B：原来只验 /L1|L2|L3/ 字样出现过，
// 把实现改成"上限恒打 —""永不标超限"都照样全绿；而地图是模型决定压不压的唯一依据）。
const pressureRow = (zone) => new RegExp(`${zone}\\s+[\\d,]+（[\\d.]+%）\\s+[\\d,]+\\s+\\d+ token`).test(text)
check('L3/L2/L1 三行都把"已用（占比）区上限 单块上限"四个数写全',
  pressureRow('L3') && pressureRow('L2') && pressureRow('L1'),
  text.split('\n').filter((l) => /^L[123]\s/.test(l)).join(' ⏎ '))
const overText = renderMap({ ...ctx, sessions: { get: () => session } }, agent,
  { ...config, budget: { l1: 0.00001, l2: 0.00001, l3: 0.00001 } }, usage).text
check('超线时那一行标「⚠已超设计容量」，没超的默认地图一条都不该有', /^L1\s.*⚠已超设计容量/m.test(overText) && !/⚠已超设计容量/.test(text),
  overText.split('\n').filter((l) => /^L[123]\s/.test(l)).join(' ⏎ '))
check('地图带可压位置段', /可压位置/.test(text))
check('地图带压缩须知段', /压缩须知/.test(text))
check('地图给出 l0 的轮号范围写法', /可写 to=T\d+–T\d+|暂不可用/.test(text))
check('地图给出 l1/l2 的块序号范围写法', /可写 to=1–\d+|暂不可用/.test(text))
// 外来块（没有块头）的出身：查不到压缩事务时必须在地图上说明，否则模型只看到"什么都压不动"。
const ckSession = {
  surface: { nodes: [5, 9000] },
  deriveMessages: () => [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: '宿主压缩留下的摘要' }], source: { kind: 'compact-checkpoint', compactionId: 'c9' } },
  ],
}
const ckText = renderMap({ sessions: { get: () => ckSession }, get: (n) => (n === 'sessionProjections' ? { stateOf: () => ({ turns: [] }) } : null) }, agent, config, usage).text
check('来历不明的检查点已按原文处理：地图说明它不是块、会跟着原文一起被压走', /来历不明的压缩摘要/.test(ckText), ckText.slice(0, 700))
// 压不动时不能再出现「前 N 块」这种半截话：N 该由插件算好，不该让模型猜。
// 有可压范围就写真实区间（压 L1 区最老的 1–3 块），没有就写「一段」。
check('可压位置里不出现「前 N 块」这种没算好的占位说法', !/前 N 块/.test(text), text.slice(0, 600))
check('l1/l2 可压时直接写真实区间或「一段」', /l1\s+压 L1 区最老的(\s+\d+–\d+ 块|一段)/.test(text) && /l2\s+压 L2 区最老的(\s+\d+–\d+ 块|一段)/.test(text), text.slice(0, 700))

// 缺轮必须在地图上说出来：否则模型只看到「最多压到 T1」却不知道为什么，
// 会以为插件坏了（user m20995 的裁定：准确保上限，但要让模型知道原因）。
const gapCtx = {
  sessions: { get: () => session },
  get: (name) => (name === 'sessionProjections'
    ? { stateOf: () => ({ turns: [{ turn: 1, seq: 9 }, { turn: 2, seq: 49 }, { turn: 4, seq: 60 }] }) }
    : null),
}
const gapText = renderMap(gapCtx, agent, config, usage).text
check('缺轮时地图说明原因（不再只说可写 to=T1）', /缺了/.test(gapText) && /没有自己的边界/.test(gapText), gapText.slice(0, 400))
// 第六轮审查 A#2：缺的轮号要单独列出来并说明写不得，不能让模型照抄主句的区间。
// 这里要让它真的走到"可写 to=T2–T3"那一支，所以原文写长一点（不足 300 token 会走"太小"分支）。
const longNodes = [5, 9000, 50, 60]
const longMessages = [
  { role: 'system', content: [{ type: 'text', text: 'sys' }] },
  { role: 'user', content: [{ type: 'text', text: '〔L1｜T1–T1｜ev 10–10〕早先的摘要' }], source: { kind: 'compact-checkpoint', compactionId: 'c9' } },
  { role: 'user', content: [{ type: 'text', text: '原'.repeat(400) }] },
  { role: 'assistant', content: [{ type: 'text', text: '答'.repeat(400) }] },
]
const longSession = {
  surface: { nodes: longNodes },
  deriveMessages: () => longMessages,
  requestContext: () => ({ contextWindow: 200000 }),
  requestHeader: () => ({ config: { maxTokens: 8000 } }),
}
const longGapCtx = {
  sessions: { get: () => longSession },
  get: (name) => (name === 'sessionProjections'
    ? { stateOf: () => ({ turns: [{ turn: 1, seq: 9 }, { turn: 2, seq: 49 }, { turn: 4, seq: 60 }] }) }
    : null),
}
const longGapText = renderMap(longGapCtx, agent, config, usage).text
check('缺轮时单独列出「写不得」的轮号', /缺的轮号 T3/.test(longGapText) && /写不得/.test(longGapText), longGapText.slice(0, 600))
// 回归修复：可写的 to 不能把缺轮号包进去（之前同一行里既写 T2–T3、又说 T3 写不得）。
// 断言三件事：有可写区间、区间里没有缺轮号、不出现 T2–T2 这种同值区间（回归修复）。
check('可写区间不含缺轮号（T3 缺 → 上界退到 T2）',
  /可写 to=T\d+(?:–T\d+)?（/.test(longGapText) && !/可写 to=[^（]*T3/.test(longGapText)
    && !/可写 to=T(\d+)–T\1/.test(longGapText),
  longGapText.slice(0, 600))

// 只有一个可写轮时写单值 `可写 to=T1（`，不能写成 `T1–T1`（回归修复）。
{
  // turn/start 必须自己也占一个表层节点，readZones 才能把它映射成边界（否则整段都是"无主原文"）。
  const oneSession = {
    surface: { nodes: [5, 9, 9000, 60, 100] },
    deriveMessages: () => [
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      { role: 'user', content: [{ type: 'text', text: '〔轮次标记〕本轮 T1' }] },
      { role: 'user', content: [{ type: 'text', text: '原'.repeat(400) }] },
      { role: 'assistant', content: [{ type: 'text', text: '答'.repeat(400) }] },
      { role: 'user', content: [{ type: 'text', text: '〔轮次标记〕本轮 T2' }] },
    ],
    requestContext: () => ({ contextWindow: 200000 }),
    requestHeader: () => ({ config: { maxTokens: 8000 } }),
  }
  const oneCtx = {
    sessions: { get: () => oneSession },
    get: (name) => (name === 'sessionProjections'
      // 第 2 轮有 turn/start（所以第 1 轮算已结束），但表层上没有它的原文：
      // 可写范围只剩 T1 一轮，正好走 B6 的「单值」分支。
      ? { stateOf: () => ({ turns: [{ turn: 1, seq: 9 }, { turn: 2, seq: 100 }] }) }
      : null),
  }
  const oneText = renderMap(oneCtx, agent, config, usage).text
  check('地图正文不许出现工具名（折叠短注会把它带进对话，SPEC L485）', !/compress|context_map/.test(oneText), (oneText.match(/compress|context_map/) || [])[0] || '')
  const keepText = renderMap(oneCtx, agent, { ...config, keepTurns: 2 }, usage).text
  check('F4：keepTurns 把轮次全保住时，原文区仍非空——标记说明行不能跟着消失',
    /暂不可用：keepTurns=2/.test(keepText) && /原文区里每条〔轮次标记〕/.test(keepText), keepText.slice(0, 500))
  check('只有一个可写轮：写单值 `可写 to=T1（`，不写 T1–T1',
    /可写 to=T1（/.test(oneText) && !/可写 to=T1–T1/.test(oneText), oneText.slice(0, 400))
}


// 无主原文：地图必须点出来（回归修复）——首界标之前的消息没有轮号，不说出来模型会以为它不存在。
{
  const um = (t) => ({ role: 'user', content: [{ type: 'text', text: t }] })
  const orphanSession = {
    surface: { nodes: [1, 3] },
    log: [
      undefined,
      { type: 'user/message', data: um('T1 之前的问题（轮次记录丢了）') },
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'user/message', data: um('T2 的问题') },
    ],
    deriveMessages: () => [um('T1 之前的问题（轮次记录丢了）'), um('T2 的问题')],
    deriveEventMessage: (e) => (e && e.data) || null,
    requestContext: () => ({ contextWindow: 200000 }),
    requestHeader: () => ({ config: { maxTokens: 8000 } }),
  }
  const orphanCtx = { sessions: { get: () => orphanSession }, get: () => null }
  const orphanText = renderMap(orphanCtx, agent, config, usage).text
check('有首界标之前的无主原文时，地图要说出来', /没有轮号的消息/.test(orphanText), orphanText.split('\n').filter((l) => /可写 to|没有轮号/.test(l)).join(' / '))
check('措辞：这句要说「这些内容会被一起压进第一块」（回归修复）', /这些内容会被一起压进第一块/.test(orphanText), orphanText)
check('单条无主原文写成「事件号 1」，不写成 1–1', /事件号 1）/.test(orphanText) && !/事件号 1–1/.test(orphanText), orphanText.split('\n').find((l) => /没有轮号/.test(l)) || '')
check('这句提示只许出现一次（曾因两处拼接写成两遍）', (orphanText.match(/没有轮号的消息/g) || []).length === 1, String((orphanText.match(/没有轮号的消息/g) || []).length))
}


// D1：`turnStarts === null`（投影没挂、日志也没有 turn/start）时，全部原文都没有轮号，
// 那不是"无主原文"，地图不许说"最早的轮次记录丢了"（回归修复）。
{
  const noTurnSession = {
    surface: { nodes: [5, 9000, 60] },
    deriveMessages: () => [
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      { role: 'user', content: [{ type: 'text', text: '原'.repeat(400) }] },
      { role: 'assistant', content: [{ type: 'text', text: '答'.repeat(400) }] },
    ],
    requestContext: () => ({ contextWindow: 200000 }),
    requestHeader: () => ({ config: { maxTokens: 8000 } }),
  }
  const noTurnCtx = { sessions: { get: () => noTurnSession }, get: () => null }
  const noTurnText = renderMap(noTurnCtx, agent, config, usage).text
  check('拿不到轮号时不说"最早的轮次记录丢了"', !/没有轮号的消息/.test(noTurnText), noTurnText.slice(0, 400))
  check('拿不到轮号时仍要说明判不了轮', /拿不到轮号/.test(noTurnText), noTurnText.slice(0, 400))
}

if (failed) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
// 成本闸门（用户 2026-11-05 第 2 条）：两层都是小块的 L1 只有"第一块能压"，
// 而第一块 116 token 盖不住改写开销——地图必须写清原因，不能再给一个照做必被拒的 to。
{
  const nodes = [1, 2, 3]
  const mkBlock = (i) => ({
    role: 'user',
    source: { kind: 'compact-checkpoint' },
    content: [{ type: 'text', text: `〔L1｜T${i * 2 + 1}–T${i * 2 + 2}｜ev ${10 + i}–${20 + i}〕块${i + 1}\n` + '摘'.repeat(110) }],
  })
  const msgs = [{ role: 'system', content: [{ type: 'text', text: 'sys' }] }, mkBlock(0), mkBlock(1)]
  const tinySession = {
    surface: { nodes },
    deriveMessages: () => msgs,
    requestContext: () => ({ contextWindow: 200000 }),
    requestHeader: () => ({ config: { maxTokens: 8000 } }),
  }
  const tinyCtx = {
    sessions: { get: () => tinySession },
    get: (name) => (name === 'sessionProjections' ? { stateOf: () => ({ turns: [{ turn: 1, seq: 9 }, { turn: 2, seq: 49 }] }) } : null),
  }
  const tinyText = renderMap(tinyCtx, agent, config, usage).text
  const l1Line = (tinyText.split('\n').find((line) => line.startsWith('l1 ')) || '')
  check('L1 只有小块时地图写清"盖不住改写开销"', /盖不住一块的最小产物成本/.test(l1Line), l1Line)
  check('L1 只有小块时不再给出可写 to', !/可写 to=/.test(l1Line), l1Line)
  // 可压的时候必须把"还剩多少预算留给摘要+标题"写出来（设计意图回归修复：150 当阈值两头都漏，
  // 改成"给两端的事实"）。
  {
    const bigNodes = [1, 2, 3]
    const bigBlock = (i) => ({
      role: 'user',
      source: { kind: 'compact-checkpoint' },
      content: [{ type: 'text', text: `〔L1｜T${i * 2 + 1}–T${i * 2 + 2}｜ev ${10 + i}–${20 + i}〕块${i + 1}\n` + '摘'.repeat(300) }],
    })
    const bigMsgs = [{ role: 'system', content: [{ type: 'text', text: 'sys' }] }, bigBlock(0), bigBlock(1)]
    const bigSession = { surface: { nodes: bigNodes }, deriveMessages: () => bigMsgs, requestContext: () => ({ contextWindow: 200000 }), requestHeader: () => ({ config: { maxTokens: 8000 } }) }
    const bigCtx = { sessions: { get: () => bigSession }, get: (name) => (name === 'sessionProjections' ? { stateOf: () => ({ turns: [{ turn: 1, seq: 9 }, { turn: 2, seq: 49 }] }) } : null) }
    const bigLine = (renderMap(bigCtx, agent, config, usage).text.split('\n').find((line) => line.startsWith('l1 ')) || '')
    check('L1 可压时写出"摘要+标题合计不超过 N token"', /摘要\+标题合计不超过 \d+ token 才过收益校验/.test(bigLine), bigLine)
  }
}

// 只有 2 块且首块不够地板时：必须走"暂不可用"，绝不能拼出 `to=2–1`（回归修复）。
{
  const nodes = [1, 2]
  const msgs = [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: '〔L1｜T1–T1｜ev 3–3〕小块\n' + '摘'.repeat(90) }] },
    { role: 'user', source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: '〔L1｜T2–T2｜ev 4–4〕大块\n' + '摘'.repeat(400) }] },
  ]
  const sess = { surface: { nodes }, deriveMessages: () => msgs, requestContext: () => ({ contextWindow: 200000 }), requestHeader: () => ({ config: { maxTokens: 8000 } }) }
  const c = { sessions: { get: () => sess }, get: (name) => (name === 'sessionProjections' ? { stateOf: () => ({ turns: [{ turn: 1, seq: 9 }, { turn: 2, seq: 49 }] }) } : null) }
  const line = (renderMap(c, agent, config, usage).text.split('\n').find((l) => l.startsWith('l1 ')) || '')
  check('两块且首块不够地板时不拼出 to=2–1', !/to=2–1/.test(line), line)
}

// 首块单独不够改写开销时：表头不能再写「可写 to=1–N」（回归修复实测 97/166/116）。
{
  const sizes = [97, 166, 116]
  const nodes = [4, 1, 2, 3]
  const msgs = [{ role: 'system', content: [{ type: 'text', text: 'sys' }] }].concat(sizes.map((n, i) => ({
    role: 'user',
    source: { kind: 'compact-checkpoint' },
    content: [{ type: 'text', text: `〔L1｜T${i + 1}–T${i + 1}｜ev ${10 + i}–${20 + i}〕块${i + 1}\n` + '摘'.repeat(n) }],
  })))
  const sess = { surface: { nodes }, deriveMessages: () => msgs, requestContext: () => ({ contextWindow: 200000 }), requestHeader: () => ({ config: { maxTokens: 8000 } }) }
  const c = { sessions: { get: () => sess }, get: (name) => (name === 'sessionProjections' ? { stateOf: () => ({ turns: [{ turn: 1, seq: 9 }, { turn: 2, seq: 49 }, { turn: 3, seq: 99 }] }) } : null) }
  const line = (renderMap(c, agent, config, usage).text.split('\n').find((l) => l.startsWith('l1 ')) || '')
  check('首块不够开销时表头写「可写 to=2–N」而不是 to=1–N', /可写 to=2–2（to=1 单独不可行）/.test(line), line)
  check('并且逐个 to 说清 to=1 单独写必被拒', /to=1 只并最老的一块/.test(line) && /必被拒/.test(line), JSON.stringify(line))
}
// 240 是提醒门槛，不是压不动的硬边界：地图不能说「压完不会比原样更小」。
{
  const msgs = [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'T1 的话' + '字'.repeat(200) }] },
    { role: 'user', content: [{ type: 'text', text: 'T2 的话' }] },
  ]
  const sess = { surface: { nodes: [5, 6, 7] }, deriveMessages: () => msgs, requestContext: () => ({ contextWindow: 200000 }), requestHeader: () => ({ config: { maxTokens: 8000 } }) }
  const c = { sessions: { get: () => sess }, get: (name) => (name === 'sessionProjections' ? { stateOf: () => ({ turns: [{ turn: 1, seq: 6 }, { turn: 2, seq: 7 }] }) } : null) }
  const line = (renderMap(c, agent, config, usage).text.split('\n').find((l) => l.startsWith('l0 ')) || '')
  check('l0 走叫醒门槛口径：说「门槛」而不是断言「压完不会更小」', /叫醒门槛/.test(line) && !/压完不会比原样更小/.test(line), line)
}

console.log(`map 断言测试全部通过（${total} 项）`)
