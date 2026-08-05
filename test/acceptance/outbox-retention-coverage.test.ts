/**
 * AC-OUTBOX-RETENTION-01 每条 outbox 主题都必须真的有人剪。
 *
 * **这条闸拦的不是「剪得对不对」，是「有没有人剪」**（2026-08-05 dev 实测）：
 * 剪裁器按主题名单工作，名单里没写的主题一行都不剪 —— 而这件事不报错、不告警、
 * 不体现在任何测试里，只体现为 dev/ol 共用的生产库上一张表在长。
 *
 * 当时漏了两条：`sync_read.changed`（每 target 每 10 秒一条，长到 8 万行、
 * 占该表 99%，整表 141,245 行 / 45MB）与 `config_mirror.bump`（九天 17 行，
 * 所以一直没人看见）。**同一个缺口，只是产量不同** —— 靠产量来发现缺口，
 * 等于只能发现其中一半。两次都是靠人工查库发现的。
 *
 * 对账是双向的：声明要剪却无人登记 ⇒ 失败；登记了登记表以外的主题名 ⇒ 也失败
 * （名字写错时，真正那条主题实际无人剪裁，而拼错的那条什么都不匹配、静默无害）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { INTERACTION_AUDIT_OUTBOX_TOPIC } from 'aidcp-kernel/kernel/interaction-audit-outbox.js';

import { AUTOMATION_SYNC_READ_SIGNAL_RELAY_CONSUMER } from '../../src/automation-composition-root.js';
import { automationOutboxRetentionTopics } from '../../src/automation-risk-accounting.js';
import {
  assertOutboxRetentionCoverage,
  EVENT_OUTBOX_TOPICS,
  outboxTopicsRequiringRetention,
  reviewOutboxRetentionCoverage,
} from '../../src/transport/event-outbox-topic-roster.js';

/**
 * 本进程实际注册进剪裁器的主题**并集**。
 *
 * 两台剪裁器：风控记账那台（`automationOutboxRetentionTopics`）与审计中继那台
 * （`createAutomationConfigAuditRelay` 内联一条 `interaction.audit_event`）。
 * 后者的名单在函数内联、拿不到句柄，所以这里点名它那一条 —— 并在下面用引用断言
 * 钉住「点的确实是那个常量」，避免这份手抄名单与实现漂移。
 */
function registeredRetentionTopics(): string[] {
  const riskAccountingPruner = automationOutboxRetentionTopics({
    syncReadChangedConsumer: AUTOMATION_SYNC_READ_SIGNAL_RELAY_CONSUMER,
    panelEventConsumed: true,
    riskCommandConsumed: true,
  }).map((entry) => entry.topic);
  const auditRelayPruner = [INTERACTION_AUDIT_OUTBOX_TOPIC];
  return [...riskAccountingPruner, ...auditRelayPruner];
}

test('AC-OUTBOX-RETENTION-01 登记表里每条声明要剪的主题都真的有剪裁器登记它', () => {
  const report = reviewOutboxRetentionCoverage(registeredRetentionTopics());
  assert.deepEqual(
    report.uncovered,
    [],
    '这些主题声明要剪却无人登记 —— 它们正在共用生产库上无界增长，且不会报错',
  );
  assert.deepEqual(
    report.unregistered,
    [],
    '剪裁器登记了登记表以外的主题名 —— 名字写错时真正那条主题无人剪裁',
  );
  assert.deepEqual(report.prunedDespiteDisposition, []);
  assert.doesNotThrow(() => assertOutboxRetentionCoverage(registeredRetentionTopics()));
});

test('AC-OUTBOX-RETENTION-02 本次漏掉的两条主题确实在名单里，且按游标剪、不强删', () => {
  const entries = automationOutboxRetentionTopics({
    syncReadChangedConsumer: AUTOMATION_SYNC_READ_SIGNAL_RELAY_CONSUMER,
    panelEventConsumed: true,
    riskCommandConsumed: true,
  });
  for (const topic of ['sync_read.changed', 'config_mirror.bump']) {
    const entry = entries.find((candidate) => candidate.topic === topic);
    assert.ok(entry, `${topic} 不在剪裁名单里 —— 这正是 2026-08-05 那条缺口的形态`);
    assert.ok(
      entry!.consumers.length > 0,
      `${topic} MUST 按消费者游标下界剪，MUST NOT 纯按年龄裸剪（会删掉尚未投递的行）`,
    );
    assert.equal(
      entry!.unconsumedRetentionMs,
      undefined,
      `${topic} MUST NOT 设强删兜底：`
        + 'config_mirror.bump 删掉未投递的 = 一处配置永远不 reload；'
        + 'sync_read.changed 没有非开不可的理由，开了就是给将来留一条「消费者没上线也照删」的路',
    );
    assert.ok(entry!.retentionMs > 0);
  }
});

test('AC-OUTBOX-RETENTION-03 覆盖闸会点名漏掉的那条，而不是压成一个布尔', () => {
  // 复现本次的形态：剪裁器接了、其他主题都在，独独少这一条。
  const missingOne = registeredRetentionTopics().filter(
    (topic) => topic !== 'sync_read.changed',
  );
  assert.deepEqual(reviewOutboxRetentionCoverage(missingOne).uncovered, [
    'sync_read.changed',
  ]);
  assert.throws(
    () => assertOutboxRetentionCoverage(missingOne),
    /sync_read\.changed/,
    '漏掉的主题 MUST 在错误文案里被点名，否则这道闸只会说「有问题」',
  );

  // 登记表本身也必须是全集：新增主题却不给保留裁定，typecheck 那一层已经拦了，
  // 这里再钉一次「五条一条不少」，防止有人把某条从登记表里删掉来绕过对账。
  assert.equal(EVENT_OUTBOX_TOPICS.length, 5);
  assert.equal(outboxTopicsRequiringRetention().length, 5);
});
