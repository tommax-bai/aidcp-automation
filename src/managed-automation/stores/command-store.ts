import type pg from 'pg';
import type {
  CancelManagedTaskResult,
  CreateManagedTaskResult,
  ManagedTaskAppliedReceipt,
} from 'aidcp-kernel/kernel/managed-task-port.js';
import type { ExecutionPlan } from '../contracts/execution-plan.js';
import type { DecisionTrace } from '../contracts/decision-trace.js';
import type { ExecutionTarget } from '../contracts/common.js';
import type { Task, TaskRevision } from '../contracts/task.js';
import {
  ManagedTaskInvariantError,
  ManagedTaskStoreBase,
  type ManagedTaskSchemaRequirement,
  type ManagedTaskStoreOptions,
} from './store-base.js';

const REQUIREMENT: ManagedTaskSchemaRequirement = {
  capability: 'managed_task_commands',
  sinceVersion: '0109_managed_task_decision_traces',
  tables: new Map([
    ['tasks', new Set([
      'task_id', 'execution_target', 'account_id', 'env_key', 'platform', 'task_definition_id',
      'task_definition_version', 'current_revision_id', 'capability_scope', 'constraints',
      'budget', 'schedule', 'authorization_revision', 'actor_ref', 'status', 'correlation_id',
      'aggregate_version', 'created_at', 'updated_at',
    ])],
    ['task_revisions', new Set([
      'revision_id', 'execution_target', 'task_id', 'ordinal', 'cause', 'capability_scope',
      'constraints', 'budget', 'schedule', 'authorization_revision', 'actor_ref',
      'supersedes_revision_id', 'created_at',
    ])],
    ['execution_plans', new Set([
      'execution_plan_id', 'execution_target', 'task_id', 'task_revision_id',
      'task_definition_id', 'task_definition_version', 'authorization_revision', 'nodes',
      'edges', 'entry_node_id', 'bounds', 'completion_condition_ref', 'plan_hash', 'compiled_at',
    ])],
    ['task_runs', new Set([
      'run_id', 'execution_target', 'task_id', 'task_revision_id', 'execution_plan_id',
      'account_id', 'idempotency_key', 'status', 'wait_reason', 'terminal_outcome',
      'reason_code', 'confirmed_units', 'target_units', 'last_checkpoint_ref',
      'current_node_id', 'lease_owner', 'lease_expires_at', 'attempt_count', 'version',
      'created_at', 'updated_at', 'terminal_at',
    ])],
    ['execution_attempts', new Set([
      'execution_target', 'run_id', 'status',
    ])],
    ['managed_task_command_receipts', new Set([
      'execution_target', 'command_id', 'command_kind', 'payload_hash', 'task_id', 'run_id',
      'receipt', 'created_at',
    ])],
    ['decision_traces', new Set([
      'trace_id', 'execution_target', 'correlation_id', 'causation_id', 'task_id', 'run_id',
      'step_run_id', 'attempt_id', 'decision_type', 'outcome', 'reason_code', 'input_refs',
      'evidence_refs', 'created_at',
    ])],
  ]),
  indexes: new Map([
    ['uq_task_runs_target_idempotency', 'task_runs'],
    ['idx_execution_attempts_target_run', 'execution_attempts'],
  ]),
};

export interface CreateTaskBundle {
  commandId: string;
  payloadHash: string;
  task: Task;
  revision: TaskRevision;
  plan: ExecutionPlan;
  runId: string;
  runIdempotencyKey: string;
  targetUnits: number | null;
  trace: DecisionTrace;
  receipt: ManagedTaskAppliedReceipt;
}

export type CreateTaskBundleResult =
  | { outcome: 'applied'; receipt: ManagedTaskAppliedReceipt }
  | { outcome: 'duplicate'; receipt: ManagedTaskAppliedReceipt }
  | { outcome: 'collision' };

export interface CancelTaskCommand {
  commandId: string;
  payloadHash: string;
  task: Task;
  cancelRevision: TaskRevision;
  trace: DecisionTrace;
  expectedAggregateVersion: number;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}

async function rollback(client: pg.PoolClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined);
}

export class ManagedTaskCommandStore extends ManagedTaskStoreBase {
  constructor(options: ManagedTaskStoreOptions) {
    super(REQUIREMENT, options);
  }

  async createBundle(target: ExecutionTarget, bundle: CreateTaskBundle): Promise<CreateTaskBundleResult> {
    this.assertCreateBundle(target, bundle);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await this.readReceipt<CreateManagedTaskResult>(
        client, target, bundle.commandId, 'create', bundle.payloadHash,
      );
      if (existing.outcome !== 'missing') {
        await client.query('COMMIT');
        if (existing.outcome === 'collision') return existing;
        const receipt = existing.receipt;
        if (receipt.outcome !== 'applied' && receipt.outcome !== 'duplicate') {
          throw new ManagedTaskInvariantError('stored create receipt is not an applied result');
        }
        return { outcome: 'duplicate', receipt: { ...receipt, outcome: 'duplicate' } };
      }

      await this.insertTask(client, target, bundle.task);
      await this.insertRevision(client, target, bundle.revision);
      await this.insertPlan(client, target, bundle.plan);
      await client.query(
        `INSERT INTO task_runs
           (run_id, execution_target, task_id, task_revision_id, execution_plan_id, account_id,
            idempotency_key, status, target_units, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9,$9)`,
        [bundle.runId, target, bundle.task.taskId, bundle.revision.revisionId,
          bundle.plan.executionPlanId, bundle.task.accountId, bundle.runIdempotencyKey,
          bundle.targetUnits, new Date(bundle.task.createdAt)],
      );
      await this.insertTrace(client, target, bundle.trace);
      await this.insertReceipt(
        client,
        target,
        bundle.commandId,
        'create',
        bundle.payloadHash,
        bundle.task.taskId,
        bundle.runId,
        bundle.receipt,
      );
      await client.query('COMMIT');
      return { outcome: 'applied', receipt: bundle.receipt };
    } catch (error) {
      await rollback(client);
      if (isUniqueViolation(error)) {
        return this.resolveCreateRace(target, bundle.commandId, bundle.payloadHash);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelTask(target: ExecutionTarget, command: CancelTaskCommand): Promise<CancelManagedTaskResult> {
    if (
      command.task.executionTarget !== target
      || command.cancelRevision.executionTarget !== target
      || command.cancelRevision.taskId !== command.task.taskId
      || command.cancelRevision.supersedesRevisionId !== command.task.currentRevisionId
      || command.trace.executionTarget !== target
    ) {
      throw new ManagedTaskInvariantError('cancel command authority does not match target/task');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await this.readReceipt<CancelManagedTaskResult>(
        client, target, command.commandId, 'cancel', command.payloadHash,
      );
      if (existing.outcome !== 'missing') {
        await client.query('COMMIT');
        if (existing.outcome === 'collision') {
          return { outcome: 'collision', commandId: command.commandId };
        }
        const receipt = existing.receipt;
        if (receipt.outcome !== 'applied' && receipt.outcome !== 'duplicate') return receipt;
        return { ...receipt, outcome: 'duplicate' };
      }

      const updated = await client.query(
        `UPDATE tasks
            SET status='cancelled', current_revision_id=$1,
                authorization_revision=$2, actor_ref=$3,
                aggregate_version=aggregate_version+1, updated_at=$4
          WHERE execution_target=$5 AND account_id=$6 AND task_id=$7
            AND aggregate_version=$8 AND status='active'`,
        [command.cancelRevision.revisionId, command.cancelRevision.authorizationRevision,
          command.cancelRevision.actorRef, new Date(command.cancelRevision.createdAt), target,
          command.task.accountId, command.task.taskId, command.expectedAggregateVersion],
      );
      if (updated.rowCount !== 1) {
        const result: CancelManagedTaskResult = {
          outcome: 'rejected',
          code: 'invalid_task_request',
          message: 'task is missing, stale, or no longer cancellable',
        };
        await this.insertReceipt(
          client, target, command.commandId, 'cancel', command.payloadHash,
          command.task.taskId, null, result,
        );
        await client.query('COMMIT');
        return result;
      }

      await this.insertRevision(client, target, command.cancelRevision);
      await client.query(
        `UPDATE task_runs
            SET status=CASE WHEN status IN ('queued','waiting') THEN 'terminal' ELSE 'cancel_requested' END,
                wait_reason=NULL,
                terminal_outcome=CASE WHEN status IN ('queued','waiting') THEN 'cancelled' ELSE NULL END,
                reason_code=CASE WHEN status IN ('queued','waiting') THEN 'cancelled_by_actor' ELSE NULL END,
                lease_owner=CASE WHEN status IN ('queued','waiting') THEN NULL ELSE lease_owner END,
                lease_expires_at=CASE WHEN status IN ('queued','waiting') THEN NULL ELSE lease_expires_at END,
                terminal_at=CASE WHEN status IN ('queued','waiting') THEN $1 ELSE NULL END,
                version=version+1, updated_at=$1
          WHERE execution_target=$2 AND task_id=$3 AND status <> 'terminal'`,
        [new Date(command.cancelRevision.createdAt), target, command.task.taskId],
      );
      const unknown = await client.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM execution_attempts
            WHERE execution_target=$1 AND run_id IN (
              SELECT run_id FROM task_runs WHERE execution_target=$1 AND task_id=$2
            ) AND status IN ('dispatching','submitted_unknown')
         ) AS present`,
        [target, command.task.taskId],
      );
      const receipt = {
        outcome: 'applied' as const,
        commandId: command.commandId,
        taskId: command.task.taskId,
        aggregateVersion: command.expectedAggregateVersion + 1,
        dispatchedAttemptReconciliationContinues: unknown.rows[0]?.present === true,
      };
      await this.insertTrace(client, target, command.trace);
      await this.insertReceipt(
        client, target, command.commandId, 'cancel', command.payloadHash,
        command.task.taskId, null, receipt,
      );
      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      await rollback(client);
      if (isUniqueViolation(error)) {
        return this.resolveCancelRace(target, command.commandId, command.payloadHash);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private assertCreateBundle(target: ExecutionTarget, bundle: CreateTaskBundle): void {
    if (
      bundle.task.executionTarget !== target
      || bundle.revision.executionTarget !== target
      || bundle.plan.executionTarget !== target
      || bundle.trace.executionTarget !== target
      || bundle.task.currentRevisionId !== bundle.revision.revisionId
      || bundle.plan.taskRevisionId !== bundle.revision.revisionId
      || bundle.receipt.taskId !== bundle.task.taskId
      || bundle.receipt.runId !== bundle.runId
    ) {
      throw new ManagedTaskInvariantError('create bundle records are not one target-scoped authority');
    }
  }

  private async insertTask(client: pg.PoolClient, target: ExecutionTarget, task: Task): Promise<void> {
    await client.query(
      `INSERT INTO tasks
         (task_id, execution_target, account_id, env_key, platform, task_definition_id,
          task_definition_version, current_revision_id, capability_scope, constraints, budget,
          schedule, authorization_revision, actor_ref, status, correlation_id, aggregate_version,
          created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [task.taskId, target, task.accountId, task.envKey, task.platform, task.taskDefinitionId,
        task.taskDefinitionVersion, task.currentRevisionId, JSON.stringify(task.capabilityScope),
        JSON.stringify(task.constraints), JSON.stringify(task.budget), JSON.stringify(task.schedule),
        task.authorizationRevision, task.actorRef, task.status, task.correlationId,
        task.aggregateVersion, new Date(task.createdAt), new Date(task.updatedAt)],
    );
  }

  private async insertRevision(
    client: pg.PoolClient,
    target: ExecutionTarget,
    revision: TaskRevision,
  ): Promise<void> {
    await client.query(
      `INSERT INTO task_revisions
         (revision_id, execution_target, task_id, ordinal, cause, capability_scope, constraints,
          budget, schedule, authorization_revision, actor_ref, supersedes_revision_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [revision.revisionId, target, revision.taskId, revision.ordinal, revision.cause,
        JSON.stringify(revision.capabilityScope), JSON.stringify(revision.constraints),
        JSON.stringify(revision.budget), JSON.stringify(revision.schedule),
        revision.authorizationRevision, revision.actorRef, revision.supersedesRevisionId,
        new Date(revision.createdAt)],
    );
  }

  private async insertPlan(client: pg.PoolClient, target: ExecutionTarget, plan: ExecutionPlan): Promise<void> {
    await client.query(
      `INSERT INTO execution_plans
         (execution_plan_id, execution_target, task_id, task_revision_id, task_definition_id,
          task_definition_version, authorization_revision, nodes, edges, entry_node_id, bounds,
          completion_condition_ref, plan_hash, compiled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [plan.executionPlanId, target, plan.taskId, plan.taskRevisionId, plan.taskDefinitionId,
        plan.taskDefinitionVersion, plan.authorizationRevision, JSON.stringify(plan.nodes),
        JSON.stringify(plan.edges), plan.entryNodeId, JSON.stringify(plan.bounds),
        plan.completionConditionRef, plan.planHash, new Date(plan.compiledAt)],
    );
  }

  private async insertTrace(client: pg.PoolClient, target: ExecutionTarget, trace: DecisionTrace): Promise<void> {
    await client.query(
      `INSERT INTO decision_traces
         (trace_id, execution_target, correlation_id, causation_id, task_id, run_id,
          step_run_id, attempt_id, decision_type, outcome, reason_code, input_refs,
          evidence_refs, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [trace.traceId, target, trace.correlationId, trace.causationId, trace.taskId, trace.runId,
        trace.stepRunId, trace.attemptId, trace.decisionType, trace.outcome, trace.reasonCode,
        JSON.stringify(trace.inputRefs), JSON.stringify(trace.evidenceRefs), new Date(trace.createdAt)],
    );
  }

  private async insertReceipt(
    client: pg.PoolClient,
    target: ExecutionTarget,
    commandId: string,
    commandKind: 'create' | 'cancel',
    payloadHash: string,
    taskId: string | null,
    runId: string | null,
    receipt: CreateManagedTaskResult | CancelManagedTaskResult,
  ): Promise<void> {
    await client.query(
      `INSERT INTO managed_task_command_receipts
         (execution_target, command_id, command_kind, payload_hash, task_id, run_id, receipt)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [target, commandId, commandKind, payloadHash, taskId, runId, JSON.stringify(receipt)],
    );
  }

  private async readReceipt<TResult>(
    client: Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>,
    target: ExecutionTarget,
    commandId: string,
    commandKind: 'create' | 'cancel',
    payloadHash: string,
  ): Promise<{ outcome: 'missing' } | { outcome: 'collision' } | { outcome: 'duplicate'; receipt: TResult }> {
    const result = await client.query<{
      command_kind: 'create' | 'cancel';
      payload_hash: string;
      receipt: TResult;
    }>(
      `SELECT command_kind, payload_hash, receipt
         FROM managed_task_command_receipts
        WHERE execution_target=$1 AND command_id=$2`,
      [target, commandId],
    );
    const row = result.rows[0];
    if (!row) return { outcome: 'missing' };
    if (row.command_kind !== commandKind || row.payload_hash !== payloadHash) return { outcome: 'collision' };
    return { outcome: 'duplicate', receipt: row.receipt };
  }

  private async resolveCreateRace(
    target: ExecutionTarget,
    commandId: string,
    payloadHash: string,
  ): Promise<CreateTaskBundleResult> {
    const existing = await this.readReceipt<CreateManagedTaskResult>(
      this.pool, target, commandId, 'create', payloadHash,
    );
    if (existing.outcome === 'missing') {
      throw new ManagedTaskInvariantError('unique violation occurred without a durable create receipt');
    }
    if (existing.outcome === 'collision') return { outcome: 'collision' };
    if (existing.receipt.outcome !== 'applied' && existing.receipt.outcome !== 'duplicate') {
      throw new ManagedTaskInvariantError('stored create receipt is not an applied result');
    }
    return { outcome: 'duplicate', receipt: { ...existing.receipt, outcome: 'duplicate' } };
  }

  private async resolveCancelRace(
    target: ExecutionTarget,
    commandId: string,
    payloadHash: string,
  ): Promise<CancelManagedTaskResult> {
    const existing = await this.readReceipt<CancelManagedTaskResult>(
      this.pool, target, commandId, 'cancel', payloadHash,
    );
    if (existing.outcome === 'missing') {
      throw new ManagedTaskInvariantError('unique violation occurred without a durable cancel receipt');
    }
    if (existing.outcome === 'collision') return { outcome: 'collision', commandId };
    const receipt = existing.receipt;
    if (receipt.outcome !== 'applied' && receipt.outcome !== 'duplicate') return receipt;
    return { ...receipt, outcome: 'duplicate' };
  }
}
