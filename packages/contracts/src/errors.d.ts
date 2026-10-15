export declare const ErrorCode: {
    readonly UNAUTHORIZED: "UNAUTHORIZED";
    readonly FORBIDDEN: "FORBIDDEN";
    readonly OFFLINE: "OFFLINE";
    readonly LEASE_EXPIRED: "LEASE_EXPIRED";
    readonly CONFLICT: "CONFLICT";
    readonly BUDGET_EXCEEDED: "BUDGET_EXCEEDED";
    readonly WAITING_HUMAN: "WAITING_HUMAN";
    readonly ADAPTER_INCOMPATIBLE: "ADAPTER_INCOMPATIBLE";
    readonly ARTIFACT_TOO_LARGE: "ARTIFACT_TOO_LARGE";
    readonly INVALID_STATE_TRANSITION: "INVALID_STATE_TRANSITION";
    readonly TASK_NOT_FOUND: "TASK_NOT_FOUND";
    readonly RESOURCE_LOCKED: "RESOURCE_LOCKED";
    readonly INTERNAL_ERROR: "INTERNAL_ERROR";
};
export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];
export declare class CollabError extends Error {
    readonly code: ErrorCodeType;
    readonly status: number;
    readonly details?: Record<string, unknown>;
    constructor(code: ErrorCodeType, message: string, status?: number, details?: Record<string, unknown>);
}
//# sourceMappingURL=errors.d.ts.map