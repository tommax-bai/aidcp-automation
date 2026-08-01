import pg from 'pg';
import { DEFAULT_PG_CONFIG } from 'aidcp-kernel/kernel/pg-config.js';
import {
  SchemaCapabilityError,
  classifySchemaCapability,
  type SchemaProber,
} from 'aidcp-kernel/kernel/schema-capability-contract.js';
import type { ExecutionTarget } from '../contracts/common.js';

const { Pool } = pg;

export interface ManagedTaskStoreOptions {
  pool?: pg.Pool;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  schemaProber: SchemaProber;
}

export interface ManagedTaskSchemaRequirement {
  capability: string;
  sinceVersion: string;
  tables: Map<string, Set<string>>;
  indexes: Map<string, string>;
}

export class ManagedTaskInvariantError extends Error {
  readonly code = 'managed_task_invariant_violation';

  constructor(detail: string) {
    super(`managed_task_invariant_violation: ${detail}`);
    this.name = 'ManagedTaskInvariantError';
  }
}

export abstract class ManagedTaskStoreBase {
  protected readonly pool: pg.Pool;
  private readonly ownedPool?: pg.Pool;
  private readonly requirement: ManagedTaskSchemaRequirement;
  private readonly schemaProber: SchemaProber;

  constructor(requirement: ManagedTaskSchemaRequirement, options: ManagedTaskStoreOptions) {
    this.requirement = requirement;
    this.schemaProber = options.schemaProber;
    let pool = options.pool;
    if (!pool) {
      pool = new Pool({
        host: options.host ?? DEFAULT_PG_CONFIG.host,
        port: options.port ?? DEFAULT_PG_CONFIG.port,
        database: options.database ?? DEFAULT_PG_CONFIG.database,
        user: options.user ?? DEFAULT_PG_CONFIG.user,
        password: options.password ?? DEFAULT_PG_CONFIG.password,
      });
      this.ownedPool = pool;
    }
    this.pool = pool;
  }

  async init(): Promise<void> {
    const shape = await this.schemaProber(this.pool, [...this.requirement.tables.keys()]);
    const verdict = classifySchemaCapability(
      { tables: this.requirement.tables, indexes: this.requirement.indexes },
      shape,
    );
    if (verdict.status !== 'ready') {
      throw new SchemaCapabilityError(
        {
          capability: this.requirement.capability,
          sinceVersion: this.requirement.sinceVersion,
          ddl: [],
        },
        verdict,
      );
    }
  }

  async close(): Promise<void> {
    if (this.ownedPool) await this.ownedPool.end();
  }
}

export function toEpochMillis(value: Date | string): number {
  return new Date(value).getTime();
}

export function toNullableEpochMillis(value: Date | string | null): number | null {
  return value === null ? null : toEpochMillis(value);
}

export function assertCallTarget(expected: ExecutionTarget, actual: ExecutionTarget): void {
  if (expected !== actual) {
    throw new ManagedTaskInvariantError(`call target ${expected} does not match record target ${actual}`);
  }
}
