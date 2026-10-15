import { buildServer } from "./server.js";

const port = Number(process.env.PORT) || 3100;
const host = process.env.HOST || "0.0.0.0";

async function main() {
  const app = await buildServer();
  try {
    await app.listen({ port, host });
    console.log(`[ai-collab-hub] 控制平面服务已在 http://${host}:${port} 启动`);
  } catch (err) {
    console.error("[ai-collab-hub] 启动失败:", err);
    process.exit(1);
  }
}

main();
