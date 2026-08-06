/**
 * 风控自动恢复扫描器（change restricted-policy-global-config，design D3）。
 *
 * 接活状态机里的恢复死代码：`recoverIfEligible` / 恢复常量在库多年、全仓无人调用，受限账号的
 * 唯一出口一直是人工。本模块以 ~5min 周期（带抖动）扫 `warned` / `restricted` 两态：
 *   - restricted 满窗（`recoveryHours` 策略现读）→ 恢复到 **warned**（逐级回迁，不直跳 normal）；
 *   - warned 满既有 7d 常量 → 恢复到 normal；
 *   - frozen 不进查询、也永不被恢复（唯一出口仍是人工）。
 *
 * 红线：
 *   - **单写通道**：恢复一律经该账号 controller 的 `applySignal({kind:'recovered'})`（内部
 *     recoverIfEligible + persistState + mutation queue 串行），MUST NOT 绕过 controller 直改库。
 *   - **属主隔离**：dev/ol 共库双进程，只对本进程 `execution_target` 拥有的账号动手；归属经
 *     api 归属端口逐账号问（accounts 是 api 域，本进程 MUST NOT 直拼它的 SQL）。
 *   - **写拒诚实放弃**：条件写被拒（并发接管）→ registry 已驱逐 + 告警，本模块只如实计数放弃，
 *     MUST NOT 重试同一次写、MUST NOT 把放弃伪装成已恢复。
 *   - **判窗同源**：满窗判据 = `recoveryAtMs`（与 view 拒绝的 retryAfterMs、续场闸 resumeAt
 *     同一实现）；materialize 后再按 controller 内存态（可能更新鲜）复判一次。
 */
import type { DeploymentTarget } from 'aidcp-kernel/deployment-target.js';

import type { AccountOwnershipReader } from './pg-risk-store.js';
import type { RestrictedPolicyProvider } from './restricted-policy.js';
import { restrictedRecoveryWindowMs } from './restricted-policy.js';
import { recoveryAtMs } from './risk-state-machine.js';
import type { RiskState, RiskStatus } from './types.js';

/** 扫描器要的存储只读面（PgRiskStore.listByStatus 的窄投影）。 */
export interface RecoverySweepStore {
  listByStatus(
    statuses: readonly RiskStatus[],
  ): Promise<Array<Pick<RiskState, 'accountId' | 'status' | 'lastSignalAt' | 'statusSince'>>>;
}

/** 扫描器要的 controller 窄面（RiskController 的结构子集）。 */
export interface RecoverySweepController {
  getState(): RiskState;
  recoveryAt(): number | null;
  applySignal(signal: { kind: 'recovered'; reason?: string }): Promise<RiskState>;
}

export interface RiskRecoverySweeperOptions {
  store: RecoverySweepStore;
  /** 每账号单写通道的解析口（风控底座的 resolveController）。 */
  resolveController: (accountId: string) => Promise<RecoverySweepController>;
  /** 本进程部署目标（属主过滤基准）。 */
  executionTarget: DeploymentTarget;
  /**
   * 归属读口（api 域）。**缺省 = 无从判属主 → 本模块整体不启动**，由装配方决定；
   * 这里仍防御性处理：未注入时 sweepOnce 直接空跑并告警一次，绝不在判不了属主时动手。
   */
  ownership?: AccountOwnershipReader;
  /** 受限恢复窗口的策略现读（warned 窗口维持 7d 常量，不经此口）。 */
  restrictedPolicy: RestrictedPolicyProvider;
  /** 扫描周期基准（默认 5min）；每轮叠 ±10% 抖动。 */
  intervalMs?: number;
  clock?: () => number;
  random?: () => number;
  logger?: Pick<Console, 'log' | 'warn'>;
}

export interface RecoverySweepResult {
  scanned: number;
  /** restricted→warned 恢复数。 */
  restrictedRecovered: number;
  /** warned→normal 回迁数。 */
  warnedRecovered: number;
  /** 非属主跳过数。 */
  skippedNotOwned: number;
  /** 写被拒 / 单账号异常放弃数（已由 registry 告警，这里只如实计数）。 */
  abandoned: number;
}

export const DEFAULT_RECOVERY_SWEEP_INTERVAL_MS = 5 * 60_000;

export class RiskRecoverySweeper {
  private readonly store: RecoverySweepStore;
  private readonly resolveController: (accountId: string) => Promise<RecoverySweepController>;
  private readonly executionTarget: DeploymentTarget;
  private readonly ownership?: AccountOwnershipReader;
  private readonly restrictedPolicy: RestrictedPolicyProvider;
  private readonly intervalMs: number;
  private readonly clock: () => number;
  private readonly random: () => number;
  private readonly logger: Pick<Console, 'log' | 'warn'>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private sweeping = false;
  private warnedMissingOwnership = false;

  constructor(options: RiskRecoverySweeperOptions) {
    this.store = options.store;
    this.resolveController = options.resolveController;
    this.executionTarget = options.executionTarget;
    this.ownership = options.ownership;
    this.restrictedPolicy = options.restrictedPolicy;
    this.intervalMs = options.intervalMs ?? DEFAULT_RECOVERY_SWEEP_INTERVAL_MS;
    this.clock = options.clock ?? Date.now;
    this.random = options.random ?? Math.random;
    this.logger = options.logger ?? console;
  }

  /** 启动：先立即扫一轮（部署首扫会把存量满窗账号成批恢复），再按抖动周期续扫。 */
  start(): void {
    this.stopped = false;
    void this.sweepSafely().finally(() => this.scheduleNext());
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    // ±10% 抖动：双进程共库时避免两边整点齐扫。
    const jittered = Math.round(this.intervalMs * (0.9 + 0.2 * this.random()));
    this.timer = setTimeout(() => {
      void this.sweepSafely().finally(() => this.scheduleNext());
    }, jittered);
    this.timer.unref?.();
  }

  private async sweepSafely(): Promise<void> {
    if (this.sweeping) return; // 上一轮未结束不叠扫
    this.sweeping = true;
    try {
      await this.sweepOnce();
    } catch (err) {
      // 整轮失败（如库暂不可达）只告警、下一轮再来；周期任务 MUST NOT 让异常逃逸。
      this.logger.warn(
        `[risk-recovery] 本轮扫描失败（下一轮重试）：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.sweeping = false;
    }
  }

  /** 单轮扫描（导出供单测与部署观察调用）。逐账号**串行**：成批恢复也不制造写风暴。 */
  async sweepOnce(): Promise<RecoverySweepResult> {
    const result: RecoverySweepResult = {
      scanned: 0,
      restrictedRecovered: 0,
      warnedRecovered: 0,
      skippedNotOwned: 0,
      abandoned: 0,
    };
    if (!this.ownership) {
      // 判不了属主就绝不动手（dev/ol 共库，双写者比不恢复更糟）。只警一次，避免每 5min 刷屏。
      if (!this.warnedMissingOwnership) {
        this.warnedMissingOwnership = true;
        this.logger.warn(
          '[risk-recovery] 归属读口未注入 —— 自动恢复扫描空转（判不了属主绝不发恢复信号）。',
        );
      }
      return result;
    }
    const rows = await this.store.listByStatus(['warned', 'restricted']);
    result.scanned = rows.length;
    const restrictedWindowMs = restrictedRecoveryWindowMs(this.restrictedPolicy);
    for (const row of rows) {
      const now = this.clock();
      // 第一道判窗：按库内行 + 同源函数，不满窗的连归属都不用问。
      const dueAt = recoveryAtMs(row, restrictedWindowMs);
      if (dueAt === null || now < dueAt) continue;
      try {
        const resolution = await this.ownership.resolveExecutionTarget(row.accountId);
        if (resolution.outcome !== 'owned' || resolution.target !== this.executionTarget) {
          result.skippedNotOwned += 1;
          continue;
        }
        const controller = await this.resolveController(row.accountId);
        // 第二道判窗：controller 内存态可能比库行新鲜（窗口内刚来了新信号 / 状态已翻转）。
        // recoveryAt() 与上面是同一实现，读数必然同源。
        const before = controller.getState();
        if (before.status !== 'warned' && before.status !== 'restricted') continue;
        const recoverAt = controller.recoveryAt();
        if (recoverAt === null || this.clock() < recoverAt) continue;
        const after = await controller.applySignal({
          kind: 'recovered',
          reason: `auto_recovery_sweep:${this.executionTarget}`,
        });
        if (before.status === 'restricted' && after.status === 'warned') {
          result.restrictedRecovered += 1;
        } else if (before.status === 'warned' && after.status === 'normal') {
          result.warnedRecovered += 1;
        }
        // 状态没动（并发插入新信号等）不是失败，不计数——recoverIfEligible 已如实拒绝。
      } catch (err) {
        // 条件写被拒（并发接管）→ registry 已驱逐 + P1 告警；其余单账号异常同样只放弃本轮。
        // MUST NOT 重试同一次写：那正是「后写方盖回先写方」的原路。
        result.abandoned += 1;
        this.logger.warn(
          `[risk-recovery] 账号 ${row.accountId} 恢复放弃（本轮不重试）：${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    if (result.restrictedRecovered > 0 || result.warnedRecovered > 0 || result.abandoned > 0) {
      this.logger.log(
        `[risk-recovery] 扫描 ${result.scanned} 账号：restricted→warned ${result.restrictedRecovered}，`
          + `warned→normal ${result.warnedRecovered}，非属主跳过 ${result.skippedNotOwned}，`
          + `放弃 ${result.abandoned}（target=${this.executionTarget}，窗口=${Math.round(restrictedWindowMs / 3_600_000)}h）`,
      );
    }
    return result;
  }
}
