// aidcp:test-owner=derived
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
/**
 * 这条用例**换过一次判据**（2026-08-03），换的原因值得留着。
 *
 * 原先它断的是「组装根 MUST NOT 出现 `new PublishGenerationHttpClient(`」+「台账里那条必须还在」，
 * 用途是防「伪装成已接线」。生成链真接上之后，那个判据就到期了 —— 而**它是靠编译器点名到期的**
 * （台账撤条后联合类型里没有那个 id 了，字面量比较当场红），不是靠谁记得回来改。
 *
 * 换成的新判据是**正向的**：客户端 MUST 真的建出来、MUST 喂给发帖触发器、
 * 而发帖触发器 MUST 有一个真消费方。**别退回「文件里没有某个字符串」那种反向判据** ——
 * 接线做完之后它只会挡住后来人，挡不住任何真问题。
 */
test('派生组合根：生成链真接上（客户端 → 发帖触发器 → 委托执行器），且超时预算够长', async () => {
  assert.equal(INTERNAL_HTTP_TIMEOUT_CEILING_MS, 180_000);
  assert.ok(
    INTERNAL_HTTP_TIMEOUT_CEILING_MS > PUBLISH_GENERATION_POLL_SEGMENT_CEILING_MS,
    '单次调用超时必须严格大于单段 long-poll 挂起上限',
  );
  const main = await readFile(new URL('../../src/automation-main.ts', import.meta.url), 'utf8');
  const code = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  // ① 客户端真建，且**超时显式取那个硬顶**。漏掉 timeoutMs 的后果不是报错，
  //    是每次跨进程生成在默认 15s 确定性失败 —— typecheck 抓不到，它只是个缺省参数。
  assert.match(
    code,
    /new PublishGenerationHttpClient\(\s*new InternalHttpClient\(\s*config\.contentBaseUrl,\s*\{\s*timeoutMs: INTERNAL_HTTP_TIMEOUT_CEILING_MS,/,
    '生成链客户端 MUST 指向内容进程，且单次调用超时 MUST 取 180s 硬顶',
  );

  // ② 客户端 MUST 喂给发帖触发器（否则就是「建好零消费方」）。
  assert.match(code, /orchestrator:\s*publishGeneration,/);

  // ③ 发帖触发器 MUST 有真消费方。本进程里唯一可达的那个是委托执行器 ——
  //    排期 tick 那个类属 api、本仓没有；手动发布那条路由按 1.7b 裁定刻意不接。
  assert.match(code, /publishes:\s*publishScheduler,/);

  // ④ **本进程 MUST NOT 有「本地编排器」回落**：那会得到「启动日志说已就绪、每次发帖在调用点炸」，
  //    而排期发帖的小时格幂等票在触发前就已认领 —— 失败一次就烧掉那一小时。
  assert.doesNotMatch(code, /publishOrchestrator/);

  // ⑤ 那条台账条目 MUST 已经撤掉（撤条与接线同批，别留一条已经不成立的欠账）。
  //    **id 先按注解宽化成 `string[]` 再比**，不写 `as`：撤条之后那个字面量已经不在联合里，
  //    直接比会被 TS 判成「永远不相等」而报错 —— 而这条断言的价值恰恰在「有人把它加回来就红」。
  const ledgerIds: readonly string[] = AUTOMATION_ROOT_READINESS_BLOCKERS.map(
    (blocker) => blocker.id,
  );
  assert.equal(
    ledgerIds.includes('content-generic-llm-authority'),
    false,
    '生成链已接线，那条台账条目 MUST 同批撤掉',
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
