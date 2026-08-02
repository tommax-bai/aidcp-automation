// aidcp:test-owner=derived
/**
 * 评论调度器 + 加群调度器 + 联系评论安全闸（批 G 第三片）。
 *
 * 这一片管的是**真发评论**，所以红线全在「缺一样东西时会不会安静地照跑」：
 * 缺精选召回不许回空数组、缺时序策略不许拿默认时长顶上、缺暂停通道不许塞 undefined、
 * 语言不对不许发、闸不过不许记账。每条都配一个会真触发它的用例。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createAutomationCommentSchedulerPorts } from '../../src/automation-comment-scheduler.js';

type Captured = {
  comment: Record<string, any>;
  join: Record<string, any>;
};

const schedule = (over: Record<string, unknown> = {}) => ({
  contactCommentMode: 'review',
  commentMode: 'review',
  contactCommentDailyCap: 3,
  ...over,
});

function build(over: Record<string, unknown> = {}): {
  ports: ReturnType<typeof createAutomationCommentSchedulerPorts>['ports'];
  captured: Captured;
  warned: string[];
  risk: { records: string[]; canComment: boolean };
  attempts: { count: number; recorded: unknown[] };
} {
  const captured: Captured = { comment: {}, join: {} };
  const warned: string[] = [];
  const risk = { records: [] as string[], canComment: true };
  const attempts = { count: 0, recorded: [] as unknown[] };

  const assembly = createAutomationCommentSchedulerPorts({
    runtimes: {
      runtimeForAccount: () => ({ bus: {} as never, edgeId: 'edge-1' }),
      remainingSessionBudgetForAccount: () => 1,
      consumeSessionBudgetForAccount: () => true,
    },
    pusher: { pushToEdges: () => 1 },
    edgeTaskLeases: {} as never,
    getSoul: () => ({
      writing_language: 'zh-CN',
      identity: { name: '小明', role: '园艺爱好者' },
    }) as never,
    personaBinding: () => 'bound' as never,
    llm: { complete: async () => '一条中文评论' },
    curatedSelection: { state: 'unavailable', reason: 'content_client_missing' },
    risk: {
      resolveController: async () => ({ canDo: () => risk.canComment }),
      recordRiskFact: async (_a: string, _act: string, key: string) => {
        risk.records.push(key);
        return true;
      },
      hasInteraction: async () => false,
      recordInteraction: async () => undefined,
    },
    approvalPorts: {
      approval: { state: 'unavailable', reason: 'comment_approval_disabled_by_env' },
      notifyAutoApproved: async () => undefined,
      resolveApprovalMode: (async () => 'review') as never,
      notifyMandatoryOutcome: (async () => undefined) as never,
      valuableCorpus: { state: 'unavailable', reason: 'x' },
    } as never,
    accountRuntime: {
      getPlatformOrNull: async () => 'facebook',
      getContactInfo: async () => null,
    },
    automationConfigCommands: {
      resolveFacebookContainerName: async () => undefined,
      countContactAttemptsToday: async () => attempts.count,
      recordContactCommentAttempt: async (_a: string, snap: unknown) => {
        attempts.recorded.push(snap);
        return undefined;
      },
    },
    deliverStructuredNotification: async () => undefined,
    businessConfig: {
      effectiveScheduleFor: () => schedule() as never,
      facebookCommentConfigFor: () => ({
        enabled: true,
        keywords: ['k'],
        containers: [],
        commentMode: 'template',
        commentTemplates: ['t'],
      }),
    } as never,
    facebookStores: {
      targets: { resolveRegionCommentTemplatesForGroup: async () => ({}) } as never,
      memberships: {
        coverageCandidates: async () => [],
        markCoverageCommented: async () => undefined,
        recordCoverageLeftSignal: async () => undefined,
      } as never,
      joinAudit: {} as never,
      commentAudit: { append: async () => undefined },
    },
    groupCommentPolicy: { state: 'unavailable', reason: 'no_transport' },
    accountPause: { state: 'unavailable', reason: 'no_transport' },
    scheduledTaskFeedback: { state: 'unavailable', reason: 'no_transport' },
    env: {},
    logger: { log: () => undefined, warn: (m: string) => warned.push(String(m)) },
    createCommentScheduler: (deps: Record<string, any>) => {
      captured.comment = deps as never;
      return {
        triggerTargeted: async () => ({
          ok: true,
          level: 'success',
          title: 't',
          message: 'm',
        }),
        triggerManual: async () => ({ ok: true, level: 'success', title: 't', message: 'm' }),
      } as never;
    },
    createJoinScheduler: (deps: Record<string, any>) => {
      captured.join = deps as never;
      return {} as never;
    },
    ...over,
  } as never);

  return { ports: assembly.ports, captured, warned, risk, attempts };
}

/* ─────── 红线 1：共享属主池 —— 关停路径不许碰这三个存储的 close() ─────── */

test('装配不暴露 close()，且源码里不对注入的群存储调 close —— 它内部是 pool.end()', () => {
  const source = readFileSync(
    new URL('../../src/automation-comment-scheduler.ts', import.meta.url),
    'utf8',
  )
    // 只看代码：本文件的注释里就解释着这条红线，整文件匹配会被自己的注释命中。
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.equal(
    /stores\.(targets|memberships|joinAudit|commentAudit)\s*\.\s*close\s*\(/.test(source),
    false,
    '注入的是共享属主池，调它们的 close() 会连带打死本进程其余存储',
  );
  const assembly = build();
  assert.equal('close' in (assembly.ports as Record<string, unknown>), false);
});

/* ─────── 红线 2：精选召回缺席 → 具名抛错，绝不空数组 ─────── */

test('精选召回没接线 → 抛具名 not_configured，MUST NOT 回空数组', async () => {
  const { captured } = build();
  await assert.rejects(
    () => captured.comment.curatedSelection.selectSamplesForSearchTerms('acc-1', 'note', 3),
    (error: Error & { code?: string }) => {
      assert.match(String(error.message), /content_client_missing/);
      return true;
    },
  );
});

test('精选召回接上后原样转过去，不在这里就地投影', async () => {
  const seen: unknown[] = [];
  const { captured } = build({
    curatedSelection: {
      state: 'wired',
      port: {
        selectSamplesForSearchTerms: async (...args: unknown[]) => {
          seen.push(args);
          return ['sample'];
        },
      },
    },
  });
  const out = await captured.comment.curatedSelection.selectSamplesForSearchTerms(
    'acc-1',
    'note',
    3,
  );
  assert.deepEqual(out, ['sample']);
  assert.deepEqual(seen, [['acc-1', 'note', 3]]);
});

/* ─────── 红线 3：时序策略缺席 → 本轮无可评群，绝不拿默认时长顶上 ─────── */

test('群评论时序策略未接线 → 覆盖候选 enabled=false，且一次库都不查', async () => {
  let queried = 0;
  const { captured, warned } = build({
    facebookStores: {
      targets: { resolveRegionCommentTemplatesForGroup: async () => ({}) },
      memberships: {
        coverageCandidates: async () => {
          queried += 1;
          return [{ groupUrl: 'https://g/1' }];
        },
        markCoverageCommented: async () => undefined,
        recordCoverageLeftSignal: async () => undefined,
      },
      joinAudit: {},
      commentAudit: { append: async () => undefined },
    },
  });
  const config = await captured.comment.facebookCoverageConfigFor('acc-1');
  assert.equal(config.enabled, false, '拿不到预热/冷却时长就不该选群');
  assert.deepEqual(config.containers, []);
  assert.equal(config.relaxed, false);
  assert.equal(queried, 0, '策略缺席时连候选都不该去查——查了就说明在拿默认值兜');
  assert.ok(
    warned.some((line) => line.includes('覆盖评论本进程一条都不会发')),
    '这条降级必须说出来',
  );
});

test('时序策略接上后，冷却时长取策略值；两处消费共用同一个取用点', async () => {
  const marked: Array<{ cooldownMs: number }> = [];
  const seenWarmup: Array<{ warmupMs: number; cooldownMs: number }> = [];
  let reads = 0;
  const { captured } = build({
    groupCommentPolicy: {
      state: 'wired',
      port: {
        get: () => {
          reads += 1;
          return {
            joinToFirstCommentHours: 5,
            revision: 7,
            source: 'db',
            sameGroupRecommentCooldownHours: 11,
          };
        },
      },
    },
    facebookStores: {
      targets: { resolveRegionCommentTemplatesForGroup: async () => ({}) },
      memberships: {
        coverageCandidates: async (_a: string, opts: { warmupMs: number; cooldownMs: number }) => {
          seenWarmup.push(opts);
          return [{ groupUrl: 'https://g/1' }];
        },
        markCoverageCommented: async (_a: string, _g: string, opts: { cooldownMs: number }) => {
          marked.push(opts);
        },
        recordCoverageLeftSignal: async () => undefined,
      },
      joinAudit: {},
      commentAudit: { append: async () => undefined },
    },
  });

  const config = await captured.comment.facebookCoverageConfigFor('acc-1');
  assert.equal(config.enabled, true);
  assert.deepEqual(config.containers, [{ url: 'https://g/1' }]);
  assert.equal(seenWarmup[0]!.warmupMs, 5 * 60 * 60 * 1000);
  assert.equal(seenWarmup[0]!.cooldownMs, 11 * 60 * 60 * 1000);

  await captured.comment.facebookCoverageOnCommented('acc-1', 'https://g/1');
  assert.equal(
    marked[0]!.cooldownMs,
    11 * 60 * 60 * 1000,
    '同群再评冷却必须来自策略，不是环境默认的 72 小时',
  );
  // 两处消费各现读一次同一个取用点：谁在别处另存一份快照，这个计数就对不上。
  assert.equal(reads, 2);
});

/* ─────── 红线 4：免审通知来源恒为「评论调度器」 ─────── */

test('免审通知的来源由本片现推，恒为 comment_scheduler', async () => {
  const sources: string[] = [];
  const { captured } = build({
    approvalPorts: {
      approval: { state: 'unavailable', reason: 'off' },
      notifyAutoApproved: async (_input: unknown, source: string) => {
        sources.push(source);
      },
      resolveApprovalMode: async () => 'review',
      notifyMandatoryOutcome: async () => undefined,
      valuableCorpus: { state: 'unavailable', reason: 'x' },
    },
  });
  await captured.comment.autoApproveNotify({ requestId: 'r-1', text: 'x' });
  assert.deepEqual(sources, ['comment_scheduler']);
});

test('人审端口未开启时整组缺席，不塞 undefined', () => {
  const { captured } = build();
  assert.equal('approval' in captured.comment, false);
  const wired = build({
    approvalPorts: {
      approval: { state: 'wired', port: { marker: true } },
      notifyAutoApproved: async () => undefined,
      resolveApprovalMode: async () => 'review',
      notifyMandatoryOutcome: async () => undefined,
      valuableCorpus: { state: 'unavailable', reason: 'x' },
    },
  });
  assert.deepEqual(wired.captured.comment.approval, { marker: true });
});

/* ─────── 红线 5：写作语言不满足即拒发 ─────── */

test('连续两次写不出目标语言 → 返回 null，绝不把语言不对的评论发出去', async () => {
  let calls = 0;
  const { captured } = build({
    llm: {
      complete: async () => {
        calls += 1;
        return 'This is English only';
      },
    },
  });
  const out = await captured.comment.facebookCompose('acc-1', { keyword: 'k', container: 'c' });
  assert.equal(out, null);
  assert.equal(calls, 2, '重试上限就是 2 次，不许无限试到蒙对');
});

test('账号没配写作语言 → 直接拒绝生成，一次模型都不调', async () => {
  let calls = 0;
  const { captured } = build({
    getSoul: () => ({}),
    llm: {
      complete: async () => {
        calls += 1;
        return 'x';
      },
    },
  });
  assert.equal(
    await captured.comment.facebookCompose('acc-1', { keyword: 'k', container: 'c' }),
    null,
  );
  assert.equal(calls, 0);
});

/* ─────── 联系评论安全闸：闸不过不触发；触发即记的是尝试、不是配额 ─────── */

test('风控不放行 → 不触发、不记尝试、不消费评论配额', async () => {
  const { ports, risk, attempts } = build();
  risk.canComment = false;
  const result = await ports.fireAutoContactComment({
    accountId: 'acc-1',
    noteId: 'n-1',
    title: 't',
    currentDetail: { noteId: 'n-1' },
    velocity: 900,
    ageHours: 2,
  } as never);
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'risk_blocked');
  assert.deepEqual(attempts.recorded, []);
  assert.deepEqual(risk.records, []);
});

test('子上限已满 → 不触发，原因是 daily_cap 而不是被塞成风控拒绝', async () => {
  const { ports, attempts } = build();
  attempts.count = 3;
  const result = await ports.fireAutoContactComment({
    accountId: 'acc-1',
    noteId: 'n-1',
    title: 't',
    currentDetail: { noteId: 'n-1' },
    velocity: 900,
    ageHours: 2,
  } as never);
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'daily_cap');
});

test('触发成功只记尝试；评论配额留到最终 commented 才消费', async () => {
  const { ports, risk, attempts } = build();
  const result = await ports.fireAutoContactComment({
    accountId: 'acc-1',
    noteId: 'n-1',
    title: 't',
    currentDetail: { noteId: 'n-1' },
    velocity: 900,
    ageHours: 2,
  } as never);
  assert.equal(result.fired, true);
  assert.equal(attempts.recorded.length, 1);
  assert.deepEqual(
    risk.records,
    [],
    '触发即记会让「未产出却占掉一次 comment」成为常态',
  );
});

/* ─────── 加群：暂停通道缺席时整组缺席，且会话额度按引用取注册表 ─────── */

test('账号暂停通道未接线 → 加群依赖里整组缺席，不塞 undefined，且说得出为什么', () => {
  const { captured, warned } = build();
  assert.equal('pauseAccount' in captured.join, false);
  assert.ok(warned.some((line) => line.includes('不会暂停账号')));
});

test('接上暂停通道后，加群失败到顶会真的暂停账号', async () => {
  const paused: string[] = [];
  const { captured } = build({
    accountPause: {
      state: 'wired',
      port: {
        pause: async (accountId: string) => {
          paused.push(accountId);
        },
      },
    },
  });
  await captured.join.pauseAccount('acc-1', 'join_failed');
  assert.deepEqual(paused, ['acc-1']);
});

test('排期名额回程未接线 → 如实回 false（逐次结果卡照发），并说出原因', () => {
  const { captured, warned } = build();
  assert.equal(captured.comment.onScheduledTaskNotStarted('acc-1', 'comment', 'edge_offline'), false);
  assert.ok(warned.some((line) => line.includes('排期名额未归还')));
});
