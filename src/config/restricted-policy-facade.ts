/**
 * 受限处置策略面板外观（全局单例，change restricted-policy-global-config）。
 *
 * 把「策略回显」与「策略写（校验）」收口成可单测的外观，与 server 装配解耦。
 * 复刻 resume-config-facade 通路：automation 独占 store；api 只持 kernel 端口
 * `PanelRestrictedPolicy`（拆进程后经 transport 的内部 HTTP client 过来）。
 *
 * 红线：写前校验（mode 必须在枚举内；recoveryHours 必须正整数且 ≤ 上限）；
 *       任一非法整块拒、绝不部分落库、绝不假成功。回显服务端真态（非乐观；
 *       经提供者回落 → 显示 = 当前真生效）。
 *       本外观只动 restricted_policy_config，不碰风控状态单写路径、不经协议。
 * **MUST NOT 破坏镜像失效接线**：写仍只经 `store.set()` → `writeWithMirrorBump`。
 */

import type {
  PanelRestrictedPolicy,
  RestrictedPolicyMode,
  RestrictedPolicySetResult,
  RestrictedPolicyView,
} from 'aidcp-kernel/kernel/config-panel-ports.js';
import type { RestrictedPolicyPatch, RestrictedPolicyStore } from './restricted-policy-store.js';

export interface RestrictedPolicyFacadeDeps {
  store: RestrictedPolicyStore;
}

const VALID_MODES: readonly RestrictedPolicyMode[] = ['browse_only', 'full_pause'];
/** 恢复时长上限（小时）：30 天。防手滑把窗口写成事实上的「永不恢复」。 */
export const RECOVERY_HOURS_MAX = 720;

export function createRestrictedPolicyPanel(deps: RestrictedPolicyFacadeDeps): PanelRestrictedPolicy {
  // 全局回显：各项经提供者口取（缺行 / 非法已逐项回落 → 显示 = 当前真生效）；
  // overridden 看库内是否存在全局行（false = 显示的是写死默认）。
  const buildView = (): RestrictedPolicyView => {
    const row = deps.store.getRow();
    return {
      mode: deps.store.mode(),
      recoveryHours: deps.store.recoveryHours(),
      overridden: !!row,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
  };

  return {
    getView: async () => buildView(),
    set: async (patch, updatedBy): Promise<RestrictedPolicySetResult> => {
      const storePatch: RestrictedPolicyPatch = {};
      let provided = 0;
      if (patch.mode !== undefined) {
        // 未知模式整块拒（枚举与云端逐字对齐；MUST NOT 静默落库）。
        if (!VALID_MODES.includes(patch.mode)) return { ok: false, reason: 'invalid_value' };
        storePatch.mode = patch.mode;
        provided += 1;
      }
      if (patch.recoveryHours !== undefined) {
        // 非正整数 / 越上限整块拒。
        const hours = patch.recoveryHours;
        if (!Number.isInteger(hours) || hours <= 0 || hours > RECOVERY_HOURS_MAX) {
          return { ok: false, reason: 'invalid_value' };
        }
        storePatch.recoveryHours = hours;
        provided += 1;
      }
      if (provided === 0) return { ok: false, reason: 'no_valid_fields' };

      await deps.store.set(storePatch, updatedBy);
      return { ok: true, view: buildView() };
    },
  };
}
