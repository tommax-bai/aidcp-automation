import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  InternalHttpClient,
  InternalHttpServer,
  INTERNAL_HTTP_TIMEOUT_CEILING_MS,
} from '../../src/transport/internal-http.js';
import {
  PUBLISH_GENERATION_ROUTES,
  PUBLISH_GENERATION_POLL_SEGMENT_CEILING_MS,
  PublishGenerationHttpClient,
  registerPublishGenerationRoutes,
} from '../../src/transport/publish-generation-http.js';
import type {
  PublishGenerationPort,
  SchedulerTriggerResult,
} from 'aidcp-kernel/kernel/publish-generation-types.js';
import type { TriggerInput } from 'aidcp-kernel/kernel/publish-pipeline-types.js';
import { AUTOMATION_ROOT_READINESS_BLOCKERS } from '../../src/automation-composition-root.js';

/** 样本终态：结构上满足 SchedulerTriggerResult（含 approvalCard 联合的一个合法枝）。 */
const SAMPLE: SchedulerTriggerResult = {
  status: 'pending_approval',
  runId: 'run-xyz',
  recordId: 42,
  approvalCard: { sent: true, targetChatId: 'oc_1', targetSource: 'default_chat' },
};

/** 仅测传输往返，不构造全字段业务夹具（口径由 typecheck 在真实调用处保证）。 */
function sampleInput(): TriggerInput {
  return { accountId: 'acc-1' } as unknown as TriggerInput;
}

/** fake 端口：trigger 在 delayMs 后 resolve 一个样本终态；记录被调用的入参。 */
function fakePort(delayMs: number): { port: PublishGenerationPort; calls: TriggerInput[] } {
  const calls: TriggerInput[] = [];
  const port: PublishGenerationPort = {
    trigger(input) {
      calls.push(input);
      return new Promise<SchedulerTriggerResult>((resolve) => {
        setTimeout(() => resolve(SAMPLE), delayMs);
      });
    },
  };
  return { port, calls };
}

async function withServer(
  local: PublishGenerationPort,
  run: (http: InternalHttpClient) => Promise<void>,
): Promise<void> {
  const server = new InternalHttpServer();
  registerPublishGenerationRoutes(server, local);
  const listenPort = await server.listen(0);
  // 单次调用超时须 > pollSegmentMs：给足 180s 天花板。
  const http = new InternalHttpClient(`http://127.0.0.1:${listenPort}`, { timeoutMs: 180_000 });
  try {
    await run(http);
  } finally {
    await server.close();
  }
}

test('PublishGenerationHttpClient 满足 kernel 端口形状', async () => {
  await withServer(fakePort(5).port, async (http) => {
    const client: PublishGenerationPort = new PublishGenerationHttpClient(http);
    assert.equal(typeof client.trigger, 'function');
  });
});

test('快 trigger：kick → 一轮 poll 即 done 拿到结果', async () => {
  const { port, calls } = fakePort(10);
  await withServer(port, async (http) => {
    const client = new PublishGenerationHttpClient(http, { pollSegmentMs: 5000 });
    const out = await client.trigger(sampleInput());
    assert.deepEqual(out, SAMPLE);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].accountId, 'acc-1');
  });
});

test('慢 trigger（raw 两轮）：第一轮小 budget → done:false，续轮拿到结果', async () => {
  await withServer(fakePort(120).port, async (http) => {
    const { correlationId } = await http.call<{ correlationId: string }>(
      PUBLISH_GENERATION_ROUTES.kick,
      { input: sampleInput() },
    );
    assert.equal(typeof correlationId, 'string');
    // 第一轮预算 20ms，远小于 trigger 的 120ms → 未 settled。
    const first = await http.call<{ done: boolean }>(PUBLISH_GENERATION_ROUTES.poll, {
      correlationId,
      budgetMs: 20,
    });
    assert.equal(first.done, false);
    // 续轮给足预算 → 拿到终态。
    const second = await http.call<{ done: boolean; result?: SchedulerTriggerResult }>(
      PUBLISH_GENERATION_ROUTES.poll,
      { correlationId, budgetMs: 5000 },
    );
    assert.equal(second.done, true);
    assert.deepEqual(second.result, SAMPLE);
  });
});

test('慢 trigger（client 多轮）：小 pollSegmentMs 下循环 poll 直到 done', async () => {
  await withServer(fakePort(120).port, async (http) => {
    const client = new PublishGenerationHttpClient(http, { pollSegmentMs: 20 });
    const out = await client.trigger(sampleInput());
    assert.deepEqual(out, SAMPLE);
  });
});

/**
 * 组合根接线不变量：单次调用超时 MUST > 分段 long-poll 预算。
 * 落回默认 15s 时，每一段 poll 都会在服务端回 `{done:false}` 之前被客户端切断 ⇒ 每次跨服务发帖生成
 * 都在 15s 确定性失败（core 模式的硬阻断，typecheck 抓不到——它只是个缺省参数）。
 */
test('派生组合根：生成链保持具名 content/runtime blocker，不伪装成已接线', async () => {
  assert.equal(INTERNAL_HTTP_TIMEOUT_CEILING_MS, 180_000);
  assert.ok(
    INTERNAL_HTTP_TIMEOUT_CEILING_MS > PUBLISH_GENERATION_POLL_SEGMENT_CEILING_MS,
    '单次调用超时必须严格大于单段 long-poll 挂起上限',
  );
  const [server, root] = await Promise.all([
    readFile(new URL('../../src/server.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../src/automation-composition-root.ts', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(
    `${server}\n${root}`,
    /new PublishGenerationHttpClient\(/,
    '4a automation root MUST NOT fake the unresolved content generation wiring',
  );
  assert.ok(
    AUTOMATION_ROOT_READINESS_BLOCKERS.some(
      (blocker) => blocker.id === 'content-generic-llm-authority',
    ),
    'unwired generation authority must remain a named readiness blocker',
  );
});

test('取走结果后再 poll 同 correlationId → unknown_correlation', async () => {
  await withServer(fakePort(5).port, async (http) => {
    const { correlationId } = await http.call<{ correlationId: string }>(
      PUBLISH_GENERATION_ROUTES.kick,
      { input: sampleInput() },
    );
    const done = await http.call<{ done: boolean }>(PUBLISH_GENERATION_ROUTES.poll, {
      correlationId,
      budgetMs: 5000,
    });
    assert.equal(done.done, true);
    await assert.rejects(
      () => http.call(PUBLISH_GENERATION_ROUTES.poll, { correlationId, budgetMs: 100 }),
      (err: unknown) => (err as { code?: string }).code === 'unknown_correlation',
    );
  });
});
