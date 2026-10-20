import { z } from "zod";
import { TaskState } from "./state-machine.js";

/** Agent 标识：任意可读 slug（如 grok-a / codex-b / claude-c），保留 grok/codex/human 兼容旧值 */
export const AgentId = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._:-]+$/, "Agent 标识只能包含字母、数字、点、下划线、冒号与短横线");

/** @deprecated 使用 AgentId；保留导出以兼容旧调用方 */
export const AgentType = AgentId;
export type AgentTypeValue = z.infer<typeof AgentId>;

export const WorkerStatus = z.enum(["online", "offline", "busy"]);
export type WorkerStatusValue = z.infer<typeof WorkerStatus>;

export const ApprovalStatus = z.enum(["pending", "approved", "rejected", "expired"]);
export type ApprovalStatusValue = z.infer<typeof ApprovalStatus>;

// ================= 核心实体 Schemas =================

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(100),
  uvcsRepo: z.string().min(1),
  baseBranch: z.string().min(1).default("/main"),
  description: z.string().optional(),
  createdAt: z.string().datetime(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const WorkerSchema = z.object({
  id: z.string().min(1),
  agentType: AgentId,
  name: z.string().min(1),
  hostname: z.string().min(1),
  capabilities: z.array(z.string()).default([]),
  status: WorkerStatus.default("online"),
  lastHeartbeatAt: z.string().datetime(),
  version: z.string().optional(),
});
export type Worker = z.infer<typeof WorkerSchema>;

export const TaskBudgetSchema = z.object({
  maxMinutes: z.number().int().positive().default(30),
  maxRepairs: z.number().int().nonnegative().default(3),
  maxQuestions: z.number().int().nonnegative().default(10),
});
export type TaskBudget = z.infer<typeof TaskBudgetSchema>;

export const TaskSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  parentTaskId: z.string().nullable().default(null),
  title: z.string().min(1).max(200),
  goal: z.string().min(1),
  acceptanceCriteria: z.string().min(1),
  assignedAgent: AgentId.default("unassigned"),
  state: z.nativeEnum(TaskState).default(TaskState.QUEUED),
  budget: TaskBudgetSchema.default({}),
  currentAttempt: z.number().int().nonnegative().default(0),
  version: z.number().int().nonnegative().default(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Task = z.infer<typeof TaskSchema>;

export const RunSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  projectId: z.string().min(1),
  workerId: z.string().min(1),
  fencingToken: z.number().int().positive(),
  attempt: z.number().int().positive(),
  leaseExpiresAt: z.string().datetime(),
  status: z.enum(["running", "submitted", "completed", "failed", "cancelled"]),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable().default(null),
  exitReason: z.string().nullable().default(null),
});
export type Run = z.infer<typeof RunSchema>;

export const MessageSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  threadId: z.string().min(1),
  fromAgent: AgentId,
  toAgent: AgentId,
  content: z.string().min(1),
  replyToId: z.string().nullable().default(null),
  idempotencyKey: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type Message = z.infer<typeof MessageSchema>;

export const EventSchema = z.object({
  id: z.number().int().positive(), // 单调自增游标
  projectId: z.string().min(1),
  taskId: z.string().nullable().default(null),
  runId: z.string().nullable().default(null),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});
export type Event = z.infer<typeof EventSchema>;

export const ApprovalSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().min(1),
  action: z.string().min(1),
  paramsHash: z.string().min(1),
  description: z.string().min(1),
  details: z.record(z.string(), z.unknown()).default({}),
  status: ApprovalStatus.default("pending"),
  requestedBy: AgentId,
  decidedBy: z.string().nullable().default(null),
  decidedAt: z.string().datetime().nullable().default(null),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const ArtifactSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  runId: z.string().min(1),
  path: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  contentHash: z.string().min(1),
  mimeType: z.string().default("application/octet-stream"),
  createdAt: z.string().datetime(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

// ================= API 输入验证 Schemas =================

export const RegisterWorkerInputSchema = z.object({
  id: z.string().min(1),
  agentType: AgentId,
  name: z.string().min(1),
  hostname: z.string().min(1),
  capabilities: z.array(z.string()).default([]),
  version: z.string().optional(),
});
export type RegisterWorkerInput = z.infer<typeof RegisterWorkerInputSchema>;

export const HeartbeatInputSchema = z.object({
  workerId: z.string().min(1),
  currentRunId: z.string().nullable().optional(),
});
export type HeartbeatInput = z.infer<typeof HeartbeatInputSchema>;

export const CreateTaskInputSchema = z.object({
  projectId: z.string().min(1),
  parentTaskId: z.string().nullable().optional(),
  title: z.string().min(1).max(200),
  goal: z.string().min(1),
  acceptanceCriteria: z.string().min(1),
  assignedAgent: AgentId.default("unassigned"),
  budget: TaskBudgetSchema.partial().optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

export const ClaimRunInputSchema = z.object({
  workerId: z.string().min(1),
  projectId: z.string().min(1),
  agentType: AgentId,
  timeoutSeconds: z.number().int().min(1).max(30).default(15), // 长轮询等待时间
});
export type ClaimRunInput = z.infer<typeof ClaimRunInputSchema>;

export const RenewRunInputSchema = z.object({
  runId: z.string().min(1),
  workerId: z.string().min(1),
  fencingToken: z.number().int().positive(),
  extendSeconds: z.number().int().min(10).max(300).default(60),
});
export type RenewRunInput = z.infer<typeof RenewRunInputSchema>;

export const SubmitRunInputSchema = z.object({
  runId: z.string().min(1),
  workerId: z.string().min(1),
  fencingToken: z.number().int().positive(),
  summary: z.string().min(1),
  changesetSpec: z.string().optional(),
  artifacts: z.array(z.string()).default([]),
});
export type SubmitRunInput = z.infer<typeof SubmitRunInputSchema>;

export const FailRunInputSchema = z.object({
  runId: z.string().min(1),
  workerId: z.string().min(1),
  fencingToken: z.number().int().positive(),
  reason: z.string().min(1),
});
export type FailRunInput = z.infer<typeof FailRunInputSchema>;

export const SendMessageInputSchema = z.object({
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  threadId: z.string().min(1),
  fromAgent: AgentId,
  toAgent: AgentId,
  content: z.string().min(1),
  replyToId: z.string().nullable().optional(),
  idempotencyKey: z.string().min(1),
});
export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

export const RequestApprovalInputSchema = z.object({
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  runId: z.string().min(1),
  action: z.string().min(1),
  description: z.string().min(1),
  details: z.record(z.string(), z.unknown()).default({}),
  timeoutMinutes: z.number().int().min(1).max(60).default(15),
});
export type RequestApprovalInput = z.infer<typeof RequestApprovalInputSchema>;

export const ApprovalDecisionInputSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().optional(),
});
export type ApprovalDecisionInput = z.infer<typeof ApprovalDecisionInputSchema>;
