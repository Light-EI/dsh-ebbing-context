// 配置页文案与默认值的一致性断言（"改文案等于改逻辑"：面板里写死的数字必须跟 DEFAULTS 同源）。
// 跑法：node plugin/test/client.test.mjs
import { readFileSync } from 'node:fs'
import { DEFAULTS } from '../lib/config.js'

const text = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) {
    failed++
    console.error(`FAIL ${name}${detail ? `：${detail}` : ''}`)
  }
}

// 2026-11-08 发现的漂移：面板举例还写着旧默认 60000/24000，而 growthTokens 默认 65000、40% = 26000。
const growth = DEFAULTS.notice.growthTokens
const resetPct = DEFAULTS.notice.growthResetPct
const reset = Math.max(1, Math.round(growth * (resetPct / 100)))
check('增长门槛重设文案用现值（不是旧默认 60000/24000）',
  text.includes(`原额 ${growth}`) && text.includes(`再长 ${reset}`), `应为 原额 ${growth} / 再长 ${reset}`)
check('页面文案不残留旧默认数 60000 / 24000', !/60000|24000/.test(text))

// keepTurns 的 cutoff 在 resolveTurnAnchor 里是「当前轮 − 1 − N」；文案写「当前轮 − N」等于少算一轮。
check('keepTurns 文案写「当前轮 − 1 − N」', text.includes('当前轮 − 1 − N'))

// 提醒正文与工具描述的口径是「在一次压缩中完成，不要分多次压缩」；面板不能教相反的做法。
check('单块超限的说明不教「分几次压」', !text.includes('分几次压'))

// 原文事件仍在会话日志里、可按事件号读回；说「永久丢失」与取回口径矛盾。
check('页面注意不写「细节永久丢失」', !text.includes('永久丢失'))

if (failed) {
  console.error(`client 文案断言 ${failed} 项失败`)
  process.exit(1)
}
console.log('client 文案断言全部通过（5 项）')
