// dsh-infinity-context —— 模型自己把旧对话折成三层摘要的 DSH 插件。
//
// 设计要点（详见 notes/2026-10-27-DSH原生分层压缩-设计方案.md §2.35 / §2.36）：
//   1. 只写宿主本来就认识的会话事件，不实现 ctx.compaction，不做代理，不拦截请求。
//   2. 层级不存盘：任何时刻都能从日志重算（块的身份靠检查点来源标记）。
//   3. 最上层只保留一块；压 L2 时产物正文 = 旧 L3 正文原样 + 新段落（尾部追加）。
//   4. L3 是多块区；l3 键把整个 L3 区压成一块（不接受 to）。

import { DEFAULTS, NAME } from './lib/config.js'
import { renderMap } from './lib/map.js'
import { estimateTokens } from './lib/tokens.js'
import { readZones } from './lib/blocks.js'
import { runCompress } from './lib/compress.js'
import { userMessage } from './lib/messages.js'
import { makeLogger } from './lib/log.js'

export const name = NAME
export const inject = ['tools', 'sessions', 'tokenMeter', 'agents', 'sessionProjections']

// 系统提示段：由配置渲染，同一份配置下逐字不变，所以不会破坏前缀缓存。
// 配置改了才变一次——这正是我们要的（提示里的数字必须和设置项一致）。
function infinityPrompt(config) {
  const pct = Math.round(config.triggerPct * 100)
  const lang = config.title && config.title.lang
  const titleTokens = (config.title && config.title.maxTokens) || 50
  const langHint = lang === 'en' ? '标题用英文写' : lang === 'any' ? '标题中英文皆可' : '标题用中文写'
  return [
    `本机装了分层压缩。占用超过 ${pct}% 后，每一轮你会收到一条提醒，提醒里直接带一张当前地图。收到提醒的那一轮必须真的调用 compress——回一句"我来压缩"不算；而且由这条提醒触发的压缩要从最上面还有内容的那一层开始，把下面几层一起压掉。`,
    '两个工具：context_map 看当前分层结构和「可压位置」；compress 把最旧的对话折成更短的摘要。',
    '四个键各压一层、产物进上一层：l0 压原文区产出 L1 块，l1 压 L1 区产出 L2 块，l2 压 L2 区并吸收旧 L3 产出 L3 块，l3 把整个 L3 区压成一块（l3 不写 to，其余必须写 to）。',
    '压缩是自下往上长的：先有 l0 压出来的 L1 块，l1 才有东西可并；先有 L2 块，l2 才有东西可并；L3 区有内容，l3 才有东西可缩。哪一层还是空的，就不能压它上面那一层——地图里写着「暂不可用」的就是这种情况。',
    '填表按时间线顺序：最老的一层先写，l3 → l2 → l1 → l0，跟它们覆盖的对话发生顺序一致。',
    '一次调用可以给多个键——一起给只断一次前缀缓存，拆成几次要给几次，所以攒够了一次压。',
    '历史里那些〔L1｜T16–T19｜ev 4121–4390〕标题开头的块是压缩结果（括号里是它所在的层、覆盖的轮次、被压掉的事件号范围），是已经成立的事实：直接在它们上面继续做事，不要复述、不要在回复里提它、不要把里面的事重做一遍。',
    '压掉的原文不会消失：需要细节时用会话搜索按事件编号取回。所以摘要写短没关系——但别每次压完就顺手取回，只有真需要原文时才取。',
    `摘要正文由你写进 summary，插件只搬运、不调模型。${langHint}，不超过 ${titleTokens} token；正文单块上限 l1 ${config.segment.l1} / l2 ${config.segment.l2} / l3 ${config.segment.l3}（按 token 算）。`,
    '只压已经结束、结果已经落地的轮次——判据是该轮所有工具调用都已有返回结果，且你后面不再需要它的输出；当前这一轮和正在跑的步骤不能压（地图会标出当前轮号）。',
    '压缩在表层上不可撤销（原文移出上下文，但能按事件编号检索回来）。',
    '不压的代价：写满之后服务端会直接以超出窗口拒掉整轮请求。',
  ].join('')
}
const CONTEXT_WINDOW_EXCEEDED = 'CONTEXT_WINDOW_EXCEEDED'

export function apply(ctx, rawConfig = {}) {
  const config = mergeConfig(rawConfig)
  const log = makeLogger('infinity-context')
  const reminded = new Map() // agentId -> { turn, count }：每轮最多一条，count 用来在第二次起换说法
  const overflowSaid = new Map() // agentId -> 上一次报超限发生在第几轮

  // 进程内状态只在会话活着时有意义：会话销毁就清掉，避免这两个表随会话数单调增长。
  ctx.on('agent/disposed', (payload) => {
    const id = payload && payload.agent ? payload.agent.id : null
    if (!id) return
    reminded.delete(id)
    overflowSaid.delete(id)
  })

  ctx.effect(() => ctx.tools.register(contextMapTool(ctx, config)))
  ctx.effect(() => ctx.tools.register(compressTool(ctx, config, log)))

  // /context-status：只读，给人看。插件出问题时先看它，而不是去翻日志文件。
  const commands = ctx.get('commands')
  if (commands && typeof commands.register === 'function') {
    ctx.effect(() =>
      commands.register({
        name: 'context-status',
        description: '看当前上下文的分层占用、块列表与提醒状态（只读，不改任何东西）',
        handler: (invocation) => {
          try {
            const text = renderMap(ctx, invocation.agent, config).text
            return { kind: 'success', text }
          } catch (error) {
            return { kind: 'error', text: `看不了：${String(error && error.message ? error.message : error)}` }
          }
        },
      }),
    )
  }

  // 静态提示段：字面量逐字不变，所以不会破坏前缀缓存。
  // 只讲纪律，不放任何数字或状态——那些由工具返回值和到线提醒负责。
  const prompt = ctx.get('systemPrompt')
  if (prompt) {
    const text = infinityPrompt(config)
      ctx.effect(() => prompt.section({ name: 'infinity-context', order: 500, text }))
  }

  // 到线就提醒：每轮一条，只在线上就一直提醒；掉下去就复位。不做任何机械措施。
  // 顺序要紧：先追加再 next()，否则提醒只能等到下一轮才见效。
  ctx.on('agent/pre-step', async (payload, next) => {
    if (config.notice.enabled) remindIfNeeded(ctx, config, reminded, payload)
    return next()
  })

  // 真的超了：只报一句，不自动压缩、不重试、不改写历史。
  // 同一轮只报一条：宿主可能在同一轮里重试多次，不去重会把这句话刷屏。
  ctx.on('agent/request-error', async (payload, next) => {
    const code = payload.failure && payload.failure.code
    if (code !== CONTEXT_WINDOW_EXCEEDED) return next()
    const id = payload.agent.id
    const turn = typeof payload.turn === 'number' ? payload.turn : null
    if (overflowSaid.get(id) === turn) return next()
    overflowSaid.set(id, turn)
    // 超限就停：不让 goal 自动续作把它一轮一轮地重新撞上去。
    // disarm 只摘掉「自动续作」这层权限，不动 goal 的落盘状态与人可见的 revision，人随时能 resume。
    try {
      const goals = ctx.get('goals')
      if (goals && typeof goals.disarm === 'function') goals.disarm(payload.agent)
    } catch {}
    log('overflow', { agent: id, turn })
    appendNotice(ctx, id,
      '上下文超出窗口，这一轮已经被服务端拒掉，停在这里，不会自动再试。' +
      '自动续作也已经停掉。请手动 /compact 压一下，或者把 maxTokens 调小 / 换一个窗口更大的模型，然后再让我继续。')
    return next()
  })
}

// 三种触发条件各自独立，同一条提醒里可以同时给出多条理由：
//   1) 占用达到 triggerPct（每一轮一条，同一轮多步只发一条）
//   2) 自上次提醒之后又长了 notice.growthTokens（总量还没到线时这条会先叫）
//   3) 某一层区超出设计容量（每层各自只在第一次越线时提醒，回落再涨才会再提醒）
function remindIfNeeded(ctx, config, state, payload) {
  const session = ctx.sessions.get(payload.agent.id)
  if (!session) return
  const usage = readUsage(ctx, session)
  if (!usage) return

  const id = payload.agent.id
  const turn = typeof payload.turn === 'number' ? payload.turn : null
  let st = state.get(id)
  if (!st) {
    st = { turn: null, count: 0, tokens: null, zones: {}, zonesTurn: null }
    state.set(id, st)
  }

  const grew = st.tokens === null ? 0 : usage.used - st.tokens
  const reasons = []
  if (usage.ratio >= config.triggerPct && st.turn !== turn) reasons.push('line')
  if (st.tokens !== null && grew >= config.notice.growthTokens) reasons.push('growth')

  // 区超限每轮最多查一次：它要全量扫一遍日志，别每步都扫。
  let zoneOver = {}
  if (st.zonesTurn !== turn) {
    st.zonesTurn = turn
    zoneOver = readZoneOver(ctx, session, config, usage.window)
    for (const key of ['l1', 'l2', 'l3']) {
      if (zoneOver[key] && !st.zones[key]) {
        st.zones[key] = true
        reasons.push('zone-' + key)
      } else if (!zoneOver[key]) st.zones[key] = false
    }
  }
  if (!reasons.length) return

  st.turn = turn
  st.count += 1
  st.tokens = usage.used

  const pct = Math.round(usage.ratio * 1000) / 10
  const line = Math.round(config.triggerPct * 100)
  const parts = []
  if (reasons.includes('line')) parts.push(`上下文已用 ${pct}%，超过 ${line}% 的提醒线。`)
  if (reasons.includes('growth')) parts.push(`距上次提醒又长了约 ${fmt(grew)} token（现在 ${pct}%）。`)
  if (st.count >= 2 && (reasons.includes('line') || reasons.includes('growth'))) {
    parts.push('上次提醒之后占用没有降下来——上次压得不够。')
  }
  if (reasons.includes('zone-l1')) {
    parts.push(`L1 区已超设计容量（${fmt(zoneOver.l1.used)}/${fmt(zoneOver.l1.limit)} token）：要压它就给 l1，并且连 l0 一起给（原文区还有内容的话）。`)
  }
  if (reasons.includes('zone-l2')) {
    parts.push(
      `L2 区已超设计容量（${fmt(zoneOver.l2.used)}/${fmt(zoneOver.l2.limit)} token）：要压它就给 l2，` +
        '并且连 l1、l0 一起给——压某一层的前提是比它浅的层都已经压完。',
    )
  }
  if (reasons.includes('zone-l3')) {
    parts.push(
      `L3 区已超设计容量（${fmt(zoneOver.l3.used)}/${fmt(zoneOver.l3.limit)} token）：要压它就给 l3，` +
        '并且连 l2、l1、l0 一起给。',
    )
  }

  // 地图随提醒一起给：省掉模型单独调一次 context_map 的整整一遍上下文往返。
  // 这张地图是此刻现算的，比模型自己调工具拿到的更新。
  let mapText = ''
  try {
    mapText = '\n\n' + renderMap(ctx, payload.agent, config).text
  } catch {}

  const text =
    parts.join('') +
    '现在压缩，而且这次必须从最上面那一层开始往下压：地图里还有内容的每一层都给一个键（L3 区没内容就跳过 l3），' +
    '一次调用把所有能压的键一起给完，填表顺序 l3 → l2 → l1 → l0（跟它们覆盖的对话时间顺序一致）。' +
    '一次调用只断一次前缀缓存，分层慢慢压会断好几次。' +
    '地图就在下面，直接用它给的位置，不用再单独调 context_map。' +
    '地图显示没有可压位置时，直接告诉用户上下文已满，建议手动 /compact 或让另一个 agent 在场外压完把结论带回来——' +
    '不要沉默，也不要假称压过了。不压的话，这一轮之后随时可能被服务端以超出窗口拒掉。' +
    mapText
  appendNotice(ctx, id, text)
}

function fmt(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// 尾部追加一条提示，不碰前缀。失败静默：提示发不出去不该影响这一轮。
function appendNotice(ctx, agentId, text) {
  const session = ctx.sessions.get(agentId)
  if (!session) return
  try {
    const message = userMessage({ content: [{ type: 'text', text }], source: { kind: 'infinity-context-notice' } })
    session.append('user/message', message, { surfaceOp: 'append' })
  } catch {}
}

function contextMapTool(ctx, config) {
  return {
    name: 'context_map',
    description:
      '查看当前上下文的分层结构：每一层占了多少、每个压缩块盖了哪几轮和它的标题、以及现在能压到哪里。' +
      '压缩之前必须先调这个：compress 里的位置写法只能从这张地图里抄。',
    parameters: { type: 'object', properties: {} },
    output: textOutput(),
    execute: async (_args, exec) => {
      const blocked = missingSessionQuery(ctx, config)
      if (blocked) return { text: blocked }
      const agent = requireAgent(ctx, exec)
      try {
      return { text: renderMap(ctx, agent, config).text }
    } catch (error) {
      return { text: '列地图时出错了：' + errText(error) }
    }
    },
  }
}

function compressTool(ctx, config, log) {
  const titleLimit = (config.title && config.title.maxTokens) || 50
  const seg = config.segment || {}
  return {
    name: 'compress',
    description:
      '把旧对话折成更短的摘要，摘要正文由你写在 summary 里。四个键各压一层、产物进上一层：' +
      'l0 压原文区最旧的一段→得到 L1 块；l1 压 L1 区最老的前 N 块→得到 L2 块；l2 压 L2 区前 N 块并吸收旧 L3→得到 L3 块（新正文接在旧 L3 后面）；l3 把整个 L3 区压成一块（唯一不写 to 的键）。' +
      '压缩是自下往上长的：哪一层还是空的，就不能压它上面那一层。' +
      '填表按时间线顺序，最老的一层先写：l3 → l2 → l1 → l0。' +
      '一次调用可以给多个键，一起给只断一次前缀缓存，所以攒够了一次压。' +
      `正文单块上限 l1 ${seg.l1} / l2 ${seg.l2} / l3 ${seg.l3}（按 token 算，不是字数）。` +
      '压完必须比被压掉的内容小；不达标整批不写，并会告诉你两侧的实际值。',
    parameters: {
      type: 'object',
      properties: {
        l3: blockSpec('把整个 L3 区压成一块（不写 to）', false, titleLimit, true),
        l2: blockSpec('压 L2 区最老的前 N 块（旧 L3 会被一起吸收），产物成为 L3 块', true, titleLimit, false),
        l1: blockSpec('压 L1 区最老的前 N 块，产物成为 L2 块', true, titleLimit, false),
        l0: blockSpec('压原文区最旧的一段，产物成为 L1 块', true, titleLimit, false),
      },
    },
    output: textOutput(),
    execute: async (args, exec) => {
      const blocked = missingSessionQuery(ctx, config)
      if (blocked) return { text: blocked }
      const agent = requireAgent(ctx, exec)
      let result
    try {
      result = await runCompress(ctx, agent, args || {}, config)
    } catch (error) {
      // 兜底：任何没被预料到的异常都要变成一句中文原因，别把 JS 堆栈甩给模型
      result = { ok: false, reason: '压缩时出错了：' + errText(error) }
    }
      if (!result.ok) {
        log('compress-rejected', { reason: result.reason, keys: Object.keys(args || {}) })
        return { text: `没能压缩：${result.reason}` }
      }
      log('compress-ok', { keys: result.results.map((r) => r.key), prunedChars: result.prunedChars })
      const lines = result.results.map(
        (r) => `${r.key} 成功：${r.title}（${r.shadowedCount} 条 -> 省 ${r.savedTokens} token）`,
      )
      if (result.prunedChars > 0) {
        lines.push(`顺带把超大的工具结果剪短了 ${result.prunedChars} 个字符（原文仍在日志里，可查回）。`)
      }
      return { text: lines.join('\n') }
    },
  }
}

// 统一 DSL：object 根不带 additionalProperties；必填用逐属性 required:true。
// 写法规范只在 l3 上写全（它排第一，模型从左往右生成时先读到），其余三个键给一行摘要，
// 否则同一段说明会随四个键各存一份，每轮请求白付四倍。
function blockSpec(desc, needTo, titleLimit, rich) {
  const titleFull =
    `一块的标题：中文名词短语，5–15 字，说清这块在讲什么事，同层之间要能互相区分（地图上只显示它）。上限 ${titleLimit} token。`
  const summaryFull =
    '这块的摘要正文。按这四行写，顺序不变，缺的行留空，不要另加小标题——' +
    '结论：<已定的决策与结论，连为什么选它>；' +
    '数据：<具体数值、标识符、文件名、路径、可直接复制的命令>；' +
    '未完：<还没做完的事与下一步，并标出哪些是已验证、哪些还只是推测>；' +
    '约束：<用户明确给出的约束与纠正>。' +
    '判断标准只有一条：删掉这段之后，下一轮你还会做出同样的决定、跑同样的命令吗？会就删，不会就留——所以删的是过程叙述，不是决策依据。' +
    '失败过的尝试要写：试过什么、为什么不行。不要写"如上所述"这类跨块引用，下次压缩后它会失效。' +
    '注意：更早的摘要里已经有的内容，只有在那个块这次不会被一起压掉时才能省；如果它就在你这次压掉的块里，必须写进新摘要。' +
    '只记事实和状态，不要写成一段对话：没真发出去的回复不要写成已发送，也不要列"已回答"这类清单。'
  const toFull =
    '压到哪个位置为止：l0 写轮锚点（如 T19，轮号就是对话里 "preparing turn 19" 的那个数，只能写已经结束的轮次）；l1/l2 写该区从 1 起的块序号，1 = 该区最老的块。只能从当前这张地图里抄。'
  const properties = {
    title: { type: 'string', required: true, description: rich ? titleFull : `同 l3 的 title：中文名词短语，5–15 字，上限 ${titleLimit} token。` },
    summary: { type: 'string', required: true, description: rich ? summaryFull : '同 l3 的 summary 规则：四行——结论（带理由）/ 数据 / 未完（含已验证与推测）/ 约束；删过程叙述，但决策依据和失败原因要留。' },
  }
  if (needTo) {
    properties.to = {
      type: 'string',
      required: true,
      description: rich ? toFull : '同 l3 的 to 规则：l0 写轮锚点（T19），l1/l2 写该区从 1 起的块序号（1 = 最老的块），只能从当前地图里抄。',
    }
  }
  return { type: 'object', properties, description: desc }
}

function textOutput() {
  return {
    schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  }
}

// 没有「会话搜索」就不让压：否则压掉的原文永久取不回，而模型不知道自己已经瞎了。
function missingSessionQuery(ctx, config) {
  if (!config.requireSessionQuery) return null
  const hasRead = !!(ctx.tools && ctx.tools.get && ctx.tools.get('session_event_read'))
  const hasSearch = !!(ctx.tools && ctx.tools.get && ctx.tools.get('session_event_search'))
  if (hasRead && hasSearch) return null
  return (
    '「会话搜索」插件没开：请在 DSH 里启用实验性插件「会话搜索」（session search）后重启会话。' +
    '没有它，压缩掉的原文取不回来，所以这两个工具先停用。'
  )
}
function errText(error) {
  return (error && error.message) ? String(error.message) : String(error)
}
function requireAgent(ctx, exec) {
  if (exec && exec.agent) return exec.agent
  const agent = ctx.agents && ctx.agents.requireInitiator ? ctx.agents.requireInitiator() : null
  if (!agent) throw new Error('拿不到当前会话所属的 agent')
  return agent
}

// 上下文占用：宿主投影里没有现成的百分比字段，按它的三个数自己算。
// used = pressureTokens + surfaceTokens - sampledSurfaceTokens（没有采样时退回 surfaceTokens）
// 占用读数：真实 usage 做锚、启发式只算增量，所以比例可信；
// 但绝对 token 数是我们自己的口径，别拿它跟宿主日志里的数对账。
function readUsage(ctx, session) {
  try {
    const s = ctx.sessionProjections?.stateOf?.(session, 'contextPressure')
    if (!s || typeof s.contextWindow !== 'number' || s.contextWindow <= 0) return null
    if (typeof s.surfaceTokens !== 'number') return null
    const hasSample = typeof s.pressureTokens === 'number' && typeof s.sampledSurfaceTokens === 'number'
    const used = hasSample ? Math.max(0, s.pressureTokens + s.surfaceTokens - s.sampledSurfaceTokens) : s.surfaceTokens
    return { ratio: used / s.contextWindow, used, window: s.contextWindow }
  } catch {
    return null
  }
}

// 各区实际占用：用插件自己的估算器（跟地图里显示的一致）。
// 不用宿主的计价：它按 4 字 1 token，中文被低估约 4 倍，区超限提醒在中文会话里几乎不会触发。
function readZoneOver(ctx, session, config, window) {
  const over = {}
  try {
    const zones = readZones(ctx, session)
    for (const key of ['l1', 'l2', 'l3']) {
      const list = (zones.zones && zones.zones[key]) || []
      const used = list.reduce((t, n) => t + estimateTokens(n.text || ''), 0)
      const limit = Math.round((config.budget[key] || 0) * window)
      if (limit > 0 && used > limit) over[key] = { used, limit }
    }
  } catch {}
  return over
}

function mergeConfig(raw) {
  return {
    ...DEFAULTS,
    ...raw,
    budget: { ...DEFAULTS.budget, ...(raw.budget || {}) },
    segment: { ...DEFAULTS.segment, ...(raw.segment || {}) },
    notice: { ...DEFAULTS.notice, ...(raw.notice || {}) },
  }
}
