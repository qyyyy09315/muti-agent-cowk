export const TaskState = {
    QUEUED: "queued",
    LEASED: "leased",
    RUNNING: "running",
    SUBMITTED: "submitted",
    REVIEWING: "reviewing",
    COMPLETED: "completed",
    NEEDS_CHANGES: "needs_changes",
    WAITING_PEER: "waiting_peer",
    WAITING_HUMAN: "waiting_human",
    PAUSED: "paused",
    FAILED: "failed",
    CANCELLED: "cancelled",
};
/**
 * 终态集合：处于终态的任务不可再向前流转
 */
export const TERMINAL_STATES = new Set([
    TaskState.COMPLETED,
    TaskState.FAILED,
    TaskState.CANCELLED,
]);
/**
 * 显式状态转移表：仅允许表格中声明的前后状态流转
 */
export const ALLOWED_TRANSITIONS = {
    [TaskState.QUEUED]: new Set([TaskState.LEASED, TaskState.CANCELLED, TaskState.PAUSED]),
    [TaskState.LEASED]: new Set([
        TaskState.RUNNING,
        TaskState.QUEUED, // 租约超时重新入队
        TaskState.FAILED,
        TaskState.CANCELLED,
        TaskState.PAUSED,
    ]),
    [TaskState.RUNNING]: new Set([
        TaskState.SUBMITTED,
        TaskState.WAITING_PEER,
        TaskState.WAITING_HUMAN,
        TaskState.PAUSED,
        TaskState.FAILED,
        TaskState.CANCELLED,
    ]),
    [TaskState.SUBMITTED]: new Set([TaskState.REVIEWING, TaskState.FAILED, TaskState.CANCELLED]),
    [TaskState.REVIEWING]: new Set([
        TaskState.COMPLETED,
        TaskState.NEEDS_CHANGES,
        TaskState.FAILED,
        TaskState.CANCELLED,
        TaskState.WAITING_HUMAN,
    ]),
    [TaskState.NEEDS_CHANGES]: new Set([
        TaskState.QUEUED, // 派生出新修复轮次
        TaskState.RUNNING,
        TaskState.FAILED,
        TaskState.CANCELLED,
    ]),
    [TaskState.WAITING_PEER]: new Set([
        TaskState.RUNNING, // 收到对端回复后恢复
        TaskState.FAILED,
        TaskState.CANCELLED,
        TaskState.WAITING_HUMAN, // 互问成环转人工
    ]),
    [TaskState.WAITING_HUMAN]: new Set([
        TaskState.RUNNING, // 人工审批/干预通过后恢复
        TaskState.REVIEWING,
        TaskState.FAILED,
        TaskState.CANCELLED,
        TaskState.PAUSED,
    ]),
    [TaskState.PAUSED]: new Set([
        TaskState.RUNNING, // 人工解除暂停
        TaskState.QUEUED,
        TaskState.CANCELLED,
    ]),
    // 终态无法向任何状态迁移
    [TaskState.COMPLETED]: new Set(),
    [TaskState.FAILED]: new Set(),
    [TaskState.CANCELLED]: new Set(),
};
/**
 * 校验状态流转是否合法
 */
export function isValidStateTransition(from, to) {
    if (from === to)
        return true;
    const allowed = ALLOWED_TRANSITIONS[from];
    return Boolean(allowed && allowed.has(to));
}
/**
 * 判断任务是否处于非终态活动中
 */
export function isTaskActive(state) {
    return !TERMINAL_STATES.has(state);
}
//# sourceMappingURL=state-machine.js.map