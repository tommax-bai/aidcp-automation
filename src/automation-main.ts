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

import { EventBus } from './event-bus/index.js';
import { edgeCommandToEnvelope } from './comm/command-bridge.js';
import type { Envelope } from './comm/protocol.js';
import type {
  ConceptExtractorFactoryOptions,
  CuratedCommentEvaluatorFactoryOptions,
  CuratedNoteEvaluatorFactoryOptions,
  RoleFactoryRegistry,
  ValuableCommentArchivistFactoryOptions,
} from './orchestrator/role-dispatcher.js';
import { InternalHttpClient } from './transport/internal-http.js';
import { AutomationSyncReadMirrors } from './transport/automation-sync-read-mirrors.js';
import { probeSchemaShape } from './schema/schema-capability.js';
import type { AutomationSyncReadRuntimeSources } from './transport/automation-sync-read-source.js';
import {
  CuratedWriteAuthorityHttpClient,
  ReplyAiAuthorityHttpClient,
  TextCardTranscriptionAuthorityHttpClient,
} from './transport/content-authority-http.js';
import { FacebookPublishMediaAuthorityHttpClient } from './transport/content-media-usage-http.js';
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
  const textCardTranscriber = new TextCardTranscriptionAuthorityHttpClient(
    ...contentArgs,
    // 本进程没有本地旗标，能力在不在由**属主侧**答；这里恒报「本地认为开着」，
    // 让客户端按属主的回答走，而不是在两侧各留一个会漂的开关。
    () => true,
    logger,
  );

  // 模型出口用的内部 HTTP 客户端：**指向接口进程**。组装根内部建的那两个都没暴露，
  // 这里建一个交给模型出口（它的注释明说别在模块内自建）。
  const apiHttp = new InternalHttpClient(config.apiBaseUrl);

  // 发布授权权威（api 属主）。**组装根那 17 个客户端里没有它** —— 而发布下发链上有三处要它，
  // 一处都不能用发布日志客户端顶替（发布日志答的是「稿子怎么样了」，授权答的是「批没批、推进到哪一步」）。
  const publishApprovalAuthority = new PublishApprovalAuthorityHttpClient(
    apiHttp,
    config.apiInternalToken,
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
  // ⚠️ 运营那条启停通道**本片不接**：它卡在接口侧签名上，登记在台账条目
  //    `feishu-operator-dispatch-start-stop`。本进程今天恒为「在跑」，这是**已登记的缺口**，
  //    不是遗漏 —— 别在这里塞一个没人能调的接收方去凑「接好了」的样子。
  let dispatchActive = true;
  // 昵称的进程内已知值。**权威在接口域**（属主侧是「比较后写」，这里只是省掉重复写），
  // 重启后为空 ⇒ 首次采集会多写一次幂等写。MUST NOT 把它当权威读口。
  const knownNicknames = new Map<string, string>();

  // ── 2. 配置副本停手闸 ────────────────────────────────────────────────────
  const configMirrorGate = createAutomationConfigMirrorGate({ mirrors, logger });

  // ── 3. 模型出口（⚠️ 构造期起角色模型轮询，归还在 dispose） ──────────────────
  const modelExit = await createAutomationModelExit({ apiHttp, env, logger });

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

  // ── 16. 启动外壳 ────────────────────────────────────────────────────────
  const businessIngress: AutomationBusinessIngress = {
    async start() {
      await edgeAccess.start();
      publishDispatch.start();
      auditRelay.start();
      interaction.start();
      // 在途动作恢复扫描：**就绪闸放行之后**才跑（构造期跑等于让一个未放行的进程动数据）。
      await facebookCoordinator.recoverActiveActions();
    },
    async stop() {
      // 逆序停。
      auditRelay.stop();
      await publishDispatch.close();
      await edgeAccess.close();
      await connectionRuntime.close();
    },
    async dispose() {
      // 构造期就占住的三样，**无论业务有没有放行都要还**。
      riskAccounting.stop();
      modelExit.stop();
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
