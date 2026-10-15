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
   * 严格限定在任务绑定的 Unity UVCS workspace 目录中
   */
  async executeTask(ctx: ExecutionContext): Promise<ExecutionResult> {
    const prompt = [
      `[Task ID: ${ctx.task.id}]`,
      `[Title]: ${ctx.task.title}`,
      `[Goal]: ${ctx.task.goal}`,
      `[Acceptance Criteria]: ${ctx.task.acceptanceCriteria}`,
      `请在工作目录 ${ctx.workspaceDir} 下执行审查与代码交付，验证 C# 逻辑与测试规范。`,
    ].join("\n");

    ctx.onLog?.(`[CodexAdapter]: 正在启动真实 Codex 进程 (${this.codexBinary})...`);
    ctx.onLog?.(`[CodexAdapter]: 隔离工作目录: ${ctx.workspaceDir}`);

    return new Promise((resolve) => {
      // 官方命令: codex run -C <workspaceDir> <prompt>
      const args = ["run", "-C", ctx.workspaceDir, prompt];

      try {
        const proc = spawn(this.codexBinary, args, {
          cwd: ctx.workspaceDir,
          env: {
            ...process.env,
            COLLAB_TASK_ID: ctx.task.id,
            COLLAB_RUN_ID: ctx.run.id,
          },
          detached: process.platform !== "win32",
          shell: process.platform === "win32",
        });

        this.currentProcess = proc;

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
   * 终止子进程树，防止后台孤儿进程未受控修改 Unity 工程
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
