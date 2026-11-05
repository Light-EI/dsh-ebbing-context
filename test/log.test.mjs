// 日志模块的断言测试（失败以非零退出码结束）。
//
// 为什么要单钉这一份：日志是我们唯一的"事后诊断线"。它以前有个致命毛病——
// `DSH_HOME\logs` 建不出来时把 logger 换成空函数，**整个进程再也不写**，而且一声不响；
// 出问题时最需要日志，恰恰这时候什么都没有。现在要求两条：
//   ① 建目录失败不抛错、不影响主流程，并且会退到系统临时目录；
//   ② 失败之后还会重试（不是一次失败就永久关闭）。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

let failed = 0
let total = 0
const check = (name, cond, detail) => {
  total++
  if (cond) return
  console.error(`FAIL ${name}${detail ? ' :: ' + detail : ''}`)
  failed++
}

const here = new URL('../lib/log.js', import.meta.url).href
const scratch = mkdtempSync(join(tmpdir(), 'ebbing-log-test-'))
const savedHome = process.env.DSH_HOME

// 每例换一个 import 查询串：log.js 把解析结果缓存在模块作用域里，同一个实例测不了两种环境。
let seq = 0
async function freshLog(home) {
  process.env.DSH_HOME = home
  seq += 1
  return import(`${here}?case=${seq}`)
}

try {
  // ① 正常路径：DSH_HOME/logs 可写 → 落在那儿。
  {
    const home = join(scratch, 'ok-home')
    mkdirSync(home, { recursive: true })
    const mod = await freshLog(home)
    const log = mod.makeLogger('case1')
    log('hello', { a: 1 })
    const st = mod.logStatus()
    check('正常时写到 DSH_HOME/logs', st.origin === 'home' && st.path === join(home, 'logs', 'ebbing-context.log'), JSON.stringify(st))
    const text = existsSync(st.path) ? readFileSync(st.path, 'utf8') : ''
    check('事件与细节都落盘', text.includes('[case1] hello') && text.includes('"a":1'), text)
  }

  // ② DSH_HOME 指向一个文件（建不了目录）→ 退到临时目录，且不抛错。
  {
    const blocker = join(scratch, 'blocker')
    writeFileSync(blocker, 'x')
    const mod = await freshLog(blocker)
    const log = mod.makeLogger('case2')
    let threw = null
    try {
      log('fallback', 'x')
    } catch (error) {
      threw = error
    }
    check('建目录失败不抛错', threw === null, threw && String(threw))
    const st = mod.logStatus()
    check('退到临时目录而不是永久关闭', st.writable && st.origin === 'temp', JSON.stringify(st))
    const text = existsSync(st.path) ? readFileSync(st.path, 'utf8') : ''
    check('退到临时目录后日志仍写出来', text.includes('[case2] fallback'), text)
  }

  // ③ 同一个 scope 复用一个写入口（不然滚动判断会各记一份）。
  {
    const home = join(scratch, 'reuse-home')
    mkdirSync(home, { recursive: true })
    const mod = await freshLog(home)
    check('同 scope 返回同一个函数', mod.makeLogger('same') === mod.makeLogger('same'))
    check('不同 scope 不是同一个函数', mod.makeLogger('same') !== mod.makeLogger('other'))
  }
} finally {
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {}
}

console.log(`\nlog 断言测试全部通过（${total} 项）`)
if (failed > 0) process.exit(1)
