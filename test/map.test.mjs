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
const usage = { used: 90000, ratio: 90000 / 192000, budget: 192000 }
const text = renderMap(ctx, agent, config, usage).text

check('地图带每层压力表头（含每区占比）', /区域\s+已用（占可用输入）\s+区上限/.test(text) && /（\d+\.\d%）/.test(text), text.slice(0, 300))
// 总量必须并排两个数：宿主口径 + 插件自估（2026-11-07 用户要求）。压缩成功回执那一刻宿主的数
// 还带过渡估算，只报一个数会让人以为真实占用高出一大截；并排显示才能互相核对。
// 断言连数值一起钉：fixture 的 ratio = used/budget，宿主数、自估数、百分比、窗口四段都得在，
// 只钉格式的话把宿主/自估对调、或把 ratio 换成别的数都照样绿（复审实测）。
check('总量并排两个数（宿主口径 + 自估，数值与占比一致）',
  /^上下文 90,000 token（宿主口径）\/ 自估 [\d,]+（[\d.]+%） \/ 可用输入 192,000（46\.9%）$/.test(text.split('\n')[0]),
  text.split('\n')[0])
// 三支边缘：无宿主账单、ratio 缺失、取不到窗口。
const noUsageText = renderMap(ctx, agent, config, null).text
check('取不到宿主账单时总量退回自估口径', /插件自估口径/.test(noUsageText.split('\n')[0]), noUsageText.split('\n')[0])
const noRatioText = renderMap(ctx, agent, config, { used: 90000, budget: 192000, ratio: NaN }).text
check('宿主 ratio 缺失/NaN 时不渲染百分比段', /\/ 可用输入 192,000$/.test(noRatioText.split('\n')[0]) && !/NaN%|undefined%/.test(noRatioText), noRatioText.split('\n')[0])
const bare = { surface: { nodes }, deriveMessages: () => messages }
const noWindowText = renderMap({ ...ctx, sessions: { get: () => bare } }, agent, config, { used: 50000 }).text
check('取不到窗口时只报两个总量、不渲染可用输入', /^上下文 50,000 token（宿主口径）\/ 自估 [\d,]+$/.test(noWindowText.split('\n')[0]), noWindowText.split('\n')[0])
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
// 须知段的三条硬话（2026-11-08 用户要求）：别压没收尾的、压缩专用轮压完收手、级联同批。
check('压缩须知：当前轮与进行中步骤绝对不可压，且不许一压到底',
  /当前轮和还需要的轮绝对不可压/.test(text) && /不要一压到底/.test(text) && /拿不准是否收尾就按没收尾处理/.test(text),
  text.split('\n').filter((l) => /压缩须知|绝对不可压/.test(l)).join(' ⏎ '))
check('压缩须知：压缩专用轮压完就收手（这句从提醒正文挪到地图须知段）',
  /压缩专用轮：压完就收手/.test(text) && /越过上一轮还没收尾的未决项/.test(text) && /不要在压缩成功后转做其它任务/.test(text))
// 用户要求（2026-11-09）：地图不能再给「可写 to=T124–T130」这种可照抄形态——模型会把它整个抄进 to。
// 改成「可写 to 的轮号：T124…T130」，并明确「写哪个号就压到哪个号」。
// 用户裁定（2026-11-09）：不写"没有理由就写最老的号"（没理由就该不压）、不写"没有把握就取小的"
// （模型没把握时压小的也可能是错的）；规则只说"压已经完成的部分"。
check('压缩须知：最大号只是上界，要压就压已经完成的部分',
  /地图列出的最大号只是上界/.test(text) && /要压就压已经完成的部分/.test(text)
    && !/没有理由就写最老的号/.test(text) && !/没有把握就取小的/.test(text) && !/先压一小段/.test(text))
check('地图的 to 写法不再给出可照抄的区间（l0 用「可写 to 的轮号：T1…T2」，l1/l2 用「可写 to 的序号：1…N」）',
  !/可写 to=T\d+–T\d+/.test(text) && !/可写 to=1–\d+/.test(text))
check('地图给出 l0 的轮号写法', /可写 to 的轮号：T\d+…T\d+|可写 to 的轮号：T\d+（|暂不可用/.test(text))
check('地图给出 l1/l2 的块序号写法', /可写 to 的序号：\d+…\d+|可写 to 的序号：\d+（|暂不可用/.test(text))
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
check('可写轮号不含缺轮号（T3 缺 → 上界退到 T2）',
  /可写 to 的轮号：T\d+(?:…T\d+)?（/.test(longGapText) && !/可写 to 的轮号：[^（]*T3/.test(longGapText)
    && !/可写 to 的轮号：T(\d+)…T\1/.test(longGapText),
  longGapText.slice(0, 600))
// 设计约束 裁定：l0 行的括号里要带上取舍口径，别让"可写"看起来像"该压"。
// 断言必须按行钉：光钉短语在整张图里出现过，把它挪到"压缩须知"下面测试照样绿（回归修复）。
{
  const l0Line = longGapText.split('\n').find((l) => l.startsWith('l0')) || ''
  check('l0 行的括号里说明"只压已经收尾的、还在推进的留着"',
    /可写 to 的轮号：T\d+(?:…T\d+)?（[^）]*只压已经收尾、结果已落地的内容，还在推进或接下来还要用的留着[^）]*）/.test(l0Line),
    l0Line.slice(0, 700))
}

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
  check('只有一个可写轮：写单值 `可写 to 的轮号：T1（`，不写 T1–T1',
    /可写 to 的轮号：T1（/.test(oneText) && !/可写 to 的轮号：T1…T1/.test(oneText), oneText.slice(0, 400))
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
  check('L1 只有小块时不再给出可写 to', !/可写 to 的序号/.test(l1Line), l1Line)
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
    check('L1 可压时写出"摘要+标题合计不超过 N token"', /摘要\+标题合计不超过 \d+ token 才过收益校验/.test(bigLine) && !/摘要正文不超过/.test(bigLine), bigLine)
  }
  // 收益预算超过产物层单块上限时，必须把上限也写出来：压 l1 的产物是 L2 块、上限 2000，
  // 只写"≤ 5406"会给出一个模型根本写不出来的数（2026-11-09 用户问"会不会诱导一压到底"时核出）。
  {
    const hugeBlock = (i) => ({
      role: 'user',
      source: { kind: 'compact-checkpoint' },
      content: [{ type: 'text', text: `〔L1｜T${i * 2 + 1}–T${i * 2 + 2}｜ev ${10 + i}–${20 + i}〕块${i + 1}\n` + '摘'.repeat(2000) }],
    })
    const hugeMsgs = [{ role: 'system', content: [{ type: 'text', text: 'sys' }] }, hugeBlock(0), hugeBlock(1), hugeBlock(2)]
    const hugeSession = { surface: { nodes: [1, 2, 3, 4] }, deriveMessages: () => hugeMsgs, requestContext: () => ({ contextWindow: 200000 }), requestHeader: () => ({ config: { maxTokens: 8000 } }) }
    const hugeCtx = { sessions: { get: () => hugeSession }, get: (name) => (name === 'sessionProjections' ? { stateOf: () => ({ turns: [{ turn: 1, seq: 9 }, { turn: 2, seq: 49 }] }) } : null) }
    const hugeLine = (renderMap(hugeCtx, agent, config, usage).text.split('\n').find((line) => line.startsWith('l1 ')) || '')
    check('收益预算超过产物层上限时，地图把单块上限也写出来',
      /摘要正文不超过 2000（L2 单块上限）/.test(hugeLine) && /摘要\+标题合计不超过 \d+ token 才过收益校验/.test(hugeLine), hugeLine)
  }
  // to=1 的预算同样要按产物层上限截断（qwen 快审 1163c1a 的 Major：首块很大时给 2390，实际 L2 上限 2000）。
  {
    const bigFirst = (i, n) => ({
      role: 'user',
      source: { kind: 'compact-checkpoint' },
      content: [{ type: 'text', text: `〔L1｜T${i * 2 + 1}–T${i * 2 + 2}｜ev ${10 + i}–${20 + i}〕块${i + 1}\n` + '摘'.repeat(n) }],
    })
    const msgs = [{ role: 'system', content: [{ type: 'text', text: 'sys' }] }, bigFirst(0, 4200), bigFirst(1, 200), bigFirst(2, 100)]
    const session = { surface: { nodes: [1, 2, 3, 4] }, deriveMessages: () => msgs, requestContext: () => ({ contextWindow: 200000 }), requestHeader: () => ({ config: { maxTokens: 8000 } }) }
    const ctx = { sessions: { get: () => session }, get: (name) => (name === 'sessionProjections' ? { stateOf: () => ({ turns: [{ turn: 1, seq: 9 }, { turn: 2, seq: 49 }] }) } : null) }
    const line = (renderMap(ctx, agent, config, usage).text.split('\n').find((l) => l.startsWith('l1 ')) || '')
    check('to=1 的预算也按产物层上限截断（首块很大时不承诺写不出来的数）',
      /to=1 只并最老的一块（\d+ token，够改写开销；摘要\+标题 ≤ 2000）/.test(line) && /摘要正文不超过 2000/.test(line), line)
  }
}

// 只有 2 块、首块够改写开销：可写序号只有一个（1），不能渲染成「1…1」（qwen 快审 15d6868/2f45f84 Minor）。
{
  const msgs = [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: '〔L1｜T1–T2｜ev 3–4〕块1\n' + '摘'.repeat(400) }] },
    { role: 'user', source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: '〔L1｜T3–T4｜ev 5–6〕块2\n' + '摘'.repeat(400) }] },
  ]
  const sess = { surface: { nodes: [1, 2, 3] }, deriveMessages: () => msgs, requestContext: () => ({ contextWindow: 200000 }), requestHeader: () => ({ config: { maxTokens: 8000 } }) }
  const c = { sessions: { get: () => sess }, get: (name) => (name === 'sessionProjections' ? { stateOf: () => ({ turns: [{ turn: 1, seq: 9 }, { turn: 2, seq: 49 }] }) } : null) }
  const line = (renderMap(c, agent, config, usage).text.split('\n').find((l) => l.startsWith('l1 ')) || '')
  check('只有 2 块时可写序号写单值 1，不写 1…1', /可写 to 的序号：1（该区共 2 块/.test(line) && !/1…1/.test(line), line)
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
  check('首块不够开销时表头写「可写 to 的序号：2」而不是 1…2', /可写 to 的序号：2（to=1 单独不可行）/.test(line) && !/2…2/.test(line), line)
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

if (failed) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}

console.log(`map 断言测试全部通过（${total} 项）`)
