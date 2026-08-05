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
  createAutomationDispatcherFactory,
  mapRuleBatchTerminalStates,
  ruleBatchContactCommentOptions,
  type AutomationDispatcherDeps,
} from '../../src/automation-connection-dispatcher.js';
import {
  SEARCH_ACTIVITY_RECEIPT_CAPABILITY,
  IDENTITY_READ_CURRENT_CAPABILITY,
  IDENTITY_READ_SELF_PROFILE_CAPABILITY,
} from '../../src/comm/protocol.js';
import { FACEBOOK_REEL_FOLLOW_EDGE_CAPABILITY } from '../../src/platform/facebook-presented-video.js';

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

/* ═══════════════ 工厂本体：选项面到底铺成了什么 ═══════════════ */

/**
 * 上面那些用例测的都是**析出来的纯函数**；工厂本体那 46 项映射此前一条覆盖都没有。
 *
 * 今晚已经为此栽过三次（自举名单少一条 / 载荷多两个键 / 约束漏一项），
 * 三次的共同点都是「映射类代码没人真跑过」。故这里把组装好的选项对象抓出来逐项断言。
 */
function stubDeps(over: Partial<AutomationDispatcherDeps> = {}): {
  deps: AutomationDispatcherDeps;
  captured: Record<string, unknown>[];
} {
  const captured: Record<string, unknown>[] = [];
  const noop = (() => undefined) as never;
  const twoStateOff = { state: 'unavailable' as const, reason: 'batch_g_not_wired' };
  const deps = {
    configMirrorGate: {
      isStale: () => false,
      noteStaleRefusal: () => undefined,
    } as never,
    llm: {} as never,
    getSoul: (() => ({})) as never,
    pacingFloors: {} as never,
    edgeTaskLeases: {} as never,
    sessionLimitProvider: {} as never,
    resumeConfigProvider: {} as never,
    conceptStore: undefined as never,
    curatedStore: undefined as never,
    textCardTranscriber: undefined as never,
    roleFactories: {} as never,
    personaBinding: (() => 'bound') as never,
    getNickname: (() => null) as never,
    setNickname: noop,
    isDispatchActive: () => true,
    onSessionRejected: noop,
    notifyComments: (async () => undefined) as never,
    isHardPaused: () => false,
    sendCommand: noop,
    interactionGuardFor: () => ({}) as never,
    cooldownGate: {} as never,
    hasCommentedForLead: (async () => false) as never,
    businessConfig: {
      effectiveScheduleFor: () => schedule(),
      effectiveActiveWeekMaskFor: () => null,
      hotLeadGateConfig: () => ({
        maxAgeHours: 48,
        velocityMin: 300,
        minLikeFloor: 500,
        floorHours: 1,
      }),
      facebookCommentBodyScheme: () => 'template' as const,
      facebookCommentConfigFor: () => ({
        enabled: true,
        keywords: [],
        containers: [],
        commentMode: 'template' as const,
        commentTemplates: [],
      }),
      facebookOperationBaseFor: () => ({ ok: false as const, blocker: 'test' }),
    },
    comment: {
      scheduler: twoStateOff,
      approval: twoStateOff,
      notifyAutoApproved: noop,
      resolveApprovalMode: noop,
      notifyMandatoryOutcome: noop,
      fireAutoContactComment: noop,
      valuableCorpus: twoStateOff,
    },
    facebookRuntime: {
      rule: twoStateOff,
      consumption: twoStateOff,
      coordinator: twoStateOff,
    },
    createDispatcher: (options) => {
      captured.push(options as unknown as Record<string, unknown>);
      return {} as never;
    },
    ...over,
  } as AutomationDispatcherDeps;
  return { deps, captured };
}

const buildCtx = (over: Record<string, unknown> = {}) =>
  ({
    bus: { on: () => undefined },
    controller: {
      getState: () => ({ status: 'normal', quotaLevel: 'normal' }),
      canDo: () => true,
      explain: () => ({ allowed: true }),
      dailyRemaining: () => 5,
      slowStartView: () => ({ state: 'off' }),
    },
    accountId: 'acc-1',
    edgeId: 'edge-1',
    platform: 'facebook',
    capabilities: ['inline_targeting'],
    ...over,
  }) as never;

test('批 G 的口未接时 MUST NOT 把字段塞成 undefined —— 那与「接了但今天不可用」同形', () => {
  const { deps, captured } = stubDeps();
  createAutomationDispatcherFactory(deps)(buildCtx());
  const options = captured[0]!;
  // 二态为 unavailable 时，对应选项**整组缺席**（而不是 key 在、值是 undefined）。
  for (const key of [
    'commentApproval',
    'archiveValuableComment',
    'getCorpusReferences',
    'applyFacebookRuleView',
    'triggerFacebookRuleJoinContact',
    'applyFacebookConsumptionView',
    'triggerFacebookConsumptionAction',
  ]) {
    assert.equal(key in options, false, `${key} MUST 整组缺席，不能塞 undefined`);
  }
});

test('批 G 的口接上后逐项接线，且规则批次触发口真的用上了调度器', async () => {
  const calls: string[] = [];
  const { deps, captured } = stubDeps({
    comment: {
      ...stubDeps().deps.comment,
      scheduler: {
        state: 'wired',
        port: {
          triggerManual: async () => {
            calls.push('triggerManual');
            return { ok: true, level: 'success' as const, title: 't', message: 'm' };
          },
          triggerTargeted: async () => ({
            ok: true,
            level: 'success' as const,
            title: 't',
            message: 'm',
          }),
        },
      },
      valuableCorpus: {
        state: 'wired',
        port: { archive: async () => undefined, retrieveByTopics: async () => [] },
      },
    },
    facebookRuntime: {
      rule: {
        state: 'wired',
        port: { applyConfirmedView: () => undefined, updateBatch: () => undefined },
      },
      consumption: stubDeps().deps.facebookRuntime.consumption,
      coordinator: stubDeps().deps.facebookRuntime.coordinator,
    },
  });
  createAutomationDispatcherFactory(deps)(buildCtx());
  const options = captured[0]!;
  for (const key of [
    'applyFacebookRuleView',
    'triggerFacebookRuleJoinContact',
    'archiveValuableComment',
    'getCorpusReferences',
  ]) {
    assert.equal(typeof options[key], 'function', `${key} MUST 已接线`);
  }
  const trigger = options.triggerFacebookRuleJoinContact as (
    accountId: string,
  ) => Promise<{ started: boolean }>;
  const receipt = await trigger('acc-1');
  assert.equal(receipt.started, true);
  assert.deepEqual(calls, ['triggerManual']);
});

test('调度器没接时规则批次触发 MUST 具名不启动，绝不报「已触发」', async () => {
  const { deps, captured } = stubDeps({
    facebookRuntime: {
      rule: {
        state: 'wired',
        port: { applyConfirmedView: () => undefined, updateBatch: () => undefined },
      },
      consumption: stubDeps().deps.facebookRuntime.consumption,
      coordinator: stubDeps().deps.facebookRuntime.coordinator,
    },
  });
  createAutomationDispatcherFactory(deps)(buildCtx());
  const trigger = captured[0]!.triggerFacebookRuleJoinContact as (
    a: string,
  ) => Promise<{ started: boolean; reason?: string }>;
  const receipt = await trigger('acc-1');
  assert.equal(receipt.started, false);
  assert.equal(receipt.reason, 'batch_g_not_wired', '不启动的原因 MUST 具名');
});

test('下行指令按本连接 edgeId 定向，不广播', () => {
  const sent: Array<{ edgeId?: string; accountId: string }> = [];
  const { deps, captured } = stubDeps({
    sendCommand: ((_command: unknown, edgeId: string | undefined, accountId: string) => {
      sent.push({ edgeId, accountId });
    }) as never,
  });
  createAutomationDispatcherFactory(deps)(buildCtx({ edgeId: 'edge-9' }));
  (captured[0]!.sendCommand as (c: unknown) => void)({ action: 'x' });
  assert.deepEqual(sent, [{ edgeId: 'edge-9', accountId: 'acc-1' }]);
});

test('联系人名册每连接只订阅一次，且没有名册时不订阅', () => {
  const subscriptions: string[] = [];
  const ctx = buildCtx({
    bus: { on: (event: string) => subscriptions.push(event) },
  });
  const withRegistry = stubDeps({
    notificationContacts: { appendEvents: async () => undefined },
  });
  createAutomationDispatcherFactory(withRegistry.deps)(ctx);
  assert.deepEqual(subscriptions, ['notification.items.arrived']);

  subscriptions.length = 0;
  createAutomationDispatcherFactory(stubDeps().deps)(ctx);
  assert.deepEqual(subscriptions, [], '没有名册时 MUST 不订阅（单体同形）');
});

/* ─────────────────── 版本偏斜闸：能力名按引用比对 ─────────────────── */

/**
 * 这五道闸决定「新边端能不能拿到新能力」。它们比对的是**握手声明的能力名**，
 * 两端都是裸 `string` ⇒ 抄错一个字 typecheck 一个字都不说，闸只是对所有边缘恒判 false，
 * 新边端被静默降级成老边端。**已实测发生过**：派生 automation 手抄时漏了 `_v1` 后缀，
 * 四道闸恒关，OL/dev 上 Reel 自动关注与免导航身份读全线消失，日志只留一句
 * `facebook_reel_follow_edge_capability_missing` —— 看着像边缘旧，其实是云端读错名。
 *
 * 故本组按**引用**断言（名字取协议侧常量），并额外喂一遍「漏后缀」的错名钉死那次真实回归：
 * 只断言「正确名 ⇒ true」不够，实现若改成同时接受两种写法，那条也照样绿。
 */
const CAPABILITY_GATES = [
  ['hasInlineTargeting', 'inline_targeting'],
  ['hasReelFollow', FACEBOOK_REEL_FOLLOW_EDGE_CAPABILITY],
  ['hasSearchActivityReceipt', SEARCH_ACTIVITY_RECEIPT_CAPABILITY],
  ['hasIdentityReadCurrent', IDENTITY_READ_CURRENT_CAPABILITY],
  ['hasIdentityReadSelfProfile', IDENTITY_READ_SELF_PROFILE_CAPABILITY],
] as const;

const gateOf = (options: Record<string, unknown>, name: string): boolean =>
  (options[name] as () => boolean)();

const captureWithCapabilities = (capabilities: readonly string[]): Record<string, unknown> => {
  const { deps, captured } = stubDeps();
  createAutomationDispatcherFactory(deps)(buildCtx({ capabilities: [...capabilities] }));
  return captured[0]!;
};

test('五道版本偏斜闸 MUST 按协议常量识别能力名（抄错名 = 该能力对所有边缘恒关）', () => {
  const options = captureWithCapabilities(CAPABILITY_GATES.map(([, name]) => name));
  for (const [gate, name] of CAPABILITY_GATES) {
    assert.equal(gateOf(options, gate), true, `${gate} 认不出 ${name}`);
  }
});

test('握手没声明能力时五道闸 MUST 全关（闸恒真等于闸不在）', () => {
  const options = captureWithCapabilities([]);
  for (const [gate] of CAPABILITY_GATES) {
    assert.equal(gateOf(options, gate), false, `${gate} 在无能力声明时仍放行`);
  }
});

test('漏 `_v1` 后缀的错名 MUST NOT 被认成能力（钉死那次真实回归）', () => {
  const versioned = CAPABILITY_GATES.filter(([, name]) => name.endsWith('_v1'));
  // 前提自检：真有带 `_v1` 的名字，否则下面那圈断言是空转。
  assert.equal(versioned.length, 4, '带 `_v1` 的能力名数量变了，这条用例需要重写');
  const options = captureWithCapabilities(
    versioned.map(([, name]) => name.replace(/_v1$/, '')),
  );
  for (const [gate, name] of versioned) {
    assert.equal(gateOf(options, gate), false, `${gate} 把截短名认成了 ${name}`);
  }
});
