// aidcp:test-owner=derived
/**
 * 养号事实取用口的闸（change restore-automation-risk-quota-inputs）。
 *
 * 这一片守的全是**「不报错、只是判据被换掉」**那一类：
 *
 * - 平台读不到就回落成某个具体平台 ⇒ FB 号按小红书曲线跑，第 1 天差 2.5 倍，零日志；
 * - 绑定歧义时挑一个环境的起点用 ⇒ 替运营做了一个没法复核的选择；
 * - 曲线那条流没到过却交出一份「空曲线」⇒ 等于宣称这个号没有任何逐日上限；
 * - 曲线陈旧就回落写死默认 ⇒ 编译默认很可能比运营配的更松，一陈旧就悄悄放宽。
 *
 * 前两条能用行为断言钉住。**第三条只能按消费方的两处取用写法逐字复现**：
 * 契约只承认「方法不在」这一种缺席，而一个「存在但返回 undefined」的方法在第二处取用点
 * （`?.().totalDays`）会当场炸 —— 所以用例里出现的就是那两个表达式本身，不是它的近似物。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RISK_ACTIONS, type ActionQuota } from 'aidcp-kernel/kernel/risk-contract.js';
import { makeSyncReadFactEnvelope } from 'aidcp-kernel/kernel/sync-read-facts.js';

import { createAutomationNurtureProvider } from '../../src/automation-nurture-provider.js';
import { AutomationSyncReadMirrors } from '../../src/transport/automation-sync-read-mirrors.js';

const FRESH_MS = 60_000;

function quota(view: number): ActionQuota {
  return Object.fromEntries(
    RISK_ACTIONS.map((action) => [action, action === 'view' ? view : 0]),
  ) as ActionQuota;
}

/**
 * 三条流各自可选地喂一份载荷。`readAt` 与 `asOf` 分开传是因为本文件要测**陈旧那一档**——
 * 同一个时刻既写又读，永远只测得到新鲜态。
 */
function mirrorsWith(input: {
  accounts?: { accountId: string; platform: string; createdAt: number | null }[];
  anchors?: {
    accountId: string;
    envKey: string | null;
    slowStartSince: number | null;
    slowStartCompletedAt: number | null;
    ambiguous: boolean;
  }[];
  curve?: { totalDays: number; dailyCaps: ActionQuota[] };
  asOf?: number;
  readAt?: number;
}): AutomationSyncReadMirrors {
  const asOf = input.asOf ?? 1_000;
  const readAt = input.readAt ?? asOf;
  const mirrors = new AutomationSyncReadMirrors('dev', () => readAt);
  const push = (stream: string, value: unknown): void => {
    mirrors.apply(
      makeSyncReadFactEnvelope({
        executionTarget: 'dev',
        stream: stream as never,
        cursor: '1',
        asOf,
        freshUntil: asOf + FRESH_MS,
        value: value as never,
      }),
      'owner_fetch',
    );
  };
  if (input.accounts) {
    push('automation_account_projection', {
      accounts: input.accounts.map((row) => ({
        ...row,
        groupLabel: null,
        status: 'active' as const,
      })),
    });
  }
  if (input.anchors) {
    push('client_environment_automation', {
      blockedEnvironmentKeys: [],
      slowStartAnchors: input.anchors,
    });
  }
  if (input.curve) push('facebook_operation_policy', { environments: [], slowStart: input.curve });
  return mirrors;
}

const BOUND = {
  accountId: 'a1',
  envKey: 'k1',
  slowStartSince: 1_700_000_000_000,
  slowStartCompletedAt: null,
  ambiguous: false,
};

test('副本新鲜：平台、入库时刻、慢启动起点与毕业时刻都如实给出', () => {
  const provider = createAutomationNurtureProvider(
    mirrorsWith({
      accounts: [{ accountId: 'a1', platform: 'facebook', createdAt: 1_600_000_000_000 }],
      anchors: [{ ...BOUND, slowStartCompletedAt: 1_700_600_000_000 }],
    }),
  );
  assert.equal(provider.platformFor('a1'), 'facebook');
  assert.equal(provider.createdAtFor('a1'), 1_600_000_000_000);
  assert.equal(provider.slowStartSinceFor('a1'), 1_700_000_000_000);
  assert.equal(provider.slowStartCompletedAtFor?.('a1'), 1_700_600_000_000);
});

test('账号不在名册里 / 绑定歧义：平台未知、锚点为空，MUST NOT 回落任何具体平台或任取一个环境', () => {
  const provider = createAutomationNurtureProvider(
    mirrorsWith({
      accounts: [{ accountId: 'a1', platform: 'facebook', createdAt: null }],
      anchors: [
        { ...BOUND, accountId: 'a2', envKey: null, slowStartSince: null, ambiguous: true },
      ],
    }),
  );
  // 平台未知 MUST 是 undefined：回落成小红书就是 FB 号按第 1 天 view=50 而非 20 跑。
  assert.equal(provider.platformFor('a9'), undefined);
  assert.equal(provider.createdAtFor('a1'), undefined, 'createdAt 为空 ⇒ 未知，不是 0');
  // 歧义是一个**真结论**：挑一个环境的起点用等于替运营做了个没法复核的选择。
  assert.equal(provider.slowStartSinceFor('a2'), null);
  assert.equal(provider.slowStartSinceFor('a1'), null, '名册里没有这个账号 ⇒ 没有锚点');
});

test('曲线那条流一次都没到过：方法本身不在，消费方两处取用写法都不炸', () => {
  const provider = createAutomationNurtureProvider(mirrorsWith({ anchors: [BOUND] }));
  // 下面两行**逐字**就是消费方的两处取用写法，且必须求值在断言之前 ——
  // 先断言「这个属性是 undefined」会让类型收窄成 `never`，那两个表达式就再也写不出来了，
  // 而第二处（`?.().totalDays`）正是「存在但返回 undefined」会当场炸的那一处，必须真跑到。
  const absentCall = provider.facebookSlowStartPolicy?.();
  const absentTotalDays = provider.facebookSlowStartPolicy?.().totalDays ?? 7;
  assert.equal(
    provider.facebookSlowStartPolicy,
    undefined,
    '契约只承认「方法不在」这一种缺席 —— 交出一份空曲线等于宣称这个号没有任何逐日上限',
  );
  assert.equal(absentCall, undefined);
  assert.equal(absentTotalDays, 7);
});

test('曲线新鲜：逐日上限逐位来自运营配的那份，且交出去的是副本', () => {
  const provider = createAutomationNurtureProvider(
    mirrorsWith({ anchors: [BOUND], curve: { totalDays: 3, dailyCaps: [quota(11), quota(22), quota(33)] } }),
  );
  const policy = provider.facebookSlowStartPolicy?.();
  assert.equal(policy?.totalDays, 3);
  assert.deepEqual(policy?.dailyCaps.map((row) => row.view), [11, 22, 33]);
  policy!.dailyCaps.length = 0;
  assert.equal(
    provider.facebookSlowStartPolicy?.().dailyCaps.length,
    3,
    '消费方拿到的 MUST 是副本：它若能改到镜像那一份，下一个账号读到的就是被改过的曲线',
  );
});

test('曲线陈旧：沿用上一份，MUST NOT 因为陈旧就退回写死默认（那会悄悄放宽）', () => {
  const asOf = 1_000;
  const provider = createAutomationNurtureProvider(
    mirrorsWith({
      anchors: [BOUND],
      curve: { totalDays: 5, dailyCaps: [quota(7)] },
      asOf,
      readAt: asOf + FRESH_MS + 1,
    }),
  );
  assert.equal(provider.facebookSlowStartPolicy?.().totalDays, 5);
  assert.equal(provider.facebookSlowStartPolicy?.().dailyCaps[0]?.view, 7);
});
