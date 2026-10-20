import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import {
  CreateTaskInputSchema,
  ClaimRunInputSchema,
  RenewRunInputSchema,
  SubmitRunInputSchema,
  FailRunInputSchema,
  SendMessageInputSchema,
  RegisterWorkerInputSchema,
  HeartbeatInputSchema,
  RequestApprovalInputSchema,
  ApprovalDecisionInputSchema,
  LoginInputSchema,
  A2AEnvelopeSchema,
  TaskState,
  CollabError,
} from "@ai-collab/contracts";
import { StorageEngine } from "./types.js";
import { HubScheduler } from "./scheduler.js";
import {
  verifyPassword,
  createSessionToken,
  verifySessionToken,
  authMode,
  authenticate,
  classifyRequest,
  newApiToken,
  hashApiToken,
  type Principal,
} from "./auth.js";

export function registerRoutes(app: FastifyInstance, storage: StorageEngine, scheduler: HubScheduler): void {
  // ===== 鉴权守卫（HUB_AUTH_MODE: off / dashboard / strict）=====
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const mode = authMode();
    if (mode === "off") return;

    const policy = classifyRequest(req.method, req.url);
    if (policy === "public") return;

    const principal = await authenticate(req, storage);
    const attach = (p: Principal | null) => {
      if (p) (req as any).principal = p;
    };

    // shared：Worker 与 UI 都会读；dashboard 按向后兼容放开
    if (policy === "shared") {
      if (principal) attach(principal);
      else if (mode === "strict") {
        return reply.code(401).send({ error: "未登录或凭据无效" });
      }
      return;
    }

    // worker：dashboard 模式兼容尚未配置 Token 的旧 Worker
    if (policy === "worker") {
      if (principal) {
        if (principal.kind !== "agent" && principal.kind !== "user") {
          return reply.code(403).send({ error: "凭据类型不允许调用执行接口" });
        }
        attach(principal);
        return;
      }
      if (mode === "dashboard") return; // 兼容期：旧 Worker 无 Token 仍可执行
      return reply.code(401).send({ error: "Worker 需要 Agent Token" });
    }

    if (!principal) return reply.code(401).send({ error: "未登录或凭据无效" });

    if (policy === "admin" && !(principal.kind === "user" && principal.role === "admin")) {
      return reply.code(403).send({ error: "需要管理员权限" });
    }
    if (policy === "user" && principal.kind !== "user") {
      return reply.code(403).send({ error: "该操作需要用户身份" });
    }

    attach(principal);
  });

  // 0. Web 控制台主页
  app.get("/", async (_req: FastifyRequest, reply: FastifyReply) => {
    const candidates = [
      path.join(process.cwd(), "public", "index.html"),
      path.join(__dirname, "..", "public", "index.html"),
    ];
    for (const file of candidates) {
      if (fs.existsSync(file)) {
        return reply.type("text/html; charset=utf-8").send(fs.readFileSync(file, "utf-8"));
      }
    }
    return reply.type("text/html; charset=utf-8").send("<h1>AI Collab Hub Console</h1>");
  });

  // 1. 健康检查
  app.get("/healthz", async () => ({ status: "ok", service: "ai-collab-hub" }));
  app.get("/readyz", async () => ({ status: "ready" }));

  // 1.1 纯管理员登录鉴权（无任何外部注册入口）
  app.post("/api/auth/login", async (req: FastifyRequest, reply: FastifyReply) => {
    const input = LoginInputSchema.parse(req.body);
    const user = await storage.getUserByUsername(input.username);
    if (!user || !verifyPassword(input.password, user.passwordHash)) {
      return reply.status(401).send({ error: "用户名或密码错误" });
    }
    const token = createSessionToken(user.username);
    return { ok: true, user: { username: user.username, role: user.role }, token };
  });

  app.get("/api/auth/me", async (req: FastifyRequest, reply: FastifyReply) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    const verified = verifySessionToken(token);
    if (!verified) return reply.status(401).send({ error: "未登录或凭证已过期" });
    const user = await storage.getUserByUsername(verified.username);
    return { ok: true, user: { username: user?.username, role: user?.role } };
  });

  // 1.2 A2A Agent-to-Agent 协议接口
  app.post("/api/a2a/send", async (req: FastifyRequest, reply: FastifyReply) => {
    const input = A2AEnvelopeSchema.parse(req.body);
    const res = await storage.saveA2AEnvelope(input);
    return reply.status(res.duplicate ? 200 : 201).send(res);
  });

  app.get("/api/tasks/:id/a2a", async (req: FastifyRequest<{ Params: { id: string }; Querystring: { conversationId?: string } }>) => {
    return storage.listA2AEnvelopes(req.params.id, req.query.conversationId);
  });

  // 2. 项目管理
  app.post("/api/projects", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as any;
    const project = await storage.createProject({
      id: body.id || `proj_${Date.now()}`,
      name: body.name,
      uvcsRepo: body.uvcsRepo,
      baseBranch: body.baseBranch || "/main",
      description: body.description,
      createdAt: new Date().toISOString(),
    });
    return reply.status(201).send(project);
  });

  app.get("/api/projects", async () => storage.listProjects());

  // 3. Worker 登记与心跳
  app.post("/api/workers/register", async (req: FastifyRequest) => {
    const input = RegisterWorkerInputSchema.parse(req.body);
    const worker = await storage.upsertWorker({
      ...input,
      status: "online",
      lastHeartbeatAt: new Date().toISOString(),
    });
    return worker;
  });

  app.post("/api/workers/heartbeat", async (req: FastifyRequest) => {
    const input = HeartbeatInputSchema.parse(req.body);
    await storage.updateWorkerHeartbeat(input.workerId);
    return { ok: true };
  });

  app.get("/api/workers", async () => storage.listWorkers());

  // 4. 任务调度
  app.post("/api/tasks", async (req: FastifyRequest, reply: FastifyReply) => {
    const input = CreateTaskInputSchema.parse(req.body);
    const task = await storage.createTask({
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      projectId: input.projectId,
      parentTaskId: input.parentTaskId || null,
      title: input.title,
      goal: input.goal,
      acceptanceCriteria: input.acceptanceCriteria,
      assignedAgent: input.assignedAgent,
      state: TaskState.QUEUED,
      budget: {
        maxMinutes: input.budget?.maxMinutes ?? 30,
        maxRepairs: input.budget?.maxRepairs ?? 3,
        maxQuestions: input.budget?.maxQuestions ?? 10,
      },
      currentAttempt: 0,
      version: 1,
      createdBy: ((req as any).principal as Principal | undefined)?.kind === "user"
        ? ((req as any).principal as Principal & { kind: "user" }).userId
        : null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    scheduler.notifyNewQueuedTask();
    return reply.status(201).send(task);
  });

  app.get("/api/tasks/:id", async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const task = await storage.getTask(req.params.id);
    if (!task) throw new CollabError("TASK_NOT_FOUND", "任务不存在", 404);
    return task;
  });

  app.get("/api/tasks", async (req: FastifyRequest<{ Querystring: { projectId?: string; state?: string } }>) => {
    if (req.query.projectId) {
      return storage.listTasks(req.query.projectId, req.query.state as any);
    }
    return storage.listAllTasks(100);
  });

  app.get("/api/projects/:projectId/tasks", async (req: FastifyRequest<{ Params: { projectId: string }; Querystring: { state?: string } }>) => {
    return storage.listTasks(req.params.projectId, req.query.state as any);
  });

  app.post("/api/tasks/:id/actions", async (req: FastifyRequest<{ Params: { id: string }; Body: { action: "pause" | "resume" | "cancel" | "requeue" } }>) => {
    const { action } = req.body;
    let targetState: any = TaskState.PAUSED;
    if (action === "resume") targetState = TaskState.RUNNING;
    if (action === "requeue") targetState = TaskState.QUEUED;
    if (action === "cancel") targetState = TaskState.CANCELLED;

    const updated = await storage.updateTaskState(req.params.id, targetState as any);
    if (action === "resume" || action === "requeue") scheduler.notifyNewQueuedTask();
    return updated;
  });

  // 5. 抢单、续租与提交
  app.post("/api/runs/claim", async (req: FastifyRequest) => {
    const input = ClaimRunInputSchema.parse(req.body);
    const result = await scheduler.claimRun(input);
    return { claimed: Boolean(result), data: result };
  });

  app.post("/api/runs/:id/renew", async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const input = RenewRunInputSchema.parse({ ...req.body as any, runId: req.params.id });
    const run = await scheduler.renewRun(input);
    return run;
  });

  app.post("/api/runs/:id/submit", async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const input = SubmitRunInputSchema.parse({ ...req.body as any, runId: req.params.id });
    const run = await scheduler.submitRun(input);
    return run;
  });

  app.post("/api/runs/:id/fail", async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const input = FailRunInputSchema.parse({ ...req.body as any, runId: req.params.id });
    const run = await scheduler.failRun(input);
    return run;
  });

  // 6. 消息与协作
  app.post("/api/messages", async (req: FastifyRequest, reply: FastifyReply) => {
    const input = SendMessageInputSchema.parse(req.body);
    const msg = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      ...input,
      replyToId: input.replyToId || null,
      createdAt: new Date().toISOString(),
    };
    const res = await storage.saveMessage(msg);
    if (!res.duplicate && !msg.replyToId) {
      const task = await storage.getTask(msg.taskId);
      if (
        task &&
        task.assignedAgent === msg.fromAgent &&
        (task.state === TaskState.LEASED || task.state === TaskState.RUNNING)
      ) {
        await storage.updateTaskState(task.id, TaskState.WAITING_PEER);
      }
    }
    return reply.status(res.duplicate ? 200 : 201).send(res);
  });

  app.get("/api/tasks/:id/messages", async (req: FastifyRequest<{ Params: { id: string }; Querystring: { threadId?: string } }>) => {
    return storage.listMessages(req.params.id, req.query.threadId);
  });

  app.get("/api/projects/:projectId/messages", async (req: FastifyRequest<{ Params: { projectId: string }; Querystring: { limit?: string } }>) => {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 100;
    return storage.listProjectMessages(req.params.projectId, limit);
  });

  app.get("/api/messages", async (req: FastifyRequest<{ Querystring: { limit?: string } }>) => {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 100;
    return storage.listAllMessages(limit);
  });

  // 6.5 API Token 管理（明文仅创建时返回一次）
  app.get("/api/tokens", async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = (req as any).principal as Principal | undefined;
    if (!principal || principal.kind !== "user") return reply.code(401).send({ error: "需要用户身份" });
    const list = await storage.listApiTokens(principal.userId);
    return list.map((t) => ({
      id: t.id,
      label: t.label,
      agentId: t.agentId,
      createdAt: t.createdAt,
      lastUsedAt: t.lastUsedAt,
      revoked: Boolean(t.revokedAt),
    }));
  });

  app.post("/api/tokens", async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = (req as any).principal as Principal | undefined;
    if (!principal || principal.kind !== "user") return reply.code(401).send({ error: "需要用户身份" });
    const body = req.body as { label?: string; agentId?: string };
    const label = String(body?.label || "").trim();
    if (!label) return reply.code(400).send({ error: "请填写令牌用途标签" });
    const agentId = body?.agentId ? String(body.agentId).trim() : null;
    if (agentId && !/^[A-Za-z0-9._:-]{1,64}$/.test(agentId)) {
      return reply.code(400).send({ error: "Agent 标识不合法" });
    }
    const raw = newApiToken();
    const record = {
      id: `tok_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      userId: principal.userId,
      agentId,
      label,
      tokenHash: hashApiToken(raw),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    };
    await storage.createApiToken(record);
    return reply.status(201).send({ id: record.id, label, agentId, token: raw });
  });

  app.delete("/api/tokens/:id", async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const principal = (req as any).principal as Principal | undefined;
    if (!principal || principal.kind !== "user") return reply.code(401).send({ error: "需要用户身份" });
    const ok = await storage.revokeApiToken(req.params.id, principal.userId);
    if (!ok) return reply.code(404).send({ error: "令牌不存在或已吊销" });
    return { ok: true };
  });

  // 7. 事件流 (SSE 与断点游标)
  app.get("/api/events", async (req: FastifyRequest<{ Querystring: { projectId: string; after?: string; stream?: string } }>, reply: FastifyReply) => {
    const { projectId, after, stream } = req.query;
    if (!projectId) return reply.status(400).send({ error: "projectId 必填" });

    const afterCursor = after ? parseInt(after, 10) : 0;

    // SSE 流式推送模式
    if (stream === "true" || stream === "1") {
      // 必须由应用接管原生响应流，否则 Fastify 会提前结束连接
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      // 断线重连间隔提示
      reply.raw.write("retry: 3000\n\n");

      let currentCursor = afterCursor;
      let closed = false;

      const write = (chunk: string): boolean => {
        if (closed) return false;
        try {
          reply.raw.write(chunk);
          return true;
        } catch {
          closed = true;
          return false;
        }
      };

      const interval = setInterval(async () => {
        if (closed) return;
        try {
          const events = await storage.listEvents(projectId, currentCursor, 50);
          // 只使用默认 message 事件（不写 event: 名称），便于浏览器 EventSource.onmessage 统一接收；
          // 具体类型保留在 data 负载的 type 字段中。
          for (const ev of events) {
            if (!write(`id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`)) break;
            currentCursor = ev.id;
          }
        } catch {
          closed = true;
          clearInterval(interval);
        }
      }, 1000);

      // 保活注释，防止中间代理按空闲超时断开
      const keepalive = setInterval(() => {
        if (!write(": ping\n\n")) clearInterval(keepalive);
      }, 15000);

      const cleanup = () => {
        closed = true;
        clearInterval(interval);
        clearInterval(keepalive);
        try {
          reply.raw.end();
        } catch {}
      };
      req.raw.on("close", cleanup);
      req.raw.on("error", cleanup);
      return;
    }

    // 普通拉取模式
    return storage.listEvents(projectId, afterCursor);
  });

  // 8. 审批
  app.post("/api/approvals", async (req: FastifyRequest, reply: FastifyReply) => {
    const input = RequestApprovalInputSchema.parse(req.body);
    const expiresAt = new Date(Date.now() + input.timeoutMinutes * 60 * 1000).toISOString();
    const approval = await storage.createApproval({
      id: `appr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      projectId: input.projectId,
      taskId: input.taskId,
      runId: input.runId,
      action: input.action,
      paramsHash: Math.random().toString(36).slice(2, 10),
      description: input.description,
      details: input.details,
      status: "pending",
      requestedBy: "grok",
      decidedBy: null,
      decidedAt: null,
      expiresAt,
      createdAt: new Date().toISOString(),
    });
    return reply.status(201).send(approval);
  });

  app.get("/api/projects/:projectId/approvals", async (req: FastifyRequest<{ Params: { projectId: string }; Querystring: { status?: string } }>) => {
    return storage.listApprovals(req.params.projectId, req.query.status);
  });

  app.post("/api/approvals/:id/decision", async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const input = ApprovalDecisionInputSchema.parse(req.body);
    const principal = (req as any).principal as Principal | undefined;
    const decidedBy = principal?.kind === "user" ? principal.username : "admin";
    return storage.decideApproval(req.params.id, input.decision, decidedBy);
  });
}
