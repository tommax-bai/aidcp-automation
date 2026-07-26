import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';

import {
  AUTOMATION_API_CLIENT_GROUPS,
  AUTOMATION_COMMAND_RECEIVER_GROUPS,
  AUTOMATION_ROOT_READINESS_BLOCKERS,
  AUTOMATION_ROOT_SURFACE,
  AutomationRootNotReadyError,
  createAutomationCompositionRoot,
  readAutomationRootConfig,
  runAutomationEntry,
  type AutomationRootConfig,
  type AutomationRuntimeHandles,
} from '../../src/automation-composition-root.js';
import { AutomationOffboardAdmissionReconciler } from '../../src/interactions/offboard-admission-reconciler.js';
import { EdgeResumeCommandHttpClient } from '../../src/transport/paired-command-http.js';
import { InternalHttpClient } from '../../src/transport/internal-http.js';
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

test('derived census separates the 20/55 transport package from the 19/54 automation root', async () => {
  const census = deriveAutomationRootCensus();
  assert.deepEqual(census, {
    ...AUTOMATION_ROOT_SURFACE,
    excludedTransportGroups: ['personaGenerator'],
  });
  const blockers = await deriveIndependentRootBlockers();
  assert.equal(blockers.length, 20);
  assert.deepEqual(
    Object.fromEntries(
      ['4b-mirror', 'operator-command', 'content-owner', 'composition-root'].map((category) => [
        category,
        blockers.filter((blocker) => blocker.category === category).length,
      ]),
    ),
    {
      '4b-mirror': 8,
      'operator-command': 4,
      'content-owner': 7,
      'composition-root': 1,
    },
  );
});
