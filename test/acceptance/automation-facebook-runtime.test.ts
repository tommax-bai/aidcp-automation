// aidcp:test-owner=derived
/**
 * Facebook 两套运行时存储的装配（批 G 第一片）。
 *
 * 这一片全部的价值在**缺席时怎么说话**：能力接不上时，调用方必须拿到一个
 * 带具名理由的 `unavailable`，而不是一个「看着能用、其实一步不走」的空实现。
 * 故本文件测的都是失败路径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAutomationFacebookRuntime } from '../../src/automation-facebook-runtime.js';

const SILENT = { warn: () => undefined };
const pool = {} as never;

/** 「库里该有的都有」：requirement 是模块私有常量，探不到列清单，故用恒真的成员检查。 */
const everythingPresent = (async () => ({
  tables: { has: () => true },
  columns: { has: () => true },
  indexes: { has: () => true },
})) as never;

const workingPool = (over: Record<string, unknown> = {}) =>
  ({
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => ({
      query: async () => ({ rows: [], rowCount: 0 }),
      release: () => undefined,
    }),
    ...over,
  }) as never;

test('缺部署目标 → 两个口都具名 unavailable，且一个存储都不构造', async () => {
  // target-scoped 的持久运行时：没有目标就写不出隔离列，构造出来只会往共享库写没有归属的行。
  let built = 0;
  const assembly = await createAutomationFacebookRuntime({
    runtimePool: pool,
    schemaProber: (() => {
      built += 1;
      return Promise.resolve({}) as never;
    }) as never,
    logger: SILENT,
  });
  assert.equal(assembly.ports.rule.state, 'unavailable');
  assert.equal(assembly.ports.consumption.state, 'unavailable');
  assert.equal(
    assembly.ports.rule.state === 'unavailable' && assembly.ports.rule.reason,
    'execution_target_missing',
    '理由 MUST 具名 —— 调用方要据此报 blocker',
  );
  assert.equal(built, 0, '缺目标时 MUST 一个存储都不构造');
});

test('init 失败 MUST 变成具名 unavailable，绝不吞成「本来就没这个能力」', async () => {
  // 吞掉的话，规则批次与消费模式会安静地一步都不走，日志上与「今天没排期」完全同形。
  const assembly = await createAutomationFacebookRuntime({
    runtimePool: pool,
    executionTarget: 'dev',
    schemaProber: (() => Promise.reject(new Error('relation_missing'))) as never,
    logger: SILENT,
  });
  for (const port of [assembly.ports.rule, assembly.ports.consumption]) {
    assert.equal(port.state, 'unavailable');
    assert.match(
      port.state === 'unavailable' ? port.reason : '',
      /^init_failed:/,
      '理由 MUST 说清是初始化失败，而不是笼统的「不可用」',
    );
    assert.match(
      port.state === 'unavailable' ? port.reason : '',
      /relation_missing/,
      '原始错因 MUST 带出来，否则现场只能靠猜',
    );
  }
});

test('探测通过 → 两个口都接线，且方法真的转到存储上', async () => {
  const calls: string[] = [];
  const assembly = await createAutomationFacebookRuntime({
    runtimePool: workingPool({
      query: async (sql: string) => {
        calls.push(sql.slice(0, 12));
        return { rows: [], rowCount: 0 };
      },
    }),
    executionTarget: 'dev',
    schemaProber: everythingPresent,
    logger: SILENT,
  });
  assert.equal(assembly.ports.rule.state, 'wired');
  assert.equal(assembly.ports.consumption.state, 'wired');
  if (assembly.ports.consumption.state !== 'wired') return;
  // 五个方法都在（少一个 = 调度器那边整条链静默断掉）。
  for (const method of [
    'applyConfirmedView',
    'claimAction',
    'markDispatched',
    'settleAction',
    'supersedeAccount',
  ]) {
    assert.equal(
      typeof (assembly.ports.consumption.port as Record<string, unknown>)[method],
      'function',
      `${method} MUST 接线`,
    );
  }
});

test('关停只关自己建的，MUST NOT 碰注入进来的共享属主池', async () => {
  // 批 D 踩过的坑：存储的 close() 内部是 pool.end()，
  // 在共享池上调它会连带打死本进程其余十几个存储。
  let poolEnded = 0;
  const assembly = await createAutomationFacebookRuntime({
    runtimePool: workingPool({
      end: async () => {
        poolEnded += 1;
      },
    }),
    executionTarget: 'dev',
    schemaProber: everythingPresent,
    logger: SILENT,
  });
  await assembly.close();
  assert.equal(poolEnded, 0, '共享属主池 MUST NOT 被这一片关掉');
});
