import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ManagedTaskConnectionTarget } from '../../src/orchestrator/connection-runtime.js';
import {
  ConnectionRuntimeResearchDispatchAdapter,
  type AtomicResearchCommandChannel,
  type AtomicResearchReceipt,
  type AtomicResearchSendResult,
  type ReadOnlyResearchCommand,
} from '../../src/managed-automation/execution/index.js';

const target: ManagedTaskConnectionTarget = {
  connectionGeneration: 'generation-1',
  edgeId: 'ads-env-1',
  accountId: 'account-1',
  platform: 'facebook',
  capabilities: [
    'managed_research_search_v1',
    'managed_research_browse_v1',
    'managed_research_assess_v1',
    'managed_research_summarize_v1',
  ],
};

function command(overrides: Partial<ReadOnlyResearchCommand> = {}): ReadOnlyResearchCommand {
  return {
    commandKind: 'managed.research.read',
    commandId: 'attempt-1',
    executionTarget: 'dev',
    accountId: 'account-1',
    envKey: 'env-1',
    platform: 'facebook',
    taskId: 'task-1',
    runId: 'run-1',
    stepRunId: 'step-1',
    attemptId: 'attempt-1',
    capabilityId: 'research.search',
    capabilityVersion: 1,
    inputRef: 'input:1',
    idempotencyKey: 'managed-task/run-1/search',
    correlationId: 'correlation-1',
    params: { keywords: ['coffee'], maxItems: 3 },
    ...overrides,
  };
}

function completedReceipt(overrides: Partial<AtomicResearchReceipt> = {}): AtomicResearchReceipt {
  return {
    executionTarget: 'dev',
    accountId: 'account-1',
    attemptId: 'attempt-1',
    edgeId: 'ads-env-1',
    connectionGeneration: 'generation-1',
    capabilityId: 'research.search',
    capabilityVersion: 1,
    status: 'completed',
    reasonCode: 'succeeded',
    evidence: {
      evidenceRef: 'evidence:attempt-1',
      stableContentRefs: ['facebook:post:1'],
      postconditionRef: 'postcondition:research.search@1:page-1',
    },
    ...overrides,
  } as AtomicResearchReceipt;
}

class FakeChannel implements AtomicResearchCommandChannel {
  readonly order: string[] = [];
  readonly callbacks: Array<(receipt: AtomicResearchReceipt) => void> = [];
  sendResult: AtomicResearchSendResult = { outcome: 'dispatched' };
  sendError: Error | null = null;
  receiptDuringSend: AtomicResearchReceipt | null = null;
  subscribedTarget: ManagedTaskConnectionTarget | null = null;
  sentTarget: ManagedTaskConnectionTarget | null = null;
  sentCommand: ReadOnlyResearchCommand | null = null;
  unsubscribed = 0;

  subscribeReceipt(
    selected: ManagedTaskConnectionTarget,
    attemptId: string,
    receive: (receipt: AtomicResearchReceipt) => void,
  ): () => void {
    this.order.push(`subscribe:${attemptId}`);
    this.subscribedTarget = selected;
    this.callbacks.push(receive);
    return () => { this.unsubscribed += 1; };
  }

  sendAtomic(
    selected: ManagedTaskConnectionTarget,
    sent: ReadOnlyResearchCommand,
  ): AtomicResearchSendResult {
    this.order.push(`send:${sent.attemptId}`);
    this.sentTarget = selected;
    this.sentCommand = sent;
    if (this.sendError) throw this.sendError;
    if (this.receiptDuringSend) this.callbacks.at(-1)?.(this.receiptDuringSend);
    return this.sendResult;
  }
}

function makeAdapter(
  channel: FakeChannel,
  selected: ManagedTaskConnectionTarget | null = target,
): ConnectionRuntimeResearchDispatchAdapter {
  return new ConnectionRuntimeResearchDispatchAdapter({
    targets: { managedTaskTargetFor: () => selected },
    commands: channel,
  });
}

function options(signal = new AbortController().signal, delayMs = 1_000) {
  return { signal, deadlineAt: Date.now() + delayMs };
}

test('missing exact account/environment target is undeliverable without subscribing or sending', async () => {
  const channel = new FakeChannel();
  const result = await makeAdapter(channel, null).dispatchReadOnly(command(), options());
  assert.deepEqual(result, {
    executionTarget: 'dev', accountId: 'account-1', attemptId: 'attempt-1',
    status: 'undeliverable', reasonCode: 'waiting_for_edge', evidence: null,
  });
  assert.deepEqual(channel.order, []);
});

test('platform and declared edge capability gates fail closed before dispatch', async () => {
  const mismatched = new FakeChannel();
  assert.equal((await makeAdapter(mismatched, { ...target, platform: 'xiaohongshu' })
    .dispatchReadOnly(command(), options())).status, 'unsupported');
  assert.deepEqual(mismatched.order, []);

  const unsupportedPlatform = new FakeChannel();
  assert.equal((await makeAdapter(unsupportedPlatform, { ...target, platform: 'wechat_channels' })
    .dispatchReadOnly(command({ platform: 'wechat_channels' }), options())).status, 'unsupported');
  assert.deepEqual(unsupportedPlatform.order, []);

  const missingCapability = new FakeChannel();
  const result = await makeAdapter(missingCapability, { ...target, capabilities: [] })
    .dispatchReadOnly(command(), options());
  assert.equal(result.status, 'unsupported');
  assert.equal(result.reasonCode, 'capability_not_available');
  assert.deepEqual(missingCapability.order, []);
});

test('subscribes before one atomic send and accepts a synchronous exact-generation receipt', async () => {
  const channel = new FakeChannel();
  channel.receiptDuringSend = completedReceipt();
  const result = await makeAdapter(channel).dispatchReadOnly(command(), options());
  assert.deepEqual(channel.order, ['subscribe:attempt-1', 'send:attempt-1']);
  assert.equal(channel.sentTarget, target);
  assert.equal(channel.sentCommand?.attemptId, 'attempt-1');
  assert.equal(result.status, 'completed');
  assert.equal(channel.unsubscribed, 1);
});

test('ignores receipts from another account, edge, generation, or capability', async () => {
  const channel = new FakeChannel();
  const pending = makeAdapter(channel).dispatchReadOnly(command(), options());
  const receive = channel.callbacks[0]!;
  receive(completedReceipt({ accountId: 'other-account' }));
  receive(completedReceipt({ edgeId: 'ads-other' }));
  receive(completedReceipt({ connectionGeneration: 'generation-2' }));
  receive(completedReceipt({ capabilityId: 'research.browse' }));
  receive(completedReceipt());
  assert.equal((await pending).status, 'completed');
  assert.equal(channel.unsubscribed, 1);
});

test('not-started send stays undeliverable while send throw becomes submitted-unknown', async () => {
  const notStarted = new FakeChannel();
  notStarted.sendResult = { outcome: 'not_started', reason: 'socket_not_open' };
  assert.equal((await makeAdapter(notStarted).dispatchReadOnly(command(), options())).status, 'undeliverable');
  assert.equal(notStarted.unsubscribed, 1);

  const thrown = new FakeChannel();
  thrown.sendError = new Error('socket closed during send');
  assert.equal((await makeAdapter(thrown).dispatchReadOnly(command(), options())).status, 'submitted_unknown');
  assert.equal(thrown.unsubscribed, 1);
});

test('abort is distinct before dispatch but ambiguous after dispatch', async () => {
  const before = new AbortController();
  before.abort();
  const beforeChannel = new FakeChannel();
  assert.equal((await makeAdapter(beforeChannel).dispatchReadOnly(command(), options(before.signal))).status, 'aborted');
  assert.deepEqual(beforeChannel.order, []);

  const after = new AbortController();
  const afterChannel = new FakeChannel();
  const pending = makeAdapter(afterChannel).dispatchReadOnly(command(), options(after.signal));
  after.abort();
  assert.equal((await pending).status, 'submitted_unknown');
  assert.equal(afterChannel.unsubscribed, 1);
});

test('deadline after dispatch is submitted-unknown and never resends', async () => {
  const channel = new FakeChannel();
  const result = await makeAdapter(channel).dispatchReadOnly(command(), options(undefined, 10));
  assert.equal(result.status, 'submitted_unknown');
  assert.equal(result.reasonCode, 'result_unknown');
  assert.deepEqual(channel.order, ['subscribe:attempt-1', 'send:attempt-1']);
  assert.equal(channel.unsubscribed, 1);
});
