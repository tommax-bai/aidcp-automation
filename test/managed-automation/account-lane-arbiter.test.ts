import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AccountLaneArbiter,
  CompositeLegacyAccountWorkAdapter,
  LEGACY_WORK_SOURCES,
  unknownLegacyAccountWorkProbe,
  type LegacyAccountWorkPort,
  type LegacyAccountWorkProbe,
  type LegacyAccountWorkProbes,
  type LegacyAccountWorkSnapshot,
} from '../../src/managed-automation/engine/account-lane-arbiter.js';
import type { AccountWorkLane, LaneAcquireResult } from '../../src/managed-automation/stores/index.js';

const CLEAR: LegacyAccountWorkSnapshot = {
  kind: 'clear',
  checkedAt: '1970-01-01T00:00:01.000Z',
};

function lane(overrides: Partial<AccountWorkLane> = {}): AccountWorkLane {
  return {
    executionTarget: 'dev',
    accountId: 'account-1',
    ownerKind: 'managed',
    managedRunId: 'run-1',
    leaseOwner: 'worker-1',
    leaseExpiresAt: 31_000,
    inFlightEvidence: [],
    version: 1,
    updatedAt: 1_000,
    ...overrides,
  };
}

function probes(
  overrides: Partial<Record<(typeof LEGACY_WORK_SOURCES)[number], LegacyAccountWorkProbe>> = {},
): LegacyAccountWorkProbes {
  return Object.fromEntries(LEGACY_WORK_SOURCES.map((source) => [
    source,
    overrides[source] ?? { async inspect() { return { kind: 'clear' as const }; } },
  ])) as unknown as LegacyAccountWorkProbes;
}

test('complete legacy adapter checks all frozen producers and aggregates concrete busy evidence', async () => {
  const calls: string[] = [];
  const all = probes();
  for (const source of LEGACY_WORK_SOURCES) {
    all[source] = {
      async inspect(accountId) {
        calls.push(`${source}:${accountId}`);
        if (source === 'comment_scheduler') {
          return { kind: 'busy', evidenceRefs: ['comment:claim-1', 'shared:evidence'] };
        }
        if (source === 'publish_dispatch') {
          return { kind: 'busy', evidenceRefs: ['publish:record-1', 'shared:evidence'] };
        }
        return { kind: 'clear' };
      },
    };
  }

  const snapshot = await new CompositeLegacyAccountWorkAdapter(all, () => 1_000)
    .snapshot('account-1');
  assert.deepEqual(calls, LEGACY_WORK_SOURCES.map((source) => `${source}:account-1`));
  assert.deepEqual(snapshot, {
    kind: 'busy',
    checkedAt: '1970-01-01T00:00:01.000Z',
    sources: ['comment_scheduler', 'publish_dispatch'],
    evidenceRefs: ['comment:claim-1', 'shared:evidence', 'publish:record-1'],
  });
});

test('unknown or throwing legacy source has deny polarity and cannot collapse to clear/busy', async () => {
  const explicit = new CompositeLegacyAccountWorkAdapter(probes({
    content_schedule: unknownLegacyAccountWorkProbe('not_wired_in_independent_root'),
    publish_dispatch: { async inspect() { return { kind: 'busy', evidenceRefs: ['publish:1'] }; } },
  }), () => 2_000);
  assert.deepEqual(await explicit.snapshot('account-1'), {
    kind: 'unknown',
    checkedAt: '1970-01-01T00:00:02.000Z',
    source: 'content_schedule',
    reason: 'not_wired_in_independent_root',
  });

  const throwing = new CompositeLegacyAccountWorkAdapter(probes({
    edge_task_lease: { async inspect() { throw new Error('lease_read_down'); } },
  }), () => 3_000);
  assert.deepEqual(await throwing.snapshot('account-1'), {
    kind: 'unknown',
    checkedAt: '1970-01-01T00:00:03.000Z',
    source: 'edge_task_lease',
    reason: 'probe_failed:lease_read_down',
  });
});

interface StoreFake {
  observed: AccountWorkLane | null;
  acquireResult: LaneAcquireResult;
  releaseResult: 'released' | 'retained' | 'lost';
  calls: string[];
  observe(target: 'dev' | 'ol', accountId: string): Promise<AccountWorkLane | null>;
  acquireManaged(
    target: 'dev' | 'ol',
    accountId: string,
    runId: string,
    workerId: string,
    leaseMs: number,
    now: number,
  ): Promise<LaneAcquireResult>;
  renew(
    target: 'dev' | 'ol', accountId: string, workerId: string,
    expectedVersion: number, leaseMs: number, now: number,
  ): Promise<boolean>;
  retainForShutdown(
    target: 'dev' | 'ol', accountId: string, workerId: string,
    expectedVersion: number, retentionMs: number, evidence: readonly string[], now: number,
  ): Promise<boolean>;
  releaseManagedSafely(
    target: 'dev' | 'ol', accountId: string, runId: string,
    workerId: string, expectedVersion: number,
  ): Promise<'released' | 'retained' | 'lost'>;
}

function storeFake(): StoreFake {
  const fake: StoreFake = {
    observed: null,
    acquireResult: { outcome: 'acquired', lane: lane() },
    releaseResult: 'released',
    calls: [],
    async observe(target, accountId) {
      fake.calls.push(`observe:${target}:${accountId}`);
      return fake.observed;
    },
    async acquireManaged(target, accountId, runId, workerId, leaseMs, now) {
      fake.calls.push(`acquire:${target}:${accountId}:${runId}:${workerId}:${leaseMs}:${now}`);
      return fake.acquireResult;
    },
    async renew(target, accountId, workerId, expectedVersion, leaseMs, now) {
      fake.calls.push(`renew:${target}:${accountId}:${workerId}:${expectedVersion}:${leaseMs}:${now}`);
      return true;
    },
    async retainForShutdown(target, accountId, workerId, expectedVersion, retentionMs, evidence, now) {
      fake.calls.push(
        `retain:${target}:${accountId}:${workerId}:${expectedVersion}:${retentionMs}:${evidence.join(',')}:${now}`,
      );
      return true;
    },
    async releaseManagedSafely(target, accountId, runId, workerId, expectedVersion) {
      fake.calls.push(`release:${target}:${accountId}:${runId}:${workerId}:${expectedVersion}`);
      return fake.releaseResult;
    },
  };
  return fake;
}

function snapshots(...values: LegacyAccountWorkSnapshot[]): LegacyAccountWorkPort {
  let index = 0;
  return {
    async snapshot() {
      return values[Math.min(index++, values.length - 1)]!;
    },
  };
}

function arbiter(
  store: StoreFake,
  legacyWork: LegacyAccountWorkPort = snapshots(CLEAR, CLEAR),
  enabled = true,
): AccountLaneArbiter {
  return new AccountLaneArbiter({
    executionTarget: 'dev',
    store,
    legacyWork,
    laneEnabled: () => enabled,
    leaseMs: 30_000,
    now: () => 1_000,
  });
}

test('disabled gate performs no owner/legacy read; clear account uses pre/post handshake', async () => {
  const disabledStore = storeFake();
  let legacyReads = 0;
  const disabled = arbiter(disabledStore, {
    async snapshot() { legacyReads += 1; return CLEAR; },
  }, false);
  assert.deepEqual(await disabled.acquireManaged('account-1', 'run-1', 'worker-1'), {
    outcome: 'disabled',
    reason: 'managed_task_lane_disabled',
  });
  assert.equal(legacyReads, 0);
  assert.deepEqual(disabledStore.calls, []);

  const activeStore = storeFake();
  let activeReads = 0;
  const active = arbiter(activeStore, {
    async snapshot() { activeReads += 1; return CLEAR; },
  });
  assert.deepEqual(await active.acquireManaged('account-1', 'run-1', 'worker-1'), {
    outcome: 'acquired',
    lane: lane(),
  });
  assert.equal(activeReads, 2);
  assert.deepEqual(activeStore.calls, [
    'acquire:dev:account-1:run-1:worker-1:30000:1000',
  ]);
});

test('busy/unknown legacy evidence denies before durable acquisition', async () => {
  for (const snapshot of [
    {
      kind: 'busy' as const,
      checkedAt: 'now',
      sources: ['delegated_task' as const],
      evidenceRefs: ['claim:1'],
    },
    {
      kind: 'unknown' as const,
      checkedAt: 'now',
      source: 'content_schedule' as const,
      reason: 'not_wired',
    },
  ]) {
    const store = storeFake();
    const result = await arbiter(store, snapshots(snapshot)).acquireManaged(
      'account-1', 'run-1', 'worker-1',
    );
    assert.equal(result.outcome, 'waiting');
    if (result.outcome === 'waiting') {
      assert.equal(result.reason, snapshot.kind === 'busy' ? 'legacy_work_active' : 'legacy_work_unknown');
      assert.deepEqual(result.legacySnapshot, snapshot);
    }
    assert.deepEqual(store.calls, []);
  }
});

test('durable lane conflict is account-scoped and does not block another account', async () => {
  const calls: string[] = [];
  const store = storeFake();
  store.acquireManaged = async (_target, accountId) => {
    calls.push(accountId);
    return accountId === 'account-a'
      ? { outcome: 'busy', lane: lane({ accountId: 'account-a', managedRunId: 'run-other' }) }
      : { outcome: 'acquired', lane: lane({ accountId: 'account-b', managedRunId: 'run-b' }) };
  };
  const target = arbiter(store);

  const [a, b] = await Promise.all([
    target.acquireManaged('account-a', 'run-a', 'worker-1'),
    target.acquireManaged('account-b', 'run-b', 'worker-1'),
  ]);
  assert.equal(a.outcome, 'waiting');
  if (a.outcome === 'waiting') assert.equal(a.reason, 'account_lane_busy');
  assert.equal(b.outcome, 'acquired');
  assert.deepEqual(calls.sort(), ['account-a', 'account-b']);
});

test('post-acquire legacy race releases before dispatch; unknown Attempt retains reconciliation', async () => {
  const raced = {
    kind: 'busy' as const,
    checkedAt: 'after',
    sources: ['comment_scheduler' as const],
    evidenceRefs: ['comment:claim-1'],
  };

  const releasable = storeFake();
  assert.deepEqual(await arbiter(releasable, snapshots(CLEAR, raced)).acquireManaged(
    'account-1', 'run-1', 'worker-1',
  ), {
    outcome: 'waiting',
    reason: 'legacy_work_raced',
    legacySnapshot: raced,
    lane: null,
  });
  assert.ok(releasable.calls.includes('release:dev:account-1:run-1:worker-1:1'));

  const retained = storeFake();
  retained.releaseResult = 'retained';
  assert.deepEqual(await arbiter(retained, snapshots(CLEAR, raced)).acquireManaged(
    'account-1', 'run-1', 'worker-1',
  ), {
    outcome: 'reconciliation_required',
    reason: 'managed_attempt_in_flight',
    lane: lane(),
    legacySnapshot: raced,
  });
});

test('legacy admission blocks every managed row, including expired, and fails safe on read outage', async () => {
  const store = storeFake();
  store.observed = lane({ leaseExpiresAt: 500 });
  assert.deepEqual(await arbiter(store).admitLegacy('account-1'), {
    allowed: false,
    reason: 'managed_task_lane_active',
    managedRunId: 'run-1',
    leaseExpiresAt: 500,
  });

  const off = storeFake();
  off.observed = lane();
  assert.deepEqual(await arbiter(off, snapshots(CLEAR), false).admitLegacy('account-1'), {
    allowed: true,
  });
  assert.deepEqual(off.calls, []);

  const unavailable = storeFake();
  unavailable.observe = async () => { throw new Error('lane_db_down'); };
  assert.deepEqual(await arbiter(unavailable).admitLegacy('account-1'), {
    allowed: false,
    reason: 'managed_task_lane_unavailable',
    managedRunId: null,
    leaseExpiresAt: null,
  });
});

test('renew, safe release, and shutdown retention remain available after the acquisition flag closes', async () => {
  const store = storeFake();
  const target = arbiter(store, snapshots(CLEAR), false);
  assert.equal(await target.renewManaged('account-1', 'worker-1', 1), true);
  assert.equal(await target.retainManagedForShutdown(
    'account-1', 'worker-1', 2, 60_000, ['attempt:submitted_unknown'],
  ), true);
  assert.equal(await target.releaseManaged('account-1', 'run-1', 'worker-1', 3), 'released');
  assert.deepEqual(store.calls, [
    'renew:dev:account-1:worker-1:1:30000:1000',
    'retain:dev:account-1:worker-1:2:60000:attempt:submitted_unknown:1000',
    'release:dev:account-1:run-1:worker-1:3',
  ]);
});
