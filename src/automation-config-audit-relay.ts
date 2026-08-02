/**
 * 互动配置面**审计中继**（change split-cloud-automation-production-runtime 批 C 最后一件）。
 *
 * 把本进程 outbox 里的配置面审计行排空到**接口属主表**。
 *
 * ## 为什么是中继，而不是直接写那张表
 *
 * 审计表归接口域单写。拆进程之后本进程连它的库都不该开池 ——
 * 所以配置面的写入侧改成「入队到本域 outbox」，再由这条中继经**已有的跨进程通道**送过去。
 * **MUST NOT 直连那张表**：那既破坏单写、又会在物理拆库后直接连不上。
 *
 * ## 三条不许降级的
 *
 * 1. **载荷结构不符 ⇒ 抛错，让游标停在该条之前**，每一轮如实报一次（可见的堵塞）。
 *    **MUST NOT 静默跳过** —— 载荷由本仓自己的写入侧生成，结构不符即代码缺陷，
 *    靠丢掉一条审计来掩盖，等于让「谁在什么时候改了配置」这件事出现无人知晓的空洞。
 * 2. **跨进程通道缺席同样抛错**，不吞。吞掉的话中继会一直"成功"地把审计丢进真空。
 * 3. **承重主题 MUST NOT 设兜底强删**（`unconsumedRetentionMs`）。
 *    outbox 是队列不是账本，没有剪裁只进不出；但审计**未落地就删 = 静默吞掉一条审计**。
 *    剪裁只按「已被本消费者确认」的那一档做 —— 真正的账本是接口侧那张表（365 天），
 *    outbox 只留 24 小时。
 */
import type pg from 'pg';

import type { DeploymentTarget } from 'aidcp-kernel/deployment-target.js';
import {
  INTERACTION_AUDIT_OUTBOX_RETENTION_MS,
  INTERACTION_AUDIT_OUTBOX_TOPIC,
  INTERACTION_AUDIT_RELAY_CONSUMER,
  decodeInteractionAuditEvent,
} from 'aidcp-kernel/kernel/interaction-audit-outbox.js';

import {
  OutboxConsumer,
  OutboxRetentionPruner,
  type OutboxHandler,
} from './transport/event-outbox.js';

/** 审计落地的跨进程出口（接口属主的写入口客户端）。缺席即抛，见红线 2。 */
export interface InteractionAuditWritePort {
  insertAuditEvent(record: unknown): Promise<unknown>;
}

export interface AutomationConfigAuditRelayOptions {
  /** **自动化属主池**：outbox 表归 automation。 */
  pool: pg.Pool;
  /** 部署目标。缺失即整片不启动（outbox 行按 target 隔离）。 */
  executionTarget?: DeploymentTarget;
  /**
   * 审计写入口。**二态而非可选**：`unavailable` 时中继照样启动、但每条都抛，
   * 于是游标停住、堵塞可见 —— 这比"不启动"更诚实，因为队列里的行确实还在等人送。
   */
  auditWrites?: InteractionAuditWritePort;
  logger?: Pick<Console, 'log' | 'warn'>;
}

export interface AutomationConfigAuditRelay {
  /** 起中继与剪裁。**定时器不在构造期起**：与批 D/F 一致，留给进程入口在就绪闸之后调。 */
  start(): void;
  stop(): void;
  /** 本片是否真的在跑（探活用；未启动时调用方能如实报出来）。 */
  running(): boolean;
}

export function createAutomationConfigAuditRelay(
  options: AutomationConfigAuditRelayOptions,
): AutomationConfigAuditRelay {
  const logger = options.logger ?? console;
  const target = options.executionTarget;

  if (!target) {
    logger.warn(
      '[aidcp-automation] 配置面审计中继未启动：缺部署目标 —— ' +
        'outbox 行按 target 隔离，没有目标会把别的机器的审计也排空过去',
    );
    return { start: () => undefined, stop: () => undefined, running: () => false };
  }

  const relay = new OutboxConsumer({
    consumer: INTERACTION_AUDIT_RELAY_CONSUMER,
    executionTarget: target,
    pool: options.pool,
    handlers: new Map<string, OutboxHandler>([
      [
        INTERACTION_AUDIT_OUTBOX_TOPIC,
        async (event) => {
          const record = decodeInteractionAuditEvent(event.payload);
          if (!record) {
            // 结构不符即代码缺陷：抛出去让游标停住、每轮报一次，MUST NOT 丢掉这条审计。
            throw new Error(
              `interaction_audit_relay_undecodable_payload id=${String(event.id)}`,
            );
          }
          if (!options.auditWrites) {
            // 通道缺席同样抛：吞掉的话中继会一直「成功」地把审计丢进真空。
            throw new Error('interaction_api_writes_unavailable');
          }
          await options.auditWrites.insertAuditEvent(record);
        },
      ],
    ]),
    logger,
  });

  // 队列剪裁：审计的**账本**是接口侧那张表（365 天），outbox 只留 24h。
  // **承重主题 ⇒ 不设 unconsumedRetentionMs 兜底强删**（未落地就删 = 静默吞审计）。
  const pruner = new OutboxRetentionPruner({
    pool: options.pool,
    executionTarget: target,
    topics: [
      {
        topic: INTERACTION_AUDIT_OUTBOX_TOPIC,
        retentionMs: INTERACTION_AUDIT_OUTBOX_RETENTION_MS,
        consumers: [INTERACTION_AUDIT_RELAY_CONSUMER],
      },
    ],
    logger,
  });

  let started = false;
  return {
    start: () => {
      if (started) return;
      started = true;
      relay.start();
      pruner.start();
      logger.log(
        `[aidcp-automation] 互动配置面审计中继已启动（topic=${INTERACTION_AUDIT_OUTBOX_TOPIC}, target=${target}）`,
      );
    },
    stop: () => {
      if (!started) return;
      started = false;
      relay.stop?.();
      pruner.stop?.();
    },
    running: () => started,
  };
}
