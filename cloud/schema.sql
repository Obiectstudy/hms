-- HMS 云同步后端表结构（腾讯云开发 SQL 型数据库 / PostgreSQL）
--
-- 在云开发控制台的 SQL 编辑器里整段执行；全部带 IF NOT EXISTS，可重复执行。
-- 这里不出现任何连接串、密码或环境变量值。

-- 账号表：用户名大小写不敏感唯一（username 存原样，username_lower 存小写用于唯一约束与查询）
-- id 用 int4（SERIAL）而不是 bigserial：node-postgres 会把 int8 读成字符串，int4 才是 JS number，
-- 直接决定接口返回的 userId 是 1 还是 "1"。
CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  username       TEXT        NOT NULL,
  username_lower TEXT        NOT NULL UNIQUE,
  pwd_hash       TEXT        NOT NULL,
  pwd_salt       TEXT        NOT NULL,
  recovery_hash  TEXT        NOT NULL,
  recovery_salt  TEXT        NOT NULL,
  fail_count     INTEGER     NOT NULL DEFAULT 0,
  locked_until   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 会话表：主键是 token 的 sha256 十六进制串，明文 token 永不落库
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT        PRIMARY KEY,
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- 快照表：每个账号一行整库快照
CREATE TABLE IF NOT EXISTS snapshots (
  user_id  INTEGER     PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rev      INTEGER     NOT NULL DEFAULT 0,
  saved_at TIMESTAMPTZ,
  payload  JSONB
);

-- 索引
CREATE INDEX IF NOT EXISTS sessions_user_id_idx    ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS users_locked_until_idx  ON users (locked_until);

-- 可选的日常维护（按需手动执行，不放进云函数热路径）：
--   DELETE FROM sessions WHERE expires_at <= now();
