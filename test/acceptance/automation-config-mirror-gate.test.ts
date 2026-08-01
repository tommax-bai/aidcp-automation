// aidcp:test-owner=derived
/**
 * 本进程配置副本停手闸的行为闸（task 3.1c 第 3 步）。
 *
 * 这条链上真正会静默出错的是三处，每处都有会真触发它的用例：
 *
 * - **闸门键清单**：多一个本进程根本不持有的键 → 镜像对认不出的键一律答 `stale`
 *   ⇒ 本进程被一条它没有的副本**永久停手**；少一个真闸门键 ⇒ 该配置陈旧时照常动作。
 * - **参数档不入列**：热帖阈值那类陈旧只告警，混进来会把告警变成停手。
 * - **拒绝落账**：属主表在接口域，没有落账口时 MUST 具名留痕，
 *   **MUST NOT 静默 no-op** —— 镜像自带的默认参数正是一个静默 no-op。
 *
 * 判定策略本身不在这里测（那在 kernel 工厂那一侧），本文件只测「本进程接得对不对」。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ConfigMirrorKey } from 'aidcp-kernel/kernel/config-mirror-bump-types.js';

import {
  AUTOMATION_GATE_MIRROR_KEYS,
  createAutomationConfigMirrorGate,
} from '../../src/automation-config-mirror-gate.js';
import { AutomationSyncReadMirrors } from '../../src/transport/automation-sync-read-mirrors.js';

const SILENT = { warn: () => undefined };

/** 一份全新的镜像集：什么都还没装载，因此每一条都不是 `ready`。 */
function freshMirrors(now = 1_000): AutomationSyncReadMirrors {
  return new AutomationSyncReadMirrors('dev', () => now);
}

test('闸门键清单逐条都是本进程真持有的副本（多一个会让本进程被永久停手）', () => {
  const mirrors = freshMirrors();
  for (const key of AUTOMATION_GATE_MIRROR_KEYS) {
    assert.notEqual(
      mirrors.configMirrorStateOf(key),
      undefined,
      `${key}: 镜像必须认得这个键`,
    );
  }
  // 反向：一个本进程没有的键，镜像答 stale——这正是「多列一个就永久停手」的机制。
  assert.equal(
    mirrors.configMirrorStateOf('model_config' as ConfigMirrorKey),
    'stale',
    '认不出的键答 stale 是对的（偏向停手），但也正因如此，清单里 MUST NOT 出现本进程没有的键',
  );
});

test('参数档不入闸门清单：它们陈旧只告警、不停手', () => {
  const parameterTier = ['quota_config', 'model_config', 'role_config', 'hot_lead_config'];
  for (const key of parameterTier) {
    assert.equal(
      (AUTOMATION_GATE_MIRROR_KEYS as readonly string[]).includes(key),
      false,
      `${key} 是参数档，混进闸门清单会把「只告警」升级成「停手」`,
    );
  }
});

test('镜像未装载 → 判陈旧、停手并点名是哪一条', () => {
  const gate = createAutomationConfigMirrorGate({ mirrors: freshMirrors(), logger: SILENT });
  assert.equal(gate.isStale(AUTOMATION_GATE_MIRROR_KEYS[0]), true);
  assert.equal(gate.hasStaleGateMirror(), true);
  const halt = gate.platformActionHalt('account=acct-a');
  assert.equal(halt.halted, true);
  assert.ok(
    halt.halted && (AUTOMATION_GATE_MIRROR_KEYS as readonly string[]).includes(halt.mirrorKey),
    '停手 MUST 点名是哪一条副本，否则运维只知道「停了」',
  );
});

test('没有落账口时具名留痕并自己计数，MUST NOT 静默 no-op', () => {
  const warned: string[] = [];
  const gate = createAutomationConfigMirrorGate({
    mirrors: freshMirrors(),
    logger: { warn: (message: string) => warned.push(message) },
  });
  const key = AUTOMATION_GATE_MIRROR_KEYS[0];
  gate.noteStaleRefusal(key, 'ctx-1');
  gate.noteStaleRefusal(key, 'ctx-2');

  assert.equal(
    gate.unpersistedRefusals()[key],
    2,
    '记不进属主表的拒绝 MUST 有个数得出来的度量——「记了但没人收」正是要消灭的形态',
  );
  assert.equal(warned.length, 1, '同一个键只说一次，别把日志刷爆');
  assert.match(warned[0]!, /没有落账口|不会进/);
});

test('有落账口时原样转交，且不再自己计数', () => {
  const received: [string, string | undefined][] = [];
  const gate = createAutomationConfigMirrorGate({
    mirrors: freshMirrors(),
    refusals: { noteStaleRefusal: (k, c) => received.push([k, c]) },
    logger: SILENT,
  });
  const key = AUTOMATION_GATE_MIRROR_KEYS[1];
  gate.noteStaleRefusal(key, 'ctx');
  assert.deepEqual(received, [[key, 'ctx']]);
  assert.deepEqual(
    gate.unpersistedRefusals(),
    {},
    '有地方收就不该再有「没落库」的计数——那个计数是缺口的度量，不是正常态',
  );
});

test('停手时顺带记一次拒绝；只读裁决不记（两者共用同一份判定）', () => {
  const received: string[] = [];
  const gate = createAutomationConfigMirrorGate({
    mirrors: freshMirrors(),
    refusals: { noteStaleRefusal: (k) => received.push(k) },
    logger: SILENT,
  });
  gate.hasStaleGateMirror();
  assert.deepEqual(received, [], '只读裁决什么都没拒绝，记账会污染指标');
  gate.platformActionHalt('ctx');
  assert.equal(received.length, 1, '真停手了就 MUST 记一次');
});
