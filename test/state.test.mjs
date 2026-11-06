// 增长状态落盘的断言测试。
//
// 钉住四件事：
//   ① 同一段状态写下去能原样读回来；两处都读不到有效记录（缺失/损坏/版本不对/字段非法）
//      时读成 null（退回"按当前用量起步"，不是抛错）；
//   ② 会话 id 直接进文件名，必须只留安全字符，拼不出目录穿越；
//   ③ 主目录写不进去时退系统临时目录，读的时候两处都读、取最新的有效副本
//      （主目录旧值不能遮蔽临时目录新值；主目录写成功后清掉临时副本）；
//      某一份坏了不影响另一处的有效副本，两处都坏才按"没有存过"；
//   ④ index.js 的 hydrateGrowth / persistGrowth / resetGrowthBaseline 与读写的接线正确
//      （重启后基线不清零、指示灯先复位再落盘）。
import { existsSync, mkdtempSync, chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readGrowth, writeGrowth, lastStateFallback } from '../lib/state.js'
import { hydrateGrowth, persistGrowth, resetGrowthBaseline } from '../index.js'

let failed = 0
let total = 0
const check = (name, cond, detail) => {
  total++
  if (cond) return
  console.error(`FAIL ${name}${detail ? ' :: ' + detail : ''}`)
  failed++
}
const safeRead = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return '<missing>'
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'ebbing-state-test-'))
const savedHome = process.env.DSH_HOME
process.env.DSH_HOME = scratch
const stateDir = join(scratch, 'logs', 'ebbing-context-state')
const fileOf = (id) => join(stateDir, `${id}.json`)
const tmpDir = join(tmpdir(), 'ebbing-context-state')
const tmpFileOf = (id) => join(tmpDir, `${id}.json`)
const uniq = `session-tmp-${process.pid}-${Date.now()}`

try {
  // ① 正常写入 / 读回
  check('写下去返回 true', writeGrowth('session-abc', { tokens: 123456, growthQuota: 32500, lineOn: true }) === true)
  const back = readGrowth('session-abc')
  check('读回来字段一致', back && back.tokens === 123456 && back.growthQuota === 32500 && back.lineOn === true, JSON.stringify(back))
  check('落盘文件在 DSH_HOME/logs/ebbing-context-state 下', existsSync(fileOf('session-abc')))
  check('写完不留下 .tmp', readdirSync(stateDir).every((f) => !f.endsWith('.tmp')))

  // ② 缺失 / 损坏 / 版本不对 / 字段非法 → null（不是抛错）
  check('没有文件时读成 null', readGrowth('session-missing') === null)
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(fileOf('session-bad'), '{not json')
  check('坏 JSON 读成 null', readGrowth('session-bad') === null)
  writeFileSync(fileOf('session-v9'), JSON.stringify({ v: 9, tokens: 1 }))
  check('版本不对读成 null', readGrowth('session-v9') === null)
  writeFileSync(fileOf('session-neg'), JSON.stringify({ v: 1, tokens: -5 }))
  check('负的 tokens 读成 null', readGrowth('session-neg') === null)
  check('写非法 tokens 返回 false', writeGrowth('session-x', { tokens: 'many' }) === false)
  check('空 sessionId 读成 null', readGrowth('') === null)

  // ③ 会话 id 拼不出目录穿越
  check('带 ../ 的 id 也能写（被清洗）', writeGrowth('../../evil', { tokens: 42 }) === true)
  check('穿越的文件没有落在 state 目录外', !existsSync(join(scratch, 'evil.json')) && !existsSync(join(scratch, 'logs', 'evil.json')))
  check(
    '清洗后的文件仍在 state 目录里',
    existsSync(fileOf('.._.._evil')),
    safeRead(join(stateDir, '.._.._evil.json')),
  )

  // ④ hydrateGrowth / persistGrowth 的接线
  const ctx = { sessions: { get: (id) => (id === 'a1' ? { id: 'session-abc' } : null) } }
  writeGrowth('session-abc', { tokens: 777, growthQuota: 100, lineOn: false })
  const st = { tokens: null, growthQuota: null, lineOn: false }
  check('hydrate 把基线/门槛/灯拿回来', hydrateGrowth(ctx, 'a1', st) === true && st.tokens === 777 && st.growthQuota === 100 && st.lineOn === false, JSON.stringify(st))
  const st2 = { tokens: null, growthQuota: null, lineOn: false }
  check('拿不到会话时不灌状态', hydrateGrowth(ctx, 'missing', st2) === false && st2.tokens === null)
  check('persist 把当前基线写回去', persistGrowth(ctx, 'a1', { tokens: 888, growthQuota: null, lineOn: true }) === true && readGrowth('session-abc').tokens === 888)
  check('persist 没基线时不写', persistGrowth(ctx, 'a1', { tokens: null }) === false)
  check('persist 没有会话服务时不抛错', persistGrowth({}, 'a1', { tokens: 1 }) === false)

  // ⑤ 主目录写不进去：退临时目录；读的时候两处都找
  const blockedHome = join(scratch, 'blocked-home')
  writeFileSync(blockedHome, 'not a dir') // 让 mkdir 失败
  process.env.DSH_HOME = blockedHome
  check('主目录不可建时写进临时目录', writeGrowth(uniq, { tokens: 4321, growthQuota: null, lineOn: true }) === true)
  check('临时目录里真有文件', existsSync(tmpFileOf(uniq)))
  // 退到临时目录成功时 persistGrowth 也必须留痕，否则用户查不到真实位置
  const fallbackLogs = []
  persistGrowth({ sessions: { get: () => ({ id: uniq }) } }, 'a1', { tokens: 4321, growthQuota: null, lineOn: true }, (event, data) => fallbackLogs.push({ event, data }))
  check('退临时目录时 persistGrowth 记 growth-state-written-to-tmp', fallbackLogs.some((l) => l.event === 'growth-state-written-to-tmp'), JSON.stringify(fallbackLogs))
  // 同一状态连续退级只记一次（恢复后清标记），坏盘时不能每步刷一条
  const dedupeId = `${uniq}-dedupe`
  const dedupeSt = { tokens: 1, growthQuota: null, lineOn: false }
  const dedupeLogs = []
  const dedupeCtx = { sessions: { get: () => ({ id: dedupeId }) } }
  persistGrowth(dedupeCtx, 'a1', dedupeSt, (event) => dedupeLogs.push(event))
  persistGrowth(dedupeCtx, 'a1', dedupeSt, (event) => dedupeLogs.push(event))
  check('连续退临时目录只记一条日志', dedupeLogs.filter((e) => e === 'growth-state-written-to-tmp').length === 1, JSON.stringify(dedupeLogs))
  process.env.DSH_HOME = scratch
  const fromTmp = readGrowth(uniq)
  check('主目录没有时从临时目录读回来', fromTmp && fromTmp.tokens === 4321 && fromTmp.lineOn === true, JSON.stringify(fromTmp))
  check('主目录恢复后写回主目录', writeGrowth(uniq, { tokens: 99, growthQuota: null, lineOn: false }) === true && readGrowth(uniq).tokens === 99)

  // 文件在但坏了：忽略坏的那份；另一处有有效副本时用它（主目录常坏时靠临时目录兜底）
  const corruptId = `${uniq}-corrupt`
  mkdirSync(tmpDir, { recursive: true })
  writeFileSync(tmpFileOf(corruptId), JSON.stringify({ v: 1, tokens: 7, growthQuota: null, lineOn: false, updatedAt: new Date().toISOString() }))
  writeFileSync(fileOf(corruptId), '{broken')
  check('主目录文件坏了：用临时目录里的有效副本', readGrowth(corruptId) && readGrowth(corruptId).tokens === 7, JSON.stringify(readGrowth(corruptId)))
  const bothBadId = `${uniq}-bothbad`
  writeFileSync(tmpFileOf(bothBadId), '{broken')
  writeFileSync(fileOf(bothBadId), '{broken')
  check('两处都坏了：读成 null', readGrowth(bothBadId) === null)

  // 主目录文件只读（Windows 上 rename 失败）→ 新值写进临时目录；读必须拿新的那份，不能主目录旧值遮蔽
  const roId = `${uniq}-readonly`
  check('先写一份基线 100 到主目录', writeGrowth(roId, { tokens: 100, growthQuota: null, lineOn: false }) === true)
  // 让主目录写不进去的手段按平台分：Windows 锁文件（rename 覆盖只读文件 EPERM）；
  // POSIX 上 rename 覆盖只读文件是允许的、锁不住，只能让目录不可写（发版 CI 是 Ubuntu）。
  // root 无视目录权限（0555 挡不住），这条用例会误报红；CI 是非 root，root 下跳过。
  const posixRoot = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0
  if (!posixRoot) {
  const restoreMain = () => {
    try {
      if (process.platform === 'win32') chmodSync(fileOf(roId), 0o666)
      else chmodSync(stateDir, 0o755)
    } catch {}
  }
  if (process.platform === 'win32') chmodSync(fileOf(roId), 0o444)
  else chmodSync(stateDir, 0o555)
  const roWrote = writeGrowth(roId, { tokens: 200, growthQuota: null, lineOn: true })
  check('主目录写不进去：写入退临时目录仍返回 true', roWrote === true)
  check('退临时目录会置 fallback 标记（给插件记日志）', lastStateFallback().fellBack === true, JSON.stringify(lastStateFallback()))
  const roBack = readGrowth(roId)
  check('读回的是临时目录里更新的那份（不是主目录旧值 100）', roBack && roBack.tokens === 200 && roBack.lineOn === true, JSON.stringify(roBack))
  restoreMain()
  check('主目录恢复可写后写回主目录', writeGrowth(roId, { tokens: 300, growthQuota: null, lineOn: false }) === true && readGrowth(roId).tokens === 300)
  check('主目录写成功后临时目录里的旧副本被清掉', !existsSync(tmpFileOf(roId)))
  }

  // updatedAt 只到毫秒：并列时用文件 mtime 分先后（这是我们自己测试里"两次写入落在同一毫秒"的真实情形）
  const tieId = `${uniq}-tie`
  const tieStamp = new Date().toISOString()
  mkdirSync(tmpDir, { recursive: true })
  writeFileSync(fileOf(tieId), JSON.stringify({ v: 1, tokens: 11, growthQuota: null, lineOn: false, updatedAt: tieStamp }))
  writeFileSync(tmpFileOf(tieId), JSON.stringify({ v: 1, tokens: 22, growthQuota: null, lineOn: false, updatedAt: tieStamp }))
  const later = new Date(Date.now() + 5000)
  utimesSync(tmpFileOf(tieId), later, later)
  check('updatedAt 并列时按文件 mtime 取更新的那份', readGrowth(tieId) && readGrowth(tieId).tokens === 22, JSON.stringify(readGrowth(tieId)))

  // 去重的状态切换：失败 → 退临时目录 → 恢复正常 → 再失败，每次切换记一条（回归修复）
  {
    const transId = `${uniq}-trans`
    const transSt = { tokens: 1, growthQuota: null, lineOn: false }
    const transCtx = { sessions: { get: () => ({ id: transId }) } }
    const transLogs = []
    const transLog = (event) => transLogs.push(event)
    const blocker = tmpFileOf(transId)
    process.env.DSH_HOME = blockedHome
    mkdirSync(blocker, { recursive: true }) // 临时目录的目标位置被目录占住 → rename 也失败
    persistGrowth(transCtx, 'a1', transSt, transLog)
    persistGrowth(transCtx, 'a1', transSt, transLog)
    check('两处都写不进：连续失败只记一条 growth-state-write-failed',
      transLogs.filter((e) => e === 'growth-state-write-failed').length === 1, JSON.stringify(transLogs))
    rmSync(blocker, { recursive: true, force: true })
    persistGrowth(transCtx, 'a1', transSt, transLog)
    check('从失败切到退临时目录：记一条 growth-state-written-to-tmp',
      transLogs.filter((e) => e === 'growth-state-written-to-tmp').length === 1, JSON.stringify(transLogs))
    process.env.DSH_HOME = scratch
    persistGrowth(transCtx, 'a1', transSt, transLog)
    check('恢复正常写回主目录后不再记日志', transLogs.length === 2, JSON.stringify(transLogs))
    // 清标记必须真的清：主目录再坏、临时目录可写时，日志要重新出现（标记残留会被 'tmp' 抑制）
    process.env.DSH_HOME = blockedHome
    persistGrowth(transCtx, 'a1', transSt, transLog)
    check('恢复正常后再退临时目录：日志重新出现（证明恢复时清了标记）',
      transLogs.filter((e) => e === 'growth-state-written-to-tmp').length === 2, JSON.stringify(transLogs))
    // 上一步退临时目录时在这里写回了文件；先清掉，再把同一路径占成目录制造"两处都失败"
    rmSync(blocker, { force: true })
    mkdirSync(blocker, { recursive: true })
    persistGrowth(transCtx, 'a1', transSt, transLog)
    check('恢复后再坏：能重新记一条失败', transLogs.filter((e) => e === 'growth-state-write-failed').length === 2, JSON.stringify(transLogs))
    rmSync(blocker, { recursive: true, force: true })
    process.env.DSH_HOME = scratch
    rmSync(tmpFileOf(transId), { force: true })
  }

  // ⑥ resetGrowthBaseline：先按压缩后比例复位指示灯、再落盘（审查 Major 2）
  const usageSession = {
    id: 'session-reset',
    seq: 1,
    used: 300,
    requestContext: () => ({ contextWindow: 1000 }),
  }
  const resetCtx = {
    sessions: { get: () => usageSession },
    tokenMeter: { measure: () => ({ totalTokens: usageSession.used }) },
  }
  const map = new Map([['a1', { tokens: 500, growthQuota: 50, lineOn: true }]])
  resetGrowthBaseline(resetCtx, { id: 'a1' }, { triggerPct: 0.85, reservedTokens: 0 }, map)
  const afterReset = readGrowth('session-reset')
  check('reset 把基线对齐压缩后用量', map.get('a1').tokens === 300 && afterReset && afterReset.tokens === 300, JSON.stringify(afterReset))
  check('reset 落盘的是复位后的指示灯（false）', afterReset && afterReset.lineOn === false, JSON.stringify(afterReset))
} finally {
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  try {
    if (process.platform === 'win32') chmodSync(fileOf(`${uniq}-readonly`), 0o666)
    else chmodSync(stateDir, 0o755)
  } catch {}
  rmSync(scratch, { recursive: true, force: true })
  try {
    rmSync(tmpFileOf(uniq), { force: true })
    rmSync(tmpFileOf(`${uniq}-dedupe`), { force: true })
    rmSync(tmpFileOf(`${uniq}-corrupt`), { force: true })
    rmSync(tmpFileOf(`${uniq}-bothbad`), { force: true })
    rmSync(tmpFileOf(`${uniq}-readonly`), { force: true })
    rmSync(tmpFileOf(`${uniq}-tie`), { force: true })
    rmSync(tmpFileOf(`${uniq}-trans`), { force: true })
  } catch {}
}

if (failed > 0) {
  console.error(`state 断言测试失败 ${failed} / ${total} 项`)
  process.exit(1)
}
console.log(`state 断言测试全部通过（${total} 项）`)
