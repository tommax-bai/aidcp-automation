import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { JsonValue } from '../../src/managed-automation/contracts/common.js';
import type { DecisionTrace } from '../../src/managed-automation/contracts/decision-trace.js';
import type { Task } from '../../src/managed-automation/contracts/task.js';
import type { TaskRun } from '../../src/managed-automation/contracts/task-run.js';
import {
  ContractValidationError,
  canTransitionAttemptStatus,
  canTransitionRunStatus,
  canonicalJson,
  isOrthogonalRunStateValid,
  payloadHash,
  projectCustomerDecisionTrace,
  projectCustomerTask,
  requireContractVersion,
  requireExecutionTarget,
} from '../../src/managed-automation/contracts/index.js';

const baseTask: Task = {
  taskId: 'task-1',
  executionTarget: 'dev',
  accountId: 'account-1',
  envKey: 'env-1',
  platform: 'facebook',
  taskDefinitionId: 'persona.research',
  taskDefinitionVersion: 1,
  currentRevisionId: 'revision-1',
  capabilityScope: { allow: ['content.search'], deny: [] },
  constraints: { privatePrompt: 'must-not-leak' },
  budget: { maxBrowserMinutes: 10, maxSteps: 4, maxExecutionAttempts: 4, maxWaitMs: 60_000 },
  schedule: { scheduledAt: 1, latestStartAt: 2, missPolicy: 'skip' },
  authorizationRevision: 'auth-secret-ref',
  actorRef: 'actor-secret-ref',
  status: 'active',
  correlationId: 'correlation-secret-ref',
  aggregateVersion: 1,
  createdAt: 1,
  updatedAt: 2,
};

const waitingRun: TaskRun = {
  runId: 'run-1',
  executionTarget: 'dev',
  taskId: 'task-1',
  taskRevisionId: 'revision-1',
  executionPlanId: 'plan-1',
  accountId: 'account-1',
  state: {
    status: 'waiting',
    waitReason: 'waiting_for_account_lane',
    terminalOutcome: null,
    reasonCode: 'waiting_for_account_lane',
  },
  progress: { confirmedUnits: 3, targetUnits: 10, lastCheckpointRef: 'private-checkpoint' },
  currentNodeId: 'browse',
  leaseOwner: null,
  leaseExpiresAt: null,
  attemptCount: 0,
  version: 1,
  createdAt: 2,
  updatedAt: 3,
  terminalAt: null,
};

describe('managed automation contract helpers', () => {
  it('canonicalizes object keys recursively and hashes the canonical payload', () => {
    const left: JsonValue = { z: 1, nested: { b: true, a: ['x', { d: 4, c: 3 }] } };
    const right: JsonValue = { nested: { a: ['x', { c: 3, d: 4 }], b: true }, z: 1 };
    assert.equal(canonicalJson(left), canonicalJson(right));
    assert.equal(payloadHash(left), payloadHash(right));
    assert.notEqual(payloadHash(left), payloadHash({ z: 2 }));
  });

  it('accepts only the exact contract version and deployment target', () => {
    assert.deepEqual(requireContractVersion({ name: 'managed-task', version: 1 }, 'managed-task', 1), {
      name: 'managed-task', version: 1,
    });
    assert.equal(requireExecutionTarget('dev'), 'dev');
    assert.throws(
      () => requireContractVersion({ name: 'managed-task', version: 2 }, 'managed-task', 1),
      (error) => error instanceof ContractValidationError && error.code === 'protocol_version_mismatch',
    );
    assert.throws(
      () => requireExecutionTarget('staging'),
      (error) => error instanceof ContractValidationError && error.code === 'execution_target_mismatch',
    );
  });

  it('enforces orthogonal run states and terminal monotonicity', () => {
    assert.equal(isOrthogonalRunStateValid(waitingRun.state), true);
    assert.equal(isOrthogonalRunStateValid({ ...waitingRun.state, waitReason: null }), false);
    assert.equal(canTransitionRunStatus('running', 'waiting'), true);
    assert.equal(canTransitionRunStatus('terminal', 'running'), false);
    assert.equal(canTransitionAttemptStatus('dispatching', 'submitted_unknown'), true);
    assert.equal(canTransitionAttemptStatus('completed', 'failed'), false);
  });

  it('projects task and trace summaries without private refs or inputs', () => {
    const summary = projectCustomerTask(baseTask, waitingRun);
    assert.equal(summary.state, 'waiting_for_lane');
    assert.equal(summary.confirmedUnits, 3);
    const serializedTask = JSON.stringify(summary);
    assert.doesNotMatch(serializedTask, /must-not-leak|auth-secret|actor-secret|correlation-secret|private-checkpoint/);

    const trace: DecisionTrace = {
      traceId: 'trace-private-id',
      executionTarget: 'dev',
      correlationId: 'correlation-private',
      causationId: null,
      taskId: 'task-1',
      runId: 'run-1',
      stepRunId: 'step-1',
      attemptId: null,
      decisionType: 'lane_admission',
      outcome: 'delayed',
      reasonCode: 'waiting_for_account_lane',
      inputRefs: ['raw-private-input'],
      evidenceRefs: ['raw-private-evidence'],
      createdAt: 4,
    };
    const traceSummary = projectCustomerDecisionTrace(trace);
    assert.deepEqual(traceSummary, {
      decisionType: 'lane_admission',
      outcome: 'delayed',
      reasonCode: 'waiting_for_account_lane',
      createdAt: 4,
    });
  });
});
