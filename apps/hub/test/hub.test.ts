import assert from "node:assert/strict";
import { test } from "node:test";
import { buildServer } from "../src/server.js";
import { MemoryStorageEngine } from "../src/db.js";
import { hashPassword } from "../src/auth.js";

test("Hub API: 完整调度、离线用户登录与 A2A 协议测试", async () => {
  const storage = new MemoryStorageEngine();
  const app = await buildServer({ storage });
  await app.ready();

  try {
    // 0. 离线管理员注册（无网页公开注册入口）
    await storage.createUser({
      id: "usr_admin",
      username: "admin",
      passwordHash: hashPassword("Secret123"),
      role: "admin",
    });

    // 0.1 错误口令拦截
    const loginFail = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "wrong_password" },
    });
    assert.equal(loginFail.statusCode, 401);

    // 0.2 正确口令登录获取 Token
    const loginOk = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "Secret123" },
    });
    assert.equal(loginOk.statusCode, 200);
    const { token } = JSON.parse(loginOk.body);
    assert.ok(token);

    // 0.3 凭据核验
    const meRes = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(meRes.statusCode, 200);
    assert.equal(JSON.parse(meRes.body).user.username, "admin");

    // 1. 健康检查
    const healthRes = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(healthRes.statusCode, 200);

    // 2. 登记项目
    const projRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        id: "proj_unity_demo",
        name: "LanzhouLandmarks",
        uvcsRepo: "LanzhouLandmarks@cloud",
        baseBranch: "/main",
      },
    });
    assert.equal(projRes.statusCode, 201);

    // 3. 注册两端 Worker (Grok & Codex)
    await app.inject({
      method: "POST",
      url: "/api/workers/register",
      payload: {
        id: "worker_grok_01",
        agentType: "grok",
        name: "Grok Terminal Worker",
        hostname: "pc-a",
        capabilities: ["csharp", "architecture"],
      },
    });

    await app.inject({
      method: "POST",
      url: "/api/workers/register",
      payload: {
        id: "worker_codex_01",
        agentType: "codex",
        name: "Codex Worker",
        hostname: "pc-b",
        capabilities: ["csharp", "review"],
      },
    });

    // 4. 创建任务
    const taskRes = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        projectId: "proj_unity_demo",
        title: "编写地标展示面板 Prefab",
        goal: "提供面板数据绑定组件",
        acceptanceCriteria: "编译通过",
        assignedAgent: "grok",
      },
    });
    assert.equal(taskRes.statusCode, 201);
    const task = JSON.parse(taskRes.body);

    // 5. A2A 协议测试（Grok 向 Codex 发起接口确认信封）
    const a2aRes = await app.inject({
      method: "POST",
      url: "/api/a2a/send",
      payload: {
        id: "a2a_env_01",
        conversationId: "conv_task_01",
        projectId: "proj_unity_demo",
        taskId: task.id,
        fromAgent: "grok",
        toAgent: "codex",
        intent: "clarify_interface",
        payload: { suggestedInterface: "ILandmarkPresenter" },
        idempotencyKey: "idem_a2a_01",
        createdAt: new Date().toISOString(),
      },
    });
    assert.equal(a2aRes.statusCode, 201);
    assert.equal(JSON.parse(a2aRes.body).duplicate, false);

    // 6. A2A 幂等重放
    const a2aDup = await app.inject({
      method: "POST",
      url: "/api/a2a/send",
      payload: {
        id: "a2a_env_01",
        conversationId: "conv_task_01",
        projectId: "proj_unity_demo",
        taskId: task.id,
        fromAgent: "grok",
        toAgent: "codex",
        intent: "clarify_interface",
        payload: { suggestedInterface: "ILandmarkPresenter" },
        idempotencyKey: "idem_a2a_01",
        createdAt: new Date().toISOString(),
      },
    });
    assert.equal(a2aDup.statusCode, 200);
    assert.equal(JSON.parse(a2aDup.body).duplicate, true);

  } finally {
    await app.close();
  }
});

test("Worker 在线状态由服务器时钟决定", async () => {
  const storage = new MemoryStorageEngine();
  await storage.upsertWorker({
    id: "worker_grok_01",
    agentType: "grok",
    name: "Grok",
    hostname: "pc-a",
    capabilities: [],
    status: "offline",
    lastHeartbeatAt: new Date().toISOString(),
  });
  await storage.upsertWorker({
    id: "worker_codex_01",
    agentType: "codex",
    name: "Codex",
    hostname: "pc-b",
    capabilities: [],
    status: "online",
    lastHeartbeatAt: new Date(Date.now() - 120_000).toISOString(),
  });

  const app = await buildServer({ storage });
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/workers" });
    assert.equal(res.statusCode, 200);
    const workers = JSON.parse(res.body) as Array<{ id: string; status: string }>;
    assert.equal(workers.find((worker) => worker.id === "worker_grok_01")?.status, "online");
    assert.equal(workers.find((worker) => worker.id === "worker_codex_01")?.status, "offline");
  } finally {
    await app.close();
  }
});

test("执行端提问后任务等待对端，答复后重新排队", async () => {
  const storage = new MemoryStorageEngine();
  const app = await buildServer({ storage });
  await app.ready();
  try {
    await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { id: "proj_demo", name: "Demo", uvcsRepo: "demo@cloud", baseBranch: "/main" },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        projectId: "proj_demo",
        title: "对齐接口",
        goal: "向对端确认字段",
        acceptanceCriteria: "收到答复后继续",
        assignedAgent: "grok",
      },
    });
    const task = JSON.parse(created.body);
    const claimed = await app.inject({
      method: "POST",
      url: "/api/runs/claim",
      payload: { workerId: "worker_grok_01", projectId: "proj_demo", agentType: "grok", timeoutSeconds: 1 },
    });
    assert.equal(JSON.parse(claimed.body).claimed, true);

    const asked = await app.inject({
      method: "POST",
      url: "/api/messages",
      payload: {
        projectId: "proj_demo",
        taskId: task.id,
        threadId: "thread_1",
        fromAgent: "grok",
        toAgent: "codex",
        content: "这个字段要不要音频路径",
        idempotencyKey: "ask_1",
      },
    });
    assert.equal(asked.statusCode, 201);
    const parked = await storage.getTask(task.id);
    assert.equal(parked?.state, "waiting_peer");

    const resumed = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/actions`,
      payload: { action: "requeue" },
    });
    assert.equal(resumed.statusCode, 200);
    assert.equal(JSON.parse(resumed.body).state, "queued");

    const again = await app.inject({
      method: "POST",
      url: "/api/runs/claim",
      payload: { workerId: "worker_grok_01", projectId: "proj_demo", agentType: "grok", timeoutSeconds: 1 },
    });
    assert.equal(JSON.parse(again.body).claimed, true);
  } finally {
    await app.close();
  }
});
