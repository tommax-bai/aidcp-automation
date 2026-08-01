// aidcp:test-owner=derived
/**
 * 发布下发与陪伴界面的行为闸（task 3.1 · 批 F）。
 *
 * 本批真正会**静默**出错的是四处，每处都有会真触发它的用例：
 *
 * 1. **素材端口漏传** —— 类型上可选、漏传不报错，代价是预留释放 / 标记已用 / 隔离三个写消失，
 *    于是审批驳回时那组素材永久卡在 reserved 上没人回收。
 * 2. **驳回路径不走下发器那个窄口** —— 它是本模块直调素材端口的一处；
 *    只改窄口会把它漏掉，而两条路径的行为在别处完全一样。
 * 3. **平台投影不是最后一步** —— 摘掉的键被补回 0 ⇒ 饱和判定算出「0/0 今日计划已完成」。
 * 4. **兜底扫描退回「遍历待审 id 逐个查授权」** —— 给空数组会被读成「没有待下发的」，那是一句谎。
 *
 * 另有一条**结构断言**：本模块不许出现整体类型逃逸（`as never` / `as unknown as`）。
 * 它守的东西行为测试看不见 —— 那类强转会把「属主客户端与下发契约漂开」这件事直接静音，
 * 而漂开的后果是下发器拿到一个「形状对、内容缺」的草稿。本批实测踩过一次：
 * 手抄的存储契约漏了四个字段、返回类型宽了一档，全靠去掉强转才现形。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type pg from 'pg';

import { createAutomationPublishDispatch } from '../../src/automation-publish-dispatch.js';
import type {
  AutomationPublishDispatchOptions,
  AutomationPublishMediaSupport,
} from '../../src/automation-publish-dispatch.js';
import { SYNC_READ_CONTRACT_VERSION } from 'aidcp-kernel/kernel/sync-read-snapshot.js';

import { AutomationSyncReadMirrors } from '../../src/transport/automation-sync-read-mirrors.js';

const DEAD_POOL = {
  query: async () => {
    throw new Error('no database in unit test');
  },
} as unknown as pg.Pool;

interface Recorder {
  warnings: string[];
  released: { setId: string; reservationId: string }[];
  rejected: number[];
  pushed: { accountId: string; state: string }[];
}

function newRecorder(): Recorder {
  return { warnings: [], released: [], rejected: [], pushed: [] };
}

function optionsFor(
  recorder: Recorder,
  overrides: {
    media?: AutomationPublishMediaSupport;
    platform?: string;
    draft?: Record<string, unknown> | null;
    sessionActive?: boolean;
  } = {},
): AutomationPublishDispatchOptions {
  const media: AutomationPublishMediaSupport = overrides.media ?? {
    state: 'wired',
    port: {
      releaseReservation: async (setId, reservationId) => {
        recorder.released.push({
          setId: String(setId),
          reservationId: String(reservationId ?? ''),
        });
        return true;
      },
      markUsed: async () => true,
      quarantine: async () => true,
    },
  };
  const draft = overrides.draft === undefined
    ? {
        recordId: 7,
        accountId: 'acc-1',
        status: 'pending_approval',
        title: '稿',
        content: '正文',
        imageUrl: null,
        imageUrls: [],
        contentVersion: 1,
        platform: 'facebook',
        metadata: { facebookMedia: { setId: '11', reservationId: 'r-1' } },
      }
    : overrides.draft;
  return {
    ownerPool: DEAD_POOL,
    executionTarget: 'dev',
    edge: {
      pushToEdges: () => 1,
      resolveEdgeIdForAccount: () => 'ads-1',
      edgeCapabilities: () => [],
      isEdgePaused: () => false,
    },
    commandSequencer: {
      executePublishSequence: async () => undefined,
      executeScheduledReconciliation: async () => undefined,
    } as never,
    edgeTaskLeases: { withLease: async () => undefined } as never,
    risk: {
      getController: async () =>
        ({
          effectiveQuotas: () => ({ minute: {}, hour: {}, day: { collect: 5, like: 10 } }),
          getState: () => ({ quotaLevel: 'normal' }),
          slowStartView: () => null,
          quotaReleaseAfterMs: () => undefined,
        }) as never,
      totalsForAccountSince: async () => ({ like: 1, collect: 3 }),
      todayTotalsForAccount: async () => ({ like: 1, collect: 3 }),
      recordRiskFact: async () => true,
    },
    runtime: {
      sessionUsageForAccount: () =>
        overrides.sessionActive
          ? ({ active: true, startedAt: 1_000, totals: {}, quotas: {} } as never)
          : null,
      resumeGateForAccount: () => null,
    },
    publishLog: {
      loadForDispatch: async () => draft as never,
      updateStatus: async () => undefined,
      updatePostId: async () => undefined,
      markScheduled: async () => undefined,
      markImagesAttached: async () => undefined,
      listDueScheduled: async () => [],
      deferScheduledReconcile: async () => null,
      confirmScheduledPublished: async () => true,
      rejectPendingApproval: async (recordId) => {
        recorder.rejected.push(recordId);
        return true;
      },
      lastPublishedForAccount: async () => null,
      pendingApprovalForAccount: async () => null,
      pendingPublishPreviewForAccount: async () => null,
      countPublishedSinceForAccount: async () => 0,
      countPublishedTodayForAccount: async () => 0,
    },
    publishApproval: {
      readApproval: async () => null,
      voidApproval: async () => undefined,
      markDispatching: async () => undefined,
      markConsumed: async () => undefined,
      releaseToPending: async () => undefined,
      setBlockedReason: async () => undefined,
      listPendingDispatch: async () => [],
    },
    approvalAuthority: { getApproval: async () => null } as never,
    mirrors: new AutomationSyncReadMirrors('dev', () => 1_000),
    media,
    notifications: { deliver: async () => undefined },
    logger: {
      log: () => undefined,
      warn: (message: unknown) => recorder.warnings.push(String(message)),
      error: () => undefined,
    },
  };
}

test('素材端口缺席时**说出来**：漏传的代价是三个写静默消失，不许无声', async () => {
  const recorder = newRecorder();
  const dispatch = await createAutomationPublishDispatch(
    optionsFor(recorder, {
      media: { state: 'unavailable', reason: 'content_authority_unwired' },
    }),
  );
  assert.equal(
    recorder.warnings.some((line) => line.includes('content_authority_unwired')),
    true,
    '缺席必须带具名理由；那个参数在类型上可选，`undefined` 表达不了「为什么没有」',
  );
  await dispatch.close();
});

test('驳回路径直调素材端口释放预留 —— 这一处不走下发器那个窄口，只改窄口会漏掉它', async () => {
  const recorder = newRecorder();
  const dispatch = await createAutomationPublishDispatch(optionsFor(recorder));
  dispatch.notifyPublishRejected('publish-7');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(recorder.rejected, [7]);
  assert.deepEqual(
    recorder.released,
    [{ setId: '11', reservationId: 'r-1' }],
    '不释放 ⇒ 那组素材永久卡在 reserved 上，没有任何人会回收它',
  );
  await dispatch.close();
});

test('驳回时若草稿已不是待审，既不重复驳回也不释放素材', async () => {
  const recorder = newRecorder();
  const dispatch = await createAutomationPublishDispatch(
    optionsFor(recorder, {
      draft: { recordId: 7, accountId: 'acc-1', status: 'published', title: '稿' },
    }),
  );
  dispatch.notifyPublishRejected('publish-7');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(recorder.rejected, []);
  assert.deepEqual(recorder.released, []);
  await dispatch.close();
});

test('平台投影是最后一步：该平台发不出的动作既不出现在计数里，也不参与饱和判定', async () => {
  const recorder = newRecorder();
  const options = optionsFor(recorder);
  // 该账号在投影里是 Facebook —— 收藏在这个平台上结构性不存在。
  options.mirrors.apply(
    {
      contractVersion: SYNC_READ_CONTRACT_VERSION,
      executionTarget: 'dev',
      // 这条流的事实域是共享（属主在接口进程、消费方在本进程）；游标必须是规范的十进制串。
      factScope: 'shared',
      stream: 'automation_account_projection',
      cursor: '1',
      asOf: 1_000,
      freshUntil: 10_000_000,
      complete: true,
      value: {
        accounts: [
          {
            accountId: 'acc-1',
            platform: 'facebook',
            groupLabel: null,
            createdAt: null,
            status: 'active',
          },
        ],
      },
    } as never,
    'owner_fetch',
  );
  assert.equal(
    options.mirrors.accountFor('acc-1').value?.platform,
    'facebook',
    '装置本身要先成立 —— 快照没装上的话，下面那两条断言测的是「平台未知」，不是投影',
  );
  const dispatch = await createAutomationPublishDispatch(options);
  const usage = await dispatch.buildTodayUsageForAccount('acc-1');
  assert.equal(
    Object.prototype.hasOwnProperty.call(usage.totals, 'collect'),
    false,
    '摘键必须在最后一步；顺序颠倒会把它补回 0，然后饱和判定算出「0/0 今日计划已完成」',
  );
  assert.equal(
    (usage.saturated ?? []).includes('collect' as never),
    false,
    '一个这个平台根本发不出的动作，永远不该被判成「已达上限」',
  );
  await dispatch.close();
});

test('无在跑会话时「本轮」窗口不参与饱和判定（否则空窗口会立刻报已完成）', async () => {
  const recorder = newRecorder();
  const dispatch = await createAutomationPublishDispatch(
    optionsFor(recorder, { sessionActive: false }),
  );
  const usage = await dispatch.buildTodayUsageForAccount('acc-1');
  assert.equal(usage.windows?.session?.active, false);
  assert.deepEqual(usage.windows?.session?.saturated, []);
  await dispatch.close();
});

test('兜底扫描只认本机 target 上「已批准的发布稿」：未批准与评论授权都不许挤进窗口', async () => {
  const recorder = newRecorder();
  const options = optionsFor(recorder);
  const loaded: number[] = [];
  options.publishLog.loadForDispatch = async (recordId) => {
    loaded.push(recordId);
    return null;
  };
  options.publishApproval.listPendingDispatch = async () => [
    { requestId: 'publish-7', approved: true },
    { requestId: 'publish-8', approved: false },
    { requestId: 'comment-9', approved: true },
  ];
  const dispatch = await createAutomationPublishDispatch(options);
  await dispatch.publishDispatcher.scanAndDispatchApproved();
  assert.deepEqual(
    loaded,
    [7],
    '未批准的与评论授权都不该进来：评论授权没有下发段、状态永远停在待下发，'
      + '混进来会把窗口永久占满，真正待下发的稿反而永远扫不到',
  );
  await dispatch.close();
});

test('预览刷新在本进程是**具名** no-op：「没推」与「推了没到」必须分得出来', async () => {
  const recorder = newRecorder();
  const dispatch = await createAutomationPublishDispatch(optionsFor(recorder));
  recorder.warnings.length = 0;
  dispatch.refreshPublishPreview(42);
  assert.equal(
    recorder.warnings.some((line) => line.includes('42')),
    true,
    '静默 return 会让「本进程按设计不推」与「推了但没到」完全同形',
  );
  await dispatch.close();
});

test('结构断言：本模块不许整体类型逃逸（那会把契约漂移直接静音）', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/automation-publish-dispatch.ts', import.meta.url)),
    'utf8',
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.equal(
    /\bas never\b/.test(code),
    false,
    '`as never` 会让属主客户端与下发契约的漂移不再报错 —— 本批实测踩过：'
      + '手抄的存储契约漏四个字段、返回类型宽一档，去掉强转才现形',
  );
  assert.equal(
    /\bas unknown as\b/.test(code),
    false,
    '双跳强转同理：它绕开的正是这里唯一能防契约漂移的机制',
  );
});
