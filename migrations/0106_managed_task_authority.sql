-- aidcp:kind=expand
-- aidcp:objects=table:tasks,table:task_revisions,table:execution_plans,table:managed_task_command_receipts
-- aidcp:objects=index:idx_tasks_target_status,index:idx_tasks_target_account,index:uq_task_revisions_target_task_ordinal
-- aidcp:objects=index:uq_execution_plans_target_revision,index:idx_execution_plans_target_task,index:idx_managed_task_receipts_target_task
-- Phase-one task authority. Automation is the sole writer; no cross-owner foreign keys.
CREATE TABLE IF NOT EXISTS tasks (
  task_id UUID PRIMARY KEY,
  execution_target TEXT NOT NULL CHECK (execution_target IN ('dev','ol')),
  account_id TEXT NOT NULL,
  env_key TEXT NOT NULL,
  platform TEXT NOT NULL,
  task_definition_id TEXT NOT NULL,
  task_definition_version INTEGER NOT NULL CHECK (task_definition_version >= 1),
  current_revision_id UUID NOT NULL,
  capability_scope JSONB NOT NULL,
  constraints JSONB NOT NULL DEFAULT '{}',
  budget JSONB NOT NULL,
  schedule JSONB NOT NULL,
  authorization_revision TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','cancelled','completed')),
  correlation_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL DEFAULT 1 CHECK (aggregate_version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_target_status ON tasks (execution_target, status, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_target_account ON tasks (execution_target, account_id, status, created_at);

CREATE TABLE IF NOT EXISTS task_revisions (
  revision_id UUID PRIMARY KEY,
  execution_target TEXT NOT NULL CHECK (execution_target IN ('dev','ol')),
  task_id UUID NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  cause TEXT NOT NULL CHECK (cause IN ('create','revise','cancel')),
  capability_scope JSONB NOT NULL,
  constraints JSONB NOT NULL DEFAULT '{}',
  budget JSONB NOT NULL,
  schedule JSONB NOT NULL,
  authorization_revision TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  supersedes_revision_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_revisions_target_task_ordinal
  ON task_revisions (execution_target, task_id, ordinal);

CREATE TABLE IF NOT EXISTS execution_plans (
  execution_plan_id UUID PRIMARY KEY,
  execution_target TEXT NOT NULL CHECK (execution_target IN ('dev','ol')),
  task_id UUID NOT NULL,
  task_revision_id UUID NOT NULL,
  task_definition_id TEXT NOT NULL,
  task_definition_version INTEGER NOT NULL CHECK (task_definition_version >= 1),
  authorization_revision TEXT NOT NULL,
  nodes JSONB NOT NULL,
  edges JSONB NOT NULL,
  entry_node_id TEXT NOT NULL,
  bounds JSONB NOT NULL,
  completion_condition_ref TEXT NOT NULL,
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64),
  compiled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_execution_plans_target_revision
  ON execution_plans (execution_target, task_revision_id);
CREATE INDEX IF NOT EXISTS idx_execution_plans_target_task
  ON execution_plans (execution_target, task_id, compiled_at);

CREATE TABLE IF NOT EXISTS managed_task_command_receipts (
  execution_target TEXT NOT NULL CHECK (execution_target IN ('dev','ol')),
  command_id TEXT NOT NULL,
  command_kind TEXT NOT NULL CHECK (command_kind IN ('create','cancel')),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  task_id UUID,
  run_id UUID,
  receipt JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (execution_target, command_id)
);
CREATE INDEX IF NOT EXISTS idx_managed_task_receipts_target_task
  ON managed_task_command_receipts (execution_target, task_id, created_at) WHERE task_id IS NOT NULL;
