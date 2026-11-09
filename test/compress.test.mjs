// 区间纯度（impureRange）的单元测试。
//
// 这条守卫是"横跨区界的 replace 会把当前轮或一对调用/结果一起遮掉"的兜底：
// 块是按块头分层的，块头层级与位置不一致时，l1/l2/l3 的第一块到最后一块之间
// 可能夹着原文甚至当前轮。这里直接用假 zones 喂样例，不碰宿主。

import { readFileSync } from 'node:fs'
import { impureRange, imageLedger, boundaryLine, checkShape } from '../lib/compress.js'

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
check('台账行要求按事件号取回，并指明用哪个工具', two.line.includes('事件号') && two.line.includes('session_event_read'), two.line)

const none = imageLedger(withImages, [22, 99])
check('没有图片时不写台账行', none.line === '' && none.seqs.length === 0, JSON.stringify(none))

// 一条消息里多张图：张数按图片块数算，不按消息数算（成本侧本来就是按块累加的，
// 两处口径必须一致，否则台账写 2 张、省钱按 5 张算，模型按台账也找回不全）。
const multiImage = {
  messageFor(seq) {
    if (seq === 30) {
      return {
        content: [
          { type: 'text', text: '三张图' },
          { type: 'image', source: { type: 'base64' } },
          { type: 'image', source: { type: 'base64' } },
          { type: 'image', source: { type: 'base64' } },
        ],
      }
    }
    if (seq === 31) return { content: [{ type: 'image' }, { type: 'image' }] }
    return null
  },
}
const multi = imageLedger(multiImage, [30, 31])
check('一条消息多张图：张数按图片块数算（3+2=5）', multi.count === 5, String(multi.count))
check('一条消息多张图：台账行写 5 张', multi.line.includes('5 张图片'), multi.line)

const noMapper = imageLedger({}, [21])
check('拿不到逐节点消息时不算图片（不报错、不写行）', noMapper.line === '', JSON.stringify(noMapper))

// 上一层只列前 6 个事件号，但"张数"必须是真数：合并时按它写的总数接手，
// 而不是按它列出来的几个号重算（回归修复：100 张会被缩成 6 张）。
const bigLedger = '〔L2｜T1–T2｜ev 1–26〕旧块\n\n〔这块压掉了 100 张图片（事件号 21、22、23、24、25、26 等）。需要时用 session_event_read 按事件号读。〕'
const inherited = imageLedger({ messageFor: (seq) => (seq === 50 ? { content: [{ type: 'text', text: bigLedger }] } : null) }, [50])
check('合并旧块时台账张数取上一层总数（不按列出的号数重算）', inherited.count === 100, String(inherited.count))
check('合并后台账行仍写真实张数', inherited.line.includes('100 张图片'), inherited.line)

// 交界声明：压 l0 才会写，且轮号是 to+1。
// 为什么必须有：压完之后，原本标着「下一轮 T16」的那条轮次标记被并进了块里，
// 交界处就再也没有轮号了——模型会分不清紧挨着的原文是 T16 还是 T16–T17。
const b0 = boundaryLine('l0', 'T15')
check('l0 的产物写下交界：其下第一条原文轮次是 to+1', b0.includes('T16') && b0.includes('原文区'), b0)
check('交界声明标明是"写就时"（以后下面的轮次被压掉也不会变成假话）', b0.includes('本块写就时'), b0)
check('l1/l2/l3 的产物不写交界（它们不产生新的 L0 边界）', boundaryLine('l1', 'T15') === '' && boundaryLine('l2', 'T1') === '' && boundaryLine('l3', 'T3') === '')
check('to 不是 T 号时不写（宁可没有，也不写错的轮号）', boundaryLine('l0', '') === '' && boundaryLine('l0', undefined) === '')
// 空轮（有 turn/start、没有任何表层节点）会让 to+1 指空：必须取块后第一个真有原文的轮。
const gapZones = { zones: { l0: [{ seq: 1, turn: 16 }, { seq: 2, turn: 18 }] } }
const bGap = boundaryLine('l0', 'T17', gapZones)
check('交界行跳过空轮：T18 才有原文时写 T18 而不是 T18 之外的号', bGap.includes('T18'), bGap)

// 回归修复：普通消息正文里引用"这块压掉了 3 张图片（事件号 5、6、7）"
// 不是我们写的台账——它没有块头，认了会产出互斥的两个事件号区间。
const proseLedger = imageLedger({ messageFor: (seq) => (seq === 60 ? { content: [{ type: 'text', text: '笔记：〔这块压掉了 3 张图片（事件号 5、6、7）〕' }] } : null) }, [60])
check('正文里引用的台账句不算（没有块头就不接手）', proseLedger.count === 0 && proseLedger.line === '', JSON.stringify(proseLedger))

// 2026-11-09 用户实测踩到的坑：漏写 to 时，拒绝文案把参数说明里的格式示例 T19 当成
// "轮锚点"念出来，看起来像在要求写 T19。最终口径：拒绝只指向地图里的真实轮号，且不出现任何示例轮号。
const missL0 = checkShape({ l0: { title: 't', summary: 's' } })
check('l0 漏写 to 的拒绝只指向地图、不出现任何示例轮号',
  missL0.ok === false && missL0.reason.includes('地图') && !missL0.reason.includes('T19') && !/T\d/.test(missL0.reason),
  missL0.reason)
const missL1 = checkShape({ l1: { title: 't', summary: 's' } })
check('l1 漏写 to 的拒绝说块序号、指向地图',
  missL1.ok === false && missL1.reason.includes('块序号') && missL1.reason.includes('地图'), missL1.reason)
const numTo = checkShape({ l0: { title: 't', summary: 's', to: 117 } })
check('to 写成数字时拒绝并解释字符串写法', numTo.ok === false && numTo.reason.includes('字符串'), numTo.reason)

// 参数说明每轮都发，里面若写死一个示例轮号，比拒绝文案更容易被模型照抄（2026-11-09 用户追问后的收紧）。
const schemaSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
check('compress 的 to 参数说明不写死示例轮号、且要求只抄一个号', !schemaSrc.includes('如 T19') && schemaSrc.includes('地图「可压位置」里抄一个 T 号') && schemaSrc.includes('不能写成区间'))
// 用户裁定（2026-11-09）：可压段 = 已结束、不在保护圈，不等于里面的工作做完了；写最大号前要说清这层区别。
check('compress 描述说明可压段不等于已完成', schemaSrc.includes('可压段只是"已结束、不在保护圈"') && schemaSrc.includes('不代表里面的事都做完了'))

// 参数不是对象时的形状示例同样不能写死一个可被照抄的轮号。
const shapeHint = checkShape(null)
check('参数形状示例不写死轮号、指向地图', shapeHint.ok === false && !/T19/.test(shapeHint.reason) && shapeHint.reason.includes('地图'), shapeHint.reason)
// 地图里「可写 to=T99–T102 / 1–6」是可选范围，不是让照抄整段区间；另一个会话的模型实测抄了区间。
const rangeL0 = checkShape({ l0: { title: 't', summary: 's', to: 'T99–T102' } })
check('l0 的 to 写成区间时拒因直接说该写哪个',
  rangeL0.ok === false && rangeL0.reason.includes('区间') && rangeL0.reason.includes('T102'), rangeL0.reason)
const rangeL1 = checkShape({ l1: { title: 't', summary: 's', to: '1–6' } })
check('l1 的 to 写成区间时拒因直接说该写哪个',
  rangeL1.ok === false && rangeL1.reason.includes('区间') && rangeL1.reason.includes('6'), rangeL1.reason)
// 地图现在的主形态是省略号（T124…T130 / 1…8）：区间守卫必须认识它，否则拒因退化成泛泛的「收到的是 …」。
const ellL0 = checkShape({ l0: { title: 't', summary: 's', to: 'T124…T130' } })
check('l0 抄地图的省略号区间时拒因直接说该写 T130',
  ellL0.ok === false && ellL0.reason.includes('区间') && ellL0.reason.includes('T130'), ellL0.reason)
const ellL1 = checkShape({ l1: { title: 't', summary: 's', to: '1…8' } })
check('l1 抄地图的省略号区间时拒因直接说该写 8',
  ellL1.ok === false && ellL1.reason.includes('区间') && ellL1.reason.includes('8'), ellL1.reason)
check('单个轮号仍然放行', checkShape({ l0: { title: 't', summary: 's', to: 'T102' } }).ok === true)
if (failed !== 0) process.exitCode = 1

console.log(failed === 0 ? `\ncompress 断言测试全部通过（${total} 项）` : `\ncompress 断言测试失败 ${failed} / ${total}`)
