// 压缩许可证：地图是一次"看地形"的凭证，看一次只能用一次。
// 为什么需要它：模型只能按"区内序号"点名，序号是它看地图那一刻的。
// 如果中间表层被替换过（上一次压缩、或者别的插件），同一个序号可能指到隔壁的块。
// 所以：取地图发证，压缩成功收证；想再压必须重新看一遍地图。
const seen = new Map()

export function issue(agentId, session) {
  const s = session.surface
  seen.set(agentId, { gen: s.replaceGeneration ?? 0, count: s.nodes.length })
}

export function check(agentId, session) {
  const rec = seen.get(agentId)
  if (!rec) {
    return '还没看过地图：这条提醒或上一次工具结果里附的地图就能用；手边没有时再调一次 context_map。'
  }
  const s = session.surface
  const gen = s.replaceGeneration ?? 0
  if (rec.gen !== gen) {
    return '这张地图已经过期了（表层在这之后被改过）——用最近一次结果里附的新地图，照它再压。'
  }
  return null
}

export function consume(agentId) {
  seen.delete(agentId)
}

// 折叠是我们自己做的一次表层替换，它不该让刚发出去的地图作废：
// 折叠只把尾部「调用 + 返回」两条换成一条短注，区序号、块顺序、轮号都没有变。
// 不重新对齐代数的话，就会出现"压完一层 → 我们折掉调用记录 → 紧接着想再压一层被拒"的假过期，
// 每连续压两次白烧一个来回，还会把模型引去重看地图。
export function restate(agentId, session) {
  const rec = seen.get(agentId)
  if (!rec) return
  const s = session.surface
  rec.gen = s.replaceGeneration ?? 0
  rec.count = s.nodes.length
}

export function forget(agentId) {
  seen.delete(agentId)
}
