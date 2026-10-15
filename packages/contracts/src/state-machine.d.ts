export declare const TaskState: {
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
};
export type TaskStateType = (typeof TaskState)[keyof typeof TaskState];
/**
 * 终态集合：处于终态的任务不可再向前流转
 */
export declare const TERMINAL_STATES: ReadonlySet<TaskStateType>;
/**
 * 显式状态转移表：仅允许表格中声明的前后状态流转
 */
export declare const ALLOWED_TRANSITIONS: Readonly<Record<TaskStateType, ReadonlySet<TaskStateType>>>;
/**
 * 校验状态流转是否合法
 */
export declare function isValidStateTransition(from: TaskStateType, to: TaskStateType): boolean;
/**
 * 判断任务是否处于非终态活动中
 */
export declare function isTaskActive(state: TaskStateType): boolean;
//# sourceMappingURL=state-machine.d.ts.map