import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DecisionTrace } from '../../src/managed-automation/contracts/decision-trace.js';
import type { ReadEvidence } from '../../src/managed-automation/contracts/execution-attempt.js';
import type { Task } from '../../src/managed-automation/contracts/task.js';
import type { StepExecutionRequest } from '../../src/managed-automation/engine/step-executor.js';
import {
  ResearchStepExecutor,
  type ReadOnlyResearchCommand,
  type ResearchDispatchOutcome,
} from '../../src/managed-automation/execution/index.js';
import { createPhaseOneRegistry } from '../../src/managed-automation/registry/index.js';
import { PERSONA_RESEARCH_CAPABILITY_IDS } from '../../src/managed-automation/registry/persona-research.js';

function task(overrides: Partial<Task> = {}): Task {
  return {
    taskId: '00000000-0000-0000-0000-000000000102',
    executionTarget: 'dev',
    accountId: 'account-1',
    envKey: 'env-1',
    platform: 'facebook',
    taskDefinitionId: 'persona.research',
    taskDefinitionVersion: 1,
    currentRevisionId: '00000000-0000-0000-0000-000000000103',
    capabilityScope: { allow: [...PERSONA_RESEARCH_CAPABILITY_IDS], deny: [] },
    constraints: { keywords: ['coffee', 'coffee', 'travel'], maxItems: 3 },
    budget: { maxBrowserMinutes: 10, maxSteps: 4, maxExecutionAttempts: 3, maxWaitMs: 60_000 },
    schedule: { scheduledAt: 1_000, latestStartAt: 60_000, missPolicy: 'skip' },
    authorizationRevision: 'auth-1',
    actorRef: 'customer:1',
    status: 'active',
    correlationId: 'correlation-task-1',
    aggregateVersion: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function request(capabilityId = 'research.search'): StepExecutionRequest {
  return {
    executionTarget: 'dev',
    accountId: 'account-1',
    taskId: '00000000-0000-0000-0000-000000000102',
    runId: '00000000-0000-0000-0000-000000000101',
    stepRunId: '00000000-0000-0000-0000-000000000105',
    attemptId: '00000000-0000-0000-0000-000000000106',
    idempotencyKey: 'managed-task/run-1/node-1',
    node: {
      nodeId: capabilityId.slice('research.'.length),
      capabilityId,
      capabilityVersion: 1,
      inputBindingRef: 'bind:persona.research@1/search',
    },
    inputRef: 'bind:persona.research@1/search',
    deadlineAt: 60_000,
    correlationId: 'managed-task:run-1:node-1',
    knownStableContentRefs: ['facebook:post:known'],
    signal: new AbortController().signal,
  };
}

function evidence(
  capabilityId: string,
  refs: string[],
  overrides: Partial<ReadEvidence> = {},
): ReadEvidence {
  return {
    evidenceRef: `evidence:${capabilityId}:attempt-1`,
    stableContentRefs: refs,
    postconditionRef: `postcondition:${capabilityId}@1:page-snapshot-1`,
    ...overrides,
  };
}

class Harness {
  currentTask: Task | null = task();
  readonly traces: Array<Omit<DecisionTrace, 'createdAt'>> = [];
  readonly commands: ReadOnlyResearchCommand[] = [];
  outcome: ResearchDispatchOutcome = {
    executionTarget: 'dev',
    accountId: 'account-1',
    attemptId: '00000000-0000-0000-0000-000000000106',
    status: 'completed',
    reasonCode: 'succeeded',
    evidence: evidence('research.search', ['facebook:post:1']),
  };
  thrown: Error | null = null;

  readonly executor = new ResearchStepExecutor({
    dispatch: {
      dispatchReadOnly: async (command) => {
        this.commands.push(command);
        if (this.thrown) throw this.thrown;
        return this.outcome;
      },
    },
    tasks: { getTask: async () => this.currentTask },
    traces: {
      append: async (_target, trace) => {
        this.traces.push(trace);
        return true;
      },
    },
    registry: createPhaseOneRegistry(),
    now: () => 2_000,
    newTraceId: () => `00000000-0000-0000-0000-${String(this.traces.length + 1).padStart(12, '0')}`,
  });
}

test('supports exactly the four registered read-only capability versions', () => {
  const harness = new Harness();
  for (const capabilityId of PERSONA_RESEARCH_CAPABILITY_IDS) {
    assert.equal(harness.executor.supports(capabilityId, 1), true);
    assert.equal(harness.executor.supports(capabilityId, 2), false);
  }
  assert.equal(harness.executor.supports('publish.submit', 1), false);
  assert.equal(harness.executor.supports('research.unregistered', 1), false);
});

test('completed receipt is exact-target bound, normalizes duplicate refs, and traces prior evidence reuse', async () => {
  const harness = new Harness();
  harness.outcome = {
    executionTarget: 'dev',
    accountId: 'account-1',
    attemptId: '00000000-0000-0000-0000-000000000106',
    status: 'completed',
    reasonCode: 'succeeded',
    evidence: evidence('research.search', [
      'facebook:post:1',
      'facebook:post:1',
      'facebook:post:known',
    ]),
  };
  const result = await harness.executor.execute(request());
  assert.deepEqual(result, {
    status: 'completed',
    reasonCode: 'succeeded',
    evidence: evidence('research.search', ['facebook:post:1', 'facebook:post:known']),
  });
  assert.equal(harness.commands.length, 1);
  assert.deepEqual(harness.commands[0], {
    commandKind: 'managed.research.read',
    commandId: '00000000-0000-0000-0000-000000000106',
    executionTarget: 'dev',
    accountId: 'account-1',
    envKey: 'env-1',
    platform: 'facebook',
    taskId: '00000000-0000-0000-0000-000000000102',
    runId: '00000000-0000-0000-0000-000000000101',
    stepRunId: '00000000-0000-0000-0000-000000000105',
    attemptId: '00000000-0000-0000-0000-000000000106',
    capabilityId: 'research.search',
    capabilityVersion: 1,
    inputRef: 'bind:persona.research@1/search',
    idempotencyKey: 'managed-task/run-1/node-1',
    correlationId: 'managed-task:run-1:node-1',
    params: { keywords: ['coffee', 'travel'], maxItems: 3 },
  });
  assert.equal(harness.traces.length, 1);
  assert.equal(harness.traces[0]?.decisionType, 'evidence');
  assert.equal(harness.traces[0]?.reasonCode, 'duplicate_evidence');
  assert.deepEqual(harness.traces[0]?.inputRefs, ['facebook:post:1', 'facebook:post:known']);
});

test('empty is distinct from failed and requires an exact capability postcondition', async () => {
  const harness = new Harness();
  harness.outcome = {
    ...harness.outcome,
    status: 'empty',
    reasonCode: 'empty_result',
    evidence: evidence('research.search', []),
  };
  assert.deepEqual(await harness.executor.execute(request()), {
    status: 'empty', reasonCode: 'empty_result', evidence: evidence('research.search', []),
  });
  assert.equal(harness.traces.length, 0);

  harness.outcome = {
    ...harness.outcome,
    evidence: evidence('research.search', [], { postconditionRef: 'postcondition:research.browse@1:wrong' }),
  };
  assert.deepEqual(await harness.executor.execute(request()), {
    status: 'submitted_unknown', reasonCode: 'result_unknown', evidence: null,
  });
  assert.equal(harness.traces.at(-1)?.reasonCode, 'evidence_invalid');
});

test('negative dispatch receipts stay distinct and each execute performs one bounded attempt', async () => {
  const cases: Array<{
    status: 'submitted_unknown' | 'failed' | 'timeout' | 'undeliverable' | 'aborted' | 'unsupported';
    reasonCode: ResearchDispatchOutcome['reasonCode'];
  }> = [
    { status: 'submitted_unknown', reasonCode: 'result_unknown' },
    { status: 'failed', reasonCode: 'execution_failed' },
    { status: 'timeout', reasonCode: 'execution_timeout' },
    { status: 'undeliverable', reasonCode: 'waiting_for_edge' },
    { status: 'aborted', reasonCode: 'execution_failed' },
    { status: 'unsupported', reasonCode: 'unsupported' },
  ];
  for (const item of cases) {
    const harness = new Harness();
    harness.outcome = {
      executionTarget: 'dev', accountId: 'account-1',
      attemptId: '00000000-0000-0000-0000-000000000106',
      status: item.status,
      reasonCode: item.reasonCode,
      evidence: null,
    } as ResearchDispatchOutcome;
    assert.deepEqual(await harness.executor.execute(request()), { ...item, evidence: null });
    assert.equal(harness.commands.length, 1);
    assert.equal(harness.traces.length, 1);
  }
});

test('throw or receipt-binding drift becomes submitted-unknown without an internal retry', async () => {
  const thrown = new Harness();
  thrown.thrown = new Error('socket closed after send');
  assert.deepEqual(await thrown.executor.execute(request()), {
    status: 'submitted_unknown', reasonCode: 'result_unknown', evidence: null,
  });
  assert.equal(thrown.commands.length, 1);
  assert.equal(thrown.traces[0]?.decisionType, 'reconciliation');

  const drift = new Harness();
  drift.outcome = { ...drift.outcome, accountId: 'account-other' };
  assert.deepEqual(await drift.executor.execute(request()), {
    status: 'submitted_unknown', reasonCode: 'result_unknown', evidence: null,
  });
  assert.equal(drift.commands.length, 1);
});

test('authority, cancellation, deadline, and evidence gates reject before or after dispatch honestly', async () => {
  const missing = new Harness();
  missing.currentTask = null;
  assert.deepEqual(await missing.executor.execute(request()), {
    status: 'failed', reasonCode: 'contract_invalid', evidence: null,
  });
  assert.equal(missing.commands.length, 0);

  const cancelled = new Harness();
  cancelled.currentTask = task({ status: 'cancelled' });
  assert.deepEqual(await cancelled.executor.execute(request()), {
    status: 'aborted', reasonCode: 'cancelled_by_actor', evidence: null,
  });
  assert.equal(cancelled.commands.length, 0);

  const expired = new Harness();
  assert.deepEqual(await expired.executor.execute({ ...request(), deadlineAt: 2_000 }), {
    status: 'timeout', reasonCode: 'deadline_exceeded', evidence: null,
  });
  assert.equal(expired.commands.length, 0);

  const malformed = new Harness();
  malformed.outcome = {
    executionTarget: 'dev',
    accountId: 'account-1',
    attemptId: '00000000-0000-0000-0000-000000000106',
    status: 'completed',
    reasonCode: 'succeeded',
    evidence: evidence('research.search', ['unstable ref with spaces']),
  };
  assert.deepEqual(await malformed.executor.execute(request()), {
    status: 'submitted_unknown', reasonCode: 'result_unknown', evidence: null,
  });
  assert.equal(malformed.commands.length, 1);
  assert.equal(malformed.traces[0]?.reasonCode, 'evidence_invalid');
});
