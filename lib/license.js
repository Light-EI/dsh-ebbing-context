// 压缩许可证：地图是一次"看地形"的凭证，看一次只能用一次。
// 为什么需要它：模型只能按"区内序号"点名，序号是它看地图那一刻的。
// 如果中间表层被替换过（上一次压缩、或者别的插件），同一个序号可能指到隔壁的块。
// 所以：取地图发证，压缩成功收证；想再压必须重新看一遍地图。
//
// 判据不用宿主的 `replaceGeneration`（审计一般项 2）：那个计数会被**任何**替换 +1，
// 包括宿主自己把提示词重写一遍、图片离线化、我们自己的折叠短注——
// 它们一个都没动块的位置，却会把刚发出去的地图打废，于是每次压完想再压一层都被假报过期。
// 现在改成对"地图里真正出现的东西"取指纹：三层的块 seq 表 + 表头节点。
// 只要这些没变，地图里写的序号就仍然指同一个块；变了就一定是真的过期。
const seen = new Map()

function fingerprint(zones) {
  if (!zones || !zones.zones) return null
  const seqs = (list) => (Array.isArray(list) ? list : []).map((b) => (b && b.seq !== undefined && b.seq !== null ? String(b.seq) : '')).join(',')
  // 只算三层块的 seq 表，**不含表头节点 0**（复核三）：节点 0 不在任何地图里展示，
  // 而宿主重写提示词（渲染文本变化）会把它换成新 seq——带上它就会出现"块一个没动、
  // 却报这张地图过期"的假报警。地图给模型看的正是这三层，指纹就只盯这三层。
  return [
    seqs(zones.zones.l3),
    seqs(zones.zones.l2),
    seqs(zones.zones.l1),
  ].join('|')
}


export function issue(agentId, session, zones) {
  seen.set(agentId, { fp: fingerprint(zones) })
}

export function check(agentId, session, zones) {
  const rec = seen.get(agentId)
  if (!rec) {
    return '还没看过地图：这条提醒或上一次工具结果里附的地图就能用；手边没有时再调一次 context_map。'
  }
  // 拿不到指纹（调用方没给 zones）时不拦：宁可按"没过期"放行，也不要凭空造一次拒绝。
  // 真正的保护仍在 compress 里——它按实时表层重新算区间，区间对不上就整批拒绝。
  if (rec.fp === null || !zones) return null
  if (fingerprint(zones) !== rec.fp) {
    return '这张地图已经过期了（这几层区里的块在这之后变过）——用最近一次结果里附的新地图，照它再压。'
  }
  return null
}

export function consume(agentId) {
  seen.delete(agentId)
}



export function forget(agentId) {
  seen.delete(agentId)
}
