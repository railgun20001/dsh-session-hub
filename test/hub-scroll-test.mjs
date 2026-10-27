/**
 * dsh-session-status-hub —— 侧栏会话行定位与滚动的纯逻辑测试。
 *
 * 运行：node --test test/hub-scroll-test.mjs
 *
 * 被测模块不碰 React / Cordis / 真实 DOM，只操作「文档桩」：
 * 断言的是外部可见行为——按 `data-row-key` 找对行、找错行时返回 null、
 * 滚动参数为垂直居中（`block: "center"`），以及一切异常都被吞掉。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SESSION_ROW_PREFIX,
  WORKSPACE_ROW_PREFIX,
  findRowByKey,
  findSessionRow,
  findWorkspaceRow,
  owningWorkspaceIdOf,
  scrollSessionRowIntoView,
} from '../src/hub-scroll.js'

/**
 * 造一个侧栏行元素桩。
 * @param {string} [key] `data-row-key` 值；省略表示没有该属性。
 * @returns {{dataset: object, calls: Array<object|undefined>, scrollIntoView: (options?: object) => void}}
 */
function row(key) {
  const calls = []
  return {
    dataset: key === undefined ? {} : { rowKey: key },
    calls,
    scrollIntoView: (options) => { calls.push(options) },
  }
}

/**
 * 造一个文档桩：`querySelectorAll` 返回给定行集合。
 * @param {Array<object>} rows 行元素。
 * @returns {{querySelectorAll: (selector: string) => Array<object>}}
 */
function docOf(rows) {
  return {
    querySelectorAll: (selector) => {
      assert.equal(selector, '[data-row-key]', '只应粗筛属性，不应把 id 拼进选择器')
      return rows
    },
  }
}

test('findRowByKey 按 dataset.rowKey 精确匹配，前缀相近不误命中', () => {
  const exact = row('session:s1')
  const doc = docOf([row('session:s10'), exact, row('workspace:w1')])
  assert.equal(findRowByKey(doc, 'session:s1'), exact)
  assert.equal(findRowByKey(doc, 'session:missing'), null)
})

test('findSessionRow / findWorkspaceRow 使用官方 data-row-key 前缀拼接', () => {
  const session = row('session:abc')
  const workspace = row('workspace:ws-1')
  const doc = docOf([workspace, session])
  assert.equal(findSessionRow(doc, 'abc'), session)
  assert.equal(findWorkspaceRow(doc, 'ws-1'), workspace)
  // 「未分组」桶的 key 是空串：`workspace:` 这一行必须能找到。
  const ungrouped = row('workspace:')
  assert.equal(findWorkspaceRow(docOf([ungrouped]), ''), ungrouped)
})

test('findRowByKey 对坏环境与坏参数一律返回 null（不抛）', () => {
  assert.equal(findRowByKey(null, 'session:1'), null)
  assert.equal(findRowByKey({}, 'session:1'), null)
  assert.equal(findRowByKey(docOf([]), ''), null)
  assert.equal(findRowByKey({ querySelectorAll: () => { throw new Error('boom') } }, 'session:1'), null)
  assert.equal(findRowByKey({ querySelectorAll: () => null }, 'session:1'), null)
  // 行本身没有 dataset 时跳过，不崩。
  assert.equal(findRowByKey(docOf([{}, { dataset: null }]), 'session:1'), null)
})

test('findSessionRow 对空会话 id 直接放弃', () => {
  assert.equal(findSessionRow(docOf([row('session:')]), ''), null)
  assert.equal(findSessionRow(docOf([row('session:s1')]), 's1').dataset.rowKey, 'session:s1')
})

test('owningWorkspaceIdOf 与官方 owningGroupKey 同口径', () => {
  const snapshot = { items: [{ workspaceId: 'w1', sessionIds: ['a', 'b'] }, { workspaceId: 'w2', sessionIds: ['c'] }] }
  assert.equal(owningWorkspaceIdOf(snapshot, 'b'), 'w1')
  assert.equal(owningWorkspaceIdOf(snapshot, 'c'), 'w2')
  // 快照可用但没有归属：官方「未分组」桶（空串），不能当成「不知道」。
  assert.equal(owningWorkspaceIdOf(snapshot, 'nope'), '')
})

test('owningWorkspaceIdOf 对缺失/异形快照返回 null（保留「不知道」）', () => {
  assert.equal(owningWorkspaceIdOf(undefined, 'a'), null)
  assert.equal(owningWorkspaceIdOf(null, 'a'), null)
  assert.equal(owningWorkspaceIdOf({}, 'a'), null)
  assert.equal(owningWorkspaceIdOf({ items: 'oops' }, 'a'), null)
  assert.equal(owningWorkspaceIdOf({ items: [] }, 'a'), '')
  assert.equal(owningWorkspaceIdOf({ items: [] }, ''), null)
  // 项里的 sessionIds 非法时跳过；workspaceId 非字符串时保守返回 null。
  assert.equal(owningWorkspaceIdOf({ items: [{ sessionIds: null }, { workspaceId: 7, sessionIds: ['a'] }] }, 'a'), null)
})

test('scrollSessionRowIntoView 命中会话行时只滚它，参数为垂直居中', () => {
  const session = row('session:s1')
  const workspace = row('workspace:w1')
  const hit = scrollSessionRowIntoView(docOf([workspace, session]), 's1', {
    workspaces: { items: [{ workspaceId: 'w1', sessionIds: ['s1'] }] },
  })
  assert.equal(hit, 'session')
  assert.deepEqual(session.calls, [{ block: 'center' }])
  assert.deepEqual(workspace.calls, [], '找到会话行时不应再碰分组行')
})

test('会话行不在 DOM（分组折叠）时退化滚动到所属工作区分组行', () => {
  const workspace = row('workspace:w1')
  const hit = scrollSessionRowIntoView(docOf([workspace]), 's1', {
    workspaces: { items: [{ workspaceId: 'w1', sessionIds: ['s1'] }] },
  })
  assert.equal(hit, 'workspace')
  assert.deepEqual(workspace.calls, [{ block: 'center' }])
})

test('会话行与分组行都找不到时返回 null，且不抛', () => {
  assert.equal(scrollSessionRowIntoView(docOf([]), 's1', { workspaces: { items: [] } }), null)
  assert.equal(scrollSessionRowIntoView(docOf([]), 's1'), null)
  assert.equal(scrollSessionRowIntoView(null, 's1'), null)
})

test('行缺少 scrollIntoView 时不抛异常，仍报告命中的行类型', () => {
  const broken = { dataset: { rowKey: 'session:s1' } }
  assert.equal(scrollSessionRowIntoView(docOf([broken]), 's1'), 'session')
})

test('滚动抛异常（宿主不支持该选项）时静默吞掉', () => {
  const throwing = {
    dataset: { rowKey: 'session:s1' },
    scrollIntoView: () => { throw new Error('not supported') },
  }
  assert.equal(scrollSessionRowIntoView(docOf([throwing]), 's1'), 'session')
})

test('前缀常量与官方 ui-workspace 的 data-row-key 约定一致', () => {
  assert.equal(SESSION_ROW_PREFIX, 'session:')
  assert.equal(WORKSPACE_ROW_PREFIX, 'workspace:')
})
