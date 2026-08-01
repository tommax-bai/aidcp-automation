import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import type { SchemaShape } from 'aidcp-kernel/kernel/schema-capability-contract.js';
import { SchemaCapabilityError } from 'aidcp-kernel/kernel/schema-capability-contract.js';
import {
  AccountLaneStore,
  DecisionTraceStore,
  ExecutionLedgerStore,
  ManagedTaskInvariantError,
  RunStateStore,
  TaskAuthorityStore,
  type ManagedTaskStoreOptions,
} from '../../src/managed-automation/stores/index.js';

interface FakeResult {
  rows: unknown[];
  rowCount: number;
}

class FakePool {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  private readonly results: FakeResult[] = [];

  enqueue(rows: unknown[] = [], rowCount = rows.length): void {
    this.results.push({ rows, rowCount });
  }

  async query(text: string, values: readonly unknown[] = []): Promise<FakeResult> {
    this.calls.push({ text, values });
    return this.results.shift() ?? { rows: [], rowCount: 0 };
  }
}

const emptyShape = (): SchemaShape => ({ tables: new Set(), columns: new Set(), indexes: new Set() });

function options(pool: FakePool): ManagedTaskStoreOptions {
  return {
    pool: pool as unknown as pg.Pool,
    schemaProber: async () => emptyShape(),
  };
}

test('store init fails closed when the exact managed-task schema is absent', async () => {
  const pool = new FakePool();
  const probedTables: string[][] = [];
  const store = new TaskAuthorityStore({
    pool: pool as unknown as pg.Pool,
    schemaProber: async (_client, tables) => {
      probedTables.push(tables);
      return emptyShape();
    },
  });
  await assert.rejects(store.init(), SchemaCapabilityError);
  assert.deepEqual(probedTables, [[
    'tasks',
    'task_revisions',
    'execution_plans',
    'managed_task_command_receipts',
  ]]);
  assert.equal(pool.calls.length, 0, 'capability probe owns shape reads; store must not run DDL');
});

test('task authority rejects record/call target drift before SQL', async () => {
  const pool = new FakePool();
  const store = new TaskAuthorityStore(options(pool));

  await assert.rejects(
    store.insertTask('dev', {
      taskId: '00000000-0000-0000-0000-000000000001',
      executionTarget: 'ol',
      accountId: 'account-1',
      envKey: 'env-1',
      platform: 'facebook',
      taskDefinitionId: 'persona.research',
      taskDefinitionVersion: 1,
      currentRevisionId: '00000000-0000-0000-0000-000000000002',
      capabilityScope: { allow: ['research.search'], deny: [] },
      constraints: {},
      budget: { maxBrowserMinutes: 10, maxSteps: 4, maxExecutionAttempts: 3, maxWaitMs: 60_000 },
      schedule: { scheduledAt: 1, latestStartAt: 2, missPolicy: 'skip' },
      authorizationRevision: 'auth-1',
      actorRef: 'actor-1',
      status: 'active',
      correlationId: 'correlation-1',
      aggregateVersion: 1,
    }),
    ManagedTaskInvariantError,
  );
  assert.equal(pool.calls.length, 0);
});

test('command receipts distinguish stable duplicate from idempotency collision', async () => {
  const pool = new FakePool();
  const store = new TaskAuthorityStore(options(pool));
  const existing = {
    execution_target: 'dev',
    command_id: 'command-1',
    command_kind: 'create',
    payload_hash: 'a'.repeat(64),
    task_id: '00000000-0000-0000-0000-000000000001',
    run_id: null,
    receipt: { outcome: 'applied' },
    created_at: new Date(1000),
  };

  pool.enqueue([], 0);
  pool.enqueue([existing]);
  const duplicate = await store.insertCommandReceipt('dev', {
    commandId: 'command-1',
    commandKind: 'create',
    payloadHash: 'a'.repeat(64),
    taskId: existing.task_id,
    runId: null,
    receipt: { outcome: 'ignored-on-duplicate' },
  });
  assert.equal(duplicate.outcome, 'duplicate');
  if (duplicate.outcome === 'duplicate') {
    assert.deepEqual(duplicate.receipt.receipt, { outcome: 'applied' });
  }

  pool.enqueue([], 0);
  pool.enqueue([existing]);
  const collision = await store.insertCommandReceipt('dev', {
    commandId: 'command-1',
    commandKind: 'create',
    payloadHash: 'b'.repeat(64),
    taskId: existing.task_id,
    runId: null,
    receipt: { outcome: 'applied' },
  });
  assert.deepEqual(collision, { outcome: 'collision' });
  assert.match(pool.calls[3]!.text, /execution_target=\$1 AND command_id=\$2/);
});

test('run transitions reject invalid orthogonal state and terminal regression', async () => {
  const store = new RunStateStore(options(new FakePool()));
  const progress = { confirmedUnits: 0, targetUnits: 1, lastCheckpointRef: null };

  await assert.rejects(
    store.transitionRun('dev', 'run-1', 1, 'running', {
      state: { status: 'running', waitReason: 'waiting_for_edge', terminalOutcome: null, reasonCode: null },
      progress,
      currentNodeId: null,
    }),
    ManagedTaskInvariantError,
  );
  await assert.rejects(
    store.transitionRun('dev', 'run-1', 2, 'terminal', {
      state: { status: 'terminal', waitReason: null, terminalOutcome: 'succeeded', reasonCode: 'succeeded' },
      progress,
      currentNodeId: null,
    }),
    /terminal run state is immutable/,
  );
});

test('run claim and renew are target-scoped, leased, and CAS-guarded', async () => {
  const pool = new FakePool();
  const store = new RunStateStore(options(pool));
  pool.enqueue([], 0);
  assert.equal(await store.claimNextRun('dev', 'worker-1', 30_000, 1000), null);
  assert.match(pool.calls[0]!.text, /execution_target=\$4/);
  assert.match(pool.calls[0]!.text, /FOR UPDATE SKIP LOCKED/);
  assert.match(pool.calls[0]!.text, /status='running' AND lease_expires_at <= \$3/);
  assert.match(pool.calls[0]!.text, /status='waiting'.*updated_at <= \$5/s);

  pool.enqueue([{
    run_id: 'run-1',
    execution_target: 'dev',
    task_id: 'task-1',
    task_revision_id: 'revision-1',
    execution_plan_id: 'plan-1',
    account_id: 'account-1',
    status: 'running',
    wait_reason: null,
    terminal_outcome: null,
    reason_code: null,
    confirmed_units: 0,
    target_units: 1,
    last_checkpoint_ref: null,
    current_node_id: null,
    lease_owner: 'worker-1',
    lease_expires_at: new Date(31_000),
    attempt_count: 0,
    version: 3,
    created_at: new Date(0),
    updated_at: new Date(1_000),
    terminal_at: null,
  }]);
  const renewed = await store.renewRunLease('dev', 'run-1', 'worker-1', 3, 30_000, 1000);
  assert.equal(renewed?.version, 3, 'lease heartbeat must not race state CAS by advancing version');
  assert.equal(renewed?.leaseExpiresAt, 31_000);
  assert.match(pool.calls[1]!.text, /execution_target=\$3/);
  assert.match(pool.calls[1]!.text, /version=\$6/);
  assert.doesNotMatch(pool.calls[1]!.text, /version=version\+1/);
  await assert.rejects(store.renewRunLease('dev', 'run-1', 'worker-1', 4, 0), ManagedTaskInvariantError);

  pool.enqueue([], 0);
  assert.equal(await store.claimNextCancellation('dev', 'worker-2', 30_000, 2_000), null);
  assert.match(pool.calls[2]!.text, /status='cancel_requested'/);
  assert.match(pool.calls[2]!.text, /execution_target=\$4/);
  assert.match(pool.calls[2]!.text, /FOR UPDATE SKIP LOCKED/);
});

test('execution ledger rejects target drift, terminal mutation, and unsafe evidence coupling', async () => {
  const pool = new FakePool();
  const store = new ExecutionLedgerStore(options(pool));
  await assert.rejects(
    store.insertIntent('dev', {
      intentId: 'intent-1',
      executionTarget: 'ol',
      runId: 'run-1',
      stepRunId: 'step-1',
      accountId: 'account-1',
      capabilityId: 'research.search',
      capabilityVersion: 1,
      inputRef: 'input:1',
      idempotencyKey: 'key-1',
      correlationId: 'correlation-1',
    }),
    ManagedTaskInvariantError,
  );
  await assert.rejects(
    store.transitionAttempt('dev', 'attempt-1', 'completed', {
      status: 'completed',
      reasonCode: 'succeeded',
      evidence: { evidenceRef: 'e:1', stableContentRefs: ['content:1'], postconditionRef: null },
      strongestProgressEvidenceRef: 'e:1',
      dispatchedAt: 1,
      settledAt: 2,
    }),
    /terminal execution attempt is immutable/,
  );
  await assert.rejects(
    store.transitionAttempt('dev', 'attempt-1', 'dispatching', {
      status: 'completed',
      reasonCode: 'succeeded',
      evidence: null,
      strongestProgressEvidenceRef: null,
      dispatchedAt: 1,
      settledAt: 2,
    }),
    /completed requires read evidence/,
  );
  assert.equal(pool.calls.length, 0);
});

test('account lane needs legacy evidence and never releases an unknown dispatched attempt', async () => {
  const pool = new FakePool();
  const store = new AccountLaneStore(options(pool));
  await assert.rejects(
    store.acquireLegacy('dev', 'account-1', 'legacy-1', [], 30_000),
    /requires concrete in-flight evidence/,
  );

  const lane = {
    execution_target: 'dev',
    account_id: 'account-1',
    owner_kind: 'managed',
    managed_run_id: 'run-1',
    lease_owner: 'worker-1',
    lease_expires_at: new Date(50_000),
    in_flight_evidence: ['attempt:unknown'],
    version: 4,
    updated_at: new Date(1000),
  };
  pool.enqueue([], 0);
  pool.enqueue([lane]);
  assert.equal(
    await store.releaseManagedSafely('dev', 'account-1', 'run-1', 'worker-1', 4),
    'retained',
  );
  assert.match(pool.calls[0]!.text, /status IN \('dispatching','submitted_unknown'\)/);
  assert.match(pool.calls[0]!.text, /attempt.execution_target=lane.execution_target/);
});

test('expired managed lane takeover is denied while dispatch reconciliation is unresolved', async () => {
  const pool = new FakePool();
  const store = new AccountLaneStore(options(pool));
  const busyLane = {
    execution_target: 'dev',
    account_id: 'account-1',
    owner_kind: 'managed',
    managed_run_id: 'run-1',
    lease_owner: 'worker-old',
    lease_expires_at: new Date(500),
    in_flight_evidence: ['attempt:submitted_unknown'],
    version: 3,
    updated_at: new Date(100),
  };
  pool.enqueue([], 0);
  pool.enqueue([busyLane]);

  const result = await store.acquireManaged(
    'dev', 'account-1', 'run-new', 'worker-new', 30_000, 1_000,
  );
  assert.equal(result.outcome, 'busy');
  assert.match(pool.calls[0]!.text, /lease_expires_at <= \$8/);
  assert.match(pool.calls[0]!.text, /status IN \('dispatching','submitted_unknown'\)/);
  assert.match(pool.calls[0]!.text, /attempt.execution_target=managed_account_work_lanes.execution_target/);
});

test('decision traces are append-only, target-checked, and query-bounded', async () => {
  const pool = new FakePool();
  const store = new DecisionTraceStore(options(pool));
  const trace = {
    traceId: 'trace-1',
    executionTarget: 'ol' as const,
    correlationId: 'correlation-1',
    causationId: null,
    taskId: 'task-1',
    runId: null,
    stepRunId: null,
    attemptId: null,
    decisionType: 'creation' as const,
    outcome: 'allowed' as const,
    reasonCode: 'succeeded' as const,
    inputRefs: ['input:hash'],
    evidenceRefs: [],
  };
  await assert.rejects(store.append('dev', trace), ManagedTaskInvariantError);
  await assert.rejects(store.listByTask('dev', 'task-1', 1001), /between 1 and 1000/);
  assert.equal(pool.calls.length, 0);
});
