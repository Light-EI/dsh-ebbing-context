// 作用域审计：模块级函数不许引用 apply() 里的局部变量。
//
// 为什么专门钉这一条（2026-10-31 真机报错）：
//   compress 成功路径上写了 `resetGrowthBaseline(ctx, agent, config, reminded)`，
//   而 `reminded` 是 apply() 里声明的局部 Map，被调的 compressTool 却是模块级函数。
//   于是**每次成功压缩**都会抛 ReferenceError，被外层 catch 吞成「压缩时出错了」，
//   四事件其实已经写进去了 —— 模型看到失败回执，还会照它重试一遍。
//   这类错单测全绿也发现不了（没有一条测试真的走通了 execute 的成功路径），
//   所以用静态扫描兜住：apply() 里的局部名，不许出现在模块级函数体里。
//
// 扫的是我们自己写的 index.js，词法处理只覆盖这个文件真实用到的写法，
// 宁可漏报也不误报：字符串/注释/模板里的内容一律当文本跳过。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const file = process.env.SCOPE_FILE || join(here, '..', 'index.js')
const src = readFileSync(file, 'utf8')

let failed = 0
let total = 0
const check = (name, cond, detail) => {
  total++
  if (cond) return
  console.error(`FAIL ${name}${detail ? ' :: ' + detail : ''}`)
  failed++
}

// ---- 极简词法：把字符串/注释/模板内容替换成空格，只留结构字符与标识符 ----
// 模板字面量的 ${ } 里的代码要保留（里面可能有变量引用），其余部分抹掉。
function strip(src) {
  const out = []
  let i = 0
  const stack = [] // 记录模板插值嵌套：'tpl' 表示在模板文本里，'expr' 表示在 ${} 里
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    const top = stack[stack.length - 1]
    if (top === 'tpl') {
      if (c === '\\') { out.push(' ', ' '); i += 2; continue }
      if (c === '`') { stack.pop(); out.push(' '); i++; continue }
      if (c === '$' && n === '{') { stack.push('expr'); out.push('  '); i += 2; continue }
      out.push('\n' === c ? '\n' : ' ')
      i++
      continue
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') { out.push(' '); i++ }
      continue
    }
    if (c === '/' && n === '*') {
      i += 2
      out.push('  ')
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out.push(src[i] === '\n' ? '\n' : ' '); i++ }
      i += 2
      out.push('  ')
      continue
    }
    if (c === "'" || c === '"') {
      const q = c
      out.push(' ')
      i++
      while (i < src.length) {
        if (src[i] === '\\') { out.push(' ', ' '); i += 2; continue }
        if (src[i] === q) { out.push(' '); i++; break }
        out.push(src[i] === '\n' ? '\n' : ' ')
        i++
      }
      continue
    }
    if (c === '`') { stack.push('tpl'); out.push(' '); i++; continue }
    if (top === 'expr' && c === '}') { stack.pop(); out.push(' '); i++; continue }
    if (top === 'expr' && c === '{') { stack.push('expr'); out.push(' '); i++; continue }
    out.push(c)
    i++
  }
  return out.join('')
}

const clean = strip(src)

// 括号配对：从 openAt（指向 {）找到匹配的 }，返回 [bodyStart, bodyEnd)
function blockOf(text, openAt) {
  let depth = 0
  for (let i = openAt; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return [openAt + 1, i]
    }
  }
  return [-1, -1]
}

// apply() 的局部声明名：找 `export function apply` 的函数体，取其中顶层 const/let/function 声明
function declaredInApply(text) {
  const at = text.indexOf('export function apply')
  if (at < 0) return new Set()
  // 参数表里可能有默认值 `= {}`，所以不能直接找下一个 `{`：
  // 先跳过括号配对的参数表，再取函数体的开括号。
  let p = text.indexOf('(', at)
  if (p < 0) return new Set()
  let depthP = 0
  let q = p
  for (; q < text.length; q++) {
    if (text[q] === '(') depthP++
    else if (text[q] === ')') {
      depthP--
      if (depthP === 0) break
    }
  }
  const open = text.indexOf('{', q)
  const [s, e] = blockOf(text, open)
  if (s < 0) return new Set()
  const body = text.slice(s, e)
  const names = new Set()
  // 只收 apply 函数体**顶层**的声明：嵌套箭头函数里的 const turn / const text
  // 属于那个函数自己，收进来会造成满天飞的误报。
  let depth = 0
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (depth === 0) {
      const rest = body.slice(i, i + 200)
      const m = /^(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/.exec(rest)
      if (m && (i === 0 || !/[\w$]/.test(body[i - 1]))) {
        names.add(m[1])
        i += m[0].length - 1
      }
    }
  }
  return names
}

// 模块级函数：普通 function / export function / async function / const x = (…) => {…}
// 2026-10-31 用户 m16024：原来只认行首 `function`，`export function`、`async`、
// 箭头函数全都看不见——0.1.6 的 `reminded` 恰好写在普通 function 里才被逮到，
// 换成 `const compressTool = async (…) => {…}` 这类写法就会静默漏掉。
function moduleFunctions(text) {
  const list = []
  const patterns = [
    /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm,
    /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*\{/gm,
    /^(?:export\s+)?let\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*\{/gm,
  ]
  const seen = new Set()
  for (const re of patterns) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text))) {
      if (seen.has(m[1] + '@' + m.index)) continue
      seen.add(m[1] + '@' + m.index)
      const open = text.indexOf('{', m.index + m[0].length - 1)
      const [s, e] = blockOf(text, open)
      if (s < 0) continue
      const body = text.slice(s, e)
      const params = new Set(
        m[2].split(',').map((p) => p.trim().split(/[=:\s]/)[0]).filter(Boolean),
      )
      // 函数体里的局部声明也算自己人
      const locals = new Set()
      const lre = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g
      let lm
      while ((lm = lre.exec(body))) locals.add(lm[1])
      list.push({ name: m[1], params, locals, body })
    }
  }
  return list
}

const applyLocals = declaredInApply(clean)
const fns = moduleFunctions(clean)

check('能解析出 apply() 的局部声明（至少 reminded / foldQueues）', applyLocals.has('reminded') && applyLocals.has('foldQueues'), [...applyLocals].join(','))
check('能解析出模块级函数（至少 20 个）', fns.length >= 20, String(fns.length))

const offenders = []
for (const fn of fns) {
  for (const name of applyLocals) {
    if (fn.params.has(name) || fn.locals.has(name)) continue
    // 属性访问（`session.log`）不算引用：只认裸标识符，前面不能是 `.` 或标识符字符。
    const re = new RegExp(`(?<![.\\w$])${name}\\b`)
    if (re.test(fn.body)) offenders.push(`${fn.name} 引用了 apply() 的局部变量 ${name}`)
  }
}

check('模块级函数不引用 apply() 的局部变量', offenders.length === 0, offenders.join('；'))

// 自检：把三种写法各造一个"坏函数"，确认解析器真的能逮到箭头函数里的同类错。
// 不做这一步的话，"扩展了解析面"只是自我感觉良好——0.1.6 的教训就是测试没盖住那条路径。
{
  const sample = [
    'export function apply() {',
    '  const reminded = new Map()',
    '  const foldQueues = new Map()',
    '  return null',
    '}',
    'const arrowBad = (a) => {',
    '  return reminded.get(a)',
    '}',
    'async function plainBad(b) {',
    '  return foldQueues.get(b)',
    '}',
  ].join('\n')
  const localsOfSample = declaredInApply(sample)
  const fnsOfSample = moduleFunctions(sample)
  const hits = []
  for (const fn of fnsOfSample) {
    for (const name of localsOfSample) {
      if (fn.params.has(name) || fn.locals.has(name)) continue
      if (new RegExp(`(?<![.\\w$])${name}\\b`).test(fn.body)) hits.push(`${fn.name}:${name}`)
    }
  }
  check('自检：箭头函数与 async 函数里的同类错也能被逮到', hits.includes('arrowBad:reminded') && hits.includes('plainBad:foldQueues'), hits.join(','))
}

// 顺带钉住这次的具体 bug：resetGrowthBaseline 的第四个参数必须是本函数自己的入参。
const compressFn = fns.find((f) => f.name === 'compressTool')
check('compressTool 接收了 reminded（而不是去闭包里找）', !!compressFn && compressFn.params.has('reminded'), compressFn ? [...compressFn.params].join(',') : 'missing')

if (failed) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log(`scope 作用域审计全部通过（${total} 项）`)
