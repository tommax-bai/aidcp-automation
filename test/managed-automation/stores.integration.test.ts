import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import type { SchemaShape } from 'aidcp-kernel/kernel/schema-capability-contract.js';
import {
  AccountLaneStore,
  ExecutionLedgerStore,
  RunStateStore,
  TaskAuthorityStore,
  type ManagedTaskStoreOptions,
} from '../../src/managed-automation/stores/index.js';
import { OUTBOX_URL_ENV, resolveIntegrationDatabase } from '../helpers/pg-test-database-guard.js';

const target = resolveIntegrationDatabase(OUTBOX_URL_ENV);
const connectionString = target.enabled ? target.connectionString : undefined;
const skipReason = target.enabled ? (false as const) : target.skipReason;

const MIGRATIONS = [
  '0106_managed_task_authority.sql',
  '0107_managed_task_run_state.sql',
  '0108_managed_task_execution_ledger.sql',
  '0109_managed_task_decision_traces.sql',
] as const;

const unusedShape = async (): Promise<SchemaShape> => ({
  tables: new Set(),
  columns: new Set(),
  indexes: new Set(),
});

function storeOptions(pool: pg.Pool): ManagedTaskStoreOptions {
  return { pool, schemaProber: unusedShape };
}

test(
  'PostgreSQL: claim/CAS/dedupe/target/lane unknown-attempt invariants hold concurrently',
  { skip: skipReason },
  async () => {
    const adminPool = new pg.Pool({ connectionString });
    const schema = `managed_task_${process.pid}_${Date.now()}`;
    assert.match(schema, /^[a-z0-9_]+$/);
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });

    try {
      for (const migration of MIGRATIONS) {
        await pool.query(await readFile(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'));
      }

      const taskStore = new TaskAuthorityStore(storeOptions(pool));
      const runStore = new RunStateStore(storeOptions(pool));
      const ledgerStore = new ExecutionLedgerStore(storeOptions(pool));
      const laneStore = new AccountLaneStore(storeOptions(pool));

      const runIds = [randomUUID(), randomUUID()];
      for (const [index, runId] of runIds.entries()) {
        assert.equal(await runStore.insertRun('dev', {
          runId,
          taskId: randomUUID(),
          taskRevisionId: randomUUID(),
          executionPlanId: randomUUID(),
          accountId: `account-${index}`,
          idempotencyKey: `run-key-${index}`,
          targetUnits: 1,
        }), true);
      }

      const claims = await Promise.all([
        runStore.claimNextRun('dev', 'worker-a', 30_000),
        runStore.claimNextRun('dev', 'worker-b', 30_000),
      ]);
      assert.equal(new Set(claims.map((claim) => claim?.runId)).size, 2, 'SKIP LOCKED claims distinct runs');
      assert.equal(await runStore.getRun('ol', runIds[0]!), null, 'ol cannot read a dev run');

      const terminalRunId = randomUUID();
      await runStore.insertRun('dev', {
        runId: terminalRunId,
        taskId: randomUUID(),
        taskRevisionId: randomUUID(),
        executionPlanId: randomUUID(),
        accountId: 'account-terminal',
        idempotencyKey: 'run-key-terminal',
        targetUnits: 1,
      });
      const terminalTransition = {
        state: {
          status: 'terminal' as const,
          waitReason: null,
          terminalOutcome: 'failed' as const,
          reasonCode: 'execution_failed' as const,
        },
        progress: { confirmedUnits: 0, targetUnits: 1, lastCheckpointRef: null },
        currentNodeId: null,
      };
      const terminalRace = await Promise.all([
        runStore.transitionRun('dev', terminalRunId, 1, 'queued', terminalTransition),
        runStore.transitionRun('dev', terminalRunId, 1, 'queued', terminalTransition),
      ]);
      assert.deepEqual(terminalRace.sort(), [false, true], 'only one same-version terminal CAS wins');

      const commandId = 'create-command-1';
      const receiptInput = {
        commandId,
        commandKind: 'create' as const,
        payloadHash: 'a'.repeat(64),
        taskId: randomUUID(),
        runId: null,
        receipt: { outcome: 'applied' },
      };
      assert.equal((await taskStore.insertCommandReceipt('dev', receiptInput)).outcome, 'inserted');
      assert.equal((await taskStore.insertCommandReceipt('dev', receiptInput)).outcome, 'duplicate');
      assert.equal((await taskStore.insertCommandReceipt('dev', {
        ...receiptInput,
        payloadHash: 'b'.repeat(64),
      })).outcome, 'collision');

      const leaseAccount = 'account-expired-lane';
      const firstLease = await laneStore.acquireManaged(
        'dev', leaseAccount, randomUUID(), 'worker-a', 1000, 1000,
      );
      assert.equal(firstLease.outcome, 'acquired');
      const busyLease = await laneStore.acquireManaged(
        'dev', leaseAccount, randomUUID(), 'worker-b', 1000, 1500,
      );
      assert.equal(busyLease.outcome, 'busy');
      const takeover = await laneStore.acquireManaged(
        'dev', leaseAccount, randomUUID(), 'worker-b', 1000, 2500,
      );
      assert.equal(takeover.outcome, 'acquired', 'expired lease is recoverable by another worker');

      const unknownRunId = randomUUID();
      const unknownLane = await laneStore.acquireManaged(
        'dev', 'account-unknown', unknownRunId, 'worker-unknown', 30_000,
      );
      assert.equal(unknownLane.outcome, 'acquired');
      if (unknownLane.outcome !== 'acquired') assert.fail('managed lane must be acquired');

      const intentId = randomUUID();
      const stepRunId = randomUUID();
      const attemptId = randomUUID();
      assert.equal((await ledgerStore.insertIntent('dev', {
        intentId,
        executionTarget: 'dev',
        runId: unknownRunId,
        stepRunId,
        accountId: 'account-unknown',
        capabilityId: 'research.search',
        capabilityVersion: 1,
        inputRef: 'input:hash',
        idempotencyKey: 'intent-key-unknown',
        correlationId: 'correlation-unknown',
      })).outcome, 'inserted');
      await ledgerStore.insertAttempt('dev', {
        attemptId,
        intentId,
        runId: unknownRunId,
        stepRunId,
        ordinal: 1,
      });
      await ledgerStore.transitionAttempt('dev', attemptId, 'prepared', {
        status: 'dispatching',
        reasonCode: null,
        evidence: null,
        strongestProgressEvidenceRef: null,
        dispatchedAt: Date.now(),
        settledAt: null,
      });
      await ledgerStore.transitionAttempt('dev', attemptId, 'dispatching', {
        status: 'submitted_unknown',
        reasonCode: 'result_unknown',
        evidence: null,
        strongestProgressEvidenceRef: null,
        dispatchedAt: Date.now(),
        settledAt: null,
      });
      assert.equal(await laneStore.releaseManagedSafely(
        'dev', 'account-unknown', unknownRunId, 'worker-unknown', unknownLane.lane.version,
      ), 'retained', 'submitted_unknown attempt retains the account lane');

      await ledgerStore.reconcileSubmittedUnknown('dev', attemptId, {
        status: 'completed',
        reasonCode: 'succeeded',
        evidence: {
          evidenceRef: 'evidence:reconciled',
          stableContentRefs: ['content:stable'],
          postconditionRef: 'postcondition:read',
        },
        strongestProgressEvidenceRef: 'evidence:reconciled',
        dispatchedAt: Date.now(),
        settledAt: Date.now(),
      });
      assert.equal(await laneStore.releaseManagedSafely(
        'dev', 'account-unknown', unknownRunId, 'worker-unknown', unknownLane.lane.version,
      ), 'released', 'lane releases only after unknown dispatch is reconciled');
    } finally {
      await pool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await adminPool.end();
    }
  },
);
