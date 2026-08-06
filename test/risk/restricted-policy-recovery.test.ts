/**
 * change restricted-policy-global-config：受限处置策略 + 自动恢复的判定面单测。
 *
 * 覆盖（tasks 2.2 / 3.1 / 3.4 的判定内核）：
 *  - 恢复基点 = max(statusSince, lastSignalAt)：手动受限（无信号时间戳）不被秒恢复；
 *  - 恢复窗口注入：recoveryHours 改值即刻影响判窗；frozen 永不满窗；
 *  - explain('view')：full_pause 拒绝并带剩余等待；browse_only 保持豁免；互动照拒；
 *  - 「恢复时刻」三处同源：view 拒绝的 retryAfterMs / controller.recoveryAt / 扫描器判窗；
 *  - 扫描器：恢复到 warned 而非 normal、warned 满 7d 回 normal、非属主跳过、
 *    写拒诚实放弃不重试、多账号串行成批恢复（部署首扫路径）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RESTRICTED_RECOVERY_HOURS,
  FALLBACK_RESTRICTED_POLICY,
  RiskController,
  RiskRecoverySweeper,
  RiskStateMachine,
  WARNED_RECOVERY_MS,
  createRiskState,
  recoveryAtMs,
  restrictedRecoveryWindowMs,
  type RecoverySweepController,
  type RestrictedPolicyProvider,
  type RiskState,
} from '../../src/risk/index.js';

const HOUR = 3_600_000;

function policy(mode: 'browse_only' | 'full_pause', hours: number): RestrictedPolicyProvider & { setHours(h: number): void; setMode(m: 'browse_only' | 'full_pause'): void } {
  let currentMode = mode;
  let currentHours = hours;
  return {
    mode: () => currentMode,
    recoveryHours: () => currentHours,
    setHours: (h: number) => { currentHours = h; },
    setMode: (m: 'browse_only' | 'full_pause') => { currentMode = m; },
  };
}

// ─── 状态机：恢复基点与窗口注入（task 2.2） ─────────────────────────────────────

test('手动受限（无 lastSignalAt）满窗前不恢复、满窗恢复（秒恢复漏洞已堵）', () => {
  const machine = new RiskStateMachine(policy('browse_only', 72));
  // manual_restrict 不记信号时间戳：lastSignalAt 保持 null，statusSince = 1000。
  let state = machine.transition(createRiskState('acct', 0), { kind: 'manual_restrict', at: 1000 });
  assert.equal(state.status, 'restricted');
  assert.equal(state.lastSignalAt, null);
  // 旧守卫（只看 lastSignalAt）在这里会直接放行恢复——那正是要堵的洞。
  state = machine.transition(state, { kind: 'recovered', at: 1000 + 72 * HOUR - 1 });
  assert.equal(state.status, 'restricted', '满窗前 MUST NOT 恢复');
  state = machine.transition(state, { kind: 'recovered', at: 1000 + 72 * HOUR });
  assert.equal(state.status, 'warned', '满窗恢复到 warned（逐级回迁，不直跳 normal）');
});

test('窗口内新信号顺延恢复基点', () => {
  const machine = new RiskStateMachine(policy('browse_only', 72));
  let state = machine.transition(createRiskState('acct', 0), { kind: 'manual_restrict', at: 1000 });
  // 受限期间又来软信号（restricted 状态不变，但 lastSignalAt 前移）。
  state = machine.transition(state, { kind: 'light', at: 1000 + 10 * HOUR });
  assert.equal(state.status, 'restricted');
  state = machine.transition(state, { kind: 'recovered', at: 1000 + 72 * HOUR });
  assert.equal(state.status, 'restricted', '基点已顺延到新信号时刻，原窗口不再成立');
  state = machine.transition(state, { kind: 'recovered', at: 1000 + 82 * HOUR });
  assert.equal(state.status, 'warned');
});

test('recoveryHours 改值即刻影响判窗（热生效，无需重新进入状态）', () => {
  const p = policy('browse_only', 72);
  const machine = new RiskStateMachine(p);
  const state = machine.transition(createRiskState('acct', 0), { kind: 'manual_restrict', at: 0 });
  assert.equal(machine.transition(state, { kind: 'recovered', at: 24 * HOUR }).status, 'restricted');
  p.setHours(24);
  assert.equal(machine.transition(state, { kind: 'recovered', at: 24 * HOUR }).status, 'warned', '改成 24h 后同一时刻已满窗');
});

test('frozen 永不满窗（无论停留多久，唯一出口是人工）', () => {
  const machine = new RiskStateMachine(policy('browse_only', 1));
  const state = machine.transition(createRiskState('acct', 0), { kind: 'fatal', at: 1000 });
  assert.equal(state.status, 'frozen');
  const later = machine.transition(state, { kind: 'recovered', at: 1000 + 365 * 24 * HOUR });
  assert.equal(later.status, 'frozen');
  assert.equal(recoveryAtMs(state, 1 * HOUR), null, '同源函数对 frozen 恒回 null');
});

test('未注入策略 → 状态机回落写死默认 72h（零回归）', () => {
  const machine = new RiskStateMachine();
  assert.equal(machine.restrictedWindowMs(), DEFAULT_RESTRICTED_RECOVERY_HOURS * HOUR);
  assert.equal(restrictedRecoveryWindowMs(FALLBACK_RESTRICTED_POLICY), 72 * HOUR);
});

// ─── controller：view 闸按模式（task 3.1）＋ 三处同源 ──────────────────────────

async function restrictedController(p: RestrictedPolicyProvider, clock: () => number): Promise<RiskController> {
  const controller = new RiskController({ accountId: 'acct', clock, restrictedPolicy: p });
  await controller.applySignal({ kind: 'manual_restrict' });
  assert.equal(controller.getState().status, 'restricted');
  return controller;
}

test('full_pause：explain(view) 拒绝、reason state:restricted、retryAfterMs = 恢复时刻 − now', async () => {
  let now = 1000;
  const controller = await restrictedController(policy('full_pause', 48), () => now);
  now = 1000 + 10 * HOUR;
  const decision = controller.explain('view');
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'state:restricted');
  assert.equal(decision.retryAfterMs, 38 * HOUR, '进入受限 10h，48h 窗口还剩 38h');
  // 互动拒绝与配额归零不变。
  assert.equal(controller.explain('like').allowed, false);
  assert.equal(controller.explain('like').reason, 'state:restricted');
  assert.equal(controller.effectiveQuotas().day.like, 0);
});

test('browse_only：explain(view) 保持豁免（现状零回归），互动仍拒', async () => {
  const controller = await restrictedController(policy('browse_only', 48), () => 1000);
  assert.equal(controller.explain('view').allowed, true);
  assert.equal(controller.explain('comment').allowed, false);
});

test('策略每次判定现读：模式热切换即刻改变 view 判定', async () => {
  const p = policy('browse_only', 48);
  const controller = await restrictedController(p, () => 1000);
  assert.equal(controller.explain('view').allowed, true);
  p.setMode('full_pause');
  assert.equal(controller.explain('view').allowed, false, '切 full_pause 后即刻拒绝');
  p.setMode('browse_only');
  assert.equal(controller.explain('view').allowed, true, '切回即刻放行（安全方向也不粘滞）');
});

test('恢复时刻三处同源：view 拒绝 / controller.recoveryAt / 扫描器判窗读数一致', async () => {
  let now = 1000;
  const p = policy('full_pause', 48);
  const controller = await restrictedController(p, () => now);
  now = 1000 + 7 * HOUR;
  const state = controller.getState();
  const fromController = controller.recoveryAt();
  const fromFreeFunction = recoveryAtMs(state, restrictedRecoveryWindowMs(p)); // 扫描器用的算式
  const fromExplain = now + (controller.explain('view').retryAfterMs ?? Number.NaN);
  assert.equal(fromController, fromFreeFunction);
  assert.equal(fromController, fromExplain);
  assert.equal(fromController, state.statusSince + 48 * HOUR);
});

test('恢复到 warned 后 view 放行（full_pause 下浏览闭环可被重新驱动）', async () => {
  let now = 1000;
  const controller = await restrictedController(policy('full_pause', 48), () => now);
  now = 1000 + 48 * HOUR;
  await controller.applySignal({ kind: 'recovered' });
  assert.equal(controller.getState().status, 'warned');
  assert.equal(controller.explain('view').allowed, true, 'warned 语义放行 view');
});

// ─── 扫描器（task 3.4） ────────────────────────────────────────────────────────

interface SweepFixtureAccount {
  state: RiskState;
  owner: 'dev' | 'ol' | null;
  failWrite?: boolean;
}

function sweeperFixture(accounts: Record<string, SweepFixtureAccount>, nowRef: { now: number }, p: RestrictedPolicyProvider) {
  const applied: string[] = [];
  const resolveOrder: string[] = [];
  let listedWith: readonly string[] | null = null;
  const machineFor = () => new RiskStateMachine(p);
  const sweeper = new RiskRecoverySweeper({
    store: {
      listByStatus: async (statuses) => {
        listedWith = statuses;
        return Object.values(accounts)
          .filter((a) => (statuses as readonly string[]).includes(a.state.status))
          .map((a) => ({
            accountId: a.state.accountId,
            status: a.state.status,
            lastSignalAt: a.state.lastSignalAt,
            statusSince: a.state.statusSince,
          }));
      },
    },
    resolveController: async (accountId): Promise<RecoverySweepController> => {
      resolveOrder.push(accountId);
      const acct = accounts[accountId]!;
      return {
        getState: () => ({ ...acct.state }),
        recoveryAt: () => recoveryAtMs(acct.state, restrictedRecoveryWindowMs(p)),
        applySignal: async (signal) => {
          if (acct.failWrite) throw new Error(`risk_state_taken_over account=${accountId}`);
          applied.push(accountId);
          acct.state = machineFor().transition(acct.state, { ...signal, at: nowRef.now } as never, nowRef.now);
          return { ...acct.state };
        },
      };
    },
    executionTarget: 'dev',
    ownership: {
      resolveExecutionTarget: async (accountId) => {
        const owner = accounts[accountId]?.owner;
        return owner ? { outcome: 'owned', target: owner } : { outcome: 'unowned' };
      },
    },
    restrictedPolicy: p,
    clock: () => nowRef.now,
    logger: { log: () => undefined, warn: () => undefined },
  });
  return { sweeper, applied, resolveOrder, listedWith: () => listedWith };
}

function stateOf(accountId: string, status: RiskState['status'], statusSince: number, lastSignalAt: number | null = null): RiskState {
  return { accountId, status, quotaLevel: 'normal', signalCount: 0, lastSignalAt, statusSince, updatedAt: statusSince };
}

test('扫描器：restricted 满窗恢复到 warned（不直跳 normal），未满窗不动', async () => {
  const nowRef = { now: 100 * HOUR };
  const p = policy('browse_only', 72);
  const accounts: Record<string, SweepFixtureAccount> = {
    due: { state: stateOf('due', 'restricted', nowRef.now - 73 * HOUR), owner: 'dev' },
    early: { state: stateOf('early', 'restricted', nowRef.now - 10 * HOUR), owner: 'dev' },
  };
  const { sweeper, applied, listedWith } = sweeperFixture(accounts, nowRef, p);
  const result = await sweeper.sweepOnce();
  assert.deepEqual(listedWith(), ['warned', 'restricted'], 'frozen 不进查询（永不被扫）');
  assert.deepEqual(applied, ['due']);
  assert.equal(accounts.due!.state.status, 'warned', '恢复到 warned 而非 normal');
  assert.equal(accounts.early!.state.status, 'restricted');
  assert.equal(result.restrictedRecovered, 1);
  assert.equal(result.warnedRecovered, 0);
});

test('扫描器：warned 满 7d 回 normal；两种模式下自动恢复都生效', async () => {
  for (const mode of ['browse_only', 'full_pause'] as const) {
    const nowRef = { now: 1000 * HOUR };
    const p = policy(mode, 72);
    const accounts: Record<string, SweepFixtureAccount> = {
      w: { state: stateOf('w', 'warned', nowRef.now - WARNED_RECOVERY_MS - 1) as RiskState, owner: 'dev' },
    };
    const { sweeper } = sweeperFixture(accounts, nowRef, p);
    const result = await sweeper.sweepOnce();
    assert.equal(accounts.w!.state.status, 'normal', `mode=${mode} 下 warned 满 7d 回 normal`);
    assert.equal(result.warnedRecovered, 1);
  }
});

test('扫描器：非属主账号跳过（dev/ol 共库不形成第二写者）', async () => {
  const nowRef = { now: 100 * HOUR };
  const p = policy('browse_only', 24);
  const accounts: Record<string, SweepFixtureAccount> = {
    mine: { state: stateOf('mine', 'restricted', nowRef.now - 25 * HOUR), owner: 'dev' },
    theirs: { state: stateOf('theirs', 'restricted', nowRef.now - 25 * HOUR), owner: 'ol' },
    orphan: { state: stateOf('orphan', 'restricted', nowRef.now - 25 * HOUR), owner: null },
  };
  const { sweeper, applied } = sweeperFixture(accounts, nowRef, p);
  const result = await sweeper.sweepOnce();
  assert.deepEqual(applied, ['mine']);
  assert.equal(result.skippedNotOwned, 2);
  assert.equal(accounts.theirs!.state.status, 'restricted');
});

test('扫描器：写拒诚实放弃、不重试、不影响其它账号（部署首扫成批恢复路径）', async () => {
  const nowRef = { now: 100 * HOUR };
  const p = policy('browse_only', 24);
  const accounts: Record<string, SweepFixtureAccount> = {
    a1: { state: stateOf('a1', 'restricted', nowRef.now - 30 * HOUR), owner: 'dev' },
    a2: { state: stateOf('a2', 'restricted', nowRef.now - 30 * HOUR), owner: 'dev', failWrite: true },
    a3: { state: stateOf('a3', 'restricted', nowRef.now - 30 * HOUR), owner: 'dev' },
    a4: { state: stateOf('a4', 'warned', nowRef.now - WARNED_RECOVERY_MS - HOUR), owner: 'dev' },
  };
  const { sweeper, applied, resolveOrder } = sweeperFixture(accounts, nowRef, p);
  const result = await sweeper.sweepOnce();
  // 存量成批恢复：逐账号串行（resolve 顺序 = 库行顺序），一个写拒不拖垮整轮。
  assert.deepEqual(resolveOrder, ['a1', 'a2', 'a3', 'a4']);
  assert.deepEqual(applied, ['a1', 'a3', 'a4'], '写拒的 a2 只放弃、绝不重试');
  assert.equal(result.restrictedRecovered, 2);
  assert.equal(result.warnedRecovered, 1);
  assert.equal(result.abandoned, 1);
  assert.equal(accounts.a2!.state.status, 'restricted', '写拒账号状态不动（下一轮属主自会处理）');
});

test('扫描器：controller 内存态比库行新鲜时以 controller 复判为准（不发无效信号）', async () => {
  const nowRef = { now: 100 * HOUR };
  const p = policy('browse_only', 24);
  // 库行看着满窗，但 controller 内存态刚收到新信号（lastSignalAt 顺延）→ 第二道判窗拦下。
  const fresh = stateOf('acct', 'restricted', nowRef.now - 30 * HOUR, nowRef.now - HOUR);
  const stale = { accountId: 'acct', status: 'restricted' as const, lastSignalAt: null, statusSince: nowRef.now - 30 * HOUR };
  const applied: string[] = [];
  const sweeper = new RiskRecoverySweeper({
    store: { listByStatus: async () => [stale] },
    resolveController: async () => ({
      getState: () => ({ ...fresh }),
      recoveryAt: () => recoveryAtMs(fresh, restrictedRecoveryWindowMs(p)),
      applySignal: async () => {
        applied.push('acct');
        return { ...fresh };
      },
    }),
    executionTarget: 'dev',
    ownership: { resolveExecutionTarget: async () => ({ outcome: 'owned', target: 'dev' }) },
    restrictedPolicy: p,
    clock: () => nowRef.now,
    logger: { log: () => undefined, warn: () => undefined },
  });
  await sweeper.sweepOnce();
  assert.deepEqual(applied, [], '内存态未满窗 → 不发恢复信号');
});
