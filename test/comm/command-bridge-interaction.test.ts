import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { edgeCommandToEnvelope } from '../../src/comm/command-bridge.js';
import { normalizeActionCompletedAction } from '../../src/comm/handler.js';

/**
 * 词汇批 5（objectify-interaction-vocabulary）：互动命令的 bridge 组合网与关联键别名表穷举。
 *
 * 前置探查坐实的零回归网缺口：此前四个直测 edgeCommandToEnvelope 的文件没有一个覆盖互动
 * 5 条——bridge 从硬编码直返迁入 (action, platform[, object]) 组合表时漏一条不会有任何测试红。
 * 本文件补上：9 个合法组合逐条断言信封名；代表性非法组合响亮 throw；
 * 关联键别名表 26 键穷举（值＝风控动作名命名空间，MUST NOT 随协议名变）。
 */

describe('bridge interaction composite table (batch 5)', () => {
  const LEGAL: Array<{
    action: 'like' | 'collect' | 'follow' | 'comment' | 'comment_like';
    platform: 'xiaohongshu' | 'facebook';
    likeObject?: 'note' | 'video';
    type: string;
  }> = [
    { action: 'like', platform: 'xiaohongshu', type: 'xiaohongshu.note.like' },
    { action: 'like', platform: 'xiaohongshu', likeObject: 'note', type: 'xiaohongshu.note.like' },
    { action: 'like', platform: 'facebook', type: 'facebook.note.like' },
    { action: 'like', platform: 'facebook', likeObject: 'note', type: 'facebook.note.like' },
    { action: 'like', platform: 'facebook', likeObject: 'video', type: 'facebook.video.like' },
    { action: 'collect', platform: 'xiaohongshu', type: 'xiaohongshu.note.collect' },
    { action: 'follow', platform: 'xiaohongshu', type: 'xiaohongshu.user.follow' },
    { action: 'follow', platform: 'facebook', type: 'facebook.user.follow' },
    { action: 'comment', platform: 'xiaohongshu', type: 'xiaohongshu.note.comment' },
    { action: 'comment', platform: 'facebook', type: 'facebook.note.comment' },
    { action: 'comment_like', platform: 'xiaohongshu', type: 'xiaohongshu.comment.like' },
  ];

  for (const { action, platform, likeObject, type } of LEGAL) {
    it(`${action}${likeObject ? `(${likeObject})` : ''} × ${platform} → ${type}`, () => {
      const env = edgeCommandToEnvelope({ action, likeObject, params: { noteId: 'n1' } }, platform);
      assert.equal(env.type, type);
      assert.equal((env.payload as { noteId?: string }).noteId, 'n1');
    });
  }

  const ILLEGAL: Array<{
    action: 'like' | 'collect' | 'follow' | 'comment' | 'comment_like';
    platform?: 'xiaohongshu' | 'facebook' | 'wechat_channels';
    likeObject?: 'note' | 'video';
  }> = [
    // 结构性不可达的后备（非第二道支持闸）：不存在的组合必须响亮 throw，绝不静默近似。
    { action: 'like', platform: 'xiaohongshu', likeObject: 'video' },
    { action: 'collect', platform: 'facebook' },
    { action: 'comment_like', platform: 'facebook' },
    { action: 'like', platform: 'wechat_channels' },
    { action: 'comment', platform: 'wechat_channels' },
    { action: 'like' }, // 缺平台＝翻译失败，桥不代答
  ];

  for (const { action, platform, likeObject } of ILLEGAL) {
    it(`${action}${likeObject ? `(${likeObject})` : ''} × ${platform ?? '(none)'} throws`, () => {
      assert.throws(() => edgeCommandToEnvelope({ action, likeObject, params: { noteId: 'n1' } }, platform));
    });
  }
});

describe('action.completed correlation-key alias table (26 keys, values frozen)', () => {
  // 值＝云端角色关联键＝风控动作名（RISK_ACTIONS，kernel 枚举 + DB CHECK 钉死）。
  // 词汇批 5 红线：只换键、值不动——改坏任意一条（键漏改 / 值误改）本表穷举当场红。
  const EXPECTED: Record<string, string> = {
    'xiaohongshu.feed.scroll': 'scroll',
    'xiaohongshu.search.scroll': 'scroll',
    'facebook.feed.scroll': 'scroll',
    'facebook.search.scroll': 'scroll',
    'facebook.reels.scroll': 'scroll',
    'xiaohongshu.feed.refresh': 'refresh',
    'facebook.feed.refresh': 'refresh',
    'xiaohongshu.note.like': 'like',
    'facebook.note.like': 'like',
    'facebook.video.like': 'like',
    'xiaohongshu.note.collect': 'collect',
    'xiaohongshu.user.follow': 'follow',
    'facebook.user.follow': 'follow',
    'xiaohongshu.note.comment': 'comment',
    'facebook.note.comment': 'comment',
    'xiaohongshu.comment.like': 'comment_like',
    'xiaohongshu.search.execute': 'search',
    'facebook.search.execute': 'search',
    'xiaohongshu.note.open': 'open_note',
    'facebook.note.open': 'open_note',
    'xiaohongshu.note.close': 'close',
    'facebook.note.close': 'close',
    'xiaohongshu.note.browse_images': 'browse_images',
    'xiaohongshu.note.scroll_comments': 'scroll_comments',
    'navigation.back': 'back',
    'xiaohongshu.profile.open': 'profile_open',
    'facebook.group.join': 'join_group',
    'xiaohongshu.notification.open': 'open_notifications',
    'xiaohongshu.notification.browse_comments': 'browse_notification_comments',
    'xiaohongshu.notification.browse_likes': 'browse_notification_likes',
    'xiaohongshu.notification.browse_follows': 'browse_notification_follows',
    'xiaohongshu.notification.back_home': 'notification_back_home',
    'pacing.update': 'pacing_update',
  };

  for (const [envelopeName, key] of Object.entries(EXPECTED)) {
    it(`${envelopeName} → ${key}`, () => {
      assert.equal(normalizeActionCompletedAction(envelopeName), key);
    });
  }

  it('规范短键本身不被改写（幂等：正常回执直读零映射）', () => {
    for (const key of ['like', 'collect', 'follow', 'comment', 'comment_like', 'scroll', 'open_note', 'join_group']) {
      assert.equal(normalizeActionCompletedAction(key), key);
    }
  });

  it('旧共享名已从别名表删除（直接切换：旧客户端不会执行新名命令，不存在旧回执窗口）', () => {
    for (const legacy of ['interaction.like', 'interaction.collect', 'interaction.follow', 'interaction.comment', 'interaction.like_comment']) {
      assert.equal(normalizeActionCompletedAction(legacy), legacy, `${legacy} 不应再被归一（表里不该有这条）`);
    }
  });
});
