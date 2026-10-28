// 造一条「用户消息」。优先用宿主的构造器（它负责 id / 时间戳 / 默认字段）。
//
// 为什么要包一层：第三方插件能不能解析到宿主的包，是装载方式决定的，不是代码决定的。
// 解析不到时若直接 import，插件会在启动阶段整片崩掉；包一层之后最坏结果只是消息少两个
// 可选字段，压缩照样能落盘。这条降级路径只会在宿主包真的缺失时走到。
import { randomUUID } from 'node:crypto'

let hostFactory = null
try {
  const mod = await import('@deepseek-ai/dsh-llm')
  if (typeof mod.createUserMessage === 'function') hostFactory = mod.createUserMessage
} catch {
  hostFactory = null
}

export function userMessage({ content, source }) {
  if (hostFactory) {
    try {
      return hostFactory({ content, source })
    } catch {}
  }
  return { id: randomUUID(), role: 'user', createdAt: Date.now(), content, source }
}
