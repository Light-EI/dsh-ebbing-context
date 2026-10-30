// 胶水层冒烟：把 apply() 挂到假 ctx 上，真跑一次 agent/pre-step。
// 纯函数测试测不到这一层——"引用了外层作用域的变量却没接收成参数"这类错误，
// 只有真跑一遍才会现形（ee1fb7e 就是这么漏过去的）。
// 跑法：node plugin/test/prestep.test.mjs
import assert from 'node:assert/strict'
import { apply, foldPending } from '../index.js'
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
      return seq - 1
    },
  }
  return session
}

const callMessage = (ids) => ({
  role: 'assistant',
  content: ids.map(([name, id]) => ({ type: 'tool-call', name, id, arguments: '{"x":1}' })),
})
const resultMessage = (id) => ({ role: 'tool', toolCallId: id, content: [{ type: 'text', text: '成功' }] })

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

// —— 提醒的投递时机（用户 m10065：固定在本轮收尾、用户下一句话之前）——

function usageSession(used) {
  const session = fakeSession([10], [{ role: 'user', content: [{ type: 'text', text: '你好' }] }])
  session.seq = 1
  session.requestContext = () => ({ contextWindow: 1000 })
  session.used = used
  return session
}

function usageCtx(session) {
  const ctx = fakeCtx(session)
  ctx.tools = { register: () => () => {} }
  ctx.tokenMeter = { measure: () => ({ totalTokens: session.used }) }
  return ctx
}

const STEP = (turn, step = 1, extra = {}) => ({ agent: wakeAgent(), turn, step, signal: new AbortController().signal, ...extra })

// 被叫醒的那个 agent：followup 只是把消息排进 inbox 的 next-turn，宿主在本轮结束后自己开新一轮。
function wakeAgent() {
  const agent = {
    id: 'a1',
    followups: [],
    followup(message) {
      agent.followups.push(message)
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
  assert.equal(session.appends.length, 0, '这一步不该有任何写入')
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
  assert.equal(session.appends.length, 0, '叫醒这条路不自己写节点，交给宿主认领时写')
  assert.match(String(step.agent.followups[0].content[0].text), /上下文已用 90%/)
  // 提醒必须带**完整地图**（含"压缩须知"、块表、占用），不是只给 to 的那一行数字：
  // 模型要靠块标题与块大小决定并哪几块。有人为省 token 换成紧凑版时，这条会红。
  const noticeText = String(step.agent.followups[0].content[0].text)
  assert.match(noticeText, /压缩须知/, '提醒里必须带完整地图（须知段）')
  assert.doesNotMatch(noticeText, /能压（to 照抄，别自己数）/, '提醒不能用紧凑版顶替完整地图')
})

await check('拿不到活 agent（没有 followup）：退化成尾部追加', async () => {
  const session = usageSession(900)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  const step = STEP(3, 1, { agent: plainAgent })
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: step.signal }, () => {})
  assert.equal(session.appends.length, 1)
  assert.equal(session.appends[0].opts.surfaceOp, 'append')
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
  assert.equal(session.appends.length, 0, '同一句话不重复发')
})

await check('用户真的开口了：闸门复位，下一轮收尾又能叫醒', async () => {
  const session = usageSession(900)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  const s3 = STEP(3)
  await ctx.handlers.get('agent/pre-step')(s3, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: s3.signal }, () => {})
  const s4 = STEP(4, 1, { agent: s3.agent, messages: s3.agent.followups.slice() })
  await ctx.handlers.get('agent/pre-step')(s4, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 4, signal: s4.signal }, () => {})
  // 用户发了一句话，这一轮的新信号里认领到的是用户那条
  const s5 = STEP(5, 1, { agent: s3.agent, messages: [{ role: 'user', content: [], source: { kind: 'user' } }] })
  await ctx.handlers.get('agent/pre-step')(s5, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 5, signal: s5.signal }, () => {})
  assert.equal(s3.agent.followups.length, 2, '用户开口之后可以再叫醒一次')
})

await check('同一条提醒只发一次：第二次 turn-stopping 不再发', async () => {
  const session = usageSession(900)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  const step = STEP(3)
  await ctx.handlers.get('agent/pre-step')(step, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: step.signal }, () => {})
  await ctx.handlers.get('agent/turn-stopping')({ turn: 3, signal: step.signal }, () => {})
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
  assert.equal(session.appends.length, 0)
})

await check('上一轮以异常收场（turn-stopping 没来）：旧记录直接丢，不拿过期读数说话', async () => {
  const session = usageSession(900)
  const ctx = usageCtx(session)
  apply(ctx, { ...DEFAULTS, reservedTokens: 0 })
  const agent = wakeAgent()
  await ctx.handlers.get('agent/pre-step')({ agent, turn: 3, step: 1, signal: new AbortController().signal }, () => {})
  assert.equal(session.appends.length, 0)
  // 没有 turn-stopping，直接进下一轮第一步
  await ctx.handlers.get('agent/pre-step')({ agent, turn: 4, step: 1, signal: new AbortController().signal }, () => {})
  assert.equal(agent.followups.length, 0, '上一轮那条已经作废，不该补发')
  assert.equal(session.appends.length, 0)
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

// 设计裁定（用户 m13359 选 A）：剪枝只在 compress 里做，与宿主同构——
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

console.log(`prestep 冒烟测试全部通过（${passed} 项）`)
