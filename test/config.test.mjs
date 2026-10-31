// 配置校验的断言测试（不是冒烟：失败会以非零退出码结束）。
// 跑法：node plugin/test/config.test.mjs
import { readFileSync } from 'node:fs'
import { validateConfig, DEFAULTS } from '../lib/config.js'

const KNOWN_TOP = ['budget', 'segment', 'title', 'notice', 'pruneFirst', 'foldCallRecord', 'requireSessionQuery', 'reservedTokens', 'triggerPct', 'keepTurns']

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

// patch 模板本身就是一份真配置：缩进错一层会让插件"启动即拒绝"（0.1.11 就是这样翻车的）。
// 测试只验内存对象是抓不到这个的，所以直接解析模板、按缩进还原层级再验一遍。
{
  const yml = readFileSync(new URL('../dsh.bundle.patch.yml', import.meta.url), 'utf8').split(/\r?\n/)
  const top = new Set()
  const sub = new Map()
  let cur = null
  for (const line of yml) {
    if (/^\s*#/.test(line) || !line.trim()) continue
    const m = /^( *)([A-Za-z][\w]*):\s*(.*)$/.exec(line)
    if (!m) continue
    const depth = m[1].length
    if (depth === 8) { top.add(m[2]); cur = m[2] }
    else if (depth === 10 && cur) {
      if (!sub.has(cur)) sub.set(cur, [])
      sub.get(cur).push(m[2])
    }
  }
  const bad = [...top].filter((k) => !KNOWN_TOP.includes(k))
  if (bad.length) { console.error('FAIL patch 模板里有未知的顶层键: ' + bad.join(',')); failed++ }
  const noticeSubs = sub.get('notice') || []
  for (const k of noticeSubs) {
    if (!['enabled', 'growthTokens', 'growthResetPct', 'notifySubagents'].includes(k)) {
      console.error('FAIL patch 模板 notice 组里有未知子键: ' + k); failed++
    }
  }
  if (!top.has('notice')) { console.error('FAIL patch 模板缺 notice 组'); failed++ }
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
// 不压之后门槛重设到原额的百分之多少（用户 m15172）：0~100 的百分数，默认 40
accept('notice.growthResetPct = 0（下一轮立刻再触发）', { notice: { growthResetPct: 0 } })
accept('notice.growthResetPct = 50（原额的一半）', { notice: { growthResetPct: 50 } })
reject('notice.growthResetPct 超值', { notice: { growthResetPct: 120 } }, 'notice.growthResetPct 不能大于')
if (DEFAULTS.notice.growthResetPct !== 40) {
  console.error('FAIL DEFAULTS.notice.growthResetPct 应为 40（默认按原额四成重设）')
  failed++
}
// 子代理默认参与（用户 m16497）：它们也会看到已压缩的表层，没有轮次标记就会误读块覆盖了哪几轮。
if (DEFAULTS.notice.notifySubagents !== true) {
  console.error('FAIL DEFAULTS.notice.notifySubagents 应为 true（子代理也要拿轮次标记）')
  failed++
}
accept('notice.notifySubagents = false（想安静时关掉）', { notice: { notifySubagents: false } })
reject('notice.notifySubagents 写成字符串', { notice: { notifySubagents: 'yes' } }, '应该是 true 或 false')
// 0.1.11 的模板把 notifySubagents 写到了根上：装过那版的人不能因此启动即失败
{
  const migrated = { notifySubagents: true }
  validateConfig(migrated)
  if (!migrated.notice || migrated.notice.notifySubagents !== true || "notifySubagents" in migrated) {
    console.error("FAIL 根级 notifySubagents 应被迁到 notice.notifySubagents")
    failed++
  }
}
// 语言项已整体删除：再写 lang 必须被当成未知子键拒绝
reject('title.lang 已删除', { title: { lang: 'en' } }, 'title.lang 不认识')
// 深合并的前提：默认值本身是完整的（缺了它，只写 lang 会把 maxTokens 一起吃掉）
if (DEFAULTS.title.maxTokens !== 50 || 'lang' in DEFAULTS.title) {
  console.error('FAIL DEFAULTS.title 不完整，深合并会丢键')
  failed++
}


// 老配置项迁移（审计 A-G2）：forgivePct 改名 growthResetPct 之后不许让老 profile 起不来。
try {
  const migrated = { notice: { forgivePct: 70 } }
  validateConfig(migrated)
  if (migrated.notice.growthResetPct !== 70 || "forgivePct" in migrated.notice) {
    console.error("FAIL forgivePct 没有被迁移成 growthResetPct")
    failed += 1
  }
} catch (error) {
  console.error("FAIL 老配置 forgivePct 让插件拒绝启动：" + error.message)
  failed += 1
}
if (failed) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('config 断言测试全部通过（' + 14 + ' 项）')
