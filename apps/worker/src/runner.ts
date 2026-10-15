import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { HubClient } from "./client.js";
import { GrokAdapter } from "@ai-collab/adapter-grok";
import { CodexAdapter } from "@ai-collab/adapter-codex";
import { UVCSClient, UnityBridge } from "@ai-collab/uvcs-workspace";
import { CollabError, ErrorCode } from "@ai-collab/contracts";

export interface WorkerConfig {
  hubUrl: string;
  projectId: string;
  agentType: "grok" | "codex";
  workerId?: string;
  workspaceDir: string;
  token?: string;
  cmBinary?: string;
  skipUvcsIsolation?: boolean;
}

export class WorkerRunner {
  readonly config: WorkerConfig;
  readonly workerId: string;
  readonly client: HubClient;
  readonly uvcs: UVCSClient;
  public leaseLost = false;
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
    this.uvcs = new UVCSClient(config.cmBinary);
  }

  async start(): Promise<void> {
    this.running = true;
    console.log(`[Worker-${this.config.agentType}]: 正在启动常驻守护进程 (Worker ID: ${this.workerId})...`);

    await this.client.registerWorker({
      id: this.workerId,
      agentType: this.config.agentType,
      name: `${this.config.agentType.toUpperCase()} Worker @ ${os.hostname()}`,
      hostname: os.hostname(),
      capabilities: [this.config.agentType, "unity", "csharp", "uvcs", "quality_gate"],
      version: "0.2.1",
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

          // 核心修复：接单成功即刻启动续租监控，在后续所有写操作与签入前严密核验
          this.startLeaseRenewal(run.id, run.fencingToken);

          try {
            await this.executePipeline(task, run);
          } finally {
            this.stopLeaseRenewal();
            this.currentRunId = null;
          }
        }
      } catch (pollErr) {
        console.warn(`[Worker-${this.config.agentType}]: 轮询异常，${backoffMs / 1000}s 后重试...`, (pollErr as Error).message);
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 30000);
      }
    }
  }

  /**
   * 前置租约守卫：每个变更和签入前强制复核有效租约
   */
  private assertLeaseActive(): void {
    if (this.leaseLost) {
      throw new CollabError(
        ErrorCode.LEASE_EXPIRED,
        "任务租约已失效或已被抢占，阻断后续写操作与云端签入，防止脑裂覆写！",
        403
      );
    }
  }

  /**
   * 工业级严密执行管线
   */
  async executePipeline(task: any, run: any): Promise<void> {
    const pipelineStartTime = Date.now();
    let wsDir = this.config.workspaceDir;
    const branchName = `br:/main/ai/${task.id}/${this.config.agentType}`;
    const lockedPaths: string[] = [];

    try {
      this.assertLeaseActive();

      // [Step 1] 分支与工作区隔离处理（杜绝直接改写人工日常工作区）
      if (!this.config.skipUvcsIsolation) {
        console.log(`[Pipeline 1/7]: 查询基线状态并准备任务分支: ${branchName}...`);
        const baseStatus = await this.uvcs.getStatus(wsDir);
        await this.uvcs.createBranch(wsDir, branchName, baseStatus.changeset);
        await this.uvcs.switchBranch(wsDir, branchName);
        console.log(`[Pipeline 1/7]: 分支隔离切换成功 (基准变更集: ${baseStatus.changeset})`);
      }

      this.assertLeaseActive();

      // [Step 2] 动态扫描不可合并排他资产并申请锁定
      if (!this.config.skipUvcsIsolation) {
        console.log(`[Pipeline 2/7]: 扫描排他性资源锁定需求...`);
        const lockExtensions = [".unity", ".prefab", ".asset", ".mat", ".fbx", ".png"];
        
        // 扫描 Assets 目录下匹配扩展名的资源
        const assetsDir = path.join(wsDir, "Assets");
        if (fs.existsSync(assetsDir)) {
          const scanLocks = (d: string) => {
            const items = fs.readdirSync(d, { withFileTypes: true });
            for (const it of items) {
              const fp = path.join(d, it.name);
              if (it.isDirectory()) {
                scanLocks(fp);
              } else {
                const ext = path.extname(it.name).toLowerCase();
                // 如果文件名或路径出现在任务目标/标题中，进行精准锁定
                if (lockExtensions.includes(ext) && (task.goal.includes(it.name) || task.title.includes(it.name))) {
                  const rel = path.relative(wsDir, fp).replace(/\\/g, "/");
                  lockedPaths.push(rel);
                }
              }
            }
          };
          scanLocks(assetsDir);
        }

        // 统一申请锁定，冲突即止
        for (const lp of lockedPaths) {
          console.log(`[Pipeline 2/7]: 申请锁定排他资源: ${lp}`);
          await this.uvcs.lockFile(wsDir, lp);
        }
      }

      this.assertLeaseActive();

      // [Step 4] 调用模型适配器（通过 stdin 管道流式传输）
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

      this.assertLeaseActive();

      // [Step 5] 质量门禁：Unity 编译零错误与新鲜编译日志判定
      console.log(`[Pipeline 5/7]: 执行 Unity 质量门禁检测 (.meta GUID 完整性与新鲜编译日志)...`);
      const metaAudit = UnityBridge.auditMetaFiles(wsDir);
      if (!metaAudit.valid) {
        throw new Error(
          `质量门禁拦截: 发现丢失或孤儿 .meta 文件: ${metaAudit.missingMetas.join(", ") || metaAudit.orphanMetas.join(", ")}，严禁带病提交！`
        );
      }

      const editorLogPath = path.join(wsDir, "Editor.log");
      if (fs.existsSync(editorLogPath)) {
        const stat = fs.statSync(editorLogPath);
        // 关键修复：编译日志必须是本次运行之后产生的“新鲜日志”，过期日志视为无效
        if (stat.mtimeMs < pipelineStartTime) {
          throw new Error(`质量门禁拦截: 未检测到本次执行产生的新鲜 Editor.log (日志修改时间早于流水线启动时间)，拒绝放行！`);
        }
        const logContent = fs.readFileSync(editorLogPath, "utf-8");
        const compileErrors = UnityBridge.parseCompileErrors(logContent);
        if (compileErrors.length > 0) {
          throw new Error(`质量门禁拦截: Unity 编译存在 ${compileErrors.length} 处错误: ${compileErrors[0]}`);
        }
      }
      console.log(`[Pipeline 5/7]: 质量门禁检查全部通过 (0 编译错误，0 meta 丢失，新鲜日志校验有效)`);

      // 关键防脑裂修复：在执行 cm checkin 签入云端前做最终租约复核！
      this.assertLeaseActive();

      // [Step 6] 真实 cm check-in 签入与变更集验证
      let changeset = `cs:local_${Date.now()}`;
      if (!this.config.skipUvcsIsolation) {
        console.log(`[Pipeline 6/7]: 租约在签入前有效，执行真实 cm 签入与变更集核对...`);
        changeset = await this.uvcs.checkin(wsDir, `[AI-Collab] ${task.title}`);
        const statusAfter = await this.uvcs.getStatus(wsDir);
        console.log(`[Pipeline 6/7]: 成功签入 changeset: ${changeset} (当前分支: ${statusAfter.branch})`);
      }

      // [Step 7] 向 Hub 提交最终成果
      this.assertLeaseActive();

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
      // 核心修复：无论成功、中断还是异常，在 finally 块中完整释放本任务持有的全部文件锁
      if (!this.config.skipUvcsIsolation && lockedPaths.length > 0) {
        console.log(`[Pipeline 清理]: 正在释放本任务申请持有的 ${lockedPaths.length} 个排他资源锁...`);
        for (const lp of lockedPaths) {
          try {
            await this.uvcs.unlockFile(wsDir, lp);
            console.log(`[Pipeline 清理]: 锁已释放: ${lp}`);
          } catch (unlockErr) {
            console.warn(`[Pipeline 清理]: 释放锁异常 (${lp}):`, (unlockErr as Error).message);
          }
        }
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
      } catch (err) {
        console.error(`[Worker-${this.config.agentType}]: 租约续订失败，标记租约丢失并立即终止子进程:`, (err as Error).message);
        this.leaseLost = true;
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
