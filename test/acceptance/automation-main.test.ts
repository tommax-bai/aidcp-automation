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

test('结构断言：能力旗标 MUST 读部署配置，不许恒 true', () => {
  // 本片第一版把文字卡转写客户端的「本地旗标」写成恒 `true`，理由写的是「能力在不在由属主答」——
  // 那句话本身是错的：`enabled()` 是角色用来决定**要不要发起转写**的那一问。
  // 恒 true 有两个后果，都不报错：① 每篇笔记都去调一条对面今天还没服务的路由；
  // ② 两侧旗标对账永远比不出差异，而那条告警的全部价值就在于比。
  const code = codeOf(MAIN);
  assert.match(
    code,
    /AIDCP_TEXTCARD_OCR/,
    '本地旗标 MUST 读与属主进程同一份部署配置（两侧读同一个变量才比得出不一致）',
  );
  assert.equal(
    /TextCardTranscriptionAuthorityHttpClient\([\s\S]{0,400}?\(\)\s*=>\s*true/.test(code),
    false,
    '恒 true 会把「这台机器没开这个能力」变成一串失败调用',
  );
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

test('结构断言：调度启停真翻转时 MUST 真启停各连接，且在线数取实测', () => {
  // 这条守的是「开关变成一个只用于显示的布尔」。三个判据都不报错、只是行为悄悄没了：
  // ① 不调启停 ⇒ 面板说停了、各连接照跑；
  // ② `changed` 现算成 true ⇒ 「我请求了所以变了」，而它是**观测值**；
  // ③ 在线数写死或乐观 ⇒ 运营据此判断有没有生效，写死等于给一个假答案。
  const body = codeOf(MAIN).split('export async function runAutomationMain')[1] ?? '';
  const i = body.indexOf('registerAutomationDispatchCommandRoutes');
  assert.ok(i > 0, '本进程 MUST 自己注册这条路由 —— 组装根只注册三个成对指令接收方');
  const block = body.slice(i, i + 1_600);
  assert.match(block, /runtimes\.startAll\(\)/, '真翻转到 start 时 MUST 真的把各连接起起来');
  assert.match(block, /runtimes\.endAll\(/, '真翻转到 stop 时 MUST 真的把各连接停掉');
  assert.match(
    block,
    /changed\s*=\s*dispatchActive\s*!==\s*want/,
    '`changed` MUST 是观测值（翻转前后比出来的），不是「我请求了所以变了」',
  );
  assert.match(block, /onlineEdgeCount\(\)/, '在线边缘数 MUST 取实测，绝不乐观');
});

test('结构断言：入口切成真启动之后，那道就绪闸仍在、且顺序没被换', () => {
  // 台账清零那一批把入口从 fail-closed 切成真启动。**闸没有被删，只是不再恒真** ——
  // 这条守的是三件事：
  // ① 闸还在（`assertAutomationRootReady`），不是被注释掉换成一句「已经清零了」；
  // ② 顺序没换：**先读配置、再过闸、最后才真装配**。反过来会让一个缺配置的进程先去抢
  //    风控写者锁再失败退出，而那把锁是会话级的 —— 抢完就死等于让下一个真进程排队等它；
  // ③ 装配是**动态 import** 进来的：入口模块被别处 import 时（用例、工具）不该顺带把
  //    整张装配图拉起来。
  const code = codeOf('../../src/automation-composition-root.ts');
  const entry = code.slice(code.indexOf('export async function runAutomationEntry'));
  const body = entry.slice(0, entry.indexOf('\n}'));
  const readAt = body.indexOf('readAutomationRootConfig(env)');
  const gateAt = body.indexOf('assertAutomationRootReady()');
  const mainAt = body.indexOf('runAutomationMain(');
  assert.ok(readAt >= 0, '入口 MUST 先读配置');
  assert.ok(gateAt > readAt, '就绪闸 MUST 在读配置之后');
  assert.ok(mainAt > gateAt, '真装配 MUST 在闸之后 —— 闸是最后一道拦得住启动的东西');
  assert.match(body, /await import\('\.\/automation-main\.js'\)/, '装配 MUST 动态引入');
});

test('结构断言：委托任务控制面两条路由都注册，且目标校验两个钩子都在', () => {
  // 这条守的是本 change 的红线形态：**省掉钩子把服务先接上**。
  // 少了钩子什么都不报错 —— 确认卡照发、任务照建，等真去执行时才发现目标不对，
  // 而那时离下指令已经过去很久，运营看到的是一次莫名其妙的失败。
  const body = codeOf(MAIN).split('export async function runAutomationMain')[1] ?? '';
  const i = body.indexOf('new PgDelegatedTaskStore');
  assert.ok(i > 0, '委托任务存储 MUST 由本进程自己建（属主池）');
  const block = body.slice(i);

  assert.match(block, /registerDelegatedTaskRoutes\(/, '既有 7 方法那条路由 MUST 注册');
  assert.match(
    block,
    /registerDelegatedTaskTextCommandRoutes\(/,
    '自由文本委托那条路由 MUST 注册 —— 只注册 7 方法的话 `/delegate` 仍然到不了本进程',
  );
  assert.match(block, /prepareTarget:/, '建卡前的目标快照 MUST 在');
  assert.match(block, /validateTarget:/, '确认时的目标复核 MUST 在');
});

test('结构断言：精选目标校验走受鉴权那条读，且分得出「库不可用」与「这行不存在」', () => {
  // 走裸那条读会让跨进程后的缺表错误只剩一个普通传输错误：
  // `isCuratedContentUnavailableError` 恒 false ⇒「库暂时不可用」被如实报成
  //「目标不存在或不属于该账号」。那句是谎，且编译期与测试都看不见。
  const body = codeOf(MAIN).split('export async function runAutomationMain')[1] ?? '';
  assert.match(
    body,
    /new CuratedTargetAuthorityHttpClient\(/,
    '精选目标校验 MUST 走受鉴权那一族（它按码还原成 ContentPortError）',
  );
  assert.equal(
    /CuratedContentHttpClient\b/.test(body),
    false,
    '裸形态那条客户端不做错误还原，接上它等于把「库不可用」永久改写成「这行不存在」',
  );
  // 归类 MUST 用 kernel 那个**两类抛出物都认**的函数：只认本地错误类跨进程恒 false。
  assert.match(body, /curatedContentFailureReason\(/);
  assert.match(
    body,
    /code:\s*'curated_content_unavailable'/,
    '库不可用要有自己的原因码，MUST NOT 复用「目标不存在 / 已变化」那两句',
  );
});

test('结构断言：账号候选取共享那一份翻译，不许在装配里再拼一遍', () => {
  // 复制一份出来的那一刻两份行为完全一致；漂开的现形时刻是「按昵称选号」真被用到那一次，
  // 而那条路径平时几乎不跑。
  const body = codeOf(MAIN).split('export async function runAutomationMain')[1] ?? '';
  assert.match(
    body,
    /listAccounts:\s*\(\)\s*=>\s*listDelegatedAccountCandidates\(apiClients\.accountRoster\)/,
    '候选清单 MUST 正向委托给共享翻译，并从 4a 花名册端口取目录',
  );
  assert.equal(
    /displayName:\s*[^,\n]*\bnames:/.test(body.replace(/\n/g, ' ')),
    false,
    '装配里 MUST NOT 自己拼候选行',
  );
});

test('结构断言：幂等台账单独 try，且失败时换成具名 fail-closed 台账', () => {
  // 并进委托控制面那条链的后果：台账表出问题会把**既有 7 方法**（压根不用台账）一起掐掉，
  // 把一个无关能力的故障放大成一片。
  const body = codeOf(MAIN).split('export async function runAutomationMain')[1] ?? '';
  const i = body.indexOf('new PgOperatorCommandLedger');
  assert.ok(i > 0, '台账 MUST 由本进程自己建');
  const before = body.slice(Math.max(0, i - 200), i);
  assert.match(before, /try\s*\{/, '台账 MUST 单独 try，不与委托存储共用一个');
  assert.match(
    body.slice(i, i + 800),
    /unavailableOperatorCommandLedger\(/,
    '台账不可用时 MUST 换成具名 fail-closed 台账，MUST NOT 让委托控制面整体缺席',
  );
});

test('结构断言：发布授权客户端 MUST 用授权专用令牌，不许拿通用 api 令牌顶替', () => {
  // 这条守的是一种**只有真跑两个进程才现形**的接线错：接口进程给授权权威与授权决定写那两组路由
  // 挂的是 `AIDCP_PUBLISH_APPROVAL_INTERNAL_TOKEN`，与 `AIDCP_API_INTERNAL_TOKEN` 是两个 env、
  // 没有互相回落。拿错令牌 ⇒ 每一次授权读写都被判未授权，而这件事编译得过、两仓测试各自全绿。
  // 现形方式还特别坏：调用方读到的是「授权读不出来」，一个很容易被当成业务原因的说法。
  const body = codeOf(MAIN).split('export async function runAutomationMain')[1] ?? '';
  const i = body.indexOf('new PublishApprovalAuthorityHttpClient');
  assert.ok(i > 0, '发布授权权威客户端 MUST 由本进程构造');
  const block = body.slice(i, i + 300);
  assert.match(
    block,
    /config\.publishApprovalInternalToken/,
    '授权客户端 MUST 取授权专用令牌',
  );
  assert.doesNotMatch(
    block,
    /config\.apiInternalToken/,
    '通用 api 令牌调不动授权那两组路由 —— 两侧是同一个 env 才对得上',
  );
});

test('结构断言：委托任务执行泵 MUST 在业务入口放行之后才起，且缺席具名', () => {
  // 三件都不报错、只是能力悄悄没有或悄悄做错的事：
  // ① 泵在构造期就起 ⇒ 一个还没放行的进程去认领任务，而认领带租约 —— 认了不干活，
  //    那条任务要等租约过期才轮得到别人；
  // ② 触发器缺席时静默 ⇒「确认了却永远不跑」与「队列里暂时没任务」完全同形；
  // ③ 按配置禁用时也静默 ⇒ 与「没建起来」现象一样，运营查不出是哪一种。
  const body = codeOf(MAIN).split('export async function runAutomationMain')[1] ?? '';
  const construct = body.indexOf('new DelegatedTaskWorker(');
  const startCall = body.indexOf('delegatedTaskWorker.start(');
  assert.ok(construct > 0, '委托任务执行器 MUST 由本进程构造');
  assert.ok(startCall > construct, '泵 MUST 在构造之后、且在业务入口那一段里才起');
  const ingress = body.slice(body.indexOf('const businessIngress'));
  assert.match(ingress, /delegatedTaskWorker\.start\(/, '泵 MUST 起在业务入口的 start() 里');
  assert.match(ingress, /delegatedTaskWorker\?\.stop\(\)/, 'stop() MUST 把泵一起停掉');
  assert.match(
    body,
    /DelegatedTaskWorker 未建（发帖触发器缺席）/,
    '触发器缺席 MUST 具名说出口，绝不静默',
  );
  assert.match(
    body,
    /DelegatedTaskWorker 已按配置禁用/,
    '按配置禁用也 MUST 说出口 —— 与「没建起来」现象一样但原因不同',
  );
});

test('结构断言：候选稿版本对不上时 MUST 只回读、不写授权决定', () => {
  // 这条守的是「给旧稿盖章」：批准/驳回都要先比 contentVersion，不一致就照原样回读。
  // 少了这一比不会报错 —— 它会在「稿子刚被改过、委托任务才轮到」那一刻把决定写到旧版本上。
  const body = codeOf(MAIN).split('export async function runAutomationMain')[1] ?? '';
  const router = body.slice(body.indexOf('createDelegatedExecutorRouter('));
  const guards = router.match(/draft\.contentVersion !== candidate\.contentVersion/g) ?? [];
  assert.equal(guards.length, 2, '批准与驳回**两条**都 MUST 比版本');
  assert.match(
    router,
    /preflightApprovePublish\(requestId\)/,
    '批准前 MUST 过属主那道预检，MUST NOT 直接写决定',
  );
  assert.match(
    router,
    /writeApprovalDecision\(requestId, true, draft, decidedBy\)/,
    '批准 MUST 经 api 属主那条授权决定口写，且 decidedBy 传真实决策主体',
  );
  assert.match(
    body,
    /publishApprovalDecisionWriter\.writeDecision\(/,
    '本进程 MUST NOT 自己碰授权表 —— 只能经属主那条口',
  );
});
