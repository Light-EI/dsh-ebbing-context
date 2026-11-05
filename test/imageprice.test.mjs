// 图片计价：宿主按路由声明的真实价，拿不到就退回固定 800（设计约束）。
// 跑法：node plugin/test/imageprice.test.mjs
import assert from 'node:assert'
import { imagePrices } from '../lib/imageprice.js'

let failed = 0
let total = 0
const check = (name, fn) => {
  total++
  try {
    fn()
  } catch (error) {
    failed++
    console.error(`FAIL ${name} :: ${error && error.message}`)
  }
}

const images = [{ type: 'image', mediaType: 'image/png' }, { type: 'image', mediaType: 'image/jpeg' }]

check('宿主真实形状 {visualTokens, text}：按 visualTokens 取价', () => {
  const ctx = {
    get: (name) => (name === 'llm'
      ? { imageRequestPricing: () => ({ priceImages: (list) => list.map((_, i) => ({ visualTokens: 1000 + i, text: '' })) }) }
      : null),
  }
  assert.deepEqual(imagePrices(ctx, { provider: 'p', model: 'm' }, images), [1000, 1001])
})

check('数字形状也认（旧版/第三方路由），两种形状可以混着来', () => {
  const ctx = {
    get: () => ({ imageRequestPricing: () => ({ priceImages: () => [{ visualTokens: 1200, text: '' }, 900] }) }),
  }
  assert.deepEqual(imagePrices(ctx, { provider: 'p', model: 'mix' }, images), [1200, 900])
})

check('宿主把图投影成文本时，文本那部分也计入', () => {
  const ctx = {
    get: () => ({ imageRequestPricing: () => ({ priceImages: () => [{ visualTokens: 1200, text: '中文字' }] }) }),
  }
  assert.deepEqual(imagePrices(ctx, { provider: 'p', model: 'txt' }, images.slice(0, 1)), [1203])
})

check('价对象缺字段/为 null 时退回 800', () => {
  const ctx = {
    get: () => ({ imageRequestPricing: () => ({ priceImages: () => [{}, null] }) }),
  }
  assert.deepEqual(imagePrices(ctx, { provider: 'p', model: 'bad' }, images), [800, 800])
})

check('没有 llm 服务时返回 null（调用方退回固定价）', () => {
  const ctx = { get: () => null }
  assert.equal(imagePrices(ctx, { provider: 'p', model: 'm' }, images), null)
})

check('模型没声明图片价（返回 undefined）时也返回 null', () => {
  const ctx = { get: () => ({ imageRequestPricing: () => undefined }) }
  assert.equal(imagePrices(ctx, { provider: 'p', model: 'm' }, images), null)
})

check('张数对不上时返回 null，不抛错', () => {
  const ctx = {
    get: () => ({ imageRequestPricing: () => ({ priceImages: () => [123] }) }),
  }
  assert.equal(imagePrices(ctx, { provider: 'p', model: 'm2' }, images), null)
})

check('priceImages 抛错时被吞掉、返回 null', () => {
  const ctx = {
    get: () => ({ imageRequestPricing: () => ({ priceImages: () => { throw new Error('boom') } }) }),
  }
  assert.equal(imagePrices(ctx, { provider: 'p', model: 'm3' }, images), null)
})

check('imageRequestPricing 自己抛错时也返回 null', () => {
  const ctx = { get: () => ({ imageRequestPricing: () => { throw new Error('route down') } }) }
  assert.equal(imagePrices(ctx, { provider: 'p', model: 'm4' }, images), null)
})

check('非法价（0、负数、NaN）退回 800', () => {
  const ctx = {
    get: () => ({ imageRequestPricing: () => ({ priceImages: () => [0, Number.NaN] }) }),
  }
  assert.deepEqual(imagePrices(ctx, { provider: 'p', model: 'm5' }, images), [800, 800])
})

check('按 (provider, model) 缓存：同一路由只问一次', () => {
  let calls = 0
  const ctx = {
    get: () => ({
      imageRequestPricing: () => {
        calls += 1
        return { priceImages: (list) => list.map(() => 500) }
      },
    }),
  }
  imagePrices(ctx, { provider: 'p', model: 'cache' }, images)
  imagePrices(ctx, { provider: 'p', model: 'cache' }, images)
  assert.equal(calls, 1)
})

check('换模型会重新取一次价（缓存按路由分开）', () => {
  let calls = 0
  const ctx = {
    get: () => ({
      imageRequestPricing: () => {
        calls += 1
        return { priceImages: (list) => list.map(() => 500) }
      },
    }),
  }
  imagePrices(ctx, { provider: 'p', model: 'a' }, images)
  imagePrices(ctx, { provider: 'p', model: 'b' }, images)
  assert.equal(calls, 2)
})

check('空图片列表直接返回空数组（不问宿主）', () => {
  let calls = 0
  const ctx = { get: () => ({ imageRequestPricing: () => { calls += 1; return { priceImages: () => [] } } }) }
  assert.deepEqual(imagePrices(ctx, { provider: 'p', model: 'm' }, []), [])
  assert.equal(calls, 0)
})

// 假宿主/探针可能传 null、数字、字符串当 ctx：WeakMap 的键必须是对象，
// 否则 set 处直接抛「Invalid value used as weak map key」，比"退回 800"严重得多。
for (const bad of [null, 0, '', true, undefined]) {
  check(`ctx 不是对象（${String(bad)}）时不抛、退回 null`, () => {
    assert.equal(imagePrices(bad, { provider: 'p', model: 'm' }, images), null)
  })
}

if (failed) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
check('暂时拿不到价不缓存：llm 稍后就绪时仍能拿到真实价（全代码逻辑审核 7）', () => {
  let ready = false
  const ctx = {
    get: (name) => (name === 'llm'
      ? (ready
          ? { imageRequestPricing: () => ({ priceImages: (list) => list.map(() => 1234) }) }
          : { imageRequestPricing: () => undefined })
      : null),
  }
  assert.equal(imagePrices(ctx, { provider: 'p', model: 'late' }, images), null)
  ready = true
  assert.deepEqual(imagePrices(ctx, { provider: 'p', model: 'late' }, images), [1234, 1234])
})

console.log(`imageprice 断言测试全部通过（${total} 项）`)
