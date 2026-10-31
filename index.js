// dsh-ebbing-context —— 模型自己把旧对话折成三层摘要的 DSH 插件。
//
// 设计要点（详见 notes/2026-10-27-DSH原生分层压缩-设计方案.md §2.35 / §2.36）：
//   1. 只写宿主本来就认识的会话事件，不实现 ctx.compaction，不做代理，不拦截请求。
//   2. 层级不存盘：任何时刻都能从日志重算（块的身份靠检查点来源标记）。
//   3. 最上层按块收纳；压 L2 得到的是一块新的 L3，落在 L3 区尾部，旧 L3 块原样不动（不拼接）。
//   4. L3 是多块区；l3 键把整个 L3 区压成一块（不接受 to）。

import { DEFAULTS, NAME, validateConfig } from './lib/config.js'
import { renderMap } from './lib/map.js'
import { estimateTokens } from './lib/tokens.js'
import { issue, forget, restate } from './lib/license.js'
import { canCompressZone, readZones } from './lib/blocks.js'
import { runCompress } from './lib/compress.js'
import { userMessage } from './lib/messages.js'
import { rememberFold, forgetFold, foldCallRecordEx, callNodeOf, shrinkReceipt } from './lib/callfold.js'
import { makeLogger } from './lib/log.js'

export const name = NAME
export const inject = ['tools', 'sessions', 'tokenMeter', 'agents', 'sessionProjections']

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
      forgivePct: V(Schema.number().min(0).max(100).default(DEFAULTS.notice.forgivePct)),
    }).default(DEFAULTS.notice),
    reservedTokens: V(Schema.number().min(0).default(DEFAULTS.reservedTokens)),
    // 少了这一行，宿主解析出的 config 里根本没有这个键：面板与 YAML 改了都不生效，
    // validateConfig 里那条却一直在，于是永远用默认值 2 —— 那种"设了等于没设"比没有控件更坏。
    keepTurns: V(Schema.number().min(0).max(50).default(DEFAULTS.keepTurns)),
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
    `本机装了分层压缩。占用超过 ${pct}% 后，一轮结束时插件会把你直接叫醒一次，第一条消息就是提醒（带当前地图）——看到它就真的调用 compress，回一句"我来压缩"不算。`,
    '两个工具：context_map 看当前分层结构和「可压位置」；compress 把最旧的对话折成更短的摘要（填法、级联与上限都写在它的说明与参数里）。',
    '摘要正文由你写进 summary，插件只搬运、不调模型。',
    '历史里那些〔L1｜T16–T19｜ev 4121–4390〕标题开头的块是压缩结果（括号里是它所在的层、覆盖的轮次、被压掉的事件号范围），是已经成立的事实：直接在它们上面继续做事，不要复述、不要在回复里提它、不要把里面的事重做一遍。',
    '压掉的原文不会消失（还在会话日志里）：装了「会话搜索」就能按事件编号取回；没装时这两个工具会直接停用（取不回来就不让压）。所以摘要写短没关系，但别每次压完就顺手取回，只有真需要原文时才取。',
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

export function apply(ctx, rawConfig = {}) {
  // 自己先验一遍：不依赖宿主 schema，加载不到 schemastery 也不会静默放过写错的配置。
  // 宿主把带 volatile 标记的字段解析成引用对象（{ get(), [write] }），不是裸值；
  // 直接拿它做 typeof 判断会全部判错（数字/布尔都成了 object），所以先解引用。
  const plainConfig = unwrapVolatile(rawConfig)
  validateConfig(plainConfig)
  // 宿主保存 volatile 字段时只原地更新引用（loader 里 equalExceptVolatile → _commitVolatile），
  // **不会重新 apply**，所以启动时的快照会在改完参数后一直生效。这里改成每次读都解引用。
  const config = makeLiveConfig(rawConfig)
  const log = makeLogger('ebbing-context')
  const reminded = new Map() // agentId -> { turn, count }：每轮最多一条，count 用来在第二次起换说法
  // 待发的提醒：命中之后每一步都覆盖一次（最后一步的读数最接近收尾那一刻），
  // 收尾时按「同一个 AbortSignal」把它认回来——agent/turn-stopping 的载荷只有 { turn, signal }，
  // 没有 agent，所以不能按 agentId 认。
  const pendingBySignal = new WeakMap() // 本轮信号 -> 待发记录
  const pendingByAgent = new Map() // agentId -> { signal, record }：只为清理异常收场留下的孤儿
  const overflowSaid = new Map() // agentId -> 上一次报超限发生在第几轮
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
  ctx.on('loader/volatile-update', () => { rebuild() })

  // /context-status：只读，给人看。插件出问题时先看它，而不是去翻日志文件。
  const commands = ctx.get('commands')
  if (commands && typeof commands.register === 'function') {
    ctx.effect(() =>
      commands.register({
        name: 'context-status',
        description: '看当前上下文的分层占用、块列表与可压位置（只读，不改任何东西；折叠失败会附在末尾）。',
        handler: (invocation) => {
          try {
            const mapSession = ctx.sessions.get(invocation.agent.id)
        const mapUsage = mapSession ? readUsage(ctx, mapSession, config) : null
        const text = renderMap(ctx, invocation.agent, config, mapUsage).text
            // 折叠失败原本只写进日志文件：插件"看起来"一切正常，只是调用记录没折掉、白花 token。
            // 这里把它摆到人一眼能看到的地方。
            const queue = foldQueues.get(invocation.agent.id)
            const failure = queue && queue.lastError
            const suffix = failure
              ? `\n\n折叠上一次失败（${failure.at}）：${failure.error}\n调用记录原样留着，没有伤到会话；但如果每次都失败，压缩就会多花一份摘要的钱。`
              : ''
            return { kind: 'success', text: text + suffix }
          } catch (error) {
            return { kind: 'error', text: `看不了：${String(error && error.message ? error.message : error)}` }
          }
        },
      }),
    )
  }


  // 到线就提醒：每轮一条，只在线上就一直提醒；掉下去就复位。不做任何机械措施。
  // 顺序要紧：先追加再 next()，否则提醒只能等到下一轮才见效。
  ctx.on('agent/pre-step', async (payload, next) => {
    // 宿主不在 waterfall 外层兜异常：抛出去会被 kick() 的 catch 静默吞掉，整轮不再发请求、
    // 用户也看不到原因（cordis events.ts waterfall 无 try/catch → agent-loop:1010 throwError）。
    // 所以这里自己兜住——任何一步失败只放弃本次动作，绝不阻断这一轮。
    try {
      // 先收上一次 compress 的调用记录：这一步仍在同一个 turn 内，且在下一次请求之前，
      // 所以那份参数副本不会再被发出去一次。
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
      if (config.notice.enabled) remindIfNeeded(ctx, config, reminded, pendingBySignal, pendingByAgent, payload)
    } catch (error) {
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
      flushNotice(ctx, config, reminded, pendingBySignal, pendingByAgent, payload, log)
      // 先发再结算：刚发出去的那条会把 growthPending 记成本轮，这里看到 turn <= pending 就跳过；
      // 真正要结算的是"上一轮发的提醒，这一轮还没压"。
      settleGrowth(ctx, config, reminded, payload, log)
    } catch (error) {
      log('turn-stopping', { error: String((error && error.message) || error) })
    }
  })

  // 真的超了：只报一句，不自动压缩、不重试、不改写历史。
  // 同一轮只报一条：宿主可能在同一轮里重试多次，不去重会把这句话刷屏。
  ctx.on('agent/request-error', async (payload, next) => {
    // 这个 waterfall 不兜异常（宿主的 emit 兜、waterfall 不兜）：任何一步抛错都会让
    // 这一轮以 error 收场，而且用户看不到超限那句提示。所以整段包起来。
    try {
      const code = payload.failure && payload.failure.code
      if (code === CONTEXT_WINDOW_EXCEEDED) {
        const id = payload.agent.id
        const turn = typeof payload.turn === 'number' ? payload.turn : null
        if (overflowSaid.get(id) !== turn) {
          overflowSaid.set(id, turn)
          // 超限就停：不让 goal 自动续作把它一轮一轮地重新撞上去。
          // disarm 只摘掉「自动续作」这层权限，不动 goal 的落盘状态与人可见的 revision，人随时能 resume。
          try {
            const goals = ctx.get('goals')
            if (goals && typeof goals.disarm === 'function') goals.disarm(payload.agent)
          } catch {}
          log('overflow', { agent: id, turn })
          try {
            appendNotice(ctx, id,
              '上下文超出窗口，这一轮已经被服务端拒掉，停在这里，不会自动再试；自动续作也已经停掉。' +
              '现在每次请求都还会超窗口，compress 要依附在一次成功的请求上才调得动，所以先别等我压。' +
              '请你把 maxTokens 调小，或者换一个窗口更大的模型，然后发一句话让我继续。' +
              '如果这两条都做不到，要不要用宿主自带的压缩（它会把分层拍平、原文再也取不回）由你决定——我不替你选。')
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
export function foldPending(ctx, config, queues, payload, log) {  if (!config.foldCallRecord) return
  const id = payload.agent.id
  const queue = queues.get(id)
  try {
    const session = ctx.sessions.get(id)
    if (!session) return
    if (!queue || queue.size === 0) {
      // 队列空也可能有活：失败回执没有待折项，但那张地图会随着每次重试永久叠一张。
      const shrunk = shrinkReceipt(session, null)
      if (shrunk.done) {
        log('compress-receipt-shrunk', { agent: id, kind: shrunk.kind })
        try { restate(id, session) } catch {}
      }
      return
    }
    const r = foldCallRecordEx(session, queue, config)
    if (r.note) {
      log('fold-call-record', { agent: id })
      // 折叠自己改过一次表层（replaceGeneration +1）。地图许可证必须跟着对齐，
      // 否则"MCP 刚续上的地图"会被我们自己的折叠打废，接着压必被假报过期。
      try { restate(id, session) } catch {}
      // 成功就抹掉上一次的失败记录：那个错误已经被下一轮覆盖掉了，不该一直挂在状态里。
      queue.lastError = null
      queue.failures = 0
      return
    }
    // 并行调用（同一条助手消息里还有别的调用）：整段替换会让兄弟调用变孤儿，
    // 只能把带地图的那条返回收紧，并把待折项销掉。
    if (r.reason === 'parallel-call') {
      const shrunk = shrinkReceipt(session, queue)
      if (shrunk.done) {
        log('fold-call-record-shrunk', { agent: id, kind: shrunk.kind })
        try { restate(id, session) } catch {}
        queue.lastError = null
        queue.failures = 0
        return
      }
    }
    // 下面是"折不掉"：这些情形都不会自己好转——
    // 尾部那一对一旦被后来的消息顶走，就再没有任何时刻能折它了。
    // 所以记一次、把这一条丢掉、并把原因留给 /context-status，不再每轮白撞。
    if (r.reason === 'empty' || r.reason === 'disabled') return
    if (r.callId) queue.delete(String(r.callId))
    if (r.reason === 'no-entry' || r.reason === 'no-tail-pair') {
      // 这两种永远不会好转（尾部那对不是我们的调用 / 已被顶走），
      // 留着只会占队列上限（QUEUE_LIMIT=4）并每轮重试一次，直接丢。
      queue.lastError = { at: new Date().toISOString(), error: FOLD_REASON_TEXT[r.reason] || r.reason }
      log('fold-call-record-dropped', { agent: id, error: queue.lastError.error })
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
  'error-result': '这次调用的结果本身是失败的，不折（留着原样，免得短注说"已经成功"）',
  'node-unknown': '定位不到这次调用在表层上的位置（会话里出现了空节点），这一条不再重试',
  'no-entry': '待折队列里没有这一条（多半是同一 callId 又被调了一次），不再重试',
  'no-tail-pair': '尾部那一对已经不是这次调用了（后来又被别的消息顶走），这一条不再重试',
  'parallel-call': '这次调用和别的工具调用挤在同一条消息里，整段替换会连累它们，改成只收紧返回正文',
}

// 三种触发条件各自独立，同一条提醒里可以同时给出多条理由：
//   1) 占用达到 triggerPct（每一轮一条）
//   2) 自上次提醒之后又长了 notice.growthTokens（总量还没到线时这条会先叫）
//   3) 某一层区超出设计容量（每层各自只在第一次越线时提醒，回落再涨才会再提醒）
//
// 这一步只做判定、只留一条待发记录，一个节点都不写：投递统一在收尾（flushNotice）。
// 每一步都会重算并覆盖这条记录，所以收尾拿到的是"最后一步看到的那份读数"——
// 既不额外多算一遍，也不会拿开头那一步的旧数字去说话。
function remindIfNeeded(ctx, config, state, bySignal, byAgent, payload) {
  const session = ctx.sessions.get(payload.agent.id)
  if (!session) return
  const usage = readUsage(ctx, session, config)
  if (!usage) return

  const id = payload.agent.id
  const turn = typeof payload.turn === 'number' ? payload.turn : null
  // 拿不到轮号就别开口：`autoTurn` 的初值也是 null，`null === null` 恒真，
  // 会把"每个会话的第一条提醒"永久吃掉（宿主现在恒给数字，这里只防兜底漏洞）。
  if (turn === null) return
  let st = state.get(id)
  if (!st) {
    st = newState()
    state.set(id, st)
  }

  // 第一次见到这个会话就把"上一次提醒时的量"定为当前量，否则增长触发永远没有基线、开不了口。
  if (st.tokens === null) st.tokens = usage.used
  // 这一轮本来就是被叫醒的那一轮：不再登记第二条。刚说过的话不必再说一遍，
  // 等用户真开口之后的下一轮再判（否则"读了提醒没压"会立刻又收到一条同样的提醒）。
  if (st.autoTurn === turn) {
    forgetPending(bySignal, byAgent, id, payload.signal)
    return
  }
  const grew = usage.used - st.tokens
  // 到线提醒同样是"越线才报一次"（用户 m14563）：越过那条线时亮灯、报一条就记住，
  // 掉回线下再熄灭；一直停在线上面不会每轮重复报——增长那条负责"还在长"的后续提醒。
  const aboveLine = usage.ratio >= config.triggerPct
  if (!aboveLine) st.lineOn = false
  const onLine = aboveLine && !st.lineOn
  // 增长门槛可能是"原额"，也可能是上一次没压成时被砍到的一半（用户 m14431 第 2 条）。
  const growthQuota = typeof st.growthQuota === 'number' ? st.growthQuota : config.notice.growthTokens
  const onGrowth = growthQuota > 0 && grew >= growthQuota

  // 区超限要全量扫一遍日志，所以每轮最多扫一次；同一轮后面几步复用这次结果，
  // 既省重复扫描，也免得同一条提醒在几步之间理由来回变。
  if (st.zonesTurn !== turn) {
    st.zonesTurn = turn
    // 区配额与触发线必须用同一个分母（可用输入预算），否则两套账。
    st.zonesOver = readZoneOver(ctx, session, config, usage.budget)
    // 整批必拒的状态（认不出块在哪）不要叫醒模型：叫醒了也压不动，
    // 每轮白烧一次请求和一次失败调用的 token，直到窗口撑爆把人逼去 /compact。
    // 顺带把"哪一层现在真的压得动"算出来：区超限与纯增长这两类提醒只在
    // 真能动手时才发（用户 m14280）——叫醒了却压不动，等于每轮白烧一次失败调用。
    try {
      const zones = readZones(ctx, session)
      st.ambiguous = zones.ambiguous === true
      const keepTurns = typeof config.keepTurns === 'number' ? config.keepTurns : 0
      st.compressible = {
        l0: canCompressZone(zones, 'l0', keepTurns),
        l1: canCompressZone(zones, 'l1', keepTurns),
        l2: canCompressZone(zones, 'l2', keepTurns),
        l3: canCompressZone(zones, 'l3', keepTurns),
      }
      // "这一层还有内容吗"：区分"空层"与"有内容但压不动"。空层不该被当成不可压的拖累。
      st.zoneHas = {
        l0: (zones.zones.l0 || []).length > 0,
        l1: (zones.zones.l1 || []).length > 0,
        l2: (zones.zones.l2 || []).length > 0,
        l3: (zones.zones.l3 || []).length > 0,
      }
    } catch {
      st.ambiguous = false
      st.compressible = null
      st.zoneHas = null
    }
  }
  if (st.ambiguous) {
    forgetPending(bySignal, byAgent, id, payload.signal)
    return
  }
  const zoneOver = st.zonesOver || {}
  const compressible = st.compressible || null
  const zoneHas = st.zoneHas || null
  const anyCompressible = compressible ? Object.values(compressible).some(Boolean) : true

  const reasons = []
  if (onLine) reasons.push('line')
  // 纯增长触发：一个可压的层都没有时闭嘴（用户 m14280 第 2 条）。
  // 但闭嘴不等于把这次增长丢掉：把门槛砍到原额的一半、基线前移到当前，
  // 再长半个额度就重新判一次（用户 m14431 第 2 条）。一直砍不下去说明内容还在长，
  // 而每次只多等半个门槛，不会因为"一直压不动"就把这条触发彻底饿死。
  if (onGrowth) {
    if (anyCompressible) {
      // 增长指示灯：到量且真压得动才亮。收尾那一步发不发，就看这一格。
      st.growthLamp = true
    } else if (typeof st.growthQuota !== 'number' || st.growthQuota > Math.max(1, Math.round(config.notice.growthTokens * 0.5))) {
      st.growthLamp = false
      st.growthQuota = Math.max(1, Math.round(config.notice.growthTokens * 0.5))
      st.tokens = usage.used
    }
  }
  if (onGrowth && st.growthLamp) reasons.push('growth')
  // 区超限：要报的那一层，比它浅的层必须全都压得动（用户 m14431 第 1 条）。
  // 深一层满、浅层没满时照报浅层那条；地图上写着深层不可压，模型不会硬去压它。
  for (const key of ['l1', 'l2', 'l3']) {
    const worthTelling = zoneNoticeAllowed(key, zoneOver, compressible, zoneHas)
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

// 区超限要不要报：比它浅、**而且还有内容**的层必须全都压得动（用户 m14431 第 1 条）。
// 道理：压深层要把上面还能压的层同批给出去；浅层有内容却压不动时，这条提醒只能换来一次拒绝。
// 浅层是空的则不算"不可压"——空层本来就不用进这一批，不许拿它把深层一起拖黑。
// 反过来（深一层满、浅层没满）照报浅层那条：地图上会写着深层不可压，模型不会硬去压它。
const SHALLOWER = { l1: ['l0'], l2: ['l0', 'l1'], l3: ['l0', 'l1', 'l2'] }

export function zoneNoticeAllowed(key, zoneOver, compressible, hasContent) {
  if (!zoneOver || !zoneOver[key]) return false
  // 拿不到哪一层压得动（读表层失败）：不拦，宁可多报一次也别静默。
  if (!compressible) return true
  if (!compressible[key]) return false
  return SHALLOWER[key].every((k) => !(hasContent && hasContent[k]) || compressible[k])
}

function newState() {
  return {
    turn: null, count: 0, tokens: null, zones: {}, zonesTurn: null, zonesOver: null,
    autoTurn: null, ambiguous: false, compressible: null, zoneHas: null, lineOn: false,
    // 增长这条触发自己的两格状态（用户 m14431 第 2 条）：
    // growthQuota = 当前门槛（null 表示用配置里的原额；压不动时砍到一半）
    // growthLamp  = 增长指示灯（亮着表示"已经在等模型动手"，收尾那步才发得出去）
    growthQuota: null,
    growthLamp: false,
    // 增长提醒发出去的那一轮：下一轮收尾时如果还没压，就按 forgivePct 退额度。
    growthPending: null,
  }
}

function forgetPending(bySignal, byAgent, id, signal) {
  const record = signal ? bySignal.get(signal) : undefined
  if (record && record.agentId === id) bySignal.delete(signal)
  const entry = byAgent.get(id)
  if (entry && (!signal || entry.signal === signal)) byAgent.delete(id)
}

// 增长提醒发出去之后，模型还有一整轮时间决定压不压。到那轮收尾时仍然没压，
// 就按 notice.forgivePct 把这段增长退回额度里（用户 m14431 第 3 条）：
//   · 100（默认）= 全额退回，等于重新攒满一个门槛才会再提醒；
//   · 50 = 只退回一半，剩下一半继续算数，下一轮更容易再亮灯；
//   · 0 = 一分不退，下一轮接着提醒（模型每轮都能看到"又长了"）。
// 不做这一步的话，基线停在提醒那一刻，模型只要一直不压，增长这条就每轮都成立，
// 变成"每轮叫醒一次"的连环烧钱。
function settleGrowth(ctx, config, state, payload, log) {
  const id = payload.agent && payload.agent.id
  if (!id) return
  const st = state.get(id)
  if (!st || st.growthPending === null) return
  const turn = typeof payload.turn === 'number' ? payload.turn : null
  // 还在被叫醒的那一轮里：给它这一步的时间，收尾时才结算。
  if (turn === null || turn <= st.growthPending) return
  const session = ctx.sessions.get(id)
  const usage = session ? readUsage(ctx, session, config) : null
  const raw = config.notice && config.notice.forgivePct
  const pct = typeof raw === 'number' && Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 100
  if (usage) st.tokens = st.tokens + (usage.used - st.tokens) * (pct / 100)
  st.growthPending = null
  st.growthLamp = false
  // 退完这次增长就把门槛放回原额：砍半只是"压不动时早点给一次机会"的临时手段，
  // 不能让某一次压不动的历史把此后每一轮都变成半个门槛（用户 m14797）。
  // 成功压缩那条路更彻底：resetGrowthBaseline 会把 quota/lamp/pending 一起清空。
  st.growthQuota = null
  log('growth-forgiven', { agent: id, turn, forgivePct: pct })
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

// 认领到的消息里只要有一条不是我们发的，就说明用户（或别的流程）开口了：
// 解除"刚叫醒过一轮"的闸，下一次收尾还能再叫醒一次。
function noteUserSpoke(state, payload) {
  if (payload.step !== 1 || !Array.isArray(payload.messages) || payload.messages.length === 0) return
  const id = payload.agent && payload.agent.id
  if (!id) return
  const st = state.get(id)
  if (!st || st.autoTurn === null) return
  const fromUs = payload.messages.every((m) => m && m.source && m.source.kind === NOTICE_KIND)
  if (!fromUs) st.autoTurn = null
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
      if (message && message.source && message.source.kind === NOTICE_KIND) return message
    }
  } catch {}
  return null
}

function deliverNotice(ctx, config, state, record, log) {
  const id = record.agentId
  const session = ctx.sessions.get(id)
  if (!session) return
  let st = state.get(id)
  if (!st) {
    st = newState()
    state.set(id, st)
  }

  const turn = typeof record.turn === 'number' ? record.turn : st.turn
  const text = noticeText(ctx, config, record, record.count)
  const message = userMessage({ content: [{ type: 'text', text }], source: { kind: NOTICE_KIND } })

  // 记账放在"真的发出去"之后：先记账会让"投递失败"也算发过，
  // 于是这一轮白算、下一轮 `st.turn !== turn` 又登记又失败，每轮静默重试，
  // 区越线标志还会被白白置位（正是下面注释里说要避免的那种假话）。
  const commit = () => {
    st.turn = turn
    st.count = record.count
    st.tokens = record.usage.used
    for (const key of ['l1', 'l2', 'l3']) st.zones[key] = !!(record.zoneOver && record.zoneOver[key])
    // 增长这条路：记下"哪一轮发的"，下一轮收尾时据此判断模型有没有动手（见 settleGrowth）。
    if (record.reasons.includes('line')) st.lineOn = true
    if (record.reasons.includes('growth')) st.growthPending = turn
  }

  // 叫醒模型立刻压（用户 m10194）：followup 只是把消息排进 inbox 的 next-turn，
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
    session.append('user/message', message, { surfaceOp: 'append' })
    commit()
  } catch (error) {
    log('notice-append-failed', { agent: id, error: String((error && error.message) || error) })
  }
}

function noticeText(ctx, config, record, count) {
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
      issueFor(ctx, record.agent)
    }
  } catch {}

  return (
    // 首行必须自报家门：宿主把它作为一条 user/message 交给模型，模型默认会当成"用户说的"。
    // 说清是谁发的、这不是用户发言，模型才不会把提醒里的数字当成用户给的要求。
    '〔Ebbing Context 自动提醒 · 插件注入，不是用户说的话〕\n' +
    // 第 3 点（用户 m14280）：提醒是"要不要压"的入口，不是"必须压"的命令。
    // 把判断权明确交回模型：内容还在用就先留着，这一轮什么都不做也允许——
    // 否则它会把做到一半的工作压掉，然后只剩自己写的那几行摘要。
    '压不压由你判断：要压掉的那几轮里如果有还没做完的事（目标还没收尾、todo 没打完、还在验证、等用户拍板），' +
    '或者内容接下来明显还要用到，就留着别动——这一轮允许什么都不压，按原计划继续干活即可。' +
    parts.join('') +
    '决定要压时：照下面给的位置，一次调用把还能压的层一起给完（级联与填表顺序见 compress 的说明）。' +
    '没有可压位置就直接告诉用户这一版压完了，并说明宿主自带压缩会把分层拍平、要不要用由用户决定。' +
    '不压也回一句为什么（例如"还没做完，先留着"），不要沉默，也不要假称压过了。' +
    '压完只回一两句：压了哪几层、省下多少、现在占用多少；不要复述摘要，也不要重新讲一遍做过的事。' +
    mapText
  )
}


function fmt(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// 尾部追加一条提示，不碰前缀。失败静默：提示发不出去不该影响这一轮。
function appendNotice(ctx, agentId, text) {
  const session = ctx.sessions.get(agentId)
  if (!session) return
  try {
    const message = userMessage({ content: [{ type: 'text', text }], source: { kind: NOTICE_KIND } })
    session.append('user/message', message, { surfaceOp: 'append' })
  } catch {}
}

function contextMapTool(ctx, config) {
  return {
    name: 'context_map',
    description:
      '查看当前上下文的分层结构：每一层占了多少、每个压缩块盖了哪几轮和它的标题、以及现在能压到哪里。' +
      '压缩之前必须先调这个：compress 里的位置写法只能从这张地图里抄。' +
      '压过一次之后，压缩结果里会直接附一张刷新的地图，接着压就照那张，不用再调这个工具；' +
      '只有当表层被别的东西改过时，才需要重新看一遍地图（否则你会照着旧序号去压，压到隔壁那块）。',
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
      const text = renderMap(ctx, agent, config, session ? readUsage(ctx, session, config) : null).text
      if (session) issue(agent.id, session)
      return { text }
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
          '写并到第几个块：1 = 该区最老的块，最多到「块数 − 1」。只能从地图里抄。'),
        l1: blockSpec('压 L1 区最老的一块或几块，到 to 指定的那块为止', true, titleLimit, false,
          '写并到第几个块：1 = 该区最老的块，最多到「块数 − 1」。只能从地图里抄。'),
        l0: blockSpec('压原文区最旧的一段', true, titleLimit, false,
          '写到哪一轮为止：如 T19（压到那轮结束，不会切到轮中）；只能写已经结束、且不在 keepTurns 里的轮；只认地图里的 T 号。'),
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
        sessionAtCall = ctx.sessions.get(agent.id)
        const callSeq = sessionAtCall ? callNodeOf(sessionAtCall) : null
        // 同一个 callId 可能跨助手消息复用：先作废旧的待折项，
        // 免得这一次失败时，上一轮成功留下的记录把它折成「已经成功」。
        forgetFold(foldQueueFor(foldQueues, agent.id), exec.callId)
        let result
        try {
          result = await runCompress(ctx, agent, args || {}, config)
        } catch (error) {
          // 兜底：任何没被预料到的异常都要变成一句中文原因，别把 JS 堆栈甩给模型
          result = { ok: false, reason: '压缩时出错了：' + errText(error) }
        }
      if (!result.ok) {
        log('compress-rejected', { reason: result.reason, keys: Object.keys(args || {}) })
        // 多键批里可能"前面的层已经写进去、后面的失败了"：把落盘的层说清楚，
        // 否则模型会整批重发，把已写的层再压一遍。fail() 给的是 partial，不是 results。
        const landed = Array.isArray(result.partial) && result.partial.length
          ? `（已经写进去的：${result.partial.map((r) => r.key).join('、')}；后面的没写）`
          : ''
        // 拒绝回执 = 错误 + 完整地图。设计稿 §11（"提醒里直接带地图"）与 §2.7 的
        // "地图必调"是同一件事的两面：模型要改对参数，必须先看到**块标题、每层压力、
        // 可压区间**这三样——只给一行 to 的数字，它不知道错在哪、为什么错，只能再撞一次。
        // 代价（450–690 token/次）是设计上认过的账，不许拿"省 token"当理由改成紧凑版。
        const mapText = fullMap(ctx, agent, config)
        if (mapText) issueFor(ctx, agent)
        return { text: `没能压缩：${result.reason}${landed}` + (mapText ? '\n\n' + mapText : '') }
      }
      log('compress-ok', { keys: result.results.map((r) => r.key), prunedChars: result.prunedChars })
      const lines = result.results.map(
        (r) => `${r.key} 成功：${r.title}（${r.shadowedCount} 条 -> 省 ${r.savedTokens} token）`,
      )
      if (result.prunedChars > 0) {
        lines.push(`顺带把超大的工具结果剪短了 ${result.prunedChars} 个字符（原文仍在日志里，可查回）。`)
      }
      // 登记待折叠：真正的替换发生在下一次 pre-step（那时工具返回才存在）。
      // 注意顺序：刷新后的地图必须在 rememberFold **之前**并进 lines，否则它跟着被折掉的结果一起消失——
      // 模型既看不到地图，又以为"地图随结果来了"，下一次照旧位置压，必被拒。
      // 设计稿 §2.7 / §11 要求压缩成功也带刷新后的地图（ae398aa 起就是行为约定）。
      const mapText = fullMap(ctx, agent, config)
      if (mapText) lines.push(mapText)
      if (mapText) issueFor(ctx, agent)
      // 压缩把用量压下去了，但提醒的"上次量"基线还停在压缩前：不重设的话 grew 会长期为负，
      // 增长触发（notice.growthTokens）要等用量爬回压缩前的高度才可能再响——等于报废。
      resetGrowthBaseline(ctx, agent, config, reminded)
      rememberFold(foldQueueFor(foldQueues, agent.id), exec.callId, lines.slice(), callSeq)
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
function resetGrowthBaseline(ctx, agent, config, state) {
  try {
    const st = state.get(agent.id)
    if (!st) return
    const session = ctx.sessions.get(agent.id)
    if (!session) return
    const usage = readUsage(ctx, session, config)
    if (usage && typeof usage.used === 'number') st.tokens = usage.used
    // 任何原因触发的压缩都算"已经处理过增长"（用户 m14431 第 4 条）：
    // 额度回到原额、指示灯熄灭、待结算清空。留着旧的半额门槛会让下一次提醒来得莫名其妙。
    st.growthQuota = null
    st.growthLamp = false
    st.growthPending = null
  } catch {}
}

// 把这一轮的地图许可证续上：位置是刚刚现算的，照它压不会错。
// 为什么续：地图只在取到时有效，而"压完一层还想再压一层"是最常见的动作；
// 不续的话第二次压必被假报"地图过期"，白烧一个来回。
function issueFor(ctx, agent) {
  try {
    const session = ctx.sessions.get(agent.id)
    if (session) issue(agent.id, session)
  } catch {}
}

// 完整地图（块表 + 每层压力 + 可压区间 + 须知）。提醒、拒绝回执、成功回执三处共用同一份。
// 设计稿 §11「提醒里直接带地图」与 §2.7「地图必调」是同一件事的两面：模型的 `to`
// 只能从一张现算的地图里抄，而这三种时刻恰好都是"它马上要填表"的时刻。
function fullMap(ctx, agent, config) {
  try {
    const session = ctx.sessions.get(agent.id)
    const usage = session ? readUsage(ctx, session, config) : null
    return renderMap(ctx, agent, config, usage).text || ''
  } catch {
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
export function readUsage(ctx, session, config) {
  try {
    const cacheable = session !== null && typeof session === 'object'
    const seq = cacheable && typeof session.seq === 'number' ? session.seq : -1
    if (cacheable) {
      const hit = usageCache.get(session)
      if (hit && hit.seq === seq && hit.config === config) return hit.value
    }
    const value = computeUsage(ctx, session, config)
    if (cacheable) usageCache.set(session, { seq, config, value })
    return value
  } catch {
    return null
  }
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

function mergeConfig(raw) {
  return {
    ...DEFAULTS,
    ...raw,
    budget: { ...DEFAULTS.budget, ...(raw.budget || {}) },
    segment: { ...DEFAULTS.segment, ...(raw.segment || {}) },
    notice: { ...DEFAULTS.notice, ...(raw.notice || {}) },
    title: { ...DEFAULTS.title, ...(raw.title || {}) },
  }
}

