import type { ExecutionTarget } from '../contracts/common.js';
import type {
  AccountLaneStore,
  AccountWorkLane,
} from '../stores/account-lane-store.js';

export const LEGACY_WORK_SOURCES = [
  'role_dispatcher',
  'edge_task_lease',
  'comment_scheduler',
  'facebook_group_join',
  'facebook_consumption',
  'publish_dispatch',
  'publish_schedule',
  'delegated_task',
  'content_schedule',
] as const;

export type LegacyWorkSource = (typeof LEGACY_WORK_SOURCES)[number];

export type LegacyAccountWorkSnapshot =
  | { kind: 'clear'; checkedAt: string }
  | {
    kind: 'busy';
    checkedAt: string;
    sources: LegacyWorkSource[];
    evidenceRefs: string[];
  }
  | {
    kind: 'unknown';
    checkedAt: string;
    source: LegacyWorkSource;
    reason: string;
  };

export interface LegacyAccountWorkPort {
  snapshot(accountId: string): Promise<LegacyAccountWorkSnapshot>;
}

export type LegacyAccountWorkProbeResult =
  | { kind: 'clear' }
  | { kind: 'busy'; evidenceRefs: string[] }
  | { kind: 'unknown'; reason: string };

export interface LegacyAccountWorkProbe {
  inspect(accountId: string): Promise<LegacyAccountWorkProbeResult>;
}

/**
 * Every inventoried legacy producer is mandatory at construction time. A producer that has not
 * reached the independent root must still be represented by an explicit unknown probe; omission
 * can therefore never become a false clear snapshot.
 */
export type LegacyAccountWorkProbes = {
  [Source in LegacyWorkSource]: LegacyAccountWorkProbe;
};

export function unknownLegacyAccountWorkProbe(reason: string): LegacyAccountWorkProbe {
  return {
    async inspect() {
      return { kind: 'unknown', reason };
    },
  };
}

export class CompositeLegacyAccountWorkAdapter implements LegacyAccountWorkPort {
  private readonly now: () => number;

  constructor(
    private readonly probes: LegacyAccountWorkProbes,
    now: () => number = Date.now,
  ) {
    this.now = now;
  }

  async snapshot(accountId: string): Promise<LegacyAccountWorkSnapshot> {
    const checkedAt = new Date(this.now()).toISOString();
    const results = await Promise.all(LEGACY_WORK_SOURCES.map(async (source) => {
      try {
        return { source, result: await this.probes[source].inspect(accountId) };
      } catch (error) {
        return {
          source,
          result: {
            kind: 'unknown' as const,
            reason: `probe_failed:${error instanceof Error ? error.message : String(error)}`,
          },
        };
      }
    }));

    // Unknown has priority over busy: a partially observed legacy surface is not a complete busy
    // snapshot and must remain operationally visible until the missing source recovers.
    const unknown = results.find((item) => item.result.kind === 'unknown');
    if (unknown?.result.kind === 'unknown') {
      return {
        kind: 'unknown',
        checkedAt,
        source: unknown.source,
        reason: unknown.result.reason,
      };
    }

    const busy = results.filter(
      (item): item is { source: LegacyWorkSource; result: { kind: 'busy'; evidenceRefs: string[] } } =>
        item.result.kind === 'busy',
    );
    if (busy.length > 0) {
      return {
        kind: 'busy',
        checkedAt,
        sources: busy.map((item) => item.source),
        evidenceRefs: [...new Set(busy.flatMap((item) => item.result.evidenceRefs))],
      };
    }
    return { kind: 'clear', checkedAt };
  }
}

type AccountLaneArbiterStore = Pick<
  AccountLaneStore,
  'observe' | 'acquireManaged' | 'renew' | 'retainForShutdown' | 'releaseManagedSafely'
>;

export type ManagedLaneAcquireResult =
  | { outcome: 'acquired'; lane: AccountWorkLane }
  | { outcome: 'disabled'; reason: 'managed_task_lane_disabled' }
  | {
    outcome: 'waiting';
    reason: 'legacy_work_active' | 'legacy_work_unknown' | 'account_lane_busy' | 'legacy_work_raced';
    legacySnapshot: LegacyAccountWorkSnapshot | null;
    lane: AccountWorkLane | null;
  }
  | {
    outcome: 'reconciliation_required';
    reason: 'managed_attempt_in_flight';
    lane: AccountWorkLane;
    legacySnapshot: LegacyAccountWorkSnapshot;
  }
  | { outcome: 'lost'; reason: 'managed_account_lane_lost' };

export type LegacyLaneAdmission =
  | { allowed: true }
  | {
    allowed: false;
    reason: 'managed_task_lane_active' | 'managed_task_lane_unavailable';
    managedRunId: string | null;
    leaseExpiresAt: number | null;
  };

export interface AccountLaneArbiterOptions {
  executionTarget: ExecutionTarget;
  store: AccountLaneArbiterStore;
  legacyWork: LegacyAccountWorkPort;
  laneEnabled: () => boolean;
  leaseMs: number;
  now?: () => number;
}

function legacyWait(snapshot: LegacyAccountWorkSnapshot): ManagedLaneAcquireResult {
  return {
    outcome: 'waiting',
    reason: snapshot.kind === 'unknown' ? 'legacy_work_unknown' : 'legacy_work_active',
    legacySnapshot: snapshot,
    lane: null,
  };
}

/** Durable account-lane arbitration; connection/session metadata is deliberately absent. */
export class AccountLaneArbiter {
  private readonly now: () => number;

  constructor(private readonly options: AccountLaneArbiterOptions) {
    if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 1) {
      throw new Error('account lane arbiter leaseMs must be a positive integer');
    }
    this.now = options.now ?? Date.now;
  }

  async acquireManaged(
    accountId: string,
    runId: string,
    workerId: string,
  ): Promise<ManagedLaneAcquireResult> {
    if (!this.options.laneEnabled()) {
      return { outcome: 'disabled', reason: 'managed_task_lane_disabled' };
    }

    const before = await this.options.legacyWork.snapshot(accountId);
    if (before.kind !== 'clear') return legacyWait(before);

    const acquired = await this.options.store.acquireManaged(
      this.options.executionTarget,
      accountId,
      runId,
      workerId,
      this.options.leaseMs,
      this.now(),
    );
    if (acquired.outcome === 'busy') {
      return {
        outcome: 'waiting',
        reason: 'account_lane_busy',
        legacySnapshot: null,
        lane: acquired.lane,
      };
    }

    // Close clear->legacy-claim races. Task 6.4 makes every legacy producer check the durable lane
    // before claim and again before dispatch; this post-acquire read is the managed half of the
    // reservation handshake.
    const after = await this.options.legacyWork.snapshot(accountId);
    if (after.kind === 'clear') return acquired;

    const release = await this.options.store.releaseManagedSafely(
      this.options.executionTarget,
      accountId,
      runId,
      workerId,
      acquired.lane.version,
    );
    if (release === 'retained') {
      return {
        outcome: 'reconciliation_required',
        reason: 'managed_attempt_in_flight',
        lane: acquired.lane,
        legacySnapshot: after,
      };
    }
    if (release === 'lost') return { outcome: 'lost', reason: 'managed_account_lane_lost' };
    return {
      outcome: 'waiting',
      reason: 'legacy_work_raced',
      legacySnapshot: after,
      lane: null,
    };
  }

  renewManaged(
    accountId: string,
    workerId: string,
    expectedVersion: number,
  ): Promise<AccountWorkLane | null> {
    return this.options.store.renew(
      this.options.executionTarget,
      accountId,
      workerId,
      expectedVersion,
      this.options.leaseMs,
      this.now(),
    );
  }

  retainManagedForShutdown(
    accountId: string,
    workerId: string,
    expectedVersion: number,
    retentionMs: number,
    evidence: readonly string[],
  ): Promise<boolean> {
    return this.options.store.retainForShutdown(
      this.options.executionTarget,
      accountId,
      workerId,
      expectedVersion,
      retentionMs,
      evidence,
      this.now(),
    );
  }

  releaseManaged(
    accountId: string,
    runId: string,
    workerId: string,
    expectedVersion: number,
  ): Promise<'released' | 'retained' | 'lost'> {
    return this.options.store.releaseManagedSafely(
      this.options.executionTarget,
      accountId,
      runId,
      workerId,
      expectedVersion,
    );
  }

  /** Hook consumed by every legacy claim/dispatch entrypoint in gated task 6.4. */
  async admitLegacy(accountId: string): Promise<LegacyLaneAdmission> {
    if (!this.options.laneEnabled()) return { allowed: true };
    try {
      const lane = await this.options.store.observe(this.options.executionTarget, accountId);
      if (!lane || lane.ownerKind === 'legacy') return { allowed: true };
      // Expiry alone is not release authority: an expired managed lane may still protect a
      // dispatching/submitted_unknown Attempt. Recovery or safe release must clear it first.
      return {
        allowed: false,
        reason: 'managed_task_lane_active',
        managedRunId: lane.managedRunId,
        leaseExpiresAt: lane.leaseExpiresAt,
      };
    } catch {
      return {
        allowed: false,
        reason: 'managed_task_lane_unavailable',
        managedRunId: null,
        leaseExpiresAt: null,
      };
    }
  }
}
