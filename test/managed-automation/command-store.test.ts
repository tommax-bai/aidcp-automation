import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import type { SchemaShape } from 'aidcp-kernel/kernel/schema-capability-contract.js';
import type {
  CancelTaskCommand,
  CreateTaskBundle,
} from '../../src/managed-automation/stores/command-store.js';
import { ManagedTaskCommandStore } from '../../src/managed-automation/stores/command-store.js';

interface QueryResult {
  rows: unknown[];
  rowCount: number;
}

class FakeTransactionClient {
  readonly calls: string[] = [];
  existingReceipt: unknown | null = null;
  failPattern: RegExp | null = null;
  unknownAttemptPresent = false;

  async query(text: string): Promise<QueryResult> {
    this.calls.push(text);
    if (this.failPattern?.test(text)) throw new Error('injected transaction failure');
    if (/SELECT command_kind, payload_hash, receipt/.test(text)) {
      return { rows: this.existingReceipt ? [this.existingReceipt] : [], rowCount: this.existingReceipt ? 1 : 0 };
    }
    if (/SELECT EXISTS[\s\S]*FROM execution_attempts/.test(text)) {
      return { rows: [{ present: this.unknownAttemptPresent }], rowCount: 1 };
    }
    return { rows: [], rowCount: /^UPDATE tasks/.test(text) ? 1 : 1 };
  }

  release(): void {}
}

class FakeTransactionPool {
  readonly client = new FakeTransactionClient();

  async connect(): Promise<FakeTransactionClient> {
    return this.client;
  }

  async query(): Promise<QueryResult> {
    return { rows: [], rowCount: 0 };
  }
}

const unusedShape = async (): Promise<SchemaShape> => ({
  tables: new Set(),
  columns: new Set(),
  indexes: new Set(),
});

function bundle(): CreateTaskBundle {
  const createdAt = 1000;
  const capabilityScope = {
    allow: ['research.search', 'research.browse', 'research.assess', 'research.summarize'],
    deny: [],
  };
  const budget = { maxBrowserMinutes: 20, maxSteps: 4, maxExecutionAttempts: 3, maxWaitMs: 900_000 };
  const schedule = { scheduledAt: 1000, latestStartAt: 2000, missPolicy: 'skip' as const };
  return {
    commandId: 'command-1',
    payloadHash: 'a'.repeat(64),
    task: {
      taskId: '00000000-0000-0000-0000-000000000001',
      executionTarget: 'dev',
      accountId: 'account-1',
      envKey: 'env-1',
      platform: 'facebook',
      taskDefinitionId: 'persona.research',
      taskDefinitionVersion: 1,
      currentRevisionId: '00000000-0000-0000-0000-000000000002',
      capabilityScope,
      constraints: { keywords: ['automation'] },
      budget,
      schedule,
      authorizationRevision: 'auth-1',
      actorRef: 'customer:actor-1',
      status: 'active',
      correlationId: 'correlation-1',
      aggregateVersion: 1,
      createdAt,
      updatedAt: createdAt,
    },
    revision: {
      revisionId: '00000000-0000-0000-0000-000000000002',
      executionTarget: 'dev',
      taskId: '00000000-0000-0000-0000-000000000001',
      ordinal: 1,
      cause: 'create',
      capabilityScope,
      constraints: { keywords: ['automation'] },
      budget,
      schedule,
      authorizationRevision: 'auth-1',
      actorRef: 'customer:actor-1',
      supersedesRevisionId: null,
      createdAt,
    },
    plan: {
      executionPlanId: '00000000-0000-0000-0000-000000000003',
      executionTarget: 'dev',
      taskId: '00000000-0000-0000-0000-000000000001',
      taskRevisionId: '00000000-0000-0000-0000-000000000002',
      taskDefinitionId: 'persona.research',
      taskDefinitionVersion: 1,
      authorizationRevision: 'auth-1',
      nodes: [{ nodeId: 'search', capabilityId: 'research.search', capabilityVersion: 1, inputBindingRef: 'input:search' }],
      edges: [],
      entryNodeId: 'search',
      bounds: { maxNodes: 1, maxExecutionAttempts: 3, maxWallClockMs: 60_000 },
      completionConditionRef: 'completion:persona.research@1',
      planHash: 'b'.repeat(64),
      compiledAt: createdAt,
    },
    runId: '00000000-0000-0000-0000-000000000004',
    runIdempotencyKey: 'managed-task:dev:command-1',
    targetUnits: 3,
    trace: {
      traceId: '00000000-0000-0000-0000-000000000005',
      executionTarget: 'dev',
      correlationId: 'correlation-1',
      causationId: null,
      taskId: '00000000-0000-0000-0000-000000000001',
      runId: '00000000-0000-0000-0000-000000000004',
      stepRunId: null,
      attemptId: null,
      decisionType: 'creation',
      outcome: 'allowed',
      reasonCode: 'succeeded',
      inputRefs: ['command:command-1'],
      evidenceRefs: [],
      createdAt,
    },
    receipt: {
      outcome: 'applied',
      commandId: 'command-1',
      taskId: '00000000-0000-0000-0000-000000000001',
      runId: '00000000-0000-0000-0000-000000000004',
      aggregateVersion: 1,
    },
  };
}

function store(pool: FakeTransactionPool): ManagedTaskCommandStore {
  return new ManagedTaskCommandStore({
    pool: pool as unknown as pg.Pool,
    schemaProber: unusedShape,
  });
}

function cancelCommand(): CancelTaskCommand {
  const created = bundle();
  return {
    commandId: 'command-cancel-1',
    payloadHash: 'c'.repeat(64),
    task: created.task,
    cancelRevision: {
      ...created.revision,
      revisionId: '00000000-0000-0000-0000-000000000006',
      ordinal: 2,
      cause: 'cancel',
      supersedesRevisionId: created.task.currentRevisionId,
      createdAt: 2000,
    },
    trace: {
      ...created.trace,
      traceId: '00000000-0000-0000-0000-000000000007',
      runId: null,
      decisionType: 'cancellation',
      outcome: 'selected',
      reasonCode: 'cancelled_by_actor',
      createdAt: 2000,
    },
    expectedAggregateVersion: created.task.aggregateVersion,
  };
}

test('create authority bundle and command receipt commit in one transaction', async () => {
  const pool = new FakeTransactionPool();
  const result = await store(pool).createBundle('dev', bundle());
  assert.equal(result.outcome, 'applied');
  assert.equal(pool.client.calls[0], 'BEGIN');
  assert.match(pool.client.calls[1]!, /SELECT command_kind, payload_hash, receipt/);
  assert.match(pool.client.calls.at(-2)!, /INSERT INTO managed_task_command_receipts/);
  assert.equal(pool.client.calls.at(-1), 'COMMIT');
  assert.equal(pool.client.calls.includes('ROLLBACK'), false);
});

test('create bundle failure rolls back before a command receipt can survive', async () => {
  const pool = new FakeTransactionPool();
  pool.client.failPattern = /INSERT INTO execution_plans/;
  await assert.rejects(store(pool).createBundle('dev', bundle()), /injected transaction failure/);
  assert.equal(pool.client.calls.at(-1), 'ROLLBACK');
  assert.equal(pool.client.calls.some((sql) => /INSERT INTO managed_task_command_receipts/.test(sql)), false);
  assert.equal(pool.client.calls.includes('COMMIT'), false);
});

test('same command and hash return the durable receipt without duplicating authority rows', async () => {
  const pool = new FakeTransactionPool();
  pool.client.existingReceipt = {
    command_kind: 'create',
    payload_hash: 'a'.repeat(64),
    receipt: bundle().receipt,
  };
  const result = await store(pool).createBundle('dev', bundle());
  assert.equal(result.outcome, 'duplicate');
  assert.equal(pool.client.calls.some((sql) => /INSERT INTO tasks/.test(sql)), false);
  assert.equal(pool.client.calls.at(-1), 'COMMIT');
});

test('cancel stops undispatched runs and preserves dispatched reconciliation truth', async () => {
  for (const unknownAttemptPresent of [false, true]) {
    const pool = new FakeTransactionPool();
    pool.client.unknownAttemptPresent = unknownAttemptPresent;
    const result = await store(pool).cancelTask('dev', cancelCommand());

    assert.equal(result.outcome, 'applied');
    if (result.outcome === 'applied') {
      assert.equal(
        result.dispatchedAttemptReconciliationContinues,
        unknownAttemptPresent,
      );
    }
    const runUpdate = pool.client.calls.find((sql) => /^UPDATE task_runs/.test(sql));
    assert.match(runUpdate ?? '', /status IN \('queued','waiting'\) THEN 'terminal'/);
    assert.match(runUpdate ?? '', /ELSE 'cancel_requested'/);
    assert.equal(pool.client.calls.at(-1), 'COMMIT');
  }
});
