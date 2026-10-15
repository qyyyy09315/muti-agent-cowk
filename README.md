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
# On Peer A machine (e.g. Grok):
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

---

## Open Source Credits & Standards
See [NOTICE.md](./NOTICE.md) for full compliance details regarding the Model Context Protocol (MCP), Agent2Agent (A2A) protocol, and Unity Version Control specifications.

## License
MIT License.
