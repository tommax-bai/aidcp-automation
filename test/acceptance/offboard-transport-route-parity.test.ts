// aidcp:test-owner=derived
/**
 * 离场两族路由名：本仓那份 与 共享包那份 **逐条相同**。
 *
 * ## 为什么需要这一条
 *
 * 本仓是 `src/transport/` 的属主，`src/` 里 MUST NOT 从 `aidcp-transport` 取传输原语
 * （闸在 `transport-single-copy`：第二份同名错误类会让 `instanceof` 恒 false）。代价是同一份
 * 传输文件在本仓与共享包里各存一份 —— 而**服务方读本仓那份、调用方读包那份**。
 *
 * 于是路由名有了两处来源。改一处忘了改另一处，**编译全过、两仓测试各自全绿**，
 * 现形方式只有一种：两个进程一起跑起来时的跨进程 404 —— 而那个 404 历来被读成「对面版本落后」。
 * 本仓在这件事上已经连撞五次（见 `served-route-inventory` 文件头）。
 *
 * 本闸从**运行时导出**比，不比文件文本：注释、格式、注入方式都允许两边不同，
 * 唯独「这条路由叫什么」不许。
 *
 * 只钉这两族，是因为它们是**这次新加的**、且此刻只有它们两侧同时被真正接线；
 * 存量那 50 个文件的同类风险不在本次范围内（要治得从属主关系整体收口，那是另一件事）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  OFFBOARD_MATERIALIZATION_ROUTES as LOCAL_MATERIALIZATION,
} from '../../src/transport/offboard-materialization-http.js';
import {
  OFFBOARD_CLEANUP_GRANT_ROUTES as LOCAL_CLEANUP_GRANT,
} from '../../src/transport/offboard-cleanup-grant-http.js';
import {
  OFFBOARD_MATERIALIZATION_ROUTES as PACKAGED_MATERIALIZATION,
} from 'aidcp-transport/transport/offboard-materialization-http.js';
import {
  OFFBOARD_CLEANUP_GRANT_ROUTES as PACKAGED_CLEANUP_GRANT,
} from 'aidcp-transport/transport/offboard-cleanup-grant-http.js';

test('台账物化那一族：服务方与调用方读到的是同一批路由名', () => {
  assert.deepEqual(LOCAL_MATERIALIZATION, PACKAGED_MATERIALIZATION);
});

test('清理授权那一族：服务方与调用方读到的是同一批路由名', () => {
  assert.deepEqual(LOCAL_CLEANUP_GRANT, PACKAGED_CLEANUP_GRANT);
});

test('两族的方法名集合本身没少（少一个方法 = 调用方永远拿不到那一步）', () => {
  assert.deepEqual(Object.keys(LOCAL_MATERIALIZATION).sort(), ['materializeEnvironmentOffboard']);
  assert.deepEqual(Object.keys(LOCAL_CLEANUP_GRANT).sort(), [
    'consumeCleanupGrant',
    'issueCleanupGrant',
  ]);
});
