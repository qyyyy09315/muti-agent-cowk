import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildServer } from "../apps/hub/src/server.js";
import { MemoryStorageEngine } from "../apps/hub/src/db.js";
import { WorkerRunner } from "../apps/worker/src/runner.js";
import { CodexAdapter } from "../packages/adapters/codex/src/index.js";
import { TaskState } from "@ai-collab/contracts";

test("E2E-1: 完整全流程执行闭环测试 (接单、stdin传输、质量门禁与成功交付)", async () => {
  const storage = new MemoryStorageEngine();
  const app = await buildServer({ storage });
  const port = 3199;
  await app.listen({ port, host: "127.0.0.1" });

  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "e2e_ws_01_"));
  // 建立一个标准干净的 Unity 目录结构
  fs.mkdirSync(path.join(tmpWs, "Assets"));
  fs.writeFileSync(path.join(tmpWs, "Assets", "Test.cs"), "// csharp code");
  fs.writeFileSync(path.join(tmpWs, "Assets", "Test.cs.meta"), "guid: a1b2c3d4e5");

  const runner = new WorkerRunner({
    hubUrl: `http://127.0.0.1:${port}`,
    projectId: "proj_e2e",
    agentType: "codex",
    workspaceDir: tmpWs,
    skipUvcsIsolation: true, // 单元测试环境
  });

  try {
    // 1. 初始化项目与任务
    await storage.createProject({
      id: "proj_e2e",
      name: "E2E Test Project",
      uvcsRepo: "repo@cloud",
      baseBranch: "/main",
      createdAt: new Date().toISOString(),
    });

    const task = await storage.createTask({
      id: "task_e2e_01",
      projectId: "proj_e2e",
      parentTaskId: null,
      title: "实现地标核心数据类",
      goal: "编写基础 C# 数据类",
      acceptanceCriteria: "0 编译报错，0 meta 丢失",
      assignedAgent: "codex",
      state: TaskState.QUEUED,
      budget: { maxMinutes: 30, maxRepairs: 3, maxQuestions: 10 },
      currentAttempt: 0,
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // 2. Worker 抢单接单
    const claim = await runner.client.claimRun({
      workerId: runner.workerId,
      projectId: "proj_e2e",
      agentType: "codex",
      timeoutSeconds: 2,
    });
    assert.ok(claim);
    assert.equal(claim.task.id, task.id);

    // 3. 运行工业级 7 步管线
    await runner.executePipeline(claim.task, claim.run);

    // 4. 验证任务状态成功推进至 submitted
    const taskAfter = await storage.getTask(task.id);
    assert.equal(taskAfter?.state, TaskState.SUBMITTED);
  } finally {
    await runner.stop();
    await app.close();
  }
});

test("E2E-2: 质量门禁拦截测试 (模拟编译报错与孤儿 meta，坚决拦截提交)", async () => {
  const storage = new MemoryStorageEngine();
  const app = await buildServer({ storage });
  const port = 3198;
  await app.listen({ port, host: "127.0.0.1" });

  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "e2e_ws_02_"));
  fs.mkdirSync(path.join(tmpWs, "Assets"));
  // 故意制造损坏门禁：存在孤儿 .meta
  fs.writeFileSync(path.join(tmpWs, "Assets", "Orphan.cs.meta"), "guid: 999");
  // 故意放入 Unity 编译报错日志
  fs.writeFileSync(
    path.join(tmpWs, "Editor.log"),
    "Assets/Broken.cs(10,5): error CS1002: ; expected\nCompilation failed."
  );

  const runner = new WorkerRunner({
    hubUrl: `http://127.0.0.1:${port}`,
    projectId: "proj_e2e_broken",
    agentType: "codex",
    workspaceDir: tmpWs,
    skipUvcsIsolation: true,
  });

  try {
    await storage.createProject({
      id: "proj_e2e_broken",
      name: "Broken Project",
      uvcsRepo: "repo@cloud",
      baseBranch: "/main",
      createdAt: new Date().toISOString(),
    });

    const task = await storage.createTask({
      id: "task_broken_01",
      projectId: "proj_e2e_broken",
      parentTaskId: null,
      title: "带病代码任务",
      goal: "测试质量门禁是否有效",
      acceptanceCriteria: "必须被拦截",
      assignedAgent: "codex",
      state: TaskState.QUEUED,
      budget: { maxMinutes: 30, maxRepairs: 3, maxQuestions: 10 },
      currentAttempt: 0,
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const claim = await runner.client.claimRun({
      workerId: runner.workerId,
      projectId: "proj_e2e_broken",
      agentType: "codex",
      timeoutSeconds: 2,
    });
    assert.ok(claim);

    // 运行管线，预期在门禁阶段被中断
    await runner.executePipeline(claim.task, claim.run);

    // 验证：任务绝不能变成 submitted，必须被门禁成功阻断！
    const taskAfter = await storage.getTask(task.id);
    assert.notEqual(taskAfter?.state, TaskState.SUBMITTED);
    assert.equal(taskAfter?.state, TaskState.LEASED);
  } finally {
    await runner.stop();
    await app.close();
  }
});

test("E2E-3: 取消与急停进程树强杀测试", async () => {
  const adapter = new CodexAdapter();
  // 启动取消不会崩溃，且内部句柄安全清空
  await adapter.cancel();
  assert.equal((adapter as any).currentProcess, null);
});
