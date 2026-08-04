/**
 * 互动能力的装配（task 3.5f，批 H 第 4 片）。
 *
 * 它交付的是批 D 留在 {@link AutomationEdgeAccessOptions} 上的**第三个必填口** ——
 * `interaction`，一个二态：`wired` 带端口 / `unavailable` 带具名理由。
 * 用户 2026-08-02 拍板这一批**真接通**，不走「具名缺席」了事。
 *
 * ## 三个子件与单体的对应
 *
 * - **收件箱**：存储 → 回复策略解析 → 回复工作流 → 收件箱服务；
 * - **运行时开关**：把存储里的开关 + 待办离场 + 撤权准入投影成发给边缘的那张快照；
 * - **握手后恢复编排**：先清待办离场，其次才是可恢复回复（**顺序是单体口径，别调换**）。
 *
 * ## 红线：整体缺席，不得半截可用
 *
 * 单体的回落处是把八个变量**一起**置空的。半截可用会让下游能力位发得不一致 ——
 * 边缘据此判断自己该不该拉取、该不该发送，而它没有第二个信息源可以交叉验证。
 * 所以本工厂只有两种结局：三个子件全给，或者一个都不给并说明为什么。
 *
 * ## `unavailable` 是真实存在的一态，不是「还没接线」的托词
 *
 * 最主要的那条是 schema：互动域的表在这台机器上可能压根没建，单体里那就是整体缺席。
 * 因此本工厂**必须先真的 `init()` 一次**才能定二态 —— 它是异步工厂，不是纯构造。
 *
 * ## ⚠️ 与原计划的一处偏离：半迁移**不判** unavailable
 *
 * 3.5f 的计划注释把「schema 半迁移」列为 unavailable 的理由之一。**实读单体后不采纳**：
 * 半迁移（`legacy_read_only`）在单体里仍然组装收件箱与运行时开关，只是把**写**总开关强制关掉
 * （读已恢复、评论回复与私信发送关闭）。把它判成整体缺席等于连读也停掉，是一次行为回归。
 * 正确做法是照单体：仍然 `wired`，但写开关按 schema 模式算出来。
 *
 * ## ⚠️ 真环：本能力要边缘推送出口，而边缘接入又要本能力
 *
 * 收件箱的自动下发、离场命令、断连恢复都要往边缘推，而边-云服务端是**边缘接入工厂**造的，
 * 它的构造入参里又有本能力这个必填口。这不是排序能解决的，用**晚绑定薄壳**破：
 * 见 {@link createLateBoundInteractionEdgeBinding}。薄壳在绑定之前被调用时**具名抛错**，
 * 不是返回 0、也不是静默丢弃 —— 那会让「推送出口还没接上」表现成「边缘不在线」。
 */
import type pg from 'pg';

import type { DeploymentTarget } from 'aidcp-kernel/deployment-target.js';
import type { OffboardAdmissionLedgerPort } from 'aidcp-kernel/kernel/api-direct-port.js';
import type { ReplyConfigReader } from 'aidcp-kernel/kernel/interaction-reply-contract.js';
import type { AccountRuntimeAuthorityPort } from 'aidcp-kernel/kernel/api-direct-port.js';
import {
  INTERACTION_OFFBOARDING_CAPABILITY,
  INTERACTION_REPLY_RECOVERY_CAPABILITY,
} from './comm/protocol.js';
import type { EdgePusher } from './comm/ws-server.js';
import { InteractionInboxService } from './interactions/interaction-inbox-service.js';
import { InteractionMetrics } from './interactions/metrics.js';
import { InteractionOffboardingService } from './interactions/offboarding-service.js';
import {
  InteractionStore,
  type InteractionStoreOptions,
} from './interactions/interaction-store.js';
import { ReplyWorkflow } from './interactions/reply-workflow.js';
import type { ReplyAiPort } from 'aidcp-kernel/kernel/interaction-types.js';
import { projectRuntimeControls } from './interactions/runtime-controls-provider.js';
import {
  InteractionSendOrchestrator,
  type InteractionRiskController,
} from './interactions/send-orchestrator.js';
import { interactionWritesAllowed } from './interactions/schema-capability.js';
import type { AutomationEdgeInteractionSupport } from './automation-edge-access.js';

/** 每日保留期清理的周期。与单体逐字一致。 */
const RETENTION_SWEEP_MS = 24 * 60 * 60 * 1_000;

/**
 * 边缘推送出口的晚绑定薄壳。
 *
 * **它存在的唯一理由是那个真环**（本能力 ↔ 边缘接入），不是为了灵活性。
 * 所以它只有一个能力：在绑定之前被调用就**响亮抛错**。
 */
export interface AutomationInteractionEdgeBinding {
  /**
   * 推送出口。**它本身就是那层薄壳** —— 每个方法在调用时才去问真服务端，
   * 所以下游（下发器 / 离场服务）拿到的是一个可以立刻传下去的稳定引用，
   * 而不必自己关心绑定时机。
   */
  pusher: EdgePusher;
  isEdgePaused(edgeId: string): boolean;
}

export interface AutomationInteractionEdgeLateBinding {
  binding: AutomationInteractionEdgeBinding;
  /** 边缘服务端造好之后调一次。重复绑定即抛——两个推送出口意味着有一半的推送去了别处。 */
  bind(server: EdgePusher & { isEdgePaused(edgeId: string): boolean }): void;
}

export function createLateBoundInteractionEdgeBinding(): AutomationInteractionEdgeLateBinding {
  let bound: (EdgePusher & { isEdgePaused(edgeId: string): boolean }) | null = null;
  const require_ = (): EdgePusher & { isEdgePaused(edgeId: string): boolean } => {
    if (!bound) {
      // **绝不返回一个「推了 0 条」的空壳**：那会让「出口还没接上」与「边缘不在线」同形，
      // 而这两者的处置完全不同（前者是装配缺陷、后者是常态）。
      throw new Error('interaction_edge_pusher_unbound');
    }
    return bound;
  };
  return {
    binding: {
      pusher: {
        pushToEdges: (envelope, edgeId) => require_().pushToEdges(envelope, edgeId),
        resolveEdgeIdForAccount: (accountId, capability) =>
          require_().resolveEdgeIdForAccount?.(accountId, capability) ?? null,
        edgeCapabilities: (edgeId) => require_().edgeCapabilities?.(edgeId),
        edgeCount: () => require_().edgeCount(),
        onlineEdgeCount: () => require_().onlineEdgeCount(),
        pauseEdge: (edgeId) => require_().pauseEdge(edgeId),
        resumeEdge: (edgeId) => require_().resumeEdge(edgeId),
      },
      isEdgePaused: (edgeId) => require_().isEdgePaused(edgeId),
    },
    bind(server) {
      if (bound) throw new Error('interaction_edge_pusher_already_bound');
      bound = server;
    },
  };
}

export interface AutomationInteractionOptions {
  /** 属主池。互动域的表全是本域属主。 */
  ownerPool: pg.Pool;
  executionTarget: DeploymentTarget;
  api: {
    /**
     * 登录态写入的准入闸（接口域判定 + 环境级行锁 + 带有效期的回执）。
     * **必填**：缺它时正确做法是传一个「一律拒绝」的实现，而不是不传 ——
     * 存储内部对它是可选的，不传等于把这道跨域闸整个跳过。
     */
    authGate: NonNullable<InteractionStoreOptions['authGate']>;
    /** 回复策略解析（接口属主的配置表）。**必填**：缺它整条能力不组装。 */
    replyConfig: ReplyConfigReader;
    /**
     * 撤权准入的读面（批 H 第 4 片新开的窄端口）。**必填**。
     *
     * 它答的布尔是**放行条件**：`false` = 没有 hold = 放行。所以这里 MUST NOT 接一个
     * 「失败就答 false」的实现 —— 那等于给正在被撤权的环境重新放开互动写。
     */
    revocationHold: Pick<OffboardAdmissionLedgerPort, 'hasPendingRevocationHold'>;
    /** 接口属主表的清除口（存储内部按需调用）。缺席时该清除退化，存储自己有分支。 */
    apiWrites?: NonNullable<InteractionStoreOptions['apiPurge']>;
    /** 账号运行时事实（昵称回写 / 平台判定 / 联系方式）。缺席各有明写的退化。 */
    accountRuntime?: Pick<
      AccountRuntimeAuthorityPort,
      'recordNickname' | 'getPlatformOrNull' | 'getContactInfo'
    >;
  };
  content: {
    /**
     * 回复生成能力（内容域）。**缺席则整条能力不组装**，理由逐字照单体：
     * 塞一个空壳进去意味着每一次分类 / 润色 / 风险复核都静静回一个看起来合法的结果。
     */
    replyAi?: ReplyAiPort;
  };
  risk: {
    controllerFor(
      accountId: string,
    ): InteractionRiskController | undefined | Promise<InteractionRiskController | undefined>;
  };
  /** 边缘推送出口。真环，用晚绑定薄壳传进来。 */
  edge: AutomationInteractionEdgeBinding;
  /** 自动入队的准入判定归下发器；这里只是把它接回收件箱（单体同形）。 */
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearTimer?: (handle: ReturnType<typeof setInterval>) => void;
}

export interface AutomationInteraction {
  /** 交给边缘接入的那个必填二态口。 */
  support: AutomationEdgeInteractionSupport;
  /**
   * 周期性任务起转（保留期清理）。**刻意不在构造期起**：构造发生在就绪闸之前，
   * 那时业务还没放行，起一张表就等于让一个未放行的进程开始动数据。
   */
  start(): void;
  /** 归还构造期与 `start()` 占住的东西。无论二态是哪一态都可安全调用一次。 */
  dispose(): Promise<void>;
}

/**
 * 建互动能力。**异步**：二态要由真实的 schema 探测决定，探不到就不能假装 wired。
 */
export async function createAutomationInteraction(
  options: AutomationInteractionOptions,
): Promise<AutomationInteraction> {
  const logger = options.logger ?? console;
  const setTimer =
    options.setTimer ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((handle: ReturnType<typeof setInterval>) => clearInterval(handle));
  const env = options.env ?? process.env;
  const metrics = new InteractionMetrics();

  // 回复生成缺席 ⇒ **整条不组装**。这一跳放在建存储之前，省掉一次没有意义的建表探测，
  // 也让「为什么整条没起来」的理由是那个真原因，而不是随后某个次生失败。
  if (!options.content.replyAi) {
    logger.warn(
      '[aidcp-automation] 回复生成能力缺席 ⇒ 互动能力整体不组装（绝不半截可用）',
    );
    return {
      support: { state: 'unavailable', reason: 'interaction_reply_generation_unavailable' },
      start: () => undefined,
      dispose: async () => undefined,
    };
  }

  const store = new InteractionStore({
    pool: options.ownerPool,
    authGate: options.api.authGate,
    executionTarget: options.executionTarget,
    ...(options.api.apiWrites ? { apiPurge: options.api.apiWrites } : {}),
    ...(options.api.accountRuntime
      ? {
          accountPlatform: {
            getPlatformOrNull: (id: string) =>
              options.api.accountRuntime!.getPlatformOrNull(id),
          },
        }
      : {}),
  });

  let schemaMode;
  try {
    schemaMode = await store.init();
  } catch (error) {
    // 建表探测失败 = 互动域在这台机器上不可用。**照单体：整体缺席，且理由具名。**
    await store.close().catch(() => undefined);
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn(`[aidcp-automation] 互动 schema 不可用 ⇒ 互动能力整体不组装: ${detail}`);
    return {
      support: {
        state: 'unavailable',
        reason: `interaction_schema_unavailable:${detail}`,
      },
      start: () => undefined,
      dispose: async () => undefined,
    };
  }

  // 写总开关 = 「运营配了没有」与「schema 支不支持」取与。**半迁移在这里体现，不在二态上体现**
  // —— 判成整体缺席会连读一起停掉，那是行为回归（见文件头那条偏离说明）。
  const configuredWriteEnabled = ['1', 'true', 'yes', 'on'].includes(
    String(env.AIDCP_INTERACTION_WRITE_ENABLED ?? '').trim().toLowerCase(),
  );
  // 第三个实参不能省：半迁移只在 dev 上仍允许写（单体逐字口径），漏传会让 dev 的写
  // 悄悄关掉 —— 那是「看着更安全」但与单体不一致的一次静默行为变更。
  const globalWriteEnabled = interactionWritesAllowed(
    schemaMode,
    configuredWriteEnabled,
    options.executionTarget,
  );
  logger.log(
    '[aidcp-automation] interaction write capability '
      + `schema=${schemaMode} configured=${configuredWriteEnabled} `
      + `effective=${globalWriteEnabled}`,
  );

  const sender = new InteractionSendOrchestrator({
    store,
    configs: options.api.replyConfig,
    pusher: options.edge.pusher,
    isEdgePaused: (edgeId) => options.edge.isEdgePaused(edgeId),
    controllerFor: options.risk.controllerFor,
    metrics,
    globalWriteEnabled,
    env,
  });

  const workflow = new ReplyWorkflow(store, options.api.replyConfig, options.content.replyAi, {
    ...(options.api.accountRuntime
      ? {
          contactInfoFor: (accountId: string) =>
            options.api.accountRuntime!.getContactInfo(accountId),
        }
      : {}),
    canAutoQueue: (context, snapshot, preview) =>
      sender.canAutoQueueDraft(context, snapshot, preview),
  });

  const inbox = new InteractionInboxService({
    store,
    configs: options.api.replyConfig,
    workflow,
    controllerFor: options.risk.controllerFor,
    metrics,
    ...(options.api.accountRuntime
      ? {
          recordNickname: (accountId: string, nickname: string) =>
            options.api.accountRuntime!.recordNickname(accountId, nickname),
        }
      : {}),
    logger,
    dispatchAuto: (input) => sender.dispatchQueued(input),
  });

  const offboarding = new InteractionOffboardingService({
    store,
    pusher: options.edge.pusher,
    metrics,
  });

  let retentionTimer: ReturnType<typeof setInterval> | null = null;

  return {
    support: {
      state: 'wired',
      port: {
        inbox,
        runtimeControls: {
          getSnapshot: (accountId: string) =>
            projectRuntimeControls(
              {
                getRuntimeControls: (id) => store.getRuntimeControls(id),
                hasPendingOffboard: (id) => inbox.hasPendingOffboard(id),
                // 跨域读：撤权准入台账属接口域，走窄端口。失败**原样抛**——
                // 这个布尔是放行条件，吞成 false 就是把正在被撤权的环境重新放开。
                hasPendingRevocationHold: (id) =>
                  options.api.revocationHold.hasPendingRevocationHold(id),
                globalWriteEnabled,
              },
              accountId,
            ),
        },
        // **先清待办离场，其次才是可恢复回复**：顺序是单体口径。
        // 反过来的话，一个已经被判离场的账号会先被恢复一批回复出去。
        reconcileOnWelcome: async ({ accountId, edgeId, capabilities }) => {
          const pendingOffboards = capabilities.has(INTERACTION_OFFBOARDING_CAPABILITY)
            ? await store.pendingOffboards(accountId, 1)
            : [];
          if (pendingOffboards.length > 0) {
            await offboarding.dispatchPending(accountId, edgeId);
          } else if (capabilities.has(INTERACTION_REPLY_RECOVERY_CAPABILITY)) {
            await sender.reconcileRecoverable(accountId, edgeId);
          }
        },
        // 客户提交离场后的即时派发。**边缘 id 在这里解析、不由调用方递进来**：
        // 见端口注释——推送目标必须取自本进程的连接注册表，而不是调用方那份在场镜像。
        // 边缘不在线是**事实**（回 0），派发失败是**故障**（抛出去），两者不合并。
        dispatchPendingOffboards: async (accountId) => {
          const resolve = options.edge.pusher.resolveEdgeIdForAccount;
          if (!resolve) {
            // 推送出口连 account→edge 解析都没有 ⇒ **装配缺陷**，不是「边缘不在线」。
            // 回 0 会把这两件事压成一态，而后者是常态、前者要有人去修。
            throw new Error(
              'interaction_edge_resolver_unavailable: 推送出口缺 account→edge 解析，无法确定离场指令推给谁',
            );
          }
          // 不带能力过滤，与单体那处逐字同口径（握手侧的能力检查是另一条路径上的事）。
          const edgeId = resolve(accountId);
          if (!edgeId) return 0;
          return offboarding.dispatchPending(accountId, edgeId);
        },
      },
    },
    start() {
      if (retentionTimer !== null) return;
      retentionTimer = setTimer(() => {
        void store.purgeExpiredContent().catch((error: unknown) =>
          logger.warn(
            `[interaction] retention 失败: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }, RETENTION_SWEEP_MS);
      retentionTimer.unref?.();
    },
    async dispose() {
      if (retentionTimer !== null) {
        clearTimer(retentionTimer);
        retentionTimer = null;
      }
      // 存储的 `close()` 是裸 `pool.end()`，而池是**注入进来的共享属主池**
      // ⇒ 关它会打死本进程其余十几个存储。归还只到停表为止。
      // （同族的关停语义并不一致，逐个看它关的是谁的池——这是批 D / 批 G 各咬过一次的形状。）
    },
  };
}
