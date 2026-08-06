import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { RestrictedPolicyStore } from '../src/config/restricted-policy-store.js';
import { createRestrictedPolicyPanel, RECOVERY_HOURS_MAX } from '../src/config/restricted-policy-facade.js';
import { fakeSchemaProbe } from './fixtures/schema-probe.js';

// store 自身零运行时 DDL（AC-SCHEMA-DDL-OWNER 棘轮）；假库形状从迁移 0116 的 DDL 同文推导。
const MIGRATION_0116_DDL = `
CREATE TABLE IF NOT EXISTS restricted_policy_config (
  id             INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  mode           TEXT CHECK (mode IN ('browse_only','full_pause')),
  recovery_hours INTEGER,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     TEXT
);
`;
const schemaProbe = fakeSchemaProbe(MIGRATION_0116_DDL);

interface SeedRow {
  mode: string | null;
  recovery_hours: number | null;
}

/** 内存假 pool（全局单行）：路由 restricted_policy_config 的探测 / SELECT(id=1) / upsert(RETURNING)。 */
function fakePool(seed?: SeedRow) {
  let row: (SeedRow & { updated_at: string; updated_by: string }) | null = seed
    ? { ...seed, updated_at: '2026-08-06T00:00:00.000Z', updated_by: 'seed' }
    : null;
  let failWrite = false;
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      const probe = schemaProbe(sql);
      if (probe) return probe;
      if (sql.includes('CREATE TABLE')) return { rows: [] };
      if (sql.includes('INSERT INTO restricted_policy_config')) {
        if (failWrite) throw new Error('db down');
        const [mode, recovery_hours, updated_by] = params as [string | null, number | null, string];
        row = { mode, recovery_hours, updated_at: '2026-08-06T01:00:00.000Z', updated_by };
        return { rows: [row] };
      }
      if (sql.includes('FROM restricted_policy_config')) return { rows: row ? [row] : [] };
      return { rows: [] };
    },
  };
  return { pool: pool as unknown as pg.Pool, setFailWrite: (v: boolean) => { failWrite = v; } };
}

test('零回归：表为空 → 回落写死默认 browse_only / 72（与配置化之前逐位一致）', async () => {
  const { pool } = fakePool();
  const store = new RestrictedPolicyStore({ pool });
  await store.init();
  assert.equal(store.mode(), 'browse_only');
  assert.equal(store.recoveryHours(), 72);
  assert.equal(store.getRow(), undefined);
});

test('命中全局行 → 用库值；非法值逐项回落默认（绝不 brick）', async () => {
  const { pool } = fakePool({ mode: 'full_pause', recovery_hours: 24 });
  const store = new RestrictedPolicyStore({ pool });
  await store.init();
  assert.equal(store.mode(), 'full_pause');
  assert.equal(store.recoveryHours(), 24);

  const bad = fakePool({ mode: 'nuke_from_orbit', recovery_hours: -3 });
  const badStore = new RestrictedPolicyStore({ pool: bad.pool });
  await badStore.init();
  assert.equal(badStore.mode(), 'browse_only', '未知模式回落默认');
  assert.equal(badStore.recoveryHours(), 72, '非正小时数回落默认');
});

test('set 后即时热加载 + 部分写未传字段保持原值', async () => {
  const { pool } = fakePool({ mode: 'browse_only', recovery_hours: 48 });
  const store = new RestrictedPolicyStore({ pool });
  await store.init();
  await store.set({ mode: 'full_pause' }, 'alice'); // 只改模式
  assert.equal(store.mode(), 'full_pause');
  assert.equal(store.recoveryHours(), 48, '未传小时数保持原值');
  assert.equal(store.getRow()?.updatedBy, 'alice');
});

test('写库失败 → 内存镜像不变（写库成功才刷镜像）', async () => {
  const { pool, setFailWrite } = fakePool({ mode: 'browse_only', recovery_hours: 48 });
  const store = new RestrictedPolicyStore({ pool });
  await store.init();
  setFailWrite(true);
  await assert.rejects(store.set({ mode: 'full_pause' }, 'a'));
  assert.equal(store.mode(), 'browse_only', '写失败镜像不变');
});

// ─── facade（task 5.1）：拒非法值、写后回真态 ─────────────────────────────────

test('facade：未知模式 / 非正整数小时 / 越上限整块拒，配置保持原值', async () => {
  const { pool } = fakePool({ mode: 'browse_only', recovery_hours: 48 });
  const store = new RestrictedPolicyStore({ pool });
  await store.init();
  const panel = createRestrictedPolicyPanel({ store });
  for (const patch of [
    { mode: 'both_at_once' as never },
    { recoveryHours: 0 },
    { recoveryHours: -5 },
    { recoveryHours: 1.5 },
    { recoveryHours: RECOVERY_HOURS_MAX + 1 },
  ]) {
    assert.deepEqual(await panel.set(patch, 'mallory'), { ok: false, reason: 'invalid_value' });
  }
  assert.deepEqual(await panel.set({}, 'mallory'), { ok: false, reason: 'no_valid_fields' });
  const view = await panel.getView();
  assert.equal(view.mode, 'browse_only');
  assert.equal(view.recoveryHours, 48, '非法写被拒后配置保持原值');
});

test('facade：合法写回显写后真态（overridden / updatedBy 来自库回读）', async () => {
  const { pool } = fakePool();
  const store = new RestrictedPolicyStore({ pool });
  await store.init();
  const panel = createRestrictedPolicyPanel({ store });
  const before = await panel.getView();
  assert.equal(before.overridden, false, '库无行 → 回显写死默认且 overridden=false');
  const result = await panel.set({ mode: 'full_pause', recoveryHours: 24 }, 'alice');
  assert.ok(result.ok);
  assert.equal(result.view.mode, 'full_pause');
  assert.equal(result.view.recoveryHours, 24);
  assert.equal(result.view.overridden, true);
  assert.equal(result.view.updatedBy, 'alice');
});
