import assert from 'node:assert/strict';
import test from 'node:test';
import type { Task, TaskRevision } from '../../src/managed-automation/contracts/task.js';
import { PlanCompileError, PlanCompiler } from '../../src/managed-automation/engine/index.js';
import { createPhaseOneRegistry, PERSONA_RESEARCH_CAPABILITY_IDS } from '../../src/managed-automation/registry/index.js';

function authority(): { task: Task; revision: TaskRevision } {
  const capabilityScope = { allow: [...PERSONA_RESEARCH_CAPABILITY_IDS], deny: [] };
  const budget = { maxBrowserMinutes: 20, maxSteps: 4, maxExecutionAttempts: 3, maxWaitMs: 900_000 };
  const schedule = { scheduledAt: 1000, latestStartAt: 2000, missPolicy: 'skip' as const };
  const revision: TaskRevision = {
    revisionId: 'revision-1',
    executionTarget: 'dev',
    taskId: 'task-1',
    ordinal: 1,
    cause: 'create',
    capabilityScope,
    constraints: { keywords: ['automation'] },
    budget,
    schedule,
    authorizationRevision: 'auth-1',
    actorRef: 'actor-1',
    supersedesRevisionId: null,
    createdAt: 1000,
  };
  return {
    revision,
    task: {
      taskId: 'task-1',
      executionTarget: 'dev',
      accountId: 'account-1',
      envKey: 'env-1',
      platform: 'facebook',
      taskDefinitionId: 'persona.research',
      taskDefinitionVersion: 1,
      currentRevisionId: revision.revisionId,
      capabilityScope,
      constraints: revision.constraints,
      budget,
      schedule,
      authorizationRevision: 'auth-1',
      actorRef: 'actor-1',
      status: 'active',
      correlationId: 'correlation-1',
      aggregateVersion: 1,
      createdAt: 1000,
      updatedAt: 1000,
    },
  };
}

test('compiler emits the exact read-only linear plan with a stable hash', () => {
  const compiler = new PlanCompiler(createPhaseOneRegistry());
  const { task, revision } = authority();
  const first = compiler.compile({ executionPlanId: 'plan-1', task, revision, compiledAt: 3000 });
  const second = compiler.compile({ executionPlanId: 'plan-1', task, revision, compiledAt: 4000 });

  assert.deepEqual(first.nodes.map((node) => node.capabilityId), PERSONA_RESEARCH_CAPABILITY_IDS);
  assert.deepEqual(first.edges.map((edge) => `${edge.from}->${edge.to}`), [
    'search->browse',
    'browse->assess',
    'assess->summarize',
  ]);
  assert.equal(first.entryNodeId, 'search');
  assert.match(first.planHash, /^[a-f0-9]{64}$/);
  assert.equal(first.planHash, second.planHash, 'compiledAt is not part of the immutable semantic hash');
});

test('compiler intersects definition bounds with the frozen task budget', () => {
  const compiler = new PlanCompiler(createPhaseOneRegistry());
  const { task, revision } = authority();
  revision.budget = { ...revision.budget, maxExecutionAttempts: 2, maxWaitMs: 500_000 };
  task.budget = revision.budget;
  const plan = compiler.compile({ executionPlanId: 'plan-1', task, revision, compiledAt: 3000 });
  assert.deepEqual(plan.bounds, { maxNodes: 4, maxExecutionAttempts: 2, maxWallClockMs: 500_000 });
});

test('compiler rejects task/revision authority drift', () => {
  const compiler = new PlanCompiler(createPhaseOneRegistry());
  const { task, revision } = authority();
  revision.authorizationRevision = 'auth-stale';
  assert.throws(
    () => compiler.compile({ executionPlanId: 'plan-1', task, revision, compiledAt: 3000 }),
    (error: unknown) => error instanceof PlanCompileError && error.reason === 'contract_invalid',
  );
});

test('compiler rejects denied or omitted capabilities instead of weakening the graph', () => {
  const compiler = new PlanCompiler(createPhaseOneRegistry());
  const { task, revision } = authority();
  revision.capabilityScope = {
    allow: revision.capabilityScope.allow.filter((id) => id !== 'research.assess'),
    deny: [],
  };
  task.capabilityScope = revision.capabilityScope;
  assert.throws(
    () => compiler.compile({ executionPlanId: 'plan-1', task, revision, compiledAt: 3000 }),
    (error: unknown) => error instanceof PlanCompileError && error.reason === 'capability_scope_denied',
  );
});

test('compiler rejects a budget that cannot contain the mandatory graph', () => {
  const compiler = new PlanCompiler(createPhaseOneRegistry());
  const { task, revision } = authority();
  revision.budget = { ...revision.budget, maxSteps: 3 };
  task.budget = revision.budget;
  assert.throws(
    () => compiler.compile({ executionPlanId: 'plan-1', task, revision, compiledAt: 3000 }),
    (error: unknown) => error instanceof PlanCompileError && error.reason === 'contract_invalid',
  );
});
