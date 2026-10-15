# 开源引用与版权致谢声明 (Open Source Notices & Credits)

本项目在系统架构、通信协议与工作流设计中借鉴并兼容了以下开源规范、标准协议及官方文档：

## 1. 协议规范与开源标准

* **A2A (Agent2Agent) Protocol**
  * **来源与参考**：Google / 开源 A2A Specification v1.0.0 (`https://github.com/tomtom215/a2a-rust`, `https://github.com/traylinx/a2a-ruby`)
  * **作用领域**：`packages/contracts/src/a2a-auth.ts` 中多智能体直接交互的结构化信封协议（Envelope Model），用于双向对齐接口（`clarify_interface`）、代码审查（`request_review`）与成果交接。

* **ACP (Agent Client Protocol)**
  * **来源与参考**：xAI Grok Build Headless & ACP (`https://github.com/newioapp/acp-inspector`, `https://docs.x.ai/build/cli/headless-scripting`)
  * **作用领域**：`packages/adapters/grok` 中针对本地 Grok Build 终端进程的 headless stdio 事件流捕获与权限拦截。

* **MCP (Model Context Protocol)**
  * **来源与参考**：Anthropic Model Context Protocol (`https://github.com/modelcontextprotocol/typescript-sdk`, MIT License)
  * **作用领域**：`apps/hub/src/mcp.ts`，基于官方 TypeScript MCP SDK 暴露的 Streamable HTTP 工具服务。

## 2. 调度与分布式模型

* **Fencing Token 与原子租约状态机**
  * **来源与参考**：Martin Kleppmann《Designing Data-Intensive Applications》(DDIA) 分布式锁与递增 fencing token 防脑裂模式。
  * **作用领域**：`apps/hub/src/scheduler.ts` 及 PostgreSQL `FOR UPDATE SKIP LOCKED` 行级并发接单机制。

## 3. Unity 版本控制与引擎自动化规程

* **Unity Version Control (Plastic SCM) CLI 规范**
  * **来源与参考**：Unity 官方 Plastic SCM 自动化文档 (`https://docs.unity.com/en-us/unity-version-control/uvcs-cli/`)
  * **作用领域**：`packages/uvcs-workspace/src/cm-cli.ts` 命令行参数封装、任务分支隔离与排他性文件锁管理。

* **Unity Headless Batchmode & TestFramework**
  * **来源与参考**：Unity Technologies 官方文档与 Unity-Test-Runner 规范
  * **作用领域**：`packages/uvcs-workspace/src/unity-bridge.ts` 批处理运行参数构造与编译日志、XML 结果解析。
