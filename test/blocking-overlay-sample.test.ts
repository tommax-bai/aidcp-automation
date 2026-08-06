import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptchaCoordinator } from '../src/comm/captcha-coordinator.js';
import { overlayTextDigest } from '../src/alerts/blocking-overlay-sample-store.js';
import { RiskController } from '../src/risk/index.js';
import type { RiskQuotaLevel, RiskState, RiskStatus } from '../src/risk/index.js';
import type {
  BlockingOverlaySnapshotPayload,
  CaptchaDetectedPayload,
} from '../src/comm/protocol.js';
import type { AlertData } from '../src/alerts/alert-notification.js';
import type { BlockingOverlaySampleInput } from '../src/alerts/blocking-overlay-sample-store.js';

/**
 * 阻断现场样本留存（change blocking-overlay-dom-capture）。
 *
 * 这批用例锁三件事：样本写入不被告警冷却吞掉、结构不被拍平、以及告警能靠 captureId 回溯到样本
 * （含留存失败时仍如实给出标识）。
 */

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

interface Harness {
  coordinator: CaptchaCoordinator;
  samples: BlockingOverlaySampleInput[];
  alerts: AlertData[];
  warnings: string[];
  errors: string[];
}

function makeHarness(options: {
  recordImpl?: (input: BlockingOverlaySampleInput) => Promise<{ inserted: boolean }>;
  withStore?: boolean;
} = {}): Harness {
  const samples: BlockingOverlaySampleInput[] = [];
  const alerts: AlertData[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const controller = new RiskController({ initialState: state('normal', 'normal'), clock: () => NOW });
  const withStore = options.withStore ?? true;

  const coordinator = new CaptchaCoordinator({
    resolveController: async () => controller,
    resolveChatId: async () => 'chat-1',
    deliverAlert: async (alert) => {
      alerts.push(alert);
    },
    ...(withStore
      ? {
        overlaySampleStore: {
          record: async (input: BlockingOverlaySampleInput) => {
            if (options.recordImpl) return options.recordImpl(input);
            samples.push(input);
            return { inserted: true };
          },
        },
      }
      : {}),
    logger: {
      error(...args: unknown[]) {
        errors.push(args.map(String).join(' '));
      },
      warn(...args: unknown[]) {
        warnings.push(args.map(String).join(' '));
      },
      log() {},
    },
    clock: () => NOW,
  });
  return { coordinator, samples, alerts, warnings, errors };
}

const overlay = (over: Partial<BlockingOverlaySnapshotPayload> = {}): BlockingOverlaySnapshotPayload => ({
  kind: 'unknown',
  capturedAt: NOW,
  firstDetectedUrl: 'https://www.facebook.com/reel/2815335378830397',
  text: "Sorry, this feature isn't available right now",
  captureId: 'ovc_abc_001',
  captureStatus: 'captured',
  dom: {
    tag: 'div',
    role: 'dialog',
    testId: 'fb-block-dialog',
    rect: { x: 420, y: 250, width: 600, height: 380 },
    clickables: [
      { tag: 'div', role: 'button', label: 'OK', testId: 'dlg-ok', rect: { x: 880, y: 560, width: 96, height: 36 } },
    ],
    html: '<div role="dialog">…</div>',
  },
  candidates: [
    {
      tag: 'div',
      role: 'dialog',
      testId: 'fb-block-dialog',
      rect: { x: 420, y: 250, width: 600, height: 380 },
      clickables: [
        { tag: 'div', role: 'button', label: 'OK', testId: 'dlg-ok', rect: { x: 880, y: 560, width: 96, height: 36 } },
      ],
      html: '<div role="dialog">…</div>',
    },
  ],
  ...over,
});

const detected = (over: Partial<CaptchaDetectedPayload> = {}): CaptchaDetectedPayload => ({
  kind: 'unknown',
  accountId: 'a',
  edgeId: 'e1',
  overlay: overlay(),
  ...over,
});

const session = { edgeId: 'e1', accountId: 'a', platform: 'facebook' } as never;

test('样本原样存结构，不在留存前拍平', async () => {
  const h = makeHarness();
  await h.coordinator.onDetected(detected(), session);

  assert.equal(h.samples.length, 1);
  const sample = h.samples[0]!;
  assert.equal(sample.captureId, 'ovc_abc_001');
  assert.equal(sample.platform, 'facebook');
  assert.equal(sample.kind, 'unknown');
  assert.equal(sample.status, 'captured');

  // 结构必须可逐项读出——拍平成给人读的文本就再也聚类不了，那是本表存在的全部意义。
  const payload = sample.payload as BlockingOverlaySnapshotPayload;
  assert.equal(payload.candidates.length, 1);
  const container = payload.candidates[0]!;
  assert.equal(container.testId, 'fb-block-dialog');
  assert.equal(container.clickables?.[0]?.label, 'OK');
  // 坐标必须活到库里：写坐标点击那条路全靠它。
  assert.deepEqual(container.clickables?.[0]?.rect, { x: 880, y: 560, width: 96, height: 36 });
  assert.ok(container.html, 'HTML 原文必须留存');
});

test('冷却窗内被抑制告警的上报，样本照样留下', async () => {
  const h = makeHarness();
  // 第一次：出卡 + 落样本。
  await h.coordinator.onDetected(detected({ overlay: overlay({ captureId: 'ovc_first' }) }), session);
  // 第二次：同 edge 同类型，落在 10 分钟冷却窗内 ⇒ 告警被抑制。
  await h.coordinator.onDetected(detected({ overlay: overlay({ captureId: 'ovc_second' }) }), session);

  assert.equal(h.alerts.length, 1, '冷却窗内第二张卡应被抑制（既有行为不变）');
  // 样本写入排在冷却判定之前：弹窗越随机越需要这些被压掉的那几次。
  assert.deepEqual(h.samples.map((s) => s.captureId), ['ovc_first', 'ovc_second']);
});

test('告警正文带 captureId，可据此回溯到样本', async () => {
  const h = makeHarness();
  await h.coordinator.onDetected(detected(), session);

  assert.equal(h.alerts.length, 1);
  assert.match(h.alerts[0]!.detail ?? '', /ovc_abc_001/);
});

test('样本写入失败：告警仍带 captureId 并注明未存住，风控与告警照常', async () => {
  const h = makeHarness({
    recordImpl: async () => {
      throw new Error('storage exploded');
    },
  });
  await h.coordinator.onDetected(detected({ kind: 'captcha' }), session);

  // 红线：留存失败不得阻断告警投递。
  assert.equal(h.alerts.length, 1);
  const detail = h.alerts[0]!.detail ?? '';
  assert.match(detail, /ovc_abc_001/, '省略标识会使该次现场既查不到样本、也不知道曾采到过');
  assert.match(detail, /未存住/);
  assert.ok(h.errors.some((line) => line.includes('现场样本留存失败')), '失败必须留痕，不静默吞');
});

test('未注入样本存储时响亮记录，不静默无声', async () => {
  const h = makeHarness({ withStore: false });
  await h.coordinator.onDetected(detected(), session);

  assert.ok(
    h.warnings.some((line) => line.includes('现场样本存储未注入')),
    '「样本一条都没有」必须能区分「没接线」与「没弹窗」',
  );
  assert.equal(h.alerts.length, 1, '未注入样本存储不影响告警');
});

test('旧边缘不带 captureId：不臆造标识，告警不加无从查起的一行', async () => {
  const h = makeHarness();
  const legacy = overlay();
  delete (legacy as { captureId?: string }).captureId;
  await h.coordinator.onDetected(detected({ overlay: legacy }), session);

  assert.equal(h.samples.length, 0, '无标识不写样本');
  assert.equal(h.alerts.length, 1, '既有告警行为不变');
  assert.doesNotMatch(h.alerts[0]!.detail ?? '', /现场样本/);
});

test('采集三态如实透传：none_visible 与 failed 不被压成同一态', async () => {
  for (const [status, captureId] of [
    ['none_visible', 'ovc_none'],
    ['failed', 'ovc_failed'],
  ] as const) {
    const h = makeHarness();
    await h.coordinator.onDetected(
      detected({ overlay: overlay({ captureId, captureStatus: status, candidates: [] }) }),
      session,
    );
    assert.equal(h.samples[0]!.status, status);
  }
});

test('告警面貌除样本行外不变：类型 / 优先级 / 标题一致', async () => {
  const withSample = makeHarness();
  await withSample.coordinator.onDetected(detected({ kind: 'captcha' }), session);

  const legacyOverlay = overlay();
  delete (legacyOverlay as { captureId?: string }).captureId;
  const withoutSample = makeHarness();
  await withoutSample.coordinator.onDetected(
    detected({ kind: 'captcha', overlay: legacyOverlay }),
    session,
  );

  const a = withSample.alerts[0]!;
  const b = withoutSample.alerts[0]!;
  assert.equal(a.severity, b.severity);
  assert.equal(a.title, b.title);
  // 正文差异必须恰好是那一行样本标识，其余逐字不变。
  const removed = (a.detail ?? '').split('\n').filter((line) => !line.includes('现场样本'));
  assert.deepEqual(removed, (b.detail ?? '').split('\n'));
});

test('文案指纹归一化后稳定，且空文案不产生指纹', () => {
  const a = overlayTextDigest("Sorry, this feature isn't available right now");
  const b = overlayTextDigest("  SORRY,   this feature isn't    available right now  ");
  assert.equal(a, b, '同形态文案应归一到同一指纹以便聚类');
  assert.equal(overlayTextDigest(''), undefined);
  assert.equal(overlayTextDigest(undefined), undefined);
  // 指纹绝不用作采集标识：它会把同形态弹窗的多次独立出现折叠成一条。
  assert.notEqual(a, 'ovc_abc_001');
});
