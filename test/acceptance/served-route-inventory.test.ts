/**
 * 本进程「到底服务哪些路由」的清单闸（change wire-content-scheduler-into-api-process，任务 3.3）。
 *
 * **它防的不是笔误，是一类反复发生的静默事故**：派生服务的启动入口各自手写、从不自动同步，
 * 它注册的路由集合会悄悄少于单体。而少了的后果不是编译错误——客户端建得出来（构造函数只吃基址
 * 与令牌）、调用点编译得过（类型描述形状、不描述「对面有没有这条路由」）、两仓测试各自全绿；
 * **只有真把两个进程一起跑起来才 404**，而那个 404 会被读成「对面版本落后」。本仓在这件事上
 * 已经连撞五次。
 *
 * 两个方向都要锁，因为**漏登记比漏注册更危险**：漏注册至少还有人在等那条路由，漏登记则是
 * 这张清单从此不再代表事实，而没有任何东西会说出来。
 *   ① 清单里的每一族 MUST 真的在启动装配里被注册；
 *   ② 启动装配里注册的每一族 MUST 在清单里。
 *
 * 加一族路由 = 在 {@link SERVED_FAMILIES} 加一行。删一行 = 显式声明「本进程不再服务它」，
 * 那是个需要 review 的判断，不该靠改一行 main() 就悄悄发生。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { CONTENT_SCHEDULING_ROUTES } from '../../src/transport/content-scheduling-http.js';
import { DELEGATED_TASK_ROUTES } from '../../src/transport/delegated-task-http.js';
import {
  EDGE_RESUME_COMMAND_ROUTES,
  FACEBOOK_SCOPE_COMMAND_ROUTES,
  PUBLISH_UI_UPDATE_COMMAND_ROUTES,
} from '../../src/transport/paired-command-http.js';
import {
  AUTOMATION_DISPATCH_COMMAND_ROUTES,
  DELEGATED_TASK_TEXT_COMMAND_ROUTES,
} from '../../src/transport/operator-command-http.js';

/** 启动装配的两个文件：组装根 + 手写 main。路由只可能注册在这两处。 */
const ASSEMBLY_FILES = ['../../src/automation-composition-root.ts', '../../src/automation-main.ts'];

const SERVED_FAMILIES: ReadonlyArray<{
  registerFn: string;
  routes: Readonly<Record<string, string>>;
}> = [
  { registerFn: 'registerEdgeResumeCommandRoutes', routes: EDGE_RESUME_COMMAND_ROUTES },
  { registerFn: 'registerFacebookScopeCommandRoutes', routes: FACEBOOK_SCOPE_COMMAND_ROUTES },
  { registerFn: 'registerPublishUiUpdateCommandRoutes', routes: PUBLISH_UI_UPDATE_COMMAND_ROUTES },
  {
    registerFn: 'registerAutomationDispatchCommandRoutes',
    routes: AUTOMATION_DISPATCH_COMMAND_ROUTES,
  },
  { registerFn: 'registerDelegatedTaskRoutes', routes: DELEGATED_TASK_ROUTES },
  {
    registerFn: 'registerDelegatedTaskTextCommandRoutes',
    routes: DELEGATED_TASK_TEXT_COMMAND_ROUTES,
  },
  { registerFn: 'registerContentSchedulingRoutes', routes: CONTENT_SCHEDULING_ROUTES },
];

async function assemblySource(): Promise<string> {
  const parts = await Promise.all(
    ASSEMBLY_FILES.map((file) => readFile(new URL(file, import.meta.url), 'utf8')),
  );
  return parts.join('\n');
}

/** 只认**调用**，不认 import：import 留着、注册删掉，正是本仓出过的那个形态。 */
function registeredFamilies(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/^\s*(register[A-Za-z]*Routes)\(/gm)].map((match) => match[1]),
  );
}

test('清单里的每一族都真的在启动装配里被注册（漏注册 → 只有真跑两个进程才 404）', async () => {
  const registered = registeredFamilies(await assemblySource());
  const missing = SERVED_FAMILIES.map((family) => family.registerFn).filter(
    (fn) => !registered.has(fn),
  );
  assert.deepEqual(
    missing,
    [],
    `以下路由族登记为「本进程服务」但启动装配里没有注册：\n${missing.join('\n')}`,
  );
});

test('启动装配里注册的每一族都在清单里（漏登记是静默的，比漏注册更危险）', async () => {
  const registered = [...registeredFamilies(await assemblySource())].sort();
  const declared = new Set(SERVED_FAMILIES.map((family) => family.registerFn));
  const unlisted = registered.filter((fn) => !declared.has(fn));
  assert.deepEqual(
    unlisted,
    [],
    `以下路由族被注册但未登记进清单——这张清单从此不再代表事实：\n${unlisted.join('\n')}`,
  );
});

test('路由名全局唯一：两族撞同一条路径时后注册的会当场抛，但那要等到启动才发现', () => {
  const all = SERVED_FAMILIES.flatMap((family) => Object.values(family.routes));
  assert.equal(new Set(all).size, all.length);
});

test('排期的推进权在接口进程：本进程只服务它的问询，自己不起排期心跳', async () => {
  // **正向写**：本进程对内容排期的参与形态只有一种——注册被调面。
  // 反过来写成「找不到 new ContentScheduler」是靠不住的：改个名就绕过去了。
  assert.match(await assemblySource(), /registerContentSchedulingRoutes\(/);

  // 而那个类**根本不在本仓**：归属表把它判给 api，派生只会把 api 的文件送进 api 仓。
  // 归属是这条保证的事实源；它一旦被改成 automation，下一次派生就会把类送进来，这条会当场红。
  const manifest = JSON.parse(
    await readFile(new URL('../../boundaries/module-ownership.json', import.meta.url), 'utf8'),
  ) as Array<{ path: string }>;
  assert.equal(
    manifest.some((entry) => entry.path === 'src/orchestrator/content-scheduler.ts'),
    false,
    '同一个后台任务绝不两处各跑一份；真正拦住重复触发的是小时格的数据库原子占位（唯一键=账号+动作），本条只是把归属决定钉在明面上',
  );
});
