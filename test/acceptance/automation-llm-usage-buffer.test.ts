// aidcp:test-owner=derived
/**
 * 模型用量合并缓冲的闸（task 2.4d-用量）。
 *
 * 这一片的错法有个共同点：**全都不报错，只是数字悄悄不对**。所以每条用例钉的都是一个
 * 「照直觉写就会写反」的具体判据，而不是「跑通了」：
 *
 * - 传输失败去重投 → 数字**翻倍**（属主侧是累加不是幂等写），且看起来一切正常；
 * - 把「不知道成没成」记成成功 → 丢账无声；
 * - 桶起点让属主重算 → 整批用量挪进错误的时间桶，曲线平移、零报错；
 * - 总 token 用「输入 + 输出」凑 → 把缓存命中 / 思考 token 那个差额抹平；
 * - 缺账号兜个默认 → 落成一行谁都归属不了的账。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LLM_USAGE_BUCKET_MS,
  type LlmUsageIncrement,
} from 'aidcp-kernel/kernel/llm-usage-recording-port.js';

import { createAutomationLlmUsageBuffer } from '../../src/automation-llm-usage-buffer.js';

const SILENT = { log: () => undefined, warn: () => undefined };

function harness(options: {
  recordUsage: (rows: readonly LlmUsageIncrement[]) => Promise<number>;
  now?: () => number;
}) {
  const submitted: LlmUsageIncrement[][] = [];
  const buffer = createAutomationLlmUsageBuffer({
    sink: {
      recordUsage: async (rows) => {
        submitted.push(rows.map((row) => ({ ...row })));
        return options.recordUsage(rows);
      },
    },
    now: options.now ?? (() => 1_700_000_000_000),
    logger: SILENT,
  });
  return { buffer, submitted };
}

test('同键合并成一行：调用次数累加，总 token 取厂商回报值而不是输入+输出凑', async () => {
  const { buffer, submitted } = harness({ recordUsage: async (rows) => rows.length });
  const call = {
    accountId: 'a1',
    role: 'note_opener',
    provider: 'dashscope',
    model: 'qwen-plus',
    ok: true,
    promptTokens: 10,
    completionTokens: 5,
    // 厂商回报的合计**大于**输入+输出（思考 token / 缓存等）——凑数会把这个差额抹平。
    totalTokens: 20,
  };
  buffer.record(call);
  buffer.record({ ...call, ok: false, promptTokens: 1, completionTokens: 1, totalTokens: 3 });
  await buffer.flush();

  assert.equal(submitted.length, 1);
  assert.equal(submitted[0]!.length, 1, '同一个键 MUST 合并成一行');
  const row = submitted[0]![0]!;
  assert.equal(row.promptTokens, 11);
  assert.equal(row.completionTokens, 6);
  assert.equal(row.totalTokens, 23, '总数是两次厂商回报值之和，不是 11+6');
  assert.equal(row.calls, 2);
  assert.equal(row.okCalls, 1, '失败那次也要记 token（token 与 ok 解耦），但不计入 okCalls');
});

test('桶起点由本侧在调用发生那一刻戳，且对齐到桶宽', async () => {
  let clock = 1_700_000_000_123;
  const { buffer, submitted } = harness({
    recordUsage: async (rows) => rows.length,
    now: () => clock,
  });
  buffer.record({ accountId: 'a1', model: 'm', ok: true, totalTokens: 1 });
  // 跨到下一个桶再记一条：**两条 MUST 分成两行**，否则曲线会被压进同一个时间点。
  clock += LLM_USAGE_BUCKET_MS;
  buffer.record({ accountId: 'a1', model: 'm', ok: true, totalTokens: 1 });
  await buffer.flush();

  const rows = submitted[0]!;
  assert.equal(rows.length, 2, '跨桶的两次调用 MUST 是两行');
  for (const row of rows) {
    assert.equal(row.bucketStartMs % LLM_USAGE_BUCKET_MS, 0, '桶起点 MUST 对齐桶宽');
  }
  assert.equal(rows[1]!.bucketStartMs - rows[0]!.bucketStartMs, LLM_USAGE_BUCKET_MS);
});

test('传输失败：丢弃并计数，**绝不重投**（重投即翻倍）', async () => {
  let attempts = 0;
  const { buffer, submitted } = harness({
    recordUsage: async () => {
      attempts += 1;
      throw new Error('connect ECONNREFUSED');
    },
  });
  buffer.record({ accountId: 'a1', model: 'm', ok: true, totalTokens: 7 });
  await buffer.flush();
  // 再 flush 一次：**上一批 MUST NOT 出现在这一批里**。
  await buffer.flush();

  assert.equal(attempts, 1, '失败之后不许再提交同一批 —— 属主侧是累加计数器，重投即翻倍');
  assert.equal(submitted.length, 1);
  assert.equal(buffer.stats().discardedRows, 1, '丢掉的行数要计数留痕，不能无声');
  assert.equal(buffer.stats().appliedRows, 0, '「不知道成没成」MUST NOT 记成成功');
});

test('属主只落了一部分：差额如实计数，不当成全部成功', async () => {
  const { buffer } = harness({ recordUsage: async () => 1 });
  buffer.record({ accountId: 'a1', model: 'm1', ok: true, totalTokens: 1 });
  buffer.record({ accountId: 'a2', model: 'm2', ok: true, totalTokens: 1 });
  await buffer.flush();

  const stats = buffer.stats();
  assert.equal(stats.appliedRows, 1);
  assert.equal(stats.unappliedRows, 1, '属主明确说没写上的那一行 MUST 留痕');
  assert.equal(stats.discardedRows, 0, '这不是传输失败，两者的含义不同、别混成一个计数');
});

test('缺账号的调用就地丢掉，MUST NOT 兜一个默认账号', async () => {
  const { buffer, submitted } = harness({ recordUsage: async (rows) => rows.length });
  buffer.record({ model: 'm', ok: true, totalTokens: 5 });
  buffer.record({ accountId: '   ', model: 'm', ok: true, totalTokens: 5 });
  await buffer.flush();

  assert.equal(submitted.length, 0, '一行都不该提交');
  assert.equal(buffer.stats().droppedNoAccount, 2);
});

test('维度缺省填显式占位值，且空窗口提交是空操作', async () => {
  const { buffer, submitted } = harness({ recordUsage: async (rows) => rows.length });
  await buffer.flush();
  assert.equal(submitted.length, 0, '空窗口 MUST NOT 发一次请求');

  buffer.record({ accountId: 'a1', model: '  ', ok: true, totalTokens: 1 });
  await buffer.flush();
  const row = submitted[0]![0]!;
  // 三个维度都 MUST 非空：跨进程之后空串是个看起来完全合法的取值，
  // 会落成一行谁都归属不了的账，而不是被谁挡下来。
  assert.equal(row.role, 'untagged');
  assert.equal(row.provider, 'unknown');
  assert.equal(row.model, 'unknown');
});

test('record 绝不抛：它跑在模型调用的完成路径上', () => {
  const buffer = createAutomationLlmUsageBuffer({
    sink: { recordUsage: async () => 0 },
    logger: SILENT,
    now: () => {
      throw new Error('clock exploded');
    },
  });
  assert.doesNotThrow(() =>
    buffer.record({ accountId: 'a1', model: 'm', ok: true, totalTokens: 1 }),
  );
});

test('停机时做最后一次提交，失败同样不重投', async () => {
  let attempts = 0;
  const buffer = createAutomationLlmUsageBuffer({
    sink: {
      recordUsage: async () => {
        attempts += 1;
        throw new Error('down');
      },
    },
    logger: SILENT,
    now: () => 1_700_000_000_000,
    setTimer: () => ({ unref: () => undefined }) as never,
    clearTimer: () => undefined,
  });
  buffer.start();
  buffer.record({ accountId: 'a1', model: 'm', ok: true, totalTokens: 1 });
  await buffer.stop();
  assert.equal(attempts, 1, '关停也只试一次 —— 「要关了」不是重投的理由');
  assert.equal(buffer.stats().discardedRows, 1);
});
