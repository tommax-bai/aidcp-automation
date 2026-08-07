/**
 * EdgeCommand → 协议 Envelope 桥接层。
 *
 * 将 RoleDispatcher 产出的 EdgeCommand 翻译为协议 Envelope，
 * 以便通过 ws-server.pushToEdges 下发给边缘节点。
 *
 * 词汇批 4（platformize-browse-vocabulary）：浏览命令带平台段，翻译需要目标账号的平台。
 * 平台×动作的组合表以 `satisfies` 钉在 `MessageType` 上——写错名编译期红；
 * 运行时不存在的组合（如 facebook + browse_images）响亮 throw。这个 throw 是结构性
 * 不可达的后备（FB 的深读/主页/巡视角色本就不注册或被注入闸短路），**不是**第二道
 * 支持闸——`platform-browse-surface` 规格的单点审计拒发闸照旧唯一。
 */

import { randomUUID } from 'node:crypto';
import { makeEnvelope, type Envelope, type MessageType } from './protocol.js';
import type { EdgeCommand } from '../orchestrator/role-dispatcher.js';
import type { PlatformId } from '../platform/registry.js';

/** 构造一个带随机 id 的信封 */
function createEnvelope(type: MessageType, payload: Record<string, unknown>): Envelope {
  return makeEnvelope(type, randomUUID(), Date.now(), payload as never);
}

export type ScrollSurface = 'feed' | 'search' | 'reels';

/** 滚动命令：平台 × 面 → 信封类型。xhs 无 reels 面；视频号无浏览面。 */
const SCROLL_TYPES: Readonly<Record<PlatformId, Partial<Record<ScrollSurface, MessageType>>>> = {
  xiaohongshu: { feed: 'xiaohongshu.feed.scroll', search: 'xiaohongshu.search.scroll' },
  facebook: {
    feed: 'facebook.feed.scroll',
    search: 'facebook.search.scroll',
    reels: 'facebook.reels.scroll',
  },
  wechat_channels: {},
} satisfies Record<PlatformId, Partial<Record<ScrollSurface, MessageType>>>;

/** like 命令：平台 × 对象 → 信封类型（词汇批 5「按对象拆、不按位置拆」；video=Reels 或 feed 视频帖）。 */
const LIKE_TYPES: Readonly<Record<PlatformId, Partial<Record<'note' | 'video', MessageType>>>> = {
  xiaohongshu: { note: 'xiaohongshu.note.like' },
  facebook: { note: 'facebook.note.like', video: 'facebook.video.like' },
  wechat_channels: {},
} satisfies Record<PlatformId, Partial<Record<'note' | 'video', MessageType>>>;

/** 平台段命令：平台 × 动作 → 信封类型（缺席组合＝该平台不存在该能力）。 */
const PLATFORM_SCOPED_TYPES: Readonly<Record<PlatformId, Partial<Record<string, MessageType>>>> = {
  xiaohongshu: {
    refresh: 'xiaohongshu.feed.refresh',
    open_note: 'xiaohongshu.note.open',
    close_note: 'xiaohongshu.note.close',
    collect: 'xiaohongshu.note.collect',
    follow: 'xiaohongshu.user.follow',
    comment: 'xiaohongshu.note.comment',
    comment_like: 'xiaohongshu.comment.like',
    search: 'xiaohongshu.search.execute',
    browse_images: 'xiaohongshu.note.browse_images',
    scroll_comments: 'xiaohongshu.note.scroll_comments',
    profile_open: 'xiaohongshu.profile.open',
    open_notifications: 'xiaohongshu.notification.open',
    browse_notification_comments: 'xiaohongshu.notification.browse_comments',
    browse_notification_likes: 'xiaohongshu.notification.browse_likes',
    browse_notification_follows: 'xiaohongshu.notification.browse_follows',
    notification_back_home: 'xiaohongshu.notification.back_home',
  },
  facebook: {
    refresh: 'facebook.feed.refresh',
    open_note: 'facebook.note.open',
    close_note: 'facebook.note.close',
    follow: 'facebook.user.follow',
    comment: 'facebook.note.comment',
    search: 'facebook.search.execute',
  },
  wechat_channels: {},
} satisfies Record<PlatformId, Partial<Record<string, MessageType>>>;

function platformScopedType(action: string, platform: PlatformId | undefined): MessageType {
  if (!platform) {
    throw new Error(`edge command action=${action} requires a platform for translation, got none`);
  }
  const type = PLATFORM_SCOPED_TYPES[platform]?.[action];
  if (!type) {
    throw new Error(`edge command action=${action} does not exist on platform=${platform}`);
  }
  return type;
}

/**
 * 将 RoleDispatcher 的 EdgeCommand 转换为协议 Envelope。
 * `platform` = 目标账号所属平台（连接层闭包穿入）；仅平台段命令需要，非平台域命令忽略。
 */
export function edgeCommandToEnvelope(command: EdgeCommand, platform?: PlatformId): Envelope {
  switch (command.action) {
    case 'scroll': {
      // 面由发令方声明（sendScrollCommand / sendBrowseRedrive 经单点解析器落 surface）；
      // 缺面即翻译失败——补空即决策，桥不代答（edge-command-grammar 第 1 条）。
      if (!platform) {
        throw new Error('scroll requires a platform for translation, got none');
      }
      const surface = command.surface;
      if (!surface) {
        throw new Error(`scroll on platform=${platform} carries no surface declaration`);
      }
      const type = SCROLL_TYPES[platform]?.[surface];
      if (!type) {
        throw new Error(`scroll surface=${surface} does not exist on platform=${platform}`);
      }
      // feed-scroll-card-floor：透传 params（如 dwellMs）；旧行为只带 reason 会丢弃 params。
      return createEnvelope(type, { reason: command.reason, ...command.params });
    }
    case 'refresh':
      // feed 深度到阈值改点右下「刷新」回顶换新批（change feed-refresh-on-depth）；透传 thinkMs 等 params。
      return createEnvelope(platformScopedType('refresh', platform), { reason: command.reason, ...command.params });
    case 'open_note':
      return createEnvelope(platformScopedType('open_note', platform), command.params ?? {});
    case 'close_note':
      return createEnvelope(platformScopedType('close_note', platform), command.params ?? {});
    case 'like': {
      // 词汇批 5：对象由发令方声明（Reels/feed 视频路径标 video），缺省 note；
      // 不存在组合（xiaohongshu×video）响亮 throw——结构性不可达的后备，非第二道支持闸。
      if (!platform) {
        throw new Error('like requires a platform for translation, got none');
      }
      const objectKind = command.likeObject ?? 'note';
      const type = LIKE_TYPES[platform]?.[objectKind];
      if (!type) {
        throw new Error(`like object=${objectKind} does not exist on platform=${platform}`);
      }
      return createEnvelope(type, command.params ?? {});
    }
    case 'collect':
      return createEnvelope(platformScopedType('collect', platform), command.params ?? {});
    case 'follow':
      return createEnvelope(platformScopedType('follow', platform), command.params ?? {});
    case 'comment':
      return createEnvelope(platformScopedType('comment', platform), command.params ?? {});
    case 'comment_like':
      return createEnvelope(platformScopedType('comment_like', platform), command.params ?? {});
    case 'search':
      return createEnvelope(platformScopedType('search', platform), command.params ?? {});
    case 'back':
      return createEnvelope('navigation.back', { reason: command.reason, ...command.params });
    case 'browse_images':
      return createEnvelope(platformScopedType('browse_images', platform), command.params ?? {});
    case 'scroll_comments':
      return createEnvelope(platformScopedType('scroll_comments', platform), command.params ?? {});
    case 'profile_open':
      return createEnvelope(platformScopedType('profile_open', platform), command.params ?? {});
    case 'identity_read_current':
      return createEnvelope('identity.read_current_page', command.params ?? {});
    case 'identity_read_self_profile':
      return createEnvelope('identity.read_self_profile', command.params ?? {});
    case 'state_read':
      // 观察命令「问现状」（change add-state-observation-command）：captureId 随 params 透传。
      return createEnvelope('state.read', command.params ?? {});
    case 'open_notifications':
      return createEnvelope(platformScopedType('open_notifications', platform), command.params ?? {});
    case 'browse_notification_comments':
      return createEnvelope(platformScopedType('browse_notification_comments', platform), command.params ?? {});
    case 'browse_notification_likes':
      return createEnvelope(platformScopedType('browse_notification_likes', platform), command.params ?? {});
    case 'browse_notification_follows':
      return createEnvelope(platformScopedType('browse_notification_follows', platform), command.params ?? {});
    case 'notification_back_home':
      return createEnvelope(platformScopedType('notification_back_home', platform), command.params ?? {});
    case 'session.end':
      return createEnvelope('session.end', { reason: command.reason, ...command.params });
    case 'pacing_update':
      // 中途风控档位刷新（change pacing-fallback-hardening）：透传 { tempo }，边缘更新兜底节奏、不重置锚点。
      return createEnvelope('pacing.update', command.params ?? {});
    default:
      throw new Error(`Unknown edge command action: ${(command as EdgeCommand).action}`);
  }
}
