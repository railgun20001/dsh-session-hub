/**
 * dsh-session-status-hub —— localStorage 的 JSON 读写层（零依赖，可单测）
 *
 * 只做一件事：把「读一个 JSON 键」和「写一个 JSON 键」的**全部失败路径**关在这里。
 *
 * 为什么值得单独一层：这些读写散落在配置、水位、确认表、待查看记账、去重窗口、诊断日志
 * 六处，每处都要处理「没有 localStorage（纯 Node 测试）」「键不存在」「JSON 坏了」
 * 「配额满 / 隐私模式」四件事，抄六遍必然漏。这里统一成「读失败回落默认值、写失败只记日志」。
 *
 * 依赖通过参数注入（`storage` / `warn`），因此可以在 Node 里用假存储直接测，不碰真全局。
 *
 * @module dsh-session-status-hub/hub-json-store
 */

/**
 * 创建一个 JSON 存储读写器。
 *
 * @param {object} [options] 注入点。
 * @param {string} [options.pluginId] 日志标签前缀。
 * @param {{ getItem: (key: string) => string|null, setItem: (key: string, value: string) => void }|null} [options.storage]
 *   存储后端；缺省用当前环境的 `localStorage`（纯 Node 下没有则所有读写静默降级）。
 * @param {(message: string, error?: unknown) => void} [options.warn] 告警回调（默认 console.warn）。
 * @returns {{
 *   read: (key: string, fallback: unknown) => unknown,
 *   write: (key: string, value: unknown) => void,
 *   remove: (key: string) => void,
 * }} 读写器。
 */
export function createJsonStore(options = {}) {
  const {
    pluginId = 'dsh-session-status-hub',
    storage = typeof localStorage === 'undefined' ? null : localStorage,
    warn = (message, error) => console.warn(message, error),
  } = options

  /**
   * 读一个 JSON 键；任何异常都回落到默认值。
   * @param {string} key 存储键。
   * @param {unknown} fallback 默认值。
   * @returns {unknown} 解析结果或默认值（`null` / `undefined` 也按默认值处理）。
   */
  const read = (key, fallback) => {
    try {
      if (storage === null) return fallback
      const raw = storage.getItem(key)
      if (raw === null || raw === '') return fallback
      const value = JSON.parse(raw)
      return value === null || value === undefined ? fallback : value
    } catch (error) {
      warn(`[${pluginId}] 读取 ${key} 失败，使用默认值`, error)
      return fallback
    }
  }

  /**
   * 写一个 JSON 键；配额 / 隐私模式导致的失败只记日志，绝不抛出。
   * @param {string} key 存储键。
   * @param {unknown} value 待写入值。
   * @returns {void}
   */
  const write = (key, value) => {
    try {
      if (storage === null) return
      storage.setItem(key, JSON.stringify(value))
    } catch (error) {
      warn(`[${pluginId}] 写入 ${key} 失败`, error)
    }
  }

  /**
   * 删掉一个键（迁移旧前缀时用）。存储后端不支持删除、或删除失败，都只当没发生。
   * @param {string} key 存储键。
   * @returns {void}
   */
  const remove = (key) => {
    try {
      if (storage === null) return
      storage.removeItem?.(key)
    } catch (error) {
      warn(`[${pluginId}] 删除 ${key} 失败`, error)
    }
  }

  return { read, write, remove }
}
