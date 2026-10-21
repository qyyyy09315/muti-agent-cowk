<div align="center">

# AI-Collab · 多 Agent 协作平台

**muti-agent-cowk**

让不同电脑上的 Grok、Codex 等命令行智能体，共同完成 Unity / UVCS 项目的开发、验证与交付。

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](#开发与接口)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=node.js&logoColor=white)](#快速开始)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-%E2%89%A514-4169e1?logo=postgresql&logoColor=white)](#开发与接口)
[![Tests](https://img.shields.io/badge/tests-75%20passed-2f855a)](#测试)
[![License](https://img.shields.io/badge/license-MIT-2f855a)](#许可)

[快速开始](#快速开始) · [系统架构](#系统架构) · [任务流程](#任务如何执行) · [本机监视台](#本机监视台) · [开发与接口](#开发与接口) · [测试](#测试)

</div>

## 能做什么

Hub 统一管理任务、消息与审阅，各台主机上的 Worker 驱动本地 CLI 执行。模型登录态留在执行端，协作者通过任务、线程和变更集交换成果。

- **跨机分工**：将任务指派给具体 Agent，跟踪领取、执行、交付和审阅状态。
- **执行中协作**：汇报工作节点、提出接口问题、读取对端答复；可选扩展支持核验后的协作目标更新。
- **隔离开发**：在独立 Unity 工作区与任务分支中修改文件，保留日常工程和未提交成果。
- **交付检查**：签入前核验租约、资源锁、元数据配对与本次编译日志；失败时保存检查点。
- **实时查看**：服务器控制台管理任务与成员，本机监视台展示心跳、CLI 输出和 Unity 编译日志。

## 快速开始

### 环境要求

| 依赖 | 版本 | 说明 |
| :-- | :-- | :-- |
| Node.js | ≥ 20 | 推荐 20 LTS 或 22 LTS |
| pnpm | ≥ 9 | workspace 管理 |
| PostgreSQL | ≥ 14 | 推荐 16 |
| Grok CLI / Codex CLI | 最新版 | 按执行端角色安装并完成登录 |

### 部署 Hub

```bash
git clone https://github.com/qyyyy09315/muti-agent-cowk.git
cd muti-agent-cowk

pnpm install
pnpm build

# 依次执行全部迁移
for f in db/migrations/*.sql; do
  psql -d "$DB_NAME" -f "$f"
done

# 离线创建管理员（系统不提供公开注册入口）
node scripts/create-user.mjs <admin_username> <admin_password> admin

# 启动控制平面（生产环境必须提供 ≥32 字符的会话密钥）
DATABASE_URL="postgresql://user:pass@127.0.0.1:5432/ai_collab" \
HUB_SESSION_SECRET="<至少 32 字符的随机密钥>" \
HUB_AUTH_MODE=strict \
pnpm --filter @ai-collab/hub start
```

> [!WARNING]
> `HUB_SESSION_SECRET` 在生产环境缺失或短于 32 字符时，服务会拒绝启动。这是刻意设计的失败关闭（fail-closed）行为，请通过环境变量或 systemd 单元注入，不要写入仓库。

### 启动 Worker

每台协作主机运行一个 Worker，并将其指派给对应的智能体标识：

```bash
# 端 A：Grok
pnpm --filter @ai-collab/worker start \
  --agent grok \
  --worker-id worker_grok_local \
  --hub https://<your-hub-domain> \
  --project <project_id> \
  --workspace "/path/to/local/unity/workspace"

# 端 B：Codex
pnpm --filter @ai-collab/worker start \
  --agent codex \
  --worker-id worker_codex_local \
  --hub https://<your-hub-domain> \
  --project <project_id> \
  --workspace "/path/to/local/unity/workspace"
```

`--type` 是 `--agent` 的兼容别名。`--no-listen-messages` 仅领取任务；`--messages-only` 只保留心跳与收件箱，不领取任务、不运行 Unity/UVCS。

> [!NOTE]
> `HUB_AUTH_MODE=strict` 时，Worker 必须携带 Agent Token（`--token` 或环境变量 `HUB_TOKEN`），否则执行接口会返回 401。个人令牌与 Agent 令牌可在控制台的“API 令牌”中创建：前者用于人或脚本，后者绑定具体 Agent 标识。

### 自检

```bash
node scripts/doctor.mjs
```

该工具检查网络连通性、Hub 证书、数据库状态、本地 `cm` CLI 与模型环境。

<details>
<summary><b>消息监听的行为边界（展开）</b></summary>

- 正常启动的 Worker 会监听 Hub 的 `message_sent` 事件；首次启动会读取既有事件积压。
- 提问交给当前项目会话：Grok 使用 `grok --continue`，Codex 使用 `codex exec resume --last`；无会话时在同一工作区新建一轮。
- 答复投递回提问会话；任务处于 `waiting_peer` 时回到队列，由原执行端领回。
- 生成结果先持久化再发送，使用稳定幂等键；POST 响应丢失或重启不会重复回复。
- 单条答复有 120 秒进程超时与 16,000 字符上限；失败按退避重试并保留游标。
- 状态目录默认位于 `~/.ai-collab/inbox`，按 Hub/项目/角色隔离；本地进程锁防止同机重复监听。
- 每个 Hub、项目、角色应只运行一个接收者；跨机去重无法阻止两端同时消耗模型配额。
- 前置条件：Grok 主机已登录 `grok` CLI，Codex 主机已登录 `codex` CLI；可用 `GROK_BIN`/`CODEX_BIN` 指定可执行文件。Windows 下的 `codex.cmd` shim 会被解析到 `@openai/codex/bin/codex.js`。
- Grok 的任务执行使用 `grok --prompt-file`，而非 `grok run --headless`。

</details>

## 系统架构

### 运行方式

- **单一事实源**：任务、运行、事件、消息与审批均以 Hub 的 PostgreSQL 为准。
- **凭据本地化**：Grok/Codex 的登录态只存在于各自主机，Hub 不接触模型凭据。
- **显式边界**：状态迁移、权限判定与破坏性操作均需通过显式校验，而非依赖约定。

![中心控制平面与独立执行端架构](docs/figures/system-architecture.png)

*中心协调、边缘执行：模型凭据留在本机，经过验证的变更集进入UVCS。*

### 组件职责

| 组件 | 位置 | 职责 |
| :-- | :-- | :-- |
| **Hub** | 服务器 | 调度、状态机、事件流、鉴权、审批、MCP 工具服务 |
| **Worker** | 各协作主机 | 领取指定任务、驱动本地 CLI、执行 UVCS/Unity 流程、收发 A2A 消息 |
| **PostgreSQL** | 服务器 | 唯一事实源；行级锁与事件游标 |
| **Web 控制台** | 服务器静态资源 | 任务与消息可视化、人工审批、成员与令牌管理 |
| **本机监视台** | 各协作主机 | 只读回环面板：心跳、进程、消息、日志 |
| **适配器** | Worker 进程内 | Grok ACP/stdio、Codex CLI 子进程桥接 |

## 任务如何执行

### 任务生命周期

系统定义 12 个状态，并通过显式转移表约束合法迁移；终态不可再迁移。

![任务生命周期简图](docs/figures/task-lifecycle.png)

*12种任务状态的主要迁移（简图，省略部分异常路径）；leased可直接提交，完整规则以[契约转移表](packages/contracts/src/state-machine.ts)为准。*

> [!IMPORTANT]
> 非法迁移在写入前即被拒绝；`completed`、`failed`、`cancelled` 为终态。互问成环时任务转入 `waiting_human`，由人工终止循环。

### 任务分派与租约

任务在创建时即绑定 `assigned_agent`。Worker 只能领取指派给自己的任务，从机制上避免“抢单”带来的争用与误领。



租约机制包含三条约束：

- **续期校验**：`(runId, workerId, fencingToken)` 三元组必须同时匹配；
- **写操作门禁**：续期、提交、失败上报与签入前均复核租约，过期即拒绝；
- **有界重试**：租约回收与失败上报共享 `maxRepairs` 预算，超限转入 `failed`，避免无限重试。

### A2A 消息与线程

跨端消息采用统一信封，支持 `clarify_interface`、`request_review`、`review_verdict` 与 `handover` 四类语义。消息共享 `taskId` 与 `threadId`，答复通过 `replyToId` 指回根提问。

![任务澄清与执行中进度讨论](docs/figures/peer-coordination.png)

*普通澄清消息与执行中的进度讨论。`progress:`线程保持现有任务状态与租约；答复回到同一执行上下文。图示的事件通道不表示默认Worker已改为SSE推送。*

为抑制智能体互答死循环，系统只对**根提问**生成自动答复；答复本身不再触发自动回复。生成结果先落盘再发送，并携带稳定幂等键，因此 POST 响应丢失或进程重启不会造成重复消息。

### 隔离工作区与版本控制安全

Unity 工程包含场景、Prefab 与二进制资产，无法像纯文本仓库一样依赖合并解决冲突。系统在 `cm` CLI 之上施加以下门禁：

| 门禁 | 规则 | 目的 |
| :-- | :-- | :-- |
| 工作区隔离 | 每个任务创建独立 workspace | 不污染主工作区 |
| 分支隔离 | `br:/main/ai/<taskId>/<agentId>` | 变更可追溯、可丢弃 |
| 排他锁 | 写前申请；仅释放本次成功获取的锁 | 避免误释放他人锁 |
| `.meta` 完整性 | 校验文件/目录与meta配对、缺失和孤儿项 | 防止资源引用断裂 |
| 编译门禁 | Editor.log 必须存在且新于流水线启动 | 防止用旧日志冒充通过 |
| 检查点 | 破坏性清理前完整备份 | 失败不丢工作成果 |
| 安全冻结 | 备份失败则禁止 `undocheckout`/删工作区 | 保留现场供人工恢复 |
| 签入复核 | `cm checkin` 前再次校验租约 | 丢租绝不写入 |
| 参数规范 | 使用 `--changeset=cs:<n>` | 与 UVCS 官方 CLI 一致 |

### 身份、角色与审批分离

| 角色 | 等级 | 读取 | 创建/修改任务 | 审批 | 成员管理 |
| :-- | :--: | :--: | :--: | :--: | :--: |
| `viewer` | 1 | ✓ | — | — | — |
| `reviewer` | 2 | ✓ | — | ✓ | — |
| `developer` | 3 | ✓ | ✓ | — | — |
| `owner` | 4 | ✓ | ✓ | ✓ | ✓ |
| `admin` | 系统级 | ✓ | ✓ | ✓ | ✓ |

审批权限单独判定，仅 `owner`、`reviewer` 与系统管理员可执行，避免“开发者自审自批”。认证材料采用 scrypt 口令哈希、HMAC-SHA256 会话与 SHA-256 令牌摘要；本机凭据以 DPAPI 加密保存。


### 执行中进度与协作目标更新

可选执行端扩展在工作区就绪、文件修改、Unity批处理、验证、签入和Hub确认提交等节点汇报进度；CLI可提问并读取同一任务线程的实际回复。父Worker保管凭据、持久化发件箱、使用稳定幂等键重试。问题等待超时不视为同意，收到回复不会另开一个编辑器重做同一任务。

`progress:<runId>`线程不把正在执行的任务误切为`waiting_peer`。接管通知需明确唯一的`toAgent`，通过同项目来源/请求关联、时效及在线Worker核验后，才持久化更改后续协作目标；它不改变本机Agent身份、权限或任务分派。核验器缺失时拒绝启用自动路由。

本机监视台默认显示CLI公开执行输出与当前隔离工作区的Editor.log，每秒更新，标注根据日志推断的阶段；阶段标签不改变Hub任务状态，不显示模型内部推理。

收件会话可读取父Worker提供的运行证据和指定云端变更集缓存；收件分支版本不代表云端交付不存在。云端读取不会切换工作区，指定摘要可用于比对下载文件。签入前可选纳管新增Assets/ProjectDocs交付文件，并排除日志。

标准Worker入口仍保留。可选Codex启动器、私有配置样例、权限边界和使用方式见[scripts/collaboration](scripts/collaboration/README.md)。图像由内置绘图工具生成并人工核对；[编辑源稿](docs/figures/diagram-sources.md)与[绘图提示词](docs/figures/PROMPTS.md)随仓库保存。

## 本机监视台

面向协作主机的只读回环面板，用于观察 Worker 心跳、本地 CLI 进程、项目消息、任务重试与 stdout/stderr。凭据保存在服务端与本机 DPAPI 中，不进入页面。

```powershell
# Windows：后台启动并打开 http://127.0.0.1:8787/
./scripts/start_worker_monitor.ps1 -ProfileDir '<worker-profile>'
```

```bash
# 前台运行
node scripts/worker-monitor/server.mjs --profile '<worker-profile>' --port 8787
```

监视台只监听 `127.0.0.1`，拒绝跨站读取与 DNS 重绑定；详细配置见 [`scripts/worker-monitor/README.md`](scripts/worker-monitor/README.md)。

## 开发与接口

### 目录结构

```text
muti-agent-cowk/
├── apps/
│   ├── hub/                 # 控制平面：Fastify、调度、SSE、MCP、静态控制台
│   └── worker/              # 本地执行守护进程
├── packages/
│   ├── contracts/           # Zod Schema、状态机、A2A 信封、错误码
│   ├── adapters/grok/       # Grok Build ACP/stdio 适配
│   ├── adapters/codex/      # Codex 子进程适配
│   └── uvcs-workspace/      # cm CLI、工作区、Unity 批处理桥
├── db/migrations/           # PostgreSQL 迁移（001–004）
├── scripts/                 # 建号、诊断、更新检查、本机监视台
└── tests/                   # 端到端与消息监听测试
```

### 技术栈

| 层次 | 选型 |
| :-- | :-- |
| 语言与构建 | TypeScript（strict）、pnpm workspace、tsc |
| 服务端 | Fastify、Node.js ≥ 20 |
| 存储 | PostgreSQL ≥ 14（行级锁、事件游标） |
| 实时通道 | Server-Sent Events（断点续传 + 游标去重） |
| 智能体接入 | Grok Build ACP/stdio、OpenAI Codex CLI |
| 协议 | A2A 信封、MCP（Streamable HTTP） |
| 前端 | 原生 HTML/CSS/JS 静态控制台，不引入前端框架 |

### 主要接口

| 方法 | 路径 | 说明 |
| :--: | :-- | :-- |
| `POST` | `/api/runs/claim` | 原子领取指派任务 |
| `POST` | `/api/runs/:id/renew` | 续期租约（校验 fencing token） |
| `POST` | `/api/runs/:id/submit` | 提交执行结果 |
| `POST` | `/api/runs/:id/fail` | 失败上报与有界重试 |
| `POST` | `/api/messages` | 发送 A2A 消息（幂等） |
| `GET` | `/api/events` | 默认JSON游标补拉；`stream=true`启用SSE |
| `POST` | `/api/approvals/:id/decision` | 人工审批 |
| `GET` | `/api/tasks` | 任务列表与详情 |
| `GET/POST` | `/api/tokens` | 个人令牌与 Agent 令牌管理 |
| `GET/PUT` | `/api/projects/:id/members` | 项目成员与角色 |

MCP 服务暴露 6 个工具：`project_status`、`task_create`、`task_get`、`peer_ask`、`peer_reply`、`review_request`。

完整的扩展配置与消息约定见 [协作运行扩展](scripts/collaboration/README.md)。


## 测试

验证目标是**调度正确性、故障恢复与破坏性操作安全**，而非模型能力基准。测试由四层构成：契约层单元测试、Hub/Worker 集成测试、UVCS 解析测试，以及带故障注入的端到端测试。所有端到端测试使用模拟子进程与本地 Hub，不调用真实模型、不访问生产环境。

| 测试层 | 覆盖内容 | 数量 | 结果 |
| :-- | :-- | --: | :--: |
| contracts | Schema、状态迁移、A2A 信封 | 7 | 通过 |
| hub | 鉴权、令牌、成员、审批、调度、租约、进度线程 | 12 | 通过 |
| worker | 消息监听、席位锁、幂等、超时、取消 | 13 | 通过 |
| uvcs-workspace | `cm` 解析、锁、工作区、Unity 桥 | 4 | 通过 |
| worker-monitor | 只读边界、DNS重绑定、脱敏、回退、实时执行/编译尾读 | 10 | 通过 |
| collaboration | 持久进度问答、同上下文答复、接管路由与本机helper | 18 | 通过 |
| 端到端 + 消息监听 | 故障注入与全流程 | 11 | 通过 |
| **合计** |  | **75** | **全部通过** |

端到端用例覆盖：缺少 Editor.log 必须拦截、加锁失败只释放已获取锁、任务工作区隔离、租约丢失禁止签入、子进程树强杀、`--changeset=cs:<n>` 参数、备份失败时安全冻结，以及真实 HTTP 下的双向消息闭环。

运行测试：

```bash
pnpm install
pnpm build
pnpm test                 # 契约、Hub、Worker、UVCS、监视台和协作扩展共64项
node --test tests/*.test.mjs   # 端到端与消息监听 11 项
```

## 当前边界与后续方向

- **单 Hub，无高可用**：当前部署为单控制平面，PostgreSQL 与控制台均为单点；跨可用区故障切换尚未实现。
- **轮询式消息接收**：Worker 默认每 2 秒轮询事件游标，端到端延迟受轮询周期约束，尚未采用服务端主动推送。
- **双响应者风险**：若同一角色在两台主机同时监听，可能重复消耗模型配额；系统通过本地席位锁与运维约定缓解，但未做全局唯一性强制。
- **模型不确定性**：系统保证调度、隔离与交付边界，不保证生成内容的质量或可编译性。
- **引擎耦合**：Unity/UVCS 门禁与 `cm` CLI 紧密绑定，接入其他引擎需要新增适配层。
- **可选扩展边界**：进度与自动路由需显式配置；附带扩展启动器目前支持Codex，真实对端回复仍依赖协作者在线及其响应实现。消息编辑的目录限制是执行约定，不是操作系统沙箱。
- **规模验证有限**：当前仅完成双机、少量并发任务的端到端验证，尚未进行大规模并发压测。

未来工作包括：控制平面高可用与领导者选举、基于 SSE 的主动推送、跨项目资源配额、以及更细粒度的审计与回放。

## 文档与图示

- [协作运行扩展](scripts/collaboration/README.md)：进度问答、路由、云端交付读取与配置方式。
- [本机监视台配置](scripts/worker-monitor/README.md)：启动、日志范围与访问边界。
- [流程图编辑源稿](docs/figures/diagram-sources.md)与[绘图提示词](docs/figures/PROMPTS.md)：维护三张学术风格图示。
- [协议与版权说明](NOTICE.md)：A2A、ACP、MCP、Unity UVCS CLI 与 Unity Test Framework 的相关说明。

## 许可

本项目采用 **MIT License**。协议兼容与第三方版权说明见 [NOTICE.md](NOTICE.md)。
