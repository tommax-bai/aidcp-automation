/**
 * 受限处置策略的**消费侧接口**（change restricted-policy-global-config，task 1.3）。
 *
 * 定义在 `src/risk/` 而实现于 `src/config/restricted-policy-store.ts`：
 * 依赖方向维持「config → risk 单向」的既成事实（`src/risk/` 对 `src/config/` 的 import
 * 必须保持为 0，有静态断言测试守着；resume-limits.ts 同款划线依据）。
 *
 * 契约（与 QuotaProvider / AccountNurtureProvider 同款）：**同步、零 IO、永不抛**。
 * 两个方法都是**现读**——判定方每次调用取值，MUST NOT 在消费侧再包一层缓存。
 */
import type { RestrictedPolicyMode } from 'aidcp-kernel/kernel/config-panel-ports.js';

export type { RestrictedPolicyMode };

/** 写死默认：只浏览（与配置化之前的行为逐位一致）。 */
export const DEFAULT_RESTRICTED_POLICY_MODE: RestrictedPolicyMode = 'browse_only';
/** 写死默认：受限 72 小时自动恢复（原 RESTRICTED_RECOVERY_MS = 3d 的小时形态）。 */
export const DEFAULT_RESTRICTED_RECOVERY_HOURS = 72;

export interface RestrictedPolicyProvider {
  /** 受限处置模式（每次判定现读，热生效）。 */
  mode(): RestrictedPolicyMode;
  /** 受限自动恢复时长（小时，正整数；缺值 / 非法已在实现侧回落默认）。 */
  recoveryHours(): number;
}

/**
 * 写死默认的 fallback 实现：未接线（单测 / 降级）时行为与配置化之前逐位一致。
 * 装配方 MUST 显式接线 store 实现；本 fallback 的存在是「绝不 brick」，不是接线的替代。
 */
export const FALLBACK_RESTRICTED_POLICY: RestrictedPolicyProvider = {
  mode: () => DEFAULT_RESTRICTED_POLICY_MODE,
  recoveryHours: () => DEFAULT_RESTRICTED_RECOVERY_HOURS,
};

/** 小时 → 毫秒（判窗与 retryAfterMs 共用；集中一处防止散写 `* 3_600_000` 漂移）。 */
export function restrictedRecoveryWindowMs(provider: RestrictedPolicyProvider): number {
  const hours = provider.recoveryHours();
  // 防御：实现侧已回落默认，这里再兜一层「非正有限数 → 默认」，保证窗口恒为正毫秒数。
  const safe = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_RESTRICTED_RECOVERY_HOURS;
  return safe * 3_600_000;
}
