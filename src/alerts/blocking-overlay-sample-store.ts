/**
 * 阻断弹窗现场样本存储（blocking_overlay_samples 表，PostgreSQL）。
 *
 * change blocking-overlay-dom-capture。目的只有一个：**把现场留下来，供后续独立开发**
 * （认出弹窗 / 点中其中按钮 / 判定属于哪一类阻断）。本存储不参与任何判定与处置。
 *
 * 三条与 alerts 刻意不同的性质：
 *  ① **结构原样存**（JSONB）：MUST NOT 在留存前拍平成给人读的文本——拍平后就再也聚类不了，
 *     而「照着结构写代码」正是本表存在的全部意义；
 *  ② **不受告警去重冷却影响**：写入点在冷却判定之前。冷却窗内被抑制告警的上报同样留样本，
 *     否则弹窗越随机越攒不起来；
 *  ③ **幂等靠边缘生成的 captureId**：同一次上报重投 MUST NOT 写出第二条。
 *
 * 不叠第二道限流：上报本身已是 episode 级去重（边缘 reportedBlockingKind 保证一个阻断
 * episode 只发一次 detected），样本量天然有界。再加冷却等于把 alerts 的问题原样搬进新表。
 */

import { createHash } from 'node:crypto';
import pg from 'pg';
import { DEFAULT_PG_CONFIG } from 'aidcp-kernel/kernel/pg-config.js';
import { ensureCapabilitySchema } from '../schema/schema-capability.js';

const { Pool } = pg;

/** 本表由 migrations/0115 创建；此处只记版本号，供探不到时说得出「补跑哪一条」。 */
export const BLOCKING_OVERLAY_SAMPLES_SINCE_VERSION = '0115_blocking_overlay_samples';

export interface BlockingOverlaySampleInput {
  /** 边缘生成的采集标识。空则不写——无标识的样本既对不上告警，也无法幂等。 */
  captureId: string;
  platform?: string;
  edgeId?: string;
  accountId?: string;
  /** 阻断类别（captcha / unknown）。 */
  kind: string;
  /** 采集三态（captured / none_visible / failed）。 */
  status: string;
  url?: string;
  /** 遮罩文案，仅用于算指纹；原文本身在 payload 里。 */
  text?: string;
  capturedAt?: number;
  /** 采集结果原样（含容器、可点击子元素、HTML 原文、截断标记）。 */
  payload: unknown;
}

export interface BlockingOverlaySampleStore {
  init(): Promise<void>;
  /**
   * 写一条样本。返回是否真的新写入（false = 该 captureId 已存在，幂等命中）。
   * 绝不假成功：重复写入如实回 false，而不是宣称又存了一条。
   */
  record(input: BlockingOverlaySampleInput): Promise<{ inserted: boolean }>;
  close?(): Promise<void>;
}

/**
 * 文案指纹：同形态弹窗聚类用。
 *
 * 归一化（压空白、小写）后取 sha256 前 16 位。刻意**不**把指纹当作采集标识——
 * 指纹会把同形态的多次独立出现折叠成一条，那正是标识必须由边缘另行生成的原因。
 */
export function overlayTextDigest(text: string | undefined): string | undefined {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!clean) return undefined;
  return createHash('sha256').update(clean).digest('hex').slice(0, 16);
}

export interface PgBlockingOverlaySampleStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
}

export class PgBlockingOverlaySampleStore implements BlockingOverlaySampleStore {
  private readonly pool: pg.Pool;

  constructor(options: PgBlockingOverlaySampleStoreOptions = {}) {
    this.pool =
      options.pool ??
      new Pool({
        host: options.host ?? DEFAULT_PG_CONFIG.host,
        port: options.port ?? DEFAULT_PG_CONFIG.port,
        database: options.database ?? DEFAULT_PG_CONFIG.database,
        user: options.user ?? DEFAULT_PG_CONFIG.user,
        password: options.password ?? DEFAULT_PG_CONFIG.password,
      });
  }

  async init(): Promise<void> {
    // DDL 单一所有者：只探测、不建表。探不到即带 version id 报错并 fail-closed。
    //
    // **`ddl` 刻意是空的、要求全部走 `requiredObjects`**：运行时 DDL 棘轮（AC-SCHEMA-DDL-OWNER，
    // 只减不增）禁止为了新 schema 在 `src/` 下再写一段建表语句。表由 migrations/0115 建，
    // 这里只声明「探测需要哪些表 / 列 / 索引」。照 src/delegated-task/operator-command-ledger.ts。
    await ensureCapabilitySchema(this.pool, {
      capability: 'blocking_overlay_samples',
      sinceVersion: BLOCKING_OVERLAY_SAMPLES_SINCE_VERSION,
      ddl: [],
      requiredObjects: {
        tables: {
          blocking_overlay_samples: [
            'capture_id',
            'platform',
            'edge_id',
            'account_id',
            'kind',
            'status',
            'url',
            'text_digest',
            'captured_at',
            'payload',
            'created_at',
          ],
        },
        // 幂等键必须探到：缺了它 ON CONFLICT 会在真机上直接报错，而不是安静地去重。
        indexes: { uq_blocking_overlay_samples_capture: 'blocking_overlay_samples' },
      },
    });
  }

  async record(input: BlockingOverlaySampleInput): Promise<{ inserted: boolean }> {
    const captureId = input.captureId.trim();
    if (!captureId) throw new Error('blocking overlay sample requires a captureId');
    const { rowCount } = await this.pool.query(
      `INSERT INTO blocking_overlay_samples
         (capture_id, platform, edge_id, account_id, kind, status, url, text_digest, captured_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (capture_id) DO NOTHING`,
      [
        captureId,
        input.platform ?? null,
        input.edgeId ?? null,
        input.accountId ?? null,
        input.kind,
        input.status,
        input.url ?? null,
        overlayTextDigest(input.text) ?? null,
        input.capturedAt !== undefined ? new Date(input.capturedAt) : null,
        JSON.stringify(input.payload ?? null),
      ],
    );
    return { inserted: (rowCount ?? 0) > 0 };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
