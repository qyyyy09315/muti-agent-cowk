import { z } from "zod";
export declare const AgentType: z.ZodEnum<["grok", "codex", "human"]>;
export type AgentTypeValue = z.infer<typeof AgentType>;
export declare const WorkerStatus: z.ZodEnum<["online", "offline", "busy"]>;
export type WorkerStatusValue = z.infer<typeof WorkerStatus>;
export declare const ApprovalStatus: z.ZodEnum<["pending", "approved", "rejected", "expired"]>;
export type ApprovalStatusValue = z.infer<typeof ApprovalStatus>;
export declare const ProjectSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    uvcsRepo: z.ZodString;
    baseBranch: z.ZodDefault<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    name: string;
    uvcsRepo: string;
    baseBranch: string;
    createdAt: string;
    description?: string | undefined;
}, {
    id: string;
    name: string;
    uvcsRepo: string;
    createdAt: string;
    baseBranch?: string | undefined;
    description?: string | undefined;
}>;
export type Project = z.infer<typeof ProjectSchema>;
export declare const WorkerSchema: z.ZodObject<{
    id: z.ZodString;
    agentType: z.ZodEnum<["grok", "codex", "human"]>;
    name: z.ZodString;
    hostname: z.ZodString;
    capabilities: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    status: z.ZodDefault<z.ZodEnum<["online", "offline", "busy"]>>;
    lastHeartbeatAt: z.ZodString;
    version: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status: "online" | "offline" | "busy";
    id: string;
    name: string;
    agentType: "grok" | "codex" | "human";
    hostname: string;
    capabilities: string[];
    lastHeartbeatAt: string;
    version?: string | undefined;
}, {
    id: string;
    name: string;
    agentType: "grok" | "codex" | "human";
    hostname: string;
    lastHeartbeatAt: string;
    status?: "online" | "offline" | "busy" | undefined;
    capabilities?: string[] | undefined;
    version?: string | undefined;
}>;
export type Worker = z.infer<typeof WorkerSchema>;
export declare const TaskBudgetSchema: z.ZodObject<{
    maxMinutes: z.ZodDefault<z.ZodNumber>;
    maxRepairs: z.ZodDefault<z.ZodNumber>;
    maxQuestions: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    maxMinutes: number;
    maxRepairs: number;
    maxQuestions: number;
}, {
    maxMinutes?: number | undefined;
    maxRepairs?: number | undefined;
    maxQuestions?: number | undefined;
}>;
export type TaskBudget = z.infer<typeof TaskBudgetSchema>;
export declare const TaskSchema: z.ZodObject<{
    id: z.ZodString;
    projectId: z.ZodString;
    parentTaskId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    title: z.ZodString;
    goal: z.ZodString;
    acceptanceCriteria: z.ZodString;
    assignedAgent: z.ZodDefault<z.ZodEnum<["grok", "codex", "unassigned"]>>;
    state: z.ZodDefault<z.ZodNativeEnum<{
        readonly QUEUED: "queued";
        readonly LEASED: "leased";
        readonly RUNNING: "running";
        readonly SUBMITTED: "submitted";
        readonly REVIEWING: "reviewing";
        readonly COMPLETED: "completed";
        readonly NEEDS_CHANGES: "needs_changes";
        readonly WAITING_PEER: "waiting_peer";
        readonly WAITING_HUMAN: "waiting_human";
        readonly PAUSED: "paused";
        readonly FAILED: "failed";
        readonly CANCELLED: "cancelled";
    }>>;
    budget: z.ZodDefault<z.ZodObject<{
        maxMinutes: z.ZodDefault<z.ZodNumber>;
        maxRepairs: z.ZodDefault<z.ZodNumber>;
        maxQuestions: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        maxMinutes: number;
        maxRepairs: number;
        maxQuestions: number;
    }, {
        maxMinutes?: number | undefined;
        maxRepairs?: number | undefined;
        maxQuestions?: number | undefined;
    }>>;
    currentAttempt: z.ZodDefault<z.ZodNumber>;
    version: z.ZodDefault<z.ZodNumber>;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    createdAt: string;
    version: number;
    projectId: string;
    parentTaskId: string | null;
    title: string;
    goal: string;
    acceptanceCriteria: string;
    assignedAgent: "grok" | "codex" | "unassigned";
    state: "queued" | "leased" | "running" | "submitted" | "reviewing" | "completed" | "needs_changes" | "waiting_peer" | "waiting_human" | "paused" | "failed" | "cancelled";
    budget: {
        maxMinutes: number;
        maxRepairs: number;
        maxQuestions: number;
    };
    currentAttempt: number;
    updatedAt: string;
}, {
    id: string;
    createdAt: string;
    projectId: string;
    title: string;
    goal: string;
    acceptanceCriteria: string;
    updatedAt: string;
    version?: number | undefined;
    parentTaskId?: string | null | undefined;
    assignedAgent?: "grok" | "codex" | "unassigned" | undefined;
    state?: "queued" | "leased" | "running" | "submitted" | "reviewing" | "completed" | "needs_changes" | "waiting_peer" | "waiting_human" | "paused" | "failed" | "cancelled" | undefined;
    budget?: {
        maxMinutes?: number | undefined;
        maxRepairs?: number | undefined;
        maxQuestions?: number | undefined;
    } | undefined;
    currentAttempt?: number | undefined;
}>;
export type Task = z.infer<typeof TaskSchema>;
export declare const RunSchema: z.ZodObject<{
    id: z.ZodString;
    taskId: z.ZodString;
    projectId: z.ZodString;
    workerId: z.ZodString;
    fencingToken: z.ZodNumber;
    attempt: z.ZodNumber;
    leaseExpiresAt: z.ZodString;
    status: z.ZodEnum<["running", "submitted", "completed", "failed", "cancelled"]>;
    startedAt: z.ZodString;
    endedAt: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    exitReason: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    status: "running" | "submitted" | "completed" | "failed" | "cancelled";
    id: string;
    projectId: string;
    taskId: string;
    workerId: string;
    fencingToken: number;
    attempt: number;
    leaseExpiresAt: string;
    startedAt: string;
    endedAt: string | null;
    exitReason: string | null;
}, {
    status: "running" | "submitted" | "completed" | "failed" | "cancelled";
    id: string;
    projectId: string;
    taskId: string;
    workerId: string;
    fencingToken: number;
    attempt: number;
    leaseExpiresAt: string;
    startedAt: string;
    endedAt?: string | null | undefined;
    exitReason?: string | null | undefined;
}>;
export type Run = z.infer<typeof RunSchema>;
export declare const MessageSchema: z.ZodObject<{
    id: z.ZodString;
    projectId: z.ZodString;
    taskId: z.ZodString;
    threadId: z.ZodString;
    fromAgent: z.ZodEnum<["grok", "codex", "human"]>;
    toAgent: z.ZodEnum<["grok", "codex", "human"]>;
    content: z.ZodString;
    replyToId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    idempotencyKey: z.ZodString;
    createdAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    createdAt: string;
    projectId: string;
    taskId: string;
    threadId: string;
    fromAgent: "grok" | "codex" | "human";
    toAgent: "grok" | "codex" | "human";
    content: string;
    replyToId: string | null;
    idempotencyKey: string;
}, {
    id: string;
    createdAt: string;
    projectId: string;
    taskId: string;
    threadId: string;
    fromAgent: "grok" | "codex" | "human";
    toAgent: "grok" | "codex" | "human";
    content: string;
    idempotencyKey: string;
    replyToId?: string | null | undefined;
}>;
export type Message = z.infer<typeof MessageSchema>;
export declare const EventSchema: z.ZodObject<{
    id: z.ZodNumber;
    projectId: z.ZodString;
    taskId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    runId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    type: z.ZodString;
    payload: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    createdAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: string;
    id: number;
    createdAt: string;
    projectId: string;
    taskId: string | null;
    runId: string | null;
    payload: Record<string, unknown>;
}, {
    type: string;
    id: number;
    createdAt: string;
    projectId: string;
    payload: Record<string, unknown>;
    taskId?: string | null | undefined;
    runId?: string | null | undefined;
}>;
export type Event = z.infer<typeof EventSchema>;
export declare const ApprovalSchema: z.ZodObject<{
    id: z.ZodString;
    projectId: z.ZodString;
    runId: z.ZodString;
    taskId: z.ZodString;
    action: z.ZodString;
    paramsHash: z.ZodString;
    description: z.ZodString;
    details: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    status: z.ZodDefault<z.ZodEnum<["pending", "approved", "rejected", "expired"]>>;
    requestedBy: z.ZodEnum<["grok", "codex", "human"]>;
    decidedBy: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    decidedAt: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    expiresAt: z.ZodString;
    createdAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    status: "pending" | "approved" | "rejected" | "expired";
    id: string;
    description: string;
    createdAt: string;
    projectId: string;
    taskId: string;
    runId: string;
    action: string;
    paramsHash: string;
    details: Record<string, unknown>;
    requestedBy: "grok" | "codex" | "human";
    decidedBy: string | null;
    decidedAt: string | null;
    expiresAt: string;
}, {
    id: string;
    description: string;
    createdAt: string;
    projectId: string;
    taskId: string;
    runId: string;
    action: string;
    paramsHash: string;
    requestedBy: "grok" | "codex" | "human";
    expiresAt: string;
    status?: "pending" | "approved" | "rejected" | "expired" | undefined;
    details?: Record<string, unknown> | undefined;
    decidedBy?: string | null | undefined;
    decidedAt?: string | null | undefined;
}>;
export type Approval = z.infer<typeof ApprovalSchema>;
export declare const ArtifactSchema: z.ZodObject<{
    id: z.ZodString;
    projectId: z.ZodString;
    taskId: z.ZodString;
    runId: z.ZodString;
    path: z.ZodString;
    sizeBytes: z.ZodNumber;
    contentHash: z.ZodString;
    mimeType: z.ZodDefault<z.ZodString>;
    createdAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    path: string;
    id: string;
    createdAt: string;
    projectId: string;
    taskId: string;
    runId: string;
    sizeBytes: number;
    contentHash: string;
    mimeType: string;
}, {
    path: string;
    id: string;
    createdAt: string;
    projectId: string;
    taskId: string;
    runId: string;
    sizeBytes: number;
    contentHash: string;
    mimeType?: string | undefined;
}>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export declare const RegisterWorkerInputSchema: z.ZodObject<{
    id: z.ZodString;
    agentType: z.ZodEnum<["grok", "codex", "human"]>;
    name: z.ZodString;
    hostname: z.ZodString;
    capabilities: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    version: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    id: string;
    name: string;
    agentType: "grok" | "codex" | "human";
    hostname: string;
    capabilities: string[];
    version?: string | undefined;
}, {
    id: string;
    name: string;
    agentType: "grok" | "codex" | "human";
    hostname: string;
    capabilities?: string[] | undefined;
    version?: string | undefined;
}>;
export type RegisterWorkerInput = z.infer<typeof RegisterWorkerInputSchema>;
export declare const HeartbeatInputSchema: z.ZodObject<{
    workerId: z.ZodString;
    currentRunId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    workerId: string;
    currentRunId?: string | null | undefined;
}, {
    workerId: string;
    currentRunId?: string | null | undefined;
}>;
export type HeartbeatInput = z.infer<typeof HeartbeatInputSchema>;
export declare const CreateTaskInputSchema: z.ZodObject<{
    projectId: z.ZodString;
    parentTaskId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    title: z.ZodString;
    goal: z.ZodString;
    acceptanceCriteria: z.ZodString;
    assignedAgent: z.ZodDefault<z.ZodEnum<["grok", "codex", "unassigned"]>>;
    budget: z.ZodOptional<z.ZodObject<{
        maxMinutes: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
        maxRepairs: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
        maxQuestions: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
    }, "strip", z.ZodTypeAny, {
        maxMinutes?: number | undefined;
        maxRepairs?: number | undefined;
        maxQuestions?: number | undefined;
    }, {
        maxMinutes?: number | undefined;
        maxRepairs?: number | undefined;
        maxQuestions?: number | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    projectId: string;
    title: string;
    goal: string;
    acceptanceCriteria: string;
    assignedAgent: "grok" | "codex" | "unassigned";
    parentTaskId?: string | null | undefined;
    budget?: {
        maxMinutes?: number | undefined;
        maxRepairs?: number | undefined;
        maxQuestions?: number | undefined;
    } | undefined;
}, {
    projectId: string;
    title: string;
    goal: string;
    acceptanceCriteria: string;
    parentTaskId?: string | null | undefined;
    assignedAgent?: "grok" | "codex" | "unassigned" | undefined;
    budget?: {
        maxMinutes?: number | undefined;
        maxRepairs?: number | undefined;
        maxQuestions?: number | undefined;
    } | undefined;
}>;
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;
export declare const ClaimRunInputSchema: z.ZodObject<{
    workerId: z.ZodString;
    projectId: z.ZodString;
    agentType: z.ZodEnum<["grok", "codex"]>;
    timeoutSeconds: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    agentType: "grok" | "codex";
    projectId: string;
    workerId: string;
    timeoutSeconds: number;
}, {
    agentType: "grok" | "codex";
    projectId: string;
    workerId: string;
    timeoutSeconds?: number | undefined;
}>;
export type ClaimRunInput = z.infer<typeof ClaimRunInputSchema>;
export declare const RenewRunInputSchema: z.ZodObject<{
    runId: z.ZodString;
    workerId: z.ZodString;
    fencingToken: z.ZodNumber;
    extendSeconds: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    workerId: string;
    fencingToken: number;
    runId: string;
    extendSeconds: number;
}, {
    workerId: string;
    fencingToken: number;
    runId: string;
    extendSeconds?: number | undefined;
}>;
export type RenewRunInput = z.infer<typeof RenewRunInputSchema>;
export declare const SubmitRunInputSchema: z.ZodObject<{
    runId: z.ZodString;
    workerId: z.ZodString;
    fencingToken: z.ZodNumber;
    summary: z.ZodString;
    changesetSpec: z.ZodOptional<z.ZodString>;
    artifacts: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    workerId: string;
    fencingToken: number;
    runId: string;
    summary: string;
    artifacts: string[];
    changesetSpec?: string | undefined;
}, {
    workerId: string;
    fencingToken: number;
    runId: string;
    summary: string;
    changesetSpec?: string | undefined;
    artifacts?: string[] | undefined;
}>;
export type SubmitRunInput = z.infer<typeof SubmitRunInputSchema>;
export declare const SendMessageInputSchema: z.ZodObject<{
    projectId: z.ZodString;
    taskId: z.ZodString;
    threadId: z.ZodString;
    fromAgent: z.ZodEnum<["grok", "codex", "human"]>;
    toAgent: z.ZodEnum<["grok", "codex", "human"]>;
    content: z.ZodString;
    replyToId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    idempotencyKey: z.ZodString;
}, "strip", z.ZodTypeAny, {
    projectId: string;
    taskId: string;
    threadId: string;
    fromAgent: "grok" | "codex" | "human";
    toAgent: "grok" | "codex" | "human";
    content: string;
    idempotencyKey: string;
    replyToId?: string | null | undefined;
}, {
    projectId: string;
    taskId: string;
    threadId: string;
    fromAgent: "grok" | "codex" | "human";
    toAgent: "grok" | "codex" | "human";
    content: string;
    idempotencyKey: string;
    replyToId?: string | null | undefined;
}>;
export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;
export declare const RequestApprovalInputSchema: z.ZodObject<{
    projectId: z.ZodString;
    taskId: z.ZodString;
    runId: z.ZodString;
    action: z.ZodString;
    description: z.ZodString;
    details: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    timeoutMinutes: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    description: string;
    projectId: string;
    taskId: string;
    runId: string;
    action: string;
    details: Record<string, unknown>;
    timeoutMinutes: number;
}, {
    description: string;
    projectId: string;
    taskId: string;
    runId: string;
    action: string;
    details?: Record<string, unknown> | undefined;
    timeoutMinutes?: number | undefined;
}>;
export type RequestApprovalInput = z.infer<typeof RequestApprovalInputSchema>;
export declare const ApprovalDecisionInputSchema: z.ZodObject<{
    decision: z.ZodEnum<["approved", "rejected"]>;
    reason: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    decision: "approved" | "rejected";
    reason?: string | undefined;
}, {
    decision: "approved" | "rejected";
    reason?: string | undefined;
}>;
export type ApprovalDecisionInput = z.infer<typeof ApprovalDecisionInputSchema>;
//# sourceMappingURL=schemas.d.ts.map