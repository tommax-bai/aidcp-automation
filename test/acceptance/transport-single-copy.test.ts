// aidcp:test-owner=derived
/**
 * 本进程里传输原语**只许有一份**（change split-cloud-automation-production-runtime · task 2.8 前瞻闸）。
 *
 * 本仓是 `src/transport/` 的属主，50 个文件都在自己的 src 里。同一批文件也被复制进
 * `aidcp-transport` 共享包给 api / content 用。两份的**行为**逐字相同，所以谁都不会因为
 * 「装错了一份」而崩 —— 这正是它危险的地方。
 *
 * 真正会坏的是 `instanceof`：本仓有一批错误判别写成 `err instanceof InternalHttpError`、
 * `err instanceof ApiDirectHttpError`（客户端在本地构造这些错误，所以在单份世界里完全成立）。
 * 一旦本仓某个文件改从包里 import，同一个进程里就有了**两个同名的类**，
 * 跨这两份的 `instanceof` **恒 false**：鉴权失败、版本不支持、target 不匹配这些具名判别会
 * 一齐退化成兜底分支。不抛、不报，只是判错——与本 change 反复点名的那种静默失败同形。
 *
 * **这条闸此刻是前瞻的**：本仓今天一条 `aidcp-transport` 的 import 都没有。
 * 但 task A-1 马上要让它第一次真依赖那个包（模型调用出口 `aidcp-transport/llm/*`）。
 * 那条闭包实测只含两个文件 + 三个 kernel 文件，**不含**传输原语，所以 A-1 本身安全；
 * 危险的是「既然已经 pin 了这个包，顺手也从它 import 一个 HTTP 客户端吧」这一步。
 * 那一步没有任何编译错误，本闸是唯一会说话的东西。
 *
 * 放行 `aidcp-transport/llm/*` 是显式的：那不是传输原语，且本仓不对它做任何 `instanceof`。
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const SRC = new URL('../../src/', import.meta.url);

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('src/ 不得从 aidcp-transport 取传输原语（本仓是它的属主，第二份会让 instanceof 恒 false）', async () => {
  const root = SRC.pathname;
  const files = await walk(root);
  assert.ok(files.length > 100, `前置：应扫到本仓全部源文件，实际 ${files.length}`);

  const offenders: string[] = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    // 只认真实的模块说明符（import / export ... from '...' 与动态 import('...')），
    // 不匹配注释里提到包名的地方 —— 本仓有好几处注释在讨论准入规则。
    for (const match of text.matchAll(/from\s+'(aidcp-transport\/[^']+)'|import\('(aidcp-transport\/[^']+)'\)/g)) {
      const spec = match[1] ?? match[2];
      if (spec.startsWith('aidcp-transport/llm/')) continue; // 显式放行：模型出口，非传输原语
      offenders.push(`${path.relative(root, file)} → ${spec}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    '本仓的传输原语只许来自 src/transport/。从包里再取一份 = 同一进程两个同名类，'
      + '所有针对它们的 instanceof 判别静默变 false（鉴权 / 版本 / target 不匹配一起退化成兜底）',
  );
});
