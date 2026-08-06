import type { RiskSignal, RiskState, RiskStatus } from './types.js';
import {
  DEFAULT_RESTRICTED_RECOVERY_HOURS,
  type RestrictedPolicyProvider,
  restrictedRecoveryWindowMs,
} from './restricted-policy.js';

export const WARNED_RECOVERY_MS = 7 * 24 * 60 * 60_000;
/** 历史写死默认（= DEFAULT_RESTRICTED_RECOVERY_HOURS）。现役窗口以策略现读为准（可配）。 */
export const RESTRICTED_RECOVERY_MS = DEFAULT_RESTRICTED_RECOVERY_HOURS * 60 * 60_000;

/**
 * 恢复基点（change restricted-policy-global-config，design D4）：`max(statusSince, lastSignalAt)`。
 *
 * 只看 `lastSignalAt` 的旧守卫有一个已坐实的秒恢复漏洞：`manual_restrict` 不记信号时间戳，
 * `lastSignalAt` 为 null 时窗口守卫直接跳过——一旦有人发恢复信号，手动受限的号会被立即恢复。
 * 取两者较大：手动受限从进入受限时刻起足额等满窗口；窗口内新信号则顺延。
 */
export function recoveryBaseAt(state: Pick<RiskState, 'statusSince' | 'lastSignalAt'>): number {
  // lastSignalAt 缺失回落 statusSince（不是 0）：语义是「无信号时从进入该状态起算」，
  // 用 0 兜底只在「时间恒为正 epoch」这个巧合下才对。
  return Math.max(state.statusSince, state.lastSignalAt ?? state.statusSince);
}

/**
 * 「恢复时刻」的**唯一**推导（design D4）：view 拒绝的剩余等待、续场闸的 resumeAt、
 * 扫描器的满窗判断三处 MUST 全部经此，MUST NOT 各自拼算式。
 *
 * - `restricted` → 基点 + 受限窗口（毫秒；由调用方按策略现读换算好传入）；
 * - `warned` → 基点 + 7 天常量（本 change 不配置化）；
 * - `normal` / `frozen` → null（无自动恢复时刻；frozen 唯一出口是人工）。
 */
export function recoveryAtMs(
  state: Pick<RiskState, 'status' | 'statusSince' | 'lastSignalAt'>,
  restrictedWindowMs: number,
): number | null {
  if (state.status === 'restricted') return recoveryBaseAt(state) + restrictedWindowMs;
  if (state.status === 'warned') return recoveryBaseAt(state) + WARNED_RECOVERY_MS;
  return null;
}

export function createRiskState(accountId: string, now = Date.now()): RiskState {
  return {
    accountId,
    status: 'normal',
    quotaLevel: 'normal',
    signalCount: 0,
    lastSignalAt: null,
    statusSince: now,
    updatedAt: now,
  };
}

export class RiskStateMachine {
  /**
   * 受限恢复窗口的现读来源（change restricted-policy-global-config）。
   * 缺省（不注入）→ 写死默认 72h，与配置化之前逐位一致；warned 维持 7d 常量、frozen 恒 ∞。
   */
  constructor(private readonly restrictedPolicy?: RestrictedPolicyProvider) {}

  transition(state: RiskState, signal: RiskSignal, now = signal.at ?? Date.now()): RiskState {
    const nextStatus = this.nextStatus(state, signal, now);
    const isRiskSignal = signal.kind === 'light' || signal.kind === 'confirmed' || signal.kind === 'fatal';
    // operator_override_recover：特权强制 normal，清零信号计数与窗口（绕过恢复窗口）。
    const forcedRecover = signal.kind === 'operator_override_recover';
    return {
      ...state,
      status: nextStatus,
      signalCount: forcedRecover ? 0 : isRiskSignal ? state.signalCount + 1 : state.signalCount,
      lastSignalAt: forcedRecover ? null : isRiskSignal ? now : state.lastSignalAt,
      statusSince: nextStatus === state.status ? state.statusSince : now,
      updatedAt: now,
    };
  }

  recoverIfEligible(state: RiskState, now = Date.now()): RiskState {
    // 满窗判据经同源函数（recoveryAtMs）：基点 = max(statusSince, lastSignalAt)。
    // 旧守卫只看 lastSignalAt，手动受限（无信号时间戳）会被秒恢复——那正是 D4 修的漏洞。
    const recoverAt = recoveryAtMs(state, this.restrictedWindowMs());
    if (recoverAt === null || now < recoverAt) return { ...state, updatedAt: now };
    if (state.status === 'warned') return { ...state, status: 'normal', signalCount: 0, statusSince: now, updatedAt: now };
    if (state.status === 'restricted') return { ...state, status: 'warned', signalCount: 0, statusSince: now, updatedAt: now };
    return { ...state, updatedAt: now };
  }

  /** 当前受限恢复窗口（毫秒，策略现读；未注入回落写死默认 72h）。 */
  restrictedWindowMs(): number {
    return this.restrictedPolicy ? restrictedRecoveryWindowMs(this.restrictedPolicy) : RESTRICTED_RECOVERY_MS;
  }

  private nextStatus(state: RiskState, signal: RiskSignal, now: number): RiskStatus {
    if (signal.kind === 'fatal' || signal.kind === 'manual_freeze') return 'frozen';
    // 特权强制恢复：无视恢复窗口直接 normal（reason 校验在 controller/路由层）
    if (signal.kind === 'operator_override_recover') return 'normal';
    // 手动加严：normal/warned → restricted；已 restricted/frozen 不变（不降级）
    if (signal.kind === 'manual_restrict') {
      return state.status === 'normal' || state.status === 'warned' ? 'restricted' : state.status;
    }
    if (signal.kind === 'manual_unfreeze' && state.status === 'frozen') return 'restricted';
    if (signal.kind === 'recovered') return this.recoverIfEligible(state, now).status;
    if (signal.kind === 'confirmed') return state.status === 'normal' ? 'restricted' : state.status === 'frozen' ? 'frozen' : 'restricted';
    // 软信号（未知阻断浮层）逐级升：normal→warned→restricted。配额饱和不再是软信号（见
    // change decouple-quota-hit-from-risk）——威胁态只由平台可观测信号升级。
    if (signal.kind === 'light') {
      if (state.status === 'normal') return 'warned';
      if (state.status === 'warned') return 'restricted';
    }
    return state.status;
  }
}
