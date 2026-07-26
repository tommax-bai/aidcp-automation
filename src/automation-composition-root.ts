import { pathToFileURL } from 'node:url';
import pg from 'pg';

import type { DeploymentTarget } from 'aidcp-kernel/deployment-target.js';
import { parseDeploymentTarget } from 'aidcp-kernel/deployment-target.js';
import { resolveOwnerPgConfig } from 'aidcp-kernel/kernel/pg-owner-connection-resolver.js';

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
import { InternalHttpClient, InternalHttpServer } from './transport/internal-http.js';
import {
  registerEdgeResumeCommandRoutes,
  registerFacebookScopeCommandRoutes,
  registerPublishUiUpdateCommandRoutes,
} from './transport/paired-command-http.js';

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
      id: '4b-b1-persona-binding-soul-mirror',
      category: '4b-mirror',
      owner: 'api',
      closingChange: 'split-cloud-api-composition-root-4b',
    },
    {
      id: '4b-b2-environment-gate-mirror',
      category: '4b-mirror',
      owner: 'api',
      closingChange: 'split-cloud-api-composition-root-4b',
    },
    {
      id: '4b-b3-config-freshness-runtime',
      category: '4b-mirror',
      owner: 'shared-kernel',
      closingChange: 'split-cloud-api-composition-root-4b',
    },
    {
      id: '4b-b4-account-identity-status-mirror',
      category: '4b-mirror',
      owner: 'api',
      closingChange: 'split-cloud-api-composition-root-4b',
    },
    {
      id: '4b-b5-content-schedule-mirror',
      category: '4b-mirror',
      owner: 'api',
      closingChange: 'split-cloud-api-composition-root-4b',
    },
    {
      id: '4b-b5-hot-lead-config-mirror',
      category: '4b-mirror',
      owner: 'api',
      closingChange: 'split-cloud-api-composition-root-4b',
    },
    {
      id: '4b-b5-facebook-comment-config-mirror',
      category: '4b-mirror',
      owner: 'api',
      closingChange: 'split-cloud-api-composition-root-4b',
    },
    {
      id: '4b-b5-facebook-join-config-mirror',
      category: '4b-mirror',
      owner: 'api',
      closingChange: 'split-cloud-api-composition-root-4b',
    },
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
  internalServer: InternalHttpServer;
  listen(port?: number): Promise<number>;
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
}): AutomationCompositionRoot {
  const ownsPool = !options.ownerPool;
  const ownerPool = options.ownerPool ?? new pg.Pool(resolveOwnerPgConfig('automation'));
  const apiClients = createAutomationApiClients(options.config);
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

  const offboardReconciler = new AutomationOffboardAdmissionReconciler({
    automationRead: new PgClientEnvAutomationRead({ pool: ownerPool }),
    materializationOps: new PgOffboardMaterializationOps({ pool: ownerPool }),
    admissionLedger: apiClients.offboardAdmissionLedger,
    workerId: options.config.offboardWorkerId,
  });

  return {
    ownerPool,
    apiClients,
    structuredDeliver: apiClients.structuredNotification,
    commandReceivers,
    offboardReconciler,
    internalServer,
    listen: (port = options.config.automationPort) => internalServer.listen(port),
    async close() {
      try {
        await internalServer.close();
      } finally {
        if (ownsPool) await ownerPool.end();
      }
    },
  };
}

/**
 * The executable entry is deliberately fail-closed until the derived ledger is
 * empty. The 4a composition factory above remains loadable and directly testable.
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
