import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptchaCoordinator } from '../src/comm/captcha-coordinator.js';
import { FB_THROTTLE_PHRASES, isFacebookThrottleText } from '../src/comm/facebook-throttle-signals.js';
import { RiskController } from '../src/risk/index.js';
import type { RiskQuotaLevel, RiskState, RiskStatus } from '../src/risk/index.js';
import type { CaptchaDetectedPayload } from '../src/comm/protocol.js';

// change account-nurture-discipline-spine §3：FB 软阻断/限流浮层 → 激进退避（restricted）。
// 纯云端、复用既有 CaptchaDetectedPayload/overlay.text、不改协议。

const NOW = 1_000_000_000_000;

const state = (status: RiskStatus, quotaLevel: RiskQuotaLevel): RiskState => ({
  accountId: 'a',
  status,
  quotaLevel,
  signalCount: 0,
  lastSignalAt: null,
  statusSince: 0,
  updatedAt: 0,
});

test('isFacebookThrottleText：命中 FB 限流文案（大小写/智能引号/多空格无关）', () => {
  assert.equal(isFacebookThrottleText('Action Blocked'), true);
  assert.equal(isFacebookThrottleText('We limit how often you can do this.'), true);
  assert.equal(isFacebookThrottleText("You can't use this feature right now"), true);
  assert.equal(isFacebookThrottleText('You’re temporarily blocked'), true); // 智能引号
  assert.equal(isFacebookThrottleText('It looks like you were misusing this feature'), true);
  assert.equal(isFacebookThrottleText('你暂时无法使用此功能'), true);
  assert.equal(isFacebookThrottleText('ACTION   BLOCKED'), true); // 多空格 + 大写
});

test('isFacebookThrottleText：非限流文案与空值 → false（不臆断）', () => {
  assert.equal(isFacebookThrottleText('请完成拼图验证'), false);
  assert.equal(isFacebookThrottleText('Log in to continue'), false);
  assert.equal(isFacebookThrottleText(''), false);
  assert.equal(isFacebookThrottleText(undefined), false);
  assert.equal(isFacebookThrottleText(null), false);
});

test('词库非空且均为归一化小写（无撇号、无变音符）', () => {
  assert.ok(FB_THROTTLE_PHRASES.length > 0);
  for (const p of FB_THROTTLE_PHRASES) {
    assert.equal(p, p.toLowerCase());
    assert.ok(!p.includes("'"), `phrase 含撇号未归一: ${p}`);
    // 词条不经 normalize()、靠人工保证已归一 ⇒ 一条带变音符的词条会**永不命中**且无任何报错
    // （change fb-throttle-popup-fr-copy）。此断言是防止那种静默死条目的机械闸。
    assert.equal(
      p.normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
      p,
      `phrase 含变音符未归一（将永不命中）: ${p}`,
    );
  }
});

function makeCoordinator(controller: RiskController): CaptchaCoordinator {
  return new CaptchaCoordinator({
    resolveController: async () => controller,
    resolveChatId: async () => '',
    logger: { error() {}, warn() {}, log() {} },
    clock: () => NOW,
  });
}

const detected = (over: Partial<CaptchaDetectedPayload>): CaptchaDetectedPayload => ({
  kind: 'unknown',
  accountId: 'a',
  ...over,
});

const overlay = (text: string) => ({ kind: 'unknown' as const, capturedAt: NOW, text, candidates: [] });

test('协调器：unknown 阻断 + FB 限流文案 → 升级 restricted（激进退避）', async () => {
  const controller = new RiskController({ initialState: state('normal', 'normal'), clock: () => NOW });
  const coord = makeCoordinator(controller);
  await coord.onDetected(
    detected({ kind: 'unknown', overlay: overlay("You can't use this feature right now") }),
    { edgeId: 'e', accountId: 'a' } as never,
  );
  assert.equal(controller.getState().status, 'restricted');
});

test('协调器：unknown 阻断 + 非限流文案 → 仍 warned（回归护栏，不误升级）', async () => {
  const controller = new RiskController({ initialState: state('normal', 'normal'), clock: () => NOW });
  const coord = makeCoordinator(controller);
  await coord.onDetected(
    detected({ kind: 'unknown', overlay: overlay('请完成拼图验证') }),
    { edgeId: 'e', accountId: 'a' } as never,
  );
  assert.equal(controller.getState().status, 'warned');
});

test('协调器：kind=captcha → restricted（既有行为不变）', async () => {
  const controller = new RiskController({ initialState: state('normal', 'normal'), clock: () => NOW });
  const coord = makeCoordinator(controller);
  await coord.onDetected(detected({ kind: 'captcha' }), { edgeId: 'e', accountId: 'a' } as never);
  assert.equal(controller.getState().status, 'restricted');
});

// ——— change fb-throttle-popup-zh-frequency-copy ———

const ZH_FREQUENCY_POPUP = '为让社群免受垃圾信息打扰，我们限制了你发帖、评论或执行其他操作的频率。你可以稍后再试。';

test('中文「频率」框架限流文案命中词库（本 change 的主因缺口）', () => {
  assert.equal(isFacebookThrottleText(ZH_FREQUENCY_POPUP), true);
  // 「您」变体 + 「社区」地区差异 + 半角标点转录变体
  assert.equal(
    isFacebookThrottleText('为让社区免受垃圾信息打扰,我们限制了您发帖、评论或执行其他操作的频率.'),
    true,
  );
});

test('词条纪律：正常页面的裸词「限制」/「频率」绝不命中', () => {
  // 误报代价不对称：命中一次 → restricted → 钉住恢复窗且不自动回滚、只能人工恢复。
  assert.equal(isFacebookThrottleText('本群规则：请勿刷屏。管理员有权限制发帖频率，违者移出群组。'), false);
  assert.equal(isFacebookThrottleText('你可以在设置中调整通知的频率。'), false);
  assert.equal(isFacebookThrottleText('我们限制了广告的展示频率以改善你的体验。'), false);
});

test('词条集合锁：中文「频率」框架三条须与边缘 FB_THROTTLE_ZH_FREQUENCY_PHRASES 逐条一致', () => {
  // 两仓无共享模块 ⇒ 本断言是唯一防漂移手段。边缘 test/facebook/overlay.test.ts 镜像同一份表。
  const zhFrequency = FB_THROTTLE_PHRASES.filter((p) => p.includes('频率') || p.includes('发帖'));
  assert.deepEqual([...zhFrequency], ['我们限制了你发帖', '我们限制了您发帖', '执行其他操作的频率']);
});

test('词库不含 we removed your（过于宽泛，陈年内容删除通知会误把账号打进 restricted）', () => {
  assert.equal(FB_THROTTLE_PHRASES.includes('we removed your'), false);
  assert.equal(isFacebookThrottleText('We removed your post because it goes against our Community Standards.'), false);
});

interface SentCard {
  chatId: string;
  card: unknown;
}
interface RaisedAlert {
  severity: string;
  type: string;
  title: string;
  edgeId?: string;
}

function makeAlertingCoordinator(
  controller: RiskController,
  sink: { cards: SentCard[]; alerts: RaisedAlert[] },
  clock: () => number = () => NOW,
): CaptchaCoordinator {
  return new CaptchaCoordinator({
    resolveController: async () => controller,
    // 现有测试把 messenger 打成 undefined、resolveChatId 返回 ''，maybeAlert 第一行即 return
    // ⇒ 告警分支零覆盖、改动会假绿上线。此处给真实消息通道与目标群。
    resolveChatId: async () => 'oc_test_chat',
    sendAlertCard: async (chatId: string, alert: unknown) => {
      sink.cards.push({ chatId, card: alert });
      return undefined as never;
    },
    alertStore: {
      raise: async (a: RaisedAlert) => {
        sink.alerts.push(a);
        return undefined as never;
      },
      resolveByEdge: async () => 0,
    } as never,
    logger: { error() {}, warn() {}, log() {} },
    clock,
  });
}

test('告警：确认的限流 → P0 + 独立 type=fb_throttle + 专属标题（运营可辨、面板可过滤）', async () => {
  const controller = new RiskController({ initialState: state('normal', 'normal'), clock: () => NOW });
  const sink = { cards: [] as SentCard[], alerts: [] as RaisedAlert[] };
  const coord = makeAlertingCoordinator(controller, sink);

  await coord.onDetected(
    detected({ kind: 'unknown', overlay: overlay(ZH_FREQUENCY_POPUP) }),
    { edgeId: 'e', accountId: 'a' } as never,
  );

  assert.equal(controller.getState().status, 'restricted', '限流须真刹车，不是降速');
  assert.equal(sink.alerts.length, 1);
  assert.equal(sink.alerts[0].severity, 'P0');
  assert.equal(sink.alerts[0].type, 'fb_throttle');
  assert.equal(sink.alerts[0].title, 'Facebook 限流阻断');
  assert.equal(sink.cards.length, 1, '飞书卡须发出');
  assert.equal(sink.cards[0].chatId, 'oc_test_chat');
});

test('告警：未命中判据的未知遮罩仍走泛化 P1 + block（既有行为不变）', async () => {
  const controller = new RiskController({ initialState: state('normal', 'normal'), clock: () => NOW });
  const sink = { cards: [] as SentCard[], alerts: [] as RaisedAlert[] };
  const coord = makeAlertingCoordinator(controller, sink);

  await coord.onDetected(
    detected({ kind: 'unknown', overlay: overlay('某个说不上来的浮层') }),
    { edgeId: 'e', accountId: 'a' } as never,
  );

  assert.equal(sink.alerts[0].severity, 'P1');
  assert.equal(sink.alerts[0].type, 'block');
  assert.equal(sink.alerts[0].title, '未知阻断弹窗');
});

test('告警：验证码仍 P0 + captcha（既有行为不变）', async () => {
  const controller = new RiskController({ initialState: state('normal', 'normal'), clock: () => NOW });
  const sink = { cards: [] as SentCard[], alerts: [] as RaisedAlert[] };
  const coord = makeAlertingCoordinator(controller, sink);

  await coord.onDetected(detected({ kind: 'captcha' }), { edgeId: 'e', accountId: 'a' } as never);

  assert.equal(sink.alerts[0].severity, 'P0');
  assert.equal(sink.alerts[0].type, 'captcha');
});

test('冷却不跨类型吞没：先验证码后限流，限流照发且 alerts 记录落库', async () => {
  // 冷却此前按 edge 不分类型 ⇒ 10min 窗内先到验证码告警会把限流告警整条吞掉；又因落库在冷却闸之后，
  // 连 alerts 记录都不落。分维后两者同时修好。
  const controller = new RiskController({ initialState: state('normal', 'normal'), clock: () => NOW });
  const sink = { cards: [] as SentCard[], alerts: [] as RaisedAlert[] };
  const coord = makeAlertingCoordinator(controller, sink);

  await coord.onDetected(detected({ kind: 'captcha' }), { edgeId: 'e', accountId: 'a' } as never);
  await coord.onDetected(
    detected({ kind: 'unknown', overlay: overlay(ZH_FREQUENCY_POPUP) }),
    { edgeId: 'e', accountId: 'a' } as never,
  );

  assert.equal(sink.alerts.length, 2, '两种类型各自成告警，绝不互相吞没');
  assert.deepEqual(sink.alerts.map((a) => a.type), ['captcha', 'fb_throttle']);
  assert.equal(sink.cards.length, 2);
});

test('同类型冷却行为不变：窗内第二次同类型告警仍被去重', async () => {
  const controller = new RiskController({ initialState: state('normal', 'normal'), clock: () => NOW });
  const sink = { cards: [] as SentCard[], alerts: [] as RaisedAlert[] };
  const coord = makeAlertingCoordinator(controller, sink);

  await coord.onDetected(
    detected({ kind: 'unknown', overlay: overlay(ZH_FREQUENCY_POPUP) }),
    { edgeId: 'e', accountId: 'a' } as never,
  );
  await coord.onDetected(
    detected({ kind: 'unknown', overlay: overlay(ZH_FREQUENCY_POPUP) }),
    { edgeId: 'e', accountId: 'a' } as never,
  );

  assert.equal(sink.alerts.length, 1, '同类型仍走既有去重冷却');
});

test('冷却分维不同 edge 互不影响（既有语义保持）', async () => {
  const controller = new RiskController({ initialState: state('normal', 'normal'), clock: () => NOW });
  const sink = { cards: [] as SentCard[], alerts: [] as RaisedAlert[] };
  const coord = makeAlertingCoordinator(controller, sink);

  await coord.onDetected(
    detected({ kind: 'unknown', overlay: overlay(ZH_FREQUENCY_POPUP) }),
    { edgeId: 'e1', accountId: 'a' } as never,
  );
  await coord.onDetected(
    detected({ kind: 'unknown', overlay: overlay(ZH_FREQUENCY_POPUP) }),
    { edgeId: 'e2', accountId: 'a' } as never,
  );

  assert.equal(sink.alerts.length, 2);
});

test('cleared 清冷却：分维键下仍能清干净（否则清除后新事件被旧冷却压住）', async () => {
  const controller = new RiskController({ initialState: state('normal', 'normal'), clock: () => NOW });
  const sink = { cards: [] as SentCard[], alerts: [] as RaisedAlert[] };
  const coord = makeAlertingCoordinator(controller, sink);

  await coord.onDetected(
    detected({ kind: 'unknown', overlay: overlay(ZH_FREQUENCY_POPUP) }),
    { edgeId: 'e', accountId: 'a' } as never,
  );
  assert.equal(sink.alerts.length, 1);

  await coord.onCleared({ edgeId: 'e', accountId: 'a' } as never, { edgeId: 'e', accountId: 'a' } as never);

  // 冷却窗未过，但 cleared 已清记录 ⇒ 新事件必须能再次告警。
  await coord.onDetected(
    detected({ kind: 'unknown', overlay: overlay(ZH_FREQUENCY_POPUP) }),
    { edgeId: 'e', accountId: 'a' } as never,
  );
  assert.equal(sink.alerts.length, 2, 'cleared 后冷却须清干净（分维键不能漏删）');
});

// ——— change fb-throttle-popup-fr-copy ———

/** FB 法语软阻断弹窗的真实文案（带完整重音与撇号），本 change 的主因缺口。 */
const FR_SECURITY_CHECK_POPUP = [
  "Cette fonctionnalité n'est pas disponible.",
  'Un contrôle de sécurité est requis pour continuer.',
  "Si vous pensez que ceci ne va pas à l'encontre des Standards de la communauté, dites-le nous.",
  'OK',
].join(' ');

test('法语软阻断文案命中词库（本 change 的主因缺口）', () => {
  assert.equal(isFacebookThrottleText(FR_SECURITY_CHECK_POPUP), true);
});

test('法语处置与英语处置等价（同一弹窗不因界面语言分叉）', () => {
  const en = [
    "This feature isn't available.",
    'A security check is required to continue.',
    "If you think this doesn't go against our Community Standards, let us know.",
    'OK',
  ].join(' ');
  assert.equal(isFacebookThrottleText(en), true, '英文版今天已命中（回归护栏）');
  assert.equal(isFacebookThrottleText(FR_SECURITY_CHECK_POPUP), isFacebookThrottleText(en));
});

test('变音符归一：预组合 / 组合序列 / 重音丢失三种形式匹配结果一致', () => {
  // ① 预组合形式（U+00E9 等）——上面的 FR_SECURITY_CHECK_POPUP 即是
  assert.equal(isFacebookThrottleText(FR_SECURITY_CHECK_POPUP.normalize('NFC')), true);
  // ② 组合序列形式（'e' + U+0301）：页面 innerText 用哪种不受我们控制，字面比较不相等
  assert.equal(isFacebookThrottleText(FR_SECURITY_CHECK_POPUP.normalize('NFD')), true);
  // ③ 重音整体丢失（文案取证经截图转录的典型损耗）
  assert.equal(isFacebookThrottleText('Un controle de securite est requis pour continuer.'), true);
  assert.equal(isFacebookThrottleText("Cette fonctionnalite n'est pas disponible."), true);
  // 注：OCR 把 ô 误认成别的字母（contrale）属**字符识别错误**、非变音符丢失，不在本归一的承诺范围内。
});

test('词条纪律：法语申诉话术绝不命中（陈年违规通知会误把账号打进 restricted）', () => {
  // 「如果你认为这不违反社群规范，请告知我们」附在一切违规告知之后，包括通知中心里的陈年内容删除通知。
  // 与 'we removed your' 被删的理由完全同源。
  assert.equal(
    isFacebookThrottleText(
      "Si vous pensez que ceci ne va pas à l'encontre des Standards de la communauté, dites-le nous.",
    ),
    false,
  );
  assert.equal(
    isFacebookThrottleText(
      'Nous avons supprimé votre publication car elle ne respecte pas nos Standards de la communauté.',
    ),
    false,
  );
});

test('词条纪律：不带「est requis」限定的裸短语绝不命中（设置页里是功能名）', () => {
  assert.equal(isFacebookThrottleText('Contrôle de sécurité'), false);
  assert.equal(
    isFacebookThrottleText('Contrôle de sécurité — vérifiez les paramètres de sécurité de votre compte.'),
    false,
  );
  assert.equal(isFacebookThrottleText('Cette option est disponible dans vos paramètres.'), false);
});

test('词条集合锁：法语两条须与边缘 FB_THROTTLE_FR_PHRASES 逐条一致', () => {
  // 两仓无共享模块 ⇒ 本断言是唯一防漂移手段。边缘 test/facebook/overlay.test.ts 镜像同一份表。
  const fr = FB_THROTTLE_PHRASES.filter((p) => p.includes('controle') || p.includes('fonctionnalite'));
  assert.deepEqual(
    [...fr],
    ['controle de securite est requis', 'cette fonctionnalite nest pas disponible'],
  );
});

test('协调器：法语软阻断 → 与英语版同样升级 restricted（端到端等价）', async () => {
  const controller = new RiskController({ initialState: state('normal', 'normal'), clock: () => NOW });
  const coord = makeCoordinator(controller);
  await coord.onDetected(
    detected({ kind: 'unknown', overlay: overlay(FR_SECURITY_CHECK_POPUP) }),
    { edgeId: 'e', accountId: 'a' } as never,
  );
  assert.equal(controller.getState().status, 'restricted');
});
