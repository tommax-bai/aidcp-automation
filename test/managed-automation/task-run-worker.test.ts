import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExecutionAttempt, ExecutionIntent } from '../../src/managed-automation/contracts/execution-attempt.js';
import type { ExecutionPlan } from '../../src/managed-automation/contracts/execution-plan.js';
import type { Task } from '../../src/managed-automation/contracts/task.js';
import type { RunStatus, StepRun, TaskRun } from '../../src/managed-automation/contracts/task-run.js';
import {
  StepExecutorRegistry,
  TaskRunWorker,
  type StepExecutionResult,
  type TaskRunWorkerOptions,
} from '../../src/managed-automation/engine/index.js';
import {
  ConnectionRuntimeResearchDispatchAdapter,
  ResearchStepExecutor,
  type AtomicResearchCommandChannel,
  type AtomicResearchReceipt,
  type ReadOnlyResearchCommand,
} from '../../src/managed-automation/execution/index.js';
import { createPhaseOneRegistry } from '../../src/managed-automation/registry/index.js';
import { PERSONA_RESEARCH_CAPABILITY_IDS } from '../../src/managed-automation/registry/persona-research.js';
import type { AccountWorkLane } from '../../src/managed-automation/stores/index.js';

function taskRun(status: RunStatus = 'queued'): TaskRun {
  return {
    runId: '00000000-0000-0000-0000-000000000101',
    executionTarget: 'dev',
    taskId: '00000000-0000-0000-0000-000000000102',
    taskRevisionId: '00000000-0000-0000-0000-000000000103',
    executionPlanId: '00000000-0000-0000-0000-000000000104',
    accountId: 'account-1',
    state: {
      status,
      waitReason: status === 'waiting' ? 'waiting_for_account_lane' : null,
      terminalOutcome: status === 'terminal' ? 'succeeded' : null,
      reasonCode: null,
    },
    progress: { confirmedUnits: 0, targetUnits: null, lastCheckpointRef: null },
    currentNodeId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    attemptCount: 0,
    version: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
    terminalAt: null,
  };
}

function plan(nodeCount = 2): ExecutionPlan {
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({
    nodeId: `node-${index + 1}`,
    capabilityId: 'research.search' as const,
    capabilityVersion: 1,
    inputBindingRef: `input:${index + 1}`,
  }));
  return {
    executionPlanId: '00000000-0000-0000-0000-000000000104',
    executionTarget: 'dev',
    taskId: '00000000-0000-0000-0000-000000000102',
    taskRevisionId: '00000000-0000-0000-0000-000000000103',
    taskDefinitionId: 'persona.research',
    taskDefinitionVersion: 1,
    authorizationRevision: 'auth-1',
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      kind: 'linear' as const,
      from: nodes[index]!.nodeId,
      to: node.nodeId,
    })),
    entryNodeId: nodes[0]!.nodeId,
    bounds: { maxNodes: nodeCount, maxExecutionAttempts: 2, maxWallClockMs: 60_000 },
    completionConditionRef: 'completion:persona.research@1',
    planHash: 'a'.repeat(64),
    compiledAt: 1_000,
  };
}

function lane(version = 1): AccountWorkLane {
  return {
    executionTarget: 'dev',
    accountId: 'account-1',
    ownerKind: 'managed',
    managedRunId: '00000000-0000-0000-0000-000000000101',
    leaseOwner: 'worker-1',
    leaseExpiresAt: 61_000,
    inFlightEvidence: [],
    version,
    updatedAt: 1_000,
  };
}

class Harness {
  run = taskRun();
  readonly plan = plan();
  readonly steps = new Map<string, StepRun>();
  readonly intents = new Map<string, ExecutionIntent>();
  readonly attempts: ExecutionAttempt[] = [];
  readonly laneCalls: string[] = [];
  executorCalls = 0;
  claimCalls = 0;
  cancellationClaim = false;
  laneBusy = false;
  behavior: (call: number, signal: AbortSignal) => StepExecutionResult | Promise<StepExecutionResult> = () => ({
    status: 'completed',
    reasonCode: 'succeeded',
    evidence: {
      evidenceRef: 'evidence:shared',
      stableContentRefs: ['facebook:post:1', 'facebook:post:1'],
      postconditionRef: 'postcondition:shared',
    },
  });

  readonly runState = {
    claimNextRun: async () => {
      this.claimCalls += 1;
      if (this.run.state.status !== 'queued' && this.run.state.status !== 'waiting') return null;
      this.run = {
        ...this.run,
        state: { status: 'running' as const, waitReason: null, terminalOutcome: null, reasonCode: null },
        leaseOwner: 'worker-1', leaseExpiresAt: 61_000,
        version: this.run.version + 1,
      };
      return this.run;
    },
    claimNextCancellation: async () => {
      if (!this.cancellationClaim || this.run.state.status !== 'cancel_requested') return null;
      this.cancellationClaim = false;
      this.run = { ...this.run, leaseOwner: 'worker-1', leaseExpiresAt: 61_000, version: this.run.version + 1 };
      return this.run;
    },
    renewRunLease: async () => null,
    getRun: async (_target: 'dev' | 'ol', runId: string) => runId === this.run.runId ? this.run : null,
    transitionRun: async (
      _target: 'dev' | 'ol', runId: string, version: number, status: RunStatus,
      next: Parameters<TaskRunWorkerOptions['runState']['transitionRun']>[4],
    ) => {
      if (runId !== this.run.runId || version !== this.run.version || status !== this.run.state.status) return false;
      this.run = {
        ...this.run,
        state: next.state,
        progress: next.progress,
        currentNodeId: next.currentNodeId,
        attemptCount: this.run.attemptCount + (next.incrementAttemptCount === true ? 1 : 0),
        leaseOwner: next.state.status === 'running' ? this.run.leaseOwner : null,
        leaseExpiresAt: next.state.status === 'running' ? this.run.leaseExpiresAt : null,
        version: this.run.version + 1,
      };
      return true;
    },
    insertStep: async (_target: 'dev' | 'ol', input: {
      stepRunId: string; runId: string; nodeId: string;
      capabilityId: 'research.search'; capabilityVersion: number; targetUnits: number | null;
    }) => {
      if ([...this.steps.values()].some((step) => step.nodeId === input.nodeId)) return false;
      this.steps.set(input.stepRunId, {
        ...input,
        executionTarget: 'dev',
        state: { status: 'queued', waitReason: null, terminalOutcome: null, reasonCode: null },
        progress: { confirmedUnits: 0, targetUnits: input.targetUnits, lastCheckpointRef: null },
        attemptCount: 0,
        version: 1,
        startedAt: null,
        updatedAt: 1_000,
        terminalAt: null,
      });
      return true;
    },
    getStep: async (_target: 'dev' | 'ol', stepRunId: string) => this.steps.get(stepRunId) ?? null,
    listStepsByRun: async () => [...this.steps.values()],
    transitionStep: async (
      _target: 'dev' | 'ol', stepRunId: string, version: number, status: RunStatus,
      next: Parameters<TaskRunWorkerOptions['runState']['transitionStep']>[4],
    ) => {
      const step = this.steps.get(stepRunId);
      if (!step || step.version !== version || step.state.status !== status) return false;
      this.steps.set(stepRunId, {
        ...step,
        state: next.state,
        progress: next.progress,
        attemptCount: step.attemptCount + (next.incrementAttemptCount === true ? 1 : 0),
        version: step.version + 1,
      });
      return true;
    },
  };

  readonly authority = { getPlan: async () => this.plan };

  readonly ledger = {
    getIntentByIdempotencyKey: async (_target: 'dev' | 'ol', key: string) => this.intents.get(key) ?? null,
    insertIntent: async (_target: 'dev' | 'ol', input: Omit<ExecutionIntent, 'createdAt'>) => {
      const intent = { ...input, createdAt: 1_000 };
      this.intents.set(input.idempotencyKey, intent);
      return { outcome: 'inserted' as const, intent };
    },
    insertAttempt: async (_target: 'dev' | 'ol', input: {
      attemptId: string; intentId: string; runId: string; stepRunId: string; ordinal: number;
    }) => {
      if (this.attempts.some((attempt) => attempt.attemptId === input.attemptId)) return false;
      this.attempts.push({
        ...input,
        executionTarget: 'dev',
        status: 'prepared', reasonCode: null, evidence: null,
        strongestProgressEvidenceRef: null, reconciliationCount: 0,
        preparedAt: 1_000, dispatchedAt: null, settledAt: null,
      });
      return true;
    },
    listAttemptsByIntent: async (_target: 'dev' | 'ol', intentId: string) =>
      this.attempts.filter((attempt) => attempt.intentId === intentId),
    listAttemptsByRun: async () => this.attempts,
    transitionAttempt: async (
      _target: 'dev' | 'ol', attemptId: string, expected: ExecutionAttempt['status'],
      next: Parameters<TaskRunWorkerOptions['ledger']['transitionAttempt']>[3],
    ) => {
      const index = this.attempts.findIndex((attempt) => attempt.attemptId === attemptId);
      const attempt = this.attempts[index];
      if (!attempt || attempt.status !== expected) return false;
      this.attempts[index] = { ...attempt, ...next };
      return true;
    },
  };

  readonly lanes = {
    acquireManaged: async () => this.laneBusy
      ? {
        outcome: 'waiting' as const,
        reason: 'account_lane_busy' as const,
        legacySnapshot: null,
        lane: lane(),
      }
      : { outcome: 'acquired' as const, lane: lane() },
    renewManaged: async () => lane(2),
    retainManagedForShutdown: async () => { this.laneCalls.push('retain'); return true; },
    releaseManaged: async () => { this.laneCalls.push('release'); return 'released' as const; },
  };

  worker(overrides: Partial<TaskRunWorkerOptions> = {}): TaskRunWorker {
    const executor = {
      supports: () => true,
      execute: async (request: { signal: AbortSignal }) => {
        this.executorCalls += 1;
        return this.behavior(this.executorCalls, request.signal);
      },
    };
    return new TaskRunWorker({
      executionTarget: 'dev',
      runState: this.runState,
      authority: this.authority,
      ledger: this.ledger,
      lanes: this.lanes,
      executors: new StepExecutorRegistry([executor]),
      flags: { workerEnabled: () => true },
      ready: () => true,
      workerId: 'worker-1',
      leaseMs: 60_000,
      renewIntervalMs: 30_000,
      waitingRetryMs: 0,
      maxRunsPerTick: 1,
      now: () => 1_000,
      logger: { info() {}, warn() {}, error() {} },
      ...overrides,
    });
  }
}

function researchTask(): Task {
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
    constraints: { keywords: ['coffee'], maxItems: 3 },
    budget: { maxBrowserMinutes: 10, maxSteps: 4, maxExecutionAttempts: 2, maxWaitMs: 60_000 },
    schedule: { scheduledAt: 1_000, latestStartAt: 60_000, missPolicy: 'execute_when_available' },
    authorizationRevision: 'auth-1',
    actorRef: 'customer:1',
    status: 'active',
    correlationId: 'correlation-task-1',
    aggregateVersion: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

class VerticalResearchChannel implements AtomicResearchCommandChannel {
  connected = false;
  generation = 'generation-1';
  outcome: 'completed' | 'empty' | 'none' = 'completed';
  readonly sent: ReadOnlyResearchCommand[] = [];
  private receive: ((receipt: AtomicResearchReceipt) => void) | null = null;

  target() {
    return this.connected ? {
      connectionGeneration: this.generation,
      edgeId: 'ads-env-1',
      accountId: 'account-1',
      platform: 'facebook' as const,
      capabilities: ['managed_research_search_v1'],
    } : null;
  }

  subscribeReceipt(
    _target: NonNullable<ReturnType<VerticalResearchChannel['target']>>,
    _attemptId: string,
    receive: (receipt: AtomicResearchReceipt) => void,
  ): () => void {
    this.receive = receive;
    return () => { this.receive = null; };
  }

  sendAtomic(
    target: NonNullable<ReturnType<VerticalResearchChannel['target']>>,
    command: ReadOnlyResearchCommand,
  ): { outcome: 'dispatched' } {
    this.sent.push(command);
    if (this.outcome === 'none') return { outcome: 'dispatched' };
    const stableContentRefs = this.outcome === 'completed'
      ? ['facebook:post:1', 'facebook:post:1'] : [];
    this.receive?.({
      executionTarget: command.executionTarget,
      accountId: command.accountId,
      attemptId: command.attemptId,
      edgeId: target.edgeId,
      connectionGeneration: target.connectionGeneration,
      capabilityId: command.capabilityId,
      capabilityVersion: command.capabilityVersion,
      status: this.outcome,
      reasonCode: this.outcome === 'completed' ? 'succeeded' : 'empty_result',
      evidence: {
        evidenceRef: `evidence:${command.attemptId}`,
        stableContentRefs,
        postconditionRef: `postcondition:${command.capabilityId}@${command.capabilityVersion}:page-1`,
      },
    } as AtomicResearchReceipt);
    return { outcome: 'dispatched' };
  }
}

function verticalExecutors(
  channel: VerticalResearchChannel,
  traces: Array<{ reasonCode: string }>,
  now: () => number = () => 1_000,
): StepExecutorRegistry {
  const dispatch = new ConnectionRuntimeResearchDispatchAdapter({
    targets: { managedTaskTargetFor: () => channel.target() },
    commands: channel,
    now,
  });
  const executor = new ResearchStepExecutor({
    dispatch,
    tasks: { getTask: async () => researchTask() },
    traces: {
      append: async (_target, trace) => {
        traces.push({ reasonCode: trace.reasonCode });
        return true;
      },
    },
    registry: createPhaseOneRegistry(),
    now,
    newTraceId: () => '00000000-0000-0000-0000-000000000999',
  });
  return new StepExecutorRegistry([executor]);
}

test('default-off and not-ready gates perform no durable claim', async () => {
  const disabled = new Harness();
  assert.deepEqual(await disabled.worker({ flags: { workerEnabled: () => false } }).tick(), {
    outcome: 'disabled', claimed: 0,
  });
  assert.equal(disabled.claimCalls, 0);

  const notReady = new Harness();
  assert.deepEqual(await notReady.worker({ ready: () => false }).tick(), {
    outcome: 'not_ready', claimed: 0,
  });
  assert.equal(notReady.claimCalls, 0);
});

test('lane contention checkpoints waiting and dispatches no executor', async () => {
  const harness = new Harness();
  harness.laneBusy = true;
  assert.deepEqual(await harness.worker().tick(), { outcome: 'processed', claimed: 1 });
  assert.equal(harness.run.state.status, 'waiting');
  assert.equal(harness.run.state.waitReason, 'waiting_for_account_lane');
  assert.equal(harness.executorCalls, 0);
});

test('worker-executor-connection vertical slice waits offline, re-resolves reconnect, and dedupes evidence', async () => {
  const harness = new Harness();
  harness.plan.nodes.splice(1);
  harness.plan.edges.splice(0);
  harness.plan.bounds.maxNodes = 1;
  const channel = new VerticalResearchChannel();
  const traces: Array<{ reasonCode: string }> = [];
  const worker = harness.worker({ executors: verticalExecutors(channel, traces) });

  await worker.tick();
  assert.equal(harness.run.state.status, 'waiting');
  assert.equal(harness.run.state.waitReason, 'waiting_for_edge');
  assert.deepEqual(harness.attempts.map((attempt) => attempt.status), ['undeliverable']);
  assert.deepEqual(channel.sent, []);
  assert.deepEqual(harness.laneCalls, ['release']);

  channel.connected = true;
  channel.generation = 'generation-2';
  await worker.tick();
  assert.equal(channel.sent.length, 1, 'reconnect creates one new bounded Attempt, not a replay of the first');
  assert.deepEqual(harness.attempts.map((attempt) => attempt.status), ['undeliverable', 'completed']);
  assert.equal(harness.run.state.terminalOutcome, 'succeeded');
  assert.equal(harness.run.progress.confirmedUnits, 1);
  assert.deepEqual(traces, [{ reasonCode: 'waiting_for_edge' }, { reasonCode: 'duplicate_evidence' }]);
  assert.deepEqual(harness.laneCalls, ['release', 'release']);
});

test('worker-executor-connection vertical slice preserves a proven empty result', async () => {
  const harness = new Harness();
  harness.plan.nodes.splice(1);
  harness.plan.edges.splice(0);
  harness.plan.bounds.maxNodes = 1;
  const channel = new VerticalResearchChannel();
  channel.connected = true;
  channel.outcome = 'empty';
  const worker = harness.worker({ executors: verticalExecutors(channel, []) });

  await worker.tick();
  assert.equal(harness.attempts[0]?.status, 'empty');
  assert.equal(harness.run.state.status, 'terminal');
  assert.equal(harness.run.state.terminalOutcome, 'skipped');
  assert.equal(harness.run.progress.confirmedUnits, 0);
  assert.deepEqual(harness.laneCalls, ['release']);
});

test('worker-executor-connection vertical slice keeps a post-dispatch timeout submitted-unknown', async () => {
  const harness = new Harness();
  harness.plan.nodes.splice(1);
  harness.plan.edges.splice(0);
  harness.plan.bounds.maxNodes = 1;
  harness.plan.bounds.maxWallClockMs = 50;
  harness.run = { ...harness.run, createdAt: Date.now() };
  const channel = new VerticalResearchChannel();
  channel.connected = true;
  channel.outcome = 'none';
  const worker = harness.worker({
    executors: verticalExecutors(channel, [], Date.now),
    now: Date.now,
  });

  await worker.tick();
  assert.equal(channel.sent.length, 1);
  assert.equal(harness.attempts[0]?.status, 'submitted_unknown');
  assert.equal(harness.run.state.waitReason, 'waiting_for_reconciliation');
  assert.deepEqual(harness.laneCalls, ['retain']);
});

test('linear execution retries within bounds and dedupes stable content references', async () => {
  const harness = new Harness();
  harness.behavior = (call) => call === 1
    ? { status: 'failed', reasonCode: 'execution_failed', evidence: null }
    : {
      status: 'completed',
      reasonCode: 'succeeded',
      evidence: {
        evidenceRef: `evidence:${call}`,
        stableContentRefs: ['facebook:post:1', 'facebook:post:1'],
        postconditionRef: `postcondition:${call}`,
      },
    };
  await harness.worker().tick();
  assert.equal(harness.executorCalls, 3, 'first node retries once; second executes once');
  assert.deepEqual(harness.attempts.map((attempt) => attempt.status), ['failed', 'completed', 'completed']);
  assert.equal(harness.run.state.status, 'terminal');
  assert.equal(harness.run.state.terminalOutcome, 'succeeded');
  assert.equal(harness.run.progress.confirmedUnits, 1, 'duplicate refs across steps count once');
  assert.deepEqual(harness.laneCalls, ['release']);
});

test('submitted-unknown waits with lane retention and recovery never re-dispatches it', async () => {
  const harness = new Harness();
  harness.behavior = () => ({ status: 'submitted_unknown', reasonCode: 'result_unknown', evidence: null });
  await harness.worker().tick();
  assert.equal(harness.executorCalls, 1);
  assert.equal(harness.run.state.waitReason, 'waiting_for_reconciliation');
  assert.deepEqual(harness.laneCalls, ['retain']);

  await harness.worker().tick();
  assert.equal(harness.executorCalls, 1, 'durable unknown receipt is never inferred safe to retry');
  assert.equal(harness.run.state.waitReason, 'waiting_for_reconciliation');
  assert.deepEqual(harness.laneCalls, ['retain', 'retain']);
});

test('kill switch stops subsequent steps, safely releases, and resumes from the durable checkpoint', async () => {
  const harness = new Harness();
  let enabled = true;
  let announceDispatched!: () => void;
  const dispatched = new Promise<void>((resolve) => { announceDispatched = resolve; });
  let settle!: (result: StepExecutionResult) => void;
  harness.behavior = (call) => call === 1
    ? new Promise<StepExecutionResult>((resolve) => {
      settle = resolve;
      announceDispatched();
    })
    : {
      status: 'completed',
      reasonCode: 'succeeded',
      evidence: {
        evidenceRef: `evidence:${call}`,
        stableContentRefs: [`facebook:post:${call}`],
        postconditionRef: `postcondition:${call}`,
      },
    };
  const worker = harness.worker({ flags: { workerEnabled: () => enabled } });
  const activeTick = worker.tick();
  await dispatched;
  enabled = false;
  assert.deepEqual(await worker.tick(), { outcome: 'disabled', claimed: 0 });
  assert.deepEqual(harness.laneCalls, [], 'an in-flight Attempt keeps the account exclusion');

  settle({
    status: 'completed',
    reasonCode: 'succeeded',
    evidence: {
      evidenceRef: 'evidence:1',
      stableContentRefs: ['facebook:post:1'],
      postconditionRef: 'postcondition:1',
    },
  });
  await activeTick;
  assert.equal(harness.executorCalls, 1);
  assert.equal(harness.run.state.status, 'waiting');
  assert.equal(harness.run.state.waitReason, 'waiting_until');
  assert.deepEqual(harness.laneCalls, ['release']);

  enabled = true;
  await worker.tick();
  assert.equal(harness.executorCalls, 2, 'completed first step is checkpointed and not replayed');
  assert.equal(harness.run.state.terminalOutcome, 'succeeded');
  assert.deepEqual(harness.laneCalls, ['release', 'release']);
});

test('claimed cancellation terminalizes before dispatch and releases its durable lane', async () => {
  const harness = new Harness();
  harness.run = taskRun('cancel_requested');
  harness.cancellationClaim = true;
  await harness.worker().tick();
  assert.equal(harness.executorCalls, 0);
  assert.equal(harness.run.state.status, 'terminal');
  assert.equal(harness.run.state.terminalOutcome, 'cancelled');
  assert.deepEqual(harness.laneCalls, ['release']);
});

test('graceful shutdown stops new work and retains a dispatching attempt without inventing a result', async () => {
  const harness = new Harness();
  harness.plan.nodes.splice(1);
  harness.plan.edges.splice(0);
  harness.plan.bounds.maxNodes = 1;
  let announceStarted!: () => void;
  const started = new Promise<void>((resolve) => { announceStarted = resolve; });
  let settle!: (result: StepExecutionResult) => void;
  harness.behavior = () => new Promise<StepExecutionResult>((resolve) => {
    settle = resolve;
    announceStarted();
  });
  const worker = harness.worker();
  const tick = worker.tick();
  await started;
  await worker.stop();
  assert.deepEqual(harness.laneCalls, ['retain']);
  assert.equal(harness.attempts[0]?.status, 'dispatching');

  settle({ status: 'aborted', reasonCode: 'execution_failed', evidence: null });
  await tick;
  assert.equal(harness.attempts[0]?.status, 'dispatching', 'shutdown preserves ambiguous dispatch truth');
  assert.equal(harness.executorCalls, 1);
});
