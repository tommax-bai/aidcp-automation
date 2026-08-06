-- 0116_restricted_policy_config.sql
-- aidcp:kind=expand
-- aidcp:owner=automation
-- aidcp:objects=table:restricted_policy_config
--
-- change restricted-policy-global-config：受限（restricted）处置策略的全局单行配置。
--
-- 复刻 resume_config_global 形态（单行 id=1 CHECK + 可空列 = 未覆盖回落写死默认）：
--  - mode：'browse_only'（只浏览，默认，现状零回归）/ 'full_pause'（浏览也暂停）；
--  - recovery_hours：受限自动恢复时长（小时）。NULL = 回落默认 72。
-- 两列均可空：缺行 / 缺列时行为 MUST 与配置化之前逐位一致（绝不 brick）。
--
-- 消费方（automation 进程内）：RiskController 的 view 判定、风控状态机恢复窗口、
-- 自动恢复扫描器。写入走 restricted-policy-store 的 writeWithMirrorBump
--（同事务推进镜像失效信号，dev/ol 共库双进程）。
-- 库：aidcp（user=aidcp）。幂等：CREATE TABLE IF NOT EXISTS，可重复执行。

CREATE TABLE IF NOT EXISTS restricted_policy_config (
  id             INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  mode           TEXT CHECK (mode IN ('browse_only','full_pause')),
  recovery_hours INTEGER,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     TEXT
);
