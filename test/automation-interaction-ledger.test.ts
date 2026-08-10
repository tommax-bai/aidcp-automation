/**
 * 互动观测台账订阅（automation-interaction-ledger）——单体 segC 漏搬回填的回归钉。
 *
 * 钉住的不变量（对应 2026-08-10 dev 实测的静默停摆）：
 *  - interaction.occurred 必须落四本账（liked_notes / 精选语料 / risk_interactions / interaction_feed）
 *    并立即 apply 风控内存计数——缺任何一段订阅都是「零报错、账本变陈旧」的静默腐化。
 *  - content_ref 会话内引用 MUST NOT 进任何按笔记键的持久行，但风控照常计数。
 *  - 缺 accountId 即 honest-fail 丢弃，绝不回落 default。
 *  - note.detail / profile.detail 喂展示账本元数据；本人主页绝不写入（隔离守卫③）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/event-bus/index.js';
import { createAutomationInteractionLedger } from '../src/automation-interaction-ledger.js';
import type { NoteDetailData } from 'aidcp-kernel/kernel/note-detail.js';

const silentLogger = { log: () => {}, warn: () => {} };

/** 让订阅 handler 里挂起的 promise 链（getControllerForAccounting().then 等）跑完。 */
async function drain(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
}

function harness(overrides?: {
  applyNowResult?: boolean;
  explainResult?: { allowed: boolean; reason?: string };
  withAlertStore?: boolean;
}) {
  const calls = {
    applyNow: 0,
    controllerRecord: [] as string[],
    explain: [] as string[],
    recordLike: [] as string[],
    markBotAction: [] as { accountId: string; sourceId: string; action: string; content?: unknown }[],
    recordInteraction: [] as { accountId: string; noteId: string; action: string }[],
    recordEvent: [] as { accountId: string; action: string; targetId: string }[],
    upsertMeta: [] as { accountId: string; targetId: string; meta: { title?: string | null; url?: string | null } }[],
    alerts: [] as string[],
  };
  const eventBus = new EventBus();
  const controller = {
    explain: (action: string) => {
      calls.explain.push(action);
      return overrides?.explainResult ?? { allowed: true };
    },
    record: async (action: string) => {
      calls.controllerRecord.push(action);
      return true;
    },
  };
  const ledger = createAutomationInteractionLedger({
    eventBus,
    // 测试替身只实现被测面；结构兼容真实注册表/漏斗的取用方式。
    riskRegistry: {
      getControllerForAccounting: async () => controller,
    } as never,
    riskAccounting: {
      applyNow: async () => {
        calls.applyNow++;
        return overrides?.applyNowResult ?? true;
      },
    },
    riskStore: {
      recordInteraction: async (accountId: string, noteId: string, action: string) => {
        calls.recordInteraction.push({ accountId, noteId, action });
      },
    } as never,
    likedNoteStore: {
      recordLike: async (noteId: string) => {
        calls.recordLike.push(noteId);
      },
    },
    interactionFeedStore: {
      recordEvent: async (accountId, action, targetId) => {
        calls.recordEvent.push({ accountId, action, targetId });
      },
      upsertMeta: async (accountId, targetId, meta) => {
        calls.upsertMeta.push({ accountId, targetId, meta });
      },
    },
    curatedWrite: {
      markBotAction: async (accountId, sourceId, action, content) => {
        calls.markBotAction.push({ accountId, sourceId, action, content });
      },
    },
    ...(overrides?.withAlertStore
      ? {
          alertStore: {
            raise: async (input: { accountId?: string }) => {
              calls.alerts.push(input.accountId ?? '');
              return { alertId: calls.alerts.length };
            },
          } as never,
        }
      : {}),
    logger: silentLogger,
  });
  return { eventBus, calls, ledger };
}

test('like 事件落四本账并立即 apply 风控计数', async () => {
  const { eventBus, calls } = harness();
  eventBus.emit('interaction.occurred', {
    action: 'like',
    accountId: 'acc-1',
    noteId: 'note-1',
    targetId: 'note-1',
  });
  await drain();
  assert.equal(calls.applyNow, 1, '风控内存计数必须立即 apply');
  assert.deepEqual(calls.controllerRecord, [], '漏斗在时不走进程内回落');
  assert.deepEqual(calls.recordLike, ['note-1'], 'liked_notes 血缘');
  assert.equal(calls.markBotAction.length, 1, '精选语料 markBotAction');
  assert.equal(calls.markBotAction[0].action, 'like');
  assert.equal(calls.markBotAction[0].content, undefined, 'like 是弱信号，不带正文');
  assert.deepEqual(calls.recordInteraction, [{ accountId: 'acc-1', noteId: 'note-1', action: 'like' }], '去重台账');
  assert.deepEqual(calls.recordEvent, [{ accountId: 'acc-1', action: 'like', targetId: 'note-1' }], '展示账本');
});

test('comment/follow 进展示账本；follow 不落按笔记键的三本账', async () => {
  const { eventBus, calls } = harness();
  eventBus.emit('interaction.occurred', { action: 'comment', accountId: 'acc-1', noteId: 'n1', targetId: 'n1' });
  eventBus.emit('interaction.occurred', { action: 'follow', accountId: 'acc-1', targetId: 'author-9' });
  await drain();
  assert.deepEqual(
    calls.recordEvent.map((c) => `${c.action}:${c.targetId}`),
    ['comment:n1', 'follow:author-9'],
  );
  assert.deepEqual(calls.recordLike, []);
  assert.deepEqual(calls.recordInteraction, [], 'comment 去重由调度器直写，follow 无 per-note 语义');
});

test('content_ref 引用：风控照常计数，但绝不进任何按笔记键的持久行', async () => {
  const { eventBus, calls } = harness();
  eventBus.emit('interaction.occurred', {
    action: 'like',
    accountId: 'acc-1',
    noteId: 'ref-1',
    targetId: 'ref-1',
    noteIdKind: 'content_ref',
  });
  await drain();
  assert.equal(calls.applyNow, 1, '浏览与点赞是真实发生的事实，风控照记');
  assert.deepEqual(calls.recordLike, []);
  assert.deepEqual(calls.markBotAction, []);
  assert.deepEqual(calls.recordInteraction, []);
  assert.deepEqual(calls.recordEvent, [], '展示账本也不进（follow 例外不适用于笔记类动作）');
});

test('缺 accountId 即 honest-fail 丢弃，绝不记账', async () => {
  const { eventBus, calls } = harness();
  eventBus.emit('interaction.occurred', { action: 'like', noteId: 'n1', targetId: 'n1' });
  await drain();
  assert.equal(calls.applyNow, 0);
  assert.deepEqual(calls.recordEvent, []);
});

test('漏斗没起来时回落进程内 controller.record', async () => {
  const { eventBus, calls } = harness({ applyNowResult: false });
  eventBus.emit('interaction.occurred', { action: 'like', accountId: 'acc-1', noteId: 'n1', targetId: 'n1' });
  eventBus.emit('search.occurred', {
    accountId: 'acc-1',
    activityId: 'a1',
    purpose: 'discovery',
    scope: 'global',
    outcome: 'results_ready',
  });
  await drain();
  assert.deepEqual(calls.controllerRecord, ['like', 'search']);
});

test('note.detail 喂元数据 + 最近观测缓存；随后 collect 的 markBotAction 带正文', async () => {
  const { eventBus, calls } = harness();
  const detail: NoteDetailData = {
    noteId: 'note-7',
    title: '标题七',
    content: '正文七',
    author: '作者甲',
    authorId: 'author-7',
    likeCount: 3,
    collectCount: 1,
    url: 'https://example.com/note-7',
  };
  eventBus.emit('note.detail.arrived', { detail, accountId: 'acc-1', ts: 1000 });
  await drain();
  assert.deepEqual(
    calls.upsertMeta.map((c) => c.targetId),
    ['note-7', 'author-7'],
    '笔记与作者元数据各一条',
  );
  eventBus.emit('interaction.occurred', { action: 'collect', accountId: 'acc-1', noteId: 'note-7', targetId: 'note-7' });
  await drain();
  assert.equal(calls.markBotAction.length, 1);
  const content = calls.markBotAction[0].content as { title: string; body: string };
  assert.equal(content.title, '标题七', 'collect 是强信号，同访问观测到正文则补建');
  assert.equal(content.body, '正文七');
});

test('profile.detail 补作者元数据；本人主页绝不写入（隔离守卫③）', async () => {
  const { eventBus, calls } = harness();
  eventBus.emit('profile.detail.arrived', {
    detail: { authorId: 'acc-1', postsCount: 0, followersCount: 5, nickname: '自己' },
    accountId: 'acc-1',
    ts: 1000,
  });
  eventBus.emit('profile.detail.arrived', {
    detail: { authorId: 'author-2', postsCount: 0, followersCount: 5, nickname: '别人', url: 'https://example.com/u/2' },
    accountId: 'acc-1',
    ts: 1001,
  });
  await drain();
  assert.deepEqual(
    calls.upsertMeta.map((c) => c.targetId),
    ['author-2'],
    '本人主页那条被守卫拦下',
  );
});

test('撞突发窗发节奏告警；人工评论标记期间 comment 不告警、账照记', async () => {
  const { eventBus, calls, ledger } = harness({
    withAlertStore: true,
    explainResult: { allowed: false, reason: 'quota:hour' },
  });
  eventBus.emit('interaction.occurred', { action: 'comment', accountId: 'acc-1', noteId: 'n1', targetId: 'n1' });
  await drain();
  assert.deepEqual(calls.alerts, ['acc-1'], '自动来源撞顶发 P2 告警');
  ledger.manualCommentMarker.onStart('acc-1');
  eventBus.emit('interaction.occurred', { action: 'comment', accountId: 'acc-1', noteId: 'n2', targetId: 'n2' });
  await drain();
  ledger.manualCommentMarker.onEnd('acc-1');
  assert.deepEqual(calls.alerts, ['acc-1'], '人工来源不发节奏告警');
  assert.equal(calls.applyNow, 2, '但配额账照记——手动跳过的是闸不是账');
});
