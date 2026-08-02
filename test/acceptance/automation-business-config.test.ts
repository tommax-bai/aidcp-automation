// aidcp:test-owner=derived
/**
 * 四个业务配置取值口（批 H 第一片）。
 *
 * 这一片本身没有判定 —— 判定全在公共契约层。所以红线全在**取不到快照时往哪边倒**：
 * 排期倒向「完全不自动」、正文方案倒向「说不出」、基线倒向具名 blocker。
 * 外加一条结构判据：这里不许出现第二份解析。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createAutomationBusinessConfigPorts } from '../../src/automation-business-config.js';

const SCHEDULE_ROW = {
  accountId: 'acc-1',
  autoEnabled: true,
  postMode: 'review' as const,
  postDailyCap: 2,
  commentMode: 'auto_approve' as const,
  commentDailyCap: 5,
  contactCommentMode: 'review' as const,
  contactCommentDailyCap: 3,
  activeWeekMask: null,
  contentActiveMask: null,
};

const FB_ROW = {
  accountId: 'acc-1',
  keywords: ['k'],
  containers: [{ url: 'https://g/1' }],
  // 线缆写法是**复数**；顺手比 'template' 会恒 false 且不报错。
  commentMode: 'templates' as const,
  commentModeConfigured: true,
  commentTemplates: ['t1'],
};

function build(over: {
  contentSchedule?: unknown;
  hotLead?: unknown | null;
  facebookComment?: unknown;
  fresh?: boolean;
  globalActiveWeekMask?: string | null;
  baseResolutions?: unknown[];
} = {}) {
  const fresh = over.fresh ?? true;
  const seenResolvers: Array<(id: string) => unknown> = [];
  // **陈旧时仍带着上一份快照** —— 真镜像就是这么行为的（`view.value` 会保留）。
  // 桩里把它置空会让「陈旧要不要用」这条用例变成空的：实测过一次，
  // 把「陈旧就沿用」的变异放进去，11 条全绿。
  const lookup = (value: unknown) =>
    fresh
      ? { state: 'fresh' as const, value, asOf: 1 }
      : { state: 'stale' as const, value, asOf: null };

  const ports = createAutomationBusinessConfigPorts({
    mirrors: {
      businessConfig: ((stream: string) =>
        stream === 'content_schedule'
          ? lookup(over.contentSchedule ?? { global: null, accounts: [SCHEDULE_ROW] })
          : stream === 'hot_lead_config'
            ? lookup(
                over.hotLead === null
                  ? null
                  : over.hotLead ?? {
                      maxAgeHours: 12,
                      velocityMin: 111,
                      minLikeFloor: 222,
                      floorHours: 3,
                    },
              )
            : lookup(over.facebookComment ?? { accounts: [FB_ROW] })) as never,
      facebookOperationBaseFor: ((accountId: string, resolver: (id: string) => unknown) => {
        seenResolvers.push(resolver);
        return { ok: false as const, blocker: `base_for:${accountId}` };
      }) as never,
      facebookEnvironmentForAccount: ((accountId: string) =>
        accountId === 'acc-1'
          ? { ok: true as const, envKey: 'env-1' }
          : { ok: false as const, reason: 'binding_unknown' as const }) as never,
    },
    globalActiveWeekMask: () => over.globalActiveWeekMask ?? null,
  });

  return { ports, seenResolvers };
}

/* ─────── 红线 1：排期快照没到位 ⇒ 按「没有这个账号的行」处置 ─────── */

test('排期快照陈旧 → 全 off（完全不自动），MUST NOT 按上一次的印象继续跑', () => {
  const { ports } = build({ fresh: false });
  const schedule = ports.effectiveScheduleFor('acc-1');
  assert.equal(schedule.autoEnabled, false);
  assert.equal(schedule.postMode, 'off');
  assert.equal(schedule.commentMode, 'off');
  assert.equal(schedule.contactCommentMode, 'off');
  assert.equal(schedule.contactCommentDailyCap, 0);
});

test('快照到位 → 账号行逐项生效', () => {
  const { ports } = build();
  const schedule = ports.effectiveScheduleFor('acc-1');
  assert.equal(schedule.autoEnabled, true);
  assert.equal(schedule.commentMode, 'auto_approve');
  assert.equal(schedule.contactCommentDailyCap, 3);
});

test('快照里没有这个账号 → 同样是完全不自动，不回落到别人的配置', () => {
  const { ports } = build();
  assert.equal(ports.effectiveScheduleFor('acc-unknown').autoEnabled, false);
});

// 掩码是「周内天 x 24 小时」的逐格位串（168 位），不是 7 位 —— 写短了会被判非法并静静回落。
const ALL_ON = '1'.repeat(168);
const ALL_OFF = '0'.repeat(168);

test('活跃周历：账号没配就回落全局，全局也没有就是 null（全周全天）', () => {
  assert.equal(build().ports.effectiveActiveWeekMaskFor('acc-1'), null);
  assert.equal(
    build({ globalActiveWeekMask: ALL_ON }).ports.effectiveActiveWeekMaskFor('acc-1'),
    ALL_ON,
  );
  assert.equal(
    build({
      contentSchedule: {
        global: null,
        accounts: [{ ...SCHEDULE_ROW, activeWeekMask: ALL_OFF }],
      },
      globalActiveWeekMask: ALL_ON,
    }).ports.effectiveActiveWeekMaskFor('acc-1'),
    ALL_OFF,
    '账号覆盖合法即优先',
  );
  assert.equal(
    build({
      contentSchedule: {
        global: null,
        accounts: [{ ...SCHEDULE_ROW, activeWeekMask: '1111100' }],
      },
      globalActiveWeekMask: ALL_ON,
    }).ports.effectiveActiveWeekMaskFor('acc-1'),
    ALL_ON,
    '脏覆盖视作缺失并回落全局，绝不因坏值绕过更严格的全局闸',
  );
});

/* ─────── 红线 2：正文方案陈旧一律 unavailable ─────── */

test('Facebook 评论配置陈旧 → 正文方案 unavailable，既不猜模板也不猜生成式', () => {
  const { ports } = build({ fresh: false });
  assert.equal(ports.facebookCommentBodyScheme('acc-1'), 'unavailable');
});

test('线缆写法 templates 必须还原成领域写法 template —— 顺手比字面量会恒 false 且不报错', () => {
  const { ports } = build();
  assert.equal(ports.facebookCommentBodyScheme('acc-1'), 'template');
  const config = ports.facebookCommentConfigFor('acc-1');
  assert.equal(config.commentMode, 'template');
  assert.deepEqual(config.commentTemplates, ['t1']);
  assert.equal(config.enabled, true);
});

test('没配过的账号按模板（判定的写明处置），不是猜', () => {
  const { ports } = build();
  assert.equal(ports.facebookCommentBodyScheme('acc-none'), 'template');
});

/* ─────── 红线 3：基线的环境解析器按引用取镜像那一份 ─────── */

test('运营基线转给镜像那一份，且喂进去的解析器就是镜像自己的账号→环境键', () => {
  const { ports, seenResolvers } = build();
  assert.deepEqual(ports.facebookOperationBaseFor('acc-1'), {
    ok: false,
    blocker: 'base_for:acc-1',
  });
  assert.equal(seenResolvers.length, 1);
  assert.deepEqual(seenResolvers[0]!('acc-1'), { ok: true, envKey: 'env-1' });
  assert.deepEqual(seenResolvers[0]!('acc-2'), { ok: false, reason: 'binding_unknown' });
});

/* ─────── 热帖阈值：快照就是成品；没到位回落写死默认 ─────── */

const HOT_LEAD = { maxAgeHours: 12, velocityMin: 111, minLikeFloor: 222, floorHours: 3 };

test('热帖阈值取快照成品', () => {
  assert.deepEqual(build().ports.hotLeadGateConfig(), HOT_LEAD);
});

test('陈旧时保留上一份阈值 —— 退回写死默认很可能把闸放宽，方向正好反了', () => {
  assert.deepEqual(build({ fresh: false }).ports.hotLeadGateConfig(), HOT_LEAD);
});

test('一次都没收到过快照才用写死默认（那时没有「上一份」可言）', () => {
  const fallback = build({ fresh: false, hotLead: null }).ports.hotLeadGateConfig();
  assert.ok(fallback.maxAgeHours > 0 && fallback.velocityMin > 0);
  assert.notDeepEqual(fallback, HOT_LEAD);
});

test('返回的是拷贝，调用方改不动镜像里的快照', () => {
  const snapshot = { maxAgeHours: 12, velocityMin: 111, minLikeFloor: 222, floorHours: 3 };
  const { ports } = build({ hotLead: snapshot });
  ports.hotLeadGateConfig().maxAgeHours = 999;
  assert.equal(snapshot.maxAgeHours, 12);
});

/* ─────── 结构：这里不许出现第二份解析 ─────── */

test('本片 MUST 委托到公共契约层的判定，不许自己算', () => {
  const source = readFileSync(
    new URL('../../src/automation-business-config.ts', import.meta.url),
    'utf8',
  )
    // 本文件注释里就写着这条红线，整文件匹配会被自己的注释命中。
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  for (const symbol of [
    'resolveEffectiveContentSchedule',
    'resolveEffectiveActiveWeekMask',
    'resolveEffectiveFacebookCommentConfig',
    'resolveHotLeadGateConfig',
    'facebookCommentModeFromWire',
  ]) {
    assert.match(source, new RegExp(`\\b${symbol}\\s*\\(`), `${symbol} MUST 被真的调到`);
  }
  // 反向：不许在这里出现「账号覆盖 ?? 全局」这类就地解析的形状。
  assert.equal(
    /activeWeekMask\s*\?\?\s*/.test(source),
    false,
    'MUST NOT 在本片就地做账号覆盖回落 —— 那是判定那一份的事',
  );
  assert.equal(
    /===\s*['"]template['"]|===\s*['"]templates['"]/.test(source),
    false,
    'MUST NOT 在本片手比正文模式字面量',
  );
});
