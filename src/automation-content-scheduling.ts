/**
 * 内容排期调度器的**被调面**（change wire-content-scheduler-into-api-process）。
 *
 * 排期器住在接口进程；它每分钟要问的事实与三类真正的扳机住在这里。本文件把本进程既有的
 * 那几样东西装成 {@link ContentSchedulingAutomationPort}，由 `main()` 注册成路由。
 *
 * ── 三条纪律，改这里之前先读 ────────────────────────────────────────────────
 *
 * **一、九条读口一律「答不上来就抛」。** 绝不回一个看着正常的缺省值：回空清单＝「没人在线」、
 * 回 `'normal'`＝放行、回 `busy:false`＝放行。判「更严的那一侧」是**调用方**的事，因为只有它
 * 知道跳过意味着跳过什么；这一层先兜一个缺省值，那个决定就被悄悄拿走了，且外部看不出区别。
 *
 * **二、扳机回执是「受不受理」，不是结局。** 一次 HTTP 挂到生成结束既占连接、又把超时语义
 * 搅进业务结局（超时算发了还是没发？）。由此推出**终态结果卡由本进程发**——结局在这儿。
 * 调用方只对「未受理」回卡；两侧都发卡，运营就分不出是哪条路径放行的。
 *
 * **三、三条扳机的等待形态各不相同，照抄会挂住请求。**
 *   - 发帖：`triggerScheduled` 一路跑到生成结束 ⇒ **fire-and-forget**，终态卡本进程自补；
 *   - 评论：`triggerManual` 起了异步任务就回执 ⇒ 可以直接 await，回执逐字段带回调用方；
 *     终态卡由评论链自己补（`postResultCard`），本文件绝不重复发。
 *   - 加群：`triggerScheduled` **await 完整加群过程** ⇒ 同样 fire-and-forget。
 */
import type { PlatformId } from 'aidcp-kernel/kernel/platform-types.js';
import type { CommentCommandReceipt } from 'aidcp-kernel/kernel/feishu-card-contract.js';
import {
  scheduledContactCommentLabel,
  scheduledContactCommentOptions,
  type ContentSchedulingAutomationPort,
  type ScheduledApprovalMode,
  type ScheduledBusyView,
  type ScheduledOnlineAccountsView,
  type ScheduledPostExecutionInput,
  type ScheduledTriggerAcceptance,
} from 'aidcp-kernel/kernel/content-scheduling-port.js';

/** 发帖扳机的终态形状（只取本文件要用的那几个字段，不复制整份类型）。 */
interface ScheduledPostOutcome {
  result: string;
  reason?: string;
  status?: string;
  failureReason?: string;
}

export interface AutomationContentSchedulingDeps {
  /** 完成欢迎握手的在线账号；`envKey` 只作诊断。 */
  onlineAccountIdentities(): Array<{ accountId: string; envKey: string | null }>;
  /** 账号风控控制器（状态 / 配额 / canDo 都从它取，绝不各拿一份副本）。 */
  resolveController(accountId: string): Promise<{
    getState(): { status: string };
    effectiveQuotas(): { day: { join_group: number } };
    canDo(action: 'comment'): boolean;
  }>;
  /**
   * 发布触发器。**可缺席**：概念池 / 点赞库不可用时 `main()` 刻意不建它。
   * 缺席时本口如实回「未受理 + 具名原因」，MUST NOT 假装受理——那会烧掉一个小时格却什么都没做。
   */
  publishScheduler: {
    isBusy(accountId?: string): boolean;
    triggerScheduled(
      accountId: string,
      approvalMode: ScheduledApprovalMode,
      execution: ScheduledPostExecutionInput,
    ): Promise<ScheduledPostOutcome>;
  } | null;
  commentScheduler: {
    isRunning(accountId: string): boolean;
    triggerManual(
      accountId: string,
      options: {
        priority: 'automatic';
        approvalMode: ScheduledApprovalMode;
        injectContact?: true;
      },
    ): Promise<CommentCommandReceipt>;
  };
  joinScheduler: {
    isRunning(accountId: string): boolean;
    triggerScheduled(accountId: string): Promise<{ triggered: boolean; reason?: string }>;
  };
  delegatedOwnership(accountId: string, family: 'comment' | 'publish'): Promise<boolean>;
  commentedTodayCount(accountId: string): Promise<number>;
  joinedTodayCount(accountId: string): Promise<number>;
  /** 账号平台，只用来给联系评论的卡片取动作名。 */
  getPlatform(accountId: string): Promise<PlatformId>;
  deliverNotification(payload: unknown, idempotencyKey: string): Promise<unknown>;
  logger: { warn(message: string): void; log?(message: string): void };
}

const busy = (value: boolean): ScheduledBusyView => ({ busy: value });

export function createAutomationContentSchedulingPort(
  deps: AutomationContentSchedulingDeps,
): ContentSchedulingAutomationPort {
  /** 终态结果卡（只发帖用）。失败不外抛：卡发不出去 MUST NOT 反过来影响业务结局。 */
  const deliverPostCard = async (
    accountId: string,
    hourCell: string,
    ok: boolean,
    level: 'success' | 'warning' | 'error',
    title: string,
    message: string,
  ): Promise<void> => {
    await deps
      .deliverNotification(
        {
          kind: 'command_result',
          input: { command: '排期发帖（自动）', ok, level, title, message, accountId },
        },
        // 幂等键带小时格：同一格重复投递（重试 / 重放）不该在群里刷第二张。
        `scheduled-post-result:${accountId}:${hourCell}`,
      )
      .catch((err: unknown) =>
        deps.logger.warn(
          `[content-scheduling] 排期发帖结果卡发送失败 account=${accountId}：${(err as Error).message}`,
        ),
      );
  };

  const runScheduledPost = async (
    accountId: string,
    approvalMode: ScheduledApprovalMode,
    execution: ScheduledPostExecutionInput,
  ): Promise<void> => {
    try {
      const outcome = await deps.publishScheduler!.triggerScheduled(
        accountId,
        approvalMode,
        execution,
      );
      if (outcome.result !== 'triggered') {
        // blocked（未绑人设 / 风控非 normal / canDo 拒）：逐字照单体回一张黄卡。
        await deliverPostCard(
          accountId,
          execution.hourCell,
          false,
          'warning',
          '排期发帖：本槽被闸拦下，未触发',
          outcome.reason ?? 'unknown',
        );
        return;
      }
      const status = outcome.status;
      if (status === 'pending_approval' || status === 'published' || status === 'draft') {
        await deliverPostCard(
          accountId,
          execution.hourCell,
          true,
          'success',
          approvalMode === 'auto_approve'
            ? '排期发帖：已按免审预授权提交'
            : '排期发帖：草稿已生成，待飞书人审',
          approvalMode === 'auto_approve'
            ? `status=${status}（后台免审已自动授权；下发仍由发布派发器复核/执行）`
            : `status=${status}（真发仍须人审通过；未通过/超时一律不发）`,
        );
        return;
      }
      if (status === 'skipped') {
        await deliverPostCard(
          accountId,
          execution.hourCell,
          false,
          'warning',
          '排期发帖：本槽无新素材，本次不发',
          outcome.failureReason ?? '内容侦察判定无可用素材（诚实空槽，不硬凑内容）',
        );
        return;
      }
      await deliverPostCard(
        accountId,
        execution.hourCell,
        false,
        'error',
        '排期发帖：编排未成',
        `status=${status}${outcome.failureReason ? `：${outcome.failureReason}` : ''}`,
      );
    } catch (err) {
      await deliverPostCard(
        accountId,
        execution.hourCell,
        false,
        'error',
        '排期发帖失败',
        (err as Error).message,
      );
    }
  };

  const commentAcceptance = (
    receipt: CommentCommandReceipt,
    label: string,
  ): ScheduledTriggerAcceptance => {
    // ok = 任务真开跑。**不发卡**：评论链跑完自补终态结果卡，两侧都发就成了双卡。
    if (receipt.ok) return { accepted: true };
    // `code` 只在**瞬时**未开始时置位（边端离线 / 唤不醒 / 租约不可得）。它决定调用方
    // 归还小时格并在本小时内有界重试；缺省即不可重试，烧掉本格并如实回卡。
    return {
      accepted: false,
      ...(receipt.code === undefined ? {} : { reason: receipt.code }),
      retryable: receipt.code !== undefined,
      level: receipt.level === 'error' ? 'error' : 'warning',
      title: `排期${label}：${receipt.title}`,
      message: receipt.message,
    };
  };

  return {
    async listOnlineAccounts(): Promise<ScheduledOnlineAccountsView> {
      return { accounts: deps.onlineAccountIdentities() };
    },

    async readRiskStatus({ accountId }) {
      return { status: (await deps.resolveController(accountId)).getState().status };
    },

    async readPublishBusy({ accountId }) {
      // 触发器缺席 ⇒ 判「在跑」。回 false 是放行，而放行之后那一格会被烧掉却什么都没发生。
      if (!deps.publishScheduler) return busy(true);
      return busy(deps.publishScheduler.isBusy(accountId));
    },

    async readCommentBusy({ accountId }) {
      return busy(deps.commentScheduler.isRunning(accountId));
    },

    async readJoinBusy({ accountId }) {
      return busy(deps.joinScheduler.isRunning(accountId));
    },

    async readDelegatedOwnershipBusy({ accountId, family }) {
      return busy(await deps.delegatedOwnership(accountId, family));
    },

    async readCommentedTodayCount({ accountId }) {
      return { count: await deps.commentedTodayCount(accountId) };
    },

    async readJoinedTodayCount({ accountId }) {
      return { count: await deps.joinedTodayCount(accountId) };
    },

    async readJoinDailyCap({ accountId }) {
      const controller = await deps.resolveController(accountId);
      return { cap: controller.effectiveQuotas().day.join_group };
    },

    async triggerScheduledPost({ accountId, approvalMode, execution }) {
      if (!deps.publishScheduler) {
        return {
          accepted: false,
          reason: 'publish_trigger_unavailable',
          retryable: false,
          level: 'error',
          title: '排期发帖：本进程没有发布触发器',
          message:
            '概念池 / 点赞库不可用时本进程刻意不建发布触发器；本槽未触发。这是配置问题，不是「没素材」。',
        };
      }
      // 受理即返回。**绝不 await**：整条生成链跑完可能要几分钟。
      void runScheduledPost(accountId, approvalMode, execution);
      return { accepted: true };
    },

    async triggerScheduledComment({ accountId, approvalMode, variant }) {
      const contact = variant === 'contact_comment';
      const label = contact
        ? scheduledContactCommentLabel(await deps.getPlatform(accountId))
        : '评论';
      // 配额闸在这一侧：它挨着风控事实源。自动路径 MUST 过 `canDo('comment')`
      //（手动 /comment 跳配额是因为「人是刹车」；自动无人在场）。
      const controller = await deps.resolveController(accountId);
      if (!controller.canDo('comment')) {
        return {
          accepted: false,
          reason: 'quota_denied',
          retryable: false,
          level: 'warning',
          title: `排期${label}：配额拒绝，本槽未触发`,
          message: "风控 canDo('comment')=false（自动路径必过配额；手动 /comment 不受此限）",
        };
      }
      const receipt = await deps.commentScheduler.triggerManual(
        accountId,
        contact
          ? scheduledContactCommentOptions(await deps.getPlatform(accountId), approvalMode)
          : { priority: 'automatic', approvalMode },
      );
      return commentAcceptance(receipt, label);
    },

    async triggerScheduledJoin({ accountId }) {
      // fire-and-forget：加群扳机 await 的是完整加群过程（解析连接 → 配额 → 真加群）。
      // 它自己写加群审计台账，未开始的原因在那里查得到，故此处只补一行本地日志。
      void deps.joinScheduler
        .triggerScheduled(accountId)
        .then((result) => {
          if (!result.triggered) {
            deps.logger.warn(
              `[content-scheduling] 排期加群未开始 account=${accountId} reason=${result.reason ?? 'unknown'}`,
            );
          }
        })
        .catch((err: unknown) =>
          deps.logger.warn(
            `[content-scheduling] 排期加群异常 account=${accountId}：${(err as Error).message}`,
          ),
        );
      return { accepted: true };
    },
  };
}
