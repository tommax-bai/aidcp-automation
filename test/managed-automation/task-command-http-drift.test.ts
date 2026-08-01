import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CreateManagedTaskInput,
  ManagedTaskEnvelope,
} from 'aidcp-kernel/kernel/managed-task-port.js';
import { MANAGED_TASK_CONTRACT } from 'aidcp-kernel/kernel/managed-task-port.js';
import {
  InternalHttpClient,
  InternalHttpError,
  InternalHttpServer,
} from 'aidcp-transport/transport/internal-http.js';
import {
  MANAGED_TASK_ROUTES,
  ManagedTaskHttpClient,
  registerManagedTaskRoutes,
} from 'aidcp-transport/transport/managed-task-http.js';
import type { TaskDefinition } from '../../src/managed-automation/contracts/capability.js';
import { PlanCompiler } from '../../src/managed-automation/engine/plan-compiler.js';
import {
  createPhaseOneRegistry,
  PERSONA_RESEARCH_CAPABILITY_IDS,
  PERSONA_RESEARCH_TASK_DEFINITION,
} from '../../src/managed-automation/registry/index.js';
import {
  createCommandPayloadHash,
  ManagedTaskCommandService,
  type ManagedTaskCommandServiceDeps,
} from '../../src/managed-automation/service/index.js';
import type { CreateTaskBundle } from '../../src/managed-automation/stores/command-store.js';

const TOKEN = 'managed-task-owner-drift-token';

const UNKNOWN_CAPABILITY_DEFINITION: TaskDefinition = {
  ...PERSONA_RESEARCH_TASK_DEFINITION,
  taskDefinitionId: 'persona.research.unknown-capability',
  nodes: PERSONA_RESEARCH_TASK_DEFINITION.nodes.map((node, index) => ({
    ...node,
    capabilityId: index === 0 ? 'research.unknown' : node.capabilityId,
  })),
  edges: PERSONA_RESEARCH_TASK_DEFINITION.edges.map((edge) => ({ ...edge })),
  bounds: { ...PERSONA_RESEARCH_TASK_DEFINITION.bounds },
};

function createInput(
  taskDefinition: CreateManagedTaskInput['taskDefinition'] = {
    id: 'persona.research',
    version: 1,
  },
): CreateManagedTaskInput {
  const input: CreateManagedTaskInput = {
    commandId: `create-${taskDefinition.id}-${taskDefinition.version}`,
    payloadHash: '',
    actor: {
      kind: 'operator',
      actorId: 'operator-1',
      customerId: 'customer-1',
      authorizationRevision: 'auth-1',
    },
    accountId: 'account-1',
    envKey: 'env-1',
    platform: 'facebook',
    taskDefinition,
    parameters: { keywords: ['automation'], maxItems: 3 },
    capabilityScope: { allow: [...PERSONA_RESEARCH_CAPABILITY_IDS], deny: [] },
    budget: {
      maxBrowserMinutes: 20,
      maxSteps: 4,
      maxExecutionAttempts: 3,
      maxWaitMs: 900_000,
    },
    schedule: { scheduledAt: 1_000, latestStartAt: 2_000, missPolicy: 'skip' },
  };
  input.payloadHash = createCommandPayloadHash(input);
  return input;
}

function envelope(input = createInput()): ManagedTaskEnvelope<CreateManagedTaskInput> {
  return {
    contract: MANAGED_TASK_CONTRACT,
    executionTarget: 'dev',
    correlationId: 'correlation-http-drift',
    causationId: null,
    input,
  };
}

function ownerService() {
  const registry = createPhaseOneRegistry({
    additionalDefinitions: [UNKNOWN_CAPABILITY_DEFINITION],
  });
  const calls = { authorization: 0, create: 0 };
  const bundles: CreateTaskBundle[] = [];
  const ids = ['task-1', 'revision-1', 'plan-1', 'run-1', 'trace-1'];
  let idIndex = 0;
  const deps: ManagedTaskCommandServiceDeps = {
    executionTarget: 'dev',
    flags: () => ({
      apiEnabled: true,
      createEnabled: true,
      workerEnabled: false,
      laneEnabled: false,
    }),
    readiness: () => ({ ready: true }),
    authorization: {
      async authorize() {
        calls.authorization += 1;
        return { allowed: true, authorizationRevision: 'auth-1' };
      },
    },
    registry,
    compiler: new PlanCompiler(registry),
    commandStore: {
      async createBundle(_target, bundle) {
        calls.create += 1;
        bundles.push(bundle);
        return { outcome: 'applied', receipt: bundle.receipt };
      },
      async cancelTask() {
        throw new Error('cancel is outside this drift test');
      },
    },
    taskStore: {
      async getTaskForAccount() {
        return null;
      },
    },
    runStore: {
      async getLatestRunForTask() {
        return null;
      },
    },
    traceStore: {
      async listByTask() {
        return [];
      },
    },
    now: () => 3_000,
    newId: () => ids[idIndex++] ?? `extra-${idIndex}`,
  };
  return { service: new ManagedTaskCommandService(deps), calls, bundles };
}

async function withOwnerRoute(
  run: (context: {
    client: ManagedTaskHttpClient;
    raw: InternalHttpClient;
    calls: ReturnType<typeof ownerService>['calls'];
    bundles: CreateTaskBundle[];
  }) => Promise<void>,
): Promise<void> {
  const owner = ownerService();
  const server = new InternalHttpServer();
  registerManagedTaskRoutes(server, owner.service, TOKEN, 'dev');
  const port = await server.listen(0);
  const raw = new InternalHttpClient(`http://127.0.0.1:${port}`);
  try {
    await run({
      client: new ManagedTaskHttpClient(raw, TOKEN, 'dev'),
      raw,
      calls: owner.calls,
      bundles: owner.bundles,
    });
  } finally {
    await server.close();
  }
}

test('API HTTP client reaches the real Automation owner service and commits one compiled bundle', async () => {
  await withOwnerRoute(async ({ client, calls, bundles }) => {
    assert.deepEqual(await client.create(envelope()), {
      outcome: 'applied',
      commandId: 'create-persona.research-1',
      taskId: 'task-1',
      runId: 'run-1',
      aggregateVersion: 1,
    });
    assert.deepEqual(calls, { authorization: 1, create: 1 });
    assert.equal(bundles.length, 1);
    assert.deepEqual(
      bundles[0]!.plan.nodes.map((node) => node.capabilityId),
      PERSONA_RESEARCH_CAPABILITY_IDS,
    );
  });
});

test('unknown wire contract version fails before Automation authorization or owner writes', async () => {
  await withOwnerRoute(async ({ raw, calls, bundles }) => {
    const drifted = structuredClone(envelope()) as unknown as Record<string, unknown>;
    drifted.contract = { name: 'managed-task', version: 2 };
    await assert.rejects(
      () => raw.callBearer(MANAGED_TASK_ROUTES.create, drifted, TOKEN),
      (error: unknown) => error instanceof InternalHttpError
        && error.code === 'protocol_version_mismatch',
    );
    assert.deepEqual(calls, { authorization: 0, create: 0 });
    assert.equal(bundles.length, 0);
  });
});

test('unknown TaskDefinition and capability versions stay explicit owner rejections over HTTP', async () => {
  await withOwnerRoute(async ({ client, calls, bundles }) => {
    const unknownVersion = envelope(createInput({ id: 'persona.research', version: 2 }));
    const unknownCapability = envelope(createInput({
      id: UNKNOWN_CAPABILITY_DEFINITION.taskDefinitionId,
      version: UNKNOWN_CAPABILITY_DEFINITION.version,
    }));

    assert.deepEqual(await client.create(unknownVersion), {
      outcome: 'rejected',
      code: 'unsupported',
      message: 'unknown task definition persona.research@2',
    });
    assert.deepEqual(await client.create(unknownCapability), {
      outcome: 'rejected',
      code: 'unsupported',
      message: 'unknown capability research.unknown@1',
    });
    assert.deepEqual(calls, { authorization: 2, create: 0 });
    assert.equal(bundles.length, 0);
  });
});
