import type { MessageType } from './protocol.js';

export type AutomationOperationClass =
  | 'automation_control'
  | 'platform_api_automation'
  | 'browser_lifecycle'
  | 'page_automation'
  /**
   * 类别按「在编址什么」裁决，不按「怎么执行」（edge-command-grammar 规则一；判例四的根治，
   * change recategorize-nonpage-commands）。两类都需要浏览器，但**不以页面账号名义动作**。
   */
  | 'page_observation'
  | 'environment_assist';

/**
 * 平台留痕维（platform footprint）——「判错了会不会在平台上留痕」这条尺子的机读形态。
 * 46 条取值与边缘 `aidcp-edge/src/client/operation-registry.ts` 逐字一致（跨仓对表闸
 * `scripts/operation-registry-parity` 守全部字段）。
 *
 * 判据：这条命令**执行成功后**，平台上是否**直接**出现一个可归因到该账号的新对象。
 * 三条边界裁定（详见边缘那份的字段注释）：按消息类型取最坏一档；只算直接后果不算间接触发；
 * **本维 MUST NOT 单独决定放行**（反例：`edge.task.acquire` 是 `none`，身份未落定照拦——准入判据）。
 *
 * 云端这一侧**将来**的消费方是重放决策（重试上限 / 升级 / 绝不重放都在云端做）：
 * `account_visible` 的命令一经派发绝不自动重放。**当前尚未接线**——本维今天只被测试断言
 * 消费，不参与任何放行 / 拒绝 / 重试判断，MUST NOT 被当成已生效的闸。
 */
export type PlatformFootprint = 'account_visible' | 'none';

export interface AutomationOperationDescriptor {
  category: AutomationOperationClass;
  transport: 'automation_ws';
  identity: 'none' | 'local_environment' | 'bound_account' | 'page_account';
  browser: 'forbidden' | 'on_demand' | 'required';
  platformFootprint: PlatformFootprint;
}

// platformFootprint 默认一律落在 'account_visible'（保守侧）：留痕为默认、不留痕需显式声明——
// 漏判的新命令因此天然进「绝不重放」一侧。
const automationControl = (
  identity: AutomationOperationDescriptor['identity'] = 'bound_account',
  platformFootprint: PlatformFootprint = 'account_visible',
): AutomationOperationDescriptor => ({
  category: 'automation_control', transport: 'automation_ws', identity, browser: 'forbidden', platformFootprint,
});
const platformApiAutomation = (
  platformFootprint: PlatformFootprint = 'account_visible',
): AutomationOperationDescriptor => ({
  category: 'platform_api_automation', transport: 'automation_ws', identity: 'bound_account', browser: 'forbidden', platformFootprint,
});
const browserLifecycle = (
  platformFootprint: PlatformFootprint = 'account_visible',
): AutomationOperationDescriptor => ({
  category: 'browser_lifecycle', transport: 'automation_ws', identity: 'bound_account', browser: 'on_demand', platformFootprint,
});
const pageAutomation = (
  platformFootprint: PlatformFootprint = 'account_visible',
): AutomationOperationDescriptor => ({
  category: 'page_automation', transport: 'automation_ws', identity: 'page_account', browser: 'required', platformFootprint,
});
// 观察与处置：需要浏览器，但 identity 是 local_environment——不代表账号做任何事，
// 身份未落定时也 MUST 可用（正是解开该终局的探针 / 通道）。取值与边缘逐字一致。
const pageObservation = (): AutomationOperationDescriptor => ({
  category: 'page_observation', transport: 'automation_ws', identity: 'local_environment', browser: 'required', platformFootprint: 'none',
});
const environmentAssist = (): AutomationOperationDescriptor => ({
  category: 'environment_assist', transport: 'automation_ws', identity: 'local_environment', browser: 'required', platformFootprint: 'none',
});

/**
 * Cloud -> Edge active-operation registry. The WebSocket is the automation channel, not the
 * customer's general data plane. Any newly pushed operation must declare identity and browser needs here.
 */
export const AUTOMATION_OPERATION_REGISTRY = {
  // —— 控制与心跳：只动边缘本地投影 / 节奏 / outbox 确认，不触任何平台对象 ——
  'ui.snapshot': automationControl('bound_account', 'none'),
  'pacing.update': automationControl('bound_account', 'none'),
  'interaction.sync.ack': automationControl('bound_account', 'none'),
  'interaction.reply.result.ack': automationControl('bound_account', 'none'),
  'interaction.offboard.ack': automationControl('bound_account', 'none'),
  'interaction.runtime.controls': automationControl('bound_account', 'none'),
  ping: automationControl('none', 'none'),
  pong: automationControl('none', 'none'),

  // 拉取同步：边缘全部端点为 observed_read_only，纯读不写平台。
  'interaction.sync.request': platformApiAutomation('none'),
  // 真发出私信——唯一的 API 直写留痕命令（且不经页面身份闸，缺口已在 change 里登记待议）。
  'interaction.reply.send': platformApiAutomation(),
  // 协议注释：只核验既有 attempt，绝不发起新平台写。
  'interaction.reply.reconcile': platformApiAutomation('none'),
  // 撤权后清理边缘本地加密会话；协议注释：结果可重放。
  'interaction.offboard.command': platformApiAutomation('none'),

  'interaction.auth.reopen': browserLifecycle('none'),
  'interaction.browser.control': browserLifecycle('none'),

  // v1 兼容路径：PlanStep 的 op 含 click / input，可承载点赞 / 评论等写手势 ⇒ 按最坏一档。
  'plan.response': pageAutomation(),
  'session.end': automationControl('local_environment', 'none'),
  'note.open': pageAutomation('none'),
  'note.close': pageAutomation('none'),
  // 搜索只产生账号自见的隐式行为记录，不产生平台上可归因的新对象。
  'search.execute': pageAutomation('none'),
  'page.scroll': pageAutomation('none'),
  'feed.refresh': pageAutomation('none'),
  // —— 互动写：每条直接产生可归因到该账号的新对象 ——
  'interaction.like': pageAutomation(),
  'interaction.collect': pageAutomation(),
  'interaction.follow': pageAutomation(),
  'interaction.comment': pageAutomation(),
  'interaction.like_comment': pageAutomation(),
  'group.join': pageAutomation(),
  'navigation.back': pageAutomation('none'),
  'note.browse_images': pageAutomation('none'),
  'note.scroll_comments': pageAutomation('none'),
  'profile.open': pageAutomation('none'),
  // 身份救援放行清单的两条成员（边缘 identity-command-gate.ts）：运行期身份落到「不知道浏览器里
  // 登着谁」的终局时，节点拒绝一切代表该账号的动作，只放行读 / 收尾 / 救援命令，而这两条是**唯一**
  // 能问出当前登录身份、从而解开该终局的事实来源。云端这一侧漏登记 ⇒ 出口闸判 operation_unclassified
  // 静默拒发、投递数返回 0 ⇒ 那条自救通道结构上不成立。位置与边缘那份逐行对齐，便于人工比对。
  'identity.read_current': pageObservation(),
  'identity.read_self_profile': pageObservation(),
  // 观察命令「问现状」（change add-state-observation-command）：纯读探针，一次带回当前面 + 登录身份。
  'state.read': pageObservation(),
  'notification.open': pageAutomation('none'),
  'notification.browse_comments': pageAutomation('none'),
  'notification.browse_likes': pageAutomation('none'),
  'notification.browse_follows': pageAutomation('none'),
  'notification.back_home': pageAutomation('none'),
  // 留痕维按消息类型语义判（发布 ⇒ 留痕）；publish.command 按最坏一档（多种原子里只有
  // 「点提交」真留痕，但本表按消息类型编址）。
  'publish.command': pageAutomation(),
  // 租约属准入不属留痕：acquire 不产生对象但身份未落定照拦（本维不决定放行的常驻反例）。
  'edge.task.acquire': pageAutomation('none'),
  'edge.task.release': automationControl('local_environment', 'none'),
  'captcha.assist.capture': environmentAssist(),
  // 人工点位只作用于验证码浮层，解开阻断不产生该账号名下的新对象。
  'captcha.assist.click': environmentAssist(),
} as const satisfies Partial<Record<MessageType, AutomationOperationDescriptor>>;

export function automationOperationDescriptorFor(type: MessageType): AutomationOperationDescriptor | null {
  return (AUTOMATION_OPERATION_REGISTRY as Partial<Record<MessageType, AutomationOperationDescriptor>>)[type] ?? null;
}
