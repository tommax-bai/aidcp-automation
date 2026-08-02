/**
 * Facebook 规则 / 消费两套**运行时存储**的装配（change split-cloud-automation-production-runtime
 * 批 G 第一片）。
 *
 * 它填的是批 E-2 步骤 3 那个工厂留下的 {@link AutomationFacebookRuntimePorts} 里的两个口
 * （`rule` / `consumption`）。第三个口 `coordinator` **不在本片**，理由见下。
 *
 * ## 为什么先切这两样出来
 *
 * 它们自洽：只要一个**自动化属主池** + 部署目标 + schema 探针，不依赖评论域的任何东西。
 * 而消费协调器缠着加群调度器、评论调度器、历史群选择、风控控制器物化和群成员账本，
 * 所以它单独成片（批 G 第四片，落点 `automation-comment-scheduler` 之后）。
 *
 * **一处已作废的判断留在这里备查**：本片原先写着「协调器要的运营策略决策是 api 属主的异步口，
 * 需要再补一条跨进程口」。2026-08-02 实读推翻——它要的两样输入本进程都已具备
 * （基线走同步读镜像，慢启动走本进程自己的风控投影），缺的只是把两样拼起来的那一小段纯判断，
 * 已析出到公共契约层。**别再照那句话去补跨进程口。**
 *
 * ## 两条红线
 *
 * 1. **部署目标缺失 / 非法 ⇒ 不构造、二态报 `unavailable` 并具名**（task 3.4）。
 *    这两张表都是 target-scoped 的持久运行时：没有目标就写不出正确的隔离列，
 *    构造出来只会往共享库里写没有归属的行。单体里同样是 `deploymentTarget ? … : undefined`。
 * 2. **`init()` 失败 MUST 变成具名 `unavailable`，MUST NOT 静默降级成"没这个能力"**。
 *    调用方据此报 blocker；吞掉的话，规则批次与消费模式会安静地一步都不走，
 *    而日志上与「今天没排期」完全同形。
 */
import type pg from 'pg';

import type { DeploymentTarget } from 'aidcp-kernel/deployment-target.js';
import type { SchemaProber } from 'aidcp-kernel/kernel/schema-capability-contract.js';

import type { AutomationFacebookRuntimePorts } from './automation-connection-dispatcher.js';
import { FacebookRuleModeRuntimeStore } from './orchestrator/facebook-rule-mode-runtime-store.js';
import { FacebookConsumptionModeRuntimeStore } from './orchestrator/facebook-consumption-mode-runtime-store.js';

export interface AutomationFacebookRuntimeOptions {
  /** **自动化属主池**。这两张表归 automation，MUST NOT 传接口域的池。 */
  runtimePool: pg.Pool;
  /** 部署目标。缺失 / 非法即整片不构造（见红线 1）。 */
  executionTarget?: DeploymentTarget;
  schemaProber: SchemaProber;
  logger?: Pick<Console, 'warn'>;
}

export interface AutomationFacebookRuntimeAssembly {
  /** 喂给每连接调度器工厂的两个口（第三个 `coordinator` 由批 G 第四片供）。 */
  ports: Pick<AutomationFacebookRuntimePorts, 'rule' | 'consumption'>;
  /**
   * 消费运行时存储本体（批 G 第四片的协调器要它的**全取用面**，比上面那个窄口宽）。
   *
   * **刻意不让第四片自己再建一个**：另建会让认领 / 下发 / 结算落在两个实例上，
   * 而两边都不会报错 —— 只是同一个动作被两套租约各管一半。
   */
  consumptionStore:
    | { state: 'wired'; store: FacebookConsumptionModeRuntimeStore }
    | { state: 'unavailable'; reason: string };
  /** 关停：只关自己建的东西。**注入进来的共享池不在这里关**（会连带打死本进程其余存储）。 */
  close(): Promise<void>;
}

/**
 * 装配两套运行时存储。**`init()` 在这里 await 完**：让「表不在 / 探测失败」
 * 在装配期就变成具名 `unavailable`，而不是等到第一次真要写批次时才炸在热路径上。
 */
export async function createAutomationFacebookRuntime(
  options: AutomationFacebookRuntimeOptions,
): Promise<AutomationFacebookRuntimeAssembly> {
  const logger = options.logger ?? console;
  const target = options.executionTarget;

  if (!target) {
    // 具名缺席：调用方（每连接工厂）据此整组不接线，规则批次与消费模式报 blocker 而不是空跑。
    const reason = 'execution_target_missing';
    logger.warn(
      '[aidcp-automation] Facebook 运行时存储未构造：缺部署目标 —— ' +
        '这两张表是 target-scoped 的持久运行时，没有目标会往共享库写没有归属的行',
    );
    return {
      ports: {
        rule: { state: 'unavailable', reason },
        consumption: { state: 'unavailable', reason },
      },
      consumptionStore: { state: 'unavailable', reason },
      close: async () => undefined,
    };
  }

  const started: Array<{ close?: () => Promise<void> }> = [];

  const rule = await initialize(
    'facebook_rule_mode_runtime',
    () =>
      new FacebookRuleModeRuntimeStore({
        runtimePool: options.runtimePool,
        executionTarget: target,
        schemaProber: options.schemaProber,
      }),
    started,
    logger,
  );
  const consumption = await initialize(
    'facebook_consumption_mode_runtime',
    () =>
      new FacebookConsumptionModeRuntimeStore({
        runtimePool: options.runtimePool,
        executionTarget: target,
        schemaProber: options.schemaProber,
      }),
    started,
    logger,
  );

  return {
    ports: {
      rule:
        rule.state === 'wired'
          ? {
              state: 'wired',
              port: {
                applyConfirmedView: (input: unknown) =>
                  rule.store.applyConfirmedView(input as never),
                updateBatch: (batchId: unknown, patch: unknown) =>
                  rule.store.updateBatch(batchId as never, patch as never),
              },
            }
          : { state: 'unavailable', reason: rule.reason },
      consumption:
        consumption.state === 'wired'
          ? {
              state: 'wired',
              port: {
                applyConfirmedView: (input: unknown) =>
                  consumption.store.applyConfirmedView(input as never),
                claimAction: (input: unknown) =>
                  consumption.store.claimAction(input as never),
                markDispatched: (input: unknown) =>
                  consumption.store.markDispatched(input as never),
                settleAction: (input: unknown) =>
                  consumption.store.settleAction(input as never),
                supersedeAccount: (input) =>
                  consumption.store.supersedeAccount(input as never),
              },
            }
          : { state: 'unavailable', reason: consumption.reason },
    },
    consumptionStore:
      consumption.state === 'wired'
        ? { state: 'wired', store: consumption.store }
        : { state: 'unavailable', reason: consumption.reason },
    // 只关自己建的；注入的共享属主池由组装根统一关（批 D 那条坑：
    // 存储的 close() 内部是 pool.end()，在共享池上调它会连带打死本进程其余十几个存储）。
    close: async () => {
      for (const entry of started) {
        await entry.close?.().catch(() => undefined);
      }
    },
  };
}

/** 构造 + `init()`，失败一律具名（`init_failed:<原因>`），绝不吞成「本来就没这个能力」。 */
async function initialize<T extends { init(): Promise<void>; close?: () => Promise<void> }>(
  capability: string,
  build: () => T,
  started: Array<{ close?: () => Promise<void> }>,
  logger: Pick<Console, 'warn'>,
): Promise<{ state: 'wired'; store: T } | { state: 'unavailable'; reason: string }> {
  let store: T;
  try {
    store = build();
  } catch (error) {
    const reason = `construct_failed:${messageOf(error)}`;
    logger.warn(`[aidcp-automation] ${capability} 构造失败：${reason}`);
    return { state: 'unavailable', reason };
  }
  try {
    await store.init();
  } catch (error) {
    const reason = `init_failed:${messageOf(error)}`;
    logger.warn(
      `[aidcp-automation] ${capability} 初始化失败：${reason} —— ` +
        '对应能力整组不接线，调用方会报具名 blocker（绝不空跑冒充成功）',
    );
    await store.close?.().catch(() => undefined);
    return { state: 'unavailable', reason };
  }
  started.push(store);
  return { state: 'wired', store };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
