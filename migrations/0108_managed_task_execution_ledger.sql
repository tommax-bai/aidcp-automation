-- aidcp:kind=expand
-- aidcp:objects=table:execution_intents,table:execution_attempts
-- aidcp:objects=index:uq_execution_intents_target_idempotency,index:idx_execution_intents_target_run
-- aidcp:objects=index:uq_execution_attempts_target_intent_ordinal,index:idx_execution_attempts_target_status,index:idx_execution_attempts_target_run
CREATE TABLE IF NOT EXISTS execution_intents (
  intent_id UUID PRIMARY KEY,
  execution_target TEXT NOT NULL CHECK (execution_target IN ('dev','ol')),
  run_id UUID NOT NULL,
  step_run_id UUID NOT NULL,
  account_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  capability_version INTEGER NOT NULL CHECK (capability_version >= 1),
  input_ref TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_execution_intents_target_idempotency
  ON execution_intents (execution_target, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_execution_intents_target_run ON execution_intents (execution_target, run_id, created_at);

CREATE TABLE IF NOT EXISTS execution_attempts (
  attempt_id UUID PRIMARY KEY,
  execution_target TEXT NOT NULL CHECK (execution_target IN ('dev','ol')),
  intent_id UUID NOT NULL,
  run_id UUID NOT NULL,
  step_run_id UUID NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  status TEXT NOT NULL CHECK (status IN (
    'prepared','dispatching','submitted_unknown','completed','empty','failed',
    'timeout','undeliverable','aborted','unsupported'
  )),
  reason_code TEXT,
  evidence JSONB,
  strongest_progress_evidence_ref TEXT,
  reconciliation_count INTEGER NOT NULL DEFAULT 0 CHECK (reconciliation_count >= 0),
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_execution_attempts_target_intent_ordinal
  ON execution_attempts (execution_target, intent_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_execution_attempts_target_status
  ON execution_attempts (execution_target, status, prepared_at);
CREATE INDEX IF NOT EXISTS idx_execution_attempts_target_run ON execution_attempts (execution_target, run_id, prepared_at);
