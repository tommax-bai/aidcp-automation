// aidcp:test-owner=derived
// 它读的是**本仓手写的组装根**（`src/automation-*.ts`），在 aidcp-cloud 里没有对应物；
// 没有这行标记，跨仓同步会把它当成「多出的文件」，`--prune` 一跑就没了。
/**
 * 「属主存储写了表，却没推配置镜像版本」的接线闸（本仓这一半）。
 *
 * ## 为什么本仓也要有
 *
 * 同一道闸 2026-08-04 先加在 `aidcp-api`，因为那天真炸的是 api 那一侧：
 * 账号与人设两个存储没拿到推进器 ⇒ 12 条人设写进了库而版本一次没动 ⇒
 * 自动化一重启就 `same_cursor_payload_drift`、业务入口不放行、8787 消失。
 *
 * **本仓当时是好的**（会话 / 配额 / 节奏 / 恢复四个存储都接着 outbox 型推进器）。
 * 只给 api 加闸就会留下典型的「守卫只覆盖作者在治的那条道」：本仓哪天漏一个，
 * 两边测试照样全绿。判据一样、代价一样，所以两边都装。
 *
 * ## 机理（与 api 那份逐字同因）
 *
 * `writeWithMirrorBump(pool, bumper, key, run)` 的第一行是 `if (!bumper) return run(pool)`
 * —— 推进器缺席时写照常提交、版本一动不动、**不报错也不告警**。
 * 本仓的推进器写的是本域事务型 outbox 行（同库、同事务），再由中继异步推给 api；
 * 缺席时那条 outbox 行根本不产生，失效信号从源头就不存在。
 *
 * 例外写进 {@link DELIBERATELY_UNBUMPED}，逐条给**结构性**理由。
 * 「本进程今天只读它」不是合格理由：读写归属会变，而变的那天没有任何东西会提醒人。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..', 'src');

/** 本仓的组装根是一组文件，不是单个 main()。逐个扫，别只扫 automation-main.ts。 */
const ASSEMBLY_PREFIX = 'automation-';

/** 本进程刻意不接推进器的存储，逐条写清结构性理由。今天是空的。 */
const DELIBERATELY_UNBUMPED: Readonly<Record<string, string>> = {};

async function tsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await tsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function isAssemblyRoot(file: string): boolean {
  const name = file.slice(file.lastIndexOf('/') + 1);
  return name.startsWith(ASSEMBLY_PREFIX) && file.endsWith('.ts')
    && file.slice(0, file.lastIndexOf('/')) === SRC;
}

/** 事实源：选项接口里声明了 `mirrorVersionBumper` 的文件，取它导出的第一个 class 名。 */
async function bumpAwareStoreClasses(): Promise<string[]> {
  const names: string[] = [];
  for (const file of await tsFiles(SRC)) {
    if (isAssemblyRoot(file)) continue;
    const source = await readFile(file, 'utf8');
    if (!/mirrorVersionBumper\??\s*:\s*MirrorVersionBumper/.test(source)) continue;
    const cls = /export class ([A-Za-z0-9_]+)/.exec(source)?.[1];
    if (cls) names.push(cls);
  }
  return [...new Set(names)].sort();
}

/** 抠出 `new <Class>({ … })` 那段对象字面量（括号配平，不靠行数）。 */
function constructionLiteral(source: string, cls: string): string | null {
  const start = source.indexOf(`new ${cls}({`);
  if (start === -1) return null;
  let i = source.indexOf('{', start);
  let depth = 0;
  const from = i;
  for (; i < source.length; i += 1) {
    const ch = source[i]!;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  return null;
}

async function assemblySources(): Promise<string[]> {
  const files = (await tsFiles(SRC)).filter(isAssemblyRoot);
  return Promise.all(files.map((file) => readFile(file, 'utf8')));
}

test('AC-MIRROR-01 事实源不为空（扫不到东西时本闸会全绿，那比没有闸更糟）', async () => {
  const classes = await bumpAwareStoreClasses();
  assert.ok(
    classes.length >= 4,
    `扫到的「会推镜像版本」的存储类只有 ${classes.length} 个 —— 正则大概率失效了。`,
  );
});

test('AC-MIRROR-02 组装根里构造的每个此类存储，MUST 真的拿到推进器', async () => {
  const sources = await assemblySources();
  const missing: string[] = [];
  for (const cls of await bumpAwareStoreClasses()) {
    if (Object.prototype.hasOwnProperty.call(DELIBERATELY_UNBUMPED, cls)) continue;
    const literals = sources
      .map((source) => constructionLiteral(source, cls))
      .filter((literal): literal is string => literal !== null);
    if (literals.length === 0) continue; // 本进程不构造它 —— 那不是漏接
    if (!literals.every((literal) => /\bmirrorVersionBumper\s*:/.test(literal))) missing.push(cls);
  }
  assert.deepEqual(
    missing,
    [],
    '这些存储在本进程被构造、却没拿到镜像版本推进器。写会照常提交、失效信号从源头就不产生、'
      + '零告警：\n' + missing.map((c) => `  · ${c}`).join('\n'),
  );
});

test('AC-MIRROR-03 例外表里的名字 MUST 真的是本进程构造的此类存储（防这张表烂掉）', async () => {
  const sources = await assemblySources();
  const known = new Set(await bumpAwareStoreClasses());
  const stale = Object.keys(DELIBERATELY_UNBUMPED).filter(
    (cls) => !known.has(cls) || sources.every((source) => constructionLiteral(source, cls) === null),
  );
  assert.deepEqual(stale, [], `这些例外声明已经指向不存在的东西：\n${stale.map((c) => `  · ${c}`).join('\n')}`);
});
