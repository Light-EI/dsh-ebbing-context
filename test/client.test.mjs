// 配置页文案与默认值的一致性断言（"改文案等于改逻辑"：面板里写死的数字必须跟 DEFAULTS 同源）。
// 另加中英两套文案的覆盖断言：每个字段、每组、每条面板文案都必须有对应译文；界面按宿主语言只显示一套。
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

// —— 双语覆盖（2026-11-09） ——
// 面板是「中文为主、英文为辅」：每个字段的中文标签/说明、每组名、面板级文案都要有英文对应。
const count = (re) => (text.match(re) || []).length
// 字段数用 path 数组数认（label: 之类还会撞上面板按钮的 detail 文案，不能直接数）。
const fieldCount = count(/\bpath: \[/g)
const groupNames = [...text.matchAll(/\bgroup: '([^']+)'/g)].map((m) => m[1])
const groupNamesEn = [...text.matchAll(/\bgroupEn: '([^']+)'/g)].map((m) => m[1])
const groupPairs = new Set(groupNames.map((g, i) => g + ' => ' + groupNamesEn[i]))
const labelEn = count(/\blabelEn: '/g)
const detailEn = count(/\bdetailEn: '/g)
const groupEn = count(/\bgroupEn: '/g)
check('每个字段都有英文标签', fieldCount > 0 && labelEn === fieldCount, `fields ${fieldCount} / labelEn ${labelEn}`)
check('每个字段都有英文说明', fieldCount > 0 && detailEn === fieldCount, `fields ${fieldCount} / detailEn ${detailEn}`)
check('每一组都有英文组名', groupNames.length === fieldCount && groupPairs.size === new Set(groupNames).size,
  `字段 ${groupNames.length} / 组对 ${groupPairs.size} / 组 ${new Set(groupNames).size}`)
check('面板级文案有英文块', text.includes("title: 'Ebbing Context'") && text.includes('hint:'), '缺少 TEXT.en')
check('渲染确实用了英文标签与说明', text.includes('item.labelEn') && text.includes('item.detailEn'))
check('按钮/横幅文案随当前语言取', text.includes('const T = zh ? TEXT.zh : TEXT.en') && text.includes('T.save') && text.includes('T.note') && text.includes('zh ? banner.zh : banner.en'))
// 英文侧同样不能残留旧默认数（整文件检查已在上面做过，这里再钉一次英文块里的增长阈值）。
check('英文说明里的增长阈值与默认值同源', text.includes(`an original threshold of ${growth}`) && text.includes(`another ${reset} tokens`))

// —— 设置面板独立页（2026-11-10） ——
// 设置弹窗左侧导航的 settings.section 页：和「通知提醒」同一层，数据走 ui-settings 的共享表单。
check('注册了设置面板独立页 settings.section', text.includes("name: 'settings.section'") && text.includes('whileServed([CONFIG_NS]'))
check('设置页跟随宿主服务的命名空间（停用时不留空页）', text.includes('forms.whileServed') && text.includes('forms.get(CONFIG_NS)'))
check('设置页导航 id/位置固定', text.includes("id: 'ebbing-context'") && text.includes('order: 46'))
check('configForms / locale 用 ctx.inject 等待服务（不拖垮插件行配置页）',
  text.includes("inject: ['slots']")
  && /ctx\.inject\(\s*\[\s*'configForms'\s*,\s*'locale'\s*\]/.test(text)
  && /ctx\.inject\(\s*\[\s*'locale'\s*\]/.test(text))

// —— 标题与文案（2026-11-10） ——
// 设置页标题：中文「EC上下文设置」、英文「Ebbing Context」；跟宿主 locale 走。
check('标题中英为 EC上下文设置 / Ebbing Context',
  text.includes("title: 'EC上下文设置'") && text.includes("title: 'Ebbing Context'"))
check('标题与正文用同一个语言判据（不注册词典）',
  /const pageTitle[\s\S]{0,80}activeLocale\(\)/.test(text) && !text.includes('LOCALE_NS'))
check('增长门槛重设标签写明「模型主动拒绝」',
  text.includes('模型主动拒绝之后门槛重设到原额的百分比') && text.includes('Threshold reset after the model declines (%)'))

// —— 单语言渲染（2026-11-10） ——
// 界面只显示宿主当前语言：两套文案都必须保留（改文案时两边一起改），渲染时二选一。
check('渲染按当前语言二选一', text.includes('const T = zh ? TEXT.zh : TEXT.en') && text.includes('zh ? item.label : item.labelEn'))
check('说明也按语言二选一', text.includes('zh ? item.detail : item.detailEn'))
// 不再中英拼接：只留一条正则覆盖两种引号/模板串常见写法，行为面由 client-render 断言。
check('不再中英同屏拼接', !/["'`] \/ ["'`]\s*\+/.test(text))

if (failed) {
  console.error(`client 文案断言 ${failed} 项失败`)
  process.exit(1)
}
console.log('client 文案、语言与设置页断言全部通过（22 项）')
