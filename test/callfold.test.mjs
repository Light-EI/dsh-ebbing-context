// 断言：把「compress 调用 + 返回」折成一句短注的三条硬边界。
// 跑法：node --permission --allow-fs-read=* plugin/test/callfold.test.mjs
import assert from 'node:assert/strict'
import { rememberFold, forgetFold, foldCallRecord, foldCallRecordEx, buildNote, inspectTail, siblingCompressCount, FOLD_NOTE_HEAD, FOLD_NOTE_MARK } from '../lib/callfold.js'

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
const textMessage = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] })

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

check('同一轮里前后又调了别的工具（各自独立的消息）：不折（那一对已经进过请求）', () => {
  // 真实形态：一步一次调用——先 compress，再 pwsh、再 edit，每条助手消息只有一个调用。
  // 编辑/命令的调用已经落盘，说明含 compress 回执的那次请求早发出去了：
  // 这时再 replace 掉 [10,11]，从它往后的前缀缓存全部作废，省下的 token 远不够赔。
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
  assert.equal(foldCallRecordEx(session, queue, { foldCallRecord: true }).reason, 'not-tail')
  assert.equal(session.appends.length, 0)
  // 这一层只负责"不折"；把陈旧待折项丢掉是调用方（foldPending）的事
  assert.equal(queue.size, 1)
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
  // 第 1 行现在带'插件写的消息'自报家门（回归修复），第 2 行才是身份哨兵。
  assert.equal(note.split('\n')[0], FOLD_NOTE_HEAD + '（插件写的消息，不是你自己的话，也不是用户说的）')
  assert.equal(note.split('\n')[1], FOLD_NOTE_MARK)
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

check('末尾是别人的调用：找回自己那一对，但已经进过请求，所以不折', () => {
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
  // 能定位到（按登记的节点号），但尾部不是它 → 拒绝改写，连别人的调用也不碰
  const r = foldCallRecordEx(session, queue, { foldCallRecord: true })
  assert.equal(r.reason, 'not-tail')
  assert.equal(session.appends.length, 0)
  assert.equal(queue.size, 1)
})

check('钉住「一个字节都不动」：这一对后面还有节点时，既不折也不改写别的', () => {
  // 只多一个节点（助手发了一句文本），就足以证明含这一对的请求已经发出去了
  const session = fakeSession(
    [10, 11, 12],
    [callMessage([['compress', 'c1']]), resultMessage('c1'), textMessage('好，接着压')],
  )
  const before = session.surface.nodes.slice()
  const queue = new Map()
  rememberFold(queue, 'c1', ['x'])
  // 精确路径报 not-tail；没有 session.log 的桩走兜底路径时报 no-tail-pair——
  // 两条路都不许写表层，这才是这条用例要钉的东西。
  const reason = foldCallRecordEx(session, queue, { foldCallRecord: true }).reason
  assert.ok(reason === 'not-tail' || reason === 'no-tail-pair', `意外原因: ${reason}`)
  assert.equal(session.appends.length, 0)
  assert.deepEqual(session.surface.nodes, before)
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
const textEvent = (text) => ({
  type: 'assistant/message',
  data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
})

check('并行调用：不折、表层一个字节都不动', () => {
  // 同一条助手消息里还有兄弟调用：整段替换会连累它们（孤儿 → 每个请求 400）。
  // 这里也不去改写那条返回的正文——已经进过请求的节点一改，它后面的前缀缓存全部作废。
  const session = preciseSession([10, 11, 12, 13], {
    10: callEvent([['context_map', 'c2'], ['compress', 'c1']]),
    11: resultEvent('c2', '地图'),
    12: resultEvent('c1', 'l0 成功：甲（12 条 -> 省 800 token）\n\n' + MAP_TEXT),
    13: textEvent('接着压'),
  })
  const queue = new Map()
  rememberFold(queue, 'c1', ['x'], 12)
  const r = foldCallRecordEx(session, queue, { foldCallRecord: true })
  assert.equal(r.reason, 'parallel-call')
  assert.equal(session.appends.length, 0)
})


check('精确路径：返回被标成失败 → 不折（不能把失败说成已经成功）', () => {
  // 回归修复：以前只有退化路径查 isError，精确路径会把失败回执折成「已经成功」。
  const session = preciseSession([10, 11], {
    10: callEvent([['compress', 'c1']]),
    11: resultEvent('c1', '压缩失败：区间不对', { isError: true }),
  })
  const queue = new Map()
  rememberFold(queue, 'c1', ['x'], 10)
  const r = foldCallRecordEx(session, queue, { foldCallRecord: true })
  assert.equal(r.reason, 'error-result')
  assert.equal(session.appends.length, 0)
})

check('精确路径：贴尾的一对照常折（尾部判据在精确路径也生效）', () => {
  const session = preciseSession([10, 11], {
    10: callEvent([['compress', 'c1']]),
    11: resultEvent('c1', 'l0 成功：甲（12 条 -> 省 800 token）'),
  })
  const queue = new Map()
  rememberFold(queue, 'c1', ['l0 成功'], 10)
  const r = foldCallRecordEx(session, queue, { foldCallRecord: true })
  assert.equal(r.reason, null)
  assert.equal(session.appends.length, 1)
})

// 并发 compress 的闸门（复核二 B5）：以前只看表层最后一个节点。
// 交错批 [pwsh, compressA, compressB] 里，pwsh 的返回先落进表层 —— 末节点是那条 tool 结果，
// 计数会变成 0，闸门静默失效。现在改成往回找"第一张含工具调用的助手消息"。
check('交错批：末节点是别的工具的返回，仍能数出两个 compress', () => {
  const log = []
  log[1] = callEvent([['pwsh', 'p1'], ['compress', 'c1'], ['compress', 'c2']])
  log[2] = resultEvent('p1', '工具输出')
  log[3] = resultEvent('c1', '压缩成功')
  const session = { surface: { nodes: [1, 2, 3] }, log, deriveEventMessage: (event) => event.data.message }
  assert.equal(siblingCompressCount(session), 2)
})

check('正常单个 compress：数为 1', () => {
  const log = []
  log[1] = callEvent([['compress', 'c1']])
  log[2] = resultEvent('c1', '压缩成功')
  const session = { surface: { nodes: [1, 2] }, log, deriveEventMessage: (event) => event.data.message }
  assert.equal(siblingCompressCount(session), 1)
})

console.log(`callfold 断言测试全部通过（${passed} 项）`)
