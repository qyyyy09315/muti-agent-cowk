import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

/**
 * 与 GitHub 远程版本对比检查
 * 优先采用 git ls-remote，免 API 速率限制且支持私有/公共仓库
 *
 * @param {Object} [options]
 * @param {string} [options.repoUrl]
 * @param {number} [options.timeoutMs]
 */
export async function checkForUpdates(options = {}) {
  const repo = options.repoUrl || "origin";
  const timeoutMs = options.timeoutMs || 6000;
  const now = new Date().toISOString();

  // 读取本地 package.json 版本
  let localVersion = "0.2.3";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"));
    if (pkg.version) localVersion = pkg.version;
  } catch {}

  // 获取本地 git commit
  let localCommit = "unknown";
  try {
    localCommit = execSync("git rev-parse --short HEAD", { cwd: rootDir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return {
      checkedAt: now,
      status: "not_a_git_repo",
      repo,
      localCommit: "unknown",
      remoteCommit: null,
      isLatest: true,
      updateAvailable: false,
      localVersion,
      updateCommand: "git pull origin main && pnpm build",
      message: "本地目录非 Git 仓库，跳过远程版本检查",
    };
  }

  // 获取远程最新 main 分支 commit
  let remoteCommit = null;
  try {
    const lsRemote = execSync(`git ls-remote ${repo} refs/heads/main`, {
      cwd: rootDir,
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (lsRemote) {
      remoteCommit = lsRemote.split(/\s+/)[0]?.slice(0, 7) || null;
    }
  } catch (err) {
    // 降级使用 GitHub 公开 API 探测
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch("https://api.github.com/repos/qyyyy09315/muti-agent-cowk/commits/main", {
        headers: { "User-Agent": "ai-collab-update-checker" },
        signal: controller.signal,
      });
      clearTimeout(t);
      if (res.ok) {
        const data = await res.json();
        if (data.sha) {
          remoteCommit = data.sha.slice(0, 7);
        }
      }
    } catch {}
  }

  if (!remoteCommit) {
    return {
      checkedAt: now,
      status: "offline_or_unreachable",
      repo,
      localCommit,
      remoteCommit: null,
      isLatest: true,
      updateAvailable: false,
      localVersion,
      updateCommand: "git pull origin main && pnpm build",
      message: "无法连接 GitHub 远程仓库，已降级忽略（网络离线或无权限）",
    };
  }

  const isLatest = localCommit === remoteCommit;
  const updateAvailable = !isLatest;

  return {
    checkedAt: now,
    status: "ok",
    repo,
    localCommit,
    remoteCommit,
    isLatest,
    updateAvailable,
    localVersion,
    updateCommand: "git pull origin main && pnpm build",
    message: isLatest
      ? `当前版本为最新 (Commit: ${localCommit})`
      : `检测到远程有新版本可更新! 本地: ${localCommit} -> 远程: ${remoteCommit}`,
  };
}

async function cli() {
  const isJson = process.argv.includes("--json");
  const isQuiet = process.argv.includes("--quiet");
  const failOnOutdated = process.argv.includes("--fail-on-outdated");

  const result = await checkForUpdates();

  if (isJson) {
    // 对 Agent 绝对友好：输出干净的 JSON
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (!isQuiet || result.updateAvailable) {
      console.log("=================================================");
      console.log("       AI-Collab 协同系统 GitHub 版本检查        ");
      console.log("=================================================");
      console.log(`本地版本:    v${result.localVersion} (${result.localCommit})`);
      console.log(`远程最新:    ${result.remoteCommit ? result.remoteCommit : "未能获取"}`);
      console.log(`状态:        ${result.message}`);
      if (result.updateAvailable) {
        console.log("-------------------------------------------------");
        console.log("📢 升级提示: 发现远程仓库更新，建议执行以下命令同步:");
        console.log(`   ${result.updateCommand}`);
      }
      console.log("=================================================");
    }
  }

  if (failOnOutdated && result.updateAvailable) {
    process.exit(2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  cli().catch((err) => {
    console.error("[UpdateChecker Error]:", err.message);
    process.exit(1);
  });
}
