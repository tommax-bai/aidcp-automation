/**
 * 观察命令「问现状」（change add-state-observation-command，蓝图批 3）——云端通道契约。
 *
 * 守护点（tasks 3.2）：
 *   ① 发得出：登记表放行（出口闸不判 operation_unclassified）+ 桥接映射 state_read → state.read；
 *   ② 收得到：handler 把 state.report 转成 state.report.arrived 事件，携带边缘回填的信封 id；
 *   ③ 超时如实：pending 表按 captureId 关联；边缘静默 ⇒ `timeout` 结局，MUST NOT 伪造成
 *      一份 unconfirmed 观察；出口未投递 ⇒ `not_sent`；三态不得压成一态。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DefaultMessageHandler, makeEnvelope } from '../../src/comm/index.js';
import type { AnchorStore } from '../../src/comm/handler.js';
import type { EdgeSession } from '../../src/comm/ws-server.js';
import { EventBus } from '../../src/event-bus/index.js';
import { SimplePlanner } from '../../src/planner/index.js';
import { automationOperationDescriptorFor } from '../../src/comm/operation-registry.js';
import { edgeCommandToEnvelope } from '../../src/comm/command-bridge.js';
import { StateObservationChannel } from '../../src/comm/state-observation.js';
import type { StateObservationOutcome } from '../../src/comm/state-observation.js';
import type { StateReportPayload } from '../../src/comm/protocol.js';

function anchorStore(): AnchorStore {
  return {
    get: async () => null,
    recordHit: async () => {},
    recordFailure: async () => {},
    stage: async () => {},
    confirmStaged: async () => ({ promoted: false, successes: 1, needed: 2 }),
    dropStaged: async () => {},
  } as unknown as AnchorStore;
}

const sampleReport: StateReportPayload = {
  captureId: 'cap-1',
  surface: { outcome: 'confirmed', kind: 'note_detail' },
  identity: { outcome: 'confirmed', accountId: 'acc-1', nickname: '昵称' },
  observedAt: 1_784_044_802_100,
};

test('state.read is registered dispatchable — the outbound gate must not fail it closed', () => {
  // 漏登记的后果不是报错，是静默拒发（operation_unclassified、投递数 0）——三段对账第③段
  // 在云端侧结构上不成立。字段与边缘那份逐字一致，跨仓 parity 闸守全字段。
  assert.deepEqual(automationOperationDescriptorFor('state.read'), {
    category: 'page_observation',
    transport: 'automation_ws',
    identity: 'local_environment',
    browser: 'required',
    platformFootprint: 'none',
  });
});

test('command bridge maps state_read to a state.read envelope with captureId intact', () => {
  const envelope = edgeCommandToEnvelope({ action: 'state_read', params: { captureId: 'cap-9' } });
  assert.equal(envelope.type, 'state.read');
  assert.deepEqual(envelope.payload, { captureId: 'cap-9' });
});

test('handler turns state.report into state.report.arrived carrying the correlated envelope id', async () => {
  const eventBus = new EventBus();
  const arrived: Array<{ report: StateReportPayload; accountId?: string; envelopeId: string; ts: number }> = [];
  eventBus.on('state.report.arrived', (p) => { arrived.push(p); });
  const handler = new DefaultMessageHandler({
    planner: new SimplePlanner(),
    llm: { complete: async () => '0' },
    cache: anchorStore(),
    clock: () => 1_784_044_802_200,
    eventBus,
  });
  const session: EdgeSession = { sessionId: 'edge-session-1', accountId: 'acc-1' } as EdgeSession;

  // 边缘按请求信封 id 回填 envelope.id（信封关联）；handler 必须把它原样带进事件。
  const reply = await handler.handle(makeEnvelope('state.report', 'req-envelope-7', 1_784_044_802_100, sampleReport), session);

  assert.equal(reply, null);
  assert.equal(arrived.length, 1);
  assert.equal(arrived[0]!.envelopeId, 'req-envelope-7');
  assert.equal(arrived[0]!.accountId, 'acc-1');
  assert.deepEqual(arrived[0]!.report, sampleReport);
});

test('channel resolves reported when the correlated report arrives, and clears its pending entry', async () => {
  const sentCaptureIds: string[] = [];
  const timers: Array<() => void> = [];
  const channel = new StateObservationChannel({
    sendStateRead: (captureId) => { sentCaptureIds.push(captureId); return true; },
    createCaptureId: () => 'cap-fixed',
    setTimeoutFn: (fn) => { timers.push(fn); return timers.length; },
    clearTimeoutFn: () => {},
  });

  const pending = channel.ask();
  assert.deepEqual(sentCaptureIds, ['cap-fixed']);
  assert.equal(channel.pendingCount, 1);
  channel.onReport({ ...sampleReport, captureId: 'cap-fixed' }, 'env-42');
  const outcome = await pending;
  assert.equal(outcome.kind, 'reported');
  assert.equal((outcome as { envelopeId?: string }).envelopeId, 'env-42');
  assert.equal(channel.pendingCount, 0);
});

test('silent edge resolves timeout — never fabricated into an unconfirmed observation', async () => {
  const timers: Array<() => void> = [];
  const channel = new StateObservationChannel({
    sendStateRead: () => true,
    createCaptureId: () => 'cap-timeout',
    setTimeoutFn: (fn) => { timers.push(fn); return timers.length; },
    clearTimeoutFn: () => {},
  });

  const pending = channel.ask();
  timers[0]!();
  const outcome = await pending;
  // 超时是它自己的结局：与「应答说没能确认」是两件事，压成一态云端就分不清
  // 「边缘没收到 / 没装到」与「边缘读不出来」。
  assert.deepEqual(outcome, { kind: 'timeout' });
  assert.equal(channel.pendingCount, 0);

  // 迟到的应答不复活已判 timeout 的请求（pending 已收口，按无主丢弃）。
  channel.onReport({ ...sampleReport, captureId: 'cap-timeout' });
  assert.equal(channel.pendingCount, 0);
});

test('undelivered send resolves not_sent immediately — distinct from timeout', async () => {
  const cleared: unknown[] = [];
  const channel = new StateObservationChannel({
    sendStateRead: () => false,
    createCaptureId: () => 'cap-unsent',
    setTimeoutFn: () => 'timer-handle',
    clearTimeoutFn: (handle) => { cleared.push(handle); },
  });

  const outcome: StateObservationOutcome = await channel.ask();
  assert.deepEqual(outcome, { kind: 'not_sent' });
  assert.deepEqual(cleared, ['timer-handle'], '未投递必须当场清掉超时计时器，不留悬挂 pending');
  assert.equal(channel.pendingCount, 0);
});

test('mismatched captureId never settles someone else\'s pending ask', async () => {
  const timers: Array<() => void> = [];
  const channel = new StateObservationChannel({
    sendStateRead: () => true,
    createCaptureId: () => 'cap-mine',
    setTimeoutFn: (fn) => { timers.push(fn); return timers.length; },
    clearTimeoutFn: () => {},
  });

  const pending = channel.ask();
  channel.onReport({ ...sampleReport, captureId: 'cap-somebody-else' });
  assert.equal(channel.pendingCount, 1, '错关联的应答绝不冒领 pending');
  timers[0]!();
  assert.deepEqual(await pending, { kind: 'timeout' });
});
