/**
 * 风控单写者与告警底座（task 3.1 · 批 B）。
 *
 * ## 为什么它排在第一个搬
 *
 * 风控是**单写者**：账号风控的最终状态只由这一处写。后面几乎每一批都要向它要控制器
 * （评论、加群、发布、浏览闭环无一例外），而它自己只依赖属主池与几个窄口，不依赖边缘。
 *
 * ## 三条**不许降级**的红线（每条都对着一次会翻倍或会覆盖的真实后果）
 *
 * 1. **抢不到写者锁就不许启用风控写路径。** 两个实例同时持写权，合计放行的真实平台动作会是
 *    单份上限的**两倍**，而且一方刚写下的「受限」会被另一方陈旧的「正常」盖回去。
 *    抢不到时本模块**抛具名错误**（并尽力把一条 P1 告警落库），MUST NOT 返回一个「没有锁的」底座。
 *    ——注意与单体的差别：单体在这里直接 `process.exit(1)`，本模块只抛，
 *    **由进程入口决定怎么退**（工厂里调 `process.exit` 会让它没法被测试，也越权）。
 * 2. **写权中途丢了 = 立刻停发新的互动命令。** 持锁连接一断，数据库那一侧就已经释放了锁，
 *    另一个实例随时可能接管。闸设在每账号准入判定的**公共必经点**上，覆盖是结构性的、
 *    不靠逐处接线（新加一道独立闸必然漏接）。浏览仍放行、记账 outbox 的落账也**刻意不停**
 *    ——那是 append-only 的既成事实账本，停掉它只会把已经发生的动作丢掉。
 * 3. **告警链路没就绪不等于可以不告警。** 告警存储在风控之后才建得出来，所以告警出口是
 *    「先声明、后绑定」的：没绑上时照样 `warn`，可检索性降级但信息不消失。
 *
 * ## 两个**必填**的现读口，别给默认值
 *
 * `mirrorStale` 与 `accountingBlocked` 在单体里恒被喂真实现，本模块把它们做成**必填参数**：
 * 给个恒 `false` 的默认，等于本进程宣称「配置副本永远新鲜」「记账永远没断」——
 * 两句都不是真的，而且错了不报错、只是悄悄放行。批 C 装配它们时编译器会当场点名。
 *
 * `nurture`（养号事实）与 `quotaProvider`（限额配置）在类型上仍是可选的 —— 但**「文档写明的回落」
 * 挡不住「从来没接过线」**。2026-08-04 这两处双双没接，进程照常启动、照常放行，慢启动整段不叠、
 * 后台配的限额一个不算数，零日志零告警。所以现在：两者缺席时本模块**当场各留一条具名 warn**，
 * 说出哪项能力在本进程不生效、后果是什么。装配方 MUST 显式接线，MUST NOT 依赖那条回落。
 */
import pg from 'pg';

import type { DeploymentTarget } from 'aidcp-kernel/deployment-target.js';
import type { AccountOwnershipPort } from 'aidcp-kernel/kernel/account-ownership-port.js';
import type { ConfigMirrorKey } from 'aidcp-kernel/kernel/config-mirror-bump-types.js';
import { resolveOwnerPgConfig } from 'aidcp-kernel/kernel/pg-owner-connection-resolver.js';

import { PgAlertStore } from './alerts/alert-store.js';
import { InteractionFeedStore } from './cache/interaction-feed-store.js';
import { LikedNoteStore } from './cache/liked-note-store.js';
import { ValuableCommentStore } from './cache/valuable-comment-store.js';
import { PgRiskStore } from './risk/pg-risk-store.js';
import { RiskControllerRegistry } from './risk/risk-controller-registry.js';
import type { RiskController } from './risk/risk-controller.js';
import type { AccountNurtureProvider, QuotaProvider } from './risk/types.js';
import {
  AutomationWriterLock,
  resolveWriterLockConnection,
} from './risk/writer-lock.js';
import { ensureCapabilitySchema } from './schema/schema-capability.js';

/** 告警的形状。与告警存储的写口同形，单独声明是为了让本模块的调用方不必 import 存储。 */
export interface AutomationRiskAlertInput {
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  type: string;
  accountId?: string;
  title: string;
  detail: string;
}

/**
 * 抢不到写者锁。**调用方 MUST fail-closed**（进程以非零码退出），
 * MUST NOT 当成「稍后再说」继续启用风控写路径。
 */
export class AutomationWriterLockUnavailableError extends Error {
  readonly code = 'automation_writer_lock_unavailable';

  constructor(
    readonly executionTarget: DeploymentTarget,
    readonly detail: string,
  ) {
    super(`automation writer lock unavailable (${executionTarget}): ${detail}`);
    this.name = 'AutomationWriterLockUnavailableError';
  }
}

export interface AutomationRiskFoundationOptions {
  /** automation 属主池。三张风控表与三个互动存储都落在它上面。 */
  ownerPool: pg.Pool;
  /**
   * 本进程的部署目标。**必填**——单体在缺失时是「不抢锁、不启用归属强制、不启动记账 worker」
   * 的整体 fail-closed，而本进程的存在意义就是承载风控写，缺 target 就没有可交付的形态。
   * 判缺失属进程入口的事（配置读那一层已经拦了），到这里就是有。
   */
  executionTarget: DeploymentTarget;
  /**
   * 账号归属的窄读写口（`accounts` 由接口进程单写）。组装根已有这个客户端，传进来即可。
   * **缺它 ⇒ 属主谓词无从取值 ⇒ 条件写只能退回无谓词覆盖**，跨 target 接管保护随之消失，
   * 所以本模块把「没有它」这件事**说出来**（`ownershipMode` 会是 `off` 并留一行日志），
   * 而不是让存储内部那道降级成为唯一的告知点。
   */
  ownership?: AccountOwnershipPort;
  /** 限额数字的现读来源。缺省 → 派生写死默认（单体同款、明写的回落）。 */
  quotaProvider?: QuotaProvider;
  /** 养号事实。缺省 → 不叠冷启动 clamp（单体同款、明写的回落）。 */
  nurture?: AccountNurtureProvider;
  /**
   * 配置副本陈旧判定（批 C 装配）。**必填、无默认**：恒 false 的默认等于宣称副本永远新鲜。
   */
  mirrorStale: (mirrorKey: ConfigMirrorKey) => boolean;
  /**
   * 记账断链判定（批 C 装配）。**必填、无默认**：恒 false 的默认等于宣称记账永远没断。
   * 断链时该账号的一切互动准入直接拒（浏览仍放行）。
   */
  accountingBlocked: (accountId: string) => boolean;
  /** 冷启动配额爬坡（默认关：配额直接走安全限额配置，不按账号年龄压低）。 */
  coldStartRampEnabled?: boolean;
  /** 慢启动全局停用闸（置真 → 无视所有环境级开关，全体不 clamp）。 */
  slowStartDisabled?: boolean;
  /** 抢锁等待上限。 */
  writerLockWaitMs?: number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /** 替身注入（测试用）。 */
  createWriterLock?: () => Pick<
    AutomationWriterLock,
    'acquire' | 'onLost' | 'release' | 'isHeld'
  >;
  /** 启动期告警的落库口（测试用）；缺省自建一个**专用小池**，见实现处注释。 */
  raiseStandaloneAlert?: (input: AutomationRiskAlertInput) => Promise<void>;
  /**
   * 注册表构造的替身。**存在的理由是一条结构断言**：准入闸只许有一份，
   * 而「注册表拿到的是不是同一个闭包」用行为测试证明不了——第二份实现在写出来那一刻行为完全一致，
   * 要等到某天有人只改了其中一份、且恰好在拒绝真该发生的那一刻才现形。
   */
  createRegistry?: (
    ...args: ConstructorParameters<typeof RiskControllerRegistry>
  ) => RiskControllerRegistry;
}

export interface AutomationRiskFoundation {
  riskRegistry: RiskControllerRegistry;
  /**
   * 风控存储本体（批 F 的当日用量装配按窗口读计数）。
   *
   * **暴露的是注册表用的那一个实例**，不是让调用方另建一个：另建一份会连到同一张表、
   * 读得出同样的数，却各自持一套连接与缓存 —— 错不报错，只是两处慢慢对不上。
   */
  riskStore: PgRiskStore;
  /** 每账号控制器解析。解析过的留一份缓存，供最后一道同步闸 fail-closed 用。 */
  resolveController(accountId: string): Promise<RiskController>;
  /** 已解析过的控制器（同步查，供握着租约的那道同步终闸用）。 */
  resolvedController(accountId: string): RiskController | undefined;
  /** 告警出口。绑定前后都可调：没绑上时照样 warn，绝不静默。 */
  raiseAlert(input: AutomationRiskAlertInput): Promise<void>;
  alertStore?: PgAlertStore;
  likedNoteStore?: LikedNoteStore;
  valuableCommentStore?: ValuableCommentStore;
  interactionFeedStore?: InteractionFeedStore;
  /** 写权是否已经丢失。丢了之后本进程对所有账号拒绝互动准入。 */
  writerAuthorityLost(): boolean;
  /**
   * 互动准入是否被拒（写权丢失 **或** 该账号记账断链）。
   *
   * **与注入给注册表的是同一个闭包，不是第二份判断** —— 握着租约的那道同步终闸要就地问一次，
   * 而它拿不到 controller。第二份实现会在两者漂开的那一刻悄悄放行。
   */
  interactionBlocked(accountId: string): boolean;
  /** 三个互动存储各自的就绪与失败原因（**退化要说得出来**，不是一个 undefined 了事）。 */
  degraded: readonly { store: string; reason: string }[];
  close(): Promise<void>;
}

export async function createAutomationRiskFoundation(
  options: AutomationRiskFoundationOptions,
): Promise<AutomationRiskFoundation> {
  const logger = options.logger ?? console;
  const degraded: { store: string; reason: string }[] = [];

  // ── 告警出口：先声明、后绑定 ──────────────────────────────────────────
  // 告警存储在下面才建得出来，而写者锁的失败告警在那之前就可能发生。
  // 没绑上时**照样 warn** —— 可检索性降级，信息不消失。
  let alertSink: Pick<PgAlertStore, 'raise'> | undefined;
  const raiseAlert = async (input: AutomationRiskAlertInput): Promise<void> => {
    logger.warn(`[aidcp-automation][risk] ${input.title} — ${input.detail}`);
    if (!alertSink) return;
    try {
      await alertSink.raise(input);
    } catch (error) {
      logger.warn(
        `[aidcp-automation][risk] 告警落库失败: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  // 启动期告警（抢锁失败 → 马上就要退出）：此刻告警存储还没建，且我们即将退出，
  // 故临时开一条连接把这条 P1 写进去再走。写不进去也照退——诚实失败优于静默双写。
  // ⚠️ 这里**故意自建一个专用小池**、不注入共享属主池：下面 `finally` 会 `close()`（= 池 end），
  //    注入共享池会把整个属主池 end 掉、连带打死其余十几个存储。
  const raiseStandaloneAlert =
    options.raiseStandaloneAlert
    ?? (async (input: AutomationRiskAlertInput): Promise<void> => {
      const store = new PgAlertStore({
        pool: new pg.Pool({ ...resolveOwnerPgConfig('automation'), max: 1 }),
      });
      try {
        await store.init();
        await store.raise(input);
      } catch (error) {
        logger.error(
          `[aidcp-automation] 启动期告警写入失败: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        await store.close().catch(() => undefined);
      }
    });

  // ── 写者锁：**先抢锁，再建注册表** ─────────────────────────────────────
  let writerAuthorityLost = false;
  const writerLock =
    options.createWriterLock?.()
    ?? new AutomationWriterLock({
      executionTarget: options.executionTarget,
      // ⚠️ MUST NOT 注入属主池：advisory lock 是**会话级**的，池回收连接即释放锁。
      // ⚠️ 也 MUST NOT 把属主连接配置拆成五个字段：属主 URL 已设时那份配置只有连接串，
      //    五字段全 undefined 会一路落到本机默认库——「在错的库上取到锁而且会成功」，
      //    正是这把锁要防的那种失效。
      connection: resolveWriterLockConnection(),
      waitMs: options.writerLockWaitMs ?? 60_000,
      logger,
    });
  const acquired = await writerLock.acquire();
  if (!acquired.ok) {
    const detail =
      `${acquired.detail ?? '未给出原因'}。本进程 MUST NOT 在无锁状态下启用风控写路径——`
      + '两个实例同时持有写权，合计放行的真实平台动作会是单份上限的两倍，'
      + '且一方刚写下的 restricted 会被另一方陈旧的 normal 盖回。'
      + `处理办法：确认 ${options.executionTarget} 上是否已有一个自动化进程在跑`
      + '（部署形态 MUST 是 stop→start，禁止滚动 / 蓝绿）。';
    await raiseStandaloneAlert({
      severity: 'P1',
      type: 'risk_writer_lock_unavailable',
      title: `自动化写者锁获取失败（${options.executionTarget}），进程拒绝启动`,
      detail,
    });
    // 抛，不 exit：怎么退是进程入口的事，工厂里 exit 会让这条路径没法被测试。
    throw new AutomationWriterLockUnavailableError(options.executionTarget, detail);
  }
  logger.log(`[aidcp-automation] 自动化写者锁已持有（target=${options.executionTarget}）`);
  writerLock.onLost((reason) => {
    writerAuthorityLost = true;
    void raiseAlert({
      severity: 'P1',
      type: 'risk_writer_lock_lost',
      title: `自动化写者锁已丢失（${options.executionTarget}），已停止下发新的互动命令`,
      detail:
        `${reason}。持锁连接断开即视为写权丢失：数据库已释放该会话的 advisory lock，`
        + '另一个实例随时可能接管。本进程已 fail-closed（互动准入一律拒绝），'
        + 'MUST 重启本进程重新抢锁；MUST NOT 无锁继续运行。',
    });
  });

  // ── 风控存储与注册表 ────────────────────────────────────────────────
  // 缺归属读口 ⇒ 属主谓词无从取值 ⇒ 只能退回无谓词覆盖。**这里就判掉并说明白**，
  // 免得让存储内部那道降级（同样响亮）成为唯一的告知点。
  const ownershipMode = options.ownership ? 'enforce' : 'off';
  logger.log(
    `[aidcp-automation] 账号归属跟随当次连接：条件写=${ownershipMode}`
      + (ownershipMode === 'off'
        ? '（未装配归属读口 → 无谓词覆盖；跨 target 接管保护不生效）'
        : ''),
  );
  // 判定的两路**现读输入**同样在这里判掉并说出来。它们与归属读口是同一种形状的缺席：
  // 参数可选、缺省有回落，所以缺了不报错、也没有任何现象 —— 而后果是判据被整套换掉。
  // 2026-08-04 实测过这条缺口：本进程接手边缘之后，慢启动整段不叠、后台配的限额一个都不算数，
  // 客户端那半边还照常显示「冷启动 · 第 1 天」（那半边由接口进程直读环境表，是真话）。
  // **MUST NOT 只在源码注释里交代**：一条启动日志是它唯一会被人看见的形态。
  if (!options.quotaProvider) {
    logger.warn(
      '[aidcp-automation] 安全限额配置未接线 —— 本进程按编译期写死的三档默认判定，'
        + '后台限额页改的数字在这里一个都不生效（页面照常能改能存）。',
    );
  }
  if (!options.nurture) {
    logger.warn(
      '[aidcp-automation] 养号事实未接线 —— 慢启动 / 冷启动的逐日天花板在本进程整段不叠，'
        + '一个今天刚开始爬坡的账号会直接按满档跑；「运行方式」也判不出冷启动、恒回落底模式。',
    );
  }
  if (options.quotaProvider && options.nurture) {
    logger.log(
      '[aidcp-automation] 配额判定输入已接线：限额配置 + 养号事实'
        + `（慢启动全局停用=${options.slowStartDisabled ? '开' : '关'}，`
        + `年龄爬坡=${options.coldStartRampEnabled ? '开' : '关'}）`,
    );
  }
  const riskStore = new PgRiskStore({
    pool: options.ownerPool,
    schemaEnsurer: ensureCapabilitySchema,
    executionTarget: options.executionTarget,
    ownershipMode,
    ...(options.ownership ? { ownershipReader: options.ownership } : {}),
  });

  /** 唯一那份准入判定。注册表与同步终闸都取它，**绝不各写一份**。 */
  const interactionBlocked = (accountId: string): boolean =>
    writerAuthorityLost || options.accountingBlocked(accountId);

  const constructRegistry =
    options.createRegistry
    ?? ((...args: ConstructorParameters<typeof RiskControllerRegistry>) =>
      new RiskControllerRegistry(...args));
  const riskRegistry = constructRegistry(
    riskStore,
    undefined,
    options.quotaProvider,
    {
      coldStartRampEnabled: options.coldStartRampEnabled ?? false,
      slowStartDisabled: options.slowStartDisabled ?? false,
      nurtureProvider: options.nurture,
      mirrorStale: options.mirrorStale,
      // 写权丢失与记账断链**共用这一条现读通道**：闸设在全部自动路径的公共必经点上，
      // 覆盖是结构性的。新加一道独立闸必然漏接线。
      interactionBlockedProvider: interactionBlocked,
      executionTarget: options.executionTarget,
      onOwnershipAlert: (info) => {
        void raiseAlert({
          severity: 'P1',
          type: 'risk_controller_evicted_not_owned',
          accountId: info.accountId,
          title: `账号 ${info.accountId} 的风控写被拒（账号已被另一连接接管），已驱逐本地缓存控制器`,
          detail: info.detail,
        });
      },
      logger,
    },
  );

  const resolved = new Map<string, RiskController>();
  const resolveController = async (accountId: string): Promise<RiskController> => {
    const controller = await riskRegistry.getController(accountId);
    resolved.set(accountId, controller);
    return controller;
  };

  // ── 三个互动存储 + 告警存储：init 失败**具名退化**，不阻塞启动、也不静默 ──────────
  const initStore = async <T extends { init(): Promise<unknown> }>(
    name: string,
    store: T,
    onDegrade: string,
  ): Promise<T | undefined> => {
    try {
      await store.init();
      logger.log(`[aidcp-automation] ${name} 已就绪`);
      return store;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      degraded.push({ store: name, reason });
      logger.warn(`[aidcp-automation] ${name} 初始化失败，${onDegrade}: ${reason}`);
      return undefined;
    }
  };

  const alertStore = await initStore(
    'PgAlertStore',
    new PgAlertStore({ pool: options.ownerPool }),
    '告警只留日志、不落库',
  );
  // 绑上之后 raiseAlert 才会落库；在此之前发生的告警已经以 warn 形式留过痕。
  alertSink = alertStore;

  const likedNoteStore = await initStore(
    'LikedNoteStore',
    new LikedNoteStore({ pool: options.ownerPool }),
    '来源血缘退化',
  );
  const valuableCommentStore = await initStore(
    'ValuableCommentStore',
    new ValuableCommentStore({ pool: options.ownerPool }),
    '评论语料库退化',
  );
  const interactionFeedStore = await initStore(
    'InteractionFeedStore',
    new InteractionFeedStore({ pool: options.ownerPool }),
    '面板互动流退化',
  );

  return {
    riskRegistry,
    riskStore,
    resolveController,
    resolvedController: (accountId) => resolved.get(accountId),
    raiseAlert,
    alertStore,
    likedNoteStore,
    valuableCommentStore,
    interactionFeedStore,
    writerAuthorityLost: () => writerAuthorityLost,
    interactionBlocked,
    degraded,
    close: async () => {
      // 只释放本模块自己开的东西。属主池由组装根掌控生命周期，这里**绝不** end 它。
      await writerLock.release().catch(() => undefined);
    },
  };
}
