/**
 * StateObservationChannel — 观察命令「问现状」的云端通道（change add-state-observation-command）。
 *
 * 职责边界（**只落通道不接决策**）：把「发一条 state.read、等它的 state.report」做成一次
 * 可关联、有界超时的请求。何时问、问完怎么改航向＝阶段四（观测决策上移），不在本类。
 *
 * 关联形态照 identity.read_current 的既有形态：captureId 由云端生成、随命令下发、应答原样
 * 回传，pending 表按它关联；信封 id 关联发生在边缘侧（state.report 的 envelope.id = 请求
 * envelope.id），由 handler 转成事件时以 envelopeId 一并携带，供审计与将来强校验。
 *
 * 三态诚实（tasks 3.2）：`reported`（拿到应答，内容自表两态）/ `timeout`（边缘静默——
 * 如实上抛，MUST NOT 伪造成一份 unconfirmed 观察）/ `not_sent`（出口未投递，如边缘不在线）。
 * 三态不得压成一态：`timeout` 与「应答说没能确认」是两件事，压在一起云端就分不清
 * 「边缘没收到」与「边缘读不出来」。
 */
import { randomUUID } from 'node:crypto';
import type { StateReportPayload } from './protocol.js';

export type StateObservationOutcome =
  | { kind: 'reported'; report: StateReportPayload; envelopeId?: string }
  | { kind: 'timeout' }
  | { kind: 'not_sent' };

export interface StateObservationChannelDeps {
  /** 下发出口：把带 captureId 的 state.read 发出去；返回 false = 未投递（如边缘不在线）。 */
  sendStateRead: (captureId: string) => boolean;
  /** 应答等待上限（ms）；默认 20s（照本人身份采集的兜底口径）。 */
  timeoutMs?: number;
  /** 关联 id 生成器；测试可注入。 */
  createCaptureId?: () => string;
  /** 计时器注入（测试桩）；生产用全局 setTimeout/clearTimeout（unref，不阻进程退出）。 */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export const DEFAULT_STATE_OBSERVATION_TIMEOUT_MS = 20_000;

interface PendingObservation {
  resolve: (outcome: StateObservationOutcome) => void;
  timer: unknown;
}

export class StateObservationChannel {
  private readonly pending = new Map<string, PendingObservation>();
  private readonly timeoutMs: number;
  private readonly createCaptureId: () => string;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  constructor(private readonly deps: StateObservationChannelDeps) {
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_STATE_OBSERVATION_TIMEOUT_MS;
    this.createCaptureId = deps.createCaptureId ?? randomUUID;
    this.setTimeoutFn = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = deps.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** 在途请求数（只读，供用例与排障；pending 泄漏 = 超时通道失效的直接证据）。 */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** 问一次现状：下发 + 有界等待。每次调用独立生成 captureId，可并发多问互不串扰。 */
  ask(): Promise<StateObservationOutcome> {
    const captureId = this.createCaptureId();
    return new Promise<StateObservationOutcome>((resolve) => {
      const timer = this.setTimeoutFn(() => {
        if (!this.pending.delete(captureId)) return;
        resolve({ kind: 'timeout' });
      }, this.timeoutMs);
      if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
      this.pending.set(captureId, { resolve, timer });
      let sent = false;
      try {
        sent = this.deps.sendStateRead(captureId);
      } catch {
        sent = false;
      }
      if (!sent) {
        this.settle(captureId, { kind: 'not_sent' });
      }
    });
  }

  /**
   * 应答入口（由 `state.report.arrived` 事件接线）。按 captureId 命中 pending 即 resolve；
   * 迟到 / 不认识的应答按无主丢弃（pending 已按超时收口，绝不复活一次已判 timeout 的请求）。
   */
  onReport(report: StateReportPayload, envelopeId?: string): void {
    this.settle(report.captureId, {
      kind: 'reported',
      report,
      ...(envelopeId ? { envelopeId } : {}),
    });
  }

  /** 关停：把所有在途请求按 not_sent 收口（绝不悬挂调用方），并清掉计时器。 */
  dispose(): void {
    for (const captureId of [...this.pending.keys()]) {
      this.settle(captureId, { kind: 'not_sent' });
    }
  }

  private settle(captureId: string, outcome: StateObservationOutcome): void {
    const entry = this.pending.get(captureId);
    if (!entry) return;
    this.pending.delete(captureId);
    this.clearTimeoutFn(entry.timer);
    entry.resolve(outcome);
  }
}
