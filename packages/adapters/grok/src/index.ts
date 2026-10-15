import { spawn, ChildProcess, execSync } from "node:child_process";
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

  async executeTask(ctx: ExecutionContext): Promise<ExecutionResult> {
    const taskPayload = JSON.stringify({
      taskId: ctx.task.id,
      title: ctx.task.title,
      goal: ctx.task.goal,
      acceptanceCriteria: ctx.task.acceptanceCriteria,
      workspaceDir: ctx.workspaceDir,
      assignedAgent: "grok",
    }, null, 2);

    ctx.onLog?.(`[GrokAdapter]: 准备通过 stdin 发送任务载荷至 Grok (进程: ${this.grokBinary})...`);
    ctx.onLog?.(`[GrokAdapter]: 目标工作区: ${ctx.workspaceDir}`);

    return new Promise((resolve) => {
      const args = process.env.GROK_ARGS 
        ? process.env.GROK_ARGS.split(" ")
        : ["run", "--headless", "-"];

      try {
        const isWin = process.platform === "win32";
        const proc = spawn(this.grokBinary, args, {
          cwd: ctx.workspaceDir,
          env: {
            ...process.env,
            COLLAB_TASK_ID: ctx.task.id,
            COLLAB_RUN_ID: ctx.run.id,
          },
          detached: !isWin,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });

        this.currentProcess = proc;

        if (proc.stdin) {
          proc.stdin.write(taskPayload, "utf-8", (err) => {
            if (err) {
              ctx.onLog?.(`[GrokAdapter]: stdin 写入警告: ${err.message}`);
            }
            proc.stdin?.end();
          });
        }

        proc.stdout?.on("data", (chunk: Buffer) => {
          const lines = chunk.toString().split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) ctx.onLog?.(trimmed);
          }
        });

        proc.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString().trim();
          if (text) ctx.onLog?.(`[Grok-Err]: ${text}`);
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

        proc.on("close", (code, signal) => {
          this.currentProcess = null;
          if (signal) {
            ctx.onLog?.(`[GrokAdapter]: 进程被外部信号终止 (${signal})`);
            resolve({
              success: false,
              summary: `Grok 进程被信号终止: ${signal}`,
              exitCode: -1,
            });
            return;
          }

          const exitCode = code === null ? -1 : code;
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
          summary: `无法创建 Grok 进程: ${(err as Error).message}`,
          exitCode: -1,
        });
      }
    });
  }

  async cancel(): Promise<void> {
    if (!this.currentProcess || !this.currentProcess.pid) return;
    const pid = this.currentProcess.pid;

    try {
      if (process.platform === "win32") {
        try {
          execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" });
        } catch {
          try {
            execSync(`C:\\Windows\\System32\\taskkill.exe /F /T /PID ${pid}`, { stdio: "ignore" });
          } catch {}
        }
      } else {
        process.kill(-pid, "SIGTERM");
        await new Promise((r) => setTimeout(r, 600));
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
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
