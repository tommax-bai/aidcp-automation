import type { ExecutionTarget } from '../contracts/common.js';
import type { ReasonCode, WaitReasonCode } from '../contracts/reason-codes.js';
import type {
  OrthogonalRunState,
  RunProgress,
  RunStatus,
  RunTerminalOutcome,
  StepRun,
  TaskRun,
} from '../contracts/task-run.js';
import { canTransitionRunStatus, isOrthogonalRunStateValid } from '../contracts/validation.js';
import type { CapabilityId } from '../contracts/capability.js';
import {
  ManagedTaskInvariantError,
  ManagedTaskStoreBase,
  toEpochMillis,
  toNullableEpochMillis,
  type ManagedTaskSchemaRequirement,
  type ManagedTaskStoreOptions,
} from './store-base.js';

const REQUIREMENT: ManagedTaskSchemaRequirement = {
  capability: 'managed_task_run_state',
  sinceVersion: '0107_managed_task_run_state',
  tables: new Map([
    ['task_runs', new Set([
      'run_id', 'execution_target', 'task_id', 'task_revision_id', 'execution_plan_id',
      'account_id', 'idempotency_key', 'status', 'wait_reason', 'terminal_outcome',
      'reason_code', 'confirmed_units', 'target_units', 'last_checkpoint_ref',
      'current_node_id', 'lease_owner', 'lease_expires_at', 'attempt_count', 'version',
      'created_at', 'updated_at', 'terminal_at',
    ])],
    ['step_runs', new Set([
      'step_run_id', 'execution_target', 'run_id', 'node_id', 'capability_id',
      'capability_version', 'status', 'wait_reason', 'terminal_outcome', 'reason_code',
      'confirmed_units', 'target_units', 'last_checkpoint_ref', 'attempt_count', 'version',
      'started_at', 'updated_at', 'terminal_at',
    ])],
  ]),
  indexes: new Map([
    ['idx_task_runs_target_status', 'task_runs'],
    ['idx_task_runs_target_account', 'task_runs'],
    ['uq_task_runs_target_idempotency', 'task_runs'],
    ['idx_task_runs_target_lease', 'task_runs'],
    ['uq_step_runs_target_run_node', 'step_runs'],
    ['idx_step_runs_target_run', 'step_runs'],
  ]),
};

interface RunRow {
  run_id: string;
  execution_target: ExecutionTarget;
  task_id: string;
  task_revision_id: string;
  execution_plan_id: string;
  account_id: string;
  status: RunStatus;
  wait_reason: WaitReasonCode | null;
  terminal_outcome: RunTerminalOutcome | null;
  reason_code: ReasonCode | null;
  confirmed_units: number | string;
  target_units: number | string | null;
  last_checkpoint_ref: string | null;
  current_node_id: string | null;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  attempt_count: number | string;
  version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
  terminal_at: Date | string | null;
}

interface StepRow {
  step_run_id: string;
  execution_target: ExecutionTarget;
  run_id: string;
  node_id: string;
  capability_id: CapabilityId;
  capability_version: number | string;
  status: RunStatus;
  wait_reason: WaitReasonCode | null;
  terminal_outcome: RunTerminalOutcome | null;
  reason_code: ReasonCode | null;
  confirmed_units: number | string;
  target_units: number | string | null;
  last_checkpoint_ref: string | null;
  attempt_count: number | string;
  version: number | string;
  started_at: Date | string | null;
  updated_at: Date | string;
  terminal_at: Date | string | null;
}

const RUN_COLUMNS = `run_id, execution_target, task_id, task_revision_id, execution_plan_id,
  account_id, status, wait_reason, terminal_outcome, reason_code, confirmed_units, target_units,
  last_checkpoint_ref, current_node_id, lease_owner, lease_expires_at, attempt_count, version,
  created_at, updated_at, terminal_at`;
const STEP_COLUMNS = `step_run_id, execution_target, run_id, node_id, capability_id,
  capability_version, status, wait_reason, terminal_outcome, reason_code, confirmed_units,
  target_units, last_checkpoint_ref, attempt_count, version, started_at, updated_at, terminal_at`;

function stateFromRow(row: Pick<RunRow, 'status' | 'wait_reason' | 'terminal_outcome' | 'reason_code'>): OrthogonalRunState {
  return {
    status: row.status,
    waitReason: row.wait_reason,
    terminalOutcome: row.terminal_outcome,
    reasonCode: row.reason_code,
  };
}

function progressFromRow(row: Pick<RunRow, 'confirmed_units' | 'target_units' | 'last_checkpoint_ref'>): RunProgress {
  return {
    confirmedUnits: Number(row.confirmed_units),
    targetUnits: row.target_units === null ? null : Number(row.target_units),
    lastCheckpointRef: row.last_checkpoint_ref,
  };
}

function runFromRow(row: RunRow): TaskRun {
  return {
    runId: row.run_id,
    executionTarget: row.execution_target,
    taskId: row.task_id,
    taskRevisionId: row.task_revision_id,
    executionPlanId: row.execution_plan_id,
    accountId: row.account_id,
    state: stateFromRow(row),
    progress: progressFromRow(row),
    currentNodeId: row.current_node_id,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: toNullableEpochMillis(row.lease_expires_at),
    attemptCount: Number(row.attempt_count),
    version: Number(row.version),
    createdAt: toEpochMillis(row.created_at),
    updatedAt: toEpochMillis(row.updated_at),
    terminalAt: toNullableEpochMillis(row.terminal_at),
  };
}

function stepFromRow(row: StepRow): StepRun {
  return {
    stepRunId: row.step_run_id,
    executionTarget: row.execution_target,
    runId: row.run_id,
    nodeId: row.node_id,
    capabilityId: row.capability_id,
    capabilityVersion: Number(row.capability_version),
    state: stateFromRow(row),
    progress: progressFromRow(row),
    attemptCount: Number(row.attempt_count),
    version: Number(row.version),
    startedAt: toNullableEpochMillis(row.started_at),
    updatedAt: toEpochMillis(row.updated_at),
    terminalAt: toNullableEpochMillis(row.terminal_at),
  };
}

export interface TaskRunInsert {
  runId: string;
  taskId: string;
  taskRevisionId: string;
  executionPlanId: string;
  accountId: string;
  idempotencyKey: string;
  targetUnits: number | null;
}

export interface StepRunInsert {
  stepRunId: string;
  runId: string;
  nodeId: string;
  capabilityId: CapabilityId;
  capabilityVersion: number;
  targetUnits: number | null;
}

export interface RunTransition {
  state: OrthogonalRunState;
  progress: RunProgress;
  currentNodeId: string | null;
  incrementAttemptCount?: boolean;
}

function assertTransition(from: RunStatus, next: RunTransition): void {
  if (!isOrthogonalRunStateValid(next.state)) {
    throw new ManagedTaskInvariantError('orthogonal run state is invalid');
  }
  if (!canTransitionRunStatus(from, next.state.status)) {
    throw new ManagedTaskInvariantError(`run status cannot regress from ${from} to ${next.state.status}`);
  }
  if (from === 'terminal') {
    throw new ManagedTaskInvariantError('terminal run state is immutable');
  }
  if (next.progress.confirmedUnits < 0 || (next.progress.targetUnits !== null && next.progress.targetUnits < 0)) {
    throw new ManagedTaskInvariantError('run progress cannot be negative');
  }
}

export class RunStateStore extends ManagedTaskStoreBase {
  constructor(options: ManagedTaskStoreOptions) {
    super(REQUIREMENT, options);
  }

  async insertRun(target: ExecutionTarget, input: TaskRunInsert): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO task_runs
         (run_id, execution_target, task_id, task_revision_id, execution_plan_id, account_id,
          idempotency_key, status, target_units)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8)
       ON CONFLICT DO NOTHING`,
      [input.runId, target, input.taskId, input.taskRevisionId, input.executionPlanId,
        input.accountId, input.idempotencyKey, input.targetUnits],
    );
    return result.rowCount === 1;
  }

  async getRun(target: ExecutionTarget, runId: string): Promise<TaskRun | null> {
    const result = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM task_runs WHERE execution_target=$1 AND run_id=$2`,
      [target, runId],
    );
    return result.rows[0] ? runFromRow(result.rows[0]) : null;
  }

  async getLatestRunForTask(target: ExecutionTarget, taskId: string): Promise<TaskRun | null> {
    const result = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM task_runs
        WHERE execution_target=$1 AND task_id=$2
        ORDER BY created_at DESC LIMIT 1`,
      [target, taskId],
    );
    return result.rows[0] ? runFromRow(result.rows[0]) : null;
  }

  async claimNextRun(
    target: ExecutionTarget,
    workerId: string,
    leaseMs: number,
    now = Date.now(),
  ): Promise<TaskRun | null> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
      throw new ManagedTaskInvariantError('leaseMs must be a positive integer');
    }
    const result = await this.pool.query<RunRow>(
      `UPDATE task_runs
          SET status='running', wait_reason=NULL, reason_code=NULL,
              lease_owner=$1, lease_expires_at=$2, version=version+1, updated_at=$3
        WHERE run_id=(
          SELECT run_id FROM task_runs
           WHERE execution_target=$4
             AND status IN ('queued','waiting')
             AND (lease_expires_at IS NULL OR lease_expires_at <= $3)
           ORDER BY created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        ) AND execution_target=$4
        RETURNING ${RUN_COLUMNS}`,
      [workerId, new Date(now + leaseMs), new Date(now), target],
    );
    return result.rows[0] ? runFromRow(result.rows[0]) : null;
  }

  async renewRunLease(
    target: ExecutionTarget,
    runId: string,
    workerId: string,
    expectedVersion: number,
    leaseMs: number,
    now = Date.now(),
  ): Promise<boolean> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
      throw new ManagedTaskInvariantError('leaseMs must be a positive integer');
    }
    const result = await this.pool.query(
      `UPDATE task_runs
          SET lease_expires_at=$1, version=version+1, updated_at=$2
        WHERE execution_target=$3 AND run_id=$4 AND lease_owner=$5 AND version=$6
          AND status <> 'terminal' AND lease_expires_at > $2`,
      [new Date(now + leaseMs), new Date(now), target, runId, workerId, expectedVersion],
    );
    return result.rowCount === 1;
  }

  async transitionRun(
    target: ExecutionTarget,
    runId: string,
    expectedVersion: number,
    expectedStatus: RunStatus,
    next: RunTransition,
  ): Promise<boolean> {
    assertTransition(expectedStatus, next);
    const terminalAt = next.state.status === 'terminal' ? new Date() : null;
    const result = await this.pool.query(
      `UPDATE task_runs
          SET status=$1, wait_reason=$2, terminal_outcome=$3, reason_code=$4,
              confirmed_units=$5, target_units=$6, last_checkpoint_ref=$7,
              current_node_id=$8, attempt_count=attempt_count+$9,
              lease_owner=CASE WHEN $1='terminal' THEN NULL ELSE lease_owner END,
              lease_expires_at=CASE WHEN $1='terminal' THEN NULL ELSE lease_expires_at END,
              terminal_at=$10, version=version+1, updated_at=now()
        WHERE execution_target=$11 AND run_id=$12 AND version=$13 AND status=$14
          AND confirmed_units <= $5`,
      [next.state.status, next.state.waitReason, next.state.terminalOutcome, next.state.reasonCode,
        next.progress.confirmedUnits, next.progress.targetUnits, next.progress.lastCheckpointRef,
        next.currentNodeId, next.incrementAttemptCount === true ? 1 : 0, terminalAt,
        target, runId, expectedVersion, expectedStatus],
    );
    return result.rowCount === 1;
  }

  async insertStep(target: ExecutionTarget, input: StepRunInsert): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO step_runs
         (step_run_id, execution_target, run_id, node_id, capability_id, capability_version,
          status, target_units)
       VALUES ($1,$2,$3,$4,$5,$6,'queued',$7)
       ON CONFLICT DO NOTHING`,
      [input.stepRunId, target, input.runId, input.nodeId, input.capabilityId,
        input.capabilityVersion, input.targetUnits],
    );
    return result.rowCount === 1;
  }

  async getStep(target: ExecutionTarget, stepRunId: string): Promise<StepRun | null> {
    const result = await this.pool.query<StepRow>(
      `SELECT ${STEP_COLUMNS} FROM step_runs WHERE execution_target=$1 AND step_run_id=$2`,
      [target, stepRunId],
    );
    return result.rows[0] ? stepFromRow(result.rows[0]) : null;
  }

  async transitionStep(
    target: ExecutionTarget,
    stepRunId: string,
    expectedVersion: number,
    expectedStatus: RunStatus,
    next: Omit<RunTransition, 'currentNodeId'>,
  ): Promise<boolean> {
    assertTransition(expectedStatus, { ...next, currentNodeId: null });
    const startedAt = next.state.status === 'running' ? new Date() : null;
    const terminalAt = next.state.status === 'terminal' ? new Date() : null;
    const result = await this.pool.query(
      `UPDATE step_runs
          SET status=$1, wait_reason=$2, terminal_outcome=$3, reason_code=$4,
              confirmed_units=$5, target_units=$6, last_checkpoint_ref=$7,
              attempt_count=attempt_count+$8,
              started_at=COALESCE(started_at,$9), terminal_at=$10,
              version=version+1, updated_at=now()
        WHERE execution_target=$11 AND step_run_id=$12 AND version=$13 AND status=$14
          AND confirmed_units <= $5`,
      [next.state.status, next.state.waitReason, next.state.terminalOutcome, next.state.reasonCode,
        next.progress.confirmedUnits, next.progress.targetUnits, next.progress.lastCheckpointRef,
        next.incrementAttemptCount === true ? 1 : 0, startedAt, terminalAt,
        target, stepRunId, expectedVersion, expectedStatus],
    );
    return result.rowCount === 1;
  }
}
