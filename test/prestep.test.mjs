// 胶水层冒烟：把 apply() 挂到假 ctx 上，真跑一次 agent/pre-step。
// 纯函数测试测不到这一层——"引用了外层作用域的变量却没接收成参数"这类错误，
// 只有真跑一遍才会现形（ee1fb7e 就是这么漏过去的）。
// 跑法：node plugin/test/prestep.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, describeResults, foldPending, receiptLines } from '../index.js'
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

await check('到线：pre-step 只登记，不写节点、也不叫醒', async () => {
  const session = usageSession(900)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  const step = STEP(3)
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  assert.equal(onlyKind(session, NOTICE_KIND).length, 0, '这一步不该写提醒')
  assert.equal(step.agent.followups.length, 0, '还没到收尾，不该叫醒')
})

await check('turn-stopping：走 followup 把模型叫醒（不是写进表层等用户开口）', async () => {
  const session = usageSession(900)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  const step = STEP(3)
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: step.signal }, () => {})
  assert.equal(step.agent.followups.length, 1)
  assert.equal(onlyKind(session, NOTICE_KIND).length, 0, '叫醒这条路不自己写提醒节点，交给宿主认领时写')
  assert.match(String(step.agent.followups[0].content[0].text), /上下文已用 90%/)
  // 提醒必须带**完整地图**（含"压缩须知"、块表、占用），不是只给 to 的那一行数字：
  // 模型要靠块标题与块大小决定并哪几块。有人为省 token 换成紧凑版时，这条会红。
  const noticeText = String(step.agent.followups[0].content[0].text)
  assert.match(noticeText, /压缩须知/, '提醒里必须带完整地图（须知段）')
  assert.doesNotMatch(noticeText, /能压（to 照抄，别自己数）/, '提醒不能用紧凑版顶替完整地图')
  // 首行必须自报家门：宿主把这条当 user/message 交给模型，不写明就会被当成用户说的话。
  assert.match(noticeText.split('\n')[0], /自动提醒/, '提醒首行必须标明是插件注入的自动提醒')
  assert.match(noticeText.split('\n')[0], /不是用户/, '提醒首行必须说明这不是用户发言')
  // 来源标记要用宿主已登记的 kind：Client 会把它渲染成「插件状态更新」卡片；
  // 自造 kind 会落回默认的「收到执行请求」，看着像用户自己发起的请求。
  assert.equal(step.agent.followups[0].source.kind, 'cordis-host-runner', '提醒的 source.kind 必须是宿主登记过的')
  // 用户要求（2026-11-05）：一次调用就是一批，别在同一轮里连压多次——提醒正文要收住。
  assert.match(noticeText, /请在一次压缩中完成，不要分多次压缩/, '提醒要明确说"一次压缩完成"')
})

await check('拿不到活 agent（没有 followup）：退化成尾部追加', async () => {
  const session = usageSession(900)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  const step = STEP(3, 1, { agent: plainAgent })
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: step.signal }, () => {})
  const noticed = onlyKind(session, NOTICE_KIND)
  assert.equal(noticed.length, 1)
  assert.equal(noticed[0].opts.surfaceOp, 'append')
})

// ── 轮次标记：模型靠它把「压掉 T1–T15」和表层里那一段对上号 ──────────────
await check('轮次标记：收尾写「下一轮 T{N+1}」，而且不会重复写', async () => {
  const session = usageSession(100) // 远低于线，不该有提醒，只剩标记
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
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
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
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
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
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
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  const step = STEP(1, 1)
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  // 收尾也一样：这一轮连请求都没发出去时表层仍是空的
  await ctx.handlers.get('agent/turn-stopping')({ turn: 1, signal: step.signal, agent: step.agent }, () => {})
  assert.equal(onlyKind(session, MARKER_KIND).length, 0, '空表层上一条标记都不许写')
  assert.equal(session.appends.length, 0, '空表层上任何 append 都不许发生')
})

await check('只叫醒一轮：被叫醒的那轮不再登记第二条，也不连环叫醒', async () => {
  const session = usageSession(900)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  const s3 = STEP(3)
  await ctx.handlers.get('agent/pre-step')(s3, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: s3.signal }, () => {})
  assert.equal(s3.agent.followups.length, 1)
  // 下一轮就是被叫醒的那一轮：认领到的消息是我们自己发的那条
  const s4 = STEP(4, 1, { agent: s3.agent, messages: s3.agent.followups.slice() })
  await ctx.handlers.get('agent/pre-step')(s4, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 4, signal: s4.signal }, () => {})
  assert.equal(s3.agent.followups.length, 1, '不能再叫醒一次')
  assert.equal(onlyKind(session, NOTICE_KIND).length, 0, '同一句话不重复发')
})

await check('到线只在越线时报一次：掉回线下再越线才会再报（不在线上反复催）', async () => {
  const session = usageSession(900)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, notice: { ...DEFAULTS.notice, growthTokens: 0 } })
  const s3 = STEP(3)
  await ctx.handlers.get('agent/pre-step')(s3, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: s3.signal }, () => {})
  assert.equal(s3.agent.followups.length, 1, '越线时报一条')
  // 一直停在线上面：用户开口了、又过了一轮，也不该再报（设计约束）
  const s4 = STEP(4, 1, { agent: s3.agent, messages: [{ role: 'user', content: [], source: { kind: 'user' } }] })
  await ctx.handlers.get('agent/pre-step')(s4, () => {})
  s3.agent.inbox.nextTurn = []
  await ctx.handlers.get('agent/turn-stopping')({ turn: 4, signal: s4.signal }, () => {})
  assert.equal(s3.agent.followups.length, 1, '在线上面不该每轮重复报')
  // 掉回线下（压缩后），再越线一次 → 重新亮灯
  session.used = 400
  session.seq += 1
  const s5 = STEP(5, 1, { agent: s3.agent })
  await ctx.handlers.get('agent/pre-step')(s5, () => {})
  session.used = 900
  session.seq += 1
  const s6 = STEP(6, 1, { agent: s3.agent })
  await ctx.handlers.get('agent/pre-step')(s6, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 6, signal: s6.signal }, () => {})
  assert.equal(s3.agent.followups.length, 2, '掉回线下再越线，要重新报一次')
})

await check('上一条提醒还挂在 inbox 里：就地替换，不再排队塞第二条', async () => {
  const session = usageSession(900)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  const agent = wakeAgent()
  // 模拟"上一轮以异常收场、提醒没人认领"：inbox 里留着一条我们的提醒
  // 必须带哨兵才算'我们写的'（回归修复）：宿主自己的 cordis-host-runner 消息也可能排在这里。
  const stale = { id: 'stale-1', role: 'user', createdAt: Date.now(), content: [{ type: 'text', text: '〔Ebbing Context 插件注入〕旧提醒' }], source: { kind: 'cordis-host-runner' } }
  agent.inbox.nextTurn.push(stale)
  const s3 = STEP(3, 1, { agent })
  await ctx.handlers.get('agent/pre-step')(s3, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: s3.signal }, () => {})
  assert.equal(agent.followups.length, 0, '有旧提醒时不该再 followup 一条新的')
  assert.equal(agent.replaced.length, 1, '应该就地替换旧提醒')
  assert.equal(agent.inbox.nextTurn.length, 1, '队列里始终只有一条我们的提醒')
  assert.match(String(agent.inbox.nextTurn[0].content[0].text), /自动提醒/, '替换进去的是这次的新读数')
})

await check('同一条提醒只发一次：第二次 turn-stopping 不再发', async () => {
  const session = usageSession(900)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  const step = STEP(3)
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: step.signal, agent: step.agent }, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: step.signal, agent: step.agent }, () => {})
  assert.equal(step.agent.followups.length, 1)
})

await check('后面一步算出没理由了：撤销待发，收尾不发（照旧数字说话就是说谎）', async () => {
  const session = usageSession(900)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  const signal = new AbortController().signal
  const agent = wakeAgent()
  await ctx.handlers.get('agent/pre-step')({ agent, turn: 3, step: 1, signal }, () => {})
  // 模型在这一轮里压掉了一层，占用掉回线下；seq 变化让读数缓存失效
  session.used = 200
  session.seq = 2
  await ctx.handlers.get('agent/pre-step')({ agent, turn: 3, step: 2, signal }, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal }, () => {})
  assert.equal(agent.followups.length, 0)
  assert.equal(onlyKind(session, NOTICE_KIND).length, 0)
})

await check('上一轮以异常收场（turn-stopping 没来）：旧记录直接丢，不拿过期读数说话', async () => {
  const session = usageSession(900)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  const agent = wakeAgent()
  await ctx.handlers.get('agent/pre-step')({ agent, turn: 3, step: 1, signal: new AbortController().signal }, () => {})
  assert.equal(onlyKind(session, NOTICE_KIND).length, 0)
  // 没有 turn-stopping，直接进下一轮第一步
  await ctx.handlers.get('agent/pre-step')({ agent, turn: 4, step: 1, signal: new AbortController().signal }, () => {})
  assert.equal(agent.followups.length, 0, '上一轮那条已经作废，不该补发')
  assert.equal(onlyKind(session, NOTICE_KIND).length, 0)
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

await check('提醒里明确写了「允许不压」与「压完简短回复」', async () => {
  const session = usageSession(900)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  const step = STEP(3)
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: step.signal }, () => {})
  const text = String(step.agent.followups[0].content[0].text)
  assert.match(text, /这一轮允许什么都不压/, '必须明确允许本轮不采取压缩行动')
  assert.match(text, /压完只回一两句/, '必须要求压完之后简短回复')
  assert.match(text, /还没做完/, '必须点名"没做完的事"作为不压的理由')
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
    const session = usageSession(900)
    session.id = 'session-restart-line'
    // 关掉增长这条线，只看"到线灯"的落盘
    const config = { ...DEFAULTS, reservedTokens: 0, notice: { ...DEFAULTS.notice, growthTokens: 0 } }
    const ctx1 = usageCtx(session)
    apply(ctx1, config)
    const t1 = STEP(1)
    await ctx1.handlers.get('agent/pre-step')(t1, () => {})
    await ctx1.handlers.get('agent/turn-stopping')({ turn: 1, signal: t1.signal }, () => {})
    assert.equal(t1.agent.followups.length, 1, '越线先报一次')
    assert.equal(readGrowth('session-restart-line') && readGrowth('session-restart-line').lineOn, true, '灯亮着要落盘')
    // 掉回线下：灯灭必须落盘（旧代码只改内存，盘上仍是 true）
    session.used = 400
    session.seq += 1
    const t2 = STEP(2, 1, { agent: t1.agent })
    await ctx1.handlers.get('agent/pre-step')(t2, () => {})
    assert.equal(readGrowth('session-restart-line') && readGrowth('session-restart-line').lineOn, false, '掉回线下后盘上必须是灭的')
    // 模拟重启，再次越线：必须重新报
    session.used = 900
    session.seq += 1
    const ctx2 = usageCtx(session)
    apply(ctx2, config)
    const t3 = STEP(3)
    await ctx2.handlers.get('agent/pre-step')(t3, () => {})
    await ctx2.handlers.get('agent/turn-stopping')({ turn: 3, signal: t3.signal }, () => {})
    assert.equal(t3.agent.followups.length, 1, '重启后再次越线必须重新报（灯不能还是亮着）')
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

await check('S3 回归：只发到线提醒时，不许把"当时压不动"的区记成已提醒', async () => {
  const session = layeredSession(['L1'], 400, 900)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.75 })
  const t3 = STEP(3, 1)
  await ctx.handlers.get('agent/pre-step')(t3, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: t3.signal })
  assert.equal(t3.agent.followups.length, 1, '到线提醒照发')
  assert.doesNotMatch(String(t3.agent.followups[0].content[0].text), /区已超设计容量/, '这一层只有一块，不该报区超限')
  // 下一轮补到两块、仍然超限：这块区第一次真正可压，必须能报出来。
  // 注意第 4 轮是"被叫醒的那一轮"（autoTurn），按设计不登记第二条；所以看第 5 轮。
  session.pushBlock('L1')
  session.used = 920
  session.seq += 1
  const t4 = STEP(4, 1)
  await ctx.handlers.get('agent/pre-step')(t4, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 4, signal: t4.signal })
  assert.equal(t4.agent.followups.length, 0, '被叫醒的那一轮不再登记第二条')
  session.seq += 1
  const t5 = STEP(5, 1)
  await ctx.handlers.get('agent/pre-step')(t5, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 5, signal: t5.signal })
  assert.equal(t5.agent.followups.length, 1, '没报过的区不能被提前锁存')
  assert.match(String(t5.agent.followups[0].content[0].text), /区已超设计容量/)
})

await check('G3 回归：被叫醒的那一轮里掉到线下，也要把到线指示灯复位', async () => {
  const session = usageSession(900)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, triggerPct: 0.75 })
  const t3 = STEP(3, 1)
  await ctx.handlers.get('agent/pre-step')(t3, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: t3.signal })
  assert.equal(t3.agent.followups.length, 1, '第一次越线要报')
  // 第 4 轮就是被叫醒的那轮：占用掉到线下（这一步会被 autoTurn 早退，但复位不能被跳过）
  session.used = 400
  session.seq += 1
  const t4 = STEP(4, 1)
  await ctx.handlers.get('agent/pre-step')(t4, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 4, signal: t4.signal })
  // 第 5 轮又涨回线上：这是一次新的"越线"，必须能再报。
  session.used = 900
  session.seq += 1
  const t5 = STEP(5, 1)
  await ctx.handlers.get('agent/pre-step')(t5, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 5, signal: t5.signal })
  assert.equal(t5.agent.followups.length, 1, '掉下去又越上来，要当成一次新的越线')
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
  const session = usageSession(900)
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
  const session = usageSession(900)
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

await check('R3 回归：停用会话搜索期间占用掉到线下，指示灯也要复位（否则重新启用后到线提醒永久丢）', async () => {
  const session = usageSession(900)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0, triggerPct: 0.75, notice: { ...DEFAULTS.notice, growthTokens: 100000 } })
  const t3 = STEP(3, 1)
  await ctx.handlers.get('agent/pre-step')(t3, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: t3.signal })
  assert.equal(t3.agent.followups.length, 1, '第一次越线要报')
  // 用户在第二、三轮之间把会话搜索插件关掉，同时占用掉到线下。
  ctx.tools = { register: () => () => {}, get: () => undefined }
  session.used = 400
  session.seq += 1
  const t4 = STEP(4, 1)
  await ctx.handlers.get('agent/pre-step')(t4, () => {})
  assert.equal(t4.agent.followups.length, 0, '没装会话搜索时不许叫醒')
  // 重新启用，用量再次越线：这一次的到线提醒必须能发出来。
  ctx.tools = { register: () => () => {}, get: (name) => (name === 'session_event_read' || name === 'session_event_search' ? {} : undefined) }
  session.used = 920
  session.seq += 1
  const t5 = STEP(5, 1)
  await ctx.handlers.get('agent/pre-step')(t5, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 5, signal: t5.signal })
  assert.equal(t5.agent.followups.length, 1, '停用期间掉下线的复位丢了 → 这里就永远不报（回归修复）')
  assert.match(String(t5.agent.followups[0].content[0].text), /上下文/, '发的应该还是到线提醒')
})
await check('没装会话搜索插件：不叫醒（地图与工具都是停用的）', async () => {
  const session = usageSession(900)
  const ctx = usageCtx(session)
  // 覆盖掉 usageCtx 给的 get：模拟"宿主没装 dsh-tool-session-query"
  ctx.tools = { register: () => () => {}, get: () => undefined }
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  const step = STEP(3)
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: step.signal }, () => {})
  assert.equal(step.agent.followups.length, 0, '没有会话搜索时不该叫醒模型')
  assert.equal(onlyKind(session, NOTICE_KIND).length, 0)
})

await check('读不到表层：pre-step 直接报红（工作对象坏了，不许装作可压）', async () => {
  const session = usageSession(900)
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
  assert.deepEqual(ctx.state ? ctx.state.get('a1').compressible : { l0: false, l1: false, l2: false, l3: false }, { l0: false, l1: false, l2: false, l3: false })
  // 说明是"尽力而为"：本次 fixture 连 surface 都读不出来，写不进任何节点——这正是
  // "表层坏了就连提醒都贴不上去"的真实约束。真正能保证的是"不吞消息、不装作可压"。
  // 能写的时候（例如只是 deriveMessages 坏）会贴一条，见下一条用例。
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

await check('成功回执：收手提醒在地图之后、是本组最后一行（改文案要红）', async () => {
  const lines = receiptLines(
    [{ key: 'l0', title: 'A', shadowedCount: 7, savedTokens: 120 }],
    { mapText: '地图第一行\n地图第二行' },
  )
  assert.equal(lines[lines.length - 1], '本轮压缩已经完成，请在本轮不要继续压缩。')
  assert.equal(lines[lines.length - 2], '地图第一行\n地图第二行', '提醒要排在地图之后')
  assert.match(lines[0], /l0 成功：A（7 条消息 -> 省 120 token）/)
})

await check('B3 回归：关掉会话搜索时，系统提示不再承诺「按事件号能查回来」', async () => {
  const session = usageSession(120)
  const ctx = usageCtx(session)
  const captured = []
  ctx.get = (name) => (name === 'systemPrompt' ? { section: (s) => { captured.push(s.text); return () => {} } } : name === 'commands' ? { register: () => () => {} } : undefined)
  apply(ctx, { ...DEFAULTS, requireSessionQuery: false })
  const text = captured.join('')
  assert.match(text, /若装了会话搜索/, '要说清能不能查回来取决于装没装，不能无条件承诺')
  assert.doesNotMatch(text, /按事件号能查回来。/, '不能把一定查得回来说死')
  assert.doesNotMatch(text, /compress 与 context_map 会直接停用/, '开关关掉时不会停用，别这么说')
})

await check('B3 对照：默认开着时仍然明确点名 session_event_read 并说明停用规则', async () => {
  const session = usageSession(120)
  const ctx = usageCtx(session)
  const captured = []
  ctx.get = (name) => (name === 'systemPrompt' ? { section: (s) => { captured.push(s.text); return () => {} } } : name === 'commands' ? { register: () => () => {} } : undefined)
  apply(ctx, { ...DEFAULTS })
  const text = captured.join('')
  assert.match(text, /session_event_read/, '默认情况下要告诉模型用哪个工具取回')
  assert.match(text, /会直接停用/, '没装会话搜索时会停用，这句要保留')
  assert.doesNotMatch(text, /填表顺序按/, 'F3：填表顺序只在 compress 的说明里写一份，系统提示不再重复')
  assert.doesNotMatch(text, /必须同批一起给/, 'F3：级联规矩也只在说明里写一份')
})

console.log(`prestep 冒烟测试全部通过（${passed} 项）`)
