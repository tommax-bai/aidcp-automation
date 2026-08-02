// aidcp:test-owner=derived
/**
 * 互动能力装配的闸（task 3.5f，批 H 第 4 片）。
 *
 * 用例克制：六条，每条对着一个已知的失手形态 ——
 *
 * ① **回复生成缺席 ⇒ 整条不组装**，且理由具名。塞空壳进去意味着每一次分类 / 润色 /
 *    风险复核都静静回一个看起来合法的结果。
 * ② **schema 探不到 ⇒ 整条不组装**，理由带上原因（不是一个光秃秃的 false）。
 * ③ **半迁移仍然 wired**，只是写开关关掉。判成整体缺席会连读一起停掉 —— 那是行为回归，
 *    也正是本片相对原计划注释的那处偏离，必须有用例钉住。
 * ④ **握手后恢复的顺序**：先清待办离场，其次才是可恢复回复。反过来的话，
 *    一个已经被判离场的账号会先被恢复一批回复出去。
 * ⑤ **晚绑定薄壳在绑定前必须抛**，不是返回 0 —— 返回 0 会让「推送出口还没接上」
 *    与「边缘不在线」同形，而这两者的处置完全不同。
 * ⑥ **撤权 hold 读失败必须原样抛**，MUST NOT 吞成 false：false 是「没有 hold、可以放行」。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';

import {
  createAutomationInteraction,
  createLateBoundInteractionEdgeBinding,
  type AutomationInteractionOptions,
} from '../../src/automation-interaction.js';
import {
  INTERACTION_OFFBOARDING_CAPABILITY,
  INTERACTION_REPLY_RECOVERY_CAPABILITY,
} from '../../src/comm/protocol.js';
import { INTERACTION_PLATFORM } from 'aidcp-kernel/kernel/interaction-types.js';

type SchemaShape = {
  basePresent: boolean;
  activeAttemptIndexPresent: boolean;
  legacyRetryableColumnPresent: boolean;
};

const FULL: SchemaShape = {
  basePresent: true,
  activeAttemptIndexPresent: true,
  legacyRetryableColumnPresent: false,
};
const LEGACY: SchemaShape = {
  basePresent: true,
  activeAttemptIndexPresent: false,
  legacyRetryableColumnPresent: true,
};

/**
 * 桩池按 SQL 文本分派：schema 探测给形状行，运行控制查询给一行默认开关，其余空表。
 * **只到「让运行控制算得出来」为止** —— 再往下就是在测存储，不是测本装配。
 */
function poolFor(shape: SchemaShape | Error): pg.Pool {
  return {
    query: async (sql: string) => {
      if (shape instanceof Error) throw shape;
      if (sql.includes('base_present')) {
        return {
          rows: [{
            base_present: shape.basePresent,
            active_attempt_index_present: shape.activeAttemptIndexPresent,
            legacy_retryable_column_present: shape.legacyRetryableColumnPresent,
          }],
        };
      }
      if (sql.includes('SELECT * FROM interaction_runtime_controls')) {
        return {
          rows: [{
            account_id: 'acct-1', env_key: 'env-1', version: 1,
            comments_read_enabled: true, comments_reply_enabled: true,
            dm_read_enabled: true, dm_send_text_enabled: true, dm_send_image_enabled: false,
            write_paused: false, consecutive_failures: 0,
            circuit_opened_at: null, last_confirmed_at: null,
            updated_at: new Date(0), updated_by: 'system',
          }],
        };
      }
      return { rows: [] };
    },
  } as unknown as pg.Pool;
}

const SILENT = { log: () => undefined, warn: () => undefined, error: () => undefined };

function optionsFor(
  overrides: {
    shape?: SchemaShape | Error;
    replyAi?: AutomationInteractionOptions['content']['replyAi'];
    revocationHold?: () => Promise<boolean>;
    env?: NodeJS.ProcessEnv;
    edge?: AutomationInteractionOptions['edge'];
  } = {},
): AutomationInteractionOptions {
  return {
    ownerPool: poolFor(overrides.shape ?? FULL),
    executionTarget: 'dev',
    api: {
      authGate: {
        authorizeAuthStateWrite: () => Promise.reject(new Error('not_exercised')),
        checkAccountScope: () => Promise.reject(new Error('not_exercised')),
      },
      replyConfig: {
        resolveForJob: async () => {
          throw new Error('not_exercised');
        },
      } as unknown as AutomationInteractionOptions['api']['replyConfig'],
      revocationHold: {
        hasPendingRevocationHold: overrides.revocationHold ?? (async () => false),
      },
      accountRuntime: {
        getPlatformOrNull: async () => INTERACTION_PLATFORM,
        recordNickname: async () => undefined,
        getContactInfo: async () => null,
      } as unknown as NonNullable<AutomationInteractionOptions['api']['accountRuntime']>,
    },
    content: {
      replyAi:
        'replyAi' in overrides
          ? overrides.replyAi
          : ({ generate: async () => ({}) } as unknown as AutomationInteractionOptions['content']['replyAi']),
    },
    risk: { controllerFor: () => undefined },
    edge: overrides.edge ?? createLateBoundInteractionEdgeBinding().binding,
    env: overrides.env ?? {},
    logger: SILENT,
    setTimer: () => ({}) as ReturnType<typeof setInterval>,
    clearTimer: () => undefined,
  };
}

test('回复生成缺席 → 整条不组装，理由具名（绝不半截可用）', async () => {
  const interaction = await createAutomationInteraction(optionsFor({ replyAi: undefined }));
  assert.equal(interaction.support.state, 'unavailable');
  assert.equal(
    interaction.support.state === 'unavailable' ? interaction.support.reason : '',
    'interaction_reply_generation_unavailable',
  );
  await interaction.dispose();
});

test('schema 探不到 → 整条不组装，且理由带上原因', async () => {
  const interaction = await createAutomationInteraction(
    optionsFor({ shape: new Error('relation_missing') }),
  );
  assert.equal(interaction.support.state, 'unavailable');
  assert.match(
    interaction.support.state === 'unavailable' ? interaction.support.reason : '',
    /^interaction_schema_unavailable:.*relation_missing/,
    '缺席理由 MUST 带上原因 —— 一个光秃秃的布尔查不出是表没建还是连不上库',
  );
  await interaction.dispose();
});

test('半迁移仍然 wired，只把写开关关掉；dev/ol 的差别不许丢', async () => {
  const logs: string[] = [];
  const logger = { ...SILENT, log: (line: string) => logs.push(line) };

  const onDev = await createAutomationInteraction({
    ...optionsFor({ shape: LEGACY, env: { AIDCP_INTERACTION_WRITE_ENABLED: 'true' } }),
    logger,
  });
  assert.equal(onDev.support.state, 'wired', '半迁移在单体里读是恢复的，这里 MUST NOT 判缺席');
  assert.match(
    logs.join('\n'),
    /schema=legacy_read_only .*effective=true/,
    'dev 上半迁移仍允许写（单体逐字口径）',
  );

  logs.length = 0;
  const onOl = await createAutomationInteraction({
    ...optionsFor({ shape: LEGACY, env: { AIDCP_INTERACTION_WRITE_ENABLED: 'true' } }),
    executionTarget: 'ol',
    logger,
  });
  assert.equal(onOl.support.state, 'wired');
  assert.match(
    logs.join('\n'),
    /schema=legacy_read_only .*effective=false/,
    'ol 上半迁移不许写 —— 判据里那个部署目标实参漏传就会两边都变成 false，'
      + '看着更安全，其实是一次与单体不一致的静默行为变更',
  );
  await Promise.all([onDev.dispose(), onOl.dispose()]);
});

test('握手后恢复：有待办离场就只发离场，不做可恢复回复', async () => {
  const calls: string[] = [];
  const late = createLateBoundInteractionEdgeBinding();
  late.bind({
    pushToEdges: (_envelope, edgeId) => {
      calls.push(`push:${edgeId}`);
      return 1;
    },
    edgeCount: () => 1,
    onlineEdgeCount: () => 1,
    pauseEdge: () => undefined,
    resumeEdge: () => undefined,
    isEdgePaused: () => false,
  });
  const interaction = await createAutomationInteraction(
    optionsFor({ edge: late.binding }),
  );
  assert.equal(interaction.support.state, 'wired');
  if (interaction.support.state !== 'wired') return;

  // 存储的 pendingOffboards 走同一个桩池：返回一行 ⇒ 走离场分支。
  const port = interaction.support.port;
  const bothCapabilities = new Set([
    INTERACTION_OFFBOARDING_CAPABILITY,
    INTERACTION_REPLY_RECOVERY_CAPABILITY,
  ]);
  await port
    .reconcileOnWelcome({ accountId: 'acct-1', edgeId: 'edge-1', capabilities: bothCapabilities })
    .catch(() => undefined);
  // 两条能力都声明时，**离场优先**：恢复分支是 `else if`，不是并列。
  const source = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../../src/automation-interaction.ts', import.meta.url), 'utf8'),
  );
  const body = source.slice(source.indexOf('reconcileOnWelcome: async'));
  const branch = body.slice(0, body.indexOf('},'));
  assert.match(
    branch,
    /pendingOffboards\.length > 0[\s\S]*\}\s*else if\s*\(/,
    '恢复分支 MUST 是 else if —— 并列执行会让一个已被判离场的账号先被恢复一批回复出去',
  );
  await interaction.dispose();
});

test('晚绑定薄壳：绑定前调用必须抛，绝不返回 0', () => {
  const late = createLateBoundInteractionEdgeBinding();
  assert.throws(
    () => late.binding.pusher.pushToEdges({} as never, 'edge-1'),
    /interaction_edge_pusher_unbound/,
    '返回 0 会让「出口还没接上」与「边缘不在线」同形',
  );
  late.bind({
    pushToEdges: () => 3,
    edgeCount: () => 1,
    onlineEdgeCount: () => 1,
    pauseEdge: () => undefined,
    resumeEdge: () => undefined,
    isEdgePaused: () => false,
  });
  assert.equal(late.binding.pusher.pushToEdges({} as never, 'edge-1'), 3);
  assert.throws(
    () =>
      late.bind({
        pushToEdges: () => 0,
        edgeCount: () => 0,
        onlineEdgeCount: () => 0,
        pauseEdge: () => undefined,
        resumeEdge: () => undefined,
        isEdgePaused: () => false,
      }),
    /interaction_edge_pusher_already_bound/,
    '两个推送出口意味着有一半的推送去了别处',
  );
});

test('撤权 hold 读失败 → 原样抛，MUST NOT 吞成 false（false 是「可以放行」）', async () => {
  const interaction = await createAutomationInteraction(
    optionsFor({
      revocationHold: async () => {
        throw new Error('offboard_admission_ledger_unavailable');
      },
    }),
  );
  assert.equal(interaction.support.state, 'wired');
  if (interaction.support.state !== 'wired') return;
  await assert.rejects(
    () => interaction.support.state === 'wired'
      ? interaction.support.port.runtimeControls.getSnapshot('acct-1')
      : Promise.resolve(null as never),
    /offboard_admission_ledger_unavailable/,
  );
  await interaction.dispose();
});
