// 占用读数：宿主不同版本提供的接口不一样，这里把三条来源都钉住。
// 背景：contextPressure 投影在 0.2.1-rc.3 与 0.2.2-alpha.2 里都只有
// pressureTokens / projectedTokens / contextWindow（.strict()），
// 早期按 surfaceTokens + sampledSurfaceTokens 算出来的读数恒为 null，
// 提醒与区指示灯在真机上永远不亮——本文件防的就是这类"字段名写错但测试全绿"。
// 跑法：node plugin/test/usage.test.mjs
import assert from 'node:assert/strict'
import { readUsage } from '../index.js'
import { DEFAULTS } from '../lib/config.js'

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

const config = { ...DEFAULTS, reservedTokens: 0 }

function fakeSession(extra = {}) {
  return {
    seq: 10,
    requestHeader: () => ({ config: { maxTokens: 1000 } }),
    ...extra,
  }
}

await check('0.2.2 形状：measure().totalTokens 当已用，contextPressure().contextWindow 当窗口', () => {
  const ctx = {
    tokenMeter: {
      contextPressure: () => ({ pressureTokens: 1, contextWindow: 200000 }),
      measure: () => ({ totalTokens: 150000, surfaceTokens: 40000 }),
    },
  }
  const u = readUsage(ctx, fakeSession(), config)
  assert.ok(u, '应当读出占用')
  assert.equal(u.used, 150000)
  assert.equal(u.window, 200000)
  assert.equal(u.budget, 199000)
  assert.ok(Math.abs(u.ratio - 150000 / 199000) < 1e-9)
})

await check('0.2.1 形状：没有 contextPressure()，窗口退回 session.requestContext()', () => {
  const ctx = { tokenMeter: { measure: () => ({ totalTokens: 20000, surfaceTokens: 5000 }) } }
  const session = fakeSession({ requestContext: () => ({ contextWindow: 100000 }) })
  const u = readUsage(ctx, session, config)
  assert.ok(u)
  assert.equal(u.used, 20000)
  assert.equal(u.window, 100000)
  assert.equal(u.budget, 99000)
})

await check('只有投影可用时用 projectedTokens（不是已消失的 surfaceTokens）', () => {
  const ctx = {
    sessionProjections: {
      stateOf: () => ({ pressureTokens: 800, projectedTokens: 1234, contextWindow: 10000 }),
    },
  }
  const session = fakeSession({ requestHeader: () => ({ config: { maxTokens: 500 } }) })
  const u = readUsage(ctx, session, config)
  assert.ok(u)
  assert.equal(u.used, 1234)
  assert.equal(u.window, 10000)
  assert.equal(u.budget, 9500)
})

await check('投影只有 pressureTokens 时退回它', () => {
  const ctx = { sessionProjections: { stateOf: () => ({ pressureTokens: 777, contextWindow: 1000 }) } }
  const session = fakeSession({ requestHeader: () => ({ config: { maxTokens: 100 } }) })
  const u = readUsage(ctx, session, config)
  assert.equal(u.used, 777)
  assert.equal(u.window, 1000)
})

await check('measure 抛错时退回投影，不抛给调用方', () => {
  const ctx = {
    tokenMeter: { measure: () => { throw new Error('boom') } },
    sessionProjections: { stateOf: () => ({ projectedTokens: 321, contextWindow: 2000 }) },
  }
  const session = fakeSession({ requestHeader: () => ({ config: { maxTokens: 100 } }) })
  const u = readUsage(ctx, session, config)
  assert.equal(u.used, 321)
  assert.equal(u.window, 2000)
})

await check('什么都拿不到时返回 null（提醒据此静默，不炸会话）', () => {
  assert.equal(readUsage({}, fakeSession(), config), null)
  assert.equal(readUsage({ sessionProjections: { stateOf: () => undefined } }, fakeSession(), config), null)
  assert.equal(readUsage({}, { seq: 1 }, config), null)
})

await check('按会话 + 日志序号缓存：同一轮里多次读只测一次，序号前进才重测', () => {
  let calls = 0
  const ctx = {
    tokenMeter: {
      contextPressure: () => ({ contextWindow: 10000 }),
      measure: () => { calls += 1; return { totalTokens: 100 * calls } },
    },
  }
  const session = fakeSession()
  const a = readUsage(ctx, session, config)
  const b = readUsage(ctx, session, config)
  assert.equal(calls, 1, '同一序号只测一次')
  assert.equal(a, b, '应当复用同一个结果对象')
  session.seq = 11
  const c = readUsage(ctx, session, config)
  assert.equal(calls, 2, '日志前进后重测')
  assert.equal(c.used, 200)
})

await check('可用输入预算有 10% 下限：输出预留再大，分母也不塌成 0', () => {
  const ctx = {
    tokenMeter: { measure: () => ({ totalTokens: 900 }) },
  }
  const session = fakeSession({ requestContext: () => ({ contextWindow: 1000 }), requestHeader: () => ({ config: { maxTokens: 990 } }) })
  const u = readUsage(ctx, session, config)
  assert.equal(u.budget, 100)
  assert.equal(u.ratio, 9)
})

console.log(`\n${passed} 项全部通过（usage）`)
