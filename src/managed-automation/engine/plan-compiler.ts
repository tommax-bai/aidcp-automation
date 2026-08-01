import type { JsonValue } from '../contracts/common.js';
import type { ExecutionPlan } from '../contracts/execution-plan.js';
import { payloadHash } from '../contracts/validation.js';
import type { Task, TaskRevision } from '../contracts/task.js';
import type { RegistryValidationFailure, PhaseOneRegistry } from '../registry/index.js';
import { resolveLinearGraph } from './linear-graph.js';

export class PlanCompileError extends Error {
  readonly code = 'managed_task_plan_compile_rejected';

  constructor(
    readonly reason: RegistryValidationFailure | 'capability_scope_denied' | 'contract_invalid',
    detail: string,
  ) {
    super(`managed_task_plan_compile_rejected(${reason}): ${detail}`);
    this.name = 'PlanCompileError';
  }
}

export interface CompilePlanInput {
  executionPlanId: string;
  task: Task;
  revision: TaskRevision;
  compiledAt: number;
}

function frozenAuthorityHash(authority: Pick<
  TaskRevision,
  'capabilityScope' | 'constraints' | 'budget' | 'schedule' | 'authorizationRevision' | 'actorRef'
>): string {
  return payloadHash({
    capabilityScope: {
      allow: [...authority.capabilityScope.allow],
      deny: [...authority.capabilityScope.deny],
    },
    constraints: authority.constraints,
    budget: {
      maxBrowserMinutes: authority.budget.maxBrowserMinutes,
      maxSteps: authority.budget.maxSteps,
      maxExecutionAttempts: authority.budget.maxExecutionAttempts,
      maxWaitMs: authority.budget.maxWaitMs,
    },
    schedule: {
      scheduledAt: authority.schedule.scheduledAt,
      latestStartAt: authority.schedule.latestStartAt,
      missPolicy: authority.schedule.missPolicy,
    },
    authorizationRevision: authority.authorizationRevision,
    actorRef: authority.actorRef,
  });
}

function planHashPayload(plan: Omit<ExecutionPlan, 'planHash' | 'compiledAt'>): JsonValue {
  return {
    executionPlanId: plan.executionPlanId,
    executionTarget: plan.executionTarget,
    taskId: plan.taskId,
    taskRevisionId: plan.taskRevisionId,
    taskDefinitionId: plan.taskDefinitionId,
    taskDefinitionVersion: plan.taskDefinitionVersion,
    authorizationRevision: plan.authorizationRevision,
    nodes: plan.nodes.map((node) => ({
      nodeId: node.nodeId,
      capabilityId: node.capabilityId,
      capabilityVersion: node.capabilityVersion,
      inputBindingRef: node.inputBindingRef,
    })),
    edges: plan.edges.map((edge) => ({ kind: edge.kind, from: edge.from, to: edge.to })),
    entryNodeId: plan.entryNodeId,
    bounds: {
      maxNodes: plan.bounds.maxNodes,
      maxExecutionAttempts: plan.bounds.maxExecutionAttempts,
      maxWallClockMs: plan.bounds.maxWallClockMs,
    },
    completionConditionRef: plan.completionConditionRef,
  };
}

export class PlanCompiler {
  constructor(private readonly registry: PhaseOneRegistry) {}

  compile(input: CompilePlanInput): ExecutionPlan {
    const { task, revision } = input;
    if (
      task.executionTarget !== revision.executionTarget
      || task.taskId !== revision.taskId
      || task.currentRevisionId !== revision.revisionId
      || task.authorizationRevision !== revision.authorizationRevision
      || frozenAuthorityHash(task) !== frozenAuthorityHash(revision)
    ) {
      throw new PlanCompileError('contract_invalid', 'task and revision authority do not match');
    }

    const registryResult = this.registry.validateTaskDefinition(
      task.taskDefinitionId,
      task.taskDefinitionVersion,
    );
    if (!registryResult.ok) {
      throw new PlanCompileError(registryResult.reason, registryResult.detail);
    }
    const graph = resolveLinearGraph(
      registryResult.definition.nodes.map((node) => node.nodeId),
      registryResult.definition.edges,
    );
    if (!graph.ok) throw new PlanCompileError('contract_invalid', graph.detail);

    const allow = new Set(revision.capabilityScope.allow);
    const deny = new Set(revision.capabilityScope.deny);
    const nodeById = new Map(registryResult.definition.nodes.map((node) => [node.nodeId, node]));
    for (const capability of registryResult.capabilities) {
      if (!allow.has(capability.capabilityId) || deny.has(capability.capabilityId)) {
        throw new PlanCompileError(
          'capability_scope_denied',
          `capability ${capability.capabilityId}@${capability.version} is outside the frozen revision scope`,
        );
      }
    }

    const budgetWallClockMs = Math.min(
      revision.budget.maxWaitMs,
      revision.budget.maxBrowserMinutes * 60_000,
    );
    const planWithoutHash: Omit<ExecutionPlan, 'planHash' | 'compiledAt'> = {
      executionPlanId: input.executionPlanId,
      executionTarget: task.executionTarget,
      taskId: task.taskId,
      taskRevisionId: revision.revisionId,
      taskDefinitionId: task.taskDefinitionId,
      taskDefinitionVersion: task.taskDefinitionVersion,
      authorizationRevision: revision.authorizationRevision,
      nodes: graph.order.map((nodeId) => {
        const node = nodeById.get(nodeId);
        if (!node) throw new PlanCompileError('contract_invalid', `node ${nodeId} vanished during compilation`);
        return { ...node };
      }),
      edges: registryResult.definition.edges.map((edge) => ({ ...edge })),
      entryNodeId: graph.order[0]!,
      bounds: {
        maxNodes: Math.min(registryResult.definition.bounds.maxNodes, revision.budget.maxSteps),
        maxExecutionAttempts: Math.min(
          registryResult.definition.bounds.maxExecutionAttempts,
          revision.budget.maxExecutionAttempts,
        ),
        maxWallClockMs: Math.min(registryResult.definition.bounds.maxWallClockMs, budgetWallClockMs),
      },
      completionConditionRef: registryResult.definition.completionConditionRef,
    };
    if (
      planWithoutHash.nodes.length > planWithoutHash.bounds.maxNodes
      || planWithoutHash.bounds.maxExecutionAttempts < 1
      || planWithoutHash.bounds.maxWallClockMs < 1
    ) {
      throw new PlanCompileError('contract_invalid', 'task budget cannot contain the registered plan');
    }
    return {
      ...planWithoutHash,
      planHash: payloadHash(planHashPayload(planWithoutHash)),
      compiledAt: input.compiledAt,
    };
  }
}
