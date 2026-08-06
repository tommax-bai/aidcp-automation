/**
 * 受限处置策略配置存储（restricted_policy_config 表，PostgreSQL）—— 全局单例。
 *
 * change restricted-policy-global-config：受限（restricted）的处置力度成为可配——
 * `mode`（browse_only 只浏览 / full_pause 浏览也暂停）+ `recoveryHours`（自动恢复时长，小时）。
 * 复刻 resume-config-store 全套形态：落库（至多一行 id=1）+ 内存镜像热加载 +
 * `writeWithMirrorBump`（写入与跨进程失效信号同事务，dev/ol 共库双进程）。
 *
 * 消费方：RiskController（view 判定 + 状态机恢复窗口）与自动恢复扫描器，均经
 * `src/risk/restricted-policy.ts` 的 RestrictedPolicyProvider 接口现读本镜像
 * （依赖方向保持 config → risk 单向；risk/ 对 config/ 的 import 必须为 0）。
 *
 * 安全不变量（与 resume store 同款）：
 * - 绝不 brick：缺行 / 字段非法 → 逐项回落写死默认（browse_only / 72）；永不抛。
 * - 写库成功才刷内存镜像。
 * - 零回归：表为空时取值与写死默认逐位一致。
 *
 * 红线：本 store 只读写 restricted_policy_config；绝不碰风控状态单写路径
 * （risk_state / setQuotaLevel / applySignal）、不经协议。
 * 表由 migrations/0116_restricted_policy_config.sql 建；本文件**刻意零运行时 DDL**
 * （AC-SCHEMA-DDL-OWNER 棘轮只减不增），init 只按 requiredObjects 探测。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from 'aidcp-kernel/kernel/pg-config.js';
import { writeWithMirrorBump, type MirrorVersionBumper } from 'aidcp-kernel/kernel/config-mirror-bump-types.js';
import {
  DEFAULT_RESTRICTED_POLICY_MODE,
  DEFAULT_RESTRICTED_RECOVERY_HOURS,
  type RestrictedPolicyMode,
  type RestrictedPolicyProvider,
} from '../risk/restricted-policy.js';
import { ensureCapabilitySchema } from '../schema/schema-capability.js';

const { Pool } = pg;

/** 全局受限处置策略行 + 审计（面板回显用）。null 表示该列未覆盖（回落写死默认）。 */
export interface RestrictedPolicyRow {
  mode: RestrictedPolicyMode | null;
  recoveryHours: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** 写补丁：未传的字段保持原值（无原值则该列写 null = 回落写死默认）。 */
export interface RestrictedPolicyPatch {
  mode?: RestrictedPolicyMode;
  recoveryHours?: number;
}

export interface RestrictedPolicyStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
  /** 跨进程失效通道：写入与版本推进同事务。缺省 = 不推版本（仅本进程写透镜像）。 */
  mirrorVersionBumper?: MirrorVersionBumper;
}

interface RestrictedPolicyDbRow {
  mode: string | null;
  recovery_hours: number | string | null;
  updated_at: Date | string | null;
  updated_by: string | null;
}

const VALID_MODES: readonly RestrictedPolicyMode[] = ['browse_only', 'full_pause'];

function validMode(raw: string | null | undefined): RestrictedPolicyMode | undefined {
  return raw != null && (VALID_MODES as readonly string[]).includes(raw)
    ? (raw as RestrictedPolicyMode)
    : undefined;
}

/** 正的有限整数才算有效覆盖值，否则视作缺（回落写死默认 72）。 */
function validHours(raw: number | string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

export class RestrictedPolicyStore implements RestrictedPolicyProvider {
  private readonly pool: pg.Pool;
  /** 是否自己建的池（注入的共享属主池 MUST NOT 被本 store end 掉，见 resume store 同款注释）。 */
  private readonly ownsPool: boolean;
  private readonly mirrorVersionBumper?: MirrorVersionBumper;
  /** 全局单行镜像；null = 库无行（全回落写死默认）。 */
  private cache: RestrictedPolicyRow | null = null;

  constructor(options: RestrictedPolicyStoreOptions = {}) {
    this.mirrorVersionBumper = options.mirrorVersionBumper;
    this.pool =
      options.pool ??
      new Pool({
        host: options.host ?? DEFAULT_PG_CONFIG.host,
        port: options.port ?? DEFAULT_PG_CONFIG.port,
        database: options.database ?? DEFAULT_PG_CONFIG.database,
        user: options.user ?? DEFAULT_PG_CONFIG.user,
        password: options.password ?? DEFAULT_PG_CONFIG.password,
      });
    this.ownsPool = options.pool === undefined;
  }

  /** schema 探测（不建表） + 载入内存镜像。 */
  async init(): Promise<void> {
    // DDL 单一所有者：只探测、不建表；探不到即带 version id 明确报错并 fail-closed。
    // `ddl` 刻意为空、全部走 `requiredObjects`（运行时 DDL 棘轮只减不增，表由 migrations/0116 建）。
    await ensureCapabilitySchema(this.pool, {
      capability: 'restricted_policy',
      sinceVersion: '0116_restricted_policy_config',
      ddl: [],
      requiredObjects: {
        tables: {
          restricted_policy_config: ['id', 'mode', 'recovery_hours', 'updated_at', 'updated_by'],
        },
      },
    });
    await this.reload();
  }

  /** 跨进程失效刷新入口：只由刷新链在版本变化时调用；`reload()` 保持 private。 */
  async refreshFromAuthority(): Promise<void> {
    await this.reload();
  }

  private async reload(): Promise<void> {
    const { rows } = await this.pool.query<RestrictedPolicyDbRow>(
      `SELECT mode, recovery_hours, updated_at, updated_by FROM restricted_policy_config WHERE id = 1`,
    );
    this.cache = rows[0] ? this.rowFromDb(rows[0]) : null;
  }

  private rowFromDb(r: RestrictedPolicyDbRow): RestrictedPolicyRow {
    return {
      mode: validMode(r.mode) ?? null,
      recoveryHours:
        r.recovery_hours === null || r.recovery_hours === undefined ? null : Number(r.recovery_hours),
      updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
      updatedBy: r.updated_by ?? null,
    };
  }

  // ─── RestrictedPolicyProvider（逐项回落写死默认、同步零 IO、永不抛） ───────────

  mode(): RestrictedPolicyMode {
    return validMode(this.cache?.mode) ?? DEFAULT_RESTRICTED_POLICY_MODE;
  }

  recoveryHours(): number {
    return validHours(this.cache?.recoveryHours) ?? DEFAULT_RESTRICTED_RECOVERY_HOURS;
  }

  /** 取全局覆盖行（无行 undefined，面板审计 / overridden 判定用）。 */
  getRow(): RestrictedPolicyRow | undefined {
    return this.cache ?? undefined;
  }

  /**
   * 写库 + 刷内存镜像（热加载）。未传的字段保持原值（无原值则写 null = 回落写死默认）。
   * 先写库成功、再刷镜像。调用方（facade）应已校验取值合法。
   */
  async set(patch: RestrictedPolicyPatch, updatedBy: string): Promise<RestrictedPolicyRow> {
    const prev = this.cache;
    const next = {
      mode: patch.mode ?? prev?.mode ?? null,
      recoveryHours: patch.recoveryHours ?? prev?.recoveryHours ?? null,
    };

    // 写库与版本推进同事务：写库失败 → 整体回滚 → 版本不进、镜像不刷。
    const { rows } = await writeWithMirrorBump(
      this.pool,
      this.mirrorVersionBumper,
      'restricted_policy_config',
      (q) =>
        q.query<RestrictedPolicyDbRow>(
          `INSERT INTO restricted_policy_config (id, mode, recovery_hours, updated_at, updated_by)
           VALUES (1, $1, $2, now(), $3)
           ON CONFLICT (id)
           DO UPDATE SET mode = EXCLUDED.mode,
                         recovery_hours = EXCLUDED.recovery_hours,
                         updated_at = now(), updated_by = EXCLUDED.updated_by
           RETURNING mode, recovery_hours, updated_at, updated_by`,
          [next.mode, next.recoveryHours, updatedBy],
        ),
    );
    const result = rows[0] ? this.rowFromDb(rows[0]) : { ...next, updatedAt: null, updatedBy };
    this.cache = result;
    return result;
  }

  /** 只 end **自己建的**池；注入的属主池由组合根掌控生命周期（见 ownsPool）。 */
  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
