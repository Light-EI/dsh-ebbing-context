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
check('地图带可压位置段', /可压位置/.test(text))
check('地图带压缩须知段', /压缩须知/.test(text))
check('地图给出 l0 的轮号范围写法', /可写 to=T\d+–T\d+|暂不可用/.test(text))
check('地图给出 l1/l2 的块序号范围写法', /可写 to=1–\d+|暂不可用/.test(text))

if (failed) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log(`map 断言测试全部通过（${total} 项）`)
