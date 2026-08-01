/**
 * 每连接运行时（task 3.1 · **批 E 的前半**）。
 *
 * ## 为什么把批 E 切成两半
 *
 * 批 E 原计划一次搬完「每连接私有总线 + 每连接角色调度器」。实读后这两件事的体量差着一个数量级：
 * **注册表本身**（握手准入 → 建私有总线 → 解析控制器 → welcome 提交 → 断连拆除）是一块自洽的东西；
 * 而**调度器工厂**是整个自动化段最密的一处，一个函数就 400 余行、读写二十来个存储与策略，
 * 其中相当一部分的供给方要到批 G 才有。
 *
 * 一次搬完必然停在「编不过的中间态」，而这一批恰恰是**批 D 与批 F 都在等的那个口** ——
 * 拖着它，那两批留下的必填口就一直是空的。所以本模块只做前半，
 * 把调度器工厂做成**必填注入口**（{@link AutomationDispatcherFactory}），由批 E 后半供。
 *
 * **这不是「搬了一半」**：本模块自身可编译、可单测，且它交付的正是那个口的完整实现。
 * 后半缺席是**编译期可见**的 —— 这与批 B 留给批 C 的两个必填口是同一个办法。
 *
 * ## 三条**不许降级**的红线
 *
 * 1. **缺 / 空账号标识一律拒绝握手。** MUST NOT 偷偷映射成某个默认账号开跑 ——
 *    那会让一台配错的机器安静地拿别人的账号去动真实平台。拒绝时**发一条具名通知**，
 *    因为这类错只能靠人去改启动器，没人看见就永远不会被修。
 * 2. **welcome 是传输提交点。** 建调度器、读人设、顶替同环境旧连接这些业务动作
 *    MUST 全部排在 welcome 写出之后 —— 排在之前的话，一次业务闸失败会被升级成传输握手失败，
 *    边缘看到的是「连不上」，而真相是「连上了但人设没绑」。
 * 3. **归属切换后 MUST 驱逐本进程缓存的控制器。** 账号刚从另一台机器切过来，
 *    本进程那份内存**既有陈旧计数、也有陈旧状态**；只重放计数会漏掉状态 ——
 *    陈旧的「正常」会在下次条件写时盖回接管方刚写的「受限」，而那时归属谓词已经通过，
 *    最后一道保护不再触发，**静默覆盖就此发生**。
 *
 * ## 一处刻意的不对称：动作冷却闸是**单例共享**
 *
 * 它内部按账号分桶，同账号 N 条连接共用同一条冷却时间线。做成每连接一个的话，
 * 同账号两条连接会各自持一条时间线 —— 而它防的正是「同账号并行会话同刻双发」。
 * 它是**兜底闸、不是数量闸**（数量单归风控配额主闸）。
 */
import type { DeploymentTarget } from 'aidcp-kernel/deployment-target.js';
import type { AccountOwnershipPort } from 'aidcp-kernel/kernel/account-ownership-port.js';
import { normalizePlatformId } from 'aidcp-kernel/kernel/platform-types.js';
import type { PlatformId } from 'aidcp-kernel/kernel/platform-types.js';
import type { StructuredNotificationDeliveryInput } from 'aidcp-kernel/kernel/api-direct-port.js';

import { ConnectionRuntimeRegistry } from './orchestrator/connection-runtime.js';
import type {
  DispatcherBuildContext,
  RuntimeRegistryDeps,
} from './orchestrator/connection-runtime.js';
import type { RoleDispatcher } from './orchestrator/role-dispatcher.js';
import { ActionCooldownGate } from './risk/action-cooldown.js';
import { InteractionGuardRegistry } from './risk/interaction-guard.js';
import type { RiskControllerRegistry } from './risk/risk-controller-registry.js';
import type { EventBus } from './event-bus/index.js';
import type { EdgeSession } from './comm/ws-server.js';

/**
 * 每连接角色调度器的构造工厂（**批 E 后半供给**）。
 *
 * 做成必填注入口而不是可选：没有它，握手能过、私有总线也建得出来，
 * 但那条连接**永远不会开始浏览** —— 而这在日志上与「账号今天没排期」完全同形。
 */
export type AutomationDispatcherFactory = (
  context: DispatcherBuildContext,
) => RoleDispatcher;

/** 账号主数据的窄口（api 属主，组装根已有客户端）。 */
export interface AutomationAccountRuntimePort {
  /** 握手时对新账号做幂等 upsert：**不覆盖已配置行、不默认启用**。 */
  ensureAccount(accountId: string, platform?: string): Promise<void>;
  /** 读账号平台。读不到时**由调用方决定回落**，本口不替它兜。 */
  getPlatformOrNull(accountId: string): Promise<string | null>;
  /** 比较后写昵称（属主侧一次往返，避免「先读后写」在跨进程下的竞态）。 */
  recordNickname(accountId: string, nickname: string): Promise<unknown>;
}

/** 归属跟随当次连接。**缺任一项即整段不启用**，与未接归属时逐位一致。 */
export interface AutomationOwnershipWiring {
  executionTarget: DeploymentTarget;
  port: AccountOwnershipPort;
  /** 告警出口（批 B 的底座）。 */
  raiseAlert(input: {
    severity: 'P0' | 'P1' | 'P2' | 'P3';
    type: string;
    accountId?: string;
    title: string;
    detail: string;
  }): Promise<void>;
}

export interface AutomationConnectionRuntimeOptions {
  /**
   * 进程级观测总线。**MUST 与批 D 的消息处理器同一个实例** ——
   * 每连接私有总线会 tee 到它，两个实例的后果是看板聚合与风控记账各看见一半。
   */
  observerBus: EventBus;
  /** 风控注册表（批 B）。握手取的是**可写**控制器：此时归属闸已放行。 */
  riskRegistry: Pick<RiskControllerRegistry, 'getWritableController' | 'evict'>;
  /** 每连接角色调度器工厂（批 E 后半）。**必填**。 */
  buildDispatcher: AutomationDispatcherFactory;
  /** 账号主数据窄口（api 属主客户端）。 */
  accountRuntime: AutomationAccountRuntimePort;
  /** 关掉某条连接（批 D 的服务端）：同环境重连顶替时收掉旧连接。 */
  closeEdge(sessionId: string): void;
  /** 结构化通知出口（握手配置错误要发出去，否则没人会去修启动器）。 */
  notifications: { deliver(input: StructuredNotificationDeliveryInput): Promise<unknown> };
  /** 归属跟随。缺省 = 整段不启用（与未接归属逐位一致）。 */
  ownership?: AutomationOwnershipWiring;
  /**
   * 账号平台读不到时的回落。默认小红书 —— 与单体逐字一致。
   *
   * **回落写在这一层，不写进属主口**：属主口如实答 `null`，
   * 「不知道」与「就是小红书」在那一层必须分得开。
   */
  fallbackPlatform?: PlatformId;
  commandIdGen?: () => string;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface AutomationConnectionRuntime {
  /** 交给批 D 的消息处理器与批 F 的用量装配的那个口。 */
  runtimes: ConnectionRuntimeRegistry;
  /** 同账号 N 连接共用的互动去重守卫（下发互动前占坑，防两节点对同一目标重复动作）。 */
  interactionGuards: InteractionGuardRegistry;
  /** 动作冷却兜底闸（单例，内部按账号分桶）。 */
  actionCooldown: ActionCooldownGate;
  close(): Promise<void>;
}

/**
 * 重启冷启动静默期。
 *
 * 冷却是内存态、重启即清零 ⇒ 兜底对「每账号每动作的首发」是瞎的，静默期补上这一发的最小间距。
 * 默认与冷却同值，同受「兜底必须比主闸松」这条不变量约束 ——
 * 早先默认 3 分钟等于把病灶从冷却搬到静默期：严 12 倍，且严于关注 / 评论主闸的地板。
 */
const RESTART_QUIET_DEFAULT_MS = 15_000;

export function createAutomationConnectionRuntime(
  options: AutomationConnectionRuntimeOptions,
): AutomationConnectionRuntime {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const commandIdGen = options.commandIdGen ?? (() => `handshake-${Date.now()}`);
  const fallbackPlatform: PlatformId = options.fallbackPlatform ?? 'xiaohongshu';

  const interactionGuards = new InteractionGuardRegistry();

  const rawQuietMs = Number(env.AIDCP_RESTART_QUIET_MS ?? RESTART_QUIET_DEFAULT_MS);
  const actionCooldown = new ActionCooldownGate({
    startedAtMs: Date.now(),
    restartQuietMs:
      Number.isFinite(rawQuietMs) && rawQuietMs >= 0 ? rawQuietMs : RESTART_QUIET_DEFAULT_MS,
  });

  // 缺 / 空账号标识 → 配置错误。拒绝握手在注册表里完成，这里只负责**把人叫去修启动器**：
  // 这类错没有自愈路径，不发出去就永远停在那台机器上。
  const onConfigError = async (session: EdgeSession, message: string): Promise<void> => {
    logger.error(
      `[aidcp-automation] 握手配置错误 edge=${session.edgeId ?? '-'}: ${message}`,
    );
    try {
      await options.notifications.deliver({
        commandId: commandIdGen(),
        notification: {
          kind: 'operational_text',
          input: {
            route: 'default',
            text:
              `⚠️ 边缘节点握手被拒（配置错误）：edge=\`${session.edgeId ?? '-'}\``
              + `${session.machineLabel ? `（${session.machineLabel}）` : ''} 未声明账号标识。\n`
              + '请为该节点启动器显式设置账号标识。',
          },
        },
      } as StructuredNotificationDeliveryInput);
    } catch (error) {
      logger.error(
        `[aidcp-automation] 握手配置错误通知发送失败: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const ownershipWiring: RuntimeRegistryDeps['ownership'] = options.ownership
    ? {
        executionTarget: options.ownership.executionTarget,
        port: options.ownership.port,
        onEvent: (info) => {
          void options.ownership!.raiseAlert({
            // 首次驱动（无归属 → 本机）P3；跨机接管（别的机器 → 本机）P2，运营值得看一眼。
            severity: info.previousTarget === null ? 'P3' : 'P2',
            type: 'risk_owner_driver_switched',
            accountId: info.accountId,
            title:
              info.previousTarget === null
                ? `账号 ${info.accountId} 首次由 ${info.ownerTarget} 驱动，归属已设为 ${info.ownerTarget}`
                : `账号 ${info.accountId} 由 ${info.previousTarget} 切换到 ${info.ownerTarget} 驱动`,
            detail: info.detail,
          });
        },
        // 归属切换后 MUST 驱逐缓存的控制器。**只重放计数是不够的**：
        // 陈旧的「正常」会在下次条件写时盖回接管方刚写的「受限」，而那时归属谓词已经通过、
        // 最后一道保护不再触发 —— 静默覆盖就此发生。驱逐后下次物化会从库重读状态并回放计数。
        onClaimed: async (accountId: string) => {
          options.riskRegistry.evict(accountId);
        },
      }
    : undefined;

  const runtimes = new ConnectionRuntimeRegistry({
    observerBus: options.observerBus,
    // 握手解析该连接账号的控制器：此时归属闸已放行，故取**可写**口。
    getController: (accountId) => options.riskRegistry.getWritableController(accountId),
    buildDispatcher: options.buildDispatcher,
    ensureAccount: async (accountId, platform) => {
      try {
        await options.accountRuntime.ensureAccount(accountId, platform);
      } catch (error) {
        // 登记失败**不阻塞握手**：账号行是主数据，缺它不影响这条连接本身能不能建。
        // 但要说出来 —— 静默吞掉会让「新账号一直不出现在后台」查无可查。
        logger.warn(
          `[aidcp-automation] ensureAccount(${accountId}) 失败（不阻塞握手）: `
            + `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    getAccountPlatform: async (accountId) => {
      // 读不到 → 由**这里**回落，不在属主口里兜。别名归一取共用的那一份，本仓不另写映射表。
      const platform = await options.accountRuntime.getPlatformOrNull(accountId);
      return platform === null ? fallbackPlatform : normalizePlatformId(platform);
    },
    recordNickname: (accountId, nickname) =>
      options.accountRuntime.recordNickname(accountId, nickname).then(() => undefined),
    onConfigError,
    closeEdge: (sessionId) => options.closeEdge(sessionId),
    ...(ownershipWiring ? { ownership: ownershipWiring } : {}),
    logger,
  });
  logger.log(
    '[aidcp-automation] 连接运行时注册表就绪（按连接多租户编排，握手建运行时、断连拆除）'
      + `；归属跟随=${ownershipWiring ? '启用' : '未启用'}`,
  );

  return {
    runtimes,
    interactionGuards,
    actionCooldown,
    close: async () => {
      // 注册表按连接持有，生命周期跟着连接走；进程关停时由批 D 的服务端 close 触发拆除。
      // 这里没有自己开的定时器或连接，故无事可关 —— 但保留这个方法，
      // 让关停路径的形状与其它几批一致，别让调用方去记「哪个有 close 哪个没有」。
    },
  };
}
