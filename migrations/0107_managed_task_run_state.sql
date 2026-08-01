-- aidcp:kind=expand
-- aidcp:objects=table:task_runs,table:step_runs,table:managed_account_work_lanes
-- aidcp:objects=index:idx_task_runs_target_status,index:idx_task_runs_target_account,index:uq_task_runs_target_idempotency
-- aidcp:objects=index:idx_task_runs_target_lease,index:uq_step_runs_target_run_node,index:idx_step_runs_target_run
-- aidcp:objects=index:idx_managed_account_lanes_target_lease
CREATE TABLE IF NOT EXISTS task_runs (
  run_id UUID PRIMARY KEY,
  execution_target TEXT NOT NULL CHECK (execution_target IN ('dev','ol')),
  task_id UUID NOT NULL,
  task_revision_id UUID NOT NULL,
  execution_plan_id UUID NOT NULL,
  account_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','waiting','running','cancel_requested','terminal')),
  wait_reason TEXT CHECK (wait_reason IN ('waiting_for_account_lane','waiting_for_edge','waiting_for_reconciliation','waiting_until')),
  terminal_outcome TEXT CHECK (terminal_outcome IN ('succeeded','partially_succeeded','skipped','failed','cancelled','attention_required')),
  reason_code TEXT,
  confirmed_units INTEGER NOT NULL DEFAULT 0 CHECK (confirmed_units >= 0),
  target_units INTEGER CHECK (target_units IS NULL OR target_units >= 0),
  last_checkpoint_ref TEXT,
  current_node_id TEXT,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  terminal_at TIMESTAMPTZ,
  CONSTRAINT task_runs_wait_reason_iff_waiting CHECK ((wait_reason IS NOT NULL) = (status = 'waiting')),
  CONSTRAINT task_runs_terminal_outcome_iff_terminal CHECK ((terminal_outcome IS NOT NULL) = (status = 'terminal')),
  CONSTRAINT task_runs_lease_pair CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_task_runs_target_status ON task_runs (execution_target, status, created_at);
CREATE INDEX IF NOT EXISTS idx_task_runs_target_account ON task_runs (execution_target, account_id, status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_runs_target_idempotency ON task_runs (execution_target, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_task_runs_target_lease
  ON task_runs (execution_target, lease_expires_at) WHERE lease_expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS step_runs (
  step_run_id UUID PRIMARY KEY,
  execution_target TEXT NOT NULL CHECK (execution_target IN ('dev','ol')),
  run_id UUID NOT NULL,
  node_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  capability_version INTEGER NOT NULL CHECK (capability_version >= 1),
  status TEXT NOT NULL CHECK (status IN ('queued','waiting','running','cancel_requested','terminal')),
  wait_reason TEXT CHECK (wait_reason IN ('waiting_for_account_lane','waiting_for_edge','waiting_for_reconciliation','waiting_until')),
  terminal_outcome TEXT CHECK (terminal_outcome IN ('succeeded','partially_succeeded','skipped','failed','cancelled','attention_required')),
  reason_code TEXT,
  confirmed_units INTEGER NOT NULL DEFAULT 0 CHECK (confirmed_units >= 0),
  target_units INTEGER CHECK (target_units IS NULL OR target_units >= 0),
  last_checkpoint_ref TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  started_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  terminal_at TIMESTAMPTZ,
  CONSTRAINT step_runs_wait_reason_iff_waiting CHECK ((wait_reason IS NOT NULL) = (status = 'waiting')),
  CONSTRAINT step_runs_terminal_outcome_iff_terminal CHECK ((terminal_outcome IS NOT NULL) = (status = 'terminal'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_step_runs_target_run_node ON step_runs (execution_target, run_id, node_id);
CREATE INDEX IF NOT EXISTS idx_step_runs_target_run ON step_runs (execution_target, run_id, updated_at);

CREATE TABLE IF NOT EXISTS managed_account_work_lanes (
  execution_target TEXT NOT NULL CHECK (execution_target IN ('dev','ol')),
  account_id TEXT NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('legacy','managed')),
  managed_run_id UUID,
  lease_owner TEXT NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  in_flight_evidence JSONB NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (execution_target, account_id),
  CONSTRAINT managed_lane_run_iff_managed CHECK ((managed_run_id IS NOT NULL) = (owner_kind = 'managed'))
);
CREATE INDEX IF NOT EXISTS idx_managed_account_lanes_target_lease
  ON managed_account_work_lanes (execution_target, lease_expires_at);
