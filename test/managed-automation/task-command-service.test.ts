import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CreateManagedTaskInput,
  ManagedTaskEnvelope,
} from 'aidcp-kernel/kernel/managed-task-port.js';
import { MANAGED_TASK_CONTRACT } from 'aidcp-kernel/kernel/managed-task-port.js';
import type { DecisionTrace } from '../../src/managed-automation/contracts/decision-trace.js';
import type { Task } from '../../src/managed-automation/contracts/task.js';
import type { TaskRun } from '../../src/managed-automation/contracts/task-run.js';
import { PlanCompiler } from '../../src/managed-automation/engine/plan-compiler.js';
import { createPhaseOneRegistry, PERSONA_RESEARCH_CAPABILITY_IDS } from '../../src/managed-automation/registry/index.js';
import {
  cancelCommandPayloadHash,
  createCommandPayloadHash,
  ManagedTaskCommandService,
  readManagedTaskFeatureFlags,
  type ManagedTaskCommandServiceDeps,
} from '../../src/managed-automation/service/index.js';
import type { CreateTaskBundle } from '../../src/managed-automation/stores/command-store.js';

const enabledFlags = {
  apiEnabled: true,
  createEnabled: true,
  workerEnabled: false,
  laneEnabled: false,
};

function createInput(): CreateManagedTaskInput {
  const input: CreateManagedTaskInput = {
    commandId: 'command-create-1',
    payloadHash: '',
    actor: {
      kind: 'customer',
      actorId: 'actor-1',
      customerId: 'customer-1',
      authorizationRevision: 'auth-1',
    },
    accountId: 'account-1',
    envKey: 'env-1',
    platform: 'facebook',
    taskDefinition: { id: 'persona.research', version: 1 },
    parameters: { keywords: ['automation'], maxItems: 3 },
    capabilityScope: { allow: [...PERSONA_RESEARCH_CAPABILITY_IDS], deny: [] },
    budget: { maxBrowserMinutes: 20, maxSteps: 4, maxExecutionAttempts: 3, maxWaitMs: 900_000 },
    schedule: { scheduledAt: 1000, latestStartAt: 2000, missPolicy: 'skip' },
  };
  input.payloadHash = createCommandPayloadHash(input);
  return input;
}

function envelope(input = createInput()): ManagedTaskEnvelope<CreateManagedTaskInput> {
  return {
    contract: MANAGED_TASK_CONTRACT,
    executionTarget: 'dev',
    correlationId: 'correlation-1',
    causationId: null,
    input,
  };
}

function activeTask(): Task {
  const input = createInput();
  return {
    taskId: 'task-existing',
    executionTarget: 'dev',
    accountId: input.accountId,
    envKey: input.envKey,
    platform: input.platform,
    taskDefinitionId: input.taskDefinition.id,
    taskDefinitionVersion: input.taskDefinition.version,
    currentRevisionId: 'revision-existing',
    capabilityScope: input.capabilityScope,
    constraints: input.parameters as Record<string, string[] | number>,
    budget: input.budget,
    schedule: input.schedule,
    authorizationRevision: 'auth-1',
    actorRef: 'customer:actor-1',
    status: 'active',
    correlationId: 'correlation-existing',
    aggregateVersion: 1,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

interface ServiceFakes {
  deps: ManagedTaskCommandServiceDeps;
  calls: { authorization: number; create: number; cancel: number; query: number };
  bundles: CreateTaskBundle[];
  task: Task | null;
  run: TaskRun | null;
  traces: DecisionTrace[];
}

function fakes(ids = ['task-1', 'revision-1', 'plan-1', 'run-1', 'trace-1']): ServiceFakes {
  const registry = createPhaseOneRegistry();
  const calls = { authorization: 0, create: 0, cancel: 0, query: 0 };
  const bundles: CreateTaskBundle[] = [];
  let idIndex = 0;
  const fake: ServiceFakes = {
    calls,
    bundles,
    task: null,
    run: null,
    traces: [],
    deps: {
      executionTarget: 'dev',
      flags: () => enabledFlags,
      readiness: () => ({ ready: true }),
      authorization: {
        async authorize() {
          calls.authorization += 1;
          return { allowed: true, authorizationRevision: 'auth-1' };
        },
      },
      registry,
      compiler: new PlanCompiler(registry),
      commandStore: {
        async createBundle(_target, bundle) {
          calls.create += 1;
          bundles.push(bundle);
          return { outcome: 'applied', receipt: bundle.receipt };
        },
        async cancelTask(_target, command) {
          calls.cancel += 1;
          return {
            outcome: 'applied',
            commandId: command.commandId,
            taskId: command.task.taskId,
            aggregateVersion: command.expectedAggregateVersion + 1,
            dispatchedAttemptReconciliationContinues: false,
          };
        },
      },
      taskStore: {
        async getTaskForAccount() {
          calls.query += 1;
          return fake.task;
        },
      },
      runStore: {
        async getLatestRunForTask() {
          return fake.run;
        },
      },
      traceStore: {
        async listByTask() {
          return fake.traces;
        },
      },
      now: () => 3000,
      newId: () => ids[idIndex++] ?? `extra-${idIndex}`,
    },
  };
  return fake;
}

test('feature flags require exact lowercase true and default to disabled', () => {
  assert.deepEqual(readManagedTaskFeatureFlags({}), {
    apiEnabled: false,
    createEnabled: false,
    workerEnabled: false,
    laneEnabled: false,
  });
  assert.deepEqual(readManagedTaskFeatureFlags({
    AIDCP_MANAGED_TASK_API_ENABLED: 'TRUE',
    AIDCP_MANAGED_TASK_CREATE_ENABLED: 'true',
    AIDCP_MANAGED_TASK_WORKER_ENABLED: '1',
    AIDCP_MANAGED_TASK_LANE_ENABLED: 'true',
  }), {
    apiEnabled: false,
    createEnabled: true,
    workerEnabled: false,
    laneEnabled: true,
  });
});

test('target mismatch rejects before authorization or owner reads', async () => {
  const fake = fakes();
  const service = new ManagedTaskCommandService(fake.deps);
  const request = envelope();
  request.executionTarget = 'ol';
  assert.deepEqual(await service.create(request), {
    outcome: 'rejected',
    code: 'execution_target_mismatch',
    message: 'request target does not match local Automation target',
  });
  assert.deepEqual(fake.calls, { authorization: 0, create: 0, cancel: 0, query: 0 });
});

test('create validates the hash and writes one atomic authority bundle', async () => {
  const fake = fakes();
  const service = new ManagedTaskCommandService(fake.deps);
  const result = await service.create(envelope());
  assert.deepEqual(result, {
    outcome: 'applied',
    commandId: 'command-create-1',
    taskId: 'task-1',
    runId: 'run-1',
    aggregateVersion: 1,
  });
  assert.equal(fake.calls.authorization, 1);
  assert.equal(fake.calls.create, 1);
  assert.equal(fake.bundles.length, 1);
  const bundle = fake.bundles[0]!;
  assert.deepEqual(bundle.plan.nodes.map((node) => node.capabilityId), PERSONA_RESEARCH_CAPABILITY_IDS);
  assert.equal(bundle.targetUnits, 3);
  assert.equal(bundle.trace.inputRefs.some((ref) => ref.includes('keywords')), false);
});

test('bad payload hash and stale authorization fail before command persistence', async () => {
  const badHash = fakes();
  const badInput = createInput();
  badInput.payloadHash = '0'.repeat(64);
  const badResult = await new ManagedTaskCommandService(badHash.deps).create(envelope(badInput));
  assert.equal(badResult.outcome, 'rejected');
  assert.equal(badHash.calls.authorization, 0);

  const stale = fakes();
  stale.deps.authorization = {
    async authorize() {
      stale.calls.authorization += 1;
      return { allowed: true, authorizationRevision: 'auth-new' };
    },
  };
  const staleResult = await new ManagedTaskCommandService(stale.deps).create(envelope());
  assert.deepEqual(staleResult, {
    outcome: 'rejected',
    code: 'account_not_authorized',
    message: 'actor/account authorization is absent or stale',
  });
  assert.equal(stale.calls.create, 0);
});

test('capability scope cannot silently weaken the mandatory research graph', async () => {
  const fake = fakes();
  const input = createInput();
  input.capabilityScope.allow = input.capabilityScope.allow.filter((id) => id !== 'research.assess');
  input.payloadHash = createCommandPayloadHash(input);
  const result = await new ManagedTaskCommandService(fake.deps).create(envelope(input));
  assert.deepEqual(result, {
    outcome: 'rejected',
    code: 'capability_scope_denied',
    message: 'task capability scope does not contain the registered plan',
  });
  assert.equal(fake.calls.create, 0);
});

test('cancel remains available when new creation is disabled', async () => {
  const fake = fakes(['cancel-revision-1', 'cancel-trace-1']);
  fake.task = activeTask();
  fake.deps.flags = () => ({ ...enabledFlags, createEnabled: false });
  const input = {
    commandId: 'command-cancel-1',
    payloadHash: '',
    actor: createInput().actor,
    accountId: 'account-1',
    taskId: 'task-existing',
    expectedAggregateVersion: 1,
    reason: 'operator requested stop',
  };
  input.payloadHash = cancelCommandPayloadHash(input);
  const result = await new ManagedTaskCommandService(fake.deps).cancel({
    contract: MANAGED_TASK_CONTRACT,
    executionTarget: 'dev',
    correlationId: 'correlation-cancel',
    causationId: null,
    input,
  });
  assert.equal(result.outcome, 'applied');
  assert.equal(fake.calls.cancel, 1);
});

test('query returns only the customer projection and redacted trace summary', async () => {
  const fake = fakes();
  fake.task = activeTask();
  fake.traces = [{
    traceId: 'trace-private',
    executionTarget: 'dev',
    correlationId: 'correlation-private',
    causationId: null,
    taskId: 'task-existing',
    runId: null,
    stepRunId: null,
    attemptId: null,
    decisionType: 'creation',
    outcome: 'allowed',
    reasonCode: 'succeeded',
    inputRefs: ['private:input-ref'],
    evidenceRefs: ['private:evidence-ref'],
    createdAt: 1000,
  }];
  const result = await new ManagedTaskCommandService(fake.deps).query({
    contract: MANAGED_TASK_CONTRACT,
    executionTarget: 'dev',
    correlationId: 'correlation-query',
    causationId: null,
    input: {
      requestId: 'request-1',
      actor: createInput().actor,
      accountId: 'account-1',
      taskId: 'task-existing',
    },
  });
  assert.equal(result.outcome, 'found');
  assert.equal(JSON.stringify(result).includes('private:'), false);
  if (result.outcome === 'found') {
    assert.deepEqual(result.task.trace, [{
      decisionType: 'creation',
      outcome: 'allowed',
      reasonCode: 'succeeded',
      createdAt: 1000,
    }]);
  }
});
