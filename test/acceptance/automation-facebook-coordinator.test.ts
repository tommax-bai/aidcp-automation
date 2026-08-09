// aidcp:test-owner=derived
/**
 * Facebook 消费模式协调器的装配（批 G 第四片，填满 10 个口的最后一个）。
 *
 * 这一片管的是**真下发平台动作**，红线全在「决策链缺一环时会不会照发」：
 * 副本陈旧要具名拒绝、决策前必须先物化风控控制器、时序策略拿不到要让协调器自己报、
 * 恢复扫描的定时器不许在构造期起。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createAutomationFacebookCoordinator } from '../../src/automation-facebook-coordinator.js';

const BASE_OK = {
  ok: true as const,
  envKey: 'env-1',
  primarySurface: 'feed' as const,
  surfaceRevision: 1,
  baseMode: 'consumption' as const,
  policyRevision: 42,
  cadenceSource: 'global' as const,
  rule: { viewsPerLike: 5, joinEveryNRounds: 2 },
  consumption: { viewsPerLike: 4, confirmedLikesPerJoin: 3, confirmedJoinsPerComment: 2 },
  reels: {
    persona: { viewsPerLike: 6, viewsPerFollow: 12 },
    slowStart: { viewsPerFollow: 20 },
    rule: { viewsPerFollow: 15 },
    consumption: { viewsPerFollow: 14 },
  },
  updatedAt: null,
  updatedBy: null,
};

function build(over: Record<string, unknown> = {}) {
  const captured: { deps: Record<string, any> } = { deps: {} };
  const warned: string[] = [];
  const staleRefusals: Array<[string, string | undefined]> = [];
  const materialized: string[] = [];
  const timers: string[] = [];
  const resolved = new Map<string, { explain(): { allowed: boolean; reason?: string } }>();

  const assembly = createAutomationFacebookCoordinator({
    consumptionStore: { state: 'wired', store: {} as never },
    executors: { join: {} as never, comment: {} as never },
    memberships: {
      coverageCandidates: async () => [],
      findMembership: async () => null,
      recordCoverageCommented: async () => null,
    } as never,
    groupCommentPolicy: {
      state: 'wired',
      port: {
        get: () => ({
          joinToFirstCommentHours: 5,
          revision: 3,
          source: 'db' as const,
          sameGroupRecommentCooldownHours: 11,
        }),
      },
    },
    configMirrorGate: {
      isStale: () => false,
      noteStaleRefusal: (key: string, context?: string) => staleRefusals.push([key, context]),
    },
    facebookOperationBaseFor: () => BASE_OK,
    risk: {
      resolveController: async (accountId: string) => {
        materialized.push(accountId);
        resolved.set(accountId, { explain: () => ({ allowed: true }) });
        return { slowStartView: () => ({ state: 'off' as const }) };
      },
      resolvedController: (accountId: string) => resolved.get(accountId) ?? null,
    },
    logger: { log: () => undefined, warn: (m: string) => warned.push(String(m)) },
    createCoordinator: (deps: Record<string, any>) => {
      captured.deps = deps;
      return {
        trigger: async () => undefined,
        recoverActiveActions: async () => {
          timers.push('recover');
          return { scanned: 0, driven: 0, results: [] };
        },
      } as never;
    },
    ...over,
  } as never);

  return { assembly, captured, warned, staleRefusals, materialized, timers };
}

/* ─────── 红线 1：副本陈旧 → 具名拒绝，且拒绝要记账 ─────── */

test('配置副本陈旧 → blocked + 具名 blocker，且记进停手闸的账', async () => {
  const { captured, materialized } = build({
    configMirrorGate: {
      isStale: () => true,
      noteStaleRefusal: () => undefined,
    },
  });
  const decision = await captured.deps.resolveOperationPolicy('acc-1');
  assert.equal(decision.effectiveMode, 'blocked');
  assert.equal(decision.blocker, 'facebook_operation_policy_stale');
  assert.equal(decision.policyRevision, null, '陈旧时不许带出一个可能过期的版本号');
  assert.deepEqual(materialized, [], '已经确定 blocked 就不该再去物化控制器');
});

test('陈旧拒绝会被记账，且带得出是哪个账号', async () => {
  const seen: Array<[string, string | undefined]> = [];
  const { captured } = build({
    configMirrorGate: {
      isStale: () => true,
      noteStaleRefusal: (key: string, context?: string) => seen.push([key, context]),
    },
  });
  await captured.deps.resolveOperationPolicy('acc-9');
  assert.deepEqual(seen, [['content_schedule', 'facebook_consumption_policy:acc-9']]);
});

/* ─────── 红线 2：决策前必须先物化控制器；终闸绝不自己补建 ─────── */

test('决策会先物化风控控制器 —— 随后那道同步终闸就是按它判的', async () => {
  const { captured, materialized } = build();
  const decision = await captured.deps.resolveOperationPolicy('acc-1');
  assert.equal(decision.effectiveMode, 'consumption');
  assert.equal(decision.policyRevision, 42);
  assert.deepEqual(materialized, ['acc-1']);
  assert.deepEqual(captured.deps.commentActionGate('acc-1'), { allowed: true });
});

test('没物化过 → 终闸 fail-closed，MUST NOT 就地补建一个把决策链绕过去', () => {
  const { captured } = build();
  assert.deepEqual(captured.deps.commentActionGate('never-seen'), {
    allowed: false,
    reason: 'risk_controller_unavailable',
  });
});

test('慢启动在跑 → 决策落在爬坡档，绝不按满档跑', async () => {
  const { captured } = build({
    risk: {
      resolveController: async () => ({
        slowStartView: () => ({ state: 'active' as const, since: 1 }),
      }),
      resolvedController: () => null,
    },
  });
  assert.equal((await captured.deps.resolveOperationPolicy('acc-1')).effectiveMode, 'slow_start');
});

test('慢启动问不到 → blocked 且具名，MUST NOT 压成「不在爬坡」', async () => {
  const { captured } = build({
    risk: {
      resolveController: async () => ({
        slowStartView: () => ({ state: 'off' as const, ineligibleReason: 'binding_unknown' }),
      }),
      resolvedController: () => null,
    },
  });
  const decision = await captured.deps.resolveOperationPolicy('acc-1');
  assert.equal(decision.effectiveMode, 'blocked');
  assert.equal(decision.blocker, 'slow_start_binding_unknown');
});

/* ─────── 红线 3：时序策略拿不到 → 让协调器自己报，别塞默认时长 ─────── */

test('时序策略未接线 → 取用点回 null（协调器据此具名报 blocker），并说出原因', () => {
  const { captured, warned } = build({
    groupCommentPolicy: { state: 'unavailable', reason: 'no_transport' },
  });
  assert.equal(captured.deps.resolveGroupCommentPolicy(), null);
  assert.ok(warned.some((line) => line.includes('消费模式评论段不会推进')));
});

test('时序策略接上 → 历史群选择与协调器共用同一个取用点', () => {
  let reads = 0;
  const { captured } = build({
    groupCommentPolicy: {
      state: 'wired',
      port: {
        get: () => {
          reads += 1;
          return {
            joinToFirstCommentHours: 5,
            revision: 3,
            source: 'db',
            sameGroupRecommentCooldownHours: 11,
          };
        },
      },
    },
  });
  assert.equal(captured.deps.resolveGroupCommentPolicy()!.revision, 3);
  assert.equal(reads, 1);
});

/* ─────── 红线 4：恢复扫描不在构造期跑，也不起定时器 ─────── */

test('构造期一次恢复扫描都不跑，且源码里没有定时器', () => {
  const { timers } = build();
  assert.deepEqual(timers, [], '构造期跑恢复 = 组装期就下发真实平台动作');
  const source = readFileSync(
    new URL('../../src/automation-facebook-coordinator.ts', import.meta.url),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/setInterval\s*\(|setTimeout\s*\(/.test(source), false);
});

test('恢复入口交付出去，调用时才真跑', async () => {
  const { assembly, timers } = build();
  const result = await assembly.recoverActiveActions();
  assert.deepEqual(timers, ['recover']);
  assert.equal(result!.scanned, 0);
});

/* ─────── 任务收敛后的浏览恢复通道：必须透传，漏接=恢复能力静默消失 ─────── */

test('redriveBrowse 透传进协调器 deps，调用能到达在线会话恢复口', () => {
  const calls: Array<[string, string]> = [];
  const { captured } = build({
    redriveBrowse: (accountId: string, edgeId: string) => {
      calls.push([accountId, edgeId]);
      return 1;
    },
  });
  // 协调器侧该依赖是可选口（deps.redriveBrowse?.(…)）：装配层没接线不会报错，
  // 加群/评论任务收敛后就没人把浏览会话带回主浏览面（dev 2026-08-09 实测整场停在群页面）。
  assert.equal(typeof captured.deps.redriveBrowse, 'function', '装配缝必须把恢复通道接进 deps');
  captured.deps.redriveBrowse('acc-7', 'edge-7');
  assert.deepEqual(calls, [['acc-7', 'edge-7']]);
});

/* ─────── 运行时存储没建成 → 整片不构造，且恢复入口是具名 no-op ─────── */

test('消费运行时存储不可用 → 口具名 unavailable，恢复入口诚实回 null', async () => {
  const { assembly, warned } = build({
    consumptionStore: { state: 'unavailable', reason: 'execution_target_missing' },
  });
  assert.equal(assembly.port.state, 'unavailable');
  assert.equal(
    assembly.port.state === 'unavailable' ? assembly.port.reason : null,
    'execution_target_missing',
  );
  assert.equal(await assembly.recoverActiveActions(), null);
  assert.ok(warned.some((line) => line.includes('消费模式协调器未构造')));
});
