// 胶水层冒烟：把 apply() 挂到假 ctx 上，真跑一次 agent/pre-step。
// 纯函数测试测不到这一层——"引用了外层作用域的变量却没接收成参数"这类错误，
// 只有真跑一遍才会现形（ee1fb7e 就是这么漏过去的）。
// 跑法：node plugin/test/prestep.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, describeResults, foldPending, receiptLines, resetGrowthBaseline, sceneContinues, sceneOfFlags, RECEIPT_CONTINUE_LINE } from '../index.js'
import { readGrowth } from '../lib/state.js'
import { DEFAULTS } from '../lib/config.js'
import { FOLD_NOTE_HEAD } from '../lib/callfold.js'

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

// 假会话：nodes 与 deriveMessages 一一对齐；append 带 surfaceOp 时按真实 splice 语义替换。
function fakeSession(nodes, messages) {
  let seq = 9000
  const session = {
    appends: [],
    get surface() {
      return { nodes: nodes.slice() }
    },
    deriveMessages() {
      return messages.slice()
    },
    append(type, data, opts) {
      session.appends.push({ type, data, opts })
      if (opts && opts.surfaceOp && typeof opts.surfaceOp === 'object') {
        const start = nodes.indexOf(opts.surfaceOp.startSeq)
        const end = nodes.indexOf(opts.surfaceOp.endSeq)
        const removed = end - start + 1
        nodes.splice(start, removed, seq++)
        messages.splice(start, removed, { role: 'user', content: data.content, source: data.source })
      }
      // 真实宿主的 append 返回**事件对象**（带 seq），不是数字：假桩返回数字会掩盖 sourceEventSeqs 之类的假设。
      const out = seq - 1
      return { type, seq: out, data, time: Date.now() }
    },
  }
  return session
}

const callMessage = (ids) => ({  role: 'assistant',
  content: ids.map(([name, id]) => ({ type: 'tool-call', name, id, arguments: '{"x":1}' })),
})
const resultMessage = (id) => ({ role: 'tool', toolCallId: id, content: [{ type: 'text', text: '成功' }] })

// 会话里现在有两类插件写的节点：提醒（#1）与轮次标记（#2）。
// 断言"没写提醒"时必须按 kind 过滤，否则会被每轮都写的轮次标记绊倒。
const NOTICE_KIND = 'cordis-host-runner'
const MARKER_KIND = 'ebbing-context-marker'
const onlyKind = (session, kind) =>
  session.appends.filter((a) => a.data && a.data.source && a.data.source.kind === kind)

// 假 ctx：只实现插件真正用到的接口，够跑起来就行。
function fakeCtx(session) {
  const tools = []
  const commands = []
  const handlers = new Map()
  return {
    tools,
    commands,
    handlers,
    session,
    toolsApi: { register: null },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(name) {
      if (name === 'commands') return { register: (cmd) => (commands.push(cmd), () => {}) }
      return undefined
    },
    on(event, handler) {
      handlers.set(event, handler)
      return () => {}
    },
    sessions: { get: () => session },
    agents: { requireInitiator: () => ({ id: 'a1' }) },
    sessionProjections: { stateOf: () => null },
    registerTools: null,
    toolRegister: (tool) => {
      tools.push(tool)
      return () => {}
    },
  }
}

await check('/context-status 第一行报告表层读到什么（正向信号）', async () => {
  const session = blockSession(2, 100)
  const ctx = fakeCtx(session)
  ctx.session = session
  ctx.tools = { register: () => () => {} }
  apply(ctx, { ...DEFAULTS })
  const cmd = ctx.commands[0]
  const res = cmd.handler({ agent: { id: 'a1' } })
  assert.equal(res.kind, 'success')
  assert.match(res.text.split('\n')[0], /^表层读取：正常（2 个节点 \/ 2 条消息）$/)
  assert.ok(res.text.includes('L1'), '地图正文仍要跟着出现')
})

await check('apply() 能挂上：两个工具 + 一条命令', async () => {
  const registered = []
  const ctx = fakeCtx(null)
  // tools 是服务对象而不是数组：换成只记录注册的注册器
  ctx.tools = { register: (tool) => (registered.push(tool), () => {}) }
  apply(ctx, {})
  assert.deepEqual(registered.map((t) => t.name).sort(), ['compress', 'context_map'])
  assert.equal(ctx.commands.length, 1)
  assert.equal(ctx.commands[0].name, 'context-status')
  assert.equal(typeof ctx.handlers.get('agent/pre-step'), 'function')
})

// 真机（OpenAI 兼容线）会因为嵌套对象里的 `required: true` 整轮失败：
// `Invalid schema for function 'compress': true is not of type "array"`。
// 这里按宿主自己的 raw-schema 边界逐条核（dsh-tools 的 assertSupportedJsonSchema）：
// ① required 必须是字符串数组；② 数组里的名字必须在 properties 里声明过；
// ③ additionalProperties 出现时必须是布尔；④ 只许出现受支持的少数关键字。
const SCHEMA_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples'])
function schemaViolations(root, path) {
  const bad = []
  const walk = (node, at) => {
    if (!node || typeof node !== 'object') { bad.push(`${at} 不是对象`); return }
    for (const key of Object.keys(node)) if (!SCHEMA_KEYWORDS.has(key)) bad.push(`${at}.${key} 不是受支持的关键字`)
    if (node.required !== undefined) {
      if (!Array.isArray(node.required) || node.required.some((x) => typeof x !== 'string')) bad.push(`${at}.required 不是字符串数组`)
      else for (const name of node.required) if (!node.properties || !(name in node.properties)) bad.push(`${at}.required 里的 ${name} 没在 properties 里`)
    }
    if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') bad.push(`${at}.additionalProperties 不是布尔`)
    for (const [key, value] of Object.entries(node.properties || {})) walk(value, `${at}.properties.${key}`)
  }
  walk(root, path)
  return bad
}

await check('compress 的参数树符合宿主 raw-schema 边界（嵌套层用 required 数组）', async () => {
  const registered = []
  const ctx = fakeCtx(null)
  ctx.tools = { register: (tool) => (registered.push(tool), () => {}) }
  apply(ctx, {})
  const compress = registered.find((t) => t.name === 'compress')
  assert.deepEqual(schemaViolations(compress.parameters, 'parameters'), [])

  const blocks = compress.parameters.properties
  assert.deepEqual(Object.keys(blocks).sort(), ['l0', 'l1', 'l2', 'l3'])
  assert.deepEqual([...blocks.l3.required].sort(), ['summary', 'title'])
  assert.deepEqual([...blocks.l0.required].sort(), ['summary', 'title', 'to'])
})

await check('pre-step 空跑：不抛异常，且一定调用 next()', async () => {
  const session = fakeSession([10], [{ role: 'user', content: [{ type: 'text', text: '你好' }] }])
  const ctx = fakeCtx(session)
  ctx.tools = { register: () => () => {} }
  apply(ctx, {})
  const handler = ctx.handlers.get('agent/pre-step')
  let nexted = false
  await handler({ agent: { id: 'a1' }, turn: 3, step: 1 }, () => {
    nexted = true
  })
  assert.equal(nexted, true)
})

// —— 提醒的投递时机（用户要求：固定在本轮收尾、用户下一句话之前）——

function usageSession(used) {
  const session = fakeSession([10], [{ role: 'user', content: [{ type: 'text', text: '你好' }] }])
  session.seq = 1
  session.requestContext = () => ({ contextWindow: 1000 })
  session.used = used
  return session
}

// 到线测试需要一个「真压得动」的会话：三个 L1 块（zoneRangeCost 取前两块，成本才够地板），L1 区上限调到 0.5（块合计不越区），
// 窗口 4000、used 3600 = 90% 到线。2026-11-14 起到线统一当步内联，不再分可压/不可压。
const LINE_CONFIG = { ...DEFAULTS, reservedTokens: 0, budget: { ...DEFAULTS.budget, l1: 0.5 } }

function lineSession(used = 3600) {
  const session = blockSession(3, 150)
  session.requestContext = () => ({ contextWindow: 4000 })
  session.used = used
  return session
}

function usageCtx(session) {
  const ctx = fakeCtx(session)
  // 会话搜索必须装着：提醒现在走同一道闸门（回归修复），没装就不叫醒。
  ctx.tools = { register: () => () => {}, get: (name) => (name === 'session_event_read' || name === 'session_event_search' ? {} : undefined) }
  ctx.tokenMeter = { measure: () => ({ totalTokens: session.used }) }
  return ctx
}

const STEP = (turn, step = 1, extra = {}) => ({ agent: wakeAgent(), turn, step, signal: new AbortController().signal, ...extra })

// 被叫醒的那个 agent：followup 只是把消息排进 inbox 的 next-turn，宿主在本轮结束后自己开新一轮。
function wakeAgent() {
  const agent = {
    id: 'a1',
    followups: [],
    replaced: [],
    inbox: {
      // 宿主每轮只认领一条 next-turn（agent-loop 的 claim 是 mutate(..., 0, 1, ...)），
      // 所以这里模拟真实的 pending 列表：默认空。
      nextTurn: [],
      replace(messageId, message) {
        const at = agent.inbox.nextTurn.findIndex((m) => m.id === messageId)
        if (at < 0) return false
        agent.inbox.nextTurn[at] = message
        agent.replaced.push({ messageId, message })
        return true
      },
    },
    followup(message) {
      agent.followups.push(message)
      agent.inbox.nextTurn.push(message)
    },
  }
  return agent
}

// 没有 followup 的形状（拿不到活 agent 时）：提醒退化成尾部追加。
const plainAgent = { id: 'a1' }

// 宿主在下一轮第 1 步认领 next-turn 提醒。autoTurn 只在真正认领时写，
// 所以凡是要验叫醒轮场景的测试，都必须把 followup 排出去的那条消息放进 claims。
const claimWake = (turn, agent, extra = {}) => STEP(turn, 1, { agent, messages: [agent.followups.at(-1)], ...extra })

await check('到线：pre-step 当步直接写内联提醒，不叫醒', async () => {
  const session = lineSession(3600)
  const ctx = usageCtx(session)
  apply(ctx, LINE_CONFIG)
  const step = STEP(3)
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  const inline = onlyKind(session, NOTICE_KIND)
  assert.equal(inline.length, 1, '到线要当步写提醒')
  assert.equal(step.agent.followups.length, 0, '到线不再 followup')
  assert.equal(onlyKind(session, MARKER_KIND).length, 1, '先写轮次标记')
})

await check('到线即使没有可压位置：也发同一条轮内提醒，每次越线只发一次', async () => {
  const session = usageSession(900)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  // 第 3 轮第 1 步：没有可压层也发到线提醒（用户 2026-11-14 裁定，不再有“压不动紧急提示”）。
  const s3 = STEP(3, 1)
  await ctx.handlers.get('agent/pre-step')(s3, () => {})
  const inline = onlyKind(session, NOTICE_KIND)
  assert.equal(inline.length, 1, '到线要写轮内提醒')
  assert.equal(s3.agent.followups.length, 0, '到线不叫醒模型开新轮')
  const text = String(inline[0].data.content[0].text)
  assert.match(text, /现在可以压/, '到线提醒要说明可以压')
  assert.doesNotMatch(text, /紧急提示/, '不再有紧急提示分支')
  assert.doesNotMatch(text, /不要继续扩大这一轮/, '不再要求停止扩大')
  // 同一轮第 2 步：还停在线上面，不重复写。
  await ctx.handlers.get('agent/pre-step')(STEP(3, 2, { agent: s3.agent }), () => {})
  assert.equal(onlyKind(session, NOTICE_KIND).length, 1, '同一次越线只提示一次')
  // 轮末也不该产生 pending / 叫醒（inline 走的是表层，不是 followup）。
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: s3.signal }, () => {})
  assert.equal(s3.agent.followups.length, 0, 'inline 不产生 pending，轮末不该叫醒')
  // 掉回线下再越线：这是新的一次越线，要再提示一次。
  session.used = 400
  session.seq += 1
  await ctx.handlers.get('agent/pre-step')(STEP(5, 1, { agent: s3.agent }), () => {})
  session.used = 900
  session.seq += 1
  await ctx.handlers.get('agent/pre-step')(STEP(6, 1, { agent: s3.agent }), () => {})
  assert.equal(onlyKind(session, NOTICE_KIND).length, 2, '掉回线下再越线要重新提示')
})

await check('step 1：先写轮次标记再写到线提醒，提醒不会被算进上一轮', async () => {
  const session = usageSession(900)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  await ctx.handlers.get('agent/pre-step')(STEP(1, 1), () => {})
  const marks = onlyKind(session, MARKER_KIND)
  const notices = onlyKind(session, NOTICE_KIND)
  assert.equal(marks.length, 1, 'step 1 要补本轮标记')
  assert.match(String(marks[0].data.content[0].text), /本轮 T1/)
  assert.equal(notices.length, 1, '到线要写轮内提醒')
  assert.equal(session.appends[0].data.source.kind, MARKER_KIND, '标记必须先写：否则锚点把提示算进上一轮')
  assert.equal(session.appends[1].data.source.kind, NOTICE_KIND, '到线提醒写在标记之后')
})

await check('notice.enabled=false：常规提醒与到线轮内提醒都停用', async () => {
  const session = usageSession(900)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, notice: { ...DEFAULTS.notice, enabled: false } })
  const step = STEP(3, 1)
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  assert.equal(onlyKind(session, NOTICE_KIND).length, 0, '关掉提醒开关就不能写提醒')
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: step.signal }, () => {})
  assert.equal(step.agent.followups.length, 0, '关掉开关也不该留 pending 到轮末叫醒')
})

await check('到线不再 followup：当步写内联提醒，提醒带完整地图', async () => {
  const session = lineSession(3600)
  const ctx = usageCtx(session)
  apply(ctx, LINE_CONFIG)
  const step = STEP(3)
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: step.signal }, () => {})
  assert.equal(step.agent.followups.length, 0, '到线不再叫醒模型开新轮')
  const inline = onlyKind(session, NOTICE_KIND)
  assert.equal(inline.length, 1, '到线提醒写在表层')
  const noticeText = String(inline[0].data.content[0].text)
  assert.match(noticeText, /上下文已用 90%/)
  assert.match(noticeText, /压缩须知/, '提醒里必须带完整地图（须知段）')
  assert.doesNotMatch(noticeText, /能压（to 照抄，别自己数）/, '提醒不能用紧凑版顶替完整地图')
  assert.match(noticeText.split('\n')[0], /自动提醒/, '提醒首行必须标明是插件注入的自动提醒')
  assert.match(noticeText.split('\n')[0], /不是用户/, '提醒首行必须说明这不是用户发言')
  assert.equal(inline[0].data.source.kind, 'cordis-host-runner', '提醒的 source.kind 必须是宿主登记过的')
  assert.match(noticeText, /请在一次压缩中完成，不要分多次压缩/, '提醒要明确说"一次压缩完成"')
  assert.match(noticeText, /把要压的层一起给全（深浅同批，区间自己权衡/, '级联句要区分"层给全"与"区间大小"')
  assert.match(noticeText, /不要因为这次提醒结束本轮/, '到线提醒不能要求结束本轮')
  assert.match(noticeText, /继续当前任务/, '到线提醒要求压完继续当前任务')
  assert.doesNotMatch(noticeText, /压缩专用轮/, '到线轮不是压缩专用轮，不能打收手标记')
  assert.doesNotMatch(noticeText, /轮末叫醒的压缩专用轮/, '到线轮的地图不能印叫醒须知')
})

await check('拿不到活 agent（没有 followup）：退化成尾部追加', async () => {
  const session = lineSession(3600)
  const ctx = usageCtx(session)
  apply(ctx, LINE_CONFIG)
  const step = STEP(3, 1, { agent: plainAgent })
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: step.signal }, () => {})
  const noticed = onlyKind(session, NOTICE_KIND)
  assert.equal(noticed.length, 1)
  assert.equal(noticed[0].opts.surfaceOp, 'append')
})

await check('followup 不可用：尾部追加按 plain 渲染，不写压缩专用轮标记', async () => {
  const session = blockSession(5, 150)
  session.requestContext = () => ({ contextWindow: 4000 })
  session.used = 200
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.75, keepTurns: 1, notice: { ...DEFAULTS.notice, growthTokens: 50 } })
  const s1 = STEP(5, 1, { agent: plainAgent })
  await ctx.handlers.get('agent/pre-step')(s1, () => {})
  session.used = 300
  session.seq += 1
  const s2 = STEP(5, 2, { agent: plainAgent })
  await ctx.handlers.get('agent/pre-step')(s2, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 5, signal: s2.signal }, () => {})
  const noticed = onlyKind(session, NOTICE_KIND)
  assert.equal(noticed.length, 1, '退化路径只追加一条')
  assert.equal(noticed[0].opts.surfaceOp, 'append')
  const text = String(noticed[0].data.content[0].text)
  assert.doesNotMatch(text, /压缩专用轮/, '追加不是新开一轮，不能写压缩专用轮标记')
  assert.doesNotMatch(text, /压完就结束本轮/, '追加不能要求结束本轮')
  assert.match(text, /按原计划继续/, '追加按 plain 继续')
  assert.match(text, /压完继续当前任务/, '地图也是 plain 须知')
})

await check('followup 抛错：也走尾部追加，且按 plain 渲染', async () => {
  const session = blockSession(5, 150)
  session.requestContext = () => ({ contextWindow: 4000 })
  session.used = 200
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.75, keepTurns: 1, notice: { ...DEFAULTS.notice, growthTokens: 50 } })
  let tried = 0
  const badAgent = {
    id: 'a1',
    inbox: { nextTurn: [] },
    followup() {
      tried += 1
      throw new Error('followup unavailable')
    },
  }
  const s1 = STEP(5, 1, { agent: badAgent })
  await ctx.handlers.get('agent/pre-step')(s1, () => {})
  session.used = 300
  session.seq += 1
  const s2 = STEP(5, 2, { agent: badAgent })
  await ctx.handlers.get('agent/pre-step')(s2, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 5, signal: s2.signal }, () => {})
  assert.equal(tried, 1, '先试过 followup')
  const noticed = onlyKind(session, NOTICE_KIND)
  assert.equal(noticed.length, 1, 'followup 抛错后仍要追加一条')
  assert.equal(noticed[0].opts.surfaceOp, 'append')
  const text = String(noticed[0].data.content[0].text)
  assert.doesNotMatch(text, /压缩专用轮/, 'followup 抛错后不能保留 wake 标记')
  assert.doesNotMatch(text, /压完就结束本轮/, 'followup 抛错后不能要求结束本轮')
  assert.match(text, /按原计划继续/, 'followup 抛错后按 plain 继续')
  assert.match(text, /压完继续当前任务/, '地图按 plain')
})

// ── 轮次标记：模型靠它把「压掉 T1–T15」和表层里那一段对上号 ──────────────
await check('轮次标记：收尾写「下一轮 T{N+1}」，而且不会重复写', async () => {
  const session = usageSession(100) // 远低于线，不该有提醒，只剩标记
  const ctx = usageCtx(session)
  apply(ctx, LINE_CONFIG)
  const step = STEP(3)
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: step.signal, agent: step.agent }, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: step.signal, agent: step.agent }, () => {})
  const marks = onlyKind(session, MARKER_KIND)
  // 第一条是轮首兜底写的「本轮 T3」，第二条是收尾写的「下一轮 T4」；重复收尾不再加。
  assert.equal(marks.length, 2, '轮首兜底 + 收尾各一条，重复收尾不再加')
  const text = String(marks[1].data.content[0].text)
  assert.match(text, /〔轮次标记〕/)
  assert.match(text, /下一轮 T4/)
  assert.equal(marks[1].opts.surfaceOp, 'append')
})

await check('轮次标记：轮首兜底补「本轮 T{N}」，同一轮只补一次，下一步不重复', async () => {
  const session = usageSession(100)
  const ctx = usageCtx(session)
  apply(ctx, LINE_CONFIG)
  // 上一轮异常收场 → 没有「下一轮」那条，轮首必须自己补
  const step1 = STEP(3, 1)
  await ctx.handlers.get('agent/pre-step')(step1, () => {})
  const first = onlyKind(session, MARKER_KIND)
  assert.equal(first.length, 1)
  assert.match(String(first[0].data.content[0].text), /本轮 T3/)
  assert.match(String(first[0].data.content[0].text), /这一轮的内容就在这条标记之后/)
  // 同轮第 2 步：已经有了，不再写
  await ctx.handlers.get('agent/pre-step')(STEP(3, 2), () => {})
  assert.equal(onlyKind(session, MARKER_KIND).length, 1, '同一步里不该重复补标记')
})

await check('轮次标记：上一轮收尾已经写好「下一轮」，下一轮轮首不再补', async () => {
  const session = usageSession(100)
  const ctx = usageCtx(session)
  apply(ctx, LINE_CONFIG)
  const step = STEP(3)
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: step.signal, agent: step.agent }, () => {})
  const before = onlyKind(session, MARKER_KIND).length
  await ctx.handlers.get('agent/pre-step')(STEP(4, 1), () => {})
  assert.equal(onlyKind(session, MARKER_KIND).length, before, '已有「下一轮 T4」就不该再补一条「本轮 T4」')
})

await check('空表层（首轮、宿主还没写系统头）→ 任何节点都不许写，避免抢占表层头位', async () => {
  // 0.1.15 真机事故：首轮 pre-step 跑在宿主 append system/message 之前，
  // 此时写「本轮 T1」会成为表层第一个节点；运行期没事，关闭重开后宿主重放校验
  // 要求首节点是 system/message，整份日志被判 corrupt（SessionFormatError）。
  const session = fakeSession([], [])
  session.seq = 1
  session.requestContext = () => ({ contextWindow: 1000 })
  session.used = 100
  const ctx = usageCtx(session)
  apply(ctx, LINE_CONFIG)
  const step = STEP(1, 1)
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  // 收尾也一样：这一轮连请求都没发出去时表层仍是空的
  await ctx.handlers.get('agent/turn-stopping')({ turn: 1, signal: step.signal, agent: step.agent }, () => {})
  assert.equal(onlyKind(session, MARKER_KIND).length, 0, '空表层上一条标记都不许写')
  assert.equal(session.appends.length, 0, '空表层上任何 append 都不许发生')
})

await check('到线内联不产生 pending：下一轮同一次越线不重复发', async () => {
  const session = lineSession(3600)
  const ctx = usageCtx(session)
  apply(ctx, LINE_CONFIG)
  const s3 = STEP(3)
  await ctx.handlers.get('agent/pre-step')(s3, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: s3.signal }, () => {})
  assert.equal(s3.agent.followups.length, 0, '到线不 followup')
  assert.equal(onlyKind(session, NOTICE_KIND).length, 1, '当步写一条')
  const s4 = STEP(4, 1, { agent: s3.agent })
  await ctx.handlers.get('agent/pre-step')(s4, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 4, signal: s4.signal }, () => {})
  assert.equal(onlyKind(session, NOTICE_KIND).length, 1, '同一次越线不重复发')
})

await check('到线只在越线时报一次：掉回线下再越线才会再报（不在线上反复催）', async () => {
  const session = lineSession(3600)
  const ctx = usageCtx(session)
  apply(ctx, { ...LINE_CONFIG, notice: { ...DEFAULTS.notice, growthTokens: 0 } })
  const s3 = STEP(3)
  await ctx.handlers.get('agent/pre-step')(s3, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: s3.signal }, () => {})
  assert.equal(onlyKind(session, NOTICE_KIND).length, 1, '越线时报一条内联')
  assert.equal(s3.agent.followups.length, 0, '到线不 followup')
  // 一直停在线上面：用户开口了、又过了一轮，也不该再报（设计约束）
  const s4 = STEP(4, 1, { agent: s3.agent, messages: [{ role: 'user', content: [], source: { kind: 'user' } }] })
  await ctx.handlers.get('agent/pre-step')(s4, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 4, signal: s4.signal }, () => {})
  assert.equal(onlyKind(session, NOTICE_KIND).length, 1, '在线上面不该每轮重复报')
  // 掉回线下（压缩后），再越线一次 → 重新亮灯
  session.used = 400
  session.seq += 1
  const s5 = STEP(5, 1, { agent: s3.agent })
  await ctx.handlers.get('agent/pre-step')(s5, () => {})
  session.used = 3600
  session.seq += 1
  const s6 = STEP(6, 1, { agent: s3.agent })
  await ctx.handlers.get('agent/pre-step')(s6, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 6, signal: s6.signal }, () => {})
  assert.equal(onlyKind(session, NOTICE_KIND).length, 2, '掉回线下再越线，要重新报一次')
})

await check('普通用户轮越线：用户第 1 步的提问不算插话，地图仍按 root-line', async () => {
  const session = lineSession(400)
  const ctx = usageCtx(session)
  apply(ctx, { ...LINE_CONFIG, notice: { ...DEFAULTS.notice, growthTokens: 0 } })
  // 先跑完一轮，让增长状态存在（noteUserSpoke 只在状态已存在时看消息）。
  const s2 = STEP(2, 1)
  await ctx.handlers.get('agent/pre-step')(s2, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 2, signal: s2.signal }, () => {})
  // 真实路径：第 1 步就带着用户自己的提问（不是叫醒轮，也不是插话），且此时越线。
  session.used = 3600
  session.seq += 1
  const step = STEP(3, 1, {
    messages: [{ role: 'user', content: [{ type: 'text', text: '帮我看看这个' }], source: { kind: 'user' } }],
  })
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  const text = String(onlyKind(session, NOTICE_KIND)[0].data.content[0].text)
  assert.match(text, /这一轮是轮内到线提醒/, '普通用户轮的到线须知必须还是 root-line')
  assert.doesNotMatch(text, /这一轮是轮末叫醒的压缩专用轮/, '不能因为用户提问就当成叫醒轮')
})

await check('子代理：轮内到线也在当步内联，不 followup', async () => {
  const session = lineSession(200)
  session.id = 'sub-1'
  session.header = { version: 4, id: 'sub-1', createdAt: 0, isSeeded: false, origin: 'subagent' }
  const ctx = usageCtx(session)
  ctx.agents = { requireInitiator: () => ({ id: 'sub-1' }) }
  apply(ctx, LINE_CONFIG)
  const agent = wakeAgent()
  agent.id = 'sub-1'
  agent.session = session
  const s1 = STEP(1, 1, { agent })
  await ctx.handlers.get('agent/pre-step')(s1, () => {})
  session.used = 3600
  session.seq += 1
  const s2 = STEP(1, 2, { agent })
  await ctx.handlers.get('agent/pre-step')(s2, () => {})
  assert.equal(onlyKind(session, NOTICE_KIND).length, 1, '子代理轮内到线也要写提醒')
  assert.equal(agent.followups.length, 0, '子代理到线不 followup')
  assert.match(String(onlyKind(session, NOTICE_KIND)[0].data.content[0].text), /父会话/, '子代理文案要说明父会话')
})

await check('子代理：增长/区超限只在 step1 内联，step>1 不追加', async () => {
  const session = layeredSession(['L1', 'L1'], 260, 100)
  session.id = 'sub-2'
  session.header = { version: 4, id: 'sub-2', createdAt: 0, isSeeded: false, origin: 'subagent' }
  const ctx = usageCtx(session)
  ctx.agents = { requireInitiator: () => ({ id: 'sub-2' }) }
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.99, budget: { ...DEFAULTS.budget, l1: 0.5 }, notice: { ...DEFAULTS.notice, growthTokens: 50 } })
  const agent = wakeAgent()
  agent.id = 'sub-2'
  agent.session = session
  await ctx.handlers.get('agent/pre-step')(STEP(1, 1, { agent }), () => {})
  session.used = 200
  session.seq += 1
  await ctx.handlers.get('agent/pre-step')(STEP(1, 1, { agent }), () => {})
  assert.equal(onlyKind(session, NOTICE_KIND).length, 1, 'step1 有可压层时应该内联')
  assert.doesNotMatch(String(onlyKind(session, NOTICE_KIND)[0].data.content[0].text), /任务在这条提醒之后|这是本轮开头/, '不再声明任务与提醒的先后关系')
  await ctx.handlers.get('agent/pre-step')(STEP(1, 2, { agent }), () => {})
  assert.equal(onlyKind(session, NOTICE_KIND).length, 1, 'step>1 不追加增长提醒')
  assert.equal(agent.followups.length, 0, '子代理不 followup')
})

await check('同轮先登记增长、后越线内联：旧 pending 要撤掉，轮末不再 followup', async () => {
  const session = blockSession(5, 150)
  session.requestContext = () => ({ contextWindow: 4000 })
  session.used = 200
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.75, keepTurns: 1, notice: { ...DEFAULTS.notice, growthTokens: 50 } })
  const agent = wakeAgent()
  const signal = new AbortController().signal
  await ctx.handlers.get('agent/pre-step')(STEP(5, 1, { agent, signal }), () => {})
  session.used = 300
  session.seq += 1
  await ctx.handlers.get('agent/pre-step')(STEP(5, 2, { agent, signal }), () => {})
  session.used = 3600
  session.seq += 1
  await ctx.handlers.get('agent/pre-step')(STEP(5, 3, { agent, signal }), () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 5, signal }, () => {})
  assert.equal(onlyKind(session, NOTICE_KIND).length, 1, '到线内联一条')
  assert.equal(agent.followups.length, 0, '同轮旧的增长 pending 不能再到轮末 followup')
})

await check('根会话被增长叫醒的轮里跨到线：到线仍要内联提醒', async () => {
  const session = blockSession(5, 150)
  session.requestContext = () => ({ contextWindow: 4000 })
  session.used = 200
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.75, keepTurns: 1, notice: { ...DEFAULTS.notice, growthTokens: 50 } })
  const agent = wakeAgent()
  const t1 = STEP(5, 1, { agent })
  await ctx.handlers.get('agent/pre-step')(t1, () => {})
  session.used = 300
  session.seq += 1
  await ctx.handlers.get('agent/pre-step')(STEP(5, 2, { agent }), () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 5, signal: t1.signal }, () => {})
  assert.equal(agent.followups.length, 1, '增长提醒先 followup')
  const noticesBefore = onlyKind(session, NOTICE_KIND).length
  // 下一轮是叫醒轮；占用跨到线，不能被 autoTurn 早退吞掉。
  session.used = 3600
  session.seq += 1
  await ctx.handlers.get('agent/pre-step')(claimWake(6, agent), () => {})
  assert.equal(onlyKind(session, NOTICE_KIND).length, noticesBefore + 1, '叫醒轮内跨到线仍要内联提醒')
  assert.equal(agent.followups.length, 1, '到线不额外 followup')
  // 混合轮：这一轮是叫醒轮，补发的到线提醒也必须按“压缩专用轮”给，不能出现“继续当前任务”。
  const mixed = String(onlyKind(session, NOTICE_KIND).at(-1).data.content[0].text)
  assert.match(mixed, /〔这一轮是压缩专用轮：压完就结束本轮〕/, '叫醒轮里补发的提醒也要打标记')
  assert.match(mixed, /轮末叫醒的压缩专用轮：压完就收手/, '混合轮的地图要印叫醒须知')
  assert.doesNotMatch(mixed, /压完继续当前任务/, '混合轮不能出现“继续当前任务”')
  assert.doesNotMatch(mixed, /不要因为这次提醒结束本轮/, '混合轮不能出现“不要结束本轮”')
  assert.doesNotMatch(mixed, /这一轮是轮内到线提醒/, '混合轮不能印到线须知')
})

await check('轮末叫醒提醒：首行压缩专用轮标记、正文与地图都收手', async () => {
  const session = blockSession(5, 150)
  session.requestContext = () => ({ contextWindow: 4000 })
  session.used = 200
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.75, keepTurns: 1, notice: { ...DEFAULTS.notice, growthTokens: 50 } })
  const agent = wakeAgent()
  const t1 = STEP(5, 1, { agent })
  await ctx.handlers.get('agent/pre-step')(t1, () => {})
  session.used = 300
  session.seq += 1
  await ctx.handlers.get('agent/pre-step')(STEP(5, 2, { agent }), () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 5, signal: t1.signal }, () => {})
  assert.equal(agent.followups.length, 1, '增长要叫醒')
  const wakeText = String(agent.followups[0].content[0].text)
  assert.match(wakeText, /〔这一轮是压缩专用轮：压完就结束本轮〕/, '叫醒提醒首行要有压缩专用轮标记')
  assert.match(wakeText, /轮末叫醒的压缩专用轮：压完就收手/, '地图只印叫醒须知')
  assert.match(wakeText, /压完就结束本轮，只回一两句/, '收尾段要明确结束本轮')
  assert.match(wakeText, /如果这一轮用户又发来新消息，以用户的新消息为准/, '用户插话优先于收手')
  assert.doesNotMatch(wakeText, /压完继续当前任务/, '叫醒轮不能出现“继续当前任务”')
  assert.doesNotMatch(wakeText, /按原计划继续/, '叫醒轮不能让人按原计划继续')
  assert.doesNotMatch(wakeText, /这一轮是轮内到线提醒/, '叫醒轮不能印到线须知')
})

await check('叫醒轮里 /context-status 与 context_map 都按 wake 给须知（接线级）', async () => {
  const session = blockSession(5, 150)
  session.requestContext = () => ({ contextWindow: 4000 })
  session.used = 200
  const ctx = usageCtx(session)
  const registered = []
  ctx.tools = { register: (tool) => (registered.push(tool), () => {}), get: () => ({}) }
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.75, keepTurns: 1, notice: { ...DEFAULTS.notice, growthTokens: 50 } })
  const agent = wakeAgent()
  const t1 = STEP(5, 1, { agent })
  await ctx.handlers.get('agent/pre-step')(t1, () => {})
  session.used = 300
  session.seq += 1
  await ctx.handlers.get('agent/pre-step')(STEP(5, 2, { agent }), () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 5, signal: t1.signal }, () => {})
  assert.equal(agent.followups.length, 1, '先被叫醒')
  // 叫醒轮第 1 步：currentSteps = {turn:6}，autoTurn=6，两个只读入口都必须拿到 root-wake。
  session.seq += 1
  await ctx.handlers.get('agent/pre-step')(claimWake(6, agent), () => {})
  const cmd = ctx.commands[0]
  const cmdText = cmd.handler({ agent }).text
  assert.match(cmdText, /轮末叫醒的压缩专用轮：压完就收手/, '/context-status 要按 wake')
  assert.doesNotMatch(cmdText, /这一轮是轮内到线提醒/, '/context-status 不能印到线须知')
  const mapTool = registered.find((t) => t.name === 'context_map')
  const mapOut = await mapTool.execute({}, { agent })
  assert.match(mapOut.text, /轮末叫醒的压缩专用轮：压完就收手/, 'context_map 要按 wake')
  assert.doesNotMatch(mapOut.text, /这一轮是轮内到线提醒/, 'context_map 不能印到线须知')
})

await check('叫醒轮里用户插话：执行位退回 plain（提醒里的优先级句兜底）', async () => {
  const session = blockSession(5, 150)
  session.requestContext = () => ({ contextWindow: 4000 })
  session.used = 200
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.75, keepTurns: 1, notice: { ...DEFAULTS.notice, growthTokens: 50 } })
  const agent = wakeAgent()
  const t1 = STEP(5, 1, { agent })
  await ctx.handlers.get('agent/pre-step')(t1, () => {})
  session.used = 300
  session.seq += 1
  await ctx.handlers.get('agent/pre-step')(STEP(5, 2, { agent }), () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 5, signal: t1.signal }, () => {})
  session.seq += 1
  await ctx.handlers.get('agent/pre-step')(claimWake(6, agent), () => {})
  // 宿主认领 next-turn 后队列就空了；mock 不会自己清，手工模拟一下。
  agent.inbox.nextTurn.length = 0
  // 用户在叫醒轮第 2 步插话：宿主把插话排到下一步认领，noteUserSpoke 必须记下 spokeTurn。
  // 同时把用量抬高，让这一轮真的攒下一条增长提醒——轮末也只允许退化追加，不能再叫醒一次。
  session.used = 400
  session.seq += 1
  const s2 = STEP(6, 2, {
    agent,
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '先回答我这个新问题' }] }],
  })
  await ctx.handlers.get('agent/pre-step')(s2, () => {})
  const cmdText = ctx.commands[0].handler({ agent }).text
  assert.match(cmdText, /压完继续当前任务/, '用户开口后按 plain 继续')
  assert.doesNotMatch(cmdText, /轮末叫醒的压缩专用轮/, '用户开口后不能再印收手须知')
  await ctx.handlers.get('agent/turn-stopping')({ turn: 6, signal: s2.signal, agent }, () => {})
  assert.equal(agent.followups.length, 1, '被叫醒的轮只叫醒一次：用户插话不能让轮末再叫醒一次')
  // 下一轮（turn7）轮号不同：叫醒闸门自然打开，再长到门槛就该重新叫醒。
  session.used = 500
  session.seq += 1
  const s7 = STEP(7, 1, { agent })
  await ctx.handlers.get('agent/pre-step')(s7, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 7, signal: s7.signal, agent }, () => {})
  assert.equal(agent.followups.length, 2, '叫醒轮之后的下一轮仍能再叫醒')
})

await check('叫醒轮里宿主 runtime-context/compact-checkpoint 不算用户插话，真用户消息才算', async () => {
  const session = blockSession(5, 150)
  session.requestContext = () => ({ contextWindow: 4000 })
  session.used = 200
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.75, keepTurns: 1, notice: { ...DEFAULTS.notice, growthTokens: 50 } })
  const agent = wakeAgent()
  const t1 = STEP(5, 1, { agent })
  await ctx.handlers.get('agent/pre-step')(t1, () => {})
  session.used = 300
  session.seq += 1
  await ctx.handlers.get('agent/pre-step')(STEP(5, 2, { agent }), () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 5, signal: t1.signal }, () => {})
  session.seq += 1
  await ctx.handlers.get('agent/pre-step')(claimWake(6, agent), () => {})
  agent.inbox.nextTurn.length = 0
  // 宿主运行期上下文：不是用户说话，不能把叫醒轮降成 plain。
  session.seq += 1
  await ctx.handlers.get('agent/pre-step')(STEP(6, 2, {
    agent,
    messages: [
      { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '宿主注入的上下文' }] },
      { source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: '宿主压缩检查点' }] },
    ],
  }), () => {})
  assert.match(ctx.commands[0].handler({ agent }).text, /轮末叫醒的压缩专用轮/, 'runtime-context/compact-checkpoint 不降 plain')
  // 真用户消息：降 plain。
  session.seq += 1
  await ctx.handlers.get('agent/pre-step')(STEP(6, 3, {
    agent,
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '先回答我' }] }],
  }), () => {})
  assert.match(ctx.commands[0].handler({ agent }).text, /压完继续当前任务/, '真用户消息降 plain')
})

await check('叫醒提醒被取消/排队未认领：普通轮不按叫醒轮，认领后才按 wake', async () => {
  const session = blockSession(5, 150)
  session.requestContext = () => ({ contextWindow: 4000 })
  session.used = 200
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.75, keepTurns: 1, notice: { ...DEFAULTS.notice, growthTokens: 50 } })
  const agent = wakeAgent()
  const t1 = STEP(5, 1, { agent })
  await ctx.handlers.get('agent/pre-step')(t1, () => {})
  session.used = 300
  session.seq += 1
  await ctx.handlers.get('agent/pre-step')(STEP(5, 2, { agent }), () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 5, signal: t1.signal }, () => {})
  assert.equal(agent.followups.length, 1, '先叫醒一次')
  // 取消：宿主清空 inbox，下一轮没有我们的提醒可认领。
  agent.inbox.nextTurn.length = 0
  session.seq += 1
  const s6 = STEP(6, 1, { agent })
  await ctx.handlers.get('agent/pre-step')(s6, () => {})
  let cmdText = ctx.commands[0].handler({ agent }).text
  assert.match(cmdText, /压完继续当前任务/, '提醒被取消：本轮按普通轮继续')
  assert.doesNotMatch(cmdText, /轮末叫醒的压缩专用轮/, '没认领到提醒就不能按叫醒轮渲染')
  // 排队：提醒还在 next-turn，但本轮没轮到它（宿主每轮只认领一条）。
  agent.inbox.nextTurn.push(agent.followups[0])
  session.seq += 1
  const s7 = STEP(7, 1, { agent })
  await ctx.handlers.get('agent/pre-step')(s7, () => {})
  cmdText = ctx.commands[0].handler({ agent }).text
  assert.match(cmdText, /压完继续当前任务/, '提醒还在排队：本轮仍按普通轮')
  assert.doesNotMatch(cmdText, /轮末叫醒的压缩专用轮/, '排队未认领也不能按叫醒轮渲染')
  // 下一轮真正认领到提醒：这时才按叫醒轮。
  session.seq += 1
  await ctx.handlers.get('agent/pre-step')(claimWake(8, agent), () => {})
  cmdText = ctx.commands[0].handler({ agent }).text
  assert.match(cmdText, /轮末叫醒的压缩专用轮/, '认领到提醒后才是叫醒轮')
})

await check('叫醒轮收尾后 /context-status 按 plain（不拿上一轮状态冒充本轮）', async () => {
  const session = blockSession(5, 150)
  session.requestContext = () => ({ contextWindow: 4000 })
  session.used = 200
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.75, keepTurns: 1, notice: { ...DEFAULTS.notice, growthTokens: 50 } })
  const agent = wakeAgent()
  const t1 = STEP(5, 1, { agent })
  await ctx.handlers.get('agent/pre-step')(t1, () => {})
  session.used = 300
  session.seq += 1
  await ctx.handlers.get('agent/pre-step')(STEP(5, 2, { agent }), () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 5, signal: t1.signal }, () => {})
  session.seq += 1
  const s6 = claimWake(6, agent)
  await ctx.handlers.get('agent/pre-step')(s6, () => {})
  // 收尾载荷带 agent 时清 currentSteps；此后命令不再把上一轮当"当前轮"。
  await ctx.handlers.get('agent/turn-stopping')({ turn: 6, signal: s6.signal, agent }, () => {})
  const cmdText = ctx.commands[0].handler({ agent }).text
  assert.match(cmdText, /压完继续当前任务/, '收尾后按 plain 继续')
  assert.doesNotMatch(cmdText, /轮末叫醒的压缩专用轮/, '收尾后不能再印收手须知')
})

await check('场景判定：叫醒优先于到线、plain 兜底、子代理只分轮首/到线', async () => {
  assert.equal(sceneOfFlags({ turn: 6, autoTurn: 6, lineInlineTurn: 6 }), 'root-wake', '叫醒与到线同轮按叫醒')
  assert.equal(sceneOfFlags({ turn: 6, autoTurn: 6, spokeTurn: 6 }), 'plain', '用户本轮插过话：执行场景按 plain')
  assert.equal(sceneOfFlags({ turn: 6, autoTurn: 6, spokeTurn: 5 }), 'root-wake', '别的轮插话不影响本轮叫醒')
  assert.equal(sceneOfFlags({ turn: 6, autoTurn: 6, lineInlineTurn: 6, spokeTurn: 6 }), 'plain', '插话优先于叫醒+到线混合')
  assert.equal(sceneOfFlags({ turn: 3, lineInlineTurn: 3 }), 'root-line', '普通到线轮不受影响')
  assert.equal(sceneOfFlags({ turn: 7, autoTurn: 6, lineInlineTurn: 7 }), 'root-line')
  assert.equal(sceneOfFlags({ turn: 8, autoTurn: 6, lineInlineTurn: 7 }), 'plain')
  assert.equal(sceneOfFlags({ turn: null, autoTurn: null, lineInlineTurn: null }), 'plain', '没有轮号时不能把 null===null 判成到线')
  assert.equal(sceneOfFlags({ subagent: true, turn: 3, lineInlineTurn: 3 }), 'sub-line')
  assert.equal(sceneOfFlags({ subagent: true, turn: 4, lineInlineTurn: 3 }), 'sub-start')
  assert.equal(sceneContinues('root-wake'), false, '叫醒轮收手')
  for (const scene of ['root-line', 'sub-line', 'sub-start', 'plain']) {
    assert.equal(sceneContinues(scene), true, `${scene} 要继续任务`)
  }
})

await check('子代理：理由到 step2 才首次成立，也不能在 step2 内联', async () => {
  const session = blockSession(5, 150)
  session.requestContext = () => ({ contextWindow: 4000 })
  session.used = 200
  session.id = 'sub-3'
  session.header = { version: 4, id: 'sub-3', createdAt: 0, isSeeded: false, origin: 'subagent' }
  const ctx = usageCtx(session)
  ctx.agents = { requireInitiator: () => ({ id: 'sub-3' }) }
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.99, keepTurns: 1, budget: { ...DEFAULTS.budget, l1: 0.5 }, notice: { ...DEFAULTS.notice, growthTokens: 50 } })
  const agent = wakeAgent()
  agent.id = 'sub-3'
  agent.session = session
  await ctx.handlers.get('agent/pre-step')(STEP(5, 1, { agent }), () => {})
  session.used = 300
  session.seq += 1
  await ctx.handlers.get('agent/pre-step')(STEP(5, 2, { agent }), () => {})
  session.used = 400
  session.seq += 1
  await ctx.handlers.get('agent/pre-step')(STEP(5, 3, { agent }), () => {})
  assert.equal(onlyKind(session, NOTICE_KIND).length, 0, 'step>1 理由首次成立也不许内联')
  assert.equal(agent.followups.length, 0, '子代理不 followup')
})

await check('子代理工具闸门：step>1 且未到线时拒绝 compress', async () => {
  const session = usageSession(100)
  session.id = 'sub-gate'
  session.header = { version: 4, id: 'sub-gate', createdAt: 0, isSeeded: false, origin: 'subagent' }
  const ctx = usageCtx(session)
  ctx.agents = { requireInitiator: () => ({ id: 'sub-gate' }) }
  const registered = []
  ctx.tools = { register: (t) => (registered.push(t), () => {}), get: (name) => (name === 'session_event_read' || name === 'session_event_search' ? {} : undefined) }
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.99 })
  const agent = wakeAgent()
  agent.id = 'sub-gate'
  agent.session = session
  await ctx.handlers.get('agent/pre-step')(STEP(1, 1, { agent }), () => {})
  await ctx.handlers.get('agent/pre-step')(STEP(1, 2, { agent }), () => {})
  const tool = registered.find((t) => t.name === 'compress')
  const res = await tool.execute({}, { agent, callId: 'gate-call' })
  assert.match(String(res.text), /只允许在每轮第 1 步/)
  assert.doesNotMatch(String(res.text), /压缩须知/, '策略拒绝不带地图')
  assert.equal(onlyKind(session, NOTICE_KIND).length, 0, 'tool 拒绝不该写提醒')
})

await check('子代理工具闸门：到线 step>1 允许一次 override', async () => {
  const session = lineSession(3600)
  session.id = 'sub-gate-line'
  session.header = { version: 4, id: 'sub-gate-line', createdAt: 0, isSeeded: false, origin: 'subagent' }
  const ctx = usageCtx(session)
  ctx.agents = { requireInitiator: () => ({ id: 'sub-gate-line' }) }
  const registered = []
  ctx.tools = { register: (t) => (registered.push(t), () => {}), get: (name) => (name === 'session_event_read' || name === 'session_event_search' ? {} : undefined) }
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.75 })
  const agent = wakeAgent()
  agent.id = 'sub-gate-line'
  agent.session = session
  await ctx.handlers.get('agent/pre-step')(STEP(1, 1, { agent }), () => {})
  await ctx.handlers.get('agent/pre-step')(STEP(1, 2, { agent }), () => {})
  const tool = registered.find((t) => t.name === 'compress')
  const res = await tool.execute({}, { agent, callId: 'gate-line-call' })
  assert.doesNotMatch(String(res.text), /只允许在每轮第 1 步/, '到线应放行一次')
  const res2 = await tool.execute({}, { agent, callId: 'gate-line-call-2' })
  assert.match(String(res2.text), /已经用过豁免/, '同一 turn 第二次到线压缩必须拒绝')
})

await check('到线内联触发成功压缩：回执要求继续任务（不是收手）', async () => {
  const session = lineSession(3600)
  const ctx = usageCtx(session)
  const registered = []
  ctx.tools = { register: (t) => (registered.push(t), () => {}), get: (name) => (name === 'session_event_read' || name === 'session_event_search' ? {} : undefined) }
  apply(ctx, LINE_CONFIG)
  const agent = wakeAgent()
  const step = STEP(3, 1, { agent })
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  const mapTool = registered.find((t) => t.name === 'context_map')
  await mapTool.execute({}, { agent, callId: 'receipt-map-call' })
  const tool = registered.find((t) => t.name === 'compress')
  const res = await tool.execute({
    l1: { title: 'A', summary: '并块', to: '2' },
  }, { agent, callId: 'receipt-continue-call' })
  assert.match(String(res.text), /压缩完成；继续当前任务/, '到线内联的成功回执必须要求继续任务')
  assert.match(String(res.text), /本轮不要再压第二次/)
})

await check('子代理成功压缩：回执必须继续任务，不能收手', async () => {
  const session = lineSession(3600)
  session.id = 'sub-receipt'
  session.header = { version: 4, id: 'sub-receipt', createdAt: 0, isSeeded: false, origin: 'subagent' }
  const ctx = usageCtx(session)
  ctx.agents = { requireInitiator: () => ({ id: 'sub-receipt' }) }
  const registered = []
  ctx.tools = { register: (t) => (registered.push(t), () => {}), get: (name) => (name === 'session_event_read' || name === 'session_event_search' ? {} : undefined) }
  apply(ctx, LINE_CONFIG)
  const agent = wakeAgent()
  agent.id = 'sub-receipt'
  agent.session = session
  await ctx.handlers.get('agent/pre-step')(STEP(3, 1, { agent }), () => {})
  const mapTool = registered.find((t) => t.name === 'context_map')
  await mapTool.execute({}, { agent, callId: 'sub-receipt-map-call' })
  const tool = registered.find((t) => t.name === 'compress')
  const res = await tool.execute({
    l1: { title: 'A', summary: '并块', to: '2' },
  }, { agent, callId: 'sub-receipt-call' })
  assert.match(String(res.text), /压缩完成；继续当前任务/, '子代理成功回执必须要求继续任务')
  assert.match(String(res.text), /最后给结论/)
})

await check('闸门只拦子代理：根会话 step>1 压缩放行', async () => {
  const session = usageSession(100)
  const ctx = usageCtx(session)
  const registered = []
  ctx.tools = { register: (t) => (registered.push(t), () => {}), get: (name) => (name === 'session_event_read' || name === 'session_event_search' ? {} : undefined) }
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.99 })
  const agent = wakeAgent()
  await ctx.handlers.get('agent/pre-step')(STEP(1, 1, { agent }), () => {})
  await ctx.handlers.get('agent/pre-step')(STEP(1, 2, { agent }), () => {})
  const tool = registered.find((t) => t.name === 'compress')
  const res = await tool.execute({}, { agent, callId: 'root-step2-call' })
  assert.doesNotMatch(String(res.text), /只允许在每轮第 1 步/, 'root 不受子代理闸门')
})

await check('notice.enabled=false：子代理闸门也放行', async () => {
  const session = usageSession(100)
  session.id = 'sub-notice-off'
  session.header = { version: 4, id: 'sub-notice-off', createdAt: 0, isSeeded: false, origin: 'subagent' }
  const ctx = usageCtx(session)
  ctx.agents = { requireInitiator: () => ({ id: 'sub-notice-off' }) }
  const registered = []
  ctx.tools = { register: (t) => (registered.push(t), () => {}), get: (name) => (name === 'session_event_read' || name === 'session_event_search' ? {} : undefined) }
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.99, notice: { ...DEFAULTS.notice, enabled: false } })
  const agent = wakeAgent()
  agent.id = 'sub-notice-off'
  agent.session = session
  await ctx.handlers.get('agent/pre-step')(STEP(1, 1, { agent }), () => {})
  await ctx.handlers.get('agent/pre-step')(STEP(1, 2, { agent }), () => {})
  const tool = registered.find((t) => t.name === 'compress')
  const res = await tool.execute({}, { agent, callId: 'notice-off-call' })
  assert.doesNotMatch(String(res.text), /只允许在每轮第 1 步/, '关闭提醒时不拦压缩')
})

await check('子代理工具闸门：notifySubagents=false 时放行', async () => {
  const session = usageSession(100)
  session.id = 'sub-quiet'
  session.header = { version: 4, id: 'sub-quiet', createdAt: 0, isSeeded: false, origin: 'subagent' }
  const ctx = usageCtx(session)
  ctx.agents = { requireInitiator: () => ({ id: 'sub-quiet' }) }
  const registered = []
  ctx.tools = { register: (t) => (registered.push(t), () => {}), get: (name) => (name === 'session_event_read' || name === 'session_event_search' ? {} : undefined) }
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.99, notice: { ...DEFAULTS.notice, notifySubagents: false } })
  const agent = wakeAgent()
  agent.id = 'sub-quiet'
  agent.session = session
  await ctx.handlers.get('agent/pre-step')(STEP(1, 1, { agent }), () => {})
  await ctx.handlers.get('agent/pre-step')(STEP(1, 2, { agent }), () => {})
  const tool = registered.find((t) => t.name === 'compress')
  const res = await tool.execute({}, { agent, callId: 'gate-quiet-call' })
  assert.doesNotMatch(String(res.text), /只允许在每轮第 1 步/, 'quiet 子代理放行')
})

await check('到线内联不碰 inbox：已有旧提醒也照常写表层', async () => {
  const session = lineSession(3600)
  const ctx = usageCtx(session)
  apply(ctx, LINE_CONFIG)
  const agent = wakeAgent()
  const stale = { id: 'stale-1', role: 'user', createdAt: Date.now(), content: [{ type: 'text', text: '〔Ebbing Context 插件注入〕旧提醒' }], source: { kind: 'cordis-host-runner' } }
  agent.inbox.nextTurn.push(stale)
  const s3 = STEP(3, 1, { agent })
  await ctx.handlers.get('agent/pre-step')(s3, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: s3.signal }, () => {})
  assert.equal(agent.followups.length, 0, '到线不 followup')
  assert.equal(agent.replaced.length, 0, '到线不走 inbox replace')
  assert.equal(onlyKind(session, NOTICE_KIND).length, 1, '到线写表层')
})

await check('同一条到线提醒只发一次：第二次 turn-stopping 不再发', async () => {
  const session = lineSession(3600)
  const ctx = usageCtx(session)
  apply(ctx, LINE_CONFIG)
  const step = STEP(3)
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: step.signal, agent: step.agent }, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: step.signal, agent: step.agent }, () => {})
  assert.equal(onlyKind(session, NOTICE_KIND).length, 1)
})

await check('后面一步算出掉回线下：已经写出的内联提醒不撤回，也不补叫醒', async () => {
  const session = lineSession(3600)
  const ctx = usageCtx(session)
  apply(ctx, LINE_CONFIG)
  const signal = new AbortController().signal
  const agent = wakeAgent()
  await ctx.handlers.get('agent/pre-step')({ agent, turn: 3, step: 1, signal }, () => {})
  // 模型在这一轮里压掉了一层，占用掉回线下；seq 变化让读数缓存失效
  session.used = 200
  session.seq = 2
  await ctx.handlers.get('agent/pre-step')({ agent, turn: 3, step: 2, signal }, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal }, () => {})
  assert.equal(agent.followups.length, 0)
  assert.equal(onlyKind(session, NOTICE_KIND).length, 1, '内联提醒已经写出，不撤回')
})

await check('上一轮以异常收场（turn-stopping 没来）：内联提醒已落地，不补发第二条', async () => {
  const session = lineSession(3600)
  const ctx = usageCtx(session)
  apply(ctx, LINE_CONFIG)
  const agent = wakeAgent()
  await ctx.handlers.get('agent/pre-step')({ agent, turn: 3, step: 1, signal: new AbortController().signal }, () => {})
  assert.equal(onlyKind(session, NOTICE_KIND).length, 1)
  // 没有 turn-stopping，直接进下一轮第一步
  await ctx.handlers.get('agent/pre-step')({ agent, turn: 4, step: 1, signal: new AbortController().signal }, () => {})
  assert.equal(agent.followups.length, 0, '不因异常补发')
  assert.equal(onlyKind(session, NOTICE_KIND).length, 1, '同一越线不重复')
})

await check('foldPending 真跑一次：折叠成功、写了日志、不抛（ee1fb7e 的回归）', async () => {
  const session = fakeSession([10, 11], [callMessage([['compress', 'c1']]), resultMessage('c1')])
  const ctx = { sessions: { get: () => session } }
  const queues = new Map([['a1', new Map([['c1', { lines: ['l0 成功：标题（12 条 -> 省 800 token）'], tries: 0 }]])]])
  const logs = []
  const log = (event, data) => logs.push({ event, data })
  foldPending(ctx, { ...DEFAULTS, foldCallRecord: true }, queues, { agent: { id: 'a1' } }, log)
  assert.equal(session.appends.length, 1)
  assert.equal(session.appends[0].type, 'user/message')
  assert.equal(String(session.appends[0].data.content[0].text).startsWith(FOLD_NOTE_HEAD), true)
  assert.deepEqual(logs.map((l) => l.event), ['fold-call-record'])
  assert.equal(queues.get('a1').size, 0)
})

await check('foldPending 出错也不抛：记一条失败日志、留住这一次待折、并把失败摆进状态', async () => {
  const session = {
    get surface() {
      throw new Error('表层读不了')
    },
    deriveMessages() {
      return []
    },
    append() {
      throw new Error('不该写')
    },
  }
  const ctx = { sessions: { get: () => session } }
  const queues = new Map([['a1', new Map([['c1', { lines: ['x'], tries: 0 }]])]])
  const logs = []
  const log = (event) => logs.push(event)
  const queue = queues.get('a1')
  foldPending(ctx, { ...DEFAULTS, foldCallRecord: true }, queues, { agent: { id: 'a1' } }, log)
  assert.deepEqual(logs, ['fold-call-record-failed'])
  // 第一次失败不丢：下一次 pre-step 尾部可能还没被顶走，那时还能折。
  assert.equal(queue.size, 1)
  assert.match(queue.lastError.error, /表层读不了/)
  // 连着第二次失败才放弃，并且失败原因留在状态里给人看。
  foldPending(ctx, { ...DEFAULTS, foldCallRecord: true }, queues, { agent: { id: 'a1' } }, log)
  assert.equal(queue.size, 0)
  assert.match(queue.lastError.error, /表层读不了/)
  assert.equal(queue.failures, 2)
})

// 精确路径的假会话：log 按事件号放，deriveEventMessage 负责还原消息。
// 只有这种形态才走 locateCall（能认出"同一条消息里几个调用""这一对后面还有没有节点"）。
function foldSession(nodes, events) {
  const log = []
  for (const [k, v] of Object.entries(events)) log[Number(k)] = v
  const appends = []
  return {
    appends,
    log,
    get surface() {
      return { nodes: nodes.slice() }
    },
    deriveMessages() {
      return []
    },
    deriveEventMessage(ev) {
      return ev && ev.data ? ev.data.message : null
    },
    append(type, data, opts) {
      appends.push({ type, data, opts })
    },
  }
}

await check('foldPending：这一对已经进过请求（后面还有节点）→ 不折、丢掉陈旧项、记「跳过」不是「失败」', async () => {
  const session = foldSession([10, 11, 12], {
    10: { type: 'assistant/message', data: { message: callMessage([['compress', 'c1']]) } },
    11: { type: 'tool/result', data: { message: resultMessage('c1') } },
    12: { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '好' }] } } },
  })
  const ctx = { sessions: { get: () => session } }
  const queues = new Map([['a1', new Map([['c1', { lines: ['x'] }]])]])
  const queue = queues.get('a1')
  const logs = []
  foldPending(ctx, { ...DEFAULTS, foldCallRecord: true }, queues, { agent: { id: 'a1' } }, (e) => logs.push(e))
  assert.equal(session.appends.length, 0)
  assert.equal(queue.size, 0)
  assert.ok(!queue.lastError)
  assert.match(queue.lastSkip.error, /前缀缓存/)
  assert.deepEqual(logs, ['fold-call-record-skipped'])
})

await check('foldPending：开关关掉时不清陈旧的待折项会留成定时炸弹 → 直接清空、不写表层', async () => {
  const session = foldSession([10, 11], {
    10: { type: 'assistant/message', data: { message: callMessage([['compress', 'c1']]) } },
    11: { type: 'tool/result', data: { message: resultMessage('c1') } },
  })
  const ctx = { sessions: { get: () => session } }
  const queues = new Map([['a1', new Map([['c1', { lines: ['x'] }]])]])
  foldPending(ctx, { ...DEFAULTS, foldCallRecord: false }, queues, { agent: { id: 'a1' } }, () => {})
  assert.equal(session.appends.length, 0)
  assert.equal(queues.get('a1').size, 0)
})

await check('foldPending：并行调用 → 记跳过（不是失败），表层不动', async () => {
  const session = foldSession([10, 11], {
    10: {
      type: 'assistant/message',
      data: { message: callMessage([['compress', 'c1'], ['context_map', 'c2']]) },
    },
    11: { type: 'tool/result', data: { message: resultMessage('c1') } },
  })
  const ctx = { sessions: { get: () => session } }
  const queues = new Map([['a1', new Map([['c1', { lines: ['x'] }]])]])
  const queue = queues.get('a1')
  const logs = []
  foldPending(ctx, { ...DEFAULTS, foldCallRecord: true }, queues, { agent: { id: 'a1' } }, (e) => logs.push(e))
  assert.equal(session.appends.length, 0)
  assert.equal(queue.size, 0)
  assert.ok(!queue.lastError)
  assert.match(queue.lastSkip.error, /挤在同一条消息/)
  assert.deepEqual(logs, ['fold-call-record-skipped'])
})

// 设计裁定（用户要求 选 A）：剪枝只在 compress 里做，与宿主同构——
// 宿主把 toolResultPruner 当「压缩的前置步骤」（pressure 越线 / context-overflow 才叫），
// 不压缩就不该动表层。常开会在任意步削掉模型正要引用的内容，而剪掉的内容不一定取得回
// （没装会话搜索时工具是停用的，剪枝却不受那道闸门约束）。这条钉住"又有人把它挂回每步"。
function hugeToolResultSession(text) {
  const event = { type: 'tool/result', data: { message: { content: [{ type: 'text', text }] } } }
  // 真会话的 log 是稀疏数组（下标就是事件号），测试照这个形状来。
  const log = []
  log[1] = { type: 'user/message', data: {} }
  log[2] = event
  return { surface: { nodes: [1, 2] }, log }
}

await check('pre-step 不剪枝：超大工具返回原样留着，只有 compress 才剪', async () => {
  const session = hugeToolResultSession('x'.repeat(5000))
  const ctx = fakeCtx(session)
  ctx.tools = { register: () => () => {} }
  const pruneCalls = []
  const realGet = ctx.get
  ctx.get = (name) => {
    if (name === 'toolResultPruner') {
      return { config: { thresholdChars: 100 }, pruneSession: (s) => { pruneCalls.push(s); return { pruned: [], charsRemoved: 0 } } }
    }
    return realGet(name)
  }
  apply(ctx, {})
  const handler = ctx.handlers.get('agent/pre-step')
  await handler({ agent: { id: 'a1' }, turn: 3, step: 1 }, () => {})
  assert.equal(pruneCalls.length, 0, 'pre-step 一次都不该叫 pruner')
})

// 真机故障回归（2026-10-30，用户反馈）：模型已经答完，界面报
// 「本轮运行失败 next is not a function」。
// 原因：宿主用 `dispatch.serial(...)` 派发 agent/turn-stopping，监听器只收到荷载，
// 没有 next 参数；我们却写了 `return next()`，于是收尾阶段抛 TypeError，整轮以失败结束。
// 这条断言按真实派发方式只传一个参数调用，任何"又去调 next()"的改动都会立刻炸。
await check('turn-stopping 按 serial 派发只传一个参数：不抛异常，也不依赖 next', async () => {
  const session = fakeSession([10], [{ role: 'user', content: [{ type: 'text', text: '你好' }] }])
  const ctx = fakeCtx(session)
  ctx.tools = { register: () => () => {} }
  apply(ctx, {})
  const handler = ctx.handlers.get('agent/turn-stopping')
  assert.equal(typeof handler, 'function', 'turn-stopping 必须挂上')
  // 参数个数也要对：serial 监听器只收 payload。写成 (payload, next) 时 length 是 2，
  // 这里直接拦下——比等到真机收尾崩一次便宜得多。
  assert.equal(handler.length, 1, 'serial 监听器只能收 payload（写成 (payload, next) 会崩）')
  // 只传 payload —— 与宿主 dispatch.serial 的调用形状一致
  await handler({ agent: { id: 'a1' }, turn: 3, signal: { aborted: false } })
})

// —— 提醒别在"根本压不动"的时候把人叫醒（用户要求 第 1、2 条）——
//
// 一条提醒的实际代价是：叫醒模型开一整轮（请求 + 可能的失败调用 + 提醒正文永久进历史）。
// 所以只有当"这层真的压得动"时才值得开口；区只剩最后一块、或纯增长触发但一层都压不了时，
// 叫醒了也只能撞一次拒绝——这正是把用户逼去 /compact 的那条路。

function blockSession(count, chars) {
  const messages = []
  const nodes = []
  for (let i = 0; i < count; i += 1) {
    const head = `〔L1｜T${i * 2 + 1}–T${i * 2 + 2}｜ev ${10 + i}–${20 + i}〕第 ${i + 1} 块`
    messages.push({
      role: 'user',
      source: { kind: 'compact-checkpoint' },
      content: [{ type: 'text', text: head + '\n' + '摘'.repeat(Math.max(1, Math.ceil(chars))) }],
    })
    nodes.push(100 + i)
  }
  const session = fakeSession(nodes, messages)
  session.seq = 1
  session.requestContext = () => ({ contextWindow: 1000 })
  session.used = 300
  return session
}

await check('区超限但那一层只剩最后一块（压不动）：不发提醒', async () => {
  const session = blockSession(1, 300) // 300 token > 0.1 × 1000 的区上限，但只有 1 块 → 压不动
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  const step = STEP(3)
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: step.signal }, () => {})
  assert.equal(step.agent.followups.length, 0, '压不动的层不该叫醒模型')
})

await check('区超限且那一层压得动（≥2 块）：照常提醒', async () => {
  const session = blockSession(2, 300)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  const step = STEP(3)
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: step.signal }, () => {})
  assert.equal(step.agent.followups.length, 1)
  assert.match(String(step.agent.followups[0].content[0].text), /L1 区已超设计容量/)
})

await check('纯增长触发但一层都压不了：不发提醒', async () => {
  const session = usageSession(500)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.99, notice: { ...DEFAULTS.notice, growthTokens: 100 } })
  const first = STEP(1)
  await ctx.handlers.get('agent/pre-step')(first, () => {})
  // 第一步只把基线定下来；第二步用量涨过 growthTokens，但表层没有任何可压的东西。
  session.used = 700
  session.seq += 1
  const second = STEP(2, 1, { agent: first.agent })
  await ctx.handlers.get('agent/pre-step')(second, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 2, signal: second.signal }, () => {})
  assert.equal(second.agent.followups.length, 0, '没有可压的东西时，增长触发不该叫醒模型')
})

await check('到线提醒明确写了「允许不压」与「压完继续任务」', async () => {
  const session = lineSession(3600)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  const step = STEP(3)
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: step.signal }, () => {})
  const inline = onlyKind(session, NOTICE_KIND)
  assert.equal(inline.length, 1)
  const text = String(inline[0].data.content[0].text)
  assert.match(text, /压不压由你判断/, '必须明确允许本轮不采取压缩行动')
  assert.match(text, /压完继续当前任务/, '到线提醒要求压完继续任务')
  assert.match(text, /不要因为这次提醒结束本轮/, '不能要求结束本轮')
  assert.doesNotMatch(text, /压完只回一两句/, '不再要求只交回执')
})

// 多层的假会话：能按层造块，也能在测试中途再加一块（用来验证"压得动了"之后的行为变化）。
function layeredSession(layers, chars, used = 300) {
  const messages = []
  const nodes = []
  let seq = 100
  const push = (layer) => {
    const head = `〔${layer}｜T${nodes.length * 2 + 1}–T${nodes.length * 2 + 2}｜ev ${10 + nodes.length}–${20 + nodes.length}〕第 ${nodes.length + 1} 块`
    messages.push({
      role: 'user',
      source: { kind: 'compact-checkpoint' },
      content: [{ type: 'text', text: head + '\n' + '摘'.repeat(Math.max(1, Math.ceil(chars))) }],
    })
    nodes.push(seq++)
  }
  for (const layer of layers) push(layer)
  const session = fakeSession(nodes, messages)
  session.seq = 1
  session.requestContext = () => ({ contextWindow: 1000 })
  session.used = used
  session.pushBlock = push
  // 模拟"压缩成功"：表层少一块。用来验证同一轮里占用掉下来之后不再拿旧快照说话。
  session.dropBlock = () => {
    messages.pop()
    nodes.pop()
  }
  return session
}

await check('区超限的判据：更浅的层压不动时，这一层不报', async () => {
  const { zoneNoticeAllowed } = await import('../index.js')
  const over = { l1: true, l2: true, l3: true }
  assert.equal(zoneNoticeAllowed('l2', over, { l0: true, l1: false, l2: true, l3: true }, { l0: false }), false, 'L1 压不动 → L2 不报')
  assert.equal(zoneNoticeAllowed('l2', over, { l0: true, l1: true, l2: true, l3: true }, { l0: false }), true, '全都能压 → 报')
  assert.equal(zoneNoticeAllowed('l3', over, { l0: true, l1: true, l2: false, l3: true }, { l0: false }), false, 'L2 压不动 → L3 不报')
  // 环境原因不算拖累：轮次大纲坏了、l0 判不出可压区间，但 l1/l2 根本不需要轮号（设计约束）。
  assert.equal(zoneNoticeAllowed('l2', over, { l0: false, l1: true, l2: true, l3: true }, { l0: true }), true, 'l0 只是环境原因压不动 → L2 照报')
  assert.equal(zoneNoticeAllowed('l2', over, null, null), true, '拿不到可压状态时不拦')
})

// 缺轮是"定不了边界"的环境原因，不是"没内容可压"：它必须让 l0 记为环境受阻，
// 否则深层（l1/l2）超限的提醒会被一起拖黑，永远不发（隔离实验抓到的连坐）。
await check('缺轮归环境原因：l0 记为环境受阻，深层提醒照发', async () => {
  const { envBlockedOf, zoneNoticeAllowed } = await import('../index.js')
  const blocked = envBlockedOf({ outlineFault: null, turnStarts: [{ turn: 1, seq: 9 }], turnNotes: [{ turn: 3, reason: 'missing' }] })
  assert.equal(blocked.l0, true, '缺轮 → l0 环境受阻')
  assert.equal(zoneNoticeAllowed('l1', { l1: true, l2: true, l3: true }, { l0: false, l1: true, l2: true, l3: true }, blocked), true, 'l0 环境受阻 → L1 照报')
  // 反过来：内容原因（只剩被保住的轮）仍要拖住深层。
  const content = envBlockedOf({ outlineFault: null, turnStarts: [{ turn: 1, seq: 9 }], turnNotes: [] })
  assert.equal(content.l0, false)
  assert.equal(zoneNoticeAllowed('l1', { l1: true, l2: true, l3: true }, { l0: false, l1: true, l2: true, l3: true }, content), false, '内容原因压不动 → 拖住 L1')
})

await check('区超限：轮次大纲坏了、l0 判不出来，但 L2 压得动 → 照报（不把它一起拖黑）', async () => {
  const session = layeredSession(['L1', 'L1', 'L2', 'L2'], 300)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  const step = STEP(3)
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: step.signal }, () => {})
  assert.equal(step.agent.followups.length, 1, 'l0 的不可压是环境原因，不该连坐 l2')
})

await check('区超限：L2 满了但 L1 只剩一块（压不动）→ 不叫醒', async () => {
  const session = layeredSession(['L1', 'L2', 'L2'], 300)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  const step = STEP(3)
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: step.signal }, () => {})
  assert.equal(step.agent.followups.length, 0, '浅层有内容却压不动时，深层的超限提醒没有意义')
})

await check('区超限：浅层为空时深层也不报（这种表层本身不该出现，出现了就别叫醒）', async () => {
  // 块只能由下一层压出来，而每层最后一块永不压 → "L2 有块、L1 却是空的"根本不可能。
  // 真出现了说明表层被外部改过，这时任何提醒都只会换来一次拒绝（设计约束）。
  const session = layeredSession(['L2', 'L2'], 300)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  const step = STEP(3)
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: step.signal }, () => {})
  assert.equal(step.agent.followups.length, 0)
})

await check('增长触发没东西可压：门槛砍到一半、基线前移，压得动时按半个门槛再报', async () => {
  // 块要够大才过成本闸门（地板 139 token；260 字≈156 token）。
  // 窗口放大让区预算不干扰本用例。
  const session = layeredSession(['L1'], 260, 500)
  session.requestContext = () => ({ contextWindow: 100000 })
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.99, notice: { ...DEFAULTS.notice, growthTokens: 100 } })
  const t1 = STEP(1)
  await ctx.handlers.get('agent/pre-step')(t1, () => {})
  session.used = 700
  session.seq += 1
  const t2 = STEP(2, 1, { agent: t1.agent })
  await ctx.handlers.get('agent/pre-step')(t2, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 2, signal: t2.signal, agent: t1.agent }, () => {})
  t2.agent.inbox.nextTurn = []
  assert.equal(t1.agent.followups.length, 0, '一层都压不动：不叫醒')
  // 现在压得动了：再长 60（只有原门槛 100 的 60%，靠的是被砍半后的 50）
  session.pushBlock('L1')
  session.used = 760
  session.seq += 1
  const t3 = STEP(3, 1, { agent: t1.agent })
  await ctx.handlers.get('agent/pre-step')(t3, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: t3.signal, agent: t1.agent }, () => {})
  t3.agent.inbox.nextTurn = []
  assert.equal(t1.agent.followups.length, 1, '砍半之后，再长半个门槛就该报')
  // 模型这次仍然没压：下一轮收尾结算，门槛按原额的 40% 重设（默认值），基线前移到当前。
  session.used = 770
  session.seq += 1
  const t4 = STEP(4, 1, { agent: t1.agent })
  await ctx.handlers.get('agent/pre-step')(t4, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 4, signal: t4.signal, agent: t1.agent }, () => {})
  t4.agent.inbox.nextTurn = []
  // 只长 39（不到原额 100 的 40%）→ 不该再叫醒。
  session.used = 809
  session.seq += 1
  const t5 = STEP(5, 1, { agent: t1.agent })
  await ctx.handlers.get('agent/pre-step')(t5, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 5, signal: t5.signal, agent: t1.agent }, () => {})
  t5.agent.inbox.nextTurn = []
  assert.equal(t1.agent.followups.length, 1, '结算后门槛是原额的 40%：只长 39 不该再叫醒')
  // 再长 1（凑够 40）→ 重新触发。
  session.used = 810
  session.seq += 1
  const t6 = STEP(6, 1, { agent: t1.agent })
  await ctx.handlers.get('agent/pre-step')(t6, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 6, signal: t6.signal, agent: t1.agent }, () => {})
  t6.agent.inbox.nextTurn = []
  assert.equal(t1.agent.followups.length, 2, '不压之后按 40% 重设门槛：再长 40 就该重新报')
})

await check('增长到量一直压不动：每次只等半个门槛，跨轮继续（不会一次就饿死）', async () => {
  const session = layeredSession(['L1'], 260, 500)
  // 块要够大才过成本闸门（地板 139 token；260 字≈156 token）；窗口放大让区预算不干扰本用例。
  session.requestContext = () => ({ contextWindow: 100000 })
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.99, notice: { ...DEFAULTS.notice, growthTokens: 100 } })
  const t1 = STEP(1)
  await ctx.handlers.get('agent/pre-step')(t1, () => {})
  // 第一次到量：压不动 → 基线前移到 700、门槛砍到 50
  session.used = 700
  session.seq += 1
  const t2 = STEP(2, 1, { agent: t1.agent })
  await ctx.handlers.get('agent/pre-step')(t2, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 2, signal: t2.signal, agent: t1.agent }, () => {})
  t2.agent.inbox.nextTurn = []
  assert.equal(t1.agent.followups.length, 0, '压不动：不叫醒')
  // 再长 49：不到半个门槛，不判
  session.used = 749
  session.seq += 1
  const t3 = STEP(3, 1, { agent: t1.agent })
  await ctx.handlers.get('agent/pre-step')(t3, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: t3.signal, agent: t1.agent }, () => {})
  t3.agent.inbox.nextTurn = []
  // 再长 1（凑够半个门槛）：仍然压不动 → 继续前移、继续等
  session.used = 750
  session.seq += 1
  const t4 = STEP(4, 1, { agent: t1.agent })
  await ctx.handlers.get('agent/pre-step')(t4, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 4, signal: t4.signal, agent: t1.agent }, () => {})
  t4.agent.inbox.nextTurn = []
  assert.equal(t1.agent.followups.length, 0, '一直压不动就一直不叫醒，但门槛一直在等')
  // 现在压得动了：再长 50 → 按半个门槛报
  session.pushBlock('L1')
  session.used = 800
  session.seq += 1
  const t5 = STEP(5, 1, { agent: t1.agent })
  await ctx.handlers.get('agent/pre-step')(t5, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 5, signal: t5.signal, agent: t1.agent }, () => {})
  t5.agent.inbox.nextTurn = []
  assert.equal(t1.agent.followups.length, 1, '压得动了就在这一轮收尾投放增长提醒')
})

await check('本轮决定不压：growthResetPct = 100 时门槛回原额，重新攒满才再报', async () => {
  const session = layeredSession(['L1', 'L1'], 260, 500)
  // 块要够大才过成本闸门（地板 139 token；260 字≈156 token）；窗口放大让区预算不干扰本用例。
  session.requestContext = () => ({ contextWindow: 100000 })
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.99, notice: { ...DEFAULTS.notice, growthTokens: 100, growthResetPct: 100 } })
  const t1 = STEP(1)
  await ctx.handlers.get('agent/pre-step')(t1, () => {})
  session.used = 700
  session.seq += 1
  const t2 = STEP(2, 1, { agent: t1.agent })
  await ctx.handlers.get('agent/pre-step')(t2, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 2, signal: t2.signal, agent: t1.agent }, () => {})
  t2.agent.inbox.nextTurn = []
  assert.equal(t1.agent.followups.length, 1, '增长触发叫醒一次')
  // 模型被叫醒后没有压（表层没动），这一轮收尾按 100% 退回
  session.used = 750
  session.seq += 1
  const t3 = STEP(3, 1, { agent: t1.agent })
  await ctx.handlers.get('agent/pre-step')(t3, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: t3.signal, agent: t1.agent }, () => {})
  t3.agent.inbox.nextTurn = []
  // 只再长 50（不到原门槛 100）→ 不该再叫醒
  session.used = 800
  session.seq += 1
  const t4 = STEP(4, 1, { agent: t1.agent })
  await ctx.handlers.get('agent/pre-step')(t4, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 4, signal: t4.signal, agent: t1.agent }, () => {})
  t4.agent.inbox.nextTurn = []
  assert.equal(t1.agent.followups.length, 1, '退满 100% 之后，要重新攒满一个门槛才会再报')
})

await check('本轮决定不压：growthResetPct = 0 时门槛重设到 1 token，下一轮接着报', async () => {
  const session = layeredSession(['L1', 'L1'], 260, 500)
  // 块要够大才过成本闸门（地板 139 token；260 字≈156 token）；窗口放大让区预算不干扰本用例。
  session.requestContext = () => ({ contextWindow: 100000 })
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.99, notice: { ...DEFAULTS.notice, growthTokens: 100, growthResetPct: 0 } })
  const t1 = STEP(1)
  await ctx.handlers.get('agent/pre-step')(t1, () => {})
  session.used = 700
  session.seq += 1
  const t2 = STEP(2, 1, { agent: t1.agent })
  await ctx.handlers.get('agent/pre-step')(t2, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 2, signal: t2.signal, agent: t1.agent }, () => {})
  t2.agent.inbox.nextTurn = []
  session.used = 750
  session.seq += 1
  const t3 = STEP(3, 1, { agent: t1.agent })
  await ctx.handlers.get('agent/pre-step')(t3, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: t3.signal, agent: t1.agent }, () => {})
  t3.agent.inbox.nextTurn = []
  session.used = 800
  session.seq += 1
  const t4 = STEP(4, 1, { agent: t1.agent })
  await ctx.handlers.get('agent/pre-step')(t4, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 4, signal: t4.signal, agent: t1.agent }, () => {})
  t4.agent.inbox.nextTurn = []
  assert.equal(t1.agent.followups.length, 2, '一分不退：攒够原门槛就再报一次')
})

await check('区超限与增长同一轮都成立：合并成一条提醒，不打架', async () => {
  const session = layeredSession(['L1', 'L1'], 300, 500)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.99, notice: { ...DEFAULTS.notice, growthTokens: 100 } })
  const t1 = STEP(1)
  await ctx.handlers.get('agent/pre-step')(t1, () => {})
  session.used = 700
  session.seq += 1
  const t2 = STEP(2, 1, { agent: t1.agent })
  await ctx.handlers.get('agent/pre-step')(t2, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 2, signal: t2.signal, agent: t1.agent }, () => {})
  t2.agent.inbox.nextTurn = []
  assert.equal(t1.agent.followups.length, 1, '两条理由合成一条提醒')
  const text = String(t1.agent.followups[0].content[0].text)
  assert.match(text, /L1 区已超设计容量/, '区超限要写在同一条里')
  assert.match(text, /又长了/, '增长也要写在同一条里')
  assert.match(text, /允许什么都不压/, '每条提醒都要写明可以不压')
})

// —— 增长状态落盘：重启不清零（审查 0883a196 Major 1/3）——
// 这三条必须真跑 pre-step，并且给假会话安上 id、把 DSH_HOME 指到临时目录：
// 只测 hydrateGrowth/persistGrowth 两个函数钉不住"接线漏了"——审查实测删掉
// remindIfNeeded 里的 hydrate 调用，旧的 state 17 项 + prestep 59 项仍然全绿。

const scratchHome = () => mkdtempSync(join(tmpdir(), 'ebbing-prestep-state-'))
const withScratchHome = async (fn) => {
  const scratch = scratchHome()
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = scratch
  try {
    await fn()
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    rmSync(scratch, { recursive: true, force: true })
  }
}

await check('重启后增长累计接着算：基线从盘上回灌，不按当前用量重设', async () => {
  await withScratchHome(async () => {
    const session = layeredSession(['L1', 'L1'], 260, 300)
    session.id = 'session-restart-growth'
    session.requestContext = () => ({ contextWindow: 100000 })
    const config = { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.99, notice: { ...DEFAULTS.notice, growthTokens: 100 } }
    // 第一次运行：只把基线定下来（300），不提醒
    const ctx1 = usageCtx(session)
    apply(ctx1, config)
    await ctx1.handlers.get('agent/pre-step')(STEP(1), () => {})
    assert.equal(readGrowth('session-restart-growth') && readGrowth('session-restart-growth').tokens, 300, '首次 pre-step 应把基线落盘')
    // 长过门槛：300 → 450（+150 ≥ 100）
    session.used = 450
    session.seq += 1
    // 模拟重启：新的 ctx + 新的 apply（内存状态全丢，只能靠盘上那份文件）
    const ctx2 = usageCtx(session)
    apply(ctx2, config)
    const t2 = STEP(2)
    await ctx2.handlers.get('agent/pre-step')(t2, () => {})
    await ctx2.handlers.get('agent/turn-stopping')({ turn: 2, signal: t2.signal }, () => {})
    assert.equal(t2.agent.followups.length, 1, '重启后按旧基线判增长，应该叫醒')
    assert.match(String(t2.agent.followups[0].content[0].text), /又长了/, '理由应该是增长那条')
  })
})

await check('掉回线下要落盘灯灭：重启后再越线仍报一次（不吞提醒）', async () => {
  await withScratchHome(async () => {
    const session = lineSession(3600)
    session.id = 'session-restart-line'
    // 关掉增长这条线，只看"到线灯"的落盘
    const config = { ...DEFAULTS, reservedTokens: 0, notice: { ...DEFAULTS.notice, growthTokens: 0 } }
    const ctx1 = usageCtx(session)
    apply(ctx1, config)
    const t1 = STEP(1)
    await ctx1.handlers.get('agent/pre-step')(t1, () => {})
    await ctx1.handlers.get('agent/turn-stopping')({ turn: 1, signal: t1.signal }, () => {})
    assert.equal(onlyKind(session, NOTICE_KIND).length, 1, '越线先报一次内联')
    assert.equal(readGrowth('session-restart-line') && readGrowth('session-restart-line').lineOn, true, '灯亮着要落盘')
    // 掉回线下：灯灭必须落盘（旧代码只改内存，盘上仍是 true）
    session.used = 400
    session.seq += 1
    const t2 = STEP(2, 1, { agent: t1.agent })
    await ctx1.handlers.get('agent/pre-step')(t2, () => {})
    assert.equal(readGrowth('session-restart-line') && readGrowth('session-restart-line').lineOn, false, '掉回线下后盘上必须是灭的')
    // 模拟重启，再次越线：必须重新报
    session.used = 3600
    session.seq += 1
    const ctx2 = usageCtx(session)
    apply(ctx2, config)
    const t3 = STEP(3)
    await ctx2.handlers.get('agent/pre-step')(t3, () => {})
    await ctx2.handlers.get('agent/turn-stopping')({ turn: 3, signal: t3.signal }, () => {})
    assert.equal(onlyKind(session, NOTICE_KIND).length, 2, '重启后再次越线必须重新报（灯不能还是亮着）')
  })
})

await check('重启后叫醒轮场景不退化：autoTurn/spokeTurn 从盘上回灌', async () => {
  await withScratchHome(async () => {
    const session = blockSession(5, 150)
    session.id = 'session-restart-scene'
    session.requestContext = () => ({ contextWindow: 4000 })
    session.used = 200
    const config = { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.75, keepTurns: 1, notice: { ...DEFAULTS.notice, growthTokens: 50 } }
    const ctx1 = usageCtx(session)
    apply(ctx1, config)
    const t1 = STEP(1, 1)
    await ctx1.handlers.get('agent/pre-step')(t1, () => {})
    session.used = 300
    session.seq += 1
    const t2 = STEP(1, 2, { agent: t1.agent })
    await ctx1.handlers.get('agent/pre-step')(t2, () => {})
    await ctx1.handlers.get('agent/turn-stopping')({ turn: 1, signal: t2.signal }, () => {})
    assert.equal(t1.agent.followups.length, 1, '先叫醒一次')
    // 第 2 轮第 1 步认领提醒：autoTurn=2 落盘
    session.seq += 1
    await ctx1.handlers.get('agent/pre-step')(claimWake(2, t1.agent), () => {})
    assert.match(ctx1.commands[0].handler({ agent: t1.agent }).text, /轮末叫醒的压缩专用轮/, '重启前是 wake')
    assert.equal(readGrowth('session-restart-scene') && readGrowth('session-restart-scene').autoTurn, 2, 'autoTurn 要落盘')
    // 模拟重启：第 2 轮第 2 步，内存状态全丢，只能靠盘
    const ctx2 = usageCtx(session)
    apply(ctx2, config)
    session.seq += 1
    await ctx2.handlers.get('agent/pre-step')(STEP(2, 2, { agent: t1.agent }), () => {})
    assert.match(ctx2.commands[0].handler({ agent: t1.agent }).text, /轮末叫醒的压缩专用轮/, '重启后同一轮仍是 wake')
    // 用户在这一轮插话：spokeTurn=2 落盘；再重启，执行场景仍是 plain
    session.seq += 1
    await ctx2.handlers.get('agent/pre-step')(STEP(2, 3, {
      agent: t1.agent,
      messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '先办这个' }] }],
    }), () => {})
    assert.match(ctx2.commands[0].handler({ agent: t1.agent }).text, /压完继续当前任务/, '插话后是 plain')
    assert.equal(readGrowth('session-restart-scene') && readGrowth('session-restart-scene').spokeTurn, 2, 'spokeTurn 要落盘')
    const ctx3 = usageCtx(session)
    apply(ctx3, config)
    session.seq += 1
    await ctx3.handlers.get('agent/pre-step')(STEP(2, 4, { agent: t1.agent }), () => {})
    assert.match(ctx3.commands[0].handler({ agent: t1.agent }).text, /压完继续当前任务/, '重启后用户已插话的轮仍是 plain')
  })
})

await check('重启发生在认领前：下一轮认领提醒仍按 wake', async () => {
  await withScratchHome(async () => {
    const session = blockSession(5, 150)
    session.id = 'session-restart-before-claim'
    session.requestContext = () => ({ contextWindow: 4000 })
    session.used = 200
    const config = { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.75, keepTurns: 1, notice: { ...DEFAULTS.notice, growthTokens: 50 } }
    const ctx1 = usageCtx(session)
    apply(ctx1, config)
    const t1 = STEP(1, 1)
    await ctx1.handlers.get('agent/pre-step')(t1, () => {})
    session.used = 300
    session.seq += 1
    const t2 = STEP(1, 2, { agent: t1.agent })
    await ctx1.handlers.get('agent/pre-step')(t2, () => {})
    await ctx1.handlers.get('agent/turn-stopping')({ turn: 1, signal: t2.signal }, () => {})
    assert.equal(t1.agent.followups.length, 1, '先叫醒一次')
    // 进程在认领前重启：新 ctx 没有内存状态，认领那一步必须先把状态建出来/回灌。
    const ctx2 = usageCtx(session)
    apply(ctx2, config)
    session.seq += 1
    await ctx2.handlers.get('agent/pre-step')(claimWake(2, t1.agent), () => {})
    assert.match(ctx2.commands[0].handler({ agent: t1.agent }).text, /轮末叫醒的压缩专用轮/, '认领时仍按 wake')
  })
})

await check('重启后到线轮场景不退化：lineInlineTurn 从盘上回灌', async () => {
  await withScratchHome(async () => {
    const session = lineSession(3600)
    session.id = 'session-restart-line-scene'
    session.requestContext = () => ({ contextWindow: 4000 })
    const ctx1 = usageCtx(session)
    apply(ctx1, LINE_CONFIG)
    const t1 = STEP(1, 1)
    await ctx1.handlers.get('agent/pre-step')(t1, () => {})
    assert.match(ctx1.commands[0].handler({ agent: t1.agent }).text, /轮内到线提醒/, '重启前是 root-line')
    assert.equal(readGrowth('session-restart-line-scene') && readGrowth('session-restart-line-scene').lineInlineTurn, 1, 'lineInlineTurn 要落盘')
    const ctx2 = usageCtx(session)
    apply(ctx2, LINE_CONFIG)
    session.seq += 1
    await ctx2.handlers.get('agent/pre-step')(STEP(1, 2, { agent: t1.agent }), () => {})
    assert.match(ctx2.commands[0].handler({ agent: t1.agent }).text, /轮内到线提醒/, '重启后同一轮仍是 root-line')
  })
})

await check('旁路先建了状态（那一步拿不到用量）：下一次仍从盘上回灌，不冲掉旧基线', async () => {
  await withScratchHome(async () => {
    // 盘上已有基线 100；第一步拿不到用量，状态会被轮次标记旁路先建出来
    const { writeGrowth } = await import('../lib/state.js')
    writeGrowth('session-side-path', { tokens: 100, growthQuota: null, lineOn: false })
    const session = layeredSession(['L1', 'L1'], 260, 300)
    session.id = 'session-side-path'
    session.requestContext = () => ({ contextWindow: 100000 })
    const config = { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.99, notice: { ...DEFAULTS.notice, growthTokens: 50 } }
    const ctx = fakeCtx(session)
    ctx.tools = { register: () => () => {}, get: (name) => (name === 'session_event_read' || name === 'session_event_search' ? {} : undefined) }
    apply(ctx, config)
    await ctx.handlers.get('agent/pre-step')(STEP(1), () => {}) // 没有 tokenMeter → readUsage 拿不到读数
    // 用量恢复，且相对盘上基线长了 200（≥ 50）。bump seq 让使用量缓存失效（null 也被缓存过）。
    session.seq += 1
    ctx.tokenMeter = { measure: () => ({ totalTokens: session.used }) }
    const t2 = STEP(2)
    await ctx.handlers.get('agent/pre-step')(t2, () => {})
    await ctx.handlers.get('agent/turn-stopping')({ turn: 2, signal: t2.signal }, () => {})
    assert.equal(t2.agent.followups.length, 1, '盘上的基线 100 必须还在，增长才成立')
  })
})

await check('状态已存在但当时拿不到会话：下一步仍从盘上回灌（existing-state 分支）', async () => {
  await withScratchHome(async () => {
    const { writeGrowth } = await import('../lib/state.js')
    writeGrowth('session-late-session', { tokens: 100, growthQuota: null, lineOn: false })
    const session = layeredSession(['L1', 'L1'], 260, 300)
    session.id = 'session-late-session'
    session.requestContext = () => ({ contextWindow: 100000 })
    const config = { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.99, notice: { ...DEFAULTS.notice, growthTokens: 50 } }
    const ctx = usageCtx(session)
    const realGet = ctx.sessions.get
    // 第一步：会话服务暂时拿不到 → 状态由轮次标记旁路建出来（hydrate 失败，tokens 仍为 null）
    ctx.sessions.get = () => null
    apply(ctx, config)
    await ctx.handlers.get('agent/pre-step')(STEP(1), () => {})
    // 会话恢复：已有的空状态必须补 hydrate 拿回基线 100（旧实现只在新状态分支 hydrate）
    ctx.sessions.get = realGet
    const t2 = STEP(2)
    await ctx.handlers.get('agent/pre-step')(t2, () => {})
    await ctx.handlers.get('agent/turn-stopping')({ turn: 2, signal: t2.signal }, () => {})
    assert.equal(t2.agent.followups.length, 1, 'existing-state 分支必须回灌基线 100，增长才成立')
  })
})

await check('基线比当前用量高（宿主 /compact 后重启）：按当前量重设后可再次叫醒', async () => {
  await withScratchHome(async () => {
    const { writeGrowth } = await import('../lib/state.js')
    const session = layeredSession(['L1', 'L1'], 260, 1000)
    session.id = 'session-shrink-guard'
    session.requestContext = () => ({ contextWindow: 100000 })
    writeGrowth('session-shrink-guard', { tokens: 1000, growthQuota: 50, lineOn: false })
    const config = { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.99, notice: { ...DEFAULTS.notice, growthTokens: 100 } }
    const ctx = usageCtx(session)
    apply(ctx, config)
    await ctx.handlers.get('agent/pre-step')(STEP(1), () => {})
    // 压缩/剪枝把用量打回 500：基线要跟着改小，否则 grew 长期为负
    session.used = 500
    session.seq += 1
    await ctx.handlers.get('agent/pre-step')(STEP(2), () => {})
    assert.equal(readGrowth('session-shrink-guard') && readGrowth('session-shrink-guard').tokens, 500, '基线要按当前用量重设并落盘')
    assert.equal(readGrowth('session-shrink-guard') && readGrowth('session-shrink-guard').growthQuota, null, '缩水等于没看见的压缩，半额门槛也清掉')
    // 再长 100：应该按原门槛叫醒（没有 guard 时 grew = 600-1000 = -400，永远不响）
    session.used = 600
    session.seq += 1
    const t3 = STEP(3)
    await ctx.handlers.get('agent/pre-step')(t3, () => {})
    await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: t3.signal }, () => {})
    assert.equal(t3.agent.followups.length, 1, '基线缩水后必须能重新触发增长')
  })
})

await check('用量瞬时归零不把基线压成 0（防下一步凭空报增长）', async () => {
  await withScratchHome(async () => {
    const session = layeredSession(['L1', 'L1'], 260, 300)
    session.id = 'session-zero-guard'
    session.requestContext = () => ({ contextWindow: 100000 })
    const config = { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.99, notice: { ...DEFAULTS.notice, growthTokens: 100 } }
    const ctx = usageCtx(session)
    apply(ctx, config)
    await ctx.handlers.get('agent/pre-step')(STEP(1), () => {})
    assert.equal(readGrowth('session-zero-guard') && readGrowth('session-zero-guard').tokens, 300, '首次基线落盘')
    // 读数瞬时归零：shrink guard 的 `usage.used > 0` 必须挡住，不把基线写成 0
    session.used = 0
    session.seq += 1
    await ctx.handlers.get('agent/pre-step')(STEP(2), () => {})
    assert.equal(readGrowth('session-zero-guard') && readGrowth('session-zero-guard').tokens, 300, '基线不能被瞬时 0 顶掉')
  })
})


await check('轮次大纲缺一轮：不再打红（夹住上界即可，fork/迁移的会话照常可用）', async () => {
  // 回归修复 + 设计约束：缺一轮的边界确实不可知，但那是宿主恢复留下的正常痕迹。
  // 现在的做法是把可压上界夹到缺轮之前，而不是让整条对话永久停摆。
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'a' }] },
    { role: 'user', content: [{ type: 'text', text: 'b' }] },
    { role: 'user', content: [{ type: 'text', text: 'c' }] },
  ]
  const nodes = [12, 32, 52]
  const session = fakeSession(nodes, messages)
  session.log = []
  session.log[10] = { type: 'turn/start', data: { turn: 1 } }
  session.log[30] = { type: 'turn/start', data: { turn: 2 } }
  session.log[50] = { type: 'turn/start', data: { turn: 4 } }
  session.seq = 1
  session.requestContext = () => ({ contextWindow: 1000 })
  session.used = 100
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  const step = STEP(4)
  let thrown = null
  try {
    await ctx.handlers.get('agent/pre-step')(step, () => {})
  } catch (error) {
    thrown = error
  }
  assert.equal(thrown, null, '缺轮不该把整条对话打红')
})

await check('轮次大纲两个来源都不可信：pre-step 打红（抛错给宿主，不吞、不发请求）', async () => {
  // 轮号在时间上倒退（先 T5 后 T3）：这不是"少了一轮"，是自相矛盾，算不出边界。
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'a' }] },
    { role: 'user', content: [{ type: 'text', text: 'b' }] },
    { role: 'user', content: [{ type: 'text', text: 'c' }] },
  ]
  const nodes = [12, 32, 52]
  const session = fakeSession(nodes, messages)
  session.log = []
  session.log[10] = { type: 'turn/start', data: { turn: 5 } }
  session.log[30] = { type: 'turn/start', data: { turn: 3 } }
  session.seq = 1
  session.requestContext = () => ({ contextWindow: 1000 })
  session.used = 100
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  const step = STEP(4)
  let thrown = null
  try {
    await ctx.handlers.get('agent/pre-step')(step, () => {})
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, '必须抛出去，让宿主把它显示成红色错误')
  assert.match(String(thrown.message), /轮次大纲/, '要明说是大纲坏了')
  assert.match(String(thrown.message), /已停用这次对话/, '要说清本对话已停用')
})


// —— 回归用例（判定修复 / 快照失效 / 锁存 / 复位 / 标记去重）──────────────

// 带真实 log 的会话：readZones 在没有 turnOutline 投影时会去 log 里找 turn/start，
// 这正是"宿主每轮第 1 步还没把用户消息写进表层"的那个时序。
function loggedSession(nodes, messages, entries) {
  const session = fakeSession(nodes, messages)
  session.seq = 1
  session.requestContext = () => ({ contextWindow: 1000 })
  session.used = 120
  session.log = []
  for (const [seq, event] of entries) session.log[seq] = event
  session.deriveEventMessage = (event) => (event && event.data) || null
  return session
}

await check('F1 回归：本轮在表层上还没有节点时，pre-step 不许抛错（那是宿主的正常时序）', async () => {
  const msg = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] }
  const session = loggedSession([1], [msg], [
    [1, { type: 'user/message', data: msg }],
    [2, { type: 'turn/start', data: { turn: 1 } }],
    [9, { type: 'turn/start', data: { turn: 2 } }],
  ])
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS })
  let nextCalled = false
  // 不 expect 抛错：抛出来这条测试就失败（宿主会吞掉它、整轮不发请求）。
  await ctx.handlers.get('agent/pre-step')(STEP(2), () => {
    nextCalled = true
  })
  assert.equal(nextCalled, true, 'pre-step 必须走到 next()')
})

await check('未闭合压缩事务：pre-step 直接抛红，且一个节点都不写', async () => {
  const msg = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] }
  const session = loggedSession([1], [msg], [
    [1, { type: 'user/message', data: msg }],
    [2, { type: 'turn/start', data: { turn: 1 } }],
    [3, { type: 'compaction/start', data: { compactionId: 'c-open', turn: 1 } }],
  ])
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS })
  const before = session.appends.length
  let thrown = null
  try {
    await ctx.handlers.get('agent/pre-step')(STEP(2), () => {})
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, '必须抛出去，让宿主把它显示成红色错误')
  assert.match(String(thrown.message), /没有结束的压缩事务/, '要说清是未闭合的压缩事务')
  assert.match(String(thrown.message), /不要在这条会话里继续发消息/, '要给出停手提示')
  assert.equal(session.appends.length, before, '这一轮一个节点都不许写（写下去只会更难修）')
})

await check('未闭合事务但宿主已认领（后面有 session/end-seed）：不报红，照常走', async () => {
  const msg = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] }
  const session = loggedSession([1], [msg], [
    [1, { type: 'user/message', data: msg }],
    [2, { type: 'turn/start', data: { turn: 1 } }],
    [3, { type: 'compaction/start', data: { compactionId: 'c-open', turn: 1 } }],
    [4, { type: 'session/end-seed', data: { inherited: true } }],
  ])
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS })
  let nextCalled = false
  // 宿主自己把这种孤儿认领了（orphanCompactions），我们不该再把它报成故障。
  await ctx.handlers.get('agent/pre-step')(STEP(2), () => {
    nextCalled = true
  })
  assert.equal(nextCalled, true, '认领过的孤儿不该拦住这一轮')
})
await check('S2 回归：同一轮里占用明显掉下来（压缩成功）后，不再拿旧快照报区超限', async () => {
  const session = layeredSession(['L1', 'L1'], 300, 900)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.75 })
  const t3 = STEP(3, 1)
  await ctx.handlers.get('agent/pre-step')(t3, () => {})
  // 模拟模型在这一步成功压缩：少一块、占用掉到一半以下。
  session.dropBlock()
  session.used = 400
  session.seq += 1
  const t3b = STEP(3, 2)
  await ctx.handlers.get('agent/pre-step')(t3b, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: t3b.signal })
  assert.equal(t3b.agent.followups.length, 0, '压完了就不该再发"还超着"的提醒（否则与同一张地图自相矛盾）')
})

await check('S3 回归：到线但区还压不动时也发同一条轮内提醒，不锁存区提醒', async () => {
  const session = layeredSession(['L1'], 400, 900)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.75 })
  const t3 = STEP(3, 1)
  await ctx.handlers.get('agent/pre-step')(t3, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: t3.signal })
  // 2026-11-14：到线不再区分压不压得动，统一发轮内提醒。
  assert.equal(t3.agent.followups.length, 0, '到线不叫醒模型开新轮')
  const inline = onlyKind(session, NOTICE_KIND)
  assert.equal(inline.length, 1, '到线提醒要写进表层')
  assert.match(String(inline[0].data.content[0].text), /现在可以压/)
  assert.doesNotMatch(String(inline[0].data.content[0].text), /紧急提示/)
  // 下一轮补到两块、仍然超限：这块区第一次真正可压，必须能报出来。
  session.pushBlock('L1')
  session.used = 920
  session.seq += 1
  const t4 = STEP(4, 1)
  await ctx.handlers.get('agent/pre-step')(t4, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 4, signal: t4.signal })
  assert.equal(t4.agent.followups.length, 1, '区变得可压后要能报出来（没报过的区不能被提前锁存）')
  assert.match(String(t4.agent.followups[0].content[0].text), /区已超设计容量/)
})

await check('S3b 回归：line 已投递时，不许把当时压不动的区提前锁存', async () => {
  // 构造：L1 两块都超区上限，但"可压那段"只有第一块（小）→ 成本不够地板，l1 不可压；
  // l0 的 T1 可压，所以到线只发 line。下一轮把第一块写大（表层顺序不变）→ l1 可压，
  // zone-l1 必须能报出来（commit 只按 reasons 锁存，不能把当时不可压的区一起写成已报）。
  const t1 = { role: 'user', content: [{ type: 'text', text: 'T1 ' + '甲'.repeat(500) }] }
  const t2 = { role: 'user', content: [{ type: 'text', text: 'T2' }] }
  const t3 = { role: 'user', content: [{ type: 'text', text: 'T3' }] }
  const head1 = '〔L1｜T1–T2｜ev 10–20〕第 1 块\n'
  const b1 = { role: 'user', source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: head1 + '乙'.repeat(10) }] }
  const b2 = { role: 'user', source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: '〔L1｜T1–T2｜ev 21–30〕第 2 块\n' + '丙'.repeat(300) }] }
  const nodes = [2, 3, 4, 6, 8]
  const messages = [b1, b2, t1, t2, t3]
  const session = loggedSession(nodes, messages, [
    [1, { type: 'turn/start', data: { turn: 1 } }],
    [2, { type: 'user/message', data: b1 }],
    [3, { type: 'user/message', data: b2 }],
    [4, { type: 'user/message', data: t1 }],
    [5, { type: 'turn/start', data: { turn: 2 } }],
    [6, { type: 'user/message', data: t2 }],
    [7, { type: 'turn/start', data: { turn: 3 } }],
    [8, { type: 'user/message', data: t3 }],
    [9, { type: 'turn/start', data: { turn: 4 } }],
  ])
  session.used = 900
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.75 })
  const t4 = STEP(4, 1)
  await ctx.handlers.get('agent/pre-step')(t4, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 4, signal: t4.signal })
  const lineNotices = onlyKind(session, NOTICE_KIND)
  assert.equal(lineNotices.length, 1, 'l0 可压，到线要发内联提醒')
  assert.equal(t4.agent.followups.length, 0, '到线不 followup')
  assert.doesNotMatch(String(lineNotices[0].data.content[0].text), /区已超设计容量/, 'l1 还压不动，这一轮不该报区超限')
  // 下一轮：把第一块写大（不改表层顺序），并让"用户开口"解除叫醒闸门；l1 变可压。
  b1.content[0].text = head1 + '乙'.repeat(300)
  session.log[10] = { type: 'turn/start', data: { turn: 5 } }
  session.used = 920
  session.seq += 1
  const t5 = STEP(5, 1, { agent: t4.agent, messages: [{ role: 'user', source: { kind: 'user' }, content: [] }] })
  await ctx.handlers.get('agent/pre-step')(t5, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 5, signal: t5.signal })
  assert.equal(t4.agent.followups.length, 1, 'L1 变得可压后要报 zone-l1')
  assert.match(String(t4.agent.followups[0].content[0].text), /L1 区已超设计容量/)
})

await check('G3 回归：掉到线下时到线指示灯复位，再越线要重新报', async () => {
  const session = lineSession(3600)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, triggerPct: 0.75 })
  const t3 = STEP(3, 1)
  await ctx.handlers.get('agent/pre-step')(t3, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: t3.signal })
  assert.equal(onlyKind(session, NOTICE_KIND).length, 1, '第一次越线要报')
  // 第 4 轮占用掉到线下：灯要复位。
  session.used = 400
  session.seq += 1
  const t4 = STEP(4, 1)
  await ctx.handlers.get('agent/pre-step')(t4, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 4, signal: t4.signal })
  // 第 5 轮又涨回线上：这是一次新的"越线"，必须能再报。
  session.used = 3600
  session.seq += 1
  const t5 = STEP(5, 1)
  await ctx.handlers.get('agent/pre-step')(t5, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 5, signal: t5.signal })
  assert.equal(onlyKind(session, NOTICE_KIND).length, 2, '掉下去又越上来，要当成一次新的越线')
})

await check('标记重载去重：上一轮收尾写好的「下一轮 T3」还在表层上，本轮不再补一条', async () => {
  const userMsg = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '第 2 轮的话' }] }
  const marker = {
    role: 'user',
    source: { kind: MARKER_KIND },
    content: [{ type: 'text', text: '〔轮次标记〕下一轮 T3' }],
  }
  const session = loggedSession([1, 2], [userMsg, marker], [
    [1, { type: 'user/message', data: userMsg }],
    [2, { type: 'user/message', data: marker }],
    [3, { type: 'turn/start', data: { turn: 2 } }],
    [4, { type: 'turn/start', data: { turn: 3 } }],
  ])
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS })
  await ctx.handlers.get('agent/pre-step')(STEP(3, 1), () => {})
  assert.equal(onlyKind(session, MARKER_KIND).length, 0, '已经有「下一轮 T3」了，不许再写一条重复的')
})


// —— 用户要求：配置硬错误 + 每步只扫一次表层 ────────────────────

await check('keepTurns 配成 0：配置层兜底取 1，pre-step 不再报红停轮', async () => {
  const session = lineSession(3600)
  const ctx = usageCtx(session)
  // 用户 2026-11-05 定：面板拦正常输入，插件侧兜底取 1——不再每轮抛红把对话打死。
  apply(ctx, { ...DEFAULTS, keepTurns: 0 })
  let threw = null
  try {
    await ctx.handlers.get('agent/pre-step')(STEP(3), () => {})
  } catch (error) {
    threw = error
  }
  assert.equal(threw, null, 'keepTurns 0 由配置层取 1，不该再抛给宿主')
})

await check('每步只扫一遍表层（三个用途共用同一份，不再各扫一遍）', async () => {
  const session = lineSession(3600)
  const ctx = usageCtx(session)
  let scans = 0
  const inner = ctx.get
  ctx.get = (name) => {
    if (name === 'sessionProjections') scans += 1
    return inner(name)
  }
  apply(ctx, { ...DEFAULTS })
  await ctx.handlers.get('agent/pre-step')(STEP(3, 1), () => {})
  const firstStep = scans
  await ctx.handlers.get('agent/pre-step')(STEP(3, 2), () => {})
  const bothSteps = scans
  assert.ok(firstStep >= 1, '至少要扫一次（不然什么都不知道）')
  assert.ok(firstStep <= 1, '一步最多扫一次，实际 ' + firstStep + ' 次')
  assert.ok(bothSteps - firstStep <= 1, '第二步也最多一次，实际多了 ' + (bothSteps - firstStep) + ' 次')
})

// 超窗口（设计约束）：宿主自带压缩默认开着，它会在同一条 request-error 上
// 自己救一次并 retry。第一次就宣布"没救"是假话，所以第一次只给中性提示、不动自动续作；
// 连着第二次还超，才认死并缴械。
await check('超窗口：第一次只给中性提示、不动自动续作；连着第二次才缴械', async () => {
  const session = usageSession(100)
  const ctx = usageCtx(session)
  let disarmed = 0
  const inner = ctx.get
  ctx.get = (name) => (name === 'goals' ? { disarm: () => { disarmed += 1 } } : inner(name))
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  const handler = ctx.handlers.get('agent/request-error')
  const agent = { id: 'a1' }
  const payload = { agent, turn: 5, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } }
  await handler(payload, () => {})
  assert.equal(disarmed, 0, '第一次不许缴自动续作')
  const first = onlyKind(session, NOTICE_KIND)
  assert.equal(first.length, 1, '第一次要给一条提示')
  const firstText = String(first[0].data.content[0].text)
  assert.match(firstText, /如果下一轮恢复正常/, '第一次的提示必须说明"可能自愈"')
  assert.doesNotMatch(firstText, /不会自动重试/, '第一次不能说"没救"')
  // 同一轮重试三次：只说不数，不能把一轮的重试当成"连着两轮"
  await handler(payload, () => {})
  await handler(payload, () => {})
  await handler(payload, () => {})
  assert.equal(onlyKind(session, NOTICE_KIND).length, 1, '同一轮重试不许刷屏，也不许升级')
  assert.equal(disarmed, 0, '同一轮重试好几次仍然不缴')
  // 下一轮还超：这才算"连着第二次"
  await handler({ agent, turn: 6, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } }, () => {})
  assert.equal(disarmed, 1, '连着第二次才缴自动续作')
  const all = onlyKind(session, NOTICE_KIND)
  assert.equal(all.length, 2, '第二次要给"真的压不动"的提示')
  assert.match(String(all[1].data.content[0].text), /连着两轮都超出窗口/)
})

await check('超窗口：中间成功收尾过一轮，计数清零（重新从"可能自愈"开始）', async () => {
  const session = usageSession(100)
  const ctx = usageCtx(session)
  let disarmed = 0
  const inner = ctx.get
  ctx.get = (name) => (name === 'goals' ? { disarm: () => { disarmed += 1 } } : inner(name))
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  const handler = ctx.handlers.get('agent/request-error')
  const agent = wakeAgent()
  await handler({ agent, turn: 5, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } }, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 5, signal: new AbortController().signal, agent }, () => {})
  await handler({ agent, turn: 6, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } }, () => {})
  assert.equal(disarmed, 0, '中间成功过一轮，下一次超窗仍算"第一次"')
})

// 静默子代理（notifySubagents=false）收尾时插件早退，但超窗计数必须照样清零——
// 否则它自愈一次之后再超一次，就会被误判成"连着两轮"并缴掉它的自动续作（回归修复）。
await check('超窗口：静默子代理收尾也会清零，不会把两次隔轮超窗算成"连着两轮"', async () => {
  const session = usageSession(100)
  const ctx = usageCtx(session)
  let disarmed = 0
  const inner = ctx.get
  const sub = { id: 'sub-1', isSubagent: true, role: 'subagent' }
  ctx.get = (name) => (name === 'goals' ? { disarm: () => { disarmed += 1 } } : inner(name))
  ctx.agents = { requireInitiator: () => sub, get: (id) => (id === 'sub-1' ? sub : null) }
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, notice: { ...DEFAULTS.notice, notifySubagents: false } })
  const handler = ctx.handlers.get('agent/request-error')
  await handler({ agent: sub, turn: 5, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } }, () => {})
  // 这一轮正常收尾（静默子代理，插件不投递任何东西，但计数要清）
  await ctx.handlers.get('agent/turn-stopping')({ turn: 5, signal: new AbortController().signal, agent: sub }, () => {})
  await handler({ agent: sub, turn: 6, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } }, () => {})
  assert.equal(disarmed, 0, '中间成功过一轮，下一次超窗仍算"第一次"（静默子代理同样适用）')
})

// —— 0.2.2-rc.2：宿主删掉了 agents.roots()，子代理身份改由持久化会话头给出 ——
// 依据：rc.2 `packages/core/agent/src/index.ts` 删掉 roots()/isOwnedBy() 与运行期 owner；
// `SessionHeader.origin === 'subagent'` / `delegationDepth > 0` 是可持久化的子代理分类
// （header 注释明确说 parentSession 不能用来判子代理）。老宿主退回 roots()。
await check('0.2.2-rc.2：没有 roots() 时按 session.header.origin 认子代理（静默，不写轮次标记）', async () => {
  await withScratchHome(async () => {
    const session = usageSession(100)
    session.id = 'sub-1'
    session.header = { version: 4, id: 'sub-1', createdAt: 0, isSeeded: false, origin: 'subagent', delegationDepth: 1 }
    const ctx = usageCtx(session)
    ctx.agents = { requireInitiator: () => ({ id: 'sub-1' }) } // rc.2：这个服务上没有 roots()
    apply(ctx, { ...DEFAULTS, reservedTokens: 0, notice: { ...DEFAULTS.notice, notifySubagents: false } })
    const step = STEP(3, 1)
    step.agent.id = 'sub-1'
    step.agent.session = session
    await ctx.handlers.get('agent/pre-step')(step, () => {})
    await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: step.signal, agent: step.agent }, () => {})
    assert.equal(onlyKind(session, MARKER_KIND).length, 0, '子代理不该被写轮次标记')
    assert.equal(step.agent.followups.length, 0, '子代理不该被叫醒')
  })
})

await check('0.2.2-rc.2：会话头没有 origin 的顶层会话仍按根处理（不能把子代理判据做成一律静默）', async () => {
  await withScratchHome(async () => {
    const session = usageSession(100)
    session.id = 'a1'
    session.header = { version: 4, id: 'a1', createdAt: 0, isSeeded: false }
    const ctx = usageCtx(session)
    ctx.agents = { requireInitiator: () => ({ id: 'a1' }) }
    apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
    const step = STEP(3, 1)
    step.agent.session = session
    await ctx.handlers.get('agent/pre-step')(step, () => {})
    assert.equal(onlyKind(session, MARKER_KIND).length, 1, '根会话照常写轮次标记')
  })
})

await check('老宿主：没有会话头时仍用 agents.roots() 判子代理', async () => {
  await withScratchHome(async () => {
    const session = usageSession(100)
    session.id = 'sub-legacy'
    const root = { id: 'a1' }
    const ctx = usageCtx(session)
    ctx.agents = { requireInitiator: () => root, roots: () => [root] }
    apply(ctx, { ...DEFAULTS, reservedTokens: 0, notice: { ...DEFAULTS.notice, notifySubagents: false } })
    const step = STEP(3, 1)
    step.agent.id = 'sub-legacy'
    step.agent.session = session
    await ctx.handlers.get('agent/pre-step')(step, () => {})
    assert.equal(onlyKind(session, MARKER_KIND).length, 0, '不在 roots() 里的就是子代理')
  })
})

// 载荷里的 agent 不保证带 session（turn-stopping 的融合对象可能只有 id）：
// 拿不到 agent.session 时必须回查 ctx.sessions.get(agent.id)，否则 rc.2 上没有 roots() 会一律当根。
await check('0.2.2-rc.2：payload.agent 只有 id 时用 ctx.sessions.get(id).header 认子代理', async () => {
  await withScratchHome(async () => {
    const session = usageSession(100)
    session.id = 'sub-2'
    session.header = { version: 4, id: 'sub-2', createdAt: 0, isSeeded: false, origin: 'subagent', delegationDepth: 1 }
    const ctx = usageCtx(session)
    ctx.agents = { requireInitiator: () => ({ id: 'sub-2' }) } // rc.2：没有 roots()
    apply(ctx, { ...DEFAULTS, reservedTokens: 0, notice: { ...DEFAULTS.notice, notifySubagents: false } })
    const step = STEP(3, 1, { agent: { id: 'sub-2' } }) // 只有 id，没有 .session
    await ctx.handlers.get('agent/pre-step')(step, () => {})
    await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: step.signal, agent: { id: 'sub-2' } }, () => {})
    assert.equal(onlyKind(session, MARKER_KIND).length, 0, '回查到 header 后仍判子代理')
  })
})

await check('delegationDepth>0（头里没有 origin）仍判子代理，锁住第二分支', async () => {
  await withScratchHome(async () => {
    const session = usageSession(100)
    session.id = 'sub-depth'
    session.header = { version: 4, id: 'sub-depth', createdAt: 0, isSeeded: false, delegationDepth: 1 }
    const ctx = usageCtx(session)
    ctx.agents = { requireInitiator: () => ({ id: 'sub-depth' }) }
    apply(ctx, { ...DEFAULTS, reservedTokens: 0, notice: { ...DEFAULTS.notice, notifySubagents: false } })
    const step = STEP(3, 1)
    step.agent.id = 'sub-depth'
    step.agent.session = session
    await ctx.handlers.get('agent/pre-step')(step, () => {})
    assert.equal(onlyKind(session, MARKER_KIND).length, 0, 'depth>0 只由 spawn 子代理写入，应静默')
  })
})

await check('rc.1 roots() 存在时运行期根身份优先：以根恢复的子代理会话仍按根（老行为不变）', async () => {
  await withScratchHome(async () => {
    const session = usageSession(100)
    session.id = 'sub-1'
    session.header = { version: 4, id: 'sub-1', createdAt: 0, isSeeded: false, origin: 'subagent' }
    const ctx = usageCtx(session)
    // rc.1 的 roots() 里含它：子代理会话被以根身份恢复（parentAgent 省略），运行期就是用户正在聊的会话
    ctx.agents = { requireInitiator: () => ({ id: 'sub-1' }), roots: () => [{ id: 'sub-1' }] }
    apply(ctx, { ...DEFAULTS, reservedTokens: 0, notice: { ...DEFAULTS.notice, notifySubagents: false } })
    const step = STEP(3, 1)
    step.agent.id = 'sub-1'
    step.agent.session = session
    await ctx.handlers.get('agent/pre-step')(step, () => {})
    assert.equal(onlyKind(session, MARKER_KIND).length, 1, '运行期根身份优先，主会话不许静默')
  })
})

await check('header 为空且没有 roots()：按根处理（宁可多标记，不静默主会话）', async () => {
  await withScratchHome(async () => {
    const session = usageSession(100)
    session.id = 'a1'
    session.header = null
    const ctx = usageCtx(session)
    ctx.agents = { requireInitiator: () => ({ id: 'a1' }) }
    apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
    const step = STEP(3, 1)
    step.agent.session = session
    await ctx.handlers.get('agent/pre-step')(step, () => {})
    assert.equal(onlyKind(session, MARKER_KIND).length, 1, '拿不到判据时按根处理')
  })
})

await check('notifySubagents=true 时子代理照常参与（配置交互语义未变）', async () => {
  await withScratchHome(async () => {
    const session = usageSession(100)
    session.id = 'sub-1'
    session.header = { version: 4, id: 'sub-1', createdAt: 0, isSeeded: false, origin: 'subagent' }
    const ctx = usageCtx(session)
    ctx.agents = { requireInitiator: () => ({ id: 'sub-1' }) }
    apply(ctx, { ...DEFAULTS, reservedTokens: 0, notice: { ...DEFAULTS.notice, notifySubagents: true } })
    const step = STEP(3, 1)
    step.agent.id = 'sub-1'
    step.agent.session = session
    await ctx.handlers.get('agent/pre-step')(step, () => {})
    assert.equal(onlyKind(session, MARKER_KIND).length, 1, '配置说参与就要参与')
  })
})

await check('默认配置（notifySubagents 默认 true）下子代理照常参与', async () => {
  await withScratchHome(async () => {
    const session = usageSession(100)
    session.id = 'sub-1'
    session.header = { version: 4, id: 'sub-1', createdAt: 0, isSeeded: false, origin: 'subagent' }
    const ctx = usageCtx(session)
    ctx.agents = { requireInitiator: () => ({ id: 'sub-1' }) }
    apply(ctx, { ...DEFAULTS, reservedTokens: 0 }) // 不覆盖 notice：验证真实默认值
    const step = STEP(3, 1)
    step.agent.id = 'sub-1'
    step.agent.session = session
    await ctx.handlers.get('agent/pre-step')(step, () => {})
    assert.equal(onlyKind(session, MARKER_KIND).length, 1, '默认参与，不是默认静默')
  })
})

await check('rc.2：header 没有 origin/depth 时读运行期 options.subagentDepth（与宿主 delegationDepthOf 口径一致）', async () => {
  await withScratchHome(async () => {
    const session = usageSession(100)
    session.id = 'sub-opt'
    session.header = { version: 4, id: 'sub-opt', createdAt: 0, isSeeded: false }
    const ctx = usageCtx(session)
    ctx.agents = { requireInitiator: () => ({ id: 'sub-opt' }) } // rc.2：没有 roots()
    apply(ctx, { ...DEFAULTS, reservedTokens: 0, notice: { ...DEFAULTS.notice, notifySubagents: false } })
    const step = STEP(3, 1)
    step.agent.id = 'sub-opt'
    step.agent.session = session
    step.agent.options = { subagentDepth: 1 }
    await ctx.handlers.get('agent/pre-step')(step, () => {})
    assert.equal(onlyKind(session, MARKER_KIND).length, 0, '只设运行期 depth 的子代理也要认出来')
  })
})

await check('turn-stopping 载荷没带 agent：到线内联已经落地，不依赖收尾载荷', async () => {
  await withScratchHome(async () => {
    const session = lineSession(3600)
    const ctx = usageCtx(session)
    ctx.agents = { requireInitiator: () => ({ id: 'a1' }), roots: () => [{ id: 'a1' }] } // rc.1：roots 非空
    apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.75, notice: { ...DEFAULTS.notice, growthTokens: 100000, notifySubagents: false } })
    const t3 = STEP(3, 1)
    await ctx.handlers.get('agent/pre-step')(t3, () => {})
    assert.equal(onlyKind(session, NOTICE_KIND).length, 1, '到线在 pre-step 已写内联提醒')
    await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: t3.signal }, () => {})
    assert.equal(t3.agent.followups.length, 0, '不依赖收尾 agent')
    assert.equal(onlyKind(session, NOTICE_KIND).length, 1, '提醒已经落地')
  })
})

await check('R3 回归：停用会话搜索期间占用掉到线下，指示灯也要复位（否则重新启用后到线提醒永久丢）', async () => {
  const session = lineSession(3600)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.75, notice: { ...DEFAULTS.notice, growthTokens: 100000 } })
  const t3 = STEP(3, 1)
  await ctx.handlers.get('agent/pre-step')(t3, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: t3.signal })
  assert.equal(onlyKind(session, NOTICE_KIND).length, 1, '第一次越线要报内联')
  // 用户在第二、三轮之间把会话搜索插件关掉，同时占用掉到线下。
  ctx.tools = { register: () => () => {}, get: () => undefined }
  session.used = 400
  session.seq += 1
  const t4 = STEP(4, 1)
  await ctx.handlers.get('agent/pre-step')(t4, () => {})
  assert.equal(onlyKind(session, NOTICE_KIND).length, 1, '没装会话搜索时不许再发')
  // 重新启用，用量再次越线：这一次的到线提醒必须能发出来。
  ctx.tools = { register: () => () => {}, get: (name) => (name === 'session_event_read' || name === 'session_event_search' ? {} : undefined) }
  session.used = 3600
  session.seq += 1
  const t5 = STEP(5, 1)
  await ctx.handlers.get('agent/pre-step')(t5, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 5, signal: t5.signal })
  assert.equal(onlyKind(session, NOTICE_KIND).length, 2, '停用期间掉下线的复位丢了 → 这里就永远不报（回归修复）')
  assert.match(String(onlyKind(session, NOTICE_KIND)[1].data.content[0].text), /上下文/, '发的应该还是到线提醒')
})
await check('没装会话搜索插件：不写提醒（地图、工具与到线 inline 都停用）', async () => {
  const session = usageSession(900)
  const ctx = usageCtx(session)
  ctx.tools = { register: () => () => {}, get: () => undefined }
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  const step = STEP(3)
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: step.signal }, () => {})
  assert.equal(step.agent.followups.length, 0, '没有会话搜索时不该叫醒模型')
  assert.equal(onlyKind(session, NOTICE_KIND).length, 0, '也不许写到线提醒')

  // 压得动分支（C1 原性质）：闸门必须连常规提醒一起挡，不能只挡 inline。
  const s2 = lineSession(3600)
  const ctx2 = usageCtx(s2)
  ctx2.tools = { register: () => () => {}, get: () => undefined }
  apply(ctx2, LINE_CONFIG)
  const step2 = STEP(3, 1, { agent: wakeAgent() })
  await ctx2.handlers.get('agent/pre-step')(step2, () => {})
  await ctx2.handlers.get('agent/turn-stopping')({ turn: 3, signal: step2.signal }, () => {})
  assert.equal(step2.agent.followups.length, 0, '没装会话搜索时，压得动也不许叫醒（C1）')
  assert.equal(onlyKind(s2, NOTICE_KIND).length, 0, '也不许写提醒')

  // 正向对照（顺序必须在上面两条 0 之后）：同一夹具装上会话搜索 → 必须写一条内联提醒。
  const s3 = lineSession(3600)
  const ctx3 = usageCtx(s3)
  apply(ctx3, LINE_CONFIG)
  const step3 = STEP(3, 1, { agent: wakeAgent() })
  await ctx3.handlers.get('agent/pre-step')(step3, () => {})
  await ctx3.handlers.get('agent/turn-stopping')({ turn: 3, signal: step3.signal }, () => {})
  assert.equal(onlyKind(s3, NOTICE_KIND).length, 1, '对照：装了会话搜索才提醒；这里若变 0，上面两条 0 就是假绿')
  assert.equal(step3.agent.followups.length, 0, '提醒走内联，不走 followup')
})

await check('读不到表层：不抛异常、留可见说明（不装作可压）', async () => {
  const session = lineSession(3600)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.75 })
  Object.defineProperty(session, 'surface', {
    configurable: true,
    get() {
      throw new Error('surface boom')
    },
  })
  const t3 = STEP(3, 1)
  // 用户 2026-11-05 改判：表层读不出来**不再停对话**——旧做法在用户消息已被 claim 之后抛错，
  // 持续故障时每轮都会吞掉一条用户消息。现在是降级：本轮不叫醒、四级判据全 false、留一条可见说明，
  // 工具调用仍照常把硬错回给模型。
  let threw = null
  try {
    await ctx.handlers.get('agent/pre-step')(t3, () => {})
  } catch (error) {
    threw = error
  }
  assert.equal(threw, null, '不该再抛给宿主')
  assert.equal(onlyKind(session, NOTICE_KIND).length, 1, '读不出表层时要留一条可见说明')
  assert.match(String(onlyKind(session, NOTICE_KIND)[0].data.content[0].text), /读不出会话表层/, '说明原因')
  // 读不出表层时仍会写一条“读不出会话表层”的提示：append 本身不依赖 surface 投影，
  // 真正保证的是“不吞消息、不装作可压”；下一轮继续也不许抛。
  session.seq += 1
  let threwAgain = null
  try {
    await ctx.handlers.get('agent/pre-step')(STEP(4, 1), () => {})
  } catch (error) {
    threwAgain = error
  }
  assert.equal(threwAgain, null, '第二轮也不许抛（持续故障不能每轮吞消息）')
})

await check('回执单位：原文区数「条消息」、区块数「个块」（改坏了测试要红）', async () => {
  const lines = describeResults([
    { key: 'l0', title: 'A', shadowedCount: 7, savedTokens: 120 },
    { key: 'l1', title: 'B', shadowedCount: 3, savedTokens: 90 },
  ])
  assert.equal(lines.length, 2)
  assert.match(lines[0], /l0 成功：A（7 条消息 -> 省 120 token）/)
  assert.match(lines[1], /l1 成功：B（3 个块 -> 省 90 token）/)
})

await check('成功回执：睡醒轮收手句在地图之后、是本组最后一行（改文案要红）', async () => {
  const lines = receiptLines(
    [{ key: 'l0', title: 'A', shadowedCount: 7, savedTokens: 120 }],
    { mapText: '地图第一行\n地图第二行' },
  )
  assert.equal(lines[lines.length - 1], '压缩完成，本轮到此结束；未决的事留到下一轮。')
  assert.equal(lines[lines.length - 2], '地图第一行\n地图第二行', '提醒要排在地图之后')
  assert.match(lines[0], /l0 成功：A（7 条消息 -> 省 120 token）/)
})

await check('到线/子代理回执：压完继续任务，不要求收手', async () => {
  const lines = receiptLines(
    [{ key: 'l0', title: 'A', shadowedCount: 7, savedTokens: 120 }],
    { mapText: '地图', continueLine: true },
  )
  assert.equal(lines[lines.length - 1], RECEIPT_CONTINUE_LINE)
  assert.match(RECEIPT_CONTINUE_LINE, /继续当前任务/)
  assert.doesNotMatch(RECEIPT_CONTINUE_LINE, /本轮压缩已经完成，请在本轮不要继续压缩/)
})

await check('B3 回归：关掉会话搜索时，系统提示不再承诺「按事件号能查回来」', async () => {
  const session = usageSession(120)
  const ctx = usageCtx(session)
  const captured = []
  ctx.get = (name) => (name === 'systemPrompt' ? { section: (s) => { captured.push(s.text); return () => {} } } : name === 'commands' ? { register: () => () => {} } : undefined)
  apply(ctx, { ...DEFAULTS, requireSessionQuery: false })
  const text = captured.map((t) => (typeof t === 'function' ? t({ agent: { id: 'a1' } }) : t)).join('')
  assert.match(text, /若装了会话搜索/, '要说清能不能查回来取决于装没装，不能无条件承诺')
  assert.doesNotMatch(text, /按事件号能查回来。/, '不能把一定查得回来说死')
  assert.doesNotMatch(text, /compress 与 context_map 会直接停用/, '开关关掉时不会停用，别这么说')
  assert.match(text, /不是把摘要写短的理由/, '关会话搜索那支也要钉住同一句')
  assert.doesNotMatch(text, /摘要写短没关系/, '旧许可句不能回来')
})

await check('子代理系统提示：说轮内提醒，不再说“收尾叫醒”', async () => {
  const session = usageSession(100)
  session.id = 'sub-prompt'
  session.header = { version: 4, id: 'sub-prompt', createdAt: 0, isSeeded: false, origin: 'subagent' }
  const ctx = usageCtx(session)
  ctx.agents = { requireInitiator: () => ({ id: 'sub-prompt' }) }
  const captured = []
  ctx.get = (name) => (name === 'systemPrompt' ? { section: (s) => { captured.push(s.text); return () => {} } } : name === 'commands' ? { register: () => () => {} } : undefined)
  apply(ctx, { ...DEFAULTS })
  const agent = { id: 'sub-prompt', session }
  const text = captured.map((t) => (typeof t === 'function' ? t({ agent }) : t)).join('')
  assert.match(text, /每轮开头/, '子代理提示要说轮首/轮内')
  assert.match(text, /不会在轮后另开压缩轮/, '要明确不再轮后开压缩轮')
  assert.doesNotMatch(text, /一轮收尾把你叫醒一次/, '子代理不能再说收尾叫醒')
})

await check('B3 对照：默认开着时仍然明确点名 session_event_read 并说明停用规则', async () => {
  const session = usageSession(120)
  const ctx = usageCtx(session)
  const captured = []
  ctx.get = (name) => (name === 'systemPrompt' ? { section: (s) => { captured.push(s.text); return () => {} } } : name === 'commands' ? { register: () => () => {} } : undefined)
  apply(ctx, { ...DEFAULTS })
  const text = captured.map((t) => (typeof t === 'function' ? t({ agent: { id: 'a1' } }) : t)).join('')
  assert.match(text, /session_event_read/, '默认情况下要告诉模型用哪个工具取回')
  assert.match(text, /会直接停用/, '没装会话搜索时会停用，这句要保留')
  assert.match(text, /按当次提醒和地图的说明继续或收手/, 'root 提示不能与 followup 收手句对撞')
  assert.match(text, /不是把摘要写短的理由/, '原文可取回不能当写短摘要的借口')
  assert.doesNotMatch(text, /摘要写短没关系/, '旧许可句不能回来')
  assert.doesNotMatch(text, /聊天回执/, '不额外加回执格式示例')
  assert.doesNotMatch(text, /填表顺序按/, 'F3：填表顺序只在 compress 的说明里写一份，系统提示不再重复')
  assert.doesNotMatch(text, /必须同批一起给/, 'F3：级联规矩也只在说明里写一份')
})

await check('系统提示的 to 半句：l0 是轮号、l1/l2 是块序号（改文案要红）', async () => {
  const session = usageSession(120)
  const ctx = usageCtx(session)
  const captured = []
  ctx.get = (name) => (name === 'systemPrompt' ? { section: (s) => { captured.push(s.text); return () => {} } } : name === 'commands' ? { register: () => () => {} } : undefined)
  apply(ctx, { ...DEFAULTS })
  const text = captured.map((t) => (typeof t === 'function' ? t({ agent: { id: 'a1' } }) : t)).join('')
  assert.match(text, /压缩时 to 的轮号照〔轮次标记〕认；l1\/l2 的 to 是块序号，不是轮号/, '问题 1 依赖这句提示')
  assert.doesNotMatch(text, /压缩时写 to 就照它认轮号/, '旧句不能回来')
})

await check('compress 描述开头形状 + schema 顺序：to 在层对象里、l3 不写 to', async () => {
  const session = usageSession(120)
  const ctx = usageCtx(session)
  const registered = []
  ctx.tools = { register: (tool) => (registered.push(tool), () => {}), get: (name) => (name === 'session_event_read' || name === 'session_event_search' ? {} : undefined) }
  apply(ctx, { ...DEFAULTS })
  const compress = registered.find((tool) => tool.name === 'compress')
  assert.ok(compress, 'compress 工具要注册')
  const desc = compress.description
  assert.match(desc, /^把旧对话折成更短的摘要。参数形状：/, '描述第一句就写形状')
  assert.match(desc, /\{"l0":\{"to":"T…","title":"…","summary":"…"\}\}/, 'l0 的单层形状要带 to')
  assert.match(desc, /\{"l3":\{…\},"l1":\{…\},"l0":\{…\}\}/, '多层形状要并排放在最外层')
  assert.match(desc, /to 写在层对象里，最外层不放任何东西/, '明确 to 不是顶层字段')
  assert.match(desc, /每个对象里是 to（l3 除外）、title、summary/, 'l3 不写 to 不能与“三个字段”自相矛盾')
  assert.match(desc, /每一层的 to 只写一个锚点/, 'to 只写一个锚点的范围是每一层')
  assert.match(desc, /占位符/, '明确示例里的号是占位符')
  assert.doesNotMatch(desc, /"to":"T?\d/, '形状示例里 to 不许出现具体号')
  assert.doesNotMatch(desc, /填表语法示例/, '旧的示例段已并入形状句')

  // 参数顺序：to 必须是第一个属性（模型按 schema 顺序生成，to 放最后时漏写率最高）。
  const schemaKeys = (key) => Object.keys(compress.parameters.properties[key].properties)
  for (const key of ['l0', 'l1', 'l2']) {
    assert.deepEqual(schemaKeys(key), ['to', 'title', 'summary'], `${key} 的 to 要排在属性第一位`)
  }
  assert.deepEqual(schemaKeys('l3'), ['title', 'summary'], 'l3 不写 to')

  assert.match(desc, /l0 的 to 写 T 号，l1\/l2 写序号，l3 不写 to/, '占位符含义要说全')
  const toolText = desc + JSON.stringify(compress.parameters)
  assert.doesNotMatch(toolText, /\d+\s*%\s*[–-]\s*\d+\s*%/, '不给摘要写长度比例')
  assert.doesNotMatch(toolText, /\d{3,5}\s*[–-]\s*\d{3,5}\s*(字|token)/, '不给摘要写死字数/token 区间')
  assert.doesNotMatch(toolText, /\d+\s*字/, '不写死“多少字”')
  assert.doesNotMatch(toolText, /至少[^\n]{0,12}理由/, '不许回到“至少一条理由”')
  assert.doesNotMatch('至少要给 l3 / l2 / l1 / l0 里的一个键', /至少[^\n]{0,12}理由/, '合法的“至少要给”不能被误伤')
  assert.doesNotMatch(desc, /不要只写四行结论/, '不再加这句话')

  const summary = compress.parameters.properties.l3.properties.summary.description
  const l0Summary = compress.parameters.properties.l0.properties.summary.description
  assert.match(summary, /每个决定留下理由/, '证据保留规则要留下')
  assert.match(summary, /按这四行写/, '四行骨架要在')
  assert.match(summary, /原文很少或信息确实不足时可以短/, '原文很少时可以短这句要保留')
  assert.match(summary, /四行是结构，不是长度上限/, '四行不是长度上限这句要保留')
  assert.doesNotMatch(summary, /至少[^\n]{0,12}理由/, '不许回到“至少一条理由”')

  // 2026-11-18 摘要质量改动（评审 + 用户拍板）：
  // ① 摘要要承载重要结论、确认的事实、讨论结果与来龙去脉；
  // ② 运行结论先给结果，过程性记录挪位但不删；归属类事实保留；
  // ③ 时间边界：旧块不写压缩时的现状；
  // ④ 合并旧摘要块时不能只并标题；
  // ⑤ 领域通用：不写“改了什么文件/跑了什么命令/agent 名/审查轮次/提交号”这类模板；
  // ⑥ 明确禁止“写完自查/重写”类措辞，避免模型以为要二次压缩。
  assert.match(summary, /重要结论/, '要明确要求重要结论')
  assert.match(summary, /确认的事实/, '要明确要求确认的事实')
  assert.match(summary, /讨论后定下的方案/, '要明确要求讨论结果')
  assert.match(summary, /被否决的方案/, '要明确要求被否决的方案及原因')
  assert.match(summary, /还悬着什么/, '要留未决问题的位置')
  assert.match(summary, /来龙去脉/, '要明确要求来龙去脉')
  assert.match(summary, /路径、地址或其它能照它找回来的标识写全/, '附件/产出要能找回')
  assert.match(summary, /谁给的/, '归属类事实不能被过程性规则一刀切删掉')
  assert.match(summary, /压缩时才看到的现状不属于旧块的结论/, '时间边界要写进提示词')
  assert.match(summary, /不能只并标题/, '合并旧块不能只抄标题')
  assert.match(summary, /不能只写“已完成\/已通过”/, '要防止空泛结论')
  assert.doesNotMatch(summary, /改了什么文件|跑了什么命令|agent 名|审查轮次|提交号/, '摘要规则不能绑定编程/代理流程模板')
  assert.doesNotMatch(summary, /自查|逐项检查|写完.*检查|再写一版|重写一遍/, '不许让模型以为要写两遍/二次检查')
  assert.match(l0Summary, /同 l3 的 summary 规则：四行——/, '一行引用要指得回 l3')
  assert.match(l0Summary, /删过程流水但保留决策依据、失败原因与关键数据/, '一行引用口径要与 l3 一致')
  assert.match(l0Summary, /运行结论（结果、重要结论与定案依据；附件写全路径或地址）/, '一行引用要同步新的运行结论口径')
})

// 2026-11-12 用户 E 待办：占用达到总长线（triggerPct）时，pre-step 的"压得动"判据也必须
// 按运行时 keepTurns=0 算；否则地图说能压、提醒却仍按保护圈判"压不动"。
await check('E：占用达到总长线时 pre-step 按 keepTurns=0 判可压，降回线下恢复', async () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'T1 的问题 ' + '原'.repeat(500) }] },
    { role: 'assistant', content: [{ type: 'text', text: 'T1 的回答 ' + '答'.repeat(500) }] },
    { role: 'user', content: [{ type: 'text', text: 'T2 的问题 ' + '原'.repeat(500) }] },
    { role: 'assistant', content: [{ type: 'text', text: 'T2 的回答 ' + '答'.repeat(500) }] },
    { role: 'user', content: [{ type: 'text', text: 'T3 当前轮' }] },
  ]
  const session = fakeSession([5, 10, 11, 20, 21, 30], messages)
  session.seq = 1
  session.requestContext = () => ({ contextWindow: 10000 })
  session.requestHeader = () => ({ config: { maxTokens: 0 } })
  const projections = { stateOf: () => ({ turns: [{ turn: 1, seq: 10 }, { turn: 2, seq: 20 }, { turn: 3, seq: 30 }] }) }
  const ctx = usageCtx(session)
  const baseGet = ctx.get.bind(ctx)
  ctx.get = (name) => (name === 'sessionProjections' ? projections : baseGet(name))
  // 总长线 = 75%；未到线时 keepTurns=2 仍保护最近两轮，到线后运行时按 0。
  const cfg = { ...DEFAULTS, reservedTokens: 0, keepTurns: 2, triggerPct: 0.75 }

  session.used = 7400 // 74% 未到线，仍按 keepTurns=2 保护
  const underStep = STEP(3)
  apply(ctx, cfg)
  await ctx.handlers.get('agent/pre-step')(underStep, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: underStep.signal }, () => {})
  assert.equal(underStep.agent.followups.length, 0, '未到线时 keepTurns=2 仍保护最近两轮，l0 压不动，不该叫醒')
  assert.equal(onlyKind(session, NOTICE_KIND).length, 0, '未到线，不该写提醒')

  const overSession = fakeSession([5, 10, 11, 20, 21, 30], messages)
  overSession.seq = 1
  overSession.requestContext = () => ({ contextWindow: 10000 })
  overSession.requestHeader = () => ({ config: { maxTokens: 0 } })
  overSession.used = 8000 // 到达 75% 总长线，keepTurns 运行时降 0
  const overStep = STEP(4)
  const ctx2 = usageCtx(overSession)
  const baseGet2 = ctx2.get.bind(ctx2)
  ctx2.get = (name) => (name === 'sessionProjections' ? projections : baseGet2(name))
  apply(ctx2, cfg)
  await ctx2.handlers.get('agent/pre-step')(overStep, () => {})
  await ctx2.handlers.get('agent/turn-stopping')({ turn: 4, signal: overStep.signal }, () => {})
  assert.equal(onlyKind(overSession, NOTICE_KIND).length, 1, '超过设定线后最近已结束轮进入可压范围，到线应写提醒')
  assert.equal(overStep.agent.followups.length, 0, '到线内联，不 followup')
})

// 同一轮里先由增长触发把 compressible 按 keepTurns=2 缓存，随后占用跨过总长线：
// 缓存键必须带压缩时的运行时 keepTurns（compressKeep），否则会继续用旧判定发"压不动"提示。
await check('E：同一轮跨过总长线时 compressKeep 触发重算', async () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'T1 的问题 ' + '原'.repeat(500) }] },
    { role: 'assistant', content: [{ type: 'text', text: 'T1 的回答 ' + '答'.repeat(500) }] },
    { role: 'user', content: [{ type: 'text', text: 'T2 的问题 ' + '原'.repeat(500) }] },
    { role: 'assistant', content: [{ type: 'text', text: 'T2 的回答 ' + '答'.repeat(500) }] },
    { role: 'user', content: [{ type: 'text', text: 'T3 当前轮' }] },
  ]
  const session = fakeSession([5, 10, 11, 20, 21, 30], messages)
  session.seq = 1
  session.requestContext = () => ({ contextWindow: 10000 })
  session.requestHeader = () => ({ config: { maxTokens: 0 } })
  const projections = { stateOf: () => ({ turns: [{ turn: 1, seq: 10 }, { turn: 2, seq: 20 }, { turn: 3, seq: 30 }] }) }
  const ctx = usageCtx(session)
  const baseGet = ctx.get.bind(ctx)
  ctx.get = (name) => (name === 'sessionProjections' ? projections : baseGet(name))
  const cfg = { ...DEFAULTS, reservedTokens: 0, keepTurns: 2, triggerPct: 0.75, notice: { ...DEFAULTS.notice, growthTokens: 50 } }
  apply(ctx, cfg)

  const step = STEP(3)
  session.used = 7400
  await ctx.handlers.get('agent/pre-step')(step, () => {}) // 定基线
  session.used = 7450 // 未到 75%，增长 50 触发一次，compressible 按 keepTurns=2 缓存
  session.seq += 1
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  assert.equal(step.agent.followups.length, 0, '增长触发但 l0 还被 keepTurns 保护，不该叫醒')
  session.used = 8000 // 同一轮到达 75%
  session.seq += 1
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: step.signal }, () => {})
  assert.equal(onlyKind(session, NOTICE_KIND).length, 1, '跨线后 compressKeep 变了，必须重算出可压并写提醒（不能沿用旧缓存写“压不动”）')
  assert.equal(step.agent.followups.length, 0, '到线内联，不 followup')
})

// 压缩成功后 resetGrowthBaseline 必须清掉“哪层压得动”的旧判定；否则同轮降幅 <5% 时
// zonesTurn 不作废，余下步骤会继续用压缩前的 compressible（回归修复）。
await check('resetGrowthBaseline 清掉 compressible/envBlocked/compressTurn/compressKeep/zonesTurn/zonesOver', async () => {
  const session = usageSession(900)
  const ctx = usageCtx(session)
  const cfg = { ...DEFAULTS, reservedTokens: 0 }
  const st = {
    tokens: 800,
    compressible: { l0: true, l1: false, l2: false, l3: false },
    envBlocked: { l0: false },
    compressTurn: 3,
    compressKeep: 2,
    growthQuota: 500,
    growthLamp: true,
    growthPending: 3,
    zonesTurn: 3,
    zonesOver: { l1: { used: 999, limit: 1 } },
    lineOn: false,
  }
  const state = new Map([['a1', st]])
  resetGrowthBaseline(ctx, { id: 'a1' }, cfg, state, () => {})
  assert.equal(st.compressible, null, 'compressible 必须清')
  assert.equal(st.envBlocked, null, 'envBlocked 必须清')
  assert.equal(st.compressTurn, null, 'compressTurn 必须清')
  assert.equal(st.compressKeep, null, 'compressKeep 必须清')
  assert.equal(st.zonesTurn, null, 'zonesTurn 区快照必须清')
  assert.equal(st.zonesOver, null, 'zonesOver 区超限快照必须清')
  assert.equal(st.lineOn, true, '到线灯按压缩后 ratio 复位')
})

console.log(`prestep 冒烟测试全部通过（${passed} 项）`)
