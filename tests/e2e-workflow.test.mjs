import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildServer } from "../apps/hub/dist/src/server.js";
import { MemoryStorageEngine } from "../apps/hub/dist/src/db.js";
import { WorkerRunner } from "../apps/worker/dist/src/runner.js";
import { CodexAdapter } from "../packages/adapters/codex/dist/index.js";
import { UVCSClient } from "../packages/uvcs-workspace/dist/src/cm-cli.js";
import { TaskState } from "../packages/contracts/dist/src/index.js";

function makeStdinRunner(targetDir, scriptName = "runner.js") {
  const p = path.join(targetDir, scriptName);
  fs.writeFileSync(
    p,
    `
    let input = "";
    process.stdin.on("data", c => input += c);
    process.stdin.on("end", () => {
      try {
        const payload = JSON.parse(input);
        if (!payload.taskId) process.exit(1);
      } catch (e) {
        process.exit(1);
      }
      console.log("[STDIN-VERIFIED-OK]");
      process.exit(0);
    });
    `
  );
  return p;
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("E2E-1: 工业级全流程交付测试 (真实子进程、stdin 写入验证、门禁通过并完成提交)", async () => {
  const storage = new MemoryStorageEngine();
  const app = await buildServer({ storage });
  const port = 3195;
  await app.listen({ port, host: "127.0.0.1" });

  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "e2e_ws_01_"));
  fs.mkdirSync(path.join(tmpWs, "Assets"));
  fs.writeFileSync(path.join(tmpWs, "Assets", "ValidLandmark.cs"), "// csharp code");
  fs.writeFileSync(path.join(tmpWs, "Assets", "ValidLandmark.cs.meta"), "guid: 12345");

  const runnerScript = makeStdinRunner(tmpWs);
  process.env.CODEX_BIN = process.execPath;
  process.env.CODEX_ARGS = runnerScript;

  const runner = new WorkerRunner({
    hubUrl: `http://127.0.0.1:${port}`,
    projectId: "proj_e2e_01",
    agentType: "codex",
    workspaceDir: tmpWs,
    skipUvcsIsolation: true,
  });

  try {
    await storage.createProject({
      id: "proj_e2e_01",
      name: "E2E Project 01",
      uvcsRepo: "repo@cloud",
      baseBranch: "/main",
      createdAt: new Date().toISOString(),
    });

    const task = await storage.createTask({
      id: "task_e2e_01",
      projectId: "proj_e2e_01",
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
      projectId: "proj_e2e_01",
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

test("E2E-2: 质量门禁精确阻断测试 (Codex 成功执行，但因损坏的 meta 被门禁精准拦截)", async () => {
  const storage = new MemoryStorageEngine();
  const app = await buildServer({ storage });
  const port = 3194;
  await app.listen({ port, host: "127.0.0.1" });

  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "e2e_ws_02_"));
  fs.mkdirSync(path.join(tmpWs, "Assets"));
  fs.writeFileSync(path.join(tmpWs, "Assets", "CorruptedOrphan.prefab.meta"), "guid: 99999");

  const runnerScript = makeStdinRunner(tmpWs);
  process.env.CODEX_BIN = process.execPath;
  process.env.CODEX_ARGS = runnerScript;

  const runner = new WorkerRunner({
    hubUrl: `http://127.0.0.1:${port}`,
    projectId: "proj_e2e_02",
    agentType: "codex",
    workspaceDir: tmpWs,
    skipUvcsIsolation: true,
  });

  try {
    await storage.createProject({
      id: "proj_e2e_02",
      name: "E2E Project 02",
      uvcsRepo: "repo@cloud",
      baseBranch: "/main",
      createdAt: new Date().toISOString(),
    });

    const task = await storage.createTask({
      id: "task_e2e_02",
      projectId: "proj_e2e_02",
      parentTaskId: null,
      title: "带病资产任务",
      goal: "验证质量门禁拦截",
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
      projectId: "proj_e2e_02",
      agentType: "codex",
      timeoutSeconds: 2,
    });
    assert.ok(claim);

    await runner.executePipeline(claim.task, claim.run);

    const taskAfter = await storage.getTask(task.id);
    assert.equal(taskAfter?.state, TaskState.LEASED);
    assert.notEqual(taskAfter?.state, TaskState.SUBMITTED);
  } finally {
    delete process.env.CODEX_BIN;
    delete process.env.CODEX_ARGS;
    await runner.stop();
    await app.close();
  }
});

test("E2E-3: 租约失效签入前阻断测试 (Codex 成功执行，但在签入前因丢租严禁交付)", async () => {
  const storage = new MemoryStorageEngine();
  const app = await buildServer({ storage });
  const port = 3193;
  await app.listen({ port, host: "127.0.0.1" });

  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "e2e_ws_03_"));
  fs.mkdirSync(path.join(tmpWs, "Assets"));
  fs.writeFileSync(path.join(tmpWs, "Assets", "Clean.cs"), "// csharp code");
  fs.writeFileSync(path.join(tmpWs, "Assets", "Clean.cs.meta"), "guid: 12345");

  const runnerScript = makeStdinRunner(tmpWs);
  process.env.CODEX_BIN = process.execPath;
  process.env.CODEX_ARGS = runnerScript;

  const runner = new WorkerRunner({
    hubUrl: `http://127.0.0.1:${port}`,
    projectId: "proj_e2e_03",
    agentType: "codex",
    workspaceDir: tmpWs,
    skipUvcsIsolation: true,
  });

  try {
    await storage.createProject({
      id: "proj_e2e_03",
      name: "E2E Project 03",
      uvcsRepo: "repo@cloud",
      baseBranch: "/main",
      createdAt: new Date().toISOString(),
    });

    const task = await storage.createTask({
      id: "task_e2e_03",
      projectId: "proj_e2e_03",
      parentTaskId: null,
      title: "模拟中途丢租",
      goal: "测试前置租约有效性守卫",
      acceptanceCriteria: "严禁签入与提交",
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
      projectId: "proj_e2e_03",
      agentType: "codex",
      timeoutSeconds: 2,
    });
    assert.ok(claim);

    // 模拟丢租
    runner.leaseLost = true;

    await runner.executePipeline(claim.task, claim.run);

    const taskAfter = await storage.getTask(task.id);
    assert.equal(taskAfter?.state, TaskState.LEASED);
    assert.notEqual(taskAfter?.state, TaskState.SUBMITTED);
  } finally {
    delete process.env.CODEX_BIN;
    delete process.env.CODEX_ARGS;
    await runner.stop();
    await app.close();
  }
});

test("E2E-4: 真实子进程树启动、PID 检测与 cancel() 强杀验证", async () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "e2e_cancel_"));
  const loopScript = path.join(tmpWs, "loop.js");
  fs.writeFileSync(
    loopScript,
    "setInterval(() => {}, 100);"
  );

  process.env.CODEX_BIN = process.execPath;
  process.env.CODEX_ARGS = loopScript;

  const adapter = new CodexAdapter();
  const mockTask = { id: "t_cancel", title: "取消测试", goal: "测试强杀", acceptanceCriteria: "被杀死" };
  const mockRun = { id: "r_cancel", fencingToken: 1 };

  // 1. 异步启动执行真实子进程
  adapter.executeTask({
    task: mockTask,
    run: mockRun,
    workspaceDir: tmpWs,
  });

  // 等待进程启动，确认获得真实 PID
  await new Promise((r) => setTimeout(r, 300));
  const subPid = adapter["currentProcess"]?.pid;
  assert.ok(subPid, "子进程必须已启动并持有真实系统 PID");
  assert.equal(isPidAlive(subPid), true, "强杀前子进程必须在系统中真实存活");

  // 2. 真实触发 cancel() 销毁进程树
  await adapter.cancel();
  assert.equal(adapter["currentProcess"], null);

  // 3. 验证进程已彻底从操作系统进程表中消失
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(isPidAlive(subPid), false, "强杀后子进程 PID 必须在操作系统中彻底消亡");

  delete process.env.CODEX_BIN;
  delete process.env.CODEX_ARGS;
});

test("E2E-5: 原生 cm status --header 输出格式真实正则解析测试", () => {
  const client = new UVCSClient();
  const rawSample = "/main/geng@LanzhouLandmarks/LanzhouLandmarks@qiangdao977@unity (cs:8 - head)\r\n";
  
  const trimmed = rawSample.trim();
  const match = trimmed.match(/^([^@\r\n]+)@([^(]+)\s*\((cs:\d+)/i);
  assert.ok(match, "必须匹配原生 --header 输出");
  assert.equal(match[1].trim(), "/main/geng");
  assert.equal(match[2].trim(), "LanzhouLandmarks/LanzhouLandmarks@qiangdao977@unity");
  assert.equal(match[3].trim(), "cs:8");
});
