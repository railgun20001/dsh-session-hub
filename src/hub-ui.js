/**
 * dsh-session-hub —— 工作区顶部会话状态栏（React 组件工厂，纯浏览器代码）
 *
 * 这个文件是 bundle 里的裸脚本片段：`createSessionHubRail(React, deps)` 返回一个
 * 函数组件，由 client-main 注册进 `conversation.header.leading` 官方插槽。
 *
 * ## 为什么放在 header.leading
 *
 * `conversation.header.leading` 是官方声明的单占位插槽（`replaceRisk: none`），
 * 位于会话标题之前、工作区内容之上，并且在「没有选中会话」时也会渲染。它天然就是
 * 「工作区上方」的位置，又不需要替换任何 shipped UI。
 *
 * ## 数据来源
 *
 * 组件只读插槽的标准 props：`useSessions`、`useSessionStatus` 与绑定后的 `t`。
 * 前两者都是订阅式快照钩子，会话状态一变就重渲染；组件自己不订阅事件、不扫描 DOM。
 *
 * 视觉全部使用 `--dsw-alias-*` 主题令牌；颜色只用于状态点，语义与原生侧栏一致。
 *
 * @module dsh-session-hub/hub-ui
 */

/**
 * 创建状态栏组件。
 * @param {object} React React 运行时（由客户端模块表提供）。
 * @param {{
 *   openSession: (sessionId: string) => void,
 *   ackError: (sessionId: string, seq: number|null) => void,
 *   acks: { subscribe: (listener: () => void) => () => void, getSnapshot: () => object },
 * }} deps 由 client-main 注入的动作与确认表。
 * @returns {Function} React 函数组件。
 */
function createSessionHubRail(React, deps) {
  const h = React.createElement
  const EMPTY_LIST = { byId: {}, projectionsBySession: {} }
  const EMPTY_STATUSES = new Map()

  /** 文案回落：插槽没有绑定 locale 时也能显示中文。 */
  const FALLBACK = {
    label: '会话状态',
    idle: '全部空闲',
    aria: '会话状态：{count} 个需要关注',
    'state.answer': '等待回答',
    'state.error': '报错',
    'state.running': '运行中',
    'state.unread': '待查看',
  }

  /**
   * 极简文案函数（只在 locale 服务缺失时使用）。
   * @param {string} key 文案键。
   * @param {object} [params] 插值参数。
   * @returns {string} 文案。
   */
  const fallbackT = (key, params) => {
    const text = FALLBACK[key] ?? key
    return params === undefined ? text : text.replace(/\{(\w+)\}/g, (match, name) => String(params[name] ?? match))
  }

  /** 没有插槽钩子时的安全回落（只会在测试或异常组合里用到）。 */
  const useEmptySessions = () => EMPTY_LIST
  const useEmptyStatuses = () => EMPTY_STATUSES

  /**
   * 订阅「已确认报错」表；React 18+ 用 useSyncExternalStore，旧版本退化为强制刷新。
   * @param {object} store 快照仓库。
   * @returns {object} 当前确认表。
   */
  function useAcks(store) {
    if (typeof React.useSyncExternalStore === 'function') {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot)
    }
    const [, force] = React.useState(0)
    React.useEffect(() => store.subscribe(() => force((n) => n + 1)), [store])
    return store.getSnapshot()
  }

  const CSS = [
    '.dsh-hub{display:flex;align-items:center;gap:6px;min-width:0;max-width:min(48vw,720px);overflow-x:auto;overflow-y:hidden;padding:2px 0;scrollbar-width:none;font:inherit}',
    '.dsh-hub::-webkit-scrollbar{display:none}',
    '.dsh-hub__label{flex:none;font-size:11px;line-height:1;color:var(--dsw-alias-label-secondary);letter-spacing:.04em;margin-right:2px;user-select:none;white-space:nowrap}',
    '.dsh-hub__idle{flex:none;display:inline-flex;align-items:center;height:26px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;white-space:nowrap}',
    '.dsh-hub__chip{flex:none;display:inline-flex;align-items:center;gap:6px;max-width:240px;height:26px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;cursor:pointer;transition:background .12s ease,border-color .12s ease}',
    '.dsh-hub__chip:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}',
    '.dsh-hub__chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
    '.dsh-hub__dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}',
    '.dsh-hub__chip--answer .dsh-hub__dot{background:var(--dsw-alias-state-warn-primary)}',
    '.dsh-hub__chip--error .dsh-hub__dot{background:var(--dsw-alias-state-error-primary)}',
    '.dsh-hub__chip--running .dsh-hub__dot{background:var(--dsw-alias-brand-primary);animation:dsh-hub-pulse 1.4s ease-in-out infinite}',
    '.dsh-hub__chip--unread .dsh-hub__dot{background:var(--dsw-alias-state-success-primary)}',
    '.dsh-hub__title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dsh-hub__state{flex:none;font-size:10px;line-height:1;color:var(--dsw-alias-label-secondary)}',
    '@keyframes dsh-hub-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
    '@media (prefers-reduced-motion:reduce){.dsh-hub__chip--running .dsh-hub__dot{animation:none}}',
  ].join('')

  return function SessionHubRail(props) {
    const t = typeof props?.t === 'function' ? props.t : fallbackT
    const useSessions = typeof props?.useSessions === 'function' ? props.useSessions : useEmptySessions
    const useSessionStatus = typeof props?.useSessionStatus === 'function' ? props.useSessionStatus : useEmptyStatuses
    const list = useSessions((value) => value)
    const statuses = useSessionStatus((value) => value)
    const ackErrors = useAcks(deps.acks)
    const rows = deriveHubRows({ list, statuses, ackErrors, now: Date.now() })

    const children = [h('style', { key: 'style' }, CSS)]
    children.push(h('span', { key: 'label', className: 'dsh-hub__label' }, t('label')))
    if (rows.length === 0) {
      children.push(h('span', { key: 'idle', className: 'dsh-hub__idle' }, t('idle')))
    } else {
      for (const row of rows) {
        const stateLabel = t(`state.${row.state}`)
        children.push(h('button', {
          key: row.id,
          type: 'button',
          className: `dsh-hub__chip dsh-hub__chip--${row.state}`,
          title: `${stateLabel}：${row.title}`,
          'aria-label': `${stateLabel}：${row.title}`,
          onClick: () => {
            try {
              deps.ackError(row.id, row.errorSeq)
            } catch (error) {
              console.warn('[dsh-session-hub] 确认报错失败', error)
            }
            deps.openSession(row.id)
          },
        },
        h('span', { className: 'dsh-hub__dot', 'aria-hidden': 'true' }),
        h('span', { className: 'dsh-hub__title' }, row.title),
        h('span', { className: 'dsh-hub__state' }, stateLabel)))
      }
    }

    return h('div', {
      className: 'dsh-hub',
      'data-dsh-session-hub': '',
      role: 'group',
      'aria-label': rows.length === 0 ? t('idle') : t('aria', { count: rows.length }),
    }, children)
  }
}
