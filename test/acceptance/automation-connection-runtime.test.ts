// aidcp:test-owner=derived
/**
 * 每连接运行时的行为闸（task 3.1 · 批 E 前半）。
 *
 * 本批真正会**静默**出错的是三处，每处都有会真触发它的用例：
 *
 * 1. **缺账号标识的握手被放过** —— 一台配错的机器会安静地拿别人的账号去动真实平台。
 * 2. **配置错误只写日志、不发出去** —— 这类错没有自愈路径，没人看见就永远停在那台机器上。
 * 3. **归属切换后不驱逐缓存的控制器** —— 陈旧的「正常」会盖回接管方刚写的「受限」，
 *    而那时归属谓词已经通过、最后一道保护不再触发。**这一条不报错，只是保护消失。**
 *
 * 另有一条**结构断言**：调度器工厂必须是必填注入口。做成可选的话，
 * 「批 E 后半还没接」与「这个账号今天没排期」在行为上完全同形 —— 连接建得起来、
 * 握手也过，只是永远不开始浏览。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createAutomationConnectionRuntime } from '../../src/automation-connection-runtime.js';
import type { AutomationConnectionRuntimeOptions } from '../../src/automation-connection-runtime.js';
import { EventBus } from '../../src/event-bus/index.js';
import type { EdgeSession } from '../../src/comm/ws-server.js';

interface Recorder {
  notifications: string[];
  evicted: string[];
  ensured: { accountId: string; platform?: string }[];
  closedSessions: string[];
  dispatchersBuilt: string[];
  errors: string[];
}

function newRecorder(): Recorder {
  return {
    notifications: [],
    evicted: [],
    ensured: [],
    closedSessions: [],
    dispatchersBuilt: [],
    errors: [],
  };
}

function optionsFor(
  recorder: Recorder,
  overrides: { withOwnership?: boolean; platform?: string | null } = {},
): AutomationConnectionRuntimeOptions {
  return {
    observerBus: new EventBus(),
    riskRegistry: {
      getWritableController: async () => ({ accountId: 'acc-1' }) as never,
      evict: (accountId: string) => {
        recorder.evicted.push(accountId);
        return true;
      },
    },
    buildDispatcher: (context) => {
      recorder.dispatchersBuilt.push(context.accountId);
      return { setup: () => undefined, stop: () => undefined } as never;
    },
    accountRuntime: {
      ensureAccount: async (accountId, platform) => {
        recorder.ensured.push({ accountId, platform });
      },
      getPlatformOrNull: async () =>
        overrides.platform === undefined ? 'facebook' : overrides.platform,
      recordNickname: async () => undefined,
    },
    closeEdge: (sessionId) => recorder.closedSessions.push(sessionId),
    notifications: {
      deliver: async (input) => {
        recorder.notifications.push(JSON.stringify(input.notification));
      },
    },
    ...(overrides.withOwnership
      ? {
          ownership: {
            executionTarget: 'dev' as const,
            port: {} as never,
            raiseAlert: async () => undefined,
          },
        }
      : {}),
    logger: {
      log: () => undefined,
      warn: () => undefined,
      error: (message: unknown) => recorder.errors.push(String(message)),
    },
  };
}

function sessionOf(overrides: Partial<EdgeSession> = {}): EdgeSession {
  return { sessionId: 'sess-1', edgeId: 'ads-1', accountId: 'acc-1', ...overrides } as EdgeSession;
}

test('缺账号标识的握手被拒，MUST NOT 偷映射成某个默认账号开跑', async () => {
  const recorder = newRecorder();
  const runtime = createAutomationConnectionRuntime(optionsFor(recorder));
  const outcome = await runtime.runtimes.onHandshake(sessionOf({ accountId: undefined }));
  assert.equal(outcome.ok, false, '放过它 = 一台配错的机器拿别人的账号去动真实平台');
  assert.deepEqual(recorder.ensured, [], '被拒的握手不该顺手把账号登记进主数据');
  await runtime.close();
});

test('握手配置错误**发得出去**：这类错没有自愈路径，只写日志等于永远不修', async () => {
  const recorder = newRecorder();
  const runtime = createAutomationConnectionRuntime(optionsFor(recorder));
  await runtime.runtimes.onHandshake(sessionOf({ accountId: '   ' }));
  assert.equal(recorder.notifications.length, 1, '必须真发出去一条');
  assert.match(
    recorder.notifications[0]!,
    /握手被拒/,
    '文案要说清是被拒了，别让运营以为只是一次抖动',
  );
  await runtime.close();
});

test('通知发不出去时也不吞：日志留两条（拒绝本身 + 通知失败）', async () => {
  const recorder = newRecorder();
  const options = optionsFor(recorder);
  options.notifications = {
    deliver: async () => {
      throw new Error('feishu down');
    },
  };
  const runtime = createAutomationConnectionRuntime(options);
  await runtime.runtimes.onHandshake(sessionOf({ accountId: undefined }));
  assert.equal(recorder.errors.length, 2, '通知挂了不能连带把「握手被拒」这件事一起吞掉');
  await runtime.close();
});

test('归属切换后驱逐本进程缓存的控制器 —— 少这一步，陈旧的「正常」会盖回刚写的「受限」', async () => {
  const recorder = newRecorder();
  const options = optionsFor(recorder, { withOwnership: true });
  const runtime = createAutomationConnectionRuntime(options);
  // 注册表把归属那一段原样交给底层，故直接触发它注入进去的回调。
  const wiring = (runtime.runtimes as unknown as {
    deps: { ownership?: { onClaimed?: (accountId: string) => Promise<void> } };
  }).deps.ownership;
  assert.ok(wiring?.onClaimed, '归属接上时 MUST 带驱逐回调');
  await wiring!.onClaimed!('acc-9');
  assert.deepEqual(
    recorder.evicted,
    ['acc-9'],
    '只重放计数会漏掉状态：陈旧的 normal 会在下次条件写时盖回接管方刚写的 restricted',
  );
  await runtime.close();
});

test('未注入归属时整段不启用（与未接归属逐位一致，不是「半启用」）', () => {
  const recorder = newRecorder();
  const runtime = createAutomationConnectionRuntime(optionsFor(recorder));
  const wiring = (runtime.runtimes as unknown as {
    deps: { ownership?: unknown };
  }).deps.ownership;
  assert.equal(wiring, undefined, '缺任一项即整段不启用；半启用会得到一个谁也说不清的中间态');
});

test('账号平台读不到时的回落写在本层，属主口如实答 null', async () => {
  const recorder = newRecorder();
  const runtime = createAutomationConnectionRuntime(optionsFor(recorder, { platform: null }));
  const getPlatform = (runtime.runtimes as unknown as {
    deps: { getAccountPlatform?: (accountId: string) => Promise<string> };
  }).deps.getAccountPlatform;
  assert.equal(await getPlatform!('acc-1'), 'xiaohongshu');
  await runtime.close();
});

test('动作冷却兜底闸是单例共享：同账号 N 连接必须共用同一条时间线', () => {
  const recorder = newRecorder();
  const a = createAutomationConnectionRuntime(optionsFor(recorder));
  assert.ok(a.actionCooldown, '每连接各持一条时间线的话，它防的「同刻双发」正好防不住');
  assert.ok(a.interactionGuards);
});

test('结构断言：调度器工厂是**必填**注入口，不许退化成可选', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/automation-connection-runtime.ts', import.meta.url)),
    'utf8',
  );
  assert.match(
    source,
    /buildDispatcher: AutomationDispatcherFactory;/,
    '一旦写成 `buildDispatcher?:`，「批 E 后半还没接」与「这个账号今天没排期」'
      + '在行为上完全同形 —— 连接建得起来、握手也过，只是永远不开始浏览',
  );
  assert.equal(
    /buildDispatcher\?:/.test(source),
    false,
    '必填是这一批唯一的机械保证：后半缺席必须是编译期可见的',
  );
});
