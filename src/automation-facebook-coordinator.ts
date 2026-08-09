/**
 * Facebook 消费模式协调器的装配（change split-cloud-automation-production-runtime 批 G 第四片）。
 *
 * 它填的是批 E-2 步骤 3 那个工厂留下的最后一个口：{@link AutomationFacebookRuntimePorts} 的
 * `coordinator`。填完这一个，批 G 的 10 个口全满。
 *
 * ## 那条「要补跨进程口」的判断已作废
 *
 * 前几片一直记着：协调器要的运营策略决策是接口域的异步口（含慢启动解析），
 * 与步骤 2 给自动化侧的同步基线口不是同一个东西，所以得再补一条跨进程口。
 * **2026-08-02 实读推翻**：它要的两样输入本进程都已具备 ——
 * 基线走同步读镜像那条流（步骤 2 已落），慢启动走**本进程自己的**风控投影
 * （而自动化进程本来就是风控的单写者）。缺的只是把两样拼成最终模式的那一小段纯判断，
 * 已析出到公共契约层，两个进程调同一份。
 *
 * ⇒ **本片不补任何跨进程通道**。真去补了，等于让自动化进程绕一圈去问接口进程要「慢启动」，
 * 而那个事实源本来就在自己这一侧。
 *
 * ## 四条不许降级的红线
 *
 * 1. **副本陈旧时具名拒绝，MUST NOT 拿陈旧基线继续跑**。与每连接工厂那条浏览模式决策同口径，
 *    且拒绝要记进停手闸的账（否则「因为陈旧没跑」在日志上与「今天没动作」同形）。
 * 2. **决策前先物化风控控制器**。协调器随后那道同步终闸按缓存里的控制器判，
 *    没先物化就恒 `risk_controller_unavailable` —— 那不是拒绝，是永远不发。
 * 3. **群评论时序策略拿不到就让协调器自己报 blocker**，MUST NOT 在这里塞一份默认时长。
 *    协调器对 `null` 有写明的处置（具名 `group_comment_policy_unavailable`），
 *    塞默认值等于把「不知道该等多久」偷换成「已经等够了」。
 * 4. **恢复扫描的定时器不在构造期起**。与批 B/C/D/E/F/G 各片一致：本片只交付一个可调用的
 *    恢复入口，什么时候起、多久一次由进程入口（批 H）决定。构造期起定时器会让单测与
 *    组装期各自跑起一轮真实平台动作。
 */
import {
  resolveFacebookOperationAccountDecision,
  resolveFacebookSlowStartFromView,
  type FacebookOperationPolicyBaseResolution,
  type FacebookSlowStartViewFacts,
} from 'aidcp-kernel/kernel/facebook-operation-policy-resolution.js';
import type { ConfigMirrorKey } from 'aidcp-kernel/kernel/config-mirror-bump-types.js';

import type { AutomationFacebookRuntimePorts } from './automation-connection-dispatcher.js';
import {
  FacebookConsumptionModeCoordinator,
  createStrictFacebookConsumptionGroupSelector,
  type FacebookConsumptionCoordinatorDeps,
  type FacebookConsumptionCoordinatorRuntimePort,
  type FacebookConsumptionGroupCommentPolicyView,
  type FacebookConsumptionRecoveryResult,
} from './orchestrator/facebook-consumption-mode-coordinator.js';

/** 风控注册表的最小取用面：物化控制器 + 读它的慢启动投影与评论闸。 */
export interface AutomationCoordinatorRiskPort {
  /**
   * 物化该账号的控制器并**缓存**，供随后那道同步终闸取（红线 2）。
   * 返回的就是缓存里的那一个实例，不是副本。
   */
  resolveController(accountId: string): Promise<{
    slowStartView(): FacebookSlowStartViewFacts;
  }>;
  /** 同步取已物化的控制器；没物化过一律 `null`（**绝不在这里顺手建一个**）。 */
  resolvedController(accountId: string): {
    explain(action: 'comment'): { allowed: boolean; reason?: string };
  } | null;
}

export interface AutomationFacebookCoordinatorOptions {
  /** 批 G 第一片建好的消费运行时存储。**二态**：没建成整片不构造。 */
  consumptionStore:
    | { state: 'wired'; store: FacebookConsumptionCoordinatorRuntimePort }
    | { state: 'unavailable'; reason: string };
  /** 批 G 第三片建好的两个执行器。 */
  executors: {
    join: FacebookConsumptionCoordinatorDeps['joinExecutor'];
    comment: FacebookConsumptionCoordinatorDeps['commentExecutor'];
  };
  /**
   * 群成员账本（automation 属主，**与第三片同一个实例**）。
   * 四个方法的形状一律取协调器与历史群选择器自己那两份声明，不在这里手抄。
   */
  memberships: Parameters<
    typeof createStrictFacebookConsumptionGroupSelector
  >[0]['memberships'] & {
    findMembership: FacebookConsumptionCoordinatorDeps['readGroupMembership'];
    recordCoverageCommented: FacebookConsumptionCoordinatorDeps['recordConfirmedComment'];
  };
  /**
   * 群评论时序策略。**二态**：拿不到就让协调器自己报 blocker（红线 3）。
   * 与第三片是**同一个口**——两片各拿一份会让「预热多久」在同一进程里有两个答案。
   */
  groupCommentPolicy:
    | { state: 'wired'; port: { get(): FacebookConsumptionGroupCommentPolicyView | null } }
    | { state: 'unavailable'; reason: string };
  /** 配置副本停手闸（批 C）。陈旧即具名拒绝，且拒绝要记账（红线 1）。 */
  configMirrorGate: {
    isStale(key: ConfigMirrorKey): boolean;
    noteStaleRefusal(key: ConfigMirrorKey, context?: string): void;
  };
  /**
   * Facebook 运营基线取用（步骤 2 已落的同步读镜像口）。
   * 本片**不自己解析环境绑定**——那一段住在镜像里，在这里再写一遍就是第二份实现。
   */
  facebookOperationBaseFor(accountId: string): FacebookOperationPolicyBaseResolution;
  risk: AutomationCoordinatorRiskPort;
  /**
   * 任务收敛后的浏览恢复通道（单体 `2923aab` 的那根线）。协调器侧该依赖是可选的——
   * 漏接不报错、恢复能力静默消失（dev 2026-08-09 加群后整场停在群页面即此因），
   * 所以在装配缝上把它定为**必填**：新装配点不接线就编译不过。
   */
  redriveBrowse: NonNullable<FacebookConsumptionCoordinatorDeps['redriveBrowse']>;
  ownerId?: string;
  actionLeaseMs?: number;
  logger?: Pick<Console, 'warn' | 'log'>;
  /** 构造缝（与其余各片同理由：协调器 14 个依赖，装配错了不报错）。 */
  createCoordinator?: (
    deps: FacebookConsumptionCoordinatorDeps,
  ) => FacebookConsumptionModeCoordinator;
}

export interface AutomationFacebookCoordinatorAssembly {
  /** 批 G 的第 10 个口。 */
  port: AutomationFacebookRuntimePorts['coordinator'];
  /**
   * 在途动作恢复扫描。**构造期不跑、不起定时器**（红线 4）——
   * 进程入口在就绪闸之后自己决定什么时候起、多久一次。
   * 协调器整片没接线时它是一个具名 no-op，不是静默成功。
   */
  recoverActiveActions(): Promise<FacebookConsumptionRecoveryResult | null>;
}

export function createAutomationFacebookCoordinator(
  options: AutomationFacebookCoordinatorOptions,
): AutomationFacebookCoordinatorAssembly {
  const logger = options.logger ?? console;
  const runtime = options.consumptionStore;

  if (runtime.state !== 'wired') {
    logger.warn(
      '[aidcp-automation] Facebook 消费模式协调器未构造：消费运行时存储不可用 —— '
        + `${runtime.reason}（消费模式的认领 / 下发 / 结算全断，调用点会具名 throw 而不是空跑）`,
    );
    return {
      port: { state: 'unavailable', reason: runtime.reason },
      recoverActiveActions: async () => null,
    };
  }

  // 时序策略的**唯一取用点**：历史群选择与协调器自身按引用共用它。
  const commentPolicy = {
    get: (): FacebookConsumptionGroupCommentPolicyView | null =>
      options.groupCommentPolicy.state === 'wired'
        ? options.groupCommentPolicy.port.get()
        : null,
  };

  const selectHistoricalGroup = createStrictFacebookConsumptionGroupSelector({
    commentPolicy,
    memberships: options.memberships,
  });

  const coordinator = (options.createCoordinator ??
    ((deps) => new FacebookConsumptionModeCoordinator(deps)))({
    runtimeStore: runtime.store,
    joinExecutor: options.executors.join,
    commentExecutor: options.executors.comment,
    selectHistoricalGroup,
    resolveOperationPolicy: async (accountId: string) => {
      // 红线 1：陈旧即具名拒绝，且把拒绝记进停手闸的账。
      if (options.configMirrorGate.isStale('content_schedule')) {
        options.configMirrorGate.noteStaleRefusal(
          'content_schedule',
          `facebook_consumption_policy:${accountId}`,
        );
        return {
          effectiveMode: 'blocked' as const,
          policyRevision: null,
          blocker: 'facebook_operation_policy_stale',
        };
      }
      // 红线 2：先物化控制器 —— 随后那道同步终闸按缓存判，没物化就恒不可用。
      // 顺带它就是慢启动那一半的来源，两件事一次调用解决。
      const controller = await options.risk.resolveController(accountId);
      const decision = resolveFacebookOperationAccountDecision({
        base: options.facebookOperationBaseFor(accountId),
        slowStart: resolveFacebookSlowStartFromView(controller.slowStartView()),
      });
      return {
        effectiveMode: decision.mode,
        policyRevision: decision.policyRevision,
        ...(decision.blocker ? { blocker: decision.blocker } : {}),
      };
    },
    commentActionGate: (accountId: string) => {
      const controller = options.risk.resolvedController(accountId);
      // 没物化过 = 上面那步没跑到（或跑失败了）。**在这里补建一个是错的**：
      // 那会绕过前面整条决策链，让一个本该 blocked 的账号在终闸这里被放行。
      if (!controller) {
        return { allowed: false, reason: 'risk_controller_unavailable' };
      }
      const decision = controller.explain('comment');
      return decision.allowed
        ? { allowed: true }
        : { allowed: false, reason: decision.reason ?? 'comment_risk_suppressed' };
    },
    resolveGroupCommentPolicy: commentPolicy.get,
    readGroupMembership: (accountId: string, groupUrl: string) =>
      options.memberships.findMembership(accountId, groupUrl),
    recordConfirmedComment: (accountId: string, groupUrl: string, opts) =>
      options.memberships.recordCoverageCommented(accountId, groupUrl, opts),
    redriveBrowse: options.redriveBrowse,
    ...(options.ownerId !== undefined ? { ownerId: options.ownerId } : {}),
    ...(options.actionLeaseMs !== undefined ? { actionLeaseMs: options.actionLeaseMs } : {}),
    logger,
  } as FacebookConsumptionCoordinatorDeps);

  if (options.groupCommentPolicy.state !== 'wired') {
    logger.warn(
      '[aidcp-automation] 消费模式评论段不会推进：群评论时序策略未接线 —— '
        + `${options.groupCommentPolicy.reason}（协调器会报具名 group_comment_policy_unavailable，`
        + '本片不塞默认时长顶替）',
    );
  }

  return {
    port: {
      state: 'wired',
      port: {
        trigger: async (action: unknown) => {
          await coordinator.trigger(action as never);
        },
      },
    },
    // 红线 4：只交付入口，定时器由进程入口起。
    recoverActiveActions: () => coordinator.recoverActiveActions(),
  };
}
