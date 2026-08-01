// aidcp:test-owner=derived
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
  AUTOMATION_API_CLIENT_GROUPS,
  AUTOMATION_COMMAND_RECEIVER_GROUPS,
  AUTOMATION_CONTENT_CLIENT_GROUPS,
  AUTOMATION_ROOT_READINESS_BLOCKERS,
  AUTOMATION_ROOT_SURFACE,
  AUTOMATION_SYNC_READ_CONSUMER_STREAMS,
  AutomationRootNotReadyError,
  createAutomationCompositionRoot,
  readAutomationRootConfig,
  runAutomationEntry,
  type AutomationRootConfig,
  type AutomationRootSyncReadOverrides,
  type AutomationRuntimeHandles,
} from '../../src/automation-composition-root.js';
import { AutomationOffboardAdmissionReconciler } from '../../src/interactions/offboard-admission-reconciler.js';
import { EdgeResumeCommandHttpClient } from '../../src/transport/paired-command-http.js';
import { InternalHttpClient } from '../../src/transport/internal-http.js';
import { SyncReadSnapshotHttpClient } from '../../src/transport/sync-read-snapshot-http.js';
import {
  deriveAutomationRootCensus,
  deriveIndependentRootBlockers,
} from './helpers/composition-root-4a-census.js';

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
    edgeResume: {
      wsServer: {
        resumeEdgesForAccount: (accountId: string) => accountId === 'acct-a' ? 2 : 0,
      },
    },
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
      uiSnapshot: {
        pushPublishPreview: () => {},
        pushPublishState: () => {},
      },
    },
    syncReadSources: {
      sessionConfigGlobal: async () => ({
        cursor: '1',
        weekActiveMask: '1111111',
      }),
      edgePresence: () => ({
        edgeCount: 1,
        onlineEdgeCount: 1,
        accountEdges: [{ accountId: 'acct-a', edgeId: 'edge-a' }],
      }),
      publishInFlight: () => ({ recordIds: [] }),
      captchaAvailability: () => ({ state: 'disabled' }),
      configMirrorHealth: () => ({
        sourceService: 'automation',
        asOf: Date.now(),
        enabled: true,
        pollMs: 30_000,
        entries: [],
      }),
    },
  };
}

const SYNC_READ_PAYLOADS = {
  session_config_global: { weekActiveMask: '1111111' },
  edge_presence: {
    edgeCount: 1,
    onlineEdgeCount: 1,
    accountEdges: [{ accountId: 'acct-a', edgeId: 'edge-a' }],
  },
  publish_in_flight: { recordIds: [101] },
  captcha_availability: { state: 'available' },
  automation_config_mirror_health: {
    sourceService: 'automation',
    asOf: 1_000,
    enabled: true,
    pollMs: 30_000,
    entries: [],
  },
  account_persona: {
    accounts: [{ accountId: 'acct-a', personaText: 'persona-a', soul: null }],
  },
  client_environment_automation: {
    blockedEnvironmentKeys: [],
    slowStartAnchors: [
      // `slowStartCompletedAt` 由上游 kernel 契约新增（另一路 change 的慢启动改动）。
      // 本文件是 `aidcp:test-owner=derived` 的**永久手写分叉**，中控侧改了什么都到不了它——
      // 这次是类型碰巧接住了，**不是**有什么机制提醒过（§4.7）。
      { accountId: 'acct-a', slowStartSince: null, slowStartCompletedAt: null, ambiguous: false },
    ],
  },
  automation_account_projection: {
    accounts: [
      {
        accountId: 'acct-a',
        platform: 'facebook',
        groupLabel: null,
        createdAt: 900,
        status: 'active',
      },
    ],
  },
  content_schedule: { global: null, accounts: [] },
  hot_lead_config: {
    maxAgeHours: 24,
    velocityMin: 3,
    minLikeFloor: 5,
    floorHours: 2,
  },
  facebook_comment_config: { accounts: [] },
  facebook_group_join_automation_config: { accounts: [] },
  // 批 E-2 步骤 2 新增流。空表 = 这台机器没有已配浏览面的 Facebook 环境，
  // 消费方据此报具名 blocker（而不是给个默认面）。
  facebook_operation_policy: { environments: [] },
} as const satisfies {
  [S in SyncReadStream]: SyncReadPayloadByStream[S];
};

function syncReadEnvelope<S extends SyncReadStream>(
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

function personaCheckpoint(): SyncReadConsumerCheckpoint {
  return {
    executionTarget: 'dev',
    consumer: 'automation',
    stream: 'account_persona',
    appliedCursor: '1',
    payloadDigest: syncReadPayloadDigest(SYNC_READ_PAYLOADS.account_persona),
    sourceAsOf: 900,
    lastObservedAt: 900,
    freshUntil: 60_900,
    lastAppliedAt: 900,
    state: 'ready',
    lastError: null,
  };
}

test('automation package and executable entry modules load without API/content owner modules', async () => {
  const [packageModule, serverModule] = await Promise.all([
    import('../../src/index.js'),
    import('../../src/server.js'),
  ]);
  assert.equal(typeof packageModule.createAutomationCompositionRoot, 'function');
  assert.equal(typeof serverModule.runAutomationEntry, 'function');
});

test('entry checks service mode before dependent configuration and never fakes independent boot', async () => {
  assert.throws(
    () => readAutomationRootConfig({ AIDCP_SERVICE: 'api' }),
    /requires AIDCP_SERVICE=automation/,
  );
  const env = {
    AIDCP_SERVICE: 'automation',
    AIDCP_DEPLOY_ENV: 'dev',
    AIDCP_API_URL: 'http://127.0.0.1:8092',
    AIDCP_API_INTERNAL_TOKEN: 'api-token',
    AIDCP_AUTOMATION_INTERNAL_TOKEN: 'automation-token',
    AIDCP_CONTENT_URL: 'http://127.0.0.1:8090',
    AIDCP_CONTENT_INTERNAL_TOKEN: 'content-token',
  };
  // task 2.4: the content egress is required, not optional. An unset AIDCP_CONTENT_URL means the
  // concept pool and the curated corpus are unreachable; booting anyway would surface that as
  // "no material" at every call site instead of as a missing configuration.
  const { AIDCP_CONTENT_URL: _omitted, ...withoutContentUrl } = env;
  assert.throws(() => readAutomationRootConfig(withoutContentUrl), /AIDCP_CONTENT_URL is required/);
  await assert.rejects(
    runAutomationEntry(env),
    (error: unknown) =>
      error instanceof AutomationRootNotReadyError
      && error.blockers.length === AUTOMATION_ROOT_READINESS_BLOCKERS.length,
  );
});

test('minimal root constructs exactly 16 API clients and three automation receivers', () => {
  const ownerPool = {} as pg.Pool;
  const root = createAutomationCompositionRoot({
    config: CONFIG,
    runtime: runtimeHandles(),
    ownerPool,
  });
  assert.equal(root.ownerPool, ownerPool);
  assert.deepEqual(Object.keys(root.apiClients), [...AUTOMATION_API_CLIENT_GROUPS]);
  assert.deepEqual(Object.keys(root.contentClients), [...AUTOMATION_CONTENT_CLIENT_GROUPS]);
  assert.deepEqual(Object.keys(root.commandReceivers), [...AUTOMATION_COMMAND_RECEIVER_GROUPS]);
  assert.equal(root.structuredDeliver, root.apiClients.structuredNotification);
  assert.ok(root.offboardReconciler instanceof AutomationOffboardAdmissionReconciler);
  assert.deepEqual(root.syncRead.signalRelay.stats().topics, [
    SYNC_READ_CHANGED_TOPIC,
  ]);
  assert.equal(root.syncRead.signalRelay.stats().running, false);
});

test('minimal root exposes a real target-bound Edge resume loopback route', async () => {
  const root = createAutomationCompositionRoot({
    config: CONFIG,
    runtime: runtimeHandles(),
    ownerPool: {} as pg.Pool,
  });
  const port = await root.listen(0);
  try {
    const client = new EdgeResumeCommandHttpClient(
      new InternalHttpClient(`http://127.0.0.1:${port}`),
      CONFIG.automationInternalToken,
      CONFIG.executionTarget,
    );
    assert.deepEqual(
      await client.resumeEdgesForAccount({
        commandId: 'resume-command-a',
        accountId: 'acct-a',
      }),
      {
        outcome: 'applied',
        commandId: 'resume-command-a',
        accountId: 'acct-a',
        resumedEdges: 2,
      },
    );
  } finally {
    await root.close();
  }
});

test('4b automation start listens before bidirectional bootstrap and reaches ready from owner-local ports', async () => {
  const ownerPublished: SyncReadStream[] = [];
  const ownerSnapshots: SyncReadStream[] = [];
  const consumerFetches: SyncReadStream[] = [];
  const savedCheckpoints: SyncReadConsumerCheckpoint[] = [];
  const projectionApplies: SyncReadSnapshotEnvelope[] = [];
  const scheduled: number[] = [];
  let projectionStopped = false;
  let clearedTimer = false;
  let relayStarted = false;
  let relayStopped = false;
  let root:
    | ReturnType<typeof createAutomationCompositionRoot>
    | undefined;

  const ownerSnapshotSource: NonNullable<
    AutomationRootSyncReadOverrides['ownerSnapshotSource']
  > = {
    async snapshot<S extends SyncReadStream>(
      stream: S,
      observedAt = 1_000,
    ): Promise<SyncReadSnapshotEnvelope<SyncReadPayloadByStream[S]>> {
      assert.ok(root?.internalServer.address(), 'listener must exist before owner bootstrap');
      ownerSnapshots.push(stream);
      return syncReadEnvelope(stream, observedAt);
    },
    async publishChanged(stream, observedAt = 1_000) {
      assert.ok(root?.internalServer.address(), 'listener must exist before owner publish');
      ownerPublished.push(stream);
      return syncReadEnvelope(stream, observedAt);
    },
  };
  const fakeTimer = {} as ReturnType<typeof setTimeout>;
  root = createAutomationCompositionRoot({
    config: CONFIG,
    runtime: runtimeHandles(),
    ownerPool: {} as pg.Pool,
    syncRead: {
      clock: () => 1_000,
      ownerSnapshotSource,
      fetchOwnerSnapshot: async (stream) => {
        assert.ok(root?.internalServer.address(), 'listener must exist before consumer first load');
        consumerFetches.push(stream);
        return syncReadEnvelope(stream);
      },
      checkpointStore: {
        load: async (stream) =>
          stream === 'account_persona'
            ? { outcome: 'loaded', checkpoint: personaCheckpoint() }
            : { outcome: 'not_found', checkpoint: null },
        save: async (input) => {
          const checkpoint = input as SyncReadConsumerCheckpoint;
          savedCheckpoints.push(checkpoint);
          return { outcome: 'stored', checkpoint };
        },
      },
      accountProjectionStore: {
        init: async () => undefined,
        applyOwnerSnapshot: async (input) => {
          const envelope = input as SyncReadSnapshotEnvelope;
          projectionApplies.push(envelope);
          return {
            outcome: 'applied',
            cursor: envelope.cursor,
            payloadDigest: syncReadPayloadDigest(envelope.value),
          };
        },
        stop: () => {
          projectionStopped = true;
        },
      },
      signalRelay: {
        start: () => {
          relayStarted = true;
        },
        stop: () => {
          relayStopped = true;
        },
        stats: () => ({
          running: relayStarted,
          topics: [SYNC_READ_CHANGED_TOPIC],
          lastError: null,
          blocked: [],
        }),
      },
      setTimer: (_fn, ms) => {
        scheduled.push(ms);
        return fakeTimer;
      },
      clearTimer: (handle) => {
        assert.equal(handle, fakeTimer);
        clearedTimer = true;
      },
      logger: { warn: () => undefined },
    },
  });

  const port = await root.start(0);
  assert.ok(port > 0);
  assert.deepEqual(ownerPublished.sort(), [
    'automation_config_mirror_health',
    'captcha_availability',
    'edge_presence',
    'publish_in_flight',
  ]);
  assert.deepEqual(ownerSnapshots, ['session_config_global']);
  assert.deepEqual(
    consumerFetches.sort(),
    [...AUTOMATION_SYNC_READ_CONSUMER_STREAMS].sort(),
  );
  assert.equal(projectionApplies.length, 1);
  assert.equal(projectionApplies[0]?.stream, 'automation_account_projection');
  // 由消费流清单**算出来**、不写死：上面那条 deepEqual 已经把真实集合钉住了，
  // 这里再写一个手打数字只会在每次新增流时红一次、且红在一个看不出所以然的地方。
  // （projection 那条自持事务、不走这个存盘口，故减一。）
  assert.equal(
    savedCheckpoints.length,
    AUTOMATION_SYNC_READ_CONSUMER_STREAMS.length - 1,
  );
  assert.ok(
    savedCheckpoints.every(
      (checkpoint) => checkpoint.stream !== 'automation_account_projection',
    ),
    'B4 owns its projection/checkpoint transaction and is not double-saved',
  );
  assert.equal(root.syncRead.readiness().state, 'ready');
  assert.equal(root.syncRead.signalRelay.stats().running, true);
  assert.deepEqual(root.syncRead.mirrors.personaFor('acct-a'), {
    state: 'fresh',
    value: { binding: 'bound', personaText: 'persona-a', soul: null },
    asOf: 1_000,
  });
  assert.deepEqual(scheduled, [30_000]);

  const snapshotClient = new SyncReadSnapshotHttpClient(
    new InternalHttpClient(`http://127.0.0.1:${port}`),
    {
      executionTarget: 'dev',
      bearerToken: CONFIG.automationInternalToken,
    },
  );
  const presence = await snapshotClient.fetch('edge_presence');
  assert.equal(presence.stream, 'edge_presence');
  assert.equal(presence.cursor, '1');

  await root.close();
  assert.equal(projectionStopped, true);
  assert.equal(clearedTimer, true);
  assert.equal(relayStopped, true);
});

test('4b first-load failure stays named and a later full snapshot heals readiness', async () => {
  let failContentSchedule = true;
  const ownerSnapshotSource: NonNullable<
    AutomationRootSyncReadOverrides['ownerSnapshotSource']
  > = {
    snapshot: async <S extends SyncReadStream>(
      stream: S,
      observedAt = 1_000,
    ): Promise<SyncReadSnapshotEnvelope<SyncReadPayloadByStream[S]>> =>
      syncReadEnvelope(stream, observedAt),
    publishChanged: async (stream, observedAt = 1_000) =>
      syncReadEnvelope(stream, observedAt),
  };
  const root = createAutomationCompositionRoot({
    config: CONFIG,
    runtime: runtimeHandles(),
    ownerPool: {} as pg.Pool,
    syncRead: {
      clock: () => 1_000,
      ownerSnapshotSource,
      fetchOwnerSnapshot: async (stream) => {
        if (stream === 'content_schedule' && failContentSchedule) {
          throw new Error('api_snapshot_unavailable');
        }
        return syncReadEnvelope(stream);
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
          const envelope = input as SyncReadSnapshotEnvelope;
          return {
            outcome: 'applied',
            cursor: envelope.cursor,
            payloadDigest: syncReadPayloadDigest(envelope.value),
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

  await root.start(0);
  const blocked = root.syncRead.readiness();
  assert.equal(blocked.state, 'not_ready');
  if (blocked.state === 'not_ready') {
    assert.deepEqual(
      blocked.blockers.map((blocker) => [
        blocker.stream,
        blocker.role,
        blocker.state,
        blocker.message,
      ]),
      [
        [
          'content_schedule',
          'consumer',
          'recovering',
          'api_snapshot_unavailable',
        ],
      ],
    );
  }

  failContentSchedule = false;
  await root.syncRead.refresh();
  assert.equal(root.syncRead.readiness().state, 'ready');
  await root.close();
});

test('derived census separates the 20/55 transport package from the 19/54 automation root', async () => {
  const census = deriveAutomationRootCensus();
  assert.deepEqual(census, {
    ...AUTOMATION_ROOT_SURFACE,
    excludedTransportGroups: ['personaGenerator'],
  });
  const blockers = await deriveIndependentRootBlockers();
  // 0.3d: content-owner went 7 -> 10 when the text-card OCR sub-chain, the interaction
  // reply generator and the draft rejection-evidence predicate were recorded. They were
  // always real debts of this root; they had simply never been written down.
  // 0.3f: 10 -> 9. Draft refinement came back off: the Cloud monolith runs that worker
  // only behind `seamMode !== 'automation'` inside segC, so no independently-booted
  // process executes it and it was never this root's debt. It stays in the Cloud
  // monolith ledger on its segA store and segD reader — that ledger answers a different
  // question.
  // 1.7b (user adjudicated 2026-07-30): 14 -> 13, operator-command 4 -> 3.
  // `feishu-operator-publish-comment` retired by argument, not by wiring: its Cloud-side probes
  // aimed at the `mode === 'api'` arms of the command face's publish:/comment: closures, and those
  // closures are unreachable (CommandRouter calls them only when `actions.delegate` is falsy, while
  // `CommandFaceDeps.delegate` is NonNullable and the composition root always injects a function;
  // the panel action surface has no publish/comment at all). In api mode both capabilities fail
  // through the delegate channel, which `feishu-operator-natural-language-delegate` already tracks
  // — the entry counted one gap twice. The kernel contracts stay on purpose.
  // **These counts only ever go DOWN by adjudication.** A drop with no matching note above means a
  // probe stopped matching — a regression, not progress.
  // 2.9：13 -> 12，content-owner 9 -> 8。`content-publish-rejection-evidence-authority`
  // 撤条的理由是**记错了属主**、不是解决了：那个判定 `hasUserRejectionEvidence` 住在
  // kernel（且已随 aidcp-kernel pin 存在于本包里），是一行纯字段读；数据来自 **api** 属主的
  // publishLog 4a 端口，而本根**已经**构造着它的客户端；那个字段的唯一写入方也属 api。
  // 全链没有 content。错因是那条 binding 的作者读到的 import 指向
  // `src/publish-agent/types.ts`——一个 kernel `git mv` 之后留下的六行再导出壳，而那次搬迁
  // **早于**这条 binding。
  // 2.4b：12 -> 11，content-owner 8 -> 7。`content-role-factories` 撤条，**而且它是本台账里
  // 第一条真靠接线消掉的**——上面两条一条是记错属主、一条是重复计数，这条不是。
  // 那张角色工厂表当初确实是 content 的地盘（四个角色类属 content，本包 import 不到，
  // 只能由组装根递一张工厂函数表进来）。task 0.7 把四个角色类 + 基类 + 精选闸改判 automation
  // （六个文件今天就在本包 src/ 里），task 2.4b 又把两跳窄化的锚点从 content 属主的存储类
  // 换成 kernel 的精选写口——那是那张表上最后一个 content 符号。剩下的是组装根的活，
  // 而每个仓的组装根本来就各写各的：**本根不再需要任何 content 属主的东西来建这张表。**
  // 没跟着撤的：那些角色仍然写 content 属主的精选库（`content-curated-write-authority`），
  // 正文评估角色仍接一个 content 属主的转写器句柄（`content-textcard-transcription-authority`），
  // 两条都还在下面。这条撤的是**第三次数**同样那两个依赖。
  // **这些计数只许因裁定而下降。** 下降但上面没有配套裁定说明 = 某个探针不再命中 = 回归。
  assert.equal(blockers.length, 11);
  assert.deepEqual(
    Object.fromEntries(
      ['4b-mirror', 'operator-command', 'content-owner', 'composition-root'].map((category) => [
        category,
        blockers.filter((blocker) => blocker.category === category).length,
      ]),
    ),
    {
      '4b-mirror': 0,
      'operator-command': 3,
      'content-owner': 7,
      'composition-root': 1,
    },
  );
  assert.ok(
    blockers.every((blocker) => blocker.closingChange === 'future'),
    'only future operator/content/production-runtime blockers remain after 4b root wiring',
  );
});
