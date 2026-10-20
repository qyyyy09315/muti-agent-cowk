-- 003_auth_tokens.sql: 控制面鉴权底座
-- 目标：多用户接入前先封住匿名读写；API Token 仅存 SHA-256 哈希。

CREATE TABLE IF NOT EXISTS api_tokens (
    id           VARCHAR(64) PRIMARY KEY,
    user_id      VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id     VARCHAR(64),
    label        VARCHAR(100) NOT NULL,
    token_hash   VARCHAR(128) NOT NULL UNIQUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);

-- 审计：任务创建者
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL;
