// compress-e2e.test.mjs —— runCompress 端到端单测（假宿主，不碰生产代码）
//
// 跑法：node plugin/test/compress-e2e.test.mjs   （退出码 0 = 全过）
//
// 被测：plugin/lib/compress.js 的 runCompress(ctx, agent, args, config, log)。
// 它走完整条链：查会话 → 格式校验 → 并发检查 → 许可证 → 未闭合事务预检 →
// 剪枝 → 读表层算区间 → 整批预演 → 落盘（四条事件）→ 回执。
//
// 假宿主约定（照 plugin/test/prestep.test.mjs 的 fakeCtx / fakeSession 风格）：
//   · session.log 是稀疏数组，log[seq] = event（seq 从 1 起，log[0] 留洞）；
//   · session.surface.nodes 是有序事件号（表层），append 时按 surfaceOp 真维护：
//     'append' → push 新节点；{op:'replace',startSeq,endSeq} → splice 成一个新 seq；
//     无 surfaceOp（compaction/* 事务事件）→ 只进日志，不上表层；
//   · append 返回事件对象（带 .seq，runCompress 用 startEvent.seq）；
//   · deriveEventMessage / deriveMessages 提供逐节点精确投影，readZones 走 exact 路径；
//   · 许可证不绕过：用 license.js 的 issue() 对测试代理真发证（与 index.js 的
//     context_map 工具同一入口），每个用例用独立 agentId 隔离模块级 seen 表。
//
// 覆盖（任务规定的 6 条）：
//   1 成功路径（只压 l0）：四条事件、关键字段、回执数字、表层替换
//   2 整批预演不写任何东西（第一个键本可通过、第二个键在预演被拦）
//   3 收益校验拒绝时 0 事件
//   4 写 start 之后失败要补偿 end（绝不静默）
//   5 未闭合事务预检
//   6 并发第二个 compress 被拒

import { runCompress } from '../lib/compress.js'
import { readZones, openCompaction } from '../lib/blocks.js'
import { issue } from '../lib/license.js'
import { DEFAULTS } from '../lib/config.js'
import { messageTokens } from '../lib/tokens.js'

let total = 0
let failed = 0

function check(name, cond, note) {
  total += 1
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failed += 1
    console.log(`FAIL  ${name}`)
    if (note !== undefined) {
      const text = typeof note === 'string' ? note : JSON.stringify(note)
      console.log(`      ${text}`)
    }
  }
}

const show = (v) => JSON.stringify(v)
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
// 宽字符（CJK 1 字 = 1 token，tokens.js 的 estimateTokens 口径）
const W = (n, ch = '原') => ch.repeat(n)
// 兼容两种消息形态（宿主工厂 / 降级对象）取正文
const textOf = (m) => {
  if (!m) return ''
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) return m.content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('')
  return ''
}

/* ------------------------- 假宿主 ------------------------- */

const sysText = (t) => ({ role: 'system', content: [{ type: 'text', text: t }] })
const userText = (t) => ({ role: 'user', content: [{ type: 'text', text: t }] })
const asstText = (t) => ({ role: 'assistant', content: [{ type: 'text', text: t }] })
const checkpointBlock = (header, body, compactionId) => ({
  role: 'user',
  source: { kind: 'compact-checkpoint', compactionId },
  content: [{ type: 'text', text: `${header}\n${body}` }],
})
const toolCallMsg = (calls) => ({ role: 'assistant', content: calls })

function fakeSession() {
  const log = [] // log[seq] = event
  const nodes = [] // 表层：有序事件号
  const messages = [] // 与 nodes 一一对应的投影消息
  const appends = [] // 测试观察口：{ type, data, opts, seq }
  let nextSeq = 1

  const msgOf = (event) => {
    if (!event || typeof event !== 'object') return null
    if (event.type === 'user/message' || event.type === 'system/message') return event.data || null
    if (event.type === 'assistant/message' || event.type === 'tool/result') {
      return (event.data && event.data.message) || null
    }
    return null
  }

  const session = {
    log,
    appends,
    get surface() {
      return { nodes: nodes.slice() }
    },
    deriveMessages() {
      return messages.slice()
    },
    deriveEventMessage(event) {
      return msgOf(event)
    },
    append(type, data, opts) {
      const seq = nextSeq++
      const event = { type, data, seq }
      log[seq] = event
      appends.push({ type, data, opts, seq })
      if (opts && opts.surfaceOp === 'append') {
        nodes.push(seq)
        messages.push(msgOf(event))
      } else if (opts && opts.surfaceOp && typeof opts.surfaceOp === 'object') {
        const start = nodes.indexOf(opts.surfaceOp.startSeq)
        const end = nodes.indexOf(opts.surfaceOp.endSeq)
        if (start < 0 || end < start) {
          throw new Error(`假宿主：surfaceOp.replace 找不到区间 ${opts.surfaceOp.startSeq}–${opts.surfaceOp.endSeq}`)
        }
        nodes.splice(start, end - start + 1, seq)
        messages.splice(start, end - start + 1, msgOf(event))
      }
      return event
    },
  }

  // 布景工具：turn/start 是纯日志事件；node 同时进日志与表层；logOnly 只进日志。
  session.seed = {
    turnStart(turn) {
      const seq = nextSeq++
      log[seq] = { type: 'turn/start', data: { turn }, seq }
      return seq
    },
    node(type, message) {
      const seq = nextSeq++
      const event = { type, data: message, seq }
      log[seq] = event
      nodes.push(seq)
      messages.push(msgOf(event))
      return seq
    },
    logOnly(type, data) {
      const seq = nextSeq++
      log[seq] = { type, data, seq }
      return seq
    },
  }
  return session
}

function fakeCtx(session) {
  return {
    sessions: { get: () => session },
    // 宿主 token 计量器替身：逐节点 messageTokens（measureRange 消费 .nodes）
    tokenMeter: {
      measure(s) {
        const nodes = s.surface.nodes.map((seq) => ({
          seq,
          tokens: messageTokens(s.log[seq] ? s.deriveEventMessage(s.log[seq]) : null),
        }))
        return { totalTokens: nodes.reduce((t, n) => t + n.tokens, 0), nodes }
      },
    },
    sessionProjections: { stateOf: () => null },
    get() {
      return undefined // 无 toolResultPruner、无投影源：走"读表层"的默认路径
    },
  }
}

// 用 license.js 的真实 issue 发证（与 index.js 的 context_map 工具同一入口，不绕过许可证）
function issueLicense(ctx, session, agent, log) {
  issue(agent.id, session, readZones(ctx, session, agent, log))
}

// keepTurns 0：测试布景里"上一轮"就是可压轮（runCompress 本身不校验 keepTurns 下限，
// 那是 pre-step 的 fatalConfig 的事）。
const config = { ...DEFAULTS, keepTurns: 0 }
const agentFor = (id) => ({ id, options: { provider: 'deepseek', model: 'test-model' } })
const makeLogger = () => {
  const lines = []
  return { lines, fn: (event, data) => lines.push({ event, data }) }
}

/* ------------------------- 布景 ------------------------- */

// 布局A：系统头 + 两个原文轮（每轮 user+assistant）。
// 事件形状按宿主约定：user/system 事件的 data 就是消息，assistant 事件包 { message }。
// 表层 = [2,3,4,6,7]，currentTurn = 2；keepTurns 0 时可压区间 = 第 1 轮 = [3,4]。
function rawTwoTurns(lenA) {
  const s = fakeSession()
  s.seed.turnStart(1)
  s.seed.node('system/message', sysText('你是助手。'))
  s.seed.node('user/message', userText(W(lenA)))
  s.seed.node('assistant/message', { message: asstText(W(lenA)) })
  s.seed.turnStart(2)
  s.seed.node('user/message', userText(W(120)))
  s.seed.node('assistant/message', { message: asstText(W(120)) })
  return s
}

// 布局B：系统头 + 两块 L1 + 两个原文轮（3 轮）。
// 表层 = [2,3,4,6,7,9,10]，currentTurn = 3；keepTurns 0 时可压原文 = 第 2 轮 = [6,7]。
function blocksPlusRaw() {
  const s = fakeSession()
  s.seed.turnStart(1)
  s.seed.node('system/message', sysText('你是助手。'))
  s.seed.node(
    'user/message',
    checkpointBlock('〔L1｜T1–T1｜ev 3–3〕第一块', `<compacted-summary>${W(400, '摘')}</compacted-summary>`, 'ic-old-1'),
  )
  s.seed.node(
    'user/message',
    checkpointBlock('〔L1｜T2–T2｜ev 5–5〕第二块', `<compacted-summary>${W(400, '摘')}</compacted-summary>`, 'ic-old-2'),
  )
  s.seed.turnStart(2)
  s.seed.node('user/message', userText(W(200)))
  s.seed.node('assistant/message', { message: asstText(W(200)) })
  s.seed.turnStart(3)
  s.seed.node('user/message', userText(W(200)))
  s.seed.node('assistant/message', { message: asstText(W(200)) })
  return s
}

/* ------------------------- 用例 ------------------------- */

// 用例 1：成功路径（只压 l0）
async function case1() {
  const session = rawTwoTurns(400)
  const agent = agentFor('e2e-agent-1')
  const ctx = fakeCtx(session)
  const logger = makeLogger()
  issueLicense(ctx, session, agent, logger.fn)
  const args = { l0: { title: '第一阶段的结论', summary: W(120, '压'), to: 'T1' } }
  const result = await runCompress(ctx, agent, args, config, logger.fn)
  const a = session.appends

  check('1a · 恰好写了四条事件且顺序正确',
    a.length === 4 && a.map((x) => x.type).join(',') === 'compaction/start,compaction/summary,user/message,compaction/end',
    show(a.map((x) => x.type)))

  const ids = [
    a[0] && a[0].data && a[0].data.compactionId,
    a[1] && a[1].data && a[1].data.compactionId,
    a[2] && a[2].data && a[2].data.source && a[2].data.source.compactionId,
    a[3] && a[3].data && a[3].data.compactionId,
  ]
  check('1b · 四条事件带同一个 compactionId（ic- 前缀）',
    ids.every((x) => typeof x === 'string' && x.startsWith('ic-')) && ids[0] === ids[1] && ids[1] === ids[2] && ids[2] === ids[3],
    show(ids))

  check('1c · start.turn 等于开放轮（当前轮 2）', !!(a[0] && a[0].data && a[0].data.turn === 2), show(a[0] && a[0].data))

  check('1d · summary.shadowedSeqs 覆盖被遮节点 [3,4]',
    !!(a[1] && a[1].data && deepEq(a[1].data.shadowedSeqs, [3, 4])), show(a[1] && a[1].data))

  check('1e · summary.shadowedRange 首尾等于被遮区间',
    !!(a[1] && a[1].data && a[1].data.shadowedRange && a[1].data.shadowedRange.start === 3 && a[1].data.shadowedRange.end === 4),
    show(a[1] && a[1].data && a[1].data.shadowedRange))

  check('1f · summary 带 provider/model（来自 agent.options）',
    !!(a[1] && a[1].data && a[1].data.provider === 'deepseek' && a[1].data.model === 'test-model'),
    show(a[1] && a[1].data && [a[1].data.provider, a[1].data.model]))

  check('1g · summary.shadowedTokenCount 是宿主口径的正数',
    !!(a[1] && a[1].data && typeof a[1].data.shadowedTokenCount === 'number' && a[1].data.shadowedTokenCount > 0),
    show(a[1] && a[1].data && a[1].data.shadowedTokenCount))

  check('1h · user/message 的 surfaceOp 是 replace 且首尾等于被遮区间',
    !!(a[2] && a[2].opts && a[2].opts.surfaceOp && a[2].opts.surfaceOp.op === 'replace'
      && a[2].opts.surfaceOp.startSeq === 3 && a[2].opts.surfaceOp.endSeq === 4),
    show(a[2] && a[2].opts))

  check('1i · user/message 的 sourceEventSeqs = [start.seq, summary.seq, ...被遮节点]',
    !!(a[2] && a[2].opts && deepEq(a[2].opts.sourceEventSeqs, [a[0].seq, a[1].seq, 3, 4])),
    show(a[2] && a[2].opts && a[2].opts.sourceEventSeqs))

  check('1j · 最后一条是 compaction/end 且没有 error 字段',
    !!(a[3] && a[3].type === 'compaction/end' && a[3].data && !('error' in a[3].data)), show(a[3] && a[3].data))

  check('1k · 回执 ok === true', !!(result && result.ok === true), show(result))

  const r0 = result && result.results && result.results[0]
  check('1l · 回执带 savedTokens / shadowedTokenCount / shadowedCount 数字',
    !!(r0 && typeof r0.savedTokens === 'number' && r0.savedTokens > 0
      && typeof r0.shadowedTokenCount === 'number' && r0.shadowedTokenCount > 0
      && r0.shadowedCount === 2 && r0.key === 'l0'),
    show(r0))

  check('1m · 回执 compactionId 与事件一致', !!(r0 && ids[0] && r0.compactionId === ids[0]), show(r0))

  check('1n · prunedChars === 0（没注册剪枝器）', !!(result && result.prunedChars === 0), show(result && result.prunedChars))

  check('1o · 表层节点数按替换规则变化（5 → 4，被遮 seq 消失，新 seq 顶上）',
    deepEq(session.surface.nodes, [2, a[2].seq, 6, 7]) && !session.surface.nodes.includes(3) && !session.surface.nodes.includes(4),
    show(session.surface.nodes))

  const newMsg = session.log[a[2].seq] ? session.deriveEventMessage(session.log[a[2].seq]) : null
  check('1p · 新节点是一条 L1 检查点块（块头 〔L1｜T1｜ev 3–4〕+标题）',
    !!(newMsg && newMsg.role === 'user' && newMsg.source && newMsg.source.kind === 'compact-checkpoint'
      && textOf(newMsg).startsWith('〔L1｜T1｜ev 3–4〕第一阶段的结论')),
    show(newMsg && { role: newMsg.role, source: newMsg.source, head: textOf(newMsg).slice(0, 40) }))

  const zonesAfter = readZones(ctx, session, agent, logger.fn)
  check('1q · 重读表层：新块被归入 l1，原文区只剩第 2 轮 [6,7]',
    zonesAfter.zones.l1.length === 1 && zonesAfter.zones.l1[0].seq === a[2].seq
      && deepEq(zonesAfter.zones.l0.map((n) => n.seq), [6, 7]),
    show({ l1: zonesAfter.zones.l1.map((z) => z.seq), l0: zonesAfter.zones.l0.map((n) => n.seq) }))
}

// 用例 2：整批预演不写任何东西
// 批次 = {l1(本可通过), l0(收益不达标)}。写序按表层位置升序：l1 先、l0 后。
// 若没有"整批预演"这道闸，l1 的四条事件会先落盘；预演必须让整批一个字都不写。
async function case2() {
  const session = blocksPlusRaw()
  const agent = agentFor('e2e-agent-2')
  const ctx = fakeCtx(session)
  const logger = makeLogger()
  issueLicense(ctx, session, agent, logger.fn)
  const args = {
    l1: { title: '早期结论', summary: W(100, '摘'), to: '1' },
    l0: { title: '近期原文', summary: W(300, '压'), to: 'T2' }, // 300 token 摘要 > 120 token 原文
  }
  const result = await runCompress(ctx, agent, args, config, logger.fn)

  check('2a · 整批预演失败：ok === false 且 0 事件写入',
    !!(result && result.ok === false && session.appends.length === 0), show(result))

  check('2b · 原因说明是预演拦下整批（一个字都没写）',
    typeof (result && result.reason) === 'string' && result.reason.includes('整批预演'),
    result && result.reason)

  check('2c · 失败出在第二个键 l0（第一个键 l1 预演已通过）',
    typeof (result && result.reason) === 'string' && result.reason.includes('l0 压完反而更大'),
    result && result.reason)

  check('2d · 表层未被改动（连 l1 的替换也没有发生）',
    deepEq(session.surface.nodes, [2, 3, 4, 6, 7, 9, 10]), show(session.surface.nodes))
}

// 用例 3：收益校验拒绝时 0 事件
async function case3() {
  const session = rawTwoTurns(200) // 被压原文约 400 token（超过 300 的开销门槛）
  const agent = agentFor('e2e-agent-3')
  const ctx = fakeCtx(session)
  const logger = makeLogger()
  issueLicense(ctx, session, agent, logger.fn)
  const args = { l0: { title: '原文', summary: W(300, '压'), to: 'T1' } } // 摘要比原文还长
  const result = await runCompress(ctx, agent, args, config, logger.fn)

  check('3a · 收益校验拒绝：ok === false', !!(result && result.ok === false), show(result))

  check('3b · 一条事件都没写（appends.length === 0）',
    session.appends.length === 0, show(session.appends.map((x) => x.type)))

  check('3c · 原因提到「压完反而更大」并带两侧 token 数',
    typeof (result && result.reason) === 'string' && result.reason.includes('压完反而更大')
      && /被压 \d+ token/.test(result.reason) && /压后 \d+ token/.test(result.reason),
    result && result.reason)

  check('3d · 表层未被改动', deepEq(session.surface.nodes, [2, 3, 4, 6, 7]), show(session.surface.nodes))
}

// 用例 4：写 start 之后失败要补偿 end（绝不静默）
async function case4() {
  const session = rawTwoTurns(400)
  const agent = agentFor('e2e-agent-4')
  const ctx = fakeCtx(session)
  const logger = makeLogger()
  issueLicense(ctx, session, agent, logger.fn)
  // 宿主在写第二条（compaction/summary）时坏掉
  const realAppend = session.append
  session.append = (type, data, opts) => {
    if (type === 'compaction/summary') throw new Error('模拟宿主写盘失败：compaction/summary')
    return realAppend(type, data, opts)
  }
  const args = { l0: { title: '第一阶段的结论', summary: W(120, '压'), to: 'T1' } }
  const result = await runCompress(ctx, agent, args, config, logger.fn)
  const a = session.appends

  check('4a · ok === false', !!(result && result.ok === false), show(result))

  check('4b · 事件序列是 start → end（带 error），没有 user/message',
    a.length === 2 && a[0].type === 'compaction/start' && a[1].type === 'compaction/end'
      && !a.some((x) => x.type === 'user/message'),
    show(a.map((x) => x.type)))

  check('4c · 补偿 end 带 error 字段且指向 summary 失败',
    !!(a[1] && a[1].data && typeof a[1].data.error === 'string' && a[1].data.error.includes('compaction/summary')),
    show(a[1] && a[1].data))

  check('4d · 补偿 end 与 start 同 compactionId、同 turn',
    !!(a[1] && a[1].data && a[0].data && a[1].data.compactionId === a[0].data.compactionId && a[1].data.turn === a[0].data.turn),
    show([a[0] && a[0].data, a[1] && a[1].data]))

  check('4e · 表层未被替换', deepEq(session.surface.nodes, [2, 3, 4, 6, 7]), show(session.surface.nodes))

  check('4f · 补偿后日志里没有未闭合事务（openCompaction === null）',
    openCompaction(session) === null, show(openCompaction(session)))

  check('4g · 原因说明写入失败、停在 summary',
    typeof (result && result.reason) === 'string' && result.reason.includes('写入失败') && result.reason.includes('summary'),
    result && result.reason)
}

// 用例 5：未闭合事务预检
async function case5() {
  const session = rawTwoTurns(400)
  // 塞一条没有对应 end 的 compaction/start（上一次压缩写盘中途失败的残迹）
  session.seed.logOnly('compaction/start', { compactionId: 'ic-stuck-1', turn: 2 })
  const agent = agentFor('e2e-agent-5')
  const ctx = fakeCtx(session)
  const logger = makeLogger()
  issueLicense(ctx, session, agent, logger.fn)
  const before = session.appends.length
  const args = { l0: { title: '第一阶段的结论', summary: W(120, '压'), to: 'T1' } }
  const result = await runCompress(ctx, agent, args, config, logger.fn)

  check('5a · 检测到未闭合事务：ok === false', !!(result && result.ok === false), show(result))

  check('5b · 一条事件都没多写', session.appends.length === before, show(session.appends.map((x) => x.type)))

  check('5c · 原因提到「没闭合」', typeof (result && result.reason) === 'string' && result.reason.includes('没闭合'),
    result && result.reason)

  check('5d · 表层未被改动', deepEq(session.surface.nodes, [2, 3, 4, 6, 7]), show(session.surface.nodes))
}

// 用例 6：并发第二个 compress 被拒
async function case6() {
  const session = fakeSession()
  // 同一条助手消息里两个 compress 调用（siblingCompressCount 的判定形状）
  session.seed.node('assistant/message', { message: toolCallMsg([
    { type: 'tool-call', name: 'compress', id: 'c1', arguments: '{"l0":{"title":"x","summary":"y","to":"T1"}}' },
    { type: 'tool-call', name: 'compress', id: 'c2', arguments: '{"l0":{"title":"x","summary":"y","to":"T1"}}' },
  ]) })
  const agent = agentFor('e2e-agent-6')
  const ctx = fakeCtx(session)
  const logger = makeLogger()
  const args = { l0: { title: '第一阶段的结论', summary: W(120, '压'), to: 'T1' } }
  const result = await runCompress(ctx, agent, args, config, logger.fn)

  check('6a · 并发第二个 compress 被拒：ok === false 且 0 事件',
    !!(result && result.ok === false && session.appends.length === 0), show(result))

  check('6b · 原因提到同一条消息里不止一个 compress 调用',
    typeof (result && result.reason) === 'string' && result.reason.includes('不止一个 compress'),
    result && result.reason)
}

/* ------------------------- 跑 ------------------------- */

const caseVerdicts = []

async function runCase(label, fn) {
  const before = { total, failed }
  console.log(`\n—— ${label}`)
  let threw = null
  try {
    await fn()
  } catch (e) {
    threw = e
  }
  if (threw) {
    total += 1
    failed += 1
    console.log(`FAIL  ${label} · 用例中途抛异常：${threw && threw.message ? threw.message : threw}`)
    if (threw && threw.stack) {
      console.log('      ' + threw.stack.split('\n').slice(1, 4).join('\n      '))
    }
  }
  if (total === before.total) {
    check(`${label} · 至少产出一条断言`, false, '这个用例一条断言都没跑')
  }
  caseVerdicts.push({ label, pass: failed === before.failed })
}

// 用例 7：原文段自己太小（不足 300 token）时，拒因要说「段太小」，不能骗模型去改摘要。
async function case7() {
  const session = rawTwoTurns(60) // 约 120 token，压成块连开销都盖不住
  const agent = agentFor('e2e-agent-7')
  const ctx = fakeCtx(session)
  const logger = makeLogger()
  issueLicense(ctx, session, agent, logger.fn)
  const args = { l0: { title: '原文', summary: W(20, '压'), to: 'T1' } }
  const result = await runCompress(ctx, agent, args, config, logger.fn)

  check('7a · 收益校验拒绝：ok === false', !!(result && result.ok === false), show(result))
  check('7b · 一条事件都没写', session.appends.length === 0, show(session.appends.map((x) => x.type)))
  check('7c · 原因说「原文太少」并给出开销门槛，而不是让人去改摘要',
    typeof (result && result.reason) === 'string'
      && result.reason.includes('原文太少') && result.reason.includes('300')
      && !result.reason.includes('把摘要写短'),
    result && result.reason)
}

// 用例 8：replace 已落地、结束记录补不上 → 回执必须说"块已生效"（applied: true）
async function case8() {
  const session = rawTwoTurns(400)
  const agent = agentFor('e2e-agent-8')
  const ctx = fakeCtx(session)
  const logger = makeLogger()
  issueLicense(ctx, session, agent, logger.fn)
  const beforeNodes = session.surface.nodes.slice()
  // 结束记录两次都写不进去：主路径那次 + 补偿那次。
  const realAppend = session.append
  session.append = (type, data, opts) => {
    if (type === 'compaction/end') throw new Error('模拟磁盘只读：compaction/end')
    return realAppend(type, data, opts)
  }
  const args = { l0: { title: '第一阶段', summary: W(120, '压'), to: 'T1' } }
  const result = await runCompress(ctx, agent, args, config, logger.fn)

  check('8a · ok === false（回执仍报失败）', !!(result && result.ok === false), show(result))
  check('8b · applied === true（块已经在表层生效）', result && result.applied === true, show(result && result.applied))
  check('8c · 表层确实被替换了（不是"整批没写"）', !deepEq(session.surface.nodes, beforeNodes), show(session.surface.nodes))
  check('8d · 原因里明说"已经写进表层生效"并提醒别再压同一段',
    typeof (result && result.reason) === 'string'
      && result.reason.includes('已经写进表层生效')
      && result.reason.includes('不要再压同一段'),
    result && result.reason)
  check('8e · 日志里留下未闭合事务（openCompaction 能看见）',
    !!(openCompaction(session) && openCompaction(session).compactionId), show(openCompaction(session)))
}

// 用例 8b：第一次写 end 失败、补写成功 —— 块已生效，回执也必须带 applied（回归修复）
async function case8b() {
  const session = rawTwoTurns(400)
  const agent = agentFor('e2e-agent-8b')
  const ctx = fakeCtx(session)
  const logger = makeLogger()
  issueLicense(ctx, session, agent, logger.fn)
  const beforeNodes = session.surface.nodes.slice()
  const realAppend = session.append
  let endCalls = 0
  session.append = (type, data, opts) => {
    if (type === 'compaction/end') {
      endCalls += 1
      if (endCalls === 1) throw new Error('模拟第一次写 end 抖动')
    }
    return realAppend(type, data, opts)
  }
  const args = { l0: { title: '第一阶段', summary: W(120, '压'), to: 'T1' } }
  const result = await runCompress(ctx, agent, args, config, logger.fn)

  check('8b-1 · ok === false（这一层算失败）', !!(result && result.ok === false), show(result))
  check('8b-2 · applied === true（替换已落地）', result && result.applied === true, show(result && result.applied))
  check('8b-3 · 表层确实替换了', !deepEq(session.surface.nodes, beforeNodes), show(session.surface.nodes))
  check('8b-4 · 事务已闭合（补写的 end 带 error）',
    openCompaction(session) === null && session.appends.filter((x) => x.type === 'compaction/end').length === 1,
    show(session.appends.map((x) => x.type)))
  check('8b-5 · 原因里说清"已经写进表层生效"',
    typeof (result && result.reason) === 'string' && result.reason.includes('已经写进表层生效'),
    result && result.reason)
}

// 用例 9：外来检查点按原文处理、并且真被 l0 压过一次 —— 块头 ev 范围必须有真数字。
// （回归修复）
async function case9() {
  const s = fakeSession()
  s.seed.turnStart(1)
  s.seed.node('system/message', sysText('你是助手。'))
  s.seed.node('user/message', userText(W(200)))
  // 宿主压缩留下的检查点，前面还有原文 → 按 new 语义归 l0（as-raw）。
  s.seed.logOnly('compaction/start', { compactionId: 'ic-raw-1', turn: 1 })
  s.seed.node('user/message', checkpointBlock('', `<compacted-summary>${W(200, '摘')}</compacted-summary>`, 'ic-raw-1'))
  s.seed.logOnly('compaction/summary', { compactionId: 'ic-raw-1' })
  s.seed.logOnly('compaction/end', { compactionId: 'ic-raw-1', turn: 1 })
  s.seed.turnStart(2)
  s.seed.node('user/message', userText(W(160)))
  s.seed.node('assistant/message', { message: asstText(W(160)) })

  const agent = agentFor('e2e-agent-9')
  const ctx = fakeCtx(s)
  const logger = makeLogger()
  issueLicense(ctx, s, agent, logger.fn)

  // 落盘前的判定：这个检查点确实被当成原文。
  const zones = readZones(ctx, s, agent, logger.fn)
  check('9a · 检查点本身归 l0（既不进 L1、也不升 L3）',
    zones.zones.l0.some((n) => n.seq === 5) && zones.zones.l1.length === 0 && zones.zones.l3.length === 0,
    show({ l0: zones.zones.l0.map((n) => n.seq), l1: zones.zones.l1.length, l3: zones.zones.l3.length }))

  const args = { l0: { title: '第一轮', summary: W(120, '压'), to: 'T1' } }
  const result = await runCompress(ctx, agent, args, config, logger.fn)
  check('9b · 压缩成功', !!(result && result.ok), show(result && result.reason))
  const replaced = s.appends.find((a) => a.type === 'user/message')
  const text = replaced ? textOf(replaced.data) : ''
  const header = text.split('\n')[0]
  check('9c · 块头 ev 是真数字区间（不是 undefined）',
    /ev \d+–\d+/.test(header) && !header.includes('undefined'),
    header)
  check('9d · 块头轮次是 T1（as-raw 检查点没有块头，不能让它把轮号弄丢）',
    /〔L1｜T1｜/.test(header),
    header)
}

console.log('== runCompress 端到端单测（compress-e2e.test.mjs）==')

await runCase('用例1 成功路径（只压 l0）', case1)
await runCase('用例2 整批预演不写任何东西', case2)
await runCase('用例3 收益校验拒绝时 0 事件', case3)
await runCase('用例4 写 start 之后失败要补偿 end', case4)
await runCase('用例5 未闭合事务预检', case5)
await runCase('用例6 并发第二个 compress 被拒', case6)
await runCase('用例7 原文段太小', case7)
await runCase('用例8 replace 已落地但 end 补不上', case8)
await runCase('用例8b 首次写 end 失败、补写成功', case8b)
await runCase('用例9 外来检查点按原文压缩', case9)

console.log('\n—— 用例小结 ——')
for (const c of caseVerdicts) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.label}`)
}
console.log(`\n共 ${total} 项断言，失败 ${failed} 项。`)
if (failed > 0) process.exit(1)
