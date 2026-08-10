/**
 * 风控记账漏斗与 outbox 保留期（task 3.1d · 批 C 的记账那一半）。
 *
 * 它供的是批 B 那个留空的必填口 `accountingBlocked`，以及全系统唯一的「判定 + 记账」入口。
 *
 * ## 三条不许降级的（每条都对着一次真会丢账或翻倍的后果）
 *
 * 1. **记账链路起不来 ≠ 照跑。** 起不来时那条「崩在回执与记账之间不丢账」的保证就不成立了，
 *    但也不该把整个进程拖死（客户数据、内容服务、已在跑的会话都不依赖它）。
 *    折中是**响亮告警 + 漏斗保持未注入**，记账退回改动前的进程内路径，
 *    而「退回了」这件事本身写进告警里。MUST NOT 静默降级。
 * 2. **记账 outbox MUST 与风控存储同一个池。** exactly-once 全靠计数表上那条唯一索引 +
 *    单事务「写计数 + 标已应用」；两者分居两库时那条索引管不到对方，
 *    **exactly-once 直接失效且零报错**。这条有结构断言钉着。
 * 3. **承重命令主题 MUST NOT 设兜底强删。** outbox 是队列不是账本，没有剪裁就只进不出；
 *    但风控命令那条**未被应用就删掉 = 静默吞掉一次风控状态写**。
 *    纯观测流（面板事件）可以强删——即使回放端从没上线，历史帧也不该继续占生产库磁盘。
 *
 * ## 记账刻意不过归属闸
 *
 * 计数表是**既成事实账本**：归属刚变更时飞在半路的回执仍要记进同一本账。
 * 分裂的是写权限，不分裂的是事实。所以这里取的是「记账用」的控制器解析口，
 * 不是那个带属主谓词的写口。
 */
import type pg from 'pg';

import type { DeploymentTarget } from 'aidcp-kernel/deployment-target.js';
import type { AccountOwnershipPort } from 'aidcp-kernel/kernel/account-ownership-port.js';

import type { RiskAction } from './risk/types.js';
import { RiskAccounting } from './risk/risk-accounting.js';
import { RiskCounterReconciler } from './risk/risk-counter-reconciler.js';
import { PgRiskCounterOutboxStore } from './risk/risk-counter-outbox-store.js';
import type { RiskControllerRegistry } from './risk/risk-controller-registry.js';
import type { PgRiskStore } from './risk/pg-risk-store.js';
import { CONFIG_MIRROR_BUMP_TOPIC } from 'aidcp-kernel/kernel/config-mirror-bump-types.js';
import { SYNC_READ_CHANGED_TOPIC } from 'aidcp-kernel/kernel/sync-read-snapshot.js';

import { CONFIG_MIRROR_BUMP_CONSUMER } from './config/mirror-bump-outbox.js';
import { OutboxRetentionPruner } from './transport/event-outbox.js';
import {
  PANEL_EVENT_OUTBOX_TOPIC,
  PANEL_EVENT_RETENTION_MS,
  PANEL_EVENT_REPLAY_CONSUMER,
  PANEL_EVENT_UNCONSUMED_RETENTION_MS,
} from './transport/eventbus-outbox-bridge.js';
import {
  RISK_COMMAND_CONSUMER,
  RISK_COMMAND_RETENTION_MS,
  RISK_COMMAND_TOPIC,
} from './transport/risk-command-outbox.js';
import type { AutomationRiskAlertInput } from './automation-risk-foundation.js';

export interface AutomationRiskAccountingOptions {
  /**
   * 属主池。**MUST 与构造风控存储时用的是同一个** —— exactly-once 靠计数表那条唯一索引 +
   * 单事务，跨库时索引管不到对方。本模块有结构断言钉这一点。
   */
  ownerPool: pg.Pool;
  executionTarget: DeploymentTarget;
  registry: RiskControllerRegistry;
  /** 风控存储。本模块只用它做启动期 schema 探测与对账取数，不自己拼 SQL。 */
  riskStore: Pick<PgRiskStore, 'init' | 'totalsForAccountSince'>;
  /**
   * 账号归属的三态读（change scope-risk-reconcile-to-owned-accounts）。**对账范围据此收敛为
   * 「归属为本 target 的账号」**：计数表是 dev / ol 共用且不带 target 的既成事实账本，而内存计数
   * 只在本进程自己记账时递增 —— 对「归属在另一个 target 的账号」两者结构上不可能相等，而面板的
   * 只读用量查询又会顺手把这些账号的控制器物化进来。不接这一口 ⇒ 每 5 分钟每账号每动作各刷一条
   * P1，把这条刻意做成零容忍的信号淹进常态噪音。
   *
   * **MUST 传底座给注册表用的同一口**（`AccountOwnershipPort`），MUST NOT 另起读法：两份读法
   * 漂开不会报错，只会让「条件写认为账号是我的、对账认为不是」。缺省 ⇒ 不过滤、全量对账
   * （逐字回到本 change 之前的行为）。
   */
  ownership?: Pick<AccountOwnershipPort, 'resolveExecutionTarget'>;
  /** 告警出口（批 B 的底座给）。**起不来时靠它说话**，所以是必填。 */
  raiseAlert: (input: AutomationRiskAlertInput) => Promise<void>;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  maxAttempts?: number;
  pollIntervalMs?: number;
  reconcileIntervalMs?: number;
  /** 是否消费面板事件回放（决定剪裁「等谁追平才敢剪」）。 */
  panelEventConsumed?: boolean;
  /** 是否消费风控命令。 */
  riskCommandConsumed?: boolean;
  /**
   * 同步读变更通知中继的消费者名（组装根注入；本文件不 import 组装根，见
   * {@link automationOutboxRetentionTopics}）。
   *
   * **必填、无缺省**：给一个默认字符串的后果是它与真中继的名字对不上时，剪裁器会永远
   * 等一个不存在的消费者追平 ⇒ 该主题一行都不剪、只在日志里留一条「拒绝剪裁」——
   * 与「漏登记」几乎同形，而这正是本 change 要消灭的那类缺口。
   */
  syncReadChangedConsumer: string;
  /** 替身注入（测试用）。 */
  createOutboxStore?: (options: {
    executionTarget: DeploymentTarget;
    pool: pg.Pool;
  }) => Pick<PgRiskCounterOutboxStore, 'init'>;
  createAccounting?: (
    options: ConstructorParameters<typeof RiskAccounting>[0],
  ) => RiskAccounting;
  createPruner?: (
    options: ConstructorParameters<typeof OutboxRetentionPruner>[0],
  ) => Pick<OutboxRetentionPruner, 'start' | 'stop'>;
}

export interface AutomationRiskAccounting {
  /** 漏斗是否真的在跑。**false 时 `blocked()` 恒答 false，那是回落语义、不是「没问题」**。 */
  active(): boolean;
  /** 漏斗没起来时的具名原因（起来了 → null）。 */
  inactiveReason(): string | null;
  /**
   * 该账号的记账是否已断链（断链 ⇒ 一切互动准入直接拒，浏览仍放行）。
   * 交给批 B 那个 `accountingBlocked` 必填口。
   */
  blocked(accountId: string): boolean;
  /** 写入前判定 + 记账，**全系统唯一入口**。漏斗未启用时回落改动前的路径，行为逐位一致。 */
  recordRiskFact(accountId: string, action: RiskAction, dedupeKey: string): Promise<boolean>;
  /**
   * 立即 apply 一轮 outbox（互动观测订阅用：回执处理已把事实同步落 outbox，这里把
   * 「事实落库」与「内存计数递增」的窗口压到不可观测；轮询只作崩溃恢复兜底）。
   * 漏斗没起来时答 `false`，调用方回落进程内 `controller.record`——与单体订阅的
   * `if (riskAccounting) applyNow else record` 分支逐位同形。
   */
  applyNow(): Promise<boolean>;
  /**
   * 边缘回执处理器要的那一口（「**先落 outbox 再 emit**」）。
   *
   * **漏斗没起来时如实答 `undefined`**，而不是给一个会静默吞掉的空壳 —— 那正是消费方
   * （处理器的 `riskAccounting` 参数）**写明了回落语义**的缺席条件：字段省略 ⇒ 处理器保持
   * 改动前行为（直接 emit，记账由订阅者承担）。给空壳会把「漏斗没起来」伪装成「记了」，
   * 而那时「崩在回执与记账之间不丢账」这条保证已经不成立了。
   *
   * 与 {@link recordRiskFact} **共用同一个漏斗实例**，不是第二条记账路径。
   */
  edgeHandlerPort():
    | {
        enqueue(input: {
          accountId: string;
          action: RiskAction;
          occurredAt?: number;
          dedupeKey: string;
        }): Promise<void>;
        record(input: {
          accountId: string;
          action: RiskAction;
          occurredAt?: number;
          dedupeKey: string;
        }): Promise<{ allowed: boolean }>;
      }
    | undefined;
  stop(): void;
}

/**
 * 变更通知主题的保留期。
 *
 * 两条都只是**通知**：真正承重的是「完整快照 / 版本表」，通知投递过去（游标越过）之后
 * 这一行就没有信息价值了，留一小段只为出问题时能回溯。
 * 取值刻意不同：`config_mirror.bump` 是承重失效信号、产量极低（九天 17 行），
 * 留一天不占地方却好查；`sync_read.changed` 是纯加速器、产量随事实变化走，留一小时够用。
 */
const SYNC_READ_CHANGED_RETENTION_MS = 60 * 60 * 1000;
const CONFIG_MIRROR_BUMP_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * 保留期配置：**风控命令那条刻意没有 `unconsumedRetentionMs`**，见文件头第 3 条。
 *
 * ⚠️ **这张名单少一条主题的后果是那条主题在共用生产库上无界增长，且不报错、不告警。**
 * 2026-08-05 实测：`sync_read.changed` 与 `config_mirror.bump` 两条都漏在这里，
 * 前者长到 8 万行 / 占该表 99%（整表 141,245 行 / 45MB），后者九天 17 行、所以没人看见 ——
 * 同一个缺口，只是产量不同。现在由 `EVENT_OUTBOX_RETENTION_ROSTER` 穷举登记 +
 * `test/acceptance/outbox-retention-coverage.test.ts` 双向对账钉住，漏一条即验收失败。
 */
export function automationOutboxRetentionTopics(options: {
  panelEventConsumed: boolean;
  riskCommandConsumed: boolean;
  /**
   * 同步读变更通知中继的消费者名。**由组装根注入，不在本文件 import**——
   * 那个常量住在组装根里，而本文件是 automation 层：automation → composition 是
   * 被边界门禁禁止的方向（`AC-BOUND-04` / census 会当场判 forbidden）。
   */
  syncReadChangedConsumer: string;
}): ConstructorParameters<typeof OutboxRetentionPruner>[0]['topics'] {
  return [
    {
      // 同步读变更通知：中继是本进程自己的常驻消费者（`signalRelay`），恒在。
      // 按它的游标下界剪；**不设强删**——它虽是加速器（承重面是接口进程的周期完整快照），
      // 但没有非开不可的理由，开了就是给将来留一条「消费者没上线也照删」的路。
      topic: SYNC_READ_CHANGED_TOPIC,
      retentionMs: SYNC_READ_CHANGED_RETENTION_MS,
      consumers: [options.syncReadChangedConsumer],
    },
    {
      // 配置失效信号：**承重**，删掉未投递的 = 一处配置永远不 reload ⇒ MUST NOT 强删。
      topic: CONFIG_MIRROR_BUMP_TOPIC,
      retentionMs: CONFIG_MIRROR_BUMP_RETENTION_MS,
      consumers: [CONFIG_MIRROR_BUMP_CONSUMER],
    },
    {
      topic: PANEL_EVENT_OUTBOX_TOPIC,
      retentionMs: PANEL_EVENT_RETENTION_MS,
      consumers: options.panelEventConsumed ? [PANEL_EVENT_REPLAY_CONSUMER] : [],
      // 纯观测流：即使回放端从没上线，历史帧也不该继续占生产库磁盘（强删会 warn）。
      unconsumedRetentionMs: PANEL_EVENT_UNCONSUMED_RETENTION_MS,
    },
    {
      topic: RISK_COMMAND_TOPIC,
      retentionMs: RISK_COMMAND_RETENTION_MS,
      consumers: options.riskCommandConsumed ? [RISK_COMMAND_CONSUMER] : [],
      // 承重命令：**MUST NOT 设兜底强删** —— 未被应用就删掉 = 静默吞掉一次风控状态写。
    },
  ];
}

export async function createAutomationRiskAccounting(
  options: AutomationRiskAccountingOptions,
): Promise<AutomationRiskAccounting> {
  const logger = options.logger ?? console;
  const createOutboxStore =
    options.createOutboxStore ?? ((o) => new PgRiskCounterOutboxStore(o));
  const createAccounting = options.createAccounting ?? ((o) => new RiskAccounting(o));
  const createPruner = options.createPruner ?? ((o) => new OutboxRetentionPruner(o));

  // ── 保留期剪裁：outbox 是队列不是账本，不接就只进不出 ────────────────────
  const pruner = createPruner({
    pool: options.ownerPool,
    executionTarget: options.executionTarget,
    topics: automationOutboxRetentionTopics({
      syncReadChangedConsumer: options.syncReadChangedConsumer,
      panelEventConsumed: options.panelEventConsumed ?? false,
      riskCommandConsumed: options.riskCommandConsumed ?? false,
    }),
    logger,
  });
  pruner.start();

  let accounting: RiskAccounting | undefined;
  let reconciler: RiskCounterReconciler | undefined;
  let inactiveReason: string | null = null;

  try {
    // schema 只探测、不自愈：outbox 表与计数表上的关联列都必须已由迁移建立。
    await options.riskStore.init();
    // **同一个池**：见文件头第 2 条。
    const outboxStore = createOutboxStore({
      executionTarget: options.executionTarget,
      pool: options.ownerPool,
    });
    await outboxStore.init();
    const started = createAccounting({
      outbox: outboxStore as ConstructorParameters<typeof RiskAccounting>[0]['outbox'],
      // 记账**不过归属闸**：既成事实账本，见文件头。
      resolveController: (accountId) => options.registry.getControllerForAccounting(accountId),
      alertStore: {
        raise: async (input) => {
          // 告警存储那一侧的 `detail` 是可选的，本进程的告警出口要求必填 ——
          // 缺 detail 时**明说「未给出细节」**，MUST NOT 塞空串（空细节的告警读起来像正常告警）。
          await options.raiseAlert({ ...input, detail: input.detail ?? '（记账侧未给出细节）' });
          return { alertId: 0 };
        },
      },
      logger,
      maxAttempts: options.maxAttempts ?? 5,
      pollIntervalMs: options.pollIntervalMs ?? 5_000,
      workerId: `risk-outbox-${options.executionTarget}`,
    });
    const { recovered } = await started.start();
    accounting = started;
    logger.log(
      `[aidcp-automation] 风控记账 outbox 已就绪（target=${options.executionTarget}，启动回收在途行=${recovered}）`,
    );

    const ownership = options.ownership;
    reconciler = new RiskCounterReconciler({
      registry: options.registry,
      totalsSince: (accountId, since) => options.riskStore.totalsForAccountSince(accountId, since),
      // 对账范围按归属收敛（change scope-risk-reconcile-to-owned-accounts）：见 options.ownership 的注释。
      ...(ownership
        ? {
            executionTarget: options.executionTarget,
            ownerTargetFor: (accountId: string) => ownership.resolveExecutionTarget(accountId),
          }
        : {}),
      intervalMs: options.reconcileIntervalMs ?? 5 * 60_000,
      logger,
      onDrift: (drift) =>
        void options.raiseAlert({
          severity: 'P1',
          type: 'risk_counter_drift',
          accountId: drift.accountId,
          title: `风控计数与库内事实不一致：账号 ${drift.accountId} 的 ${drift.action}`,
          detail:
            `内存=${drift.memory}，库=${drift.database}。**判据是偏差是否为零，没有容忍阈值。**`
            + '已按库内事实重建该账号计数；对账范围已限定为归属本 target 的账号，故这条偏差不来自另一 target 的正常驱动；'
            + '来源通常是运维手工 SQL、归属刚变更时飞在半路的回执，或本进程记账链路漏记。',
        }),
    });
    reconciler.start();
    logger.log(
      `[aidcp-automation] 风控计数对账已启动（偏差非零即告警并以库为准重建）：范围=${
        ownership ? `归属为 ${options.executionTarget} 的账号` : '全部已物化账号（归属读口缺席，未过滤）'
      }`,
    );
  } catch (error) {
    inactiveReason = error instanceof Error ? error.message : String(error);
    // 起不来 MUST NOT 静默降级为「照跑」，也不该把整个进程拖死。
    await options.raiseAlert({
      severity: 'P1',
      type: 'risk_accounting_unavailable',
      title: '风控记账 outbox 未能启用，记账退回改动前的进程内路径',
      detail:
        `${inactiveReason}。此时「崩在回执与记账之间不丢账」这条保证**不成立**，MUST 尽快修复。`
        + '常见原因：迁移未执行、schema 对象不完整或数据库连接失败。',
    });
  }

  return {
    active: () => accounting !== undefined,
    inactiveReason: () => inactiveReason,
    /**
     * 漏斗没起来时恒答 false —— 那是**回落语义**（记账退回进程内路径，本来就不会把账号标断链），
     * 不是「没问题」。「起不来」这件事由上面那条 P1 告警负责说，MUST NOT 靠这个返回值表达。
     */
    blocked: (accountId) => accounting?.isBlocked(accountId) ?? false,
    recordRiskFact: async (accountId, action, dedupeKey) => {
      if (accounting) {
        const verdict = await accounting.record({ accountId, action, dedupeKey });
        return verdict.allowed;
      }
      return (await options.registry.getControllerForAccounting(accountId)).record(action);
    },
    applyNow: async () => {
      if (!accounting) return false;
      await accounting.applyNow();
      return true;
    },
    // **就是上面那个漏斗实例本身**（`RiskAccounting` 的两个方法逐字同形）；
    // 没起来时如实缺席，见接口处那段注释。
    edgeHandlerPort: () =>
      accounting
        ? {
            enqueue: (input) => accounting!.enqueue(input),
            record: (input) => accounting!.record(input),
          }
        : undefined,
    stop: () => {
      reconciler?.stop();
      accounting?.stop();
      pruner.stop();
    },
  };
}
