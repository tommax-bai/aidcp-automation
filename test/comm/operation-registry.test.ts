import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTOMATION_OPERATION_REGISTRY, automationOperationDescriptorFor } from '../../src/comm/operation-registry.js';
import type { MessageType } from '../../src/comm/protocol.js';

test('Cloud automation channel classifies control, API-only automation, browser lifecycle, and page automation', () => {
  assert.deepEqual(automationOperationDescriptorFor('ui.snapshot'), {
    category: 'automation_control', transport: 'automation_ws', identity: 'bound_account', browser: 'forbidden',
    platformFootprint: 'none',
  });
  assert.equal(automationOperationDescriptorFor('interaction.reply.send')?.category, 'platform_api_automation');
  assert.equal(automationOperationDescriptorFor('interaction.reply.send')?.browser, 'forbidden');
  assert.equal(automationOperationDescriptorFor('interaction.auth.reopen')?.category, 'browser_lifecycle');
  assert.equal(automationOperationDescriptorFor('page.scroll')?.browser, 'required');
});

test('every registered Cloud push uses automation WebSocket and unknown active operations fail closed', () => {
  for (const descriptor of Object.values(AUTOMATION_OPERATION_REGISTRY)) {
    assert.equal(descriptor.transport, 'automation_ws');
  }
  assert.equal(automationOperationDescriptorFor('future.unclassified' as MessageType), null);
});

test('identity read commands are dispatchable — the edge identity-rescue allowlist needs them', () => {
  // 边缘 src/client/identity-command-gate.ts 把这两条放进身份救援放行清单：运行期身份落到
  // 「不知道浏览器里登着谁」的终局时，只有它们能问出当前登录身份、解开该终局。云端漏登记 ⇒
  // 出口闸判 operation_unclassified 静默拒发（投递数 0）⇒ 该自救通道结构上不成立。
  //
  // 期望值**按引用取自本表里已知正确的同类命令**，不另抄一份字面量：抄一份就是第二实现，
  // 它只能证明「我抄的和我抄的一样」，描述符字段真改了它照样绿。
  const peer = automationOperationDescriptorFor('profile.open');
  assert.notEqual(peer, null, 'profile.open 是本断言的参照锚点，它自己不能是 null');
  for (const type of ['identity.read_current', 'identity.read_self_profile'] as MessageType[]) {
    assert.deepEqual(
      automationOperationDescriptorFor(type),
      peer,
      `${type} 必须可从云端下发，且分类与同类页面自动化命令一致`,
    );
  }
});

/**
 * 平台留痕维（change close-account-layer-operation-manual）：46 条取值与边缘逐字一致，
 * 跨仓由 scripts/operation-registry-parity 守全部字段。
 *
 * 期望值**按引用取自同类命令的描述符**，不另抄一份字面量（沿用上面 identity read 用例的做法）：
 * 抄一份就是第二实现，只能证明「我抄的和我抄的一样」。绝对取值由边缘侧字面量用例 + 跨仓对表闸钉死；
 * 本用例守的是**分侧不塌**——写互动与纯浏览 / 纯拉取必须始终落在留痕维的两侧。
 *
 * ⚠️ 本维 MUST NOT 单独决定放行，也尚未接线任何重放决策（将来消费方是云端重试上限 / 升级 /
 * 绝不重放）。反例常驻：`edge.task.acquire` 是 'none'，但边缘身份闸照拦——准入判据，不是留痕判据。
 */
test('platform-footprint keeps direct write commands and browse-only commands on opposite sides', () => {
  // 两个参照锚点：interaction.comment 是「直接产生可归因新对象」最无争议的一条；
  // note.close 是「纯浏览、不产生对象」最无争议的一条。
  const write = automationOperationDescriptorFor('interaction.comment');
  const browse = automationOperationDescriptorFor('note.close');
  assert.notEqual(write, null, 'interaction.comment 是参照锚点，它自己不能是 null');
  assert.notEqual(browse, null, 'note.close 是参照锚点，它自己不能是 null');
  assert.notEqual(
    write?.platformFootprint,
    browse?.platformFootprint,
    '写互动与纯浏览必须落在留痕维的两侧——两侧塌成一侧则本维失去全部区分力',
  );

  // 直接留痕（含按消息类型取最坏一档的 publish.* 与 plan.response）：与 interaction.comment 同侧。
  for (const type of [
    'interaction.like', 'interaction.collect', 'interaction.follow', 'interaction.like_comment',
    'group.join', 'publish.command', 'plan.response',
  ] as MessageType[]) {
    assert.equal(
      automationOperationDescriptorFor(type)?.platformFootprint,
      write?.platformFootprint,
      `${type} 直接产生可归因新对象（或按最坏一档），必须与 interaction.comment 同侧`,
    );
  }
  // API 族里唯一的直写：真发出私信。
  assert.equal(automationOperationDescriptorFor('interaction.reply.send')?.platformFootprint, write?.platformFootprint);

  // 浏览 / 读 / 收尾 / 租约 / 验证码协助：与 note.close 同侧。
  for (const type of [
    'session.end', 'note.open', 'search.execute', 'page.scroll',
    'feed.refresh', 'navigation.back', 'note.browse_images', 'note.scroll_comments', 'profile.open',
    'identity.read_current', 'identity.read_self_profile',
    'notification.open', 'notification.browse_comments', 'notification.browse_likes',
    'notification.browse_follows', 'notification.back_home',
    'edge.task.acquire', 'edge.task.release', 'captcha.assist.capture', 'captcha.assist.click',
  ] as MessageType[]) {
    assert.equal(
      automationOperationDescriptorFor(type)?.platformFootprint,
      browse?.platformFootprint,
      `${type} 不直接产生可归因新对象，必须与 note.close 同侧`,
    );
  }
  // 纯拉取 / 只核验 / 本地清理：协议注释明写「绝不发起新平台写」「结果可重放」。
  for (const type of [
    'interaction.sync.request', 'interaction.reply.reconcile', 'interaction.offboard.command',
  ] as MessageType[]) {
    assert.equal(
      automationOperationDescriptorFor(type)?.platformFootprint,
      browse?.platformFootprint,
      `${type} 不发起新平台写，必须与 note.close 同侧（与 interaction.reply.send 分侧）`,
    );
  }
  // 控制与心跳。
  for (const type of [
    'ui.snapshot', 'pacing.update', 'interaction.sync.ack', 'interaction.reply.result.ack',
    'interaction.offboard.ack', 'interaction.runtime.controls', 'ping', 'pong',
    'interaction.auth.reopen', 'interaction.browser.control',
  ] as MessageType[]) {
    assert.equal(
      automationOperationDescriptorFor(type)?.platformFootprint,
      browse?.platformFootprint,
      `${type} 是控制 / 心跳 / 浏览器生命周期，必须与 note.close 同侧`,
    );
  }
});

test('Cloud/admin cannot push AIDCP-owned data commands through the automation channel', () => {
  const forbiddenDataCommands = [
    'persona.generate',
    'persona.persist',
    'publish.approval_action',
    'publish.draft_image_remove',
  ] as MessageType[];
  for (const type of forbiddenDataCommands) {
    assert.equal(automationOperationDescriptorFor(type), null, `${type} must be pulled/submitted over customer-auth HTTP`);
  }
  const categories = new Set(Object.values(AUTOMATION_OPERATION_REGISTRY).map((entry) => entry.category));
  assert.equal(categories.has('cloud_data' as never), false);
});
