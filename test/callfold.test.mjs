// 断言：把「compress 调用 + 返回」折成一句短注的三条硬边界。
// 跑法：node --permission --allow-fs-read=* plugin/test/callfold.test.mjs
import assert from 'node:assert/strict'
import { rememberFold, forgetFold, foldCallRecord, foldCallRecordEx, buildNote, inspectTail, shrinkReceipt, FOLD_NOTE_HEAD } from '../lib/callfold.js'

let passed = 0
const check = (name, fn) => {
  fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

// 假表层：nodes 与 deriveMessages 必须一一对齐（宿主就是这样）。
// append 一次 replace 就把 [startSeq,endSeq] 换成新节点，模拟真实的 splice 语义。
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
        const fresh = seq++
        nodes.splice(start, removed, fresh)
        messages.splice(start, removed, { role: 'user', content: data.content, source: data.source })
      }
    },
  }
  return session
}

const callMessage = (ids) => ({
  role: 'assistant',
  content: ids.map(([name, id]) => ({ type: 'tool-call', name, id, arguments: '{"x":1}' })),
})
const resultMessage = (id) => ({ role: 'tool', toolCallId: id, content: [{ type: 'text', text: '成功' }] })

check('成对时：折成一条用户消息，来源列表覆盖两个节点', () => {
  const session = fakeSession([10, 11], [callMessage([['compress', 'c1']]), resultMessage('c1')])
  const queue = new Map()
  rememberFold(queue, 'c1', ['l0 成功：标题（12 条 -> 省 800 token）'])
  const note = foldCallRecord(session, queue, { foldCallRecord: true })
  assert.equal(session.appends.length, 1)
  const one = session.appends[0]
  assert.equal(one.type, 'user/message')
  assert.deepEqual(one.opts.surfaceOp, { op: 'replace', startSeq: 10, endSeq: 11 })
  assert.deepEqual(one.opts.sourceEventSeqs, [10, 11])
  assert.equal(note.startsWith(FOLD_NOTE_HEAD), true)
  assert.equal(session.surface.nodes.length, 1)
  assert.equal(queue.size, 0)
})

check('同一轮里前后又调了别的工具（各自独立的消息）：照折', () => {
  // 真实形态：一步一次调用——先 compress，再 pwsh、再 edit，每条助手消息只有一个调用。
  const session = fakeSession(
    [10, 11, 12, 13, 14, 15],
    [
      callMessage([['compress', 'c1']]),
      resultMessage('c1'),
      callMessage([['pwsh', 'c2']]),
      resultMessage('c2'),
      callMessage([['edit', 'c3']]),
      resultMessage('c3'),
    ],
  )
  const queue = new Map()
  rememberFold(queue, 'c1', ['l0 成功：甲（3 条 -> 省 400 token）'])
  const note = foldCallRecord(session, queue, { foldCallRecord: true })
  assert.equal(typeof note, 'string')
  assert.deepEqual(session.appends[0].opts.surfaceOp, { op: 'replace', startSeq: 10, endSeq: 11 })
  assert.equal(queue.size, 0)
})

check('并行调用：放弃（不能连累别的调用变孤儿）', () => {
  const session = fakeSession([10, 11], [
    callMessage([['compress', 'c1'], ['context_map', 'c2']]),
    resultMessage('c1'),
  ])
  const queue = new Map()
  rememberFold(queue, 'c1', ['x'])
  assert.equal(foldCallRecord(session, queue, { foldCallRecord: true }), null)
  assert.equal(session.appends.length, 0)
})

check('返回对不上：放弃改写，尾巴原样', () => {
  const session = fakeSession([10, 11], [callMessage([['compress', 'c1']]), resultMessage('other')])
  const queue = new Map()
  rememberFold(queue, 'c1', ['x'])
  assert.equal(!!inspectTail(session).pair, false)
  assert.equal(foldCallRecord(session, queue, { foldCallRecord: true }), null)
  assert.equal(session.appends.length, 0)
})

check('开关关掉：一个字节都不动', () => {
  const session = fakeSession([10, 11], [callMessage([['compress', 'c1']]), resultMessage('c1')])
  const queue = new Map()
  rememberFold(queue, 'c1', ['x'])
  assert.equal(foldCallRecord(session, queue, { foldCallRecord: false }), null)
  assert.equal(session.appends.length, 0)
  assert.equal(queue.size, 1)
})

check('短注正文：带抬头、带每条结果、不提任何工具名', () => {
  const note = buildNote(['l3 成功：甲（3 条 -> 省 400 token）', 'l2 成功：乙（2 条 -> 省 300 token）'])
  assert.equal(note.split('\n')[0], FOLD_NOTE_HEAD + '你刚刚做过一次分层压缩，已经成功：')
  assert.equal(note.includes('- l3 成功：甲'), true)
  // 提工具名会诱导模型为了"看一眼"再调一次；而地图只给标题，那趟白花钱。
  assert.equal(note.includes('context_map'), false)
  assert.equal(note.toLowerCase().includes('compress'), false)
  assert.equal(note.includes('已经在你的上下文里'), true)
})

check('待折叠队列有上限：不会随会话无限长', () => {
  const queue = new Map()
  for (let i = 0; i < 10; i += 1) rememberFold(queue, `c${i}`, ['x'])
  assert.equal(queue.size <= 4, true)
})

// 宿主会跳过"内容为空的 system/developer/assistant 消息"（session:222-226），
// 此时 messages 的下标与 surface.nodes 整体错位——用 messages 的下标去取 nodes，
// 换掉的就是别的节点。所以折叠不按下标定位，而按 rememberFold 记下的节点号定位。
check('下标错位但有记录的节点号：照样精确折到那一对（不再一票否决）', () => {
  const nodes = [7, 8, 9] // 7 是内容为空的 assistant，不进 messages
  const messages = [callMessage([['compress', 'c1']]), resultMessage('c1')]
  const session = fakeSession(nodes, messages)
  const queue = new Map()
  rememberFold(queue, 'c1', ['x'], 8) // 调用落在节点 8 上
  assert.equal(typeof foldCallRecord(session, queue, { foldCallRecord: true }), 'string')
  assert.deepEqual(session.appends[0].opts.surfaceOp, { op: 'replace', startSeq: 8, endSeq: 9 })
  assert.equal(queue.size, 0)
})

check('下标错位且没有记录的节点号（旧队列项）：一个字节都不动', () => {
  const nodes = [7, 8, 9]
  const messages = [callMessage([['compress', 'c1']]), resultMessage('c1')]
  const session = fakeSession(nodes, messages)
  const queue = new Map()
  rememberFold(queue, 'c1', ['x'])
  assert.equal(foldCallRecord(session, queue, { foldCallRecord: true }), null)
  assert.equal(session.appends.length, 0)
  assert.equal(queue.size, 1)
})

check('末尾是别人的调用：按登记过的节点号找回自己那一对，不多折别人', () => {
  const session = fakeSession(
    [10, 11, 12, 13],
    [
      callMessage([['compress', 'c1']]),
      resultMessage('c1'),
      callMessage([['pwsh', 'c2']]),
      resultMessage('c2'),
    ],
  )
  const queue = new Map()
  rememberFold(queue, 'c1', ['x'], 10)
  assert.equal(typeof foldCallRecord(session, queue, { foldCallRecord: true }), 'string')
  assert.deepEqual(session.appends[0].opts.surfaceOp, { op: 'replace', startSeq: 10, endSeq: 11 })
  assert.equal(queue.size, 0)
})

check('返回是失败的：不折（短注说"已经成功"会变成假话）', () => {
  const failed = { role: 'tool', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: '失败' }] }
  const session = fakeSession([10, 11], [callMessage([['compress', 'c1']]), failed])
  const queue = new Map()
  rememberFold(queue, 'c1', ['x'])
  assert.equal(foldCallRecord(session, queue, { foldCallRecord: true }), null)
  assert.equal(session.appends.length, 0)
})

check('同一个 callId 出现两次：整条放弃，不折', () => {
  const queue = new Map()
  rememberFold(queue, 'c1', ['成功'])
  rememberFold(queue, 'c1', ['失败'])
  assert.equal(queue.has('c1'), false)
})

check('同 callId 的下一次调用一开始就作废旧待折项', () => {
  const queue = new Map()
  rememberFold(queue, 'c1', ['上一轮成功'])
  forgetFold(queue, 'c1')
  assert.equal(queue.has('c1'), false)
  assert.equal(queue.size, 0)
})

check('上一次成功没折成、这一次同 id 失败：不会被折成「已经成功」', () => {
  // 真实形态：callId 只在同一条助手消息内保证唯一，跨消息可以复用。
  const failed = { role: 'tool', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: '没能压缩：地图过期' }] }
  const session = fakeSession([10, 11], [callMessage([['compress', 'c1']]), failed])
  const queue = new Map()
  rememberFold(queue, 'c1', ['上一轮成功'])
  forgetFold(queue, 'c1') // 这次 compress 开始时就作废了
  assert.equal(foldCallRecord(session, queue, { foldCallRecord: true }), null)
  assert.equal(session.appends.length, 0)
})

// ---- 下面三组用"精确路径"的假会话：有 log 与 deriveEventMessage，
// 于是可以按 callId 找配对，也能验证"只改返回正文"的那条路。 ----

const MAP_TEXT = '区域   已用   区上限\nl1  1.2k  20k\n\n压缩须知：只压已经结束的轮次。'

function preciseSession(nodes, events) {
  let seq = 9000
  // 真实的 session.log 是按事件号索引的数组，所以这里也拼成稀疏数组（下标 = 事件号）。
  const log = []
  for (const [k, v] of Object.entries(events)) log[Number(k)] = v
  const session = {
    appends: [],
    log,
    get surface() {
      return { nodes: nodes.slice() }
    },
    deriveEventMessage(event) {
      return event && event.data && event.data.message ? event.data.message : null
    },
    deriveMessages() {
      return nodes.map((n) => session.deriveEventMessage(log[n])).filter(Boolean)
    },
    append(type, data, opts) {
      session.appends.push({ type, data, opts })
      if (opts && opts.surfaceOp) {
        const at = nodes.indexOf(opts.surfaceOp.startSeq)
        if (at >= 0) nodes[at] = seq++
      }
    },
  }
  return session
}

const callEvent = (ids) => ({
  type: 'assistant/message',
  data: {
    message: {
      role: 'assistant',
      content: ids.map(([name, id]) => ({ type: 'tool-call', name, id, arguments: '{}' })),
    },
  },
})
const resultEvent = (id, text, extra) => ({
  type: 'tool/result',
  data: { message: { role: 'tool', toolCallId: id, content: [{ type: 'text', text }], ...(extra || {}) } },
})

check('失败回执：只折地图、错误原因逐字留着，且除 content 外字段不变', () => {
  const failed = '没能压缩：地图过期了\n\n' + MAP_TEXT
  const session = preciseSession([10, 11], { 10: callEvent([['compress', 'c1']]), 11: resultEvent('c1', failed) })
  const r = shrinkReceipt(session, null)
  assert.equal(r.done, true)
  assert.equal(r.kind, 'failed')
  assert.equal(session.appends.length, 1)
  const one = session.appends[0]
  assert.deepEqual(one.opts.surfaceOp, { op: 'replace', startSeq: 11, endSeq: 11 })
  assert.deepEqual(one.opts.sourceEventSeqs, [11])
  const text = one.data.message.content[0].text
  assert.equal(text.startsWith('没能压缩：地图过期了'), true, text)
  assert.equal(text.includes('压缩须知'), false, '地图必须被折掉')
  assert.equal(text.includes('地图已折叠'), true)
  // 除 content 之外逐字段相同（宿主对 tool/result 替换的硬要求）
  assert.equal(one.data.message.toolCallId, 'c1')
  assert.equal(one.data.message.role, 'tool')
})

check('失败回执的 isError 等字段原样保留', () => {
  const session = preciseSession([10, 11], {
    10: callEvent([['compress', 'c1']]),
    11: resultEvent('c1', '没能压缩：x\n\n' + MAP_TEXT, { isError: true }),
  })
  const r = shrinkReceipt(session, null)
  assert.equal(r.done, true)
  assert.equal(session.appends[0].data.message.isError, true)
})

check('并行调用：不整段替换，只收紧返回正文并销掉待折项', () => {
  const nodes = [10, 11, 12]
  const session = preciseSession(nodes, {
    10: callEvent([['compress', 'c1'], ['context_map', 'c2']]),
    11: resultEvent('c2', '地图'), // 兄弟调用的返回
    12: resultEvent('c1', 'l0 成功：甲（12 条 -> 省 800 token）\n\n' + MAP_TEXT),
  })
  const queue = new Map()
  rememberFold(queue, 'c1', ['x'], 10)
  // 精确路径先认出"这条消息里还有别的调用"，因此拒绝整段替换
  assert.equal(foldCallRecordEx(session, queue, { foldCallRecord: true }).reason, 'parallel-call')
  const r = shrinkReceipt(session, queue)
  assert.equal(r.done, true)
  assert.equal(r.kind, 'parallel')
  assert.deepEqual(session.appends[0].opts.surfaceOp, { op: 'replace', startSeq: 12, endSeq: 12 })
  const body = session.appends[0].data.message.content[0].text
  assert.equal(body.includes('压缩须知'), false)
  // 地图三段的抬头一行都不能漏：切点是「上下文 …」那行，后面整段都不该留下。
  assert.equal(body.includes('上下文 '), false)
  assert.equal(body.includes('下面是分层占用'), false)
  assert.equal(body.includes('区域 '), false)
  // 每个键的结果必须留着：压了哪几层、省了多少，是模型接着压的依据。
  assert.equal(body.includes('l0 成功：甲（12 条 -> 省 800 token）'), true)
  assert.equal(body.includes('context_map'), true)
  // 并行这件事必须当场说清：这条回执是模型唯一能读到"别再并行"的地方。
  assert.equal(body.includes('并行发'), true)
  assert.equal(body.includes('单独发成一条消息'), true)
  assert.equal(queue.has('c1'), false)
})

check('不是我们的返回（没有地图）：一个字节都不动', () => {
  const session = preciseSession([10, 11], { 10: callEvent([['pwsh', 'c9']]), 11: resultEvent('c9', '普通输出') })
  assert.equal(shrinkReceipt(session, new Map()).done, false)
  assert.equal(session.appends.length, 0)
})

console.log(`callfold 断言测试全部通过（${passed} 项）`)
