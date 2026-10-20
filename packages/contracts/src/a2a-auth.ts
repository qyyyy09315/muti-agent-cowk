import { z } from "zod";
import { AgentId } from "./schemas.js";

export const A2AIntent = z.enum([
  "clarify_interface",    // 接口与数据结构体对齐提问
  "answer",               // 答复对方
  "request_review",       // 请求对方对 changeset/分支进行审查
  "review_verdict",       // 审查通过或指出具体缺陷
  "handover",             // 子任务完成交接
]);
export type A2AIntentValue = z.infer<typeof A2AIntent>;

export const A2AEnvelopeSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  fromAgent: AgentId,
  toAgent: AgentId,
  intent: A2AIntent,
  payload: z.record(z.string(), z.unknown()),
  changesetSpec: z.string().optional(),
  idempotencyKey: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type A2AEnvelope = z.infer<typeof A2AEnvelopeSchema>;

// 用户登录鉴权 Schema（无注册）
export const LoginInputSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof LoginInputSchema>;

export const UserSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  passwordHash: z.string().min(1),
  role: z.enum(["admin", "member"]).default("admin"),
  createdAt: z.string().datetime(),
});
export type User = z.infer<typeof UserSchema>;
