/**
 * 自动化进程的真装配（task 3.5g，批 H 第 5 片）—— 把十二个工厂接进组装根，并写出 `main()`。
 *
 * ## 读这个文件之前要知道的四件事
 *
 * 1. **这一段是新写的，不是从单体搬的。** 单体的自动化段是「先开边缘口、后装同步读」，
 *    与本进程要求的顺序**正好相反**：本进程必须先让同步读就绪，才放行业务入口
 *    （启动外壳的就绪闸就是干这个的）。照抄单体的顺序会得到一个「监听起来了、
 *    但拿着一份空副本在跑」的进程。
 * 2. **`main()` 的第一句是 schema 契约门**，在建池之前。这条不靠记：启动外壳的
 *    `schemaGate` 是必填、回执品牌位不导出、外部造不出来 ⇒ 漏了编译期就红。
 * 3. **有三处真环**，不是排序能解决的，一律用晚绑定薄壳破（见 {@link lateBound}）：
 *    风控底座 ↔ 记账漏斗；边缘接入 ↔ 每连接运行时 ↔ 调度器工厂；组装根 ↔ 边缘 / 发布。
 * 4. **可执行入口仍然 fail-closed，本片不动它。** 台账清零之前，`runAutomationEntry()`
 *    照旧读完配置就抛「未就绪」。本片交付的是「这套装配可以被真的调起来并测试」，
 *    切成真启动属第 4 段，且切换本身要有用例证明「台账非空时仍然拒绝启动」这条闸没被删。
 *
 * ## 关停：判据是「它关的是谁的池」，不是「这一族有没有安全写法」
 *
 * 同一族存储的 `close()` 语义可以不一样，而**调用点看不出来**。裸 `pool.end()` 那一族
 * （锚点缓存 / 群目标 / 群成员 / 加群审计 / 告警 / 点赞 / 有价值评论 / 互动 feed / 群路由 /
 * 委托任务存储）关的是**注入进来的共享属主池**，调一次就打死整个进程 ⇒ **本文件绝不调它们**。
 * 带 `ownsPool` / `ownedPool?` 守卫的那一族（会话配置 / 续场配置 / 风控存储 / FB 两套运行时 …）
 * 在注入池时是空操作，安全。属主池由 `main()` 自己在最后关。
 *
 * ## 部署形态 MUST 是 stop→start，禁止滚动 / 蓝绿
 *
 * 风控写者锁是**会话级 advisory lock、构造期就抢**：两个进程重叠期间，后起的那个会抢不到锁
 * 并拒绝启动（这是设计，不是故障）。
 */
import pg from 'pg';

import type { DeploymentTarget } from 'aidcp-kernel/deployment-target.js';
import { resolveOwnerPgConfig } from 'aidcp-kernel/kernel/pg-owner-connection-resolver.js';
import type { PersonaBinding } from 'aidcp-kernel/kernel/persona-binding.js';
import type { Soul } from 'aidcp-kernel/kernel/soul-types.js';
import type { StructuredNotificationDeliveryInput } from 'aidcp-kernel/kernel/api-direct-port.js';
import type { CuratedWritePort } from 'aidcp-kernel/kernel/curated-write-port.js';
import { hasUserRejectionEvidence } from 'aidcp-kernel/kernel/publish-pipeline-types.js';
import type { DispatchDraft } from 'aidcp-kernel/kernel/publish-draft-contract.js';
import {
  curatedContentFailureReason,
  type CuratedPanelRow,
} from 'aidcp-kernel/kernel/curated-content-types.js';
import type { ApprovalVoidReason } from 'aidcp-kernel/kernel/publish-approval-contract.js';
import type { TextCardTranscriber } from 'aidcp-kernel/kernel/text-card-transcriber-port.js';

import {
  createAutomationCompositionRoot,
  readAutomationRootConfig,
  type AutomationApiClients,
  type AutomationCompositionRoot,
  type AutomationContentClients,
  type AutomationRootConfig,
  type AutomationRuntimeHandles,
} from './automation-composition-root.js';
import {
  runAutomationStartupSchemaGate,
  type AutomationSchemaGateReceipt,
} from './automation-schema-gate-startup.js';
import {
  startAutomationService,
  type AutomationBusinessIngress,
  type AutomationService,
  type AutomationSignalSource,
} from './automation-service-entry.js';
import { createAutomationConfigMirrorGate } from './automation-config-mirror-gate.js';
import { createAutomationConfigAuditRelay } from './automation-config-audit-relay.js';
import { createAutomationModelExit } from './automation-model-exit.js';
import { createAutomationRiskFoundation } from './automation-risk-foundation.js';
import {
  createAutomationRiskAccounting,
  type AutomationRiskAccounting,
} from './automation-risk-accounting.js';
import { createAutomationFacebookRuntime } from './automation-facebook-runtime.js';
import { createAutomationBusinessConfigPorts } from './automation-business-config.js';
import { createAutomationCommentApprovalPorts } from './automation-comment-approval.js';
import { createAutomationCommentSchedulerPorts } from './automation-comment-scheduler.js';
import { createAutomationFacebookCoordinator } from './automation-facebook-coordinator.js';
import {
  createAutomationDispatcherFactory,
  type AutomationDispatcherDeps,
} from './automation-connection-dispatcher.js';
import {
  createAutomationConnectionRuntime,
  type AutomationConnectionRuntime,
  type AutomationDispatcherFactory,
} from './automation-connection-runtime.js';
import {
  createAutomationEdgeAccess,
  type AutomationEdgeAccess,
} from './automation-edge-access.js';
import {
  createAutomationInteraction,
  createLateBoundInteractionEdgeBinding,
} from './automation-interaction.js';
import {
  createAutomationPublishDispatch,
  type AutomationPublishDispatch,
} from './automation-publish-dispatch.js';
import { personaBindingFor, requirePersonaSoul } from './automation-persona-view.js';
import { createAutomationLlmUsageBuffer } from './automation-llm-usage-buffer.js';

import { EventBus } from './event-bus/index.js';
import { edgeCommandToEnvelope } from './comm/command-bridge.js';
import {
  AutomationDispatchCommandReceiver,
  DelegatedTaskCommandReceiver,
} from './delegated-task/operator-command-receiver.js';
import {
  PgOperatorCommandLedger,
  unavailableOperatorCommandLedger,
  type OperatorCommandLedger,
} from './delegated-task/operator-command-ledger.js';
import { PgDelegatedTaskStore } from './delegated-task/store.js';
import { DelegatedTaskService } from './delegated-task/service.js';
import { listDelegatedAccountCandidates } from './delegated-task/account-candidates.js';
import {
  registerAutomationDispatchCommandRoutes,
  registerDelegatedTaskTextCommandRoutes,
} from './transport/operator-command-http.js';
import { registerDelegatedTaskRoutes } from './transport/delegated-task-http.js';
import { registerContentSchedulingRoutes } from './transport/content-scheduling-http.js';
import { registerRiskReadRoutes } from './transport/risk-read-http.js';
import { registerRiskCommandRoutes } from './transport/risk-command-http.js';
import { registerPanelAutomationRoutes } from './transport/panel-automation-http.js';
import { registerGroupRouteRoutes } from './transport/group-route-http.js';
import { registerAlertResolutionRoutes } from './transport/alert-resolution-http.js';
import { registerPanelConfigRoutes } from './transport/panel-config-http.js';
import { registerFacebookGroupOpsRoutes } from './transport/facebook-group-ops-http.js';
import { PgPanelAutomationRead } from './risk/panel-automation-read.js';
import { PgRiskCommandService } from './risk/risk-command-service.js';
import { GroupRouteStore } from './cache/group-route-store.js';
import { QuotaConfigStore } from './config/quota-config-store.js';
import { PacingConfigStore } from './config/pacing-config-store.js';
import { createQuotaConfigPanel } from './config/quota-config-facade.js';
import { createPacingConfigPanel } from './config/pacing-config-facade.js';
import { createSessionLimitPanel } from './config/session-config-facade.js';
import { createResumeConfigPanel } from './config/resume-config-facade.js';
import { createAutomationContentSchedulingPort } from './automation-content-scheduling.js';
import type { Envelope } from './comm/protocol.js';
import type {
  ConceptExtractorFactoryOptions,
  CuratedCommentEvaluatorFactoryOptions,
  CuratedNoteEvaluatorFactoryOptions,
  RoleFactoryRegistry,
  ValuableCommentArchivistFactoryOptions,
} from './orchestrator/role-dispatcher.js';
import {
  InternalHttpClient,
  INTERNAL_HTTP_TIMEOUT_CEILING_MS,
} from './transport/internal-http.js';
import { PublishGenerationHttpClient } from './transport/publish-generation-http.js';
import { PublishApprovalDecisionWriterHttpClient } from './transport/publish-approval-decision-http.js';
import { PublishScheduler } from './publish-agent/publish-scheduler.js';
import { resolveCuratedGateConfig } from './publish-agent/curated-gate.js';
import { createDelegatedExecutorRouter } from './delegated-task/executors.js';
import { DelegatedTaskWorker } from './delegated-task/worker.js';
import {
  DelegatedTaskNotificationGate,
  delegatedTaskFailureReceipt,
} from './delegated-task/notification.js';
import type { DelegatedTask } from './delegated-task/types.js';
import { platformRegistryEntry } from './platform/registry.js';
import { AutomationSyncReadMirrors } from './transport/automation-sync-read-mirrors.js';
import { probeSchemaShape } from './schema/schema-capability.js';
import type { AutomationSyncReadRuntimeSources } from './transport/automation-sync-read-source.js';
import {
  CuratedTargetAuthorityHttpClient,
  CuratedWriteAuthorityHttpClient,
  ReplyAiAuthorityHttpClient,
  TextCardTranscriptionAuthorityHttpClient,
} from './transport/content-authority-http.js';
import {
  FacebookPublishMediaAuthorityHttpClient,
  LlmUsageRecordingAuthorityHttpClient,
} from './transport/content-media-usage-http.js';
import { PublishApprovalAuthorityHttpClient } from './transport/publish-approval-authority-http.js';
import { SessionConfigStore } from './config/session-config-store.js';
import { ResumeConfigStore } from './config/resume-config-store.js';
import {
  FacebookGroupJoinAuditStore,
  FacebookGroupMembershipStore,
  FacebookGroupTargetStore,
} from './comment-agent/facebook-group-store.js';
import { FacebookCommentAuditStore } from './comment-agent/facebook-comment-audit-store.js';
import { ConceptExtractorRole } from './agents/concept-extractor-role.js';
import { ValuableCommentArchivist } from './agents/valuable-comment-archivist.js';
import { CuratedNoteEvaluator, type CuratedNoteSink } from './agents/curated-note-evaluator.js';
import {
  CuratedCommentEvaluator,
  type CuratedCommentSink,
} from './agents/curated-comment-evaluator.js';

/**
 * 装配还没完成就被取用。
 *
 * **绝不返回一个「看着正常的空值」**：那会让「装配顺序错了」与「这东西本来就不在」同形，
 * 而两者的处置完全相反。与边缘接入那个响亮取用闸同形，只是作用在跨工厂的三处真环上。
 */
function assertEnvelope(value: unknown): Envelope {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { type?: unknown }).type !== 'string'
  ) {
    throw new Error(
      'automation_push_payload_not_envelope: 推给边缘的不是一个协议信封（缺 type）',
    );
  }
  return value as Envelope;
}

export class AutomationCompositionNotConstructedError extends Error {
  readonly code = 'automation_composition_not_constructed';

  constructor(readonly component: string) {
    super(
      `automation composition component "${component}" was used before construction finished`,
    );
    this.name = 'AutomationCompositionNotConstructedError';
  }
}

interface LateBound<T> {
  /** 取值。未回填即**具名抛**。 */
  get(): T;
  /** 回填一次。重复回填即抛 —— 两个实例意味着有一半的调用去了别处。 */
  set(value: T): void;
  /** 只看有没有（用于「启动期窗口内按未就绪处置」这类**写明了回落语义**的读法）。 */
  peek(): T | undefined;
}

function lateBound<T>(component: string): LateBound<T> {
  let value: T | undefined;
  return {
    get() {
      if (value === undefined) {
        throw new AutomationCompositionNotConstructedError(component);
      }
      return value;
    },
    set(next: T) {
      if (value !== undefined) {
        throw new Error(`automation_late_binding_rebound:${component}`);
      }
      value = next;
    },
    peek: () => value,
  };
}

export interface AutomationMainOptions {
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /** 信号挂载点。传 `null` = 不挂（嵌入式调用与测试用）。 */
  signals?: AutomationSignalSource | null;
  /** 直接给配置；不给就按环境变量读。 */
  config?: AutomationRootConfig;
  /**
   * schema 契约门的替身（**测试用**）。生产上不传 —— 门自己按 `AIDCP_SCHEMA_GATE`
   * 与属主连接配置去判，且 MUST NOT 被 try/catch 包住。
   */
  runSchemaGate?: typeof runAutomationStartupSchemaGate;
  /** 属主池构造缝（测试用）。 */
  createOwnerPool?: () => pg.Pool;
}

/**
 * 起自动化生产运行时。
 *
 * 返回的是启动外壳那个 {@link AutomationService}：`close()` 会依次停业务入口、
 * 归还构造期资源、关组装根，最后由本函数关掉属主池。
 */
export async function runAutomationMain(
  options: AutomationMainOptions = {},
): Promise<AutomationService> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;

  // ── 0. 配置 ─────────────────────────────────────────────────────────────
  const config = options.config ?? readAutomationRootConfig(env);
  const executionTarget: DeploymentTarget = config.executionTarget;

  // ── 0b. schema 契约门：**建池之前**，MUST NOT 包 try/catch ─────────────────
  // enforce 模式下门自己抛，异常一路冒到调用方，进程以非 0 退出、systemd 重启 —— 这是设计。
  const schemaGate: AutomationSchemaGateReceipt = await (
    options.runSchemaGate ?? runAutomationStartupSchemaGate
  )();

  // ── 1. 属主池：全体共享的**那一个** ────────────────────────────────────────
  const ownerPool =
    options.createOwnerPool?.() ?? new pg.Pool(resolveOwnerPgConfig('automation'));

  // ── 1b. 同步读镜像 ──────────────────────────────────────────────────────
  // 由 main() 建、再喂进组装根：本进程好几个工厂在组装根建成之前就要它。
  const mirrors = new AutomationSyncReadMirrors(executionTarget, Date.now);

  // ── 1c. 三处真环的晚绑定薄壳 ─────────────────────────────────────────────
  const edgeAccessRef = lateBound<AutomationEdgeAccess>('edgeAccess');
  const publishDispatchRef = lateBound<AutomationPublishDispatch>('publishDispatch');
  const accountingRef = lateBound<AutomationRiskAccounting>('riskAccounting');
  /**
   * 每连接角色调度器工厂。**晚绑定的是它、不是每连接运行时**，这一点是有意选的：
   * 环上两侧只需要破一处，而这一侧是**一个函数**，薄壳就是「调用时才解引用」一行；
   * 反过来破另一侧就得给冷却闸与去重守卫**两个对象**各做一层代理 —— 代理对象是
   * 「看着接上了、其实少实现了一个方法」的高发区，而那种错不报错。
   */
  const dispatcherFactoryRef = lateBound<AutomationDispatcherFactory>('dispatcherFactory');
  /** 进程级观测总线。**边缘接入与每连接运行时 MUST 是同一个实例**（两条总线 = 静默分裂）。 */
  const eventBus = new EventBus();

  /**
   * 属主同步读五条流的供给方。
   *
   * 它是组装根的**构造入参**，而五个供给方里有三个住在工厂身上 ⇒ 这就是第三处真环。
   * 破法是晚绑定：组装根只在**快照时刻**才调这些闭包，装配期给薄壳即可。
   */
  const syncReadSources: AutomationSyncReadRuntimeSources = {
    sessionConfigGlobal: () => sessionConfigStore.syncReadObservation(),
    edgePresence: () => edgeAccessRef.get().server.edgePresenceSnapshot(),
    publishInFlight: () => ({
      recordIds: publishDispatchRef.get().publishDispatcher.getInFlightRecordIds(),
    }),
    captchaAvailability: () => ({
      state:
        env.AIDCP_CAPTCHA_ASSIST_ENABLED?.trim() !== 'true'
          ? 'disabled'
          : edgeAccessRef.get().captchaAssist.isAvailable()
            ? 'available'
            : 'unavailable',
    }),
    // ⚠️ **本进程没有配置镜像轮询刷新器**：那个刷新器（`src/config/mirror-refresher.ts`）
    //    在归属表里是 api，派生器不会把它拷进本仓。单体那份 health 报的是
    //    `CONFIG_MIRRORS[k].owner === 'automation'` 的四类限频配置（配额 / 节奏 / 单场 / 续场），
    //    而本进程**就是那四张表的属主、直读自己的库**，不存在「副本落后于属主」这件事。
    //    ⇒ 如实报「没有在跑的镜像刷新」，**MUST NOT 编一份看着健康的条目表**。
    //    真正的缺口不在这条流上，而是「后台改了这四类配置之后谁去通知本进程重读」——
    //    已按 5.5 登记，别在这里用一份假条目把它盖住。
    configMirrorHealth: () => ({
      sourceService: 'automation',
      asOf: Date.now(),
      enabled: false,
      pollMs: 0,
      entries: [],
    }),
  };

  /**
   * 账号投影刷新（Facebook 作用域指令的守卫二次判定要它）。
   *
   * 单体里它是「重新拉一次花名册」；本进程的投影来自同步读那条消费流，所以这里
   * **触发一次真刷新、再如实回报结果**。刷不动时 MUST NOT 答 `ok` —— 接收方会据此
   * 重试属主写，答成功等于让它在一份没变的投影上再撞一次。
   */
  const refreshAccountProjection = async (): Promise<
    { ok: true; rows: number } | { ok: false; reason: 'source_failed'; message?: string }
  > => {
    await rootRef.get().syncRead.refresh();
    const view = mirrors.accountFor('');
    if (view.state !== 'fresh') {
      return {
        ok: false,
        reason: 'source_failed',
        message: `automation_account_projection_${view.state}`,
      };
    }
    return { ok: true, rows: 1 };
  };

  const rootRef = lateBound<AutomationCompositionRoot>('compositionRoot');

  const runtime: AutomationRuntimeHandles = {
    // 三个指令接收方都在**调用时**才解引用 `deps.x`，所以 getter 形态的薄壳可用。
    edgeResume: {
      get wsServer() {
        return edgeAccessRef.peek()?.server;
      },
    },
    facebookScope: {
      get owner() {
        return facebookGroupTargets;
      },
      refreshAccountProjection,
    },
    publishUiUpdate: {
      get uiSnapshot() {
        return publishDispatchRef.get().uiSnapshot;
      },
    },
    syncReadSources,
  };

  // ── 1d. 组装根 ──────────────────────────────────────────────────────────
  const root = createAutomationCompositionRoot({
    config,
    runtime,
    ownerPool,
    syncRead: { mirrors },
  });
  rootRef.set(root);
  const apiClients: AutomationApiClients = root.apiClients;
  const contentClients: AutomationContentClients = root.contentClients;

  /**
   * 结构化通知的两参形态（载荷 + 幂等键）。属主口收的是一个信封 `{commandId, notification}`，
   * 这里只做那一层包装 —— **幂等键由调用点给**，本函数不自己造：造一个等于让重投变成两张卡。
   */
  const deliverStructuredNotification = async (
    payload: unknown,
    idempotencyKey: string,
  ): Promise<unknown> =>
    root.structuredDeliver.deliver({
      commandId: idempotencyKey,
      notification: payload as StructuredNotificationDeliveryInput['notification'],
    });

  // ── 1e~1g. `main()` 自己持有的存储与客户端 ────────────────────────────────
  // 会话配置 / 续场配置：**唯一实例**。发布下发、每连接调度器、业务配置的活跃周历、
  // 以及 `session_config_global` 那条属主流全部取它，不许任何一处自建第二个。
  const sessionConfigStore = new SessionConfigStore({ pool: ownerPool });
  const resumeConfigStore = new ResumeConfigStore({ pool: ownerPool });

  // 内容侧另外四个客户端：组装根那两个（概念池 / 精选召回）之外的部分。
  const contentHttp = new InternalHttpClient(config.contentBaseUrl);
  const contentArgs = [contentHttp, config.contentInternalToken, executionTarget] as const;
  const curatedWrite = new CuratedWriteAuthorityHttpClient(...contentArgs);
  const facebookPublishMedia = new FacebookPublishMediaAuthorityHttpClient(...contentArgs);
  const replyAi = new ReplyAiAuthorityHttpClient(...contentArgs);
  const llmUsageRecording = new LlmUsageRecordingAuthorityHttpClient(...contentArgs);
  const textCardTranscriber = new TextCardTranscriptionAuthorityHttpClient(
    ...contentArgs,
    // 第四个参数是「旗标开没开」的**本地**取值闭包，两个进程读的是同一份部署配置，
    // 所以不为一个布尔多走一次网络往返；客户端拿到应答后会比对属主回显的取值，不一致告警一次。
    //
    // ⚠️ **MUST NOT 写成恒 `true`**（本片第一版就是这么写的，是个不诚实）：
    // `enabled()` 是角色用来决定「要不要发起转写」的那一问。恒答 true ⇒ 每篇笔记都会去调一条
    // 今天对面还没服务的路由，把「这台机器没开这个能力」变成一串失败；而且两侧旗标对账
    // 从此永远比不出差异 —— 那条告警的全部价值就在于比。
    () => env.AIDCP_TEXTCARD_OCR === 'true',
    logger,
  );

  // 模型出口用的内部 HTTP 客户端：**指向接口进程**。组装根内部建的那两个都没暴露，
  // 这里建一个交给模型出口（它的注释明说别在模块内自建）。
  const apiHttp = new InternalHttpClient(config.apiBaseUrl);

  // 发布授权权威（api 属主）。**组装根那 17 个客户端里没有它** —— 而发布下发链上有三处要它，
  // 一处都不能用发布日志客户端顶替（发布日志答的是「稿子怎么样了」，授权答的是「批没批、推进到哪一步」）。
  // ⚠️ **令牌取 `publishApprovalInternalToken`，不是通用的 api 令牌**：接口进程给这一组路由挂的是
  //    `AIDCP_PUBLISH_APPROVAL_INTERNAL_TOKEN`，两者没有互相回落。拿错了每次调用都被判未授权，
  //    而那要真把两个进程一起跑起来才看得见（编译过、两仓测试各自全绿）。
  const publishApprovalAuthority = new PublishApprovalAuthorityHttpClient(
    apiHttp,
    config.publishApprovalInternalToken,
  );


  // 四个 Facebook 属主存储：`main()` 自建，跨片共用。
  // ⚠️ 群成员账本必须与消费协调器**同一个实例**（两份会让覆盖记录各记一半）。
  const facebookGroupTargets = new FacebookGroupTargetStore({
    pool: ownerPool,
    executionTarget,
    refreshAccountProjection,
  });
  const facebookGroupMemberships = new FacebookGroupMembershipStore({
    pool: ownerPool,
    executionTarget,
  });
  const facebookGroupJoinAudit = new FacebookGroupJoinAuditStore({ pool: ownerPool });
  const facebookCommentAudit = new FacebookCommentAuditStore({ pool: ownerPool });

  // ── 进程内的两样状态 ─────────────────────────────────────────────────────
  // 调度总开关：**刻意是进程内布尔、刻意没有持久台账**（重启后运营再点一次启动 MUST 重新执行，
  // 台账会把它判成 duplicate 并回放一条陈旧的「是否真翻转」＝编造事实）。
  let dispatchActive = true;
  // 昵称的进程内已知值。**权威在接口域**（属主侧是「比较后写」，这里只是省掉重复写），
  // 重启后为空 ⇒ 首次采集会多写一次幂等写。MUST NOT 把它当权威读口。
  const knownNicknames = new Map<string, string>();

  // ── 1h. 运营指令：调度启停 ─────────────────────────────────────────────
  // **这条路由本进程必须自己注册。** 组装根只注册了三个成对指令接收方，
  // 而运营指令那一族（委托自由文本 / 手动发布 / 手动评论 / 调度启停）在单体里是**进程内直调**，
  // 拆开之后就成了 api → automation 的一跳；不注册的话对面拿到的是 404，
  // 而 404 会被读成「对面版本落后、不支持这个方法」—— 一个纯接线遗漏冒名顶替了具名原因。
  //
  // **先注册、后有调用方是对的顺序**（判例是内容侧用量记账那条：属主先接得住，
  // 免得写调用方时才发现对面根本没有这条路由）。今天 api 的手写入口还没构造对应客户端，
  // 那是接口侧的账，见 tasks 4.1b。
  registerAutomationDispatchCommandRoutes(
    root.internalServer,
    new AutomationDispatchCommandReceiver({
      // 语义逐条照单体：**`changed` 是观测值**（本次是否真翻转），不是「我请求了所以变了」；
      // 真翻转时要**真的**启停各连接，否则开关只是个显示用的布尔；
      // `edgesOnline` 取实测在线数，绝不乐观。
      setDispatch: async (accountId, action) => {
        const want = action === 'start';
        const changed = dispatchActive !== want;
        if (changed) {
          dispatchActive = want;
          if (want) connectionRuntime.runtimes.startAll();
          else connectionRuntime.runtimes.endAll('panel_dispatch_stop');
        }
        return {
          accountId,
          dispatch: want ? 'started' : 'stopped',
          changed,
          // 边缘接入此刻可能还没建成（这条闭包只在请求期才跑，届时必已回填）。
          edgesOnline: edgeAccessRef.get().server.onlineEdgeCount(),
        };
      },
      isActive: () => dispatchActive,
    }),
    config.automationInternalToken,
    executionTarget,
  );

  // ── 1i. 运营指令：委托任务控制面（自由文本 + 卡片动作） ────────────────────
  //
  // 与 1h 同一形态的第二条：单体里 `/delegate` 与委托卡片动作都是**进程内直调**，
  // 拆开之后成了 api → automation 的一跳，而这两条路由本进程此前一条都没注册。
  //
  // **两个目标校验钩子 MUST NOT 省略。** 它们是「目标存不存在 / 是不是待审 /
  // 是不是这个账号的」三问的唯一执行点：省掉之后确认卡照发、任务照建，等真去执行时
  // 才发现目标不对 —— 那是本进程最不该有的形态（先假成功、后爆在最远处）。
  const delegatedTaskStore = new PgDelegatedTaskStore({ executionTarget, pool: ownerPool });
  await delegatedTaskStore.init();

  /**
   * 精选目标校验读。**走受鉴权那一族，不走裸形态那条同名读**（2026-08-04 裁决）。
   *
   * 判据是失败语义、不是风格：下面两个钩子必须分得出「精选库暂时不可用」与「这一行不存在」，
   * 而裸那条的客户端不做按码还原 —— 跨进程后对面的缺表错误到这边只剩一个普通传输错误，
   * 守卫恒 false，于是「库不可用」被如实报成「目标不存在或不属于该账号」。
   * 那句话是谎，且编译期与测试都看不见它。
   */
  const curatedTarget = new CuratedTargetAuthorityHttpClient(...contentArgs);

  /**
   * 精选读的抛出物归类。**两类都要认**：跨端口来的是 `ContentPortError`，
   * 单体属主存储抛的是它自己那个缺表错误 —— 只认前一类今天恒 false，只认后一类拆完恒 false。
   * 认不出来的照原样抛（逐字照单体：不认识的错误 MUST NOT 被压成一句「稍后重试」）。
   */
  const curatedReadUnavailable = (err: unknown): boolean =>
    curatedContentFailureReason(err) !== 'unclassified_error';

  const delegatedTaskService = new DelegatedTaskService({
    store: delegatedTaskStore,
    // 账号候选：一次全量目录读 + 那一份共享翻译。**MUST NOT 在这里重写一遍**——
    // 单体组装根用的是同一个函数，两份漂开的现形时刻是「按昵称选号」真被用到的那一刻。
    listAccounts: () => listDelegatedAccountCandidates(apiClients.accountRoster),
    prepareTarget: async (intent, account) => {
      if (
        intent.action === 'approve_candidate'
        || intent.action === 'reject_candidate'
        || intent.action === 'modify_candidate'
      ) {
        const recordId = Number(intent.targetConstraints?.candidateId);
        if (!Number.isInteger(recordId) || recordId <= 0) {
          return { ok: false, code: 'candidate_target_required', message: '请提供有效候选稿编号。' };
        }
        const draft = await apiClients.automationPublishLog.loadForDispatch(recordId);
        if (!draft || draft.accountId !== account.accountId || draft.platform !== account.platform) {
          return {
            ok: false,
            code: 'candidate_not_found_or_mismatch',
            message: '候选稿不存在或不属于该账号/平台。',
          };
        }
        if (draft.status !== 'pending_approval') {
          return {
            ok: false,
            code: 'candidate_not_pending',
            message: `候选稿当前状态为 ${draft.status}，不能创建该操作。`,
          };
        }
        return {
          ok: true,
          targetConstraints: {
            ...(intent.targetConstraints ?? {}),
            candidateId: String(recordId),
            candidateVersion: draft.contentVersion,
            candidateTitle: draft.title ?? '',
          },
        };
      }
      if (intent.action === 'comment_curated') {
        const curatedId = Number(intent.targetConstraints?.curatedId);
        let row: CuratedPanelRow | null = null;
        try {
          row = Number.isInteger(curatedId)
            ? await curatedTarget.getOneForAccount(curatedId, account.accountId)
            : null;
        } catch (err) {
          // 库不可用（可重试）：MUST NOT 复用 curated_target_unavailable —— 那句是「这行不存在」= 谎。
          if (curatedReadUnavailable(err)) {
            return {
              ok: false,
              code: 'curated_content_unavailable',
              message: '精选内容存储暂不可用，请稍后重试。',
            };
          }
          throw err;
        }
        if (!row || (row.contentType !== 'image_text' && row.contentType !== 'video') || !row.title?.trim()) {
          return {
            ok: false,
            code: 'curated_target_unavailable',
            message: '指定精选内容不存在、归属不符或缺少可定位标题。',
          };
        }
        return {
          ok: true,
          targetConstraints: {
            ...(intent.targetConstraints ?? {}),
            curatedId,
            noteId: row.sourceId,
            title: row.title,
          },
        };
      }
      return { ok: true };
    },
    validateTarget: async (task) => {
      if (
        task.action === 'approve_candidate'
        || task.action === 'reject_candidate'
        || task.action === 'modify_candidate'
      ) {
        const recordId = Number(task.targetConstraints.candidateId);
        const expectedVersion = Number(task.targetConstraints.candidateVersion);
        const draft = await apiClients.automationPublishLog.loadForDispatch(recordId);
        if (!draft || draft.accountId !== task.accountId || draft.platform !== task.platform) {
          return {
            ok: false,
            code: 'candidate_not_found_or_mismatch',
            message: '候选稿已不存在或归属/平台已变化。',
          };
        }
        if (draft.contentVersion !== expectedVersion) {
          return {
            ok: false,
            code: 'candidate_version_conflict',
            message: `候选稿已更新到 v${draft.contentVersion}，请重新确认。`,
          };
        }
      }
      const curatedId = Number(task.targetConstraints.curatedId ?? task.sourceConstraints.curatedId);
      if (Number.isInteger(curatedId) && curatedId > 0) {
        let row: CuratedPanelRow | null = null;
        try {
          row = await curatedTarget.getOneForAccount(curatedId, task.accountId);
        } catch (err) {
          // 同上：MUST NOT 复用 curated_target_changed —— 那句是「已删 / 已变」= 谎。
          if (curatedReadUnavailable(err)) {
            return {
              ok: false,
              code: 'curated_content_unavailable',
              message: '精选内容存储暂不可用，请稍后重试。',
            };
          }
          throw err;
        }
        if (
          !row
          || row.sourceId !== String(task.targetConstraints.noteId ?? task.sourceConstraints.sourceId ?? '')
        ) {
          return {
            ok: false,
            code: 'curated_target_changed',
            message: '精选目标已删除或身份发生变化，不能改选相似内容。',
          };
        }
      }
      return { ok: true };
    },
  });

  /**
   * 运营指令的幂等台账。**单独 try、不并进上面那条链**（逐字照单体的裁定）：
   * 它失败 MUST NOT 把整个委托控制面拖下水 —— 既有 7 方法压根不用台账（各自有版本号乐观锁），
   * 让「台账表出问题」把委托任务管理一起掐掉，是把一个无关能力的故障放大成一片。
   * 失败时换成具名 fail-closed 台账：自由文本那条带原因拒收，7 方法照常。
   */
  let operatorCommandLedger: OperatorCommandLedger;
  try {
    const pgLedger = new PgOperatorCommandLedger({ executionTarget, pool: ownerPool });
    await pgLedger.init();
    operatorCommandLedger = pgLedger;
  } catch (err) {
    const reason = (err as Error).message;
    operatorCommandLedger = unavailableOperatorCommandLedger(reason);
    logger.warn(
      '[aidcp-automation] 运营指令幂等台账不可用 → 自由文本委托带具名原因拒收'
      + `（既有 7 方法不受影响）：${reason}`,
    );
  }

  const delegatedTaskCommandPort = new DelegatedTaskCommandReceiver({
    service: delegatedTaskService,
    ledger: operatorCommandLedger,
  });
  registerDelegatedTaskRoutes(
    root.internalServer,
    delegatedTaskCommandPort,
    config.automationInternalToken,
    executionTarget,
  );
  registerDelegatedTaskTextCommandRoutes(
    root.internalServer,
    delegatedTaskCommandPort,
    config.automationInternalToken,
    executionTarget,
  );

  // ── 2. 配置副本停手闸 ────────────────────────────────────────────────────
  const configMirrorGate = createAutomationConfigMirrorGate({ mirrors, logger });

  // ── 2b. 模型用量的合并缓冲 ───────────────────────────────────────────────
  // 家在这里、不在模型出口工厂里：工厂只留缝（`onCall`），缓冲的生命周期归进程。
  // **周期表在业务入口放行之后才起**，与本仓其余各片一致。
  const llmUsageBuffer = createAutomationLlmUsageBuffer({ sink: llmUsageRecording, logger });

  // ── 3. 模型出口（⚠️ 构造期起角色模型轮询，归还在 dispose） ──────────────────
  const modelExit = await createAutomationModelExit({
    apiHttp,
    env,
    logger,
    // 用量记账挂在这里。**这个回调跑在模型调用的完成路径上**，所以缓冲那一侧的 `record`
    // 是同步且绝不抛的 —— 往这条路径上抛异常就是让记账把正事拖垮。
    onCall: (info) => llmUsageBuffer.record(info),
  });

  // ── 4. 风控底座（⚠️ 构造期抢写者锁，归还在 dispose） ───────────────────────
  const riskFoundation = await createAutomationRiskFoundation({
    ownerPool,
    executionTarget,
    ownership: apiClients.accountOwnership,
    mirrorStale: (mirrorKey) => configMirrorGate.isStale(mirrorKey),
    // 环一：记账漏斗此刻还没建。**启动期窗口内恒判「未断链」**，与漏斗自己写明的
    // 回落语义一致（漏斗没起来时 `blocked()` 恒 false）。这是启动期窗口，不是常态。
    accountingBlocked: (accountId) => accountingRef.peek()?.blocked(accountId) ?? false,
    logger,
  });

  // ── 5. 记账漏斗（⚠️ 构造期起三张周期表，归还在 dispose） ───────────────────
  const riskAccounting = await createAutomationRiskAccounting({
    ownerPool,
    executionTarget,
    registry: riskFoundation.riskRegistry,
    riskStore: riskFoundation.riskStore,
    raiseAlert: riskFoundation.raiseAlert,
    logger,
  });
  accountingRef.set(riskAccounting);

  // ── 6. 配置面审计中继（定时器留到 start()） ────────────────────────────────
  const auditRelay = createAutomationConfigAuditRelay({
    pool: ownerPool,
    executionTarget,
    auditWrites: apiClients.interactionApiWrites,
    logger,
  });

  // ── 6b. 每连接运行时（`buildDispatcher` 与关边缘都用晚绑定） ────────────────
  const connectionRuntime: AutomationConnectionRuntime = createAutomationConnectionRuntime({
    // **与边缘接入同一个总线实例**：自建第二个会得到「两条总线各自都对」的静默分裂。
    observerBus: eventBus,
    riskRegistry: riskFoundation.riskRegistry,
    buildDispatcher: (context) => dispatcherFactoryRef.get()(context),
    accountRuntime: apiClients.accountRuntime,
    closeEdge: (sessionId) => edgeAccessRef.get().server.closeEdge(sessionId),
    notifications: { deliver: (input) => root.structuredDeliver.deliver(input) },
    ownership: {
      executionTarget,
      port: apiClients.accountOwnership,
      raiseAlert: riskFoundation.raiseAlert,
    },
    env,
    logger,
  });

  // ── 7. Facebook 两套运行时 ───────────────────────────────────────────────
  const facebookRuntime = await createAutomationFacebookRuntime({
    runtimePool: ownerPool,
    executionTarget,
    schemaProber: probeSchemaShape,
    logger,
  });

  // ── 8. 业务配置取值口 ────────────────────────────────────────────────────
  const businessConfig = createAutomationBusinessConfigPorts({
    mirrors,
    // 与发布下发、每连接调度器取的是**同一个**会话配置实例。
    globalActiveWeekMask: () => sessionConfigStore.weekActiveMask(),
  });

  // ── 9. 评论审批与通知口 ──────────────────────────────────────────────────
  const commentApproval = createAutomationCommentApprovalPorts({
    deliverStructuredNotification: deliverStructuredNotification,
    approvalPolicy: apiClients.commentApprovalPolicy,
    // 人审端口靠它判「批了没有」。**取授权权威、不是发布日志**：后者答不了这个问题。
    publishApproval: {
      read: (requestId) =>
        publishApprovalAuthority.getApproval({ requestId, executionTarget }),
      markConsumed: (requestId, revision) =>
        publishApprovalAuthority.markConsumed({
          requestId,
          executionTarget,
          expectedRevision: Number(revision),
        }),
    },
    approvalEnabled: env.AIDCP_COMMENT_APPROVAL === 'true',
    valuableCommentStore: riskFoundation.valuableCommentStore,
    logger,
  });

  // ── 10. 评论 / 加群调度器 ────────────────────────────────────────────────
  const commentScheduler = createAutomationCommentSchedulerPorts({
    runtimes: connectionRuntime.runtimes,
    pusher: {
      // 评论调度器那条口把信封声明成 `unknown`（它刻意不依赖协议类型），而服务端要 `Envelope`。
      // 这里**收窄时带一道守卫**，不写裸强转：裸强转会让「有人推了个不是信封的东西」
      // 一路走到传输层才现形（那时只剩一行 JSON 序列化错误，看不出是谁推的）。
      pushToEdges: (envelope, edgeId) =>
        edgeAccessRef.get().server.pushToEdges(assertEnvelope(envelope), edgeId),
    },
    edgeTaskLeases: {
      withLease: (...args) => edgeAccessRef.get().edgeTaskLeases.withLease(...args),
    },
    getSoul: (accountId) => requirePersonaSoul(mirrors, accountId),
    personaBinding: (accountId) => personaBindingFor(mirrors, accountId),
    llm: modelExit.client,
    curatedSelection: { state: 'wired', port: contentClients.curatedSelection },
    risk: {
      resolveController: (accountId) => riskFoundation.resolveController(accountId),
      recordRiskFact: (accountId, action, dedupeKey) =>
        riskAccounting.recordRiskFact(accountId, action, dedupeKey),
      hasInteraction: (accountId, noteId, action) =>
        riskFoundation.riskStore.hasInteraction(accountId, noteId, action),
      recordInteraction: (accountId, noteId, action) =>
        riskFoundation.riskStore.recordInteraction(accountId, noteId, action, Date.now()),
    },
    approvalPorts: commentApproval,
    accountRuntime: apiClients.accountRuntime,
    automationConfigCommands: apiClients.automationConfigCommands,
    deliverStructuredNotification,
    businessConfig,
    facebookStores: {
      targets: facebookGroupTargets,
      memberships: facebookGroupMemberships,
      joinAudit: facebookGroupJoinAudit,
      commentAudit: facebookCommentAudit,
    },
    // **用户已裁定暂不接**（接口域配置表，本进程既无同步读流也无 HTTP 口，而协调器要的是同步取用）。
    // 缺席后果写明：本进程的 Facebook 覆盖评论**一条都不会发**。这是显式缺席，不是漏传。
    groupCommentPolicy: {
      state: 'unavailable',
      reason: 'group_comment_policy_not_wired_by_adjudication',
    },
    accountPause: {
      state: 'wired',
      port: {
        pause: (accountId, reason) =>
          apiClients.accountRuntime.pauseAccount(accountId, reason),
      },
    },
    scheduledTaskFeedback: {
      state: 'wired',
      port: {
        // ⚠️ 口是**同步**的、客户端是异步的 ⇒ 这里是转接层，不是直通。
        // 回报失败只留痕：名额没还回去是运营层面的损失，但**绝不能**因此把调度链拖住。
        reportNotStarted: (accountId, action, reason) => {
          void apiClients.scheduleFeedback
            .reportScheduledTaskNotStarted(accountId, action, reason)
            .catch((error: unknown) =>
              logger.warn(
                `[aidcp-automation] 排期名额回程失败 account=${accountId} action=${action}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ),
            );
        },
      },
    },
    env,
    logger,
  });

  // ── 11. Facebook 消费协调器 ──────────────────────────────────────────────
  const facebookCoordinator = createAutomationFacebookCoordinator({
    consumptionStore: facebookRuntime.consumptionStore,
    executors: commentScheduler.executors,
    // 与评论调度器**同一个实例**。
    memberships: facebookGroupMemberships,
    // 与评论调度器**同一个口**：两片各拿一份会让「预热多久」在同一进程里有两个答案。
    groupCommentPolicy: {
      state: 'unavailable',
      reason: 'group_comment_policy_not_wired_by_adjudication',
    },
    configMirrorGate,
    facebookOperationBaseFor: (accountId) => businessConfig.facebookOperationBaseFor(accountId),
    risk: {
      resolveController: (accountId) => riskFoundation.resolveController(accountId),
      resolvedController: (accountId) =>
        riskFoundation.resolvedController(accountId) ?? null,
    },
    logger,
  });

  // ── 12. 每连接角色调度器工厂（边缘侧字段用晚绑定） ─────────────────────────
  /**
   * 角色工厂表。
   *
   * 这张表当初存在的理由是「这四个角色属 content，automation 不能静态 import」——
   * 而 task 0.7 已把四个角色类改判 automation、它们就在本仓。**表仍然留着**，因为
   * 角色注册表今天还扛着一道真检查（2026-07-23 审计坐实过一次回归）；
   * 要拆得先想清楚那道检查搬去哪，不在本片顺手做。
   */
  const roleFactories: RoleFactoryRegistry = {
    concept_extractor: (o: ConceptExtractorFactoryOptions) => new ConceptExtractorRole(o),
    valuable_comment_archivist: (o: ValuableCommentArchivistFactoryOptions) =>
      new ValuableCommentArchivist(o),
    curated_note_evaluator: (o: CuratedNoteEvaluatorFactoryOptions) => {
      const { curatedStore, textCardTranscriber: transcriber, ...rest } = o;
      // **两跳，不是一跳**（task 0.6d / 2.4b）：先把 opaque 句柄断言成**跨属主写口**，
      // 再靠赋值给 `CuratedNoteSink` 做结构核对。直接 `as CuratedNoteSink` 是一次无检查的转换，
      // Sink 上任何方法缺失都过得去 —— 而本进程给的正是 HTTP 客户端那一种实现。
      const noteSink: CuratedNoteSink = curatedStore as CuratedWritePort;
      return new CuratedNoteEvaluator({
        ...rest,
        curatedStore: noteSink,
        // 三态显式化：句柄在 → wired；句柄缺 → **明说「依赖没接上」**，绝不省略字段。
        // 省略会在角色内退化成 `transcriber?.enabled()` 的假，与「旗标关掉了」长得一模一样。
        textCardTranscriber: transcriber
          ? { state: 'wired', transcriber: transcriber as TextCardTranscriber }
          : { state: 'unavailable', reason: 'not_wired_by_composition_root' },
      });
    },
    curated_comment_evaluator: (o: CuratedCommentEvaluatorFactoryOptions) => {
      const { curatedStore, ...rest } = o;
      const commentSink: CuratedCommentSink = curatedStore as CuratedWritePort;
      return new CuratedCommentEvaluator({ ...rest, curatedStore: commentSink });
    },
  };
  const dispatcherDeps: AutomationDispatcherDeps = {
    configMirrorGate,
    llm: modelExit.client,
    getSoul: (accountId?: string): Soul => requirePersonaSoul(mirrors, accountId),
    // 节奏兜底：薄壳，边缘接入建成之后才解引用（环二）。
    pacingFloors: { floorFor: (op) => edgeAccessRef.get().pacingFloors.floorFor(op) },
    edgeTaskLeases: {
      acquire: (input) => edgeAccessRef.get().edgeTaskLeases.acquire(input),
      release: (input) => edgeAccessRef.get().edgeTaskLeases.release(input),
    },
    sessionLimitProvider: sessionConfigStore,
    resumeConfigProvider: resumeConfigStore,
    conceptStore: contentClients.conceptPool,
    curatedStore: curatedWrite,
    textCardTranscriber: textCardTranscriber,
    // content 层角色工厂表：四个角色类已随 task 0.7 改判 automation、就在本仓。
    roleFactories,
    personaBinding: (accountId: string): PersonaBinding =>
      personaBindingFor(mirrors, accountId),
    getNickname: (accountId: string) => knownNicknames.get(accountId) ?? null,
    setNickname: async (accountId: string, nickname: string) => {
      await apiClients.accountRuntime.recordNickname(accountId, nickname);
      knownNicknames.set(accountId, nickname);
    },
    isDispatchActive: () => dispatchActive,
    onSessionRejected: (accountId: string, reason: string) => {
      logger.warn(
        `[aidcp-automation] 账号 ${accountId} ${reason}：未绑人设，拒绝启动浏览会话`,
      );
    },
    // **按连接账号路由到团队群**：来源账号由调用点现推，供给方 MUST NOT 写死
    // —— 写死会让所有账号的入站消息都落到默认群，运营再也分不出这条是谁的。
    notifyComments: async (items, accountId) => {
      await deliverStructuredNotification(
        { kind: 'notification_inbox', accountId, items },
        `notification-inbox-${accountId}-${Date.now()}`,
      );
    },
    isHardPaused: (edgeId?: string) =>
      edgeId ? edgeAccessRef.get().server.isEdgePaused(edgeId) : false,
    sendCommand: (command, edgeId, accountId) => {
      const envelope = edgeCommandToEnvelope(command);
      const sent = edgeAccessRef.get().server.pushToEdges(envelope, edgeId);
      logger.log(
        `[RoleDispatcher] sendCommand account=${accountId} edgeId=${edgeId ?? '-'}` +
          ` action=${(command as { action?: string }).action ?? '-'} sent=${sent}`,
      );
    },
    interactionGuardFor: (accountId: string) =>
      connectionRuntime.interactionGuards.forAccount(accountId),
    // **单例共享**，内部按账号分桶：每连接一个会让同账号多连接各自不受约束。
    cooldownGate: connectionRuntime.actionCooldown,
    hasCommentedForLead: (accountId: string, noteId: string) =>
      riskFoundation.riskStore
        .hasInteraction(accountId, noteId, 'comment')
        .catch(() => false),
    notificationContacts: apiClients.notificationContacts,
    businessConfig,
    comment: {
      ...commentApproval,
      ...commentScheduler.ports,
    },
    facebookRuntime: {
      ...facebookRuntime.ports,
      coordinator: facebookCoordinator.port,
    },
    logger,
  };
  dispatcherFactoryRef.set(createAutomationDispatcherFactory(dispatcherDeps));

  // ── 13. 互动能力（真环：本能力 ↔ 边缘接入，用晚绑定薄壳破） ────────────────
  const interactionEdge = createLateBoundInteractionEdgeBinding();
  const interaction = await createAutomationInteraction({
    ownerPool,
    executionTarget,
    api: {
      authGate: apiClients.interactionAuth,
      replyConfig: apiClients.replyConfig,
      revocationHold: apiClients.offboardAdmissionLedger,
      apiWrites: apiClients.interactionApiWrites,
      accountRuntime: apiClients.accountRuntime,
    },
    content: { replyAi },
    risk: {
      controllerFor: (accountId) => riskFoundation.resolveController(accountId),
    },
    edge: interactionEdge.binding,
    env,
    logger,
  });

  // ── 14. 边缘接入 ⇒ 回填 12 / 13 / 13b 的薄壳 ──────────────────────────────
  const edgeAccess = await createAutomationEdgeAccess({
    ownerPool,
    port: Number(env.AIDCP_WS_PORT ?? 8787),
    llm: modelExit.client,
    eventBus,
    mirrors,
    configMirrorGate,
    risk: {
      resolveController: (accountId) => riskFoundation.resolveController(accountId),
      raiseAlert: riskFoundation.raiseAlert,
      alertStore: riskFoundation.alertStore,
    },
    // 漏斗没起来时**字段省略**（工厂如实答 undefined）⇒ 处理器保持改动前行为：
    // 直接 emit、记账由订阅者承担。这是单体写明的回落，不是能力静默消失。
    ...(riskAccounting.edgeHandlerPort()
      ? { riskAccounting: riskAccounting.edgeHandlerPort()! }
      : {}),
    personaService: apiClients.accountPersona,
    edgePublish: {
      decidePublishApproval: (input) =>
        apiClients.edgePublish.decidePublishApproval(input),
      removeDraftImage: (input) => apiClients.edgePublish.removeDraftImage(input),
    },
    notifications: { deliver: (input) => root.structuredDeliver.deliver(input) },
    environmentRegistry: apiClients.environmentHandshake,
    runtime: connectionRuntime.runtimes,
    uiSnapshot: {
      pushHelloSnapshot: (accountId, edgeId, capabilities) =>
        publishDispatchRef.get().uiSnapshot.pushHelloSnapshot(accountId, edgeId, capabilities),
    },
    interaction: interaction.support,
    env,
    logger,
  });
  edgeAccessRef.set(edgeAccess);
  interactionEdge.bind(edgeAccess.server);

  // ── 15. 发布下发 ⇒ 回填 14 的界面快照薄壳 ─────────────────────────────────
  const publishDispatch = await createAutomationPublishDispatch({
    ownerPool,
    executionTarget,
    sessionConfig: sessionConfigStore,
    edge: {
      pushToEdges: (envelope, edgeId) => edgeAccess.server.pushToEdges(envelope, edgeId),
      resolveEdgeIdForAccount: (accountId, capability) =>
        edgeAccess.server.resolveEdgeIdForAccount(accountId, capability),
      edgeCapabilities: (edgeId) => edgeAccess.server.edgeCapabilities(edgeId),
      isEdgePaused: (edgeId) => edgeAccess.server.isEdgePaused(edgeId),
    },
    commandSequencer: edgeAccess.commandSequencer,
    edgeTaskLeases: edgeAccess.edgeTaskLeases,
    risk: {
      getController: (accountId) => riskFoundation.resolveController(accountId),
      totalsForAccountSince: (accountId, since) =>
        riskFoundation.riskStore.totalsForAccountSince(accountId, since),
      todayTotalsForAccount: (accountId) =>
        riskFoundation.riskStore.todayTotalsForAccount(accountId),
      recordRiskFact: (accountId, action, dedupeKey) =>
        riskAccounting.recordRiskFact(accountId, action, dedupeKey),
    },
    runtime: connectionRuntime.runtimes,
    publishLog: apiClients.automationPublishLog,
    // 人审端口靠它判「批了没有」。**取授权权威、不是发布日志**：后者答不了这个问题。
    // 授权权威的两种取用面。**逐个方法转接、不整体强转**：属主客户端收的是信封对象，
    // 下发器要的是位置参数；强转能编过，但属主哪天多 / 少一个字段就再也没人会说话了。
    publishApproval: {
      readApproval: async (requestId) => {
        const view = await publishApprovalAuthority.getApproval({ requestId, executionTarget });
        return view
          ? {
              approved: view.approved,
              contentVersion: view.contentVersion,
              revision: view.revision,
              dispatchState: view.dispatchState,
              dispatchBlockedReason: view.dispatchBlockedReason,
            }
          : null;
      },
      voidApproval: (requestId, expectedRevision, reason) =>
        publishApprovalAuthority.voidApproval({
          requestId,
          executionTarget,
          expectedRevision,
          reason: reason as ApprovalVoidReason,
        }),
      markDispatching: (requestId, expectedRevision) =>
        publishApprovalAuthority.markDispatching({ requestId, executionTarget, expectedRevision }),
      markConsumed: (requestId, expectedRevision) =>
        publishApprovalAuthority.markConsumed({ requestId, executionTarget, expectedRevision }),
      releaseToPending: (requestId, expectedRevision, blockedReason) =>
        publishApprovalAuthority.releaseToPending({
          requestId,
          executionTarget,
          expectedRevision,
          blockedReason,
        }),
      setBlockedReason: (requestId, expectedRevision, reason) =>
        publishApprovalAuthority.setBlockedReason({
          requestId,
          executionTarget,
          expectedRevision,
          reason,
        }),
      // 属主那条列表口**没有 envKey 参数**，回来的视图上才有这个字段 ⇒ 在这里过滤。
      // 传了 envKey 就必须真过滤：不过滤会把别的环境的待下发也算进本机窗口。
      listPendingDispatch: async (target, envKey, subjectKind) => {
        const views = await publishApprovalAuthority.listPendingDispatch({
          executionTarget: target,
          subjectKind,
        });
        return views
          .filter((view) => envKey === undefined || view.envKey === envKey)
          .map((view) => ({ requestId: view.requestId, approved: view.approved }));
      },
    },
    approvalAuthority: publishApprovalAuthority,
    // `sourceId` 两侧形状不同（属主答 `string | null`，下发器读 `string | undefined`）：
    // 这里显式转接，**不整体强转** —— 强转会把「以后属主再多 / 少一个字段」一起静音掉。
    firstPostProgress: {
      getFirstPostProgress: async (accountId) => {
        const row = await apiClients.firstPostProgress.getFirstPostProgress(accountId);
        if (!row) return null;
        return {
          state: row.state,
          startedAt: row.startedAt,
          ...(row.sourceId === null ? {} : { sourceId: row.sourceId }),
        };
      },
    },
    mirrors,
    media: { state: 'wired', port: facebookPublishMedia },
    notifications: { deliver: (input) => root.structuredDeliver.deliver(input) },
    env,
    logger,
  });
  publishDispatchRef.set(publishDispatch);

  // ── 15b. 发帖触发器（内容生成链的唯一消费方） ──────────────────────────────
  //
  // **内容生成在另一个进程里。** 本进程只管「什么时候该发、以谁的身份发、发不发得成」，
  // 真正的创作管线住在内容进程；两边靠那条「同步 kick + 分段 long-poll」接。
  // **接之前去 `aidcp-content` 的 `main()` 里确认过那条路由无条件注册**
  //（`registerPublishGenerationRoutes(httpServer, publishOrchestrator)`），不是「客户端建得出来就算」。
  //
  // ⚠️ **单次调用超时必须 > 分段 long-poll 预算**（150s），否则每一段 poll 都会在服务端回
  // `{done:false}` 之前先被客户端切断 ⇒ 每次跨进程生成都在默认 15s 确定性失败。取内部 HTTP 那个
  // 180s 硬顶（与模型调用天花板同源的既有常量，不新写魔数）。
  //
  // **本进程刻意没有「本地编排器」回落**：单体那条 local 分支取的是内容段构造的编排器，而本进程
  // 根本不跑内容段。给它回落只会得到「启动日志说已就绪、每次发帖在调用点炸」，而排期发帖的小时格
  // 幂等票**在触发前就已认领** —— 失败一次就烧掉那一小时。
  const publishGeneration = new PublishGenerationHttpClient(
    new InternalHttpClient(config.contentBaseUrl, {
      timeoutMs: INTERNAL_HTTP_TIMEOUT_CEILING_MS,
    }),
  );

  /**
   * 发帖触发器。**点赞素材库缺席时具名不建**（逐字照单体：概念池 / 点赞库任一不可用就不建），
   * 而不是塞一个空桩 —— 空桩会让「素材库没起来」表现成「最近没有可用素材」，两者的处置完全相反。
   */
  const publishScheduler = riskFoundation.likedNoteStore
    ? new PublishScheduler({
        conceptStore: contentClients.conceptPool,
        likedStore: riskFoundation.likedNoteStore,
        publishLog: apiClients.automationPublishLog,
        resolveRisk: (accountId) => riskFoundation.resolveController(accountId),
        /**
         * 「唯一真实账号」：恰好一个才返回它，0 或多个返回 null。
         * **读失败照旧回 null、不抛**（逐字照单体）：调用方据此如实「无法解析唯一真实账号 — 跳过」；
         * 抛出去会被上层归一成一次失败发帖。
         */
        resolveSingleAccountId: async () => {
          try {
            const rows = await apiClients.accountRoster.listAccountIdentities();
            return rows.length === 1 ? rows[0].accountId : null;
          } catch (err) {
            logger.warn(
              `[aidcp-automation] resolveSingleAccountId 失败：${(err as Error).message}`,
            );
            return null;
          }
        },
        // 缺账号回落小红书**是属主那条读自己的既有口径**，这里逐字保持；
        // MUST NOT 借这次搬运顺手改语义。
        getPlatform: async (accountId) =>
          (await apiClients.accountRuntime.getPlatformOrNull(accountId)) ?? 'xiaohongshu',
        // 人设三态闸：`unknown`（副本陈旧，可重试）与 `unbound`（真没绑，终态）MUST 分开 ——
        // 压成一个会把「等一下再试」变成「这个账号永远不能发」。判定取共享那一份。
        personaBinding: (accountId) => personaBindingFor(mirrors, accountId),
        orchestrator: publishGeneration,
        curatedStore: contentClients.curatedSelection,
        selectTopK: resolveCuratedGateConfig().selectTopK,
        getSoul: (accountId) => requirePersonaSoul(mirrors, accountId),
        conceptThreshold: Number(env.AIDCP_PUBLISH_CONCEPT_THRESHOLD ?? 20),
        minHoursBetween: Number(env.AIDCP_PUBLISH_MIN_HOURS ?? 24),
        countPendingForAccount: (accountId) =>
          apiClients.automationPublishLog.countPendingForAccount(accountId),
        pendingCapPerAccount: Number(env.AIDCP_PUBLISH_PENDING_CAP_PER_ACCOUNT ?? 20),
        maxConcurrentRuns: Number(env.AIDCP_PUBLISH_MAX_CONCURRENT_RUNS ?? 3),
        logger,
      })
    : undefined;

  // ── 15c. 委托任务执行器（发帖触发器的真消费方） ────────────────────────────
  //
  // **没有它，委托任务就是「能建、能确认、永远不跑」**，而那个状态从外部看不出来：
  // 确认卡照发、任务照进队列。所以缺席必须**具名**（见下面那条 else）。
  //
  // 授权决定写**必须经 api 属主那条口**：本进程没有、也不该有授权表的连接。
  // 那条路由接口进程已经注册，用的是授权专用令牌（与上面那个授权权威同一把）。
  const publishApprovalDecisionWriter = new PublishApprovalDecisionWriterHttpClient(
    apiHttp,
    config.publishApprovalInternalToken,
  );
  let delegatedTaskWorker: DelegatedTaskWorker | undefined;
  if (publishScheduler) {
    /** 候选稿快照：委托层判「还是不是那一稿」的唯一依据，字段逐条照单体。 */
    const loadCandidate = async (recordId: number) => {
      const draft = await apiClients.automationPublishLog.loadForDispatch(recordId);
      if (!draft) return null;
      const platform = draft.platform ?? 'xiaohongshu';
      // 视频号在本会话里刻意只做收件箱，不进主动发布域。
      if (platform === 'wechat_channels') return null;
      return {
        recordId: draft.recordId,
        accountId: draft.accountId,
        platform,
        status: draft.status,
        contentVersion: draft.contentVersion,
        title: draft.title,
        content: draft.content,
        images: draft.imageUrls,
        userRejected: hasUserRejectionEvidence(draft.metadata),
      };
    };
    /** 授权决定：四个入参照单体拼；`decidedBy` MUST 是真实决策主体，不用常量占位。 */
    const writeApprovalDecision = (
      requestId: string,
      approved: boolean,
      draft: DispatchDraft,
      decidedBy: string,
    ) => {
      const topics = draft.metadata?.topics;
      const tags = Array.isArray(topics)
        ? topics.filter((item): item is string => typeof item === 'string')
        : [];
      return publishApprovalDecisionWriter.writeDecision({
        requestId,
        approved,
        payload: {
          title: draft.title ?? '',
          content: draft.content,
          tags,
          contentVersion: draft.contentVersion,
        },
        context: { decidedBy, decidedVia: 'delegated_task' },
        executionTarget,
      });
    };
    const delegatedExecutors = createDelegatedExecutorRouter({
      comments: commentScheduler.executors.comment,
      publishes: publishScheduler,
      loadCandidate,
      approveCandidate: async (candidate, decidedBy) => {
        const draft = await apiClients.automationPublishLog.loadForDispatch(candidate.recordId);
        // 版本对不上 = 这一稿已经变了；**照原样回读、不写决定**（写下去就是给旧稿盖章）。
        if (!draft || draft.contentVersion !== candidate.contentVersion) {
          return loadCandidate(candidate.recordId);
        }
        const requestId = `publish-${candidate.recordId}`;
        const preflight = await publishDispatch.preflightApprovePublish(requestId);
        if (!preflight.ok) throw new Error(`candidate_deferred:${preflight.reason}`);
        const result = await writeApprovalDecision(requestId, true, draft, decidedBy);
        if (!result.written && result.alreadyDecided !== true) {
          throw new Error('candidate_already_rejected');
        }
        // 已经批过一次：**补触发一次下发**（那条决定可能落在下发之前）。
        if (!result.written && result.alreadyDecided === true) {
          await publishDispatch.triggerPublishDispatchOnApprove(
            requestId,
            result.revision,
            'human_reconfirm',
          );
        }
        return loadCandidate(candidate.recordId);
      },
      rejectCandidate: async (candidate, decidedBy) => {
        const draft = await apiClients.automationPublishLog.loadForDispatch(candidate.recordId);
        if (!draft || draft.contentVersion !== candidate.contentVersion) {
          return loadCandidate(candidate.recordId);
        }
        const requestId = `publish-${candidate.recordId}`;
        const result = await writeApprovalDecision(requestId, false, draft, decidedBy);
        if (!result.written && result.alreadyDecided !== false) {
          throw new Error('candidate_already_approved');
        }
        await apiClients.automationPublishLog.rejectPendingApproval(candidate.recordId);
        publishDispatch.notifyPublishRejected(requestId);
        return loadCandidate(candidate.recordId);
      },
      modifyCandidate: async (candidate, patch) => {
        const result = await apiClients.automationPublishLog.editDraft(
          candidate.recordId,
          candidate.contentVersion,
          patch,
          'delegated-task',
        );
        if (!result.ok) throw new Error(`candidate_edit_${result.reason}`);
        publishDispatch.refreshPublishPreview(candidate.recordId);
        return loadCandidate(candidate.recordId);
      },
      terminalWaitMs: Number(env.AIDCP_DELEGATED_TASK_TERMINAL_WAIT_MS ?? 4 * 60_000),
    });
    const delegatedTaskNotificationGate = new DelegatedTaskNotificationGate();
    delegatedTaskWorker = new DelegatedTaskWorker({
      store: delegatedTaskStore,
      executorFor: delegatedExecutors.executorFor,
      externalBusy: delegatedExecutors.externalBusy,
      platformStillMatches: async (task) =>
        (await apiClients.accountRuntime.getPlatformOrNull(task.accountId)) === task.platform,
      onTaskUpdated: async (task: DelegatedTask) => {
        // 委托层不主动推进度卡：结果由每类任务自己的业务结果卡承担。
        // 兜底 = **没有独立结果卡的终态失败**补一张，红线是「绝不静默失败」。
        const receipt = delegatedTaskFailureReceipt(task);
        if (!receipt) return;
        if (!delegatedTaskNotificationGate.shouldSend(task)) return;
        // 命令触发的终态卡回来源会话；无来源会话（自动 / 排期 / 旧行）补集式回落账号团队群。
        const originChatId = task.originChatId?.trim();
        const commandLabel = task.actionFamily === 'comment' ? '评论' : '发帖';
        try {
          await deliverStructuredNotification(
            {
              kind: 'command_result',
              input: {
                command: commandLabel,
                ok: false,
                level: receipt.level,
                title: receipt.title,
                message: receipt.message,
                accountId: task.accountId,
                originChatId,
                // 多账号多平台并行时，光有昵称不够定位是哪条线出的事。
                platformName: platformRegistryEntry(task.platform).displayName,
              },
            },
            `delegated-task-result:${task.id}:${task.status}`,
          );
          delegatedTaskNotificationGate.markSent(task);
        } catch (err) {
          logger.warn(
            `[delegated-task] ${commandLabel}失败结果卡发送失败 task=${task.id}: ${(err as Error).message}`,
          );
        }
      },
      maxConcurrent: Math.max(1, Math.trunc(Number(env.AIDCP_DELEGATED_TASK_MAX_CONCURRENT ?? 3))),
      logger,
    });
  } else {
    // **具名缺席，不是静默。** 少了这句，「任务确认了却永远不跑」在外部与
    //「队列里暂时没任务」完全同形 —— 而这两件事的处置完全不同。
    logger.warn(
      '[aidcp-automation] DelegatedTaskWorker 未建（发帖触发器缺席）→ 委托任务可确认但不会执行',
    );
  }


  // ── 15c. 内容排期调度器的被调面 ─────────────────────────────────────────
  //
  // 调度器本身归接口进程（那边的手写 main 构造它），但它每分钟要问的事实与三类真正的扳机
  // 都在本进程。**先注册、后有调用方是对的顺序**：反过来的代价是「客户端建得出来、调用编译
  // 得过、两仓测试各自全绿，只有真把两个进程一起跑起来才 404」——而那个 404 会被读成
  //「对面版本落后」，一个纯接线遗漏冒名顶替了具名原因。本仓在这件事上已经连撞五次。
  //
  // 发布触发器可缺席（概念池 / 点赞库不可用时刻意不建）；那一路 MUST 具名答「未受理」，
  // MUST NOT 假装受理 —— 小时格幂等票在触发前就已认领，假受理一次就烧掉那一小时。
  registerContentSchedulingRoutes(
    root.internalServer,
    createAutomationContentSchedulingPort({
      onlineAccountIdentities: () => connectionRuntime.runtimes.onlineAccountIdentities(),
      resolveController: (accountId) => riskFoundation.resolveController(accountId),
      publishScheduler: publishScheduler ?? null,
      commentScheduler: commentScheduler.executors.comment,
      joinScheduler: commentScheduler.executors.join,
      delegatedOwnership: (accountId, family) =>
        delegatedTaskStore.hasActiveOwnership(accountId, family),
      commentedTodayCount: (accountId) =>
        riskFoundation.riskStore.countInteractionsTodayForAccount(accountId, 'comment'),
      joinedTodayCount: (accountId) => facebookGroupMemberships.countJoinedToday(accountId),
      getPlatform: async (accountId) =>
        (await apiClients.accountRuntime.getPlatformOrNull(accountId)) ?? 'xiaohongshu',
      deliverNotification: deliverStructuredNotification,
      logger,
    }),
    config.automationInternalToken,
    executionTarget,
  );

  // ── 15b. 面板与客户端要问本域的那几族（change deploy-derived-services-to-dev）────────
  //
  // 这几族在 `aidcp-transport` 里**客户端与 registrar 都齐**，本进程却一条都没注册过。
  // 后果不是编译错误：接口进程那边把客户端建得出来、调用点编译得过、两仓测试各自全绿，
  // **只有两个进程真跑起来才 404** —— 而那个 404 会被读成「对面版本落后」。
  // 单体停掉之后，管理后台的风控页 / 配额页 / 告警页 / 群路由页全靠这几条。
  //
  // 顺序同上一段：**先注册、后有调用方**。
  registerRiskReadRoutes(root.internalServer, {
    getState: (accountId) =>
      riskFoundation.riskRegistry.getController(accountId).then((c) => c.getState()),
    effectiveQuotas: (accountId) =>
      riskFoundation.riskRegistry.getController(accountId).then((c) => c.effectiveQuotas()),
    slowStartView: (accountId) =>
      riskFoundation.riskRegistry.getController(accountId).then((c) => c.slowStartView()),
  });
  // 这几个存储此前本进程一个都没建（它们的消费者全在面板那一侧）。都吃本进程的属主池。
  const quotaConfigStore = new QuotaConfigStore({ pool: ownerPool });
  const pacingConfigStore = new PacingConfigStore({ pool: ownerPool });
  const groupRouteStore = new GroupRouteStore({ pool: ownerPool });
  const riskCommandService = new PgRiskCommandService({
    pool: ownerPool,
    // 归属目标构造期钉死，**绝不从请求里推**：推导等于让调用方挑自己写进哪个环境的账。
    executionTarget,
    logger,
  });
  await quotaConfigStore.init();
  await pacingConfigStore.init();
  await groupRouteStore.init();
  registerRiskCommandRoutes(root.internalServer, riskCommandService);
  registerPanelAutomationRoutes(root.internalServer, new PgPanelAutomationRead({ pool: ownerPool }));
  registerGroupRouteRoutes(root.internalServer, groupRouteStore);
  if (riskFoundation.alertStore) {
    registerAlertResolutionRoutes(root.internalServer, riskFoundation.alertStore);
  } else {
    // **缺席具名说出**：告警存储 init 失败与「注册了但没有告警」在面板那一侧完全同形。
    logger.warn(
      '[aidcp-automation] alert-resolution 路由未注册（AlertStore 初始化失败）'
        + ' —— 面板的告警处置按钮会 404，那不是「没有告警」',
    );
  }
  registerPanelConfigRoutes(root.internalServer, {
    quota: createQuotaConfigPanel({ store: quotaConfigStore }),
    pacing: createPacingConfigPanel({ store: pacingConfigStore }),
    session: createSessionLimitPanel({ store: sessionConfigStore }),
    resume: createResumeConfigPanel({ store: resumeConfigStore }),
  });
  // 第七族：Facebook 群组操作面。**与上面六族是同一个形态、同一个后果**——
  // 客户端在接口进程里建得出来（面板的群目录 / 分面 / 区域评论模板 / 进度 / 认领全靠它），
  // registrar 也一直在本仓，只是从来没有人调用过。单体停掉之后，面板的整个群组家族
  // 会从「能出数」变成 500 internal_error（跨进程 no route 被顶层 catch 兜成 500，
  // 连具名的 503 都不是）—— 那正是最难从现象倒推回原因的一种。
  //
  // 十二个方法分住三个存储（目标 / 成员账本 / 加群审计），与单体那一侧逐字同构：
  // 这里 MUST NOT 只挑「面板今天用得到的那几个」注册，端口是闭集合，缺一个就是一条 404。
  registerFacebookGroupOpsRoutes(root.internalServer, {
    listTargets: (options) => facebookGroupTargets.listTargets(options),
    listFacets: () => facebookGroupTargets.listFacets(),
    listRegionCommentTemplates: () => facebookGroupTargets.listRegionCommentTemplates(),
    setRegionCommentTemplates: (region, commentTemplates, updatedBy) =>
      facebookGroupTargets.setRegionCommentTemplates(region, commentTemplates, updatedBy),
    setEnabled: (groupUrl, enabled) => facebookGroupTargets.setEnabled(groupUrl, enabled),
    accountProgress: () => facebookGroupTargets.accountProgress(),
    scopedTargetCountForAccount: (accountId) =>
      facebookGroupTargets.scopedTargetCountForAccount(accountId),
    scopedTargetCountsForAccounts: (accountIds) =>
      facebookGroupTargets.scopedTargetCountsForAccounts(accountIds),
    listAssignments: (limit) => facebookGroupMemberships.listAssignments(limit),
    reclaimStaleAssignments: (ttlMs) =>
      facebookGroupMemberships.reclaimStaleAssignments(ttlMs),
    latestScheduledResult: (accountId) =>
      facebookGroupJoinAudit.latestScheduledResult(accountId),
    latestScheduledResults: (accountIds) =>
      facebookGroupJoinAudit.latestScheduledResults(accountIds),
  });

  // ── 16. 启动外壳 ────────────────────────────────────────────────────────
  const businessIngress: AutomationBusinessIngress = {
    async start() {
      await edgeAccess.start();
      publishDispatch.start();
      auditRelay.start();
      interaction.start();
      llmUsageBuffer.start();
      // 委托任务的执行泵：**就绪闸放行之后**才起。构造期起等于让一个还没放行的进程去认领任务，
      // 而认领是有租约的 —— 认了又不干活，那条任务要等租约过期才轮得到别人。
      // `start()` 自己会先收敛旧进程遗留的 planning/executing claim，再开放泵。
      if (delegatedTaskWorker && env.AIDCP_DELEGATED_TASK_WORKER !== 'false') {
        await delegatedTaskWorker.start(Number(env.AIDCP_DELEGATED_TASK_POLL_MS ?? 5_000));
      } else if (delegatedTaskWorker) {
        // 显式关掉也要说出口：与「没建起来」是两回事，运营看到的现象却一样。
        logger.warn('[aidcp-automation] DelegatedTaskWorker 已按配置禁用（任务可确认但不会执行）');
      }
      // 在途动作恢复扫描：**就绪闸放行之后**才跑（构造期跑等于让一个未放行的进程动数据）。
      await facebookCoordinator.recoverActiveActions();
    },
    async stop() {
      // 逆序停。
      delegatedTaskWorker?.stop();
      auditRelay.stop();
      await publishDispatch.close();
      await edgeAccess.close();
      await connectionRuntime.close();
    },
    async dispose() {
      // 构造期就占住的三样，**无论业务有没有放行都要还**。
      riskAccounting.stop();
      modelExit.stop();
      // 停表 + 最后一次提交。**失败即丢、不重投**（属主侧是累加计数器，重投即翻倍）。
      await llmUsageBuffer.stop();
      await interaction.dispose();
      await facebookRuntime.close();
      // 风控底座：只放写者锁，**绝不碰注入池**。
      await riskFoundation.close();
      // 带 ownsPool 守卫的那一族：注入池时是空操作，安全。
      await sessionConfigStore.close();
      await resumeConfigStore.close();
    },
  };

  const service = await startAutomationService({
    runtime,
    businessIngress,
    schemaGate,
    config,
    ownerPool,
    syncRead: { mirrors },
    env,
    logger,
    ...(options.signals === undefined ? {} : { signals: options.signals }),
    // 复用**已经建好的那个根**：本进程 MUST 只有一个根（一个内部服务端、一套客户端、
    // 一套同步读）。让外壳再建一个不会报错，只会让探活路由与业务口挂在两个根上。
    createRoot: (input) => {
      if (
        input.config !== config ||
        input.runtime !== runtime ||
        input.ownerPool !== ownerPool ||
        input.syncRead?.mirrors !== mirrors
      ) {
        throw new Error(
          'automation_root_reuse_input_mismatch: 启动外壳拿到的建根入参与 main() 用的不是同一批。' +
            '这条断言存在的理由是复用本身没有别的机械保证 —— 入参一漂，进程里就会有两套装配。',
        );
      }
      return root;
    },
  });

  return {
    ...service,
    async close() {
      try {
        await service.close();
      } finally {
        // 传了池就意味着组装根不关它，最后由 `main()` 自己关。
        await ownerPool.end();
      }
    },
  };
}
