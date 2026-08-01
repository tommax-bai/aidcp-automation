import { createHash, randomUUID } from 'node:crypto';
import type { ExecutionAttempt, ExecutionAttemptStatus } from '../contracts/execution-attempt.js';
import type { ExecutionPlan, ExecutionPlanNode } from '../contracts/execution-plan.js';
import type { ReasonCode } from '../contracts/reason-codes.js';
import type { RunProgress, RunTerminalOutcome, StepRun, TaskRun } from '../contracts/task-run.js';
import type { ExecutionTarget } from '../contracts/common.js';
import type { AccountLaneArbiter } from './account-lane-arbiter.js';
import { resolveLinearGraph } from './linear-graph.js';
import type { StepExecutionResult, StepExecutorRegistry } from './step-executor.js';
import type { ExecutionLedgerStore, RunStateStore, TaskAuthorityStore } from '../stores/index.js';

export const MANAGED_TASK_WORKER_ENV = 'AIDCP_MANAGED_TASK_WORKER_ENABLED';

export function isManagedTaskWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MANAGED_TASK_WORKER_ENV] === 'true';
}

type RunStatePort = Pick<RunStateStore,
  'claimNextRun' | 'claimNextCancellation' | 'renewRunLease' | 'getRun'
  | 'transitionRun' | 'insertStep' | 'getStep' | 'listStepsByRun' | 'transitionStep'>;
type AuthorityPort = Pick<TaskAuthorityStore, 'getPlan'>;
type LedgerPort = Pick<ExecutionLedgerStore,
  'getIntentByIdempotencyKey' | 'insertIntent' | 'insertAttempt'
  | 'listAttemptsByIntent' | 'listAttemptsByRun' | 'transitionAttempt'>;
type LanePort = Pick<AccountLaneArbiter,
  'acquireManaged' | 'renewManaged' | 'retainManagedForShutdown' | 'releaseManaged'>;

export interface TaskRunWorkerFlags {
  workerEnabled(): boolean;
}

export interface TaskRunWorkerOptions {
  executionTarget: ExecutionTarget;
  runState: RunStatePort;
  authority: AuthorityPort;
  ledger: LedgerPort;
  lanes: LanePort;
  executors: StepExecutorRegistry;
  flags?: TaskRunWorkerFlags;
  ready?: () => boolean | Promise<boolean>;
  workerId?: string;
  leaseMs?: number;
  renewIntervalMs?: number;
  waitingRetryMs?: number;
  maxRunsPerTick?: number;
  shutdownRetentionMs?: number;
  now?: () => number;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export type WorkerTickResult =
  | { outcome: 'disabled' | 'not_ready'; claimed: 0 }
  | { outcome: 'idle' | 'processed'; claimed: number };

interface ActiveRun {
  runId: string;
  accountId: string;
  abort: AbortController;
  runVersion: number;
  laneVersion: number;
  dispatchAttemptId: string | null;
  unsettledDispatch: boolean;
  renewing: boolean;
  renewPromise: Promise<void>;
  retentionPromise: Promise<void> | null;
  processPromise: Promise<void> | null;
}

interface StepOutcome {
  outcome: 'succeeded' | 'skipped';
  reasonCode: ReasonCode | null;
}

const NULL_STATE = { waitReason: null, terminalOutcome: null, reasonCode: null } as const;

function deterministicUuid(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function progressFromAttempts(run: TaskRun, attempts: readonly ExecutionAttempt[]): RunProgress {
  const refs = new Set(attempts.flatMap((attempt) =>
    attempt.status === 'completed' ? (attempt.evidence?.stableContentRefs ?? []) : []));
  const evidence = [...attempts].reverse().find((attempt) =>
    (attempt.status === 'completed' || attempt.status === 'empty') && attempt.evidence !== null)?.evidence;
  return {
    confirmedUnits: Math.max(run.progress.confirmedUnits, refs.size),
    targetUnits: run.progress.targetUnits,
    lastCheckpointRef: evidence?.evidenceRef ?? run.progress.lastCheckpointRef,
  };
}

function aggregate(outcomes: readonly StepOutcome[]): StepOutcome {
  const skipped = outcomes.filter((value) => value.outcome === 'skipped');
  if (skipped.length === 0) return { outcome: 'succeeded', reasonCode: 'succeeded' };
  const reasonCode = skipped.at(-1)?.reasonCode ?? 'empty_result';
  return skipped.length === outcomes.length
    ? { outcome: 'skipped', reasonCode }
    : { outcome: 'succeeded', reasonCode: 'partial_completion' };
}

/** Owner-local durable worker. Production construction is deliberately deferred to task 6.2. */
export class TaskRunWorker {
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly renewIntervalMs: number;
  private readonly waitingRetryMs: number;
  private readonly maxRunsPerTick: number;
  private readonly shutdownRetentionMs: number;
  private readonly now: () => number;
  private readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;
  private readonly active = new Map<string, ActiveRun>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly options: TaskRunWorkerOptions) {
    this.workerId = options.workerId ?? `managed-task-${randomUUID()}`;
    this.leaseMs = Math.max(1_000, options.leaseMs ?? 60_000);
    this.renewIntervalMs = Math.max(250, options.renewIntervalMs ?? Math.floor(this.leaseMs / 3));
    this.waitingRetryMs = Math.max(0, options.waitingRetryMs ?? 5_000);
    this.maxRunsPerTick = Math.max(1, Math.trunc(options.maxRunsPerTick ?? 5));
    this.shutdownRetentionMs = Math.max(this.leaseMs, options.shutdownRetentionMs ?? 5 * 60_000);
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
  }

  private enabled(): boolean {
    return this.options.flags?.workerEnabled() ?? isManagedTaskWorkerEnabled();
  }

  async start(intervalMs = 5_000): Promise<boolean> {
    if (!this.enabled() || !(await (this.options.ready?.() ?? true))) return false;
    if (this.timer) return true;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick().catch((error) => {
      this.logger.error(`[managed-task] worker tick failed: ${String(error)}`);
    }), Math.max(250, intervalMs));
    this.timer.unref?.();
    return true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const state of this.active.values()) state.abort.abort(new Error('worker_stopped'));
    for (const state of this.active.values()) state.renewing = false;
    await Promise.allSettled([...this.active.values()].map((state) => this.retainUnsafe(state)));
  }

  async tick(): Promise<WorkerTickResult> {
    if (this.stopped || !this.enabled()) return { outcome: 'disabled', claimed: 0 };
    if (!(await (this.options.ready?.() ?? true))) return { outcome: 'not_ready', claimed: 0 };

    const cancellation = await this.options.runState.claimNextCancellation(
      this.options.executionTarget, this.workerId, this.leaseMs, this.now(),
    );
    if (cancellation) await this.processCancellation(cancellation);

    let claimed = 0;
    while (claimed < this.maxRunsPerTick && !this.stopped && this.enabled()) {
      const run = await this.options.runState.claimNextRun(
        this.options.executionTarget,
        this.workerId,
        this.leaseMs,
        this.now(),
        this.waitingRetryMs,
      );
      if (!run) break;
      claimed += 1;
      await this.processClaim(run);
    }
    return { outcome: claimed === 0 ? 'idle' : 'processed', claimed };
  }

  private async processClaim(run: TaskRun): Promise<void> {
    const lane = await this.options.lanes.acquireManaged(run.accountId, run.runId, this.workerId);
    if (lane.outcome !== 'acquired') {
      const waitReason = lane.outcome === 'reconciliation_required'
        ? 'waiting_for_reconciliation' : 'waiting_for_account_lane';
      await this.waitRun(run, waitReason, lane.reason);
      return;
    }

    const state: ActiveRun = {
      runId: run.runId,
      accountId: run.accountId,
      abort: new AbortController(),
      runVersion: run.version,
      laneVersion: lane.lane.version,
      dispatchAttemptId: null,
      unsettledDispatch: false,
      renewing: true,
      renewPromise: Promise.resolve(),
      retentionPromise: null,
      processPromise: null,
    };
    this.active.set(run.runId, state);
    const timer = setInterval(() => this.scheduleRenew(state), this.renewIntervalMs);
    timer.unref?.();
    state.processPromise = this.execute(run, state);
    try {
      await state.processPromise;
    } finally {
      clearInterval(timer);
      state.renewing = false;
      await state.renewPromise;
      if (state.unsettledDispatch && state.dispatchAttemptId !== null) {
        await this.retainUnsafe(state);
      } else if (this.stopped && state.abort.signal.aborted) {
        await this.options.lanes.releaseManaged(
          run.accountId, run.runId, this.workerId, state.laneVersion,
        ).catch((error) => this.logger.error(`[managed-task] lane release failed: ${String(error)}`));
      }
      this.active.delete(run.runId);
    }
  }

  private scheduleRenew(state: ActiveRun): void {
    if (!state.renewing) return;
    state.renewPromise = state.renewPromise.then(async () => {
      if (!state.renewing || state.abort.signal.aborted) return;
      const [renewedRun, renewedLane] = await Promise.all([
        this.options.runState.renewRunLease(
          this.options.executionTarget, state.runId, this.workerId,
          state.runVersion, this.leaseMs, this.now(),
        ).catch(() => null),
        this.options.lanes.renewManaged(state.accountId, this.workerId, state.laneVersion).catch(() => null),
      ]);
      if (renewedLane === null) {
        state.abort.abort(new Error('account_lane_lost'));
        return;
      }
      state.laneVersion = renewedLane.version;
      if (renewedRun !== null) {
        state.runVersion = renewedRun.version;
        return;
      }
      const fresh = await this.options.runState.getRun(this.options.executionTarget, state.runId).catch(() => null);
      if (fresh?.state.status !== 'cancel_requested') state.abort.abort(new Error('run_lease_lost'));
    });
  }

  private retainUnsafe(state: ActiveRun): Promise<void> {
    if (!state.unsettledDispatch || state.dispatchAttemptId === null) return Promise.resolve();
    state.retentionPromise ??= state.renewPromise.then(async () => {
      await this.options.lanes.retainManagedForShutdown(
        state.accountId,
        this.workerId,
        state.laneVersion,
        this.shutdownRetentionMs,
        [`attempt:${state.dispatchAttemptId!}`],
      );
    }).catch((error) => this.logger.error(`[managed-task] lane retention failed: ${String(error)}`));
    return state.retentionPromise;
  }

  private async execute(initialRun: TaskRun, active: ActiveRun): Promise<void> {
    const target = this.options.executionTarget;
    const plan = await this.options.authority.getPlan(target, initialRun.executionPlanId);
    if (!plan || plan.executionTarget !== target
      || plan.executionPlanId !== initialRun.executionPlanId
      || plan.taskId !== initialRun.taskId
      || plan.taskRevisionId !== initialRun.taskRevisionId) {
      await this.terminalRun(initialRun, active, 'failed', 'contract_invalid');
      return;
    }
    const graph = resolveLinearGraph(plan.nodes.map((node) => node.nodeId), plan.edges);
    if (!graph.ok || graph.order[0] !== plan.entryNodeId || graph.order.length > plan.bounds.maxNodes) {
      await this.terminalRun(initialRun, active, 'failed', 'contract_invalid');
      return;
    }

    const unsafe = (await this.options.ledger.listAttemptsByRun(target, initialRun.runId))
      .find((attempt) => attempt.status === 'dispatching' || attempt.status === 'submitted_unknown');
    if (unsafe) {
      active.dispatchAttemptId = unsafe.attemptId;
      active.unsettledDispatch = true;
      await this.waitRun(await this.freshRun(initialRun), 'waiting_for_reconciliation', 'result_unknown');
      return;
    }

    const nodes = new Map(plan.nodes.map((node) => [node.nodeId, node]));
    const steps = new Map((await this.options.runState.listStepsByRun(target, initialRun.runId))
      .map((step) => [step.nodeId, step]));
    const outcomes: StepOutcome[] = [];

    for (const nodeId of graph.order) {
      if (active.abort.signal.aborted) return;
      const before = await this.freshRun(initialRun);
      active.runVersion = before.version;
      if (before.state.status === 'cancel_requested') {
        await this.convergeCancellation(before, active);
        return;
      }
      if (before.state.status !== 'running') return;

      const node = nodes.get(nodeId)!;
      let step = steps.get(nodeId) ?? await this.createOrReadStep(before, node);
      steps.set(nodeId, step);
      if (step.state.status === 'terminal') {
        if (step.state.terminalOutcome === 'failed' || step.state.terminalOutcome === 'attention_required') {
          await this.terminalRun(before, active, 'failed', step.state.reasonCode ?? 'execution_failed');
          return;
        }
        outcomes.push({
          outcome: step.state.terminalOutcome === 'skipped' ? 'skipped' : 'succeeded',
          reasonCode: step.state.reasonCode,
        });
        continue;
      }

      const result = await this.executeStep(before, plan, node, step, active);
      if (result === 'ownership_lost' || result === 'reconciliation') return;
      step = result.step;
      steps.set(nodeId, step);
      outcomes.push(result.outcome);
      if (result.failed) {
        await this.terminalRun(await this.freshRun(before), active, 'failed', result.outcome.reasonCode);
        return;
      }

      const after = await this.freshRun(before);
      active.runVersion = after.version;
      if (after.state.status === 'cancel_requested') {
        await this.convergeCancellation(after, active);
        return;
      }
      if (after.state.status !== 'running') return;
      const attempts = await this.options.ledger.listAttemptsByRun(target, after.runId);
      const nextProgress = progressFromAttempts(after, attempts);
      const checkpointed = await this.options.runState.transitionRun(target, after.runId, after.version, 'running', {
        state: { status: 'running', ...NULL_STATE },
        progress: nextProgress,
        currentNodeId: nodeId,
        incrementAttemptCount: true,
      });
      if (!checkpointed) return;
      active.runVersion = after.version + 1;
    }

    const fresh = await this.freshRun(initialRun);
    active.runVersion = fresh.version;
    if (fresh.state.status === 'cancel_requested') {
      await this.convergeCancellation(fresh, active);
      return;
    }
    if (fresh.state.status !== 'running') return;
    const result = aggregate(outcomes);
    await this.terminalRun(
      fresh,
      active,
      result.reasonCode === 'partial_completion' ? 'partially_succeeded' : result.outcome,
      result.reasonCode,
    );
  }

  private async createOrReadStep(run: TaskRun, node: ExecutionPlanNode): Promise<StepRun> {
    const stepRunId = deterministicUuid(`step:${run.runId}:${node.nodeId}`);
    await this.options.runState.insertStep(this.options.executionTarget, {
      stepRunId,
      runId: run.runId,
      nodeId: node.nodeId,
      capabilityId: node.capabilityId,
      capabilityVersion: node.capabilityVersion,
      targetUnits: null,
    });
    const step = await this.options.runState.getStep(this.options.executionTarget, stepRunId);
    if (!step) throw new Error(`step ${stepRunId} disappeared after insert`);
    return step;
  }

  private async executeStep(
    run: TaskRun,
    plan: ExecutionPlan,
    node: ExecutionPlanNode,
    initialStep: StepRun,
    active: ActiveRun,
  ): Promise<
    | 'ownership_lost'
    | 'reconciliation'
    | { step: StepRun; outcome: StepOutcome; failed: boolean }
  > {
    const target = this.options.executionTarget;
    const inputRef = node.inputBindingRef;
    const executor = this.options.executors.resolve(node.capabilityId, node.capabilityVersion);
    if (inputRef === null || executor === null) {
      const step = await this.finishUnsupported(initialStep);
      return { step, outcome: { outcome: 'skipped', reasonCode: 'unsupported' }, failed: true };
    }

    const idempotencyKey = `managed-task/${run.runId}/${node.nodeId}`;
    let intent = await this.options.ledger.getIntentByIdempotencyKey(target, idempotencyKey);
    if (!intent) {
      const intentId = deterministicUuid(`intent:${idempotencyKey}`);
      const inserted = await this.options.ledger.insertIntent(target, {
        intentId,
        executionTarget: target,
        runId: run.runId,
        stepRunId: initialStep.stepRunId,
        accountId: run.accountId,
        capabilityId: node.capabilityId,
        capabilityVersion: node.capabilityVersion,
        inputRef,
        idempotencyKey,
        correlationId: `managed-task:${run.runId}:${node.nodeId}`,
      });
      if (inserted.outcome === 'collision') throw new Error(`intent idempotency collision ${idempotencyKey}`);
      intent = inserted.intent;
    }

    let step = initialStep;
    const existing = await this.options.ledger.listAttemptsByIntent(target, intent.intentId);
    const unsafe = existing.find((attempt) =>
      attempt.status === 'dispatching' || attempt.status === 'submitted_unknown');
    if (unsafe) {
      active.dispatchAttemptId = unsafe.attemptId;
      active.unsettledDispatch = true;
      await this.waitRun(await this.freshRun(run), 'waiting_for_reconciliation', 'result_unknown');
      return 'reconciliation';
    }

    const settled = existing.at(-1);
    if (settled?.status === 'completed' || settled?.status === 'empty') {
      step = await this.finishStepFromAttempt(step, settled);
      return {
        step,
        outcome: settled.status === 'empty'
          ? { outcome: 'skipped', reasonCode: settled.reasonCode ?? 'empty_result' }
          : { outcome: 'succeeded', reasonCode: 'succeeded' },
        failed: false,
      };
    }

    let ordinal = settled?.status === 'prepared' ? settled.ordinal : existing.length + 1;
    let preparedAttemptId = settled?.status === 'prepared' ? settled.attemptId : null;
    while (ordinal <= plan.bounds.maxExecutionAttempts) {
      const freshRun = await this.freshRun(run);
      active.runVersion = freshRun.version;
      if (freshRun.state.status === 'cancel_requested') {
        await this.convergeCancellation(freshRun, active);
        return 'ownership_lost';
      }
      if (freshRun.state.status !== 'running' || active.abort.signal.aborted) return 'ownership_lost';

      if (step.state.status !== 'running') {
        const started = await this.options.runState.transitionStep(target, step.stepRunId, step.version, step.state.status, {
          state: { status: 'running', ...NULL_STATE },
          progress: step.progress,
          incrementAttemptCount: true,
        });
        if (!started) return 'ownership_lost';
        step = (await this.options.runState.getStep(target, step.stepRunId))!;
      } else if (ordinal > 1) {
        const restarted = await this.options.runState.transitionStep(target, step.stepRunId, step.version, 'running', {
          state: { status: 'running', ...NULL_STATE },
          progress: step.progress,
          incrementAttemptCount: true,
        });
        if (!restarted) return 'ownership_lost';
        step = (await this.options.runState.getStep(target, step.stepRunId))!;
      }

      const attemptId = preparedAttemptId ?? deterministicUuid(`attempt:${intent.intentId}:${ordinal}`);
      preparedAttemptId = null;
      await this.options.ledger.insertAttempt(target, {
        attemptId,
        intentId: intent.intentId,
        runId: run.runId,
        stepRunId: step.stepRunId,
        ordinal,
      });
      const dispatchedAt = this.now();
      const dispatchMarked = await this.options.ledger.transitionAttempt(target, attemptId, 'prepared', {
        status: 'dispatching', reasonCode: null, evidence: null,
        strongestProgressEvidenceRef: null, dispatchedAt, settledAt: null,
      });
      if (!dispatchMarked) {
        const known = (await this.options.ledger.listAttemptsByIntent(target, intent.intentId))
          .find((attempt) => attempt.attemptId === attemptId);
        if (known?.status === 'dispatching' || known?.status === 'submitted_unknown') {
          active.dispatchAttemptId = attemptId;
          active.unsettledDispatch = true;
          await this.waitRun(await this.freshRun(run), 'waiting_for_reconciliation', 'result_unknown');
          return 'reconciliation';
        }
        if (known?.status === 'completed' || known?.status === 'empty') {
          step = await this.finishStepFromAttempt(step, known);
          return {
            step,
            outcome: known.status === 'empty'
              ? { outcome: 'skipped', reasonCode: known.reasonCode ?? 'empty_result' }
              : { outcome: 'succeeded', reasonCode: 'succeeded' },
            failed: false,
          };
        }
        ordinal += 1;
        continue;
      }

      active.dispatchAttemptId = attemptId;
      active.unsettledDispatch = true;
      let result: StepExecutionResult;
      try {
        result = await executor.execute({
          executionTarget: target,
          accountId: run.accountId,
          taskId: run.taskId,
          runId: run.runId,
          stepRunId: step.stepRunId,
          attemptId,
          idempotencyKey,
          node,
          inputRef,
          deadlineAt: run.createdAt + plan.bounds.maxWallClockMs,
          correlationId: intent.correlationId,
          signal: active.abort.signal,
        });
      } catch (error) {
        result = {
          status: active.abort.signal.aborted ? 'aborted' : 'failed',
          reasonCode: active.abort.signal.aborted ? 'execution_failed' : 'execution_failed',
          evidence: null,
        };
      }
      if (active.abort.signal.aborted) return 'ownership_lost';

      const settledAt = result.status === 'submitted_unknown' ? null : this.now();
      const transitioned = await this.options.ledger.transitionAttempt(target, attemptId, 'dispatching', {
        status: result.status,
        reasonCode: result.reasonCode,
        evidence: result.evidence,
        strongestProgressEvidenceRef: result.evidence?.evidenceRef ?? null,
        dispatchedAt,
        settledAt,
      });
      if (!transitioned) return 'ownership_lost';
      active.unsettledDispatch = result.status === 'submitted_unknown';
      if (result.status === 'submitted_unknown') {
        await this.waitRun(await this.freshRun(run), 'waiting_for_reconciliation', 'result_unknown');
        return 'reconciliation';
      }

      const attempt: ExecutionAttempt = {
        attemptId,
        executionTarget: target,
        intentId: intent.intentId,
        runId: run.runId,
        stepRunId: step.stepRunId,
        ordinal,
        status: result.status,
        reasonCode: result.reasonCode,
        evidence: result.evidence,
        strongestProgressEvidenceRef: result.evidence?.evidenceRef ?? null,
        reconciliationCount: 0,
        preparedAt: dispatchedAt,
        dispatchedAt,
        settledAt,
      };
      if (result.status === 'completed' || result.status === 'empty') {
        step = await this.finishStepFromAttempt(step, attempt);
        return {
          step,
          outcome: result.status === 'empty'
            ? { outcome: 'skipped', reasonCode: result.reasonCode }
            : { outcome: 'succeeded', reasonCode: result.reasonCode },
          failed: false,
        };
      }
      if (ordinal === plan.bounds.maxExecutionAttempts) {
        step = await this.finishFailedStep(step, result.status, result.reasonCode);
        return { step, outcome: { outcome: 'skipped', reasonCode: result.reasonCode }, failed: true };
      }
      ordinal += 1;
    }
    throw new Error('attempt loop exhausted unexpectedly');
  }

  private async finishStepFromAttempt(step: StepRun, attempt: ExecutionAttempt): Promise<StepRun> {
    const succeeded = attempt.status === 'completed';
    const refs = attempt.evidence?.stableContentRefs ?? [];
    const changed = await this.options.runState.transitionStep(
      this.options.executionTarget, step.stepRunId, step.version, step.state.status,
      {
        state: {
          status: 'terminal', waitReason: null,
          terminalOutcome: succeeded ? 'succeeded' : 'skipped',
          reasonCode: attempt.reasonCode ?? (succeeded ? 'succeeded' : 'empty_result'),
        },
        progress: {
          confirmedUnits: Math.max(step.progress.confirmedUnits, new Set(refs).size),
          targetUnits: step.progress.targetUnits,
          lastCheckpointRef: attempt.evidence?.evidenceRef ?? step.progress.lastCheckpointRef,
        },
      },
    );
    if (!changed) throw new Error(`step ${step.stepRunId} checkpoint CAS lost`);
    return (await this.options.runState.getStep(this.options.executionTarget, step.stepRunId))!;
  }

  private async finishFailedStep(
    step: StepRun,
    status: ExecutionAttemptStatus,
    reasonCode: ReasonCode,
  ): Promise<StepRun> {
    const changed = await this.options.runState.transitionStep(
      this.options.executionTarget, step.stepRunId, step.version, step.state.status,
      {
        state: { status: 'terminal', waitReason: null, terminalOutcome: 'failed', reasonCode },
        progress: step.progress,
      },
    );
    if (!changed) throw new Error(`step ${step.stepRunId} ${status} CAS lost`);
    return (await this.options.runState.getStep(this.options.executionTarget, step.stepRunId))!;
  }

  private async finishUnsupported(step: StepRun): Promise<StepRun> {
    return this.finishFailedStep(step, 'unsupported', 'unsupported');
  }

  private async freshRun(fallback: TaskRun): Promise<TaskRun> {
    return (await this.options.runState.getRun(this.options.executionTarget, fallback.runId)) ?? fallback;
  }

  private async waitRun(run: TaskRun, waitReason: 'waiting_for_account_lane' | 'waiting_for_reconciliation', reason: string): Promise<void> {
    if (run.state.status !== 'running') return;
    await this.options.runState.transitionRun(this.options.executionTarget, run.runId, run.version, 'running', {
      state: { status: 'waiting', waitReason, terminalOutcome: null, reasonCode: waitReason },
      progress: run.progress,
      currentNodeId: run.currentNodeId,
    });
    this.logger.info(`[managed-task] run=${run.runId} waiting: ${reason}`);
  }

  private async terminalRun(
    run: TaskRun,
    active: ActiveRun,
    outcome: RunTerminalOutcome,
    reasonCode: ReasonCode | null,
  ): Promise<void> {
    active.renewing = false;
    await active.renewPromise;
    const fresh = await this.freshRun(run);
    active.runVersion = fresh.version;
    if (fresh.state.status === 'cancel_requested') {
      await this.convergeCancellation(fresh, active);
      return;
    }
    if (fresh.state.status !== 'running' || active.abort.signal.aborted) return;
    const attempts = await this.options.ledger.listAttemptsByRun(this.options.executionTarget, run.runId);
    const done = await this.options.runState.transitionRun(
      this.options.executionTarget, run.runId, fresh.version, 'running', {
        state: { status: 'terminal', waitReason: null, terminalOutcome: outcome, reasonCode },
        progress: progressFromAttempts(fresh, attempts),
        currentNodeId: fresh.currentNodeId,
      },
    );
    if (!done) return;
    active.runVersion = fresh.version + 1;
    active.abort.abort(new Error('run_terminal'));
    const release = await this.options.lanes.releaseManaged(
      run.accountId, run.runId, this.workerId, active.laneVersion,
    );
    if (release === 'released') active.unsettledDispatch = false;
  }

  private async convergeCancellation(run: TaskRun, active?: ActiveRun): Promise<void> {
    const attempts = await this.options.ledger.listAttemptsByRun(this.options.executionTarget, run.runId);
    const unsafe = attempts.find((attempt) =>
      attempt.status === 'dispatching' || attempt.status === 'submitted_unknown');
    if (unsafe) {
      if (active) {
        active.dispatchAttemptId = unsafe.attemptId;
        active.unsettledDispatch = true;
      }
      return;
    }
    if (!active) return;
    active.renewing = false;
    await active.renewPromise;
    const done = await this.options.runState.transitionRun(
      this.options.executionTarget, run.runId, run.version, 'cancel_requested', {
        state: {
          status: 'terminal', waitReason: null, terminalOutcome: 'cancelled', reasonCode: 'cancelled_by_actor',
        },
        progress: progressFromAttempts(run, attempts),
        currentNodeId: run.currentNodeId,
      },
    );
    if (!done) return;
    active.runVersion = run.version + 1;
    active.abort.abort(new Error('run_cancelled'));
    const release = await this.options.lanes.releaseManaged(
      run.accountId, run.runId, this.workerId, active.laneVersion,
    );
    if (release === 'released') active.unsettledDispatch = false;
  }

  private async processCancellation(run: TaskRun): Promise<void> {
    const attempts = await this.options.ledger.listAttemptsByRun(this.options.executionTarget, run.runId);
    if (attempts.some((attempt) =>
      attempt.status === 'dispatching' || attempt.status === 'submitted_unknown')) return;
    const lane = await this.options.lanes.acquireManaged(run.accountId, run.runId, this.workerId);
    if (lane.outcome !== 'acquired') return;
    const active: ActiveRun = {
      runId: run.runId,
      accountId: run.accountId,
      abort: new AbortController(),
      runVersion: run.version,
      laneVersion: lane.lane.version,
      dispatchAttemptId: null,
      unsettledDispatch: false,
      renewing: false,
      renewPromise: Promise.resolve(),
      retentionPromise: null,
      processPromise: null,
    };
    await this.convergeCancellation(run, active);
  }
}
