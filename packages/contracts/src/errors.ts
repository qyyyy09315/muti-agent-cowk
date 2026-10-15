export const ErrorCode = {
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  OFFLINE: "OFFLINE",
  LEASE_EXPIRED: "LEASE_EXPIRED",
  CONFLICT: "CONFLICT",
  BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
  WAITING_HUMAN: "WAITING_HUMAN",
  ADAPTER_INCOMPATIBLE: "ADAPTER_INCOMPATIBLE",
  ARTIFACT_TOO_LARGE: "ARTIFACT_TOO_LARGE",
  INVALID_STATE_TRANSITION: "INVALID_STATE_TRANSITION",
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  RESOURCE_LOCKED: "RESOURCE_LOCKED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

export class CollabError extends Error {
  readonly code: ErrorCodeType;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCodeType, message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = "CollabError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
