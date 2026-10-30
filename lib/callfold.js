// 把「这一次 compress 调用 + 它的返回」从表层折成一句短注。
//
// 为什么要做：摘要里那份参数副本，在我们把原文折成块之后就成了纯粹的重复内容——
// 那段原文已经变成顶部的块，它却还留在本轮的调用参数里整份发一遍。
//
// 为什么不能在工具里当场做：工具返回的那一刻，宿主还没追加 tool/result。
// 只删调用会留下一条没妈的返回（下一次请求里就是"结果找不到对应调用"）。
// 所以挪到下一次 agent/pre-step——它仍在同一个 turn 内，且发生在下一次请求之前，
// 于是那份参数副本根本不会被再发一次；模型看到的是下面这段短注。
//
// 为什么替换后必须是 user/message：宿主不允许把节点替换成 assistant/message
// （session-surface.ts:335-337：assistant/message embeds its source stream and cannot
// carry sourceEventSeqs），而只留一条 tool/result 又没有调用，会成孤儿。
// 两个节点一起换成一条用户消息，正好满足"来源列表覆盖所有被遮节点"的硬要求。
import { userMessage } from './messages.js'

const TOOL_NAME = 'compress'
const QUEUE_LIMIT = 4 // 同一会话最多挂几次待折叠，超了丢最老的，内存不至于随会话增长

export const FOLD_NOTE_HEAD = '〔压缩调用记录已折叠〕'

// 每次同 callId 的调用开始前先作废旧的待折项。
// 因为 callId 的重复只保证「同一条助手消息内不重号」，跨消息可以复用；
// 若上一次成功登记了却没折成、这一次又失败了，旧记录会把失败折成「已经成功」。
export function forgetFold(queue, callId) {
  if (!callId) return
  queue.delete(String(callId))
}

// 这一次 compress 调用落在表层上的节点号。
// 工具执行的那一刻，宿主的 tool/result 还没追加，所以调用消息就是最后一个节点。
// 记下它，折叠时就不必假设"消息下标 = 节点下标"——会话里出现空节点（宿主会跳过渲染）
// 时两张表会错位，靠这个节点号仍能精确定位到那一对。
export function callNodeOf(session) {
  const nodes = session && session.surface ? session.surface.nodes : null
  if (!nodes || !nodes.length) return null
  return nodes[nodes.length - 1]
}

// 登记一次成功的压缩调用，等下一次 pre-step 来收。
export function rememberFold(queue, callId, lines, callSeq = null) {
  if (!callId || !Array.isArray(lines) || lines.length === 0) return
  const key = String(callId)
  // 同一个 callId 出现两次就无法判断该折哪一条（Map 会被后者覆盖，
  // 于是"成功后又有一次同 id 的失败调用"会被误折成成功）。整条放弃，宁可不折。
  if (queue.has(key)) {
    queue.delete(key)
    return
  }
  queue.set(key, { lines, callSeq, tries: 0 })
  while (queue.size > QUEUE_LIMIT) {
    const oldest = queue.keys().next().value
    queue.delete(oldest)
  }
}

function toolCallsOf(message) {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return []
  const out = []
  for (const block of message.content) {
    if (!block || block.type !== 'tool-call') continue
    const name = block.name || block.toolName
    const id = block.id || block.toolCallId
    if (name && id) out.push({ name: String(name), id: String(id) })
  }
  return out
}

function toolResultCallId(message) {
  if (!message || message.role !== 'tool') return null
  if (message.toolCallId) return String(message.toolCallId)
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!block) continue
      const id = block.toolCallId || block.id
      if (id) return String(id)
    }
  }
  return null
}

export function buildNote(lines) {
  return [
    FOLD_NOTE_HEAD + '你刚刚做过一次分层压缩，已经成功：',
    // 单行的是回执要点，加 `- ` 列表化；多行的是整张地图（块表要对齐），原样贴，别加前缀。
    ...lines.map((line) => (String(line).includes('\n') ? line : '- ' + line)),
    // 不要在这里提任何工具名（context_map 之类）：模型见到"用 X 能看到"就会顺手去调一次，
    // 而地图只给标题、不给摘要正文，那一趟纯属白花 token。
    // 摘要正文就是各层块本身，本来就在它的上下文里。
    '这次的工具调用与工具结果已经被折叠替换成本条消息；摘要正文就是各层的块本身，已经在你的上下文里。',
  ].join('\n')
}

// 在派生消息的末尾附近找「一条只有一个 compress 调用的助手消息 + 紧邻它对得上的返回」，
// 再把它换算回表层节点下标。
//
// 注意"并行调用"的准确含义：**同一条助手消息里有两个及以上工具调用**（模型一次发多个），
// 不是"一轮里调用了多次工具"。一轮里连调三次工具是三个步骤、三条助手消息，每条只有一个调用，
// 这种情况完全不影响折叠——我们只看 compress 自己那一条消息。
//
// 只往末尾看几对：正常情况下 compress 的返回就是最后一个节点（pre-step 紧接着就触发），
// 留一点余量是为了容忍宿主在中间插了别的东西。
const SCAN_PAIRS = 3

// 精确路径最多回看多少个节点。正常情况返回就在末尾一两格，留余量是容忍宿主在中间插东西。
const SCAN_NODES = 12

// 一张地图的标志（renderMap 的须知段）。只认这个，避免把别的长工具结果当回执去改。
const MAP_MARK = '压缩须知'
// 我们把"没能压缩：<原因>"作为失败回执的开头，靠它认出自己的失败返回。
const FAIL_MARK = '没能压缩：'

function messageAtNode(session, seq) {
  if (!session || typeof session.deriveEventMessage !== 'function') return null
  const log = session.log
  if (!Array.isArray(log)) return null
  const event = log[seq]
  if (!event || typeof event !== 'object') return null
  try {
    return session.deriveEventMessage(event) || null
  } catch {
    return null
  }
}

function textOfMessage(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('')
}

// 精确找"我们登记过的那次调用 + 它自己的返回"：
// 不看下标对齐、不假设一对相邻，只看 callId。同一条消息里带多个调用时返回 parallel。
function locateCall(session, queue) {
  if (!queue || typeof queue.get !== 'function' || queue.size === 0) return null
  const nodes = session.surface.nodes
  const from = Math.max(0, nodes.length - SCAN_NODES)
  for (let at = nodes.length - 1; at >= from; at -= 1) {
    const calls = toolCallsOf(messageAtNode(session, nodes[at]))
    if (!calls.length) continue
    const mine = calls.find((c) => c.name === TOOL_NAME && queue.get(c.id))
    if (!mine) continue
    // 并行时返回可能乱序到达，所以在"这条消息调用数 + 余量"的窗口里按 callId 找。
    const upto = Math.min(nodes.length - 1, at + calls.length + 2)
    for (let j = at + 1; j <= upto; j += 1) {
      if (toolResultCallId(messageAtNode(session, nodes[j])) !== mine.id) continue
      return { callId: mine.id, callAt: at, resultAt: j, parallel: calls.length > 1 }
    }
    return null
  }
  return null
}

// 只改一条 tool/result 的正文。宿主对 tool/result 的原子级替换要求：恰好一个节点、
// 原本就是 tool/result、且除 message.content 之外逐字段相同——所以在原始事件上改，不重造。
function replaceResultContent(session, at, text) {
  const nodes = session.surface.nodes
  const seq = nodes[at]
  const log = session.log
  const event = Array.isArray(log) ? log[seq] : null
  if (!event || event.type !== 'tool/result' || !event.data || typeof event.data !== 'object') return false
  const original = event.data
  const message = original.message
  if (!message || typeof message !== 'object') return false
  session.append(
    'tool/result',
    { ...original, message: { ...message, content: [{ type: 'text', text }] } },
    { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] },
  )
  return true
}

// 末尾这条返回里带着地图时，把地图折掉——但**不整段替换**。
// 两个场景：① compress 失败的回执（地图会随每次重试永久叠一张）；
// ② 成功但调用是并行的（整段替换会带走兄弟调用）。失败时错误原因必须留着。
export function shrinkReceipt(session, queue) {
  const nodes = session.surface.nodes
  if (!nodes.length) return { done: false, reason: 'no-nodes' }
  const at = nodes.length - 1
  const msg = messageAtNode(session, nodes[at])
  if (!msg || msg.role !== 'tool') return { done: false, reason: 'tail-not-result' }
  const text = textOfMessage(msg)
  if (!text.includes(MAP_MARK)) return { done: false, reason: 'no-map' }
  const callId = toolResultCallId(msg)

  if (text.startsWith(FAIL_MARK)) {
    const head = text.split('\n\n')[0]
    const ok = replaceResultContent(
      session,
      at,
      `${head}\n（地图已折叠：需要时重新取一次地图。错误原因保留在这一条里。）`,
    )
    return ok ? { done: true, kind: 'failed', callId } : { done: false, reason: 'replace-failed' }
  }

  if (callId && queue && typeof queue.get === 'function' && queue.get(callId)) {
    // 并行的成功回执：只折地图，**每个键的结果留着**（压了哪几层、省了多少，是接着压的依据）。
    // 地图从「上下文 …」那行开始（`map.js` 两个分支都以它开头，紧随其后是「下面是分层占用」
    // 与区表），所以从那里整段切掉，前面的每键结果原样留下。
    const all = text.split('\n')
    const start = all.findIndex((line) => line.startsWith('上下文 ') || line.startsWith('区域 ') || line.startsWith('下面是分层占用'))
    const kept = (start > 0 ? all.slice(0, start) : all).filter((line) => line.trim() !== '')
    const ok = replaceResultContent(
      session,
      at,
      [
        ...kept,
        '（地图已折叠：要接着压就重新调一次 context_map 拿新地图。）',
        '这次 compress 是和别的工具一起并行发的：以后请把它单独发成一条消息——并行时'
          + '摘要正文会以调用参数的形式一直留在上下文里（删不掉），白占一份钱。',
      ].join('\n'),
    )
    if (ok) queue.delete(callId)
    return ok ? { done: true, kind: 'parallel', callId } : { done: false, reason: 'replace-failed' }
  }
  return { done: false, reason: 'not-ours' }
}


// 返回 { pair } 或 { reason }。
// 消息下标只用来"认"是哪一次调用（callId 是唯一的），**不用它去推节点下标**：
// 宿主会跳过内容为空的 system/developer/assistant 消息（dsh-session 的 deriveMessages
// 里 `if (msg) this.derived.push(msg)`），只要出现一个空节点，两张表就整体错位。
// 节点下标优先用 rememberFold 时记下的 callSeq，没有记录且数量相等时才退回按下标。
export function inspectTail(session, queue) {
  // 先走精确路径：靠 session.log + deriveEventMessage 逐节点问"这个节点是哪条消息"，
  // 于是同一条助手消息里带了几个调用、返回的顺序有没有乱，都不影响定位。
  const precise = locateCall(session, queue)
  if (precise) {
    // 并行调用：同一条助手消息里还有别的调用。整段替换会把兄弟调用一起带走、
    // 让它们变成孤儿（宿主不清洗孤儿，之后每次请求都 400），所以这条路只折"返回"的正文。
    if (precise.parallel) return { reason: 'parallel-call', callId: precise.callId, resultAt: precise.resultAt }
    return { pair: { callId: precise.callId, callAt: precise.callAt, resultAt: precise.resultAt } }
  }
  const nodes = session.surface.nodes
  if (nodes.length < 2) return { reason: 'no-nodes' }
  const messages = session.deriveMessages()
  const n = messages.length
  if (n < 2) return { reason: 'no-messages' }
  let fallback = null
  for (let i = 0; i < SCAN_PAIRS; i += 1) {
    // 成对只可能是 (偶数位调用, 奇数位返回)——宿主一步一条消息，调用与返回永远相邻。
    const msgAt = n - 1 - 2 * i
    const callMsgAt = msgAt - 1
    if (callMsgAt < 0) break
    const calls = toolCallsOf(messages[callMsgAt])
    // 同一条消息里有多个调用就放弃：删掉它会把别的调用一起变成孤儿。
    if (calls.length !== 1) continue
    const only = calls[0]
    if (only.name !== TOOL_NAME) continue
    const result = messages[msgAt]
    if (toolResultCallId(result) !== only.id) continue
    // 结果可能是失败的：我们登记的是"成功过的那次调用"，若宿主或别的插件
    // （如 tools/post-execute block）把这条结果变成错误，短注里的"已经成功"就是假话。
    // 语义错不能靠信息量补，直接不折，原样留着。
    if (result && result.isError === true) return { reason: 'error-result', callId: only.id }
    const entry = queue && typeof queue.get === 'function' ? queue.get(only.id) : null
    let callAt = entry && entry.callSeq != null ? nodes.indexOf(entry.callSeq) : -1
    if (callAt < 0 && n === nodes.length) callAt = callMsgAt
    // 定位不到就不猜：宁可这一条不折，也不能错位替换别的节点。
    if (callAt < 0) return { reason: 'node-unknown', callId: only.id }
    const resultAt = callAt + 1
    if (resultAt >= nodes.length) return { reason: 'node-unknown', callId: only.id }
    const pair = { callId: only.id, callAt, resultAt }
    // 优先返回"我们确实登记过的那一对"：末尾可能是别的调用，
    // 那时不该拿它去比队列（否则永远匹配不上，看起来像折叠失败）。
    if (!queue || typeof queue.get !== 'function' || queue.get(only.id)) return { pair }
    if (!fallback) fallback = pair
  }
  if (fallback) return { pair: fallback }
  return { reason: 'no-tail-pair' }
}

// 带原因的版本：胶水层要靠它区分"没什么可折"和"折不掉"，后者必须被看见。
export function foldCallRecordEx(session, queue, config) {
  if (!config || config.foldCallRecord === false) return { note: null, reason: 'disabled' }
  if (!queue || queue.size === 0) return { note: null, reason: 'empty' }
  const found = inspectTail(session, queue)
  if (!found.pair) return { note: null, reason: found.reason, callId: found.callId }
  const pending = queue.get(found.pair.callId)
  if (!pending) return { note: null, reason: 'no-entry', callId: found.pair.callId }
  const nodes = session.surface.nodes
  const note = buildNote(pending.lines)
  session.append(
    'user/message',
    userMessage({ content: [{ type: 'text', text: note }], source: { kind: 'user' } }),
    {
      surfaceOp: { op: 'replace', startSeq: nodes[found.pair.callAt], endSeq: nodes[found.pair.resultAt] },
      sourceEventSeqs: [nodes[found.pair.callAt], nodes[found.pair.resultAt]],
    },
  )
  queue.delete(found.pair.callId)
  return { note, reason: null }
}

export function foldCallRecord(session, queue, config) {
  return foldCallRecordEx(session, queue, config).note
}
