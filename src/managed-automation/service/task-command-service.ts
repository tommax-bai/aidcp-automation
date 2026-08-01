import { randomUUID } from 'node:crypto';
import type {
  CancelManagedTaskInput,
  CancelManagedTaskResult,
  CreateManagedTaskInput,
  CreateManagedTaskResult,
  ManagedTaskActor,
  ManagedTaskEnvelope,
  ManagedTaskJson,
  ManagedTaskRejection,
  QueryManagedTaskInput,
  QueryManagedTaskResult,
} from 'aidcp-kernel/kernel/managed-task-port.js';
import { MANAGED_TASK_CONTRACT } from 'aidcp-kernel/kernel/managed-task-port.js';
import type { PlatformId } from 'aidcp-kernel/kernel/platform-types.js';
import type { ExecutionTarget, JsonValue, StructuredConstraints } from '../contracts/common.js';
import { projectCustomerDecisionTrace, projectCustomerTask } from '../contracts/projection.js';
import type { DecisionTrace } from '../contracts/decision-trace.js';
import { payloadHash } from '../contracts/validation.js';
import type { Task, TaskRevision } from '../contracts/task.js';
import { PlanCompileError, PlanCompiler } from '../engine/plan-compiler.js';
import type { PhaseOneRegistry } from '../registry/index.js';
import { parsePersonaResearchParams } from '../registry/persona-research.js';
import type { ManagedTaskCommandStore } from '../stores/command-store.js';
import type { DecisionTraceStore } from '../stores/decision-trace-store.js';
import type { RunStateStore } from '../stores/run-state-store.js';
import type { TaskAuthorityStore } from '../stores/task-authority-store.js';
import type { ManagedTaskFeatureFlags } from './feature-flags.js';

export interface AccountAuthorizationRequest {
  executionTarget: ExecutionTarget;
  actor: ManagedTaskActor;
  accountId: string;
  envKey?: string;
  platform?: PlatformId;
}

export type AccountAuthorizationResult =
  | { allowed: true; authorizationRevision: string }
  | { allowed: false };

export interface AccountAuthorizationPort {
  authorize(request: AccountAuthorizationRequest): Promise<AccountAuthorizationResult>;
}

export type ManagedTaskReadiness =
  | { ready: true }
  | { ready: false; reason: 'schema_not_ready' | 'runtime_not_ready'; detail: string };

export interface ManagedTaskCommandServiceDeps {
  executionTarget: ExecutionTarget;
  flags: () => ManagedTaskFeatureFlags;
  readiness: () => ManagedTaskReadiness;
  authorization: AccountAuthorizationPort;
  registry: PhaseOneRegistry;
  compiler: PlanCompiler;
  commandStore: Pick<ManagedTaskCommandStore, 'createBundle' | 'cancelTask'>;
  taskStore: Pick<TaskAuthorityStore, 'getTaskForAccount'>;
  runStore: Pick<RunStateStore, 'getLatestRunForTask'>;
  traceStore: Pick<DecisionTraceStore, 'listByTask'>;
  now?: () => number;
  newId?: () => string;
}

function actorRef(actor: ManagedTaskActor): string {
  return `${actor.kind}:${actor.actorId}`;
}

function actorJson(actor: ManagedTaskActor): JsonValue {
  return {
    kind: actor.kind,
    actorId: actor.actorId,
    customerId: actor.customerId,
    authorizationRevision: actor.authorizationRevision,
  };
}

export function createCommandPayloadHash(input: CreateManagedTaskInput): string {
  return payloadHash({
    commandId: input.commandId,
    actor: actorJson(input.actor),
    accountId: input.accountId,
    envKey: input.envKey,
    platform: input.platform,
    taskDefinition: { id: input.taskDefinition.id, version: input.taskDefinition.version },
    parameters: input.parameters,
    capabilityScope: {
      allow: [...input.capabilityScope.allow],
      deny: [...input.capabilityScope.deny],
    },
    budget: {
      maxBrowserMinutes: input.budget.maxBrowserMinutes,
      maxSteps: input.budget.maxSteps,
      maxExecutionAttempts: input.budget.maxExecutionAttempts,
      maxWaitMs: input.budget.maxWaitMs,
    },
    schedule: {
      scheduledAt: input.schedule.scheduledAt,
      latestStartAt: input.schedule.latestStartAt,
      missPolicy: input.schedule.missPolicy,
    },
  });
}

export function cancelCommandPayloadHash(input: CancelManagedTaskInput): string {
  return payloadHash({
    commandId: input.commandId,
    actor: actorJson(input.actor),
    accountId: input.accountId,
    taskId: input.taskId,
    expectedAggregateVersion: input.expectedAggregateVersion,
    reason: input.reason,
  });
}

function structuredParameters(value: ManagedTaskJson): StructuredConstraints | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as StructuredConstraints
    : null;
}

function rejection(code: ManagedTaskRejection['code'], message: string): ManagedTaskRejection {
  return { outcome: 'rejected', code, message };
}

function exactEnvelope<T>(
  localTarget: ExecutionTarget,
  envelope: ManagedTaskEnvelope<T>,
): ManagedTaskRejection | null {
  if (
    envelope.contract.name !== MANAGED_TASK_CONTRACT.name
    || envelope.contract.version !== MANAGED_TASK_CONTRACT.version
  ) {
    return rejection('protocol_version_mismatch', 'managed-task contract version is not supported');
  }
  if (envelope.executionTarget !== localTarget) {
    return rejection('execution_target_mismatch', 'request target does not match local Automation target');
  }
  return null;
}

export class ManagedTaskCommandService {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: ManagedTaskCommandServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  async create(envelope: ManagedTaskEnvelope<CreateManagedTaskInput>): Promise<CreateManagedTaskResult> {
    const envelopeError = exactEnvelope(this.deps.executionTarget, envelope);
    if (envelopeError) return envelopeError;
    const flags = this.deps.flags();
    if (!flags.apiEnabled || !flags.createEnabled) {
      return rejection('feature_disabled', 'managed task creation is disabled');
    }
    const readiness = this.deps.readiness();
    if (!readiness.ready) {
      return readiness.reason === 'schema_not_ready'
        ? rejection('schema_not_ready', 'managed task schema is not ready')
        : { outcome: 'unavailable', reason: 'managed_task_runtime_not_ready' };
    }
    const input = envelope.input;
    if (createCommandPayloadHash(input) !== input.payloadHash) {
      return rejection('invalid_task_request', 'create command payload hash does not match');
    }

    const authorization = await this.deps.authorization.authorize({
      executionTarget: envelope.executionTarget,
      actor: input.actor,
      accountId: input.accountId,
      envKey: input.envKey,
      platform: input.platform,
    });
    if (
      !authorization.allowed
      || authorization.authorizationRevision !== input.actor.authorizationRevision
    ) {
      return rejection('account_not_authorized', 'actor/account authorization is absent or stale');
    }
    const constraints = structuredParameters(input.parameters);
    if (constraints === null) return rejection('invalid_task_request', 'task parameters must be an object');
    const parameterResult = parsePersonaResearchParams(constraints);
    if (!parameterResult.ok) return rejection('invalid_task_request', parameterResult.detail);
    const registryResult = this.deps.registry.validateTaskDefinition(
      input.taskDefinition.id,
      input.taskDefinition.version,
    );
    if (!registryResult.ok) return rejection(registryResult.reason, registryResult.detail);

    const createdAt = this.now();
    const taskId = this.newId();
    const revisionId = this.newId();
    const executionPlanId = this.newId();
    const runId = this.newId();
    const traceId = this.newId();
    const scope = {
      allow: [...input.capabilityScope.allow],
      deny: [...input.capabilityScope.deny],
    };
    const task: Task = {
      taskId,
      executionTarget: envelope.executionTarget,
      accountId: input.accountId,
      envKey: input.envKey,
      platform: input.platform,
      taskDefinitionId: input.taskDefinition.id,
      taskDefinitionVersion: input.taskDefinition.version,
      currentRevisionId: revisionId,
      capabilityScope: scope,
      constraints,
      budget: { ...input.budget },
      schedule: { ...input.schedule },
      authorizationRevision: authorization.authorizationRevision,
      actorRef: actorRef(input.actor),
      status: 'active',
      correlationId: envelope.correlationId,
      aggregateVersion: 1,
      createdAt,
      updatedAt: createdAt,
    };
    const revision: TaskRevision = {
      revisionId,
      executionTarget: envelope.executionTarget,
      taskId,
      ordinal: 1,
      cause: 'create',
      capabilityScope: scope,
      constraints,
      budget: { ...input.budget },
      schedule: { ...input.schedule },
      authorizationRevision: authorization.authorizationRevision,
      actorRef: actorRef(input.actor),
      supersedesRevisionId: null,
      createdAt,
    };

    try {
      const plan = this.deps.compiler.compile({ executionPlanId, task, revision, compiledAt: createdAt });
      const receipt = {
        outcome: 'applied' as const,
        commandId: input.commandId,
        taskId,
        runId,
        aggregateVersion: 1,
      };
      const trace: DecisionTrace = {
        traceId,
        executionTarget: envelope.executionTarget,
        correlationId: envelope.correlationId,
        causationId: envelope.causationId,
        taskId,
        runId,
        stepRunId: null,
        attemptId: null,
        decisionType: 'creation',
        outcome: 'allowed',
        reasonCode: 'succeeded',
        inputRefs: [`command:${input.commandId}`, `authorization:${authorization.authorizationRevision}`],
        evidenceRefs: [],
        createdAt,
      };
      const result = await this.deps.commandStore.createBundle(envelope.executionTarget, {
        commandId: input.commandId,
        payloadHash: input.payloadHash,
        task,
        revision,
        plan,
        runId,
        runIdempotencyKey: `managed-task:${envelope.executionTarget}:${input.commandId}`,
        targetUnits: parameterResult.params.maxItems,
        trace,
        receipt,
      });
      if (result.outcome === 'collision') return { outcome: 'collision', commandId: input.commandId };
      return result.receipt;
    } catch (error) {
      if (error instanceof PlanCompileError) {
        if (error.reason === 'capability_scope_denied') {
          return rejection('capability_scope_denied', 'task capability scope does not contain the registered plan');
        }
        return rejection(error.reason, 'registered task definition cannot be compiled');
      }
      return { outcome: 'unavailable', reason: 'managed_task_create_failed' };
    }
  }

  async cancel(envelope: ManagedTaskEnvelope<CancelManagedTaskInput>): Promise<CancelManagedTaskResult> {
    const envelopeError = exactEnvelope(this.deps.executionTarget, envelope);
    if (envelopeError) return envelopeError;
    if (!this.deps.flags().apiEnabled) return rejection('feature_disabled', 'managed task API is disabled');
    const readiness = this.deps.readiness();
    if (!readiness.ready) {
      return readiness.reason === 'schema_not_ready'
        ? rejection('schema_not_ready', 'managed task schema is not ready')
        : { outcome: 'unavailable', reason: 'managed_task_runtime_not_ready' };
    }
    const input = envelope.input;
    if (cancelCommandPayloadHash(input) !== input.payloadHash) {
      return rejection('invalid_task_request', 'cancel command payload hash does not match');
    }
    const authorization = await this.deps.authorization.authorize({
      executionTarget: envelope.executionTarget,
      actor: input.actor,
      accountId: input.accountId,
    });
    if (!authorization.allowed || authorization.authorizationRevision !== input.actor.authorizationRevision) {
      return rejection('account_not_authorized', 'actor/account authorization is absent or stale');
    }

    try {
      const task = await this.deps.taskStore.getTaskForAccount(
        envelope.executionTarget,
        input.accountId,
        input.taskId,
      );
      if (!task) return rejection('invalid_task_request', 'task does not exist for this account');
      const createdAt = this.now();
      const cancelRevision: TaskRevision = {
        revisionId: this.newId(),
        executionTarget: envelope.executionTarget,
        taskId: task.taskId,
        ordinal: task.aggregateVersion + 1,
        cause: 'cancel',
        capabilityScope: task.capabilityScope,
        constraints: task.constraints,
        budget: task.budget,
        schedule: task.schedule,
        authorizationRevision: authorization.authorizationRevision,
        actorRef: actorRef(input.actor),
        supersedesRevisionId: task.currentRevisionId,
        createdAt,
      };
      const trace: DecisionTrace = {
        traceId: this.newId(),
        executionTarget: envelope.executionTarget,
        correlationId: envelope.correlationId,
        causationId: envelope.causationId,
        taskId: task.taskId,
        runId: null,
        stepRunId: null,
        attemptId: null,
        decisionType: 'cancellation',
        outcome: 'selected',
        reasonCode: 'cancelled_by_actor',
        inputRefs: [`command:${input.commandId}`, `cancel-reason-hash:${payloadHash(input.reason)}`],
        evidenceRefs: [],
        createdAt,
      };
      return await this.deps.commandStore.cancelTask(envelope.executionTarget, {
        commandId: input.commandId,
        payloadHash: input.payloadHash,
        task,
        cancelRevision,
        trace,
        expectedAggregateVersion: input.expectedAggregateVersion,
      });
    } catch {
      return { outcome: 'unavailable', reason: 'managed_task_cancel_failed' };
    }
  }

  async query(envelope: ManagedTaskEnvelope<QueryManagedTaskInput>): Promise<QueryManagedTaskResult> {
    const envelopeError = exactEnvelope(this.deps.executionTarget, envelope);
    if (envelopeError) return envelopeError;
    if (!this.deps.flags().apiEnabled) return rejection('feature_disabled', 'managed task API is disabled');
    const readiness = this.deps.readiness();
    if (!readiness.ready) {
      return readiness.reason === 'schema_not_ready'
        ? rejection('schema_not_ready', 'managed task schema is not ready')
        : { outcome: 'unavailable', reason: 'managed_task_runtime_not_ready' };
    }
    const input = envelope.input;
    const authorization = await this.deps.authorization.authorize({
      executionTarget: envelope.executionTarget,
      actor: input.actor,
      accountId: input.accountId,
    });
    if (!authorization.allowed || authorization.authorizationRevision !== input.actor.authorizationRevision) {
      return rejection('account_not_authorized', 'actor/account authorization is absent or stale');
    }

    try {
      const task = await this.deps.taskStore.getTaskForAccount(
        envelope.executionTarget,
        input.accountId,
        input.taskId,
      );
      if (!task) return { outcome: 'not_found' };
      const [run, traces] = await Promise.all([
        this.deps.runStore.getLatestRunForTask(envelope.executionTarget, task.taskId),
        this.deps.traceStore.listByTask(envelope.executionTarget, task.taskId, 100),
      ]);
      const summary = projectCustomerTask(task, run);
      return {
        outcome: 'found',
        task: {
          ...summary,
          trace: traces.map(projectCustomerDecisionTrace),
        },
      };
    } catch {
      return { outcome: 'unavailable', reason: 'managed_task_query_failed' };
    }
  }
}
