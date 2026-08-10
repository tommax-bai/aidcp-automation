import {
  FACEBOOK_CADENCE_MODES,
  type FacebookCadenceMode,
} from 'aidcp-kernel/kernel/facebook-operation-policy-resolution.js';

export type { FacebookCadenceMode } from 'aidcp-kernel/kernel/facebook-operation-policy-resolution.js';
export { FACEBOOK_CADENCE_MODES } from 'aidcp-kernel/kernel/facebook-operation-policy-resolution.js';

/**
 * 节奏解释模式的安全解析（change facebook-cadence-probability-mode）。
 * 缺省 / 非法一律回落 `fixed`（= 既有精确计数行为,版本偏斜安全缺省,MUST NOT 静默错标）。
 */
export function resolveFacebookCadenceMode(mode: unknown): FacebookCadenceMode {
  return typeof mode === 'string' && (FACEBOOK_CADENCE_MODES as readonly string[]).includes(mode)
    ? (mode as FacebookCadenceMode)
    : 'fixed';
}

/**
 * 概率模式「本次合格 A 事件是否触发 B」的单点判定：独立掷一次 `random() < 1/n`。
 * n 必须是 ≥1 的整数（配置边界已保证）；n<1 或非有限一律不触发（fail-closed,不放大动作）。
 */
export function facebookCadenceProbabilisticHit(n: number, random: () => number): boolean {
  if (!Number.isFinite(n) || n < 1) return false;
  return random() < 1 / n;
}
