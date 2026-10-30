// 区间纯度（impureRange）的单元测试。
//
// 这条守卫是"横跨区界的 replace 会把当前轮或一对调用/结果一起遮掉"的兜底：
// 块是按块头分层的，块头层级与位置不一致时，l1/l2/l3 的第一块到最后一块之间
// 可能夹着原文甚至当前轮。这里直接用假 zones 喂样例，不碰宿主。

import { impureRange, imageLedger } from '../lib/compress.js'

let total = 0
let failed = 0

function check(name, cond, note) {
  total += 1
  if (cond) {
    console.log(`ok ${total} - ${name}`)
    return
  }
  failed += 1
  console.log(`not ok ${total} - ${name}`)
  if (note !== undefined) console.log(`  note: ${note}`)
}

function block(tier, title) {
  return { kind: 'block', tier, block: { tier, title, turns: [1, 2], events: [1, 2] } }
}

// 表层：原文 1、L1 块 2、原文 3、L2 块 4
const zones = {
  nodes: [11, 12, 13, 14],
  info: new Map([
    [11, { kind: 'raw' }],
    [12, block(1, '〔L1｜T1–T2｜ev 1–9〕一')],
    [13, { kind: 'raw' }],
    [14, block(2, '〔L2｜T1–T2｜ev 1–9〕二')],
  ]),
}

const pure = impureRange('l0', { startIdx: 0, endIdx: 0 }, zones)
check('l0 只覆盖原文时放行', pure === null, pure)

const mixedL0 = impureRange('l0', { startIdx: 0, endIdx: 1 }, zones)
check('l0 区间里夹着压缩块时拒绝', typeof mixedL0 === 'string' && mixedL0.includes('压缩块'), mixedL0)

const mixedL1 = impureRange('l1', { startIdx: 0, endIdx: 1 }, zones)
check('l1 区间里混进原文时拒绝', typeof mixedL1 === 'string' && mixedL1.includes('混进了原文'), mixedL1)

const pureL1 = impureRange('l1', { startIdx: 1, endIdx: 1 }, zones)
check('l1 区间只有同层块时放行', pureL1 === null, pureL1)

const wrongTier = impureRange('l1', { startIdx: 3, endIdx: 3 }, zones)
check('l1 区间里是 L2 块时拒绝', typeof wrongTier === 'string' && wrongTier.includes('L2 块'), wrongTier)

const offTable = impureRange('l2', { startIdx: 7, endIdx: 7 }, zones)
check('区间下标在表层上找不到时拒绝', typeof offTable === 'string' && offTable.includes('找不到'), offTable)

// 图片台账：压掉的内容里有图时，块正文末尾要留一行"几张、事件号是多少"，
// 否则图片被压掉之后模型永远不知道曾经有过图、也不知道去哪取。
const withImages = {
  messageFor(seq) {
    if (seq === 21) return { content: [{ type: 'text', text: '看图' }, { type: 'image', source: { type: 'base64' } }] }
    if (seq === 22) return { content: [{ type: 'text', text: '没有图' }] }
    if (seq === 23) return { content: [{ type: 'image', source: { type: 'base64' } }] }
    return null
  },
}
const two = imageLedger(withImages, [21, 22, 23])
check('两块有图：清单按事件号列出', two.seqs.join(',') === '21,23', two.seqs.join(','))
check('台账行写清张数与事件号', two.line.includes('2 张图片') && two.line.includes('21、23'), two.line)
check('台账行要求按事件号取回', two.line.includes('会话搜索'), two.line)

const none = imageLedger(withImages, [22, 99])
check('没有图片时不写台账行', none.line === '' && none.seqs.length === 0, JSON.stringify(none))

const noMapper = imageLedger({}, [21])
check('拿不到逐节点消息时不算图片（不报错、不写行）', noMapper.line === '', JSON.stringify(noMapper))

console.log(failed === 0 ? `\ncompress 断言测试全部通过（${total} 项）` : `\ncompress 断言测试失败 ${failed} / ${total}`)
if (failed !== 0) process.exitCode = 1
