/**
 * 自动化进程的启动外壳（task 3.1/3.2/3.3 的骨架部分，批 A）。
 *
 * ## 它是什么、不是什么
 *
 * 这里只有**进程生命周期**：读配置 → 建组装根 → 先监听 → 就绪闸 → 放行业务入口 → 优雅关停 → 信号处理。
 * 更早的两步（schema 契约门 → 建属主池 → 造那十几个工厂）发生在 `main()` 里、调本外壳之前；
 * 门那一步靠 {@link AutomationServiceOptions.schemaGate} 这张必填回执在编译期钉住顺序。
 * 它**不构造任何业务运行时**。运行时依赖（{@link AutomationRuntimeHandles}）与业务入口
 * （{@link AutomationBusinessIngress}）都是**必填参数、没有缺省**——批 B…G 把真实供给方逐批搬进来时，
 * 编译器会当场逼调用方面对「这两样从哪来」，而不是让一个空壳悄悄跑起来。
 *
 * ## 可执行入口仍然是 fail-closed，本文件没有动它
 *
 * `runAutomationEntry()` 照旧读完配置就抛「未就绪」，直到那份台账清零（批 H 才切）。
 * 这个分离是有意的：**「组装根能构造」与「进程能启动」是两件事**。
 * 本外壳让前者可以被真的跑起来、被测试，而后者仍然被那道闸挡着——
 * 中间态没有保护罩的话，一个搬到一半的运行时会以「已就绪」的姿态上线。
 *
 * **批 H MUST NOT 把那道闸删掉换成直接调本函数**：切换本身要有用例证明「台账非空时仍然拒绝启动」。
 *
 * ## 就绪闸的四个要点（照接口进程那份办，缺一不可）
 *
 * 1. 一个已启动布尔 + 一个 `startBusinessIfReady()`，三个条件任一成立就早退：
 *    **正在关闭 / 已经启过 / 同步读就绪度不是 ready**。
 * 2. **用一个在途 promise 去重**，而不是只看那个布尔——否则「首轮刷新完成」与「就绪度巡视」
 *    两个触发点并发调用时会**启动两次业务入口**。「重复的就绪信号不重复放行」靠的是这个去重。
 * 3. 周期性任务在业务入口起来**之后**才起，且 `unref()`——否则进程会因为一个定时器不肯退出。
 * 4. **先监听、再放行业务**：就绪探活路由要在业务入口起来之前就可访问，
 *    否则外部分不出「还没就绪」与「进程没起来」。探活响应里**必须**带上业务入口有没有放行，
 *    「监听着但没放行业务」这个中间态必须是可观测的，否则运维只看到端口通、以为一切正常。
 */
import type pg from 'pg';

import {
  AUTOMATION_PG_OWNERS,
  type AutomationSchemaGateReceipt,
} from './automation-schema-gate-startup.js';
import {
  createAutomationCompositionRoot,
  readAutomationRootConfig,
  type AutomationCompositionRoot,
  type AutomationRootConfig,
  type AutomationRootSyncReadOverrides,
  type AutomationRuntimeHandles,
  type AutomationSyncReadReadiness,
} from './automation-composition-root.js';

/**
 * 就绪探活路由。**只有这一份定义**——将来若有客户端来读，从这里取常量，别在两侧各手写一次路径。
 * （实测过的滑手形态：注册时手写一遍路径、不用共享常量，`typecheck` 完全绿，只有真跑起来才 404。）
 */
export const AUTOMATION_SYNC_READ_READINESS_ROUTE =
  'internal/automation/sync-read/readiness';

/**
 * 业务入口：本进程对外真正开始接活的那一下（边-云监听放行、调度器起转、总线开始派发）。
 *
 * 拆成 start/stop 两半而不是塞进组装根，是为了让**就绪闸有东西可以挡**：
 * 组装根的 `start()` 管的是「配置面与同步读活起来」，那必须先发生；业务入口是就绪之后才放行的那一层。
 */
export interface AutomationBusinessIngress {
  /** 放行业务。**MUST 是幂等安全的**：外壳虽已去重，但重启动语义仍归实现方保证。 */
  start(): Promise<void>;
  /** 停业务。只在 start 真的成功过之后才会被调用。 */
  stop(): Promise<void>;
  /**
   * 释放**构造期就已经占住的**资源。**无论业务入口有没有放行过，关停时一定会被调用一次。**
   *
   * ## 为什么必须与 `stop()` 分开，而且是必填
   *
   * `stop()` 只在 `start()` 真的成功过之后才调（见 {@link stopService}）。但本进程里有三样东西
   * **在工厂构造期就产生了副作用**，那时业务入口离放行还差一整个就绪闸：
   *
   * - 风控单写者锁：构造期就抢，**抢到之后靠会话保活**；
   * - 记账漏斗的三张周期表：构造期就起转；
   * - 模型出口的角色模型轮询：构造期就起转。
   *
   * 于是有一条真空路径——**同步读一直不就绪、然后收到终止信号**：此路径上 `start()` 从未成功，
   * `stop()` 因此一次都不会被调，上面三样全部泄漏。其中写者锁最重：它靠会话保活，
   * 进程只要没真正退出就一直握着，**下一个自动化进程等锁到超时后会直接拒绝启动**——
   * 现象是「新进程起不来」，而根因在上一个进程的关停路径，排查方向完全错开。
   *
   * 做成**必填、无缺省**是为了让这件事在编译期可见：批 H 写业务入口时，编译器会当场
   * 逼调用方回答「构造期占了什么、谁来还」。给它一个可选的空实现，就等于让这条真空
   * 重新变得不可见。**确实没有构造期资源要还时，写一个空实现并注明理由**，别把方法删掉。
   */
  dispose(): Promise<void>;
}

/** 信号源。抽出来是为了让测试驱动它，生产上就是 `process`。 */
export interface AutomationSignalSource {
  on(signal: 'SIGTERM' | 'SIGINT', handler: () => void): unknown;
  off(signal: 'SIGTERM' | 'SIGINT', handler: () => void): unknown;
}

export interface AutomationServiceOptions {
  /** 运行时依赖。**必填、无缺省**：批 B…G 逐批补齐它的真实供给方。 */
  runtime: AutomationRuntimeHandles;
  /** 业务入口。**必填、无缺省**，理由同上。 */
  businessIngress: AutomationBusinessIngress;
  /**
   * schema 契约门跑过了的回执。**必填、无缺省，且外部造不出来**
   * （只能由 {@link runAutomationStartupSchemaGate} 返回）。
   *
   * ## 它在这里，是为了把「门必须先跑」变成编译期可见的顺序约束
   *
   * 门 MUST 跑在**任何存储 init 之前**，而调本外壳时属主池与那十几个工厂**都已经造好了**
   * （工厂在构造期就抢写者锁、起周期表，见 {@link AutomationBusinessIngress.dispose}）。
   * ⇒ 门的正确位置只有一个：`main()` 的第一句，建池之前。
   *
   * 而「没调门」这件事在行为上**什么都不表现**——进程照起、日志照打、用例照绿，
   * 只有 schema 真落后的那一次才爆，且那时门已经不在场了。既然行为测试原理上看不见它，
   * 就让**类型**担保：想调本外壳，就必须先拿到一张只能由 `runAutomationStartupSchemaGate()`
   * 发出的回执。
   *
   * 本外壳不重跑门（那会变成一次进程内的重复判定），只做两件事：核回执判过的属主集合
   * 与本进程真正建池的属主集合一致，以及把结论打进启动日志。
   */
  schemaGate: AutomationSchemaGateReceipt;
  /** 直接给配置；不给就按环境变量读（缺项一律具名抛错，不给默认值）。 */
  config?: AutomationRootConfig;
  env?: NodeJS.ProcessEnv;
  /**
   * 属主库连接池。**调用方自己建了池就必须从这里传进来。**
   *
   * 不传的话组装根会自建一个（见 `createAutomationCompositionRoot` 的 `ownsPool`）——
   * 而业务入口那十几个工厂要的是**同一个** automation 属主池。两条各自建池的路径
   * 都能跑起来、都不报错，结果是同一个库上开着两套连接，且本仓没有任何断言会说话。
   *
   * **关停责任随之转移**：传了池就意味着 `ownsPool === false`，`root.close()` 便**不会**
   * 关它——调用方 MUST 在 `service.close()` 落地之后自己关。
   */
  ownerPool?: pg.Pool;
  /** 建根的替身，测试用。 */
  createRoot?: (options: {
    config: AutomationRootConfig;
    runtime: AutomationRuntimeHandles;
    ownerPool?: pg.Pool;
    syncRead?: AutomationRootSyncReadOverrides;
  }) => AutomationCompositionRoot;
  syncRead?: AutomationRootSyncReadOverrides;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /**
   * 信号处理挂在哪。传 `null` 表示不挂（测试与嵌入式调用用）。缺省是 `process`。
   */
  signals?: AutomationSignalSource | null;
  /** 就绪度巡视周期。业务入口放行后立即停表。 */
  readinessWatchMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearTimer?: (handle: ReturnType<typeof setInterval>) => void;
}

export interface AutomationService {
  /** 内部 HTTP 真实监听端口。 */
  port: number;
  /** 同步读就绪度。 */
  readiness(): AutomationSyncReadReadiness;
  /** 业务入口有没有放行。**与 readiness 分开报**：就绪了不等于已经放行。 */
  businessIngressStarted(): boolean;
  /** 优雅关停。可重复调用，恒返回同一个在途 promise。 */
  close(): Promise<void>;
}

const DEFAULT_READINESS_WATCH_MS = 5_000;

export async function startAutomationService(
  options: AutomationServiceOptions,
): Promise<AutomationService> {
  const logger = options.logger ?? console;
  const config = options.config ?? readAutomationRootConfig(options.env ?? process.env);
  const createRoot = options.createRoot ?? createAutomationCompositionRoot;
  const readinessWatchMs = options.readinessWatchMs ?? DEFAULT_READINESS_WATCH_MS;
  const setTimer =
    options.setTimer ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((handle: ReturnType<typeof setInterval>) => clearInterval(handle));

  // 门判过的属主集合 MUST 与本进程真正建池的属主集合逐个吻合 —— 对不上即拒绝启动，不是告警。
  // 判少了：真在用的库没被校验过（门看着绿、其实什么都没校验到）；
  // 判多了：本进程根本不连那个库，却在替它的 schema 背书。单体侧同一条不变量写在
  // `assertOwnerPoolsMatchProcessOwners`，这里是它在本进程的形态（本仓恒只连 automation）。
  const judged = [...options.schemaGate.owners].sort().join(',');
  const opened = [...AUTOMATION_PG_OWNERS].sort().join(',');
  if (judged !== opened) {
    throw new Error(
      `schema_gate_owner_scope_mismatch: 门判了 [${judged}]，本进程建池 [${opened}]。`
        + '两者必须一致——否则要么真在用的库没被校验，要么在替本进程不连的库背书。',
    );
  }

  const root = createRoot({
    config,
    runtime: options.runtime,
    ownerPool: options.ownerPool,
    syncRead: options.syncRead,
  });

  let businessIngressStarted = false;
  let businessStart: Promise<void> | null = null;
  let readinessWatch: ReturnType<typeof setInterval> | null = null;
  let closing = false;
  let closePromise: Promise<void> | null = null;
  const signalSource: AutomationSignalSource | null =
    options.signals === null ? null : options.signals ?? process;

  // 要点 4：探活路由在 listen 之前注册，且把「业务入口放行了没有」一并报出去。
  root.internalServer.registerBearer(
    AUTOMATION_SYNC_READ_READINESS_ROUTE,
    config.automationInternalToken,
    async () => {
      const readiness = root.syncRead.readiness();
      return {
        service: 'automation',
        executionTarget: config.executionTarget,
        businessIngressStarted,
        state: readiness.state,
        checkedAt: readiness.checkedAt,
        blockers: readiness.blockers,
      };
    },
  );

  const stopReadinessWatch = (): void => {
    if (readinessWatch === null) return;
    clearTimer(readinessWatch);
    readinessWatch = null;
  };

  // 要点 1 + 2：三个早退条件 + 在途 promise 去重。
  const startBusinessIfReady = async (): Promise<void> => {
    if (closing || businessIngressStarted) return;
    if (root.syncRead.readiness().state !== 'ready') return;
    if (!businessStart) {
      businessStart = (async () => {
        await options.businessIngress.start();
        businessIngressStarted = true;
        stopReadinessWatch();
      })().finally(() => {
        businessStart = null;
      });
    }
    await businessStart;
  };

  // 要点 3：巡视表本身也 unref —— 它在业务放行前就存在，不该拖住进程退出。
  const armReadinessWatch = (): void => {
    if (closing || businessIngressStarted || readinessWatch !== null) return;
    readinessWatch = setTimer(() => {
      void startBusinessIfReady().catch((error: unknown) => {
        logger.warn(
          '[aidcp-automation] 业务入口放行失败，进程继续监听并保持未放行：'
            + describeError(error),
        );
      });
    }, readinessWatchMs);
    readinessWatch.unref?.();
  };

  const detachSignals = (): void => {
    if (!signalSource) return;
    signalSource.off('SIGTERM', onSignal);
    signalSource.off('SIGINT', onSignal);
  };

  const stopService = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      detachSignals();
      stopReadinessWatch();
      // 关停时可能正有一次放行在途：等它落地再停，否则会出现「stop 了但 start 还在跑」。
      const inflight = businessStart;
      if (inflight) await inflight.catch(() => undefined);
      if (businessIngressStarted) {
        await options.businessIngress.stop();
        businessIngressStarted = false;
      }
      // 构造期占住的资源**无条件**归还：`stop()` 只在放行过之后才跑，而写者锁 / 周期表 /
      // 模型轮询在就绪闸之前就已经占着了。「一直没就绪就收到终止信号」正是它们唯一的泄漏路径。
      // 放在 root.close() 之前：它们用的是本进程的属主池与连接，晚于根关停就没得还了。
      await options.businessIngress.dispose();
      await root.close();
    })();
    return closePromise;
  };

  /**
   * 收到信号就摘掉自己再关停 —— **第二个信号因此落回 Node 默认处置（立刻结束）**。
   * 这是有意的：关停若卡住，运维不该被迫去找 kill -9，而本外壳也不该自己发明一个超时上限。
   */
  function onSignal(): void {
    logger.log('[aidcp-automation] 收到终止信号，开始优雅关停');
    void stopService().catch((error: unknown) => {
      logger.error('[aidcp-automation] 优雅关停失败：' + describeError(error));
      process.exitCode = 1;
    });
  }

  if (signalSource) {
    signalSource.on('SIGTERM', onSignal);
    signalSource.on('SIGINT', onSignal);
  }

  let port: number;
  try {
    // 组装根的 start() 自己就是「先 listen 再跑首轮同步读刷新」，要点 4 由它保证。
    port = await root.start();
  } catch (error) {
    await stopService().catch(() => undefined);
    throw error;
  }

  try {
    await startBusinessIfReady();
  } catch (error) {
    // 首轮放行失败**不等于启动失败**：监听已经起来了，探活能如实报「未放行」，巡视会继续重试。
    logger.warn(
      '[aidcp-automation] 首轮业务放行失败，进程保持监听且业务仍未放行：' + describeError(error),
    );
  }
  if (!businessIngressStarted) armReadinessWatch();

  const readiness = root.syncRead.readiness();
  logger.log(
    `[aidcp-automation] 内部 API 已监听 127.0.0.1:${port}`
      + `（target=${config.executionTarget}；schema 门=${options.schemaGate.mode}/`
      + `${options.schemaGate.pass ? '通过' : '未通过'}；同步读就绪度=${readiness.state}`
      + `；业务入口=${businessIngressStarted ? '已放行' : '未放行'}`
      + `${readiness.state === 'ready' ? '' : `；阻塞流=${readiness.blockers.map((blocker) => blocker.stream).join(',')}`}）`,
  );

  return {
    port,
    readiness: () => root.syncRead.readiness(),
    businessIngressStarted: () => businessIngressStarted,
    close: stopService,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
