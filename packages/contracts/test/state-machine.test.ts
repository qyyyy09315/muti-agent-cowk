import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TaskState,
  isValidStateTransition,
  isTaskActive,
  TERMINAL_STATES,
} from "../src/state-machine.js";

test("state machine valid transitions", () => {
  // 正常主流程
  assert.equal(isValidStateTransition(TaskState.QUEUED, TaskState.LEASED), true);
  assert.equal(isValidStateTransition(TaskState.LEASED, TaskState.RUNNING), true);
  assert.equal(isValidStateTransition(TaskState.RUNNING, TaskState.SUBMITTED), true);
  assert.equal(isValidStateTransition(TaskState.SUBMITTED, TaskState.REVIEWING), true);
  assert.equal(isValidStateTransition(TaskState.REVIEWING, TaskState.COMPLETED), true);

  // 审查发现缺陷进入 needs_changes，再重新入队派生
  assert.equal(isValidStateTransition(TaskState.REVIEWING, TaskState.NEEDS_CHANGES), true);
  assert.equal(isValidStateTransition(TaskState.NEEDS_CHANGES, TaskState.QUEUED), true);

  // 等待对端 / 人工及恢复
  assert.equal(isValidStateTransition(TaskState.RUNNING, TaskState.WAITING_PEER), true);
  assert.equal(isValidStateTransition(TaskState.WAITING_PEER, TaskState.RUNNING), true);
  assert.equal(isValidStateTransition(TaskState.LEASED, TaskState.WAITING_PEER), true);
  assert.equal(isValidStateTransition(TaskState.WAITING_PEER, TaskState.QUEUED), true);
  assert.equal(isValidStateTransition(TaskState.RUNNING, TaskState.WAITING_HUMAN), true);
  assert.equal(isValidStateTransition(TaskState.WAITING_HUMAN, TaskState.RUNNING), true);

  // 暂停与取消
  assert.equal(isValidStateTransition(TaskState.RUNNING, TaskState.PAUSED), true);
  assert.equal(isValidStateTransition(TaskState.PAUSED, TaskState.RUNNING), true);
  assert.equal(isValidStateTransition(TaskState.RUNNING, TaskState.CANCELLED), true);
});

test("state machine invalid transitions blocked", () => {
  // 禁止从已完成/终态任意跳转
  assert.equal(isValidStateTransition(TaskState.COMPLETED, TaskState.RUNNING), false);
  assert.equal(isValidStateTransition(TaskState.FAILED, TaskState.QUEUED), false);
  assert.equal(isValidStateTransition(TaskState.CANCELLED, TaskState.LEASED), false);

  // 禁止跨状态跳跃
  assert.equal(isValidStateTransition(TaskState.QUEUED, TaskState.COMPLETED), false);
  assert.equal(isValidStateTransition(TaskState.LEASED, TaskState.COMPLETED), false);
});

test("isTaskActive correctly reflects terminal state", () => {
  assert.equal(isTaskActive(TaskState.QUEUED), true);
  assert.equal(isTaskActive(TaskState.RUNNING), true);
  assert.equal(isTaskActive(TaskState.REVIEWING), true);

  for (const terminal of TERMINAL_STATES) {
    assert.equal(isTaskActive(terminal), false);
  }
});
