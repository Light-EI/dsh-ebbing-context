// 增长累计的落盘状态：关掉 DSH 再打开，基线接着算，不回到零。
//
// 为什么需要：插件把增长状态放在进程内存里（index.js 的 state Map），重启进程就全丢，
// 下一次 pre-step 只能把基线重设成"当时的用量"——用户看到的就是"累计清零"。
// 这里只存增长线的三个数：基线用量（tokens）、当前门槛（growthQuota，没压成时被砍半）、
// 到线指示灯（lineOn，重启后不重复报到线）。轮内的东西（growthPending、autoTurn）不存：
// 它们只对当前这轮有意义。
//
// 位置与日志同源：`DSH_HOME/logs/ebbing-context-state/<sessionId>.json`；
// 主目录建不出来/写不进去就退系统临时目录（宁可位置难看，也别让累计凭空消失）。
// 读的时候两处都读、按 `updatedAt` 取**最新**那份（并列时再比文件 mtime，两个都并列才主目录优先）：
// 主目录写失败退到临时目录后，主目录里那份是旧的，不能把新的盖回去（审查 0883a196 回归修复 1）。
// 主目录写成功时顺手删掉临时目录里可能残留的旧副本。
// 以 session.id 为键：agent.id 在重启后可能变，session.id 是稳定的（也随会话文件走）。
// 读写失败不抛错：读不到只是退回"按当前用量起步"，绝不影响主流程；写失败由
// persistGrowth 记日志（全部失败记 growth-state-write-failed，退到临时目录记
// growth-state-written-to-tmp），排查时不用靠猜。
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const VERSION = 1

let lastFailure = ''
let lastFallback = { fellBack: false, reason: '' }

// 最近一次读写失败的原因（成功一次就清空）。只给 persistGrowth 记日志用，不往外抛。
export function lastStateFailure() {
  return lastFailure
}

// 最近一次写入是否退到了临时目录（主目录写失败）。persistGrowth 据此记一条日志。
export function lastStateFallback() {
  return { ...lastFallback }
}

function homeDir() {
  return process.env.DSH_HOME || process.env.HOME || process.env.USERPROFILE || ''
}

function withLongPath(dir) {
  const list = [dir]
  if (process.platform === 'win32' && !dir.startsWith('\\\\?\\')) {
    const abs = isAbsolute(dir) ? dir : resolve(dir)
    list.push(`\\\\?\\${abs.replace(/\//g, '\\')}`)
  }
  return list
}

// 候选目录，按优先级：DSH_HOME 下（与日志同源）→ 系统临时目录。
// 写的时候先试主目录，失败才退临时目录；读的时候两处都读，取最新的一份（不是先找到先用）。
function stateDirs() {
  const home = homeDir()
  const list = []
  if (home) list.push(join(home, 'logs', 'ebbing-context-state'))
  list.push(join(tmpdir(), 'ebbing-context-state'))
  return list
}

// 会话 id 直接进文件名：只留文件名安全字符，其余换成下划线（`..` 拼不出目录穿越）。
function safeId(sessionId) {
  const id = String(sessionId || '').trim()
  if (!id) return ''
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  return safe === '' || safe === '.' || safe === '..' ? '' : safe
}

function parseRecord(text) {
  try {
    const raw = JSON.parse(text)
    if (!raw || raw.v !== VERSION) return null
    const tokens = typeof raw.tokens === 'number' && Number.isFinite(raw.tokens) && raw.tokens >= 0 ? raw.tokens : null
    if (tokens === null) return null
    const quota = typeof raw.growthQuota === 'number' && Number.isFinite(raw.growthQuota) && raw.growthQuota > 0
      ? raw.growthQuota
      : null
    const stamp = typeof raw.updatedAt === 'string' ? Date.parse(raw.updatedAt) : NaN
    return { tokens, growthQuota: quota, lineOn: raw.lineOn === true, updatedAt: Number.isFinite(stamp) ? stamp : 0 }
  } catch {
    return null
  }
}

// 读一次增长状态：两处候选都读，在**有效**记录里取 `updatedAt` 最新的那份；
// 并列时再用文件 mtime 分先后，两个都并列才按候选顺序（主目录优先）。
// 都读不到（缺失/坏了/版本不对/字段不合法）返回 null（退回"按当前用量起步"）。
export function readGrowth(sessionId) {
  const id = safeId(sessionId)
  if (!id) return null
  let best = null
  for (const dir of stateDirs()) {
    for (const candidate of withLongPath(dir)) {
      const path = join(candidate, `${id}.json`)
      let text
      try {
        text = readFileSync(path, 'utf8')
      } catch (error) {
        // 这个候选没有/读不了就继续试下一个（主目录被日志清理带走、或权限暂时不对）。
        if (error && error.code !== 'ENOENT') lastFailure = `read:${error.code || error.message || error}`
        continue
      }
      const record = parseRecord(text)
      if (!record) {
        // 坏了/版本不对的那份按"不存在"处理，但不影响另一处的有效副本（下面继续读）。
        lastFailure = 'read:invalid'
        continue
      }
      // 先比 `updatedAt`（严格大于才替换）；并列时比文件 mtime，后写的那份不会更早
      // （`updatedAt` 只到毫秒，同一毫秒里连续写两次会并列；ext4/NTFS 的 mtime 精度都够）。
      // 两个都并列才保留先读到的（主目录）。
      let mtimeMs = 0
      try {
        mtimeMs = statSync(path).mtimeMs || 0
      } catch {}
      const newer = !best ||
        record.updatedAt > best.updatedAt ||
        (record.updatedAt === best.updatedAt && mtimeMs > best.mtimeMs)
      if (newer) best = { ...record, mtimeMs }
    }
  }
  if (!best) return null
  lastFailure = ''
  return { tokens: best.tokens, growthQuota: best.growthQuota, lineOn: best.lineOn }
}

// 写一次增长状态；返回是否真的落盘。先写临时文件再改名，半截文件不会被下一次读到。
// 临时文件名带 pid 与序号：两个进程同时写同一条会话时不会互相踩 .tmp。
let tmpCounter = 0

export function writeGrowth(sessionId, data) {
  const id = safeId(sessionId)
  if (!id) return false
  const tokens = data && typeof data.tokens === 'number' && Number.isFinite(data.tokens) ? data.tokens : null
  if (tokens === null) return false
  const quota = data && typeof data.growthQuota === 'number' && Number.isFinite(data.growthQuota) && data.growthQuota > 0
    ? Math.round(data.growthQuota)
    : null
  const payload = {
    v: VERSION,
    tokens: Math.round(tokens),
    growthQuota: quota,
    lineOn: data && data.lineOn === true,
    updatedAt: new Date().toISOString(),
  }
  const text = JSON.stringify(payload)
  const dirs = stateDirs()
  const primary = dirs[0]
  const spillover = dirs.length > 1 ? dirs[dirs.length - 1] : null
  let failure = ''
  lastFallback = { fellBack: false, reason: '' }
  for (const dir of dirs) {
    for (const candidate of withLongPath(dir)) {
      const path = join(candidate, `${id}.json`)
      const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`
      try {
        mkdirSync(candidate, { recursive: true })
        writeFileSync(tmp, text, 'utf8')
        renameSync(tmp, path)
        lastFailure = ''
        if (dir !== primary) {
          // 主目录写失败、退到了临时目录：调用方要能记一条，用户排查"为什么盘上还是旧值"时有据可查。
          lastFallback = { fellBack: true, reason: failure || 'write:primary-failed' }
        } else if (spillover) {
          // 主目录写成功：把临时目录里可能残留的旧副本尽力删掉，避免以后误读到更旧的状态。
          for (const other of withLongPath(spillover)) {
            try {
              unlinkSync(join(other, `${id}.json`))
            } catch {}
          }
        }
        return true
      } catch (error) {
        failure = `write:${error.code || error.message || error}`
        lastFailure = failure
        try {
          unlinkSync(tmp)
        } catch {}
        // 这个候选写不进去（只读、被占用、路径太深）就试下一个，最后才放弃。
      }
    }
  }
  return false
}
