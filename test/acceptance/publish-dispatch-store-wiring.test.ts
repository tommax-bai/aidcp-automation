// aidcp:test-owner=derived
/**
 * 下发段存储的装配闸：属主客户端的方法**必须真到得了下发器手里**。
 *
 * 拆仓后 `publishLog` 从「单体里那个直接对象」变成了 `AutomationPublishLogHttpClient`
 * 这样的 **class 实例**（方法在 prototype 上）。装配处一旦写成 `{ ...publishLog, … }`，
 * 对象展开只拷自有可枚举属性 ⇒ 五个方法一个都不过去，store 变成空壳。
 *
 * 这个错**编译期抓不到**：TS 对展开 class 实例的类型推导仍保留全部方法签名，
 * `tsc --noEmit` 全绿。行为测试也抓不到，因为下发链路上每一处都拿桩对象（字面量，
 * 方法是自有属性）当 store，桩根本复现不了 prototype 那一层。
 * 真跑起来的表现是兜底扫描每 30s 一条 `loadForDispatch is not a function` 后 `跳过` ——
 * **只 warn 不抛**，人审通过的稿就此永远发不出去（dev 2026-08-05 实测，
 * recordId=216/220 卡在「已批准·待下发」一天多无人发现）。
 *
 * 故本闸**必须用真 class 实例**喂 `dispatchStoreFromPublishLog`，且**必须同时断言
 * 展开写法确实会丢方法** —— 否则哪天 prototype 语义变了，这条闸会恒真通过，
 * 就没人能证明它还在守着什么。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dispatchStoreFromPublishLog } from '../../src/automation-publish-dispatch.js';
import type { AutomationPublishLogPort } from '../../src/automation-publish-dispatch.js';

/** 属主客户端的形状：方法在 prototype 上、构造器参数是自有字段——与真客户端一致。 */
class FakePublishLogClient {
  readonly calls: string[] = [];
  constructor(private readonly token: string) {}
  async loadForDispatch(recordId: number) {
    this.calls.push(`loadForDispatch:${recordId}:${this.token}`);
    return null;
  }
  async updateStatus(id: number, status: string) {
    this.calls.push(`updateStatus:${id}:${status}`);
  }
  async updatePostId(id: number, postId: string, postUrl?: string | null) {
    this.calls.push(`updatePostId:${id}:${postId}:${postUrl ?? '-'}`);
  }
  async markScheduled(id: number, scheduledAt: number, scheduledPlatformId?: string | null) {
    this.calls.push(`markScheduled:${id}:${scheduledAt}:${scheduledPlatformId ?? '-'}`);
  }
  async markImagesAttached(id: number, count: number) {
    this.calls.push(`markImagesAttached:${id}:${count}`);
  }
}

/** 下发器真正会调到的那五个方法。少一个都意味着一条下发路径静默失效。 */
const DELEGATED_METHODS = [
  'loadForDispatch',
  'updateStatus',
  'updatePostId',
  'markScheduled',
  'markImagesAttached',
] as const;

test('装配出来的下发存储：属主客户端的每个方法都真的可调用（class 方法在 prototype 上，展开会丢光）', async () => {
  const client = new FakePublishLogClient('tok');
  const store = dispatchStoreFromPublishLog(client as unknown as AutomationPublishLogPort);

  for (const name of DELEGATED_METHODS) {
    assert.equal(
      typeof (store as unknown as Record<string, unknown>)[name],
      'function',
      `下发存储缺方法 ${name}：装配处很可能又把属主客户端展开了`,
    );
  }

  // 不止「是个函数」，还得真委托到属主客户端（含 this 绑定——丢 this 的表现同样是运行期才炸）。
  await store.loadForDispatch(216);
  await store.updateStatus(216, 'published');
  await store.updatePostId(216, 'p1', 'https://example.com/p1');
  await store.markScheduled(216, 1_700_000_000_000, 'sched-1');
  await store.markImagesAttached(216, 3);

  assert.deepEqual(client.calls, [
    'loadForDispatch:216:tok',
    'updateStatus:216:published',
    'updatePostId:216:p1:https://example.com/p1',
    'markScheduled:216:1700000000000:sched-1',
    'markImagesAttached:216:3',
  ]);
});

test('兜底扫描口显式拒绝，MUST NOT 给空数组（空数组会被读成「没有待下发的」，那是一句谎）', async () => {
  const store = dispatchStoreFromPublishLog(
    new FakePublishLogClient('tok') as unknown as AutomationPublishLogPort,
  );
  await assert.rejects(
    () => store.listPendingApprovalIds(),
    /publish_pending_scan_uses_authenticated_listPendingDispatch/,
  );
});

test('闸的前提自证：展开 class 实例确实会丢光方法（前提不成立时本闸恒真，须当场红）', () => {
  const client = new FakePublishLogClient('tok');
  const spread = { ...client } as unknown as Record<string, unknown>;
  for (const name of DELEGATED_METHODS) {
    assert.notEqual(
      typeof spread[name],
      'function',
      `前提已变：展开 class 实例现在保留了 ${name}。上面那条闸不再守得住任何东西，须重写`,
    );
  }
});
