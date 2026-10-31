// 配置校验的断言测试（不是冒烟：失败会以非零退出码结束）。
// 跑法：node plugin/test/config.test.mjs
import { validateConfig, DEFAULTS } from '../lib/config.js'

let failed = 0
const reject = (name, cfg, mustInclude) => {
  try {
    validateConfig(cfg)
    console.error(`FAIL 应拒绝但通过了: ${name}`)
    failed++
  } catch (error) {
    if (mustInclude && !String(error.message).includes(mustInclude)) {
      console.error(`FAIL 拒绝消息里没有「${mustInclude}」: ${name}`)
      failed++
    }
  }
}
const accept = (name, cfg) => {
  try {
    validateConfig(cfg)
  } catch (error) {
    console.error(`FAIL 应放行但拒绝了: ${name} :: ${error.message}`)
    failed++
  }
}

// 分组必须是对象：写成数字 / 数组 / false 都不能静默回退到默认值
reject('budget 传数字', { budget: 42 }, 'budget 应该是对象')
reject('segment 传数组', { segment: [] }, 'segment 应该是对象')
reject('notice 传 false', { notice: false }, 'notice 应该是对象')
reject('title 传字符串', { title: 'zh' }, 'title 应该是对象')

// 未知键（拼错）必须拒绝，否则用户以为设上了、实际用的是默认值
reject('顶层拼错', { bagdet: {} }, '不认识的配置项')
reject('budget 子键拼错', { budget: { l4: 0.1 } }, 'budget.l4 不认识')
// triggerPct 在根上，不在 notice 里：写进 notice 必须拒绝（曾漏过一个）
reject('notice.triggerPct', { notice: { triggerPct: 0.5 } }, 'notice.triggerPct 不认识')

// 数值域
reject('triggerPct 超出范围', { triggerPct: 1.5 }, 'triggerPct 不能大于')

// 正常配置必须放行（含只写一半的分组，靠深合并补默认值）
accept('空配置', {})
accept('只写 budget.l1', { budget: { l1: 0.1 } })
accept('只写 title.maxTokens', { title: { maxTokens: 60 } })
// 不压时退回多少增长额度（用户 m14431 第 3 条）：0~100 的百分数，默认 100
accept('notice.forgivePct = 0（一分不退）', { notice: { forgivePct: 0 } })
accept('notice.forgivePct = 50（退一半）', { notice: { forgivePct: 50 } })
reject('notice.forgivePct 超值', { notice: { forgivePct: 120 } }, 'notice.forgivePct 不能大于')
if (DEFAULTS.notice.forgivePct !== 100) {
  console.error('FAIL DEFAULTS.notice.forgivePct 应为 100（默认全额退回）')
  failed++
}
// 语言项已整体删除：再写 lang 必须被当成未知子键拒绝
reject('title.lang 已删除', { title: { lang: 'en' } }, 'title.lang 不认识')
// 深合并的前提：默认值本身是完整的（缺了它，只写 lang 会把 maxTokens 一起吃掉）
if (DEFAULTS.title.maxTokens !== 50 || 'lang' in DEFAULTS.title) {
  console.error('FAIL DEFAULTS.title 不完整，深合并会丢键')
  failed++
}

if (failed) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('config 断言测试全部通过（' + 14 + ' 项）')
