/**
 * 自动化进程的可执行入口。
 *
 * **2026-08-03 台账清零之后，它从「读完配置就抛未就绪」切成了真启动。** 那道就绪闸没有被删，
 * 只是不再恒真（见 `assertAutomationRootReady`）—— 将来真发现一条新依赖时，它仍然是唯一
 * 会拦住启动的东西。
 *
 * ## 这个文件只做三件事，别往里加业务
 *
 * 1. 调 `runAutomationEntry()`（读配置 → 过闸 → 真装配），**成功后不退出**：进程的生命周期
 *    由内部 HTTP 监听与边缘 WS 撑着；
 * 2. 失败时打一条结构化日志并**以非 0 退出**。systemd 是 `Restart=on-failure`，
 *    所以「起不来」会表现成重启循环 —— 那是设计（比一个静默半死的进程好查）；
 * 3. 收到 SIGTERM / SIGINT 时**优雅关停一次**：停业务入口、还锁、关池。
 *
 * ## 部署形态 MUST 是 stop→start，禁止滚动 / 蓝绿
 *
 * 风控写者锁是**会话级 advisory lock、构造期就抢**：两个进程重叠期间后起的那个会抢不到锁并
 * 拒绝启动。所以这里收到信号后要**真的等关停做完**再让进程退出，不能立刻 `process.exit()` ——
 * 那会把锁留给一个已经不存在的会话，下一个进程要等它超时。
 */
import { isDirectExecution, runAutomationEntry } from './automation-composition-root.js';
import type { AutomationService } from './automation-service-entry.js';

export { runAutomationEntry } from './automation-composition-root.js';

function logEvent(event: string, detail: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ service: 'aidcp-automation', event, ...detail }));
}

/**
 * 装一次关停。**重复信号只关一次**（第二次 SIGTERM 常见于编排器强杀前的催促），
 * 但两次都要如实留痕 —— 「又来了一个信号」与「第一个信号没生效」现象一样、原因完全不同。
 */
function installShutdown(service: AutomationService): void {
  let closing: Promise<void> | null = null;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (closing) {
        logEvent('shutdown_signal_repeat', { signal });
        return;
      }
      logEvent('shutdown_begin', { signal });
      closing = service
        .close()
        .then(() => {
          logEvent('shutdown_complete', { signal });
        })
        .catch((error: unknown) => {
          // 关停失败也要以非 0 退出：静默退 0 会让编排器把这次当成一次干净下线。
          logEvent('shutdown_failed', {
            signal,
            message: error instanceof Error ? error.message : String(error),
          });
          process.exitCode = 1;
        });
    });
  }
}

if (isDirectExecution(import.meta.url)) {
  void runAutomationEntry()
    .then((service) => {
      installShutdown(service);
      logEvent('started', { port: service.port });
    })
    .catch((error: unknown) => {
      const detail = error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: 'UnknownError', message: String(error) };
      console.error(JSON.stringify({
        service: 'aidcp-automation',
        // 事件名从 `startup_blocked` 改成 `startup_failed`：入口切成真启动之后，
        // 「被台账挡住」只是众多失败原因之一，再叫 blocked 会把「配置错 / 库连不上 / 抢不到写者锁」
        // 一律说成「还没接线完」。
        event: 'startup_failed',
        ...detail,
      }));
      process.exitCode = 1;
    });
}
