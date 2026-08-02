/**
 * 人设在自动化进程里的**唯一取用口**（批 H 第 5 片）。
 *
 * ## 为什么要有这个文件，而不是在各处就地展开
 *
 * 人设事实源在**接口域**（`persona_config` 表），本进程只有同步读副本。从副本推出两样东西：
 *
 * - **绑定三态**（`bound` / `unbound` / `unknown`）——「未知 ≠ 未绑」是本系统的既有不变量；
 * - **人设本体**（撰写 / 决策热路径要的那份 soul）。
 *
 * 这两个判断在本进程里**至少有三个取用点**（陪伴界面快照、每连接角色调度器、评论调度器）。
 * 本 change 已经反复实测过同一件事：**同一份判断被两处用，行为测试原理上看不见第二份**——
 * 复制出来的那一刻两份行为完全一致，要等某天只改了其中一份、且恰好在该拦住的那一刻才现形，
 * 而那正是最少被真跑到的路径。所以这里收成一份，并由 `test/acceptance/automation-persona-view.test.ts`
 * 里的**结构断言**按符号钉住取用方确实委托到了这里（按词边界正向判据，不是「没有同名的本地定义」——
 * 后者换个函数名就绕过去了，本 change 已被这样绕过一次）。
 *
 * ## 三条回落方向都按「哪边更严」定，不按「哪边更像缺省」定
 *
 * 1. 副本**陈旧 / 未到位** ⇒ 绑定态 `unknown`，**MUST NOT 答 `unbound`**：
 *    `unbound` 会让人设弹窗弹给一个其实绑好了的账号，也会让冷待机把正常会话撕断；
 * 2. 副本陈旧 / 未到位 ⇒ 取 soul **具名抛**，MUST NOT 回落任何默认人设
 *    （「以默认人设跑一整天」是静默假成功里代价最高的一种）；
 * 3. 副本新鲜但**账号不在名册里** ⇒ `unbound`（这是真结论，不是缺席）。
 */
import type { PersonaBinding } from 'aidcp-kernel/kernel/persona-binding.js';
import type { Soul } from 'aidcp-kernel/kernel/soul-types.js';

import type { AutomationSyncReadMirrors } from './transport/automation-sync-read-mirrors.js';

/** 本模块要用的镜像取用面。窄成一条，免得把整个镜像类当依赖传。 */
export type AutomationPersonaMirrors = Pick<AutomationSyncReadMirrors, 'personaFor'>;

/**
 * 人设绑定三态。副本不新鲜一律 `unknown` —— 见文件头回落方向第 1 条。
 */
export function personaBindingFor(
  mirrors: AutomationPersonaMirrors,
  accountId: string,
): PersonaBinding {
  const lookup = mirrors.personaFor(accountId);
  if (lookup.state !== 'fresh' || !lookup.value) return 'unknown';
  return lookup.value.binding === 'bound' ? 'bound' : 'unbound';
}

/**
 * 取该账号的人设本体。**永不回落**：拿不到就具名抛，由调用点的人设闸决定怎么处置。
 *
 * 四种失败各有独立的具名前缀，因为它们的处置完全不同：
 * - `persona_mirror_not_ready` —— 装配 / 网络问题，等副本到位即自愈；
 * - `no_persona` —— 运营还没给这个账号绑人设（与单体逐字同名，下游按此判据引导去绑）；
 * - `persona_soul_malformed` —— 属主发过来的载荷形状不对，是**属主侧**的缺陷。
 */
export function requirePersonaSoul(
  mirrors: AutomationPersonaMirrors,
  accountId?: string,
): Soul {
  const target = accountId ?? '(未指定)';
  const lookup = accountId ? mirrors.personaFor(accountId) : null;
  if (!lookup || lookup.state !== 'fresh' || !lookup.value) {
    throw new Error(
      `persona_mirror_not_ready: 账号 ${target} 的人设副本` +
        `${lookup ? `状态为 ${lookup.state}` : '未指定账号'}，` +
        '拒绝以默认人设运行（副本到位后自愈）',
    );
  }
  if (lookup.value.binding !== 'bound' || lookup.value.soul === null) {
    throw new Error(`no_persona: 账号 ${target} 未绑定人设，拒绝以默认人设运行`);
  }
  const soul = lookup.value.soul;
  if (!isSoulShaped(soul)) {
    throw new Error(
      `persona_soul_malformed: 账号 ${target} 的人设载荷缺少 identity / interests，` +
        '属主侧发出的快照不符合契约（本进程不猜、不补默认）',
    );
  }
  return soul;
}

/**
 * 结构守卫：只核 {@link Soul} 上那两个**必填**字段。
 *
 * 刻意不写成 `soul as Soul` 的整体强转 —— 本 change 实测过一次：一个整体强转把
 * 「手抄契约漏了四个字段」整段静音掉了。也刻意不在这里复刻属主侧那套完整校验：
 * 那份校验的事实源在接口域，抄第二份就是本文件开头要消灭的形态。这里只回答
 * 「这个 JSON 能不能当 Soul 用」，答不了的当场具名抛。
 */
function isSoulShaped(value: unknown): value is Soul {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return isPlainObject(record.identity) && isPlainObject(record.interests);
}

function isPlainObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
