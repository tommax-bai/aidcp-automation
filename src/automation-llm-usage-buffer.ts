/**
 * 模型 token 用量的**合并缓冲**（task 2.4d-用量）—— 自动化进程这一侧。
 *
 * ## 为什么需要它，而不是每次调用发一条 HTTP
 *
 * 属主（content）原来的记账入口是同步、无返回、纯内存的 `add()`：按
 * 「10 分钟桶 + 账号 + 角色 + 厂商 + 模型」在内存里合并，另有定时器批量落库。
 * 那个签名**跨不过进程边界**——照抄只会得到一个必然撒谎的方法（`void` 无处报错），
 * 而一次调用一条 HTTP 会把一条低频旁路挂到每一次模型调用的热路径上。
 *
 * 所以跨界端口的形状是「**提交已经合并好的增量行**」，合并留在调用方。本文件就是那个调用方，
 * 它的家在自动化进程的 `main()`（文本模型出口的 `onCall` 钩子挂到 {@link AutomationLlmUsageBuffer.record}）。
 *
 * ## 三条 MUST，逐条都是「照直觉写就会错」的地方（判据在 kernel 端口文件头）
 *
 * 1. **桶起点由本侧在调用发生那一刻戳。** 批量提交必然晚于发生时刻（要等合并窗口），
 *    让属主按收到请求的时刻重算，等于把一批用量整体挪进错误的时间桶 —— 曲线平移，且零报错。
 * 2. **传输失败 MUST NOT 重投。** 属主侧是 `ON CONFLICT … 累加`（可交换计数器，不是幂等写），
 *    同一批提交两次 ＝ 数字翻倍。超时是典型的**结果未知**：对面可能已经加上了。
 *    用量是**可丢**的观测数据，所以正确处置是**丢弃 + 计数留痕**，
 *    MUST NOT 重投，更 MUST NOT 把「不知道成没成」记成成功。
 * 3. **回执是「真的落库了几行」，不是「请求发出去了」。** 属主逐行写、逐行容错，
 *    天然可能只落一部分；`applied` 小于提交行数即有增量被丢，本侧 MUST 把差额计数留痕。
 *
 * ## 还有两条本文件自己守的
 *
 * - **{@link AutomationLlmUsageBuffer.record} 绝不抛。** 它挂在模型调用的完成回调上，
 *   往那条路径上抛异常就是「记账把正事拖垮了」——属主自己的文件头也明写 MUST NOT 拖垮模型调用。
 * - **没有账号的调用就地丢掉**（属主今天也是这么做的），MUST NOT 兜一个默认账号：
 *   跨进程之后那会落成一行谁都归属不了的账，而不是被谁挡下来。
 */
import {
  llmUsageBucketStart,
  type LlmUsageIncrement,
  type LlmUsageRecordingPort,
} from 'aidcp-kernel/kernel/llm-usage-recording-port.js';

/**
 * 三个维度的占位取值。
 *
 * ⚠️ **它们与属主（content 的用量存储）私有的那三个常量必须逐字相同**，否则同一种「未打标」
 * 的调用会按写入路径落成两行不同维度的账 —— 表不会报错，只是曲线悄悄裂成两条。
 * 今天两侧各持一份（属主那份是模块私有 const），**这是一处已知的手抄件**，
 * 已登记 tasks 2.4d-用量-占位：应当把这三个值抬进 kernel 的端口文件、两侧都从那里取。
 * 在那之前，改动这里 MUST 同批改属主那一份。
 */
export const LLM_USAGE_UNTAGGED_ROLE = 'untagged';
export const LLM_USAGE_UNKNOWN_PROVIDER = 'unknown';
export const LLM_USAGE_UNKNOWN_MODEL = 'unknown';

/** 本缓冲要的那一小片调用回执（取文本模型出口 `onCall` 的子集，形状不在这里另立）。 */
export interface AutomationLlmCallUsage {
  role?: string;
  provider?: string;
  model: string;
  ok: boolean;
  accountId?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AutomationLlmUsageBufferOptions {
  /** 跨属主提交口（content 的用量记账客户端）。 */
  sink: LlmUsageRecordingPort;
  /** 合并窗口。缺省 60s —— 比属主的 10 分钟桶短一个量级，保证一个桶会被提交多次而不是攒满再发。 */
  flushIntervalMs?: number;
  logger?: Pick<Console, 'log' | 'warn'>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearTimer?: (handle: ReturnType<typeof setInterval>) => void;
}

export interface AutomationLlmUsageStats {
  /** 缺账号被就地丢掉的调用数。 */
  droppedNoAccount: number;
  /** 因传输失败被丢弃的**增量行**数（不重投，见 MUST 2）。 */
  discardedRows: number;
  /** 属主明确表示没落上的行数（`applied` 与提交行数的差额，见 MUST 3）。 */
  unappliedRows: number;
  /** 已确认落库的行数。 */
  appliedRows: number;
}

export interface AutomationLlmUsageBuffer {
  /** 热路径入口。**同步、绝不抛**。 */
  record(info: AutomationLlmCallUsage): void;
  /** 提交当前窗口。**失败即丢弃并计数**，绝不重投。 */
  flush(): Promise<void>;
  /** 起周期提交。**构造期不起**（与本仓其余各片一致，留给业务入口放行之后）。 */
  start(): void;
  /** 停表并做最后一次提交（同样不重投）。 */
  stop(): Promise<void>;
  stats(): AutomationLlmUsageStats;
}

const DEFAULT_FLUSH_MS = 60_000;

function dimension(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function nonNegative(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : 0;
}

export function createAutomationLlmUsageBuffer(
  options: AutomationLlmUsageBufferOptions,
): AutomationLlmUsageBuffer {
  const logger = options.logger ?? console;
  const now = options.now ?? Date.now;
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_MS;
  const setTimer =
    options.setTimer ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((handle: ReturnType<typeof setInterval>) => clearInterval(handle));

  let buffer = new Map<string, LlmUsageIncrement>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let flushing: Promise<void> | null = null;
  let warnedNoAccount = false;
  let warnedUntagged = false;
  const stats: AutomationLlmUsageStats = {
    droppedNoAccount: 0,
    discardedRows: 0,
    unappliedRows: 0,
    appliedRows: 0,
  };

  const record = (info: AutomationLlmCallUsage): void => {
    try {
      const accountId = info.accountId?.trim();
      if (!accountId) {
        // 属主今天也是这么做的：**丢掉，不兜默认账号**。跨进程之后兜底会落成一行谁都归属不了的账。
        stats.droppedNoAccount += 1;
        if (!warnedNoAccount) {
          warnedNoAccount = true;
          logger.warn(
            '[aidcp-automation][llm-usage] 调用缺 accountId，已丢弃该条用量（绝不回落默认账号）；本条每进程只说一次',
          );
        }
        return;
      }
      const role = dimension(info.role, LLM_USAGE_UNTAGGED_ROLE);
      if (role === LLM_USAGE_UNTAGGED_ROLE && !warnedUntagged) {
        warnedUntagged = true;
        logger.warn('[aidcp-automation][llm-usage] 记到一次未打标角色的模型调用；本条每进程只说一次');
      }
      const provider = dimension(info.provider, LLM_USAGE_UNKNOWN_PROVIDER);
      const model = dimension(info.model, LLM_USAGE_UNKNOWN_MODEL);
      // MUST 1：桶起点在**调用发生这一刻**戳，不留给属主用收到请求的时刻重算。
      const bucketStartMs = llmUsageBucketStart(now());
      const key = `${bucketStartMs}|${accountId}|${role}|${provider}|${model}`;
      const current = buffer.get(key);
      const promptTokens = nonNegative(info.promptTokens);
      const completionTokens = nonNegative(info.completionTokens);
      // **总数取厂商回报的那一个**，MUST NOT 由输入 + 输出凑：两者对不上时那个差额本身就是信号
      // （缓存命中、思考 token…），凑数会把它抹平。
      const totalTokens = nonNegative(info.totalTokens);
      const okCalls = info.ok ? 1 : 0;
      if (current) {
        current.promptTokens += promptTokens;
        current.completionTokens += completionTokens;
        current.totalTokens += totalTokens;
        current.calls += 1;
        current.okCalls += okCalls;
        return;
      }
      buffer.set(key, {
        bucketStartMs,
        accountId,
        role,
        provider,
        model,
        promptTokens,
        completionTokens,
        totalTokens,
        calls: 1,
        okCalls,
      });
    } catch (error) {
      // 记账**绝不**把正事拖垮：这条回调挂在模型调用的完成路径上。
      logger.warn(
        `[aidcp-automation][llm-usage] 记账内部异常，已吞掉以免拖垮模型调用：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  const submit = async (): Promise<void> => {
    if (buffer.size === 0) return;
    // 先把窗口换掉：提交期间新来的调用进新窗口，不会被这一次的成败牵连。
    const rows = [...buffer.values()];
    buffer = new Map();
    let applied: number;
    try {
      applied = await options.sink.recordUsage(rows);
    } catch (error) {
      // MUST 2：**丢弃，绝不重投**。属主侧是累加不是幂等写，重投即翻倍；
      // 而超时是「结果未知」——对面可能已经加上了。用量是可丢的观测数据，丢弃是这里唯一安全的处置。
      stats.discardedRows += rows.length;
      logger.warn(
        `[aidcp-automation][llm-usage] 提交失败，已丢弃 ${rows.length} 行（**不重投**：属主侧是累加计数器，`
          + `重投即翻倍；累计丢弃 ${stats.discardedRows} 行）：${
            error instanceof Error ? error.message : String(error)
          }`,
      );
      return;
    }
    // MUST 3：回执是「真的落库了几行」。差额即被属主丢掉的行，如实计数。
    const landed = Number.isFinite(applied) ? Math.max(0, Math.floor(applied)) : 0;
    stats.appliedRows += Math.min(landed, rows.length);
    if (landed < rows.length) {
      const lost = rows.length - landed;
      stats.unappliedRows += lost;
      logger.warn(
        `[aidcp-automation][llm-usage] 属主只落了 ${landed}/${rows.length} 行，`
          + `本次丢 ${lost} 行（累计 ${stats.unappliedRows}）——这不是传输失败，是属主明确说它没写上`,
      );
    }
  };

  const flush = (): Promise<void> => {
    // 串行化：两次提交并行会让「换窗口」竞态，且属主那边同一批可能被拆成两笔累加。
    const next = (flushing ?? Promise.resolve()).then(submit, submit);
    flushing = next.catch(() => undefined);
    return next;
  };

  return {
    record,
    flush,
    start() {
      if (timer !== null) return;
      timer = setTimer(() => {
        void flush().catch(() => undefined);
      }, flushIntervalMs);
      timer.unref?.();
    },
    async stop() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      // 最后一次提交也照 MUST 2 办：失败即丢，不因为「要关了」就重投。
      await flush().catch(() => undefined);
    },
    stats: () => ({ ...stats }),
  };
}
