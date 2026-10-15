import os from "node:os";
import { HubClient } from "./client.js";
import { GrokAdapter } from "@ai-collab/adapter-grok";
import { CodexAdapter } from "@ai-collab/adapter-codex";

export interface WorkerConfig {
  hubUrl: string;
  projectId: string;
  agentType: "grok" | "codex";
  workerId?: string;
  workspaceDir: string;
  token?: string;
}

export class WorkerRunner {
  readonly config: WorkerConfig;
  readonly workerId: string;
  readonly client: HubClient;
  private running = false;
  private currentRunId: string | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private leaseRenewTimer: NodeJS.Timeout | null = null;
  private adapter: GrokAdapter | CodexAdapter;

  constructor(config: WorkerConfig) {
    this.config = config;
    this.workerId = config.workerId || `worker_${config.agentType}_${os.hostname()}_${Math.random().toString(36).slice(2, 6)}`;
    this.client = new HubClient(config.hubUrl, config.token);
    this.adapter = config.agentType === "grok" ? new GrokAdapter() : new CodexAdapter();
  }

  async start(): Promise<void> {
    this.running = true;
    console.log(`[Worker-${this.config.agentType}]: 正在启动常驻守护进程 (Worker ID: ${this.workerId})...`);

    // 1. 注册能力
    await this.client.registerWorker({
      id: this.workerId,
      agentType: this.config.agentType,
      name: `${this.config.agentType.toUpperCase()} Worker @ ${os.hostname()}`,
      hostname: os.hostname(),
      capabilities: [this.config.agentType, "unity", "csharp", "uvcs"],
      version: "0.1.0",
    });
    console.log(`[Worker-${this.config.agentType}]: 成功在 Hub 注册在线状态`);

    // 2. 启动 15s 心跳
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.client.sendHeartbeat({
          workerId: this.workerId,
          currentRunId: this.currentRunId,
        });
      } catch (err) {
        console.warn(`[Worker-${this.config.agentType}]: 心跳发送受阻:`, err instanceof Error ? err.message : err);
      }
    }, 15000);

    // 3. 进入有界长轮询接单循环
    let backoffMs = 2000;
    while (this.running) {
      try {
        const claimResult = await this.client.claimRun({
          workerId: this.workerId,
          projectId: this.config.projectId,
          agentType: this.config.agentType,
          timeoutSeconds: 15,
        });

        backoffMs = 2000; // 成功通讯，重置退避时间

        if (claimResult) {
          const { task, run } = claimResult;
          this.currentRunId = run.id;
          console.log(`\n======================================================`);
          console.log(`[Worker-${this.config.agentType}]: 成功抢单! Task: ${task.id} (${task.title})`);
          console.log(`[Worker-${this.config.agentType}]: 获得租约 Fencing Token: ${run.fencingToken}`);
          console.log(`======================================================\n`);

          // 启动自动续租计时器（每 20s 续订 60s 租约）
          this.startLeaseRenewal(run.id, run.fencingToken);

          try {
            // 调用模型适配器在任务工作目录执行
            const execResult = await this.adapter.executeTask({
              task,
              run,
              workspaceDir: this.config.workspaceDir,
              onLog: (line) => console.log(`[AI-Exec]: ${line}`),
            });

            // 提交任务成果
            await this.client.submitRun({
              runId: run.id,
              workerId: this.workerId,
              fencingToken: run.fencingToken,
              summary: execResult.summary,
              changesetSpec: execResult.changesetSpec,
              artifacts: [],
            });
            console.log(`[Worker-${this.config.agentType}]: 任务执行完毕并已提交回 Hub!`);
          } catch (taskErr) {
            console.error(`[Worker-${this.config.agentType}]: 任务执行异常:`, taskErr);
          } finally {
            this.stopLeaseRenewal();
            this.currentRunId = null;
          }
        }
      } catch (pollErr) {
        console.warn(`[Worker-${this.config.agentType}]: 轮询等待异常，将在 ${backoffMs / 1000}s 后重试...`, pollErr instanceof Error ? pollErr.message : pollErr);
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 30000); // 指数退避，上限 30 秒
      }
    }
  }

  private startLeaseRenewal(runId: string, fencingToken: number) {
    this.stopLeaseRenewal();
    this.leaseRenewTimer = setInterval(async () => {
      try {
        await this.client.renewRun({
          runId,
          workerId: this.workerId,
          fencingToken,
          extendSeconds: 60,
        });
        console.log(`[Worker-${this.config.agentType}]: 租约续订成功 (Fencing: ${fencingToken})`);
      } catch (err) {
        console.error(`[Worker-${this.config.agentType}]: 租约续订失败:`, err);
      }
    }, 20000);
  }

  private stopLeaseRenewal() {
    if (this.leaseRenewTimer) {
      clearInterval(this.leaseRenewTimer);
      this.leaseRenewTimer = null;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.stopLeaseRenewal();
    await this.adapter.cancel();
    console.log(`[Worker-${this.config.agentType}]: 守护进程已停止`);
  }
}
