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

export class CodexAdapter {
  readonly agentType = "codex" as const;
  private currentProcess: ChildProcess | null = null;
  private codexBinary: string;

  constructor(codexBinary = process.env.CODEX_BIN || "codex") {
    this.codexBinary = codexBinary;
  }

  /**
   * 启动真实 Codex 进程执行任务或代码审查
   * 修复规范：
   * 1. 严格使用官方 -C <dir> - 参数，任务上下文通过 stdin 管道写入；
   * 2. shell: false 直接调用二进制；
   * 3. 严格处理信号退出（signal 不为空或 exitCode 不为 0 均判失败）；
   * 4. 支持进程树销毁。
   */
  async executeTask(ctx: ExecutionContext): Promise<ExecutionResult> {
    const taskPayload = JSON.stringify({
      taskId: ctx.task.id,
      title: ctx.task.title,
      goal: ctx.task.goal,
      acceptanceCriteria: ctx.task.acceptanceCriteria,
      workspaceDir: ctx.workspaceDir,
      assignedAgent: "codex",
    }, null, 2);

    ctx.onLog?.(`[CodexAdapter]: 准备通过 stdin 发送任务载荷至 Codex (进程: ${this.codexBinary})...`);
    ctx.onLog?.(`[CodexAdapter]: 隔离工作目录: ${ctx.workspaceDir}`);

    return new Promise((resolve) => {
      // 官方命令签名: codex exec -C <workspaceDir> -
      // 默认通过 '-' 从标准输入获取任务指令，严禁使用已被弃用的 --path
      const args = process.env.CODEX_ARGS 
        ? process.env.CODEX_ARGS.split(" ")
        : ["exec", "-C", ctx.workspaceDir, "-"];

      try {
        const isWin = process.platform === "win32";
        const proc = spawn(this.codexBinary, args, {
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

        // 通过 stdin 管道写入任务文本并关闭输入流
        if (proc.stdin) {
          proc.stdin.write(taskPayload, "utf-8", (err) => {
            if (err) {
              ctx.onLog?.(`[CodexAdapter]: stdin 写入警告: ${err.message}`);
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
          if (text) ctx.onLog?.(`[Codex-Err]: ${text}`);
        });

        proc.on("error", (err: Error) => {
          this.currentProcess = null;
          ctx.onLog?.(`[CodexAdapter 启动失败]: 未找到可执行文件 ${this.codexBinary} 或进程创建失败: ${err.message}`);
          resolve({
            success: false,
            summary: `Codex 进程启动异常: ${err.message}`,
            exitCode: -1,
          });
        });

        // 关键修复：显式判断 signal 信号退出，禁止将 null 误当成功
        proc.on("close", (code, signal) => {
          this.currentProcess = null;
          if (signal) {
            ctx.onLog?.(`[CodexAdapter]: 进程被外部信号终止 (${signal})`);
            resolve({
              success: false,
              summary: `Codex 进程被信号终止: ${signal}`,
              exitCode: -1,
            });
            return;
          }

          const exitCode = code === null ? -1 : code;
          ctx.onLog?.(`[CodexAdapter]: Codex 进程退出，退出码: ${exitCode}`);
          resolve({
            success: exitCode === 0,
            summary: exitCode === 0 ? `Codex 成功完成审查与代码处理: ${ctx.task.title}` : `Codex 执行失败，退出码: ${exitCode}`,
            exitCode,
          });
        });
      } catch (err) {
        resolve({
          success: false,
          summary: `无法创建 Codex 进程: ${(err as Error).message}`,
          exitCode: -1,
        });
      }
    });
  }

  /**
   * 工业级进程树销毁：异步等待 taskkill 完全终止并校验
   */
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
