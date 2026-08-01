/**
 * 本进程的配置副本停手闸（task 3.1c 第 3 步 · 批 C 的配置镜像那一半）。
 *
 * ## 更正一条曾经记错的现状
 *
 * 此前登记的说法是「自动化侧缺新鲜度事实源、被 api 属主的刷新器挡住」。**那是错的**：
 * 本仓的同步读镜像早就带了一个按进程的事实源（`AutomationSyncReadMirrors#configFreshnessRuntime`，
 * 实现 kernel 的 `ConfigMirrorFreshnessSource`），把配置副本键映射到本进程自己的镜像上。
 * 真实状况是**它建好了却零消费方** —— 全仓只有定义它的那个文件提到它。
 * 那正是本 change 反复点名的形态：造得出来、日志正常，只是没有任何人读它算的结果。
 *
 * ## 为什么本进程的事实源就该是同步读镜像，而不是把 api 的刷新器搬过来
 *
 * 单体时代的失效通道（版本表 + 轮询刷新器）解决的是「一个进程里的 15 份内存副本何时过期」。
 * 三等分之后，**本进程持有的配置副本就是那 7 条同步读消费流**，它们各自带
 * `freshUntil` 与就绪态 —— 过期与否本来就由它们说了算。
 * 所以这里不需要第二套失效机制，只需要把已有的那一套接到停手闸上。
 *
 * 实测吻合：闸门档（`gate`）的配置副本键与本进程的同步读消费流几乎一一对应
 * （两个环境类键共用同一条环境流；参数档的热帖阈值不参与停手）。
 *
 * ## 判定逻辑一个字都不在这里
 *
 * 两条 fail-safe 策略（未装事实源 → fresh、事实源抛错 → 按 stale 收敛）单写在 kernel 工厂里，
 * 与 api 侧那两份用的是同一份定义。**本模块只负责两件属于本进程的事**：
 * 哪些键在本进程算闸门档、以及"因陈旧而拒绝"这笔账记到哪去。
 */
import type { ConfigMirrorKey } from 'aidcp-kernel/kernel/config-mirror-bump-types.js';
import { createConfigMirrorGate } from 'aidcp-kernel/kernel/config-mirror-gate.js';
import type { ConfigMirrorGate } from 'aidcp-kernel/kernel/config-mirror-gate.js';

import type { AutomationSyncReadMirrors } from './transport/automation-sync-read-mirrors.js';

/**
 * 本进程的**闸门档**配置副本键：陈旧即停止放行新的真实平台动作。
 *
 * 逐条都能在本进程找到对应的同步读消费流（映射由镜像自己持有）：
 * 人设 / 环境慢启动 / 环境自动化闸（后两者共用环境流）/ 账号状态 /
 * 内容排期 / FB 评论配置 / FB 加群自动化配置。
 *
 * **参数档不入列**（如热帖阈值）：它们陈旧只告警、不停手。
 * **本进程没有的键也不入列**：镜像对认不出的键一律答 `stale`，
 * 把它放进来会让本进程被一条它根本不持有的副本永久停手。
 */
export const AUTOMATION_GATE_MIRROR_KEYS = [
  'persona_config',
  'client_environment_slow_start',
  'client_environment_automation_gate',
  'account_status',
  'content_schedule',
  'facebook_comment_config',
  'facebook_group_join_automation_config',
] as const satisfies readonly ConfigMirrorKey[];

/** 「因副本陈旧而拒绝」的落账口。属主表在接口域，故本进程只能经端口过去。 */
export interface ConfigMirrorRefusalSink {
  noteStaleRefusal(mirrorKey: ConfigMirrorKey, context?: string): void;
}

export interface AutomationConfigMirrorGateOptions {
  mirrors: AutomationSyncReadMirrors;
  /**
   * 拒绝计数的落账口。**不传 = 本进程记不了这笔账**，
   * 本模块会按键各留一次具名 warn 并自己计数（见 {@link AutomationConfigMirrorGate.unpersistedRefusals}）。
   *
   * **刻意不做成静默 no-op**：那张按小时聚合的计数表属接口域，跨进程后要么经通道过去、
   * 要么如实缺席 —— MUST NOT 变成「记了但没人收」。镜像自带的那个默认参数正是一个静默 no-op，
   * 所以这里显式接管，不用它的默认值。
   */
  refusals?: ConfigMirrorRefusalSink;
  logger?: Pick<Console, 'warn'>;
}

export interface AutomationConfigMirrorGate extends ConfigMirrorGate {
  /** 本进程算闸门档的键。 */
  gateMirrorKeys: readonly ConfigMirrorKey[];
  /** 没能落库的拒绝计数（按键）。落账口缺席时才会非空 —— 它是缺口的度量，不是正常态。 */
  unpersistedRefusals(): Record<string, number>;
}

export function createAutomationConfigMirrorGate(
  options: AutomationConfigMirrorGateOptions,
): AutomationConfigMirrorGate {
  const logger = options.logger ?? console;
  const unpersisted = new Map<string, number>();
  const warned = new Set<string>();

  const noteStaleRefusal = (mirrorKey: ConfigMirrorKey, context?: string): void => {
    if (options.refusals) {
      options.refusals.noteStaleRefusal(mirrorKey, context);
      return;
    }
    unpersisted.set(mirrorKey, (unpersisted.get(mirrorKey) ?? 0) + 1);
    if (!warned.has(mirrorKey)) {
      warned.add(mirrorKey);
      logger.warn(
        `[aidcp-automation] 因配置副本陈旧而拒绝（${mirrorKey}）——`
          + '本进程没有落账口，这笔计数只留在内存里、不会进那张按小时聚合的表。'
          + '停手结论本身不受影响；这条每个键只说一次。',
      );
    }
  };

  const gate = createConfigMirrorGate({
    // 事实源就是本进程自己的同步读镜像；`noteStaleRefusal` 由本模块接管，
    // 不用镜像那个默认的静默 no-op。
    source: () => options.mirrors.configFreshnessRuntime(noteStaleRefusal),
    gateMirrorKeys: AUTOMATION_GATE_MIRROR_KEYS,
  });

  return {
    ...gate,
    gateMirrorKeys: AUTOMATION_GATE_MIRROR_KEYS,
    unpersistedRefusals: () => Object.fromEntries(unpersisted),
  };
}
