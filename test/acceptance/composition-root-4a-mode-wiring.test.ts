import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';

import {
  makeSyncReadFactEnvelope,
  type SyncReadPayloadByStream,
} from 'aidcp-kernel/kernel/sync-read-facts.js';
import {
  syncReadPayloadDigest,
  type SyncReadConsumerCheckpoint,
  type SyncReadSnapshotEnvelope,
  type SyncReadStream,
} from 'aidcp-kernel/kernel/sync-read-snapshot.js';
import {
  AUTOMATION_API_CLIENT_GROUPS,
  AUTOMATION_COMMAND_RECEIVER_GROUPS,
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
      { accountId: 'acct-a', slowStartSince: null, ambiguous: false },
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
  };
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
  assert.deepEqual(Object.keys(root.commandReceivers), [...AUTOMATION_COMMAND_RECEIVER_GROUPS]);
  assert.equal(root.structuredDeliver, root.apiClients.structuredNotification);
  assert.ok(root.offboardReconciler instanceof AutomationOffboardAdmissionReconciler);
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
  assert.equal(savedCheckpoints.length, 6);
  assert.ok(
    savedCheckpoints.every(
      (checkpoint) => checkpoint.stream !== 'automation_account_projection',
    ),
    'B4 owns its projection/checkpoint transaction and is not double-saved',
  );
  assert.equal(root.syncRead.readiness().state, 'ready');
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
  assert.equal(blockers.length, 12);
  assert.deepEqual(
    Object.fromEntries(
      ['4b-mirror', 'operator-command', 'content-owner', 'composition-root'].map((category) => [
        category,
        blockers.filter((blocker) => blocker.category === category).length,
      ]),
    ),
    {
      '4b-mirror': 0,
      'operator-command': 4,
      'content-owner': 7,
      'composition-root': 1,
    },
  );
  assert.ok(
    blockers.every((blocker) => blocker.closingChange === 'future'),
    'only future operator/content/production-runtime blockers remain after 4b root wiring',
  );
});
