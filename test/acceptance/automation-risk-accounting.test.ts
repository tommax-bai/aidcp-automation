// aidcp:test-owner=derived
/**
 * 风控记账漏斗与 outbox 保留期（task 3.1d · 批 C 记账半）。
 *
 * 三条不许降级的各有会真触发它的用例；另有两条**结构断言**，因为它们守的东西
 * 行为测试原理上看不见：
 *
 * - **同一个池**：exactly-once 靠计数表那条唯一索引 + 单事务。两者分居两库时索引管不到对方，
 *   **零报错、只是不再 exactly-once**。行为测试永远发现不了。
 * - **承重命令主题没有兜底强删**：这条要断的是「某个字段**不在**配置里」，
 *   而"不在"这件事在行为上什么都不表现——直到某天一条没被应用的命令被删掉。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';

import {
  automationOutboxRetentionTopics,
  createAutomationRiskAccounting,
  type AutomationRiskAccountingOptions,
} from '../../src/automation-risk-accounting.js';
import type { AutomationRiskAlertInput } from '../../src/automation-risk-foundation.js';
import { RISK_COMMAND_TOPIC } from '../../src/transport/risk-command-outbox.js';
import { PANEL_EVENT_OUTBOX_TOPIC } from '../../src/transport/eventbus-outbox-bridge.js';

const SILENT = { log: () => undefined, warn: () => undefined, error: () => undefined };
const POOL = {} as pg.Pool;

function baseOptions(
  overrides: Partial<AutomationRiskAccountingOptions> & { alerts?: AutomationRiskAlertInput[] } = {},
): AutomationRiskAccountingOptions {
  const alerts = overrides.alerts ?? [];
  return {
    ownerPool: POOL,
    executionTarget: 'dev',
    registry: {
      getControllerForAccounting: async () => ({ record: async () => true }),
    } as unknown as AutomationRiskAccountingOptions['registry'],
    riskStore: {
      init: async () => undefined,
      totalsForAccountSince: async () => ({}),
    } as unknown as AutomationRiskAccountingOptions['riskStore'],
    raiseAlert: async (input) => {
      alerts.push(input);
    },
    logger: SILENT,
    createOutboxStore: () => ({ init: async () => undefined }),
    createAccounting: () =>
      ({
        start: async () => ({ recovered: 0 }),
        stop: () => undefined,
        isBlocked: (accountId: string) => accountId === 'acct-broken',
        record: async () => ({ allowed: true }),
      }) as unknown as ReturnType<NonNullable<AutomationRiskAccountingOptions['createAccounting']>>,
    createPruner: () => ({ start: () => undefined, stop: () => undefined }),
    ...overrides,
  };
}

test('承重命令主题 MUST NOT 设兜底强删；纯观测流可以', () => {
  const topics = automationOutboxRetentionTopics({
    panelEventConsumed: false,
    riskCommandConsumed: false,
  });
  const risk = topics.find((t) => t.topic === RISK_COMMAND_TOPIC)!;
  const panel = topics.find((t) => t.topic === PANEL_EVENT_OUTBOX_TOPIC)!;
  assert.equal(
    'unconsumedRetentionMs' in risk ? risk.unconsumedRetentionMs : undefined,
    undefined,
    '风控命令未被应用就删掉 = 静默吞掉一次风控状态写。这条 MUST 没有兜底强删',
  );
  assert.ok(
    panel.unconsumedRetentionMs !== undefined,
    '纯观测流反过来：回放端从没上线也不该让历史帧永久占生产库磁盘',
  );
});

test('「等谁追平才敢剪」由模式决定，不由游标行倒推', () => {
  const none = automationOutboxRetentionTopics({
    panelEventConsumed: false,
    riskCommandConsumed: false,
  });
  const both = automationOutboxRetentionTopics({
    panelEventConsumed: true,
    riskCommandConsumed: true,
  });
  assert.deepEqual(none.map((t) => t.consumers), [[], []]);
  assert.deepEqual(
    both.map((t) => t.consumers.length),
    [1, 1],
    '有消费者时才等它追平；靠「游标行在不在」倒推会让没有消费者的形态永久拒绝剪裁 + 永久告警',
  );
});

test('记账 outbox 与风控存储 MUST 同一个池（exactly-once 靠的是同库那条唯一索引）', async () => {
  // **结构断言**：分居两库时索引管不到对方，**零报错、只是不再 exactly-once**——行为测试看不见。
  const seen: pg.Pool[] = [];
  const accounting = await createAutomationRiskAccounting(
    baseOptions({
      createOutboxStore: (o) => {
        seen.push(o.pool);
        return { init: async () => undefined };
      },
    }),
  );
  assert.equal(seen.length, 1);
  assert.equal(
    seen[0],
    POOL,
    'outbox 存储 MUST 拿到与风控存储同一个池对象。换一个池不会报错，只会让 exactly-once 静默失效',
  );
  accounting.stop();
});

test('起得来：漏斗活着，断链判定给真答案', async () => {
  const accounting = await createAutomationRiskAccounting(baseOptions());
  assert.equal(accounting.active(), true);
  assert.equal(accounting.inactiveReason(), null);
  assert.equal(accounting.blocked('acct-broken'), true);
  assert.equal(accounting.blocked('acct-ok'), false);
  accounting.stop();
});

test('起不来：响亮告警 + 具名原因 + 记账回落，MUST NOT 静默降级、也 MUST NOT 拖死进程', async () => {
  const alerts: AutomationRiskAlertInput[] = [];
  let fellBack = false;
  const accounting = await createAutomationRiskAccounting(
    baseOptions({
      alerts,
      riskStore: {
        init: async () => {
          throw new Error('migration_0061_not_applied');
        },
        totalsForAccountSince: async () => ({}),
      } as unknown as AutomationRiskAccountingOptions['riskStore'],
      registry: {
        getControllerForAccounting: async () => ({
          record: async () => {
            fellBack = true;
            return true;
          },
        }),
      } as unknown as AutomationRiskAccountingOptions['registry'],
    }),
  );

  assert.equal(accounting.active(), false, '起不来就是起不来，MUST NOT 报成活着');
  assert.match(
    accounting.inactiveReason() ?? '',
    /migration_0061_not_applied/,
    '原因 MUST 具名——「记账没起来」和「为什么没起来」是两件事',
  );
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.severity, 'P1');
  assert.equal(alerts[0]!.type, 'risk_accounting_unavailable');
  assert.match(
    alerts[0]!.detail,
    /不成立/,
    '告警 MUST 说清丢失的是哪条保证，而不是只说「失败了」',
  );

  // 进程照跑，记账走回落路径（改动前的行为）。
  assert.equal(await accounting.recordRiskFact('acct-a', 'comment', 'k1'), true);
  assert.equal(fellBack, true, '漏斗未启用时 MUST 回落 controller.record，行为逐位一致');
  assert.equal(
    accounting.blocked('acct-broken'),
    false,
    '漏斗没起来时恒答 false 是**回落语义**：记账退回进程内路径，本来就不会把账号标断链。'
      + '「起不来」由那条 P1 负责说，MUST NOT 靠这个返回值表达',
  );
  accounting.stop();
});

test('漏斗活着时判定 + 记账走漏斗，不再落回 controller', async () => {
  let fellBack = false;
  const accounting = await createAutomationRiskAccounting(
    baseOptions({
      registry: {
        getControllerForAccounting: async () => ({
          record: async () => {
            fellBack = true;
            return true;
          },
        }),
      } as unknown as AutomationRiskAccountingOptions['registry'],
    }),
  );
  assert.equal(await accounting.recordRiskFact('acct-a', 'comment', 'k1'), true);
  assert.equal(fellBack, false, '全系统唯一入口：漏斗在就走漏斗，两条路同时活着会记两次账');
  accounting.stop();
});

test('剪裁在漏斗起不来时照样启动（outbox 是队列，不剪就只进不出）', async () => {
  let prunerStarted = 0;
  const accounting = await createAutomationRiskAccounting(
    baseOptions({
      riskStore: {
        init: async () => {
          throw new Error('down');
        },
        totalsForAccountSince: async () => ({}),
      } as unknown as AutomationRiskAccountingOptions['riskStore'],
      createPruner: () => ({
        start: () => {
          prunerStarted += 1;
        },
        stop: () => undefined,
      }),
    }),
  );
  assert.equal(
    prunerStarted,
    1,
    '剪裁与记账是两件事：记账起不来时更不该让 outbox 只进不出',
  );
  accounting.stop();
});
