// aidcp:test-owner=derived
/**
 * 每连接角色调度器工厂（批 E-2 步骤 3）。
 *
 * 这一批的保护线**不在调度器的选项面上** —— 那 200 余个字段几乎全可选，漏传不报错。
 * 保护线在本工厂的依赖面：批 G 才有的供给方一律必填 / 能力二态。
 * 故本文件测的是三件事：**二态被如实翻译**、**决策闭包只有一份**、**终态口径逐字保留**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mapRuleBatchTerminalStates,
  ruleBatchContactCommentOptions,
} from '../../src/automation-connection-dispatcher.js';

/* ─────────────────── 规则批次终态口径 ─────────────────── */

test('降级发出的普通评论 MUST 投影成 confirmed_without_contact，绝不投成 confirmed', () => {
  // 投成 confirmed 会让后台与客户端认为联系方式已经发出去了 —— 那是对人的谎报。
  const fallback = mapRuleBatchTerminalStates({
    joinOutcome: 'joined',
    outcome: 'commented',
    contactFallbackApplied: true,
  });
  assert.equal(fallback.commentState, 'confirmed_without_contact');
  const real = mapRuleBatchTerminalStates({
    joinOutcome: 'joined',
    outcome: 'commented',
  });
  assert.equal(real.commentState, 'confirmed');
  assert.equal(real.joinState, 'confirmed');
});

test('「没有目标」是没开始、不是失败——记成失败会让重试与告警都走错分支', () => {
  for (const outcome of ['no_targets', 'no_strong_candidate']) {
    assert.equal(
      mapRuleBatchTerminalStates({ outcome }).commentState,
      'not_started',
    );
  }
  // 对照：真失败仍是 failed，别把两者合并。
  assert.equal(
    mapRuleBatchTerminalStates({ outcome: 'exploded' }).commentState,
    'failed',
  );
});

test('提交但未确认 / 被风控压住 / 被拒 三类分得开，且 blocker 原样带出', () => {
  assert.equal(
    mapRuleBatchTerminalStates({ outcome: 'verification_ambiguous' }).commentState,
    'submitted_unknown',
  );
  assert.equal(
    mapRuleBatchTerminalStates({ outcome: 'pending_group_approval' }).commentState,
    'submitted_unknown',
  );
  assert.equal(
    mapRuleBatchTerminalStates({ outcome: 'quota_denied' }).commentState,
    'risk_suppressed',
  );
  assert.equal(
    mapRuleBatchTerminalStates({ outcome: 'comment_rejected' }).commentState,
    'rejected',
  );
  assert.equal(
    mapRuleBatchTerminalStates({ outcome: 'failed', reason: 'boom' }).blocker,
    'boom',
  );
  // 没有 reason 时 MUST NOT 造一个出来。
  assert.equal('blocker' in mapRuleBatchTerminalStates({ outcome: 'failed' }), false);
});

test('加群终态：已是成员 / 待审 / 被闸挡 三类各有各的口径', () => {
  assert.equal(
    mapRuleBatchTerminalStates({ joinOutcome: 'already_member' }).joinState,
    'already_satisfied',
  );
  assert.equal(
    mapRuleBatchTerminalStates({ joinOutcome: 'pending' }).joinState,
    'ambiguous',
  );
  assert.equal(
    mapRuleBatchTerminalStates({ joinOutcome: 'gated_skip' }).joinState,
    'rejected',
  );
  assert.equal(
    mapRuleBatchTerminalStates({ joinOutcome: 'risk_suppressed' }).joinState,
    'risk_suppressed',
  );
});

/* ─────────────────── 规则批次触发参数 ─────────────────── */

const schedule = (over: Record<string, unknown> = {}) =>
  ({
    autoEnabled: true,
    postEnabled: false,
    postMode: 'off',
    postDailyCap: 0,
    commentEnabled: true,
    commentMode: 'review',
    commentDailyCap: 5,
    contactCommentEnabled: true,
    contactCommentMode: 'review',
    contactCommentDailyCap: 3,
    effectiveActiveWeekMask: null,
    effectiveMask: null,
    ...over,
  }) as never;

test('联系评论免审 MUST NOT 外溢到降级发出的普通评论——两者是两个独立字段', () => {
  // 运营只给联系评论开了免审；降级正文走的是**普通评论车道**，从未为它授权过免审。
  const options = ruleBatchContactCommentOptions({
    schedule: schedule({ contactCommentMode: 'auto_approve', commentMode: 'review' }),
    actionGate: () => ({ allowed: true }),
  });
  assert.equal(options.approvalMode, 'auto_approve');
  assert.deepEqual(options.contactFallback, {
    kind: 'plain',
    approvalMode: 'review',
  });
});

test('两条车道各自独立：普通评论免审也不会把联系评论带成免审', () => {
  const options = ruleBatchContactCommentOptions({
    schedule: schedule({ contactCommentMode: 'review', commentMode: 'auto_approve' }),
    actionGate: () => ({ allowed: true }),
  });
  assert.equal(options.approvalMode, 'review');
  assert.deepEqual(options.contactFallback, {
    kind: 'plain',
    approvalMode: 'auto_approve',
  });
});

test('自动路径 MUST NOT 开评论快返，且来源标记固定为规则批次', () => {
  // 快返固定回 verification_ambiguous ⇒ 结构上永远报不出「已评论」⇒
  // 去重烧掉目标帖、冷却不落、当日配额不计（真机验过评论其实已上墙）。
  const options = ruleBatchContactCommentOptions({
    schedule: schedule(),
    actionGate: () => ({ allowed: true }),
  });
  assert.equal('fastReturn' in options, false);
  assert.equal(options.force, false);
  assert.equal(options.manualOverride, false);
  assert.equal(options.source, 'facebook_rule_batch');
  assert.equal(options.joinFirst, true);
  assert.equal(options.injectContact, true);
});

/* ─────────────────── 结构：决策闭包只有一份 ─────────────────── */

/**
 * 规则批次的动作闸 MUST 与浏览模式决策**共用同一个闭包**。
 *
 * **行为用例守不住这条**：第二份实现在写出来那天与第一份完全等价，
 * 要等两份漂开、且恰好在该拦住的那一刻才现形 —— 而那正是最少被真跑到的路径。
 * 本 change 已在出口闸豁免名单 / 失败映射表 / 注册表准入闸上各栽过一次。**别当冗余删掉。**
 */
test('规则批次的动作闸只调那一个决策闭包，不另算一遍', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../../src/automation-connection-dispatcher.js'.replace('.js', '.ts'), import.meta.url),
    'utf8',
  );
  const start = source.indexOf('actionGate: (action: string) => {');
  assert.notEqual(start, -1, '找不到规则批次的动作闸');
  const body = source.slice(start, source.indexOf('},', source.indexOf('return risk.allowed', start)));
  assert.match(
    body,
    /\bresolveFacebookOperationDecision\s*\(/,
    '动作闸 MUST 调那个共用的决策闭包',
  );
  assert.doesNotMatch(
    body,
    /\bdecideFacebookBrowseMode\s*\(/,
    '动作闸里出现了第二次浏览模式计算 —— 两份漂开时不报错，只是某一刻放行了本该拦住的动作',
  );
  // 决策闭包在本文件只许构造一次。
  assert.equal(
    source.split('const resolveFacebookOperationDecision =').length - 1,
    1,
    '决策闭包 MUST 只有一处定义',
  );
});
