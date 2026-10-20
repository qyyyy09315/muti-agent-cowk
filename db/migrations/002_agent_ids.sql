-- 002_agent_ids.sql: 支持任意命名的 Agent（指定派给）
-- 旧值 grok / codex / unassigned 仍然有效；此处仅放宽长度，便于使用 grok-a / codex-b / claude-c 等标识。

ALTER TABLE workers   ALTER COLUMN agent_type   TYPE VARCHAR(64);
ALTER TABLE tasks     ALTER COLUMN assigned_agent TYPE VARCHAR(64);
ALTER TABLE messages  ALTER COLUMN from_agent   TYPE VARCHAR(64);
ALTER TABLE messages  ALTER COLUMN to_agent     TYPE VARCHAR(64);
ALTER TABLE approvals ALTER COLUMN requested_by TYPE VARCHAR(64);
ALTER TABLE a2a_envelopes ALTER COLUMN from_agent TYPE VARCHAR(64);
ALTER TABLE a2a_envelopes ALTER COLUMN to_agent   TYPE VARCHAR(64);

-- 便于按 Agent 精确指派与检索
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_state ON tasks (assigned_agent, state, created_at);
