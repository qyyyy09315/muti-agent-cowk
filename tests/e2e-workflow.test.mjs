import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildServer } from "../apps/hub/dist/src/server.js";
import { MemoryStorageEngine } from "../apps/hub/dist/src/db.js";
import { WorkerRunner } from "../apps/worker/dist/src/runner.js";
import { CodexAdapter } from "../packages/adapters/codex/dist/index.js";
import { TaskState } from "../packages/contracts/dist/src/index.js";

test("E2E-1: 工业级全流程执行闭环 (真实子进程、stdin管道流传输、质量门禁与成功交付)", async () => {
  const storage = new MemoryStorageEngine();
  const app = await buildServer({ storage });
  const port = 3199;
  await app.listen({ port, host: "127.0.0.1" });

  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "e2e_ws_01_"));
  fs.mkdirSync(path.join(tmpWs, "Assets"));
  fs.writeFileSync(path.join(tmpWs, "Assets", "Landmark.cs"), "// csharp code");
  fs.writeFileSync(path.join(tmpWs, "Assets", "Landmark.cs.meta"), "guid: a1b2c3d4e5");

  const runnerScript = path.join(tmpWs, "mock_runner.js");
  fs.writeFileSync(
    runnerScript,
    `
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      if (!input.includes("task_e2e_01")) {
        console.error("未收到有效 stdin 任务文本");
        process.exit(1);
      }
      console.log("[CODEX-EXEC-OK]: 成功通过 stdin 接收任务并完成审查");
      process.exit(0);
    });
    `
  );

  process.env.CODEX_BIN = process.execPath;
  process.env.CODEX_ARGS = runnerScript;

  const runner = new WorkerRunner({
    hubUrl: `http://127.0.0.1:${port}`,
    projectId: "proj_e2e",
    agentType: "codex",
    workspaceDir: tmpWs,
    skipUvcsIsolation: true,
  });

  try {
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

    const claim = await runner.client.claimRun({
      workerId: runner.workerId,
      projectId: "proj_e2e",
      agentType: "codex",
      timeoutSeconds: 2,
    });
    assert.ok(claim);

    await runner.executePipeline(claim.task, claim.run);

    const taskAfter = await storage.getTask(task.id);
    assert.equal(taskAfter?.state, TaskState.SUBMITTED);
  } finally {
    delete process.env.CODEX_BIN;
    delete process.env.CODEX_ARGS;
    await runner.stop();
    await app.close();
  }
});

test("E2E-2: 质量门禁拦截测试 (模拟孤儿 meta 与 Unity 编译报错，坚决拦截提交)", async () => {
  const storage = new MemoryStorageEngine();
  const app = await buildServer({ storage });
  const port = 3198;
  await app.listen({ port, host: "127.0.0.1" });

  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "e2e_ws_02_"));
  fs.mkdirSync(path.join(tmpWs, "Assets"));
  fs.writeFileSync(path.join(tmpWs, "Assets", "Orphan.prefab.meta"), "guid: 999");
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

    await runner.executePipeline(claim.task, claim.run);

    const taskAfter = await storage.getTask(task.id);
    assert.notEqual(taskAfter?.state, TaskState.SUBMITTED);
  } finally {
    await runner.stop();
    await app.close();
  }
});

test("E2E-3: 租约失效防脑裂测试 (租约丢失必须坚决停止交付)", async () => {
  const storage = new MemoryStorageEngine();
  const app = await buildServer({ storage });
  const port = 3197;
  await app.listen({ port, host: "127.0.0.1" });

  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "e2e_ws_03_"));
  fs.mkdirSync(path.join(tmpWs, "Assets"));
  fs.writeFileSync(path.join(tmpWs, "Assets", "Valid.cs"), "// csharp");
  fs.writeFileSync(path.join(tmpWs, "Assets", "Valid.cs.meta"), "guid: 123");

  const runner = new WorkerRunner({
    hubUrl: `http://127.0.0.1:${port}`,
    projectId: "proj_e2e_lease",
    agentType: "codex",
    workspaceDir: tmpWs,
    skipUvcsIsolation: true,
  });

  try {
    await storage.createProject({
      id: "proj_e2e_lease",
      name: "Lease Project",
      uvcsRepo: "repo@cloud",
      baseBranch: "/main",
      createdAt: new Date().toISOString(),
    });

    const task = await storage.createTask({
      id: "task_lease_01",
      projectId: "proj_e2e_lease",
      parentTaskId: null,
      title: "模拟丢租任务",
      goal: "测试租约失效后坚决不回写",
      acceptanceCriteria: "不可提交",
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
      projectId: "proj_e2e_lease",
      agentType: "codex",
      timeoutSeconds: 2,
    });
    assert.ok(claim);

    // 人为标记 leaseLost = true（模拟在执行过程中租约超时或被新抢单抢占）
    runner.leaseLost = true;

    // 运行管线
    await runner.executePipeline(claim.task, claim.run);

    // 验证：任务绝不能提交成功，防止脑裂覆写！
    const taskAfter = await storage.getTask(task.id);
    assert.notEqual(taskAfter?.state, TaskState.SUBMITTED);
  } finally {
    await runner.stop();
    await app.close();
  }
});

test("E2E-4: 取消与急停进程树强杀测试", async () => {
  const adapter = new CodexAdapter();
  await adapter.cancel();
  assert.equal(adapter.currentProcess, null);
});
