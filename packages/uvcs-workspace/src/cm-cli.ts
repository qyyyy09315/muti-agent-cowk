import { spawn } from "node:child_process";
import { CollabError, ErrorCode } from "@ai-collab/contracts";

export interface UVCSStatus {
  branch: string;
  changeset: string;
  repository: string;
  pendingChanges: string[];
}

export interface UVCSLock {
  id: string;
  path: string;
  owner: string;
  branch: string;
}

export class UVCSClient {
  private cmBinary: string;

  constructor(cmBinary = process.env.CM_BIN || "cm") {
    this.cmBinary = cmBinary;
  }

  /**
   * 执行原生 cm CLI 命令，严格校验退出码与标准错误输出
   */
  async execCm(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.cmBinary, args, { cwd });
      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
      proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));

      proc.on("error", (err: Error) => {
        reject(
          new CollabError(
            ErrorCode.INTERNAL_ERROR,
            `执行 cm 命令失败，请确认系统 PATH 中已安装 Plastic SCM 客户端 (${this.cmBinary}): ${err.message}`,
            500
          )
        );
      });

      proc.on("close", (code) => {
        const exitCode = code ?? 0;
        if (exitCode !== 0) {
          // 拦截排他锁冲突
          if (stderr.includes("locked") || stdout.includes("locked")) {
            reject(
              new CollabError(
                ErrorCode.RESOURCE_LOCKED,
                `UVCS 资源被排他锁锁定: ${stderr.trim() || stdout.trim()}`,
                409
              )
            );
            return;
          }
          // 拦截分支/版本冲突
          if (stderr.includes("conflict") || stdout.includes("conflict")) {
            reject(
              new CollabError(
                ErrorCode.CONFLICT,
                `UVCS 产生分支冲突，需人工介入: ${stderr.trim() || stdout.trim()}`,
                409
              )
            );
            return;
          }
          reject(
            new CollabError(
              ErrorCode.INTERNAL_ERROR,
              `cm 执行异常 [退出码 ${exitCode}]: ${stderr.trim() || stdout.trim()}`,
              500
            )
          );
          return;
        }

        resolve({ stdout, stderr, code: exitCode });
      });
    });
  }

  /**
   * 真实查询当前 Unity 工作区版本控制状态
   */
  async getStatus(workspaceDir: string): Promise<UVCSStatus> {
    const res = await this.execCm(["status", "--format={branch};{changeset};{rep}"], workspaceDir);
    const parts = res.stdout.trim().split(";");
    return {
      branch: parts[0] || "/main",
      changeset: parts[1] || "cs:0",
      repository: parts[2] || "unknown",
      pendingChanges: [],
    };
  }

  /**
   * 真实创建任务隔离分支: br:/main/ai/<taskId>/<agentId>
   */
  async createBranch(workspaceDir: string, branchName: string, baseChangeset?: string): Promise<string> {
    const args = ["branch", "create", branchName];
    if (baseChangeset) {
      args.push(baseChangeset.startsWith("cs:") ? baseChangeset : `cs:${baseChangeset}`);
    }
    await this.execCm(args, workspaceDir);
    return branchName;
  }

  /**
   * 真实切换工作区分支
   */
  async switchBranch(workspaceDir: string, branchName: string): Promise<void> {
    await this.execCm(["switch", branchName], workspaceDir);
  }

  /**
   * 真实对特定资源申请排他性文件锁（用于 .unity 场景或 .prefab 资产）
   */
  async lockFile(workspaceDir: string, itemPath: string): Promise<boolean> {
    const res = await this.execCm(["lock", itemPath], workspaceDir);
    return res.code === 0;
  }

  /**
   * 真实获取当前仓库已有文件锁清单
   */
  async listLocks(workspaceDir: string): Promise<UVCSLock[]> {
    const res = await this.execCm(["listlocks", "--format={id};{path};{owner};{branch}"], workspaceDir);
    const lines = res.stdout.trim().split("\n");
    const locks: UVCSLock[] = [];
    for (const line of lines) {
      const parts = line.split(";");
      if (parts.length >= 4) {
        locks.push({
          id: parts[0].trim(),
          path: parts[1].trim(),
          owner: parts[2].trim(),
          branch: parts[3].trim(),
        });
      }
    }
    return locks;
  }

  /**
   * 真实执行 check-in 提交本任务修改，并严格提取服务端返回的 changeset 编号
   */
  async checkin(workspaceDir: string, comment: string, paths: string[] = ["."]): Promise<string> {
    const args = ["checkin", ...paths, "-c", comment];
    const res = await this.execCm(args, workspaceDir);
    const match = res.stdout.match(/cs:(\d+)/i) || res.stdout.match(/changeset\s+(\d+)/i);
    if (!match) {
      throw new CollabError(
        ErrorCode.INTERNAL_ERROR,
        `cm checkin 执行完毕但无法解析 changeset 标识: ${res.stdout}`,
        500
      );
    }
    return `cs:${match[1]}`;
  }
}
