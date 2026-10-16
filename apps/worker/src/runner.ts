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
  taskWorkspaceBaseDir?: string; // 独立任务工作区根目录
  skipUvcsIsolation?: boolean;   // 仅用于离线极简单元测试
  skipCompileGate?: boolean;     // 仅用于不涉及 Unity 编译的纯文本任务测试
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
      version: "0.2.3",
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

  public assertLeaseActive(): void {
    if (this.leaseLost) {
      throw new CollabError(
        ErrorCode.LEASE_EXPIRED,
        "任务租约已失效或已被抢占，严禁后续写操作与云端签入，坚决防止脑裂覆写！",
        403
      );
    }
  }

  /**
   * 工业级严密执行管线
   */
  async executePipeline(task: any, run: any): Promise<void> {
    const pipelineStartTime = Date.now();
    const baseWsDir = this.config.workspaceDir;
    const branchName = `br:/main/ai/${task.id}/${this.config.agentType}`;

    const taskWsBase = this.config.taskWorkspaceBaseDir || path.join(os.tmpdir(), "collab_task_workspaces");
    const taskWsDir = this.config.skipUvcsIsolation
      ? baseWsDir
      : path.join(taskWsBase, `wk_${task.id}_${this.config.agentType}`);
    const taskWkName = `wk_${task.id}_${this.config.agentType}_${Date.now()}`;

    let createdTaskWorkspace = false;
    let pipelineSucceeded = false;
    const targetLockPaths: string[] = [];
    const acquiredLocks: string[] = [];

    try {
      this.assertLeaseActive();

      // [Step 1] 独立任务工作空间隔离与分支创建
      if (!this.config.skipUvcsIsolation) {
        console.log(`[Pipeline 1/7]: 查询基线状态并创建独立任务工作空间: ${taskWsDir}...`);
        const baseStatus = await this.uvcs.getStatus(baseWsDir);
        
        fs.mkdirSync(taskWsDir, { recursive: true });
        await this.uvcs.createWorkspace(taskWkName, taskWsDir, baseStatus.repository);
        createdTaskWorkspace = true;

        // 关键修复 1：采用官方 --changeset=cs:<num> 语法创建独立任务分支
        await this.uvcs.createBranch(taskWsDir, branchName, baseStatus.changeset);
        await this.uvcs.switchBranch(taskWsDir, branchName);
        console.log(`[Pipeline 1/7]: 独立任务工作空间就绪 (当前分支: ${branchName}, 基线变更集: ${baseStatus.changeset})`);
      }

      this.assertLeaseActive();

      // [Step 2] 动态扫描不可合并排他资产并申请锁定
      if (!this.config.skipUvcsIsolation) {
        console.log(`[Pipeline 2/7]: 扫描排他性资源锁定需求...`);
        const lockExtensions = [".unity", ".prefab", ".asset", ".mat", ".fbx", ".png"];
        
        const assetsDir = path.join(taskWsDir, "Assets");
        if (fs.existsSync(assetsDir)) {
          const scanLocks = (d: string) => {
            const items = fs.readdirSync(d, { withFileTypes: true });
            for (const it of items) {
              const fp = path.join(d, it.name);
              if (it.isDirectory()) {
                scanLocks(fp);
              } else {
                const ext = path.extname(it.name).toLowerCase();
                if (lockExtensions.includes(ext) && (task.goal.includes(it.name) || task.title.includes(it.name))) {
                  const rel = path.relative(taskWsDir, fp).replace(/\\/g, "/");
                  targetLockPaths.push(rel);
                }
              }
            }
          };
          scanLocks(assetsDir);
        }

        for (const lp of targetLockPaths) {
          console.log(`[Pipeline 2/7]: 尝试锁定排他资源: ${lp}`);
          await this.uvcs.lockFile(taskWsDir, lp);
          acquiredLocks.push(lp);
          console.log(`[Pipeline 2/7]: 成功锁定: ${lp}`);
        }
      }

      this.assertLeaseActive();

      // [Step 3] 调用模型适配器在独立任务工作空间执行（stdin 管道传输）
      console.log(`[Pipeline 3/7]: 启动模型适配器执行任务 (stdin 管道流传输)...`);
      const execResult = await this.adapter.executeTask({
        task,
        run,
        workspaceDir: taskWsDir,
        onLog: (line: string) => console.log(`[AI-Exec]: ${line}`),
      });

      if (!execResult.success) {
        throw new Error(`AI 执行未达成目标或进程异常退出 (Code ${execResult.exitCode})`);
      }

      this.assertLeaseActive();

      // [Step 4] 质量门禁：严禁无日志放行！强制要求新鲜编译日志与 .meta 完整性
      console.log(`[Pipeline 4/7]: 执行 Unity 质量门禁检测 (.meta 完整性与新鲜 Editor.log 零错误)...`);
      const metaAudit = UnityBridge.auditMetaFiles(taskWsDir);
      if (!metaAudit.valid) {
        throw new Error(
          `质量门禁拦截: 发现丢失或孤儿 .meta 文件: ${metaAudit.missingMetas.join(", ") || metaAudit.orphanMetas.join(", ")}，严禁带病提交！`
        );
      }

      if (!this.config.skipCompileGate) {
        const editorLogPath = path.join(taskWsDir, "Editor.log");
        if (!fs.existsSync(editorLogPath)) {
          throw new Error(
            `质量门禁拦截: 未检测到 Unity 编译日志 Editor.log！未进行本次编译与自动化测试验证前严禁放行签入！`
          );
        }

        const stat = fs.statSync(editorLogPath);
        if (stat.mtimeMs < pipelineStartTime) {
          throw new Error(
            `质量门禁拦截: 检测到陈旧的 Editor.log (修改时间早于本次任务启动时间)，未执行本次最新编译校验，拒绝放行！`
          );
        }

        const logContent = fs.readFileSync(editorLogPath, "utf-8");
        const compileErrors = UnityBridge.parseCompileErrors(logContent);
        if (compileErrors.length > 0) {
          throw new Error(`质量门禁拦截: Unity 编译存在 ${compileErrors.length} 处错误: ${compileErrors[0]}`);
        }
        console.log(`[Pipeline 4/7]: Unity 编译门禁严格核验通过 (0 编译错误，新鲜日志校验有效)`);
      } else {
        console.log(`[Pipeline 4/7]: 纯代码测试环境，跳过 Editor.log 强制校验`);
      }

      this.assertLeaseActive();

      // [Step 5] 真实 cm check-in 签入与变更集验证
      let changeset = `cs:local_${Date.now()}`;
      if (!this.config.skipUvcsIsolation) {
        console.log(`[Pipeline 5/7]: 租约在签入前有效，在独立工作空间执行真实 cm 签入...`);
        changeset = await this.uvcs.checkin(taskWsDir, `[AI-Collab] ${task.title}`);
        const statusAfter = await this.uvcs.getStatus(taskWsDir);
        console.log(`[Pipeline 5/7]: 成功签入 changeset: ${changeset} (当前分支: ${statusAfter.branch})`);
      }

      // [Step 6] 成果提交至 Hub
      this.assertLeaseActive();

      console.log(`[Pipeline 6/7]: 租约核验有效 (Fencing: ${run.fencingToken})，正在提交成果至 Hub...`);
      await this.client.submitRun({
        runId: run.id,
        workerId: this.workerId,
        fencingToken: run.fencingToken,
        summary: execResult.summary,
        changesetSpec: changeset,
        artifacts: [],
      });
      console.log(`🎉 [Worker-${this.config.agentType}]: 任务交付全流程圆满完成！`);
      pipelineSucceeded = true;
    } catch (pipelineErr) {
      console.error(`[Pipeline 失败]: 流程中断:`, (pipelineErr as Error).message);
      throw pipelineErr;
    } finally {
      // 关键修复 2：失败清理前必须先完整保存修改到检查点目录！
      // 杜绝 undocheckout 默认将已修改文件还原（revert）回签出前版本导致工作成果灰飞烟灭
      if (!pipelineSucceeded) {
        try {
          const checkpointDir = path.join(
            baseWsDir,
            ".collab_checkpoints",
            `task_${task.id}_attempt_${run.attempt || 1}`
          );
          console.log(`[Pipeline 安全保护]: 检测到任务未成功签入，在释放锁/清理前将修改完整备份归档至: ${checkpointDir}...`);
          this.saveCheckpoint(taskWsDir, checkpointDir, acquiredLocks, task.id);
        } catch (backupErr) {
          console.warn(`[Pipeline 安全保护]: 备份改动遇到提示:`, (backupErr as Error).message);
        }
      }

      // 释放排他锁：在修改已完整归档后，安全执行 undocheckout 释放持有的锁
      if (acquiredLocks.length > 0) {
        console.log(`[Pipeline 清理]: 正在释放本任务实际持有的 ${acquiredLocks.length} 个排他资源锁...`);
        for (const lp of acquiredLocks) {
          try {
            await this.uvcs.unlockFile(taskWsDir, lp);
            console.log(`[Pipeline 清理]: 已精准释放持有的排他锁: ${lp}`);
          } catch (unlockErr) {
            console.warn(`[Pipeline 清理]: 释放锁异常 (${lp}):`, (unlockErr as Error).message);
          }
        }
      }

      // 清理临时独立任务工作空间
      if (createdTaskWorkspace) {
        try {
          console.log(`[Pipeline 清理]: 正在注销任务临时工作空间: ${taskWkName}...`);
          await this.uvcs.deleteWorkspace(taskWkName);
        } catch (delErr) {
          console.warn(`[Pipeline 清理]: 注销临时工作空间提示:`, (delErr as Error).message);
        }
      }
    }
  }

  /**
   * 安全检查点备份：在 undocheckout 前将工作区被修改的文件保存到持久化检查点目录
   */
  public saveCheckpoint(
    sourceDir: string,
    checkpointDir: string,
    acquiredLocks: string[],
    taskId: string
  ): string[] {
    const backedUp: string[] = [];
    fs.mkdirSync(checkpointDir, { recursive: true });

    // 1. 优先备份所有已申请排他锁的文件（它们必然被修改，且即将被 undocheckout 还原）
    for (const relPath of acquiredLocks) {
      const srcFile = path.join(sourceDir, relPath);
      if (fs.existsSync(srcFile) && fs.statSync(srcFile).isFile()) {
        const destFile = path.join(checkpointDir, relPath);
        fs.mkdirSync(path.dirname(destFile), { recursive: true });
        fs.copyFileSync(srcFile, destFile);
        backedUp.push(relPath);
      }
    }

    // 2. 扫描 Assets/ 目录下所有已存在的文件，备份生成结果
    const assetsDir = path.join(sourceDir, "Assets");
    if (fs.existsSync(assetsDir)) {
      const copyAll = (dir: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            copyAll(fullPath);
          } else if (entry.isFile()) {
            const rel = path.relative(sourceDir, fullPath).replace(/\\/g, "/");
            if (!backedUp.includes(rel)) {
              const destFile = path.join(checkpointDir, rel);
              fs.mkdirSync(path.dirname(destFile), { recursive: true });
              fs.copyFileSync(fullPath, destFile);
              backedUp.push(rel);
            }
          }
        }
      };
      copyAll(assetsDir);
    }

    // 3. 写入清单信息文件 manifest.json
    const manifest = {
      taskId,
      savedAt: new Date().toISOString(),
      backedUpFiles: backedUp,
      reason: "Preserved before undocheckout revert on failure/cancel",
    };
    fs.writeFileSync(path.join(checkpointDir, "manifest.json"), JSON.stringify(manifest, null, 2));

    console.log(`[Pipeline 安全保护]: 已安全归档 ${backedUp.length} 个文件到检查点目录 (${checkpointDir})`);
    return backedUp;
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
