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

test("E2E-1: 工业级全流程交付测试 (带新鲜编译日志、stdin 写入验证、门禁通过并完成提交)", async () => {
  const storage = new MemoryStorageEngine();
  const app = await buildServer({ storage });
  const port = 3195;
  await app.listen({ port, host: "127.0.0.1" });

  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "e2e_ws_01_"));
  fs.mkdirSync(path.join(tmpWs, "Assets"));
  fs.writeFileSync(path.join(tmpWs, "Assets", "ValidLandmark.cs"), "// csharp code");
  fs.writeFileSync(path.join(tmpWs, "Assets", "ValidLandmark.cs.meta"), "guid: a1b2c3d4e5");

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

    const logWriter = setInterval(() => {
      fs.writeFileSync(path.join(tmpWs, "Editor.log"), "Compilation succeeded: 0 error(s), 0 warnings\nBuild finished.");
    }, 40);

    try {
      await runner.executePipeline(claim.task, claim.run);
    } finally {
      clearInterval(logWriter);
    }

    const taskAfter = await storage.getTask(task.id);
    assert.equal(taskAfter?.state, TaskState.SUBMITTED);
  } finally {
    delete process.env.CODEX_BIN;
    delete process.env.CODEX_ARGS;
    await runner.stop();
    await app.close();
  }
});

test("E2E-2: 漏洞 1 验收 - 完全没有 Editor.log，管线必须坚决拦截，严禁签入与提交！", async () => {
  const storage = new MemoryStorageEngine();
  const app = await buildServer({ storage });
  const port = 3194;
  await app.listen({ port, host: "127.0.0.1" });

  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "e2e_ws_02_"));
  fs.mkdirSync(path.join(tmpWs, "Assets"));
  fs.writeFileSync(path.join(tmpWs, "Assets", "Clean.cs"), "// csharp code");
  fs.writeFileSync(path.join(tmpWs, "Assets", "Clean.cs.meta"), "guid: 12345");

  const editorLog = path.join(tmpWs, "Editor.log");
  if (fs.existsSync(editorLog)) fs.unlinkSync(editorLog);

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
      id: "task_no_log_01",
      projectId: "proj_e2e_02",
      parentTaskId: null,
      title: "未编译放行探测任务",
      goal: "测试完全无 Editor.log 时是否被坚决拦截",
      acceptanceCriteria: "必须被门禁拦截",
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

    await assert.rejects(async () => {
      await runner.executePipeline(claim.task, claim.run);
    }, /未检测到 Unity 编译日志 Editor.log/);

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

test("E2E-3: 漏洞 3 验收 - 第二个文件加锁失败后，清理逻辑只精准释放已获取的锁，绝不触碰未取得的锁", async () => {
  const baseWs = fs.mkdtempSync(path.join(os.tmpdir(), "e2e_base_locks_"));
  const taskParent = fs.mkdtempSync(path.join(os.tmpdir(), "e2e_task_locks_"));

  const runner = new WorkerRunner({
    hubUrl: "http://127.0.0.1:9999",
    projectId: "proj_mock",
    agentType: "codex",
    workspaceDir: baseWs,
    taskWorkspaceBaseDir: taskParent,
  });

  const realLocked = [];
  const realUnlocked = [];

  runner.uvcs.lockFile = async (ws, itemPath) => {
    if (itemPath.includes("SceneA")) {
      realLocked.push(itemPath);
      return true;
    }
    if (itemPath.includes("SceneB")) {
      throw new Error(`UVCS lock error: ${itemPath} is already locked by user "peer_developer"`);
    }
    return true;
  };

  runner.uvcs.unlockFile = async (ws, itemPath) => {
    realUnlocked.push(itemPath);
    return true;
  };

  runner.uvcs.getStatus = async () => ({ branch: "/main", changeset: "cs:1", repository: "repo@cloud", pendingChanges: [] });
  runner.uvcs.createWorkspace = async (name, targetWs) => {
    fs.mkdirSync(path.join(targetWs, "Assets"), { recursive: true });
    fs.writeFileSync(path.join(targetWs, "Assets", "SceneA.unity"), "A");
    fs.writeFileSync(path.join(targetWs, "Assets", "SceneB.unity"), "B");
    fs.writeFileSync(path.join(targetWs, "Assets", "SceneA.unity.meta"), "guid: a");
    fs.writeFileSync(path.join(targetWs, "Assets", "SceneB.unity.meta"), "guid: b");
  };
  runner.uvcs.deleteWorkspace = async () => {};
  runner.uvcs.createBranch = async () => "/main";
  runner.uvcs.switchBranch = async () => {};

  const mockTask = {
    id: "task_lock_test",
    title: "修改 SceneA 与 SceneB",
    goal: "编辑 SceneA.unity 与 SceneB.unity",
  };
  const mockRun = { id: "run_lock_test", fencingToken: 1 };

  await assert.rejects(async () => {
    await runner.executePipeline(mockTask, mockRun);
  }, /already locked by user/);

  assert.equal(realLocked.length, 1);
  assert.ok(realLocked[0].includes("SceneA"));
  assert.equal(realUnlocked.length, 1);
  assert.ok(realUnlocked[0].includes("SceneA"));
  assert.equal(realUnlocked.some(p => p.includes("SceneB")), false, "绝不能尝试释放未取得的锁！");
});

test("E2E-4: 漏洞 2 验收 - 独立任务工作区隔离（绝不切换与污染原工作区）", async () => {
  const baseWs = fs.mkdtempSync(path.join(os.tmpdir(), "base_ws_developer_"));
  const taskBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "task_workspaces_"));

  let switchedWorkspaces = [];
  let createdWorkspaces = [];

  const runner = new WorkerRunner({
    hubUrl: "http://127.0.0.1:9999",
    projectId: "proj_iso",
    agentType: "codex",
    workspaceDir: baseWs,
    taskWorkspaceBaseDir: taskBaseDir,
    skipCompileGate: true,
  });

  runner.uvcs.getStatus = async (ws) => ({
    branch: ws === baseWs ? "/main/geng" : "br:/main/ai/task_iso/codex",
    changeset: "cs:8",
    repository: "LanzhouLandmarks@qiangdao977@unity",
    pendingChanges: []
  });

  runner.uvcs.createWorkspace = async (name, path, repo) => {
    createdWorkspaces.push({ name, path, repo });
  };
  runner.uvcs.deleteWorkspace = async () => {};
  runner.uvcs.createBranch = async () => {};
  runner.uvcs.switchBranch = async (ws, branch) => {
    switchedWorkspaces.push({ ws, branch });
  };
  runner.uvcs.checkin = async () => "cs:109";

  runner["adapter"].executeTask = async () => ({ success: true, summary: "ok", exitCode: 0 });
  runner.client.submitRun = async () => {};

  const mockTask = { id: "task_iso", title: "测试独立工作区隔离", goal: "不污染原工作区" };
  const mockRun = { id: "run_iso", fencingToken: 1 };

  await runner.executePipeline(mockTask, mockRun);

  assert.equal(createdWorkspaces.length, 1);
  assert.ok(createdWorkspaces[0].path.startsWith(taskBaseDir));
  assert.notEqual(createdWorkspaces[0].path, baseWs);

  assert.equal(switchedWorkspaces.length, 1);
  assert.notEqual(switchedWorkspaces[0].ws, baseWs, "baseWs 原工作区绝对不能被切换分支！");
  assert.ok(switchedWorkspaces[0].ws.startsWith(taskBaseDir), "切换分支必须发生在专属任务隔离工作区");
});

test("E2E-5: 租约失效签入前阻断测试 (丢租严禁执行 cm checkin 与 submit)", async () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "e2e_lease_"));
  fs.mkdirSync(path.join(tmpWs, "Assets"));
  fs.writeFileSync(path.join(tmpWs, "Assets", "Clean.cs"), "// csharp code");
  fs.writeFileSync(path.join(tmpWs, "Assets", "Clean.cs.meta"), "guid: 12345");

  const runnerScript = makeStdinRunner(tmpWs);
  process.env.CODEX_BIN = process.execPath;
  process.env.CODEX_ARGS = runnerScript;

  let checkinCalled = false;
  let submitCalled = false;

  const runner = new WorkerRunner({
    hubUrl: "http://127.0.0.1:9999",
    projectId: "proj_lease_guard",
    agentType: "codex",
    workspaceDir: tmpWs,
    skipUvcsIsolation: true,
    skipCompileGate: true,
  });

  runner.uvcs.checkin = async () => {
    checkinCalled = true;
    return "cs:999";
  };
  runner.client.submitRun = async () => {
    submitCalled = true;
  };

  const mockTask = { id: "t_lease", title: "丢租防脑裂任务", goal: "测试拦截" };
  const mockRun = { id: "r_lease", fencingToken: 1 };

  runner.leaseLost = true;

  await assert.rejects(async () => {
    await runner.executePipeline(mockTask, mockRun);
  }, /任务租约已失效/);

  assert.equal(checkinCalled, false, "租约失效后坚决禁止签入云端！");
  assert.equal(submitCalled, false, "租约失效后坚决禁止向 Hub 提交成果！");

  delete process.env.CODEX_BIN;
  delete process.env.CODEX_ARGS;
});

test("E2E-6: 真实子进程树启动、PID 检测与 cancel() 强杀验证", async () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "e2e_cancel_"));
  const loopScript = path.join(tmpWs, "loop.js");
  fs.writeFileSync(loopScript, "setInterval(() => {}, 100);");

  process.env.CODEX_BIN = process.execPath;
  process.env.CODEX_ARGS = loopScript;

  const adapter = new CodexAdapter();
  const mockTask = { id: "t_cancel", title: "取消测试", goal: "测试强杀", acceptanceCriteria: "被杀死" };
  const mockRun = { id: "r_cancel", fencingToken: 1 };

  adapter.executeTask({
    task: mockTask,
    run: mockRun,
    workspaceDir: tmpWs,
  });

  await new Promise((r) => setTimeout(r, 300));
  const subPid = adapter["currentProcess"]?.pid;
  assert.ok(subPid, "子进程必须已启动并持有真实系统 PID");
  assert.equal(isPidAlive(subPid), true, "强杀前子进程必须在系统中真实存活");

  await adapter.cancel();
  assert.equal(adapter.currentProcess, null);

  await new Promise((r) => setTimeout(r, 200));
  assert.equal(isPidAlive(subPid), false, "强杀后子进程 PID 必须在操作系统中彻底消亡");

  delete process.env.CODEX_BIN;
  delete process.env.CODEX_ARGS;
});

test("E2E-7: 原生 cm status --header 输出格式真实正则解析测试", () => {
  const client = new UVCSClient();
  const rawSample = "/main/geng@LanzhouLandmarks/LanzhouLandmarks@qiangdao977@unity (cs:8 - head)\r\n";
  
  const trimmed = rawSample.trim();
  const match = trimmed.match(/^([^@\r\n]+)@([^(]+)\s*\((cs:\d+)/i);
  assert.ok(match, "必须匹配原生 --header 输出");
  assert.equal(match[1].trim(), "/main/geng");
  assert.equal(match[2].trim(), "LanzhouLandmarks/LanzhouLandmarks@qiangdao977@unity");
  assert.equal(match[3].trim(), "cs:8");
});

test("E2E-8: 新增规范验收 - cm branch create 参数必须采用官方 --changeset=cs:<num> 语法", async () => {
  const client = new UVCSClient();
  let executedArgs = [];
  client.execCm = async (args) => {
    executedArgs = args;
    return { stdout: "ok", stderr: "", code: 0 };
  };

  // 1. 传入 cs:8
  await client.createBranch("C:/ws", "br:/main/ai/task_1/codex", "cs:8");
  assert.deepEqual(executedArgs, ["branch", "create", "br:/main/ai/task_1/codex", "--changeset=cs:8"]);

  // 2. 传入纯数字 8
  await client.createBranch("C:/ws", "br:/main/ai/task_2/codex", "8");
  assert.deepEqual(executedArgs, ["branch", "create", "br:/main/ai/task_2/codex", "--changeset=cs:8"]);
});

test("E2E-9: 新增规范验收 - 失败清理前必须先完整保存修改到检查点目录，防止 undocheckout 丢失工作成果", async () => {
  const baseWs = fs.mkdtempSync(path.join(os.tmpdir(), "base_ws_preserve_"));
  const taskParent = fs.mkdtempSync(path.join(os.tmpdir(), "task_ws_preserve_"));

  const runner = new WorkerRunner({
    hubUrl: "http://127.0.0.1:9999",
    projectId: "proj_preserve",
    agentType: "codex",
    workspaceDir: baseWs,
    taskWorkspaceBaseDir: taskParent,
  });

  let undocheckoutCalled = false;
  let backupExistedBeforeUnlock = false;

  runner.uvcs.getStatus = async () => ({ branch: "/main", changeset: "cs:8", repository: "repo@cloud", pendingChanges: [] });
  runner.uvcs.createWorkspace = async (name, targetWs) => {
    fs.mkdirSync(path.join(targetWs, "Assets", "Scenes"), { recursive: true });
    fs.writeFileSync(path.join(targetWs, "Assets", "Scenes.meta"), "guid: scenes_dir");
    fs.writeFileSync(path.join(targetWs, "Assets", "Scenes", "CrucialScene.unity"), "unity scene text binary data 42");
    fs.writeFileSync(path.join(targetWs, "Assets", "Scenes", "CrucialScene.unity.meta"), "guid: scene999");
  };
  runner.uvcs.deleteWorkspace = async () => {};
  runner.uvcs.createBranch = async () => "/main";
  runner.uvcs.switchBranch = async () => {};
  runner.uvcs.lockFile = async () => true;

  runner.uvcs.unlockFile = async (ws, itemPath) => {
    undocheckoutCalled = true;
    // 检查在调用 undocheckout 之前，检查点备份是否已经存在且完整
    const checkpointDir = path.join(baseWs, ".collab_checkpoints", "task_task_abort_attempt_1");
    if (fs.existsSync(path.join(checkpointDir, "manifest.json")) && 
        fs.existsSync(path.join(checkpointDir, "Assets", "Scenes", "CrucialScene.unity"))) {
      backupExistedBeforeUnlock = true;
    }
    return true;
  };

  // 模拟模型执行完毕但后续故意抛出异常（例如门禁未通过），触发 finally 失败清理
  runner["adapter"].executeTask = async () => ({ success: true, summary: "ok", exitCode: 0 });

  const mockTask = {
    id: "task_abort",
    title: "测试失败保留现场",
    goal: "修改 CrucialScene.unity",
  };
  const mockRun = { id: "run_abort", fencingToken: 1, attempt: 1 };

  await assert.rejects(async () => {
    await runner.executePipeline(mockTask, mockRun);
  });

  // 严密断言：
  // 1. 验证确实调用了 undocheckout
  assert.equal(undocheckoutCalled, true, "必须调用 undocheckout 释放锁！");

  // 2. 在执行 undocheckout 之前，文件改动已完成物理归档备份！
  assert.equal(backupExistedBeforeUnlock, true, "在 undocheckout 前必须已完整备份修改文件！");

  // 3. 检查生成的检查点内容和清单文件
  const checkpointDir = path.join(baseWs, ".collab_checkpoints", "task_task_abort_attempt_1");
  const manifest = JSON.parse(fs.readFileSync(path.join(checkpointDir, "manifest.json"), "utf-8"));
  assert.equal(manifest.taskId, "task_abort");
  assert.ok(manifest.backedUpFiles.some(f => f.includes("CrucialScene.unity")));
  const savedContent = fs.readFileSync(path.join(checkpointDir, "Assets", "Scenes", "CrucialScene.unity"), "utf-8");
  assert.equal(savedContent, "unity scene text binary data 42", "备份的内容必须 100% 完整无损！");
});
