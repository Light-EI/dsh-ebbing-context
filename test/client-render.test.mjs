// 配置页渲染冒烟测试：用极简 React 替身把 ConfigPage 真跑一遍，确认
// 1) client.js 能加载、不抛异常；2) 界面只显示宿主当前语言（中文只出中文、英文只出英文、拿不到 locale 退回中文）；
// 3) 设置面板的 settings.section 页也注册出来、并复用同一份表单渲染；
// 4) 可选服务缺失时插件行配置页仍在（configForms 缺失 → 设置页不出现；locale 缺失 → 退回中文）；
// 5) 服务晚到（apply 时没有、之后才 provide）时设置页仍会出现；
// 6) 语言切换后标题与正文跟着变。
// 跑法：node plugin/test/client-render.test.mjs
import { readFileSync } from 'node:fs'

let captured = null
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  // 真跑 effect：让 locale/configForms 的订阅真的挂上，才能测到语言切换。
  useEffect: (fn) => {
    const off = fn()
    return typeof off === 'function' ? off : undefined
  },
  useMemo: (fn) => fn(),
}
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry
    },
  },
}

await import('../client.js')

const mod = captured && captured.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error('unexpected require: ' + name)
})

// 共享配置表单的替身：settings.section 页通过 ui-settings 的 configForms 读同一份配置。
const snapshot = { status: 'ready', value: {}, revision: 7, writable: true }
const fakeFormController = {
  getSnapshot: () => snapshot,
  subscribe: () => () => {},
  mutate: async () => true,
}
const makeForms = () => ({
  get: () => fakeFormController,
  whileServed: (_namespaces, register) => {
    const off = register(new Set(['dsh-ebbing-context']))
    return typeof off === 'function' ? off : () => {}
  },
})
const makeSlots = (registrations) => ({
  inject: (_name, fn) => fn(),
  register: (def, comp) => {
    registrations.push({ def, comp })
    return () => {}
  },
})
const append = (strings, node) => {
  if (node === null || node === undefined || node === false) return
  if (typeof node === 'string' || typeof node === 'number') { strings.push(String(node)); return }
  if (Array.isArray(node)) { node.forEach((item) => append(strings, item)); return }
  // 极简替身不渲染函数组件：遇到 createElement(Component, props) 就当场调用它。
  if (node && typeof node.type === 'function') { append(strings, node.type(node.props || {})); return }
  if (node && node.children) node.children.forEach((child) => append(strings, child))
}
const render = (component, props) => {
  const strings = []
  append(strings, component(props))
  return strings.join('\n')
}
const state = { revision: 1, writable: true, status: 'ready', value: {} }
const pageProps = { view: 'page', form: { state, mutate: async () => true } }

// 宿主 locale 服务替身：getLocale / subscribe（可切换语言）。
function makeLocale(initial) {
  let active = initial
  const listeners = new Set()
  return {
    getLocale: () => ({ active, locales: [], revision: 1 }),
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    setActive: (next) => {
      active = next
      for (const fn of [...listeners]) fn()
    },
    listenerCount: () => listeners.size,
  }
}

// 迷你宿主上下文：硬依赖只有 slots；ctx.inject 等声明的服务都出现才跑回调（模拟 cordis 语义），
// 服务晚到时由 provide() 触发已经挂起的回调——这正是要测的竞态。
function makeHost() {
  const regs = []
  const services = {}
  const pending = []
  const ctx = {
    slots: makeSlots(regs),
    effect: (fn) => {
      const off = fn()
      return typeof off === 'function' ? off : () => {}
    },
    inject: (names, cb) => {
      const run = () => {
        const scope = { ...ctx }
        for (const n of names) scope[n] = services[n]
        cb(scope)
      }
      if (names.every((n) => services[n] !== undefined)) run()
      else pending.push({ names, run })
    },
  }
  return {
    ctx,
    regs,
    services,
    provide(name, value) {
      services[name] = value
      let again = true
      while (again) {
        again = false
        for (let i = 0; i < pending.length; i++) {
          if (pending[i].names.every((n) => services[n] !== undefined)) {
            const p = pending.splice(i, 1)[0]
            p.run()
            again = true
            break
          }
        }
      }
    },
    find(name) {
      return regs.find((r) => r.def && r.def.name === name)
    },
  }
}

function applyOn(host) {
  mod.apply(host.ctx)
  const row = host.find('plugins.row.config')
  const section = host.find('settings.section')
  return {
    host,
    row,
    section,
    label: section ? section.def.label() : null,
    page: row ? render(row.comp, pageProps) : '',
    pageSection: section ? render(section.comp, {}) : '',
  }
}
function applyWith(services) {
  const host = makeHost()
  for (const [name, value] of Object.entries(services)) host.services[name] = value
  return applyOn(host)
}

const zh = applyWith({ locale: makeLocale('zh'), configForms: makeForms() })
const en = applyWith({ locale: makeLocale('en'), configForms: makeForms() })
const fallback = applyWith({ configForms: makeForms() }) // 拿不到 locale 服务：退回中文
const noForms = applyWith({ locale: makeLocale('en') }) // 拿不到 configForms：行页仍在（且必须是英文）、设置页不出现
const noServices = applyWith({}) // 什么都没有：行页仍在，不抛

let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) { failed++; console.error(`FAIL ${name}${detail ? `：${detail}` : ''}`) }
}

// —— 中文宿主：只出中文 ——
check('页面能渲染（不抛异常）', zh.page.length > 0, '没有渲染出任何文本')
check('中文标题', zh.page.includes('EC上下文设置'))
check('中文提示', zh.page.includes('改完点最下面的「保存」'))
check('中文字段标签', zh.page.includes('L1 占比') && zh.page.includes('L1 单块上限'))
check('中文分组', zh.page.includes('配额') && zh.page.includes('行为'))
check('中文使用注意', zh.page.includes('使用注意：'))
check('中文按钮', zh.page.includes('保存') && zh.page.includes('放弃修改'))
check('中文详情按钮', zh.page.includes('详情'))
check('中文环境不出现英文标题/标签', !zh.page.includes('Ebbing Context') && !zh.page.includes('L1 share'))
check('中文环境不出现英文按钮', !zh.page.includes('Discard changes') && !zh.page.includes('Details'))

// —— 英文宿主：只出英文 ——
check('英文标题', en.page.includes('Ebbing Context'))
check('英文提示', en.page.includes('Click "Save" at the bottom'))
check('英文字段标签', en.page.includes('L1 share') && en.page.includes('L1 block limit'))
check('英文分组', en.page.includes('Quota') && en.page.includes('Behavior'))
check('英文使用注意', en.page.includes('built-in auto-compaction'))
check('英文按钮', en.page.includes('Save') && en.page.includes('Discard changes'))
check('英文详情按钮', en.page.includes('Details'))
check('英文环境不出现中文标题/标签', !en.page.includes('EC上下文设置') && !en.page.includes('配额'))
check('英文环境不出现中文按钮', !en.page.includes('放弃修改'))

// —— 拿不到 locale 服务：退回中文（老宿主/测试环境） ——
check('无 locale 服务时行页退回中文', fallback.page.includes('EC上下文设置') && !fallback.page.includes('Ebbing Context'))
check('只有 configForms 没有 locale 时不注册设置页（不拿中文顶替）',
  Boolean(fallback.row) && !fallback.section)

// —— 可选服务缺失：插件行配置页必须还在 ——
check('无 configForms 时行页仍在、设置页不出现',
  Boolean(noForms.row) && !noForms.section && noForms.page.includes('Ebbing Context'))
check('独立 locale inject 生效（有 locale、无 configForms 时行页也是英文）',
  noForms.page.includes('L1 share') && !noForms.page.includes('配额'))
check('什么服务都没有时行页仍在、不抛',
  Boolean(noServices.row) && !noServices.section && noServices.page.includes('EC上下文设置'))

// —— 服务晚到：apply 时没有 configForms/locale，之后 provide 才出现 ——
const late = applyOn(makeHost())
check('服务晚到时先只有行页', Boolean(late.row) && !late.section)
late.host.provide('configForms', makeForms())
check('只晚到 configForms 时设置页仍不出现（要等 locale）', !late.host.find('settings.section'))
late.host.provide('locale', makeLocale('en'))
const lateSection = late.host.find('settings.section')
check('服务晚到后设置页出现', Boolean(lateSection))
check('服务晚到后标题用英文', Boolean(lateSection) && lateSection.def.label() === 'Ebbing Context',
  lateSection ? String(lateSection.def.label()) : '')
check('服务晚到后设置页正文为英文',
  Boolean(lateSection) && render(lateSection.comp, {}).includes('Ebbing Context'))

// —— 语言切换：标题与正文跟着变（依赖 locale.subscribe 真的挂上） ——
const switchable = makeLocale('zh')
const switched = applyWith({ locale: switchable, configForms: makeForms() })
check('切换前中文', switched.page.includes('EC上下文设置') && !switched.page.includes('L1 share'))
check('页面订阅了 locale（切换能触发重画）', switchable.listenerCount() > 0, `listeners=${switchable.listenerCount()}`)
switchable.setActive('en')
const after = switched.row ? render(switched.row.comp, pageProps) : ''
check('切换后标题为英文', after.includes('Ebbing Context') && !after.includes('EC上下文设置'))
check('切换后字段为英文', after.includes('L1 share') && !after.includes('L1 占比'))
check('切换后导航标题跟着变', switched.section && switched.section.def.label() === 'Ebbing Context')

// —— 设置面板独立页：有服务时都注册、标题跟随语言、复用同一份表单 ——
check('插件行配置页仍在（两个入口共用一份配置）', Boolean(zh.row) && Boolean(en.row))
check('有服务时注册了 settings.section 页', Boolean(zh.section) && Boolean(en.section))
check('设置页 id/order 固定', zh.section && zh.section.def.id === 'ebbing-context' && zh.section.def.order === 46,
  zh.section ? `id=${zh.section.def.id} order=${zh.section.def.order}` : '')
check('中文设置页导航标题为「EC上下文设置」', zh.label === 'EC上下文设置', String(zh.label))
check('英文设置页导航标题为「Ebbing Context」', en.label === 'Ebbing Context', String(en.label))
check('设置页复用同一份表单渲染（语言跟随）',
  zh.pageSection.includes('EC上下文设置') && en.pageSection.includes('Ebbing Context'))

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
check('渲染器按语言二选一（label/detailEn 仍保留两套）', source.includes("zh ? item.label : item.labelEn") && source.includes('item.detailEn'))

if (failed) {
  console.error(`client 渲染断言 ${failed} 项失败`)
  process.exit(1)
}
console.log('client 渲染与语言跟随冒烟全部通过（41 项）')
