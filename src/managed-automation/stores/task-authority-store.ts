import type { PlatformId } from 'aidcp-kernel/kernel/platform-types.js';
import type { ExecutionPlan, ExecutionPlanEdge, ExecutionPlanNode } from '../contracts/execution-plan.js';
import type { ExecutionTarget, StructuredConstraints } from '../contracts/common.js';
import type {
  CapabilityScope,
  Task,
  TaskExecutionBudget,
  TaskLifecycleStatus,
  TaskRevision,
  TaskRevisionCause,
  TaskScheduleWindow,
} from '../contracts/task.js';
import {
  assertCallTarget,
  ManagedTaskStoreBase,
  toEpochMillis,
  type ManagedTaskSchemaRequirement,
  type ManagedTaskStoreOptions,
} from './store-base.js';

const REQUIREMENT: ManagedTaskSchemaRequirement = {
  capability: 'managed_task_authority',
  sinceVersion: '0106_managed_task_authority',
  tables: new Map([
    ['tasks', new Set([
      'task_id', 'execution_target', 'account_id', 'env_key', 'platform',
      'task_definition_id', 'task_definition_version', 'current_revision_id',
      'capability_scope', 'constraints', 'budget', 'schedule', 'authorization_revision',
      'actor_ref', 'status', 'correlation_id', 'aggregate_version', 'created_at', 'updated_at',
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
    ['managed_task_command_receipts', new Set([
      'execution_target', 'command_id', 'command_kind', 'payload_hash', 'task_id', 'run_id',
      'receipt', 'created_at',
    ])],
  ]),
  indexes: new Map([
    ['idx_tasks_target_status', 'tasks'],
    ['idx_tasks_target_account', 'tasks'],
    ['uq_task_revisions_target_task_ordinal', 'task_revisions'],
    ['uq_execution_plans_target_revision', 'execution_plans'],
    ['idx_execution_plans_target_task', 'execution_plans'],
    ['idx_managed_task_receipts_target_task', 'managed_task_command_receipts'],
  ]),
};

interface TaskRow {
  task_id: string;
  execution_target: ExecutionTarget;
  account_id: string;
  env_key: string;
  platform: string;
  task_definition_id: string;
  task_definition_version: number | string;
  current_revision_id: string;
  capability_scope: CapabilityScope;
  constraints: StructuredConstraints;
  budget: TaskExecutionBudget;
  schedule: TaskScheduleWindow;
  authorization_revision: string;
  actor_ref: string;
  status: TaskLifecycleStatus;
  correlation_id: string;
  aggregate_version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RevisionRow {
  revision_id: string;
  execution_target: ExecutionTarget;
  task_id: string;
  ordinal: number | string;
  cause: TaskRevisionCause;
  capability_scope: CapabilityScope;
  constraints: StructuredConstraints;
  budget: TaskExecutionBudget;
  schedule: TaskScheduleWindow;
  authorization_revision: string;
  actor_ref: string;
  supersedes_revision_id: string | null;
  created_at: Date | string;
}

interface PlanRow {
  execution_plan_id: string;
  execution_target: ExecutionTarget;
  task_id: string;
  task_revision_id: string;
  task_definition_id: string;
  task_definition_version: number | string;
  authorization_revision: string;
  nodes: ExecutionPlanNode[];
  edges: ExecutionPlanEdge[];
  entry_node_id: string;
  bounds: ExecutionPlan['bounds'];
  completion_condition_ref: string;
  plan_hash: string;
  compiled_at: Date | string;
}

export interface CommandReceipt<TReceipt = unknown> {
  executionTarget: ExecutionTarget;
  commandId: string;
  commandKind: 'create' | 'cancel';
  payloadHash: string;
  taskId: string | null;
  runId: string | null;
  receipt: TReceipt;
  createdAt: number;
}

export type CommandReceiptInsertResult<TReceipt> =
  | { outcome: 'inserted'; receipt: CommandReceipt<TReceipt> }
  | { outcome: 'duplicate'; receipt: CommandReceipt<TReceipt> }
  | { outcome: 'collision' };

const TASK_COLUMNS = `task_id, execution_target, account_id, env_key, platform,
  task_definition_id, task_definition_version, current_revision_id, capability_scope,
  constraints, budget, schedule, authorization_revision, actor_ref, status, correlation_id,
  aggregate_version, created_at, updated_at`;
const REVISION_COLUMNS = `revision_id, execution_target, task_id, ordinal, cause,
  capability_scope, constraints, budget, schedule, authorization_revision, actor_ref,
  supersedes_revision_id, created_at`;
const PLAN_COLUMNS = `execution_plan_id, execution_target, task_id, task_revision_id,
  task_definition_id, task_definition_version, authorization_revision, nodes, edges,
  entry_node_id, bounds, completion_condition_ref, plan_hash, compiled_at`;

function taskFromRow(row: TaskRow): Task {
  return {
    taskId: row.task_id,
    executionTarget: row.execution_target,
    accountId: row.account_id,
    envKey: row.env_key,
    platform: row.platform as PlatformId,
    taskDefinitionId: row.task_definition_id,
    taskDefinitionVersion: Number(row.task_definition_version),
    currentRevisionId: row.current_revision_id,
    capabilityScope: row.capability_scope,
    constraints: row.constraints,
    budget: row.budget,
    schedule: row.schedule,
    authorizationRevision: row.authorization_revision,
    actorRef: row.actor_ref,
    status: row.status,
    correlationId: row.correlation_id,
    aggregateVersion: Number(row.aggregate_version),
    createdAt: toEpochMillis(row.created_at),
    updatedAt: toEpochMillis(row.updated_at),
  };
}

function revisionFromRow(row: RevisionRow): TaskRevision {
  return {
    revisionId: row.revision_id,
    executionTarget: row.execution_target,
    taskId: row.task_id,
    ordinal: Number(row.ordinal),
    cause: row.cause,
    capabilityScope: row.capability_scope,
    constraints: row.constraints,
    budget: row.budget,
    schedule: row.schedule,
    authorizationRevision: row.authorization_revision,
    actorRef: row.actor_ref,
    supersedesRevisionId: row.supersedes_revision_id,
    createdAt: toEpochMillis(row.created_at),
  };
}

function planFromRow(row: PlanRow): ExecutionPlan {
  return {
    executionPlanId: row.execution_plan_id,
    executionTarget: row.execution_target,
    taskId: row.task_id,
    taskRevisionId: row.task_revision_id,
    taskDefinitionId: row.task_definition_id,
    taskDefinitionVersion: Number(row.task_definition_version),
    authorizationRevision: row.authorization_revision,
    nodes: row.nodes,
    edges: row.edges,
    entryNodeId: row.entry_node_id,
    bounds: row.bounds,
    completionConditionRef: row.completion_condition_ref,
    planHash: row.plan_hash,
    compiledAt: toEpochMillis(row.compiled_at),
  };
}

export type TaskInsert = Omit<Task, 'createdAt' | 'updatedAt'>;
export type TaskRevisionInsert = Omit<TaskRevision, 'createdAt'>;
export type ExecutionPlanInsert = Omit<ExecutionPlan, 'compiledAt'>;

export class TaskAuthorityStore extends ManagedTaskStoreBase {
  constructor(options: ManagedTaskStoreOptions) {
    super(REQUIREMENT, options);
  }

  async insertTask(target: ExecutionTarget, task: TaskInsert): Promise<boolean> {
    assertCallTarget(target, task.executionTarget);
    const result = await this.pool.query(
      `INSERT INTO tasks (${TASK_COLUMNS.replaceAll('\n', ' ')})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now(),now())
       ON CONFLICT DO NOTHING`,
      [task.taskId, target, task.accountId, task.envKey, task.platform,
        task.taskDefinitionId, task.taskDefinitionVersion, task.currentRevisionId,
        JSON.stringify(task.capabilityScope), JSON.stringify(task.constraints),
        JSON.stringify(task.budget), JSON.stringify(task.schedule), task.authorizationRevision,
        task.actorRef, task.status, task.correlationId, task.aggregateVersion],
    );
    return result.rowCount === 1;
  }

  async getTask(target: ExecutionTarget, taskId: string): Promise<Task | null> {
    const result = await this.pool.query<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM tasks WHERE execution_target=$1 AND task_id=$2`,
      [target, taskId],
    );
    return result.rows[0] ? taskFromRow(result.rows[0]) : null;
  }

  async getTaskForAccount(target: ExecutionTarget, accountId: string, taskId: string): Promise<Task | null> {
    const result = await this.pool.query<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM tasks
        WHERE execution_target=$1 AND account_id=$2 AND task_id=$3`,
      [target, accountId, taskId],
    );
    return result.rows[0] ? taskFromRow(result.rows[0]) : null;
  }

  async transitionTask(
    target: ExecutionTarget,
    taskId: string,
    expectedVersion: number,
    expectedStatuses: readonly TaskLifecycleStatus[],
    nextStatus: TaskLifecycleStatus,
    nextRevisionId?: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE tasks
          SET status=$1,
              current_revision_id=COALESCE($2, current_revision_id),
              aggregate_version=aggregate_version+1,
              updated_at=now()
        WHERE execution_target=$3 AND task_id=$4 AND aggregate_version=$5
          AND status=ANY($6::text[])`,
      [nextStatus, nextRevisionId ?? null, target, taskId, expectedVersion, expectedStatuses],
    );
    return result.rowCount === 1;
  }

  async insertRevision(target: ExecutionTarget, revision: TaskRevisionInsert): Promise<boolean> {
    assertCallTarget(target, revision.executionTarget);
    const result = await this.pool.query(
      `INSERT INTO task_revisions (${REVISION_COLUMNS.replaceAll('\n', ' ')})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
       ON CONFLICT DO NOTHING`,
      [revision.revisionId, target, revision.taskId, revision.ordinal, revision.cause,
        JSON.stringify(revision.capabilityScope), JSON.stringify(revision.constraints),
        JSON.stringify(revision.budget), JSON.stringify(revision.schedule),
        revision.authorizationRevision, revision.actorRef, revision.supersedesRevisionId],
    );
    return result.rowCount === 1;
  }

  async getRevision(target: ExecutionTarget, revisionId: string): Promise<TaskRevision | null> {
    const result = await this.pool.query<RevisionRow>(
      `SELECT ${REVISION_COLUMNS} FROM task_revisions
        WHERE execution_target=$1 AND revision_id=$2`,
      [target, revisionId],
    );
    return result.rows[0] ? revisionFromRow(result.rows[0]) : null;
  }

  async insertPlan(target: ExecutionTarget, plan: ExecutionPlanInsert): Promise<boolean> {
    assertCallTarget(target, plan.executionTarget);
    const result = await this.pool.query(
      `INSERT INTO execution_plans (${PLAN_COLUMNS.replaceAll('\n', ' ')})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
       ON CONFLICT DO NOTHING`,
      [plan.executionPlanId, target, plan.taskId, plan.taskRevisionId, plan.taskDefinitionId,
        plan.taskDefinitionVersion, plan.authorizationRevision, JSON.stringify(plan.nodes),
        JSON.stringify(plan.edges), plan.entryNodeId, JSON.stringify(plan.bounds),
        plan.completionConditionRef, plan.planHash],
    );
    return result.rowCount === 1;
  }

  async getPlanForRevision(target: ExecutionTarget, revisionId: string): Promise<ExecutionPlan | null> {
    const result = await this.pool.query<PlanRow>(
      `SELECT ${PLAN_COLUMNS} FROM execution_plans
        WHERE execution_target=$1 AND task_revision_id=$2`,
      [target, revisionId],
    );
    return result.rows[0] ? planFromRow(result.rows[0]) : null;
  }

  async getPlan(target: ExecutionTarget, executionPlanId: string): Promise<ExecutionPlan | null> {
    const result = await this.pool.query<PlanRow>(
      `SELECT ${PLAN_COLUMNS} FROM execution_plans
        WHERE execution_target=$1 AND execution_plan_id=$2`,
      [target, executionPlanId],
    );
    return result.rows[0] ? planFromRow(result.rows[0]) : null;
  }

  async insertCommandReceipt<TReceipt>(
    target: ExecutionTarget,
    input: Omit<CommandReceipt<TReceipt>, 'executionTarget' | 'createdAt'>,
  ): Promise<CommandReceiptInsertResult<TReceipt>> {
    const inserted = await this.pool.query<{ created_at: Date | string }>(
      `INSERT INTO managed_task_command_receipts
         (execution_target, command_id, command_kind, payload_hash, task_id, run_id, receipt)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT DO NOTHING
       RETURNING created_at`,
      [target, input.commandId, input.commandKind, input.payloadHash, input.taskId, input.runId,
        JSON.stringify(input.receipt)],
    );
    if (inserted.rows[0]) {
      return {
        outcome: 'inserted',
        receipt: { ...input, executionTarget: target, createdAt: toEpochMillis(inserted.rows[0].created_at) },
      };
    }

    const existing = await this.getCommandReceipt<TReceipt>(target, input.commandId);
    if (!existing || existing.payloadHash !== input.payloadHash || existing.commandKind !== input.commandKind) {
      return { outcome: 'collision' };
    }
    return { outcome: 'duplicate', receipt: existing };
  }

  async getCommandReceipt<TReceipt>(
    target: ExecutionTarget,
    commandId: string,
  ): Promise<CommandReceipt<TReceipt> | null> {
    const result = await this.pool.query<{
      execution_target: ExecutionTarget;
      command_id: string;
      command_kind: 'create' | 'cancel';
      payload_hash: string;
      task_id: string | null;
      run_id: string | null;
      receipt: TReceipt;
      created_at: Date | string;
    }>(
      `SELECT execution_target, command_id, command_kind, payload_hash, task_id, run_id,
              receipt, created_at
         FROM managed_task_command_receipts
        WHERE execution_target=$1 AND command_id=$2`,
      [target, commandId],
    );
    const row = result.rows[0];
    return row ? {
      executionTarget: row.execution_target,
      commandId: row.command_id,
      commandKind: row.command_kind,
      payloadHash: row.payload_hash,
      taskId: row.task_id,
      runId: row.run_id,
      receipt: row.receipt,
      createdAt: toEpochMillis(row.created_at),
    } : null;
  }
}
