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
    return '还没看过地图：先调一次 context_map，压缩用的位置和序号都从那张地图里抄。'
  }
  const s = session.surface
  const gen = s.replaceGeneration ?? 0
  if (rec.gen !== gen) {
    return '这张地图已经过期了（表层在这之后被改过），重新调一次 context_map，再照新地图压。'
  }
  return null
}

export function consume(agentId) {
  seen.delete(agentId)
}

export function forget(agentId) {
  seen.delete(agentId)
}
