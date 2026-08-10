-- 0119_facebook_rule_batch_includes_join.sql
-- aidcp:kind=expand
-- aidcp:objects=column:facebook_rule_batch.includes_join
--
-- Persist the "this round includes a group join" decision at batch creation
-- (change facebook-cadence-probability-mode). In fixed mode this equals the
-- derived `sequence % joinEveryNRounds === 0`; in probabilistic mode it is a
-- one-time 1/joinEveryNRounds draw. It MUST be persisted because the predicate
-- is read repeatedly (status queries, recovery, reconciliation) and a fresh
-- draw each read would drift. NULL tolerates pre-existing rows, which fall back
-- to the fixed derivation on read.

ALTER TABLE facebook_rule_batch
  ADD COLUMN IF NOT EXISTS includes_join BOOLEAN;
