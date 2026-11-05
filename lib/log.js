// 运行日志：只记"发生了什么判定"，不记任何消息正文。
// 纪律：按大小滚动（默认 2 MiB × 2 份），单条超过 4 KiB 截断，写失败静默——
// 诊断面以 /context-status 为主，这个文件只是给"为什么会这样"留痕。
//
// 两条底线（2026-11-05 改）：
// 1. **建目录失败不等于永久关闭**：以前一次失败就把 logger 换成空函数，整个进程再无痕迹；
//    现在每次写之前允许重试（失败后 30 秒冷却，避免每步都去撞同一个权限错误）。
// 2. **`DSH_HOME/logs` 建不了就退到系统临时目录**，宁可位置难看，也别让诊断线自己先断。

import { appendFileSync, mkdirSync, renameSync, statSync, rmSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const MAX_BYTES = 2 * 1024 * 1024
const KEEP_FILES = 2
const MAX_LINE = 4 * 1024
const RETRY_MS = 30 * 1000

function homeDir() {
  return process.env.DSH_HOME || process.env.HOME || process.env.USERPROFILE || '.'
}

// 解析成功后的文件路径；空串表示"此刻建不出来"（30 秒后会再试）。
let target = null
let targetOrigin = ''
let lastTry = 0

function logDirs(dir) {
  const list = [dir]
  if (process.platform === 'win32' && !dir.startsWith('\\\\?\\')) {
    const abs = isAbsolute(dir) ? dir : resolve(dir)
    list.push(`\\\\?\\${abs.replace(/\//g, '\\')}`)
  }
  return list
}

function candidates() {
  const list = []
  for (const [dir, origin] of [
    [join(homeDir(), 'logs'), 'home'],
    [join(tmpdir(), 'ebbing-context'), 'temp'],
  ]) {
    for (const candidate of logDirs(dir)) list.push({ dir: candidate, origin })
  }
  return list
}

// Windows 上超过 MAX_PATH(260) 的路径会让 mkdir 直接失败（ENAMETOOLONG），
// 那时退回长路径前缀（`\\?\` + 绝对路径）再试一次；还不行就换临时目录。
function tryResolve() {
  for (const { dir, origin } of candidates()) {
    try {
      mkdirSync(dir, { recursive: true })
      return { path: join(dir, 'ebbing-context.log'), origin }
    } catch {}
  }
  return null
}

function ensureTarget() {
  if (target) return target
  const now = Date.now()
  if (now - lastTry < RETRY_MS) return ''
  lastTry = now
  const got = tryResolve()
  if (!got) {
    target = ''
    targetOrigin = ''
    return ''
  }
  target = got.path
  targetOrigin = got.origin
  return target
}

// 给 /context-status 用：日志到底写在哪、是不是退到了临时目录。
export function logStatus() {
  const path = ensureTarget()
  return { path, origin: targetOrigin, writable: Boolean(path) }
}

function rotate(path) {
  try {
    if (statSync(path).size < MAX_BYTES) return
  } catch {
    return
  }
  // 每一步单独兜住：第一次滚动时 .1 还不存在，整体 try 会在第一步就抛出，
  // 结果主日志永远轮不掉、无限增长。这里必须逐次容错。
  for (let i = KEEP_FILES - 1; i >= 1; i--) {
    try {
      renameSync(`${path}.${i}`, `${path}.${i + 1}`)
    } catch {}
  }
  try {
    rmSync(`${path}.${KEEP_FILES}`, { force: true })
  } catch {}
  try {
    renameSync(path, `${path}.1`)
  } catch {
    // 滚动失败就不滚，宁可日志大一点也不能让插件写崩
  }
}

// 同一个 scope 只发一个写入口：多个模块各建一个也能写，但每个实例各记一份"已经滚到哪个大小"，
// 轮到自己判断时容易在别人刚滚完之后再滚一次；共享一个入口就不会有这个歧义。
const byScope = new Map()

export function makeLogger(scope) {
  const cached = byScope.get(scope)
  if (cached) return cached
  const write = (event, detail) => {
    const path = ensureTarget()
    if (!path) return
    try {
      let line = `${new Date().toISOString()} [${scope}] ${event}`
      if (detail !== undefined) {
        let text
        try {
          text = typeof detail === 'string' ? detail : JSON.stringify(detail)
        } catch {
          text = String(detail)
        }
        if (text && text.length > MAX_LINE) text = `${text.slice(0, MAX_LINE)}…`
        if (text) line += ` ${text}`
      }
      rotate(path)
      appendFileSync(path, `${line}\n`)
    } catch {
      // 写日志永远不能影响主流程；下次调用会照常重试（不再永久关闭）
    }
  }
  byScope.set(scope, write)
  return write
}
