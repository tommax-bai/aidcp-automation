// aidcp:test-owner=derived
/**
 * 边缘接入的行为闸（task 3.1 · 批 D）。
 *
 * 本批真正会**静默**出错的是四处，每处都有会真触发它的用例：
 *
 * 1. **出口闸把 `unknown` 当 `blocked`** —— 不报错，只是租约归还发不出去，
 *    浏览器槽位永不释放，而调用方看到的是「投递 0 个」，把在线的边缘归因成离线。
 * 2. **账号暂停态没接上** —— 处理器那一句是 `accountState?.pauseStateOf(…) ?? 'active'`，
 *    不接就是恒「未暂停」：运营点了暂停、后台写入成功、账号继续对真实平台动作，全程零报错。
 * 3. **连接断开只失效租约、不失效在途发布指令** —— 那条等待窗口随正文长度伸缩、可达数分钟，
 *    空转到底会把该账号后面所有已审稿件堵在串行队列里。
 * 4. **互动能力缺席时不吭声** —— 与「接了但今天不可用」同形，两台机器都查不出所以然。
 *
 * 另有一条**结构断言**，因为它守的东西行为测试原理上看不见：
 * `unknown` 档的放行判定只许有一份（kernel 那一份）。第二份写出来那一刻行为完全一致，
 * 要等两份漂开、且恰好在该拦住的那一刻才现形。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type pg from 'pg';

import type { ConfigMirrorKey } from 'aidcp-kernel/kernel/config-mirror-bump-types.js';

import {
  createAutomationEdgeAccess,
  createAutomationEdgeTransportGate,
} from '../../src/automation-edge-access.js';
import type {
  AutomationEdgeAccessOptions,
  AutomationEdgeInteractionSupport,
} from '../../src/automation-edge-access.js';
import type { Envelope, MessageType } from '../../src/comm/protocol.js';
import type { EdgeSession, WsServerOptions } from '../../src/comm/ws-server.js';
import { AutomationSyncReadMirrors } from '../../src/transport/automation-sync-read-mirrors.js';

function envelopeOf(type: MessageType): Envelope {
  return { v: 2, id: `e-${type}`, ts: 1, type, payload: {} } as Envelope;
}

/** 出口闸的最小装置：镜像三态由入参钉死，落账口只计数。 */
function gateFixture(state: 'allowed' | 'blocked' | 'unknown') {
  const refusals: { key: ConfigMirrorKey; context?: string }[] = [];
  const gate = createAutomationEdgeTransportGate({
    mirrors: { automationGateForEdgeId: () => state },
    refusals: { noteStaleRefusal: (key, context) => refusals.push({ key, context }) },
  });
  return { gate, refusals };
}

test('副本陈旧（unknown）时租约归还仍放行 —— 扣住它，浏览器槽位就永不释放', () => {
  const { gate, refusals } = gateFixture('unknown');
  assert.equal(gate(envelopeOf('task.release'), 'ads-1'), true);
  assert.equal(gate(envelopeOf('task.acquire'), 'ads-1'), true);
  assert.deepEqual(refusals, [], '放行的那些不记账，否则「因陈旧拒绝」这个指标会被纯控制面淹没');
});

test('副本陈旧时新的真实平台动作被拦下，且这一次拒绝有账可查', () => {
  const { gate, refusals } = gateFixture('unknown');
  assert.equal(gate(envelopeOf('xiaohongshu.note.like'), 'ads-1'), false);
  assert.deepEqual(refusals, [
    { key: 'client_environment_automation_gate', context: 'transport:xiaohongshu.note.like' },
  ]);
});

test('副本陈旧时控制面照常放行（停手的边界是「新的真实平台动作」，不是一切）', () => {
  const { gate, refusals } = gateFixture('unknown');
  assert.equal(gate(envelopeOf('ui.push_snapshot'), 'ads-1'), true);
  assert.equal(gate(envelopeOf('xiaohongshu.navigation.back'), 'ads-1'), true, '详情页收尾属自然结束路径（批 6b：close 并入 back）');
  assert.deepEqual(refusals, []);
});

test('确定态 blocked 一律不放行，且**不记**「因陈旧的拒绝」（那是另一回事）', () => {
  const { gate, refusals } = gateFixture('blocked');
  assert.equal(gate(envelopeOf('xiaohongshu.note.like'), 'ads-1'), false);
  assert.equal(gate(envelopeOf('task.release'), 'ads-1'), false);
  assert.deepEqual(refusals, [], 'blocked 是环境删除生命周期，不是副本陈旧；混记会污染停手指标');
});

test('blocked 下删除相关的两类必须穿透，否则 tombstone 前会被环境删除闸自锁', () => {
  const { gate } = gateFixture('blocked');
  assert.equal(gate(envelopeOf('session.end'), 'ads-1'), true);
  assert.equal(gate(envelopeOf('wechat_channels.inbox.offboard.command'), 'ads-1'), true);
});

test('结构断言：unknown 档的放行判定只许有一份（取 kernel 那一份，不许本仓再写）', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/automation-edge-access.ts', import.meta.url)),
    'utf8',
  );
  assert.match(
    source,
    /import \{ allowsTransportWhenGateUnknown \} from 'aidcp-kernel\/kernel\/transport-gate-exemptions\.js'/,
    '放行判定 MUST 按引用取 kernel 那一份',
  );
  assert.equal(
    /TRANSPORT_EXEMPT_WHEN_MIRROR_UNKNOWN\s*=/.test(source),
    false,
    '本仓 MUST NOT 自建豁免名单：第二份在写出来那一刻行为完全一致，'
      + '要等两份漂开、且恰好在该拦住的那一刻才现形',
  );
});

// ── 工厂整体：三个必填端口 + 两个回调 ────────────────────────────────────────

/** 连不上的池：让锚点缓存与节奏配置各自走「具名退化、不阻塞启动」那条路。 */
const DEAD_POOL = {
  query: async () => {
    throw new Error('no database in unit test');
  },
} as unknown as pg.Pool;

interface Recorder {
  /**
   * **一条按序的流水**，不是几个各自独立的数组。
   * 分开记的话「先回填快照、后提交传输」这种顺序倒置在断言上完全看不见 ——
   * 而顺序正是这里唯一要守的东西。
   */
  events: string[];
  welcomed: string[];
  helloSnapshots: string[];
  registeredEnvKeys: string[];
  reconciled: string[];
  disconnected: string[];
  leaseInvalidations: string[];
  sequencerInvalidations: string[];
  warnings: string[];
}

function optionsFor(
  recorder: Recorder,
  overrides: {
    mirrors?: AutomationSyncReadMirrors;
    isStale?: (key: ConfigMirrorKey) => boolean;
    interaction?: AutomationEdgeInteractionSupport;
    captureServerOptions?: (o: WsServerOptions) => void;
  } = {},
): AutomationEdgeAccessOptions {
  const mirrors = overrides.mirrors ?? new AutomationSyncReadMirrors('dev', () => 1_000);
  const interaction: AutomationEdgeInteractionSupport = overrides.interaction ?? {
    state: 'wired',
    port: {
      inbox: {
        onAuthStatus: async () => undefined,
        onSyncBatch: async () => ({}) as never,
        onReplyResult: async () => ({ duplicate: false }),
        onReplyReconcileResult: async () => undefined,
        onOffboardResult: async () => ({ duplicate: false }),
      },
      runtimeControls: { getSnapshot: async () => ({}) as never },
      reconcileOnWelcome: async ({ accountId }) => {
        recorder.events.push(`reconcile:${accountId}`);
        recorder.reconciled.push(accountId);
      },
      // 本文件测的是边缘接入、不是离场派发；桩只记事件，**不假装派发出去了**。
      dispatchPendingOffboards: async (accountId) => {
        recorder.events.push(`dispatch-offboards:${accountId}`);
        return 0;
      },
    },
  };
  return {
    ownerPool: DEAD_POOL,
    // 桩：本用例跑不到任何写口（池是死池）。这一格**必填**是有意的——缺席时的真实行为是
    // 「写照常提交、失效信号从源头不产生、零告警」，那条静默通道不配有可选写法。
    mirrorVersionBumper: { bumpDomain: 'automation', bumpInTx: async () => undefined },
    port: 0,
    llm: { complete: async () => '' } as never,
    eventBus: { emit: () => undefined, on: () => undefined } as never,
    mirrors,
    configMirrorGate: {
      isStale: overrides.isStale ?? (() => false),
      hasStaleGateMirror: () => false,
      platformActionHalt: () => ({ halted: false }) as never,
      noteStaleRefusal: () => undefined,
    },
    risk: {
      resolveController: async () => ({}) as never,
      raiseAlert: async () => undefined,
    },
    personaService: {} as never,
    edgePublish: {
      decidePublishApproval: async () => ({ requestId: '', ok: true }) as never,
      removeDraftImage: async () => ({ requestId: '', ok: true }) as never,
    },
    notifications: { deliver: async () => undefined },
    environmentRegistry: {
      registerHandshakeEnvironment: async (input) => {
        recorder.events.push(`register-env:${input.envKey}`);
        recorder.registeredEnvKeys.push(input.envKey);
      },
    },
    runtime: {
      busFor: () => ({ emit: () => undefined }) as never,
      onHandshake: () => ({ ok: true }),
      controllerForSession: () => undefined,
      onDisconnect: (session) => recorder.disconnected.push(session.sessionId),
      // 批 F 的当日用量 / 待机提示读这两口；批 D 自己不读，但它们与上面几口来自**同一个注册表实例**，
      // 所以挂在同一个端口上（拆成两个接口就可能供出两个不同实例，那种错不报错、只是数字对不上）。
      sessionUsageForAccount: () => null,
      resumeGateForAccount: () => null,
      onWelcomed: (session) => {
        recorder.events.push(`welcomed:${session.sessionId}`);
        recorder.welcomed.push(session.sessionId);
      },
    },
    uiSnapshot: {
      pushHelloSnapshot: async (accountId) => {
        recorder.events.push(`hello-snapshot:${accountId ?? '-'}`);
        recorder.helloSnapshots.push(accountId ?? '-');
      },
    },
    interaction,
    logger: {
      log: () => undefined,
      warn: (message: unknown) => recorder.warnings.push(String(message)),
      error: () => undefined,
    },
    createServer: (serverOptions) => {
      overrides.captureServerOptions?.(serverOptions);
      return {
        start: async () => undefined,
        close: async () => undefined,
        invalidateEdge: () => undefined,
      } as never;
    },
  };
}

function newRecorder(): Recorder {
  return {
    events: [],
    welcomed: [],
    helloSnapshots: [],
    registeredEnvKeys: [],
    reconciled: [],
    disconnected: [],
    leaseInvalidations: [],
    sequencerInvalidations: [],
    warnings: [],
  };
}

function sessionOf(overrides: Partial<EdgeSession> = {}): EdgeSession {
  return {
    sessionId: 'sess-1',
    edgeId: 'ads-42',
    accountId: 'acc-1',
    ...overrides,
  } as EdgeSession;
}

test('账号暂停态三态：副本陈旧答 unknown，绝不退回「查不到即 active」', async () => {
  const recorder = newRecorder();
  const access = await createAutomationEdgeAccess(
    optionsFor(recorder, { isStale: (key) => key === 'account_status' }),
  );
  assert.equal(access.accountPause.pauseStateOf('acc-1'), 'unknown');
  await access.close();
});

test('账号暂停态三态：副本新鲜且投影里没有这个账号 → active（与单体逐字一致）', async () => {
  const recorder = newRecorder();
  const access = await createAutomationEdgeAccess(optionsFor(recorder, { isStale: () => false }));
  assert.equal(access.accountPause.pauseStateOf('never-seen'), 'active');
  await access.close();
});

test('连接断开：租约与在途发布指令**都要**失效，少一个就把后面的稿件堵死', async () => {
  const recorder = newRecorder();
  let serverOptions: WsServerOptions | undefined;
  const access = await createAutomationEdgeAccess(
    optionsFor(recorder, { captureServerOptions: (o) => { serverOptions = o; } }),
  );
  access.edgeTaskLeases.invalidateEdge = (edgeId: string) => {
    recorder.leaseInvalidations.push(edgeId);
  };
  access.commandSequencer.invalidateEdge = ((edgeId: string) => {
    recorder.sequencerInvalidations.push(edgeId);
  }) as never;

  serverOptions!.onClose!(sessionOf());

  assert.deepEqual(recorder.leaseInvalidations, ['ads-42']);
  assert.deepEqual(
    recorder.sequencerInvalidations,
    ['ads-42'],
    '只失效租约不失效在途指令 ⇒ 正文填写的等待窗口空转到底（可达数分钟）',
  );
  assert.deepEqual(recorder.disconnected, ['sess-1']);
  await access.close();
});

test('握手注册完成：先提交传输（onWelcomed），再做那些失败也不该影响在线的回填', async () => {
  const recorder = newRecorder();
  let serverOptions: WsServerOptions | undefined;
  const access = await createAutomationEdgeAccess(
    optionsFor(recorder, { captureServerOptions: (o) => { serverOptions = o; } }),
  );

  serverOptions!.onEdgeRegistered!(sessionOf({ capabilities: [] }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    recorder.events[0],
    'welcomed:sess-1',
    'welcome 是传输提交点：只有走到这一步的新连接才可顶替同 edgeId 旧连接并激活浏览业务。'
      + '把它排在任何一个回填之后，都会让「快照回填失败」这类可容忍的事影响到连接顶替',
  );
  assert.deepEqual(
    recorder.events.slice(1).sort(),
    ['hello-snapshot:acc-1', 'reconcile:acc-1', 'register-env:42'],
    '后面三件都是 fire-and-forget，彼此无序；ads- 前缀的真实分身进「待分配」池、只登记不归属',
  );
  await access.close();
});

test('兜底 edge（非 ads- 前缀）不是可分配环境，绝不登记进管理侧注册表', async () => {
  const recorder = newRecorder();
  let serverOptions: WsServerOptions | undefined;
  const access = await createAutomationEdgeAccess(
    optionsFor(recorder, { captureServerOptions: (o) => { serverOptions = o; } }),
  );

  serverOptions!.onEdgeRegistered!(sessionOf({ edgeId: 'self-local', capabilities: [] }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(recorder.registeredEnvKeys, []);
  await access.close();
});

test('互动能力缺席时**说出来**：与「接了但今天不可用」同形的沉默，两台机器都查不出所以然', async () => {
  const recorder = newRecorder();
  const access = await createAutomationEdgeAccess(
    optionsFor(recorder, {
      interaction: { state: 'unavailable', reason: 'interaction_schema_unavailable' },
    }),
  );
  assert.equal(
    recorder.warnings.some((line) => line.includes('interaction_schema_unavailable')),
    true,
    '缺席必须带具名理由；`undefined` 表示不了「为什么没有」',
  );
  await access.close();
});

test('依赖不可用只做具名退化，不阻塞装配（锚点缓存 / 节奏兜底各报各的）', async () => {
  const recorder = newRecorder();
  const access = await createAutomationEdgeAccess(optionsFor(recorder));
  assert.deepEqual(
    access.degraded.map((item) => item.component).sort(),
    ['PacingConfigStore', 'PgAnchorCache'],
    '退化项要说得出来，不是一个 undefined 了事',
  );
  await access.close();
});
