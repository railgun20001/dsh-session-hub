/**
 * dsh-session-status-hub —— 客户端半的四份持久状态（配置 / 水位 / 报错确认 / 后台完成记账）
 *
 * 这一层把「插件在浏览器里记着什么」收拢到一处，其余模块只通过它读写：
 *
 * | 状态 | 形状 | 谁写 | 谁读 |
 * |---|---|---|---|
 * | 配置 | 见 notify-core 的 DEFAULT_CONFIG | `patchConfig` | 通知落地、状态栏、宿主路由 |
 * | 通知水位 | `{ [id]: { seq, pendingKey, running, seeded } }` | tick（合并落盘） | `planNotifications` |
 * | 报错确认 | `{ [id]: seq }` | `ackError` | `deriveHubRows`、行悬停提示 |
 * | 后台完成 | `{ [id]: seq }` | `markLocalUnread` | `deriveHubRows`（绿点 / 绿灯） |
 *
 * 设计要点：
 *
 *   - **写盘与调度分离**。水位是高频变化的（每次推送都可能推进），所以不在这里落盘；
 *     由调用方合并成一次 `watermarks.flush()`。其余三份都是「用户动作级」的低频写入，
 *     直接落盘更简单。
 *   - **变化与否要说清楚**。`ackError` / `markLocalUnread` / `clearLocalUnread` 都返回
 *     布尔，调用方据此决定要不要重新观察一次（`scheduleTick`）——否则会陷入
 *     「写→观察→再写」的空转。
 *   - **归一化靠注入**。非法持久值（老版本、手工改过）必须被丢掉，但归一化函数住在
 *     模型层（`normalizeConfig` / `normalizeSeqMap`），这里用参数接进来，避免这一层
 *     反过来依赖模型层的实现细节。
 *
 * @module dsh-session-status-hub/hub-stores
 */

/**
 * 一个极简快照仓库，供 React 的 `useSyncExternalStore` 订阅。
 *
 * 只在引用真的变化时才通知订阅者：`set` 收到同一个引用直接返回。
 * @param {object} initial 初始值。
 * @returns {{ getSnapshot: () => object, subscribe: (listener: () => void) => () => void, set: (next: object) => void }}
 *   仓库接口。
 */
export function createSnapshotStore(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next) => {
      if (next === value) return
      value = next
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (error) {
          console.warn('[dsh-session-status-hub] 状态栏订阅者抛错', error)
        }
      }
    },
  }
}

/**
 * 把旧前缀下的持久状态搬到新前缀（插件改名时用，一次性）。
 *
 * 规则：
 *   - 只搬「新键还没有数据、旧键有数据」的那些项；新键已有数据一律不覆盖（用户已经在用新键了）；
 *   - 搬完删掉旧键，避免下次重复搬；
 *   - 全程只读写 localStorage，不做任何归一化——搬过去的原样继续走各自的归一化入口。
 *
 * @param {object} options 迁移输入。
 * @param {{ read: Function, write: Function, remove: Function }} options.store JSON 读写器。
 * @param {Record<string, string>} options.keys 新键集合。
 * @param {Record<string, string>} options.legacyKeys 旧键集合（与 `keys` 同名）。
 * @returns {string[]} 真正搬迁过的状态名（用于日志）。
 */
export function migrateLegacyKeys({ store, keys, legacyKeys }) {
  const moved = []
  if (legacyKeys === null || typeof legacyKeys !== 'object') return moved
  for (const [name, target] of Object.entries(keys)) {
    const source = legacyKeys[name]
    if (typeof source !== 'string' || source === '' || source === target) continue
    if (store.read(target, undefined) !== undefined) continue
    const legacy = store.read(source, undefined)
    if (legacy === undefined) continue
    store.write(target, legacy)
    store.remove?.(source)
    moved.push(name)
  }
  return moved
}

/**
 * 创建四份持久状态。
 *
 * @param {object} options 依赖注入。
 * @param {{ read: (key: string, fallback: unknown) => unknown, write: (key: string, value: unknown) => void }} options.store
 *   JSON 读写器（见 hub-json-store）。
 * @param {{ config: string, watermarks: string, ack: string, unread: string }} options.keys 四个存储键。
 * @param {{ config?: (raw: unknown) => object, seqMap?: (raw: unknown) => object }} [options.normalize]
 *   归一化函数；缺省时按「不认识的值一律丢掉」处理。
 * @returns {{
 *   config: object,
 *   patchConfig: (patch: object) => object,
 *   watermarks: { get: () => object, set: (next: object) => void, flush: () => void },
 *   acks: { getSnapshot: () => object, subscribe: (listener: () => void) => () => void, set: (next: object) => void },
 *   localUnread: { getSnapshot: () => object, subscribe: (listener: () => void) => () => void, set: (next: object) => void },
 *   ackError: (sessionId: string, seq: number) => boolean,
 *   markLocalUnread: (sessionId: string, seq: number) => boolean,
 *   clearLocalUnread: (sessionId?: string) => boolean,
 * }} 状态仓库。
 */
export function createHubStores({ store, keys, normalize = {} }) {
  const normalizeConfig = typeof normalize.config === 'function' ? normalize.config : () => ({})
  const normalizeSeqMap = typeof normalize.seqMap === 'function' ? normalize.seqMap : () => ({})

  /** 生效中的配置：对象本身被就地更新（组件通过 getConfig 读快照）。 */
  const config = normalizeConfig(store.read(keys.config, {}))

  let watermarks = store.read(keys.watermarks, {})
  if (watermarks === null || typeof watermarks !== 'object') watermarks = {}

  /** 已确认的报错回合：`{ [sessionId]: seq }`。 */
  const acks = createSnapshotStore(normalizeSeqMap(store.read(keys.ack, {})))

  /** 「后台完成、尚未查看」的会话：`{ [sessionId]: seq }`。 */
  const localUnread = createSnapshotStore(normalizeSeqMap(store.read(keys.unread, {})))

  return {
    config,

    /**
     * 合并写入配置（立即生效并落盘）。
     * @param {object} patch 部分配置。
     * @returns {object} 生效后的完整配置（与 {@link config} 同一个对象）。
     */
    patchConfig(patch) {
      Object.assign(config, normalizeConfig({ ...config, ...patch }))
      store.write(keys.config, config)
      return config
    },

    watermarks: {
      /** @returns {object} 通知水位表。 */
      get: () => watermarks,
      /** 替换水位表（由 tick 每次观察后调用，不落盘）。 */
      set: (next) => { watermarks = next },
      /** 把当前水位落盘（由调用方按合并窗口调用）。 */
      flush: () => { store.write(keys.watermarks, watermarks) },
    },

    acks,
    localUnread,

    /**
     * 确认某个会话的报错（点击状态栏条目 / 正在看该会话时自动确认）。
     *
     * 只前进不后退：seq 不大于已确认值时不写入、不通知订阅者。
     * @param {string} sessionId 会话 id。
     * @param {number|null} seq 报错回合的投影序号；null 不是合法确认值。
     * @returns {boolean} 记账是否发生了变化。
     */
    ackError(sessionId, seq) {
      if (typeof sessionId !== 'string' || sessionId === '') return false
      if (!Number.isInteger(seq) || seq < 0) return false
      const current = acks.getSnapshot()
      if ((current[sessionId] ?? -1) >= seq) return false
      const next = { ...current, [sessionId]: seq }
      store.write(keys.ack, next)
      acks.set(next)
      return true
    },

    /**
     * 补记一条「后台完成、尚未查看」。
     *
     * 只在窗口不在前台时由调用方使用：这正是官方 `completionUnread` 漏掉的那一类
     * （主视图会话）。同一个会话的旧 seq 不会被更旧的边沿覆盖；重复调用是幂等的。
     * @param {string} sessionId 会话 id。
     * @param {number} seq 该回合结局的投影序号。
     * @returns {boolean} 记账是否发生了变化。
     */
    markLocalUnread(sessionId, seq) {
      if (typeof sessionId !== 'string' || sessionId === '') return false
      if (!Number.isInteger(seq) || seq < 0) return false
      const current = localUnread.getSnapshot()
      if ((current[sessionId] ?? -1) >= seq) return false
      const next = { ...current, [sessionId]: seq }
      store.write(keys.unread, next)
      localUnread.set(next)
      return true
    },

    /**
     * 清掉某个会话（或缺省全部）的「后台完成」记账。
     *
     * 触发时机：窗口回到前台且正在看该会话、用户点了该会话的通知 / chip（openSession）。
     * @param {string} [sessionId] 会话 id；不传表示全部清掉。
     * @returns {boolean} 记账是否发生了变化。
     */
    clearLocalUnread(sessionId) {
      const current = localUnread.getSnapshot()
      if (sessionId === undefined) {
        if (Object.keys(current).length === 0) return false
        store.write(keys.unread, {})
        localUnread.set({})
        return true
      }
      if (!Object.hasOwn(current, sessionId)) return false
      const next = { ...current }
      delete next[sessionId]
      store.write(keys.unread, next)
      localUnread.set(next)
      return true
    },
  }
}
