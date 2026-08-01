// aidcp:test-owner=derived
/**
 * 进程启动外壳的行为闸（task 3.2/3.3，批 A）。
 *
 * 这些用例守的是「就绪闸的四个要点」，每一条都对着一个已知的失手形态：
 *
 * - **先监听再放行**：反过来的话，外部分不出「还没就绪」与「进程没起来」，
 *   而这两者的处置完全不同（等 vs 上机器查）。
 * - **未就绪不放行**：放行了就等于宣称能接活，而镜像还没装载完 —— 那是最典型的静默假成功。
 * - **重复就绪信号不重复放行**：靠的是**在途 promise 去重**，不是那个布尔。
 *   只看布尔时，「首轮刷新完成」与「就绪度巡视」并发命中会启动两次业务入口。
 *   **这条用例是专门为那个去重写的，别当冗余删掉** —— 把去重删掉、只留布尔，其它用例照样全绿。
 * - **首轮放行失败不算启动失败**：监听已经起来了，探活要如实报「未放行」，而不是让进程退出重启。
 * - **探活里必须带上放行状态**：只报就绪度的话，「监听着但没放行业务」这个中间态是不可观测的。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';

import {
  makeSyncReadFactEnvelope,
  type SyncReadPayloadByStream,
} from 'aidcp-kernel/kernel/sync-read-facts.js';
import {
  SYNC_READ_CHANGED_TOPIC,
  syncReadPayloadDigest,
  type SyncReadConsumerCheckpoint,
  type SyncReadSnapshotEnvelope,
  type SyncReadStream,
} from 'aidcp-kernel/kernel/sync-read-snapshot.js';

import {
  createAutomationCompositionRoot,
  type AutomationCompositionRoot,
  type AutomationRootConfig,
  type AutomationRuntimeHandles,
} from '../../src/automation-composition-root.js';
import {
  AUTOMATION_SYNC_READ_READINESS_ROUTE,
  startAutomationService,
  type AutomationBusinessIngress,
  type AutomationSignalSource,
} from '../../src/automation-service-entry.js';
import { InternalHttpClient } from '../../src/transport/internal-http.js';

const CONFIG: AutomationRootConfig = {
  executionTarget: 'dev',
  apiBaseUrl: 'http://127.0.0.1:1',
  apiInternalToken: 'api-token',
  automationInternalToken: 'automation-token',
  contentBaseUrl: 'http://127.0.0.1:2',
  contentInternalToken: 'content-token',
  automationPort: 0,
  offboardWorkerId: 'offboard-reconcile-dev',
};

function runtimeHandles(): AutomationRuntimeHandles {
  return {
    edgeResume: { wsServer: { resumeEdgesForAccount: () => 0 } },
    facebookScope: {
      owner: {
        importTargets: async () => ({
          imported: 0,
          updated: 0,
          duplicate: 0,
          invalid: 0,
          rows: [],
        }),
        replaceTargetScopes: async () => ({ ok: true, items: [] }),
      },
      refreshAccountProjection: async () => ({ ok: true, rows: 0 }),
    },
    publishUiUpdate: {
      uiSnapshot: { pushPublishPreview: () => {}, pushPublishState: () => {} },
    },
    syncReadSources: {
      sessionConfigGlobal: async () => ({ cursor: '1', weekActiveMask: '1111111' }),
      edgePresence: () => ({ edgeCount: 0, onlineEdgeCount: 0, accountEdges: [] }),
      publishInFlight: () => ({ recordIds: [] }),
      captchaAvailability: () => ({ state: 'disabled' }),
      configMirrorHealth: () => ({
        sourceService: 'automation',
        asOf: 1_000,
        enabled: true,
        pollMs: 30_000,
        entries: [],
      }),
    },
  };
}

const SYNC_READ_PAYLOADS = {
  session_config_global: { weekActiveMask: '1111111' },
  edge_presence: { edgeCount: 0, onlineEdgeCount: 0, accountEdges: [] },
  publish_in_flight: { recordIds: [] },
  captcha_availability: { state: 'disabled' },
  automation_config_mirror_health: {
    sourceService: 'automation',
    asOf: 1_000,
    enabled: true,
    pollMs: 30_000,
    entries: [],
  },
  account_persona: { accounts: [] },
  client_environment_automation: { blockedEnvironmentKeys: [], slowStartAnchors: [] },
  automation_account_projection: { accounts: [] },
  content_schedule: { global: null, accounts: [] },
  hot_lead_config: { maxAgeHours: 24, velocityMin: 3, minLikeFloor: 5, floorHours: 2 },
  facebook_comment_config: { accounts: [] },
  facebook_group_join_automation_config: { accounts: [] },
} as const satisfies { [S in SyncReadStream]: SyncReadPayloadByStream[S] };

function envelope<S extends SyncReadStream>(
  stream: S,
  asOf = 1_000,
): SyncReadSnapshotEnvelope<SyncReadPayloadByStream[S]> {
  return makeSyncReadFactEnvelope({
    executionTarget: 'dev',
    stream,
    cursor: '1',
    asOf,
    freshUntil: asOf + 60_000,
    value: SYNC_READ_PAYLOADS[stream],
  });
}

/** 建一个不碰网络、不碰库的组装根；`blocked()` 为真时让一条消费流失败，就绪度因此停在 not_ready。 */
function rootFactory(blocked: () => boolean) {
  return (options: Parameters<typeof createAutomationCompositionRoot>[0]) =>
    createAutomationCompositionRoot({
      ...options,
      ownerPool: {} as pg.Pool,
      syncRead: {
        clock: () => 1_000,
        ownerSnapshotSource: {
          snapshot: async <S extends SyncReadStream>(stream: S, observedAt = 1_000) =>
            envelope(stream, observedAt),
          publishChanged: async (stream, observedAt = 1_000) => envelope(stream, observedAt),
        },
        fetchOwnerSnapshot: async (stream) => {
          if (stream === 'content_schedule' && blocked()) {
            throw new Error('api_snapshot_unavailable');
          }
          return envelope(stream);
        },
        checkpointStore: {
          load: async () => ({ outcome: 'not_found', checkpoint: null }),
          save: async (input) => ({
            outcome: 'stored',
            checkpoint: input as SyncReadConsumerCheckpoint,
          }),
        },
        accountProjectionStore: {
          init: async () => undefined,
          applyOwnerSnapshot: async (input) => {
            const value = input as SyncReadSnapshotEnvelope;
            return {
              outcome: 'applied',
              cursor: value.cursor,
              payloadDigest: syncReadPayloadDigest(value.value),
            };
          },
          stop: () => undefined,
        },
        signalRelay: {
          start: () => undefined,
          stop: () => undefined,
          stats: () => ({
            running: true,
            topics: [SYNC_READ_CHANGED_TOPIC],
            lastError: null,
            blocked: [],
          }),
        },
        setTimer: () => ({} as ReturnType<typeof setTimeout>),
        clearTimer: () => undefined,
        logger: { warn: () => undefined },
      },
    });
}

function recordingIngress(): AutomationBusinessIngress & {
  starts: number;
  stops: number;
} {
  const state = {
    starts: 0,
    stops: 0,
    start: async () => {
      state.starts += 1;
    },
    stop: async () => {
      state.stops += 1;
    },
  };
  return state;
}

const SILENT = { log: () => undefined, warn: () => undefined, error: () => undefined };

test('就绪时先监听、再放行业务，探活如实报出两者', async () => {
  const ingress = recordingIngress();
  const service = await startAutomationService({
    config: CONFIG,
    runtime: runtimeHandles(),
    businessIngress: ingress,
    createRoot: rootFactory(() => false),
    signals: null,
    logger: SILENT,
  });
  try {
    assert.ok(service.port > 0, '必须真的监听在一个端口上');
    assert.equal(service.readiness().state, 'ready');
    assert.equal(service.businessIngressStarted(), true);
    assert.equal(ingress.starts, 1);

    const probe = await new InternalHttpClient(`http://127.0.0.1:${service.port}`).callBearer<{
      service: string;
      businessIngressStarted: boolean;
      state: string;
    }>(AUTOMATION_SYNC_READ_READINESS_ROUTE, {}, CONFIG.automationInternalToken);
    assert.deepEqual(
      { service: probe.service, started: probe.businessIngressStarted, state: probe.state },
      { service: 'automation', started: true, state: 'ready' },
    );
  } finally {
    await service.close();
  }
  assert.equal(ingress.stops, 1);
});

test('未就绪时监听照起、业务不放行，探活把这个中间态报得出来', async () => {
  const ingress = recordingIngress();
  let blocked = true;
  const service = await startAutomationService({
    config: CONFIG,
    runtime: runtimeHandles(),
    businessIngress: ingress,
    createRoot: rootFactory(() => blocked),
    signals: null,
    logger: SILENT,
    setTimer: () => ({} as ReturnType<typeof setInterval>),
    clearTimer: () => undefined,
  });
  try {
    assert.ok(service.port > 0, '未就绪不等于不监听——否则外部分不出「没就绪」与「没起来」');
    assert.equal(service.readiness().state, 'not_ready');
    assert.equal(service.businessIngressStarted(), false);
    assert.equal(ingress.starts, 0, '就绪度不是 ready 就 MUST NOT 放行业务');

    const probe = await new InternalHttpClient(`http://127.0.0.1:${service.port}`).callBearer<{
      businessIngressStarted: boolean;
      state: string;
      blockers: { stream: string; message: string | null }[];
    }>(AUTOMATION_SYNC_READ_READINESS_ROUTE, {}, CONFIG.automationInternalToken);
    assert.equal(probe.businessIngressStarted, false);
    assert.equal(probe.state, 'not_ready');
    assert.deepEqual(
      probe.blockers.map((entry) => [entry.stream, entry.message]),
      [['content_schedule', 'api_snapshot_unavailable']],
      '阻塞原因必须具名到流，否则运维只知道「没就绪」',
    );
    blocked = false;
  } finally {
    await service.close();
  }
  assert.equal(ingress.stops, 0, '没放行过就没什么可停的');
});

test('重复的就绪信号不重复放行业务（靠在途 promise 去重，不是靠那个布尔）', async () => {
  let blocked = true;
  const started: number[] = [];
  // 卡住那一下**只在明确布防后才生效**。若无条件卡住，一旦就绪闸被删（这正是本文件跑过的变异之一），
  // 启动期那次放行就会永远悬着、`startAutomationService` 永不返回，测试进程整体挂死——
  // 结果是「变异跑不完」，而不是「变异被抓住」。布防开关让那种情况干脆地红掉。
  const hold: { armed: boolean; release: (() => void) | null } = { armed: false, release: null };
  const ingress: AutomationBusinessIngress = {
    start: async () => {
      started.push(started.length + 1);
      if (!hold.armed) return;
      // 放行卡在途中：布尔此刻还没置起来，正是「只看布尔」会重复放行的那个窗口。
      await new Promise<void>((resolve) => {
        hold.release = resolve;
      });
    },
    stop: async () => undefined,
  };
  const ticks: (() => void)[] = [];
  const roots: AutomationCompositionRoot[] = [];
  const service = await startAutomationService({
    config: CONFIG,
    runtime: runtimeHandles(),
    businessIngress: ingress,
    createRoot: (options) => {
      const root = rootFactory(() => blocked)(options);
      roots.push(root);
      return root;
    },
    signals: null,
    logger: SILENT,
    setTimer: (fn) => {
      ticks.push(fn);
      return {} as ReturnType<typeof setInterval>;
    },
    clearTimer: () => undefined,
  });
  try {
    assert.equal(started.length, 0);
    assert.equal(ticks.length, 1, '未就绪时必须排上就绪度巡视，否则永远等不到放行');
    blocked = false;
    await roots[0]!.syncRead.refresh();
    assert.equal(service.readiness().state, 'ready');
    hold.armed = true;
    // 三次就绪信号连着来。只看布尔的话，第一次还没把布尔置起来，后两次会各自再启一遍。
    ticks[0]!();
    ticks[0]!();
    ticks[0]!();
    await Promise.resolve();
    assert.deepEqual(started, [1], '重复的就绪信号 MUST 只放行一次业务入口');
  } finally {
    // MUST 在 close 之前放掉那个卡住的放行：关停会等在途放行落地，断言先失败的话
    // 这里不放就会**挂住整个测试进程**，把「变异被抓住了」变成「跑不完、看不出结论」。
    hold.release?.();
    await service.close();
  }
});

test('首轮放行失败不算启动失败：监听保住、探活如实报未放行', async () => {
  const ingress: AutomationBusinessIngress = {
    start: async () => {
      throw new Error('business_ingress_boom');
    },
    stop: async () => undefined,
  };
  const service = await startAutomationService({
    config: CONFIG,
    runtime: runtimeHandles(),
    businessIngress: ingress,
    createRoot: rootFactory(() => false),
    signals: null,
    logger: SILENT,
    setTimer: () => ({} as ReturnType<typeof setInterval>),
    clearTimer: () => undefined,
  });
  try {
    assert.ok(service.port > 0);
    assert.equal(service.businessIngressStarted(), false);
    assert.equal(service.readiness().state, 'ready', '同步读就绪与业务放行是两件事，别混报');
  } finally {
    await service.close();
  }
});

test('终止信号触发优雅关停，且处理器摘掉自己（第二个信号落回默认处置）', async () => {
  const ingress = recordingIngress();
  const handlers = new Map<string, (() => void)[]>();
  const signals: AutomationSignalSource = {
    on: (signal, handler) => {
      handlers.set(signal, [...(handlers.get(signal) ?? []), handler]);
      return undefined;
    },
    off: (signal, handler) => {
      handlers.set(signal, (handlers.get(signal) ?? []).filter((entry) => entry !== handler));
      return undefined;
    },
  };
  const service = await startAutomationService({
    config: CONFIG,
    runtime: runtimeHandles(),
    businessIngress: ingress,
    createRoot: rootFactory(() => false),
    signals,
    logger: SILENT,
  });
  assert.equal(handlers.get('SIGTERM')?.length, 1);
  assert.equal(handlers.get('SIGINT')?.length, 1);

  handlers.get('SIGTERM')![0]!();
  await service.close();
  assert.equal(ingress.stops, 1);
  assert.equal(handlers.get('SIGTERM')?.length, 0, '摘掉自己：第二个信号交回 Node 默认处置');
  assert.equal(handlers.get('SIGINT')?.length, 0);
});

test('关停等在途放行落地后再停业务，绝不把它丢在半途', async () => {
  // **这条是补出来的，别当冗余删掉**：把「关停等在途放行」那两行删掉，其余五条用例**一条都不红**——
  // 因为它们的放行都是瞬时完成的，根本没有「正在放行」这个窗口。真实后果是业务入口被丢在半途：
  // 服务声称已关停，实际那一半还在跑，且永远等不到它的 stop。
  let blocked = true;
  const events: string[] = [];
  const hold: { armed: boolean; release: (() => void) | null } = { armed: false, release: null };
  const ingress: AutomationBusinessIngress = {
    start: async () => {
      events.push('start:begin');
      if (hold.armed) {
        await new Promise<void>((resolve) => {
          hold.release = resolve;
        });
      }
      events.push('start:end');
    },
    stop: async () => {
      events.push('stop');
    },
  };
  const ticks: (() => void)[] = [];
  const roots: AutomationCompositionRoot[] = [];
  const service = await startAutomationService({
    config: CONFIG,
    runtime: runtimeHandles(),
    businessIngress: ingress,
    createRoot: (options) => {
      const root = rootFactory(() => blocked)(options);
      roots.push(root);
      return root;
    },
    signals: null,
    logger: SILENT,
    setTimer: (fn) => {
      ticks.push(fn);
      return {} as ReturnType<typeof setInterval>;
    },
    clearTimer: () => undefined,
  });
  blocked = false;
  await roots[0]!.syncRead.refresh();
  hold.armed = true;
  ticks[0]!();
  await Promise.resolve();
  assert.deepEqual(events, ['start:begin'], '放行此刻卡在途中');

  const closing = service.close();
  hold.release?.();
  await closing;
  assert.deepEqual(
    events,
    ['start:begin', 'start:end', 'stop'],
    '关停 MUST 等在途放行落地再停它；否则业务入口被丢在半途，且它的 stop 永远不会被调用',
  );
});

test('关停可重复调用，业务入口只停一次', async () => {
  const ingress = recordingIngress();
  const service = await startAutomationService({
    config: CONFIG,
    runtime: runtimeHandles(),
    businessIngress: ingress,
    createRoot: rootFactory(() => false),
    signals: null,
    logger: SILENT,
  });
  await Promise.all([service.close(), service.close(), service.close()]);
  assert.equal(ingress.stops, 1);
});
