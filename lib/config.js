// 配置：长度一律按 token，只有标题按字符。可被 profile 的 bundle patch 行 config 覆盖。
// 纪律：配置项名字只在这里定义一次，别处一律引用，不许硬编码数字。

export const DEFAULTS = {
  // 各区总长上限（占可用输入预算的比例：窗口减输出预留，且不低于窗口的 10%）。
  // 超了只在提醒里报数字，不做任何机械处置。
  budget: { l1: 0.10, l2: 0.06, l3: 0.03 },

  // 单块正文上限，单位是 token（不是字数）。用插件自带估算器算（中文 1 字≈1 token），
  // 不用宿主那套 4 字 1 token 的口径，否则中英文会被同一个数字卡出两种结果。
  // 超了直接拒绝写入，把实测值与上限回给模型。
  segment: { l1: 5000, l2: 2000, l3: 5000 },

  // 压缩比不设门槛、也不在提示里提。原来那套"至少 25 倍/8 倍"等于在鼓励模型
  // 往死里压；而压缩比只有下限没有上限，真压成一句话它也照样通过。
  // 现在只保留一条硬约束：压完必须比原来小（那是宿主的硬要求，不达标整批不落盘）。

  // 标题上限：用"等效 token"算（中文 1 字 = 1，其他 4 字符 = 1）。
  // 不用宿主的估算器——它按 CHARS_PER_TOKEN=4 直接除 text.length，
  // 中文会被低估约 4 倍（4 个汉字才算 1 token），拿来当长度尺子会松得离谱。
  title: { maxTokens: 50 },

  // 剪掉超大的工具返回（原位改写，原文仍在日志，可逆性比我们好）。
  // 宿主的 toolResultPruner 是全局服务：任何工具返回超过 thresholdChars（默认 8192 字符）
  // 就把中间挖掉、留 head 4096 + tail 1024；它只碰 tool/result，碰不到 assistant/message
  // 与 user/message——所以压缩块和摘要剪不掉。
  // 宿主只在它自己的自动压缩两条路上调它（compaction-basic 的 context-overflow / pressure），
  // 我们关掉 auto 之后就得自己叫：压缩前一次（见 compress.js），每步请求前按需一次（maybePrune）。
  pruneFirst: true,

  // 压缩成功后，把「这次 compress 调用 + 它的返回」从表层折成一句短注。
  // 摘要里那份参数副本在被折成块之后就是纯重复：原文已经是顶部的块，它却还整份发一遍。
  // 必须在工具返回后的下一次 pre-step 做——那一刻工具结果才存在；只删调用会留下孤儿返回。
  // 代价：模型看不到自己那次调用的完整返回，只剩一句"成功了、压了什么"；摘要正文仍在块里。
  foldCallRecord: true,

  // 到线提醒：占用量达到 triggerPct 时每一轮追加一条；掉到线下就不再发到线提醒（没有滞回）。
  notice: {
    enabled: true,
      // 另一个独立触发条件：自上次提醒后上下文又长了多少 token，就再提醒一次
    // （总量还没到线、但一直在稳步变长时，这条会先叫）。
    growthTokens: 65000,
  },
  reservedTokens: 0,            // 输出预留读不到时的兜底值（0 = 不扣）
  triggerPct: 0.75,

  // 原文区（l0）必须留住的最后 N 轮：`to` 最多只写到 currentTurn − keepTurns。
  // 当前轮天然压不了；这条给"最近几轮还在用、压了就要立刻取回原文"留缓冲。
  keepTurns: 2,

  // 取回：依赖宿主「会话搜索」实验性插件。缺失时每次调用这两个工具都直接报错，
  // 不静默降级——否则压缩不可逆，而模型不知道自己已经取不回原文了。
  requireSessionQuery: true,
}

export const NAME = 'dsh-ebbing-context'
export const LOG_FILE = 'ebbing-context.log'
export const STATUS_COMMAND = 'context-status'

// 块正文第一行的标题行格式：〔L1｜T16–T19｜ev 4121–4390〕标题
export const TITLE_OPEN = '〔'
export const TITLE_CLOSE = '〕'

// 与原生成检查点逐字节对齐的前导（宿主未导出该常量，只能自建）
export const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. ' +
  'Treat the captured context as established background and build on it without restating it. ' +
  'Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

export const SUMMARY_OPEN_TAG = '<compacted-summary>'
export const SUMMARY_CLOSE_TAG = '</compacted-summary>'

// 配置自检：不依赖宿主的 schema 机制，自己也能把写错的配置挡下来。
// 原来只靠 schemastery，加载不到就静默跳过校验——用户以为设上了，其实走的是默认值。
export function validateConfig(raw) {
  const bad = []
  const num = (value, path, min, max) => {
    if (value === undefined) return
    if (typeof value !== 'number' || !Number.isFinite(value)) return bad.push(`${path} 应该是数字，现在是 ${JSON.stringify(value)}`)
    if (min !== undefined && value < min) bad.push(`${path} 不能小于 ${min}，现在是 ${value}`)
    if (max !== undefined && value > max) bad.push(`${path} 不能大于 ${max}，现在是 ${value}`)
  }
  const bool = (value, path) => {
    if (value === undefined) return
    if (typeof value !== 'boolean') bad.push(`${path} 应该是 true 或 false，现在是 ${JSON.stringify(value)}`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${NAME}: 配置必须是一个对象，现在是 ${JSON.stringify(raw)}`)
  }
  for (const group of ['budget', 'segment', 'title', 'notice']) {
    const value = raw[group]
    if (value === undefined) continue
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      bad.push(`${group} 应该是对象（形如 ${group}: { ... }），现在是 ${JSON.stringify(value)}`)
    }
  }
  const budget = raw.budget || {}
  for (const k of ['l1', 'l2', 'l3']) num(budget[k], `budget.${k}`, 0, 1)
  const segment = raw.segment || {}
  for (const k of ['l1', 'l2', 'l3']) num(segment[k], `segment.${k}`, 64)
  const title = raw.title || {}
  num(title.maxTokens, 'title.maxTokens', 4)
  const notice = raw.notice || {}
  bool(notice.enabled, 'notice.enabled')
  num(notice.growthTokens, 'notice.growthTokens', 0)
  bool(raw.pruneFirst, 'pruneFirst')
  bool(raw.foldCallRecord, 'foldCallRecord')
  bool(raw.requireSessionQuery, 'requireSessionQuery')
  num(raw.reservedTokens, 'reservedTokens', 0)
  num(raw.triggerPct, 'triggerPct', 0.1, 0.99)
  num(raw.keepTurns, 'keepTurns', 0, 50)
  const known = ['budget','segment','title','notice','pruneFirst','foldCallRecord','requireSessionQuery','reservedTokens','triggerPct','keepTurns']
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) bad.push(`不认识的配置项 ${key}（拼错了？可用的是 ${known.join(' / ')}）`)
  }
  const knownSub = { budget: ['l1','l2','l3'], segment: ['l1','l2','l3'], title: ['maxTokens'], notice: ['enabled','growthTokens'] }
  for (const [group, keys] of Object.entries(knownSub)) {
    const value = raw[group]
    if (value === undefined || value === null || typeof value !== 'object') continue
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) bad.push(`${group}.${key} 不认识（可用的是 ${keys.join(' / ')}）`)
    }
  }
  if (bad.length) {
    throw new Error(`${NAME}: 配置有 ${bad.length} 处不对，插件拒绝启动（以免你以为设上了、实际用的是默认值）：\n  - ${bad.join('\n  - ')}`)
  }
}
