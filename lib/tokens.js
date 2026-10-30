// 自己的 token 估算器：不依赖宿主的度量服务。
//
// 为什么不用宿主的：`@deepseek-ai/dsh-token-meter` 的 estimateMessage 用的是
// 「固定密度」启发式——`ceil(text.length / 4)`。中文一个字的 `.length` 是 1，
// 于是四个汉字才算 1 token，而真实分词器大约 1 token = 1~1.5 个汉字，中文被低估约 4 倍。
// 拿它当长度尺子，"5000 token" 实际能写到两万字。
//
// 这里按字符类别分档，刻意保守（宁可估多不可估少，否则限制形同虚设）：
//   · 中日韩字符、全角标点、假名、注音：1 字 = 1 token
//   · 其他非 ASCII（emoji、西里尔、泰文…）：1 字 = 1 token
//   · ASCII 数字：3 个 = 1 token（数字分词通常 1~3 位一档）
//   · ASCII 其他（字母、标点、空格、换行）：4 个 = 1 token
// 最后整体向上取整。
//
// 校准依据（经验值，量级正确即可）：
//   · 纯中文 100 字            ≈ 100 token（真实 65~150）
//   · 纯英文 400 字符          ≈ 100 token（真实 90~110）
//   · 中文为主的技术文档混合文本 ≈ 每 token 1~1.3 字
// 我们的用途只有两个：判断"单块正文是否超上限"和"标题是否太长"，都是粗粒度闸门，
// 差 10%~20% 不影响判断；差 4 倍会让闸门失效。

/**
 * 估一段文本的 token 数。
 * @param {string} text
 * @returns {number} 向上取整的 token 估计
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0

  let wide = 0 // 中日韩等宽字符 + 非 ASCII 其他
  let digits = 0 // ASCII 数字
  let narrow = 0 // ASCII 字母、标点、空白

  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code > 0x7f) {
      wide += 1
      continue
    }
    if (code >= 0x30 && code <= 0x39) {
      digits += 1
      continue
    }
    narrow += 1
  }

  // 极端情况保底：非空文本至少 1 token
  return Math.max(1, Math.ceil(wide + digits / 3 + narrow / 4))
}

// 宿主自己的口径：`@deepseek-ai/dsh-token-meter` 的 estimateMessage 用 `ceil(text.length / 4)`。
// 中文会被低估约 4 倍，所以**只在"两侧同时退回宿主口径"这一处**使用（见 compress.js 的收益校验）。
// 别的地方一律用 estimateTokens / messageTokens，避免同一张图两处算出两个数。
export function hostTokens(text) {
  if (typeof text !== 'string') return 0
  return Math.ceil([...text].length / 4)
}

// 一条消息占多少 token：文本、图片、工具调用的参数，一处算清。
// 地图、压缩收益、长度校验全部调这里——只留一把尺子，避免"同一张图两处算出两个数"。
export const IMAGE_TOKENS = 800

export function messageTokens(message) {
  const content = message && message.content
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      total += estimateTokens(block.text)
    } else if (block.type === 'image') {
      total += IMAGE_TOKENS
    } else if (block.type === 'tool-call') {
      // 工具调用的参数是独立的一串 JSON，不在文本块里；不单独算，读文件/写代码类调用会被算成 0。
      const name = typeof block.name === 'string' ? block.name : ''
      const args = block.arguments
      let raw = ''
      try {
        raw = typeof args === 'string' ? args : (JSON.stringify(args) ?? '')
      } catch {
        raw = ''
      }
      total += estimateTokens(name) + estimateTokens(raw) + 8
    }
  }
  return total
}
