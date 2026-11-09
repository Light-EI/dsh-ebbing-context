// 配置页渲染冒烟测试：用极简 React 替身把 ConfigPage 真跑一遍，确认
// 1) client.js 能加载、不抛异常；2) 中英双语标签/按钮/说明都真的渲染出来。
// 跑法：node plugin/test/client-render.test.mjs
import { readFileSync } from 'node:fs'

let captured = null
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
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

let component = null
mod.apply({
  slots: {
    inject: (_name, fn) => fn(),
    register: (_def, comp) => { component = comp; return comp },
  },
})

const state = { revision: 1, writable: true, status: 'ready', value: {} }
const tree = component({ view: 'page', form: { state, mutate: async () => true } })

const strings = []
const walk = (node) => {
  if (node === null || node === undefined || node === false) return
  if (typeof node === 'string' || typeof node === 'number') { strings.push(String(node)); return }
  if (Array.isArray(node)) { node.forEach(walk); return }
  if (node && node.children) node.children.forEach(walk)
}
walk(tree)
const rendered = strings.join('\n')

let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) { failed++; console.error(`FAIL ${name}${detail ? `：${detail}` : ''}`) }
}

check('页面能渲染（不抛异常）', tree && strings.length > 0, '没有渲染出任何文本')
check('标题中文', rendered.includes('上下文压缩'))
check('标题英文', rendered.includes('Context compaction'))
check('提示中英', rendered.includes('改完点最下面的「保存」') && rendered.includes('Click "Save" at the bottom'))
check('字段标签中英', rendered.includes('L1 占比') && rendered.includes('L1 share') && rendered.includes('L1 block limit'))
check('分组中英', rendered.includes('配额') && rendered.includes('/ Quota') && rendered.includes('行为') && rendered.includes('/ Behavior'))
check('使用注意中英', rendered.includes('使用注意：') && rendered.includes('built-in auto-compaction'))
check('按钮中英', rendered.includes('保存 / Save') && rendered.includes('放弃修改 / Discard changes'))
check('详情按钮中英', rendered.includes('详情 / Details'))
check('英文说明可见（展开后才会显示，源码里得有）', readFileSync(new URL('../client.js', import.meta.url), 'utf8').includes('item.detailEn'))

if (failed) {
  console.error(`client 渲染断言 ${failed} 项失败`)
  process.exit(1)
}
console.log('client 渲染与双语冒烟全部通过（10 项）')
