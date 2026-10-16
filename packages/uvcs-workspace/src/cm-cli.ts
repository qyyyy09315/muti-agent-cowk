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
      const proc = spawn(this.cmBinary, args, { cwd, shell: false });
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
   * 原生 cm status --header 真实格式解析
   * 输出样例：/main/geng@LanzhouLandmarks/LanzhouLandmarks@qiangdao977@unity (cs:8 - head)
   * 严格解析，解析失败坚决报错阻断，绝不使用假默认值
   */
  async getStatus(workspaceDir: string): Promise<UVCSStatus> {
    const res = await this.execCm(["status", "--header"], workspaceDir);
    const trimmed = res.stdout.trim();
    
    // 正则提取分支、仓库名及变更集: <branch>@<repository> (<changeset> ...)
    const match = trimmed.match(/^([^@\r\n]+)@([^(]+)\s*\((cs:\d+)/i);
    if (!match) {
      throw new CollabError(
        ErrorCode.INTERNAL_ERROR,
        `cm status --header 解析失败: 未知输出格式 "${trimmed}"`,
        500
      );
    }

    return {
      branch: match[1].trim(),
      repository: match[2].trim(),
      changeset: match[3].trim(),
      pendingChanges: [],
    };
  }

  /**
   * 创建任务独立工作空间，避免污染人工日常工作区
   */
  async createWorkspace(wkName: string, wkPath: string, repoSpec?: string): Promise<void> {
    const args = ["workspace", "create", wkName, wkPath];
    if (repoSpec) args.push(repoSpec);
    await this.execCm(args, process.cwd());
  }

  /**
   * 删除任务临时工作空间
   */
  async deleteWorkspace(wkName: string): Promise<void> {
    await this.execCm(["workspace", "delete", wkName], process.cwd());
  }

  /**
   * 在 base changeset 上为具体任务创建独立分支: br:/main/ai/<taskId>/<agentId>
   * 采用官方受支持的 --changeset=cs:<num> 语法格式
   */
  async createBranch(workspaceDir: string, branchName: string, baseChangeset?: string): Promise<string> {
    const args = ["branch", "create", branchName];
    if (baseChangeset) {
      const cs = baseChangeset.startsWith("cs:") ? baseChangeset : `cs:${baseChangeset}`;
      args.push(`--changeset=${cs}`);
    }
    await this.execCm(args, workspaceDir);
    return branchName;
  }

  /**
   * 切换工作区分支
   */
  async switchBranch(workspaceDir: string, branchName: string): Promise<void> {
    await this.execCm(["switch", branchName], workspaceDir);
  }

  /**
   * 对排他性资源申请锁定（通过 cm checkout 实现排他检出锁）
   */
  async lockFile(workspaceDir: string, itemPath: string): Promise<boolean> {
    const res = await this.execCm(["checkout", itemPath], workspaceDir);
    return res.code === 0;
  }

  /**
   * 释放本任务持有的排他锁（通过 cm undocheckout 撤销检出释放锁）
   */
  async unlockFile(workspaceDir: string, itemPath: string): Promise<boolean> {
    const res = await this.execCm(["undocheckout", itemPath], workspaceDir);
    return res.code === 0;
  }

  /**
   * 列出工作区已有文件锁清单
   */
  async listLocks(workspaceDir: string): Promise<UVCSLock[]> {
    const res = await this.execCm(["lock", "list"], workspaceDir);
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
   * 真实执行 checkin 提交，严格从输出提取服务端生成的 changeset 编号
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
