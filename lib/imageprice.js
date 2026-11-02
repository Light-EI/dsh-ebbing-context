// 图片计价（设计约束）：宿主按路由声明的图片价是唯一与账单同源的口径，
// 拿不到就退回固定 800——宁可粗，也不能让计价问题冒到压缩流程里。
//
// 宿主口径（`ref/pkg-0.2.2-alpha.2/tok/lib/types/route-pricing.js:28-30`）：
//   const pricing = llm.imageRequestPricing(provider, model)
//   const prices = pricing.priceImages(images)   // 每张图（按出现顺序）一个 token 数
// 张数对不上会抛错。我们全部包在 try/catch 里，任何异常都返回 null（调用方退回 800）。
//
// 缓存：按 (provider, model) 缓存 pricing 对象。频繁切模型时最坏情况只是多个键、
// 每次都退回固定价，不会报错、不会中断压缩。
import { IMAGE_TOKENS, estimateTokens } from './tokens.js'

// 宿主 `priceImages()` 返回的元素**不是数字**，而是 `{ visualTokens, text }`：
// 宿主自己的账是 `tokens += price.visualTokens + estimateContent([{type:'text',text:price.text}])`
// （`ref/pkg-0.2.2-alpha.2/tok/lib/index.js:754-757`）。只认数字的话每张图都会落回 800，
// 于是"用真实价"这层壳在真机上等于没装（回归修复）。
// 两种形状都认：数字（旧版/第三方路由）与对象（当前宿主）。
function normalizePrice(price) {
  if (typeof price === 'number' && Number.isFinite(price) && price > 0) return price
  if (price && typeof price === 'object') {
    const visual = typeof price.visualTokens === 'number' && Number.isFinite(price.visualTokens) ? price.visualTokens : null
    const text = typeof price.text === 'string' && price.text.length ? estimateTokens(price.text) : 0
    if (visual !== null && visual >= 0) return Math.max(1, Math.round(visual) + text)
  }
  return IMAGE_TOKENS
}

const seen = new WeakMap() // ctx -> Map<key, pricing|null>

function cacheFor(ctx) {
  // WeakMap 的键必须是对象：宿主恒传对象，但假宿主/探针可能传 null、数字、字符串，
  // 那会在 set 处抛「Invalid value used as weak map key」。拿不到可用的键就不缓存。
  if (!ctx || (typeof ctx !== 'object' && typeof ctx !== 'function')) return null
  let byKey = seen.get(ctx)
  if (!byKey) {
    byKey = new Map()
    seen.set(ctx, byKey)
  }
  return byKey
}

function pricingOf(ctx, route) {
  const provider = (route && route.provider) || ''
  const model = (route && route.model) || ''
  const key = provider + '\u0000' + model
  const byKey = cacheFor(ctx)
  if (!byKey) return null
  if (byKey.has(key)) return byKey.get(key)
  let value = null
  // 只缓存"确定没有图片价"这个结论。llm 服务还没装配、imageRequestPricing 抛错这类
  // 都是暂时状态（宿主晚装配、适配器刚注册），把它们钉死在缓存里会整个进程都退回 800，
  // 用户切模型时还会再踩一次（回归修复）。暂时性失败不写缓存，下次调用重试。
  let cacheable = false
  try {
    const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : null
    if (llm && typeof llm.imageRequestPricing === 'function') {
      const got = llm.imageRequestPricing(provider, model)
      if (got && typeof got.priceImages === 'function') value = got
      // 方法存在、明确没给价（undefined / 缺 priceImages）：这条路由就是不供应图片价，
      // 属于确定性结论，可以缓存。
      cacheable = true
    }
  } catch {
    value = null
    cacheable = false
  }
  if (cacheable) byKey.set(key, value)
  return value
}

/**
 * 给一批图片出现位置定价。返回 null 表示"拿不到按路由的真实价，请退回固定价"。
 * @param {any} ctx 插件上下文（只用于 ctx.get('llm')）
 * @param {any} route 当前路由（agent.options 里的 provider/model）
 * @param {any[]} images 按出现顺序排列的图片块
 * @param {(event: string, data?: any) => void} [log]
 * @returns {number[]|null}
 */
export function imagePrices(ctx, route, images, log) {
  if (!Array.isArray(images) || images.length === 0) return []
  const pricing = pricingOf(ctx, route)
  if (!pricing) return null
  try {
    const prices = pricing.priceImages(images)
    if (!Array.isArray(prices) || prices.length !== images.length) {
      if (log) log('image-pricing-mismatch', { want: images.length, got: Array.isArray(prices) ? prices.length : -1 })
      return null
    }
    return prices.map(normalizePrice)
  } catch (error) {
    if (log) log('image-pricing-failed', { error: String((error && error.message) || error) })
    return null
  }
}
