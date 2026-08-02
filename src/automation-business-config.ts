/**
 * 四个业务配置的取值口实现（change split-cloud-automation-production-runtime 批 H 第一片）。
 *
 * 它填的是每连接调度器工厂留下的 {@link AutomationBusinessConfigPorts} ——
 * 排期 / 活跃周历 / 热帖阈值 / Facebook 评论配置 / Facebook 运营基线，五条全是**同步热路径读**。
 *
 * ## 这一片为什么不是「再实现一遍」
 *
 * 五条判定**全部**住在公共契约层（批 E-2 步骤 1/2 已把它们从接口属主存储里析出）。
 * 本文件只做两件事：从同步读镜像取快照、把它喂给那一份判定。
 * **MUST NOT 在这里出现任何解析逻辑** —— 「账号覆盖 ?? 全局回落」「未配模式一律按模板」
 * 「无行即完全不自动」这些判断各只有一份，两个进程调的是同一个函数。
 * 各写一份的现形方式不是报错，而是同一个账号在两个进程里算出不同的生效值，
 * 而两边各自的测试都会绿。
 *
 * ## 四条不许降级的红线
 *
 * 1. **排期快照没到位 ⇒ 按「这个账号没有排期行」处置**（判定给出全 off = 完全不自动）。
 *    这是安全方向：读不到配置时**少做**，绝不按上一次的印象继续跑。
 * 2. **Facebook 正文方案在快照陈旧时 MUST 报 `unavailable`** —— 既不猜模板、也不猜生成式。
 *    猜错的两个方向后果都不小：猜模板会发出一条运营早就改掉的正文，猜生成式会绕过运营的显式配置。
 * 3. **运营基线的环境解析器 MUST 取镜像自己那一份**（按引用），不在这里另写。
 *    它决定整个 Facebook 浏览模式，答不出基线在下游就是「这个账号永远不开始浏览」。
 * 4. **全局活跃周历来自本进程自己的会话配置**（automation 属主），不从接口域取。
 *    排期判定要的两个掩码来源本就不同，混成一个来源会让其中一个恒空。
 */
import {
  resolveEffectiveActiveWeekMask,
  resolveEffectiveContentSchedule,
  type EffectiveContentSchedule,
} from 'aidcp-kernel/kernel/content-schedule-resolution.js';
import {
  resolveHotLeadGateConfig,
  type HotLeadGateConfig,
} from 'aidcp-kernel/kernel/hot-lead-gate-config.js';
import {
  facebookCommentModeFromWire,
  resolveEffectiveFacebookCommentConfig,
  type EffectiveFacebookCommentConfig,
} from 'aidcp-kernel/kernel/facebook-comment-config-types.js';
import type { FacebookOperationPolicyBaseResolution } from 'aidcp-kernel/kernel/facebook-operation-policy-resolution.js';

import type { AutomationBusinessConfigPorts } from './automation-connection-dispatcher.js';
import type { AutomationSyncReadMirrors } from './transport/automation-sync-read-mirrors.js';

/** 本片用到的镜像取用面。窄成这四条，免得把整个镜像类当依赖传。 */
export type AutomationBusinessConfigMirrors = Pick<
  AutomationSyncReadMirrors,
  'businessConfig' | 'facebookOperationBaseFor' | 'facebookEnvironmentForAccount'
>;

export interface AutomationBusinessConfigOptions {
  mirrors: AutomationBusinessConfigMirrors;
  /**
   * 全局活跃周历。**本进程自己的会话配置**（automation 属主，直读不走镜像）——
   * 排期判定要的两个掩码来源本就不同：内容掩码随排期快照来自接口域，活跃掩码在这一侧。
   */
  globalActiveWeekMask(): string | null;
}

export function createAutomationBusinessConfigPorts(
  options: AutomationBusinessConfigOptions,
): AutomationBusinessConfigPorts {
  const { mirrors } = options;

  /** 排期快照 + 账号 → 生效排期。快照没到位即按「没有这个账号的行」处置（红线 1）。 */
  const effectiveScheduleFor = (accountId: string): EffectiveContentSchedule => {
    const lookup = mirrors.businessConfig('content_schedule');
    const snapshot = lookup.state === 'fresh' ? lookup.value : null;
    const account =
      snapshot?.accounts.find((row) => row.accountId === accountId) ?? null;
    return resolveEffectiveContentSchedule(account, {
      activeWeekMask: options.globalActiveWeekMask(),
      contentActiveMask: snapshot?.global?.contentActiveMask ?? null,
    });
  };

  return {
    effectiveScheduleFor,

    /**
     * 活跃周历。**走判定那一份的两参数入口**，不复用上面那条整份排期解析 ——
     * 后者会连带解析四组模式与日上限，而这里只要一个掩码。
     */
    effectiveActiveWeekMaskFor: (accountId: string): string | null => {
      const lookup = mirrors.businessConfig('content_schedule');
      const account =
        lookup.state === 'fresh'
          ? lookup.value?.accounts.find((row) => row.accountId === accountId) ?? null
          : null;
      return resolveEffectiveActiveWeekMask(
        account?.activeWeekMask,
        options.globalActiveWeekMask(),
      );
    },

    /**
     * 热帖阈值。快照本身就是**已解析好的成品**（属主侧算完再发）。
     *
     * **陈旧时保留上一份，不退回写死默认**：它是参数档不是闸门档，而写死默认很可能比
     * 运营配的值**更松** —— 一陈旧就悄悄把闸放宽，方向正好反了。
     * 只有一次都没收到过快照时才用默认（那时没有「上一份」可言）。
     */
    hotLeadGateConfig: (): HotLeadGateConfig => {
      const lookup = mirrors.businessConfig('hot_lead_config');
      if (!lookup.value) return resolveHotLeadGateConfig(null);
      return { ...lookup.value };
    },

    /** Facebook 正文方案。陈旧一律 `unavailable`（红线 2）。 */
    facebookCommentBodyScheme: (
      accountId: string,
    ): 'template' | 'generated' | 'unavailable' => {
      const lookup = mirrors.businessConfig('facebook_comment_config');
      if (lookup.state !== 'fresh' || !lookup.value) return 'unavailable';
      const row = lookup.value.accounts.find((entry) => entry.accountId === accountId);
      // 没有这个账号的行 = 没配过 ⇒ 判定给出「按模板」，与单体逐位一致（不是猜）。
      return resolveEffectiveFacebookCommentConfig(
        row ? facebookCommentFactsOf(row) : null,
      ).commentMode;
    },

    /** Facebook 评论配置生效值。与上面那条**同一次解析**（红线：两条口不许各算一遍）。 */
    facebookCommentConfigFor: (accountId: string): EffectiveFacebookCommentConfig => {
      const lookup = mirrors.businessConfig('facebook_comment_config');
      const row =
        lookup.state === 'fresh'
          ? lookup.value?.accounts.find((entry) => entry.accountId === accountId) ?? null
          : null;
      return resolveEffectiveFacebookCommentConfig(row ? facebookCommentFactsOf(row) : null);
    },

    /** Facebook 运营基线。环境解析器按引用取镜像那一份（红线 3）。 */
    facebookOperationBaseFor: (
      accountId: string,
    ): FacebookOperationPolicyBaseResolution =>
      mirrors.facebookOperationBaseFor(accountId, (id) =>
        mirrors.facebookEnvironmentForAccount(id),
      ),
  };
}

/**
 * 快照行 → 判定要的账号事实。
 *
 * **只此一处做线缆写法还原**：快照上的正文模式是复数 `templates`，领域写法是单数 `template`，
 * 顺手写 `mode === 'template'` 会恒 false 且不报错 —— 结果不是崩溃，是运营配好的模板
 * 被静静换成生成式正文。
 */
function facebookCommentFactsOf(row: {
  keywords: readonly string[];
  containers: readonly { url: string; name?: string }[];
  commentMode: 'generated' | 'templates';
  commentModeConfigured: boolean;
  commentTemplates: readonly string[];
}) {
  return {
    keywords: row.keywords,
    containers: row.containers,
    commentMode: facebookCommentModeFromWire(row.commentMode),
    commentModeConfigured: row.commentModeConfigured,
    commentTemplates: row.commentTemplates,
  };
}
