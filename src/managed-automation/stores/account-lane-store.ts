import type { ExecutionTarget } from '../contracts/common.js';
import {
  ManagedTaskInvariantError,
  ManagedTaskStoreBase,
  toEpochMillis,
  type ManagedTaskSchemaRequirement,
  type ManagedTaskStoreOptions,
} from './store-base.js';

const REQUIREMENT: ManagedTaskSchemaRequirement = {
  capability: 'managed_task_account_lane',
  sinceVersion: '0108_managed_task_execution_ledger',
  tables: new Map([
    ['managed_account_work_lanes', new Set([
      'execution_target', 'account_id', 'owner_kind', 'managed_run_id', 'lease_owner',
      'lease_expires_at', 'in_flight_evidence', 'version', 'updated_at',
    ])],
    ['execution_attempts', new Set([
      'execution_target', 'run_id', 'status',
    ])],
  ]),
  indexes: new Map([
    ['idx_managed_account_lanes_target_lease', 'managed_account_work_lanes'],
    ['idx_execution_attempts_target_run', 'execution_attempts'],
  ]),
};

export interface AccountWorkLane {
  executionTarget: ExecutionTarget;
  accountId: string;
  ownerKind: 'legacy' | 'managed';
  managedRunId: string | null;
  leaseOwner: string;
  leaseExpiresAt: number;
  inFlightEvidence: string[];
  version: number;
  updatedAt: number;
}

interface LaneRow {
  execution_target: ExecutionTarget;
  account_id: string;
  owner_kind: 'legacy' | 'managed';
  managed_run_id: string | null;
  lease_owner: string;
  lease_expires_at: Date | string;
  in_flight_evidence: string[];
  version: number | string;
  updated_at: Date | string;
}

const LANE_COLUMNS = `execution_target, account_id, owner_kind, managed_run_id, lease_owner,
  lease_expires_at, in_flight_evidence, version, updated_at`;

function laneFromRow(row: LaneRow): AccountWorkLane {
  return {
    executionTarget: row.execution_target,
    accountId: row.account_id,
    ownerKind: row.owner_kind,
    managedRunId: row.managed_run_id,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: toEpochMillis(row.lease_expires_at),
    inFlightEvidence: row.in_flight_evidence,
    version: Number(row.version),
    updatedAt: toEpochMillis(row.updated_at),
  };
}

export type LaneAcquireResult =
  | { outcome: 'acquired'; lane: AccountWorkLane }
  | { outcome: 'busy'; lane: AccountWorkLane };

export class AccountLaneStore extends ManagedTaskStoreBase {
  constructor(options: ManagedTaskStoreOptions) {
    super(REQUIREMENT, options);
  }

  async observe(target: ExecutionTarget, accountId: string): Promise<AccountWorkLane | null> {
    const result = await this.pool.query<LaneRow>(
      `SELECT ${LANE_COLUMNS} FROM managed_account_work_lanes
        WHERE execution_target=$1 AND account_id=$2`,
      [target, accountId],
    );
    return result.rows[0] ? laneFromRow(result.rows[0]) : null;
  }

  async acquireManaged(
    target: ExecutionTarget,
    accountId: string,
    runId: string,
    leaseOwner: string,
    leaseMs: number,
    now = Date.now(),
  ): Promise<LaneAcquireResult> {
    return this.acquire(target, accountId, 'managed', runId, leaseOwner, [], leaseMs, now);
  }

  async acquireLegacy(
    target: ExecutionTarget,
    accountId: string,
    leaseOwner: string,
    inFlightEvidence: readonly string[],
    leaseMs: number,
    now = Date.now(),
  ): Promise<LaneAcquireResult> {
    if (inFlightEvidence.length === 0) {
      throw new ManagedTaskInvariantError('legacy lane requires concrete in-flight evidence');
    }
    return this.acquire(
      target,
      accountId,
      'legacy',
      null,
      leaseOwner,
      inFlightEvidence,
      leaseMs,
      now,
    );
  }

  private async acquire(
    target: ExecutionTarget,
    accountId: string,
    ownerKind: 'legacy' | 'managed',
    runId: string | null,
    leaseOwner: string,
    inFlightEvidence: readonly string[],
    leaseMs: number,
    now: number,
  ): Promise<LaneAcquireResult> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
      throw new ManagedTaskInvariantError('lane leaseMs must be a positive integer');
    }
    const result = await this.pool.query<LaneRow>(
      `INSERT INTO managed_account_work_lanes
         (execution_target, account_id, owner_kind, managed_run_id, lease_owner,
          lease_expires_at, in_flight_evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (execution_target, account_id) DO UPDATE
         SET owner_kind=EXCLUDED.owner_kind,
             managed_run_id=EXCLUDED.managed_run_id,
             lease_owner=EXCLUDED.lease_owner,
             lease_expires_at=EXCLUDED.lease_expires_at,
             in_flight_evidence=EXCLUDED.in_flight_evidence,
             version=managed_account_work_lanes.version+1,
             updated_at=$8
       WHERE managed_account_work_lanes.lease_expires_at <= $8
          OR (managed_account_work_lanes.owner_kind=EXCLUDED.owner_kind
              AND managed_account_work_lanes.lease_owner=EXCLUDED.lease_owner
              AND managed_account_work_lanes.managed_run_id IS NOT DISTINCT FROM EXCLUDED.managed_run_id)
       RETURNING ${LANE_COLUMNS}`,
      [target, accountId, ownerKind, runId, leaseOwner, new Date(now + leaseMs),
        JSON.stringify(inFlightEvidence), new Date(now)],
    );
    if (result.rows[0]) return { outcome: 'acquired', lane: laneFromRow(result.rows[0]) };
    const busy = await this.observe(target, accountId);
    if (!busy) throw new ManagedTaskInvariantError('lane conflict vanished before observation');
    return { outcome: 'busy', lane: busy };
  }

  async renew(
    target: ExecutionTarget,
    accountId: string,
    leaseOwner: string,
    expectedVersion: number,
    leaseMs: number,
    now = Date.now(),
  ): Promise<boolean> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
      throw new ManagedTaskInvariantError('lane leaseMs must be a positive integer');
    }
    const result = await this.pool.query(
      `UPDATE managed_account_work_lanes
          SET lease_expires_at=$1, version=version+1, updated_at=$2
        WHERE execution_target=$3 AND account_id=$4 AND lease_owner=$5 AND version=$6
          AND lease_expires_at > $2`,
      [new Date(now + leaseMs), new Date(now), target, accountId, leaseOwner, expectedVersion],
    );
    return result.rowCount === 1;
  }

  async retainForShutdown(
    target: ExecutionTarget,
    accountId: string,
    leaseOwner: string,
    expectedVersion: number,
    retentionMs: number,
    evidence: readonly string[],
    now = Date.now(),
  ): Promise<boolean> {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 1 || evidence.length === 0) {
      throw new ManagedTaskInvariantError('shutdown retention requires positive ttl and evidence');
    }
    const result = await this.pool.query(
      `UPDATE managed_account_work_lanes
          SET lease_expires_at=$1, in_flight_evidence=$2, version=version+1, updated_at=$3
        WHERE execution_target=$4 AND account_id=$5 AND lease_owner=$6 AND version=$7`,
      [new Date(now + retentionMs), JSON.stringify(evidence), new Date(now), target,
        accountId, leaseOwner, expectedVersion],
    );
    return result.rowCount === 1;
  }

  async releaseManagedSafely(
    target: ExecutionTarget,
    accountId: string,
    runId: string,
    leaseOwner: string,
    expectedVersion: number,
  ): Promise<'released' | 'retained' | 'lost'> {
    const result = await this.pool.query(
      `DELETE FROM managed_account_work_lanes AS lane
        WHERE lane.execution_target=$1 AND lane.account_id=$2
          AND lane.owner_kind='managed' AND lane.managed_run_id=$3
          AND lane.lease_owner=$4 AND lane.version=$5
          AND NOT EXISTS (
            SELECT 1 FROM execution_attempts AS attempt
             WHERE attempt.execution_target=lane.execution_target
               AND attempt.run_id=lane.managed_run_id
               AND attempt.status IN ('dispatching','submitted_unknown')
          )`,
      [target, accountId, runId, leaseOwner, expectedVersion],
    );
    if (result.rowCount === 1) return 'released';
    const lane = await this.observe(target, accountId);
    if (!lane || lane.ownerKind !== 'managed' || lane.managedRunId !== runId || lane.leaseOwner !== leaseOwner) {
      return 'lost';
    }
    return 'retained';
  }
}
