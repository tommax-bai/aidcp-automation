// aidcp:test-owner=derived
/**
 * 批 H 第 5 片（真装配 + `main()`）的闸。
 *
 * ## 为什么这一片的用例大半是**结构断言**
 *
 * `main()` 的失效形态几乎全是「行为上什么都不表现」的那一类：
 *
 * - 强转把属主客户端与目标契约的漂移**静音**（本 change 实测过：手抄契约漏四个字段、
 *   返回类型宽一档，只有去掉强转才现形）；
 * - 关停里调错一个 `close()` —— 同一族存储的语义不一样，而**调用点看不出来**，
 *   调到裸 `pool.end()` 那一族就是打死整个进程，且要等真关停那一刻才发生；
 * - 同一份判断被复制成第二份 —— 复制那一刻两份行为完全一致，
 *   要等某天只改了其中一份、且**恰好在该拦住的那一刻**才现形；
 * - schema 契约门没被调 / 调晚了 —— 进程照起、日志照打、用例照绿。
 *
 * 这几条**行为用例原理上看不见**，所以判据钉在结构上，且一律写成**正向委托**判据
 * （「这里 MUST 调到那个符号」），不写成「没有同名的本地定义」—— 后者本 change 已被
 * 改个函数名当场绕过一次。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeSyncReadFactEnvelope } from 'aidcp-kernel/kernel/sync-read-facts.js';

import { personaBindingFor, requirePersonaSoul } from '../../src/automation-persona-view.js';
import { AutomationSyncReadMirrors } from '../../src/transport/automation-sync-read-mirrors.js';

function sourceOf(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

/** 只剥注释：结构断言按整文件匹配会被**解释这条红线的注释**命中（本 change 踩过两次）。 */
function codeOf(relative: string): string {
  return sourceOf(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

const MAIN = '../../src/automation-main.ts';

const FRESH_MS = 60_000;

/**
 * 建一份带持定时钟的人设镜像。
 *
 * `readAt` 与 `asOf` 分开传，是因为本文件要测的正是**陈旧那一档** ——
 * 用同一个时刻既写又读，永远只测得到新鲜态。
 */
function personaMirrors(
  accounts: { accountId: string; personaText: string; soul: unknown }[],
  options: { asOf?: number; readAt?: number } = {},
): AutomationSyncReadMirrors {
  const asOf = options.asOf ?? 1_000;
  const readAt = options.readAt ?? asOf;
  const mirrors = new AutomationSyncReadMirrors('dev', () => readAt);
  mirrors.apply(
    makeSyncReadFactEnvelope({
      executionTarget: 'dev',
      stream: 'account_persona',
      cursor: '1',
      asOf,
      freshUntil: asOf + FRESH_MS,
      value: { accounts } as never,
    }),
    'owner_fetch',
  );
  return mirrors;
}

const SOUL = { identity: { name: '甲' }, interests: { topics: ['x'] } };

/* ───────────────────────────── 人设取用：回落方向按「哪边更严」判 */

test('人设副本新鲜：绑定态与人设本体都如实给出', () => {
  const mirrors = personaMirrors([{ accountId: 'a1', personaText: 'p', soul: SOUL }]);
  assert.equal(personaBindingFor(mirrors, 'a1'), 'bound');
  assert.deepEqual(requirePersonaSoul(mirrors, 'a1'), SOUL);
});

test('副本新鲜但账号不在名册里 ⇒ unbound（这是真结论，不是缺席）', () => {
  const mirrors = personaMirrors([{ accountId: 'a1', personaText: 'p', soul: SOUL }]);
  assert.equal(personaBindingFor(mirrors, 'a2'), 'unbound');
  assert.throws(() => requirePersonaSoul(mirrors, 'a2'), /no_persona/);
});

test('副本一次都没到位 ⇒ 绑定态 unknown，MUST NOT 答 unbound', () => {
  const mirrors = new AutomationSyncReadMirrors('dev', () => 1_000_000);
  assert.equal(
    personaBindingFor(mirrors, 'a1'),
    'unknown',
    '答 unbound 会把人设弹窗弹给一个其实绑好了的账号，也会让冷待机把正常会话撕断',
  );
});

test('副本陈旧 ⇒ 绑定态退成 unknown、取人设具名抛，MUST NOT 回落任何默认人设', () => {
  const rows = [{ accountId: 'a1', personaText: 'p', soul: SOUL }];
  const fresh = personaMirrors(rows);
  const stale = personaMirrors(rows, { asOf: 1_000, readAt: 1_000 + FRESH_MS + 1 });

  // 先确认新鲜那一份读得出来 —— 否则下面测到的可能是「这条流本来就没到位」。
  assert.equal(personaBindingFor(fresh, 'a1'), 'bound');

  assert.equal(
    personaBindingFor(stale, 'a1'),
    'unknown',
    '陈旧 ≠ 未绑：答 unbound 会让人设弹窗弹给一个其实绑好了的账号',
  );
  assert.throws(
    () => requirePersonaSoul(stale, 'a1'),
    /persona_mirror_not_ready/,
    '「以默认人设跑一整天」是静默假成功里代价最高的一种',
  );
});

test('某个账号的人设载荷形状不对 ⇒ 只有它具名抛，MUST NOT 当成一个可用的 soul 交下去', () => {
  // **实测得到的分工，写下来免得下一手再推一遍**：生产路径上载荷先过组装根那道信封校验
  // （`isSyncReadFactPayload`），这里绕开它直接喂镜像，正是为了测**最后一道**守卫。
  // 两道都在的意义是：契约哪天放宽了、或者属主发出一份校验器认得、角色却用不了的 soul，
  // 也不会变成「拿着半个 soul 去撰写」。
  const mirrors = personaMirrors([
    { accountId: 'a1', personaText: 'p', soul: SOUL },
    { accountId: 'a2', personaText: 'p', soul: { identity: { name: '乙' } } },
  ]);
  assert.throws(
    () => requirePersonaSoul(mirrors, 'a2'),
    /persona_soul_malformed/,
    '缺字段的 soul MUST NOT 当成能用的交给角色',
  );
  // 同一份快照里正常的那个账号照常可用 —— 这条守卫是**按账号**的，不是把整份掀翻。
  assert.deepEqual(requirePersonaSoul(mirrors, 'a1'), SOUL);
});

/* ───────────────────────────── 结构断言：行为测试看不见的那几条 */

test('结构断言：装配不许整体类型逃逸（那会把属主契约漂移直接静音）', () => {
  const code = codeOf(MAIN);
  assert.equal(
    /\bas never\b/.test(code),
    false,
    '首版写了 29 处 `as never`，去掉之后编译器当场点名 5 处**真的接错了**'
      + '（两处授权口接成了发布日志、记账口形状不对、信封没收窄、首作进度字段形状不同）',
  );
  assert.equal(/\bas unknown as\b/.test(code), false, '双跳强转绕开的正是同一个机制');
});

test('结构断言：关停 MUST NOT 调那一族「关的是共享属主池」的存储', () => {
  const code = codeOf(MAIN);
  // 判据是「它关的是谁的池」：这一族的 close() 内部是裸 pool.end()，而池是注入进来的
  // 共享属主池 —— 调一次就打死本进程其余十几个存储。同一族里另一半带 ownsPool 守卫、安全，
  // **而调用点看不出这个区别**，所以钉在结构上。
  for (const forbidden of [
    'facebookGroupTargets.close',
    'facebookGroupMemberships.close',
    'facebookGroupJoinAudit.close',
    'facebookCommentAudit.close',
  ]) {
    assert.equal(
      code.includes(forbidden),
      false,
      `${forbidden}() 关的是注入进来的共享属主池，调它 = 打死整个进程`,
    );
  }
});

test('结构断言：schema 契约门 MUST 在建属主池之前，且 MUST NOT 被 try/catch 吞掉', () => {
  // ⚠️ **只看函数体**。第一版把锚点打在整个文件上，量到的是那条 `import` ——
  // 于是把门挪到建池之后，用例照样全绿（当场变异实测）。这正是本 change 记过的那条：
  // 结构断言别按整文件匹配，锚点要落在真正的构造块里。
  const body = codeOf(MAIN).split('export async function runAutomationMain')[1] ?? '';
  const gateAt = body.indexOf('runAutomationStartupSchemaGate');
  const poolAt = body.indexOf('new pg.Pool(');
  assert.ok(gateAt > 0 && poolAt > 0, '两处锚点都要在函数体里');
  assert.ok(
    gateAt < poolAt,
    '门 MUST 跑在任何存储 init 之前 —— 建了池再判，判出来也已经晚了',
  );
  const code = body;
  // 门自己会抛；包 try/catch 等于恢复「schema 落后照样启动」的静默假成功。
  const gateStatement = code.slice(gateAt - 400, gateAt);
  assert.equal(
    /try\s*\{[^}]*$/.test(gateStatement),
    false,
    '门 MUST NOT 被 try/catch 包住（fail-closed 是它的全部价值）',
  );
});

test('结构断言：人设判定按引用取共享那一份，不许各处再写一遍', () => {
  // **正向委托判据**：写成「没有同名的本地定义」当场会被改名绕过（本 change 实测过）。
  for (const [file, symbol] of [
    ['../../src/automation-publish-dispatch.ts', 'personaBindingFor'],
    [MAIN, 'personaBindingFor'],
    [MAIN, 'requirePersonaSoul'],
  ] as const) {
    const code = codeOf(file);
    assert.match(
      code,
      new RegExp(`\\b${symbol}\\s*\\(`),
      `${file} MUST 调到共享的 ${symbol}：这个判断在本进程至少三处要问，`
        + '各写一份的现形方式不是报错，是某天只改了其中一份',
    );
  }
});

test('结构断言：可执行入口在本片仍然 fail-closed（切成真启动属第 4 段）', () => {
  const code = codeOf('../../src/automation-composition-root.ts');
  assert.match(
    code,
    /export async function runAutomationEntry[\s\S]{0,400}throw new AutomationRootNotReadyError/,
    '台账清零之前，入口 MUST 照旧读完配置就抛「未就绪」——'
      + '本片交付的是「这套装配可以被真的调起来并测试」，不是「进程能启动」',
  );
  assert.equal(
    code.includes('runAutomationMain'),
    false,
    '入口 MUST NOT 直接改调真装配：那等于绕过那道闸，而闸是中间态唯一的保护罩',
  );
});
