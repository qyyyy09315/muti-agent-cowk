import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { StorageEngine } from "./types.js";
import { HubScheduler } from "./scheduler.js";
import { TaskState } from "@ai-collab/contracts";

export function createMcpServerInstance(storage: StorageEngine, scheduler: HubScheduler): Server {
  const server = new Server(
    { name: "ai-collab-hub-mcp", version: "0.2.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "project_status",
        description: "获取指定项目的概况、在线 Worker、活动任务及待办队列",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string", description: "项目 ID" },
          },
          required: ["projectId"],
        },
      },
      {
        name: "task_create",
        description: "在当前项目或父任务上下文内创建新的子任务",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            title: { type: "string" },
            goal: { type: "string" },
            acceptanceCriteria: { type: "string" },
            assignedAgent: { type: "string", enum: ["grok", "codex", "unassigned"] },
            parentTaskId: { type: "string" },
          },
          required: ["projectId", "title", "goal", "acceptanceCriteria"],
        },
      },
      {
        name: "task_get",
        description: "获取特定任务的详细要求、当前状态及执行历史",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string" },
          },
          required: ["taskId"],
        },
      },
      {
        name: "peer_ask",
        description: "向协同 AI 提问（例如接口协议、组件绑定、场景责任确认）",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            taskId: { type: "string" },
            threadId: { type: "string" },
            fromAgent: { type: "string", enum: ["grok", "codex"] },
            toAgent: { type: "string", enum: ["grok", "codex"] },
            question: { type: "string" },
          },
          required: ["projectId", "taskId", "threadId", "fromAgent", "toAgent", "question"],
        },
      },
      {
        name: "peer_reply",
        description: "回复协同 AI 的提问",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            taskId: { type: "string" },
            threadId: { type: "string" },
            fromAgent: { type: "string", enum: ["grok", "codex"] },
            toAgent: { type: "string", enum: ["grok", "codex"] },
            reply: { type: "string" },
            replyToId: { type: "string" },
          },
          required: ["projectId", "taskId", "threadId", "fromAgent", "toAgent", "reply"],
        },
      },
      {
        name: "review_request",
        description: "向协同 AI 发起针对具体 UVCS changeset 或分支的代码审查请求",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            taskId: { type: "string" },
            changesetSpec: { type: "string", description: "例如 changeset@123 或 分支名" },
            summary: { type: "string" },
          },
          required: ["projectId", "taskId", "changesetSpec", "summary"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "project_status") {
      const projectId = String(args?.projectId);
      const [project, tasks, workers] = await Promise.all([
        storage.getProject(projectId),
        storage.listTasks(projectId),
        storage.listWorkers(),
      ]);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ project, taskCount: tasks.length, activeWorkers: workers.filter((w: any) => w.status === "online") }, null, 2),
        }],
      };
    }

    if (name === "task_create") {
      const a = args as any;
      const task = await storage.createTask({
        id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        projectId: a.projectId,
        parentTaskId: a.parentTaskId || null,
        title: a.title,
        goal: a.goal,
        acceptanceCriteria: a.acceptanceCriteria,
        assignedAgent: a.assignedAgent || "unassigned",
        state: TaskState.QUEUED,
        budget: { maxMinutes: 30, maxRepairs: 3, maxQuestions: 10 },
        currentAttempt: 0,
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      scheduler.notifyNewQueuedTask();
      return {
        content: [{ type: "text", text: `子任务已创建: ${task.id} (${task.title})` }],
      };
    }

    if (name === "task_get") {
      const task = await storage.getTask(String(args?.taskId));
      return {
        content: [{ type: "text", text: JSON.stringify(task, null, 2) }],
      };
    }

    if (name === "peer_ask") {
      const a = args as any;
      const res = await storage.saveMessage({
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        projectId: a.projectId,
        taskId: a.taskId,
        threadId: a.threadId,
        fromAgent: a.fromAgent,
        toAgent: a.toAgent,
        content: a.question,
        replyToId: null,
        idempotencyKey: `ask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
      });
      return {
        content: [{ type: "text", text: `问题已送达: 消息 ID ${res.message.id}` }],
      };
    }

    if (name === "peer_reply") {
      const a = args as any;
      const res = await storage.saveMessage({
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        projectId: a.projectId,
        taskId: a.taskId,
        threadId: a.threadId,
        fromAgent: a.fromAgent,
        toAgent: a.toAgent,
        content: a.reply,
        replyToId: a.replyToId || null,
        idempotencyKey: `reply_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
      });
      return {
        content: [{ type: "text", text: `答复已送达: 消息 ID ${res.message.id}` }],
      };
    }

    if (name === "review_request") {
      const a = args as any;
      const task = await storage.getTask(a.taskId);
      if (task) {
        await storage.updateTaskState(task.id, TaskState.SUBMITTED);
      }
      return {
        content: [{ type: "text", text: `审查请求已登记，提交版本: ${a.changesetSpec}` }],
      };
    }

    throw new Error(`未知工具: ${name}`);
  });

  return server;
}

export function setupMcpServer(app: FastifyInstance, storage: StorageEngine, scheduler: HubScheduler): void {
  const sessions = new Map<string, { transport: SSEServerTransport; server: Server }>();
  const defaultServer = createMcpServerInstance(storage, scheduler);

  // 模式 1：标准单端点 HTTP POST JSON-RPC（广泛兼容各类直接发送 HTTP 调用的 MCP 客户端）
  app.post("/mcp", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as any;
    if (!body || !body.method) {
      return reply.status(400).send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "无效的 JSON-RPC 请求" } });
    }

    if (body.method === "initialize") {
      return reply.send({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "ai-collab-hub-mcp", version: "0.2.0" },
        },
      });
    }

    if (body.method === "tools/list") {
      const handler = (defaultServer as any)._requestHandlers?.get("tools/list");
      const result = await handler(body);
      return reply.send({ jsonrpc: "2.0", id: body.id, result });
    }

    if (body.method === "tools/call") {
      const handler = (defaultServer as any)._requestHandlers?.get("tools/call");
      try {
        const result = await handler(body);
        return reply.send({ jsonrpc: "2.0", id: body.id, result });
      } catch (err) {
        return reply.send({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32000, message: (err as Error).message },
        });
      }
    }

    if (body.method === "ping") {
      return reply.send({ jsonrpc: "2.0", id: body.id, result: {} });
    }

    return reply.status(404).send({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `不支持的方法: ${body.method}` } });
  });

  // 模式 2：标准双向 SSE 协议流（针对按 SSE 规范长连接挂起的客户端）
  app.get("/mcp/sse", async (req: FastifyRequest, reply: FastifyReply) => {
    // 关键：通知 Fastify 劫持原生 Socket 流，禁止框架提前完成响应
    reply.hijack();
    reply.raw.setHeader("Access-Control-Allow-Origin", "*");

    const transport = new SSEServerTransport("/mcp/messages", reply.raw);
    const sessionServer = createMcpServerInstance(storage, scheduler);

    sessions.set(transport.sessionId, { transport, server: sessionServer });

    req.raw.on("close", async () => {
      sessions.delete(transport.sessionId);
      await sessionServer.close();
    });

    await sessionServer.connect(transport);
  });

  app.post("/mcp/messages", async (req: FastifyRequest<{ Querystring: { sessionId: string } }>, reply: FastifyReply) => {
    const sessionId = req.query.sessionId;
    const session = sessions.get(sessionId);
    if (!session) {
      return reply.status(404).send({ error: `未找到活跃的 MCP 会话: ${sessionId}` });
    }
    reply.hijack();
    await session.transport.handlePostMessage(req.raw, reply.raw, req.body);
  });
}
