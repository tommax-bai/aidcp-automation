import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveFacebookCadenceMode,
  facebookCadenceProbabilisticHit,
} from '../../src/orchestrator/facebook-cadence-mode.js';
import { advanceFacebookConsumptionCounters } from '../../src/orchestrator/facebook-consumption-mode.js';

test('resolveFacebookCadenceMode：合法值透传,缺省/非法回落 fixed', () => {
  assert.equal(resolveFacebookCadenceMode('probabilistic'), 'probabilistic');
  assert.equal(resolveFacebookCadenceMode('fixed'), 'fixed');
  assert.equal(resolveFacebookCadenceMode(undefined), 'fixed');
  assert.equal(resolveFacebookCadenceMode('sometimes'), 'fixed');
  assert.equal(resolveFacebookCadenceMode(null), 'fixed');
});

test('facebookCadenceProbabilisticHit：random<1/N 命中,边界与非法 N', () => {
  // N=10 → 阈值 0.1
  assert.equal(facebookCadenceProbabilisticHit(10, () => 0.05), true);
  assert.equal(facebookCadenceProbabilisticHit(10, () => 0.1), false, '恰等阈值不命中（严格小于）');
  assert.equal(facebookCadenceProbabilisticHit(10, () => 0.5), false);
  // N=1 → 每次必中（1/1=1,random<1 恒真）
  assert.equal(facebookCadenceProbabilisticHit(1, () => 0.999999), true);
  // 非法 N fail-closed 不放大动作
  assert.equal(facebookCadenceProbabilisticHit(0, () => 0), false);
  assert.equal(facebookCadenceProbabilisticHit(Number.NaN, () => 0), false);
});

const SNAPSHOT = { viewsPerLike: 5, confirmedLikesPerJoin: 3, confirmedJoinsPerComment: 2 };

test('消费 reducer：fixed 模式行为与既有逐字一致（未传 cadenceMode）', () => {
  // 攒到 confirmedLikesPerJoin=3 才触发 join；未到不触发
  const below = advanceFacebookConsumptionCounters({
    actionType: 'like',
    outcome: 'confirmed_new_like',
    snapshot: SNAPSHOT,
    counters: { confirmedNewLikesSinceJoin: 1, confirmedNewJoinsSinceComment: 0 },
    downstreamEnabled: true,
  });
  assert.equal(below.nextActionType, null);
  assert.equal(below.counters.confirmedNewLikesSinceJoin, 2);

  const reached = advanceFacebookConsumptionCounters({
    actionType: 'like',
    outcome: 'confirmed_new_like',
    snapshot: SNAPSHOT,
    counters: { confirmedNewLikesSinceJoin: 2, confirmedNewJoinsSinceComment: 0 },
    downstreamEnabled: true,
  });
  assert.equal(reached.nextActionType, 'join');
  assert.equal(reached.counters.confirmedNewLikesSinceJoin, 0, '溢出结转 3-3=0');
});

test('消费 reducer：probabilistic 模式每次确认独立掷 1/N,计数仍累加但不驱动', () => {
  // random=0.5,confirmedLikesPerJoin=3 → 阈值 0.333 → 不中：不触发,计数 +1
  const miss = advanceFacebookConsumptionCounters({
    actionType: 'like',
    outcome: 'confirmed_new_like',
    snapshot: SNAPSHOT,
    counters: { confirmedNewLikesSinceJoin: 1, confirmedNewJoinsSinceComment: 0 },
    downstreamEnabled: true,
    cadenceMode: 'probabilistic',
    random: () => 0.5,
  });
  assert.equal(miss.nextActionType, null, '未掷中不触发');
  assert.equal(miss.counters.confirmedNewLikesSinceJoin, 2, '计数仍累加供观测');

  // random=0.1 → 命中：触发 join,计数清零（无攒够语义）
  const hit = advanceFacebookConsumptionCounters({
    actionType: 'like',
    outcome: 'confirmed_new_like',
    snapshot: SNAPSHOT,
    counters: { confirmedNewLikesSinceJoin: 1, confirmedNewJoinsSinceComment: 0 },
    downstreamEnabled: true,
    cadenceMode: 'probabilistic',
    random: () => 0.1,
  });
  assert.equal(hit.nextActionType, 'join', '掷中即触发,与累计计数无关');
  assert.equal(hit.counters.confirmedNewLikesSinceJoin, 0, '命中清零');
});

test('消费 reducer：joins→comment 同样按模式判定', () => {
  const fixedHit = advanceFacebookConsumptionCounters({
    actionType: 'join',
    outcome: 'confirmed_new_join',
    snapshot: SNAPSHOT,
    counters: { confirmedNewLikesSinceJoin: 0, confirmedNewJoinsSinceComment: 1 },
    downstreamEnabled: true,
  });
  assert.equal(fixedHit.nextActionType, 'comment', 'fixed：数到 confirmedJoinsPerComment=2');

  const probMiss = advanceFacebookConsumptionCounters({
    actionType: 'join',
    outcome: 'confirmed_new_join',
    snapshot: SNAPSHOT,
    counters: { confirmedNewLikesSinceJoin: 0, confirmedNewJoinsSinceComment: 1 },
    downstreamEnabled: true,
    cadenceMode: 'probabilistic',
    random: () => 0.9, // 阈值 0.5,不中
  });
  assert.equal(probMiss.nextActionType, null);
});

test('消费 reducer：downstream 关闭时任何模式都不触发', () => {
  const off = advanceFacebookConsumptionCounters({
    actionType: 'like',
    outcome: 'confirmed_new_like',
    snapshot: SNAPSHOT,
    counters: { confirmedNewLikesSinceJoin: 2, confirmedNewJoinsSinceComment: 0 },
    downstreamEnabled: false,
    cadenceMode: 'probabilistic',
    random: () => 0,
  });
  assert.equal(off.nextActionType, null);
});
