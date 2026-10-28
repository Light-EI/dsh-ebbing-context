// 配置：长度一律按 token，只有标题按字符。可被 profile 的 bundle patch 行 config 覆盖。
// 纪律：配置项名字只在这里定义一次，别处一律引用，不许硬编码数字。

export const DEFAULTS = {
  // 各区总长上限（占上下文窗口的比例）。超了只在提醒里报数字，不做任何机械处置。
  budget: { l1: 0.10, l2: 0.06, l3: 0.03 },

  // 单块正文上限，单位是 token（不是字数）。用宿主的估算器算，
  // 这样中英文不会被同一个"5000 字"卡出两种完全不同的结果。
  // 超了直接拒绝写入，把实测值与上限回给模型。
  segment: { l1: 5000, l2: 2000, l3: 5000 },

  // 压缩比不设门槛、也不在提示里提。原来那套"至少 25 倍/8 倍"等于在鼓励模型
  // 往死里压；而压缩比只有下限没有上限，真压成一句话它也照样通过。
  // 现在只保留一条硬约束：压完必须比原来小（那是宿主的硬要求，不达标整批不落盘）。

  // 标题上限：用"等效 token"算（中文 1 字 = 1，其他 4 字符 = 1）。
  // 不用宿主的估算器——它按 CHARS_PER_TOKEN=4 直接除 text.length，
  // 中文会被低估约 4 倍（4 个汉字才算 1 token），拿来当长度尺子会松得离谱。
  title: { maxTokens: 50, lang: 'zh' },

  // 压缩前先让宿主剪一遍超大的工具结果（原位改写，原文仍在日志，可逆性比我们好）。
  // pruner 与宿主的 auto 无关：pruneSession 是 ctx.toolResultPruner 的公开同步方法，
  // 宿主只在它自己的自动压缩两条路上调它，我们关掉 auto 之后就得自己叫。
  pruneFirst: true,

  // 到线提醒：占用量达到 triggerPct 时，每一轮追加一条；掉回 triggerPct 以下即复位（没有滞回）。
  notice: {
    enabled: true,
      // 另一个独立触发条件：自上次提醒后上下文又长了多少 token，就再提醒一次
    // （总量还没到线、但一直在稳步变长时，这条会先叫）。
    growthTokens: 65000,
  },
  triggerPct: 0.75,

  // 取回：依赖宿主「会话搜索」实验性插件。缺失时每次调用这两个工具都直接报错，
  // 不静默降级——否则压缩不可逆，而模型不知道自己已经取不回原文了。
  requireSessionQuery: true,
}

export const NAME = 'dsh-infinity-context'
export const LOG_FILE = 'infinity-context.log'
export const STATUS_COMMAND = 'context-status'

// 块正文第一行的标题行格式：〔标题〕
export const TITLE_OPEN = '〔'
export const TITLE_CLOSE = '〕'

// 与原生成检查点逐字节对齐的前导（宿主未导出该常量，只能自建）
export const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. ' +
  'Treat the captured context as established background and build on it without restating it. ' +
  'Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

export const SUMMARY_OPEN_TAG = '<compacted-summary>'
export const SUMMARY_CLOSE_TAG = '</compacted-summary>'
