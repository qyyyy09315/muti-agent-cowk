import { spawn, ChildProcess } from "node:child_process";
import { Task, Run } from "@ai-collab/contracts";

export interface ExecutionContext {
  task: Task;
  run: Run;
  workspaceDir: string;
  onLog?: (line: string) => void;
  onRequestApproval?: (action: string, description: string) => Promise<boolean>;
}

export interface ExecutionResult {
  success: boolean;
  summary: string;
  changesetSpec?: string;
  exitCode: number;
}

export class GrokAdapter {
  readonly agentType = "grok" as const;
  private currentProcess: ChildProcess | null = null;
  private grokBinary: string;

  constructor(grokBinary = process.env.GROK_BIN || "grok") {
    this.grokBinary = grokBinary;
  }

  /**
   * 启动真实 Grok Build 终端进程执行任务
   * 采用官方 Headless 批处理调用规程，绑定任务独立工作区
   */
  async executeTask(ctx: ExecutionContext): Promise<ExecutionResult> {
    const prompt = [
      `[Task ID: ${ctx.task.id}]`,
      `[Title]: ${ctx.task.title}`,
      `[Goal]: ${ctx.task.goal}`,
      `[Acceptance Criteria]: ${ctx.task.acceptanceCriteria}`,
      `[Workspace]: ${ctx.workspaceDir}`,
      `请在当前 Unity 工作区中实现该需求，确保 C# 脚本规范，遵循 UVCS 版本控制规则。`,
    ].join("\n");

    ctx.onLog?.(`[GrokAdapter]: 正在启动真实 Grok 进程 (${this.grokBinary})...`);
    ctx.onLog?.(`[GrokAdapter]: 工作区路径: ${ctx.workspaceDir}`);

    return new Promise((resolve, reject) => {
      // 官方 headless 模式参数
      const args = ["run", "--headless", "-p", prompt];

      try {
        const proc = spawn(this.grokBinary, args, {
          cwd: ctx.workspaceDir,
          env: {
            ...process.env,
            COLLAB_TASK_ID: ctx.task.id,
            COLLAB_RUN_ID: ctx.run.id,
          },
          // 独立进程组，保证可干净杀死整棵子进程树
          detached: process.platform !== "win32",
          shell: process.platform === "win32",
        });

        this.currentProcess = proc;
        let stdoutAcc = "";
        let stderrAcc = "";

        proc.stdout?.on("data", (chunk: Buffer) => {
          const lines = chunk.toString().split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
              stdoutAcc += trimmed + "\n";
              ctx.onLog?.(trimmed);
            }
          }
        });

        proc.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString().trim();
          if (text) {
            stderrAcc += text + "\n";
            ctx.onLog?.(`[Grok-Err]: ${text}`);
          }
        });

        proc.on("error", (err: Error) => {
          this.currentProcess = null;
          ctx.onLog?.(`[GrokAdapter 启动失败]: 未找到可执行文件 ${this.grokBinary} 或进程创建失败: ${err.message}`);
          resolve({
            success: false,
            summary: `Grok 进程启动异常: ${err.message}`,
            exitCode: -1,
          });
        });

        proc.on("close", (code) => {
          this.currentProcess = null;
          const exitCode = code ?? 0;
          ctx.onLog?.(`[GrokAdapter]: Grok 进程退出，退出码: ${exitCode}`);
          resolve({
            success: exitCode === 0,
            summary: exitCode === 0 ? `Grok 成功完成任务: ${ctx.task.title}` : `Grok 执行未通过，退出码: ${exitCode}`,
            exitCode,
          });
        });
      } catch (err) {
        resolve({
          success: false,
          summary: `无法创建子进程: ${(err as Error).message}`,
          exitCode: -1,
        });
      }
    });
  }

  /**
   * 安全杀死子进程树（跨平台支持 Windows taskkill / POSIX kill）
   */
  async cancel(): Promise<void> {
    if (!this.currentProcess || !this.currentProcess.pid) return;
    const pid = this.currentProcess.pid;

    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", pid.toString(), "/T", "/F"]);
      } else {
        process.kill(-pid, "SIGTERM");
      }
    } catch (e) {
      try {
        this.currentProcess.kill("SIGKILL");
      } catch {}
    } finally {
      this.currentProcess = null;
    }
  }
}
