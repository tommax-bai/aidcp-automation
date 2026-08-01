-- aidcp:kind=expand
-- aidcp:objects=table:decision_traces
-- aidcp:objects=index:idx_decision_traces_target_task,index:idx_decision_traces_target_run
-- aidcp:objects=index:idx_decision_traces_target_step,index:idx_decision_traces_target_attempt,index:idx_decision_traces_target_correlation
-- Append-only explanation ledger. Input/evidence fields contain refs or hashes, never raw private payloads.
CREATE TABLE IF NOT EXISTS decision_traces (
  trace_id UUID PRIMARY KEY,
  execution_target TEXT NOT NULL CHECK (execution_target IN ('dev','ol')),
  seq BIGSERIAL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  task_id UUID,
  run_id UUID,
  step_run_id UUID,
  attempt_id UUID,
  decision_type TEXT NOT NULL CHECK (decision_type IN (
    'creation','compilation','lane_admission','dispatch','evidence','cancellation','reconciliation'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'allowed','denied','delayed','selected','skipped','attention_required'
  )),
  reason_code TEXT NOT NULL,
  input_refs JSONB NOT NULL DEFAULT '[]',
  evidence_refs JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_decision_traces_target_task
  ON decision_traces (execution_target, task_id, seq) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_decision_traces_target_run
  ON decision_traces (execution_target, run_id, seq) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_decision_traces_target_step
  ON decision_traces (execution_target, step_run_id, seq) WHERE step_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_decision_traces_target_attempt
  ON decision_traces (execution_target, attempt_id, seq) WHERE attempt_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_decision_traces_target_correlation
  ON decision_traces (execution_target, correlation_id, seq);
