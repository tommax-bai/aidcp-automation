/**
 * 发布下发与陪伴界面（task 3.1 · 批 F）。
 *
 * ## 这一批装的是什么
 *
 * 「人审通过 → 真的发出去」这一整段：陪伴界面快照层、当日用量装配、浏览器待机提示、
 * 发布下发器、定时发布对账器、下发触发受理口，以及驳回 / 前置检查 / 预览刷新那几个闭包。
 * **它与批 E 互不依赖**（两者都只依赖批 D 与批 B），是整个第 3 段唯一能并行的一处。
 *
 * ## 一个必填口交给批 E
 *
 * {@link AutomationPublishRuntimeReadPort} —— 单体里写成 `ctx.runtimes?.…  ?? null`。
 * 那个 `?? null` 在单体里永远走不到，拆开之后却是常态：**读不到就把「本轮会话」整段静静抹掉**，
 * 客户端上「本轮计划」窗口不再出现，而日志一行都不会有。
 * 所以这里做成必填参数，且**与批 D 用的是同一个端口类型**（`AutomationEdgeRuntimePort` 的读侧子集）
 * —— 拆成两个接口的唯一后果是批 E 可能供出两个不同的注册表实例。
 *
 * ## 四条**不许降级**的红线
 *
 * 1. **素材端口 MUST 显式表态。** 下发器那个参数在类型上是可选的，**漏传不报错**，
 *    只会让「预留释放 / 标记已用 / 隔离」三个写静默消失 —— 于是审批驳回时那组素材
 *    永久卡在 reserved 上没人回收。本模块把它做成**能力二态**：要么给端口，要么具名说不可用。
 * 2. **驳回路径不走下发器那个窄口。** 它是本模块直调素材端口的一处，
 *    只改窄口会把它漏掉（kernel 端口注释点名了这一处）。搬的时候两处都要在。
 * 3. **平台投影永远是最后一步。** 先物化计数、再覆盖发布数、最后才按平台摘键。
 *    顺序颠倒 ⇒ 摘掉的键被补回 0 ⇒ 饱和判定算出「0/0 今日计划已完成」。
 *    且四个计数面（本轮 / 分钟 / 小时 / 天）**一个都不能漏**，漏一个就让同一屏的两处互相打脸。
 * 4. **配额与慢启动必须取同一个控制器实例。** 徽章从 store 另读一次的话，
 *    会出现「徽章说第 7 天、放行按第 8 天」——两个数字各自都对，合起来是假的。
 *
 * ## 本进程**不构造**的四样（构造条件在单体里就写着「非自动化模式」）
 *
 * 草稿精修工作器、发布授权 outbox 中继、待下发看门狗、客户端内审批与删图处理器。
 * 前三样在单体里由接口进程承担；后两样在本进程里的调用点已经按模式改指接口进程的远程口
 * （见批 D 的消息处理器），本进程里没有任何读者。
 * **这不是能力消失**——能力都在，只是属主在接口进程。
 */
import type pg from 'pg';

import type { DeploymentTarget } from 'aidcp-kernel/deployment-target.js';
import { shanghaiDayStartMs } from 'aidcp-kernel/time/shanghai-day.js';
import type { PersonaBinding } from 'aidcp-kernel/kernel/persona-binding.js';
import type { ScheduledPublishStore } from 'aidcp-kernel/kernel/publish-draft-contract.js';
import type {
  ApprovalBlockedReason,
  PublishApprovalAuthorityPort,
  PublishDispatchTriggerKind,
} from 'aidcp-kernel/kernel/publish-approval-contract.js';
import type { StructuredNotificationDeliveryInput } from 'aidcp-kernel/kernel/api-direct-port.js';

import {
  buildBrowserStandbyHint,
  resolveBrowserStandbyConfig,
} from './comm/browser-standby.js';
import {
  completeSessionUsageCounts,
  pickDailyUsageCounts,
  pickSessionUsageCounts,
} from './comm/daily-usage.js';
import { UI_DAILY_USAGE_ACTIONS } from './comm/protocol.js';
import type {
  Envelope,
  PersonaWritingLanguage,
  UiBrowserStandbyPayload,
  UiDailyUsageAction,
  UiDailyUsageCounts,
  UiDailyUsagePayload,
  UiDailyUsageWindowStatus,
  UiPublishPreviewPayload,
} from './comm/protocol.js';
import { PublishUiUpdateCommandReceiver } from './comm/publish-ui-update-command-receiver.js';
import { UiSnapshotService } from './comm/ui-snapshot.js';
import type { SessionConfigStore } from './config/session-config-store.js';
import type { AutomationEdgeRuntimePort } from './automation-edge-access.js';
import { personaBindingFor } from './automation-persona-view.js';
import { omitUnsupportedUsageMetrics } from './platform/surface.js';
import type { CommandSequencer } from './publish-agent/command-sequencer.js';
import { PublishDispatcher } from './publish-agent/publish-dispatcher.js';
import type { DispatchStore } from './publish-agent/publish-dispatcher.js';
import { createPublishDispatchTriggerReceiver } from './publish-agent/publish-dispatch-trigger.js';
import { ScheduledPublishReconciler } from './publish-agent/scheduled-publish-reconciler.js';
import type { EdgeTaskLeaseClient } from './comm/edge-task-lease-client.js';
import type { RiskAction, RiskWindow } from './risk/types.js';
import type { RiskController } from './risk/risk-controller.js';
import type { AutomationSyncReadMirrors } from './transport/automation-sync-read-mirrors.js';

/** 批 E 供的读侧（与批 D 的端口同源，取其子集，**不另立第二个接口**）。 */
export type AutomationPublishRuntimeReadPort = Pick<
  AutomationEdgeRuntimePort,
  'sessionUsageForAccount' | 'resumeGateForAccount'
>;

/** 批 D 供的对边出口。 */
export interface AutomationPublishEdgePort {
  pushToEdges(envelope: Envelope, edgeId?: string): number;
  resolveEdgeIdForAccount(accountId: string, capability?: string): string | null;
  edgeCapabilities(edgeId: string): string[] | undefined;
  /** 验证码硬暂停：暂停期投递必为 0 ⇒ 零副作用回待审、不烧稿。 */
  isEdgePaused(edgeId: string): boolean;
}

/** 批 B / 批 C 供的风控读与记账。 */
export interface AutomationPublishRiskPort {
  getController(accountId: string): Promise<RiskController>;
  /** 按窗口读计数。**MUST 是注册表用的那一个存储实例**，别另建。 */
  totalsForAccountSince(
    accountId: string,
    since: number,
  ): Promise<Partial<Record<string, number>>>;
  todayTotalsForAccount(accountId: string): Promise<Partial<Record<string, number>>>;
  /** 记账唯一入口（批 C 的漏斗）。发布是云端自证的既成事实，没有边缘信封 id 可用。 */
  recordRiskFact(accountId: string, action: RiskAction, dedupeKey: string): Promise<boolean>;
}

/**
 * 发布日志（api 属主，组装根已有客户端）。
 *
 * 下发要用的那几个方法**直接取下发器自己的存储契约**，不在这里手抄一遍：
 * 手抄件与真契约漂开时（少一个字段、返回类型宽一档）编译器未必拦得住，
 * 而漂的后果是下发器拿到一个「形状对、内容缺」的草稿。
 */
export interface AutomationPublishLogPort
  extends ScheduledPublishStore,
  Pick<
    DispatchStore,
    | 'loadForDispatch'
    | 'updateStatus'
    | 'updatePostId'
    | 'markScheduled'
    | 'markImagesAttached'
  > {
  rejectPendingApproval(recordId: number): Promise<unknown>;
  lastPublishedForAccount(accountId: string): Promise<{ title: string | null; at: number } | null>;
  pendingApprovalForAccount(accountId: string): Promise<{ id: number; title: string | null } | null>;
  pendingPublishPreviewForAccount(accountId: string): Promise<unknown>;
  countPublishedSinceForAccount(accountId: string, since: number): Promise<number>;
  countPublishedTodayForAccount(accountId: string): Promise<number>;
}

/** 发布授权（api 属主客户端）。 */
export interface AutomationPublishApprovalPort {
  readApproval(requestId: string): Promise<{
    approved: boolean;
    contentVersion: number;
    revision: number;
    dispatchState?: string | null;
    dispatchBlockedReason?: string | null;
  } | null>;
  voidApproval(requestId: string, expectedRevision: number, reason: string): Promise<unknown>;

  markDispatching(requestId: string, expectedRevision: number): Promise<unknown>;
  markConsumed(requestId: string, expectedRevision: number): Promise<unknown>;
  releaseToPending(
    requestId: string,
    expectedRevision: number,
    blockedReason: ApprovalBlockedReason | null,
  ): Promise<unknown>;
  setBlockedReason(
    requestId: string,
    expectedRevision: number,
    reason: ApprovalBlockedReason | null,
  ): Promise<unknown>;
  listPendingDispatch(
    target: DeploymentTarget,
    envKey: string | undefined,
    subjectKind: 'publish',
  ): Promise<{ requestId: string; approved: boolean }[]>;
}

/**
 * Facebook 发帖素材端口的**能力二态**。
 *
 * 下发器那个参数在类型上是可选的、**漏传不报错**，代价是三个写静默消失。
 * 所以本模块不接受 `undefined`：要么给端口，要么具名说不可用。
 */
export type AutomationPublishMediaSupport =
  | { state: 'wired'; port: NonNullable<ConstructorParameters<typeof PublishDispatcher>[0]['facebookPublishMedia']> }
  | { state: 'unavailable'; reason: string };

/** 授权读口（下发触发受理器要它，用于按 requestId 复核）。取契约那一份，不另写形状。 */
export type AutomationPublishApprovalAuthorityPort = Pick<
  PublishApprovalAuthorityPort,
  'getApproval'
>;

export interface AutomationPublishDispatchOptions {
  /** automation 属主池。 */
  ownerPool: pg.Pool;
  executionTarget: DeploymentTarget;
  /**
   * 单场会话配置存储。**必填、由调用方注入**——本模块**刻意不自建**。
   *
   * 它在本进程里同时是三样东西的事实源：本模块的续场护栏、每连接角色调度器的
   * `sessionLimitProvider`、业务配置那条全局活跃周历，还有 `session_config_global`
   * 那条属主同步读流的观测口。**自建一个不会报错**，只会让进程里存在两份、各持一套缓存，
   * 于是「后台改了单场时长」在一处生效、另一处不生效，而两边都不说话。
   * 做成必填无默认，是为了让「到底是不是同一个实例」在编译期可见。
   */
  sessionConfig: SessionConfigStore;
  /** 批 D 的对边出口。 */
  edge: AutomationPublishEdgePort;
  /** 批 D 的指令定序器与租约客户端。 */
  commandSequencer: CommandSequencer;
  edgeTaskLeases: EdgeTaskLeaseClient;
  /** 批 B / 批 C。 */
  risk: AutomationPublishRiskPort;
  /** 批 E。**必填** —— `?? null` 在本进程里是常态，不是不可达分支。 */
  runtime: AutomationPublishRuntimeReadPort;
  publishLog: AutomationPublishLogPort;
  publishApproval: AutomationPublishApprovalPort;
  /** 下发触发受理器要的授权读口（同一份 api 授权权威）。 */
  approvalAuthority: AutomationPublishApprovalAuthorityPort;
  /** 首作进度（api 属主）。缺省 → 载荷不带 firstPost 字段，其余照常。 */
  firstPostProgress?: {
    getFirstPostProgress(accountId: string): Promise<{
      state: string;
      startedAt: number;
      sourceId?: string;
    } | null>;
  };
  /** 同步读镜像：人设绑定三态、写作语言、账号平台。 */
  mirrors: AutomationSyncReadMirrors;
  /** 账号昵称（展示用）。4a 之后展示字段归接口域，故默认缺席。 */
  getNickname?: (accountId: string) => string | null;
  getAccountName?: (accountId: string) => string | null | undefined;
  /** Facebook 发帖素材端口。**必填二态**，见 {@link AutomationPublishMediaSupport}。 */
  media: AutomationPublishMediaSupport;
  /** 结构化通知出口（api 属主客户端）。 */
  notifications: { deliver(input: StructuredNotificationDeliveryInput): Promise<unknown> };
  commandIdGen?: () => string;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface AutomationPublishDispatch {
  uiSnapshot: UiSnapshotService;
  /** 喂给组装根 `AutomationRuntimeHandles.publishUiUpdate` 的那一份。 */
  publishUiUpdateDeps: { uiSnapshot: UiSnapshotService };
  publishUiUpdateReceiver: PublishUiUpdateCommandReceiver;
  publishDispatcher: PublishDispatcher;
  scheduledPublishReconciler: ScheduledPublishReconciler;
  triggerPublishDispatchOnApprove(
    requestId: string,
    revision: number,
    kind: PublishDispatchTriggerKind,
  ): Promise<void>;
  publishDispatchTrigger: ReturnType<typeof createPublishDispatchTriggerReceiver>;
  notifyPublishRejected(requestId: string): void;
  preflightApprovePublish(requestId: string): Promise<{
    ok: boolean;
    reason?: string;
    accountId?: string;
    edgeId?: string;
  }>;
  /** 待审草稿内容变更后重推预览。**本进程是具名 no-op**，见实现处注释。 */
  refreshPublishPreview(recordId: number): void;
  readPublishApproval(
    requestId: string,
  ): Promise<{ approved: boolean; contentVersion: number; revision: number } | null>;
  buildTodayUsageForAccount(accountId: string, edgeId?: string): Promise<UiDailyUsagePayload>;
  /** 起补偿扫描。**进程入口在就绪闸之后调**，工厂本身不起定时器。 */
  start(): void;
  degraded: readonly { component: string; reason: string }[];
  close(): Promise<void>;
}

/** 授权不可读：MUST fail-closed，MUST NOT 当作「未授权」静默吞掉。 */
export class AutomationApprovalUnreadableError extends Error {
  readonly code = 'approval_unreadable';

  constructor(reason: string) {
    super(`publish approval unreadable: ${reason}`);
    this.name = 'AutomationApprovalUnreadableError';
  }
}

function quotaSaturation(
  totals: UiDailyUsageCounts,
  quotas: UiDailyUsageCounts,
): UiDailyUsageAction[] {
  return UI_DAILY_USAGE_ACTIONS.filter((action) => {
    const cap = quotas[action];
    return typeof cap === 'number' && (totals[action] ?? 0) >= cap;
  });
}

function makeUsageWindow(
  totals: UiDailyUsageCounts,
  quotas?: UiDailyUsageCounts,
  options?: {
    active?: boolean;
    startedAt?: number;
    windowMs?: number;
    expiresAt?: number;
    refreshAt?: number;
    releaseAt?: number;
    skipSaturation?: boolean;
  },
): UiDailyUsageWindowStatus {
  const window: UiDailyUsageWindowStatus = { totals };
  if (options && Object.prototype.hasOwnProperty.call(options, 'active')) window.active = options.active;
  if (typeof options?.startedAt === 'number' && Number.isFinite(options.startedAt)) {
    window.startedAt = options.startedAt;
  }
  if (
    typeof options?.windowMs === 'number'
    && Number.isFinite(options.windowMs)
    && options.windowMs > 0
  ) {
    window.windowMs = Math.floor(options.windowMs);
  }
  if (typeof options?.expiresAt === 'number' && Number.isFinite(options.expiresAt)) {
    window.expiresAt = options.expiresAt;
  }
  if (typeof options?.refreshAt === 'number' && Number.isFinite(options.refreshAt)) {
    window.refreshAt = options.refreshAt;
  }
  if (typeof options?.releaseAt === 'number' && Number.isFinite(options.releaseAt)) {
    window.releaseAt = options.releaseAt;
  }
  if (quotas && Object.keys(quotas).length > 0) {
    window.quotas = quotas;
    window.saturated = options?.skipSaturation ? [] : quotaSaturation(totals, quotas);
  }
  return window;
}

function usageWindowReleaseAt(
  controller: RiskController,
  window: RiskWindow,
  saturated: UiDailyUsageAction[] | undefined,
  asOf: number,
): number | undefined {
  let releaseAt: number | undefined;
  for (const action of saturated ?? []) {
    // 界面动作全集是风控动作全集的子集，**这一点由编译器担保**（这里不带任何 as）。
    // 曾经写成 `action as RiskAction` —— 那样两套枚举哪天漂开都不会报错，
    // 只是拿到一个对不上任何配额桶的答案，而它看起来和真答案一模一样。
    const retryAfterMs = controller.quotaReleaseAfterMs(action, window);
    if (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
      continue;
    }
    const at = asOf + Math.ceil(retryAfterMs);
    releaseAt = releaseAt === undefined ? at : Math.min(releaseAt, at);
  }
  return releaseAt;
}

function readNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export async function createAutomationPublishDispatch(
  options: AutomationPublishDispatchOptions,
): Promise<AutomationPublishDispatch> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const degraded: { component: string; reason: string }[] = [];
  const commandIdGen = options.commandIdGen ?? (() => `${Date.now()}-${Math.trunc(performance.now())}`);

  let mediaPort: (AutomationPublishMediaSupport & { state: 'wired' })['port'] | undefined;
  if (options.media.state === 'wired') {
    mediaPort = options.media.port;
  } else {
    logger.warn(
      `[aidcp-automation] Facebook 发帖素材端口未接入（${options.media.reason}）——`
        + '预留释放 / 标记已用 / 隔离三个写在本进程不会发生。'
        + '这是显式声明的缺席：那个参数在类型上可选，漏传的话这三个写会静默消失。',
    );
  }

  // 单场会话配置（automation 属主表）：**注入的那一个实例**，本模块只 init、不新建。
  // init 失败 → 逐项回落内置默认，不阻塞装配（与单体逐位一致）。
  const sessionConfigStore = options.sessionConfig;
  try {
    await sessionConfigStore.init();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    degraded.push({ component: 'SessionConfigStore', reason });
    logger.warn(`[aidcp-automation] 单场会话配置初始化失败，逐项回落内置默认: ${reason}`);
  }

  // ── 授权读三态：MUST 严格可区分 ──────────────────────────────────────────
  // 活跃行存在 → 决定本身；无活跃行 → null（未授权，正常等待）；
  // 查询不可读 → **抛**，由调用方标阻塞原因并 fail-closed，
  // MUST NOT 当作「未授权」静默吞掉、更 MUST NOT 写任何终态。
  const readPublishApproval = async (
    requestId: string,
  ): Promise<{ approved: boolean; contentVersion: number; revision: number } | null> => {
    const row = await options.publishApproval.readApproval(requestId);
    return row
      ? { approved: row.approved, contentVersion: row.contentVersion, revision: row.revision }
      : null;
  };

  // ── 当日用量装配 ────────────────────────────────────────────────────────
  const buildTodayUsageForAccount = async (
    accountId: string,
    edgeId?: string,
  ): Promise<UiDailyUsagePayload> => {
    const asOf = Date.now();
    const minuteWindowMs = 60_000;
    const hourWindowMs = 60 * 60_000;
    const dayWindowMs = 24 * 60 * 60_000;
    const minuteSince = asOf - minuteWindowMs;
    const hourSince = asOf - hourWindowMs;
    const dayStartedAt = shanghaiDayStartMs(asOf);
    const nextUsageRefreshAt = asOf + minuteWindowMs;
    // 平台按**同步镜像**现读：undefined = 未知（缺键）⇒ 下游保持现状，既有指标一个不摘。
    // 刻意不走「缺值回落小红书」那种读法——那是把「不知道」说成「是小红书」。
    const accountPlatform = options.mirrors.accountFor(accountId).value?.platform;
    const sessionUsage = options.runtime.sessionUsageForAccount(accountId, edgeId);
    const sessionStartedAt =
      sessionUsage?.active === true
      && typeof sessionUsage.startedAt === 'number'
      && Number.isFinite(sessionUsage.startedAt)
        ? sessionUsage.startedAt
        : null;
    const [
      sessionRiskTotals,
      minuteRiskTotals,
      hourRiskTotals,
      dayRiskTotals,
      sessionPublishCount,
      minutePublishCount,
      hourPublishCount,
      dayPublishCount,
    ] = await Promise.all([
      sessionStartedAt === null
        ? Promise.resolve(null)
        : options.risk.totalsForAccountSince(accountId, sessionStartedAt),
      options.risk.totalsForAccountSince(accountId, minuteSince),
      options.risk.totalsForAccountSince(accountId, hourSince),
      options.risk.todayTotalsForAccount(accountId),
      sessionStartedAt === null
        ? Promise.resolve(null)
        : options.publishLog.countPublishedSinceForAccount(accountId, sessionStartedAt),
      options.publishLog.countPublishedSinceForAccount(accountId, minuteSince),
      options.publishLog.countPublishedSinceForAccount(accountId, hourSince),
      options.publishLog.countPublishedTodayForAccount(accountId),
    ]);

    // 三条纪律，缺一条就复活一个谎：
    // ① 投影永远是最后一步（先物化、再覆盖 publish、最后摘键）；
    // ② 四个计数面一个都不能漏——漏一个，同一屏两处互相打脸；
    // ③ 投影只塑形、不算数。
    const projectTotals = (totals: UiDailyUsageCounts): UiDailyUsageCounts =>
      omitUnsupportedUsageMetrics(accountPlatform, totals);
    const withPublish = (totals: UiDailyUsageCounts, publishCount: number): UiDailyUsageCounts => {
      totals.publish = publishCount;
      return totals;
    };

    const minuteTotals = projectTotals(
      withPublish(pickDailyUsageCounts(minuteRiskTotals), minutePublishCount),
    );
    const hourTotals = projectTotals(
      withPublish(pickDailyUsageCounts(hourRiskTotals), hourPublishCount),
    );
    const dayTotals = projectTotals(
      withPublish(pickDailyUsageCounts(dayRiskTotals), dayPublishCount),
    );
    const sessionTotals = projectTotals(
      completeSessionUsageCounts(sessionUsage?.totals ?? {}, sessionRiskTotals, sessionPublishCount),
    );
    // 「本轮计划」窗口也是一个客户端上限面：会话预算是全局单例（零平台维度），
    // 不摘的话会出现「KPI 格诚实地没有收藏、正下方窗口条显示收藏 0/5」。两处同源同谎，必须一起摘。
    const sessionQuotas = projectTotals(
      pickSessionUsageCounts(sessionUsage?.quotas ?? sessionConfigStore.sessionBudget()),
    );
    const windows: NonNullable<UiDailyUsagePayload['windows']> = {
      session: makeUsageWindow(sessionTotals, sessionQuotas, {
        active: sessionUsage?.active === true,
        startedAt: sessionUsage?.startedAt,
        windowMs: sessionConfigStore.sessionDurationMs(),
        expiresAt:
          sessionUsage?.active === true && typeof sessionUsage.startedAt === 'number'
            ? sessionUsage.startedAt + sessionConfigStore.sessionDurationMs()
            : undefined,
        skipSaturation: sessionUsage?.active !== true,
      }),
      minute: makeUsageWindow(minuteTotals, undefined, {
        startedAt: minuteSince,
        windowMs: minuteWindowMs,
        expiresAt: asOf + minuteWindowMs,
        refreshAt: nextUsageRefreshAt,
      }),
      hour: makeUsageWindow(hourTotals, undefined, {
        startedAt: hourSince,
        windowMs: hourWindowMs,
        expiresAt: asOf + hourWindowMs,
        refreshAt: nextUsageRefreshAt,
      }),
      day: makeUsageWindow(dayTotals, undefined, {
        startedAt: dayStartedAt,
        windowMs: dayWindowMs,
        expiresAt: dayStartedAt + dayWindowMs,
      }),
    };

    const payload: UiDailyUsagePayload = { asOf, totals: dayTotals, windows };
    if (options.firstPostProgress) {
      try {
        const firstPost = await options.firstPostProgress.getFirstPostProgress(accountId);
        if (firstPost && (firstPost.state === 'searching' || firstPost.state === 'generating')) {
          const sinceTotals = await options.risk.totalsForAccountSince(accountId, firstPost.startedAt);
          const viewed = Number.isFinite(sinceTotals.view)
            ? Math.max(0, Math.floor(Number(sinceTotals.view)))
            : 0;
          payload.firstPost = {
            state: firstPost.state,
            viewed,
            target: 20,
            startedAt: firstPost.startedAt,
            ...(firstPost.sourceId ? { sourceId: firstPost.sourceId } : {}),
          } as UiDailyUsagePayload['firstPost'];
        }
      } catch (error) {
        logger.warn(
          `[aidcp-automation] first-post usage read failed account=${accountId}: `
            + `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    try {
      const controller = await options.risk.getController(accountId);
      const effective = controller.effectiveQuotas();
      // 平台过滤**永远是最后一步**：先让配额算完该发多少（含风控缩放与慢启动压低），
      // 最后才把这个平台结构上发不出的摘掉。顺序颠倒则慢启动曲线会对一个不存在的动作做运算。
      const minuteQuotas = projectTotals(pickDailyUsageCounts(effective.minute));
      const hourQuotas = projectTotals(pickDailyUsageCounts(effective.hour));
      const dayQuotas = projectTotals(pickDailyUsageCounts(effective.day));
      payload.quotaLevel = controller.getState().quotaLevel;
      // 慢启动投影**必须从同一个控制器实例取**，绝不从存储另读一次 ——
      // 这是唯一能防「徽章说第 7 天、放行已按第 8 天」的机制。
      payload.slowStart = controller.slowStartView();
      const minuteWindow = makeUsageWindow(minuteTotals, minuteQuotas, {
        startedAt: minuteSince,
        windowMs: minuteWindowMs,
        expiresAt: asOf + minuteWindowMs,
        refreshAt: nextUsageRefreshAt,
      });
      const minuteReleaseAt = usageWindowReleaseAt(
        controller,
        'minute' as RiskWindow,
        minuteWindow.saturated,
        asOf,
      );
      if (typeof minuteReleaseAt === 'number') minuteWindow.releaseAt = minuteReleaseAt;
      const hourWindow = makeUsageWindow(hourTotals, hourQuotas, {
        startedAt: hourSince,
        windowMs: hourWindowMs,
        expiresAt: asOf + hourWindowMs,
        refreshAt: nextUsageRefreshAt,
      });
      const hourReleaseAt = usageWindowReleaseAt(
        controller,
        'hour' as RiskWindow,
        hourWindow.saturated,
        asOf,
      );
      if (typeof hourReleaseAt === 'number') hourWindow.releaseAt = hourReleaseAt;
      const dayWindow = makeUsageWindow(dayTotals, dayQuotas, {
        startedAt: dayStartedAt,
        windowMs: dayWindowMs,
        expiresAt: dayStartedAt + dayWindowMs,
      });
      const dayReleaseAt = usageWindowReleaseAt(
        controller,
        'day' as RiskWindow,
        dayWindow.saturated,
        asOf,
      );
      if (typeof dayReleaseAt === 'number') dayWindow.releaseAt = dayReleaseAt;
      windows.minute = minuteWindow;
      windows.hour = hourWindow;
      windows.day = dayWindow;
      payload.quotas = dayQuotas;
      payload.saturated = windows.day.saturated ?? [];
    } catch (error) {
      logger.warn(
        `[aidcp-automation] ui daily usage quota read failed account=${accountId}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return payload;
  };

  // ── 浏览器待机提示 ──────────────────────────────────────────────────────
  const browserStandbyConfig = resolveBrowserStandbyConfig(env);
  const buildBrowserStandbyForAccount = async (
    accountId: string,
    edgeId?: string,
  ): Promise<UiBrowserStandbyPayload> => {
    const controller = await options.risk.getController(accountId);
    // 拿不到续场闸（边缘离线 / 无调度器）→ null → 退化为只按风控判（安全方向：不让位）。
    const resumeGate = options.runtime.resumeGateForAccount(accountId, edgeId);
    // 「解除阻塞需要浏览器」一票否决：边缘正卡在验证码上时绝不让位 ——
    // 验证码会把账号打成受限，而受限正是让位触发器之一，不接这道闸就会去关掉
    // 运维正要解验证码的那个浏览器。用云端权威的暂停集合，不依赖边缘自报的浮层标志。
    const targetEdgeId = edgeId ?? options.edge.resolveEdgeIdForAccount(accountId) ?? undefined;
    const needsBrowserToUnblock = targetEdgeId ? options.edge.isEdgePaused(targetEdgeId) : false;
    return buildBrowserStandbyHint(controller, {
      now: Date.now(),
      config: browserStandbyConfig,
      resumeGate,
      needsBrowserToUnblock,
    });
  };

  // ── 陪伴界面快照层 ──────────────────────────────────────────────────────
  const personaBindingOf = (accountId: string): PersonaBinding =>
    // **三态**：副本陈旧 → `unknown`，快照层据此不下发「已绑人设」字段。未知 ≠ 未绑。
    // 判定取共享的那一份（`automation-persona-view.ts`）：本进程至少三处要问同一个问题，
    // 各写一份的现形方式不是报错，是某天只改了其中一份、且恰好在该拦住的那一刻。
    personaBindingFor(options.mirrors, accountId);
  const uiSnapshot = new UiSnapshotService({
    pusher: { pushToEdges: (envelope, edgeId) => options.edge.pushToEdges(envelope, edgeId) },
    resolveEdgeIdForAccount: (accountId) => options.edge.resolveEdgeIdForAccount(accountId),
    edgeCapabilities: (edgeId) => options.edge.edgeCapabilities(edgeId),
    ...(options.getNickname ? { getNickname: options.getNickname } : {}),
    personaBinding: personaBindingOf,
    getPersonaWritingLanguage: (accountId) => {
      // soul 是同步读快照里的 JSON，字段可能整体缺席（存量人设没有这一项）。
      // 取不到就是 null —— 那是「没设置」，与「设置成某个值」分得开；MUST NOT 兜一个默认语言。
      const soul = options.mirrors.personaFor(accountId).value?.soul;
      if (!soul || typeof soul !== 'object' || Array.isArray(soul)) return null;
      const value = (soul as Record<string, unknown>).writing_language;
      return typeof value === 'string' ? (value as PersonaWritingLanguage) : null;
    },
    lastPublishedForAccount: (accountId) => options.publishLog.lastPublishedForAccount(accountId),
    pendingApprovalForAccount: (accountId) => options.publishLog.pendingApprovalForAccount(accountId),
    pendingPublishPreviewForAccount: async (accountId) =>
      toUiPublishPreview(await options.publishLog.pendingPublishPreviewForAccount(accountId)),
    readApproval: readPublishApproval,
    todayUsageForAccount: buildTodayUsageForAccount,
    browserStandbyForAccount: buildBrowserStandbyForAccount,
    logger,
  });
  const publishUiUpdateReceiver = new PublishUiUpdateCommandReceiver({ uiSnapshot });

  // ── 发布下发器 ─────────────────────────────────────────────────────────
  const recordPublish = async (accountId: string): Promise<void> => {
    // 发布是云端自证的既成事实，没有边缘信封 id 可用，故用「账号 + 动作 + 时刻」构造去重键。
    // 这条路径不会被重投，真正的 exactly-once 由计数表那条唯一索引承担。
    await options.risk.recordRiskFact(
      accountId,
      'publish',
      `publish:${accountId}:${Date.now()}:${commandIdGen()}`,
    );
  };
  const publishDispatcher = new PublishDispatcher({
    store: {
      // 属主客户端本身就满足下发存储契约，故**整体透传**，不逐方法再包一层箭头函数 ——
      // 那层转发没有任何窄化作用，只是把同一组方法抄一遍，多一处会漂的地方。
      ...options.publishLog,
      // 唯一要覆盖的一处：兜底扫描走下面那条按 target 批量拉的口径。
      // 本进程 MUST NOT 用「遍历待审 id 逐个查授权」那个放大器，故显式拒绝 ——
      // 给空数组会被读成「没有待下发的」，那是一句谎。
      listPendingApprovalIds: () =>
        Promise.reject(new Error('publish_pending_scan_uses_authenticated_listPendingDispatch')),
    },
    sequencer: options.commandSequencer,
    edgeTaskLeases: options.edgeTaskLeases,
    resolveEdgeIdForAccount: (accountId) => options.edge.resolveEdgeIdForAccount(accountId),
    executionTarget: options.executionTarget,
    isEdgePaused: (edgeId) => options.edge.isEdgePaused(edgeId),
    readApproval: readPublishApproval,
    voidApprovalSignal: (requestId, expectedRevision, reason) =>
      options.publishApproval.voidApproval(requestId, expectedRevision, reason as string).then(() => undefined),
    approvalDispatchState: {
      markDispatching: async (requestId: string, expectedRevision: number) => {
        await options.publishApproval.markDispatching(requestId, expectedRevision);
      },
      markConsumed: async (requestId: string, expectedRevision: number) => {
        await options.publishApproval.markConsumed(requestId, expectedRevision);
      },
      releaseToPending: async (
        requestId: string,
        expectedRevision: number,
        blockedReason: ApprovalBlockedReason | null,
      ) => {
        await options.publishApproval.releaseToPending(requestId, expectedRevision, blockedReason);
      },
      setBlockedReason: async (
        requestId: string,
        expectedRevision: number,
        reason: ApprovalBlockedReason | null,
      ) => {
        await options.publishApproval.setBlockedReason(requestId, expectedRevision, reason);
      },
    },
    // 兜底扫描按本机 target 批量拉「已批准·待下发」。
    // subjectKind 收窄到 publish：评论授权没有下发段、状态永远停在待下发，
    // 混进来会把窗口占满，真正待下发的稿反而被挤出去、永远扫不到。
    listPendingDispatchRecordIds: async (): Promise<number[]> => {
      const rows = await options.publishApproval.listPendingDispatch(
        options.executionTarget,
        undefined,
        'publish',
      );
      return rows
        .filter((row) => row.approved && /^publish-\d+$/.test(row.requestId))
        .map((row) => Number(row.requestId.slice('publish-'.length)));
    },
    recordPublish,
    notifyUiPublishState: (accountId, recordId, state, title) =>
      uiSnapshot.pushPublishState(accountId, recordId, state, title),
    notifyDispatchEvent: (notice) => {
      void (async () => {
        const name = options.getAccountName?.(notice.accountId) ?? '（未获取昵称）';
        const ref =
          notice.recordId !== undefined
            ? `草稿 #${notice.recordId}${notice.title ? `「${notice.title}」` : ''}`
            : '';
        const text = dispatchNoticeText(notice.kind, name, ref);
        await options.notifications.deliver({
          commandId: commandIdGen(),
          notification: {
            kind: 'operational_text',
            input: { route: 'account', accountId: notice.accountId, text },
          },
        } as StructuredNotificationDeliveryInput);
      })().catch((error) => {
        logger.warn(
          `[aidcp-automation][publish-dispatch] 运维通知发送失败 kind=${notice.kind} `
            + `account=${notice.accountId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    },
    // 素材端口：**类型上可选，语义上不可省**。二态在工厂入口已强制表态，这里只是把它传下去。
    ...(mediaPort ? { facebookPublishMedia: mediaPort } : {}),
    breakerThreshold: readNumber(env, 'AIDCP_PUBLISH_BREAKER_THRESHOLD', 2),
    logger,
  });

  const scheduledPublishReconciler = new ScheduledPublishReconciler({
    store: options.publishLog,
    sequencer: options.commandSequencer,
    edgeTaskLeases: options.edgeTaskLeases,
    resolveEdgeIdForAccount: (accountId) => options.edge.resolveEdgeIdForAccount(accountId),
    isEdgePaused: (edgeId) => options.edge.isEdgePaused(edgeId),
    recordPublish,
    intervalMs: readNumber(env, 'AIDCP_SCHEDULED_RECONCILE_SCAN_MS', 60_000),
    maxAttempts: readNumber(env, 'AIDCP_SCHEDULED_RECONCILE_MAX_ATTEMPTS', 8),
    logger,
  });

  // 短应答受理口：只受理唤醒，不把下发 Promise 或平台结局塞进 HTTP 生命周期。
  const publishDispatchTrigger = createPublishDispatchTriggerReceiver({
    executionTarget: options.executionTarget,
    approvalAuthority: options.approvalAuthority,
    dispatcher: publishDispatcher,
    logger,
  });
  const triggerPublishDispatchOnApprove = async (
    requestId: string,
    revision: number,
    kind: PublishDispatchTriggerKind,
  ): Promise<void> => {
    await publishDispatchTrigger.triggerApproved({
      requestId,
      revision,
      executionTarget: options.executionTarget,
      kind,
    });
  };

  // ── 驳回 / 前置检查 / 预览刷新 ───────────────────────────────────────────
  const notifyPublishRejected = (requestId: string): void => {
    const match = /^publish-(\d+)$/.exec(requestId);
    if (!match) return;
    const recordId = Number(match[1]);
    void options.publishLog
      .loadForDispatch(recordId)
      .then(async (draft) => {
        if (!draft || draft.status !== 'pending_approval') return;
        await options.publishLog.rejectPendingApproval(recordId);
        // ⚠️ **这条路径不走下发器那个窄口，是本模块直调素材端口。**
        // 只改窄口会把它漏掉，于是审批驳回时那组素材永久卡在 reserved 上没人回收。
        if (draft.platform === 'facebook' && draft.metadata?.facebookMedia && mediaPort) {
          await mediaPort
            .releaseReservation(
              draft.metadata.facebookMedia.setId,
              draft.metadata.facebookMedia.reservationId,
            )
            .catch((error: unknown) =>
              logger.warn(
                `[aidcp-automation] Facebook 素材释放失败 recordId=${recordId}: `
                  + `${error instanceof Error ? error.message : String(error)}`,
              ),
            );
        }
        uiSnapshot.pushPublishState(draft.accountId, recordId, 'rejected', draft.title);
      })
      .catch(() => undefined);
  };

  const preflightApprovePublish = async (
    requestId: string,
  ): Promise<{ ok: boolean; reason?: string; accountId?: string; edgeId?: string }> => {
    const match = /^publish-(\d+)$/.exec(requestId);
    if (!match) return { ok: true };
    const recordId = Number(match[1]);
    let draft: Awaited<ReturnType<AutomationPublishLogPort['loadForDispatch']>>;
    try {
      draft = await options.publishLog.loadForDispatch(recordId);
    } catch (error) {
      logger.warn(
        `[aidcp-automation] 授权发布前置检查失败，无法读取草稿 requestId=${requestId}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
      return { ok: false, reason: 'publish_target_unavailable' };
    }
    if (!draft) return { ok: false, reason: 'publish_target_unavailable' };
    const edgeId = options.edge.resolveEdgeIdForAccount(draft.accountId);
    if (!edgeId) {
      logger.log(
        `[aidcp-automation] 授权发布已受理：账号 ${draft.accountId} 核心暂离线，`
          + `等待恢复后执行 requestId=${requestId}`,
      );
      return { ok: true, accountId: draft.accountId };
    }
    return { ok: true, accountId: draft.accountId, edgeId };
  };

  /**
   * 待审草稿内容变更后重推预览。
   *
   * **本进程是具名 no-op**：预览要读的是接口属主的稿件行，跨进程后本进程不再跨属主读它，
   * 改由接口进程经界面更新命令推过来（那条通道就是 `publishUiUpdateReceiver`）。
   * 留一行日志而不是静默返回 —— 「没推」与「推了没到」必须分得出来。
   */
  const refreshPublishPreview = (recordId: number): void => {
    logger.warn(
      `[aidcp-automation][ui-snapshot] 本进程不跨属主读稿件预览；`
        + `等待接口进程的界面更新命令 recordId=${recordId}`,
    );
  };

  // 兜底补偿（at-least-once）：低频扫描已授权但未下发的待审草稿补触发，靠下发幂等去重。
  let scanTimer: ReturnType<typeof setInterval> | undefined;
  const start = (): void => {
    const dispatchScanMs = readNumber(env, 'AIDCP_PUBLISH_DISPATCH_SCAN_MS', 60_000);
    if (dispatchScanMs > 0 && !scanTimer) {
      scanTimer = setInterval(() => {
        publishDispatcher.scanAndDispatchApproved().catch(() => undefined);
      }, dispatchScanMs);
      scanTimer.unref?.();
    }
    scheduledPublishReconciler.start();
  };

  return {
    uiSnapshot,
    publishUiUpdateDeps: { uiSnapshot },
    publishUiUpdateReceiver,
    publishDispatcher,
    scheduledPublishReconciler,
    triggerPublishDispatchOnApprove,
    publishDispatchTrigger,
    notifyPublishRejected,
    preflightApprovePublish,
    refreshPublishPreview,
    readPublishApproval,
    buildTodayUsageForAccount,
    start,
    degraded,
    close: async () => {
      if (scanTimer) {
        clearInterval(scanTimer);
        scanTimer = undefined;
      }
      scheduledPublishReconciler.stop?.();
      // 属主池由组装根掌控生命周期，这里**绝不** end 它 —— 单场会话配置那个存储的
      // `close()` 只在自持池时才 end，注入池时是 no-op，故也不必调。
    },
  };
}

/** 下发段运维通知文案。逐条对应一种「没发出去」的真实原因，MUST NOT 合并成一句通用失败。 */
function dispatchNoticeText(kind: string, name: string, ref: string): string {
  switch (kind) {
    case 'edge_offline_waiting':
      return `⏳ 发布待执行：账号「${name}」的批准已受理，但客户端核心暂离线。${ref} 保持授权，核心恢复后会自动尝试执行；当前尚未发布。`;
    case 'offline_requeued':
      return `⚠️ 发布未执行：账号「${name}」边缘离线，${ref} 已退回待审（本次授权作废）。边缘恢复后请重新批准。`;
    case 'browser_slot_waiting':
      return `⏳ 发布排队中：账号「${name}」客户端在线，目标浏览器正在等待本机可用槽位。${ref} 已批准且授权保留，槽位可用后会自动重试，无需重新批准。`;
    case 'acquire_timeout_requeued':
      return `⚠️ 发布未执行：账号「${name}」客户端仍在线，但浏览器未在接管时限内完成暂停当前浏览，${ref} 已退回待审（本次授权作废，未下发发布命令）。请检查浏览器/CDP后重新批准。`;
    case 'cdp_unhealthy_requeued':
      return `⚠️ 发布未执行：账号「${name}」客户端仍在线，但浏览器控制暂不可用，${ref} 已退回待审（本次授权作废，未下发发布命令）。请恢复或重启浏览器客户端后重新批准。`;
    case 'breaker_open':
      return `🔴 发布熔断：账号「${name}」连续下发失败（最近 ${ref}），已停止自动下发其已批草稿。排查边缘后重新批准任一草稿即恢复。`;
    case 'edge_paused_requeued':
      return `⏸️ 发布暂缓：账号「${name}」正处于验证码/风控暂停，${ref} 暂不下发、仍待审（授权保留）。验证码解除后会自动重投，无需重新批准。`;
    case 'preempted_exhausted':
      return `⚠️ 发布反复被打断：账号「${name}」${ref} 连续多次被更高优先任务抢占，已暂停自动重投、仍保持待审（未烧稿）。稍后手动重新批准即可再次尝试。`;
    default:
      return `🟢 发布熔断解除：账号「${name}」人工批准确认，恢复下发已批队列。`;
  }
}

function toUiPublishPreview(preview: unknown): UiPublishPreviewPayload | null {
  if (!preview || typeof preview !== 'object') return null;
  const row = preview as Record<string, unknown> & { id: number };
  return {
    recordId: row.id,
    code: `#${row.id}`,
    kind: row.kind,
    title: row.title ?? '',
    content: row.content,
    topics: row.topics,
    images: row.images,
    contentVersion: row.contentVersion,
    updatedAt: row.updatedAt,
    ...(row.imageReferenceAudit ? { imageReferenceAudit: row.imageReferenceAudit } : {}),
  } as UiPublishPreviewPayload;
}
