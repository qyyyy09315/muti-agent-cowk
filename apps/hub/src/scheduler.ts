import {
  ClaimRunInput,
  RenewRunInput,
  SubmitRunInput,
  FailRunInput,
  Run,
  Task,
  TaskState,
  CollabError,
  ErrorCode,
} from "@ai-collab/contracts";
import { StorageEngine } from "./types.js";

type ClaimWaiter = {
  workerId: string;
  projectId: string;
  agentType: "grok" | "codex";
  resolve: (result: { task: Task; run: Run } | null) => void;
  timer: NodeJS.Timeout;
};

export class HubScheduler {
  private storage: StorageEngine;
  private waiters = new Set<ClaimWaiter>();
  private reapTimer: NodeJS.Timeout | null = null;

  constructor(storage: StorageEngine) {
    this.storage = storage;
  }

  startReaper(intervalMs = 10000): void {
    if (this.reapTimer) clearInterval(this.reapTimer);
    this.reapTimer = setInterval(async () => {
      try {
        const reaped = await this.storage.reapExpiredLeases();
        if (reaped > 0) {
          this.notifyNewQueuedTask();
        }
      } catch (err) {
        console.error("[Scheduler Reaper Error]:", err);
      }
    }, intervalMs);
  }

  stopReaper(): void {
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
  }

  /**
   * 触发等待队列中的 Worker 重新尝试接单
   */
  notifyNewQueuedTask(): void {
    if (this.waiters.size === 0) return;
    const currentWaiters = Array.from(this.waiters);
    for (const waiter of currentWaiters) {
      this.storage
        .claimAvailableTask(waiter.workerId, waiter.projectId, waiter.agentType, 60)
        .then((claimed) => {
          if (claimed) {
            clearTimeout(waiter.timer);
            this.waiters.delete(waiter);
            waiter.resolve(claimed);
          }
        })
        .catch(() => {});
    }
  }

  /**
   * 有界长轮询接单：立即抢单，若无任务则挂起等待直到有新任务或超时
   */
  async claimRun(input: ClaimRunInput): Promise<{ task: Task; run: Run } | null> {
    // 1. 尝试立即获取任务
    const immediate = await this.storage.claimAvailableTask(
      input.workerId,
      input.projectId,
      input.agentType,
      60
    );
    if (immediate) return immediate;

    // 2. 无可用任务，进入有界长轮询挂起队列
    return new Promise<{ task: Task; run: Run } | null>((resolve) => {
      let waiter: ClaimWaiter;
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve(null);
      }, input.timeoutSeconds * 1000);

      waiter = {
        workerId: input.workerId,
        projectId: input.projectId,
        agentType: input.agentType,
        resolve,
        timer,
      };

      this.waiters.add(waiter);
    });
  }

  async renewRun(input: RenewRunInput): Promise<Run> {
    return this.storage.renewLease(
      input.runId,
      input.workerId,
      input.fencingToken,
      input.extendSeconds
    );
  }

  async submitRun(input: SubmitRunInput): Promise<Run> {
    const res = await this.storage.submitRun(
      input.runId,
      input.workerId,
      input.fencingToken,
      input.summary
    );
    this.notifyNewQueuedTask();
    return res;
  }

  async failRun(input: FailRunInput): Promise<Run> {
    const res = await this.storage.failRun(
      input.runId,
      input.workerId,
      input.fencingToken,
      input.reason
    );
    this.notifyNewQueuedTask();
    return res;
  }
}
