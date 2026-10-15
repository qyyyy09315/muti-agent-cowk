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

export class CodexAdapter {
  readonly agentType = "codex" as const;
  private currentProcess: ChildProcess | null = null;
  private codexBinary: string;

  constructor(codexBinary = process.env.CODEX_BIN || "codex") {
    this.codexBinary = codexBinary;
  }

  /**
   * 启动真实 Codex 进程执行任务或代码审查
   * 工业标准安全规范：
   * 1. 任务文本通过 stdin 管道传输，杜绝命令行长度超标与命令注入；
   * 2. shell: false 直接调用二进制，杜绝命令拼接漏洞；
   * 3. 独立进程组绑定，支持超时/急停时彻底连根销毁整棵进程树。
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
      // 官方命令: codex exec --path <workspaceDir> -
      // 允许环境变量自定义命令参数，默认通过 '-' 从标准输入获取任务
      const args = process.env.CODEX_ARGS 
        ? process.env.CODEX_ARGS.split(" ")
        : ["exec", "--path", ctx.workspaceDir, "-"];

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
          shell: false, // 严格禁用 shell 注入
          stdio: ["pipe", "pipe", "pipe"],
        });

        this.currentProcess = proc;

        // 核心要求：通过 stdin 管道安全写入任务文本并关闭输入流
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

        proc.on("close", (code) => {
          this.currentProcess = null;
          const exitCode = code ?? 0;
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
   * 工业级进程树销毁 (Process Tree Kill)
   */
  async cancel(): Promise<void> {
    if (!this.currentProcess || !this.currentProcess.pid) return;
    const pid = this.currentProcess.pid;

    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", pid.toString(), "/T", "/F"]);
      } else {
        process.kill(-pid, "SIGTERM");
        setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {}
        }, 1500);
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
