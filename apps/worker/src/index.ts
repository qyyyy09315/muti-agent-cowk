import { WorkerRunner, WorkerConfig } from "./runner.js";

function parseArgs(): WorkerConfig {
  const args = process.argv.slice(2);
  let hubUrl = process.env.HUB_URL || "http://127.0.0.1:3100";
  let projectId = process.env.PROJECT_ID || "proj_unity_demo";
  let agentType: "grok" | "codex" = "grok";
  let workspaceDir = process.env.WORKSPACE_DIR || process.cwd();
  let token = process.env.HUB_TOKEN;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--type" && args[i + 1]) agentType = args[++i] as any;
    if (args[i] === "--hub" && args[i + 1]) hubUrl = args[++i];
    if (args[i] === "--project" && args[i + 1]) projectId = args[++i];
    if (args[i] === "--workspace" && args[i + 1]) workspaceDir = args[++i];
    if (args[i] === "--token" && args[i + 1]) token = args[++i];
  }

  return { hubUrl, projectId, agentType, workspaceDir, token };
}

async function main() {
  const config = parseArgs();
  const runner = new WorkerRunner(config);

  process.on("SIGINT", async () => {
    console.log("\n[Worker]: 收到退出信号，正在安全下线...");
    await runner.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await runner.stop();
    process.exit(0);
  });

  await runner.start();
}

main().catch((err) => {
  console.error("[Worker Fatal]:", err);
  process.exit(1);
});
