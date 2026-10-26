/**
 * dsh-session-hub —— 宿主半桥接单测（src/hub-host.js）
 *
 * 三个关注点：任务栏状态去重、`raiseWindow` 开关、以及「宿主半在线状态」的四态判定与退避。
 * 探活的措辞是排障的入口（用户拿日志来问「为什么通知没弹」时全靠它），所以这里连文案一起断言。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHostBridge, HOST_HALF_RECHECK_MS } from '../src/hub-host.js'

/**
 * 造一个桥接器与请求记录器。
 * @param {object} [options] 覆盖项。
 * @returns {{ bridge: object, fetches: Array<object>, control: object }} 夹具。
 */
function harness(options = {}) {
  const fetches = []
  const control = {
    now: 1_000,
    desktop: options.desktop ?? true,
    disposed: false,
    config: { raiseWindow: true },
    onFetch: options.onFetch ?? (() => ({ ok: true, status: 200, json: () => Promise.resolve({ host: 'dsh-session-hub', version: '0.1.0', projectionKey: 'hubTurnOutcome' }) })),
  }
  const bridge = createHostBridge({
    pluginId: 'dsh-session-hub',
    version: '0.1.0',
    getConfig: () => control.config,
    isDesktopShell: () => control.desktop,
    isDisposed: () => control.disposed,
    fetchImpl: (url, init) => {
      fetches.push({ url, init })
      return Promise.resolve(control.onFetch(url, init))
    },
    now: () => control.now,
  })
  return { bridge, fetches, control }
}

/**
 * 临时接管一个 console 方法。
 * @param {'info'|'warn'} name 方法名。
 * @param {(line: string) => void} sink 收集器。
 * @returns {() => void} 还原函数。
 */
function captureConsole(name, sink) {
  const original = console[name]
  console[name] = (...args) => sink(args.join(' '))
  return () => { console[name] = original }
}

test('任务栏状态：非桌面端不发请求', () => {
  const { bridge, fetches } = harness({ desktop: false })
  bridge.pushTaskbar('red')
  assert.equal(fetches.length, 0)
})

test('任务栏状态：同状态去重，变化才发，force 绕过', () => {
  const { bridge, fetches } = harness()
  bridge.pushTaskbar('red')
  bridge.pushTaskbar('red')
  assert.equal(fetches.length, 1)
  assert.equal(fetches[0].url, 'dsh-session-hub/taskbar')
  assert.equal(fetches[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(fetches[0].init.body), { state: 'red' })
  assert.equal(fetches[0].init.headers['content-type'], 'application/json')

  bridge.pushTaskbar('yellow')
  assert.equal(fetches.length, 2)

  bridge.pushTaskbar('yellow', true)
  assert.equal(fetches.length, 3, 'force 应当忽略去重')
})

test('任务栏状态：卸载后普通请求不再发，但 force 仍可清灯', () => {
  const { bridge, fetches, control } = harness()
  bridge.pushTaskbar('green')
  control.disposed = true
  bridge.pushTaskbar('red')
  assert.equal(fetches.length, 1, '卸载后不应再改任务栏')
  bridge.pushTaskbar('none', true)
  assert.equal(fetches.length, 2)
  assert.deepEqual(JSON.parse(fetches[1].init.body), { state: 'none' })
})

test('raiseWindow 关闭时不再请求前置窗口，但预热照发', () => {
  const { bridge, fetches, control } = harness()
  control.config = { raiseWindow: false }
  bridge.callHostRoute('raise')
  assert.equal(fetches.length, 0)
  bridge.callHostRoute('warmup')
  assert.equal(fetches.length, 1)
  assert.equal(fetches[0].url, 'dsh-session-hub/warmup')
})

test('探活：host 字段对得上即在线，并打印版本', async () => {
  const infos = []
  const restore = captureConsole('info', (line) => infos.push(line))
  const { bridge } = harness()
  try {
    bridge.checkHostHalf(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(bridge.hostHalfState(), 'present')
    assert.equal(infos.length, 1)
    assert.match(infos[0], /客户端半 v0\.1\.0 ↔ 宿主半 v0\.1\.0 在线/)
  } finally {
    restore()
  }
})

test('探活：版本不一致时明确说出错位', async () => {
  const infos = []
  const restore = captureConsole('info', (line) => infos.push(line))
  const { bridge } = harness({
    onFetch: () => ({ ok: true, status: 200, json: () => Promise.resolve({ host: 'dsh-session-hub', version: '9.9.9', projectionKey: 'hubTurnOutcome' }) }),
  })
  try {
    bridge.checkHostHalf(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.match(infos[0], /版本不一致：宿主半 v9\.9\.9/)
  } finally {
    restore()
  }
})

test('探活：路由家族回 404 JSON 说明宿主半是旧构建，仍算在线且不告警', async () => {
  const infos = []
  const warnings = []
  const restoreInfo = captureConsole('info', (line) => infos.push(line))
  const restoreWarn = captureConsole('warn', (line) => warnings.push(line))
  const { bridge } = harness({
    onFetch: () => ({ ok: false, status: 404, json: () => Promise.resolve({ error: 'unknown-action' }) }),
  })
  try {
    bridge.checkHostHalf(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(bridge.hostHalfState(), 'present')
    assert.match(infos[0], /宿主半在线但为旧构建/)
    assert.equal(warnings.length, 0)
  } finally {
    restoreInfo()
    restoreWarn()
  }
})

test('探活：路由真的不存在时判 absent，并说清降级后果', async () => {
  const warnings = []
  const restore = captureConsole('warn', (line) => warnings.push(line))
  const { bridge } = harness({ onFetch: () => ({ ok: false, status: 404, json: () => Promise.resolve(null) }) })
  try {
    bridge.checkHostHalf(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(bridge.hostHalfState(), 'absent')
    assert.match(warnings[0], /宿主半的路由不存在/)
  } finally {
    restore()
  }
})

test('探活：请求本身失败时说「无法确认」，不是「确认不在」', async () => {
  const warnings = []
  const restore = captureConsole('warn', (line) => warnings.push(line))
  const { bridge } = harness({ onFetch: () => { throw new Error('network down') } })
  try {
    bridge.checkHostHalf(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(bridge.hostHalfState(), 'unknown')
    assert.match(warnings[0], /无法确认其状态/)
  } finally {
    restore()
  }
})

test('探活退避：5 分钟内不重复请求，force 可绕过', () => {
  // 用「请求直接抛错」把状态留在 unknown——这是唯一会反复重试的状态（present 之后不再问，
  // 见下一条用例），正好用来验证退避窗口。
  const { bridge, fetches, control } = harness({ onFetch: () => { throw new Error('boom') } })
  bridge.checkHostHalf(true)
  assert.equal(fetches.length, 1)
  assert.equal(bridge.hostHalfState(), 'unknown')
  control.now += HOST_HALF_RECHECK_MS - 1
  bridge.checkHostHalf()
  assert.equal(fetches.length, 1, '退避窗口内不应再次请求')
  control.now += 2
  bridge.checkHostHalf()
  assert.equal(fetches.length, 2, '窗口过后允许重试')

  bridge.resetHostHalfCheck()
  bridge.checkHostHalf()
  assert.equal(fetches.length, 3, 'reset 后立即允许重问')
})

test('探活：一旦确认在线就不再重复请求（哪怕已过退避窗口）', async () => {
  const { bridge, fetches, control } = harness()
  bridge.checkHostHalf(true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(bridge.hostHalfState(), 'present')
  control.now += HOST_HALF_RECHECK_MS * 3
  bridge.checkHostHalf()
  assert.equal(fetches.length, 1)
})
