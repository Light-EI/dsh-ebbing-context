// dsh-ebbing-context —— 模型自己把旧对话折成三层摘要的 DSH 插件。
//
// 设计要点（现行规范：docs/SPEC.md §4）：
//   1. 只写宿主本来就认识的会话事件，不实现 ctx.compaction，不做代理，不拦截请求。
//   2. 层级不存盘：任何时刻都能从日志重算（块的身份靠检查点来源标记）。
//   3. 最上层按块收纳；压 L2 得到的是一块新的 L3，落在 L3 区尾部，旧 L3 块原样不动（不拼接）。
//   4. L3 是多块区；l3 键把整个 L3 区压成一块（不接受 to）。

import { DEFAULTS, NAME, validateConfig, migrateConfig } from './lib/config.js'
import { renderMap } from './lib/map.js'
import { estimateTokens } from './lib/tokens.js'
import { issue, forget } from './lib/license.js'
import { openCompaction, readZones, zoneOrderFault, worthCompressing } from './lib/blocks.js'
import { runCompress } from './lib/compress.js'
import { userMessage } from './lib/messages.js'
import { rememberFold, forgetFold, foldCallRecordEx, callNodeOf, FOLD_KIND } from './lib/callfold.js'
import { makeLogger, logStatus } from './lib/log.js'
import { lastStateFailure, lastStateFallback, readGrowth, writeGrowth } from './lib/state.js'

export const name = NAME
// 宿主会按这份表决定"服务没就绪就不加载插件"。`sessionProjections` 只是性能退路
// （读轮次大纲的投影），缺了还能从会话日志里算，所以不进 inject，改用 ctx.get() 软取——
// 否则一个可选投影出问题就会让整个插件起不来（可选依赖）。
export const inject = ['tools', 'sessions', 'tokenMeter', 'agents']

// 配置校验：宿主只在拿到 Config 时才会校验 bundle patch 里的 config。
// 没有它，把 budget 写成字符串之类只会静默走默认值，用户以为设了其实没设。
// schemastery 是宿主自带的依赖；万一某个 profile 里没有，就退化为"不校验"，不让插件因此起不来。
let Config
try {
  const { default: Schema } = await import('@deepseek-ai/schemastery')
  // 宿主只把带 volatile 标记的字段暴露成可编辑表单（dsh-settings 的 volatileForm 递归挑 meta.volatile），
  // 没有 volatile 字段时整个命名空间不会出现，配置页就只会显示“没有可编辑的配置”。
  // 写法与 dsh-better-sidebar 一致：先构造完整 schema，再给叶子逐个加 .volatile()。
  const V = (schema) => schema.volatile()
  Config = Schema.object({
    budget: Schema.object({
      l1: V(Schema.number().min(0).max(1).default(DEFAULTS.budget.l1)),
      l2: V(Schema.number().min(0).max(1).default(DEFAULTS.budget.l2)),
      l3: V(Schema.number().min(0).max(1).default(DEFAULTS.budget.l3)),
    }).default(DEFAULTS.budget),
    segment: Schema.object({
      l1: V(Schema.number().min(64).default(DEFAULTS.segment.l1)),
      l2: V(Schema.number().min(64).default(DEFAULTS.segment.l2)),
      l3: V(Schema.number().min(64).default(DEFAULTS.segment.l3)),
    }).default(DEFAULTS.segment),
    title: Schema.object({
      maxTokens: V(Schema.number().min(4).default(DEFAULTS.title.maxTokens)),
    }).default(DEFAULTS.title),
    pruneFirst: V(Schema.boolean().default(DEFAULTS.pruneFirst)),
    foldCallRecord: V(Schema.boolean().default(DEFAULTS.foldCallRecord)),
    notice: Schema.object({
      enabled: V(Schema.boolean().default(DEFAULTS.notice.enabled)),
      growthTokens: V(Schema.number().min(0).default(DEFAULTS.notice.growthTokens)),
      // 提醒过一轮、模型选择"这一轮不压"时退回多少增长额度（%）。100 = 全额退回。
      growthResetPct: V(Schema.number().min(0).max(100).default(DEFAULTS.notice.growthResetPct)),
      // 子代理要不要也参与（默认 true）：它们同样会碰到已压缩的表层，没有轮次标记就看不出
      // 「这块盖住了哪几轮」；想安静可以在面板关掉。
      notifySubagents: V(Schema.boolean().default(DEFAULTS.notice.notifySubagents)),
    }).default(DEFAULTS.notice),
    reservedTokens: V(Schema.number().min(0).default(DEFAULTS.reservedTokens)),
    // 少了这一行，宿主解析出的 config 里根本没有这个键：面板与 YAML 改了都不生效，
    // validateConfig 里那条却一直在，于是永远用默认值 2 —— 那种"设了等于没设"比没有控件更坏。
    keepTurns: V(Schema.number().min(1).max(50).default(DEFAULTS.keepTurns)),
    triggerPct: V(Schema.number().min(0.1).max(0.99).default(DEFAULTS.triggerPct)),
    requireSessionQuery: V(Schema.boolean().default(DEFAULTS.requireSessionQuery)),
  })
} catch {
  Config = undefined
}
export { Config }

// 系统提示段：由配置渲染，同一份配置下逐字不变，所以不会破坏前缀缓存。
// 配置改了才变一次——这正是我们要的（提示里的数字必须和设置项一致）。
function ebbingPrompt(config) {
  const pct = Math.round(config.triggerPct * 100)
  // 标题语言只有中文这一种实现：工具参数里给模型的写作要求是写死中文的。
  // 只放"每轮都要用、又没法塞进工具描述"的东西：什么时候该压、块头怎么读、原文去哪取。
  // 填表规矩（四个键各压一层、级联、最后一块不压、to 怎么写、单块上限、被拒了怎么办）
  // 全部只在 compress 的 description 与参数描述里写一份——那里离填表最近，模型调用时必然读到，
  // 系统提示里再抄一遍就是每轮多付一份钱。
  return [
    `本机装了分层压缩。占用到 ${pct}%、最近又长了一大截、或某一层超出配额时，插件会在一轮收尾把你叫醒一次，第一条消息就是提醒（带当前地图）。提醒是让你自己判断要不要压：决定压就真的调用 compress（只回一句"我来压缩"不算），不压就说一句为什么、继续干活。`,
    '两个工具：context_map 看当前分层结构和「可压位置」；compress 把最旧的对话折成更短的摘要（填法、级联与上限都写在它的说明与参数里）。',
    '摘要正文由你写进 summary，插件只搬运、不调模型。',
    '形如〔轮次标记〕的那条消息是插件写的轮次分界线，不是用户说的话：它后面紧跟的内容就是它写的那一轮。压缩时写 to 就照它认轮号。',
    '历史里那些形如〔L1｜T16–T19｜ev 4121–4390〕标题开头的块是压缩结果（这只是格式示例，真实轮次与事件号以地图和块本身为准；括号里是它所在的层、覆盖的轮次、被压掉的事件号范围），是已经成立的事实：直接在它们上面继续做事，不要复述、不要在回复里提它、不要把里面的事重做一遍。',
    config.requireSessionQuery === false
      ? '压掉的原文不会消失（还在会话日志里）。这台机器若装了会话搜索，按事件号能查回来；没装的话原文只在日志文件里。所以摘要写短没关系，但别每次压完就顺手取回，只有真需要原文时才取。'
      : '压掉的原文不会消失（还在会话日志里），用 session_event_read 按事件号能读回来；这个工具没装时，compress 与 context_map 会直接停用。所以摘要写短没关系，但别每次压完就顺手取回，只有真需要原文时才取。',
    '压缩在表层上不可撤销（原文移出上下文）。',
    '不压的代价：写满之后服务端会直接以超出窗口拒掉整轮请求。',
  ].join('')
}
const CONTEXT_WINDOW_EXCEEDED = 'CONTEXT_WINDOW_EXCEEDED'
// 提醒的来源标记。用宿主已登记的 `cordis-host-runner`：Client 的 turn-trigger 卡片
// 按 source.kind 选标题与图标（dsh-client-ui-chat 的 chat-client.js 里，这个 kind
// 映射到「插件状态更新」+ plugin 图标）；用自造的 kind 会落回默认的「收到执行请求」，
// 看起来像用户自己发起的请求。
// 它同时是 noteUserSpoke() 的判据：这一轮是用户开口的，还是我们自己把自己叫醒的。
const NOTICE_KIND = 'cordis-host-runner'

// 轮次标记：插件写进会话的"轮与轮之间的分界线"，内容形如「〔轮次标记〕下一轮 T57」。
// 它和提醒一样是我们写的，但语义不同（不是催模型压缩），所以单独一个 kind；
// UI 上仍旧走宿主已登记的 cordis-host-runner 那套渲染，看起来还是"插件状态更新"。
// 为什么不用 assistant/message：它不能带 sourceEventSeqs，连插入都做不到（session-surface.ts:336）。
const MARKER_KIND = 'ebbing-context-marker'
// noteUserSpoke() 用它判断"这一步认领到的消息是不是我们写的"。
// 折叠短注也是一种"我们自己写的 user/message"。不登记它的话，pre-step 会把它当成
// 用户真的开口了（foreign 判定），于是下一轮叫醒规则整段失效。
const OUR_KINDS = new Set([NOTICE_KIND, MARKER_KIND, FOLD_KIND])
// 插件自己写的每条消息都带这行哨兵（设计约束）：kind 是借来的展示身份，哨兵才是真身份。
// 宿主的 cordis-host-runner 消息不会带它，所以我们不会把它误认成自己的旧提醒，
// 也不会把它的文字当成"用户开口了"。
const OWN_SENTINEL = '〔Ebbing Context 插件注入〕'

// 成功回执的每一行：单位按层分（原文区数“条消息”，区块数“个块”）。
// 抽成导出函数是为了能被测试直接钉住——第六轮审查 A/B 都指出这几行没人守，
// 改坏了（退回“N 条”双单位）测试照样全绿。
export function describeResults(results) {
  return (Array.isArray(results) ? results : []).map(
    (r) => `${r.key} 成功：${r.title}（${r.key === 'l0' ? r.shadowedCount + ' 条消息' : r.shadowedCount + ' 个块'} -> 省 ${r.savedTokens} token）`,
  )
}

// 成功回执的收手提醒：本轮压完就停，不要在同一轮里再发第二次 compress。
// 用户要求（2026-11-05）：模型会在同一轮里连压多次——每次压缩都要整段替换表层并重算地图，
// 连压两回只会把同一轮烧两遍；而且一次调用本来就能把还能压的层一起给完。
export const RECEIPT_STOP_LINE = '本轮压缩已经完成，请在本轮不要继续压缩。'

// 成功回执的正文行：结果行 → 可选说明（剪短、缺轮）→ 刷新后的地图 → 收手提醒。
// 抽成导出函数是为了能被测试直接钉住（缺口台账：改文案 = 改逻辑，每处文案都要有正向断言）。
export function receiptLines(results, extras = {}) {
  const lines = describeResults(results)
  if (extras.prunedChars > 0) {
    lines.push(`顺带把超大的工具结果剪短了 ${extras.prunedChars} 个字符（原文仍在日志里，可查回）。`)
  }
  const swallowed = Array.isArray(extras.swallowed) ? extras.swallowed : []
  if (swallowed.length) {
    lines.push(`这次切点跨过了轮次记录里缺失的 ${swallowed.map((t) => `T${t}`).join('、')}——它们的内容已经一起压进块里，块头标签只写到 to 那一轮。`)
  }
  if (extras.mapText) lines.push(extras.mapText)
  // 收手提醒放在地图之后：否则"可写 to 的轮号/序号"紧跟在"不要继续压缩"后面，两句话会打架。
  lines.push(RECEIPT_STOP_LINE)
  return lines
}

export function apply(ctx, rawConfig = {}) {
  // 老配置项先迁移（forgivePct → growthResetPct、根层的 notifySubagents 挪进 notice）：
  // 宿主保存配置后不会重新 apply，但启动时会，所以这里改一次就够；运行时那层读的也是同一个对象。
  // 迁移可能返回拷贝（宿主若冻结配置对象），后续一律用返回值。
  rawConfig = migrateConfig(rawConfig)
  // 自己先验一遍：不依赖宿主 schema，加载不到 schemastery 也不会静默放过写错的配置。
  // 宿主把带 volatile 标记的字段解析成引用对象（{ get(), [write] }），不是裸值；
  // 直接拿它做 typeof 判断会全部判错（数字/布尔都成了 object），所以先解引用。
  const plainConfig = unwrapVolatile(rawConfig)
  validateConfig(plainConfig)
  // 宿主保存 volatile 字段时只原地更新引用（loader 里 equalExceptVolatile → _commitVolatile），
  // **不会重新 apply**，所以启动时的快照会在改完参数后一直生效。这里改成每次读都解引用。
  const config = makeLiveConfig(rawConfig)
  const log = makeLogger('ebbing-context')
  // 静默夹取也要留痕：keepTurns 被夹过（0 → 1、999 → 50）时记一次日志，
  // 用户改完面板能在日志里看到实际生效的值（维护手册 §配置的承诺）。
  const keepTurnsLogged = { done: false }
  const reminded = new Map() // agentId -> { turn, count }：每轮最多一条，count 用来在第二次起换说法
  // 待发的提醒：命中之后每一步都覆盖一次（最后一步的读数最接近收尾那一刻），
  // 收尾时按「同一个 AbortSignal」把它认回来——turn-stopping 的载荷形状是 { turn, signal }，
  // 不保证带 agent（宿主 0.2.x 会用 agentEvents 融合注入 agent，但那是实现细节、不写进契约），
  // 所以认领只按 signal，不按 agentId。
  const pendingBySignal = new WeakMap() // 本轮信号 -> 待发记录
  const pendingByAgent = new Map() // agentId -> { signal, record }：只为清理异常收场留下的孤儿
  // agentId -> { turn, count }：这一轮报了超限，以及连着第几次。
  // 为什么要计数（设计约束）：宿主自带的压缩默认开着（auto: true），
  // 它会在同一条 request-error 上自己救一次并返回 retry。我们要是当场就宣布"没救"、
  // 顺手把自动续作缴械，那句话就是假话——所以第一次只给中性提示，连着第二次才认死。
  // 成功收尾（turn-stopping 会来）就清零，下一次超限重新从"可能能自愈"开始。
  const overflowSaid = new Map()
  const foldQueues = new Map() // agentId -> Map<callId, { lines }>：等下一次 pre-step 收

  // 进程内状态只在会话活着时有意义：会话销毁就清掉，避免这两个表随会话数单调增长。
  // 会话销毁时把许可证也清掉
  ctx.on('agent/disposed', (payload) => {
    const id = payload && payload.agent ? payload.agent.id : null
    if (!id) return
    reminded.delete(id)
    pendingByAgent.delete(id)
    overflowSaid.delete(id)
    foldQueues.delete(id)
    // 按步的用量缓存也清掉：以前只在 compress 出口删自己的键，从不压缩的代理（尤其子代理）
    // 会一直留一条 agentId → 步戳（回归修复）。
    stepStamps.delete(id)
    // beginUsageStep 在 session.id 与 agentId 不同时还会记第二个键（readUsage 手上只有 session）：
    // 那个键也要跟着回收，否则每注销一个代理就残留一个短字符串（回归修复）。
    const goneSession = ctx.sessions.get(id)
    if (goneSession && typeof goneSession.id === 'string' && goneSession.id !== id) stepStamps.delete(goneSession.id)
    forget(id)
  })

  // 工具说明里的数字（单块上限、标题上限）和系统提示一样是"写死在注册文本里"的，
  // 而宿主保存 volatile 配置只会原地更新引用、不会重新 apply，所以这里做成可重建：
  // 收到 loader/volatile-update 就撤掉旧的、按新值重注册一遍。
  const rebuilders = []
  const rebuild = () => {
    for (const dispose of rebuilders.splice(0)) { try { dispose() } catch (e) { /* 单个失败不影响其他的重建 */ } }
    rebuilders.push(ctx.effect(() => ctx.tools.register(contextMapTool(ctx, config))))
    rebuilders.push(ctx.effect(() => ctx.tools.register(compressTool(ctx, config, log, foldQueues, reminded))))
    const prompt = ctx.get('systemPrompt')
    if (prompt) rebuilders.push(ctx.effect(() => prompt.section({ name: 'ebbing-context', order: 500, text: ebbingPrompt(config) })))
  }
  rebuild()
  ctx.on('loader/volatile-update', () => {
    // 宿主这个事件本来就按 fiber 过滤、只送达本插件的监听器（cordis-plugin-loader 的
    // `_commitVolatile` 里 `Context.filter` 只放行 owner.fiber === fiber 才 emit），
    // 所以"别的插件改配置会打断我们"这个前提不成立——无条件重建就是对的（回归修复）。
    // 曾按载荷里的名字/键名过滤，结果把 segment/title/budget 这些真实改动全挡在门外：
    // 注册出去的提示词与工具描述会停在旧数字上，和运行时行为不一致。
    rebuild()
  })

  // /context-status：只读，给人看。插件出问题时先看它，而不是去翻日志文件。
  const commands = ctx.get('commands')
  if (commands && typeof commands.register === 'function') {
    ctx.effect(() =>
      commands.register({
        name: 'context-status',
        description: '看当前上下文的分层占用、块列表与可压位置（只读，不改任何东西；折叠失败或跳过的原因会附在末尾）。',
        handler: (invocation) => {
          try {
            const mapSession = ctx.sessions.get(invocation.agent.id)
        const mapUsage = mapSession ? readUsage(ctx, mapSession, config) : null
        const rendered = renderMap(ctx, invocation.agent, config, mapUsage)
        // 正向信号：用户 2026-11-05 问「怎么知道读表层成功了」。读失败有错误回执，
        // 成功却什么都不说，于是补一行"读到什么"——数字对不上时也能一眼看出。
        const surfaceLine = (() => {
          try {
            const n = mapSession && mapSession.surface && Array.isArray(mapSession.surface.nodes)
              ? mapSession.surface.nodes.length
              : null
            const m = mapSession && typeof mapSession.deriveMessages === 'function'
              ? mapSession.deriveMessages().length
              : null
            if (n === null || m === null) return '表层读取：正常（节点数读不出，但地图已算出来）'
            return `表层读取：正常（${n} 个节点 / ${m} 条消息）`
          } catch (error) {
            return '表层读取：正常（但节点/消息数读不出：' + String((error && error.message) || error) + '）'
          }
        })()
        // 日志写没写出来也必须可见：以前建目录失败会永久关闭，出问题时连痕迹都没有。
        const logLine = (() => {
          try {
            const st = logStatus()
            if (!st.writable) return '运行日志：不可写（建不了目录，也退不到临时目录）'
            return st.origin === 'temp'
              ? `运行日志：${st.path}（DSH_HOME 下建不了，已退到临时目录）`
              : `运行日志：${st.path}`
          } catch (error) {
            return '运行日志：状态读不出（' + String((error && error.message) || error) + '）'
          }
        })()
        const text = surfaceLine + '\n' + logLine + '\n\n' + rendered.text
        // 标记被跳过不是故障（§3.4 的两道护栏）：只在人手看的状态里提一句，
        // 免得排查"地图轮号和上下文里的标记对不上"时无从下手。
        const notes = rendered.zones && rendered.zones.markerNotes
        const markerText = notes && notes.length
          ? `\n\n有 ${notes.length} 条〔轮次标记〕与算出来的边界对不上，已跳过（定位仍按事件号，轮号可能偏粗）。`
          : ''
            // 折叠失败原本只写进日志文件：插件"看起来"一切正常，只是调用记录没折掉、白花 token。
            // 这里把它摆到人一眼能看到的地方。
            const queue = foldQueues.get(invocation.agent.id)
            const failure = queue && queue.lastError
            const skip = queue && queue.lastSkip
            const failureText = failure
              ? `\n\n折叠上一次失败（${failure.at}）：${failure.error}\n调用记录原样留着，没有伤到会话；但如果每次都失败，压缩就会多花一份摘要的钱。`
              : ''
            const skipText = skip
              ? `\n\n折叠上一次跳过（${skip.at}）：${skip.error}\n跳过不等于出错：调用记录没动，表层也没改写。`
              : ''
            return { kind: 'success', text: text + markerText + failureText + skipText }
          } catch (error) {
            return { kind: 'error', text: `看不了：${String(error && error.message ? error.message : error)}` }
          }
        },
      }),
    )
  }


  // 到线就提醒：只在**越线那一刻**报一条，掉回线下再重新上越线才会再报（掉线即复位）。
  // 不做任何机械措施——不自动压、不重试、不催 /compact。
  // 顺序要紧：先判定、收尾再投递（见 flushNotice），投递只在 turn-stopping 做。
  ctx.on('agent/pre-step', async (payload, next) => {
    if (!keepTurnsLogged.done) {
      keepTurnsLogged.done = true
      const rawKeep = rawConfig ? unwrapVolatile(rawConfig).keepTurns : undefined
      if (typeof rawKeep === 'number' && rawKeep !== config.keepTurns) {
        log('config-clamped', { agent: payload && payload.agent && payload.agent.id, from: rawKeep, to: config.keepTurns })
      }
    }

    // 宿主不在 waterfall 外层兜异常：抛出去会被 kick() 的 catch 静默吞掉，整轮不再发请求、
    // 用户也看不到原因（cordis events.ts waterfall 无 try/catch → agent-loop:1010 throwError）。
    // 所以这里自己兜住——任何一步失败只放弃本次动作，绝不阻断这一轮。
    // 轮次大纲损坏属于"插件在这种表上无法安全工作"，不是能降级的小问题：判不准每一轮到哪儿结束，
    // 切下去就可能把进行中的轮当已结束轮压掉。用户要求这种情况直接报成屏幕上的红色错误，
    // 这一轮不发请求（"本对话不可使用"），所以这条故意抛到 try 外面——让宿主的 throwError 走到 UI，
    // 而不是被我们自己吞掉。每一轮都重判：真修好了（日志重新可用）就自己恢复，不用重启。
    // 配置硬错误与大纲损坏一样不许降级：keepTurns < 1 等于允许把进行中的轮压掉。
    // 只在"根 agent"上工作：子代理是我们派出去干活的助手，不是用户在聊的这份对话。
    // 不过 `notice.notifySubagents` 默认 true——子代理也会碰到已压缩的表层，没有轮次标记
    // 就看不出块盖住了哪几轮，所以默认连子代理一起写；只有用户把它关掉时才静默。
    // 子代理判据见 isSubagent()：0.2.2-rc.2 起看持久化会话头，老宿主退回 `agents.roots()`。
    const quiet = isSubagent(ctx, payload.agent) && !(config.notice && config.notice.notifySubagents)
    // 只读检查（用户定下的规矩）：日志里停着没闭合的压缩事务时，**这一轮什么节点都不写**。
    // 为什么不等 compress 自己拒：宿主在写 turn/start 之后、我们第一次拿到控制权时，
    // 只要再 append 一个节点（轮次标记、提醒都不行），这条日志就更难修；
    // 而"打开/恢复会话"本身会先补 turn/end，那一步直接把日志写死（重放报 SessionFormatError）。
    // 抛到 try 外面 → 宿主把它当红色错误显示，这一轮不发请求。
    // openCompaction 认的是"end-seed 之前没闭合"的孤儿；被宿主认领过（后面有 end-seed）的返回 null，
    // 那种情况不会误报——见 blocks.js 的注释。
    if (!quiet) {
      const stuckSession = ctx.sessions.get(payload.agent.id)
      const stuck = stuckSession ? openCompaction(stuckSession) : null
      if (stuck) {
        log('pre-step-open-compaction', { seq: stuck.seq, compactionId: stuck.compactionId })
        throw new Error(
          '发现日志里有一个没有结束的压缩事务（compaction/start 缺 compaction/end，' +
            'compactionId=' + (stuck.compactionId || '（没有写 id）') + '，事件号 ' + stuck.seq + '）。' +
            '这一轮不会写任何东西、也不会发请求：再往这条会话里写节点会让它的日志彻底打不开。' +
            '先完全退出 DSH，备份会话日志，再补一条配对的 compaction/end（同一个 compactionId、同一个 turn，带 error）' +
            '或从那条 compaction/start 之后截断；确认能正常加载之后再回来继续对话。' +
            '（界面里还能看到历史消息，是因为宿主在重启前不会重放校验——不要在这条会话里继续发消息。）',
        )
      }
    }
    // 每一步只扫一次表层：三个用途共用这一份（判大纲损坏 / 区超限 / 哪几层压得动）。
    // 以前这三处各扫一遍，长会话每轮要做上百万次比较（设计约束）。
    beginUsageStep(payload.agent.id, payload.turn, payload.step, ctx.sessions.get(payload.agent.id))
    let stepZones = null
    try {
      const stepSession = ctx.sessions.get(payload.agent.id)
      if (stepSession) stepZones = readZones(ctx, stepSession, payload.agent, log)
    } catch (error) {
      // 读不到表层就退化成"这一步没有区快照"：后面的提醒会少一张地图。
      // 以前这里是一个空 catch，日志里一个字都没有，出了问题查不到（第六轮审查 B）。
      if (typeof log === 'function') log('read-zones-failed', { error: errText(error) })
    }
    const broken = quiet ? null : fatalOutline(ctx, payload, stepZones, log)
    if (broken) throw new Error(broken)
    try {
      // 先收上一次 compress 的调用记录：这一步仍在同一个 turn 内，且在下一次请求之前，
      // 所以那份参数副本不会再被发出去一次。
      // 折叠只是收拾我们自己的回执，不算'打扰'：关掉子代理通知时也要折（回归修复）。
      foldPending(ctx, config, foldQueues, payload, log)
      // 这里不再顺手剪工具返回。宿主的剪枝是「压缩的前置步骤」（pressure 越过阈值
      // 或 context-overflow 时才叫），我们与它同构：只在 compress 里剪一次。
      // 想每步都剪的话会越权改写模型正在用的内容，而且剪掉的内容不一定取得回来
      // （没装会话搜索时工具是停用的，剪枝却不受那道闸门约束）。
      // 上一轮以异常/取消收场时 turn-stopping 不会来，那条提醒的信号已经作废。
      // 它记录的是「那一刻」的读数，发出去就是过期信息——直接丢掉，让这一步重新判一次。
      dropStaleNotice(pendingByAgent, payload, log)
      // 用户真的开口了：解除「刚叫醒过一轮」的闸，下一轮结束还能再叫醒。
      noteUserSpoke(reminded, payload)
      if (!quiet && config.notice.enabled) remindIfNeeded(ctx, config, reminded, pendingBySignal, pendingByAgent, payload, log, stepZones)
      // 轮次标记与提醒无关：它就是"这一轮从哪开始"的路标，模型靠它把「压掉 T1–T15」对上号。
      // 正常情况下上一轮收尾已经写好「下一轮 T{N}」；没写（异常收场、会话开头、老历史）这里补。
      if (!quiet) ensureTurnMarker(ctx, reminded, payload, log)
    } catch (error) {
      // 任何失败都只放弃本次动作，不打断这一轮：插件没有"值得让宿主报红"的错误——
      // 报红发生在用户消息被 claim 之后，等于吞掉用户的话。
      log('pre-step', { agent: payload.agent && payload.agent.id, error: String((error && error.message) || error) })
    }
    return next()
  })

  // 本轮收尾：把这一步之前攒下的提醒发出去。发法有两种（见 deliverNotice）：
  //   · 正常情况下直接 agent.followup() 排进 inbox 的 next-turn —— 宿主在本轮 turn/end 之后
  //     发现 inbox 有货就立刻开新的一轮，于是模型在用户下一条消息之前就被叫醒去压；
  //   · 这一轮本来就是被叫醒的那轮（或者拿不到 agent）就退化成尾部追加，只留记录、不再连环叫醒。
  // serial 事件：宿主用 `dispatch.serial(...)` 派发（dsh-agent-loop 的收尾处），
  // 监听器只收到荷载，**没有 next 参数**。这里若写 `return next()` 就是
  // `TypeError: next is not a function` —— 收尾阶段抛错会让整轮以失败结束
  // （真机反馈：模型已经答完，界面却报 "本轮运行失败 next is not a function"）。
  // 同理要自己兜异常：抛出去会拦掉宿主的收尾流程。
  ctx.on('agent/turn-stopping', async (payload) => {
    try {
      if (isSubagent(ctx, payload.agent) && !(config.notice && config.notice.notifySubagents)) {
        // 静默子代理也要清超窗计数：它同样会走 request-error 记一笔，而收尾被这里早退，
        // 攒两次就变成"连着两轮超窗"、误停它的自动续作（回归修复）。
        if (payload.agent && payload.agent.id) overflowSaid.delete(payload.agent.id)
        return
      }
      // 收尾前补一次折叠（设计约束）：压缩恰好是本轮最后一个动作时（被截断、
      // 用户点了停止、没有下一步了），下面写轮次标记会把「调用 + 返回」挤出队尾，
      // 下一轮只能判 not-tail 永久放弃——那份参数副本和整张地图此后每轮都要再发一遍。
      // 这里先折一次：只折队尾那一对（缓存不变式不变），折不成就算了，不重试。
      // 收尾载荷不保证带 agent（宿主 0.2.x 靠 agentEvents 融合才补上），没有就跳过。
      // 单独包一层 catch：折叠失败不能把后面的轮次标记一起拖下水——标记缺了，
      // 下一轮的地图就少一个锚点，比多花几百 token 严重得多。
      if (payload.agent) {
        try {
          foldPending(ctx, config, foldQueues, payload, log)
        } catch (error) {
          log('fold-at-turn-end', { error: String((error && error.message) || error) })
        }
      }
      // 这一轮正常收尾 = 请求成功过：超窗的"连着第几次"清零，下次重新从"可能能自愈"开始。
      if (payload.agent && payload.agent.id) overflowSaid.delete(payload.agent.id)
      flushNotice(ctx, config, reminded, pendingBySignal, pendingByAgent, payload, log)
      // 先发再结算：刚发出去的那条会把 growthPending 记成本轮，这里看到 turn <= pending 就跳过；
      // 真正要结算的是"上一轮发的提醒，这一轮还没压"。
      settleGrowth(ctx, config, reminded, payload, log)
      // 给"下一轮"留路标：这一轮压不压都不影响它，它只是告诉模型下一轮的轮号。
      markNextTurn(ctx, reminded, payload, log)
    } catch (error) {
      log('turn-stopping', { error: String((error && error.message) || error) })
    }
  })

  // 真的超了：只报一句，不自动压缩、不重试、不改写历史。
  // 同一轮只报一条：宿主可能在同一轮里重试多次，不去重会把这句话刷屏。
  // 两次判定（设计约束）：宿主的 compaction-basic 默认 auto: true，它会在
  // 同一条 request-error 上做 overflow 恢复并返回 retry。第一次超限就宣布"没救"是假话，
  // 所以第一次只给中性提示（不 disarm）；连着第二次还超，才认死并停掉自动续作。
  ctx.on('agent/request-error', async (payload, next) => {
    // 这个 waterfall 不兜异常（宿主的 emit 兜、waterfall 不兜）：任何一步抛错都会让
    // 这一轮以 error 收场，而且用户看不到超限那句提示。所以整段包起来。
    try {
      const code = payload.failure && payload.failure.code
      if (code === CONTEXT_WINDOW_EXCEEDED) {
        const id = payload.agent.id
        const turn = typeof payload.turn === 'number' ? payload.turn : null
        const prev = overflowSaid.get(id)
        // 同一轮里宿主可能重试多次（每次失败都派一次 request-error）：只记一次，
        // 否则一轮五次重试就会被数成"连着两轮"，第一次超窗就缴了自动续作。
        const repeat = Boolean(prev && prev.turn === turn)
        const count = repeat ? prev.count : (prev ? prev.count + 1 : 1)
        overflowSaid.set(id, { turn, count })
        if (!repeat && count === 1) {
          log('overflow-first', { agent: id, turn })
          try {
            appendNotice(ctx, id,
              '〔Ebbing Context 超窗提示 · 插件注入，不是用户说的话〕\n' + OWN_SENTINEL + '\n' +
              '上下文超出窗口，这一轮被服务端拒掉了。宿主自带的压缩如果开着，它可能自己救一次、' +
              '然后这一轮照常继续——如果下一轮恢复正常，请忽略这句话。' +
              '要是连着两轮都被服务端拒掉，我会再报一次，那时才真的压不动。', log)
          } catch (error) {
            log('request-error', { agent: id, error: String((error && error.message) || error) })
          }
        } else if (!repeat && count === 2) {
          // 连着第二次：这时候才停。超限就停是不让 goal 自动续作一轮一轮地重新撞上去。
          // disarm 只摘掉「自动续作」这层权限，不动 goal 的落盘状态与人可见的 revision，人随时能 resume。
          try {
            const goals = ctx.get('goals')
            if (goals && typeof goals.disarm === 'function') goals.disarm(payload.agent)
          } catch {}
          log('overflow-dead', { agent: id, turn })
          try {
            appendNotice(ctx, id,
              '〔Ebbing Context 超窗提示 · 插件注入，不是用户说的话〕\n' + OWN_SENTINEL + '\n' +
              '连着两轮都超出窗口，停在这里、不会自动重试；自动续作也已经停掉。' +
              '现在每次请求都还会超窗口，compress 要依附在一次成功的请求上才调得动，所以插件此刻压不动。' +
              '建议把 maxTokens 调小，或者换一个窗口更大的模型，然后发一句话继续。' +
              '如果这两条都做不到，要不要用宿主自带的压缩由你决定——它会把分层拍平（表层上只剩它写的那段摘要，我们的块不再出现），' +
              '原文事件仍在会话日志里，装了会话搜索时可以按事件号读回来。', log)
          } catch (error) {
            // 报错本身宁可不报，也不能让这一轮死得无声无息。
            log('request-error', { agent: id, error: String((error && error.message) || error) })
          }
        }
      }
    } catch (error) {
      try {
        log('request-error-handler', { error: String((error && error.message) || error) })
      } catch {}
    }
    return next()
  })
}

function foldQueueFor(queues, agentId) {
  let queue = queues.get(agentId)
  if (!queue) {
    queue = new Map()
    queues.set(agentId, queue)
  }
  return queue
}

// 剪枝只在 compress 里做（见 lib/compress.js 的 prepare 段）：宿主把 toolResultPruner
// 当作压缩的前置步骤，我们也只在"要压了"的那一刻动表层，不越权改写模型正在用的内容。
// 宿主保证幂等：剪过的内容一定低于阈值，再剪一次返回空表。

// 导出仅供测试：这一层是胶水层，纯函数测不到它，而"用了外层作用域的变量却没接收成参数"
// 这类错误只有真跑一次才会暴露（见 ee1fb7e）。plugin/test/prestep.test.mjs 直接调它。
export function foldPending(ctx, config, queues, payload, log) {
  const id = payload.agent.id
  const queue = queues.get(id)
  // 关着的时候不消费队列：留着的待折项过几轮就全是"已经进过请求"的节点，
  // 重开那天再折它们，等于把那段历史的前缀缓存白废一次。所以关着就直接清空。
  if (!config.foldCallRecord) {
    if (queue && queue.size) queue.clear()
    return
  }
  try {
    const session = ctx.sessions.get(id)
    if (!session) return
    if (!queue || queue.size === 0) return
    const r = foldCallRecordEx(session, queue, config)
    if (r.note) {
      log('fold-call-record', { agent: id })
      // 折叠只替换尾部的「调用 + 返回」两条 raw 节点，三层块的 seq 一个都没动；
      // 许可证指纹也只盯这三层的 seq（见 lib/license.js），所以这里不需要再对齐什么。
      // 曾经在此 { restate(id, session, readZones(...)) }：那会让每步多扫一遍表层，
      // 而按现在的指纹口径它本来就是恒等运算（回归修复）。
      // 成功就抹掉上一次的失败记录：那个错误已经被下一轮覆盖掉了，不该一直挂在状态里。
      queue.lastError = null
      queue.lastSkip = null
      queue.failures = 0
      return
    }

    // 下面是"折不掉"：这些情形都不会自己好转，也不会靠重试变好。
    // 记一次跳过（不是失败）、把这一条丢掉，原因留给 /context-status，不再每轮白撞。
    if (r.reason === 'empty' || r.reason === 'disabled') return
    if (r.callId) queue.delete(String(r.callId))
    const STRUCTURAL = ['no-entry', 'no-tail-pair', 'parallel-call', 'not-tail', 'node-unknown', 'error-result', 'not-adjacent', 'no-nodes', 'no-messages']
    if (STRUCTURAL.includes(r.reason)) {
      // 尾部那一对已经不是我们的调用时（no-tail-pair 不带 callId），队列里剩下的全是陈旧项。
      // 表层本身不够两条节点（no-nodes / no-messages）同理：这一轮什么都没折的必要，直接清空。
      if (r.reason === 'no-tail-pair' || r.reason === 'no-nodes' || r.reason === 'no-messages') queue.clear()
      queue.failures = 0
      queue.lastSkip = { at: new Date().toISOString(), error: FOLD_REASON_TEXT[r.reason] || r.reason }
      log('fold-call-record-skipped', { agent: id, error: queue.lastSkip.error })
      return
    }
    queue.failures = (queue.failures || 0) + 1
    queue.lastError = { at: new Date().toISOString(), error: FOLD_REASON_TEXT[r.reason] || r.reason }
    log('fold-call-record-failed', { agent: id, error: queue.lastError.error, attempt: queue.failures })
  } catch (error) {
    // 折不了就算了：原样留着调用记录，只是多花那点 token。绝不能因此让这一轮起不来。
    // 但也不能只有日志里知道——/context-status 会把它打出来（见下面 handler）。
    queue.failures = (queue.failures || 0) + 1
    queue.lastError = { at: new Date().toISOString(), error: errText(error) }
    log('fold-call-record-failed', { agent: id, error: errText(error), attempt: queue.failures })
    if (queue.failures >= 2) queue.clear()
  }
}

// 折叠没成的原因翻译成一句能给人看的话（/context-status 直接显示）。
const FOLD_REASON_TEXT = {
  'not-adjacent': '调用与返回之间夹了别的节点',
  'error-result': '这次调用的结果本身是失败的，不折（留着原样，免得短注说"已经成功"）',
  'node-unknown': '定位不到这次调用在表层上的位置（会话里出现了空节点），这一条不再重试',
  'no-entry': '待折队列里没有这一条（多半是同一 callId 又被调了一次），不再重试',
  'no-tail-pair': '尾部那一对已经不是这次调用了（后来又被别的消息顶走），这一条不再重试',
  'parallel-call': '这次调用和别的工具调用挤在同一条消息里，整段替换会连累它们，所以不折（那份摘要参数副本要等下一次压缩把它遮蔽掉）',
  'not-tail': '这一对已经不是表层的最后两个节点了（那次请求早发出去了），再改写只会废掉前缀缓存，所以不折',
  'no-nodes': '表层上还不够两条节点，没什么可折的（等下一轮）',
  'no-messages': '拿不到派生消息，没法确认哪一条是调用（这一轮不折）',
}

// 三种触发条件各自独立，同一条提醒里可以同时给出多条理由：
//   1) 占用达到 triggerPct（每一轮一条）
//   2) 自上次提醒之后又长了 notice.growthTokens（总量还没到线时这条会先叫）
//   3) 某一层区超出设计容量（每层各自只在第一次越线时提醒，回落再涨才会再提醒）
//
// 这一步只做判定、只留一条待发记录，一个节点都不写：投递统一在收尾（flushNotice）。
// 每一步都会重算并覆盖这条记录，所以收尾拿到的是"最后一步看到的那份读数"——
// 既不额外多算一遍，也不会拿开头那一步的旧数字去说话。
// 轮次大纲损坏的判定（设计约束）：只有"日志在手、且与表层自相矛盾"才算损坏。
// 日志里根本没有 turn/start（测试桩、或宿主换了装载方式）时宁可先不动——那是"看不到"，不是"矛盾"。
// 是不是子代理？
// rc.1（有 `agents.roots()`）：运行期根身份是权威——只要这个 agent 在 roots() 里，它就是"用户正在聊的会话"，
//   哪怕会话头说它是子代理（典型：子代理会话被以根身份恢复，运行期 owner 已经丢了）。这时保持老行为：
//   按根处理、照常写标记/提醒。roots() 拿不到或为空时再看会话头（少见：测试桩/老宿主）。
// rc.2（`roots()` 已删除）：只能看持久化会话头 + 运行期 options：
//   - `origin === 'subagent'` 是权威分类（SessionHeader 注释明确说 parentSession 不能用来判）；
//   - `delegationDepth` / `options.subagentDepth > 0` 作次级证据：宿主只在 spawn 子代理时写
//     （child-agent 的 resolveChildDepth = 父 depth + 1），根会话（含开启 AgentTeam 的根会话）不会 >0；
//     宿主自己的口径是 max(header.delegationDepth, options.subagentDepth)（depth.ts），两边都读；
//   - 头里既没 origin 也没 depth 的老日志：rc.2 只能按根处理（宁可多写标记，也不让主会话静默）。
// 调用点拿到的 agent 可能只有 id（turn-stopping 载荷不保证带完整对象），所以先从 agent.session 取，
// 取不到再用 ctx.sessions.get(agent.id)；roots() 兜底按 id 比而不是对象身份。
function isSubagent(ctx, agent) {
  try {
    const id = agent && agent.id
    // 载荷没带 agent（turn-stopping 契约不保证带）：无法判定就按根处理，绝不静默主会话。
    // 旧代码在 id 缺失时 roots.some 无匹配 → 判子代理（更早的 includes 形态同样恒真），
    // 会把主会话误判成子代理、整轮收尾（flushNotice/settleGrowth/markNextTurn）全跳过——GLM 审查 Minor 1 的既有隐患。
    if (!id) return false
    const agents = ctx.agents || (typeof ctx.get === 'function' ? ctx.get('agents') : null)
    if (agents && typeof agents.roots === 'function') {
      const roots = agents.roots()
      if (!Array.isArray(roots) || roots.length === 0) return false
      return !roots.some((root) => root === agent || (root && id && root.id === id))
    }
    const session =
      (agent && agent.session) ||
      (id && ctx.sessions && typeof ctx.sessions.get === 'function' ? ctx.sessions.get(id) : null)
    const header = session && session.header
    if (header && header.origin === 'subagent') return true
    let depth = 0
    if (header && typeof header.delegationDepth === 'number' && Number.isSafeInteger(header.delegationDepth)) {
      depth = header.delegationDepth
    }
    const runtimeDepth = agent && agent.options ? agent.options.subagentDepth : undefined
    if (typeof runtimeDepth === 'number' && Number.isSafeInteger(runtimeDepth)) depth = Math.max(depth, runtimeDepth)
    return depth > 0
  } catch {
    return false
  }
}

function fatalOutline(ctx, payload, zones, log) {
  try {
    const id = payload && payload.agent && payload.agent.id
    const session = id ? ctx.sessions.get(id) : null
    if (!session) return null
    if (!Array.isArray(session.log) || session.log.length === 0) return null
    const live = zones || readZones(ctx, session, payload && payload.agent)
    if (!live) return null
    // 表层顺序自检（防护性检查）：批次中途失败可能留下层级倒挂的表。
    // 这种表还能对话，但继续压只会把错传下去，所以和"大纲损坏"一样处理：报红、停下。
    const order = zoneOrderFault(live)
    if (order) {
      return (
        `Ebbing Context 已停用这次对话：会话表层的层级顺序坏了（${order}）` +
        '继续压会把错越传越深。这一条消息没有被存进历史（宿主已把它从队列取走），' +
        '修好之前请不要再发；要接着用这份历史，在插件页关掉 Ebbing Context。'
      )
    }
    if (!live.outlineFault) return null
    // 'current' 不再是一种故障（回归修复）：宿主每轮第 1 步都还没把
    // 用户消息写进表层，于是"当前轮 0 节点"在每一轮都成立。把它当损坏 = 每条消息
    // 都被拦下来、而宿主已经把消息从 inbox 取走、不会还回来。这里只处理真损坏。
    if (live.outlineFault !== 'gap' && live.outlineFault !== 'order') return null
    const why = live.outlineFault === 'gap' ? '缺轮' : '乱序'
    const detail = live.outlineFaultDetail ? `（${live.outlineFaultDetail}）` : ''
    return (
      `Ebbing Context 已停用这次对话：轮次大纲损坏（${why}）${detail}。` +
      '判不准每一轮到哪儿结束，再压就可能切错轮次边界、把进行中的内容当成已结束的压掉，' +
      '所以插件拒绝在这种表上继续工作。注意：这一条消息没有被存进历史（宿主已把它从队列取走），' +
      '修好之前请不要再发。要接着用这份历史，请在插件页关掉 Ebbing Context；关掉后本对话恢复可用。'
    )
  } catch (error) {
    // 自检本身失败时不能装作"没事"：记一条，至少日志里查得到（第六轮审查 B）。
    if (typeof log === 'function') log('fatal-outline-failed', { error: errText(error) })
    return null
  }
}

function remindIfNeeded(ctx, config, state, bySignal, byAgent, payload, log, stepZones) {
  const session = ctx.sessions.get(payload.agent.id)
  if (!session) return
  const usage = readUsage(ctx, session, config)
  if (!usage) return

  const id = payload.agent.id
  const turn = typeof payload.turn === 'number' ? payload.turn : null
  // 拿不到轮号就别开口：`autoTurn` 的初值也是 null，`null === null` 恒真，
  // 会把"每个会话的第一条提醒"永久吃掉（宿主现在恒给数字，这里只防兜底漏洞）。
  if (turn === null) return
  const st = ensureState(ctx, state, id)

  // 第一次见到这个会话就把"上一次提醒时的量"定为当前量，否则增长触发永远没有基线、开不了口。
  if (st.tokens === null) {
    st.tokens = usage.used
    persistGrowth(ctx, id, st, log)
  }
  // 到线指示灯要在这里维护，不能放到"被叫醒就早退"之后：叫醒轮本来就该跳过登记，
  // 但它在那一轮里可能把占用压到线下、又被下一条大消息顶回线上——早退时跳过复位，
  // 这次"掉下去又越上来"就永远不报了（回归修复）。
  const aboveLine = usage.ratio >= config.triggerPct
  if (!aboveLine && st.lineOn) {
    st.lineOn = false
    // 灯灭要落盘：否则重启后 hydrate 回 true，下一次越线会被当成"还亮着"，
    // 吞掉一次到线提醒（审查 0883a196 Major 2）。
    persistGrowth(ctx, id, st, log)
  }
  // 会话搜索没开时 compress 与 context_map 都停用：叫醒只会让模型照地图撞墙（回归修复）。
  // 闸门必须放在上面两行**之后**：整个"停用 → 启用"期间占用掉到线下时，指示灯也得复位，
  // 否则重新启用后再次越线会被当成"还亮着"，那一次到线提醒永久丢掉（回归修复）。
  // 早退时顺手把这一步之前登记的提醒作废：工具都停着，叫醒它只会吃一次拒绝。
  if (missingSessionQuery(ctx, config)) {
    if (!st.loggedSearchBlock && typeof log === 'function') {
      st.loggedSearchBlock = true
      log('remind-skip-no-session-search', { agent: id })
    }
    forgetPending(bySignal, byAgent, id, payload.signal)
    return
  }
  // 这一轮本来就是被叫醒的那一轮：不再登记第二条。刚说过的话不必再说一遍，
  // 等用户真开口之后的下一轮再判（否则"读了提醒没压"会立刻又收到一条同样的提醒）。
  if (st.autoTurn === turn) {
    forgetPending(bySignal, byAgent, id, payload.signal)
    return
  }
  const grew = usage.used - st.tokens
  const onLine = aboveLine && !st.lineOn
  // 增长门槛可能是"原额"，也可能是上一次没压成时被砍到的一半（用户要求 第 2 条）。
  const growthQuota = typeof st.growthQuota === 'number' ? st.growthQuota : config.notice.growthTokens
  const onGrowth = growthQuota > 0 && grew >= growthQuota

  // 同一轮里占用明显下降（压缩成功、宿主剪枝、用户撤销）说明表层已经变了：
  // 把区快照作废、重新扫一遍。否则同一个 turn 后面的步还在用压缩前的读数，
  // 收尾就会发出「L1 已超 626/400」而同一张地图显示「313/400、不足 2 块」
  // 这种自相矛盾的提醒（回归修复）。
  if (st.zonesTurn === turn && typeof st.tokens === 'number' && st.tokens > 0) {
    const dropped = st.tokens - usage.used
    if (dropped > Math.max(1, Math.round(st.tokens * 0.05))) {
      st.zonesTurn = null
      // 「压得动」是拿同一份区快照算的：快照作废，这份判断也得跟着重算，
      // 否则会拿压缩前的"l1 还有两块可压"去给压缩后的表发提醒（回归修复）。
      st.compressTurn = null
    }
  }
  // 基线比当前用量还高（宿主 /compact、剪枝、窗口变小）：grew 会长期为负，增长触发
  // 要等用量爬回旧基线才可能再响。以当前用量为新基线重新起算（审查 0883a196 8）。
  // 必须放在"占用明显下降"检测**之后**：那个检测也读 st.tokens，提前改它会让压缩后的
  // 旧区快照不被作废（S2 回归测试抓到的正是这条）。
  if (typeof st.tokens === 'number' && usage.used > 0 && usage.used < st.tokens) {
    // `used > 0` 防的是读数瞬时归零/少计：把基线写成 0，下一步就会凭空报一次增长。
    const from = st.tokens
    st.tokens = usage.used
    // 缩水 = 表层在插件没看见的时候被压过（宿主 /compact、剪枝、窗口变小）。
    // 按 §7.4「任何原因触发的压缩都重置增长状态」的口径，半额门槛也一起清掉；
    // 留着它会让下一次提醒按缩水前的半额早来。
    st.growthQuota = null
    persistGrowth(ctx, id, st, log)
    log('growth-baseline-shrunk', { agent: id, from, to: st.tokens })
  }
  // 区超限要全量扫一遍日志，所以每轮最多扫一次；同一轮后面几步复用这次结果，
  // 既省重复扫描，也免得同一条提醒在几步之间理由来回变。
  if (st.zonesTurn !== turn) {
    st.zonesTurn = turn
    // 区配额与触发线必须用同一个分母（可用输入预算），否则两套账。
    st.zonesOver = readZoneOver(session, config, usage.budget, stepZones, log)
    st.ambiguous = stepZones ? stepZones.ambiguous === true : false
  }
  // 「哪一层现在真压得动」只在**可能真开口**时才估（回归修复）：
  // 估 l0 要把整段原文逐个 token 数一遍，而到线、增长、区超限一件都没发生的那一轮，
  // 这份结果算出来只会被丢掉。先看这一轮到底有没有理由发提醒；同一轮只算一次。
  const maybeTell = onLine || onGrowth ||
    ['l1', 'l2', 'l3'].some((key) => st.zonesOver && st.zonesOver[key])
  if (maybeTell && st.compressTurn !== turn) {
    st.compressTurn = turn
    // 第一步：把表层读出来。读失败按用户 2026-11-05 的裁定**降级**（不抛红）：抛出发生在
    // 用户消息已经被 claim 之后，持续故障时每一轮都会吞掉一条用户消息。
    let live = stepZones
    if (!live) {
      try {
        live = readZones(ctx, session, payload && payload.agent, log)
      } catch (error) {
        // 用户 2026-11-05 裁定：读不出表层**不再停对话**。旧做法抛红，但这个抛错发生在
        // 用户消息已经被 claim 之后，宿主 turn 的 catch 不入队 —— 持续故障时每一轮都会
        // 吞掉一条用户消息，而回执还让用户"把报错发给我"，一发又吞一条。
        // 现在：记日志、本轮不做任何压缩判断、留一条可见说明；工具调用仍照常报硬错
        // （工具错误是回给模型的，不会丢消息）。
        const detail = String((error && error.message) || error)
        if (typeof log === 'function') log('surface-read-failed', { agent: id, error: detail })
        st.ambiguous = true
        st.compressible = { l0: false, l1: false, l2: false, l3: false }
        st.envBlocked = { l0: false, l1: false, l2: false, l3: false }
        if (!st.readFailedNoticed) {
          st.readFailedNoticed = true
          try {
            appendNotice(ctx, id,
              '〔Ebbing Context 提示 · 插件注入，不是用户说的话〕\n' + OWN_SENTINEL + '\n' +
              '这一轮读不出会话表层（' + detail + '），分层压缩与提醒这次先跳过，对话本身不受影响。' +
              '如果之后每一轮都这样，压缩会一直不可用——把这段原话发出来，我按这条查。', log)
          } catch (noticeError) {
            if (typeof log === 'function') log('surface-read-notice-failed', { agent: id, error: String((noticeError && noticeError.message) || noticeError) })
          }
        }
        live = null
      }
    }
    // 第二步：判据本身。这里是纯计算（worthCompressing / zoneRangeCost / envBlockedOf），
    // 它抛错意味着我们的代码有 bug，不是会话坏了——记日志、本轮不叫醒，绝不因此停掉整段对话
    // （回归修复）。
    if (live) {
      try {
        st.ambiguous = live.ambiguous === true
        const keepTurns = typeof config.keepTurns === 'number' ? config.keepTurns : 0
        // 叫醒判据比"结构上可压"更严格：成本估不出来时（拿不到原文正文）就不叫醒，
        // 因为叫醒之后大概率只能换来一次失败（成本口径）。
        st.compressible = {
          l0: worthCompressing(live, 'l0', keepTurns, config),
          l1: worthCompressing(live, 'l1', keepTurns, config),
          l2: worthCompressing(live, 'l2', keepTurns, config),
          l3: worthCompressing(live, 'l3', keepTurns, config),
        }
        // l0 压不动有两种原因：内容（只剩 keepTurns 保住的轮）与环境（轮次大纲损坏、
        // 拿不到轮号、缺轮把上界夹住）。只有"内容原因"才该拖住深层的提醒——环境坏掉时
        // l1/l2 照样能用，拿它把整个金字塔拖黑，等于地图写着"l1/l2 照常"而提醒永远不发（设计约束）。
        // 缺轮也归环境：那是"定不了边界"，不是"没内容可压"。
        st.envBlocked = envBlockedOf(live)
      } catch (error) {
        if (typeof log === 'function') log('worth-compressing-failed', { agent: id, error: String((error && error.message) || error) })
        st.ambiguous = true
        st.compressible = { l0: false, l1: false, l2: false, l3: false }
        st.envBlocked = { l0: false, l1: false, l2: false, l3: false }
      }
    }
  }
  if (st.ambiguous) {
    forgetPending(bySignal, byAgent, id, payload.signal)
    return
  }
  const zoneOver = st.zonesOver || {}
  const compressible = st.compressible || null
  const envBlocked = st.envBlocked || null
  const anyCompressible = compressible ? Object.values(compressible).some(Boolean) : true

  const reasons = []
  if (onLine) reasons.push('line')
  // 纯增长触发：一个可压的层都没有时闭嘴（用户要求 第 2 条）。
  // 但闭嘴不等于把这次增长丢掉：把门槛砍到原额的一半、基线前移到当前，
  // 再长半个额度就重新判一次（用户要求 第 2 条）。一直砍不下去说明内容还在长，
  // 而每次只多等半个门槛，不会因为"一直压不动"就把这条触发彻底饿死。
  if (onGrowth) {
    if (anyCompressible) {
      // 增长指示灯：到量且真压得动才亮。收尾那一步发不发，就看这一格。
      st.growthLamp = true
    } else {
      // 到量了却一层都压不动：闭嘴，但把门槛降到原额的一半、基线前移到当前，
      // 再长半个额度就重新判一次；还不压得动就再降一次（用户要求：
      // "要是不可压就一直延续下去，跨轮也依旧继续这么下去"）。
      // 半额是固定的 50%，不受 growthResetPct 影响——那条只负责"模型主动不压"。
      st.growthLamp = false
      st.growthQuota = Math.max(1, Math.round(config.notice.growthTokens * 0.5))
      st.tokens = usage.used
      persistGrowth(ctx, id, st, log)
      log('growth-silent', { agent: id, turn, grew })
    }
  }
  if (onGrowth && st.growthLamp) reasons.push('growth')
  // 区超限：要报的那一层，比它浅的层必须全都压得动（用户要求 第 1 条）。
  // 深一层满、浅层没满时照报浅层那条；地图上写着深层不可压，模型不会硬去压它。
  for (const key of ['l1', 'l2', 'l3']) {
    const worthTelling = zoneNoticeAllowed(key, zoneOver, compressible, envBlocked)
    if (worthTelling && !st.zones[key]) reasons.push('zone-' + key)
    // 掉回线下就复位：否则某个区一旦报过一次，这个会话里就再也不报了
    // （只压某一层的工作流里，模型压小后再次越线会彻底静默）。
    else if (!zoneOver[key]) st.zones[key] = false
  }

  // 一条理由都没有：占用已经掉回线下、也没再长。撤掉待发的那条，并把"连续第几次提醒"归零，
  // 否则下一次到线时那句"上次提醒之后占用没有降下来"会是假话（它降过，只是又涨回来了）。
  if (!reasons.length) {
    st.count = 0
    forgetPending(bySignal, byAgent, id, payload.signal)
    return
  }

  const record = { agentId: id, agent: payload.agent, turn, reasons, grew, usage, zoneOver, count: st.count + 1 }
  // 按本轮信号登记：turn-stopping 的载荷只有 { turn, signal }，没有 agent，认不回来就别想发。
  if (payload.signal) bySignal.set(payload.signal, record)
  byAgent.set(id, { signal: payload.signal, record })
}

// 区超限要不要报：比它浅的层必须全都压得动（用户要求 第 1 条）。
// 道理：压深层要把上面还能压的层同批给出去；浅层压不动时，这条提醒只能换来一次拒绝。
//
// 但"压不动"要分两种（设计约束）：
//   · 内容原因——只剩 keepTurns 保住的轮、或只剩每层最后一块：这是真的没得压，该拦。
//   · 环境原因——轮次大纲损坏、拿不到轮号：l0 判不出可压区间，但 l1/l2 根本不需要轮号，
//     这时还拦就是把地图上"l1/l2 照常能压"变成空话。所以环境原因不算拖累。
// 空层不用单独判断：块只能由下一层压出来，每层最后一块又永不压，
// 所以"上层有块而下层为空"不可能出现，深层的提醒自然也不会响。
const SHALLOWER = { l1: ['l0'], l2: ['l0', 'l1'], l3: ['l0', 'l1', 'l2'] }

// l0 压不动是"环境原因"还是"内容原因"：环境原因不该把深层的提醒一起拖黑（设计约束）。
// 三种环境原因：大纲损坏、拿不到轮号、缺轮把上界夹住（缺轮是"定不了边界"，不是"没内容"）。
export function envBlockedOf(zones) {
  const missing = Array.isArray(zones && zones.turnNotes) && zones.turnNotes.some((n) => n && n.reason === 'missing')
  const broken = !!(zones && zones.outlineFault)
  const noStarts = !!zones && zones.turnStarts === null
  return { l0: broken || noStarts || missing }
}

export function zoneNoticeAllowed(key, zoneOver, compressible, envBlocked) {
  if (!zoneOver || !zoneOver[key]) return false
  // 拿不到哪一层压得动（读表层失败）：不拦，宁可多报一次也别静默。
  if (!compressible) return true
  if (!compressible[key]) return false
  return SHALLOWER[key].every((k) => compressible[k] || (envBlocked && envBlocked[k]))
}

function newState() {
  return {
    turn: null, count: 0, tokens: null, zones: {}, zonesTurn: null, zonesOver: null,
    autoTurn: null, ambiguous: false, compressible: null, envBlocked: null, lineOn: false,
    // 「哪一层压得动」是按轮缓存的（回归修复）：只有真要发提醒的那一轮才去估 l0 成本。
    compressTurn: null,
    // 增长这条触发自己的两格状态（用户要求 第 2 条）：
    // growthQuota = 当前门槛（null 表示用配置里的原额；压不动时砍到一半）
    // growthLamp  = 增长指示灯（亮着表示"已经在等模型动手"，收尾那步才发得出去）
    growthQuota: null,
    growthLamp: false,
    // 增长提醒发出去的那一轮：下一轮收尾时如果还没压，就按 growthResetPct 重设门槛。
    growthPending: null,
    // 最后一条〔轮次标记〕指向的轮号：收尾时写 N+1，轮首兜底写 N。
    // 有了它才能判断"这一轮开头到底有没有标记"，以及不重复写。
    markedTurn: null,
  }
}

// ── 增长状态的落盘（重启不清零）────────────────────────────────────────────
// 为什么只存这三个数：增长线只看"基线用量、当前门槛、到线指示灯"；轮内的东西
// （growthPending、autoTurn）只对当前这轮有意义，重开后重算即可。
// 键是 session.id：agent.id 在重启后可能变，session.id 稳定，且随会话文件走。
// 两处候选都读不到有效记录时就当"没有存过"——状态丢了只是退回按当前用量起步，绝不能影响主流程。
// 取状态：没有就建。**建的任何一条路都要先把盘上的基线灌回来**——
// 重启后第一次 pre-step 可能因为拿不到用量读数而提前返回，状态会被轮次标记、提醒投递
// 这些旁路建出来；如果它们建出的空状态不 hydrate，下一次 pre-step 看到 st 已存在就跳过
// 回灌，再把基线设成当前用量落盘，盘上的旧基线就被冲掉了（审查 0883a196 Major 1）。
function ensureState(ctx, state, id) {
  const st = state.get(id)
  if (st) {
    // 状态在、但基线还没定下来：说明它是在"看不到用量"的那一步由旁路建出来的，补回灌。
    if (st.tokens === null) hydrateGrowth(ctx, id, st)
    return st
  }
  const fresh = newState()
  hydrateGrowth(ctx, id, fresh)
  state.set(id, fresh)
  return fresh
}

export function hydrateGrowth(ctx, id, st) {
  try {
    const session = ctx && ctx.sessions && typeof ctx.sessions.get === 'function' ? ctx.sessions.get(id) : null
    const sid = session && typeof session.id === 'string' ? session.id : ''
    if (!sid) return false
    const saved = readGrowth(sid)
    if (!saved) return false
    st.tokens = saved.tokens
    st.growthQuota = saved.growthQuota
    st.lineOn = saved.lineOn
    return true
  } catch {
    return false
  }
}

export function persistGrowth(ctx, id, st, log) {
  try {
    if (!st || typeof st.tokens !== 'number' || !Number.isFinite(st.tokens)) return false
    const session = ctx && ctx.sessions && typeof ctx.sessions.get === 'function' ? ctx.sessions.get(id) : null
    const sid = session && typeof session.id === 'string' ? session.id : ''
    if (!sid) return false
    const ok = writeGrowth(sid, {
      tokens: st.tokens,
      growthQuota: typeof st.growthQuota === 'number' ? st.growthQuota : null,
      lineOn: st.lineOn === true,
    })
    // 落盘失败不能全静默：用户重启后发现"累计又清零了"，日志里至少得能查到原因。
    // 成功但退到了临时目录也要记：主目录里那份是旧的，只记在这里才看得出真实位置。
    // 同一状态连续失败/连续退级只记一次，恢复后清标记——坏盘时不能每步刷一条（GLM 回归修复 4）。
    if (!ok) {
      if (typeof log === 'function' && st.stateLog !== 'fail') {
        st.stateLog = 'fail'
        log('growth-state-write-failed', { agent: id, reason: lastStateFailure() })
      }
    } else if (typeof log === 'function') {
      const fallback = lastStateFallback()
      if (fallback.fellBack) {
        if (st.stateLog !== 'tmp') {
          st.stateLog = 'tmp'
          log('growth-state-written-to-tmp', { agent: id, reason: fallback.reason })
        }
      } else if (st.stateLog) {
        st.stateLog = ''
      }
    }
    return ok
  } catch {
    return false
  }
}

function forgetPending(bySignal, byAgent, id, signal) {
  const record = signal ? bySignal.get(signal) : undefined
  if (record && record.agentId === id) bySignal.delete(signal)
  const entry = byAgent.get(id)
  if (entry && (!signal || entry.signal === signal)) byAgent.delete(id)
}

// 增长提醒发出去之后，模型还有一整轮时间决定压不压。到那轮收尾时仍然没压，
// 就按 notice.growthResetPct 重设下一个门槛（设计约束）：
//   · 基线前移到当前用量（已经长出来的那截算"给过了"）；
//   · 门槛 = 原额 × N%（默认 40%：原额 65000 的话，再长 26000 才重新触发）。
// 不做这一步的话，基线停在提醒那一刻，模型只要一直不压，增长这条每轮都成立，
// 变成"每轮叫醒一次"的连环烧钱。
function settleGrowth(ctx, config, state, payload, log) {
  const id = payload.agent && payload.agent.id
  if (!id) return
  const st = state.get(id)
  if (!st || st.growthPending === null) return
  // 提醒还挂在 inbox 的 next-turn 里没人认领（用户恰在收尾时插话、或上一轮异常收场）：
  // 这一轮不是"给它的一轮"，先别结算——否则门槛重设、基线前移，等于白送一次叫醒，
  // 而那句提醒真正被读到时要再等一轮才有效（设计约束）。
  // 拿不到 agent（无 id）时上面直接 return：这一轮不结算，下一轮 turn 超过 growthPending
  // 时会补结算，不会永久卡住（压缩成功路径也会清）。
  if (payload.agent && pendingNoticeOf(payload.agent)) return
  const turn = typeof payload.turn === 'number' ? payload.turn : null
  // 还在被叫醒的那一轮里：给它这一步的时间，收尾时才结算。
  if (turn === null || turn <= st.growthPending) return
  const session = ctx.sessions.get(id)
  const usage = session ? readUsage(ctx, session, config) : null
  const raw = config.notice && config.notice.growthResetPct
  const pct = typeof raw === 'number' && Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 40
  if (usage) st.tokens = usage.used
  st.growthPending = null
  st.growthLamp = false
  // 100% 等于原额，直接回到 null（用配置原额，配置改了也跟着变）。
  st.growthQuota = pct >= 100 ? null : Math.max(1, Math.round(config.notice.growthTokens * (pct / 100)))
  persistGrowth(ctx, id, st, log)
  log('growth-reset', { agent: id, turn, pct, quota: st.growthQuota })
}

// ── 轮次标记 ──────────────────────────────────────────────────────────────
// 目的只有一个：让模型在写 `to` 的时候能把"轮号"和"表层里那一段内容"对上号。
// 没有标记时，模型只从地图看到「原文区最老的是 T16」，但表层里那段内容没有任何
// T 号，它只能猜；一猜错就是压掉了还在用的轮次。
//
// 写法与位置：
//   · 轮末（turn-stopping）写「〔轮次标记〕下一轮 T57」——这句话后面紧跟的就是 T57 的内容。
//   · 轮首（step 1）只在"这一轮还没有标记"时兜底补「〔轮次标记〕本轮 T57（这一轮的内容就在这条标记之后）」。
//     注意 pre-step 是在宿主把用户消息写进表层**之前**跑的，所以这条标记天然落在本轮第一条
//     用户消息之上——文案必须按这个事实写（回归修复）。
//   · 它是普通 user/message 节点，随所在轮次一起被压进块里——所以交界处那条信息不能靠它，
//     由压缩产物自己在块尾声明（见 lib/compress.js 的 l0 尾行）。
//   · 去重不能只看内存里的 markedTurn：会话重载后状态是新的，而上一轮收尾写的那条
//     「下一轮 T57」还在表层上。两者都看，重载后就不会再补一条重复的（回归修复）。
function lastMarkerTurn(ctx, agentId) {
  try {
    const session = ctx.sessions.get(agentId)
    const nodes = session && session.surface && Array.isArray(session.surface.nodes) ? session.surface.nodes : null
    const log = session && session.log
    if (!nodes || !nodes.length || !Array.isArray(log)) return null
    if (typeof session.deriveEventMessage !== 'function') return null
    const from = Math.max(0, nodes.length - 40)
    for (let i = nodes.length - 1; i >= from; i -= 1) {
      const event = log[nodes[i]]
      if (!event) continue
      let msg = null
      try {
        msg = session.deriveEventMessage(event)
      } catch {
        msg = null
      }
      if (!msg || msg.role !== 'user') continue
      if (!msg.source || msg.source.kind !== MARKER_KIND) continue
      const text = (msg.content || [])
        .map((part) => (part && part.type === 'text' ? part.text : ''))
        .join(' ')
      const m = /T(\d+)/.exec(text)
      return m ? Number(m[1]) : null
    }
    return null
  } catch {
    return null
  }
}

function markNextTurn(ctx, state, payload, log) {
  const id = payload.agent && payload.agent.id
  const turn = typeof payload.turn === 'number' ? payload.turn : null
  if (!id || turn === null) return
  const st = ensureState(ctx, state, id)
  if (st.markedTurn === turn + 1) return
  if (lastMarkerTurn(ctx, id) === turn + 1) {
    st.markedTurn = turn + 1
    return
  }
  const ok = appendOwn(ctx, id, `〔轮次标记〕下一轮 T${turn + 1}`, MARKER_KIND, log)
  if (!ok) return
  st.markedTurn = turn + 1
  log('turn-marker', { agent: id, turn: turn + 1, where: 'turn-end' })
}

function ensureTurnMarker(ctx, state, payload, log) {
  if (payload.step !== 1) return
  const id = payload.agent && payload.agent.id
  const turn = typeof payload.turn === 'number' ? payload.turn : null
  if (!id || turn === null) return
  const st = ensureState(ctx, state, id)
  if (st.markedTurn === turn) return
  if (lastMarkerTurn(ctx, id) === turn) {
    st.markedTurn = turn
    return
  }
  const ok = appendOwn(ctx, id, `〔轮次标记〕本轮 T${turn}（这一轮的内容就在这条标记之后）`, MARKER_KIND, log)
  if (!ok) return
  st.markedTurn = turn
  log('turn-marker', { agent: id, turn, where: 'step-1' })
}

// turn-stopping 没来（这一轮以异常/取消收场）：那条记录的信号已经作废，
// 再发出去就是拿"那一刻"的旧读数说话。直接丢，让下一步重新判一次。
function dropStaleNotice(byAgent, payload, log) {
  const id = payload.agent && payload.agent.id
  if (!id) return
  const entry = byAgent.get(id)
  if (!entry) return
  if (entry.signal && payload.signal && entry.signal === payload.signal) return
  byAgent.delete(id)
  log('notice-dropped', { agent: id, reason: 'turn-stopping-missing' })
}

// 取消息正文：只关心 text 部件，别的（图片、工具块）对身份判断没意义。
function messageTextOf(message) {
  try {
    const parts = message && message.content
    if (typeof parts === 'string') return parts
    if (!Array.isArray(parts)) return ''
    return parts
      .map((part) => (part && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .join('')
  } catch {
    return ''
  }
}

// 是我们写的提醒吗？kind 只说明"这类消息"，哨兵才说明"这一条是我们写的"。
// 宿主自己的 cordis-host-runner 消息不带哨兵，所以不会被我们当成旧提醒覆盖掉。
function isOwnNotice(message) {
  if (!message || !message.source || !OUR_KINDS.has(message.source.kind)) return false
  if (message.source.kind === MARKER_KIND) return true
  return messageTextOf(message).includes(OWN_SENTINEL)
}

// 认领到的消息里只要有一条不是我们发的，就说明用户（或别的流程）开口了：
// 解除"刚叫醒过一轮"的闸，下一次收尾还能再叫醒一次。
function noteUserSpoke(state, payload) {
  if (payload.step !== 1 || !Array.isArray(payload.messages) || payload.messages.length === 0) return
  const id = payload.agent && payload.agent.id
  if (!id) return
  const st = state.get(id)
  if (!st) return
  // 我们自己投递的那条提醒被认领了：这一轮就是"被叫醒的那一轮"。
  // 用哨兵认领而不是靠 turn+1 算术：提醒可能排在用户消息后面（用户要求 的 Q2），
  // 算术会指错轮，哨兵不会。
  const woke = payload.messages.some((m) => isOwnNotice(m) && m.source.kind === NOTICE_KIND)
  if (woke) st.autoTurn = typeof payload.turn === 'number' ? payload.turn : st.autoTurn
  if (st.autoTurn === null) return
  // 只有'kind 不是我们这类'的消息才算用户开口（回归修复）：宿主自己的 cordis-host-runner
  // 通知与我们同 kind 但不带哨兵，那种既不算我们、也不算用户说话，闸门不能因此解开。
  const foreign = payload.messages.some((m) => !(m && m.source && OUR_KINDS.has(m.source.kind)))
  if (foreign) st.autoTurn = null
}

// 本轮收尾：按信号把这一步之前攒下的那条记录认回来，发出去。
function flushNotice(ctx, config, state, bySignal, byAgent, payload, log) {
  const signal = payload && payload.signal
  const record = signal ? bySignal.get(signal) : undefined
  if (!record) return
  bySignal.delete(signal)
  byAgent.delete(record.agentId)
  deliverNotice(ctx, config, state, record, log)
}

// inbox 里还挂着的那条我们的提醒（next-turn 车道）。宿主每轮只认领一条 next-turn
// （`dsh-agent-loop/index.js:103` 的 `claim` 里是 `mutate("next-turn", 0, 1, …)`），
// 所以同时挂两条会多耗一轮；投递前先看有没有旧的，就地替换。
function pendingNoticeOf(agent) {
  try {
    const list = agent && agent.inbox && agent.inbox.nextTurn
    if (!Array.isArray(list)) return null
    for (const message of list) {
      if (isOwnNotice(message)) return message
    }
  } catch {}
  return null
}

function deliverNotice(ctx, config, state, record, log) {
  const id = record.agentId
  const session = ctx.sessions.get(id)
  if (!session) return
  const st = ensureState(ctx, state, id)

  const turn = typeof record.turn === 'number' ? record.turn : st.turn
  const text = noticeText(ctx, config, record, record.count, log)
  const message = userMessage({ content: [{ type: 'text', text }], source: { kind: NOTICE_KIND } })

  // 记账放在"真的发出去"之后：先记账会让"投递失败"也算发过，
  // 于是这一轮白算、下一轮 `st.turn !== turn` 又登记又失败，每轮静默重试，
  // 区越线标志还会被白白置位（正是下面注释里说要避免的那种假话）。
  const commit = () => {
    st.turn = turn
    st.count = record.count
    st.tokens = record.usage.used
    // 只锁真正报出去的那几层。以前按 record.zoneOver 全量置位，于是"这一层超了但
    // 当时压不动（被门控过滤）"也被记成"已经提醒过"，等它以后压得动了再也不报，
    // 一直要等它掉回线下才复位（回归修复）。
    for (const key of ['l1', 'l2', 'l3']) {
      if (record.reasons.includes('zone-' + key)) st.zones[key] = true
    }
    // 增长这条路：记下"哪一轮发的"，下一轮收尾时据此判断模型有没有动手（见 settleGrowth）。
    if (record.reasons.includes('line')) st.lineOn = true
    if (record.reasons.includes('growth')) st.growthPending = turn
    // 刚把基线移到这次提醒的用量、可能还亮了到线灯：落盘，重启后不用重报一遍。
    persistGrowth(ctx, id, st, log)
  }

  // 叫醒模型立刻压（设计约束）：followup 只是把消息排进 inbox 的 next-turn，
  // 宿主在本轮 turn/end 之后看到 inbox 有货就开新的一轮 —— 于是模型被叫醒后先压缩、
  // 用户的下一句话排在它后面，不用干等用户开口。
  // 只叫醒一轮：这一轮如果本来就是被叫醒的那轮（st.autoTurn === turn），退化成尾部追加；
  // 否则"读了提醒什么也没压"会让每一轮都再叫醒一次，变成连环烧钱。
  const agent = record.agent
  if (agent && typeof agent.followup === 'function' && st.autoTurn !== turn) {
    // 上一条提醒还躺在 inbox 的 next-turn 里没人认领（例如上一轮以异常收场）：
    // 直接再塞一条会排成两行，而宿主每轮只认领**一条** next-turn，于是要多花一轮才轮到后面那条。
    // 这里就地替换：内容换成这次的新读数，队列里始终只有一条我们的提醒。
    const pending = pendingNoticeOf(agent)
    if (pending) {
      try {
        if (typeof agent.inbox?.replace === 'function' && agent.inbox.replace(pending.id, message)) {
          st.autoTurn = (typeof turn === 'number' ? turn : 0) + 1
          commit()
          log('notice-replaced-pending', { agent: id })
          return
        }
      } catch (error) {
        log('notice-replace-failed', { agent: id, error: String((error && error.message) || error) })
      }
    }
    try {
      agent.followup(message)
      st.autoTurn = (typeof turn === 'number' ? turn : 0) + 1
      commit()
      return
    } catch (error) {
      log('notice-wake-failed', { agent: id, error: String((error && error.message) || error) })
    }
  }
  try {
    // followup 不可用时的退化路径：直接追加到表层。同样不许在空表层上写（见 appendOwn）。
    if (surfaceIsEmpty(session, log)) {
      log('append-skip-empty-surface', { agent: id, kind: NOTICE_KIND })
      return
    }
    session.append('user/message', message, { surfaceOp: 'append' })
    commit()
  } catch (error) {
    log('notice-append-failed', { agent: id, error: String((error && error.message) || error) })
  }
}

function noticeText(ctx, config, record, count, log) {
  const usage = record.usage
  const zoneOver = record.zoneOver || {}
  const reasons = record.reasons
  const grew = record.grew
  const pct = Math.round(usage.ratio * 1000) / 10
  const line = Math.round(config.triggerPct * 100)
  const parts = []
  if (reasons.includes('line')) parts.push(`上下文已用 ${pct}%，到了 ${line}% 的提醒线。`)
  if (reasons.includes('growth')) {
    parts.push(`距上次提醒又长了约 ${fmt(grew)} token（现在 ${pct}%）。`)
    parts.push('这次是「又长了」触发的提醒，不是催你：要压的那几轮如果还没做完、或者内容比较重要，就直接说这一轮不压，按原计划继续。')
  }
  if (count >= 2 && (reasons.includes('line') || reasons.includes('growth'))) {
    parts.push('距上次提醒又过了一段：如果占用没降，说明上次压得不够；如果降过又涨回来，是新增内容太快。')
  }
  // 区超限只说"哪区、多少"，不再逐区重复级联规矩：级联只在 compress 的描述里写一份，
  // 提醒里重复一遍等于每轮多付 60 token，而模型就是照着那份描述填表的。
  let anyZone = false
  for (const key of ['l1', 'l2', 'l3']) {
    if (!reasons.includes('zone-' + key)) continue
    anyZone = true
    const z = zoneOver[key]
    parts.push(`${key.toUpperCase()} 区已超设计容量（${fmt(z.used)}/${fmt(z.limit)} token）。`)
  }
  if (anyZone) parts.push('要压超限的那一层，就连比它浅、还能压的层一起给；某层不足 2 块时压不动，只能靠更浅的层往上顶。')

  // 位置随提醒一起给：省掉模型单独调一次 context_map 的往返。
  // 这里给**完整地图**（块表 + 须知 + 占用），不给紧凑版：
  // 提醒是模型唯一"必须立刻做决定"的入口，而做决定要看块标题与块大小
  // （并哪几块、压完会不会更大）；只给 to 的数字等于让它闭着眼睛合并。
  // 代价是每轮约 450–690 token（永久留在历史里），这是设计上认过的账。
  let mapText = ''
  try {
    mapText = renderMap(ctx, record.agent, config, usage).text
    if (mapText) {
      mapText = '\n\n' + mapText
      issueFor(ctx, record.agent, log)
    }
  } catch (error) {
    mapText = ''
    // 这是全库唯一一个原本不记日志的 catch（第六轮审查 B）：读不到地图时提醒照发，
    // 正文里却还写着"照下面给的位置"——必须留下痕迹，才好排查。
    if (typeof log === 'function') log('notice-map-failed', { error: errText(error) })
  }

  return (
    // 首行必须自报家门：宿主把它作为一条 user/message 交给模型，模型默认会当成"用户说的"。
    // 说清是谁发的、这不是用户发言，模型才不会把提醒里的数字当成用户给的要求。
    '〔Ebbing Context 自动提醒 · 插件注入，不是用户说的话〕\n' +
    // 哨兵：身份判据（isOwnNotice）。借来的 kind 只负责展示，哨兵才说明"这条是我们写的"。
    OWN_SENTINEL + '\n' +
    // 第 3 点（设计约束）：提醒是"要不要压"的入口，不是"必须压"的命令。
    // 把判断权明确交回模型：内容还在用就先留着，这一轮什么都不做也允许——
    // 否则它会把做到一半的工作压掉，然后只剩自己写的那几行摘要。
    '压不压由你判断：要压掉的那几轮里如果有还没做完的事（目标还没收尾、todo 没打完、还在验证、等用户拍板），' +
    '或者内容接下来明显还要用到，就留着别动——这一轮允许什么都不压，按原计划继续干活即可。' +
    // 用户要求（2026-11-08）：这句挪进地图的「压缩须知」段（提醒里附完整地图，照样看得到），
    // 让"压完就收手"在真正决定压哪几轮的位置上生效，而不是只出现在提醒正文的说明段。
    parts.join('') +
    (mapText
      ? '决定要压时：照下面给的位置，一次调用把要压的层一起给全（深浅同批，区间自己权衡；级联与填表顺序见 compress 的说明）。' +
        '没有可压位置就直接告诉用户这一版压完了，并说明宿主自带压缩会把分层拍平、要不要用由用户决定。'
      : '决定要压时：这次没能生成地图（插件内部出错，先别压，按原计划继续），别凭记忆压——先调一次 context_map 拿到位置再动手；' +
        '如果连 context_map 也读不到，就照实告诉用户这一版没法压，别自己猜轮号。') +
    // 用户要求（2026-11-05）：一次调用就是一批，别在同一轮里连压多次——
    // 每次压缩都要整段替换表层并重算地图，连压两回只会把同一轮烧两遍；压完这一轮就收手。
    '请在一次压缩中完成，不要分多次压缩。' +
    '不压也回一句为什么（例如"还没做完，先留着"），不要沉默，也不要假称压过了。' +
    '压完只回一两句：压了哪几层、省下多少、现在占用多少；不要复述摘要，也不要重新讲一遍做过的事。' +
    mapText
  )
}


function fmt(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// 尾部追加一条提示，不碰前缀。失败静默：提示发不出去不该影响这一轮。
function appendNotice(ctx, agentId, text, log) {
  appendOwn(ctx, agentId, text, NOTICE_KIND, log)
}

// 插件自己往会话里写一条文本节点（提醒 / 轮次标记）。
// 只能用 user/message：assistant/message 不能带 sourceEventSeqs（插不进去），
// system/message 会覆盖 historySystem，developer/message 收尾 flush 会抛 unsupported。
function surfaceIsEmpty(session, log) {
  try {
    const nodes = session && session.surface && Array.isArray(session.surface.nodes) ? session.surface.nodes : null
    return !!nodes && nodes.length === 0
  } catch (error) {
    // 读不出表层时保守地当"非空"（不跳过写入），但要留痕：否则坏表层下每步都白写一遍。
    if (typeof log === 'function') log('surface-empty-check-failed', { error: errText(error) })
    return false
  }
}

function appendOwn(ctx, agentId, text, kind, log) {
  const session = ctx.sessions.get(agentId)
  if (!session) return false
  // 空表层时一个节点都别写（0.1.15 真机事故）。宿主的日志重放校验要求表层第一个
  // 节点必须是 system/message 才能建立受保护的头：
  // `ref/pkg-0.2.2-alpha.2/dsh-session-format-v3-to-v4-0.2.2-alpha.2/lib/index.js:599`
  // 「system/message requires a protected first surface head」。首轮 `pre-step` 跑在
  // 宿主写系统头之前（`dsh-agent-loop` 先 assemble、再 append `system/message`），
  // 此时写标记就会抢在头前面——当时跑得好好的，关闭重开后整份日志被判 corrupt，
  // 会话永远打不开。宁可这一轮没有标记，也不能让日志变成不可读的。
  if (surfaceIsEmpty(session, log)) {
    if (typeof log === 'function') log('append-skip-empty-surface', { agent: agentId, kind })
    return false
  }
  try {
    const message = userMessage({ content: [{ type: 'text', text }], source: { kind } })
    session.append('user/message', message, { surfaceOp: 'append' })
    return true
  } catch (error) {
    // 写节点失败不致命（这一轮少了标记/提醒），但必须留痕：否则事后查“为什么没有轮次标记”
    // 会完全找不到线索。
    if (typeof log === 'function') log('append-own-failed', { agent: agentId, kind, error: String((error && error.message) || error) })
    return false
  }
}

function contextMapTool(ctx, config) {
  return {
    name: 'context_map',
    description:
      '查看当前上下文的分层结构：每一层占了多少、每个压缩块盖了哪几轮和它的标题、以及现在能压到哪里。' +
      '看当前的分层结构、每层占用、以及「可压位置」。提醒和 compress 的结果里都会附一张刷新的地图，' +
      '所以只有在你手上还没有地图、或者怀疑地图过期时才需要单独调这个工具；' +
      'compress 里的位置写法只能从地图里抄（序号 1 = 该区最老的块，轮号是 T 开头的那个）。',
    parameters: { type: 'object', properties: {} },
    output: textOutput(),
    execute: async (_args, exec) => {
      const blocked = missingSessionQuery(ctx, config)
      if (blocked) return { text: blocked }
      const agent = requireAgent(ctx, exec)
      try {
      // 先画地图、画成功了才发证：渲染抛错时不能让模型以为"已经看过地图"，
      // 否则它会凭记忆给序号，而许可证照样放行——这道保护就废了。
      const session = ctx.sessions.get(agent.id)
      const rendered = renderMap(ctx, agent, config, session ? readUsage(ctx, session, config) : null)
      if (session) issue(agent.id, session, rendered.zones)
      return { text: rendered.text }
    } catch (error) {
      return { text: '列地图时出错了：' + errText(error) }
    }
    },
  }
}

function compressTool(ctx, config, log, foldQueues, reminded) {
  const titleLimit = (config.title && config.title.maxTokens) || 50
  const seg = config.segment || {}
  return {
    name: 'compress',
    description:
      '把旧对话折成更短的摘要，摘要正文由你写在 summary 里。四个键各压一层、产物进上一层：' +
      'l0 的产物是 L1 块，l1 的产物是 L2 块，l2 的产物是 L3 块（落在 L3 区尾部，旧 L3 块原样不动），l3 把整个 L3 区压成一块（唯一不写 to 的键）。' +
      '压缩是自下往上长的：哪一层还是空的，就不能压它上面那一层。' +
      '压哪个键，就必须同批把比它浅、且还能压的层一起压掉，只动深层会整批被拒（某层不足 2 块、或只剩被保护的最后几轮时不用给）。' +
      'to 只写一个锚点：写最小的号 = 只压最老的一段；写最大的号 = 一次把可压段整段压掉（可压段只是"已结束、不在保护圈"，不代表里面的事都做完了），通常不是默认选择——要压就压已经完成的部分，压到第一个还没收尾的轮次之前就停。' +
      '别压还没做完的轮次：那一轮里的事还在进行（目标还没收尾、todo 没打完、还在验证、等你拍板）就先留着——压掉之后你只剩自己写的那几行摘要。' +
      '填表按时间线顺序，最老的一层先写：l3 → l2 → l1 → l0。' +
      '一次调用可以给多个键，一起给只断一次前缀缓存，所以攒够了一次压。' +
      '调用时要单独发：同一条消息里只发 compress，不要跟别的工具并行发（后台任务继续跑不算并行）。' +
      `正文单块上限按产物层算（token，不是字数）：压 l0 得到的 L1 块 ${seg.l1}、压 l1 得到的 L2 块 ${seg.l2}、压 l2/l3 得到的 L3 块 ${seg.l3}。` +
      '压完必须比被压掉的内容小；不达标整批不写，并会告诉你两侧的实际值。' +
      '被拒绝不等于坏了：照返回值改一处再试，或改压别的层。宿主自带的 /compact 会把分层拍平、原文再也取不回，不要用它代替 compress。',
    parameters: {
      type: 'object',
      properties: {
        l3: blockSpec('把整个 L3 区压成一块（不写 to）', false, titleLimit, true),
        l2: blockSpec('压 L2 区最老的一块或几块，到 to 指定的那块为止', true, titleLimit, false,
          '写并到第几个块：1 = 该区最老的块，最多到「块数 − 1」。从地图「可压位置」里抄一个序号，不能写成区间。'),
        l1: blockSpec('压 L1 区最老的一块或几块，到 to 指定的那块为止', true, titleLimit, false,
          '写并到第几个块：1 = 该区最老的块，最多到「块数 − 1」。从地图「可压位置」里抄一个序号，不能写成区间。'),
        l0: blockSpec('压原文区最旧的一段', true, titleLimit, false,
          '写到哪一轮为止：从地图「可压位置」里抄一个 T 号（只抄一个，不能写成区间；压到那轮结束，不会切到轮中）；只能写已经结束、且不在 keepTurns 里的轮。'),
      },
    },
    output: textOutput(),
    execute: async (args, exec) => {
      // 整段包在 try 里：`requireAgent` 之类抛错会被宿主工具层转成英文堆栈，
      // 模型看到的就不是中文原因了。
      let sessionAtCall = null
      try {
        const blocked = missingSessionQuery(ctx, config)
        if (blocked) return { text: blocked }
        const agent = requireAgent(ctx, exec)
        // 记下"这次调用在表层上是哪个节点"：此刻宿主的 tool/result 还没追加，
        // 所以调用消息就是最后一个节点。压完之后表层会被我们的产物改掉，
        // 那时再取就取不到了；折叠只能靠这个节点号精确落位。
        // 这一步马上要写表层：先把'这一步内'的用量缓存作废，回执地图必须显示压缩之后的新数（回归修复）。
        // 表格按代理分槽，只清自己那格；别的代理的步戳不受影响。
        stepStamps.delete(agent.id)
        sessionAtCall = ctx.sessions.get(agent.id)
        const callSeq = sessionAtCall ? callNodeOf(sessionAtCall, exec.callId) : null
        // 同一个 callId 可能跨助手消息复用：先作废旧的待折项，
        // 免得这一次失败时，上一轮成功留下的记录把它折成「已经成功」。
        forgetFold(foldQueueFor(foldQueues, agent.id), exec.callId)
        let result
        try {
          result = await runCompress(ctx, agent, args || {}, config, log)
        } catch (error) {
          // 兜底：任何没被预料到的异常都要变成一句中文原因，别把 JS 堆栈甩给模型
          result = { ok: false, reason: '压缩时出错了：' + errText(error) }
        }
      if (!result.ok) {
        log('compress-rejected', { reason: result.reason, applied: result.applied === true, keys: Object.keys(args || {}) })
        // 回执说"失败"但块其实已经落地（end 补不上那一路）：基线要照常重设，
        // 否则增长触发会把这一批当成"没发生"，下一轮立刻又报增长。
        if (result.applied === true) resetGrowthBaseline(ctx, agent, config, reminded, log)
        // 多键批里可能"前面的层已经写进去、后面的失败了"：把落盘的层说清楚，
        // 否则模型会整批重发，把已写的层再压一遍。fail() 给的是 partial，不是 results。
        const landed = Array.isArray(result.partial) && result.partial.length
          ? `（已经写进去的：${result.partial.map((r) => r.key).join('、')}；后面的没写）`
          : ''
        // 拒绝回执 = 错误 + 完整地图。设计稿 §11（"提醒里直接带地图"）与 §2.7 的
        // "地图必调"是同一件事的两面：模型要改对参数，必须先看到**块标题、每层压力、
        // 可压区间**这三样——只给一行 to 的数字，它不知道错在哪、为什么错，只能再撞一次。
        // 代价（450–690 token/次）是设计上认过的账，不许拿"省 token"当理由改成紧凑版。
        const mapText = fullMap(ctx, agent, config, log)
        if (mapText) issueFor(ctx, agent, log)
        return {
          text: `没能压缩：${result.reason}${landed}` +
            (mapText ? '\n\n' + mapText : '\n\n（地图刷新失败：先调 context_map，再按它给的可压位置重试）'),
        }
      }
      log('compress-ok', { keys: result.results.map((r) => r.key), prunedChars: result.prunedChars })
      // 登记待折叠：真正的替换发生在下一次 pre-step（那时工具返回才存在）。
      // 注意顺序：刷新后的地图必须在 rememberFold **之前**并进 lines，否则它跟着被折掉的结果一起消失——
      // 模型既看不到地图，又以为"地图随结果来了"，下一次照旧位置压，必被拒。
      // 设计稿 §2.7 / §11 要求压缩成功也带刷新后的地图（ae398aa 起就是行为约定）。
      const mapText = fullMap(ctx, agent, config, log)
      const lines = receiptLines(result.results, {
        prunedChars: result.prunedChars,
        // 切点跨过了缺轮：说明一句，免得块头标签（只写到 to）看起来像漏压了内容。
        swallowed: result.results.flatMap((r) => (Array.isArray(r.swallowed) ? r.swallowed : [])),
        mapText,
      })
      if (mapText) issueFor(ctx, agent, log)
      // 压缩把用量压下去了，但提醒的"上次量"基线还停在压缩前：不重设的话 grew 会长期为负，
      // 增长触发（notice.growthTokens）要等用量爬回压缩前的高度才可能再响——等于报废。
      resetGrowthBaseline(ctx, agent, config, reminded, log)
      // 开关关着就不登记：登记了也没人消费，等到重开那天全是「已经进过请求」的节点。
      if (config.foldCallRecord !== false) rememberFold(foldQueueFor(foldQueues, agent.id), exec.callId, lines.slice(), callSeq)
      return { text: lines.join('\n') }
      } catch (error) {
        log('compress-execute', { error: errText(error) })
        return { text: '压缩时出错了：' + errText(error) }
      }
    },
  }
}

// 压缩成功之后把"上一次提醒时的量"重设成现在的量。
// 不重设的话：基线停在压缩前的高位，压缩后 grew 长期为负，增长触发那个条件
// 要等用量一路爬回压缩前的高度才可能再响——等于把三个触发条件里的一个废掉。
// 导出是为了让测试直接钉住"先复位指示灯、再落盘"的顺序（审查 0883a196 Major 2）。
export function resetGrowthBaseline(ctx, agent, config, state, log) {
  try {
    const st = state.get(agent.id)
    if (!st) return
    const session = ctx.sessions.get(agent.id)
    if (!session) return
    const usage = readUsage(ctx, session, config)
    if (usage && typeof usage.used === 'number') st.tokens = usage.used
    // 任何原因触发的压缩都算"已经处理过增长"（用户要求 第 4 条）：
    // 额度回到原额、指示灯熄灭、待结算清空。留着旧的半额门槛会让下一次提醒来得莫名其妙。
    st.growthQuota = null
    st.growthLamp = false
    st.growthPending = null
    // 区超限快照也是"压缩前的读数"：同一轮后面的 pre-step 还照它说话，就会发出
    // 「L1 已超 626/400」而同一张地图显示「313/400、不足 2 块」的自相矛盾提醒
    // （回归修复）。压缩改变了表层，下一 step 必须重扫。
    st.zonesTurn = null
    st.zonesOver = null
    st.compressible = null
    st.envBlocked = null
    // 占用掉下来了：到线指示灯要按压缩后的实际比例复位，否则"掉下去又越上来"不再报。
    if (usage && typeof usage.ratio === 'number') st.lineOn = usage.ratio >= config.triggerPct
    // 落盘必须放在指示灯复位**之后**：以前先落盘再复位，盘上留的是压缩前的 lineOn，
    // 重启后会吞掉一次到线提醒（审查 0883a196 Major 2）。
    persistGrowth(ctx, agent.id, st, log)
  } catch {}
}

// 把这一轮的地图许可证续上：位置是刚刚现算的，照它压不会错。
// 为什么续：地图只在取到时有效，而"压完一层还想再压一层"是最常见的动作；
// 不续的话第二次压必被假报"地图过期"，白烧一个来回。
function issueFor(ctx, agent, log) {
  try {
    const session = ctx.sessions.get(agent.id)
    if (session) issue(agent.id, session, readZones(ctx, session, agent, log))
  } catch (error) {
    // 发不出证不致命（下一次 context_map 还能再发），但必须留痕：否则用户只会看到
    // 下一次 compress 报「还没看过地图」，方向完全指错。
    if (typeof log === 'function') log('license-issue-failed', { error: errText(error) })
  }
}

// 完整地图（块表 + 每层压力 + 可压区间 + 须知）。提醒、拒绝回执、成功回执三处共用同一份。
// 设计稿 §11「提醒里直接带地图」与 §2.7「地图必调」是同一件事的两面：模型的 `to`
// 只能从一张现算的地图里抄，而这三种时刻恰好都是"它马上要填表"的时刻。
function fullMap(ctx, agent, config, log) {
  try {
    const session = ctx.sessions.get(agent.id)
    const usage = session ? readUsage(ctx, session, config) : null
    return renderMap(ctx, agent, config, usage).text || ''
  } catch (error) {
    // 回执里少一张地图，模型就只能凭记忆压——这种退化必须能在日志里看见。
    if (typeof log === 'function') log('full-map-failed', { error: errText(error) })
    return ''
  }
}

// 统一 DSL：object 根不带 additionalProperties；顶层可以不写 required。
// 注意：**嵌套对象里的必填只能写成标准 JSON Schema 的 required 数组**，
// 不能写成逐属性 `required: true`——宿主只把「顶层」逐属性布尔折成数组，
// 嵌套层原样透传给 provider，OpenAI 兼容线看到 `required: true` 会整轮失败：
// `Invalid schema for function 'compress': true is not of type "array"`。
// 写法规范只在 l3 上写全（它排第一，模型从左往右生成时先读到），其余三个键给一行摘要，
// 否则同一段说明会随四个键各存一份，每轮请求白付四倍。
function blockSpec(desc, needTo, titleLimit, rich, toText) {
  const titleFull =
    `一块的标题：一个短名词短语，说清这块在讲什么事，同层之间要能互相区分（地图上只显示它）。上限 ${titleLimit} token。`
  const summaryFull =
    '这块的摘要正文。按这四行写，顺序不变，缺的行留空，不要另加小标题——' +
    '用户意图：<用户要你做什么、为什么，连同他明确给的约束与纠正，用他的话写>；' +
    '模型实际执行：<你真正做了哪些动作（改了什么文件、跑了什么命令、做了什么决定）；没做成的、失败过的尝试也要写：试过什么、为什么不行>；' +
    '运行结论：<最后成了什么、没成什么；产出是文件、报告、图片这类附件时，把路径或地址写全，让人能照着找回来>；' +
    '数据：<还要继续用的具体数值、标识符、路径与命令；不要抄 token、密钥、私有 URL、内网地址>。' +
    '判断标准只有一条：删掉这段之后，下一轮你还会做出同样的决定、跑同样的命令吗？会就删，不会就留——所以删的是过程叙述，不是决策依据。' +
    '不要写"如上所述"这类跨块引用，下次压缩后它会失效。' +
    '注意：更早的摘要里已经有的内容，只有在那个块这次不会被一起压掉时才能省；如果它就在你这次压掉的块里，必须写进新摘要。' +
    '只记事实和状态，不要写成一段对话：没真发出去的回复不要写成已发送，也不要列"已回答"这类清单。'
  const properties = {
    title: { type: 'string', description: rich ? titleFull : `同 l3 的 title：一个短名词短语，上限 ${titleLimit} token。` },
    summary: { type: 'string', description: rich ? summaryFull : '同 l3 的 summary 规则：四行——用户意图 / 模型实际执行（含失败的尝试和原因）/ 运行结论（附件写全路径或地址）/ 数据；删过程叙述，但决策依据和失败原因要留。' },
  }
  if (needTo) {
    properties.to = { type: 'string', description: toText }
  }
  // 嵌套层的必填用数组（见上方注释）：否则 provider 会看到 `required: true`。
  return { type: 'object', properties, required: Object.keys(properties), description: desc }
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

// 上下文占用：所有数字都直接问宿主的 tokenMeter，不自己拼投影字段。
// 用 measure().totalTokens 当"已用"，它 = 上一次 provider 上报的 prompt 用量
// 加上表层相对那次的增量，正是"下一次请求的 prompt 成本"。
// 注意 contextPressure 投影在两版宿主里都只有 pressureTokens / projectedTokens /
// contextWindow 三个字段（.strict()），没有 surfaceTokens / sampledSurfaceTokens，
// 早期按那两个字段算出来的读数恒为 null，提醒与区指示灯在真机上永远不亮。
// 这里做一个按会话 + 日志序号的小缓存：同一轮里提醒、地图、状态命令共用一次测量，
// measure() 自己会克隆整份表层（O(表层节点数)），不缓存的话每轮要算好几遍。
const usageCache = new WeakMap()
// 每一步的读数缓存：按会话存，带上"这是哪一步"的戳（缓存粒度）。
// 以前是一个模块级单槽，两个会话（尤其子代理）交替跑 pre-step 时会互相清掉对方的缓存：
// 不会算错，但会把很贵的 tokenMeter 反复调用——用户看到的就是"用量数字在跳"。
const stepMemo = new WeakMap() // session -> { stamp, seq, value }
// 步戳按代理分开存（不是模块级单槽）：父代理在 await 期间让出微任务时，
// 子代理的 pre-step 会把单槽覆盖掉，父代理随后每次读用量都要重算整份表层。
const stepStamps = new Map() // agentId -> `${turn}:${step}`

function windowOf(ctx, session) {
  try {
    const rc = session && session.requestContext ? session.requestContext() : undefined
    if (rc && typeof rc.contextWindow === 'number' && rc.contextWindow > 0) return rc.contextWindow
  } catch {}
  try {
    const tm = ctx.tokenMeter
    if (tm && typeof tm.contextPressure === 'function') {
      const p = tm.contextPressure(session)
      if (p && typeof p.contextWindow === 'number' && p.contextWindow > 0) return p.contextWindow
    }
  } catch {}
  try {
    const s = ctx.sessionProjections?.stateOf?.(session, 'contextPressure')
    if (s && typeof s.contextWindow === 'number' && s.contextWindow > 0) return s.contextWindow
  } catch {}
  return null
}

function usedOf(ctx, session) {
  try {
    const tm = ctx.tokenMeter
    if (tm && typeof tm.measure === 'function') {
      const m = tm.measure(session)
      if (m && typeof m.totalTokens === 'number' && m.totalTokens >= 0) return m.totalTokens
    }
  } catch {}
  try {
    const s = ctx.sessionProjections?.stateOf?.(session, 'contextPressure')
    if (s && typeof s.projectedTokens === 'number') return s.projectedTokens
    if (s && typeof s.pressureTokens === 'number') return s.pressureTokens
  } catch {}
  return null
}

// 供测试使用（真机由 pre-step / 地图 / 状态命令调用）。
// 缓存分两层（回归修复）：
//   · stepMemo —— 每个 pre-step 开头换一份新的，只在这一步内复用。
//     同一轮同一步里三次读用量（判提醒、判区超限、渲染地图）本来就该是同一个数，
//     以前按 session.seq 缓存，任何一次 append 都会让它失效，等于每步真测三次。
//   · usageCache —— 跨步按 seq 兜一层，seq 变了就重算。
export function readUsage(ctx, session, config) {
  try {
    const cacheable = session !== null && typeof session === 'object'
    const seq = cacheable && typeof session.seq === 'number' ? session.seq : -1
    // 步内缓存必须连表层版本一起比：同一步里宿主会 append 助手消息、再逐条落工具结果，
    // 之后模型调 context_map、人或 /context-status、收尾的 settleGrowth 读的都是"新的表层"。
    // 只比步戳会让它们拿到这一步请求之前的旧读数（增长基线偏低、下一轮增长虚高）。
    const agentId = cacheable && typeof session.id === 'string' ? session.id : null
    const stamp = agentId ? stepStamps.get(agentId) : null
    if (cacheable && stamp) {
      const memo = stepMemo.get(session)
      if (memo && memo.stamp === stamp && memo.seq === seq) return memo.value
    }
    if (cacheable) {
      const hit = usageCache.get(session)
      if (hit && hit.seq === seq && hit.config === config) {
        if (stamp) stepMemo.set(session, { stamp, seq, value: hit.value })
        return hit.value
      }
    }
    const value = computeUsage(ctx, session, config)
    if (cacheable) usageCache.set(session, { seq, config, value })
    if (cacheable && stamp) stepMemo.set(session, { stamp, seq, value })
    return value
  } catch {
    return null
  }
}

// 每次 pre-step 开头调用：换一个"步戳"。同一步内的重复读命中缓存，跨步、跨代理各自独立。
function beginUsageStep(agentId, turn, step, session) {
  const stamp = `${turn}:${step}`
  stepStamps.set(agentId, stamp)
  // readUsage 手上只有 session，没有 agentId：两个键都记一份，否则它永远查不到步戳、
  // 每步都退化成"没缓存"（不是错，只是白扫一遍表层，长会话里很贵）。
  if (session && typeof session.id === 'string' && session.id !== agentId) stepStamps.set(session.id, stamp)
}

function computeUsage(ctx, session, config) {
  try {
    const window = windowOf(ctx, session)
    if (window === null) return null
    const used = usedOf(ctx, session)
    if (used === null) return null
    // 宿主的 contextWindow 是"输入 + 输出"的总窗口，而请求里还要给输出预留 maxTokens。
    // 不扣掉这块预留，75% 这条线会正好压在真实上限上（例如 1M 窗口里预留 256K，真实输入上限只有 ~792K，
    // 而 75% × 1M = 786K 已经贴着墙了）。所以分母用"可用输入预算"。
    const reserve = reservedTokens(ctx, session, config)
    const budget = Math.max(Math.floor(window * 0.1), window - reserve)
    return { ratio: used / budget, used, window, budget, reserve }
  } catch {
    return null
  }
}

// 输出预留：优先读这条路由真实用的 maxTokens；读不到就用配置里的兜底值。
function reservedTokens(ctx, session, config) {
  try {
    const header = session && session.requestHeader ? session.requestHeader() : undefined
    const mt = header && header.config && header.config.maxTokens
    if (typeof mt === 'number' && mt > 0) return mt
  } catch {}
  const fallback = config && config.reservedTokens
  return typeof fallback === 'number' && fallback > 0 ? fallback : 0
}

// 各区实际占用：用插件自己的估算器（跟地图里显示的一致）。
// 不用宿主的计价：它按 4 字 1 token，中文被低估约 4 倍，区超限提醒在中文会话里几乎不会触发。
function readZoneOver(session, config, window, zones, log) {
  const over = {}
  try {
    const live = zones || readZones(null, session)
    for (const key of ['l1', 'l2', 'l3']) {
      const list = (live.zones && live.zones[key]) || []
      const used = list.reduce((t, n) => t + estimateTokens(n.text || ''), 0)
      const limit = Math.round((config.budget[key] || 0) * window)
      if (limit > 0 && used > limit) over[key] = { used, limit }
    }
  } catch (error) {
    // 区超限提醒会整体消失（返回空表），必须留痕，否则"这轮怎么没提醒"查不出来。
    if (typeof log === 'function') log('zone-over-failed', { error: errText(error) })
  }
  return over
}

function unwrapVolatile(value) {
  if (value === null || typeof value !== 'object') return value
  if (typeof value.get === 'function' && Object.isFrozen(value)) return value.get()
  if (Array.isArray(value)) return value.map(unwrapVolatile)
  const out = {}
  for (const [k, v] of Object.entries(value)) out[k] = unwrapVolatile(v)
  return out
}

function makeLiveConfig(raw) {
  const read = () => mergeConfig(unwrapVolatile(raw))
  const live = {}
  for (const key of Object.keys(read())) {
    Object.defineProperty(live, key, { enumerable: true, get: () => read()[key] })
  }
  return live
}

// 导出给测试：keepTurns 的取整必须落在运行时出口，这一层只有真读一次才看得见。
export function mergeConfig(raw) {
  const copy = raw && typeof raw === "object" ? { ...raw } : {}
  if (copy.notice && typeof copy.notice === "object" && !Array.isArray(copy.notice)) copy.notice = { ...copy.notice }
  const source = migrateConfig(copy)
  // 迁移必须发生在**运行时这条路**上（第四轮审查 D1）：validateConfig 拿到的是一份解引用副本，
  // 在副本上删旧键、填新键不会回流到宿主那份 raw；真正生效的是 mergeConfig 每次现读的这份。
  const merged = {
    ...DEFAULTS,
    ...source,
    budget: { ...DEFAULTS.budget, ...(source.budget || {}) },
    segment: { ...DEFAULTS.segment, ...(source.segment || {}) },
    notice: { ...DEFAULTS.notice, ...(source.notice || {}) },
    title: { ...DEFAULTS.title, ...(source.title || {}) },
  }
  // keepTurns 的取整与兜底必须落在**运行时出口**（回归修复）：`validateConfig` 收到的是
  // `unwrapVolatile` 造出来的副本，改那个副本不会回流到 raw；而地图与判轮读的是这里。
  // 用户 2026-11-05 定：面板 min=1 拦正常输入，插件侧兜底夹到 1..50——不再每轮抛红停用。
  // 类型错（字符串/布尔/对象）在 validateConfig 已经报错；这里只对数字做夹取，
  // 非数字退回默认值——两条路径给同一个答案，免得 validate 说 1、运行时说 2。
  if (merged.keepTurns !== undefined) {
    const keep = merged.keepTurns
    merged.keepTurns = typeof keep === 'number' && Number.isFinite(keep)
      ? Math.min(50, Math.max(1, Math.trunc(keep)))
      : DEFAULTS.keepTurns
  }
  return merged
}

