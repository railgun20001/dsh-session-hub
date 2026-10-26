/**
 * 客户端半的端到端测试（在 Node 里跑真实的 lib/client.js 产物）。
 *
 * 运行：node build/bundle.mjs && node --test test/client-half-test.mjs
 *
 * 做法：把浏览器环境用最小的桩搭起来——window.__ModuleLoader__、document、
 * localStorage、Notification——然后加载**真实产物** lib/client.js，拿到它注册的
 * 工厂并物化成 Cordis 插件，用假的会话服务驱动它。断言的是外部可见行为：
 *   1. 什么时候真的弹了通知（以及弹了几条）；
 *   2. 通知的标题/正文/选项；
 *   3. 点通知有没有跳回对应会话；
 *   4. 水位是否落盘、多标签页是否只弹一次；
 *   5. 卸载后是否彻底安静。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '..', 'lib', 'client.js')

/** 构造一次干净的浏览器环境与一份可驱动的插件实例。 */
async function createHarness(boot = {}) {
  const state = {
    notifications: [],
    openedSessions: [],
    focusCalls: 0,
    dispatched: [],
    fetches: [],
    storage: new Map(),
    listeners: new Map(),
    registration: null,
    /** 非空时让下一条通知模拟「系统侧拒绝」，派发 `failed` 事件。 */
    failWith: null,
    /** 侧栏行桩：每项形如 `{ dataset: { rowKey }, calls, scrollIntoView }`。 */
    rows: [],
  }

  class FakeNotification {
    static permission = 'granted'
    static requestPermission() {
      return Promise.resolve('granted')
    }
    constructor(title, options) {
      this.title = title
      this.options = options ?? {}
      this.closed = false
      this.listeners = new Map()
      state.notifications.push(this)
      // 真实 Chromium 是异步派发事件：构造返回后才回调，这里用微任务对齐，
      // 保证「构造后立刻挂回调」的写法在测试里也能收到。
      // `state.failWith` 非空时模拟系统侧拒绝（派发 `failed` 而不是 `show`）。
      queueMicrotask(() => {
        if (state.failWith) {
          this.dispatch('failed', { error: { message: state.failWith } })
          return
        }
        this.dispatch('show')
      })
    }
    /**
     * 订阅事件：与真实 Electron 通知对象一致（EventTarget 风格）。
     * @param {string} type 事件名。
     * @param {(event?: object) => void} handler 处理函数。
     */
    addEventListener(type, handler) {
      const list = this.listeners.get(type) ?? []
      list.push(handler)
      this.listeners.set(type, list)
    }
    /**
     * 派发事件：属性回调与订阅回调都要触发，模拟两种实现都会收到同一个事件。
     * @param {string} type 事件名。
     * @param {object} [event] 事件对象。
     */
    dispatch(type, event) {
      const handlers = [this[`on${type}`], ...(this.listeners.get(type) ?? [])]
      for (const handler of handlers) {
        try {
          handler?.(event)
        } catch {
          /* 桩不关心回调里的异常 */
        }
      }
    }
    close() {
      this.closed = true
    }
  }

  const win = {
    __ModuleLoader__: { load: (registration) => { state.registration = registration } },
    addEventListener: (type, fn) => {
      const list = state.listeners.get(type) ?? []
      list.push(fn)
      state.listeners.set(type, list)
    },
    removeEventListener: (type, fn) => {
      const list = state.listeners.get(type) ?? []
      state.listeners.set(type, list.filter((item) => item !== fn))
    },
    dispatchEvent: (event) => {
      state.dispatched.push(event)
      return true
    },
    focus: () => { state.focusCalls += 1 },
  }

  const doc = {
    visibilityState: 'visible',
    hasFocus: () => true,
    // 侧栏行查找走 `[data-row-key]` 粗筛；行桩由测试通过 state.rows 提供。
    querySelectorAll: (selector) => (selector === '[data-row-key]' ? state.rows : []),
  }

  const localStorageStub = {
    getItem: (key) => (state.storage.has(key) ? state.storage.get(key) : null),
    setItem: (key, value) => { state.storage.set(key, String(value)) },
    removeItem: (key) => { state.storage.delete(key) },
    clear: () => { state.storage.clear() },
  }

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Notification: globalThis.Notification,
    localStorage: globalThis.localStorage,
    fetch: globalThis.fetch,
    location: globalThis.location,
  }
  globalThis.window = win
  globalThis.document = doc
  globalThis.Notification = FakeNotification
  globalThis.localStorage = localStorageStub
  // `location` 只用来判定「是不是桌面外壳」（`dsh-app:` 协议）。任务栏状态点只在桌面端
  // 上报，所以需要它的用例必须显式打开 `desktop`；其余用例保持普通浏览器语义。
  globalThis.location = boot.desktop === true ? { protocol: 'dsh-app:' } : undefined
  // 宿主路由调用全部记下来：测试断言「点了通知有没有请求宿主半前置窗口」，
  // 以及「读不到投影值时会去 ping 宿主半」。
  globalThis.fetch = (url, options) => {
    state.fetches.push({ url, options })
    if (typeof boot.onFetch === 'function') return boot.onFetch(url, options, state)
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ host: 'dsh-session-hub', projectionKey: 'hubTurnOutcome' }) })
  }

  // 每个 harness 用不同的 URL 查询串，避免 ESM 模块缓存复用同一个 bundle 实例。
  const url = `${pathToFileURL(BUNDLE).href}?harness=${Math.random().toString(36).slice(2)}`
  readFileSync(BUNDLE, 'utf8') // 确保产物存在（缺失时给出清晰报错）
  await import(url)

  assert.ok(state.registration !== null, 'bundle 应当注册进 window.__ModuleLoader__')
  const exports = state.registration.factory(() => {
    throw new Error('本插件不请求外部模块')
  })
  assert.equal(typeof exports.apply, 'function')
  assert.ok(Array.isArray(exports.inject))

  // ---- 假的 DSH 客户端服务 ----
  const sessions = boot.sessions ?? []
  const projections = boot.projections ?? {}
  const statuses = boot.statuses ?? {}
  /**
   * 是否模拟「宿主半缺失」：真实的宿主半一旦注册，`values` 里就一定带
   * hubTurnOutcome 这个键（哪怕值是 null）；缺失即代表宿主半没加载。
   */
  const hostHalfMissing = boot.hostHalfMissing === true

  /** 造一个会话的投影块，形状与客户端投影存储一致。 */
  const projectionBlock = (id) => {
    if (hostHalfMissing) return { values: {} }
    return { values: { hubTurnOutcome: projections[id] ?? null } }
  }

  const listState = {
    ids: sessions.map((row) => row.id),
    byId: Object.fromEntries(sessions.map((row) => [row.id, row])),
    projectionsBySession: Object.fromEntries(sessions.map((row) => [row.id, projectionBlock(row.id)])),
    phase: 'ready',
  }

  const makeStore = (initial) => {
    let value = initial
    const subscribers = new Set()
    return {
      getSnapshot: () => value,
      subscribe: (fn) => {
        subscribers.add(fn)
        return () => { subscribers.delete(fn) }
      },
      /** 测试用：替换快照并通知订阅者。 */
      publish: (next) => {
        value = next
        for (const fn of [...subscribers]) fn()
      },
    }
  }

  const listStore = makeStore(listState)
  const statusStore = makeStore(new Map(Object.entries(statuses)))
  const services = { sessions: { list: listStore }, uiSession: { sessionStatus: statusStore } }

  const effectDisposers = []
  const ctx = {
    get: (serviceName) => services[serviceName],
    effect: (callback, _label) => {
      const disposer = callback()
      effectDisposers.push(disposer)
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }

  exports.apply(ctx)

  return {
    exports,
    state,
    ctx,
    listStore,
    statusStore,
    /** 当前列表快照（深拷贝，便于改行）。 */
    list: () => JSON.parse(JSON.stringify(listState)),
    /** 更新投影值并推送。 */
    setProjection: (id, value) => {
      listState.projectionsBySession[id] = { values: { hubTurnOutcome: value } }
      listStore.publish({ ...listState, projectionsBySession: { ...listState.projectionsBySession } })
    },
    setStatus: (id, status) => {
      const next = new Map(statusStore.getSnapshot())
      if (status === undefined) next.delete(id)
      else next.set(id, status)
      statusStore.publish(next)
    },
    /** 更新某个会话行并推送。 */
    setRow: (id, patch) => {
      listState.byId[id] = { ...listState.byId[id], ...patch }
      listStore.publish({ ...listState, byId: { ...listState.byId } })
    },
    /** 全部 effect 清理。 */
    dispose: () => {
      for (const disposer of effectDisposers.splice(0)) disposer()
    },
    /** 还原全局环境。 */
    restore: () => {
      globalThis.window = previous.window
      globalThis.document = previous.document
      globalThis.Notification = previous.Notification
      globalThis.localStorage = previous.localStorage
      globalThis.fetch = previous.fetch
      if (previous.location === undefined) {
        try {
          delete globalThis.location
        } catch {
          globalThis.location = undefined
        }
      } else {
        globalThis.location = previous.location
      }
    },
  }
}

/** 等待合并窗口过去，让插件完成一次观察。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 80))

/** 会话行。 */
function sessionRow(id, patch = {}) {
  return { id, displayTitle: `会话 ${id}`, title: `会话 ${id}`, running: false, updatedAt: 1_700_000_000_000, ...patch }
}

/** 回合结局投影。 */
function turnEnd(seq, outcome, extra = {}) {
  return { outcome, turn: seq, seq, time: Date.now() - 500, code: null, message: null, ...extra }
}

/** 造一个侧栏行元素桩，记录 scrollIntoView 的调用参数。 */
function rowElement(key) {
  return {
    dataset: { rowKey: key },
    calls: [],
    scrollIntoView(options) { this.calls.push(options) },
  }
}

/** 造一个带会话服务 + uiWorkspace 的 ctx.get 覆盖，供跳转类用例使用。 */
function workspaceCtx(harness, opened, workspaces) {
  return (serviceName) => {
    if (serviceName === 'uiWorkspace') {
      return {
        openSession: (id) => opened.push(id),
        ...(workspaces === undefined ? {} : { workspaces: { list: { getSnapshot: () => workspaces } } }),
      }
    }
    if (serviceName === 'sessions') return { list: harness.listStore }
    if (serviceName === 'uiSession') return { sessionStatus: harness.statusStore }
    return undefined
  }
}

test('bundle 声明了正确的注册 id 与服务依赖', async () => {
  const harness = await createHarness()
  try {
    assert.equal(harness.state.registration.id, JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).name)
    assert.deepEqual(harness.exports.inject, ['sessions', 'uiSession'])
  } finally {
    harness.dispose()
    harness.restore()
  }
})

test('客户端半内联的版本与 package.json 一致（版本漂移护栏）', async () => {
  const harness = await createHarness()
  try {
    await settle()
    const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'))
    assert.equal(globalThis.__DSH_SESSION_HUB__.inspect().version, pkg.version)
  } finally {
    harness.dispose()
    harness.restore()
  }
})

test('探活回报的宿主半版本与客户端半不一致时，会明确说出错位', async () => {
  const infos = []
  const originalInfo = console.info
  console.info = (...args) => { infos.push(args.join(' ')) }
  const harness = await createHarness({
    sessions: [sessionRow('s1')],
    hostHalfMissing: true,
    onFetch: () => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ host: 'dsh-session-hub', version: '9.9.9', projectionKey: 'hubTurnOutcome' }),
    }),
  })
  try {
    await settle()
    assert.equal(globalThis.__DSH_SESSION_HUB__.inspect().hostHalf, 'present')
    assert.equal(infos.length, 1)
    assert.match(infos[0], /版本不一致：宿主半 v9\.9\.9/)
  } finally {
    console.info = originalInfo
    harness.dispose()
    harness.restore()
  }
})

test('启动时已有历史结局不弹通知', async () => {
  const harness = await createHarness({
    sessions: [sessionRow('s1')],
    projections: { s1: turnEnd(10, 'completed') },
  })
  try {
    await settle()
    assert.equal(harness.state.notifications.length, 0)
  } finally {
    harness.dispose()
    harness.restore()
  }
})

test('新一轮完成弹「任务完成」，点通知跳回会话并把窗口到前台', async () => {
  const harness = await createHarness({
    sessions: [sessionRow('s1')],
    projections: { s1: turnEnd(10, 'completed') },
  })
  try {
    await settle()
    harness.setProjection('s1', turnEnd(12, 'completed'))
    await settle()

    assert.equal(harness.state.notifications.length, 1)
    const toast = harness.state.notifications[0]
    assert.equal(toast.title, '🟢 DSH · 任务完成')
    assert.equal(toast.options.body, '会话 s1')
    // tag 只放身份哈希：长 tag（几十个字符）会被 Chromium 静默丢弃整条通知，
    // 所以 tag 必须短且只含字母数字（详见 src/client-main.js 的 shortToastTag）。
    assert.match(toast.options.tag, /^dsh[0-9a-f]{12}$/)
    assert.ok(toast.options.tag.length <= 16, 'tag 不能超过实测安全长度 16 字符')
    assert.equal(toast.options.requireInteraction, false)
    assert.equal(toast.options.silent, false)
    // 每条事件一个唯一 tag，且刻意不传 renotify：本机实测「同 tag 替换」那条平台
    // 路径会把通知整条丢掉（连 Windows 都收不到提交），所以绝不走它。
    assert.equal('renotify' in toast.options, false)

    // 真实场景里点 toast 时窗口通常不在前台；这里显式模拟未聚焦。
    globalThis.document.hasFocus = () => false
    toast.onclick()
    assert.equal(toast.closed, true)
    assert.equal(harness.state.focusCalls, 1)
    assert.deepEqual(harness.state.openedSessions, [])
    // uiWorkspace 未注册时走 DOM 事件退路。
    assert.equal(harness.state.dispatched.length, 1)
    assert.equal(harness.state.dispatched[0].type, 'dsh-session-hub:open-session')
    assert.equal(harness.state.dispatched[0].detail.sessionId, 's1')
    // 并且请求宿主半把窗口提到前台（渲染进程自己做不到）。
    assert.deepEqual(
      harness.state.fetches.map((call) => call.url),
      ['dsh-session-hub/warmup', 'dsh-session-hub/raise'],
    )
    assert.equal(harness.state.fetches[1].options.method, 'POST')
  } finally {
    harness.dispose()
    harness.restore()
  }
})

test('同一会话的两次事件用两个不同的 tag，不依赖平台替换', async () => {
  const harness = await createHarness({
    sessions: [sessionRow('s1')],
    projections: { s1: turnEnd(10, 'completed') },
  })
  try {
    await settle()
    harness.setProjection('s1', turnEnd(12, 'completed'))
    await settle()
    harness.setProjection('s1', turnEnd(13, 'completed'))
    await settle()

    assert.equal(harness.state.notifications.length, 2)
    const [first, second] = harness.state.notifications
    assert.match(first.options.tag, /^dsh[0-9a-f]{12}$/)
    assert.match(second.options.tag, /^dsh[0-9a-f]{12}$/)
    assert.notEqual(first.options.tag, second.options.tag, '同会话的不同事件不能共用 tag')
    // tag 长得一样但都短：这是「越过平台替换分支」与「不被 Chromium 丢弃」的共同前提。
    assert.ok(second.options.tag.length <= 16, 'tag 不能超过实测安全长度 16 字符')
  } finally {
    harness.dispose()
    harness.restore()
  }
})

test('通知落地结果写进诊断日志：onshow 记 shown', async () => {
  const harness = await createHarness({
    sessions: [sessionRow('s1')],
    projections: { s1: turnEnd(10, 'completed') },
  })
  try {
    await settle()
    harness.setProjection('s1', turnEnd(12, 'completed'))
    await settle()

    const log = globalThis.__DSH_SESSION_HUB__.getNotifyLog()
    assert.equal(log.length, 1, '一次通知只应记一条结果')
    assert.equal(log[0].stage, 'shown')
    assert.equal(log[0].sessionId, 's1')
    assert.match(log[0].tag, /^dsh[0-9a-f]{12}$/)
    // 可读身份不丢，只是挪到 `key` 里：排障时仍能看出是哪条事件。
    assert.equal(log[0].key, 'dsh-session-hub:s1#completed:12')
    assert.equal(log[0].permission, 'granted')

    // 清空后重新读回空表（排障入口要能复位）。
    assert.deepEqual(globalThis.__DSH_SESSION_HUB__.clearNotifyLog(), [])
    assert.deepEqual(globalThis.__DSH_SESSION_HUB__.getNotifyLog(), [])
  } finally {
    harness.dispose()
    harness.restore()
  }
})

test('tag 长度与身份长短无关：超长会话 id 也只产出 15 个字符', async () => {
  const harness = await createHarness({
    sessions: [sessionRow('s1')],
    projections: { s1: turnEnd(10, 'completed') },
  })
  try {
    await settle()
    // 会话 id 长到 60+ 字符，拼出来的可读身份远超实测的 16 字符安全上限；
    // tag 必须是它的哈希，长度恒定，否则通知会被 Chromium 静默丢弃。
    const longId = `session-${'a'.repeat(60)}`
    assert.equal(globalThis.__DSH_SESSION_HUB__.testNotification(longId), true)
    await settle()
    const toast = harness.state.notifications.at(-1)
    assert.equal(toast.options.tag.length, 15, 'tag 必须恒为 15 个字符')
    assert.match(toast.options.tag, /^dsh[0-9a-f]{12}$/)
  } finally {
    harness.dispose()
    harness.restore()
  }
})

test('通知标题带彩色圆点标识，可用 colorMarkers 关掉', async () => {
  const harness = await createHarness({
    sessions: [sessionRow('s1')],
    projections: { s1: turnEnd(10, 'completed') },
  })
  try {
    await settle()
    harness.setProjection('s1', turnEnd(12, 'completed'))
    await settle()
    assert.equal(harness.state.notifications[0].title, '🟢 DSH · 任务完成')

    // 关掉后回到纯文本标题：颜色只是增益，不该变成强迫项。
    globalThis.__DSH_SESSION_HUB__.setConfig({ colorMarkers: false })
    harness.setProjection('s1', turnEnd(13, 'completed'))
    await settle()
    assert.equal(harness.state.notifications[1].title, 'DSH · 任务完成')
  } finally {
    globalThis.__DSH_SESSION_HUB__.setConfig({ colorMarkers: true })
    harness.dispose()
    harness.restore()
  }
})

test('系统侧拒绝时记 failed，不再一律吞成 no-event', async () => {
  const harness = await createHarness({
    sessions: [sessionRow('s1')],
    projections: { s1: turnEnd(10, 'completed') },
  })
  try {
    await settle()
    harness.state.failWith = 'element not found'
    harness.setProjection('s1', turnEnd(12, 'completed'))
    await settle()

    const log = globalThis.__DSH_SESSION_HUB__.getNotifyLog()
    assert.equal(log.length, 1)
    // Electron 派发的是 `failed`（HTML5 的 `error` 在 Electron 里永远不会来），
    // 两个名字都要挂上，否则失败会被记成 no-event、诊断彻底断掉。
    assert.equal(log[0].stage, 'failed')
    assert.match(String(log[0].detail), /element not found/)
  } finally {
    harness.state.failWith = null
    harness.dispose()
    harness.restore()
  }
})

test('注入 uiWorkspace 后，点通知调用 openSession', async () => {
  const harness = await createHarness({
    sessions: [sessionRow('s1')],
    projections: { s1: turnEnd(10, 'completed') },
  })
  const opened = []
  harness.ctx.get = (serviceName) => {
    if (serviceName === 'uiWorkspace') return { openSession: (id) => opened.push(id) }
    if (serviceName === 'sessions') return { list: harness.listStore }
    if (serviceName === 'uiSession') return { sessionStatus: harness.statusStore }
    return undefined
  }
  try {
    await settle()
    harness.setProjection('s1', turnEnd(12, 'completed'))
    await settle()

    assert.equal(harness.state.notifications.length, 1)
    harness.state.notifications[0].onclick()
    assert.deepEqual(opened, ['s1'])
    assert.equal(harness.state.dispatched.length, 0)
  } finally {
    harness.dispose()
    harness.restore()
  }
})

test('运行失败弹「任务失败」，正文带错误信息', async () => {
  const harness = await createHarness({ sessions: [sessionRow('s1')] })
  try {
    await settle()
    harness.setProjection('s1', turnEnd(3, 'error', { code: 'LLM_ERROR', message: '连接被重置' }))
    await settle()

    assert.equal(harness.state.notifications.length, 1)
    assert.equal(harness.state.notifications[0].title, '🔴 DSH · 任务失败')
    assert.equal(harness.state.notifications[0].options.body, '会话 s1：连接被重置')
  } finally {
    harness.dispose()
    harness.restore()
  }
})

test('待回答 / 待审批弹常驻通知', async () => {
  const harness = await createHarness({ sessions: [sessionRow('s1')] })
  try {
    await settle()
    harness.setStatus('s1', { running: true, pendingInteraction: { key: 'q1', kind: 'question', sessionId: 's1' } })
    await settle()

    assert.equal(harness.state.notifications.length, 1)
    assert.equal(harness.state.notifications[0].title, '🟡 DSH · 需要你回应')
    assert.equal(harness.state.notifications[0].options.body, '需要你回答：会话 s1')
    assert.equal(harness.state.notifications[0].options.requireInteraction, true)

    // 同一待交互的后续推送不再重复弹。
    harness.setStatus('s1', { running: true, pendingInteraction: { key: 'q1', kind: 'question', sessionId: 's1' } })
    await settle()
    assert.equal(harness.state.notifications.length, 1)
  } finally {
    harness.dispose()
    harness.restore()
  }
})

test('运行中的活动不会弹通知（这正是旧插件「无问答也提示」的来源）', async () => {
  const harness = await createHarness({
    sessions: [sessionRow('s1')],
    projections: { s1: turnEnd(1, 'completed') },
  })
  try {
    await settle()
    // 模拟一串实时活动：running 上下翻动但不产生任何新的回合结局。
    for (let i = 0; i < 6; i += 1) {
      harness.setStatus('s1', { running: i % 2 === 0 })
      await settle()
    }
    assert.equal(harness.state.notifications.length, 0)
  } finally {
    harness.dispose()
    harness.restore()
  }
})

test('宿主半确证缺失时才退化：running 下降沿兜底成「完成」', async () => {
  const harness = await createHarness({
    sessions: [sessionRow('s1', { running: true })],
    hostHalfMissing: true,
    // 非 JSON 的路由响应 = 宿主半的路由不存在（确证缺失）。
    onFetch: () => Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new Error('not json')) }),
  })
  try {
    await settle()
    harness.setStatus('s1', { running: false })
    harness.setRow('s1', { running: false })
    await settle()
    assert.equal(harness.state.notifications.length, 1)
    assert.equal(harness.state.notifications[0].title, '🟢 DSH · 任务完成')
  } finally {
    harness.dispose()
    harness.restore()
  }
})

test('宿主半在但返回值还没到（投影键缺失）时，绝不用 running 兜底', async () => {
  const harness = await createHarness({
    sessions: [sessionRow('s1', { running: true })],
    hostHalfMissing: true,
    // 路由在线（旧构建的 404 JSON）→ 不许兜底。
    onFetch: () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: 'unknown-action' }) }),
  })
  try {
    await settle()
    harness.setStatus('s1', { running: false })
    harness.setRow('s1', { running: false })
    await settle()
    assert.equal(harness.state.notifications.length, 0, '真正的结局到达前不许弹假「完成」')
  } finally {
    harness.dispose()
    harness.restore()
  }
})

test('宿主半在、但该会话还没有回合结局时，running 下降沿不兜底（避免假「完成」）', async () => {
  const harness = await createHarness({
    sessions: [sessionRow('s1', { running: true })],
  })
  try {
    await settle()
    harness.setStatus('s1', { running: false })
    harness.setRow('s1', { running: false })
    await settle()
    assert.equal(harness.state.notifications.length, 0, '真结局到达前不应当先弹一条「完成」')
  } finally {
    harness.dispose()
    harness.restore()
  }
})

test('读不到投影值只代表「还没有回合结局」，探活到宿主半就不许告警', async () => {
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => { warnings.push(args.join(' ')) }
  const harness = await createHarness({
    sessions: [sessionRow('s1')],
    hostHalfMissing: true,
    onFetch: () => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ host: 'dsh-session-hub', projectionKey: 'hubTurnOutcome' }),
    }),
  })
  try {
    await settle()
    assert.deepEqual(
      harness.state.fetches.map((call) => call.url),
      ['dsh-session-hub/ping'],
      '值缺失时应当探活一次',
    )
    assert.equal(globalThis.__DSH_SESSION_HUB__.inspect().hostHalf, 'present')
    assert.deepEqual(warnings, [], '宿主半在线时不许有任何告警')
  } finally {
    console.warn = originalWarn
    harness.dispose()
    harness.restore()
  }
})

test('宿主半是旧构建（ping 返回路由家族的 404 JSON）时也判定为在线，不告警', async () => {
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => { warnings.push(args.join(' ')) }
  const harness = await createHarness({
    sessions: [sessionRow('s1')],
    hostHalfMissing: true,
    onFetch: () => Promise.resolve({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: 'unknown-action' }),
    }),
  })
  try {
    await settle()
    assert.equal(globalThis.__DSH_SESSION_HUB__.inspect().hostHalf, 'present')
    assert.deepEqual(warnings, [], '旧构建同样是在线，不许告警')
  } finally {
    console.warn = originalWarn
    harness.dispose()
    harness.restore()
  }
})

test('宿主半路由真的不存在（非 JSON 响应）时告警，且说的是路由缺失', async () => {
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => { warnings.push(args.join(' ')) }
  const harness = await createHarness({
    sessions: [sessionRow('s1')],
    hostHalfMissing: true,
    onFetch: () => Promise.resolve({
      ok: false,
      status: 404,
      json: () => Promise.reject(new Error('not json')),
    }),
  })
  try {
    await settle()
    assert.equal(globalThis.__DSH_SESSION_HUB__.inspect().hostHalf, 'absent')
    assert.equal(warnings.length, 1, '只告警一次，不刷屏')
    assert.match(warnings[0], /宿主半的路由不存在/)
  } finally {
    console.warn = originalWarn
    harness.dispose()
    harness.restore()
  }
})

test('探活请求本身失败时措辞如实（说「无法确认」而不是「确认不在」）', async () => {
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => { warnings.push(args.join(' ')) }
  const harness = await createHarness({
    sessions: [sessionRow('s1')],
    hostHalfMissing: true,
    onFetch: () => Promise.reject(new Error('network down')),
  })
  try {
    await settle()
    assert.equal(globalThis.__DSH_SESSION_HUB__.inspect().hostHalf, 'unknown')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /探活请求失败，无法确认/)
  } finally {
    console.warn = originalWarn
    harness.dispose()
    harness.restore()
  }
})

test('探活具备退避：5 分钟内不重复请求', async () => {
  const harness = await createHarness({
    sessions: [sessionRow('s1')],
    hostHalfMissing: true,
    onFetch: () => Promise.reject(new Error('network down')),
  })
  try {
    await settle()
    harness.setRow('s1', { running: true })
    await settle()
    harness.setRow('s1', { running: false })
    await settle()
    const pings = harness.state.fetches.filter((call) => call.url === 'dsh-session-hub/ping')
    assert.equal(pings.length, 1, '失败后 5 分钟内不再打扰宿主')
  } finally {
    harness.dispose()
    harness.restore()
  }
})

test('子代理会话不打扰用户', async () => {
  const harness = await createHarness({
    sessions: [sessionRow('child', { origin: 'subagent' })],
  })
  try {
    await settle()
    harness.setProjection('child', turnEnd(4, 'completed'))
    await settle()
    assert.equal(harness.state.notifications.length, 0)
  } finally {
    harness.dispose()
    harness.restore()
  }
})

test('窗口聚焦且正在看该会话时静默；在看别的会话时照常弹', async () => {
  const harness = await createHarness({
    sessions: [sessionRow('s1', { retainedBy: { mainView: 1 } }), sessionRow('s2')],
  })
  try {
    await settle()
    // 当前会话就是 s1 → 静默。
    harness.setProjection('s1', turnEnd(3, 'completed'))
    await settle()
    assert.equal(harness.state.notifications.length, 0)

    // s2 不是当前会话 → 照常弹。
    harness.setProjection('s2', turnEnd(4, 'completed'))
    await settle()
    assert.equal(harness.state.notifications.length, 1)
    assert.equal(harness.state.notifications[0].options.body, '会话 s2')
  } finally {
    harness.dispose()
    harness.restore()
  }
})

test('窗口不可见时不算聚焦，照常弹', async () => {
  const harness = await createHarness({ sessions: [sessionRow('s1', { retainedBy: { mainView: 1 } })] })
  try {
    await settle()
    globalThis.document.visibilityState = 'hidden'
    harness.setProjection('s1', turnEnd(3, 'completed'))
    await settle()
    assert.equal(harness.state.notifications.length, 1)
  } finally {
    globalThis.document.visibilityState = 'visible'
    harness.dispose()
    harness.restore()
  }
})

test('当前会话在窗口被别的应用盖住时完成：弹完成通知，并把任务栏点亮成绿灯（待查看）', async () => {
  const harness = await createHarness({
    desktop: true,
    sessions: [sessionRow('s1', { retainedBy: { mainView: 1 } })],
    projections: { s1: turnEnd(10, 'completed') },
  })
  try {
    // 窗口可见、但不在前台（被别的窗口盖住 / 最小化前的后台状态）。
    globalThis.document.hasFocus = () => false
    await settle()
    const api = globalThis.__DSH_SESSION_HUB__
    assert.equal(api.inspect().focused, false, '不在前台的窗口不能被当成「用户正在看」')

    harness.setProjection('s1', turnEnd(12, 'completed'))
    await settle()

    // 1) Windows 通知照常弹：当前会话不再因为「正在看」而被静默。
    assert.equal(harness.state.notifications.length, 1)
    assert.equal(harness.state.notifications[0].title, '🟢 DSH · 任务完成')
    assert.equal(harness.state.notifications[0].options.body, '会话 s1')

    // 2) 官方 completionUnread 对主视图会话不置位，靠插件补记出「待查看」绿行。
    assert.deepEqual(api.getRows().map((item) => [item.id, item.state]), [['s1', 'unread']])
    assert.deepEqual(api.getLocalUnread(), { s1: 12 })
    assert.equal(api.getTaskbarState(), 'green')

    // 3) 宿主半真的收到了绿灯请求（任务栏图标上的绿点）。
    const taskbar = harness.state.fetches.filter((call) => call.url === 'dsh-session-hub/taskbar')
    assert.ok(taskbar.length > 0, '桌面端应当向宿主半上报任务栏状态')
    assert.deepEqual(JSON.parse(taskbar.at(-1).options.body), { state: 'green' })

    // 4) 记账落盘：刷新页面（新客户端半）后绿点仍然在。
    assert.deepEqual(JSON.parse(harness.state.storage.get('dsh-session-hub/local-unread-v1')), { s1: 12 })
  } finally {
    harness.dispose()
    harness.restore()
  }
})

test('窗口回到前台且正在看该会话后，「待查看」记账与任务栏绿灯一起熄灭', async () => {
  const harness = await createHarness({
    desktop: true,
    sessions: [sessionRow('s1', { retainedBy: { mainView: 1 } })],
    projections: { s1: turnEnd(10, 'completed') },
  })
  try {
    globalThis.document.hasFocus = () => false
    await settle()
    harness.setProjection('s1', turnEnd(12, 'completed'))
    await settle()
    assert.equal(globalThis.__DSH_SESSION_HUB__.getTaskbarState(), 'green')

    // 用户切回窗口：焦点变化本身不带会话状态推送，必须自己再观察一次。
    globalThis.document.hasFocus = () => true
    for (const listener of harness.state.listeners.get('focus') ?? []) listener()
    await settle()

    const api = globalThis.__DSH_SESSION_HUB__
    assert.deepEqual(api.getLocalUnread(), {})
    assert.equal(api.getTaskbarState(), 'none')
    assert.deepEqual(api.getRows(), [])
    const taskbar = harness.state.fetches.filter((call) => call.url === 'dsh-session-hub/taskbar')
    assert.deepEqual(JSON.parse(taskbar.at(-1).options.body), { state: 'none' })
  } finally {
    harness.dispose()
    harness.restore()
  }
})

test('窗口在前台且正在看该会话时完成：静默，不点绿灯（结果就在眼前）', async () => {
  const harness = await createHarness({
    desktop: true,
    sessions: [sessionRow('s1', { retainedBy: { mainView: 1 } })],
    projections: { s1: turnEnd(10, 'completed') },
  })
  try {
    await settle()
    harness.setProjection('s1', turnEnd(12, 'completed'))
    await settle()

    const api = globalThis.__DSH_SESSION_HUB__
    assert.equal(harness.state.notifications.length, 0)
    assert.deepEqual(api.getLocalUnread(), {}, '盯着看的时候完成，不该记成待查看')
    assert.equal(api.getTaskbarState(), 'none')
  } finally {
    harness.dispose()
    harness.restore()
  }
})

test('点完成通知跳回会话时清掉「待查看」记账（绿灯随之熄灭）', async () => {
  const harness = await createHarness({
    desktop: true,
    sessions: [sessionRow('s1', { retainedBy: { mainView: 1 } })],
    projections: { s1: turnEnd(10, 'completed') },
  })
  try {
    globalThis.document.hasFocus = () => false
    await settle()
    harness.setProjection('s1', turnEnd(12, 'completed'))
    await settle()
    assert.equal(globalThis.__DSH_SESSION_HUB__.getTaskbarState(), 'green')

    harness.state.notifications[0].onclick()
    await settle()

    const api = globalThis.__DSH_SESSION_HUB__
    assert.deepEqual(api.getLocalUnread(), {}, '点通知 = 已经去看过了')
    assert.equal(api.getTaskbarState(), 'none')
  } finally {
    harness.dispose()
    harness.restore()
  }
})

test('水位落盘：同一份 localStorage 的新页面不会重复弹旧事件', async () => {
  const harness = await createHarness({ sessions: [sessionRow('s1')] })
  let storage
  try {
    await settle()
    harness.setProjection('s1', turnEnd(5, 'completed'))
    await settle()
    assert.equal(harness.state.notifications.length, 1)
    // 等落盘合并窗口。
    await new Promise((resolve) => setTimeout(resolve, 500))
    storage = new Map(harness.state.storage)
    harness.dispose()
    harness.restore()
  } catch (error) {
    harness.dispose()
    harness.restore()
    throw error
  }

  // 新页面：共享同一份 localStorage，且列表里仍是同一个已完成结局。
  const second = await createHarness({
    sessions: [sessionRow('s1')],
    projections: { s1: turnEnd(5, 'completed') },
  })
  try {
    second.state.storage = storage
    await settle()
    assert.equal(second.state.notifications.length, 0, '已消化过的事件不应在重载后补弹')
  } finally {
    second.dispose()
    second.restore()
  }
})

test('多标签页共享 localStorage 时，同一事件只弹一次', async () => {
  const first = await createHarness({ sessions: [sessionRow('s1')] })
  const second = await createHarness({ sessions: [sessionRow('s1')] })
  try {
    // 两个页面共享同一份存储（模拟同一个 origin 的两个标签页）。
    second.state.storage = first.state.storage
    await settle()

    first.setProjection('s1', turnEnd(9, 'completed'))
    second.setProjection('s1', turnEnd(9, 'completed'))
    await settle()

    const total = first.state.notifications.length + second.state.notifications.length
    assert.equal(total, 1, '同一事件在两个页面里只应弹一条')
  } finally {
    first.dispose()
    first.restore()
    second.dispose()
    second.restore()
  }
})

test('关掉「完成」后不再弹完成通知，但重新打开也不补弹', async () => {
  const harness = await createHarness({ sessions: [sessionRow('s1')] })
  try {
    await settle()
    globalThis.__DSH_SESSION_HUB__.setConfig({ onComplete: false })
    harness.setProjection('s1', turnEnd(3, 'completed'))
    await settle()
    assert.equal(harness.state.notifications.length, 0)

    globalThis.__DSH_SESSION_HUB__.setConfig({ onComplete: true })
    await settle()
    assert.equal(harness.state.notifications.length, 0, '被关掉时消化过的事件不应补弹')

    harness.setProjection('s1', turnEnd(4, 'completed'))
    await settle()
    assert.equal(harness.state.notifications.length, 1)
  } finally {
    harness.dispose()
    harness.restore()
  }
})

test('unload 后不再观察、不再弹通知', async () => {
  const harness = await createHarness({ sessions: [sessionRow('s1')] })
  try {
    await settle()
    harness.dispose()
    harness.setProjection('s1', turnEnd(3, 'completed'))
    await settle()
    assert.equal(harness.state.notifications.length, 0)
    assert.equal(globalThis.__DSH_SESSION_HUB__, undefined)
  } finally {
    harness.restore()
  }
})

test('诊断入口可以弹测试通知，并能主动探活宿主半', async () => {
  const harness = await createHarness({
    sessions: [sessionRow('s1', { retainedBy: { mainView: 1 } })],
  })
  try {
    await settle()
    const api = globalThis.__DSH_SESSION_HUB__
    assert.equal(typeof api.inspect, 'function')
    assert.equal(api.inspect().permission, 'granted')
    assert.equal(await api.pingHost(), 'present')
    assert.equal(api.testNotification(), true)
    assert.equal(harness.state.notifications.length, 1)
    assert.equal(harness.state.notifications[0].title, '🔔 DSH · 通知测试')
  } finally {
    harness.dispose()
    harness.restore()
  }
})

test('窗口已聚焦时点通知不再重复请求前置窗口（不会触碰最大化状态）', async () => {
  const harness = await createHarness({
    sessions: [sessionRow('s1')],
    projections: { s1: turnEnd(10, 'completed') },
  })
  try {
    await settle()
    harness.setProjection('s1', turnEnd(12, 'completed'))
    await settle()
    assert.equal(harness.state.notifications.length, 1)
    harness.state.notifications[0].onclick()
    assert.deepEqual(
      harness.state.fetches.map((call) => call.url),
      ['dsh-session-hub/warmup'],
    )
  } finally {
    harness.dispose()
    harness.restore()
  }
})

// ---- 跳转后的左侧列表滚动 ----

test('点通知跳转后，左侧会话列表滚动到对应会话行', async () => {
  const harness = await createHarness({
    sessions: [sessionRow('s1')],
    projections: { s1: turnEnd(10, 'completed') },
  })
  const opened = []
  harness.ctx.get = workspaceCtx(harness, opened)
  const target = rowElement('session:s1')
  harness.state.rows.push(target)
  try {
    await settle()
    harness.setProjection('s1', turnEnd(12, 'completed'))
    await settle()
    assert.equal(harness.state.notifications.length, 1)

    harness.state.notifications[0].onclick()
    await settle()

    assert.deepEqual(opened, ['s1'], '跳转本身照常发生')
    assert.deepEqual(target.calls, [{ block: 'center' }], '列表应把该会话行滚到垂直居中')
  } finally {
    harness.dispose()
    harness.restore()
  }
})

test('目标行稍后才渲染（React 异步提交）时，揭示逻辑会继续重试', async () => {
  const harness = await createHarness({
    sessions: [sessionRow('s1')],
    projections: { s1: turnEnd(10, 'completed') },
  })
  const opened = []
  harness.ctx.get = workspaceCtx(harness, opened)
  const target = rowElement('session:s1')
  // 点击那一刻行还没有渲染：30ms 后才出现。
  const timer = setTimeout(() => harness.state.rows.push(target), 30)
  try {
    await settle()
    harness.setProjection('s1', turnEnd(12, 'completed'))
    await settle()
    harness.state.notifications[0].onclick()
    await new Promise((resolve) => setTimeout(resolve, 150))

    assert.deepEqual(target.calls, [{ block: 'center' }], '应在行渲染出来的那一帧滚过去')
  } finally {
    clearTimeout(timer)
    harness.dispose()
    harness.restore()
  }
})

test('会话行被分组折叠隐藏时，退化滚动到所属工作区分组行', async () => {
  const harness = await createHarness({
    sessions: [sessionRow('s1')],
    projections: { s1: turnEnd(10, 'completed') },
  })
  const opened = []
  harness.ctx.get = workspaceCtx(harness, opened, {
    items: [{ workspaceId: 'w1', sessionIds: ['s1'] }],
  })
  const groupRow = rowElement('workspace:w1')
  harness.state.rows.push(groupRow)
  try {
    await settle()
    harness.setProjection('s1', turnEnd(12, 'completed'))
    await settle()
    harness.state.notifications[0].onclick()
    await settle()

    assert.deepEqual(groupRow.calls, [{ block: 'center' }], '会话行不存在时应滚到它所属的分组行')
  } finally {
    harness.dispose()
    harness.restore()
  }
})

test('会话行与分组行都不存在时静默放弃，跳转照常完成', async () => {
  const harness = await createHarness({
    sessions: [sessionRow('s1')],
    projections: { s1: turnEnd(10, 'completed') },
  })
  const opened = []
  harness.ctx.get = workspaceCtx(harness, opened)
  try {
    await settle()
    harness.setProjection('s1', turnEnd(12, 'completed'))
    await settle()
    harness.state.notifications[0].onclick()
    await settle()

    assert.deepEqual(opened, ['s1'], '滚动找不到目标时不得影响跳转')
  } finally {
    harness.dispose()
    harness.restore()
  }
})

test('滚动时宿主抛错也不会影响跳转与通知（异常被吞掉）', async () => {
  const harness = await createHarness({
    sessions: [sessionRow('s1')],
    projections: { s1: turnEnd(10, 'completed') },
  })
  const opened = []
  harness.ctx.get = workspaceCtx(harness, opened)
  harness.state.rows.push({
    dataset: { rowKey: 'session:s1' },
    scrollIntoView: () => { throw new Error('not supported') },
  })
  try {
    await settle()
    harness.setProjection('s1', turnEnd(12, 'completed'))
    await settle()
    assert.doesNotThrow(() => harness.state.notifications[0].onclick())
    await settle()
    assert.deepEqual(opened, ['s1'])
  } finally {
    harness.dispose()
    harness.restore()
  }
})

test('诊断入口可单独验证列表揭示（不跳转）', async () => {
  const harness = await createHarness({ sessions: [sessionRow('s1')] })
  const target = rowElement('session:s1')
  harness.state.rows.push(target)
  try {
    await settle()
    const api = globalThis.__DSH_SESSION_HUB__
    assert.equal(api.revealSessionRow('s1'), 'session')
    assert.deepEqual(target.calls, [{ block: 'center' }])
    assert.equal(api.revealSessionRow('missing'), null)
  } finally {
    harness.dispose()
    harness.restore()
  }
})
