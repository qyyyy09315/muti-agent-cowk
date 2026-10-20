import pg from "pg";
import {
  Project,
  Worker,
  Task,
  Run,
  Message,
  Event,
  Approval,
  Artifact,
  TaskState,
  TaskStateType,
  isValidStateTransition,
  CollabError,
  ErrorCode,
} from "@ai-collab/contracts";
import { StorageEngine } from "./types.js";

/** 控制台在线窗口。必须用服务器时钟判断，浏览器时钟偏差会让 Worker 在 ONLINE / OFFLINE 之间闪烁。 */
const WORKER_ONLINE_WINDOW_MS = 35_000;

function withLiveWorkerStatus(worker: Worker, now = Date.now()): Worker {
  const beat = Date.parse(worker.lastHeartbeatAt);
  const age = now - beat;
  const fresh = Number.isFinite(beat) && age < WORKER_ONLINE_WINDOW_MS && age > -5_000;
  if (!fresh) return { ...worker, status: "offline" };
  if (worker.status === "busy") return { ...worker };
  return { ...worker, status: "online" };
}

function mapWorkerRow(row: any): Worker {
  return {
    id: row.id,
    agentType: row.agent_type,
    name: row.name,
    hostname: row.hostname,
    capabilities: row.capabilities,
    status: row.status,
    version: row.version,
    lastHeartbeatAt: row.last_heartbeat_at.toISOString(),
  };
}

// ==================== 1. 内存存储实现（用于单元测试与快速校验） ====================

export class MemoryStorageEngine implements StorageEngine {
  private projects = new Map<string, Project>();
  private workers = new Map<string, Worker>();
  private tasks = new Map<string, Task>();
  private runs = new Map<string, Run>();
  private messages = new Map<string, Message>();
  private messageIdempotency = new Set<string>();
  private events: Event[] = [];
  private approvals = new Map<string, Approval>();
  private artifacts = new Map<string, Artifact>();
  private users = new Map<string, { id: string; username: string; passwordHash: string; role: "admin" | "member"; createdAt: string }>();
  private a2aEnvelopes = new Map<string, any>();
  private a2aIdempotency = new Set<string>();
  private eventCursor = 1;
  private fencingSeq = 1;

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async createProject(project: Project): Promise<Project> {
    this.projects.set(project.id, { ...project });
    return project;
  }

  async getProject(id: string): Promise<Project | null> {
    return this.projects.get(id) || null;
  }

  async listProjects(): Promise<Project[]> {
    return Array.from(this.projects.values());
  }

  async upsertWorker(worker: Worker): Promise<Worker> {
    this.workers.set(worker.id, { ...worker });
    return worker;
  }

  async getWorker(id: string): Promise<Worker | null> {
    const worker = this.workers.get(id);
    return worker ? withLiveWorkerStatus(worker) : null;
  }

  async listWorkers(): Promise<Worker[]> {
    return Array.from(this.workers.values()).map((worker) => withLiveWorkerStatus(worker));
  }

  async updateWorkerHeartbeat(workerId: string): Promise<void> {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.lastHeartbeatAt = new Date().toISOString();
      worker.status = "online";
    }
  }

  async createTask(task: Task): Promise<Task> {
    this.tasks.set(task.id, { ...task });
    await this.emitEvent(task.projectId, "task_created", { task }, task.id);
    return task;
  }

  async getTask(id: string): Promise<Task | null> {
    return this.tasks.get(id) || null;
  }

  async listTasks(projectId: string, state?: TaskStateType): Promise<Task[]> {
    return Array.from(this.tasks.values()).filter(
      (t) => t.projectId === projectId && (!state || t.state === state)
    );
  }

  async listAllTasks(limit = 100): Promise<Task[]> {
    return Array.from(this.tasks.values())
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
  }

  async updateTaskState(taskId: string, newState: TaskStateType, expectedVersion?: number): Promise<Task> {
    const task = this.tasks.get(taskId);
    if (!task) throw new CollabError(ErrorCode.TASK_NOT_FOUND, `任务不存在: ${taskId}`, 404);

    if (expectedVersion !== undefined && task.version !== expectedVersion) {
      throw new CollabError(ErrorCode.CONFLICT, "任务版本冲突，已被其他执行者修改", 409);
    }

    if (!isValidStateTransition(task.state as TaskStateType, newState)) {
      throw new CollabError(
        ErrorCode.INVALID_STATE_TRANSITION,
        `不允许从状态 ${task.state} 跳转到 ${newState}`,
        400
      );
    }

    const previousState = task.state;
    task.state = newState;
    task.version += 1;
    task.updatedAt = new Date().toISOString();

    await this.emitEvent(task.projectId, "task_state_changed", {
      taskId: task.id,
      from: previousState,
      to: newState,
      version: task.version,
    }, task.id);

    return task;
  }

  async claimAvailableTask(
    workerId: string,
    projectId: string,
    agentId: string,
    leaseSeconds: number
  ): Promise<{ task: Task; run: Run } | null> {
    // 寻找处于 QUEUED 且符合 assignedAgent 的任务
    const candidate = Array.from(this.tasks.values()).find(
      (t) =>
        t.projectId === projectId &&
        t.state === TaskState.QUEUED &&
        (t.assignedAgent === agentId || t.assignedAgent === "unassigned")
    );

    if (!candidate) return null;

    // 原子推进状态至 LEASED
    candidate.state = TaskState.LEASED;
    candidate.version += 1;
    candidate.currentAttempt += 1;
    candidate.updatedAt = new Date().toISOString();

    const now = new Date();
    const leaseExpires = new Date(now.getTime() + leaseSeconds * 1000);

    const run: Run = {
      id: `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      taskId: candidate.id,
      projectId,
      workerId,
      fencingToken: this.fencingSeq++,
      attempt: candidate.currentAttempt,
      leaseExpiresAt: leaseExpires.toISOString(),
      status: "running",
      startedAt: now.toISOString(),
      endedAt: null,
      exitReason: null,
    };

    this.runs.set(run.id, run);

    await this.emitEvent(projectId, "task_leased", {
      taskId: candidate.id,
      runId: run.id,
      workerId,
      fencingToken: run.fencingToken,
      expiresAt: run.leaseExpiresAt,
    }, candidate.id, run.id);

    return { task: candidate, run };
  }

  async renewLease(runId: string, workerId: string, fencingToken: number, extendSeconds: number): Promise<Run> {
    const run = this.runs.get(runId);
    if (!run) throw new CollabError(ErrorCode.TASK_NOT_FOUND, "执行运行实例不存在", 404);
    if (run.workerId !== workerId || run.fencingToken !== fencingToken) {
      throw new CollabError(ErrorCode.FORBIDDEN, "Fencing Token 不匹配，可能已被更新的租约抢占", 403);
    }
    if (run.status !== "running") {
      throw new CollabError(ErrorCode.LEASE_EXPIRED, "执行已非运行状态，无法续租", 400);
    }

    const expiresAt = new Date(Date.now() + extendSeconds * 1000);
    run.leaseExpiresAt = expiresAt.toISOString();

    return run;
  }

  async submitRun(runId: string, workerId: string, fencingToken: number, summary: string): Promise<Run> {
    const run = this.runs.get(runId);
    if (!run) throw new CollabError(ErrorCode.TASK_NOT_FOUND, "执行运行实例不存在", 404);
    if (run.workerId !== workerId || run.fencingToken !== fencingToken) {
      throw new CollabError(ErrorCode.FORBIDDEN, "Fencing Token 失效，拒绝回写结果", 403);
    }

    run.status = "submitted";
    run.endedAt = new Date().toISOString();

    // 更新 Task 状态为 SUBMITTED
    const task = this.tasks.get(run.taskId);
    if (task) {
      await this.updateTaskState(task.id, TaskState.SUBMITTED);
    }

    await this.emitEvent(run.projectId, "run_submitted", {
      runId: run.id,
      taskId: run.taskId,
      summary,
    }, run.taskId, run.id);

    return run;
  }

  async failRun(runId: string, workerId: string, fencingToken: number, reason: string): Promise<Run> {
    const run = this.runs.get(runId);
    if (!run) throw new CollabError(ErrorCode.TASK_NOT_FOUND, "执行运行实例不存在", 404);
    if (run.workerId !== workerId || run.fencingToken !== fencingToken) {
      throw new CollabError(ErrorCode.FORBIDDEN, "Fencing Token 失效，拒绝回写结果", 403);
    }

    run.status = "failed";
    run.endedAt = new Date().toISOString();
    run.exitReason = reason;

    const task = this.tasks.get(run.taskId);
    if (task && (task.state === TaskState.LEASED || task.state === TaskState.RUNNING)) {
      const maxRepairs = task.budget.maxRepairs ?? 3;
      if (task.currentAttempt < maxRepairs) {
        task.state = TaskState.QUEUED;
        task.updatedAt = new Date().toISOString();
        task.version += 1;
        await this.emitEvent(task.projectId, "task_run_failed", {
          taskId: task.id,
          runId: run.id,
          requeued: true,
          reason,
          attempt: task.currentAttempt,
          maxRepairs,
        }, task.id, run.id);
      } else {
        task.state = TaskState.FAILED;
        task.updatedAt = new Date().toISOString();
        task.version += 1;
        await this.emitEvent(task.projectId, "task_run_failed", {
          taskId: task.id,
          runId: run.id,
          requeued: false,
          reason: `重试已达上限 (${task.currentAttempt}/${maxRepairs})。最后错误: ${reason}`,
        }, task.id, run.id);
      }
    }

    return run;
  }

  async reapExpiredLeases(): Promise<number> {
    const now = Date.now();
    let reaped = 0;

    for (const run of this.runs.values()) {
      if (run.status === "running" && new Date(run.leaseExpiresAt).getTime() < now) {
        run.status = "failed";
        run.endedAt = new Date().toISOString();
        run.exitReason = "租约心跳超时过期";

        const task = this.tasks.get(run.taskId);
        if (task && (task.state === TaskState.LEASED || task.state === TaskState.RUNNING)) {
          // 重新入队或失败（检查预算）
          if (task.currentAttempt < task.budget.maxRepairs) {
            task.state = TaskState.QUEUED;
            task.updatedAt = new Date().toISOString();
            task.version += 1;
            await this.emitEvent(task.projectId, "task_lease_reaped", {
              taskId: task.id,
              runId: run.id,
              requeued: true,
            }, task.id, run.id);
          } else {
            task.state = TaskState.FAILED;
            task.updatedAt = new Date().toISOString();
            task.version += 1;
            await this.emitEvent(task.projectId, "task_lease_reaped", {
              taskId: task.id,
              runId: run.id,
              requeued: false,
              reason: "重试次数已超上限",
            }, task.id, run.id);
          }
        }
        reaped++;
      }
    }
    return reaped;
  }

  async saveMessage(message: Message): Promise<{ message: Message; duplicate: boolean }> {
    if (this.messageIdempotency.has(message.idempotencyKey)) {
      const existing = Array.from(this.messages.values()).find(
        (m) => m.idempotencyKey === message.idempotencyKey
      );
      return { message: existing || message, duplicate: true };
    }

    this.messageIdempotency.add(message.idempotencyKey);
    this.messages.set(message.id, { ...message });

    await this.emitEvent(message.projectId, "message_sent", {
      messageId: message.id,
      taskId: message.taskId,
      threadId: message.threadId,
      from: message.fromAgent,
      to: message.toAgent,
      content: message.content,
    }, message.taskId);

    return { message, duplicate: false };
  }

  async listMessages(taskId: string, threadId?: string): Promise<Message[]> {
    return Array.from(this.messages.values()).filter(
      (m) => m.taskId === taskId && (!threadId || m.threadId === threadId)
    );
  }

  async listProjectMessages(projectId: string, limit = 100): Promise<Message[]> {
    return Array.from(this.messages.values())
      .filter((m) => m.projectId === projectId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .slice(-limit);
  }

  async listAllMessages(limit = 100): Promise<Message[]> {
    return Array.from(this.messages.values())
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .slice(-limit);
  }

  async emitEvent(
    projectId: string,
    type: string,
    payload: Record<string, unknown>,
    taskId?: string,
    runId?: string
  ): Promise<Event> {
    const event: Event = {
      id: this.eventCursor++,
      projectId,
      taskId: taskId || null,
      runId: runId || null,
      type,
      payload,
      createdAt: new Date().toISOString(),
    };
    this.events.push(event);
    return event;
  }

  async listEvents(projectId: string, afterCursor = 0, limit = 100): Promise<Event[]> {
    return this.events
      .filter((e) => e.projectId === projectId && e.id > afterCursor)
      .slice(0, limit);
  }

  async createApproval(approval: Approval): Promise<Approval> {
    this.approvals.set(approval.id, { ...approval });
    await this.emitEvent(approval.projectId, "approval_requested", { approval }, approval.taskId, approval.runId);
    return approval;
  }

  async getApproval(id: string): Promise<Approval | null> {
    return this.approvals.get(id) || null;
  }

  async listApprovals(projectId: string, status?: string): Promise<Approval[]> {
    return Array.from(this.approvals.values()).filter(
      (a) => a.projectId === projectId && (!status || a.status === status)
    );
  }

  async decideApproval(id: string, decision: "approved" | "rejected", decidedBy: string): Promise<Approval> {
    const approval = this.approvals.get(id);
    if (!approval) throw new CollabError(ErrorCode.TASK_NOT_FOUND, "审批记录不存在", 404);
    if (approval.status !== "pending") {
      throw new CollabError(ErrorCode.CONFLICT, "该审批已处理或已过期", 400);
    }

    approval.status = decision;
    approval.decidedBy = decidedBy;
    approval.decidedAt = new Date().toISOString();

    await this.emitEvent(approval.projectId, "approval_decided", {
      approvalId: approval.id,
      decision,
      decidedBy,
    }, approval.taskId, approval.runId);

    return approval;
  }

  async saveArtifact(artifact: Artifact): Promise<Artifact> {
    this.artifacts.set(artifact.id, { ...artifact });
    await this.emitEvent(artifact.projectId, "artifact_saved", { artifact }, artifact.taskId, artifact.runId);
    return artifact;
  }

  async listArtifacts(taskId: string): Promise<Artifact[]> {
    return Array.from(this.artifacts.values()).filter((a) => a.taskId === taskId);
  }

  async createUser(user: { id: string; username: string; passwordHash: string; role?: "admin" | "member"; createdAt?: string }): Promise<any> {
    const full = {
      id: user.id,
      username: user.username,
      passwordHash: user.passwordHash,
      role: user.role || "admin",
      createdAt: user.createdAt || new Date().toISOString(),
    };
    this.users.set(user.username, full);
    return full;
  }

  async getUserByUsername(username: string): Promise<any> {
    return this.users.get(username) || null;
  }

  async saveA2AEnvelope(envelope: any): Promise<{ envelope: any; duplicate: boolean }> {
    if (this.a2aIdempotency.has(envelope.idempotencyKey)) {
      const existing = Array.from(this.a2aEnvelopes.values()).find(
        (e) => e.idempotencyKey === envelope.idempotencyKey
      );
      return { envelope: existing || envelope, duplicate: true };
    }
    this.a2aIdempotency.add(envelope.idempotencyKey);
    this.a2aEnvelopes.set(envelope.id, { ...envelope });
    await this.emitEvent(envelope.projectId, `a2a_${envelope.intent}`, { envelope }, envelope.taskId);
    return { envelope, duplicate: false };
  }

  async listA2AEnvelopes(taskId: string, conversationId?: string): Promise<any[]> {
    return Array.from(this.a2aEnvelopes.values()).filter(
      (e) => e.taskId === taskId && (!conversationId || e.conversationId === conversationId)
    );
  }
}

// ==================== 2. PostgreSQL 存储实现（生产落地环境） ====================

export class PostgresStorageEngine implements StorageEngine {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
  }

  async init(): Promise<void> {
    const client = await this.pool.connect();
    client.release();
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createProject(project: Project): Promise<Project> {
    await this.pool.query(
      `INSERT INTO projects (id, name, uvcs_repo, base_branch, description, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [project.id, project.name, project.uvcsRepo, project.baseBranch, project.description, project.createdAt]
    );
    return project;
  }

  async getProject(id: string): Promise<Project | null> {
    const res = await this.pool.query(`SELECT * FROM projects WHERE id = $1`, [id]);
    if (!res.rows[0]) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      name: r.name,
      uvcsRepo: r.uvcs_repo,
      baseBranch: r.base_branch,
      description: r.description,
      createdAt: r.created_at.toISOString(),
    };
  }

  async listProjects(): Promise<Project[]> {
    const res = await this.pool.query(`SELECT * FROM projects ORDER BY created_at DESC`);
    return res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      uvcsRepo: r.uvcs_repo,
      baseBranch: r.base_branch,
      description: r.description,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async upsertWorker(worker: Worker): Promise<Worker> {
    await this.pool.query(
      `INSERT INTO workers (id, agent_type, name, hostname, capabilities, status, version, last_heartbeat_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         version = EXCLUDED.version,
         capabilities = EXCLUDED.capabilities,
         last_heartbeat_at = EXCLUDED.last_heartbeat_at`,
      [
        worker.id,
        worker.agentType,
        worker.name,
        worker.hostname,
        JSON.stringify(worker.capabilities),
        worker.status,
        worker.version || null,
        worker.lastHeartbeatAt,
      ]
    );
    return worker;
  }

  async getWorker(id: string): Promise<Worker | null> {
    const res = await this.pool.query(`SELECT * FROM workers WHERE id = $1`, [id]);
    if (!res.rows[0]) return null;
    return withLiveWorkerStatus(mapWorkerRow(res.rows[0]));
  }

  async listWorkers(): Promise<Worker[]> {
    const res = await this.pool.query(`SELECT * FROM workers ORDER BY last_heartbeat_at DESC`);
    return res.rows.map((row) => withLiveWorkerStatus(mapWorkerRow(row)));
  }

  async updateWorkerHeartbeat(workerId: string): Promise<void> {
    await this.pool.query(
      `UPDATE workers SET last_heartbeat_at = NOW(), status = 'online' WHERE id = $1`,
      [workerId]
    );
  }

  async createTask(task: Task): Promise<Task> {
    await this.pool.query(
      `INSERT INTO tasks (id, project_id, parent_task_id, title, goal, acceptance_criteria, assigned_agent, state, budget, current_attempt, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        task.id,
        task.projectId,
        task.parentTaskId,
        task.title,
        task.goal,
        task.acceptanceCriteria,
        task.assignedAgent,
        task.state,
        JSON.stringify(task.budget),
        task.currentAttempt,
        task.version,
        task.createdAt,
        task.updatedAt,
      ]
    );
    await this.emitEvent(task.projectId, "task_created", { task }, task.id);
    return task;
  }

  async getTask(id: string): Promise<Task | null> {
    const res = await this.pool.query(`SELECT * FROM tasks WHERE id = $1`, [id]);
    if (!res.rows[0]) return null;
    return this.mapTask(res.rows[0]);
  }

  async listTasks(projectId: string, state?: TaskStateType): Promise<Task[]> {
    let q = `SELECT * FROM tasks WHERE project_id = $1`;
    const params: unknown[] = [projectId];
    if (state) {
      q += ` AND state = $2`;
      params.push(state);
    }
    q += ` ORDER BY created_at ASC`;
    const res = await this.pool.query(q, params);
    return res.rows.map(this.mapTask);
  }

  async listAllTasks(limit = 100): Promise<Task[]> {
    const res = await this.pool.query(
      `SELECT * FROM tasks ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return res.rows.map(this.mapTask);
  }

  async updateTaskState(taskId: string, newState: TaskStateType, expectedVersion?: number): Promise<Task> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(`SELECT * FROM tasks WHERE id = $1 FOR UPDATE`, [taskId]);
      if (!res.rows[0]) throw new CollabError(ErrorCode.TASK_NOT_FOUND, "任务不存在", 404);
      const current = this.mapTask(res.rows[0]);

      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        throw new CollabError(ErrorCode.CONFLICT, "任务已被并发修改", 409);
      }

      if (!isValidStateTransition(current.state as TaskStateType, newState)) {
        throw new CollabError(
          ErrorCode.INVALID_STATE_TRANSITION,
          `不允许从状态 ${current.state} 变更到 ${newState}`,
          400
        );
      }

      const updatedRes = await client.query(
        `UPDATE tasks SET state = $1, version = version + 1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [newState, taskId]
      );
      await client.query("COMMIT");

      const updated = this.mapTask(updatedRes.rows[0]);
      await this.emitEvent(updated.projectId, "task_state_changed", {
        taskId: updated.id,
        from: current.state,
        to: newState,
        version: updated.version,
      }, updated.id);

      return updated;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async claimAvailableTask(
    workerId: string,
    projectId: string,
    agentId: string,
    leaseSeconds: number
  ): Promise<{ task: Task; run: Run } | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // 核心：PostgreSQL 行锁 SKIP LOCKED 实现无饥饿抢单
      const selectRes = await client.query(
        `SELECT * FROM tasks
         WHERE project_id = $1
           AND state = 'queued'
           AND (assigned_agent = $2 OR assigned_agent = 'unassigned')
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [projectId, agentId]
      );

      if (!selectRes.rows[0]) {
        await client.query("COMMIT");
        return null;
      }

      const taskRow = selectRes.rows[0];
      const now = new Date();
      const expires = new Date(now.getTime() + leaseSeconds * 1000);

      // 更新 Task 状态为 leased
      const updatedTaskRes = await client.query(
        `UPDATE tasks
         SET state = 'leased', version = version + 1, current_attempt = current_attempt + 1, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [taskRow.id]
      );
      const task = this.mapTask(updatedTaskRes.rows[0]);

      // 插入 Run 记录
      const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const fencingToken = Date.now();
      const runRes = await client.query(
        `INSERT INTO runs (id, task_id, project_id, worker_id, fencing_token, attempt, lease_expires_at, status, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', NOW()) RETURNING *`,
        [runId, task.id, projectId, workerId, fencingToken, task.currentAttempt, expires]
      );
      const r = runRes.rows[0];
      const run: Run = {
        id: r.id,
        taskId: r.task_id,
        projectId: r.project_id,
        workerId: r.worker_id,
        fencingToken: Number(r.fencing_token),
        attempt: r.attempt,
        leaseExpiresAt: r.lease_expires_at.toISOString(),
        status: r.status,
        startedAt: r.started_at.toISOString(),
        endedAt: r.ended_at ? r.ended_at.toISOString() : null,
        exitReason: r.exit_reason,
      };

      await client.query("COMMIT");

      await this.emitEvent(projectId, "task_leased", {
        taskId: task.id,
        runId: run.id,
        workerId,
        fencingToken: run.fencingToken,
        expiresAt: run.leaseExpiresAt,
      }, task.id, run.id);

      return { task, run };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async renewLease(runId: string, workerId: string, fencingToken: number, extendSeconds: number): Promise<Run> {
    const res = await this.pool.query(
      `UPDATE runs
       SET lease_expires_at = NOW() + ($1 || ' seconds')::interval
       WHERE id = $2 AND worker_id = $3 AND fencing_token = $4 AND status = 'running'
       RETURNING *`,
      [extendSeconds, runId, workerId, fencingToken]
    );
    if (!res.rows[0]) {
      throw new CollabError(ErrorCode.LEASE_EXPIRED, "租约失效或 Fencing Token 不匹配", 403);
    }
    const r = res.rows[0];
    return {
      id: r.id,
      taskId: r.task_id,
      projectId: r.project_id,
      workerId: r.worker_id,
      fencingToken: Number(r.fencing_token),
      attempt: r.attempt,
      leaseExpiresAt: r.lease_expires_at.toISOString(),
      status: r.status,
      startedAt: r.started_at.toISOString(),
      endedAt: r.ended_at ? r.ended_at.toISOString() : null,
      exitReason: r.exit_reason,
    };
  }

  async submitRun(runId: string, workerId: string, fencingToken: number, summary: string): Promise<Run> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const runRes = await client.query(
        `UPDATE runs SET status = 'submitted', ended_at = NOW()
         WHERE id = $1 AND worker_id = $2 AND fencing_token = $3 RETURNING *`,
        [runId, workerId, fencingToken]
      );
      if (!runRes.rows[0]) throw new CollabError(ErrorCode.FORBIDDEN, "Fencing Token 失效，拒绝回写", 403);

      const r = runRes.rows[0];
      await client.query(
        `UPDATE tasks SET state = 'submitted', version = version + 1, updated_at = NOW() WHERE id = $1`,
        [r.task_id]
      );
      await client.query("COMMIT");

      await this.emitEvent(r.project_id, "run_submitted", {
        runId: r.id,
        taskId: r.task_id,
        summary,
      }, r.task_id, r.id);

      return {
        id: r.id,
        taskId: r.task_id,
        projectId: r.project_id,
        workerId: r.worker_id,
        fencingToken: Number(r.fencing_token),
        attempt: r.attempt,
        leaseExpiresAt: r.lease_expires_at.toISOString(),
        status: r.status,
        startedAt: r.started_at.toISOString(),
        endedAt: r.ended_at.toISOString(),
        exitReason: r.exit_reason,
      };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async failRun(runId: string, workerId: string, fencingToken: number, reason: string): Promise<Run> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const runRes = await client.query(
        `UPDATE runs SET status = 'failed', ended_at = NOW(), exit_reason = $4
         WHERE id = $1 AND worker_id = $2 AND fencing_token = $3 RETURNING *`,
        [runId, workerId, fencingToken, reason]
      );
      if (!runRes.rows[0]) throw new CollabError(ErrorCode.FORBIDDEN, "Fencing Token 失效，拒绝回写", 403);

      const r = runRes.rows[0];
      const taskRes = await client.query(
        `SELECT id, current_attempt, budget, project_id, state FROM tasks WHERE id = $1 FOR UPDATE`,
        [r.task_id]
      );

      if (taskRes.rows[0]) {
        const t = taskRes.rows[0];
        const maxRepairs = Number(t.budget?.maxRepairs ?? 3);
        if (t.current_attempt < maxRepairs) {
          // 未超上限，重置为 queued
          await client.query(
            `UPDATE tasks SET state = 'queued', version = version + 1, updated_at = NOW() WHERE id = $1`,
            [t.id]
          );
          await this.emitEvent(t.project_id, "task_run_failed", {
            taskId: t.id,
            runId: r.id,
            requeued: true,
            reason,
            attempt: t.current_attempt,
            maxRepairs,
          }, t.id, r.id);
        } else {
          // 达到上限，彻底熔断为 failed！
          await client.query(
            `UPDATE tasks SET state = 'failed', version = version + 1, updated_at = NOW() WHERE id = $1`,
            [t.id]
          );
          await this.emitEvent(t.project_id, "task_run_failed", {
            taskId: t.id,
            runId: r.id,
            requeued: false,
            reason: `已达最大重试上限 (${t.current_attempt}/${maxRepairs})。最后错误: ${reason}`,
          }, t.id, r.id);
        }
      }

      await client.query("COMMIT");

      return {
        id: r.id,
        taskId: r.task_id,
        projectId: r.project_id,
        workerId: r.worker_id,
        fencingToken: Number(r.fencing_token),
        attempt: r.attempt,
        leaseExpiresAt: r.lease_expires_at.toISOString(),
        status: r.status,
        startedAt: r.started_at.toISOString(),
        endedAt: r.ended_at.toISOString(),
        exitReason: r.exit_reason,
      };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async reapExpiredLeases(): Promise<number> {
    const res = await this.pool.query(
      `UPDATE runs SET status = 'failed', ended_at = NOW(), exit_reason = '租约心跳超时'
       WHERE status = 'running' AND lease_expires_at < NOW() RETURNING *`
    );
    for (const r of res.rows) {
      const taskRes = await this.pool.query(
        `SELECT id, current_attempt, budget, state, project_id FROM tasks WHERE id = $1`,
        [r.task_id]
      );
      if (taskRes.rows[0]) {
        const t = taskRes.rows[0];
        if (t.state === 'leased' || t.state === 'running') {
          const maxRepairs = Number(t.budget?.maxRepairs ?? 3);
          if (t.current_attempt < maxRepairs) {
            await this.pool.query(
              `UPDATE tasks SET state = 'queued', version = version + 1, updated_at = NOW()
               WHERE id = $1`,
              [t.id]
            );
            await this.emitEvent(t.project_id, "task_lease_reaped", {
              taskId: t.id,
              runId: r.id,
              requeued: true,
              attempt: t.current_attempt,
              maxRepairs,
            }, t.id, r.id);
          } else {
            // 达到上限熔断
            await this.pool.query(
              `UPDATE tasks SET state = 'failed', version = version + 1, updated_at = NOW()
               WHERE id = $1`,
              [t.id]
            );
            await this.emitEvent(t.project_id, "task_lease_reaped", {
              taskId: t.id,
              runId: r.id,
              requeued: false,
              reason: `重试已达上限 (${t.current_attempt}/${maxRepairs})，持续超时熔断`,
            }, t.id, r.id);
          }
        }
      }
    }
    return res.rowCount || 0;
  }

  async saveMessage(message: Message): Promise<{ message: Message; duplicate: boolean }> {
    try {
      await this.pool.query(
        `INSERT INTO messages (id, project_id, task_id, thread_id, from_agent, to_agent, content, reply_to_id, idempotency_key, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          message.id,
          message.projectId,
          message.taskId,
          message.threadId,
          message.fromAgent,
          message.toAgent,
          message.content,
          message.replyToId,
          message.idempotencyKey,
          message.createdAt,
        ]
      );
      await this.emitEvent(message.projectId, "message_sent", { message }, message.taskId);
      return { message, duplicate: false };
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && "code" in err && err.code === "23505") {
        return { message, duplicate: true };
      }
      throw err;
    }
  }

  async listMessages(taskId: string, threadId?: string): Promise<Message[]> {
    let q = `SELECT * FROM messages WHERE task_id = $1`;
    const params: unknown[] = [taskId];
    if (threadId) {
      q += ` AND thread_id = $2`;
      params.push(threadId);
    }
    q += ` ORDER BY created_at ASC`;
    const res = await this.pool.query(q, params);
    return res.rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      taskId: r.task_id,
      threadId: r.thread_id,
      fromAgent: r.from_agent,
      toAgent: r.to_agent,
      content: r.content,
      replyToId: r.reply_to_id,
      idempotencyKey: r.idempotency_key,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async listProjectMessages(projectId: string, limit = 100): Promise<Message[]> {
    const res = await this.pool.query(
      `SELECT * FROM messages WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [projectId, limit]
    );
    return res.rows.reverse().map((r) => ({
      id: r.id,
      projectId: r.project_id,
      taskId: r.task_id,
      threadId: r.thread_id,
      fromAgent: r.from_agent,
      toAgent: r.to_agent,
      content: r.content,
      replyToId: r.reply_to_id,
      idempotencyKey: r.idempotency_key,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async listAllMessages(limit = 100): Promise<Message[]> {
    const res = await this.pool.query(
      `SELECT * FROM messages ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return res.rows.reverse().map((r) => ({
      id: r.id,
      projectId: r.project_id,
      taskId: r.task_id,
      threadId: r.thread_id,
      fromAgent: r.from_agent,
      toAgent: r.to_agent,
      content: r.content,
      replyToId: r.reply_to_id,
      idempotencyKey: r.idempotency_key,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async emitEvent(
    projectId: string,
    type: string,
    payload: Record<string, unknown>,
    taskId?: string,
    runId?: string
  ): Promise<Event> {
    const res = await this.pool.query(
      `INSERT INTO events (project_id, task_id, run_id, type, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *`,
      [projectId, taskId || null, runId || null, type, JSON.stringify(payload)]
    );
    const r = res.rows[0];
    return {
      id: Number(r.id),
      projectId: r.project_id,
      taskId: r.task_id,
      runId: r.run_id,
      type: r.type,
      payload: r.payload,
      createdAt: r.created_at.toISOString(),
    };
  }

  async listEvents(projectId: string, afterCursor = 0, limit = 100): Promise<Event[]> {
    const res = await this.pool.query(
      `SELECT * FROM events WHERE project_id = $1 AND id > $2 ORDER BY id ASC LIMIT $3`,
      [projectId, afterCursor, limit]
    );
    return res.rows.map((r) => ({
      id: Number(r.id),
      projectId: r.project_id,
      taskId: r.task_id,
      runId: r.run_id,
      type: r.type,
      payload: r.payload,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async createApproval(approval: Approval): Promise<Approval> {
    await this.pool.query(
      `INSERT INTO approvals (id, project_id, task_id, run_id, action, params_hash, description, details, status, requested_by, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        approval.id,
        approval.projectId,
        approval.taskId,
        approval.runId,
        approval.action,
        approval.paramsHash,
        approval.description,
        JSON.stringify(approval.details),
        approval.status,
        approval.requestedBy,
        approval.expiresAt,
        approval.createdAt,
      ]
    );
    await this.emitEvent(approval.projectId, "approval_requested", { approval }, approval.taskId, approval.runId);
    return approval;
  }

  async getApproval(id: string): Promise<Approval | null> {
    const res = await this.pool.query(`SELECT * FROM approvals WHERE id = $1`, [id]);
    if (!res.rows[0]) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      projectId: r.project_id,
      taskId: r.task_id,
      runId: r.run_id,
      action: r.action,
      paramsHash: r.params_hash,
      description: r.description,
      details: r.details,
      status: r.status,
      requestedBy: r.requested_by,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
      expiresAt: r.expires_at.toISOString(),
      createdAt: r.created_at.toISOString(),
    };
  }

  async listApprovals(projectId: string, status?: string): Promise<Approval[]> {
    let q = `SELECT * FROM approvals WHERE project_id = $1`;
    const params: unknown[] = [projectId];
    if (status) {
      q += ` AND status = $2`;
      params.push(status);
    }
    q += ` ORDER BY created_at DESC`;
    const res = await this.pool.query(q, params);
    return res.rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      taskId: r.task_id,
      runId: r.run_id,
      action: r.action,
      paramsHash: r.params_hash,
      description: r.description,
      details: r.details,
      status: r.status,
      requestedBy: r.requested_by,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
      expiresAt: r.expires_at.toISOString(),
      createdAt: r.created_at.toISOString(),
    }));
  }

  async decideApproval(id: string, decision: "approved" | "rejected", decidedBy: string): Promise<Approval> {
    const res = await this.pool.query(
      `UPDATE approvals SET status = $1, decided_by = $2, decided_at = NOW()
       WHERE id = $3 AND status = 'pending' RETURNING *`,
      [decision, decidedBy, id]
    );
    if (!res.rows[0]) throw new CollabError(ErrorCode.CONFLICT, "审批不存在或已处理", 400);
    const r = res.rows[0];
    const app: Approval = {
      id: r.id,
      projectId: r.project_id,
      taskId: r.task_id,
      runId: r.run_id,
      action: r.action,
      paramsHash: r.params_hash,
      description: r.description,
      details: r.details,
      status: r.status,
      requestedBy: r.requested_by,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
      createdAt: r.created_at.toISOString(),
    };
    await this.emitEvent(app.projectId, "approval_decided", { approval: app }, app.taskId, app.runId);
    return app;
  }

  async saveArtifact(artifact: Artifact): Promise<Artifact> {
    await this.pool.query(
      `INSERT INTO artifacts (id, project_id, task_id, run_id, path, size_bytes, content_hash, mime_type, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        artifact.id,
        artifact.projectId,
        artifact.taskId,
        artifact.runId,
        artifact.path,
        artifact.sizeBytes,
        artifact.contentHash,
        artifact.mimeType,
        artifact.createdAt,
      ]
    );
    await this.emitEvent(artifact.projectId, "artifact_saved", { artifact }, artifact.taskId, artifact.runId);
    return artifact;
  }

  async listArtifacts(taskId: string): Promise<Artifact[]> {
    const res = await this.pool.query(
      `SELECT * FROM artifacts WHERE task_id = $1 ORDER BY created_at DESC`,
      [taskId]
    );
    return res.rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      taskId: r.task_id,
      runId: r.run_id,
      path: r.path,
      sizeBytes: Number(r.size_bytes),
      contentHash: r.content_hash,
      mimeType: r.mime_type,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async createUser(user: { id: string; username: string; passwordHash: string; role?: "admin" | "member"; createdAt?: string }): Promise<any> {
    const res = await this.pool.query(
      `INSERT INTO users (id, username, password_hash, role, created_at)
       VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
      [user.id, user.username, user.passwordHash, user.role || 'admin']
    );
    const r = res.rows[0];
    return {
      id: r.id,
      username: r.username,
      passwordHash: r.password_hash,
      role: r.role,
      createdAt: r.created_at.toISOString(),
    };
  }

  async getUserByUsername(username: string): Promise<any> {
    const res = await this.pool.query(`SELECT * FROM users WHERE username = $1`, [username]);
    if (!res.rows[0]) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      username: r.username,
      passwordHash: r.password_hash,
      role: r.role,
      createdAt: r.created_at.toISOString(),
    };
  }

  async saveA2AEnvelope(envelope: any): Promise<{ envelope: any; duplicate: boolean }> {
    try {
      await this.pool.query(
        `INSERT INTO a2a_envelopes (id, conversation_id, project_id, task_id, from_agent, to_agent, intent, payload, changeset_spec, idempotency_key, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          envelope.id,
          envelope.conversationId,
          envelope.projectId,
          envelope.taskId,
          envelope.fromAgent,
          envelope.toAgent,
          envelope.intent,
          JSON.stringify(envelope.payload),
          envelope.changesetSpec || null,
          envelope.idempotencyKey,
          envelope.createdAt,
        ]
      );
      await this.emitEvent(envelope.projectId, `a2a_${envelope.intent}`, { envelope }, envelope.taskId);
      return { envelope, duplicate: false };
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && "code" in err && err.code === "23505") {
        return { envelope, duplicate: true };
      }
      throw err;
    }
  }

  async listA2AEnvelopes(taskId: string, conversationId?: string): Promise<any[]> {
    let q = `SELECT * FROM a2a_envelopes WHERE task_id = $1`;
    const params: unknown[] = [taskId];
    if (conversationId) {
      q += ` AND conversation_id = $2`;
      params.push(conversationId);
    }
    q += ` ORDER BY created_at ASC`;
    const res = await this.pool.query(q, params);
    return res.rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      projectId: r.project_id,
      taskId: r.task_id,
      fromAgent: r.from_agent,
      toAgent: r.to_agent,
      intent: r.intent,
      payload: r.payload,
      changesetSpec: r.changeset_spec,
      idempotencyKey: r.idempotency_key,
      createdAt: r.created_at.toISOString(),
    }));
  }

  private mapTask(r: Record<string, any>): Task {
    return {
      id: r.id,
      projectId: r.project_id,
      parentTaskId: r.parent_task_id,
      title: r.title,
      goal: r.goal,
      acceptanceCriteria: r.acceptance_criteria,
      assignedAgent: r.assigned_agent,
      state: r.state,
      budget: r.budget,
      currentAttempt: r.current_attempt,
      version: r.version,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  }
}

let activeStorage: StorageEngine | null = null;

export function getStorageEngine(): StorageEngine {
  if (!activeStorage) {
    if (process.env.DATABASE_URL) {
      activeStorage = new PostgresStorageEngine(process.env.DATABASE_URL);
    } else {
      activeStorage = new MemoryStorageEngine();
    }
  }
  return activeStorage;
}

export function setStorageEngine(engine: StorageEngine): void {
  activeStorage = engine;
}
