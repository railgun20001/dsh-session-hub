/**
 * 状态栏 / 任务栏纯逻辑单测。
 *
 * 运行：node --test test/hub-model-test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  aggregateTaskbarState,
  currentSessionIdOf,
  deriveHubRows,
  isUnackedFailure,
  normalizeAckErrors,
  projectionOf,
} from '../src/hub-model.js'

/**
 * 造一个会话行。
 * @param {string} id 会话 id。
 * @param {object} [patch] 覆盖字段。
 * @returns {object} 会话行。
 */
function row(id, patch = {}) {
  return { id, displayTitle: `会话 ${id}`, running: false, blank: false, updatedAt: 1, ...patch }
}

/**
 * 造一个回合结局投影。
 * @param {number} seq 事件序号。
 * @param {string} outcome 结局。
 * @returns {object} 投影值。
 */
function outcome(seq, outcomeKind) {
  return { outcome: outcomeKind, turn: seq, seq, time: 1_700_000_000_000, code: null, message: null }
}

/**
 * 造一个会话列表快照。
 * @param {object[]} rows 会话行。
 * @param {object} [projections] 每个会话的投影值。
 * @returns {object} 列表快照。
 */
function listOf(rows, projections = {}) {
  return {
    byId: Object.fromEntries(rows.map((item) => [item.id, item])),
    projectionsBySession: Object.fromEntries(Object.entries(projections).map(([id, value]) => [id, { values: { hubTurnOutcome: value } }])),
  }
}

test('四类状态都能推导出来', () => {
  const list = listOf([
    row('answer'),
    row('error'),
    row('running', { running: true }),
    row('unread'),
  ], {
    answer: outcome(3, 'completed'),
    error: outcome(4, 'error'),
    running: outcome(5, 'completed'),
    unread: outcome(6, 'completed'),
  })
  const statuses = new Map([
    ['answer', { pendingInteraction: { kind: 'question' } }],
    ['unread', { completionUnread: true }],
  ])
  const rows = deriveHubRows({ list, statuses })
  assert.deepEqual(rows.map((item) => [item.id, item.state]), [
    ['answer', 'answer'],
    ['error', 'error'],
    ['running', 'running'],
    ['unread', 'unread'],
  ])
})

test('优先级：等待回答 > 报错 > 运行中 > 待查看', () => {
  const list = listOf([
    row('unread', { updatedAt: 100 }),
    row('running', { running: true, updatedAt: 200 }),
    row('error', { updatedAt: 300 }),
    row('answer', { updatedAt: 1 }),
  ], { error: outcome(2, 'interrupted') })
  const statuses = new Map([
    ['answer', { pendingInteraction: { kind: 'approval' } }],
    ['unread', { completionUnread: true }],
  ])
  assert.deepEqual(deriveHubRows({ list, statuses }).map((item) => item.id), [
    'answer', 'error', 'running', 'unread',
  ])
})

test('空白会话与子代理会话默认不进入状态栏', () => {
  const list = listOf([
    row('blank', { blank: true }),
    row('sub', { origin: 'subagent', running: true }),
    row('normal', { running: true }),
  ])
  assert.deepEqual(deriveHubRows({ list, statuses: new Map() }).map((item) => item.id), ['normal'])
  assert.deepEqual(
    deriveHubRows({ list, statuses: new Map(), includeSubagents: true }).map((item) => item.id).sort(),
    ['normal', 'sub'],
  )
})

test('已确认的报错不再显示，新 seq 会重新出现', () => {
  const list = listOf([row('s1')], { s1: outcome(7, 'error') })
  assert.equal(deriveHubRows({ list, statuses: new Map() }).length, 1)
  assert.equal(deriveHubRows({ list, statuses: new Map(), ackErrors: { s1: 7 } }).length, 0)
  assert.equal(deriveHubRows({ list, statuses: new Map(), ackErrors: { s1: 6 } }).length, 1)
  assert.equal(isUnackedFailure(outcome(7, 'completed'), 0), false)
  assert.equal(isUnackedFailure(outcome(7, 'interrupted'), 6), true)
})

test('任务栏聚合遵守红 > 黄 > 绿 > 无', () => {
  assert.equal(aggregateTaskbarState([]), 'none')
  assert.equal(aggregateTaskbarState([{ state: 'unread' }]), 'green')
  assert.equal(aggregateTaskbarState([{ state: 'running' }]), 'green')
  assert.equal(aggregateTaskbarState([{ state: 'running' }, { state: 'answer' }]), 'yellow')
  assert.equal(aggregateTaskbarState([{ state: 'answer' }, { state: 'error' }]), 'red')
  assert.equal(aggregateTaskbarState([{ state: 'error' }, { state: 'unread' }]), 'red')
})

test('投影优先从 projectionsBySession 读，兼容单行 projectionValues', () => {
  const list = listOf([row('s1')], { s1: outcome(3, 'error') })
  assert.equal(projectionOf(list, 's1').seq, 3)
  const fallback = { byId: { s2: row('s2', { projectionValues: { hubTurnOutcome: outcome(4, 'interrupted') } }) } }
  assert.equal(projectionOf(fallback, 's2').outcome, 'interrupted')
  assert.equal(projectionOf(list, 'missing'), undefined)
})

test('当前会话由 retainedBy.mainView 判定', () => {
  const list = listOf([
    row('a'),
    row('b', { retainedBy: { mainView: 1 } }),
  ])
  assert.equal(currentSessionIdOf(list), 'b')
  assert.equal(currentSessionIdOf({ byId: {} }), undefined)
})

test('确认表归一化只保留合法整数', () => {
  assert.deepEqual(normalizeAckErrors({ a: 3, b: -1, c: 'x', d: 1.5 }), { a: 3 })
  assert.deepEqual(normalizeAckErrors(null), {})
  assert.deepEqual(normalizeAckErrors([1, 2]), {})
})
