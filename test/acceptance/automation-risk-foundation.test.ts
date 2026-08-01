// aidcp:test-owner=derived
/**
 * AC-RISK-* 在自动化仓这一侧的落点（task 3.1 · 批 B 验收）。
 *
 * 风控红线的口径是「绝不自残、绝不静默双写」。搬进本仓后，那两句话具体是这几条：
 *
 * - **抢不到写者锁 MUST 拒绝启用风控写路径**。返回一个「没有锁的」底座就是双写：
 *   两个实例合计放行的真实平台动作会是单份上限的两倍，且一方刚写下的受限会被另一方盖回。
 * - **写权中途丢了 MUST 立刻停发互动命令**，且那道闸 MUST 与注册表用的是**同一个闭包**。
 *   第二份实现会在两者漂开的那一刻悄悄放行——这类漂移不报错、只是判错。
 * - **告警链路没就绪 ≠ 可以不告警**。
 * - **存储 init 失败要具名退化**，不是一个 undefined 了事：说不出原因就查不出是哪一层坏了。
 * - **关停 MUST NOT 关掉属主池**（历史上同形的一次 bug：注入共享池 + close 把十几个存储一起打死）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';

import { RiskControllerRegistry } from '../../src/risk/risk-controller-registry.js';

import {
  AutomationWriterLockUnavailableError,
  createAutomationRiskFoundation,
  type AutomationRiskAlertInput,
} from '../../src/automation-risk-foundation.js';

const SILENT = { log: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * 一个**没有真连接**的属主池。三个互动存储与告警存储的 `init()` 会因此失败——
 * 那正好是「具名退化」那条要走的路径；风控注册表本身不在构造期查库。
 */
const FAKE_POOL = {
  query: () => Promise.reject(new Error('no_database_in_test')),
  connect: () => Promise.reject(new Error('no_database_in_test')),
  end: () => Promise.resolve(),
} as unknown as pg.Pool;

function heldLock(): {
  lock: {
    acquire: () => Promise<{ ok: true }>;
    onLost: (listener: (reason: string) => void) => () => void;
    release: () => Promise<void>;
    isHeld: () => boolean;
  };
  lose: (reason: string) => void;
  released: () => number;
} {
  const listeners: ((reason: string) => void)[] = [];
  let releases = 0;
  return {
    lock: {
      acquire: async () => ({ ok: true as const }),
      onLost: (listener) => {
        listeners.push(listener);
        return () => undefined;
      },
      release: async () => {
        releases += 1;
      },
      isHeld: () => true,
    },
    lose: (reason) => listeners.forEach((listener) => listener(reason)),
    released: () => releases,
  };
}

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    ownerPool: FAKE_POOL,
    executionTarget: 'dev' as const,
    mirrorStale: () => false,
    accountingBlocked: () => false,
    logger: SILENT,
    ...overrides,
  };
}

test('抢不到写者锁：抛具名错误、先落一条 P1 启动期告警，且绝不返回一个没有锁的底座', async () => {
  const alerts: AutomationRiskAlertInput[] = [];
  await assert.rejects(
    createAutomationRiskFoundation(
      baseOptions({
        createWriterLock: () => ({
          acquire: async () => ({ ok: false as const, detail: '锁已被另一个实例持有' }),
          onLost: () => () => undefined,
          release: async () => undefined,
          isHeld: () => false,
        }),
        raiseStandaloneAlert: async (input: AutomationRiskAlertInput) => {
          alerts.push(input);
        },
      }) as Parameters<typeof createAutomationRiskFoundation>[0],
    ),
    (error: unknown) =>
      error instanceof AutomationWriterLockUnavailableError
      && error.code === 'automation_writer_lock_unavailable'
      && error.executionTarget === 'dev'
      && error.detail.includes('锁已被另一个实例持有'),
  );
  assert.equal(alerts.length, 1, '抢不到锁 MUST 先尽力把这条 P1 写下去再退');
  assert.equal(alerts[0]!.severity, 'P1');
  assert.equal(alerts[0]!.type, 'risk_writer_lock_unavailable');
});

test('启动期告警写不进去也照退——诚实失败优于静默双写', async () => {
  await assert.rejects(
    createAutomationRiskFoundation(
      baseOptions({
        createWriterLock: () => ({
          acquire: async () => ({ ok: false as const, detail: '超时' }),
          onLost: () => () => undefined,
          release: async () => undefined,
          isHeld: () => false,
        }),
        raiseStandaloneAlert: async () => {
          throw new Error('alert_db_down');
        },
      }) as Parameters<typeof createAutomationRiskFoundation>[0],
    ),
    /alert_db_down|automation_writer_lock_unavailable/,
    '告警写失败 MUST NOT 让这条路径变成「那就继续跑吧」',
  );
});

test('写权中途丢失：准入闸立刻翻转，且注册表用的就是这一个闭包（不是第二份判断）', async () => {
  const lock = heldLock();
  const alerts: AutomationRiskAlertInput[] = [];
  const foundation = await createAutomationRiskFoundation(
    baseOptions({
      createWriterLock: () => lock.lock,
      logger: {
        log: () => undefined,
        warn: (message: string) => {
          if (message.includes('写者锁已丢失')) alerts.push({} as AutomationRiskAlertInput);
        },
        error: () => undefined,
      },
    }) as Parameters<typeof createAutomationRiskFoundation>[0],
  );

  assert.equal(foundation.writerAuthorityLost(), false);
  assert.equal(foundation.interactionBlocked('acct-a'), false);

  lock.lose('持锁连接断开');

  assert.equal(foundation.writerAuthorityLost(), true);
  assert.equal(
    foundation.interactionBlocked('acct-a'),
    true,
    '写权丢了就 MUST 对**所有**账号拒绝互动准入——闸设在公共必经点，不逐账号例外',
  );
  assert.ok(alerts.length >= 1, '写权丢失 MUST 告警');
  await foundation.close();
});

test('注册表拿到的准入闸就是对外暴露的那一个（同一个引用，不是第二份实现）', async () => {
  // **这条是结构断言，不是行为断言，别当冗余删掉。**
  // 上一条只验了对外暴露的那个闭包会翻转。把注册表那一路悄悄换成「只判记账断链、
  // 漏掉写权丢失」的第二份实现，**其余七条行为用例照样全绿**——实测过。
  // 原因是原理性的：第二份在写出来那一刻行为完全一致，要等到某天两份漂开、
  // 且**恰好在拒绝真该发生的那一刻**才现形，而那正是最少被真跑到的一条路径。
  const lock = heldLock();
  let passedProvider: unknown;
  const foundation = await createAutomationRiskFoundation(
    baseOptions({
      createWriterLock: () => lock.lock,
      createRegistry: (...args: ConstructorParameters<typeof RiskControllerRegistry>) => {
        passedProvider = args[3]?.interactionBlockedProvider;
        return new RiskControllerRegistry(...args);
      },
    }) as Parameters<typeof createAutomationRiskFoundation>[0],
  );
  assert.equal(
    passedProvider,
    foundation.interactionBlocked,
    '注册表拿到的准入闸 MUST 与对外暴露的是**同一个引用**。'
      + '两份实现在写出来那一刻行为一致，漂开之后不报错、只是悄悄放行',
  );
  await foundation.close();
});

test('记账断链只拒该账号；两条原因共用同一条通道', async () => {
  const blocked = new Set(['acct-broken']);
  const foundation = await createAutomationRiskFoundation(
    baseOptions({
      createWriterLock: () => heldLock().lock,
      accountingBlocked: (accountId: string) => blocked.has(accountId),
    }) as Parameters<typeof createAutomationRiskFoundation>[0],
  );
  assert.equal(foundation.interactionBlocked('acct-broken'), true);
  assert.equal(foundation.interactionBlocked('acct-ok'), false);
  await foundation.close();
});

test('存储 init 失败要具名退化：说得出是哪个存储、因为什么，且不阻塞启动', async () => {
  const foundation = await createAutomationRiskFoundation(
    baseOptions({ createWriterLock: () => heldLock().lock }) as Parameters<
      typeof createAutomationRiskFoundation
    >[0],
  );
  const names = foundation.degraded.map((entry) => entry.store).sort();
  assert.deepEqual(names, [
    'InteractionFeedStore',
    'LikedNoteStore',
    'PgAlertStore',
    'ValuableCommentStore',
  ]);
  for (const entry of foundation.degraded) {
    assert.ok(
      entry.reason.length > 0,
      `${entry.store}: 退化 MUST 带原因。只留一个 undefined 的话，`
        + '「库连不上」与「表还没建」在事后完全同形',
    );
  }
  assert.equal(foundation.alertStore, undefined);
  assert.ok(foundation.riskRegistry, '存储退化 MUST NOT 阻塞风控注册表本身');
  await foundation.close();
});

test('告警链路没就绪也要留痕：绑定失败时照样 warn，信息不消失', async () => {
  const warned: string[] = [];
  const foundation = await createAutomationRiskFoundation(
    baseOptions({
      createWriterLock: () => heldLock().lock,
      logger: {
        log: () => undefined,
        warn: (message: string) => warned.push(message),
        error: () => undefined,
      },
    }) as Parameters<typeof createAutomationRiskFoundation>[0],
  );
  warned.length = 0;
  await foundation.raiseAlert({
    severity: 'P2',
    type: 'probe',
    title: '标题',
    detail: '细节',
  });
  assert.equal(warned.length, 1, '告警存储没起来时 MUST 仍然 warn——可检索性降级，信息不消失');
  assert.match(warned[0]!, /标题.*细节/);
  await foundation.close();
});

test('关停只释放本模块自己开的东西，MUST NOT 关掉属主池', async () => {
  let poolEnded = 0;
  const pool = {
    query: () => Promise.reject(new Error('no_database_in_test')),
    connect: () => Promise.reject(new Error('no_database_in_test')),
    end: () => {
      poolEnded += 1;
      return Promise.resolve();
    },
  } as unknown as pg.Pool;
  const lock = heldLock();
  const foundation = await createAutomationRiskFoundation(
    baseOptions({ ownerPool: pool, createWriterLock: () => lock.lock }) as Parameters<
      typeof createAutomationRiskFoundation
    >[0],
  );
  await foundation.close();
  assert.equal(lock.released(), 1, '写者锁 MUST 释放');
  assert.equal(
    poolEnded,
    0,
    '属主池由组装根掌控生命周期。在这里 end 它会连带打死其余十几个存储——历史上同形的 bug 出过一次',
  );
});
