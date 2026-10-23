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
 * 极简文案函数工厂：只在 locale 服务缺失时使用。
 *
 * @param {object} dict 键 → 文案。
 * @returns {(key: string, params?: object) => string} 文案函数。
 */
function createFallbackT(dict) {
  return (key, params) => {
    const text = dict[key] ?? key
    return params === undefined ? text : text.replace(/\{(\w+)\}/g, (match, name) => String(params[name] ?? match))
  }
}

/**
 * 创建状态栏组件。
 * @param {object} React React 运行时（由客户端模块表提供）。
 * @param {{
 *   openSession: (sessionId: string) => void,
 *   ackError: (sessionId: string, seq: number|null) => void,
 *   acks: { subscribe: (listener: () => void) => () => void, getSnapshot: () => object },
 * }} deps 由 client-main 注入的动作与确认表。
 * @param {'header'|'chrome'} [variant] 渲染位置：会话标题前，或 Windows 顶栏菜单之后。
 * @returns {Function} React 函数组件。
 */
function createSessionHubRail(React, deps, variant = 'header') {
  const h = React.createElement
  const EMPTY_LIST = { byId: {}, projectionsBySession: {} }
  const EMPTY_STATUSES = new Map()

  /** 文案回落：插槽没有绑定 locale 时也能显示中文。 */
  const FALLBACK = {
    label: '会话',
    idle: '全部空闲',
    aria: '会话状态：{count} 个需要关注',
    more: '还有 {count} 个会话',
    collapse: '收起',
    'state.answer': '等待回答',
    'state.error': '报错',
    'state.running': '运行中',
    'state.unread': '待查看',
  }

  const fallbackT = createFallbackT(FALLBACK)

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
    '.dsh-hub{display:flex;align-items:center;gap:6px;min-width:0;max-width:min(46vw,700px);overflow-x:auto;overflow-y:hidden;padding:2px 4px 2px 0;scrollbar-width:none;font:inherit}',
    '.dsh-hub::-webkit-scrollbar{display:none}',
    '.dsh-hub__label{flex:none;font-size:11px;line-height:1;color:var(--dsw-alias-label-secondary);letter-spacing:.04em;margin-right:2px;user-select:none;white-space:nowrap}',
    '.dsh-hub__idle{flex:none;display:inline-flex;align-items:center;height:26px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;white-space:nowrap}',
    '.dsh-hub__chip{flex:none;display:inline-flex;align-items:center;gap:6px;max-width:190px;height:26px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;cursor:pointer;transition:background .12s ease,border-color .12s ease}',
    '.dsh-hub__chip:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}',
    '.dsh-hub__chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
    '.dsh-hub__dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}',
    '.dsh-hub__chip--answer .dsh-hub__dot{background:var(--dsw-alias-state-warn-primary)}',
    '.dsh-hub__chip--error .dsh-hub__dot{background:var(--dsw-alias-state-error-primary)}',
    '.dsh-hub__chip--running .dsh-hub__dot{background:var(--dsw-static-blue-400,#60a5fa);animation:dsh-hub-pulse 1.4s ease-in-out infinite}',
    '.dsh-hub__chip--unread .dsh-hub__dot{background:var(--dsw-alias-state-success-primary)}',
    '.dsh-hub__title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dsh-hub__state{flex:none;font-size:10px;line-height:1;color:var(--dsw-alias-label-secondary)}',
    '.dsh-hub__more{flex:none;display:inline-flex;align-items:center;height:26px;padding:0 9px;border:1px dashed var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:1;cursor:pointer;white-space:nowrap}',
    '.dsh-hub__more:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
    '.dsh-hub__more:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
    // Windows 顶栏变体：fixed 在「应用 / 编辑」菜单之后，高度跟随原生顶栏（40px）。
    // --dsh-windows-menu-start 由侧栏发布（展开 48px / 收起 84px）；菜单本体约 100px。
    '.dsh-hub--chrome{position:fixed;top:0;left:calc(var(--dsh-windows-menu-start,48px) + 108px);height:var(--dsh-windows-titlebar-height,40px);max-width:calc(100vw - 460px);padding:0 8px 0 0;gap:4px;z-index:1090;pointer-events:auto;-webkit-app-region:no-drag}',
    '.dsh-hub--chrome .dsh-hub__chip,.dsh-hub--chrome .dsh-hub__idle,.dsh-hub--chrome .dsh-hub__more{height:24px;padding:0 8px;font-size:11px;background:var(--dsw-specific-sidebar-fill)}',
    '.dsh-hub--chrome .dsh-hub__chip{max-width:180px}',
    '.dsh-hub--chrome .dsh-hub__label{font-size:11px}',
    '.dsh-hub--chrome .dsh-hub__state{font-size:9px}',
    'html:not([data-windows-titlebar]) .dsh-hub--chrome{display:none}',
    'html[data-windows-titlebar] .dsh-hub--header{display:none}',
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
    const [expanded, setExpanded] = React.useState(false)
    const visibleRows = expanded ? rows : rows.slice(0, 3)
    const hiddenCount = rows.length - visibleRows.length

    const children = [h('style', { key: 'style' }, CSS)]
    children.push(h('span', { key: 'label', className: 'dsh-hub__label' }, t('label')))
    if (rows.length === 0) {
      children.push(h('span', { key: 'idle', className: 'dsh-hub__idle' }, t('idle')))
    } else {
      for (const row of visibleRows) {
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
            // 点击 chip 时窗口本来就在前台：只做应用内跳转，不请求窗口前置，
            // 避免触发 Win32 的窗口状态处理（最大化被 SW_RESTORE 打回普通尺寸）。
            deps.openSession(row.id, { raise: false })
          },
        },
        h('span', { className: 'dsh-hub__dot', 'aria-hidden': 'true' }),
        h('span', { className: 'dsh-hub__title' }, row.title),
        h('span', { className: 'dsh-hub__state' }, stateLabel)))
      }
      if (hiddenCount > 0) {
        children.push(h('button', {
          key: 'more',
          type: 'button',
          className: 'dsh-hub__more',
          title: t('more', { count: hiddenCount }),
          'aria-label': t('more', { count: hiddenCount }),
          onClick: () => setExpanded(true),
        }, `+${hiddenCount}`))
      } else if (expanded && rows.length > 3) {
        children.push(h('button', {
          key: 'collapse',
          type: 'button',
          className: 'dsh-hub__more',
          onClick: () => setExpanded(false),
        }, t('collapse')))
      }
    }

    return h('div', {
      className: `dsh-hub dsh-hub--${variant}`,
      'data-dsh-session-hub': variant,
      role: 'group',
      'aria-label': rows.length === 0 ? t('idle') : t('aria', { count: rows.length }),
    }, children)
  }
}

/**
 * 创建「会话行悬停卡片里的失败提示」组件。
 *
 * ## 为什么需要它
 *
 * 侧栏会话行首那个圆点由官方 ui-workspace / ui-session 决定，只有四种：
 * 等待交互（黄）、运行中（蓝）、未读完成（绿）、空闲（不画）。它**没有「失败」态**，
 * 而 ui-session 在「running → 停止」时一律把会话记成 `completionUnread`，于是
 * **一轮因报错/中断结束的会话，行首也会显示成绿色的「已完成」**。
 *
 * 插件不能改写官方行状态机（`sidebar.session.row.leading` 只在空闲时才轮到插件渲染），
 * 所以这里用我们能控制的最近一个位置把真相补上：`sidebar.session.row.hover` 是行悬停
 * 卡片的内容位（list 插槽），在这里加一行红色提示，鼠标停在行上就能看到
 * 「本轮失败 / 本轮中断」，不会与官方绿点打架，也不去碰别人的 DOM。
 *
 * ## 数据来源
 *
 * 只读插槽标准 props：`useSessions`（会话列表快照）与 `t`；再加本插件自己的
 * 「已确认报错」表（`deps.acks`）。判据与状态栏完全一致（`failureKindOf`）。
 *
 * @param {object} React React 运行时。
 * @param {{ acks: { subscribe: (listener: () => void) => () => void, getSnapshot: () => object } }} deps
 *   本插件的确认表。
 * @returns {Function} React 函数组件。
 */
function createSessionHubRowHint(React, deps) {
  const h = React.createElement
  const EMPTY_LIST = { byId: {}, projectionsBySession: {} }
  const useEmptySessions = () => EMPTY_LIST
  const fallbackT = createFallbackT({
    'row.failed': '本轮失败',
    'row.interrupted': '本轮中断',
    'row.hint': '该会话最后一轮没有正常结束',
  })

  /**
   * 订阅「已确认报错」表。
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
    '.dsh-hub-hint{display:flex;align-items:center;gap:6px;min-width:0;font:inherit;font-size:12px;line-height:1.3;color:var(--dsw-alias-label-primary)}',
    '.dsh-hub-hint__dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-error-primary)}',
    '.dsh-hub-hint__text{flex:none}',
    '.dsh-hub-hint__detail{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary)}',
  ].join('')

  return function SessionHubRowHint(props) {
    const t = typeof props?.t === 'function' ? props.t : fallbackT
    const useSessions = typeof props?.useSessions === 'function' ? props.useSessions : useEmptySessions
    const list = useSessions((value) => value)
    const ackErrors = useAcks(deps.acks)
    const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : undefined
    if (sessionId === undefined) return null

    const projection = projectionOf(list, sessionId)
    const acked = Number.isInteger(ackErrors[sessionId]) ? ackErrors[sessionId] : -1
    const kind = failureKindOf(projection, acked)
    if (kind === null) return null

    const label = t(kind === 'interrupted' ? 'row.interrupted' : 'row.failed')
    const detail = typeof projection?.code === 'string' && projection.code !== '' ? projection.code : ''

    return h('div', {
      className: 'dsh-hub-hint',
      'data-dsh-session-hub-hint': kind,
      title: t('row.hint'),
      role: 'status',
    }, [
      h('style', { key: 'style' }, CSS),
      h('span', { key: 'dot', className: 'dsh-hub-hint__dot', 'aria-hidden': 'true' }),
      h('span', { key: 'text', className: 'dsh-hub-hint__text' }, label),
      detail === '' ? null : h('span', { key: 'detail', className: 'dsh-hub-hint__detail' }, detail),
    ])
  }
}
