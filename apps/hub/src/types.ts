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

export type StoredApiToken = {
  id: string;
  userId: string;
  agentId: string | null;
  label: string;
  tokenHash: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type MemberRole = "owner" | "developer" | "reviewer" | "viewer";

export type ProjectMember = {
  projectId: string;
  userId: string;
  username: string;
  role: MemberRole;
  createdAt: string;
};

export interface StorageEngine {
  init(): Promise<void>;
  close(): Promise<void>;

  // Project
  createProject(project: Project): Promise<Project>;
  getProject(id: string): Promise<Project | null>;
  listProjects(): Promise<Project[]>;

  // Worker
  upsertWorker(worker: Worker): Promise<Worker>;
  getWorker(id: string): Promise<Worker | null>;
  listWorkers(): Promise<Worker[]>;
  updateWorkerHeartbeat(workerId: string): Promise<void>;

  // Task
  createTask(task: Task): Promise<Task>;
  getTask(id: string): Promise<Task | null>;
  listTasks(projectId: string, state?: TaskStateType): Promise<Task[]>;
  listAllTasks(limit?: number): Promise<Task[]>;
  updateTaskState(taskId: string, newState: TaskStateType, expectedVersion?: number): Promise<Task>;

  // Run & Lease (带行锁抢单)
  claimAvailableTask(
    workerId: string,
    projectId: string,
    agentId: string,
    leaseSeconds: number
  ): Promise<{ task: Task; run: Run } | null>;
  renewLease(runId: string, workerId: string, fencingToken: number, extendSeconds: number): Promise<Run>;
  submitRun(runId: string, workerId: string, fencingToken: number, summary: string): Promise<Run>;
  failRun(runId: string, workerId: string, fencingToken: number, reason: string): Promise<Run>;
  reapExpiredLeases(): Promise<number>;

  // Messages
  saveMessage(message: Message): Promise<{ message: Message; duplicate: boolean }>;
  listMessages(taskId: string, threadId?: string): Promise<Message[]>;
  listProjectMessages(projectId: string, limit?: number): Promise<Message[]>;
  listAllMessages(limit?: number): Promise<Message[]>;

  // Events & Outbox
  emitEvent(projectId: string, type: string, payload: Record<string, unknown>, taskId?: string, runId?: string): Promise<Event>;
  listEvents(projectId: string, afterCursor?: number, limit?: number): Promise<Event[]>;

  // Approvals
  createApproval(approval: Approval): Promise<Approval>;
  getApproval(id: string): Promise<Approval | null>;
  listApprovals(projectId: string, status?: string): Promise<Approval[]>;
  decideApproval(id: string, decision: "approved" | "rejected", decidedBy: string): Promise<Approval>;

  // Artifacts
  saveArtifact(artifact: Artifact): Promise<Artifact>;
  listArtifacts(taskId: string): Promise<Artifact[]>;

  // Users & Auth (离线管理员注册，无公开注册入口)
  createUser(user: { id: string; username: string; passwordHash: string; role?: "admin" | "member"; createdAt?: string }): Promise<{ id: string; username: string; passwordHash: string; role: "admin" | "member"; createdAt: string }>;
  getUserByUsername(username: string): Promise<{ id: string; username: string; passwordHash: string; role: "admin" | "member"; createdAt: string } | null>;
  getUserById(id: string): Promise<{ id: string; username: string; passwordHash: string; role: "admin" | "member"; createdAt: string } | null>;
  listUsers(): Promise<{ id: string; username: string; role: "admin" | "member"; createdAt: string }[]>;

  // 项目成员
  listMembers(projectId: string): Promise<ProjectMember[]>;
  listUserProjects(userId: string): Promise<string[]>;
  getMemberRole(projectId: string, userId: string): Promise<MemberRole | null>;
  upsertMember(projectId: string, userId: string, role: MemberRole): Promise<ProjectMember>;
  removeMember(projectId: string, userId: string): Promise<boolean>;

  // API Token（只存哈希）
  createApiToken(token: StoredApiToken): Promise<StoredApiToken>;
  getApiTokenByHash(hash: string): Promise<StoredApiToken | null>;
  listApiTokens(userId: string): Promise<StoredApiToken[]>;
  revokeApiToken(id: string, userId: string): Promise<boolean>;
  touchApiToken(id: string): Promise<void>;

  // A2A Agent-to-Agent Envelope
  saveA2AEnvelope(envelope: any): Promise<{ envelope: any; duplicate: boolean }>;
  listA2AEnvelopes(taskId: string, conversationId?: string): Promise<any[]>;
}
