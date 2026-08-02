// aidcp:test-owner=derived
/**
 * 评论域审批与通知五个口（批 G 第二片）。
 *
 * 这一片管的是**授权**，所以红线全在「读不到 / 接不上时往哪边倒」：
 * 一律倒向更严的那边（review / 不发），且必须说出来。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAutomationCommentApprovalPorts } from '../../src/automation-comment-approval.js';

const SILENT = { log: () => undefined, warn: () => undefined };
const noApproval = { read: async () => null };

const build = (over: Record<string, unknown> = {}) =>
  createAutomationCommentApprovalPorts({
    deliverStructuredNotification: async () => undefined,
    publishApproval: noApproval,
    approvalEnabled: false,
    logger: SILENT,
    ...over,
  } as never);

/* ─────────────── 红线 1：审批口径读不到 → review ─────────────── */

test('策略端口没接线 → fail-closed 成 review，MUST NOT 沿用来源模式', async () => {
  const ports = build();
  // 来源本身是免审，但策略读不到 —— 沿用它就是把一次没核实过的免审放出去。
  assert.equal(await ports.resolveApprovalMode('acc-1', 'auto_approve'), 'review');
  assert.equal(await ports.resolveApprovalMode('acc-1', 'review'), 'review');
});

test('策略读取抛错 → 同样 fail-closed 成 review，且说得出是哪个账号', async () => {
  const warned: string[] = [];
  const ports = build({
    approvalPolicy: {
      getAccountCommentMode: async () => {
        throw new Error('authority_down');
      },
    },
    logger: { log: () => undefined, warn: (m: string) => warned.push(m) },
  });
  assert.equal(await ports.resolveApprovalMode('acc-9', 'auto_approve'), 'review');
  assert.equal(warned.length, 1, '读不到 MUST 说出来，不能静默回落');
  assert.match(warned[0]!, /acc-9/);
  assert.match(warned[0]!, /authority_down/, '原始错因 MUST 带出来');
});

test('只有环境级「全免审」才免审；其余取值一律沿用来源模式，不扩权', async () => {
  const modeOf = (environmentMode: string) =>
    build({
      approvalPolicy: { getAccountCommentMode: async () => environmentMode },
    });
  assert.equal(
    await modeOf('auto_approve_all').resolveApprovalMode('a', 'review'),
    'auto_approve',
  );
  // 非「全免审」的任何取值都不许把 review 提成免审。
  for (const mode of ['source_rules', 'review_all', 'unknown_value', '']) {
    assert.equal(
      await modeOf(mode).resolveApprovalMode('a', 'review'),
      'review',
      `环境模式 ${mode} MUST NOT 扩权`,
    );
    assert.equal(
      await modeOf(mode).resolveApprovalMode('a', 'auto_approve'),
      'auto_approve',
      `环境模式 ${mode} 下 MUST 沿用来源模式`,
    );
  }
});

/* ─────────────── 红线 2：人审端口按 env 整体二态 ─────────────── */

test('人审未开启 → 具名 unavailable，绝不是 undefined', async () => {
  const ports = build({ approvalEnabled: false });
  assert.equal(ports.approval.state, 'unavailable');
  assert.equal(
    ports.approval.state === 'unavailable' && ports.approval.reason,
    'comment_approval_disabled_by_env',
    '理由 MUST 具名 ——「没接线」与「接了但今天不可用」处置完全不同',
  );
});

test('人审开启 → 接线，且请求会带幂等键发出去', async () => {
  const sent: Array<{ payload: unknown; key: string }> = [];
  const ports = build({
    approvalEnabled: true,
    deliverStructuredNotification: async (payload: unknown, key: string) => {
      sent.push({ payload, key });
    },
  });
  assert.equal(ports.approval.state, 'wired');
  if (ports.approval.state !== 'wired') return;
  const port = ports.approval.port as {
    request(input: { requestId: string; text: string }): Promise<void>;
    timeoutMs: number;
    pollMs: number;
  };
  await port.request({ requestId: 'req-1', text: '正文' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.key, 'comment-approval:req-1', '幂等键 MUST 按 requestId');
  assert.equal(port.timeoutMs, 90_000);
  assert.equal(port.pollMs, 2_000);
});

/* ─────────────── 红线 3：迁移失败不影响放行 ─────────────── */

test('已批准时迁移失败 MUST NOT 影响放行——授权判定只看 approved', async () => {
  const warned: string[] = [];
  const ports = build({
    approvalEnabled: true,
    publishApproval: {
      read: async () => ({ approved: true, revision: 7 }),
      markConsumed: async () => {
        throw new Error('ledger_down');
      },
    },
    logger: { log: () => undefined, warn: (m: string) => warned.push(m) },
  });
  if (ports.approval.state !== 'wired') return assert.fail('应已接线');
  const port = ports.approval.port as { isApproved(id: string): Promise<boolean> };
  // 一次记账故障绝不能吞掉运营已经点过的批准。
  assert.equal(await port.isApproved('req-2'), true);
  assert.equal(warned.length, 1, '迁移失败 MUST 留痕');
  assert.match(warned[0]!, /ledger_down/);
});

test('未批准时不迁移、也不冒充已批准', async () => {
  let consumed = 0;
  const ports = build({
    approvalEnabled: true,
    publishApproval: {
      read: async () => ({ approved: false }),
      markConsumed: async () => {
        consumed += 1;
      },
    },
  });
  if (ports.approval.state !== 'wired') return assert.fail('应已接线');
  const port = ports.approval.port as { isApproved(id: string): Promise<boolean> };
  assert.equal(await port.isApproved('req-3'), false);
  assert.equal(consumed, 0, '没批准 MUST NOT 迁移状态');
  // 读不到记录同样不是「已批准」。
  const missing = build({
    approvalEnabled: true,
    publishApproval: { read: async () => null },
  });
  if (missing.approval.state !== 'wired') return assert.fail('应已接线');
  assert.equal(
    await (missing.approval.port as { isApproved(id: string): Promise<boolean> }).isApproved(
      'req-4',
    ),
    false,
  );
});

/* ─────────────── 红线 4：语料库缺失是具名降级 ─────────────── */

test('语料库缺失 → 具名 unavailable；在场则复用同一个实例、不另建', async () => {
  const absent = build().valuableCorpus;
  assert.equal(absent.state, 'unavailable');
  assert.equal(
    absent.state === 'unavailable' ? absent.reason : null,
    'valuable_comment_store_unavailable',
  );

  const archived: unknown[] = [];
  const store = {
    archive: async (input: unknown) => {
      archived.push(input);
    },
    retrieveByTopics: async () => ['ref'],
  };
  const ports = build({ valuableCommentStore: store });
  assert.equal(ports.valuableCorpus.state, 'wired');
  if (ports.valuableCorpus.state !== 'wired') return;
  await ports.valuableCorpus.port.archive({ id: 1 });
  // 复用批 B 底座那一个实例：另建第二个会让归档与召回落在两个连接池上，且谁都不报错。
  assert.deepEqual(archived, [{ id: 1 }]);
  assert.deepEqual(await ports.valuableCorpus.port.retrieveByTopics(['t'], 3), ['ref']);
});

/* ─────────────── 通知：幂等键与来源分流 ─────────────── */

test('免审通知按来源分流，且 mandatory 与普通免审是两种卡', async () => {
  const sent: Array<{ kind: string; key: string }> = [];
  const ports = build({
    deliverStructuredNotification: async (payload: unknown, key: string) => {
      sent.push({ kind: (payload as { kind: string }).kind, key });
    },
  });
  await ports.notifyAutoApproved(
    { requestId: 'r1', text: 'x', accountId: 'a' } as never,
    'mandatory_persona' as never,
  );
  await ports.notifyAutoApproved(
    { requestId: 'r2', text: 'y', accountId: 'a', contactIncluded: true } as never,
    'account_global' as never,
  );
  assert.deepEqual(sent.map((s) => s.kind), [
    'mandatory_comment_pre_authorization',
    'command_result',
  ]);
  // 幂等键带上来源：同一个 requestId 在两条来源上各发一次是合法的。
  assert.deepEqual(sent.map((s) => s.key), [
    'comment-auto-approved:mandatory_persona:r1',
    'comment-auto-approved:account_global:r2',
  ]);
});

test('mandatory 终态通知的幂等键含终态——同一请求的不同终态各发一次', async () => {
  const keys: string[] = [];
  const ports = build({
    deliverStructuredNotification: async (_payload: unknown, key: string) => {
      keys.push(key);
    },
  });
  await ports.notifyMandatoryOutcome({ requestId: 'r9', outcome: 'commented' } as never);
  await ports.notifyMandatoryOutcome({ requestId: 'r9', outcome: 'rejected' } as never);
  assert.deepEqual(keys, [
    'mandatory-comment-outcome:r9:commented',
    'mandatory-comment-outcome:r9:rejected',
  ]);
});

test('免审通知的来源 MUST 由调用点按 approvalSource 现推，供给方不许写死', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../../src/automation-connection-dispatcher.ts', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('commentAutoApproveNotify:');
  assert.notEqual(start, -1);
  const body = source.slice(start, start + 600);
  assert.match(
    body,
    /approvalSource === 'mandatory_persona'/,
    '来源 MUST 现推 —— 写死会让 mandatory 人设免审与账号级免审发出同一种卡，'
      + '运营再也分不出这条评论是被哪条授权放行的',
  );
});
