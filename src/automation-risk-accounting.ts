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

/** 保留期配置：**风控命令那条刻意没有 `unconsumedRetentionMs`**，见文件头第 3 条。 */
export function automationOutboxRetentionTopics(options: {
  panelEventConsumed: boolean;
  riskCommandConsumed: boolean;
}): ConstructorParameters<typeof OutboxRetentionPruner>[0]['topics'] {
  return [
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
