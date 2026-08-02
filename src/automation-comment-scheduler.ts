/**
 * 评论调度器 + 加群调度器 + 联系评论统一安全闸的装配（change
 * split-cloud-automation-production-runtime 批 G 第三片）。
 *
 * 它填的是批 E-2 步骤 3 那个工厂留下的 {@link AutomationCommentPorts} 里最后两个：
 * `scheduler`（手动 / 定向两条触发口）与 `fireAutoContactComment`（热帖引流评论的统一安全闸）。
 * **消费协调器不在本片** —— 它把这两个调度器当执行器用，所以必须排在本片之后。
 *
 * ## 为什么这两个必须同片
 *
 * 联系评论安全闸的触发闭包**就是**评论调度器的定向触发口；把它们切开会造出一个
 * 「闸建好了但没有可触发的东西」的中间态，而那个中间态在行为上与「今天没有热帖」完全同形。
 * 加群调度器同理：评论调度器的两条加群入口（`--join` / `--join=<url>`）直接指向它，
 * 单体里靠 TDZ-safe 闭包晚绑定，本片按同一形状保留。
 *
 * ## 五条不许降级的红线
 *
 * 1. **群成员 / 目标 / 审计三个存储的 `close()` 内部是 `pool.end()`，而池是注入进来的共享属主池**
 *    ⇒ 关停路径 **MUST NOT** 调它们的 `close()`（会连带打死本进程其余十几个存储）。
 *    这与批 D 记下的锚点缓存是同一条坑；批 G 第一片那两个运行时存储关的是自建池，
 *    形状看着一样、语义不同，**别照抄那一片的关停写法**。
 * 2. **精选召回缺席时抛具名错，MUST NOT 回空数组**。空数组的意思是「问过了，精选库里没有素材」，
 *    与「这一问根本没发生」是两件事；单体里两者后果相同（没接线就是真没素材），
 *    拆进程后连不上内容域会长成同一个空数组，搜索词生成拿零样本照跑、零报错。
 * 3. **群评论时序策略拿不到时，覆盖模式回「本轮无可评群」**（`enabled: false`），
 *    **MUST NOT** 拿默认时长顶上去。单体里该存储缺部署目标即为 `undefined`、走的正是这一支，
 *    所以这不是本片发明的降级，是逐位照搬。
 * 4. **免审通知的来源由调用点现推**：评论调度器这条链的来源恒为「评论调度器」，
 *    与人设强制免审、账号级免审是三种不同授权，MUST NOT 合并成一种卡。
 * 5. **写作语言不满足即拒发**（连试两次仍不匹配 → 返回 null），绝不把一条语言不对的评论发出去。
 *
 * ## 三个今天填不上的口（**必填二态，不给默认**）
 *
 * 它们的事实源都在接口域、且本进程今天既无镜像流也无跨进程通道。做成二态而不是可选，
 * 是为了让「没接线」与「接了但今天不可用」在类型上就分得开 —— 这两者的处置完全不同。
 * 逐条的缺席后果写在各自的字段注释里。
 */
import type { Soul } from 'aidcp-kernel/kernel/soul-types.js';
import type { PersonaBinding } from 'aidcp-kernel/kernel/persona-binding.js';
import type { PlatformId } from 'aidcp-kernel/kernel/platform-types.js';
import type { CuratedSelectionPort } from 'aidcp-kernel/kernel/curated-selection-port.js';
import { ContentPortError } from 'aidcp-kernel/kernel/content-port-error.js';
import { checkWritingLanguage } from 'aidcp-kernel/kernel/writing-language.js';
import { buildFacebookCommentComposerPrompt } from 'aidcp-kernel/kernel/facebook-comment-composer-prompt.js';
import { actionModeEnabled } from 'aidcp-kernel/kernel/content-schedule-mode.js';

import type {
  AutomationBusinessConfigPorts,
  AutomationCommentPorts,
  CapabilityState,
} from './automation-connection-dispatcher.js';
import type { AutomationCommentApprovalPorts } from './automation-comment-approval.js';
import type { EdgeTaskLeaseClient } from './comm/edge-task-lease-client.js';
import type { EventBus } from './event-bus/index.js';
import { CommentScheduler } from './comment-agent/comment-scheduler.js';
import type {
  CommentResultReceipt,
  FacebookCoverageCommentConfig,
} from './comment-agent/comment-scheduler.js';
import { FacebookGroupJoinScheduler } from './comment-agent/facebook-group-join-scheduler.js';
import {
  facebookCoverageRelaxEnabled,
  type FacebookGroupTargetStore,
  type FacebookGroupMembershipStore,
  type FacebookGroupJoinAuditStore,
} from './comment-agent/facebook-group-store.js';
import type { FacebookCommentAuditStore } from './comment-agent/facebook-comment-audit-store.js';
import { triggerGatedAutoComment } from './comment-agent/gated-auto-comment.js';
import type { FacebookConsumptionGroupCommentPolicyView } from './orchestrator/facebook-consumption-mode-coordinator.js';

/** 该账号的连接运行时解析（批 E-1 注册表）。 */
export interface AutomationCommentRuntimePort {
  runtimeForAccount(accountId: string): { bus: EventBus; edgeId?: string } | null;
  remainingSessionBudgetForAccount(
    accountId: string,
    action: 'join_group',
    edgeId?: string,
  ): number;
  consumeSessionBudgetForAccount(
    accountId: string,
    action: 'join_group',
    edgeId?: string,
  ): boolean;
}

/** 账号主数据窄口（api 属主，组装根已有客户端）。 */
export interface AutomationCommentAccountPort {
  getPlatformOrNull(accountId: string): Promise<string | null>;
  getContactInfo(accountId: string): Promise<string | null>;
}

/** 自动化配置命令（api 属主）：容器真名回填 + 联系评论尝试台账两条。 */
export interface AutomationCommentConfigCommandsPort {
  resolveFacebookContainerName(
    accountId: string,
    url: string,
    name: string,
  ): Promise<unknown>;
  countContactAttemptsToday(accountId: string): Promise<number>;
  recordContactCommentAttempt(
    accountId: string,
    snapshot: Record<string, unknown>,
  ): Promise<unknown>;
}

/** 本片直接持有的四个自动化属主存储。**注入而不是自建**：它们跨片共用（协调器还要用群成员账本）。 */
export interface AutomationCommentFacebookStores {
  targets: FacebookGroupTargetStore;
  memberships: FacebookGroupMembershipStore;
  joinAudit: FacebookGroupJoinAuditStore;
  commentAudit: Pick<FacebookCommentAuditStore, 'append'>;
}

/** 风控取用面（批 B 注册表 + 批 C 记账漏斗）。 */
export interface AutomationCommentRiskPort {
  /** 物化该账号的可写控制器（与最终同步闸取的是同一个实例）。 */
  resolveController(accountId: string): Promise<{ canDo(action: 'comment' | 'join_group'): boolean }>;
  /** 唯一记账入口（批 C 漏斗）。 */
  recordRiskFact(accountId: string, action: 'comment', dedupeKey: string): Promise<boolean>;
  /** 每笔记去重账本（与自治评论 / 联系评论同一本）。 */
  hasInteraction(accountId: string, noteId: string, action: 'comment'): Promise<boolean>;
  recordInteraction(accountId: string, noteId: string, action: 'comment'): Promise<void>;
}

export interface AutomationCommentSchedulerOptions {
  runtimes: AutomationCommentRuntimePort;
  /** 对边出口（批 D 服务端）。 */
  pusher: { pushToEdges(envelope: unknown, edgeId?: string): number };
  edgeTaskLeases: Pick<EdgeTaskLeaseClient, 'withLease'>;
  /** 人设取值口。**MUST 是取值口而不是快照**：撰写按当前账号热加载。 */
  getSoul(accountId: string): Soul;
  /** 人设绑定三态（同步读镜像）。`unknown` 与 `unbound` 说的不是同一句话。 */
  personaBinding(accountId: string): PersonaBinding;
  /** 模型出口（A-1）。账号归账由调用点带 `accountId`。 */
  llm: {
    complete(prompt: string, options: Record<string, unknown>): Promise<string>;
  };
  /**
   * 精选样本召回（内容域客户端）。**二态**：缺席时抛具名 `not_configured`，
   * MUST NOT 回空数组（红线 2）。
   */
  curatedSelection: CapabilityState<Pick<CuratedSelectionPort, 'selectSamplesForSearchTerms'>>;
  risk: AutomationCommentRiskPort;
  /** 批 G 第二片的审批与通知口。**按引用取，本片不另造第二份审批口径**。 */
  approvalPorts: AutomationCommentApprovalPorts;
  accountRuntime: AutomationCommentAccountPort;
  automationConfigCommands: AutomationCommentConfigCommandsPort;
  /** 结构化通知出口（api 客户端），与批 G 第二片同一个。 */
  deliverStructuredNotification(payload: unknown, idempotencyKey: string): Promise<unknown>;
  /** 两个业务配置取值口（步骤 1 / 2 的同一族，批 H 从同步读镜像 + kernel 判定喂进来）。 */
  businessConfig: Pick<
    AutomationBusinessConfigPorts,
    'effectiveScheduleFor' | 'facebookCommentConfigFor'
  >;
  facebookStores: AutomationCommentFacebookStores;
  /**
   * 群评论时序策略（预热 / 同群再评冷却）。事实源是**接口域**的配置表，
   * 本进程今天既没有它的同步读流、也没有跨进程通道。
   *
   * **缺席后果不是报错**：覆盖模式回「本轮无可评群」（红线 3）。这与单体里该存储
   * 因缺部署目标而为空时逐位一致 —— 所以缺席是**诚实降级**，不是假成功；
   * 但它同样意味着**这个进程里的 Facebook 覆盖评论一条都不会发**，接线时必须知道。
   */
  groupCommentPolicy: CapabilityState<{
    get(): FacebookConsumptionGroupCommentPolicyView | null;
  }>;
  /**
   * 账号暂停（加群连续失败到顶时的自我保护）。事实源在**接口域**的账号状态管理器；
   * 通道已于 2026-08-02 补上（用户拍板「先修两件小的」）。
   *
   * **仍然是二态而不是必填**：接口客户端整体没配时它就该缺席，而缺席后果不是报错 ——
   * 加群照常记账本、照常停重试，但**不会把账号真的暂停**，同一个账号明天还会再撞一次。
   */
  accountPause: CapabilityState<{
    pause(accountId: string, reason: string): Promise<void>;
  }>;
  /**
   * 排期任务「根本没开始」的回报口。事实源是**接口域**的内容排期调度器
   * （三进程形态下排期本身也跑在接口进程里，本口是它的回程）。
   *
   * **缺席后果不是报错**：排期评论没接管到边端时，那一小时的名额**不会被归还**，
   * 于是该账号这一小时就白丢了 —— 日志上与「今天没排期」完全同形。
   */
  scheduledTaskFeedback: CapabilityState<{
    reportNotStarted(
      accountId: string,
      action: 'comment' | 'contact_comment',
      reason: string,
    ): boolean | void;
  }>;
  /** 账号平台读不到时的回落。**回落写在这一层**：属主口如实答 `null`。 */
  fallbackPlatform?: PlatformId;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, 'log' | 'warn'>;
  /**
   * 两个调度器的构造缝。**存在的唯一理由与每连接工厂那个缝相同**：
   * 两个调度器加起来 40 余个选项、绝大多数可选，装配漏一项不报错，
   * 只有把组装好的选项对象抓出来看才验得了。生产路径恒用默认实现。**别当多余删掉。**
   */
  createCommentScheduler?: (
    deps: ConstructorParameters<typeof CommentScheduler>[0],
  ) => CommentScheduler;
  createJoinScheduler?: (
    deps: ConstructorParameters<typeof FacebookGroupJoinScheduler>[0],
  ) => FacebookGroupJoinScheduler;
}

export interface AutomationCommentSchedulerAssembly {
  /** 喂给每连接调度器工厂的最后两个评论域口。 */
  ports: Pick<AutomationCommentPorts, 'scheduler' | 'fireAutoContactComment'>;
  /** 消费协调器（批 G 第四片）要拿去当执行器的两个实例。 */
  executors: {
    comment: CommentScheduler;
    join: FacebookGroupJoinScheduler;
  };
}

/** 加群重试退避与上限的既有默认（与单体同值）。 */
const JOIN_RETRY_BACKOFF_HOURS_DEFAULT = 6;
const JOIN_MAX_ATTEMPTS_DEFAULT = 3;
const COVERAGE_PICK_WINDOW_DEFAULT = 5;
const COVERAGE_COOLDOWN_HOURS_DEFAULT = 72;
const GROUP_LEFT_CONFIRMATIONS_DEFAULT = 3;

/**
 * 装配评论域两个调度器与联系评论安全闸。
 *
 * 与批 B / D / F / G 各片一致：**可单测的工厂，不写进 `main()`，构造期不起任何定时器**。
 */
export function createAutomationCommentSchedulerPorts(
  options: AutomationCommentSchedulerOptions,
): AutomationCommentSchedulerAssembly {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const stores = options.facebookStores;
  const fallbackPlatform: PlatformId = options.fallbackPlatform ?? 'xiaohongshu';

  const resolveConnection = (accountId: string) =>
    options.runtimes.runtimeForAccount(accountId);
  const pusher = {
    pushToEdges: (envelope: unknown, edgeId?: string) =>
      options.pusher.pushToEdges(envelope, edgeId),
  };
  const llmFor = (accountId: string) => ({
    complete: (prompt: string, opts?: Record<string, unknown>) =>
      options.llm.complete(prompt, { ...(opts ?? {}), accountId }),
  });

  // 群评论时序策略的**唯一取用点**：两处消费（覆盖候选筛选 / 同群再评冷却）按引用共用它，
  // 在任一处另读一遍就是第二份实现。
  const groupCommentPolicy = (): FacebookConsumptionGroupCommentPolicyView | null =>
    options.groupCommentPolicy.state === 'wired'
      ? options.groupCommentPolicy.port.get()
      : null;

  // 加群调度器在评论调度器之后构造 —— 评论调度器的两条加群入口按闭包晚绑定取它（TDZ 安全，
  // 与单体逐字同形）。**别为了"看着顺"把它提到前面**：它的 `canJoin` 要用同一个风控物化口。
  let joinScheduler!: FacebookGroupJoinScheduler;

  // 提到局部常量：二态窄化在闭包里会丢（TS 不跨闭包保留对属性的窄化结果）。
  const accountPause = options.accountPause;

  const buildCommentScheduler =
    options.createCommentScheduler ?? ((deps) => new CommentScheduler(deps));
  const buildJoinScheduler =
    options.createJoinScheduler ?? ((deps) => new FacebookGroupJoinScheduler(deps));

  const commentScheduler = buildCommentScheduler({
    onScheduledTaskNotStarted: (accountId, action, reason) =>
      options.scheduledTaskFeedback.state === 'wired'
        ? options.scheduledTaskFeedback.port.reportNotStarted(accountId, action, reason)
        : // 具名缺席：名额归还这条回程没接，逐次结果卡照发（抑制它需要排期器确实接管了重试）。
          noteMissingScheduledFeedback(logger, accountId, action, reason),
    resolveConnection,
    pusher,
    edgeTaskLeases: options.edgeTaskLeases,
    getSoul: options.getSoul,
    personaBinding: options.personaBinding,
    getPlatform: async (accountId: string) =>
      ((await options.accountRuntime.getPlatformOrNull(accountId)) as PlatformId | null)
      ?? fallbackPlatform,
    getContactInfo: (accountId: string) => options.accountRuntime.getContactInfo(accountId),
    curatedSelection: {
      // 红线 2：端口整体缺席时抛具名 `not_configured`，**绝不回空数组**。
      selectSamplesForSearchTerms: (accountId, type, limit) => {
        const port = options.curatedSelection;
        if (port.state !== 'wired') {
          return Promise.reject(
            new ContentPortError(
              'not_configured',
              'curated-selection.selectSamplesForSearchTerms',
              `精选召回端口未接线：${port.reason}`,
            ),
          );
        }
        return port.port.selectSamplesForSearchTerms(accountId, type, limit);
      },
    },
    llmFor,
    dedupFor: (accountId: string) => ({
      hasInteracted: (noteId: string, action: 'comment') =>
        options.risk.hasInteraction(accountId, noteId, action).catch(() => false),
      recordInteraction: (noteId: string, action: 'comment') =>
        options.risk.recordInteraction(accountId, noteId, action).catch(() => {}),
    }),
    // 人审端口按 env 整体二态（批 G 第二片）：未开启时压根不传，评论一律诚实跳过、不发。
    ...(options.approvalPorts.approval.state === 'wired'
      ? { approval: options.approvalPorts.approval.port }
      : {}),
    // 红线 4：来源在这里现推，恒为「评论调度器」。写死成别的会让运营分不出授权来源。
    autoApproveNotify: (input) =>
      options.approvalPorts.notifyAutoApproved(input, 'comment_scheduler'),
    resolveApprovalMode: options.approvalPorts.resolveApprovalMode,
    facebookConfigFor: (accountId: string) =>
      options.businessConfig.facebookCommentConfigFor(accountId),
    facebookRegionCommentTemplatesForGroup: (groupUrl: string) =>
      stores.targets.resolveRegionCommentTemplatesForGroup(groupUrl),
    facebookCompose: (accountId, ctx) =>
      composeFacebookComment(
        { accountId, ...ctx },
        {
          getSoul: options.getSoul,
          complete: (prompt: string, opts: Record<string, unknown>) =>
            options.llm.complete(prompt, opts),
          logger,
        },
      ),
    facebookCanComment: async (accountId: string) =>
      (await options.risk.resolveController(accountId)).canDo('comment'),
    facebookAudit: (row) => {
      void stores.commentAudit.append(row);
    },
    facebookResolveContainerName: (accountId: string, url: string, name: string) =>
      options.automationConfigCommands.resolveFacebookContainerName(accountId, url, name),
    facebookCoverageConfigFor: (accountId: string) =>
      resolveCoverageConfig(accountId, {
        base: options.businessConfig.facebookCommentConfigFor(accountId),
        policy: groupCommentPolicy(),
        memberships: stores.memberships,
        env,
      }),
    facebookCoverageOnCommented: (accountId: string, groupUrl: string) =>
      stores.memberships.markCoverageCommented(accountId, groupUrl, {
        cooldownMs:
          (groupCommentPolicy()?.sameGroupRecommentCooldownHours
            ?? readEnvNumber(env, 'AIDCP_FB_GROUP_COVERAGE_COOLDOWN_HOURS', COVERAGE_COOLDOWN_HOURS_DEFAULT))
          * 60 * 60 * 1000,
      }),
    facebookCoverageOnFailure: (accountId: string, groupUrl: string, reason: string) => {
      if (reason === 'permission_gated' || reason === 'nav_error' || reason.startsWith('nav_error')) {
        void stores.memberships.recordCoverageLeftSignal(accountId, groupUrl, reason, {
          requiredConfirmations: Math.max(
            1,
            Math.trunc(
              readEnvNumber(env, 'AIDCP_FB_GROUP_LEFT_CONFIRMATIONS', GROUP_LEFT_CONFIRMATIONS_DEFAULT),
            ),
          ),
          // nav_error 是网络瞬态：要求达确认次数才把已加入群降级为 left
          //（left 不可复 claim，一次抖动即永久丢一个养熟的群）。
          demoteNow: false,
        });
      }
    },
    facebookJoinNewGroup: (accountId: string, opts?: { manual?: boolean }) =>
      joinScheduler.triggerScheduled(accountId, opts),
    facebookJoinSpecificGroup: (accountId: string, groupUrl: string, opts?: { manual?: boolean }) =>
      joinScheduler.joinSpecificGroup(accountId, groupUrl, opts),
    postResultCard: async (
      accountId: string,
      receipt: CommentResultReceipt,
      source?: string,
      originChatId?: string,
    ) => {
      await options.deliverStructuredNotification(
        {
          kind: 'command_result',
          input: {
            command: source ?? '/comment',
            ok: receipt.ok,
            level: receipt.level,
            title: receipt.title,
            message: receipt.message,
            accountId,
            originChatId,
          },
        },
        `comment-result:${accountId}:${receipt.title}:${receipt.ok ? 'ok' : 'fail'}`,
      );
    },
    logger,
  } as ConstructorParameters<typeof CommentScheduler>[0]);

  joinScheduler = buildJoinScheduler({
    resolveConnection,
    pusher,
    edgeTaskLeases: options.edgeTaskLeases,
    targets: stores.targets,
    memberships: stores.memberships,
    audit: stores.joinAudit,
    llmFor,
    canJoin: async (accountId: string) =>
      (await options.risk.resolveController(accountId)).canDo('join_group'),
    canUseSessionJoin: (accountId: string, edgeId?: string) =>
      options.runtimes.remainingSessionBudgetForAccount(accountId, 'join_group', edgeId) > 0,
    recordSessionJoin: (accountId: string, edgeId?: string) =>
      options.runtimes.consumeSessionBudgetForAccount(accountId, 'join_group', edgeId),
    isFacebookAccount: async (accountId: string) =>
      (await options.accountRuntime.getPlatformOrNull(accountId)) === 'facebook',
    ...(accountPause.state === 'wired'
      ? {
          pauseAccount: async (accountId: string, reason: string) => {
            await accountPause.port.pause(accountId, reason);
            logger.warn(`[fb-group-join] account paused account=${accountId} reason=${reason}`);
          },
        }
      : {}),
    retryBackoffMs:
      readEnvNumber(env, 'AIDCP_FB_GROUP_JOIN_RETRY_BACKOFF_HOURS', JOIN_RETRY_BACKOFF_HOURS_DEFAULT)
      * 60 * 60 * 1000,
    maxAttempts: Math.max(
      1,
      Math.trunc(readEnvNumber(env, 'AIDCP_FB_GROUP_JOIN_MAX_ATTEMPTS', JOIN_MAX_ATTEMPTS_DEFAULT)),
    ),
    logger,
  } as ConstructorParameters<typeof FacebookGroupJoinScheduler>[0]);

  if (options.accountPause.state !== 'wired') {
    logger.warn(
      '[aidcp-automation] 加群失败到顶时不会暂停账号：账号状态写通道未接线 —— '
        + `${options.accountPause.reason}（加群照常记账本、照常停止重试）`,
    );
  }
  if (options.groupCommentPolicy.state !== 'wired') {
    logger.warn(
      '[aidcp-automation] Facebook 覆盖评论本进程一条都不会发：群评论时序策略未接线 —— '
        + `${options.groupCommentPolicy.reason}（覆盖候选恒为空，与单体缺该配置时逐位一致）`,
    );
  }

  // **不加整体强转**：参数形状取端口自己那一份（`Parameters<…>`），
  // 让契约漂移在这里编译期现形，而不是长成一个「形状对、内容缺」的调用。
  const fireAutoContactComment: AutomationCommentPorts['fireAutoContactComment'] = (
    args: Parameters<AutomationCommentPorts['fireAutoContactComment']>[0],
  ) =>
    triggerGatedAutoComment(
      {
        accountId: args.accountId,
        source: 'hot_lead',
        snapshot: { noteId: args.noteId, velocity: args.velocity, ageHours: args.ageHours },
        triggerFn: async () => {
          const contactCommentMode = options.businessConfig.effectiveScheduleFor(
            args.accountId,
          ).contactCommentMode;
          const receipt = await commentScheduler.triggerTargeted(
            args.accountId,
            { noteId: args.noteId, title: args.title },
            {
              injectContact: true,
              priority: 'automatic',
              approvalMode: actionModeEnabled(contactCommentMode) ? contactCommentMode : 'review',
              currentNote: {
                noteId: args.currentDetail.noteId,
                title: args.currentDetail.title,
                content: args.currentDetail.content,
                author: args.currentDetail.author,
                likeCount: args.currentDetail.likeCount,
                collectCount: args.currentDetail.collectCount,
              },
              onResult: async (result: { outcome?: string }) => {
                if (result.outcome === 'commented') {
                  await options.risk.recordRiskFact(
                    args.accountId,
                    'comment',
                    `contact-comment:${args.accountId}:${args.noteId}:${Date.now()}`,
                  );
                }
              },
            } as Parameters<CommentScheduler['triggerTargeted']>[2],
          );
          // `recordCommentOnTrigger: false` —— 当前笔记直评在**最终 commented** 后才消费共用配额，
          // 触发即记会让「未产出却占掉一次 comment」成为常态。
          return { ...receipt, recordCommentOnTrigger: false };
        },
      },
      {
        canComment: async (accountId: string) =>
          (await options.risk.resolveController(accountId)).canDo('comment'),
        recordComment: (accountId: string) =>
          options.risk.recordRiskFact(
            accountId,
            'comment',
            `contact-comment:${accountId}:${Date.now()}:${randomSuffix()}`,
          ),
        countAttemptsToday: (accountId: string) =>
          options.automationConfigCommands.countContactAttemptsToday(accountId),
        getDailyCap: async (accountId: string) =>
          options.businessConfig.effectiveScheduleFor(accountId).contactCommentDailyCap,
        recordAttempt: async (accountId, source, snapshot) => {
          await options.automationConfigCommands.recordContactCommentAttempt(accountId, {
            source,
            ...(snapshot ?? {}),
          });
        },
      },
    );

  return {
    ports: {
      scheduler: {
        state: 'wired',
        port: {
          triggerManual: (accountId: string, opts: Record<string, unknown>) =>
            commentScheduler.triggerManual(
              accountId,
              opts as Parameters<CommentScheduler['triggerManual']>[1],
            ),
          triggerTargeted: (
            accountId: string,
            target: { noteId: string; title: string },
            opts: Record<string, unknown>,
          ) =>
            commentScheduler.triggerTargeted(
              accountId,
              target,
              opts as Parameters<CommentScheduler['triggerTargeted']>[2],
            ),
        },
      },
      fireAutoContactComment,
    },
    executors: { comment: commentScheduler, join: joinScheduler },
  };
}

/**
 * Facebook 覆盖模式候选筛选。**时序策略缺席即回「本轮无可评群」**（红线 3）——
 * 与单体里该存储为空时逐位一致，绝不拿默认时长顶上去。
 */
async function resolveCoverageConfig(
  accountId: string,
  input: {
    base: import('aidcp-kernel/kernel/facebook-comment-config-types.js').EffectiveFacebookCommentConfig;
    policy: FacebookConsumptionGroupCommentPolicyView | null;
    memberships: FacebookGroupMembershipStore;
    env: NodeJS.ProcessEnv;
  },
): Promise<FacebookCoverageCommentConfig> {
  const { base, policy, memberships, env } = input;
  if (!policy) {
    return {
      coverageEnabled: true,
      enabled: false,
      keywords: base.keywords,
      containers: [],
      commentMode: base.commentMode,
      commentTemplates: base.commentTemplates,
      relaxed: false,
    };
  }
  const pickWindow = readEnvNumber(env, 'AIDCP_FB_GROUP_COVERAGE_PICK_WINDOW', COVERAGE_PICK_WINDOW_DEFAULT);
  let candidates = await memberships.coverageCandidates(accountId, {
    limit: pickWindow,
    cooldownMs: (policy.sameGroupRecommentCooldownHours ?? COVERAGE_COOLDOWN_HOURS_DEFAULT) * 60 * 60 * 1000,
    warmupMs: policy.joinToFirstCommentHours * 60 * 60 * 1000,
  });
  // **默认严格**：无合规群即本轮不评论，MUST NOT 退而求其次去评一个不满足预热或仍在冷却中的群。
  // 判定收在那个可单测的纯函数里，本处只负责把运行时取值喂给它、不另立一份判定。
  let relaxed = false;
  if (candidates.length === 0 && facebookCoverageRelaxEnabled(env.AIDCP_FB_GROUP_COVERAGE_RELAX)) {
    candidates = await memberships.coverageCandidates(accountId, { limit: pickWindow, relaxed: true });
    relaxed = candidates.length > 0;
  }
  const chosen =
    candidates.length > 0 ? candidates[Math.floor(Math.random() * candidates.length)] ?? null : null;
  return {
    coverageEnabled: true,
    enabled: base.enabled && chosen !== null,
    keywords: base.keywords,
    containers: chosen ? [{ url: chosen.groupUrl }] : [],
    commentMode: base.commentMode,
    commentTemplates: base.commentTemplates,
    relaxed: chosen !== null ? relaxed : false,
  };
}

/**
 * Facebook 评论撰写（无人值守，不走人审）：读了再写 —— 吃到帖子正文与顶部他人评论，
 * 顺着讨论、用**内容语言**写。红线 5：连试两次仍不满足写作语言即返回 null，绝不发出去。
 */
async function composeFacebookComment(
  input: {
    accountId: string;
    keyword: string;
    postText?: string;
    comments?: string[];
  },
  deps: {
    getSoul(accountId: string): Soul;
    complete(prompt: string, options: Record<string, unknown>): Promise<string>;
    logger: Pick<Console, 'warn'>;
  },
): Promise<string | null> {
  try {
    const soul = deps.getSoul(input.accountId);
    const writingLanguage = soul.writing_language;
    if (!writingLanguage) {
      deps.logger.warn(
        `[facebook-comment] account=${input.accountId} 缺少 writing_language，拒绝生成评论`,
      );
      return null;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt = buildFacebookCommentComposerPrompt({
        soul,
        writingLanguage,
        keyword: input.keyword,
        postText: input.postText,
        comments: input.comments ?? [],
        retry: attempt > 0,
      });
      const text = await deps.complete(prompt, {
        accountId: input.accountId,
        role: 'facebook_comment_composer',
      });
      const clean = String(text ?? '').trim();
      if (clean && checkWritingLanguage(clean, writingLanguage) === 'match') return clean;
    }
    deps.logger.warn(
      `[facebook-comment] account=${input.accountId} 连续两次未满足 `
        + `writing_language=${writingLanguage}，拒绝发布评论`,
    );
    return null;
  } catch {
    return null;
  }
}

/** 名额归还回程没接：如实说一句，**返回 false** —— 逐次结果卡照发（抑制它需要排期器真接管了重试）。 */
function noteMissingScheduledFeedback(
  logger: Pick<Console, 'warn'>,
  accountId: string,
  action: string,
  reason: string,
): false {
  logger.warn(
    `[comment-scheduler] 排期名额未归还 account=${accountId} action=${action} reason=${reason}`
      + ' —— 排期回程未接线（本进程没有内容排期调度器）',
  );
  return false;
}

function readEnvNumber(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = Number(env[key]);
  return Number.isFinite(raw) ? raw : fallback;
}

/** 记账去重键的抖动位。构造期不取值、每次调用现算（与单体的随机后缀同义）。 */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}
