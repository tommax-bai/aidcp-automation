// aidcp:test-owner=derived
// 它读的是**本仓手写的组装根**（`src/automation-*.ts`），在 aidcp-cloud 里没有对应物；
// 没有这行标记，跨仓同步会把它当成「多出的文件」，`--prune` 一跑就没了。
/**
 * 「outbox 主题有生产者、却没有消费者」的接线闸。
 *
 * ## 它治的那次真事故
 *
 * 拆仓时 `RiskCommandConsumer` **整个没被搬过来**：单体 `cloud@2d34e06` 的 `src/server.ts`
 * 是 `new RiskCommandConsumer(...)` 并起了的，派生的 automation 组装根只搬了**提交侧**
 * （`PgRiskCommandService` + `registerRiskCommandRoutes`），落地侧一行没有。
 *
 * 缺席的形态是本仓最贵的那一种 —— **没有任何东西会报错**：
 *   - 面板 / 客户端提交冻结、加严受限、改配额档位、解除受限 → 一律 202「已受理」+ commandId；
 *   - 命令安静地躺在 `event_outbox` 里，游标停在单体停机那一刻，风控状态纹丝不动；
 *   - 结局回读答 `processing`（诚实，但永远不会变），界面只能一直转圈；
 *   - 日志一个字都不提，ECS 上看不到异常。
 * 单体停机（2026-08-04）到修复之间，dev / OL 两侧这四类风控写全线失效。
 *
 * `typecheck` 抓不到（没有类型漂移）、单测抓不到（消费者自己的单测全绿，它只是没人构造）。
 * 唯一能抓住的判据就是本文件这一条：**主题定义在本仓、消费者类也在本仓 ⇒ 组装根 MUST 构造并起它**。
 *
 * ## 例外的写法
 *
 * 消费者确实该住在别的进程时，写进 {@link CONSUMER_LIVES_ELSEWHERE}，并给**结构性**理由。
 * 每条例外还要过 AC-OUTBOX-03：本仓组装根 MUST 也没有它的**生产侧** —— 只进不出的主题
 * 与「本进程不关心它」长得一样，而前者是磁盘上不断增长的静默积压。
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

/**
 * 消费者刻意住在别的进程 / 刻意不接的主题。key = 消费者类名，value = 结构性理由。
 *
 * `PanelEventReplay`：`panel.event` 这条主题在本进程**两侧都没接** —— 生产侧
 * （`bridgeEventBusToOutbox` 对 EventBus 挂 onAny）也没有调用点。tee 与 replay 必须同去同来：
 * 只接 tee 就是往共库满速率写无人消费的废行，只接 replay 则空转。哪天接了 tee，
 * AC-OUTBOX-03 会当场让这条例外失效。
 */
const CONSUMER_LIVES_ELSEWHERE: Readonly<Record<string, string>> = {
  PanelEventReplay:
    'panel.event 的生产侧（bridgeEventBusToOutbox）在本进程也没有调用点；tee 与 replay 必须同去同来',
};

/** 例外条目对应的生产侧标识符：本仓组装根里一旦出现，该例外即失效。 */
const PRODUCER_SYMBOL: Readonly<Record<string, string>> = {
  PanelEventReplay: 'bridgeEventBusToOutbox',
};

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

/**
 * 事实源：**类体内**真的建了一个 `OutboxConsumer` 的具名消费者类。
 *
 * 按**行为**而不是按命名后缀挑（`ConfigMirrorBumpRelay` 叫 Relay、`PanelEventReplay` 叫 Replay，
 * 按 `*Consumer` 收会漏掉它们）；`OutboxConsumer` 自己是底座、不算。
 *
 * 判定必须落到**类体**而不是整份文件：同一个文件里常常既住着消费者、又住着这条主题的
 * **生产者**（`mirror-bump-outbox.ts` 里的 `OutboxMirrorVersionBumper` 就是），按文件收会把
 * 生产者也当成「该被 start 的消费者」，闸随即在一个永远修不好的要求上恒红。
 */
async function outboxConsumerClasses(): Promise<string[]> {
  const names: string[] = [];
  for (const file of await tsFiles(SRC)) {
    if (isAssemblyRoot(file)) continue;
    const source = await readFile(file, 'utf8');
    if (!source.includes('new OutboxConsumer(')) continue;
    // 按 `export class` 切段：每段 = 一个类的声明到下一个类声明之前。
    const marks = [...source.matchAll(/export class ([A-Za-z0-9_]+)/g)];
    for (const [index, match] of marks.entries()) {
      const cls = match[1]!;
      if (cls === 'OutboxConsumer') continue;
      const from = match.index!;
      const to = marks[index + 1]?.index ?? source.length;
      if (source.slice(from, to).includes('new OutboxConsumer(')) names.push(cls);
    }
  }
  return [...new Set(names)].sort();
}

async function assemblySources(): Promise<string> {
  const files = (await tsFiles(SRC)).filter(isAssemblyRoot);
  const sources = await Promise.all(files.map((file) => readFile(file, 'utf8')));
  return sources.join('\n');
}

test('AC-OUTBOX-01 事实源不为空（扫不到东西时本闸会全绿，那比没有闸更糟）', async () => {
  const classes = await outboxConsumerClasses();
  assert.ok(
    classes.length >= 3,
    `扫到的 outbox 消费者类只有 ${classes.length} 个（${classes.join(', ')}）—— 判据大概率失效了。`,
  );
});

test('AC-OUTBOX-02 每个 outbox 消费者 MUST 在组装根里被构造并起来', async () => {
  const assembly = await assemblySources();
  const unwired: string[] = [];
  for (const cls of await outboxConsumerClasses()) {
    if (Object.prototype.hasOwnProperty.call(CONSUMER_LIVES_ELSEWHERE, cls)) continue;
    // 构造：`new Cls(` 或经工厂 `startXxxConsumer(`。起：变量上有 `.start()`。
    const constructed = new RegExp(String.raw`new ${cls}\(`).test(assembly)
      || new RegExp(String.raw`start${cls}\(`).test(assembly);
    // 变量名不做约定，只要求组装根里存在**某个**变量的 .start()，且该变量名提到了这个消费者。
    const stem = cls.replace(/(Consumer|Relay|Replay)$/, '');
    const started = new RegExp(
      String.raw`\b[A-Za-z0-9_]*${stem}[A-Za-z0-9_]*\.start\(`,
      'i',
    ).test(assembly);
    if (!constructed || !started) unwired.push(`${cls}（构造=${constructed} 起=${started}）`);
  }
  assert.deepEqual(
    unwired,
    [],
    '这些 outbox 消费者在本仓有类、组装根却没有构造/起它。提交侧照常 202 受理、命令永远无人应用、'
      + '零报错零告警：\n' + unwired.map((c) => `  · ${c}`).join('\n'),
  );
});

test('AC-OUTBOX-03 例外表里的主题 MUST 在本进程也没有生产侧（否则就是只进不出）', async () => {
  const assembly = await assemblySources();
  const known = new Set(await outboxConsumerClasses());
  const broken: string[] = [];
  for (const [cls, reason] of Object.entries(CONSUMER_LIVES_ELSEWHERE)) {
    if (!known.has(cls)) {
      broken.push(`${cls}：例外指向一个已不存在的消费者类`);
      continue;
    }
    const producer = PRODUCER_SYMBOL[cls];
    assert.ok(producer, `${cls} 进了例外表却没登记生产侧标识符，这条例外无法自证（理由：${reason}）`);
    if (new RegExp(String.raw`\b${producer}\(`).test(assembly)) {
      broken.push(`${cls}：生产侧 ${producer}() 已在组装根接上，消费侧却仍在例外表里 ⇒ 只进不出`);
    }
  }
  assert.deepEqual(broken, [], `例外表已经不成立：\n${broken.map((c) => `  · ${c}`).join('\n')}`);
});
