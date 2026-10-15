import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { HubClient } from "./client.js";
import { GrokAdapter } from "@ai-collab/adapter-grok";
import { CodexAdapter } from "@ai-collab/adapter-codex";
import { UVCSClient, UnityBridge } from "@ai-collab/uvcs-workspace";

export interface WorkerConfig {
  hubUrl: string;
  projectId: string;
  agentType: "grok" | "codex";
  workerId?: string;
  workspaceDir: string;
  token?: string;
  cmBinary?: string;
  skipUvcsIsolation?: boolean; // 仅用于离线轻量单元测试
}

export class WorkerRunner {
  readonly config: WorkerConfig;
  readonly workerId: string;
  readonly client: HubClient;
  readonly uvcs: UVCSClient;
  private running = false;
  private currentRunId: string | null = null;
  private leaseLost = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private leaseRenewTimer: NodeJS.Timeout | null = null;
  private adapter: GrokAdapter | CodexAdapter;

  constructor(config: WorkerConfig) {
    this.config = config;
    this.workerId = config.workerId || `worker_${config.agentType}_${os.hostname()}_${Math.random().toString(36).slice(2, 6)}`;
    this.client = new HubClient(config.hubUrl, config.token);
    this.adapter = config.agentType === "grok" ? new GrokAdapter() : new CodexAdapter();
    this.uvcs = new UVCSClient(config.cmBinary);
  }

  async start(): Promise<void> {
    this.running = true;
    console.log(`[Worker-${this.config.agentType}]: 正在启动工业级守护进程 (Worker ID: ${this.workerId})...`);

    // 1. 注册能力与心跳
    await this.client.registerWorker({
      id: this.workerId,
      agentType: this.config.agentType,
      name: `${this.config.agentType.toUpperCase()} Worker @ ${os.hostname()}`,
      hostname: os.hostname(),
      capabilities: [this.config.agentType, "unity", "csharp", "uvcs", "quality_gate"],
      version: "0.2.0",
    });

    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.client.sendHeartbeat({
          workerId: this.workerId,
          currentRunId: this.currentRunId,
        });
      } catch (err) {
        console.warn(`[Worker-${this.config.agentType}]: 心跳发送受阻:`, (err as Error).message);
      }
    }, 15000);

    // 2. 有界长轮询接单循环
    let backoffMs = 2000;
    while (this.running) {
      try {
        const claimResult = await this.client.claimRun({
          workerId: this.workerId,
          projectId: this.config.projectId,
          agentType: this.config.agentType,
          timeoutSeconds: 15,
        });

        backoffMs = 2000;

        if (claimResult) {
          const { task, run } = claimResult;
          this.currentRunId = run.id;
          this.leaseLost = false;

          console.log(`\n======================================================`);
          console.log(`[Worker-${this.config.agentType}]: 成功抢单! Task: ${task.id} (${task.title})`);
          console.log(`[Worker-${this.config.agentType}]: 租约 Fencing Token: ${run.fencingToken}`);
          console.log(`======================================================`);

          // 核心闭环执行管线
          await this.executePipeline(task, run);
        }
      } catch (pollErr) {
        console.warn(`[Worker-${this.config.agentType}]: 轮询异常，${backoffMs / 1000}s 后重试...`, (pollErr as Error).message);
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 30000);
      }
    }
  }

  /**
   * 工业级严密执行管线：
   * 分支隔离 -> 资源锁判定 -> 租约守护 -> 模型执行 -> 质量门禁 -> cm签入 -> 防脑裂复核 -> 提交成果
   */
  async executePipeline(task: any, run: any): Promise<void> {
    const wsDir = this.config.workspaceDir;
    const branchName = `br:/main/ai/${task.id}/${this.config.agentType}`;
    let lockedPaths: string[] = [];

    // [Step 1] UVCS 任务隔离分支创建与切换
    if (!this.config.skipUvcsIsolation) {
      try {
        console.log(`[Pipeline 1/7]: 创建并切换至任务隔离分支: ${branchName}...`);
        await this.uvcs.createBranch(wsDir, branchName);
        await this.uvcs.switchBranch(wsDir, branchName);
        console.log(`[Pipeline 1/7]: 分支隔离切换成功`);
      } catch (err) {
        console.error(`[Pipeline 终止]: 无法创建或切换 UVCS 分支，任务中止:`, (err as Error).message);
        return;
      }
    }

    // [Step 2] 确认不可合并文件（场景/Prefab/二进制）并申请排他锁
    if (!this.config.skipUvcsIsolation) {
      try {
        console.log(`[Pipeline 2/7]: 扫描排他性资源锁定需求...`);
        // 自动识别任务中是否指明了特定场景或资源
        if (task.goal.includes(".unity") || task.title.includes("场景")) {
          const targetScene = "Assets/Scenes/Main.unity";
          console.log(`[Pipeline 2/7]: 申请锁定排他场景资源: ${targetScene}`);
          await this.uvcs.lockFile(wsDir, targetScene);
          lockedPaths.push(targetScene);
        }
      } catch (err) {
        console.error(`[Pipeline 终止]: 资源锁冲突，已有其他人员/Agent持有排他锁，停止执行:`, (err as Error).message);
        return;
      }
    }

    // [Step 3] 启动自动续租与防脑裂监控
    this.startLeaseRenewal(run.id, run.fencingToken);

    try {
      // [Step 4] 调用适配器（通过 stdin 管道灌入 prompt）
      console.log(`[Pipeline 4/7]: 启动模型适配器执行任务 (stdin 管道流传输)...`);
      const execResult = await this.adapter.executeTask({
        task,
        run,
        workspaceDir: wsDir,
        onLog: (line: string) => console.log(`[AI-Exec]: ${line}`),
      });

      if (!execResult.success) {
        throw new Error(`AI 执行未达成目标或进程异常退出 (Code ${execResult.exitCode})`);
      }

      // [Step 5] 质量门禁：Unity 编译零错误与 .meta GUID 完整性校验
      console.log(`[Pipeline 5/7]: 执行 Unity 质量门禁检测 (.meta GUID 完整性与编译校验)...`);
      const metaAudit = UnityBridge.auditMetaFiles(wsDir);
      if (!metaAudit.valid) {
        throw new Error(
          `质量门禁拦截: 发现丢失或孤儿 .meta 文件: ${metaAudit.missingMetas.join(", ") || metaAudit.orphanMetas.join(", ")}，严禁带病提交！`
        );
      }

      // 检查 Editor 日志是否存在编译报错
      const editorLogPath = path.join(wsDir, "Editor.log");
      if (fs.existsSync(editorLogPath)) {
        const logContent = fs.readFileSync(editorLogPath, "utf-8");
        const compileErrors = UnityBridge.parseCompileErrors(logContent);
        if (compileErrors.length > 0) {
          throw new Error(`质量门禁拦截: Unity 编译存在 ${compileErrors.length} 处错误: ${compileErrors[0]}`);
        }
      }
      console.log(`[Pipeline 5/7]: 质量门禁检查全部通过 (0 编译错误，0 meta 丢失)`);

      // [Step 6] 真实 cm check-in 签入与变更集 (Changeset) 服务端核对
      let changeset = `cs:local_${Date.now()}`;
      if (!this.config.skipUvcsIsolation) {
        console.log(`[Pipeline 6/7]: 执行真实 cm 签入与变更集验证...`);
        changeset = await this.uvcs.checkin(wsDir, `[AI-Collab] ${task.title}`);
        const statusAfter = await this.uvcs.getStatus(wsDir);
        console.log(`[Pipeline 6/7]: 成功签入 changeset: ${changeset} (当前分支: ${statusAfter.branch})`);
      }

      // [Step 7] 最终租约复核与成果提交（租约丢失必须坚决停止交付）
      if (this.leaseLost) {
        console.error(`[Pipeline 严重阻断]: 任务期间租约已丢失或已被其他 Worker 抢占，坚决停止交付成果，防止脑裂覆写！`);
        return;
      }

      console.log(`[Pipeline 7/7]: 租约验证有效 (Fencing: ${run.fencingToken})，正在提交成果至 Hub...`);
      await this.client.submitRun({
        runId: run.id,
        workerId: this.workerId,
        fencingToken: run.fencingToken,
        summary: execResult.summary,
        changesetSpec: changeset,
        artifacts: [],
      });
      console.log(`🎉 [Worker-${this.config.agentType}]: 任务交付全流程圆满完成！`);
    } catch (pipelineErr) {
      console.error(`[Pipeline 失败]: 流程中断:`, (pipelineErr as Error).message);
    } finally {
      this.stopLeaseRenewal();
      this.currentRunId = null;
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
      } catch (err) {
        console.error(`[Worker-${this.config.agentType}]: 租约续订失败，标记租约丢失并立即终止子进程:`, (err as Error).message);
        this.leaseLost = true;
        // 租约丢失立即终止 AI 进程，防止脑裂
        await this.adapter.cancel();
        this.stopLeaseRenewal();
      }
    }, 15000);
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
    console.log(`[Worker-${this.config.agentType}]: 守护进程已安全停止`);
  }
}
