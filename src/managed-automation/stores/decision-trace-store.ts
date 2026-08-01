import type { ExecutionTarget } from '../contracts/common.js';
import type {
  DecisionOutcome,
  DecisionTrace,
  DecisionType,
} from '../contracts/decision-trace.js';
import type { ReasonCode } from '../contracts/reason-codes.js';
import {
  assertCallTarget,
  ManagedTaskInvariantError,
  ManagedTaskStoreBase,
  toEpochMillis,
  type ManagedTaskSchemaRequirement,
  type ManagedTaskStoreOptions,
} from './store-base.js';

const REQUIREMENT: ManagedTaskSchemaRequirement = {
  capability: 'managed_task_decision_trace',
  sinceVersion: '0109_managed_task_decision_traces',
  tables: new Map([
    ['decision_traces', new Set([
      'trace_id', 'execution_target', 'seq', 'correlation_id', 'causation_id', 'task_id',
      'run_id', 'step_run_id', 'attempt_id', 'decision_type', 'outcome', 'reason_code',
      'input_refs', 'evidence_refs', 'created_at',
    ])],
  ]),
  indexes: new Map([
    ['idx_decision_traces_target_task', 'decision_traces'],
    ['idx_decision_traces_target_run', 'decision_traces'],
    ['idx_decision_traces_target_step', 'decision_traces'],
    ['idx_decision_traces_target_attempt', 'decision_traces'],
    ['idx_decision_traces_target_correlation', 'decision_traces'],
  ]),
};

interface TraceRow {
  trace_id: string;
  execution_target: ExecutionTarget;
  correlation_id: string;
  causation_id: string | null;
  task_id: string | null;
  run_id: string | null;
  step_run_id: string | null;
  attempt_id: string | null;
  decision_type: DecisionType;
  outcome: DecisionOutcome;
  reason_code: ReasonCode;
  input_refs: string[];
  evidence_refs: string[];
  created_at: Date | string;
}

const TRACE_COLUMNS = `trace_id, execution_target, correlation_id, causation_id, task_id,
  run_id, step_run_id, attempt_id, decision_type, outcome, reason_code, input_refs,
  evidence_refs, created_at`;

function traceFromRow(row: TraceRow): DecisionTrace {
  return {
    traceId: row.trace_id,
    executionTarget: row.execution_target,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    taskId: row.task_id,
    runId: row.run_id,
    stepRunId: row.step_run_id,
    attemptId: row.attempt_id,
    decisionType: row.decision_type,
    outcome: row.outcome,
    reasonCode: row.reason_code,
    inputRefs: row.input_refs,
    evidenceRefs: row.evidence_refs,
    createdAt: toEpochMillis(row.created_at),
  };
}

export type DecisionTraceInsert = Omit<DecisionTrace, 'createdAt'>;

export class DecisionTraceStore extends ManagedTaskStoreBase {
  constructor(options: ManagedTaskStoreOptions) {
    super(REQUIREMENT, options);
  }

  async append(target: ExecutionTarget, trace: DecisionTraceInsert): Promise<boolean> {
    assertCallTarget(target, trace.executionTarget);
    const result = await this.pool.query(
      `INSERT INTO decision_traces
         (trace_id, execution_target, correlation_id, causation_id, task_id, run_id,
          step_run_id, attempt_id, decision_type, outcome, reason_code, input_refs, evidence_refs)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT DO NOTHING`,
      [trace.traceId, target, trace.correlationId, trace.causationId, trace.taskId, trace.runId,
        trace.stepRunId, trace.attemptId, trace.decisionType, trace.outcome, trace.reasonCode,
        JSON.stringify(trace.inputRefs), JSON.stringify(trace.evidenceRefs)],
    );
    return result.rowCount === 1;
  }

  async listByTask(target: ExecutionTarget, taskId: string, limit = 200): Promise<DecisionTrace[]> {
    return this.list(target, 'task_id', taskId, limit);
  }

  async listByRun(target: ExecutionTarget, runId: string, limit = 200): Promise<DecisionTrace[]> {
    return this.list(target, 'run_id', runId, limit);
  }

  async listByStep(target: ExecutionTarget, stepRunId: string, limit = 200): Promise<DecisionTrace[]> {
    return this.list(target, 'step_run_id', stepRunId, limit);
  }

  async listByAttempt(target: ExecutionTarget, attemptId: string, limit = 200): Promise<DecisionTrace[]> {
    return this.list(target, 'attempt_id', attemptId, limit);
  }

  async listByCorrelation(
    target: ExecutionTarget,
    correlationId: string,
    limit = 200,
  ): Promise<DecisionTrace[]> {
    return this.list(target, 'correlation_id', correlationId, limit);
  }

  private async list(
    target: ExecutionTarget,
    column: 'task_id' | 'run_id' | 'step_run_id' | 'attempt_id' | 'correlation_id',
    value: string,
    limit: number,
  ): Promise<DecisionTrace[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new ManagedTaskInvariantError('decision trace limit must be between 1 and 1000');
    }
    const result = await this.pool.query<TraceRow>(
      `SELECT ${TRACE_COLUMNS} FROM decision_traces
        WHERE execution_target=$1 AND ${column}=$2
        ORDER BY seq ASC LIMIT $3`,
      [target, value, limit],
    );
    return result.rows.map(traceFromRow);
  }
}
