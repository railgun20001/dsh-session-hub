/**
 * 状态栏 React 组件单测（不依赖真实 React）。
 *
 * 用最小 React 桩执行 src/hub-ui.js 里的组件工厂，断言：
 *   - 四类状态都渲染成对应的 chip 与中文短标签；
 *   - 空状态渲染「全部空闲」；
 *   - 点击 chip 会先确认报错、再打开对应会话；
 *   - 组件只使用官方标准 props（useSessions / useSessionStatus），不读 DOM。
 *
 * 运行：node --test test/hub-ui-test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { deriveHubRows, STATE_LABELS } from '../src/hub-model.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, '..', 'src', 'hub-ui.js'), 'utf8')

/**
 * 最小 React 桩：createElement 产出普通对象，hooks 直接求值。
 * @returns {object} React 桩。
 */
function reactStub() {
  return {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
    }),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
  }
}

/**
 * 载入组件工厂。
 * @returns {Function} createSessionHubRail。
 */
function loadFactory() {
  // eslint-disable-next-line no-new-func
  return new Function('deriveHubRows', 'STATE_LABELS', `${SOURCE}\nreturn createSessionHubRail`)(
    deriveHubRows,
    STATE_LABELS,
  )
}

/**
 * 找到第一个满足条件的节点。
 * @param {object} node 根节点。
 * @param {(node: object) => boolean} predicate 条件。
 * @returns {object|undefined} 节点。
 */
function findNode(node, predicate) {
  if (node === null || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * 收集节点树里的全部文本。
 * @param {object} node 根节点。
 * @returns {string[]} 文本片段。
 */
function collectText(node) {
  if (node === null || node === undefined) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap((child) => collectText(child))
  return (node.children ?? []).flatMap((child) => collectText(child))
}

/**
 * 造一个会话行。
 * @param {string} id 会话 id。
 * @param {object} [patch] 覆盖字段。
 * @returns {object} 会话行。
 */
function row(id, patch = {}) {
  return { id, displayTitle: `会话 ${id}`, title: `会话 ${id}`, running: false, blank: false, updatedAt: 1, ...patch }
}

test('四类状态渲染成 chip，空状态渲染「全部空闲」', () => {
  const Rail = loadFactory()(reactStub(), {
    openSession: () => {},
    ackError: () => {},
    acks: { subscribe: () => () => {}, getSnapshot: () => ({}) },
  })
  const list = {
    byId: {
      a: row('a', { running: true }),
      b: row('b'),
      c: row('c'),
      d: row('d'),
    },
    projectionsBySession: {
      b: { values: { hubTurnOutcome: { outcome: 'error', seq: 3, turn: 1, time: 1, code: null, message: null } } },
      c: { values: { hubTurnOutcome: null } },
      d: { values: { hubTurnOutcome: null } },
    },
  }
  const statuses = new Map([
    ['a', { pendingInteraction: { kind: 'question' } }],
    ['d', { completionUnread: true }],
  ])
  const tree = Rail({
    useSessions: (selector) => selector(list),
    useSessionStatus: (selector) => selector(statuses),
  })
  const text = collectText(tree).join('|')
  assert.match(text, /会话/)
  assert.match(text, /等待回答/)
  assert.match(text, /报错/)
  assert.match(text, /待查看/)
  assert.doesNotMatch(text, /全部空闲/)

  const empty = Rail({
    useSessions: (selector) => selector({ byId: {}, projectionsBySession: {} }),
    useSessionStatus: (selector) => selector(new Map()),
  })
  assert.match(collectText(empty).join('|'), /全部空闲/)
})

test('点击 chip：先确认该条目的报错 seq，再打开会话', () => {
  const opened = []
  const acked = []
  const Rail = loadFactory()(reactStub(), {
    openSession: (id) => opened.push(id),
    ackError: (id, seq) => acked.push([id, seq]),
    acks: { subscribe: () => () => {}, getSnapshot: () => ({}) },
  })
  const list = {
    byId: { s1: row('s1') },
    projectionsBySession: {
      s1: { values: { hubTurnOutcome: { outcome: 'error', seq: 7, turn: 1, time: 1, code: null, message: null } } },
    },
  }
  const tree = Rail({
    useSessions: (selector) => selector(list),
    useSessionStatus: (selector) => selector(new Map()),
  })
  const chip = findNode(tree, (node) => typeof node.props?.className === 'string'
    && node.props.className.includes('dsh-hub__chip--error'))
  assert.ok(chip !== undefined, '应当渲染报错 chip')
  chip.props.onClick()
  assert.deepEqual(acked, [['s1', 7]])
  assert.deepEqual(opened, ['s1'])
})

test('已确认的报错不再渲染 chip', () => {
  const Rail = loadFactory()(reactStub(), {
    openSession: () => {},
    ackError: () => {},
    acks: { subscribe: () => () => {}, getSnapshot: () => ({ s1: 7 }) },
  })
  const list = {
    byId: { s1: row('s1') },
    projectionsBySession: {
      s1: { values: { hubTurnOutcome: { outcome: 'error', seq: 7, turn: 1, time: 1, code: null, message: null } } },
    },
  }
  const tree = Rail({
    useSessions: (selector) => selector(list),
    useSessionStatus: (selector) => selector(new Map()),
  })
  assert.equal(findNode(tree, (node) => typeof node.props?.className === 'string'
    && node.props.className.includes('dsh-hub__chip')), undefined)
  assert.match(collectText(tree).join('|'), /全部空闲/)
})

test('chrome 变体带 fixed 顶栏类与菜单偏移 CSS', () => {
  const factory = loadFactory()
  const Rail = factory(reactStub(), {
    openSession: () => {},
    ackError: () => {},
    acks: { subscribe: () => () => {}, getSnapshot: () => ({}) },
  }, 'chrome')
  const list = { byId: { s1: row('s1', { running: true }) }, projectionsBySession: {} }
  const tree = Rail({
    useSessions: (selector) => selector(list),
    useSessionStatus: (selector) => selector(new Map()),
  })
  assert.match(tree.props.className, /dsh-hub--chrome/)
  const style = tree.children[0]
  assert.match(style.children[0], /position:fixed/)
  assert.match(style.children[0], /--dsh-windows-menu-start/)
})
