import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { registerRoutes } from "./routes.js";
import { setupMcpServer } from "./mcp.js";
import { getStorageEngine } from "./db.js";
import { HubScheduler } from "./scheduler.js";
import { StorageEngine } from "./types.js";

export interface BuildServerOptions {
  storage?: StorageEngine;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
  });

  await app.register(cors, {
    origin: true,
  });

  const storage = options.storage || getStorageEngine();
  await storage.init();

  const scheduler = new HubScheduler(storage);
  scheduler.startReaper(10000); // 10s 扫描一次超时租约

  // 注册 REST 路由
  registerRoutes(app, storage, scheduler);

  // 挂载 MCP 服务
  setupMcpServer(app, storage, scheduler);

  app.addHook("onClose", async () => {
    scheduler.stopReaper();
    await storage.close();
  });

  return app;
}
