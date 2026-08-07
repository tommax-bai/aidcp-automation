/**
 * 每连接**角色调度器工厂**（change split-cloud-automation-production-runtime 批 E-2 步骤 3）。
 *
 * 它交付的正是 {@link AutomationDispatcherFactory} —— 批 E-1 的连接运行时注册表留下的那个必填口。
 * 不接它，连接建得起来、握手也过，但那条连接**永远不会开始浏览**，
 * 而这在日志上与「这个账号今天没排期」完全同形。
 *
 * ## 为什么这一批必须靠**本文件的**必填参数保护，而不能靠调度器的选项面
 *
 * `RoleDispatcherOptions` 有 200 余个字段、**几乎全是可选**（实测必填的只有 `llm` / `sendCommand`
 * 等寥寥数个）。漏传任何一项都不报错，只是对应能力安静地消失 —— 这正是 task 2.7 点名的
 * 「optional 参数是静默缺席的主要来源」的最大一处。
 *
 * 因此保护线画在**本文件的依赖面**上：批 G 才有的供给方一律做成**必填字段**或**能力二态**，
 * 让编译器逼批 G 面对；本文件内部再把它们铺进调度器那张可选选项面。
 *
 * ## 能力二态，不是可选字段
 *
 * 单体里有些能力本来就会整体缺席（人审端口按 env 闸、优质评论语料按 PG 可用性）。
 * 用 `undefined` 表示会让「**没接线**」与「**接了但今天不可用**」同形，而这两者的处置完全不同：
 * 前者是拆仓引入的缺陷、必须一发生就说话；后者是写明的回落。故一律 `wired` / `unavailable` 二态，
 * 且 `unavailable` MUST 带具名理由。
 *
 * ## 三条搬运时逐字保留的判据（改动前先读）
 *
 * 1. **规则批次的动作闸与浏览模式决策 MUST 共用同一个闭包**（`resolveFacebookOperationDecision`）。
 *    在 `actionGate` 里另算一遍是本 change 反复被咬的第二份实现形态 —— 两份漂开时不会报错，
 *    只是某一刻放行了本该拦住的动作。
 * 2. **规则模式那条降级（没配联系方式改发普通评论）放弃了两份已上线规格的 fail-closed 保证**，
 *    由运营显式裁定；且 `contactFallback` 的审批模式与主审批模式是**两个独立字段**
 *    —— 沿用同一个等于把「联系评论的免审」外溢到一条从未为该车道授权的普通评论正文。
 * 3. **自动路径绝不开评论快返**：快返固定回 `verification_ambiguous`，结构上永远报不出「已评论」，
 *    于是去重烧掉目标帖、冷却不落、配额不计 —— 真机验证过评论其实已上墙。
 */
import type { EffectiveContentSchedule } from 'aidcp-kernel/kernel/content-schedule-resolution.js';
import { actionModeEnabled } from 'aidcp-kernel/kernel/content-schedule-mode.js';
import type { HotLeadGateConfig } from 'aidcp-kernel/kernel/hot-lead-gate-config.js';
import type { EffectiveFacebookCommentConfig } from 'aidcp-kernel/kernel/facebook-comment-config-types.js';
import type { CommentCommandReceipt } from 'aidcp-kernel/kernel/feishu-card-contract.js';
import type {
  FacebookOperationPolicyBaseResolution,
  FacebookRuleOperationParameters,
  FacebookConsumptionOperationParameters,
} from 'aidcp-kernel/kernel/facebook-operation-policy-resolution.js';

import type { AutomationDispatcherFactory } from './automation-connection-runtime.js';
import type { DispatcherBuildContext } from './orchestrator/connection-runtime.js';
import type { PlatformId } from './platform/registry.js';
import {
  RoleDispatcher,
  type RoleDispatcherOptions,
} from './orchestrator/role-dispatcher.js';
import { decideFacebookBrowseMode } from './orchestrator/facebook-rule-mode.js';
// 版本偏斜闸比对的能力名 MUST 取自协议侧常量，MUST NOT 手抄字面量：这几个名字带 `_v1` 后缀，
// 抄漏后缀不报错、typecheck 也看不见（两侧都是裸 string），只是该能力对**所有**边缘恒判为「没有」，
// 于是新边端被静默降级成老边端。已实测发生过：切流后 Reel 自动关注 / 免导航身份读全线消失。
import {
  SEARCH_ACTIVITY_RECEIPT_CAPABILITY,
  IDENTITY_READ_CURRENT_CAPABILITY,
  IDENTITY_READ_SELF_PROFILE_CAPABILITY,
} from './comm/protocol.js';
import { FACEBOOK_REEL_FOLLOW_EDGE_CAPABILITY } from './platform/facebook-presented-video.js';

/** 浏览模式决策的返回形状：与单体逐字同源（`unsupported` / `blocked` 都带具名 blocker）。 */
export type FacebookOperationDecision =
  | { mode: 'unsupported'; blocker: string }
  | { mode: 'blocked'; blocker: string }
  | (ReturnType<typeof decideFacebookBrowseMode> & {
      primarySurface: FacebookOperationPolicyBaseResolution extends { ok: true }
        ? never
        : string;
      surfaceRevision: number;
      policyRevision: number;
      rulePolicy: FacebookRuleOperationParameters;
      consumptionPolicy: FacebookConsumptionOperationParameters;
      reelCadence?: Record<string, number>;
    });


/** 规则批次两个动作的终态口径（`joinOutcome` / `outcome` → 批次状态）。 */
export type RuleBatchActionState =
  | 'confirmed'
  | 'confirmed_without_contact'
  | 'already_satisfied'
  | 'ambiguous'
  | 'submitted_unknown'
  | 'risk_suppressed'
  | 'rejected'
  | 'not_started'
  | 'failed';

/**
 * 评论运行结果 → 规则批次终态。**逐字保留单体口径**，两处最容易被"简化"掉的是：
 * ① 降级发出的普通评论 MUST 投影成 `confirmed_without_contact`，
 *    投成 `confirmed` 会让后台与客户端认为联系方式已经发出去了；
 * ② `no_targets` / `no_strong_candidate` 是**没开始**，不是失败 ——
 *    记成失败会让重试与告警都走错分支。
 */
export function mapRuleBatchTerminalStates(result: {
  joinOutcome?: string;
  outcome?: string;
  contactFallbackApplied?: boolean;
  reason?: string;
}): { joinState: RuleBatchActionState; commentState: RuleBatchActionState; blocker?: string } {
  const joinState: RuleBatchActionState =
    result.joinOutcome === 'joined'
      ? 'confirmed'
      : result.joinOutcome === 'already_member'
        ? 'already_satisfied'
        : result.joinOutcome === 'pending' || result.joinOutcome === 'ambiguous_skip'
          ? 'ambiguous'
          : result.joinOutcome === 'risk_suppressed'
            ? 'risk_suppressed'
            : result.joinOutcome === 'gated_skip'
              ? 'rejected'
              : 'failed';
  const commentState: RuleBatchActionState =
    result.outcome === 'commented'
      ? result.contactFallbackApplied === true
        ? 'confirmed_without_contact'
        : 'confirmed'
      : result.outcome === 'verification_ambiguous' ||
          result.outcome === 'pending_group_approval'
        ? 'submitted_unknown'
        : result.outcome === 'quota_denied'
          ? 'risk_suppressed'
          : result.outcome === 'compose_skipped' || result.outcome === 'comment_rejected'
            ? 'rejected'
            : result.outcome === 'no_targets' || result.outcome === 'no_strong_candidate'
              ? 'not_started'
              : 'failed';
  return {
    joinState,
    commentState,
    ...(result.reason ? { blocker: result.reason } : {}),
  };
}

/** 能力二态：接了就带口，没接必须说明白为什么。 */
export type CapabilityState<T> =
  | { state: 'wired'; port: T }
  | { state: 'unavailable'; reason: string };

/**
 * 四个业务配置的取值口（批 E-2 步骤 1 / 2 已把判定收进 kernel）。
 *
 * 全是**同步热路径读**：调度器每 tick、每次动作前都会问。实现方按同步读镜像的快照现算，
 * MUST NOT 在这里改成跨进程 HTTP —— 那要动每个调用点的签名并给热路径加一跳网络。
 */
export interface AutomationBusinessConfigPorts {
  /** 单账号生效排期（无行 = 完全不自动，零回归）。 */
  effectiveScheduleFor(accountId: string): EffectiveContentSchedule;
  /** 账号生效活跃周历（override ?? global，唯一解析点）。 */
  effectiveActiveWeekMaskFor(accountId: string): string | null;
  /** 热帖过滤闸阈值（后台改完热加载即时生效）。 */
  hotLeadGateConfig(): HotLeadGateConfig;
  /**
   * 规则批次评论段的有效正文方案。
   * **副本陈旧时 MUST 报 `unavailable`**：评论段不执行，绝不猜成模板、也绝不猜成生成。
   */
  facebookCommentBodyScheme(
    accountId: string,
  ): 'template' | 'generated' | 'unavailable';
  /**
   * 账号 Facebook 评论配置的**生效值**（关键词 / 容器 / 正文模式 / 模板）。
   *
   * 与上面那条正文方案**MUST 出自同一次解析**：两者都在回答「这个账号今天按什么正文发」，
   * 各算一遍的现形方式不是报错，而是规则批次与覆盖评论对同一个账号给出不同正文模式。
   * 供给方（批 H）拿同步读镜像的账号行喂 kernel 那个纯判定，两条口取同一份结果。
   */
  facebookCommentConfigFor(accountId: string): EffectiveFacebookCommentConfig;
  /** Facebook 运营基线取用（拿不到时带具名 blocker，绝不回落默认基线）。 */
  facebookOperationBaseFor(
    accountId: string,
  ): FacebookOperationPolicyBaseResolution;
}

/** 评论域：整块属批 G，**必填**。缺它规则批次与热帖引流评论都不会发。 */
export interface AutomationCommentPorts {
  /**
   * 评论调度器（手动 / 定向两条触发口）。
   *
   * 回执类型**取契约那一份**（`CommentCommandReceipt`），不在这里手抄一个窄形状：
   * 抄窄了不会报错，只会让调用点读不到本该有的字段（本口原先抄成三字段，
   * 漏掉的 `level` 恰是「不染绿」那条判据要用的）。
   */
  scheduler: CapabilityState<{
    triggerManual(
      accountId: string,
      options: Record<string, unknown>,
    ): Promise<CommentCommandReceipt>;
    triggerTargeted(
      accountId: string,
      target: { noteId: string; title: string },
      options: Record<string, unknown>,
    ): Promise<CommentCommandReceipt & { reason?: string }>;
  }>;
  /**
   * 逐条人审端口。单体里由 env 闸控制**整体是否注入**，未开启时评论一律诚实跳过、不发。
   * 故这里是二态而非可选：`unavailable` 与「接了但今天关着」必须分得开。
   */
  approval: CapabilityState<RoleDispatcherOptions['commentApproval']>;
  /**
   * 免审评论的旁路通知（不参与授权，但发出去没人知道等于没有可观测性）。
   *
   * **签名刻意收两个参数**：来源由调用点按 `approvalSource` 现推，
   * 供给方 MUST NOT 把来源写死 —— 写死会让 mandatory 人设免审与账号级免审
   * 发出同一种卡，运营再也分不出这条评论是被哪条授权放行的。
   */
  notifyAutoApproved(
    input: Parameters<NonNullable<RoleDispatcherOptions['commentAutoApproveNotify']>>[0],
    source: 'mandatory_persona' | 'account_global' | 'comment_scheduler',
  ): Promise<void>;
  /** 有效审批模式解析（账号级 + 人设 mandatory 两条来源）。 */
  resolveApprovalMode: NonNullable<RoleDispatcherOptions['resolveCommentApprovalMode']>;
  /** 强制评论结果通知。 */
  notifyMandatoryOutcome: NonNullable<RoleDispatcherOptions['notifyMandatoryCommentOutcome']>;
  /** 热帖引流评论的统一安全闸（子上限 / 尝试审计 / record 时机三件一处收口）。 */
  fireAutoContactComment: NonNullable<RoleDispatcherOptions['fireAutoContactComment']>;
  /** 优质评论语料：单体里 store 缺失即不接线，故为二态。 */
  valuableCorpus: CapabilityState<{
    archive(input: unknown): Promise<void>;
    retrieveByTopics(topics: string[], limit: number): Promise<unknown>;
  }>;
}

/** Facebook 规则 / 消费两套运行时：整块属批 G，**必填**（二态）。 */
export interface AutomationFacebookRuntimePorts {
  rule: CapabilityState<{
    applyConfirmedView(input: unknown): unknown;
    updateBatch(batchId: unknown, patch: unknown): unknown;
  }>;
  consumption: CapabilityState<{
    applyConfirmedView(input: unknown): unknown;
    claimAction(input: unknown): unknown;
    markDispatched(input: unknown): unknown;
    settleAction(input: unknown): unknown;
    supersedeAccount(input: {
      accountId: string;
      keepPolicyRevision: unknown;
      reason: string;
    }): Promise<unknown>;
  }>;
  /** 消费模式协调器。缺席时单体是**具名 throw**，这里照搬那个形状。 */
  coordinator: CapabilityState<{ trigger(action: unknown): Promise<void> }>;
}

export interface AutomationDispatcherDeps {
  /** 配置副本停手闸（批 C）。 */
  configMirrorGate: NonNullable<RoleDispatcherOptions['configMirrorGate']>;
  /** 模型出口（A-1）。 */
  llm: RoleDispatcherOptions['llm'];
  /** 人设取值口。**MUST 是取值口而不是快照**——构造期检查已在，漏传会当场抛。 */
  getSoul: NonNullable<RoleDispatcherOptions['getSoul']>;
  /** 节奏兜底配置（批 D）。 */
  pacingFloors: RoleDispatcherOptions['pacingFloors'];
  /** 边缘任务租约客户端（批 D）。 */
  edgeTaskLeases: RoleDispatcherOptions['edgeTaskLeases'];
  /** 单场 / 续场配置（本仓自有）。 */
  sessionLimitProvider: RoleDispatcherOptions['sessionLimitProvider'];
  resumeConfigProvider: RoleDispatcherOptions['resumeConfigProvider'];
  /** 内容侧三个端口（已按模式取好：automation 进程下是 content 的 HTTP 客户端）。 */
  conceptStore: RoleDispatcherOptions['conceptStore'];
  curatedStore: RoleDispatcherOptions['curatedStore'];
  textCardTranscriber: RoleDispatcherOptions['textCardTranscriber'];
  /** content 层角色工厂表（0.7 已把四个角色改判 automation，本仓自建）。 */
  roleFactories: RoleDispatcherOptions['roleFactories'];
  /** 人设绑定三态（同步读镜像）。 */
  personaBinding: NonNullable<RoleDispatcherOptions['personaBinding']>;
  /** 昵称读写（账号主数据窄口）。 */
  getNickname: NonNullable<RoleDispatcherOptions['getNickname']>;
  setNickname: NonNullable<RoleDispatcherOptions['setNickname']>;
  /** 全局调度开关（进程内布尔，刻意无持久台账）。 */
  isDispatchActive: NonNullable<RoleDispatcherOptions['isDispatchActive']>;
  /** 会话被拒时的人设引导出口。 */
  onSessionRejected: NonNullable<RoleDispatcherOptions['onSessionRejected']>;
  /**
   * 通知巡视投递（结构化通知，**按账号路由到团队群**）。
   *
   * **签名刻意比调度器那一侧多一个 `accountId`**：单体里这个闭包是在每连接的
   * `buildDispatcher` 里现造的，路由目标闭包捕获的就是那条连接的账号。
   * 把它当成进程级端口直接透传，账号就丢了 —— 后果不是报错，是**所有账号的入站消息
   * 全部落到默认群**，运营再也分不出哪条是谁的（与免审通知来源那次是同一种丢法）。
   */
  notifyComments(
    items: Parameters<NonNullable<RoleDispatcherOptions['notifyComments']>>[0],
    accountId: string,
  ): Promise<void>;
  /** 硬暂停闸（验证码 / 人工接管期连帧都不发）。 */
  isHardPaused: NonNullable<RoleDispatcherOptions['isHardPaused']>;
  /** 定向下发（按 edgeId，**不广播**）。 */
  sendCommand: RoleDispatcherOptions['sendCommand'] extends (
    command: infer C,
  ) => void
    ? (command: C, edgeId: string | undefined, accountId: string, platform?: PlatformId) => void
    : never;
  /** 每账号互动去重守卫（E-1 注册表按账号取）。 */
  interactionGuardFor: (
    accountId: string,
  ) => RoleDispatcherOptions['interactionGuard'];
  /** 动作冷却兜底闸（E-1，**单例共享**，内部按账号分桶）。 */
  cooldownGate: RoleDispatcherOptions['cooldownGate'];
  /** 引流线索「已评过」去重（复用风控互动账本）。 */
  hasCommentedForLead: NonNullable<RoleDispatcherOptions['hasCommentedForLead']>;
  /** 通知联系人名册：每连接握手订阅一次。缺席即不订阅（单体同形）。 */
  notificationContacts?: {
    appendEvents(accountId: string, items: unknown[]): Promise<unknown>;
  };
  /** 四个业务配置取值口（步骤 1 / 2）。 */
  businessConfig: AutomationBusinessConfigPorts;
  /** 评论域（批 G）。 */
  comment: AutomationCommentPorts;
  /** Facebook 两套运行时（批 G）。 */
  facebookRuntime: AutomationFacebookRuntimePorts;
  /** FB 每日在线时长上限；缺省交由调度器用自己的默认。 */
  facebookDailyOnlineMinutes?: number;
  /** 评论子链三个超时；缺省交由唯一默认事实源兜底。 */
  commentTimeouts?: {
    corpusLookupMs?: number;
    llmMs?: number;
    sublineMs?: number;
  };
  logger?: Pick<Console, 'log' | 'warn'>;
  /**
   * 调度器构造缝。**这个缝存在的唯一理由是让「选项面到底铺成了什么」可断言** ——
   * 调度器 200 余个字段几乎全可选，装配错了不报错，只有把组装好的选项对象抓出来看才验得了。
   * 生产路径恒用默认实现。**别当多余删掉。**
   */
  createDispatcher?: (options: RoleDispatcherOptions) => RoleDispatcher;
}

/**
 * 造工厂。返回值就是批 E-1 那个必填口，交给连接运行时注册表即可。
 *
 * 注意本函数**不起任何定时器、不建连接**：它只是把依赖铺进每连接的调度器构造。
 * 与批 B / D / F 一致 —— 写成可单测的工厂，不写进 `main()`。
 */
export function createAutomationDispatcherFactory(
  deps: AutomationDispatcherDeps,
): AutomationDispatcherFactory {
  const logger = deps.logger ?? console;

  return (ctx: DispatcherBuildContext): RoleDispatcher => {
    // 通知联系人名册：订阅该连接私有总线，按该连接真实账号追加进事件流水。
    // 每连接握手调一次 → 一连接订阅一次（避免重复订阅重复记录）。
    // 记录失败只吞 + 准确日志：绝不冒充飞书失败、绝不阻塞巡视；append 幂等，下轮安全重试。
    const contacts = deps.notificationContacts;
    if (contacts) {
      ctx.bus.on('notification.items.arrived', (payload) => {
        const items = (payload as { items?: unknown[] } | undefined)?.items ?? [];
        if (!items.length) return;
        contacts.appendEvents(ctx.accountId, items).catch((error: unknown) =>
          logger.warn(
            `[notification-contacts] 记录失败 account=${ctx.accountId}（巡视照常，下轮幂等重试）: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      });
    }

    /**
     * 浏览模式决策。**这一个闭包同时喂 `facebookRuleModeDecision` 与规则批次的 `actionGate`**
     * —— 按引用共用是硬要求，另算一遍就是第二份实现。
     */
    const resolveFacebookOperationDecision = (
      accountId: string,
    ): FacebookOperationDecision => {
      if (ctx.platform !== 'facebook') {
        return { mode: 'unsupported', blocker: 'rule_mode_unsupported' };
      }
      // 副本陈旧时**具名拒绝**，MUST NOT 拿陈旧基线继续跑。
      if (deps.configMirrorGate.isStale('content_schedule')) {
        deps.configMirrorGate.noteStaleRefusal(
          'content_schedule',
          `facebook_operation_policy:${accountId}`,
        );
        return { mode: 'blocked', blocker: 'facebook_operation_policy_stale' };
      }
      const policy = deps.businessConfig.facebookOperationBaseFor(accountId);
      if (!policy.ok) return { mode: 'blocked', blocker: policy.blocker };
      const decision = decideFacebookBrowseMode({
        platform: ctx.platform,
        ruleEnabled: false,
        operationMode: policy.baseMode,
        personaBinding: deps.personaBinding(accountId),
        slowStart: ctx.controller.slowStartView(),
      });
      const reelCadence =
        decision.mode === 'persona'
          ? policy.reels.persona
          : decision.mode === 'slow_start'
            ? policy.reels.slowStart
            : decision.mode === 'facebook_rule'
              ? policy.reels.rule
              : decision.mode === 'consumption'
                ? policy.reels.consumption
                : undefined;
      return {
        ...decision,
        primarySurface: policy.primarySurface,
        surfaceRevision: policy.surfaceRevision,
        policyRevision: policy.policyRevision,
        rulePolicy: policy.rule,
        consumptionPolicy: policy.consumption,
        ...(reelCadence ? { reelCadence: { ...reelCadence } } : {}),
      } as FacebookOperationDecision;
    };

    const capabilities = ctx.capabilities ?? [];
    const rule = deps.facebookRuntime.rule;
    const consumption = deps.facebookRuntime.consumption;
    const coordinator = deps.facebookRuntime.coordinator;
    const scheduler = deps.comment.scheduler;
    const corpus = deps.comment.valuableCorpus;
    const approval = deps.comment.approval;
    const timeouts = deps.commentTimeouts ?? {};

    const options = {
      configMirrorGate: deps.configMirrorGate,
      getSoul: deps.getSoul,
      llm: deps.llm,
      // 私有事件通道（连接间互不串味）；其上事件经 tee 汇入全局观测总线。
      eventBus: ctx.bus,
      accountPlatform: ctx.platform,
      // 版本偏斜闸：本连接握手声明的能力位快照（重连按新连接重建、天然刷新）。
      hasInlineTargeting: () => capabilities.includes('inline_targeting'),
      hasReelFollow: () => capabilities.includes(FACEBOOK_REEL_FOLLOW_EDGE_CAPABILITY),
      hasSearchActivityReceipt: () => capabilities.includes(SEARCH_ACTIVITY_RECEIPT_CAPABILITY),
      hasIdentityReadCurrent: () => capabilities.includes(IDENTITY_READ_CURRENT_CAPABILITY),
      hasIdentityReadSelfProfile: () =>
        capabilities.includes(IDENTITY_READ_SELF_PROFILE_CAPABILITY),
      ...(deps.facebookDailyOnlineMinutes !== undefined
        ? { facebookDailyOnlineMinutes: deps.facebookDailyOnlineMinutes }
        : {}),
      // 指令级节奏：喂该账号实时风控状态，驱动 dwellMs / thinkMs 的 tempo。
      getRiskStatus: () => ctx.controller.getState().status,
      // 受限的自动恢复时刻（change restricted-policy-global-config）：续场闸裁决据此携带 resumeAt，
      // 与 view 拒绝的 retryAfterMs、恢复扫描器判窗同源（controller 内的同一推导）。
      riskRecoveryAt: () => ctx.controller.recoveryAt(),
      getQuotaLevel: () => ctx.controller.getState().quotaLevel,
      pacingFloors: deps.pacingFloors,
      // 互动 / 浏览前风控闸：按该连接真实账号的 controller 判定，被拒诚实跳过。
      canInteract: (action: Parameters<typeof ctx.controller.canDo>[0]) =>
        ctx.controller.canDo(action),
      explainInteract: (action: Parameters<typeof ctx.controller.explain>[0]) =>
        ctx.controller.explain(action),
      explainSearch: () => ctx.controller.explain('search'),
      explainView: () => ctx.controller.explain('view'),
      facebookRuleModeDecision: resolveFacebookOperationDecision,
      facebookRuleCommentBodyScheme: (accountId: string) =>
        deps.businessConfig.facebookCommentBodyScheme(accountId),
      ...(rule.state === 'wired'
        ? {
            applyFacebookRuleView: (input: unknown) =>
              rule.port.applyConfirmedView(input),
            updateFacebookRuleBatch: (batchId: unknown, patch: unknown) =>
              rule.port.updateBatch(batchId, patch),
            explainRuleJoin: () => ctx.controller.explain('join_group'),
            triggerFacebookRuleJoinContact: async (accountId: string) => {
              // 评论调度器没接 ⇒ **具名不启动**，绝不报「已触发」。
              if (scheduler.state !== 'wired') {
                return { started: false, reason: scheduler.reason };
              }
              let resolveTerminal!: (value: ReturnType<typeof mapRuleBatchTerminalStates>) => void;
              const onTerminal = new Promise<ReturnType<typeof mapRuleBatchTerminalStates>>(
                (resolve) => {
                  resolveTerminal = resolve;
                },
              );
              const receipt = await scheduler.port.triggerManual(accountId, {
                ...ruleBatchContactCommentOptions({
                  schedule: deps.businessConfig.effectiveScheduleFor(accountId),
                  // **与浏览模式决策共用同一个闭包**（本文件 §3 判据①）：
                  // 在这里另算一遍就是第二份实现，两份漂开时不报错、只是某一刻放行了本该拦住的动作。
                  actionGate: (action: string) => {
                    const decision = resolveFacebookOperationDecision(accountId);
                    if (decision.mode !== 'facebook_rule') {
                      return { allowed: false, reason: decision.blocker ?? decision.mode };
                    }
                    const risk = ctx.controller.explain(
                      action as Parameters<typeof ctx.controller.explain>[0],
                    );
                    return risk.allowed
                      ? { allowed: true }
                      : { allowed: false, reason: risk.reason ?? `${action}_risk_suppressed` };
                  },
                }),
                onResult: (observation: unknown) => {
                  resolveTerminal(
                    mapRuleBatchTerminalStates(
                      observation as Parameters<typeof mapRuleBatchTerminalStates>[0],
                    ),
                  );
                },
              });
              return receipt.ok
                ? { started: true, onTerminal }
                : { started: false, reason: receipt.code ?? receipt.message };
            },
          }
        : {}),
      ...(consumption.state === 'wired'
        ? {
            applyFacebookConsumptionView: (input: unknown) =>
              consumption.port.applyConfirmedView(input),
            claimFacebookConsumptionAction: (input: unknown) =>
              consumption.port.claimAction(input),
            markFacebookConsumptionActionDispatched: (input: unknown) =>
              consumption.port.markDispatched(input),
            settleFacebookConsumptionAction: (input: unknown) =>
              consumption.port.settleAction(input),
            triggerFacebookConsumptionAction: async (action: unknown) => {
              // 缺协调器时**具名 throw**（单体逐字同形）：静默 no-op 会让消费模式看着在跑、其实一步没动。
              if (coordinator.state !== 'wired') {
                throw new Error('facebook_consumption_coordinator_unavailable');
              }
              await coordinator.port.trigger(action);
            },
            supersedeFacebookOperationRuntime: async (input: {
              accountId: string;
              policyRevision: unknown;
            }) => {
              await consumption.port.supersedeAccount({
                accountId: input.accountId,
                keepPolicyRevision: input.policyRevision,
                reason: 'policy_superseded',
              });
            },
          }
        : {}),
      // 人审端口：env 闸未开时单体整体不注入（评论一律诚实跳过、不发）。
      ...(approval.state === 'wired' ? { commentApproval: approval.port } : {}),
      // **来源在这里现推**（与单体逐字同源）：mandatory 人设免审与账号级免审是两种卡。
      // 把来源写死会让运营再也分不出这条评论是被哪条授权放行的。
      commentAutoApproveNotify: (
        input: Parameters<NonNullable<RoleDispatcherOptions['commentAutoApproveNotify']>>[0],
      ) =>
        deps.comment.notifyAutoApproved(
          input,
          (input as { approvalSource?: string }).approvalSource === 'mandatory_persona'
            ? 'mandatory_persona'
            : 'account_global',
        ),
      resolveCommentApprovalMode: deps.comment.resolveApprovalMode,
      notifyMandatoryCommentOutcome: deps.comment.notifyMandatoryOutcome,
      ...(timeouts.corpusLookupMs !== undefined
        ? { commentCorpusLookupTimeoutMs: timeouts.corpusLookupMs }
        : {}),
      ...(timeouts.llmMs !== undefined ? { commentLlmTimeoutMs: timeouts.llmMs } : {}),
      ...(timeouts.sublineMs !== undefined
        ? { commentSublineTimeoutMs: timeouts.sublineMs }
        : {}),
      // 评论 / 评论赞当日配额预闸：按该账号 controller 当日剩余。
      getCommentDailyRemaining: () => ctx.controller.dailyRemaining('comment'),
      getCommentLikeDailyRemaining: () => ctx.controller.dailyRemaining('comment_like'),
      ...(corpus.state === 'wired'
        ? {
            archiveValuableComment: async (input: unknown) => {
              // 只落写作语料；「是否进精选」的准入判定已移交模型评估角色，此处绝不直纳。
              await corpus.port.archive(input);
            },
            getCorpusReferences: (topics: string[]) =>
              corpus.port.retrieveByTopics(topics, 3),
          }
        : {}),
      conceptStore: deps.conceptStore,
      curatedStore: deps.curatedStore,
      textCardTranscriber: deps.textCardTranscriber,
      roleFactories: deps.roleFactories,
      hotLeadGateConfig: () => deps.businessConfig.hotLeadGateConfig(),
      isAutoContactEnabled: async (accountId: string) =>
        actionModeEnabled(
          deps.businessConfig.effectiveScheduleFor(accountId).contactCommentMode,
        ),
      hasCommentedForLead: deps.hasCommentedForLead,
      fireAutoContactComment: deps.comment.fireAutoContactComment,
      isHardPaused: deps.isHardPaused,
      // 路由账号在这里现推（与单体逐字同源）：供给方拿不到「是哪条连接」，写死就等于全投默认群。
      notifyComments: (
        items: Parameters<NonNullable<RoleDispatcherOptions['notifyComments']>>[0],
      ) => deps.notifyComments(items, ctx.accountId),
      // 下行指令只发回**发起该决策的连接**（按 edgeId 定向，不广播 → 不串号）。
      sendCommand: (command: unknown) =>
        deps.sendCommand(command as never, ctx.edgeId, ctx.accountId, ctx.platform),
      edgeTaskLeases: deps.edgeTaskLeases,
      personaBinding: deps.personaBinding,
      onSessionRejected: (accountId: string, reason: unknown) =>
        deps.onSessionRejected(accountId, reason as never),
      isDispatchActive: deps.isDispatchActive,
      // 同账号并行互动去重：按账号取，同账号 N 条连接共用。
      interactionGuard: deps.interactionGuardFor(ctx.accountId),
      // 冷却兜底闸：**单例共享**，内部按账号分桶（每连接一个会让同账号多连接各自不受约束）。
      cooldownGate: deps.cooldownGate,
      sessionLimitProvider: deps.sessionLimitProvider,
      // 活跃周历：开场 / 续场 / 唤醒 / 跨界与冷待机裁决统一从同一解析口现读。
      activeWeekMaskFor: (accountId: string) =>
        deps.businessConfig.effectiveActiveWeekMaskFor(accountId),
      resumeConfigProvider: deps.resumeConfigProvider,
      getNickname: deps.getNickname,
      setNickname: deps.setNickname,
    } as unknown as RoleDispatcherOptions;

    return (deps.createDispatcher ?? ((o) => new RoleDispatcher(o)))(options);
  };
}

/**
 * 规则批次「加群 + 联系评论」的触发闭包（批 G 接线时喂进 {@link AutomationCommentPorts}）。
 *
 * 单独导出而不是埋在工厂里，因为它承载 §3 那两条判据里最容易被"顺手统一"掉的部分，
 * 需要独立可单测：**主审批模式与降级审批模式是两个独立字段**，
 * 且**自动路径绝不开快返**。
 */
export function ruleBatchContactCommentOptions(input: {
  schedule: EffectiveContentSchedule;
  actionGate: (action: string) => { allowed: boolean; reason?: string };
}): Record<string, unknown> {
  const approvalMode =
    input.schedule.contactCommentMode === 'auto_approve' ? 'auto_approve' : 'review';
  // 降级产出走**普通评论**车道的审批配置：两者是两个独立字段，
  // 运营可以只给联系评论免审；沿用它等于把免审外溢到一条从未为该车道授权的正文。
  const fallbackApprovalMode =
    input.schedule.commentMode === 'auto_approve' ? 'auto_approve' : 'review';
  return {
    injectContact: true,
    joinFirst: true,
    priority: 'automatic',
    approvalMode,
    contactFallback: { kind: 'plain', approvalMode: fallbackApprovalMode },
    manualOverride: false,
    force: false,
    // 绝不给自动路径开快返：快返固定回 verification_ambiguous，
    // 结构上永远报不出「已评论」⇒ 去重烧掉目标帖、冷却不落、当日配额不计。
    source: 'facebook_rule_batch',
    actionGate: input.actionGate,
  };
}
