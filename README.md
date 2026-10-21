<div align="center">

# 面向异构智能体的多机协作交付系统

**muti-agent-cowk** · A Multi-Agent Collaborative Delivery System for Heterogeneous CLI Agents and Unity/UVCS Projects

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](#5-实现)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=node.js&logoColor=white)](#8-快速开始)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-%E2%89%A514-4169e1?logo=postgresql&logoColor=white)](#5-实现)
[![Tests](https://img.shields.io/badge/tests-75%20passed-2f855a)](#6-实验与验证)
[![License](https://img.shields.io/badge/license-MIT-2f855a)](#11-许可与致谢)

[摘要](#摘要) · [引言](#1-引言) · [相关工作](#2-相关工作) · [系统架构](#3-系统架构) · [方法](#4-方法) · [实现](#5-实现) · [实验与验证](#6-实验与验证) · [局限](#7-局限与未来工作) · [快速开始](#8-快速开始) · [参考文献](#10-参考文献)

</div>

---

## 摘要

本文介绍 **muti-agent-cowk**：一个面向异构命令行智能体（Grok Build、OpenAI Codex 等）与 Unity/UVCS 工程的跨主机协作交付系统。系统采用“中心协调、边缘执行”的混合架构：Hub 以 PostgreSQL 为唯一事实源，通过原子租约、单调 fencing token 与显式状态机实现任务的确定性派发；Worker 在本地持有模型凭据，于隔离工作区中执行，并通过 A2A 消息完成跨端接口对齐与评审。针对游戏工程中不可合并的二进制资产与元数据完整性问题，系统引入排他文件锁、`.meta` 校验、新鲜 Editor.log 门禁与检查点冻结机制。

当前版本通过75项自动化测试，覆盖指派领取、租约丢失、故障注入、破坏性清理拦截，以及进度问答、接管路由与日志尾读。自动化结果不等于任意真实模型任务或生产部署已完成业务验收。

**关键词**：多智能体系统；异构智能体；分布式任务调度；fencing token；版本控制安全；Unity

---

## 1. 引言

### 1.1 问题背景

以大语言模型为内核的命令行智能体已具备自主修改代码、运行测试与提交变更的能力。当多个智能体分布在不同的物理主机上、面向同一代码仓库协作时，仅依靠人工转述或共享聊天窗口会带来三类结构性缺陷：

1. **状态缺失**：谁在执行、执行到哪一步、是否已提交，缺乏可审计的唯一事实源；
2. **重复执行**：网络抖动或进程重启可能导致同一任务被领取两次，进而产生冲突提交；
3. **边界模糊**：模型凭据、文件系统与版本库操作分散在各端，权限与破坏性操作难以约束。

### 1.2 研究问题

本文将问题归纳为四个可工程化的子问题：

| 编号 | 子问题 | 本文对应机制 |
| :--: | :-- | :-- |
| Q1 | 如何保证同一任务在任一时刻只被一个执行端持有？ | 原子领取 + 租约 + fencing token |
| Q2 | 如何让异构智能体在同一任务语义下交换信息？ | A2A 信封 + 线程与幂等键 |
| Q3 | 如何避免自动执行破坏不可合并资产或丢失工作成果？ | 隔离工作区 + 检查点 + 安全冻结 |
| Q4 | 如何区分开发、评审与审批职责？ | 项目角色 + 审批权限分离 |

### 1.3 主要贡献

- **C1｜中心协调、边缘执行的混合架构**：控制平面只保存状态与事件，模型调用与版本库操作全部留在执行端，凭据不出本机。
- **C2｜确定性任务派发**：以“指定派给（assigned dispatch）”替代抢单，结合 `FOR UPDATE SKIP LOCKED`、租约续期与单调 fencing token，消除脑裂写入。
- **C3｜面向 Unity/UVCS 的安全门禁**：独立任务工作区、排他锁精确释放、`.meta` 完整性、新鲜编译日志门禁、失败前检查点与冻结策略。
- **C4｜可审计的协作协议**：统一 A2A 消息语义，区分根提问与答复，抑制智能体互问死循环，并将人工审批纳入状态机。

---

## 2. 相关工作

多智能体协作框架通常聚焦于“对话编排”或“角色流水线”，而分布式执行约束与版本控制安全往往被留作工程细节。本文的工作位于二者的交叉处。

| 研究方向 | 代表工作 | 主要关注 | 与本文的差异 |
| :-- | :-- | :-- | :-- |
| 对话式多智能体编排 | AutoGen [1] | 以消息传递组织多智能体对话 | 不提供跨主机租约、原子派发与 VCS 门禁 |
| 角色化软件生成 | MetaGPT [2]、ChatDev [3] | 以 SOP/角色分工生成软件工件 | 侧重单次生成流程，缺少长期运行的任务状态与恢复语义 |
| 多智能体综述 | Guo 等 [4] | 归纳协作、竞争与评测范式 | 提供问题空间，不涉及具体交付基础设施 |
| 智能体互操作协议 | A2A [7]、MCP [8] | 代理间通信与工具暴露 | 本文将其组合进带租约与审批的交付流水线 |
| 分布式锁与防脑裂 | Kleppmann [5]、PostgreSQL [6] | 租约、fencing、行级并发控制 | 本文将其落到任务状态机与执行端写操作门禁 |

> [!NOTE]
> 本文不主张提出新的模型能力或训练方法；贡献在于将分布式系统与版本控制的安全约束，落到异构智能体的实际交付流程中。

---

## 3. 系统架构

### 3.1 设计原则

1. **单一事实源**：任务、运行、事件、消息与审批均以 Hub 的 PostgreSQL 为准。
2. **凭据本地化**：Grok/Codex 的登录态只存在于各自主机，Hub 不接触模型凭据。
3. **显式边界**：状态迁移、权限判定与破坏性操作均需通过显式校验，而非依赖约定。

### 3.2 总体结构

![图1：中心控制平面与独立执行端架构](docs/figures/system-architecture.png)

*图1. 中心协调、边缘执行：模型凭据留在本机，经过验证的变更集进入UVCS。*

### 3.3 组件职责

| 组件 | 位置 | 职责 |
| :-- | :-- | :-- |
| **Hub** | 服务器 | 调度、状态机、事件流、鉴权、审批、MCP 工具服务 |
| **Worker** | 各协作主机 | 领取指定任务、驱动本地 CLI、执行 UVCS/Unity 流程、收发 A2A 消息 |
| **PostgreSQL** | 服务器 | 唯一事实源；行级锁与事件游标 |
| **Web 控制台** | 服务器静态资源 | 任务与消息可视化、人工审批、成员与令牌管理 |
| **本机监视台** | 各协作主机 | 只读回环面板：心跳、进程、消息、日志 |
| **适配器** | Worker 进程内 | Grok ACP/stdio、Codex CLI 子进程桥接 |

---

## 4. 方法

### 4.1 任务状态机

系统定义 12 个状态，并通过显式转移表约束合法迁移；终态不可再迁移。

![图2：任务生命周期简图](docs/figures/task-lifecycle.png)

*图2. 12种任务状态的主要迁移（简图，省略部分异常路径）；leased可直接提交，完整规则以[契约转移表](packages/contracts/src/state-machine.ts)为准。*

> [!IMPORTANT]
> 非法迁移在写入前即被拒绝；`completed`、`failed`、`cancelled` 为终态。互问成环时任务转入 `waiting_human`，由人工终止循环。

### 4.2 原子派发与租约

任务在创建时即绑定 `assigned_agent`。Worker 只能领取指派给自己的任务，从机制上避免“抢单”带来的争用与误领。

```text
claim(agentId, projectId):
    BEGIN
      row ← SELECT * FROM tasks
            WHERE project_id = projectId
              AND assigned_agent = agentId
              AND state = 'queued'
            ORDER BY created_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
      token ← next_monotonic_fencing_token()
      UPDATE runs
         SET worker_id = agentId,
             fencing_token = token,
             lease_expires_at = now() + lease
      UPDATE tasks SET state = 'leased'
    COMMIT
    return (runId, token)
```

租约机制包含三条约束：

1. **续期校验**：`(runId, workerId, fencingToken)` 三元组必须同时匹配；
2. **写操作门禁**：续期、提交、失败上报与签入前均复核租约，过期即拒绝；
3. **有界重试**：租约回收与失败上报共享 `maxRepairs` 预算，超限转入 `failed`，避免无限重试。

### 4.3 A2A 消息与线程

跨端消息采用统一信封，支持 `clarify_interface`、`request_review`、`review_verdict` 与 `handover` 四类语义。消息共享 `taskId` 与 `threadId`，答复通过 `replyToId` 指回根提问。

![图3：任务澄清与执行中进度讨论](docs/figures/peer-coordination.png)

*图3. 普通澄清消息与执行中的进度讨论。`progress:`线程保持现有任务状态与租约；答复回到同一执行上下文。图示的事件通道不表示默认Worker已改为SSE推送。*

为抑制智能体互答死循环，系统只对**根提问**生成自动答复；答复本身不再触发自动回复。生成结果先落盘再发送，并携带稳定幂等键，因此 POST 响应丢失或进程重启不会造成重复消息。

### 4.4 隔离工作区与版本控制安全

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

### 4.5 身份、角色与审批分离

| 角色 | 等级 | 读取 | 创建/修改任务 | 审批 | 成员管理 |
| :-- | :--: | :--: | :--: | :--: | :--: |
| `viewer` | 1 | ✓ | — | — | — |
| `reviewer` | 2 | ✓ | — | ✓ | — |
| `developer` | 3 | ✓ | ✓ | — | — |
| `owner` | 4 | ✓ | ✓ | ✓ | ✓ |
| `admin` | 系统级 | ✓ | ✓ | ✓ | ✓ |

审批权限单独判定，仅 `owner`、`reviewer` 与系统管理员可执行，避免“开发者自审自批”。认证材料采用 scrypt 口令哈希、HMAC-SHA256 会话与 SHA-256 令牌摘要；本机凭据以 DPAPI 加密保存。

---

### 4.5 执行中进度与协作目标更新

可选执行端扩展在工作区就绪、文件修改、Unity批处理、验证、签入和Hub确认提交等节点汇报进度；CLI可提问并读取同一任务线程的实际回复。父Worker保管凭据、持久化发件箱、使用稳定幂等键重试。问题等待超时不视为同意，收到回复不会另开一个编辑器重做同一任务。

`progress:<runId>`线程不把正在执行的任务误切为`waiting_peer`。接管通知需明确唯一的`toAgent`，通过同项目来源/请求关联、时效及在线Worker核验后，才持久化更改后续协作目标；它不改变本机Agent身份、权限或任务分派。核验器缺失时拒绝启用自动路由。

本机监视台默认显示CLI公开执行输出与当前隔离工作区的Editor.log，每秒更新，标注根据日志推断的阶段；阶段标签不改变Hub任务状态，不显示模型内部推理。

收件会话可读取父Worker提供的运行证据和指定云端变更集缓存；收件分支版本不代表云端交付不存在。云端读取不会切换工作区，指定摘要可用于比对下载文件。签入前可选纳管新增Assets/ProjectDocs交付文件，并排除日志。

标准Worker入口仍保留。可选Codex启动器、私有配置样例、权限边界和使用方式见[scripts/collaboration](scripts/collaboration/README.md)。图像由内置绘图工具生成并人工核对；[编辑源稿](docs/figures/diagram-sources.md)与[绘图提示词](docs/figures/PROMPTS.md)随仓库保存。

---

## 5. 实现

### 5.1 代码组织

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

### 5.2 技术栈

| 层次 | 选型 |
| :-- | :-- |
| 语言与构建 | TypeScript（strict）、pnpm workspace、tsc |
| 服务端 | Fastify、Node.js ≥ 20 |
| 存储 | PostgreSQL ≥ 14（行级锁、事件游标） |
| 实时通道 | Server-Sent Events（断点续传 + 游标去重） |
| 智能体接入 | Grok Build ACP/stdio、OpenAI Codex CLI |
| 协议 | A2A 信封、MCP（Streamable HTTP） |
| 前端 | 原生 HTML/CSS/JS 静态控制台，不引入前端框架 |

### 5.3 主要接口

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

> [!TIP]
> 面向 Agent 的完整操作流程与工具调用约定，见仓库维护者的本地手册；对外文档只描述接口语义，不包含任何部署地址或账号信息。

---

## 6. 实验与验证

### 6.1 验证方法

验证目标是**调度正确性、故障恢复与破坏性操作安全**，而非模型能力基准。测试由四层构成：契约层单元测试、Hub/Worker 集成测试、UVCS 解析测试，以及带故障注入的端到端测试。所有端到端测试使用模拟子进程与本地 Hub，不调用真实模型、不访问生产环境。

### 6.2 测试结果

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

### 6.3 资源观测

在 2 vCPU / 4 GiB 的单实例部署中，Hub 进程的 `MemoryPeak` 约为 **72 MiB**，常驻约 **58 MiB**（systemd 统计，2026-10-20 观测）。该数值仅代表当前部署负载，不构成规模化基准。

复现命令：

```bash
pnpm install
pnpm build
pnpm test                 # 契约、Hub、Worker、UVCS、监视台和协作扩展共64项
node --test tests/*.test.mjs   # 端到端与消息监听 11 项
```

---

## 7. 局限与未来工作

1. **单 Hub，无高可用**：当前部署为单控制平面，PostgreSQL 与控制台均为单点；跨可用区故障切换尚未实现。
2. **轮询式消息接收**：Worker 默认每 2 秒轮询事件游标，端到端延迟受轮询周期约束，尚未采用服务端主动推送。
3. **双响应者风险**：若同一角色在两台主机同时监听，可能重复消耗模型配额；系统通过本地席位锁与运维约定缓解，但未做全局唯一性强制。
4. **模型不确定性**：系统保证调度、隔离与交付边界，不保证生成内容的质量或可编译性。
5. **引擎耦合**：Unity/UVCS 门禁与 `cm` CLI 紧密绑定，接入其他引擎需要新增适配层。
6. **可选扩展边界**：进度与自动路由需显式配置；附带扩展启动器目前支持Codex，真实对端回复仍依赖协作者在线及其响应实现。消息编辑的目录限制是执行约定，不是操作系统沙箱。
7. **规模验证有限**：当前仅完成双机、少量并发任务的端到端验证，尚未进行大规模并发压测。

未来工作包括：控制平面高可用与领导者选举、基于 SSE 的主动推送、跨项目资源配额、以及更细粒度的审计与回放。

---

## 8. 快速开始

### 8.1 环境要求

| 依赖 | 版本 | 说明 |
| :-- | :-- | :-- |
| Node.js | ≥ 20 | 推荐 20 LTS 或 22 LTS |
| pnpm | ≥ 9 | workspace 管理 |
| PostgreSQL | ≥ 14 | 推荐 16 |
| Grok CLI / Codex CLI | 最新版 | 按执行端角色安装并完成登录 |

### 8.2 部署 Hub

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

### 8.3 启动 Worker

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

### 8.4 自检

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

---

## 9. 本机监视台

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

---

## 10. 参考文献

1. Wu, Q., Bansal, G., Zhang, J., et al. **AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent Conversation.** arXiv:2308.08155, 2023. <https://arxiv.org/abs/2308.08155>
2. Hong, S., Zhuge, M., Chen, J., et al. **MetaGPT: Meta Programming for A Multi-Agent Collaborative Framework.** arXiv:2308.00352, 2023. <https://arxiv.org/abs/2308.00352>
3. Qian, C., Liu, W., Liu, H., et al. **ChatDev: Communicative Agents for Software Development.** arXiv:2307.07924, 2023. <https://arxiv.org/abs/2307.07924>
4. Guo, T., Chen, X., Wang, Y., et al. **Large Language Model based Multi-Agents: A Survey of Progress and Challenges.** arXiv:2402.01680, 2024. <https://arxiv.org/abs/2402.01680>
5. Kleppmann, M. **Designing Data-Intensive Applications.** O'Reilly Media, 2017.（分布式锁与 fencing token）
6. PostgreSQL Global Development Group. **SELECT — FOR UPDATE / SKIP LOCKED.** <https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE>
7. **Agent2Agent (A2A) Protocol Specification.** <https://a2a-protocol.org/>
8. **Model Context Protocol Specification.** <https://modelcontextprotocol.io/>
9. Unity Technologies. **Unity Version Control CLI 文档.** <https://docs.unity.com/en-us/unity-version-control/uvcs-cli/>

### 引用本文

```bibtex
@software{muti_agent_cowk_2026,
  title  = {muti-agent-cowk: A Multi-Agent Collaborative Delivery System},
  author = {{qyyyy09315}},
  year   = {2026},
  url    = {https://github.com/qyyyy09315/muti-agent-cowk}
}
```

---

## 11. 许可与致谢

本项目采用 **MIT License**。

协议与规范层面的引用、兼容与版权说明见 [NOTICE.md](NOTICE.md)，包括 A2A、ACP、MCP、Unity UVCS CLI 与 Unity Test Framework。

<div align="center">
<sub>以显式状态、可验证租约与最小权限，约束多个智能体的协作边界。</sub>
</div>
