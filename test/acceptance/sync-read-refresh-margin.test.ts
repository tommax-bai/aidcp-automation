/**
 * AC-SR-MARGIN-01 重发周期 MUST 明显短于新鲜期。
 *
 * **这条不是调参，是就绪闸能不能开的前提**（2026-08-04 dev 实测）：
 * 本进程每隔一个周期重发一次属主快照，接口进程按「所有必需流同时新鲜」判就绪。
 * 周期等于新鲜期时，每个周期末尾都有一段「刚过期、还没重发」的空窗；
 * 流一多，「同时新鲜」就几乎永远不成立 —— 现象是就绪度反复抖、业务入口一次都开不了，
 * 而逐条流去看又都「刚刚还是好的」，没有任何一条日志说得出问题在哪。
 *
 * 判据取三分之一：留得下两次失败重试，且不至于把重发变成热路径。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { AUTOMATION_SYNC_READ_REFRESH_MS } from '../../src/automation-composition-root.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 新鲜期常量住在派生文件里、且没有导出（那份文件由事实源仓同步过来，不在本仓手改），
 * 所以只能按文本取。**取不到即失败**：默默跳过等于把这道闸悄悄拆掉。
 */
function freshnessWindowMs(): number {
  const source = readFileSync(
    join(REPO_ROOT, 'src', 'transport', 'automation-sync-read-source.ts'),
    'utf8',
  );
  const match = source.match(/const\s+DEFAULT_FRESH_MS\s*=\s*([\d_]+)\s*;/);
  assert.ok(
    match,
    'DEFAULT_FRESH_MS 没取到 —— 常量被改名或挪走了，这道闸此刻什么都没在守',
  );
  return Number(match![1].replace(/_/g, ''));
}

test('AC-SR-MARGIN-01 重发周期 ≤ 新鲜期的三分之一', () => {
  const fresh = freshnessWindowMs();
  assert.ok(
    AUTOMATION_SYNC_READ_REFRESH_MS * 3 <= fresh,
    `重发周期 ${AUTOMATION_SYNC_READ_REFRESH_MS}ms 相对新鲜期 ${fresh}ms 太长：`
      + '接口进程的就绪闸要求多条流同时新鲜，余量不够时它会一直开不了。',
  );
});
