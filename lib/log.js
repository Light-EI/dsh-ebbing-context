// 运行日志：只记"发生了什么判定"，不记任何消息正文。
// 纪律：按大小滚动（默认 2 MiB × 2 份），单条超过 4 KiB 截断，写失败静默——
// 诊断面以 /context-status 为主，这个文件只是给"为什么会这样"留痕。

import { appendFileSync, mkdirSync, renameSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BYTES = 2 * 1024 * 1024
const KEEP_FILES = 2
const MAX_LINE = 4 * 1024

function homeDir() {
  return process.env.DSH_HOME || process.env.HOME || process.env.USERPROFILE || '.'
}

let target = null

function resolveTarget() {
  if (target !== null) return target
  try {
    const dir = join(homeDir(), 'logs')
    mkdirSync(dir, { recursive: true })
    target = join(dir, 'infinity-context.log')
  } catch {
    target = ''
  }
  return target
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

export function makeLogger(scope) {
  const path = resolveTarget()
  if (!path) return () => {}
  return (event, detail) => {
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
}
