/**
 * 养号事实在自动化进程里的**唯一取用口**。
 *
 * ## 为什么需要这个文件
 *
 * 慢启动 / 冷启动的逐日天花板由风控控制器在每次准入判定时现算，它要四样事实：账号平台、
 * 账号入库时刻、当前绑定环境的慢启动起点与毕业时刻、Facebook 逐日曲线。这四样的事实源全在
 * **接口域**，本进程只有同步读副本 —— 副本早就在（批 H 把第四项也补齐了），缺的一直是把它们
 * 合成一个 `AccountNurtureProvider` 递给风控底座的这一步。
 *
 * 缺这一步的现形方式**不是报错**：那个参数是可选的，缺省语义写着「不叠 clamp」。于是拆分部署
 * 之后，一个环境里明明写着今天开始慢启动的新账号，按满档跑了一整天，日志一行没有，客户端左边
 * 还照常显示「冷启动 · 第 1 天」（那半边由接口进程直读环境表，是真话）。2026-08-04 实测：
 * 当日上限 浏览 150 / 点赞 50 / 评论 8 / 关注 15，而第 1 天曲线是 20 / 2 / 0 / 1。
 *
 * ## 三条回落方向，都按「哪边更严」定
 *
 * 1. **平台读不到 ⇒ `undefined`（未知），MUST NOT 回落任何具体平台**：回落一次就是 FB 号按
 *    小红书曲线跑（第 1 天 view=50 而非 20）。消费方据「未知」判不 clamp，而**停止放行真实
 *    平台动作由配置副本停手闸负责**（账号状态副本正是它的闸门键之一）——配额层 MUST NOT 顶替它。
 * 2. **绑定歧义 / 该账号不在名册里 ⇒ `null`（没有锚点）**：这是真结论，不是缺席。挑一个环境的
 *    起点用等于替运营做了一个没法复核的选择。
 * 3. **曲线那条流一次都没到过 ⇒ 整个方法不存在**，见下方 `facebookSlowStartPolicy` 的注释。
 *
 * 副本**陈旧**这一态刻意不在本文件处置：消费方自己按 `client_environment_slow_start` 判，
 * 并在陈旧时退到最保守锚点（第 1 天）。两处各判一次就会出现「取值口说没有、消费方说第 1 天」。
 */
import type {
  AccountNurtureProvider,
  ActionQuota,
} from 'aidcp-kernel/kernel/risk-contract.js';

import type { AutomationSyncReadMirrors } from './transport/automation-sync-read-mirrors.js';

/** 本模块要用的镜像取用面。窄成三条，免得把整个镜像类当依赖传。 */
export type AutomationNurtureMirrors = Pick<
  AutomationSyncReadMirrors,
  'accountFor' | 'slowStartForAccount' | 'facebookSlowStartPolicy'
>;

export function createAutomationNurtureProvider(
  mirrors: AutomationNurtureMirrors,
): AccountNurtureProvider {
  return {
    platformFor(accountId: string): string | undefined {
      return mirrors.accountFor(accountId).value?.platform ?? undefined;
    },

    slowStartSinceFor(accountId: string): number | null {
      const lookup = mirrors.slowStartForAccount(accountId);
      return lookup.resolution === 'known' ? lookup.slowStartSince : null;
    },

    slowStartCompletedAtFor(accountId: string): number | null {
      const lookup = mirrors.slowStartForAccount(accountId);
      return lookup.resolution === 'known' ? lookup.slowStartCompletedAt : null;
    },

    /**
     * **这是一个 getter，不是普通方法**，而且必须是。
     *
     * 契约只承认一种「这条流还没到过」的表达方式：**方法本身不在**。消费方两个取用点写的是
     * `nurtureProvider?.facebookSlowStartPolicy?.()` 与 `...?.().totalDays ?? 默认`——
     * 方法不在时可选链把整条链短路掉，消费方回落到编译期那条 FB 曲线（**仍然 clamp**）；
     * 而一个「存在但返回 undefined」的方法会让第二个取用点在 `.totalDays` 上当场炸。
     *
     * 流的到位与否是运行期才知道的，取用口却只构造一次 —— getter 是唯一能把「按次判断在不在」
     * 表达出来的形态。**MUST NOT 改成恒定义的方法 + 内部回落到写死曲线**：那样一来「运营配的
     * 曲线」和「编译期默认」在本进程就再也分不出来了，而后者很可能更松。
     */
    get facebookSlowStartPolicy():
      | (() => { totalDays: number; dailyCaps: ActionQuota[] })
      | undefined {
      const lookup = mirrors.facebookSlowStartPolicy();
      // 判据是**载荷在不在**，不是状态串叫什么：镜像在「重新同步中」时状态同样报 `unknown`，
      // 但它手上还留着上一份载荷 —— 那一份要用，丢掉它就等于让一条恢复中的流把 clamp 放宽。
      if (!lookup.value) return undefined;
      const snapshot = lookup.value;
      // 陈旧时**沿用上一份**（`value` 就是最后收到的那份），MUST NOT 因陈旧回落写死默认：
      // 这是参数档不是闸门档，而编译默认很可能比运营配的更松，一陈旧就悄悄放宽方向正好反了。
      return () => ({
        totalDays: snapshot.totalDays,
        dailyCaps: [...snapshot.dailyCaps],
      });
    },

    createdAtFor(accountId: string): number | undefined {
      return mirrors.accountFor(accountId).value?.createdAt ?? undefined;
    },
  };
}
