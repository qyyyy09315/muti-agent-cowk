import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CreateTaskInputSchema,
  ClaimRunInputSchema,
  SendMessageInputSchema,
  TaskSchema,
  TaskState,
} from "../src/index.js";

test("CreateTaskInputSchema validates correct task payload", () => {
  const valid = {
    projectId: "proj_unity_01",
    title: "实现地标展示面板 Prefab",
    goal: "在独立 Prefab 中增加地标图片与文字介绍",
    acceptanceCriteria: "Unity EditMode 测试通过且无 Missing Script",
    assignedAgent: "codex" as const,
  };
  const parsed = CreateTaskInputSchema.parse(valid);
  assert.equal(parsed.title, valid.title);
  assert.equal(parsed.assignedAgent, "codex");
});

test("CreateTaskInputSchema rejects empty fields", () => {
  assert.throws(() => {
    CreateTaskInputSchema.parse({
      projectId: "",
      title: "",
      goal: "",
      acceptanceCriteria: "",
    });
  });
});

test("ClaimRunInputSchema bounds timeoutSeconds", () => {
  assert.throws(() => {
    ClaimRunInputSchema.parse({
      workerId: "w1",
      projectId: "p1",
      agentType: "grok",
      timeoutSeconds: 60, // 超过最大 30 秒
    });
  });

  const ok = ClaimRunInputSchema.parse({
    workerId: "w1",
    projectId: "p1",
    agentType: "grok",
    timeoutSeconds: 20,
  });
  assert.equal(ok.timeoutSeconds, 20);
});

test("SendMessageInputSchema requires idempotencyKey", () => {
  assert.throws(() => {
    SendMessageInputSchema.parse({
      projectId: "p1",
      taskId: "t1",
      threadId: "th1",
      fromAgent: "grok",
      toAgent: "codex",
      content: "请教组件绑定规范",
      // missing idempotencyKey
    });
  });
});
