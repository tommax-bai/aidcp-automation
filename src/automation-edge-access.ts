/**
 * 边缘接入（task 3.1 · 批 D）：本进程与边缘之间那一层。
 *
 * ## 它为什么是一道分水岭
 *
 * 批 B、批 C 搬的都是**本进程自己对自己**的东西（风控写权、记账漏斗、停手闸）。
 * 本批是第一批**产生对外可见行为**的：在它之前，自动化进程对边缘根本不存在——
 * 没有监听、没有握手、没有下发通道。装完之后边缘能连上来、能收到命令、能回执。
 *
 * ## 形态照批 B / 批 C：可单测的工厂，不写进 `main()`
 *
 * 后面几批（E 每连接运行时 / F 发布下发 / G 各类调度器）要拿本批的服务端与租约客户端，
 * 而它们各自的装配与 `main()` 无关。写进 `main()` 只会让所有批都堵在批 H。
 *
 * ## 三个**必填**端口，供给方在后面的批次
 *
 * 单体里这三样是「同一个函数体里的局部变量，恒在」，拆开之后就是三条会静静缺席的边：
 *
 * - {@link AutomationEdgeRuntimePort}（批 E）——每连接私有总线、握手建运行时、按连接解析控制器。
 *   单体里 `handler` 用 `ctx.runtimes!` 取它；**那个 `!` 在本进程里不成立**，
 *   缺了不是崩，是每条入站消息都找不到自己的总线。
 * - {@link AutomationEdgeUiSnapshotPort}（批 F）——握手回填陪伴界面快照。
 * - {@link AutomationEdgeInteractionSupport}（批 B/G）——互动收件箱、运行时开关、握手后的恢复编排。
 *
 * 前两个做成**必填参数**（无默认、无可选链），批 E / 批 F 一开工编译器就点名。
 * 第三个做成**能力二态**：互动能力在单体里本来就会因 schema 不可用而整体缺席，
 * 那是一条文档写明的回落、不是能力静默消失——所以它必须**显式说自己是哪一态**，
 * MUST NOT 用 `undefined` 表示「没接」（那与「接了但今天不可用」同形）。
 *
 * ## 四条**不许降级**的红线
 *
 * 1. **出口闸的 `unknown` 不等于 `blocked`。** 副本陈旧是瞬时基础设施态、全车队同时命中；
 *    把它当拒绝会**连租约归还一起扣住** → 浏览器槽位永不释放、在跑会话无法自然收敛，
 *    而调用方只看到「投递 0 个」，把在线的边缘误报成离线。放行判定取 kernel 那一份
 *    （{@link allowsTransportWhenGateUnknown}），**MUST NOT 在本仓再写一份**——
 *    两侧各写一份的现形方式不是报错，是某一侧悄悄多扣住一类信封。
 * 2. **账号暂停态必须真的接上。** 消息处理器里那一句是
 *    `this.deps.accountState?.pauseStateOf(...) ?? 'active'` ——**不接就是恒「未暂停」**：
 *    运营点了暂停、后台写入成功、账号继续对真实平台动作，全程零报错。
 *    本批用同步读镜像接上它，且陈旧时答 `unknown`（处理器按停手处理），
 *    新鲜度问的是**本进程那一个停手闸**，不是第二份新鲜度判断。
 * 3. **连接一断，租约与在途发布指令都要就地失效。** 只失效租约、不失效在途指令，
 *    等于让正文填写的等待窗口（随长度伸缩、可达数分钟）空转到底，
 *    该账号后面所有已审稿件都堵在串行队列里。
 * 4. **服务端取用是响亮的。** 推送闭包（验证码协助 / 指令定序器 / 租约客户端）都在服务端构造前
 *    就被捕获，单体里写成 `ctx.edgeServer ? … : 0`。本模块换成具名抛错的取用闸：
 *    返回 0 会被调用方读成「边缘不在线」，而真相是「服务端还没建出来」——两者的处置完全相反。
 *
 * ## 本批**不做**的事
 *
 * 不启动监听。`start()` 由进程入口在就绪闸之后调用（批 H），
 * 与「组装根能构造」和「进程能启动」保持分离——这是批 A 立下的中间态保护罩。
 */
import { randomUUID } from 'node:crypto';

import type pg from 'pg';

import type { AccountPausePort, AccountPauseState } from 'aidcp-kernel/kernel/account-pause-port.js';
import type { StructuredNotificationDeliveryInput } from 'aidcp-kernel/kernel/api-direct-port.js';
import type {
  ConfigMirrorGatePort,
  MirrorVersionBumper,
} from 'aidcp-kernel/kernel/config-mirror-bump-types.js';
import type { TextCompletionPort } from 'aidcp-kernel/kernel/llm-contract.js';
import { allowsTransportWhenGateUnknown } from 'aidcp-kernel/kernel/transport-gate-exemptions.js';

import type { AlertData } from './alerts/alert-notification.js';
import type { AlertStore } from './alerts/index.js';
import { PgAnchorCache } from './cache/pg-anchor-cache.js';
import type { ResumeGateVerdict } from './comm/browser-standby.js';
import { CaptchaAssistService } from './comm/captcha-assist.js';
import { CaptchaCoordinator } from './comm/captcha-coordinator.js';
import { EdgeTaskLeaseClient } from './comm/edge-task-lease-client.js';
import type { EdgeResumeCommandReceiverDeps } from './comm/edge-resume-command-receiver.js';
import { DefaultMessageHandler } from './comm/handler.js';
import type { HandlerDeps, HandshakeOutcome } from './comm/handler.js';
import { automationOperationDescriptorFor } from './comm/operation-registry.js';
import type { Envelope } from './comm/protocol.js';
import { EdgeCloudServer } from './comm/ws-server.js';
import type { EdgeSession, WsServerOptions } from './comm/ws-server.js';
import { PacingConfigStore } from './config/pacing-config-store.js';
import type { EventBus } from './event-bus/index.js';
import type { SessionUsageSnapshot } from './orchestrator/role-dispatcher.js';
import { SimplePlanner } from './planner/index.js';
import { CommandSequencer } from './publish-agent/command-sequencer.js';
import {
  DEFAULT_FILL_BUDGET,
  DEFAULT_PUBLISH_LEASE_MS,
  clampFillBudgetToLease,
  sanitizeFillBudget,
  warnIfFillBudgetUnusable,
} from './publish-agent/fill-budget.js';
import type { RiskController } from './risk/risk-controller.js';
import type { AutomationSyncReadMirrors } from './transport/automation-sync-read-mirrors.js';

/**
 * 服务端 / 租约客户端在构造完成前被取用。
 *
 * **它替换的是单体里那句 `ctx.edgeServer ? … : 0`。** 那个 0 的含义是「一条边缘都没推到」，
 * 调用方据此判定边缘离线并走离线分支；而这里真正发生的是装配顺序错了。
 * 两者的处置完全相反，所以 MUST NOT 合并成同一个返回值。
 */
export class AutomationEdgeAccessNotConstructedError extends Error {
  readonly code = 'automation_edge_access_not_constructed';

  constructor(readonly component: string) {
    super(
      `automation edge access component "${component}" was used before construction finished`,
    );
    this.name = 'AutomationEdgeAccessNotConstructedError';
  }
}

/** 每连接运行时（批 E 供给）。单体里是 `ctx.runtimes`。 */
export interface AutomationEdgeRuntimePort {
  /** 该连接私有的事件总线（入站事件灌本连接通道）。 */
  busFor(session: EdgeSession): EventBus;
  /** 握手：建运行时。拒绝时按结构化结果回绝，不抛。 */
  onHandshake(session: EdgeSession): Promise<HandshakeOutcome> | HandshakeOutcome;
  /** 按连接真实账号解析风控控制器。 */
  controllerForSession(session: EdgeSession): RiskController | undefined;
  /** 连接关闭。 */
  onDisconnect(session: EdgeSession): void;
  /** welcome 已回发（传输提交点）→ 该连接可顶替同 edgeId 旧连接并激活浏览业务。 */
  onWelcomed(session: EdgeSession): void;
  /**
   * 本轮会话的用量快照（批 F 的当日用量装配读它）。`null` = 无在跑会话。
   *
   * 这两个读口刻意**挂在同一个端口上**、不另开第二个接口：批 E 供的本来就是同一个注册表实例，
   * 拆成两个接口的唯一后果是它有可能供出两个不同实例 —— 那种错不报错，只是数字对不上。
   */
  sessionUsageForAccount(accountId: string, edgeId?: string): SessionUsageSnapshot | null;
  /** 续场闸裁决（批 F 的浏览器待机提示读它）。`null` = 拿不到（边缘离线 / 无调度器）。 */
  resumeGateForAccount(accountId: string, edgeId?: string): ResumeGateVerdict | null;
}

/** 陪伴界面快照（批 F 供给）。 */
export interface AutomationEdgeUiSnapshotPort {
  /** 握手注册完成后回填该账号的昵称 / 最近发布 / 在途候审。失败**不得**影响连接在线。 */
  pushHelloSnapshot(
    accountId: string | undefined,
    edgeId: string | undefined,
    capabilities: string[] | undefined,
  ): Promise<void>;
}

/** 互动能力（收件箱来自批 B 的存储，恢复编排来自批 G 的下发器与清理服务）。 */
export interface AutomationEdgeInteractionPort {
  inbox: NonNullable<HandlerDeps['interactionInbox']>;
  runtimeControls: NonNullable<HandlerDeps['interactionRuntimeControls']>;
  /**
   * 握手完成后的恢复编排：**先清理待办，其次才是可恢复回复**（单体口径逐条保留）。
   * 失败只留痕，MUST NOT 影响连接在线。
   */
  reconcileOnWelcome(input: {
    accountId: string;
    edgeId: string;
    capabilities: ReadonlySet<string>;
  }): Promise<void>;
  /**
   * 把该账号名下**待办的离场指令**推给它此刻所在的边缘，返回真正推出去的条数。
   *
   * 客户提交离场后由接口进程隔进程调一次（提交与派发已经不在同一个进程里了）。
   * **边缘 id 由本进程就地解析、MUST NOT 由调用方传进来**：那是一次**对外推送**的目标，
   * 而调用方手上只有一份可能陈旧的在场镜像 —— 拿陈旧目标推真指令，
   * 等于把「推给谁」建立在一个过期事实上。真值只在本进程的连接注册表里。
   *
   * 边缘不在线 ⇒ 回 `0`（**这是一个事实，不是失败**）。派发本身失败 ⇒ **抛**，
   * MUST NOT 吞成 0 —— 那会让「推失败了」与「没人可推」同形，而前者需要有人处置。
   */
  dispatchPendingOffboards(accountId: string): Promise<number>;
}

/**
 * 互动能力二态。
 *
 * `unavailable` 是**真实存在的一态**（单体里 schema 不可用即整体缺席），不是「还没接线」的托词；
 * 所以它必须带具名理由，而不是一个 `undefined`。
 */
export type AutomationEdgeInteractionSupport =
  | { state: 'wired'; port: AutomationEdgeInteractionPort }
  | { state: 'unavailable'; reason: string };

/** 风控那一侧本批要用的两口（批 B 的底座直接满足）。 */
export interface AutomationEdgeRiskPort {
  resolveController(accountId: string): Promise<RiskController>;
  raiseAlert(input: {
    severity: 'P0' | 'P1' | 'P2' | 'P3';
    type: string;
    accountId?: string;
    title: string;
    detail: string;
  }): Promise<void>;
  /** 验证码告警落库口（批 B 的告警存储）。退化时缺席——那时告警只留日志。 */
  alertStore?: Pick<AlertStore, 'raise' | 'resolveByEdge'>;
}

/**
 * 结构化通知出口（组装根已有的那个客户端即满足）。
 *
 * 返回值刻意收成 `unknown`：本模块只负责把通知交出去，**三种投递结局
 * （已送达 / 未送达 / 结果未知）的处置归调用方**，在这里判会把它变成第二处判断。
 */
export interface AutomationEdgeNotificationPort {
  deliver(input: StructuredNotificationDeliveryInput): Promise<unknown>;
}

/** 发布授权与草稿图删除（api 属主，组装根已有客户端）。 */
export interface AutomationEdgePublishPort {
  decidePublishApproval(input: {
    payload: Parameters<NonNullable<HandlerDeps['publishApprovalAction']>>[0];
    accountId: string;
  }): ReturnType<NonNullable<HandlerDeps['publishApprovalAction']>>;
  removeDraftImage(input: {
    payload: Parameters<NonNullable<HandlerDeps['publishDraftImageRemove']>>[0];
    session: Parameters<NonNullable<HandlerDeps['publishDraftImageRemove']>>[1];
  }): ReturnType<NonNullable<HandlerDeps['publishDraftImageRemove']>>;
}

/** 环境握手登记（api 属主，组装根已有客户端）。 */
export interface AutomationEdgeEnvironmentRegistryPort {
  registerHandshakeEnvironment(input: {
    envKey: string;
    label: string | null;
    platform: string | null;
    accountId: string | null;
  }): Promise<unknown>;
}

export interface AutomationEdgeAccessOptions {
  /** automation 属主池。锚点缓存与节奏兜底配置都落在它上面。 */
  ownerPool: pg.Pool;
  /**
   * 配置镜像失效信号的推进器（本仓是 outbox 型：同库同事务写一行，中继再异步推给 api）。
   *
   * **必填**：本模块自己构造一个节奏兜底配置存储，而那个存储有写口。
   * `writeWithMirrorBump` 在推进器缺席时的行为是 `if (!bumper) return run(pool)` ——
   * 写照常提交、失效信号从源头就不产生、**不报错也不告警**。写成可选等于把这条静默通道留着；
   * 组装根里它早在本模块的调用点之前就有了，所以「拿不到」从来不是理由。
   */
  mirrorVersionBumper: MirrorVersionBumper;
  /** 边-云 WebSocket 监听端口。 */
  port: number;
  /** 文本模型出口（批 A-1 的工厂产出）。 */
  llm: TextCompletionPort;
  /**
   * 进程级事件总线。**必填、且 MUST 与批 E 的每连接运行时同一个实例**——
   * 本模块自建一个会得到「两条总线各自都对」的静默分裂：入站事件灌进 A、订阅者挂在 B。
   */
  eventBus: EventBus;
  /** 同步读镜像（组装根已有）。账号暂停态与环境出口闸都问它。 */
  mirrors: AutomationSyncReadMirrors;
  /** 本进程的配置副本停手闸（批 C）。 */
  configMirrorGate: ConfigMirrorGatePort;
  /** 风控底座（批 B）。 */
  risk: AutomationEdgeRiskPort;
  /**
   * 记账漏斗（批 C）。**缺省即省略字段**——处理器保持改动前行为（直接 emit，记账由订阅者承担），
   * 这是单体里写明的回落，不是能力静默消失。
   */
  riskAccounting?: NonNullable<HandlerDeps['riskAccounting']>;
  /** 人设读写口（api 属主，automation 模式下就是那个 HTTP 客户端）。 */
  personaService: NonNullable<HandlerDeps['personaService']>;
  /** 发布授权 / 草稿图删除（api 属主客户端）。 */
  edgePublish: AutomationEdgePublishPort;
  /** 结构化通知出口（api 属主客户端）。 */
  notifications: AutomationEdgeNotificationPort;
  /** 环境握手登记（api 属主客户端）。 */
  environmentRegistry: AutomationEdgeEnvironmentRegistryPort;
  /** 每连接运行时（批 E）。**必填**。 */
  runtime: AutomationEdgeRuntimePort;
  /** 陪伴界面快照（批 F）。**必填**。 */
  uiSnapshot: AutomationEdgeUiSnapshotPort;
  /** 互动能力（批 B/G）。**必填二态**。 */
  interaction: AutomationEdgeInteractionSupport;
  /**
   * 账号展示名。**4a 之后展示字段归接口域**，本进程的账号投影刻意不带它——
   * 所以这里默认缺席（验证码卡文案退化成只有 accountId），由需要它的批次显式注入。
   */
  getAccountName?: (accountId: string) => string | null | undefined;
  /** 幂等命令 id 生成（测试可换）。 */
  commandIdGen?: () => string;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /**
   * 服务端构造的替身（测试用）。**它存在的理由是三个回调**——出口闸、连接关闭、握手注册完成——
   * 都是交给服务端的闭包，没有这个缝就只能起真监听、连真连接才碰得到它们，
   * 而它们恰是本模块最会静默出错的三处。
   */
  createServer?: (serverOptions: WsServerOptions) => EdgeCloudServer;
}

/** 出口闸的入参。单列成函数是为了让它可以被直接断言，而不必起一个真监听。 */
export interface AutomationEdgeTransportGateOptions {
  mirrors: Pick<AutomationSyncReadMirrors, 'automationGateForEdgeId'>;
  refusals: Pick<ConfigMirrorGatePort, 'noteStaleRefusal'>;
}

/**
 * 边-云出口闸（三态）。
 *
 * **放行判定本身一行都不在这里**：`unknown` 档该放行哪些信封由 kernel 那一份单写
 * （{@link allowsTransportWhenGateUnknown}），接口进程的出口闸问的是同一份。
 * 在本仓再写一份的现形方式不是报错，是某一侧悄悄多扣住一类信封——
 * 扣住租约归还 = 浏览器槽位永不释放，而调用方只看到「投递 0 个」。
 */
export function createAutomationEdgeTransportGate(
  options: AutomationEdgeTransportGateOptions,
): (envelope: Envelope, edgeId: string) => boolean {
  return (envelope, edgeId) => {
    // 删除本身不经 WS；这两类必须穿透，避免 tombstone 前被环境删除闸自锁。
    if (envelope.type === 'session.end' || envelope.type.startsWith('interaction.offboard.')) {
      return true;
    }
    const gate = options.mirrors.automationGateForEdgeId(edgeId);
    if (gate === 'allowed') return true;
    if (gate === 'blocked') return false;
    const allowed = allowsTransportWhenGateUnknown(
      envelope.type,
      automationOperationDescriptorFor(envelope.type)?.category ?? null,
    );
    // 只有真的拦下来才算一次「因陈旧的拒绝」——放行的那些不记账，否则指标被纯控制面淹没。
    if (!allowed) {
      options.refusals.noteStaleRefusal(
        'client_environment_automation_gate',
        `transport:${envelope.type}`,
      );
    }
    return allowed;
  };
}

export interface AutomationEdgeAccess {
  server: EdgeCloudServer;
  handler: DefaultMessageHandler;
  captchaAssist: CaptchaAssistService;
  captcha: CaptchaCoordinator;
  commandSequencer: CommandSequencer;
  edgeTaskLeases: EdgeTaskLeaseClient;
  pacingFloors: PacingConfigStore;
  /** 账号暂停态三态读口。陈旧 → `unknown`，调用方按停手处理。 */
  accountPause: AccountPausePort;
  /** 喂给组装根 `AutomationRuntimeHandles.edgeResume` 的那一份。 */
  edgeResumeDeps: EdgeResumeCommandReceiverDeps;
  /** 起监听。**进程入口在就绪闸之后调**，工厂本身不起。 */
  start(): Promise<void>;
  /** 退化项（init 失败但不阻塞启动的那些）。**说得出来**，不是一个 undefined 了事。 */
  degraded: readonly { component: string; reason: string }[];
  close(): Promise<void>;
}

function readString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]?.trim();
  return raw ? raw : undefined;
}

function readNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = readString(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function readOptionalNumber(
  env: NodeJS.ProcessEnv,
  name: string,
): number | undefined {
  const raw = readString(env, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** 告警严重度 → 结构化通知的严重度。单体里逐条如此，别在这里“简化”。 */
function notificationSeverity(
  severity: AlertData['severity'],
): 'critical' | 'error' | 'warning' | 'info' {
  if (severity === 'P0') return 'critical';
  if (severity === 'P1') return 'error';
  if (severity === 'P2') return 'warning';
  return 'info';
}

export async function createAutomationEdgeAccess(
  options: AutomationEdgeAccessOptions,
): Promise<AutomationEdgeAccess> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const degraded: { component: string; reason: string }[] = [];
  const commandIdGen = options.commandIdGen ?? (() => randomUUID());

  // ── 响亮取用闸：推送闭包在服务端 / 租约客户端构造前就被捕获 ──────────────────
  // 单体写成 `ctx.edgeServer ? … : 0`。0 的含义是「边缘不在线」，会让调用方走离线分支；
  // 而这里真正发生的是装配顺序错了。两者处置相反，所以具名抛。
  let server: EdgeCloudServer | undefined;
  const requireServer = (component: string): EdgeCloudServer => {
    if (!server) throw new AutomationEdgeAccessNotConstructedError(component);
    return server;
  };
  let edgeTaskLeases: EdgeTaskLeaseClient | undefined;
  const requireLeases = (component: string): EdgeTaskLeaseClient => {
    if (!edgeTaskLeases) throw new AutomationEdgeAccessNotConstructedError(component);
    return edgeTaskLeases;
  };

  // ── 处理器自己的两件依赖：除它之外本进程无人消费 ────────────────────────────
  const planner = new SimplePlanner({ llm: options.llm });
  const anchorCache = new PgAnchorCache({ pool: options.ownerPool });
  try {
    await anchorCache.init();
    logger.log('[aidcp-automation] PG 锚点缓存已就绪');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    degraded.push({ component: 'PgAnchorCache', reason });
    logger.warn(
      `[aidcp-automation] PG 锚点缓存初始化失败，定位退回逐次现算（不阻塞协议处理）: ${reason}`,
    );
  }

  // 节奏兜底 floor：`pacing_floor_config` 是 automation 属主表，本进程读自己的库。
  // init 失败也安全——空镜像 → 逐项回落内置默认，这是该文件写明的回落。
  const pacingFloors = new PacingConfigStore({
    pool: options.ownerPool,
    mirrorVersionBumper: options.mirrorVersionBumper,
  });
  try {
    await pacingFloors.init();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    degraded.push({ component: 'PacingConfigStore', reason });
    logger.warn(
      `[aidcp-automation] 节奏兜底配置初始化失败，逐项回落内置默认: ${reason}`,
    );
  }

  // ── 账号暂停态（三态） ──────────────────────────────────────────────────
  // 单体判据逐字保留：副本陈旧 → `unknown`；副本新鲜时缓存 miss（从未注册 / 从未暂停）→ `active`。
  // **新鲜度问的是本进程那一个停手闸**，不是在这里再写一遍「什么算陈旧」——
  // 第二份判断会在两者漂开的那一刻悄悄放行。
  // 纯取值口，不记账：记账收口在处理器里真正的拒绝点（那里确实少放行了一次平台动作）。
  const accountPause: AccountPausePort = {
    pauseStateOf: (accountId: string): AccountPauseState => {
      if (options.configMirrorGate.isStale('account_status')) return 'unknown';
      return options.mirrors.accountFor(accountId).value?.status === 'paused'
        ? 'paused'
        : 'active';
    },
  };

  // ── 验证码协助与协调 ────────────────────────────────────────────────────
  const captchaAssistEnabled = readString(env, 'AIDCP_CAPTCHA_ASSIST_ENABLED') === 'true';
  const captchaAssist = new CaptchaAssistService({
    enabled: captchaAssistEnabled,
    publicBaseUrl:
      readString(env, 'AIDCP_CAPTCHA_ASSIST_PUBLIC_BASE_URL')
      ?? readString(env, 'AIDCP_PANEL_PUBLIC_BASE_URL'),
    tokenSecret:
      readString(env, 'AIDCP_CAPTCHA_ASSIST_TOKEN_SECRET')
      ?? readString(env, 'AIDCP_PANEL_JWT_SECRET'),
    tokenTtlSeconds: readOptionalNumber(env, 'AIDCP_CAPTCHA_ASSIST_TOKEN_TTL_SECONDS') ?? 30 * 60,
    incidentTtlMs:
      (readOptionalNumber(env, 'AIDCP_CAPTCHA_ASSIST_INCIDENT_TTL_SECONDS') ?? 30 * 60) * 1000,
    // 实时抓帧：默认关（=== 'true' 才开）。三个数字只是给边缘的 hint，边缘一律再钳制。
    liveCapture: {
      enabled: readString(env, 'AIDCP_CAPTCHA_ASSIST_LIVE_ENABLED') === 'true',
      intervalMs: readOptionalNumber(env, 'AIDCP_CAPTCHA_ASSIST_LIVE_INTERVAL_MS'),
      maxDurationMs: readOptionalNumber(env, 'AIDCP_CAPTCHA_ASSIST_LIVE_MAX_DURATION_MS'),
      maxFrames: readOptionalNumber(env, 'AIDCP_CAPTCHA_ASSIST_LIVE_MAX_FRAMES'),
    },
    pusher: {
      pushToEdges: (envelope, edgeId) =>
        requireServer('captchaAssist.pusher').pushToEdges(envelope as Envelope, edgeId),
      // 键入能力 fail-closed 闸：**live 查当前连接**声明的能力位，绝不用 onDetected 时的快照
      // （incident 可能比连接活得久）。
      edgeCapabilities: (edgeId) =>
        requireServer('captchaAssist.edgeCapabilities').edgeCapabilities(edgeId),
    },
    taskLeases: {
      acquire: (request) => requireLeases('captchaAssist.acquire').acquire(request),
      release: (lease, outcome) =>
        requireLeases('captchaAssist.release').release(lease, outcome),
    },
    logger,
    ...(options.getAccountName ? { getAccountName: options.getAccountName } : {}),
  });
  if (captchaAssistEnabled && !captchaAssist.isAvailable()) {
    logger.warn(
      '[aidcp-automation] 验证码云端协助未启用：需要 AIDCP_CAPTCHA_ASSIST_PUBLIC_BASE_URL'
        + ' 或 AIDCP_PANEL_PUBLIC_BASE_URL，并配置 token secret',
    );
  }

  const captcha = new CaptchaCoordinator({
    resolveController: (accountId) => options.risk.resolveController(accountId),
    deliverAlert: async (alert: AlertData) => {
      await options.notifications.deliver({
        commandId: commandIdGen(),
        notification: {
          kind: 'alert',
          input: {
            severity: notificationSeverity(alert.severity),
            title: alert.title,
            detail: alert.detail,
            accountId: alert.accountId,
            actionText: alert.actionText,
            actionUrl: alert.actionUrl,
          },
        },
      });
    },
    ...(options.risk.alertStore ? { alertStore: options.risk.alertStore } : {}),
    ...(options.getAccountName ? { getAccountName: options.getAccountName } : {}),
    assist: captchaAssist,
    // 群解析归接口域（通知路由 4a 之后由通知授权自己决定发到哪），本进程不臆造。
    resolveChatId: async () => '',
  });

  // ── 指令定序器：正文填写预算按长度伸缩，且**收敛到发布租约 TTL 之内** ───────────
  // 不收敛的后果：边缘在打字途中单方面过期租约、恢复浏览循环去滚半写的编辑器。
  const warnBudget = (message: string): void =>
    logger.warn(`[aidcp-automation] ${message}`);
  const publishLeaseMs = readNumber(env, 'AIDCP_EDGE_PUBLISH_LEASE_MS', DEFAULT_PUBLISH_LEASE_MS);
  const fillBudget = clampFillBudgetToLease(
    sanitizeFillBudget(
      {
        baseMs: readNumber(env, 'AIDCP_PUBLISH_FILL_BASE_MS', DEFAULT_FILL_BUDGET.baseMs),
        perCharMs: readNumber(env, 'AIDCP_PUBLISH_FILL_PER_CHAR_MS', DEFAULT_FILL_BUDGET.perCharMs),
        maxMs: readNumber(env, 'AIDCP_PUBLISH_FILL_MAX_MS', DEFAULT_FILL_BUDGET.maxMs),
      },
      warnBudget,
    ),
    publishLeaseMs,
    warnBudget,
  );
  warnIfFillBudgetUnusable(fillBudget, warnBudget);
  const commandSequencer = new CommandSequencer({
    pusher: {
      pushToEdges: (envelope, edgeId) =>
        requireServer('commandSequencer.pusher').pushToEdges(envelope as Envelope, edgeId),
    },
    fillBudget,
    resultSlackMs: readNumber(env, 'AIDCP_PUBLISH_RESULT_SLACK_MS', 8_000),
    logger,
  });

  // ── 边缘任务租约客户端 ──────────────────────────────────────────────────
  edgeTaskLeases = new EdgeTaskLeaseClient({
    pusher: {
      pushToEdges: (envelope, edgeId) =>
        requireServer('edgeTaskLeases.pusher').pushToEdges(envelope, edgeId),
    },
    // 受理超时的生效值只认 EdgeTaskLeaseClient 的类默认（200s）——它必须容得下边缘为停泊账号
    // 原地重开浏览器（死线 180s）。**这里绝不再写一个硬编码回落值**：上一次就是因为抬了类默认
    // 却没改这行，45s 把 200s 永远盖住，那次修复一行都没生效。
    acquireTimeoutMs: readOptionalNumber(env, 'AIDCP_EDGE_TASK_ACQUIRE_TIMEOUT_MS'),
    releaseTimeoutMs: readNumber(env, 'AIDCP_EDGE_TASK_RELEASE_TIMEOUT_MS', 10_000),
    defaultLeaseMs: readNumber(env, 'AIDCP_EDGE_TASK_LEASE_MS', 5 * 60_000),
    // 活跃租约被抢占 → 就地 reject 属于该 taskId 的在飞发布指令，由定序器按
    // preempted / submitted_unconfirmed 归类，**绝不 unwind 整条发布序列**（防提交后被抢重投双发）。
    onActiveLeasePreempted: (taskId, _edgeId, reason) =>
      commandSequencer.preemptTask(taskId, reason),
    logger,
  });

  // ── 消息处理器 ─────────────────────────────────────────────────────────
  let interactionPort: AutomationEdgeInteractionPort | undefined;
  if (options.interaction.state === 'wired') {
    interactionPort = options.interaction.port;
  } else {
    logger.warn(
      `[aidcp-automation] 互动能力未接入（${options.interaction.reason}）——`
        + '本进程不协商互动能力位、不受理互动入站消息。'
        + '这是显式声明的缺席，不是「接了但没生效」。',
    );
  }
  const handler = new DefaultMessageHandler({
    configMirrorGate: options.configMirrorGate,
    planner,
    llm: options.llm,
    cache: anchorCache,
    publishApprovalNotifier: async (data) => {
      await options.notifications.deliver({
        commandId: `publish-approval:${data.requestId}`,
        notification: { kind: 'publish_approval', input: data },
      });
    },
    eventBus: options.eventBus,
    accountState: accountPause,
    captcha,
    captchaAssist,
    commandSequencer,
    edgeTaskLeases,
    personaService: options.personaService,
    publishApprovalAction: (payload, session) => {
      if (!session.accountId) {
        return Promise.resolve({
          requestId: payload?.requestId ?? '',
          ok: false,
          reason: 'edge_publish_authority_unavailable',
        });
      }
      return options.edgePublish.decidePublishApproval({
        payload,
        accountId: session.accountId,
      });
    },
    publishDraftImageRemove: (payload, session) =>
      options.edgePublish.removeDraftImage({ payload, session }),
    // 多租户路由：三条都必填，缺一条不是崩、是每条入站消息找不到自己的总线。
    busFor: (session) => options.runtime.busFor(session),
    onHandshake: (session) => options.runtime.onHandshake(session),
    resolveController: (session) => options.runtime.controllerForSession(session),
    ...(options.riskAccounting ? { riskAccounting: options.riskAccounting } : {}),
    pacingFloors,
    ...(interactionPort
      ? {
          interactionInbox: interactionPort.inbox,
          interactionRuntimeControls: interactionPort.runtimeControls,
        }
      : {}),
    logger,
  });

  // ── 边-云 WebSocket 服务端 ──────────────────────────────────────────────
  const constructServer = options.createServer ?? ((o: WsServerOptions) => new EdgeCloudServer(o));
  server = constructServer({
    port: options.port,
    handler,
    // 三态出口闸：
    // - allowed → 放行；
    // - blocked → 环境正处于删除生命周期，**确定态**，除既有豁免外一律不放行；
    // - unknown → 出口闸副本陈旧，**瞬时基础设施态、全车队同时命中**。此时只拦「新的真实平台动作」，
    //   控制面与收尾类照常放行。把 unknown 当 blocked 会连租约释放一起扣住 →
    //   浏览器槽位不归还、在跑会话无法自然收敛。判定单写在 kernel。
    canPushToEdge: createAutomationEdgeTransportGate({
      mirrors: options.mirrors,
      refusals: options.configMirrorGate,
    }),
    onClose: (session) => {
      if (session.edgeId) {
        edgeTaskLeases!.invalidateEdge(session.edgeId);
        // 在途发布指令一并诚实失败：正文填写的等待窗口随长度伸缩（可达数分钟），
        // 边缘一死若还傻等满预算，该账号后面所有已审稿件都被堵在串行队列里。
        commandSequencer.invalidateEdge(session.edgeId);
      }
      options.runtime.onDisconnect(session);
    },
    onEdgeRegistered: (session) => {
      // **顺序有意义**：welcome 是传输提交点，只有走到这里的新连接才可顶替同 edgeId 旧连接
      // 并激活浏览业务。后面那些回填都是 fire-and-forget，失败不影响连接在线。
      options.runtime.onWelcomed(session);
      void options.uiSnapshot
        .pushHelloSnapshot(session.accountId, session.edgeId, session.capabilities)
        .catch((error: unknown) => {
          logger.warn(
            '[aidcp-automation][ui-snapshot] hello 快照回填失败（连接保持在线）'
              + ` account=${session.accountId ?? '-'} edge=${session.edgeId ?? '-'}: `
              + `${error instanceof Error ? error.message : String(error)}`,
          );
        });
      if (session.accountId && session.edgeId && interactionPort) {
        void interactionPort
          .reconcileOnWelcome({
            accountId: session.accountId,
            edgeId: session.edgeId,
            capabilities: new Set(session.capabilities ?? []),
          })
          .catch((error: unknown) =>
            logger.warn(
              `[aidcp-automation][interaction] Edge 恢复编排失败 account=${session.accountId}: `
                + `${error instanceof Error ? error.message : String(error)}`,
            ),
          );
      }
      // 自动登记环境进管理侧注册表：AdsPower 分身（edgeId=ads-<分身id>）一连上来就进「待分配」池，
      // **只登记、不归属**。self- / host- 兜底 edge 不是可分配环境，跳过。
      const edgeId = session.edgeId;
      if (edgeId && edgeId.startsWith('ads-')) {
        void options.environmentRegistry
          .registerHandshakeEnvironment({
            envKey: edgeId.slice('ads-'.length),
            label: session.accountNickname ?? null,
            platform: session.platform ?? null,
            accountId: session.accountId ?? null,
          })
          .catch((error: unknown) =>
            logger.warn(
              `[aidcp-automation][client-env] 自动登记环境失败 edge=${edgeId}: `
                + `${error instanceof Error ? error.message : String(error)}`,
            ),
          );
      }
    },
  });

  const constructedServer = server;
  return {
    server: constructedServer,
    handler,
    captchaAssist,
    captcha,
    commandSequencer,
    edgeTaskLeases,
    pacingFloors,
    accountPause,
    edgeResumeDeps: { wsServer: constructedServer },
    start: () => constructedServer.start(),
    degraded,
    close: async () => {
      // 只关本模块自己开的东西 —— 也就是服务端。
      // ⚠️ **MUST NOT 调 `anchorCache.close()`**：它内部是 `pool.end()`，而这个池是注入进来的
      //    共享属主池；关掉它会连带打死本进程其余十几个存储。批 B 的启动期告警池踩的是同一条。
      //    锚点缓存本身无定时器、无连接自持，不关它不泄漏任何东西。
      await constructedServer.close().catch(() => undefined);
    },
  };
}
