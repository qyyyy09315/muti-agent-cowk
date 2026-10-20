# Multi-Agent Collaborative Workflow (muti-agent-cowk)

A lightweight, reliable multi-agent orchestration and delivery system for collaborative software and game engineering (e.g. Grok Build, OpenAI Codex, Unity Version Control / Plastic SCM).

---

## Architecture Overview

```text
               【Central Orchestration Hub】
                     ┌─────────────────────────────┐
                     │ Nginx Reverse Proxy (HTTPS) │
                     │  ├─ Web Admin & Approval UI │
                     │  ├─ Fastify REST / SSE API  │
                     │  ├─ Streamable HTTP MCP     │
                     │  └─ PostgreSQL State Store  │
                     └──────────────┬──────────────┘
                                    │ Outbound HTTPS SSE / Long-polling
             ┌──────────────────────┴──────────────────────┐
             ▼                                             ▼
  【Peer A Worker (e.g. Grok)】                 【Peer B Worker (e.g. Codex)】
  ├─ CLI / ACP Subprocess Adapter               ├─ CLI / SDK Subprocess Adapter
  ├─ Isolated Task Workspace                    ├─ Isolated Task Workspace
  ├─ Local Editor / Batch Bridge                ├─ Local Editor / Batch Bridge
  └─ Local Provider Auth                        └─ Local Provider Auth
             │                                             │
             └──────── Shared Cloud VCS (e.g. UVCS) ───────┘
```

---

## Key Features

1. **Agent-to-Agent (A2A) Protocol**: Standardized communication envelope for cross-agent interface clarification (`clarify_interface`), code reviews (`request_review`), review verdicts (`review_verdict`), and handovers (`handover`).
2. **Deterministic Task Scheduler**: PostgreSQL row-level locks (`FOR UPDATE SKIP LOCKED`) with incremental fencing tokens to prevent split-brain execution.
3. **No Public Registration**: Closed authentication model. Accounts are provisioned strictly offline via administrative scripts with salted scrypt hashing.
4. **VCS & Engine Safety (Unity / Plastic SCM)**: Enforces isolated task branches (`br:/main/ai/<taskId>/<agentId>`), exclusive resource locks for non-mergeable assets, and `.meta` GUID integrity checks.
5. **Lightweight Footprint**: Hub core runs on Node.js + PostgreSQL (< 300MB RAM), designed for cost-efficient cloud hosting.

---

## Deployment & Setup Guide for Collaborators

### 1. Prerequisites
- **Node.js**: v20+ or v24+
- **pnpm**: v9+ or v10+
- **PostgreSQL**: v14+ (v16+ recommended)

### 2. Hub Setup (Server)
```bash
# Clone the repository
git clone https://github.com/<your-org>/muti-agent-cowk.git
cd muti-agent-cowk

# Install dependencies and build
pnpm install
pnpm build

# Run database migrations
psql -d <your_db_name> -f db/migrations/001_init.sql

# Create an administrator account offline (no public web registration)
node scripts/create-user.mjs <admin_username> <admin_password> admin

# Start the Hub service
DATABASE_URL="postgresql://user:pass@127.0.0.1:5432/your_db" pnpm --filter @ai-collab/hub start
```

### 3. Worker Setup (Collaborator Machine)
Each peer runs a local worker daemon connected to the Hub:

```bash
# On Peer A machine (e.g. Grok). Message listening is on by default.
pnpm --filter @ai-collab/worker start \
  --type grok \
  --hub https://<your-hub-domain> \
  --project <project_id> \
  --workspace "/path/to/local/unity/workspace"

# On Peer B machine (e.g. Codex):
pnpm --filter @ai-collab/worker start \
  --type codex \
  --hub https://<your-hub-domain> \
  --project <project_id> \
  --workspace "/path/to/local/unity/workspace"
```

### 4. Health Check
Run the built-in diagnostic tool to verify environment and Hub connectivity:
```bash
node scripts/doctor.mjs
```

### 5. Automatic peer messages

A normal Worker start listens for Hub `message_sent` events. Pass
`--no-listen-messages` to claim tasks only. `--messages-only` keeps the heartbeat
and the inbox, and does not claim tasks or run Unity/UVCS.

Questions are handed to the current project session: Grok uses `grok --continue`
in the workspace, and Codex uses `codex exec resume --last`. If that session does
not exist, the Worker starts one new turn in the same workspace. Answers are sent
back on the channel. A reply is delivered into the asking session and, when the
task is `waiting_peer`, the task returns to the queue so the original Worker
picks it up again. Replies do not generate another automatic peer message.
Both machines must run this version.

```powershell
# Terminal A and Terminal B use the same project workspace. Listening is already on.
pnpm --filter @ai-collab/worker start --type grok --worker-id worker_grok_local --hub https://<your-hub-domain> --project <project_id> --workspace "/path/to/local/unity/workspace"

pnpm --filter @ai-collab/worker start --type codex --worker-id worker_codex_local --hub https://<your-hub-domain> --project <project_id> --workspace "/path/to/local/unity/workspace"
```

Use your own Hub URL, project id, and Worker id. `--type` selects the routing role
and which local session receives the message. Run only one listener for each
Hub, project, and role. Stop any previous heartbeat bridge for the same Worker id.

Prerequisites: a signed-in `grok` CLI on the Grok machine (`GROK_BIN` optional)
and a signed-in `codex` CLI on the Codex machine (`CODEX_BIN` optional). Windows
npm `codex.cmd` shims are resolved to `@openai/codex/bin/codex.js`.

Send questions using existing MCP `peer_ask` or `POST /api/messages`, with a real
`taskId`, shared `threadId`, `fromAgent` and `toAgent`. Root messages have a null
`replyToId`. Answers preserve the task/thread and set `replyToId` to the question
ID. Incoming answers are printed as `[Message received]` in the Worker log; they
do **not** generate further automatic answers. Start a new root message for a
follow-up question. Cancelled tasks receive no automatic replies. This version
consumes ordinary messages, not the separate `/api/a2a/send` envelope stream.

The listener polls every two seconds with a durable event cursor. First startup
reads the existing event backlog, including unanswered old questions. Received
questions run serially; failures retry with backoff and retain the cursor. A
generated reply is saved before sending and retried with a stable idempotency
key, so losing a POST response or restarting does not duplicate the Hub reply.
A crash before saving generated text can rerun inference. Each reply has a
120-second process timeout and a 16,000-character limit. Repeated model/login
errors block that inbox at the failed question until fixed; inspect the retry log.

State lives outside Unity at `~/.ai-collab/inbox`, scoped by Hub/project/role.
Use `--message-state-dir <directory>` for another persistent local location;
preserve it across restarts. Do not share this directory across computers.
Its local process lock prevents duplicate listeners on one machine. Hub reply
deduplication also applies across machines, but simultaneous responders on two
machines can still spend tokens twice; assign one receiver per role.

Delivery prefers the newest session for that workspace, so an already open Grok
or Codex conversation receives the peer text. A missing session gets one new
turn in the workspace instead of a throwaway read-only directory. Each new root
question can consume local model quota. Ordinary task execution still follows
the isolated-workspace pipeline. Grok task runs use `grok --prompt-file`, not
`grok run --headless`.

Offline validation after `pnpm install`:

```bash
pnpm build
pnpm test
node --test tests/message-listener.test.mjs
```

Tests use fake CLI subprocesses and a local Hub; they do not call a model or
send messages to the production Hub.

---

## Open Source Credits & Standards
See [NOTICE.md](./NOTICE.md) for full compliance details regarding the Model Context Protocol (MCP), Agent2Agent (A2A) protocol, and Unity Version Control specifications.

## License
MIT License.
