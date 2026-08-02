/**
 * 评论域的**审批与通知**四个口 + 优质评论语料口（change split-cloud-automation-production-runtime
 * 批 G 第二片）。
 *
 * 它填的是批 E-2 步骤 3 那个工厂留下的 {@link AutomationCommentPorts} 里的五个：
 * `approval` / `notifyAutoApproved` / `resolveApprovalMode` / `notifyMandatoryOutcome` /
 * `valuableCorpus`。**评论调度器本身与联系评论安全闸不在本片**（它们还要加群调度器、
 * 语料检索、风控物化一大串，属批 G 后续片）。
 *
 * ## 四条不许降级的红线
 *
 * 1. **审批口径读不到就 fail-closed 成 `review`**，MUST NOT 沿用来源模式、更不能放成免审。
 *    策略端口没接线、或读取抛错，都算读不到 —— 两种情况都要**说出来**再回落。
 * 2. **人审端口按 env 闸整体二态**。单体里未开启时压根不注入，评论一律诚实跳过、不发。
 *    这里必须是 `unavailable` + 具名理由，**不能是 `undefined`** ——
 *    后者会与「接了但今天不可用」同形，而两者处置完全不同。
 * 3. **「已批准」的状态迁移是 best-effort，失败绝不影响放行判定**。
 *    授权判定只看 `approved`；把迁移失败算进判定等于让一次记账故障吞掉运营已经点过的批准。
 * 4. **语料库缺失是写明的降级**（不归档、撰写不注入参考），不是错误 ——
 *    但同样要具名，别让「没接线」看起来像「本来就没这个能力」。
 *
 * ## 一处刻意的复用
 *
 * 优质评论语料**取批 B 底座已经建好的那一个实例**，本片不另建。
 * 另建第二个会让归档与召回落在两个连接池上，且谁都不会报错。
 */
import type { AutomationCommentPorts, CapabilityState } from './automation-connection-dispatcher.js';
import type { ValuableCommentStore } from './cache/valuable-comment-store.js';

/** 评论审批策略权威（api 属主的客户端）。缺席即读不到 —— 见红线 1。 */
export interface CommentApprovalPolicyPort {
  getAccountCommentMode(accountId: string): Promise<string>;
}

/** 发布审批账本读 + 消费迁移（api 属主）。迁移是 best-effort，见红线 3。 */
export interface PublishApprovalReadPort {
  read(requestId: string): Promise<{ approved?: boolean; revision?: unknown } | null>;
  markConsumed?(requestId: string, revision: unknown): Promise<unknown>;
}

export interface AutomationCommentApprovalOptions {
  /** 结构化通知出口（api 客户端）。四个口里有三个靠它把事情说出去。 */
  deliverStructuredNotification(
    payload: unknown,
    idempotencyKey: string,
  ): Promise<unknown>;
  /** 评论审批策略权威。**缺省即按读不到处理**（fail-closed 到 review）。 */
  approvalPolicy?: CommentApprovalPolicyPort;
  /** 发布审批账本。人审端口靠它判「批了没有」。 */
  publishApproval: PublishApprovalReadPort;
  /** 逐条人审是否开启（单体里是 `AIDCP_COMMENT_APPROVAL === 'true'`）。 */
  approvalEnabled: boolean;
  /** 批 B 底座建好的语料库实例。**本片不另建**（另建会让归档与召回落在两个池上）。 */
  valuableCommentStore?: Pick<ValuableCommentStore, 'archive' | 'retrieveByTopics'>;
  /** 人审等待上限 / 轮询间隔（与单体同值）。 */
  timeoutMs?: number;
  pollMs?: number;
  logger?: Pick<Console, 'log' | 'warn'>;
}

export type AutomationCommentApprovalPorts = Pick<
  AutomationCommentPorts,
  | 'approval'
  | 'notifyAutoApproved'
  | 'resolveApprovalMode'
  | 'notifyMandatoryOutcome'
  | 'valuableCorpus'
>;

export function createAutomationCommentApprovalPorts(
  options: AutomationCommentApprovalOptions,
): AutomationCommentApprovalPorts {
  const logger = options.logger ?? console;
  const deliver = options.deliverStructuredNotification;

  /**
   * 有效审批模式：环境级策略说「全免审」才免审，其余一律沿用来源模式。
   * **读不到一律 `review`**（红线 1）——绝不沿用任何存量值扩权。
   */
  const resolveApprovalMode = async (
    accountId: string,
    sourceMode: 'review' | 'auto_approve',
  ): Promise<'review' | 'auto_approve'> => {
    const policy = options.approvalPolicy;
    if (!policy) {
      logger.warn(
        `[approval-policy] 评论策略 authority 未接线，fail-closed 为 review account=${accountId}`,
      );
      return 'review';
    }
    try {
      const environmentMode = await policy.getAccountCommentMode(accountId);
      return environmentMode === 'auto_approve_all' ? 'auto_approve' : sourceMode;
    } catch (error) {
      logger.warn(
        `[approval-policy] 环境评论策略读取失败，fail-closed 为 review account=${accountId} ` +
          `sourceMode=${sourceMode}: ${messageOf(error)}`,
      );
      return 'review';
    }
  };

  const notifyAutoApproved = async (
    input: {
      requestId: string;
      noteId?: string;
      text: string;
      title?: string;
      authorName?: string;
      accountId?: string;
      accountName?: string;
      contactIncluded?: boolean;
      originChatId?: string;
    },
    source: 'mandatory_persona' | 'account_global' | 'comment_scheduler',
  ): Promise<void> => {
    const mandatory = source === 'mandatory_persona';
    await deliver(
      mandatory
        ? { kind: 'mandatory_comment_pre_authorization', input }
        : {
            kind: 'command_result',
            input: {
              command: input.contactIncluded ? '联系评论（免审）' : '评论（免审）',
              ok: true,
              level: 'success',
              title: input.contactIncluded ? '联系评论已免审授权' : '评论已免审授权',
              message:
                '账号或来源已开启免审，评论终稿已生成并进入提交步骤；下发前仍会核对页面、去重和边端结果。\n' +
                `**目标**：${input.title?.trim() || input.authorName?.trim() || '目标内容'}\n` +
                `**正文预览**：${input.text.replace(/\s+/g, ' ').trim().slice(0, 160) || '（空）'}`,
              accountId: input.accountId,
              accountName: input.accountName,
              originChatId: input.originChatId,
            },
          },
      `comment-auto-approved:${source}:${input.requestId}`,
    );
    logger.log(
      `[comment] 免审通知已发 source=${source} account=${input.accountId ?? '-'} ` +
        `requestId=${input.requestId} note=${input.noteId}`,
    );
  };

  const notifyMandatoryOutcome = async (input: {
    requestId: string;
    outcome: string;
    accountId?: string;
    noteId?: string;
  }): Promise<void> => {
    await deliver(
      { kind: 'mandatory_comment_outcome', input },
      `mandatory-comment-outcome:${input.requestId}:${input.outcome}`,
    );
    logger.log(
      `[comment] mandatory 终态通知已发 outcome=${input.outcome} ` +
        `account=${input.accountId ?? '-'} requestId=${input.requestId} note=${input.noteId}`,
    );
  };

  const approval: CapabilityState<unknown> = options.approvalEnabled
    ? {
        state: 'wired',
        port: {
          request: async (input: {
            requestId: string;
            noteId?: string;
            text: string;
            title?: string;
            authorName?: string;
            accountId?: string;
            accountName?: string;
            originChatId?: string;
          }) => {
            await deliver(
              { kind: 'comment_approval', input },
              `comment-approval:${input.requestId}`,
            );
          },
          isApproved: async (requestId: string) => {
            const decision = await options.publishApproval.read(requestId);
            const approved = decision?.approved === true;
            // 评论授权没有下发段：人审闸读到「已批准」的这一刻，授权就被用掉了。
            // 不迁走的话这条记录会永远停在「已批准·待下发」——一个不会有人来消费的假等待。
            // **best-effort：迁移失败绝不影响本次放行**（红线 3）。
            if (approved && decision && options.publishApproval.markConsumed) {
              await options.publishApproval
                .markConsumed(requestId, decision.revision)
                .catch((error: unknown) => {
                  logger.warn(
                    `[comment] 评论授权状态迁移失败 requestId=${requestId}: ${messageOf(error)}`,
                  );
                  return null;
                });
            }
            return approved;
          },
          timeoutMs: options.timeoutMs ?? 90_000,
          pollMs: options.pollMs ?? 2_000,
        },
      }
    : {
        state: 'unavailable',
        // 具名而非 undefined：与「接了但今天不可用」必须分得开（红线 2）。
        reason: 'comment_approval_disabled_by_env',
      };

  const valuableCorpus: CapabilityState<{
    archive(input: unknown): Promise<void>;
    retrieveByTopics(topics: string[], limit: number): Promise<unknown>;
  }> = options.valuableCommentStore
    ? {
        state: 'wired',
        port: {
          archive: async (input: unknown) => {
            await options.valuableCommentStore!.archive(input as never);
          },
          retrieveByTopics: async (topics: string[], limit: number) =>
            options.valuableCommentStore!.retrieveByTopics(topics as never, limit),
        },
      }
    : { state: 'unavailable', reason: 'valuable_comment_store_unavailable' };

  return {
    approval: approval as AutomationCommentPorts['approval'],
    notifyAutoApproved: notifyAutoApproved as AutomationCommentPorts['notifyAutoApproved'],
    resolveApprovalMode: resolveApprovalMode as AutomationCommentPorts['resolveApprovalMode'],
    notifyMandatoryOutcome:
      notifyMandatoryOutcome as AutomationCommentPorts['notifyMandatoryOutcome'],
    valuableCorpus,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
