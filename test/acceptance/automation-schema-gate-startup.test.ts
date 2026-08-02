// aidcp:test-owner=derived
/**
 * 自动化进程启动期 schema 契约门的接线闸（task 3.5d，批 H 第 2 片）。
 *
 * 用例克制：只钉四条，每条都对着一个已知的失手形态 ——
 *
 * ① **只判本进程连的那个库**：判多了就是在替本进程不连的库背书，判少了就是真在用的库
 *    没被校验过。后者正是这道门原来那次假绿的形状。
 * ② **enforce 下账本落后必须原样抛**：包一层 try/catch 就等于恢复「schema 落后照样启动」，
 *    而那是本门存在的全部理由。
 * ③ **默认路径就能判**（不显式传 migrations / table-ownership）：本仓 `src/schema/` 是自己的
 *    源码，默认基准正好是仓根；内容进程要显式传是因为它从包里 import。传错了这条会红。
 * ④ **回执必填**：门唯一的失效形态是「没人调它」，而「没调」在行为上什么都不表现。
 *    行为用例原理上看不见它 ⇒ 用结构断言钉住那个字段不是可选的。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  AUTOMATION_PG_OWNERS,
  runAutomationStartupSchemaGate,
} from '../../src/automation-schema-gate-startup.js';
import { loadMigrationFiles } from '../../src/schema/migration-files.js';
import { versionOf } from '../../src/schema/migration-plan.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function ledgerStub(versions: string[]) {
  const queries: string[] = [];
  return {
    queries,
    client: {
      async query(text: string) {
        queries.push(text);
        return { rows: versions.map((version) => ({ version })) };
      },
    },
  };
}

test('只判 automation 一个属主，且不显式传路径也能用本仓的迁移与属主清单判出结论', async () => {
  const files = await loadMigrationFiles();
  assert.ok(files.length > 0, '本仓 migrations/ 读不出东西的话，下面的结论没有意义');
  const stub = ledgerStub(files.map((file) => versionOf(file.name)));

  const receipt = await runAutomationStartupSchemaGate({ client: stub.client, mode: 'enforce' });

  assert.deepEqual(receipt.owners, ['automation'], '本进程只连 automation 库，就只判它');
  assert.deepEqual([...AUTOMATION_PG_OWNERS], ['automation']);
  assert.equal(receipt.pass, true, receipt.conclusion);
  assert.equal(stub.queries.length, 1, '一次启动只读一次账本');
});

test('enforce 下账本落后 → 原样抛，且点名 automation（MUST NOT 被吞成「照常启动」）', async () => {
  const files = await loadMigrationFiles();
  const versions = files.map((file) => versionOf(file.name));
  // 只应用到最早那一条：库比代码旧，正是这道门要拦的那一档。
  const stub = ledgerStub([versions[0]]);

  await assert.rejects(
    () => runAutomationStartupSchemaGate({ client: stub.client, mode: 'enforce' }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /schema_behind_code/);
      assert.match(message, /\[automation\]/, '失败 MUST 点名是哪个属主库');
      return true;
    },
  );
});

test('结构：门的调用点不许包 try/catch，属主集合只许有这一份定义', async () => {
  const source = await fs.readFile(path.join(SRC, 'automation-schema-gate-startup.ts'), 'utf8');
  const body = source.slice(source.indexOf('export async function runAutomationStartupSchemaGate'));
  assert.ok(
    !/\btry\s*\{/.test(body),
    '门的调用点 MUST NOT 包 try/catch —— 吞掉它等于恢复「schema 落后照样启动」的静默假成功',
  );

  // 名单类常量在本 change 已经咬过多次（手抄第二份、拼错也照样编译过）。
  // 判据按符号写：取值处 MUST 用那个唯一常量，MUST NOT 就地再写一遍字面量。
  assert.match(body, /owners:\s*AUTOMATION_PG_OWNERS/);
  const entry = await fs.readFile(path.join(SRC, 'automation-service-entry.ts'), 'utf8');
  const code = entry.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(
    !/\[\s*'automation'\s*\]/.test(code),
    '外壳 MUST 用 AUTOMATION_PG_OWNERS，别就地再手写一遍属主名单',
  );
  assert.match(code, /AUTOMATION_PG_OWNERS/);
});

test('结构：启动外壳的门回执是必填的（「没人调门」行为上看不见，只能这样钉）', async () => {
  const entry = await fs.readFile(path.join(SRC, 'automation-service-entry.ts'), 'utf8');
  const options = entry.slice(
    entry.indexOf('export interface AutomationServiceOptions'),
    entry.indexOf('export interface AutomationService {'),
  );
  const declaration = options
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .match(/^\s*schemaGate\??:.*$/m)?.[0];
  assert.ok(declaration, '启动外壳 MUST 持有门回执');
  assert.ok(
    !declaration.includes('schemaGate?'),
    '门回执 MUST NOT 是可选的：可选就等于「忘了调门」是一条合法启动路径',
  );
});
