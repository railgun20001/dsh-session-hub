/**
 * dsh-session-status-hub —— 客户端持久状态单测（src/hub-json-store.js / src/hub-stores.js）
 *
 * 这一层管着插件在浏览器里记着什么：配置、通知水位、报错确认、后台完成记账。
 * 以前它们和 tick、通知、插槽注册挤在同一个 `apply` 里，只能通过整体行为测试间接覆盖；
 * 现在依赖（存储、归一化）都从参数进来，可以直接断言「写没写、写了几次、返回什么」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createJsonStore } from '../src/hub-json-store.js'
import { createHubStores, createSnapshotStore, migrateLegacyKeys } from '../src/hub-stores.js'
import { normalizeConfig } from '../src/notify-core.js'
import { normalizeSeqMap } from '../src/hub-model.js'

/**
 * 内存存储后端（与 localStorage 的 getItem/setItem 同签名）。
 * @param {Record<string, string>} [initial] 初始内容。
 * @returns {object} 存储桩。
 */
function memoryStorage(initial = {}) {
  // 值允许写成对象（内部序列化成字符串），写坏 JSON 时直接传字符串即可。
  const data = new Map(Object.entries(initial).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]))
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, value) },
    removeItem: (key) => { data.delete(key) },
  }
}

const KEYS = { config: 'hub/config', watermarks: 'hub/watermarks', ack: 'hub/ack', unread: 'hub/unread' }

/**
 * 造一组状态仓库。
 * @param {object} [options] 覆盖项。
 * @returns {{ stores: object, storage: object, warnings: string[] }} 夹具。
 */
function harness(options = {}) {
  const warnings = []
  const storage = options.storage ?? memoryStorage(options.initial)
  const store = createJsonStore({
    pluginId: 'dsh-session-status-hub',
    storage,
    warn: (message) => { warnings.push(message) },
  })
  const stores = createHubStores({
    store,
    keys: KEYS,
    normalize: { config: normalizeConfig, seqMap: normalizeSeqMap },
  })
  return { stores, storage, warnings }
}

test('JSON 存储：坏 JSON 回落默认值并告警，不抛错', () => {
  const { stores, storage, warnings } = harness({ initial: { [KEYS.ack]: '{不是 JSON' } })
  assert.deepEqual(stores.acks.getSnapshot(), {})
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /读取 hub\/ack 失败/)
  // 坏数据不阻止后续写入。
  assert.equal(stores.ackError('s1', 3), true)
  assert.deepEqual(JSON.parse(storage.getItem(KEYS.ack)), { s1: 3 })
})

test('JSON 存储：没有存储后端时所有读写静默降级', () => {
  const store = createJsonStore({ pluginId: 'dsh-session-status-hub', storage: null, warn: () => { throw new Error('不该告警') } })
  assert.deepEqual(store.read('any', { fallback: true }), { fallback: true })
  store.write('any', { ok: true })
})

test('JSON 存储：写入失败（配额 / 隐私模式）只告警，不抛出', () => {
  const warnings = []
  const store = createJsonStore({
    pluginId: 'dsh-session-status-hub',
    storage: { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError') } },
    warn: (message) => { warnings.push(message) },
  })
  store.write('hub/ack', { s1: 1 })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /写入 hub\/ack 失败/)
})

test('初始值归一化：坏形状、负数、非整数一律丢掉', () => {
  const { stores } = harness({
    initial: {
      [KEYS.config]: { onComplete: false, silenceAllWhenFocused: true, 无关键: 1 },
      [KEYS.ack]: { a: 3, b: -1, c: 'x', d: 1.5, '': 2 },
      [KEYS.unread]: { a: 7 },
      [KEYS.watermarks]: { a: { seq: 7 } },
    },
  })
  assert.equal(stores.config.onComplete, false)
  assert.equal(stores.config.onComplete, false)
  assert.equal('无关键' in stores.config, false, '未知配置键必须被丢掉')
  assert.deepEqual(stores.acks.getSnapshot(), { a: 3 })
  assert.deepEqual(stores.localUnread.getSnapshot(), { a: 7 })
  assert.deepEqual(stores.watermarks.get(), { a: { seq: 7 } })
})

test('水位表：set 只在内存里推进，flush 才落盘', () => {
  const { stores, storage } = harness()
  stores.watermarks.set({ s1: { seq: 5 } })
  assert.equal(storage.getItem(KEYS.watermarks), null, 'set 不应写盘（高频，靠合并窗口 flush）')
  stores.watermarks.flush()
  assert.deepEqual(JSON.parse(storage.getItem(KEYS.watermarks)), { s1: { seq: 5 } })
  assert.deepEqual(stores.watermarks.get(), { s1: { seq: 5 } })
})

test('报错确认只前进不后退，重复确认返回 false 且不写盘', () => {
  const { stores, storage } = harness()
  assert.equal(stores.ackError('s1', 10), true)
  const written = storage.getItem(KEYS.ack)
  assert.deepEqual(JSON.parse(written), { s1: 10 })
  assert.equal(stores.ackError('s1', 10), false, '同 seq 重复确认不算变化')
  assert.equal(stores.ackError('s1', 9), false, '更旧的 seq 不能把确认拉回去')
  assert.equal(storage.getItem(KEYS.ack), written, '不变时不应重写')
  assert.deepEqual(stores.acks.getSnapshot(), { s1: 10 })
})

test('报错确认拒绝非法输入（空 id / 非整数 seq / 负 seq）', () => {
  const { stores } = harness()
  assert.equal(stores.ackError('', 3), false)
  assert.equal(stores.ackError('s1', 1.5), false)
  assert.equal(stores.ackError('s1', -1), false)
  assert.equal(stores.ackError('s1', null), false)
  assert.deepEqual(stores.acks.getSnapshot(), {})
})

test('后台完成记账：同一会话只记更新的 seq，clear 按会话或全清', () => {
  const { stores, storage } = harness()
  assert.equal(stores.markLocalUnread('s1', 12), true)
  assert.equal(stores.markLocalUnread('s1', 12), false, '幂等')
  assert.equal(stores.markLocalUnread('s1', 11), false, '旧 seq 不覆盖新 seq')
  assert.equal(stores.markLocalUnread('s2', 3), true)
  assert.deepEqual(stores.localUnread.getSnapshot(), { s1: 12, s2: 3 })
  assert.deepEqual(JSON.parse(storage.getItem(KEYS.unread)), { s1: 12, s2: 3 })

  assert.equal(stores.clearLocalUnread('s1'), true)
  assert.deepEqual(stores.localUnread.getSnapshot(), { s2: 3 })
  assert.equal(stores.clearLocalUnread('s1'), false, '已经清掉的会话再清不算变化')

  assert.equal(stores.clearLocalUnread(), true)
  assert.deepEqual(stores.localUnread.getSnapshot(), {})
  assert.equal(stores.clearLocalUnread(), false, '空表再全清不算变化')
})

test('配置补丁：只接受已知键，落盘并立即反映在对象上', () => {
  const { stores, storage } = harness()
  const after = stores.patchConfig({ silenceAllWhenFocused: true, unknownKey: 'x' })
  assert.equal(after.silenceAllWhenFocused, true)
  assert.equal('unknownKey' in after, false)
  assert.equal(stores.config.silenceAllWhenFocused, true, '就地更新，读快照即可见')
  const persisted = JSON.parse(storage.getItem(KEYS.config))
  assert.equal(persisted.silenceAllWhenFocused, true)
  assert.equal('unknownKey' in persisted, false)
})

test('快照仓库只在引用变化时通知订阅者', () => {
  const store = createSnapshotStore({ a: 1 })
  let calls = 0
  const dispose = store.subscribe(() => { calls += 1 })
  store.set(store.getSnapshot())
  assert.equal(calls, 0, '同一个引用不应触发重渲染')
  store.set({ a: 2 })
  assert.equal(calls, 1)
  dispose()
  store.set({ a: 3 })
  assert.equal(calls, 1, '退订后不再收到通知')
})

test('旧前缀迁移：旧键有数据、新键为空时搬过去并删旧键', () => {
  const storage = memoryStorage({
    'dsh-session-hub/config-v1': { silenceAllWhenFocused: true },
    'dsh-session-hub/local-unread-v1': { s1: 12 },
  })
  const store = createJsonStore({ pluginId: 'dsh-session-status-hub', storage, warn: () => {} })
  const moved = migrateLegacyKeys({
    store,
    keys: KEYS,
    legacyKeys: { config: 'dsh-session-hub/config-v1', watermarks: 'dsh-session-hub/watermarks-v1', ack: 'dsh-session-hub/error-acks-v1', unread: 'dsh-session-hub/local-unread-v1' },
  })
  assert.deepEqual(moved.sort(), ['config', 'unread'])
  assert.deepEqual(JSON.parse(storage.getItem(KEYS.config)), { silenceAllWhenFocused: true })
  assert.deepEqual(JSON.parse(storage.getItem(KEYS.unread)), { s1: 12 })
  assert.equal(storage.getItem('dsh-session-hub/config-v1'), null, '旧键应被删掉')
  assert.equal(storage.getItem('dsh-session-hub/local-unread-v1'), null)
})

test('旧前缀迁移：新键已有数据时不覆盖，旧键也不删', () => {
  const storage = memoryStorage({
    [KEYS.config]: { silenceAllWhenFocused: false },
    'dsh-session-hub/config-v1': { silenceAllWhenFocused: true },
  })
  const store = createJsonStore({ pluginId: 'dsh-session-status-hub', storage, warn: () => {} })
  const moved = migrateLegacyKeys({ store, keys: KEYS, legacyKeys: { config: 'dsh-session-hub/config-v1' } })
  assert.deepEqual(moved, [])
  assert.deepEqual(JSON.parse(storage.getItem(KEYS.config)), { silenceAllWhenFocused: false })
  assert.notEqual(storage.getItem('dsh-session-hub/config-v1'), null, '有新数据时不应动旧键')
})

test('旧前缀迁移：没有旧数据、或新旧前缀相同时什么都不做', () => {
  const storage = memoryStorage()
  const store = createJsonStore({ pluginId: 'dsh-session-status-hub', storage, warn: () => {} })
  assert.deepEqual(migrateLegacyKeys({ store, keys: KEYS, legacyKeys: {} }), [])
  assert.deepEqual(migrateLegacyKeys({ store, keys: KEYS, legacyKeys: { ...KEYS } }), [])
  assert.deepEqual(migrateLegacyKeys({ store, keys: KEYS, legacyKeys: null }), [])
})
