// aidcp:test-owner=derived
/**
 * 互动配置面审计中继（批 C 最后一件）。
 *
 * 这一片的全部价值在**送不出去时怎么办**：审计是「谁在什么时候改了配置」的唯一记录，
 * 丢一条就出现一段无人知晓的空洞。所以三条红线都是「宁可堵住，也不丢」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAutomationConfigAuditRelay } from '../../src/automation-config-audit-relay.js';

const SILENT = { log: () => undefined, warn: () => undefined };
/** 一条结构合法的审计载荷（照解码器逐字段要求构造）。 */
const VALID_AUDIT_PAYLOAD = {
  eventId: 'evt-1',
  platform: 'facebook',
  accountId: 'acc-1',
  envKey: 'env-1',
  actor: 'ops:someone',
  action: 'update',
  configVersion: 3,
  entityType: 'reply_config',
  entityId: 'rc-1',
  summary: '改了回复配置',
  labels: {},
  createdAt: 1_700_000_000_000,
};

const pool = {
  query: async () => ({ rows: [], rowCount: 0 }),
  connect: async () => ({
    query: async () => ({ rows: [], rowCount: 0 }),
    release: () => undefined,
  }),
} as never;

test('缺部署目标 → 整片不启动，并说清为什么', () => {
  // outbox 行按 target 隔离，没有目标会把别的机器的审计也排空过去。
  const warned: string[] = [];
  const relay = createAutomationConfigAuditRelay({
    pool,
    auditWrites: { insertAuditEvent: async () => undefined },
    logger: { log: () => undefined, warn: (m: string) => warned.push(m) },
  });
  relay.start();
  assert.equal(relay.running(), false, '缺目标 MUST NOT 假装在跑');
  assert.equal(warned.length, 1);
  assert.match(warned[0]!, /缺部署目标/);
});

test('定时器不在构造期起——与批 D/F 一致，留给进程入口在就绪闸之后调', () => {
  const relay = createAutomationConfigAuditRelay({
    pool,
    executionTarget: 'dev',
    auditWrites: { insertAuditEvent: async () => undefined },
    logger: SILENT,
  });
  // 构造完还没 start ⇒ 不该已经在跑（否则就绪闸之前就开始排空队列了）。
  assert.equal(relay.running(), false);
  relay.start();
  assert.equal(relay.running(), true);
  // 重复 start 不重复起（否则会有两条中继抢同一个游标）。
  relay.start();
  assert.equal(relay.running(), true);
  relay.stop();
  assert.equal(relay.running(), false);
});

/* ─────────── 红线：送不出去时宁可堵住，也不丢 ─────────── */

/**
 * 处理器的两条抛错分支是这一片的**承重**，但它们藏在传给消费者的 Map 里。
 * 直接构造真消费者去驱动一轮要连库，故这里把处理器取出来单独驱动 ——
 * 断的是「这两种情况到底抛不抛」，而不是消费者的调度。
 */
function handlerOf(over: Record<string, unknown> = {}) {
  const handlers = new Map<string, (event: unknown) => Promise<void>>();
  const OriginalMap = Map;
  // 捕获中继注册进去的那张处理器表。
  class CapturingMap extends OriginalMap<string, (event: unknown) => Promise<void>> {
    constructor(entries?: Iterable<[string, (event: unknown) => Promise<void>]>) {
      super(entries as never);
      for (const [topic, handler] of this) handlers.set(topic, handler);
    }
  }
  (globalThis as { Map: unknown }).Map = CapturingMap;
  try {
    createAutomationConfigAuditRelay({
      pool,
      executionTarget: 'dev',
      logger: SILENT,
      ...over,
    } as never);
  } finally {
    (globalThis as { Map: unknown }).Map = OriginalMap;
  }
  const handler = [...handlers.values()][0];
  assert.ok(handler, '中继 MUST 注册一个审计主题处理器');
  return handler;
}

test('载荷结构不符 MUST 抛错让游标停住，绝不静默跳过', async () => {
  // 载荷由本仓自己的写入侧生成，结构不符即代码缺陷；
  // 丢掉这条来「让队列跑下去」，等于用一段无人知晓的审计空洞掩盖一个 bug。
  const handler = handlerOf({
    auditWrites: { insertAuditEvent: async () => undefined },
  });
  await assert.rejects(
    () => handler({ id: 42, payload: { not: 'an audit row' } }),
    /interaction_audit_relay_undecodable_payload/,
  );
});

test('跨进程通道缺席 MUST 抛错，绝不「成功」地把审计丢进真空', async () => {
  // 用**结构合法**的载荷，确保红的确实是「通道缺席」而不是解码先失败。
  const handler = handlerOf({ auditWrites: undefined });
  await assert.rejects(
    () => handler({ id: 1, payload: VALID_AUDIT_PAYLOAD }),
    /interaction_api_writes_unavailable/,
  );
});

test('载荷合法且通道在场 → 原样送出去，不改内容', async () => {
  const sent: unknown[] = [];
  const handler = handlerOf({
    auditWrites: {
      insertAuditEvent: async (record: unknown) => {
        sent.push(record);
      },
    },
  });
  await handler({ id: 7, payload: VALID_AUDIT_PAYLOAD });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], VALID_AUDIT_PAYLOAD);
});

test('剪裁 MUST NOT 给承重主题设兜底强删——未落地就删 = 静默吞审计', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../../src/automation-config-audit-relay.ts', import.meta.url),
    'utf8',
  );
  // **只看构造块**：整文件匹配会被本文件自己解释这条红线的注释命中（弱断言的典型形态）。
  const start = source.indexOf('new OutboxRetentionPruner({');
  assert.notEqual(start, -1, '找不到剪裁器构造');
  const block = source.slice(start, source.indexOf('});', start));
  assert.doesNotMatch(
    block,
    /unconsumedRetentionMs/,
    '审计是承重主题：设了兜底强删，未被中继确认的行会被直接删掉，而那正是一条丢失的审计',
  );
  // 剪裁必须按「已被本消费者确认」那一档做 —— 即 consumers 必须点名本中继。
  assert.match(block, /consumers:\s*\[INTERACTION_AUDIT_RELAY_CONSUMER\]/);
});

test('审计落地 MUST 走注入的跨进程口，不直连接口属主表', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../../src/automation-config-audit-relay.ts', import.meta.url),
    'utf8',
  );
  // 直连既破坏单写、又会在物理拆库后连不上。
  // 去掉块注释再判：注释里解释「为什么不直连」时会提到那张表，那不是直连。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(
    code,
    /interaction_audit_events/,
    '本片 MUST NOT 出现接口属主表名 —— 落地只经注入的写入口',
  );
  assert.match(code, /options\.auditWrites\.insertAuditEvent\(/);
});
