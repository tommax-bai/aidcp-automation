/**
 * 互动观测台账订阅（组装根切片）：单体 `server.ts` segC 里挂在全局总线上的四段观测订阅，
 * 拆进程时整段漏搬——本模块是它在 automation 进程的家。
 *
 * **为什么必须存在**：每连接私有总线 tee 到全局观测总线（`connection-runtime.ts` 文件头 D1）
 * 的设计意图就是「跨连接的风控记账与观测账本订阅这里」；tee 一直在，订阅一直缺。
 * 后果实测（2026-08-10 dev 库）：`interaction_feed` / `liked_notes` / `interaction_target_meta`
 * 三表自最后一次浏览闭环互动（2026-07-29）后零新增，后台「按笔记互动」永远显示旧数据；
 * 自有点赞/收藏并入精选语料（`markBotAction`）的跨属主通道建了却无人调用——语料只会少不会多，
 * 少一条没人会发现（kernel `curated-write-port.ts` 红线②的注释正指着这里）。
 *
 * 四段订阅（逐位照搬单体 cloud@2d34e06 `src/server.ts` 5559-5694 / 5696-5765）：
 *  1. `interaction.occurred`：风控内存计数立即 apply（事实已在回执处理落 outbox，这里只压窗口）
 *     + 节奏饱和告警 + liked_notes 血缘 + 精选语料 markBotAction + risk_interactions 去重台账
 *     + interaction_feed 展示账本。
 *  2. `search.occurred`：搜索风控计数 + 节奏饱和告警（独立事实通道，不污染互动 feed）。
 *  3. `note.detail.arrived` / `note.image_snapshot.arrived`：标题/链接元数据 upsert
 *     + 「本账号最近观测笔记」内存缓存（喂自有收藏补建精选正文）。
 *  4. `profile.detail.arrived`：作者元数据 upsert（本人主页绝不写入——隔离守卫③）。
 *
 * 红线（原样保留）：
 *  - 缺 accountId 即 honest-fail 丢弃 + 告警，绝不回落保留键 default。
 *  - `noteIdKind==='content_ref'` 的会话内引用 MUST NOT 进任何按笔记键的持久行
 *    （风控照常计数——浏览与点赞是真实发生的事实，不因身份形态而不算数）。
 *  - 所有落库都是 best-effort + 具名 warn，绝不改成静默吞掉，也绝不阻塞事件循环。
 */
import type { EventBus } from './event-bus/index.js';
import type { AutomationRiskAccounting } from './automation-risk-accounting.js';
import type { RiskControllerRegistry } from './risk/risk-controller-registry.js';
import type { PgRiskStore } from './risk/pg-risk-store.js';
import type { LikedNoteStore } from './cache/liked-note-store.js';
import type { InteractionFeedStore } from './cache/interaction-feed-store.js';
import type { AlertStore } from './alerts/index.js';
import { PacingSaturationAlerter } from './risk/pacing-saturation-alerter.js';
import type { CuratedWritePort } from 'aidcp-kernel/kernel/curated-write-port.js';
import type { CuratedReferenceImageInput } from 'aidcp-kernel/kernel/curated-content-types.js';
import type { NoteDetailData } from 'aidcp-kernel/kernel/note-detail.js';
import { topicKeysFromTitle } from 'aidcp-kernel/kernel/valuable-comment-types.js';

export interface AutomationInteractionLedgerOptions {
  /** 全局观测总线（与每连接 tee、边缘接入是同一个实例）。 */
  eventBus: EventBus;
  riskRegistry: Pick<RiskControllerRegistry, 'getControllerForAccounting'>;
  riskAccounting: Pick<AutomationRiskAccounting, 'applyNow'>;
  /** 去重台账（risk_interactions）。 */
  riskStore: Pick<PgRiskStore, 'recordInteraction'>;
  /** 来源血缘（liked_notes）；init 失败缺席时该笔退化、具名 warn 过了。 */
  likedNoteStore?: Pick<LikedNoteStore, 'recordLike'>;
  /** 展示账本（interaction_feed + interaction_target_meta）；缺席同上。 */
  interactionFeedStore?: Pick<InteractionFeedStore, 'recordEvent' | 'upsertMeta'>;
  /** 精选语料写口（automation 进程下是 content 的 HTTP 客户端）。 */
  curatedWrite?: Pick<CuratedWritePort, 'markBotAction'>;
  /** 告警存储；缺席则节奏饱和告警整体不启用（单体同形：alertStore 就绪才建 alerter）。 */
  alertStore?: Pick<AlertStore, 'raise'>;
  logger: Pick<Console, 'log' | 'warn'>;
}

export interface AutomationInteractionLedger {
  /**
   * 人工评论标记（评论调度器 `withManualCommitMarker` 的回调对）：真 commit 期间把账号并入
   * 人工来源集合，只用于抑制该账号 comment 的节奏饱和告警——配额账照记（手动跳过的是闸不是账）。
   */
  manualCommentMarker: {
    onStart(accountId: string): void;
    onEnd(accountId: string): void;
  };
}

/** 建立四段观测订阅；订阅常驻进程生命周期，无需拆除句柄。 */
export function createAutomationInteractionLedger(
  options: AutomationInteractionLedgerOptions,
): AutomationInteractionLedger {
  const {
    eventBus,
    riskRegistry,
    riskAccounting,
    riskStore,
    likedNoteStore,
    interactionFeedStore,
    curatedWrite,
    logger,
  } = options;

  const pacingAlerter = options.alertStore
    ? new PacingSaturationAlerter({ alertStore: options.alertStore, logger })
    : undefined;

  /** 人工评论中的账号（发布期并入、结束移除）；只影响告警抑制，不影响记账。 */
  const manualCommentAccounts = new Set<string>();

  // 「本账号最近观测到的笔记内容」缓存：collect 通常在 note.detail 之后、同访问内发生，
  // 自有收藏自动纳入精选时据此补建正文。仅留最近一条/账号，内存态、丢失无害
  // （取不到则不补建空正文壳行）。
  const lastObservedNoteByAccount = new Map<
    string,
    {
      noteId: string;
      title: string;
      body: string;
      mediaType: 'image_text' | 'video';
      author?: string;
      sourceUrl?: string;
      topics: string[];
      likeCount: number;
      collectCount: number;
      referenceImages: CuratedReferenceImageInput[];
      publishedAtText?: string;
      publishedObservedAt?: number;
    }
  >();

  // ── 1. interaction.occurred：真实发生的动作按账号计数 + 三本观测账 ────────────
  eventBus.on('interaction.occurred', (evt) => {
    if (!evt.accountId) {
      logger.warn('[aidcp-automation] interaction.occurred 缺 accountId — 丢弃（honest-fail），绝不回落 default');
      return;
    }
    const accountId = evt.accountId;
    // 手动命令（/comment 等）跳过的是配额闸不是这本账：照常 apply 计数，只抑制节奏告警。
    const manualSource = evt.action === 'comment' && manualCommentAccounts.has(accountId);
    riskRegistry
      .getControllerForAccounting(accountId)
      .then(async (c) => {
        // 节奏告警判据 MUST 取自 apply 之前：事实早已在回执处理里落 outbox，内存计数只在
        // apply 时递增，故这一行取到的仍是那次动作当时面对的状态。
        const verdict = pacingAlerter && !manualSource ? c.explain(evt.action) : undefined;
        // 漏斗在则立即 apply（把「事实落库」与「内存计数递增」的窗口压到不可观测，
        // 轮询只作崩溃恢复兜底）；漏斗没起来回落进程内记账，行为逐位一致。
        const applied = await riskAccounting.applyNow();
        if (!applied) await c.record(evt.action);
        if (verdict && !verdict.allowed && pacingAlerter) {
          if (verdict.reason === 'quota:hour' || verdict.reason === 'quota:minute') {
            pacingAlerter.maybe(accountId, evt.action, verdict.reason === 'quota:hour' ? 'hour' : 'minute');
          }
        }
      })
      .catch((err) => {
        logger.warn('[aidcp-automation] RiskController record error:', err);
      });
    // 会话内引用 MUST NOT 进任何按笔记键的持久行：去重表 / 血缘 / 展示账本 / 精选库都要
    // 跨会话再被读到，引用换个会话解析不出任何东西；去重表更糟——会把新帖误判成已互动。
    const noteKeyPersistable = evt.noteIdKind !== 'content_ref';
    // 来源血缘：真实点赞落 liked_notes（noteId 才落；详情缺则空字段如实，不编造）。
    if (noteKeyPersistable && evt.action === 'like' && evt.noteId && likedNoteStore) {
      likedNoteStore.recordLike(evt.noteId).catch((err) => {
        logger.warn('[aidcp-automation] LikedNoteStore recordLike error:', err);
      });
    }
    // 精选灵感：自有动作并入精选语料。like=弱信号（只标既有行）；collect=强信号（同访问有
    // 非空正文才补建，取不到则只补标记）。跨进程后失败率高于单体，仍是 best-effort+具名 warn
    // ——这是一条真写，丢了这条自有动作就永久没进语料。**绝不能改成静默吞掉。**
    if (noteKeyPersistable && curatedWrite && evt.noteId && (evt.action === 'like' || evt.action === 'collect')) {
      const observed = lastObservedNoteByAccount.get(accountId);
      const content =
        evt.action === 'collect' && observed && observed.noteId === evt.noteId
          ? {
              title: observed.title,
              body: observed.body,
              mediaType: observed.mediaType,
              author: observed.author,
              sourceUrl: observed.sourceUrl,
              topics: observed.topics,
              referenceImages: observed.referenceImages,
              ...(observed.publishedAtText
                ? {
                    publishedAtText: observed.publishedAtText,
                    publishedObservedAt: observed.publishedObservedAt,
                  }
                : {}),
            }
          : undefined;
      curatedWrite.markBotAction(accountId, evt.noteId, evt.action, content).catch((err) => {
        logger.warn('[aidcp-automation] curated markBotAction error:', err);
      });
    }
    // 按笔记互动落去重表（risk_interactions）。仅 like/collect（follow 无 per-note 语义）；
    // ON CONFLICT DO NOTHING 天然去重。面板已改读 interaction_feed，此表保留为去重台账。
    if (noteKeyPersistable && evt.noteId && (evt.action === 'like' || evt.action === 'collect')) {
      riskStore.recordInteraction(accountId, evt.noteId, evt.action, Date.now()).catch((err) => {
        logger.warn('[aidcp-automation] recordInteraction error:', err);
      });
    }
    // 展示账本：四类动作落 interaction_feed——纯观测账本，不碰 RiskController 终态。
    // targetId 由 handler 据动作填（笔记动作=noteId，关注=authorId）；comment_like 无目标语义、刻意不进。
    if (
      // 关注按作者归属（targetId=authorId，与帖子身份无关）⇒ 分档只挡笔记类动作，绝不误伤关注。
      (noteKeyPersistable || evt.action === 'follow') &&
      interactionFeedStore &&
      evt.targetId &&
      (evt.action === 'like' || evt.action === 'collect' || evt.action === 'comment' || evt.action === 'follow')
    ) {
      interactionFeedStore.recordEvent(accountId, evt.action, evt.targetId, Date.now()).catch((err) => {
        logger.warn('[aidcp-automation] interactionFeed recordEvent error:', err);
      });
    }
  });

  // ── 2. search.occurred：账号级平台活动，独立事实通道，不污染互动 feed/liked_notes ──
  eventBus.on('search.occurred', (evt) => {
    if (!evt.accountId) {
      logger.warn('[aidcp-automation] search.occurred 缺 accountId — 丢弃（honest-fail），绝不回落 default');
      return;
    }
    const accountId = evt.accountId;
    riskRegistry
      .getControllerForAccounting(accountId)
      .then(async (controller) => {
        // 与 interaction.occurred 同形：判定取自 apply 之前，事实已在回执处理里落进 outbox。
        const verdict = pacingAlerter && evt.purpose !== 'operator' ? controller.explain('search') : undefined;
        const applied = await riskAccounting.applyNow();
        if (!applied) await controller.record('search');
        if (verdict && !verdict.allowed && pacingAlerter) {
          if (verdict.reason === 'quota:hour' || verdict.reason === 'quota:minute') {
            pacingAlerter.maybe(accountId, 'search', verdict.reason === 'quota:hour' ? 'hour' : 'minute');
          }
        }
      })
      .catch((err) => logger.warn('[aidcp-automation] search RiskController record error:', err));
  });

  // ── 3. 展示账本元数据：看到笔记/作者时独立 upsert 标题+链接，面板读时 LEFT JOIN ────
  // 与互动事件解耦 → 杀「动作回执先于详情到达→标题为空」竞态；诚实置空（COALESCE 缺则不覆盖、不伪造）。
  const rememberObservedNote = (evt: {
    detail: NoteDetailData;
    accountId?: string;
    ts: number;
    noteIdKind?: 'permalink' | 'content_ref';
  }): void => {
    if (!evt.accountId) {
      logger.warn('[aidcp-automation] note.detail.arrived 缺 accountId — 跳过（honest-fail）');
      return;
    }
    const acc = evt.accountId;
    const d = evt.detail;
    // 会话内引用：详情照常评估、照常计浏览（上游已做），但下面两处都是按笔记键落到后续会话。
    const noteKeyPersistable = evt.noteIdKind !== 'content_ref';
    if (noteKeyPersistable && interactionFeedStore && d.noteId) {
      interactionFeedStore.upsertMeta(acc, d.noteId, { title: d.title, url: d.url }).catch((err) => {
        logger.warn('[aidcp-automation] interactionFeed upsertMeta(note) error:', err);
      });
    }
    // 笔记上报已带作者昵称 → 顺手补作者元数据（关注展示用；主页 url 待 profile.detail 补，COALESCE 互不抹除）。
    if (interactionFeedStore && d.authorId && d.author) {
      interactionFeedStore.upsertMeta(acc, d.authorId, { title: d.author }).catch(() => {});
    }
    // 最近观测笔记内容：唯一用途是喂 markBotAction('collect') 补建精选正文，写口缺席时留着没意义。
    if (noteKeyPersistable && curatedWrite && d.noteId) {
      const topics = topicKeysFromTitle(d.title);
      lastObservedNoteByAccount.set(acc, {
        noteId: d.noteId,
        title: d.title,
        body: d.content,
        mediaType: d.mediaType === 'video' ? 'video' : 'image_text',
        author: d.author,
        sourceUrl: d.url,
        topics,
        likeCount: d.likeCount,
        collectCount: d.collectCount,
        referenceImages: d.images ?? [],
        ...(d.publishedAtText ? { publishedAtText: d.publishedAtText, publishedObservedAt: evt.ts } : {}),
      });
    }
  };
  eventBus.on('note.detail.arrived', rememberObservedNote);
  eventBus.on('note.image_snapshot.arrived', rememberObservedNote);

  // ── 4. 作者主页元数据（隔离守卫③：本人主页采集绝不写进 interaction_feed 作者元数据） ──
  eventBus.on('profile.detail.arrived', (evt) => {
    if (!interactionFeedStore) return;
    const d = evt.detail;
    if (!d.authorId) return;
    if (!evt.accountId) {
      logger.warn('[aidcp-automation] profile.detail.arrived 缺 accountId — 跳过元数据 upsert（honest-fail）');
      return;
    }
    if (d.authorId === evt.accountId) return;
    interactionFeedStore.upsertMeta(evt.accountId, d.authorId, { title: d.nickname, url: d.url }).catch((err) => {
      logger.warn('[aidcp-automation] interactionFeed upsertMeta(profile) error:', err);
    });
  });

  logger.log('[aidcp-automation] 互动观测台账订阅已建立（风控 apply + liked_notes + 精选语料 + interaction_feed + 元数据）');

  return {
    manualCommentMarker: {
      onStart: (accountId) => {
        manualCommentAccounts.add(accountId);
      },
      onEnd: (accountId) => {
        manualCommentAccounts.delete(accountId);
      },
    },
  };
}
