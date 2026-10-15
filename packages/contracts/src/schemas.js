import { z } from "zod";
import { TaskState } from "./state-machine.js";
export const AgentType = z.enum(["grok", "codex", "human"]);
export const WorkerStatus = z.enum(["online", "offline", "busy"]);
export const ApprovalStatus = z.enum(["pending", "approved", "rejected", "expired"]);
// ================= 核心实体 Schemas =================
export const ProjectSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1).max(100),
    uvcsRepo: z.string().min(1),
    baseBranch: z.string().min(1).default("/main"),
    description: z.string().optional(),
    createdAt: z.string().datetime(),
});
export const WorkerSchema = z.object({
    id: z.string().min(1),
    agentType: AgentType,
    name: z.string().min(1),
    hostname: z.string().min(1),
    capabilities: z.array(z.string()).default([]),
    status: WorkerStatus.default("online"),
    lastHeartbeatAt: z.string().datetime(),
    version: z.string().optional(),
});
export const TaskBudgetSchema = z.object({
    maxMinutes: z.number().int().positive().default(30),
    maxRepairs: z.number().int().nonnegative().default(3),
    maxQuestions: z.number().int().nonnegative().default(10),
});
export const TaskSchema = z.object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    parentTaskId: z.string().nullable().default(null),
    title: z.string().min(1).max(200),
    goal: z.string().min(1),
    acceptanceCriteria: z.string().min(1),
    assignedAgent: z.enum(["grok", "codex", "unassigned"]).default("unassigned"),
    state: z.nativeEnum(TaskState).default(TaskState.QUEUED),
    budget: TaskBudgetSchema.default({}),
    currentAttempt: z.number().int().nonnegative().default(0),
    version: z.number().int().nonnegative().default(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});
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
export const MessageSchema = z.object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    taskId: z.string().min(1),
    threadId: z.string().min(1),
    fromAgent: AgentType,
    toAgent: AgentType,
    content: z.string().min(1),
    replyToId: z.string().nullable().default(null),
    idempotencyKey: z.string().min(1),
    createdAt: z.string().datetime(),
});
export const EventSchema = z.object({
    id: z.number().int().positive(), // 单调自增游标
    projectId: z.string().min(1),
    taskId: z.string().nullable().default(null),
    runId: z.string().nullable().default(null),
    type: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
    createdAt: z.string().datetime(),
});
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
    requestedBy: AgentType,
    decidedBy: z.string().nullable().default(null),
    decidedAt: z.string().datetime().nullable().default(null),
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
});
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
// ================= API 输入验证 Schemas =================
export const RegisterWorkerInputSchema = z.object({
    id: z.string().min(1),
    agentType: AgentType,
    name: z.string().min(1),
    hostname: z.string().min(1),
    capabilities: z.array(z.string()).default([]),
    version: z.string().optional(),
});
export const HeartbeatInputSchema = z.object({
    workerId: z.string().min(1),
    currentRunId: z.string().nullable().optional(),
});
export const CreateTaskInputSchema = z.object({
    projectId: z.string().min(1),
    parentTaskId: z.string().nullable().optional(),
    title: z.string().min(1).max(200),
    goal: z.string().min(1),
    acceptanceCriteria: z.string().min(1),
    assignedAgent: z.enum(["grok", "codex", "unassigned"]).default("unassigned"),
    budget: TaskBudgetSchema.partial().optional(),
});
export const ClaimRunInputSchema = z.object({
    workerId: z.string().min(1),
    projectId: z.string().min(1),
    agentType: z.enum(["grok", "codex"]),
    timeoutSeconds: z.number().int().min(1).max(30).default(15), // 长轮询等待时间
});
export const RenewRunInputSchema = z.object({
    runId: z.string().min(1),
    workerId: z.string().min(1),
    fencingToken: z.number().int().positive(),
    extendSeconds: z.number().int().min(10).max(300).default(60),
});
export const SubmitRunInputSchema = z.object({
    runId: z.string().min(1),
    workerId: z.string().min(1),
    fencingToken: z.number().int().positive(),
    summary: z.string().min(1),
    changesetSpec: z.string().optional(),
    artifacts: z.array(z.string()).default([]),
});
export const SendMessageInputSchema = z.object({
    projectId: z.string().min(1),
    taskId: z.string().min(1),
    threadId: z.string().min(1),
    fromAgent: AgentType,
    toAgent: AgentType,
    content: z.string().min(1),
    replyToId: z.string().nullable().optional(),
    idempotencyKey: z.string().min(1),
});
export const RequestApprovalInputSchema = z.object({
    projectId: z.string().min(1),
    taskId: z.string().min(1),
    runId: z.string().min(1),
    action: z.string().min(1),
    description: z.string().min(1),
    details: z.record(z.string(), z.unknown()).default({}),
    timeoutMinutes: z.number().int().min(1).max(60).default(15),
});
export const ApprovalDecisionInputSchema = z.object({
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().optional(),
});
//# sourceMappingURL=schemas.js.map