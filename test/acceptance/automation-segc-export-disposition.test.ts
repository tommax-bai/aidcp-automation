// aidcp:test-owner=derived
/**
 * 判据清单的自洽闸（task 3.5，批 A）。
 *
 * **它买到的东西很窄，先把话说清楚：它锚的是自洽，不是与现实一致。**
 * 清单里每条的裁定必须跟它自己登记的消费方证据不矛盾，仅此而已。
 * 「41 条抄得对不对」这件事本包**没有任何东西**能回答——那个源文件（cloud 的组装根）不在本包里。
 * 唯一的机械信号在 `aidcp-cloud/test/acceptance/segc-export-face.test.ts`：
 * 那边从组装根现场解析导出面，改了当场红，并点名要来同步本清单。
 *
 * 这里的四条不变量各自对着一个真会犯的错，不是凑数：
 *
 * - 判 `construct`、本进程里却没有消费者、也没声明「构造只为答别的进程」
 *   ⇒ 正是判据 2 要防的「顺手 new 一个本进程没人读的对象」。
 * - 判 `skip`、本进程里却明明有消费者 ⇒ 搬完会静默少装一个东西，且不报错。
 * - `servesOtherProcess` 被当成默认解释（「反正别人要用」）而不是显式声明
 *   ⇒ 这个例外一旦廉价，判据 2 就形同虚设。
 * - `open` 没排到批 H ⇒ 未决项散落在各批里，等于没人负责裁。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AUTOMATION_SEGC_EXPORT_DISPOSITION,
  summarizeSegCExportDisposition,
  type AutomationSegCBatch,
} from '../../src/automation-segc-export-disposition.js';

const BATCHES: readonly AutomationSegCBatch[] = ['B', 'C', 'D', 'E', 'F', 'G', 'H'];

test('判据清单覆盖自动化段导出面全集，句柄唯一且有序', () => {
  const handles = AUTOMATION_SEGC_EXPORT_DISPOSITION.map((entry) => entry.handle);
  assert.equal(
    handles.length,
    41,
    '自动化段今天导出 41 个句柄；条数对不上意味着导出面变了，'
      + '先在 aidcp-cloud 跑 test/acceptance/helpers/segc-export-face.ts 重新派生，再逐条重判去处',
  );
  assert.equal(new Set(handles).size, handles.length, '句柄必须唯一');
  assert.deepEqual(handles, [...handles].sort(), '按句柄名字典序，便于与派生输出逐行对齐');
});

test('判 construct 的，本进程里必须有去处 —— 或者显式声明是替别的进程算', () => {
  for (const entry of AUTOMATION_SEGC_EXPORT_DISPOSITION) {
    if (entry.verdict !== 'construct') continue;
    assert.ok(
      entry.automationConsumers.length > 0 || entry.servesOtherProcess,
      `${entry.handle}: 判了 construct，但本进程里没有消费者、也没声明 servesOtherProcess。`
        + '这正是「顺手 new 一个本进程没人读的对象」——要么补上消费方证据，要么改判',
    );
    assert.ok(entry.reason.length > 0, `${entry.handle}: 依据不能为空`);
  }
});

test('判 skip 的，本进程里必须确实没有消费者', () => {
  for (const entry of AUTOMATION_SEGC_EXPORT_DISPOSITION) {
    if (entry.verdict !== 'skip') continue;
    assert.deepEqual(
      entry.automationConsumers,
      [],
      `${entry.handle}: 判了 skip，本进程里却登记着消费者。搬完会静默少装一个东西，且不报错`,
    );
    assert.equal(
      entry.servesOtherProcess,
      false,
      `${entry.handle}: skip 与「替别的进程算」互斥`,
    );
  }
});

test('「构造只为答别的进程」是显式声明的例外，不是默认解释', () => {
  for (const entry of AUTOMATION_SEGC_EXPORT_DISPOSITION) {
    if (!entry.servesOtherProcess) continue;
    assert.deepEqual(
      entry.automationConsumers,
      [],
      `${entry.handle}: 本进程里有消费者就不该走这条例外——它是给「本进程没去处但仍必须构造」那一类的`,
    );
    assert.ok(
      entry.foreignReaders.length > 0,
      `${entry.handle}: 声明了替别的进程算，却一个别段读者都没登记`,
    );
    assert.equal(entry.verdict, 'construct', `${entry.handle}: 这条例外只对 construct 有意义`);
  }
});

test('未决项一律排到批 H（导出面收口那一批），不散落在各批里', () => {
  for (const entry of AUTOMATION_SEGC_EXPORT_DISPOSITION) {
    assert.ok(BATCHES.includes(entry.batch), `${entry.handle}: 批次必须是 B…H（批 A 不搬业务代码）`);
    if (entry.verdict !== 'open') continue;
    assert.equal(
      entry.batch,
      'H',
      `${entry.handle}: 判不了的一律留到导出面收口那一批统一裁，别散在各批里`,
    );
  }
});

test('分组统计是算出来的，不是手打的', () => {
  const summary = summarizeSegCExportDisposition();
  assert.equal(summary.total, AUTOMATION_SEGC_EXPORT_DISPOSITION.length);
  assert.equal(
    summary.byVerdict.construct + summary.byVerdict.skip + summary.byVerdict.open,
    summary.total,
  );
  assert.equal(
    BATCHES.reduce((acc, batch) => acc + summary.byBatch[batch], 0),
    summary.total,
  );
  assert.equal(
    summary.servesOtherProcess,
    AUTOMATION_SEGC_EXPORT_DISPOSITION.filter((entry) => entry.servesOtherProcess).length,
  );
});
