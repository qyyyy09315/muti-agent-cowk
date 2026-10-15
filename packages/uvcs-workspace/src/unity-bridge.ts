import fs from "node:fs";
import path from "node:path";

export interface UnityProjectInfo {
  version: string;
  renderPipeline?: string;
  hasTestFramework: boolean;
}

export interface MetaAuditResult {
  valid: boolean;
  missingMetas: string[];
  orphanMetas: string[];
}

export interface TestResultSummary {
  passed: number;
  failed: number;
  total: number;
  reportPath: string;
}

export class UnityBridge {
  /**
   * 读取 Unity 工程确切版本
   */
  static getProjectVersion(projectPath: string): string {
    const versionFile = path.join(projectPath, "ProjectSettings", "ProjectVersion.txt");
    if (!fs.existsSync(versionFile)) return "Unknown (ProjectSettings missing)";
    const content = fs.readFileSync(versionFile, "utf-8");
    const match = content.match(/m_EditorVersion:\s*([^\r\n]+)/);
    return match ? match[1].trim() : "Unknown";
  }

  /**
   * 严格核查 Assets/ 目录下的资源与其 .meta 文件完整性
   * 杜绝 Unity 协作最常见的“Missing .meta / 重建随机 GUID 导致引用丢失”事故
   */
  static auditMetaFiles(projectPath: string): MetaAuditResult {
    const assetsDir = path.join(projectPath, "Assets");
    if (!fs.existsSync(assetsDir)) {
      return { valid: true, missingMetas: [], orphanMetas: [] };
    }

    const missingMetas: string[] = [];
    const orphanMetas: string[] = [];

    function walk(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.name.startsWith(".")) continue;

        if (entry.name.endsWith(".meta")) {
          // 检查去掉 .meta 后的对应实体是否存在
          const target = fullPath.slice(0, -5);
          if (!fs.existsSync(target)) {
            orphanMetas.push(path.relative(projectPath, fullPath));
          }
        } else {
          // 检查当前文件/目录是否具有对应的 .meta
          const metaPath = fullPath + ".meta";
          if (!fs.existsSync(metaPath)) {
            missingMetas.push(path.relative(projectPath, fullPath));
          }
          if (entry.isDirectory()) {
            walk(fullPath);
          }
        }
      }
    }

    walk(assetsDir);

    return {
      valid: missingMetas.length === 0 && orphanMetas.length === 0,
      missingMetas,
      orphanMetas,
    };
  }

  /**
   * 构造合法的 Unity Headless Batchmode 运行参数
   */
  static buildBatchmodeArgs(options: {
    projectPath: string;
    executeMethod?: string;
    logFile?: string;
    runTests?: boolean;
    testPlatform?: "EditMode" | "PlayMode";
    testResultsXml?: string;
  }): string[] {
    const args = ["-projectPath", options.projectPath, "-batchmode", "-nographics"];
    if (options.logFile) {
      args.push("-logFile", options.logFile);
    }
    if (options.executeMethod) {
      args.push("-executeMethod", options.executeMethod);
    }
    if (options.runTests) {
      args.push("-runTests");
      if (options.testPlatform) {
        args.push("-testPlatform", options.testPlatform);
      }
      if (options.testResultsXml) {
        args.push("-testResults", options.testResultsXml);
      }
    }
    return args;
  }

  /**
   * 解析 Unity Editor 日志中的编译报错
   */
  static parseCompileErrors(logContent: string): string[] {
    const errors: string[] = [];
    const lines = logContent.split("\n");
    for (const line of lines) {
      if (line.includes("error CS") || line.includes("Compilation failed")) {
        errors.push(line.trim());
      }
    }
    return errors;
  }
}
