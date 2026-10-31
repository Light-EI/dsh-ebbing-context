// 从 CHANGELOG.md 取「最上面那一节」生成 GitHub Release 的标题与正文。
//
// 为什么不用整份 CHANGELOG 当正文：那样每发一版，Release 正文都会把历史上所有版本
// 重贴一遍，读的人要在 200 行里找本版改了什么。
//
// 用法（CI 里）：
//   node scripts/release-notes.mjs <tag> >> $GITHUB_OUTPUT
// 产物：
//   标准输出一行 title=...（供 action 的 name 字段用）
//   dist/notes.md：本版正文（去掉标题行）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const tag = (process.argv[2] || '').trim()
const changelog = readFileSync('CHANGELOG.md', 'utf8').replace(/\r\n/g, '\n')
const lines = changelog.split('\n')

const start = lines.findIndex((line) => /^# /.test(line))
if (start < 0) {
  console.error('CHANGELOG.md 里找不到 "# " 开头的版本标题')
  process.exit(1)
}
let end = lines.length
for (let i = start + 1; i < lines.length; i++) {
  if (/^# /.test(lines[i])) {
    end = i
    break
  }
}

const heading = lines[start].replace(/^#\s*/, '').trim()
// 标题形如 "0.1.13 — 文档与仓库整理"，取破折号后面的部分当副标题
const dash = heading.search(/[—–-]\s/)
const subtitle = dash >= 0 ? heading.slice(dash + 1).trim() : ''
const body = lines.slice(start + 1, end).join('\n').trim()

const title = ['Ebbing Context', tag, subtitle].filter(Boolean).join(' ')

mkdirSync('dist', { recursive: true })
writeFileSync('dist/notes.md', body + '\n', 'utf8')
console.log(`title=${title}`)
