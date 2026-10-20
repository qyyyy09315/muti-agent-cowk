import { scryptSync, randomBytes, timingSafeEqual, createHmac, createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { StorageEngine } from "./types.js";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

function sessionSecret(): Buffer {
  const secret = process.env.HUB_SESSION_SECRET || "dev-only-session-secret-placeholder";
  return Buffer.from(secret);
}

export function hashPassword(password: string, salt = randomBytes(16)): string {
  const hash = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], "hex");
  const expected = Buffer.from(parts[5], "hex");
  if (!salt.length || expected.length !== KEY_LEN) return false;

  const actual = scryptSync(password, salt, expected.length, { N, r, p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createSessionToken(username: string): string {
  const payload = {
    username,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 天有效期
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySessionToken(token: string | undefined): { username: string } | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  const expected = createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload.exp < Date.now()) return null;
    return { username: payload.username };
  } catch {
    return null;
  }
}

// ================= 控制面鉴权（M1） =================

export type AuthMode = "off" | "dashboard" | "strict";

/** HUB_AUTH_MODE: off=全开放(仅本地/测试) | dashboard=保护控制面，Worker 兼容(默认线上) | strict=Worker 也需 Token */
export function authMode(): AuthMode {
  const raw = (process.env.HUB_AUTH_MODE || "off").trim().toLowerCase();
  return raw === "dashboard" || raw === "strict" ? raw : "off";
}

export type Principal =
  | { kind: "user"; userId: string; username: string; role: "admin" | "member" }
  | { kind: "agent"; agentId: string; userId: string | null; tokenId: string };

export function hashApiToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function newApiToken(): string {
  return `ac_${randomBytes(24).toString("base64url")}`;
}

function extractToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    const value = header.slice(7).trim();
    if (value) return value;
  }
  // EventSource 无法设置请求头，允许 SSE 用查询参数携带
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    const q = url.searchParams.get("token");
    if (q && q.trim()) return q.trim();
  } catch {}
  return null;
}

export async function authenticate(req: FastifyRequest, storage: StorageEngine): Promise<Principal | null> {
  const token = extractToken(req);
  if (!token) return null;

  if (token.startsWith("ac_")) {
    const row = await storage.getApiTokenByHash(hashApiToken(token));
    if (!row || row.revokedAt) return null;
    await storage.touchApiToken(row.id);
    if (row.agentId) {
      return { kind: "agent", agentId: row.agentId, userId: row.userId ?? null, tokenId: row.id };
    }
    const user = await storage.getUserById(row.userId);
    if (!user) return null;
    return { kind: "user", userId: user.id, username: user.username, role: user.role };
  }

  const session = verifySessionToken(token);
  if (!session) return null;
  const user = await storage.getUserByUsername(session.username);
  if (!user) return null;
  return { kind: "user", userId: user.id, username: user.username, role: user.role };
}

export type RoutePolicy = "public" | "shared" | "user" | "admin" | "worker";

/**
 * 路由策略：
 * - public：健康检查、登录、静态资源
 * - shared：Worker 与 UI 都会读的只读端点（dashboard 模式放开，strict 模式需任意身份）
 * - user：控制面读写，需用户会话/用户 Token
 * - admin：仅管理员
 * - worker：Worker 执行端点（dashboard 模式兼容无 Token，strict 模式需 Agent Token）
 */
export function classifyRequest(method: string, rawUrl: string): RoutePolicy {
  const path = new URL(rawUrl, "http://127.0.0.1").pathname;
  const m = method.toUpperCase();

  if (path === "/healthz" || path === "/readyz") return "public";
  if (path === "/api/auth/login") return "public";
  if (path === "/api/auth/logout" || path === "/api/auth/me") return "shared";

  // Worker 与消息监听器都会读取
  if (m === "GET" && (path === "/api/events" || path === "/api/tasks" || path.startsWith("/api/tasks/"))) {
    if (m === "GET" && path === "/api/tasks") return "user";
    return "shared";
  }

  // Worker 执行链路
  if (path === "/api/workers/register" || path === "/api/workers/heartbeat") return "worker";
  if (path.startsWith("/api/runs/")) return "worker";
  if (m === "POST" && path === "/api/messages") return "worker";
  if (m === "POST" && path === "/api/a2a/send") return "worker";
  if (m === "POST" && path === "/api/approvals") return "worker";

  if (path.startsWith("/api/tokens")) return "user";
  if (path === "/api/approvals/") return "user";
  if (path.startsWith("/api/approvals/")) return "user";
  if (m === "POST" && path === "/api/projects") return "admin";
  if (m === "POST" && path === "/api/tasks") return "user";
  if (m === "POST" && path.startsWith("/api/tasks/")) return "user";

  if (path === "/api/projects" || path === "/api/workers" || path === "/api/messages") return "user";

  return "user";
}
