-- 0115_blocking_overlay_samples.sql
-- aidcp:kind=expand
-- aidcp:owner=automation
-- aidcp:objects=table:blocking_overlay_samples,index:idx_blocking_overlay_samples_platform_created
-- aidcp:objects=index:idx_blocking_overlay_samples_fingerprint,index:uq_blocking_overlay_samples_capture
--
-- change blocking-overlay-dom-capture：阻断弹窗现场样本留存。
--
-- 为什么不复用 alerts：
--  ① alerts.detail 是 TEXT，且写入前经 formatDomFeature 拍平成给人读的 Markdown ——
--     结构一旦拍平就再也聚类不了，而本表存在的全部意义就是「后续照着结构写代码」；
--  ② 告警去重冷却（同 edge 同类型 10 分钟）在**落库动作之前** return ——
--     弹窗越随机，样本越攒不起来，恰好与本表的目的相反。
-- 故样本独立成表、独立于冷却写入。
--
-- capture_id 由**边缘**生成（非本表自增），并在此建唯一键：
--  ① 同一个标识贯穿「边缘诊断行 → 上报载荷 → 云端样本行 → 告警正文」四处，
--     排查时从任何一端都能对上另外三端；自增主键只存在于库里，边缘日志永远对不上号；
--  ② 唯一键令重投幂等——同一次上报被处理两次 MUST NOT 写出第二条样本；
--  ③ 样本写失败时告警仍带得出这个标识并注明「未存住」，而不是连「曾经采到过」都无从得知。
--
-- payload 存 JSONB 原样：MUST NOT 在留存前拍平。截断标记等元信息也在 payload 里，
-- 消费方据此知道这份样本完不完整。
-- 库：aidcp（user=aidcp）。幂等：CREATE TABLE / INDEX IF NOT EXISTS，可重复执行。

CREATE TABLE IF NOT EXISTS blocking_overlay_samples (
  sample_id    BIGSERIAL PRIMARY KEY,
  capture_id   TEXT NOT NULL,                 -- 边缘生成的采集标识（贯穿四处，唯一）
  platform     TEXT,                          -- 'facebook' | 'xiaohongshu' | ...（缺失不臆造）
  edge_id      TEXT,
  account_id   TEXT,
  kind         TEXT NOT NULL,                 -- 'captcha' | 'unknown'（阻断类别）
  status       TEXT NOT NULL,                 -- 'captured' | 'none_visible' | 'failed'（采集三态）
  url          TEXT,
  text_digest  TEXT,                          -- 遮罩文案指纹（同形态弹窗聚类用）
  captured_at  TIMESTAMPTZ,                   -- 边缘采集时刻（非入库时刻）
  payload      JSONB NOT NULL,                -- 采集结果原样
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 幂等键：重投同一次上报只落一条。
CREATE UNIQUE INDEX IF NOT EXISTS uq_blocking_overlay_samples_capture
  ON blocking_overlay_samples (capture_id);

-- 「这个平台最近出现过哪些形态」——攒样本后的主查询路径。
CREATE INDEX IF NOT EXISTS idx_blocking_overlay_samples_platform_created
  ON blocking_overlay_samples (platform, created_at DESC);

-- 「同一形态出现过几次」——按文案指纹聚类。
CREATE INDEX IF NOT EXISTS idx_blocking_overlay_samples_fingerprint
  ON blocking_overlay_samples (text_digest, created_at DESC);
