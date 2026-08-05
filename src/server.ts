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
 * 3. 信号与关停**不归本文件管**，见下。
 *
 * ## 本文件 MUST NOT 注册终止信号处理器
 *
 * 信号的唯一属主是启动外壳（`automation-service-entry.ts` 的 `onSignal`）：它收到第一个信号就
 * **摘掉自己**，好让第二个信号落回 Node 默认处置、当场结束进程 —— 那是关停卡住时运维唯一
 * 不必去找 kill -9 的路子。
 *
 * 本文件曾经另挂过一个**从不摘除**的处理器，把第二个信号吞成一行「重复信号」就返回。
 * 后果不是多打一行日志，而是**那条逃生口彻底失效**：发多少个 SIGTERM 都杀不掉这个进程。
 * 而它一直没被用例抓到，因为覆盖信号的那条用例驱动的是注入的假信号源 ——
 * 它看得见外壳挂的那一个，看不见本文件挂在真 `process` 上的那一个。
 *
 * ## 部署形态 MUST 是 stop→start，禁止滚动 / 蓝绿
 *
 * 风控写者锁是**会话级 advisory lock、构造期就抢**：两个进程重叠期间后起的那个会抢不到锁并
 * 拒绝启动。所以收到信号后要**真的等关停做完**再让进程退出，不能立刻 `process.exit()` ——
 * 那会把锁留给一个已经不存在的会话，下一个进程要等它超时。这条约束现在由启动外壳落实
 * （`onSignal` 先 await 关停、再显式退出），本文件不参与。
 */
import { isDirectExecution, runAutomationEntry } from './automation-composition-root.js';

export { runAutomationEntry } from './automation-composition-root.js';

function logEvent(event: string, detail: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ service: 'aidcp-automation', event, ...detail }));
}

if (isDirectExecution(import.meta.url)) {
  void runAutomationEntry()
    .then((service) => {
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
