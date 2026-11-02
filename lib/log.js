// 运行日志：只记"发生了什么判定"，不记任何消息正文。
// 纪律：按大小滚动（默认 2 MiB × 2 份），单条超过 4 KiB 截断，写失败静默——
// 诊断面以 /context-status 为主，这个文件只是给"为什么会这样"留痕。

import { appendFileSync, mkdirSync, renameSync, statSync, rmSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const MAX_BYTES = 2 * 1024 * 1024
const KEEP_FILES = 2
const MAX_LINE = 4 * 1024

function homeDir() {
  return process.env.DSH_HOME || process.env.HOME || process.env.USERPROFILE || '.'
}

let target = null

function resolveTarget() {
  if (target !== null) return target
  const dir = join(homeDir(), 'logs')
  // Windows 上超过 MAX_PATH(260) 的路径会让 mkdir 直接失败（ENAMETOOLONG），
  // 那时退回长路径前缀（`\\?\` + 绝对路径）再试一次——这条诊断线丢得没有声音，
  // 出问题时最需要它，不能因为目录名长就静默关掉。
  for (const candidate of logDirs(dir)) {
    try {
      mkdirSync(candidate, { recursive: true })
      target = join(candidate, 'ebbing-context.log')
      return target
    } catch {}
  }
  target = ''
  return target
}

function logDirs(dir) {
  const list = [dir]
  if (process.platform === 'win32' && !dir.startsWith('\\\\?\\')) {
    const abs = isAbsolute(dir) ? dir : resolve(dir)
    list.push(`\\\\?\\${abs.replace(/\//g, '\\')}`)
  }
  return list
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
  const path = resolveTarget()
  if (!path) return () => {}
  const write = (event, detail) => {
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
      // 写日志永远不能影响主流程
    }
  }
  byScope.set(scope, write)
  return write
}
