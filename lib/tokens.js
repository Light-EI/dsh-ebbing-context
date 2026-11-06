// 自己的 token 估算器：不依赖宿主的度量服务。
//
// 为什么不用宿主的：`@deepseek-ai/dsh-token-meter` 的 estimateMessage 用的是
// 「固定密度」启发式——`ceil(text.length / 4)`。中文一个字的 `.length` 是 1，
// 于是四个汉字才算 1 token；真实分词器远不止，拿它当长度尺子，"5000 token" 实际能写到两万多字。
//
// 密度按真实账单调过（2026-11-06，一次 l0 压缩的完整校验：227 条消息、非空 225 条，
// 文本 19.3 万字符、reasoning 26 万字符、工具参数 3.7 万字符；按下面的密度算出 168,299，
// 而压缩前后两次真实请求的 prompt 差是 171,464，误差约 2%）：
//   · 中日韩字符、全角标点、假名、注音：1 字 = 0.6 token
//   · 其他非 ASCII（emoji、西里尔、泰文…）：1 字 = 0.6 token
//   · ASCII 数字：3 个 = 1 token（数字分词通常 1~3 位一档）
//   · ASCII 其他（字母、标点、空格、换行）：1 字 = 0.3 token
// 最后整体向上取整。
//
// 校准依据（经验值，量级正确即可）：
//   · 纯中文 100 字            ≈ 60 token（真实 55~70）
//   · 纯英文 400 字符          ≈ 120 token（真实 100~140）
//   · 中文为主的技术文档混合文本 ≈ 每 token 1.6~1.7 字
//
// 用途：单块正文上限、标题上限、地图自估、压缩收益校验的"自估"一侧；
// 都要求量级正确，差 10%~20% 不影响判断；差 4 倍会让闸门失效。

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

  // 逐类密度见文件头：中文 0.6/字、ASCII 0.3/字、数字 1/3。
  // 极端情况保底：非空文本至少 1 token
  return Math.max(1, Math.ceil(wide * 0.6 + digits / 3 + narrow * 0.3))
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

export function messageTokens(message, imageTokens = IMAGE_TOKENS) {
  const content = message && message.content
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'image') {
      // 计价口径可以换（A4）：压缩收益校验用宿主按路由声明的真实图片价，
      // 地图展示与其它粗算仍用固定的 IMAGE_TOKENS。传 0 表示"这一块不算图片"，
      // 由调用方把真实的图片价单独加上去，避免同一张图被算两次。
      total += typeof imageTokens === 'function' ? imageTokens(block) : imageTokens
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
    } else if (typeof block.text === 'string') {
      // text 与 reasoning 都是真正进请求的文本块：thinking 模式的 API 要求把 reasoning
      // 原样回传，丢掉会被拒（实测返回 400：The reasoning_content in the thinking mode
      // must be passed back）。以前只认 text，reasoning 整块记 0 —— 一次 227 条的区间里
      // 它有 26 万字符，自估因此少一半（回归修复）。
      // 以后宿主再加新的文本类块，也走这一支，不会再静默记 0。
      // 边界：非文本块（file 等）不在这里计价，自估对它们偏保守；以后若出现带 text 展示
      // 字段的非文本块，要在这里按类型排除，别把展示文案算成请求内容。
      total += estimateTokens(block.text)
    }
  }
  return total
}
