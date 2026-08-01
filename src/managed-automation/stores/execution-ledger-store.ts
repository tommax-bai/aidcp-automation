import type { ExecutionTarget } from '../contracts/common.js';
import type {
  ExecutionAttempt,
  ExecutionAttemptStatus,
  ExecutionIntent,
  ReadEvidence,
} from '../contracts/execution-attempt.js';
import type { CapabilityId } from '../contracts/capability.js';
import type { ReasonCode } from '../contracts/reason-codes.js';
import { canTransitionAttemptStatus, isTerminalAttemptStatus } from '../contracts/validation.js';
import {
  assertCallTarget,
  ManagedTaskInvariantError,
  ManagedTaskStoreBase,
  toEpochMillis,
  toNullableEpochMillis,
  type ManagedTaskSchemaRequirement,
  type ManagedTaskStoreOptions,
} from './store-base.js';

const REQUIREMENT: ManagedTaskSchemaRequirement = {
  capability: 'managed_task_execution_ledger',
  sinceVersion: '0108_managed_task_execution_ledger',
  tables: new Map([
    ['execution_intents', new Set([
      'intent_id', 'execution_target', 'run_id', 'step_run_id', 'account_id', 'capability_id',
      'capability_version', 'input_ref', 'idempotency_key', 'correlation_id', 'created_at',
    ])],
    ['execution_attempts', new Set([
      'attempt_id', 'execution_target', 'intent_id', 'run_id', 'step_run_id', 'ordinal',
      'status', 'reason_code', 'evidence', 'strongest_progress_evidence_ref',
      'reconciliation_count', 'prepared_at', 'dispatched_at', 'settled_at',
    ])],
  ]),
  indexes: new Map([
    ['uq_execution_intents_target_idempotency', 'execution_intents'],
    ['idx_execution_intents_target_run', 'execution_intents'],
    ['uq_execution_attempts_target_intent_ordinal', 'execution_attempts'],
    ['idx_execution_attempts_target_status', 'execution_attempts'],
    ['idx_execution_attempts_target_run', 'execution_attempts'],
  ]),
};

interface IntentRow {
  intent_id: string;
  execution_target: ExecutionTarget;
  run_id: string;
  step_run_id: string;
  account_id: string;
  capability_id: CapabilityId;
  capability_version: number | string;
  input_ref: string;
  idempotency_key: string;
  correlation_id: string;
  created_at: Date | string;
}

interface AttemptRow {
  attempt_id: string;
  execution_target: ExecutionTarget;
  intent_id: string;
  run_id: string;
  step_run_id: string;
  ordinal: number | string;
  status: ExecutionAttemptStatus;
  reason_code: ReasonCode | null;
  evidence: ReadEvidence | null;
  strongest_progress_evidence_ref: string | null;
  reconciliation_count: number | string;
  prepared_at: Date | string;
  dispatched_at: Date | string | null;
  settled_at: Date | string | null;
}

const INTENT_COLUMNS = `intent_id, execution_target, run_id, step_run_id, account_id,
  capability_id, capability_version, input_ref, idempotency_key, correlation_id, created_at`;
const ATTEMPT_COLUMNS = `attempt_id, execution_target, intent_id, run_id, step_run_id,
  ordinal, status, reason_code, evidence, strongest_progress_evidence_ref,
  reconciliation_count, prepared_at, dispatched_at, settled_at`;

function intentFromRow(row: IntentRow): ExecutionIntent {
  return {
    intentId: row.intent_id,
    executionTarget: row.execution_target,
    runId: row.run_id,
    stepRunId: row.step_run_id,
    accountId: row.account_id,
    capabilityId: row.capability_id,
    capabilityVersion: Number(row.capability_version),
    inputRef: row.input_ref,
    idempotencyKey: row.idempotency_key,
    correlationId: row.correlation_id,
    createdAt: toEpochMillis(row.created_at),
  };
}

function attemptFromRow(row: AttemptRow): ExecutionAttempt {
  return {
    attemptId: row.attempt_id,
    executionTarget: row.execution_target,
    intentId: row.intent_id,
    runId: row.run_id,
    stepRunId: row.step_run_id,
    ordinal: Number(row.ordinal),
    status: row.status,
    reasonCode: row.reason_code,
    evidence: row.evidence,
    strongestProgressEvidenceRef: row.strongest_progress_evidence_ref,
    reconciliationCount: Number(row.reconciliation_count),
    preparedAt: toEpochMillis(row.prepared_at),
    dispatchedAt: toNullableEpochMillis(row.dispatched_at),
    settledAt: toNullableEpochMillis(row.settled_at),
  };
}

export type ExecutionIntentInsert = Omit<ExecutionIntent, 'createdAt'>;
export interface ExecutionAttemptInsert {
  attemptId: string;
  intentId: string;
  runId: string;
  stepRunId: string;
  ordinal: number;
}

export type IntentInsertResult =
  | { outcome: 'inserted'; intent: ExecutionIntent }
  | { outcome: 'duplicate'; intent: ExecutionIntent }
  | { outcome: 'collision' };

export interface AttemptTransition {
  status: ExecutionAttemptStatus;
  reasonCode: ReasonCode | null;
  evidence: ReadEvidence | null;
  strongestProgressEvidenceRef: string | null;
  dispatchedAt: number | null;
  settledAt: number | null;
}

function sameIntent(left: ExecutionIntent, right: ExecutionIntentInsert): boolean {
  return left.intentId === right.intentId
    && left.runId === right.runId
    && left.stepRunId === right.stepRunId
    && left.accountId === right.accountId
    && left.capabilityId === right.capabilityId
    && left.capabilityVersion === right.capabilityVersion
    && left.inputRef === right.inputRef
    && left.idempotencyKey === right.idempotencyKey
    && left.correlationId === right.correlationId;
}

function assertAttemptTransition(expected: ExecutionAttemptStatus, next: AttemptTransition): void {
  if (!canTransitionAttemptStatus(expected, next.status)) {
    throw new ManagedTaskInvariantError(`attempt status cannot transition from ${expected} to ${next.status}`);
  }
  if (isTerminalAttemptStatus(expected)) {
    throw new ManagedTaskInvariantError('terminal execution attempt is immutable');
  }
  if ((next.status === 'dispatching' || next.status === 'submitted_unknown') && next.dispatchedAt === null) {
    throw new ManagedTaskInvariantError(`${next.status} requires dispatchedAt`);
  }
  if (isTerminalAttemptStatus(next.status) !== (next.settledAt !== null)) {
    throw new ManagedTaskInvariantError('terminal attempt status and settledAt must agree');
  }
  if ((next.status === 'completed' || next.status === 'empty') && next.evidence === null) {
    throw new ManagedTaskInvariantError(`${next.status} requires read evidence`);
  }
  if (next.strongestProgressEvidenceRef !== null && next.evidence === null) {
    throw new ManagedTaskInvariantError('strongest progress evidence requires evidence');
  }
}

export class ExecutionLedgerStore extends ManagedTaskStoreBase {
  constructor(options: ManagedTaskStoreOptions) {
    super(REQUIREMENT, options);
  }

  async insertIntent(target: ExecutionTarget, input: ExecutionIntentInsert): Promise<IntentInsertResult> {
    assertCallTarget(target, input.executionTarget);
    const inserted = await this.pool.query<IntentRow>(
      `INSERT INTO execution_intents
         (intent_id, execution_target, run_id, step_run_id, account_id, capability_id,
          capability_version, input_ref, idempotency_key, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT DO NOTHING
       RETURNING ${INTENT_COLUMNS}`,
      [input.intentId, target, input.runId, input.stepRunId, input.accountId,
        input.capabilityId, input.capabilityVersion, input.inputRef, input.idempotencyKey,
        input.correlationId],
    );
    if (inserted.rows[0]) return { outcome: 'inserted', intent: intentFromRow(inserted.rows[0]) };
    const existing = await this.getIntentByIdempotencyKey(target, input.idempotencyKey);
    if (!existing || !sameIntent(existing, input)) return { outcome: 'collision' };
    return { outcome: 'duplicate', intent: existing };
  }

  async getIntent(target: ExecutionTarget, intentId: string): Promise<ExecutionIntent | null> {
    const result = await this.pool.query<IntentRow>(
      `SELECT ${INTENT_COLUMNS} FROM execution_intents
        WHERE execution_target=$1 AND intent_id=$2`,
      [target, intentId],
    );
    return result.rows[0] ? intentFromRow(result.rows[0]) : null;
  }

  async getIntentByIdempotencyKey(
    target: ExecutionTarget,
    idempotencyKey: string,
  ): Promise<ExecutionIntent | null> {
    const result = await this.pool.query<IntentRow>(
      `SELECT ${INTENT_COLUMNS} FROM execution_intents
        WHERE execution_target=$1 AND idempotency_key=$2`,
      [target, idempotencyKey],
    );
    return result.rows[0] ? intentFromRow(result.rows[0]) : null;
  }

  async insertAttempt(target: ExecutionTarget, input: ExecutionAttemptInsert): Promise<boolean> {
    if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 1) {
      throw new ManagedTaskInvariantError('attempt ordinal must be a positive integer');
    }
    const result = await this.pool.query(
      `INSERT INTO execution_attempts
         (attempt_id, execution_target, intent_id, run_id, step_run_id, ordinal, status)
       VALUES ($1,$2,$3,$4,$5,$6,'prepared')
       ON CONFLICT DO NOTHING`,
      [input.attemptId, target, input.intentId, input.runId, input.stepRunId, input.ordinal],
    );
    return result.rowCount === 1;
  }

  async getAttempt(target: ExecutionTarget, attemptId: string): Promise<ExecutionAttempt | null> {
    const result = await this.pool.query<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM execution_attempts
        WHERE execution_target=$1 AND attempt_id=$2`,
      [target, attemptId],
    );
    return result.rows[0] ? attemptFromRow(result.rows[0]) : null;
  }

  async listAttemptsByIntent(target: ExecutionTarget, intentId: string): Promise<ExecutionAttempt[]> {
    const result = await this.pool.query<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM execution_attempts
        WHERE execution_target=$1 AND intent_id=$2
        ORDER BY ordinal ASC`,
      [target, intentId],
    );
    return result.rows.map(attemptFromRow);
  }

  async listAttemptsByRun(target: ExecutionTarget, runId: string): Promise<ExecutionAttempt[]> {
    const result = await this.pool.query<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM execution_attempts
        WHERE execution_target=$1 AND run_id=$2
        ORDER BY prepared_at ASC, ordinal ASC`,
      [target, runId],
    );
    return result.rows.map(attemptFromRow);
  }

  async transitionAttempt(
    target: ExecutionTarget,
    attemptId: string,
    expectedStatus: Exclude<ExecutionAttemptStatus, 'submitted_unknown'>,
    next: AttemptTransition,
  ): Promise<boolean> {
    assertAttemptTransition(expectedStatus, next);
    return this.applyTransition(target, attemptId, expectedStatus, next, false);
  }

  async reconcileSubmittedUnknown(
    target: ExecutionTarget,
    attemptId: string,
    next: AttemptTransition,
  ): Promise<boolean> {
    assertAttemptTransition('submitted_unknown', next);
    if (!isTerminalAttemptStatus(next.status)) {
      throw new ManagedTaskInvariantError('submitted_unknown reconciliation must settle terminally');
    }
    return this.applyTransition(target, attemptId, 'submitted_unknown', next, true);
  }

  private async applyTransition(
    target: ExecutionTarget,
    attemptId: string,
    expectedStatus: ExecutionAttemptStatus,
    next: AttemptTransition,
    incrementReconciliation: boolean,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE execution_attempts
          SET status=$1, reason_code=$2, evidence=$3,
              strongest_progress_evidence_ref=$4, dispatched_at=$5, settled_at=$6,
              reconciliation_count=reconciliation_count+$7
        WHERE execution_target=$8 AND attempt_id=$9 AND status=$10`,
      [next.status, next.reasonCode, next.evidence === null ? null : JSON.stringify(next.evidence),
        next.strongestProgressEvidenceRef,
        next.dispatchedAt === null ? null : new Date(next.dispatchedAt),
        next.settledAt === null ? null : new Date(next.settledAt),
        incrementReconciliation ? 1 : 0, target, attemptId, expectedStatus],
    );
    return result.rowCount === 1;
  }
}
