import { pathToFileURL } from 'node:url';
import pg from 'pg';

import type { DeploymentTarget } from 'aidcp-kernel/deployment-target.js';
import { parseDeploymentTarget } from 'aidcp-kernel/deployment-target.js';
import { resolveOwnerPgConfig } from 'aidcp-kernel/kernel/pg-owner-connection-resolver.js';
import {
  isSyncReadFactPayload,
  type SyncReadPayloadByStream,
} from 'aidcp-kernel/kernel/sync-read-facts.js';
import type {
  SyncReadApplyResult,
  SyncReadConsumerCheckpoint,
  SyncReadSnapshotEnvelope,
  SyncReadStream,
} from 'aidcp-kernel/kernel/sync-read-snapshot.js';
import {
  parseSyncReadSnapshotEnvelope,
  SYNC_READ_CHANGED_TOPIC,
  SYNC_READ_STREAM_DEFINITIONS,
} from 'aidcp-kernel/kernel/sync-read-snapshot.js';

import { FacebookScopeCommandReceiver } from './comment-agent/facebook-scope-command-receiver.js';
import type { FacebookScopeCommandReceiverDeps } from './comment-agent/facebook-scope-command-receiver.js';
import { EdgeResumeCommandReceiver } from './comm/edge-resume-command-receiver.js';
import type { EdgeResumeCommandReceiverDeps } from './comm/edge-resume-command-receiver.js';
import { PublishUiUpdateCommandReceiver } from './comm/publish-ui-update-command-receiver.js';
import type { PublishUiUpdateCommandReceiverDeps } from './comm/publish-ui-update-command-receiver.js';
import { AutomationOffboardAdmissionReconciler } from './interactions/offboard-admission-reconciler.js';
import { PgClientEnvAutomationRead } from './interactions/client-env-automation-read.js';
import { PgOffboardMaterializationOps } from './interactions/offboard-write-adapter.js';
import {
  AccountOwnershipHttpClient,
  AccountRosterHttpClient,
  AccountRuntimeHttpClient,
} from './transport/api-account-authority-http.js';
import {
  AccountPersonaHttpClient,
  AutomationConfigCommandsHttpClient,
  CommentApprovalPolicyHttpClient,
  EnvironmentHandshakeHttpClient,
  FirstPostProgressHttpClient,
  NotificationContactsHttpClient,
  OffboardAdmissionLedgerHttpClient,
  StructuredNotificationHttpClient,
} from './transport/api-aux-authority-http.js';
import {
  AutomationPublishLogHttpClient,
  EdgePublishCommandHttpClient,
  InteractionApiWritesHttpClient,
  InteractionAuthHttpClient,
  ReplyConfigResolverHttpClient,
} from './transport/api-publish-interaction-http.js';
import { PgAccountProjectionStore } from './transport/account-projection-store.js';
import { createAutomationSyncReadConsumerCheckpointStore } from './transport/automation-sync-read-checkpoint-store.js';
import { PgAutomationSyncReadGenerationStore } from './transport/automation-sync-read-generation-store.js';
import { AutomationSyncReadMirrors } from './transport/automation-sync-read-mirrors.js';
import {
  AutomationSyncReadSnapshotSource,
  type AutomationRuntimeSyncReadStream,
  type AutomationSyncReadRuntimeSources,
} from './transport/automation-sync-read-source.js';
import { OutboxConsumer } from './transport/event-outbox.js';
import { InternalHttpClient, InternalHttpServer } from './transport/internal-http.js';
import {
  registerEdgeResumeCommandRoutes,
  registerFacebookScopeCommandRoutes,
  registerPublishUiUpdateCommandRoutes,
} from './transport/paired-command-http.js';
import {
  createSyncReadChangedHttpRelay,
  SyncReadChangedOutbox,
} from './transport/sync-read-changed-outbox.js';
import { SyncReadChangedHttpClient } from './transport/sync-read-changed-http.js';
import {
  registerSyncReadSnapshotRoute,
  SyncReadSnapshotHttpClient,
} from './transport/sync-read-snapshot-http.js';

export const AUTOMATION_API_CLIENT_GROUPS = [
  'accountRoster',
  'accountOwnership',
  'accountRuntime',
  'automationPublishLog',
  'edgePublish',
  'interactionAuth',
  'interactionApiWrites',
  'replyConfig',
  'accountPersona',
  'environmentHandshake',
  'commentApprovalPolicy',
  'notificationContacts',
  'firstPostProgress',
  'automationConfigCommands',
  'offboardAdmissionLedger',
  'structuredNotification',
] as const;

export const AUTOMATION_COMMAND_RECEIVER_GROUPS = [
  'edgeResume',
  'facebookScope',
  'publishUiUpdate',
] as const;

export const AUTOMATION_ROOT_SURFACE = {
  apiClientGroups: 16,
  apiClientMethodSlots: 50,
  commandReceiverGroups: 3,
  commandReceiverMethodSlots: 4,
  totalGroups: 19,
  totalMethodSlots: 54,
} as const;

export type AutomationRootBlockerCategory =
  | '4b-mirror'
  | 'operator-command'
  | 'content-owner'
  | 'composition-root';

export interface AutomationRootReadinessBlocker {
  id: string;
  category: AutomationRootBlockerCategory;
  owner: 'api' | 'automation' | 'content' | 'shared-kernel';
  closingChange: 'split-cloud-api-composition-root-4b' | 'future';
}

/**
 * This is the automation-derived root ledger, not the Cloud monolith ledger.
 * It includes only dependencies that prevent this package from supplying the
 * complete production automation process.
 */
export const AUTOMATION_ROOT_READINESS_BLOCKERS =
  [
    {
      id: 'feishu-operator-natural-language-delegate',
      category: 'operator-command',
      owner: 'automation',
      closingChange: 'future',
    },
    {
      id: 'feishu-operator-publish-comment',
      category: 'operator-command',
      owner: 'automation',
      closingChange: 'future',
    },
    {
      id: 'feishu-operator-delegated-card-actions',
      category: 'operator-command',
      owner: 'automation',
      closingChange: 'future',
    },
    {
      id: 'feishu-operator-dispatch-start-stop',
      category: 'operator-command',
      owner: 'automation',
      closingChange: 'future',
    },
    {
      id: 'content-draft-refinement-authority',
      category: 'content-owner',
      owner: 'content',
      closingChange: 'future',
    },
    {
      id: 'content-facebook-publish-media-authority',
      category: 'content-owner',
      owner: 'content',
      closingChange: 'future',
    },
    {
      id: 'content-concept-write-authority',
      category: 'content-owner',
      owner: 'content',
      closingChange: 'future',
    },
    {
      id: 'content-curated-write-authority',
      category: 'content-owner',
      owner: 'content',
      closingChange: 'future',
    },
    {
      id: 'content-role-factories',
      category: 'content-owner',
      owner: 'content',
      closingChange: 'future',
    },
    {
      id: 'content-generic-llm-authority',
      category: 'content-owner',
      owner: 'content',
      closingChange: 'future',
    },
    {
      id: 'content-token-usage-authority',
      category: 'content-owner',
      owner: 'content',
      closingChange: 'future',
    },
    {
      id: 'automation-production-runtime-composition-unwired',
      category: 'composition-root',
      owner: 'automation',
      closingChange: 'future',
    },
  ] as const satisfies readonly AutomationRootReadinessBlocker[];

export interface AutomationRootConfig {
  executionTarget: DeploymentTarget;
  apiBaseUrl: string;
  apiInternalToken: string;
  automationInternalToken: string;
  automationPort: number;
  offboardWorkerId: string;
}

export interface AutomationRuntimeHandles {
  edgeResume: EdgeResumeCommandReceiverDeps;
  facebookScope: FacebookScopeCommandReceiverDeps;
  publishUiUpdate: PublishUiUpdateCommandReceiverDeps;
  syncReadSources: AutomationSyncReadRuntimeSources;
}

export interface AutomationApiClients {
  accountRoster: AccountRosterHttpClient;
  accountOwnership: AccountOwnershipHttpClient;
  accountRuntime: AccountRuntimeHttpClient;
  automationPublishLog: AutomationPublishLogHttpClient;
  edgePublish: EdgePublishCommandHttpClient;
  interactionAuth: InteractionAuthHttpClient;
  interactionApiWrites: InteractionApiWritesHttpClient;
  replyConfig: ReplyConfigResolverHttpClient;
  accountPersona: AccountPersonaHttpClient;
  environmentHandshake: EnvironmentHandshakeHttpClient;
  commentApprovalPolicy: CommentApprovalPolicyHttpClient;
  notificationContacts: NotificationContactsHttpClient;
  firstPostProgress: FirstPostProgressHttpClient;
  automationConfigCommands: AutomationConfigCommandsHttpClient;
  offboardAdmissionLedger: OffboardAdmissionLedgerHttpClient;
  structuredNotification: StructuredNotificationHttpClient;
}

export const AUTOMATION_SYNC_READ_CONSUMER_STREAMS = [
  'account_persona',
  'client_environment_automation',
  'automation_account_projection',
  'content_schedule',
  'hot_lead_config',
  'facebook_comment_config',
  'facebook_group_join_automation_config',
] as const;

export type AutomationSyncReadConsumerStream =
  (typeof AUTOMATION_SYNC_READ_CONSUMER_STREAMS)[number];

export const AUTOMATION_SYNC_READ_OWNER_STREAMS = [
  'session_config_global',
  'edge_presence',
  'publish_in_flight',
  'captcha_availability',
  'automation_config_mirror_health',
] as const;

export type AutomationSyncReadOwnerStream =
  (typeof AUTOMATION_SYNC_READ_OWNER_STREAMS)[number];

export const AUTOMATION_SYNC_READ_SIGNAL_RELAY_CONSUMER =
  'api-sync-read-changed-relay';

const AUTOMATION_SYNC_READ_REFRESH_MS = 30_000;

type AutomationConsumerMirror =
  | AutomationSyncReadMirrors['persona']
  | AutomationSyncReadMirrors['environment']
  | AutomationSyncReadMirrors['accounts']
  | AutomationSyncReadMirrors['contentSchedule']
  | AutomationSyncReadMirrors['hotLead']
  | AutomationSyncReadMirrors['facebookComment']
  | AutomationSyncReadMirrors['facebookGroupJoin'];

interface AutomationCheckpointStorePort {
  load(stream: SyncReadStream): Promise<
    | { outcome: 'loaded'; checkpoint: SyncReadConsumerCheckpoint }
    | { outcome: 'not_found'; checkpoint: null }
    | {
        outcome: 'unknown';
        checkpoint: null;
        reason: 'checkpoint_invalid';
        message: string;
      }
  >;
  save(input: unknown): Promise<
    | { outcome: 'stored'; checkpoint: SyncReadConsumerCheckpoint }
    | {
        outcome: 'rejected';
        reason:
          | 'checkpoint_invalid'
          | 'old_cursor'
          | 'historical_checkpoint'
          | 'same_cursor_payload_drift';
        currentCursor: string | null;
        message: string;
      }
  >;
}

interface AutomationAccountProjectionPort {
  init(): Promise<void>;
  applyOwnerSnapshot(
    input: unknown,
    observedAt?: number,
  ): Promise<SyncReadApplyResult>;
  stop(): void;
}

interface AutomationOwnerSnapshotSourcePort {
  snapshot<S extends SyncReadStream>(
    stream: S,
    observedAt?: number,
  ): Promise<SyncReadSnapshotEnvelope<SyncReadPayloadByStream[S]>>;
  publishChanged(
    stream: AutomationRuntimeSyncReadStream,
    observedAt?: number,
  ): Promise<SyncReadSnapshotEnvelope>;
}

export interface AutomationSyncReadSignalRelayPort {
  start(): void;
  stop(): void;
  stats(): {
    running: boolean;
    topics: string[];
    lastError: string | null;
    blocked: ReadonlyArray<{
      topic: string;
      eventId: number;
      attempts: number;
      lastError: string;
    }>;
  };
}

export interface AutomationRootSyncReadOverrides {
  mirrors?: AutomationSyncReadMirrors;
  checkpointStore?: AutomationCheckpointStorePort;
  accountProjectionStore?: AutomationAccountProjectionPort;
  ownerSnapshotSource?: AutomationOwnerSnapshotSourcePort;
  signalRelay?: AutomationSyncReadSignalRelayPort;
  fetchOwnerSnapshot?: (
    stream: AutomationSyncReadConsumerStream,
  ) => Promise<SyncReadSnapshotEnvelope>;
  clock?: () => number;
  setTimer?: (
    fn: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  logger?: Pick<Console, 'warn'>;
}

export interface AutomationSyncReadReadinessBlocker {
  stream: AutomationSyncReadConsumerStream | AutomationSyncReadOwnerStream;
  role: 'consumer' | 'owner-publisher';
  state: 'uninitialized' | 'stale' | 'invalid' | 'recovering';
  message: string | null;
}

export type AutomationSyncReadReadiness =
  | {
      state: 'ready';
      checkedAt: number;
      blockers: readonly [];
    }
  | {
      state: 'not_ready';
      checkedAt: number;
      blockers: readonly AutomationSyncReadReadinessBlocker[];
    };

export interface AutomationRootSyncReadHandles {
  mirrors: AutomationSyncReadMirrors;
  ownerSnapshotSource: AutomationOwnerSnapshotSourcePort;
  accountProjectionStore: AutomationAccountProjectionPort;
  signalRelay: AutomationSyncReadSignalRelayPort;
  refresh(): Promise<void>;
  publishChanged(
    stream: AutomationRuntimeSyncReadStream,
  ): Promise<SyncReadSnapshotEnvelope>;
  readiness(now?: number): AutomationSyncReadReadiness;
}

export interface AutomationCompositionRoot {
  ownerPool: pg.Pool;
  apiClients: AutomationApiClients;
  structuredDeliver: StructuredNotificationHttpClient;
  commandReceivers: {
    edgeResume: EdgeResumeCommandReceiver;
    facebookScope: FacebookScopeCommandReceiver;
    publishUiUpdate: PublishUiUpdateCommandReceiver;
  };
  offboardReconciler: AutomationOffboardAdmissionReconciler;
  syncRead: AutomationRootSyncReadHandles;
  internalServer: InternalHttpServer;
  listen(port?: number): Promise<number>;
  start(port?: number): Promise<number>;
  close(): Promise<void>;
}

export class AutomationRootNotReadyError extends Error {
  readonly code = 'automation_independent_root_not_ready';

  constructor(readonly blockers: readonly AutomationRootReadinessBlocker[]) {
    super(
      `automation independent root remains blocked: ${blockers
        .map((blocker) => blocker.id)
        .join(', ')}`,
    );
    this.name = 'AutomationRootNotReadyError';
  }
}

function requiredEnv(
  env: NodeJS.ProcessEnv,
  name: 'AIDCP_API_URL' | 'AIDCP_API_INTERNAL_TOKEN' | 'AIDCP_AUTOMATION_INTERNAL_TOKEN',
): string {
  const value = env[name]?.trim();
  if (!value || /\s/.test(value)) {
    throw new Error(`${name} is required and must not contain whitespace`);
  }
  return value;
}

function optionalPort(env: NodeJS.ProcessEnv): number {
  const raw = env.AIDCP_AUTOMATION_PORT?.trim();
  if (!raw) return 8093;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error('AIDCP_AUTOMATION_PORT must be an integer from 1 to 65535');
  }
  return value;
}

export function readAutomationRootConfig(
  env: NodeJS.ProcessEnv = process.env,
): AutomationRootConfig {
  if (env.AIDCP_SERVICE !== 'automation') {
    throw new Error('aidcp-automation requires AIDCP_SERVICE=automation');
  }
  const executionTarget = parseDeploymentTarget(env.AIDCP_DEPLOY_ENV);
  if (!executionTarget) {
    throw new Error('AIDCP_DEPLOY_ENV must be dev or ol');
  }
  return {
    executionTarget,
    apiBaseUrl: requiredEnv(env, 'AIDCP_API_URL'),
    apiInternalToken: requiredEnv(env, 'AIDCP_API_INTERNAL_TOKEN'),
    automationInternalToken: requiredEnv(env, 'AIDCP_AUTOMATION_INTERNAL_TOKEN'),
    automationPort: optionalPort(env),
    offboardWorkerId: `offboard-reconcile-${executionTarget}`,
  };
}

export function createAutomationApiClients(
  config: Pick<AutomationRootConfig, 'apiBaseUrl' | 'apiInternalToken' | 'executionTarget'>,
): AutomationApiClients {
  const http = new InternalHttpClient(config.apiBaseUrl);
  const args = [http, config.apiInternalToken, config.executionTarget] as const;
  return {
    accountRoster: new AccountRosterHttpClient(...args),
    accountOwnership: new AccountOwnershipHttpClient(...args),
    accountRuntime: new AccountRuntimeHttpClient(...args),
    automationPublishLog: new AutomationPublishLogHttpClient(...args),
    edgePublish: new EdgePublishCommandHttpClient(...args),
    interactionAuth: new InteractionAuthHttpClient(...args),
    interactionApiWrites: new InteractionApiWritesHttpClient(...args),
    replyConfig: new ReplyConfigResolverHttpClient(...args),
    accountPersona: new AccountPersonaHttpClient(...args),
    environmentHandshake: new EnvironmentHandshakeHttpClient(...args),
    commentApprovalPolicy: new CommentApprovalPolicyHttpClient(...args),
    notificationContacts: new NotificationContactsHttpClient(...args),
    firstPostProgress: new FirstPostProgressHttpClient(...args),
    automationConfigCommands: new AutomationConfigCommandsHttpClient(...args),
    offboardAdmissionLedger: new OffboardAdmissionLedgerHttpClient(...args),
    structuredNotification: new StructuredNotificationHttpClient(...args),
  };
}

export function createAutomationCompositionRoot(options: {
  config: AutomationRootConfig;
  runtime: AutomationRuntimeHandles;
  ownerPool?: pg.Pool;
  syncRead?: AutomationRootSyncReadOverrides;
}): AutomationCompositionRoot {
  const ownsPool = !options.ownerPool;
  const ownerPool = options.ownerPool ?? new pg.Pool(resolveOwnerPgConfig('automation'));
  const apiClients = createAutomationApiClients(options.config);
  const clock = options.syncRead?.clock ?? Date.now;
  const logger = options.syncRead?.logger ?? console;
  const setTimer =
    options.syncRead?.setTimer ??
    ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    options.syncRead?.clearTimer ??
    ((handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
  const mirrors =
    options.syncRead?.mirrors ??
    new AutomationSyncReadMirrors(options.config.executionTarget, clock);
  const checkpointStore =
    options.syncRead?.checkpointStore ??
    createAutomationSyncReadConsumerCheckpointStore(
      ownerPool,
      options.config.executionTarget,
    );
  const accountProjectionStore =
    options.syncRead?.accountProjectionStore ??
    new PgAccountProjectionStore({
      pool: ownerPool,
      source: {
        listAccountIdentities: async () => {
          throw new Error(
            'independent_automation_legacy_account_projection_refresh_disabled',
          );
        },
      },
      executionTarget: options.config.executionTarget,
      logger: {
        log: () => undefined,
        warn: (message) => logger.warn(message),
        error: (message) => logger.warn(message),
      },
    });
  const ownerSnapshotSource =
    options.syncRead?.ownerSnapshotSource ??
    new AutomationSyncReadSnapshotSource(
      options.config.executionTarget,
      options.runtime.syncReadSources,
      new PgAutomationSyncReadGenerationStore(
        options.config.executionTarget,
        ownerPool,
      ),
      new SyncReadChangedOutbox(
        options.config.executionTarget,
        ownerPool,
        logger,
      ),
    );
  const syncReadApiHttp = new InternalHttpClient(options.config.apiBaseUrl);
  const snapshotClient = new SyncReadSnapshotHttpClient(
    syncReadApiHttp,
    {
      executionTarget: options.config.executionTarget,
      bearerToken: options.config.apiInternalToken,
    },
  );
  const fetchOwnerSnapshot =
    options.syncRead?.fetchOwnerSnapshot ??
    ((stream: AutomationSyncReadConsumerStream) =>
      snapshotClient.fetch(
        stream,
        (value): value is SyncReadPayloadByStream[typeof stream] =>
          isSyncReadFactPayload(stream, value),
      ));
  const signalRelay =
    options.syncRead?.signalRelay ??
    new OutboxConsumer({
      consumer: AUTOMATION_SYNC_READ_SIGNAL_RELAY_CONSUMER,
      executionTarget: options.config.executionTarget,
      pool: ownerPool,
      handlers: new Map([
        [
          SYNC_READ_CHANGED_TOPIC,
          createSyncReadChangedHttpRelay({
            executionTarget: options.config.executionTarget,
            delivery: new SyncReadChangedHttpClient(syncReadApiHttp, {
              executionTarget: options.config.executionTarget,
              bearerToken: options.config.apiInternalToken,
            }),
          }),
        ],
      ]),
      logger: {
        log: () => undefined,
        warn: (message) => logger.warn(message),
      },
      setTimer,
      clearTimer,
      now: clock,
    });
  const commandReceivers = {
    edgeResume: new EdgeResumeCommandReceiver(options.runtime.edgeResume),
    facebookScope: new FacebookScopeCommandReceiver(options.runtime.facebookScope),
    publishUiUpdate: new PublishUiUpdateCommandReceiver(options.runtime.publishUiUpdate),
  };
  const internalServer = new InternalHttpServer();
  registerEdgeResumeCommandRoutes(
    internalServer,
    commandReceivers.edgeResume,
    options.config.automationInternalToken,
    options.config.executionTarget,
  );
  registerFacebookScopeCommandRoutes(
    internalServer,
    commandReceivers.facebookScope,
    options.config.automationInternalToken,
    options.config.executionTarget,
  );
  registerPublishUiUpdateCommandRoutes(
    internalServer,
    commandReceivers.publishUiUpdate,
    options.config.automationInternalToken,
    options.config.executionTarget,
  );
  registerSyncReadSnapshotRoute(
    internalServer,
    {
      snapshotFor: ({ stream, executionTarget }) => {
        if (executionTarget !== options.config.executionTarget) {
          throw new Error('automation_sync_read_snapshot_target_mismatch');
        }
        return ownerSnapshotSource.snapshot(stream, clock());
      },
    },
    {
      owner: 'automation',
      executionTarget: options.config.executionTarget,
      bearerToken: options.config.automationInternalToken,
      streams: AUTOMATION_SYNC_READ_OWNER_STREAMS,
    },
  );

  const offboardReconciler = new AutomationOffboardAdmissionReconciler({
    automationRead: new PgClientEnvAutomationRead({ pool: ownerPool }),
    materializationOps: new PgOffboardMaterializationOps({ pool: ownerPool }),
    admissionLedger: apiClients.offboardAdmissionLedger,
    workerId: options.config.offboardWorkerId,
  });

  const ownerReadiness = new Map<
    AutomationSyncReadOwnerStream,
    {
      state: 'uninitialized' | 'ready' | 'invalid';
      message: string | null;
    }
  >(
    AUTOMATION_SYNC_READ_OWNER_STREAMS.map((stream) => [
      stream,
      { state: 'uninitialized', message: null },
    ]),
  );
  let checkpointsRestored = false;
  let projectionInitialized = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshRunning: Promise<void> = Promise.resolve();
  let syncReadStarted = false;
  let closed = false;

  const setOwnerReadiness = (
    stream: AutomationSyncReadOwnerStream,
    state: 'ready' | 'invalid',
    message: string | null,
  ): void => {
    ownerReadiness.set(stream, { state, message });
  };

  const publishChanged = async (
    stream: AutomationRuntimeSyncReadStream,
  ): Promise<SyncReadSnapshotEnvelope> => {
    try {
      const envelope = validateSnapshotEnvelope(
        options.config.executionTarget,
        stream,
        await ownerSnapshotSource.publishChanged(stream, clock()),
      );
      setOwnerReadiness(stream, 'ready', null);
      return envelope;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setOwnerReadiness(stream, 'invalid', message);
      throw error;
    }
  };

  const ensureProjectionInitialized = async (): Promise<void> => {
    if (projectionInitialized) return;
    try {
      await accountProjectionStore.init();
      projectionInitialized = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      consumerMirror(mirrors, 'automation_account_projection').beginRecovery(
        message,
      );
      logger.warn(
        `[automation-sync-read] B4 projection init failed; readiness remains blocked: ${message}`,
      );
    }
  };

  const restoreCheckpoints = async (): Promise<void> => {
    if (checkpointsRestored) return;
    await Promise.all(
      AUTOMATION_SYNC_READ_CONSUMER_STREAMS.map(async (stream) => {
        const mirror = consumerMirror(mirrors, stream);
        try {
          const loaded = await checkpointStore.load(stream);
          if (loaded.outcome === 'loaded') {
            mirror.restoreCheckpoint(loaded.checkpoint);
          } else if (loaded.outcome === 'unknown') {
            mirror.beginRecovery(loaded.message);
          }
        } catch (error) {
          mirror.beginRecovery(
            error instanceof Error ? error.message : String(error),
          );
        }
      }),
    );
    checkpointsRestored = true;
  };

  const refreshOwnerStream = async (
    stream: AutomationSyncReadOwnerStream,
  ): Promise<void> => {
    try {
      if (stream === 'session_config_global') {
        validateSnapshotEnvelope(
          options.config.executionTarget,
          stream,
          await ownerSnapshotSource.snapshot(stream, clock()),
        );
        setOwnerReadiness(stream, 'ready', null);
        return;
      }
      await publishChanged(stream);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setOwnerReadiness(stream, 'invalid', message);
      logger.warn(
        `[automation-sync-read] owner observation failed stream=${stream}: ${message}`,
      );
    }
  };

  const refreshConsumerStream = async (
    stream: AutomationSyncReadConsumerStream,
  ): Promise<void> => {
    const mirror = consumerMirror(mirrors, stream);
    try {
      if (stream === 'automation_account_projection') {
        await ensureProjectionInitialized();
        if (!projectionInitialized) {
          throw new Error('automation_account_projection_not_initialized');
        }
      }
      const envelope = validateSnapshotEnvelope(
        options.config.executionTarget,
        stream,
        await fetchOwnerSnapshot(stream),
      );
      if (stream === 'automation_account_projection') {
        const projected = await accountProjectionStore.applyOwnerSnapshot(
          envelope,
          clock(),
        );
        assertSyncReadApplied(stream, projected);
      }
      const applied = mirrors.apply(envelope, 'owner_fetch');
      assertSyncReadApplied(stream, applied);
      if (mirror.view(clock()).state !== 'ready') {
        throw new Error(`sync_read_owner_fetch_did_not_make_ready:${stream}`);
      }
      if (stream !== 'automation_account_projection') {
        const stored = await checkpointStore.save(mirror.checkpoint(clock()));
        if (stored.outcome === 'rejected') {
          throw new Error(
            `sync_read_checkpoint_rejected:${stream}:${stored.reason}:${stored.message}`,
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      mirror.beginRecovery(message);
      logger.warn(
        `[automation-sync-read] consumer refresh failed stream=${stream}: ${message}`,
      );
    }
  };

  const refreshCycle = async (): Promise<void> => {
    await Promise.all([ensureProjectionInitialized(), restoreCheckpoints()]);
    await Promise.all([
      ...AUTOMATION_SYNC_READ_OWNER_STREAMS.map(refreshOwnerStream),
      ...AUTOMATION_SYNC_READ_CONSUMER_STREAMS.map(refreshConsumerStream),
    ]);
  };

  const refresh = (): Promise<void> => {
    const next = refreshRunning.then(refreshCycle, refreshCycle);
    refreshRunning = next.catch(() => undefined);
    return next;
  };

  const scheduleRefresh = (): void => {
    if (!syncReadStarted || closed || refreshTimer !== null) return;
    refreshTimer = setTimer(() => {
      refreshTimer = null;
      void refresh().finally(scheduleRefresh);
    }, AUTOMATION_SYNC_READ_REFRESH_MS);
  };

  const readiness = (now = clock()): AutomationSyncReadReadiness => {
    const mirrorReadiness = mirrors.readiness(now);
    const consumerBlockers: AutomationSyncReadReadinessBlocker[] =
      mirrorReadiness.state === 'not_ready'
        ? mirrorReadiness.blockers.map((blocker) => ({
            stream: blocker.stream as AutomationSyncReadConsumerStream,
            role: 'consumer',
            state: blocker.state,
            message: blocker.lastError,
          }))
        : [];
    const ownerBlockers = AUTOMATION_SYNC_READ_OWNER_STREAMS.flatMap(
      (stream): AutomationSyncReadReadinessBlocker[] => {
        const state = ownerReadiness.get(stream)!;
        return state.state === 'ready'
          ? []
          : [
              {
                stream,
                role: 'owner-publisher',
                state: state.state,
                message: state.message,
              },
            ];
      },
    );
    const blockers = [...consumerBlockers, ...ownerBlockers];
    return blockers.length === 0
      ? { state: 'ready', checkedAt: now, blockers: [] }
      : { state: 'not_ready', checkedAt: now, blockers };
  };

  const syncRead: AutomationRootSyncReadHandles = {
    mirrors,
    ownerSnapshotSource,
    accountProjectionStore,
    signalRelay,
    refresh,
    publishChanged,
    readiness,
  };

  return {
    ownerPool,
    apiClients,
    structuredDeliver: apiClients.structuredNotification,
    commandReceivers,
    offboardReconciler,
    syncRead,
    internalServer,
    listen: (port = options.config.automationPort) => internalServer.listen(port),
    async start(port = options.config.automationPort) {
      const listeningPort =
        internalServer.address()?.port ?? await internalServer.listen(port);
      await refresh();
      signalRelay.start();
      syncReadStarted = true;
      scheduleRefresh();
      return listeningPort;
    },
    async close() {
      closed = true;
      syncReadStarted = false;
      signalRelay.stop();
      if (refreshTimer !== null) {
        clearTimer(refreshTimer);
        refreshTimer = null;
      }
      accountProjectionStore.stop();
      await refreshRunning;
      try {
        await internalServer.close();
      } finally {
        if (ownsPool) await ownerPool.end();
      }
    },
  };
}

function consumerMirror(
  mirrors: AutomationSyncReadMirrors,
  stream: AutomationSyncReadConsumerStream,
): AutomationConsumerMirror {
  switch (stream) {
    case 'account_persona':
      return mirrors.persona;
    case 'client_environment_automation':
      return mirrors.environment;
    case 'automation_account_projection':
      return mirrors.accounts;
    case 'content_schedule':
      return mirrors.contentSchedule;
    case 'hot_lead_config':
      return mirrors.hotLead;
    case 'facebook_comment_config':
      return mirrors.facebookComment;
    case 'facebook_group_join_automation_config':
      return mirrors.facebookGroupJoin;
  }
}

function assertSyncReadApplied(
  stream: SyncReadStream,
  result: SyncReadApplyResult,
): asserts result is Exclude<SyncReadApplyResult, { outcome: 'rejected' }> {
  if (result.outcome === 'rejected') {
    throw new Error(
      `sync_read_apply_rejected:${stream}:${result.reason}:${result.message}`,
    );
  }
}

function validateSnapshotEnvelope<S extends SyncReadStream>(
  executionTarget: DeploymentTarget,
  stream: S,
  input: unknown,
): SyncReadSnapshotEnvelope<SyncReadPayloadByStream[S]> {
  return parseSyncReadSnapshotEnvelope(input, {
    executionTarget,
    stream,
    factScope: SYNC_READ_STREAM_DEFINITIONS[stream].factScope,
    validateValue: (value): value is SyncReadPayloadByStream[S] =>
      isSyncReadFactPayload(stream, value),
  });
}

/**
 * The executable entry is deliberately fail-closed until the derived ledger is
 * empty. The bounded 4a/4b composition factory above remains loadable and
 * directly testable without pretending the future production runtime is wired.
 */
export async function runAutomationEntry(
  env: NodeJS.ProcessEnv = process.env,
): Promise<never> {
  readAutomationRootConfig(env);
  throw new AutomationRootNotReadyError(AUTOMATION_ROOT_READINESS_BLOCKERS);
}

export function isDirectExecution(metaUrl: string, argv1 = process.argv[1]): boolean {
  return Boolean(argv1) && pathToFileURL(argv1).href === metaUrl;
}
