import { randomUUID } from 'node:crypto';
import { phaseOneActionAllowed } from '../contracts/action-classification.js';
import type { ReadEvidence } from '../contracts/execution-attempt.js';
import type { ReasonCode } from '../contracts/reason-codes.js';
import type { DecisionTraceStore, TaskAuthorityStore } from '../stores/index.js';
import type { PhaseOneRegistry } from '../registry/index.js';
import {
  parsePersonaResearchParams,
  PERSONA_RESEARCH_CAPABILITY_IDS,
  PERSONA_RESEARCH_TASK_DEFINITION_ID,
  PERSONA_RESEARCH_TASK_DEFINITION_VERSION,
} from '../registry/persona-research.js';
import type {
  StepExecutionRequest,
  StepExecutionResult,
  StepExecutor,
} from '../engine/step-executor.js';
import type { ResearchDispatchOutcome, ResearchDispatchPort } from './research-dispatch-port.js';

type TaskReadPort = Pick<TaskAuthorityStore, 'getTask'>;
type TracePort = Pick<DecisionTraceStore, 'append'>;

export interface ResearchStepExecutorOptions {
  dispatch: ResearchDispatchPort;
  tasks: TaskReadPort;
  traces: TracePort;
  registry: PhaseOneRegistry;
  now?: () => number;
  newTraceId?: () => string;
}

const CAPABILITIES = new Set<string>(PERSONA_RESEARCH_CAPABILITY_IDS);
const STABLE_CONTENT_REF = /^[a-z0-9][a-z0-9._-]*:\S{1,480}$/i;

function exactPostconditionPrefix(capabilityId: string, version: number): string {
  return `postcondition:${capabilityId}@${version}:`;
}

function normalizeEvidence(
  evidence: ReadEvidence,
  capabilityId: string,
  capabilityVersion: number,
  allowEmpty: boolean,
): { ok: true; evidence: ReadEvidence; duplicates: string[] } | { ok: false } {
  if (evidence.evidenceRef.trim() === ''
    || evidence.postconditionRef === null
    || !evidence.postconditionRef.startsWith(exactPostconditionPrefix(capabilityId, capabilityVersion))) {
    return { ok: false };
  }
  const stableContentRefs: string[] = [];
  const duplicates: string[] = [];
  for (const ref of evidence.stableContentRefs) {
    if (!STABLE_CONTENT_REF.test(ref)) return { ok: false };
    if (stableContentRefs.includes(ref)) duplicates.push(ref);
    else stableContentRefs.push(ref);
  }
  if (!allowEmpty && stableContentRefs.length === 0) return { ok: false };
  if (allowEmpty && stableContentRefs.length !== 0) return { ok: false };
  return {
    ok: true,
    evidence: { ...evidence, stableContentRefs },
    duplicates,
  };
}

/** Validates one atomic read receipt. Durable retry bounds remain owned by TaskRunWorker. */
export class ResearchStepExecutor implements StepExecutor {
  private readonly now: () => number;
  private readonly newTraceId: () => string;

  constructor(private readonly options: ResearchStepExecutorOptions) {
    this.now = options.now ?? Date.now;
    this.newTraceId = options.newTraceId ?? randomUUID;
  }

  supports(capabilityId: string, capabilityVersion: number): boolean {
    if (capabilityVersion !== 1 || !CAPABILITIES.has(capabilityId)) return false;
    const capability = this.options.registry.resolveCapability(capabilityId, capabilityVersion);
    return capability !== null
      && capability.sideEffect === 'none'
      && phaseOneActionAllowed(capability.classification);
  }

  async execute(request: StepExecutionRequest): Promise<StepExecutionResult> {
    if (request.signal.aborted) return this.result('aborted', 'execution_failed');
    if (!this.supports(request.node.capabilityId, request.node.capabilityVersion)) {
      return this.result('unsupported', 'unsupported');
    }
    const task = await this.options.tasks.getTask(request.executionTarget, request.taskId);
    if (!task
      || task.executionTarget !== request.executionTarget
      || task.accountId !== request.accountId
      || task.taskDefinitionId !== PERSONA_RESEARCH_TASK_DEFINITION_ID
      || task.taskDefinitionVersion !== PERSONA_RESEARCH_TASK_DEFINITION_VERSION) {
      return this.result('failed', 'contract_invalid');
    }
    if (task.status !== 'active') return this.result('aborted', 'cancelled_by_actor');
    const params = parsePersonaResearchParams(task.constraints);
    if (!params.ok) return this.result('failed', 'contract_invalid');
    if (this.now() >= request.deadlineAt) return this.result('timeout', 'deadline_exceeded');

    let outcome: ResearchDispatchOutcome;
    try {
      outcome = await this.options.dispatch.dispatchReadOnly({
        commandKind: 'managed.research.read',
        commandId: request.attemptId,
        executionTarget: request.executionTarget,
        accountId: request.accountId,
        envKey: task.envKey,
        platform: task.platform,
        taskId: request.taskId,
        runId: request.runId,
        stepRunId: request.stepRunId,
        attemptId: request.attemptId,
        capabilityId: request.node.capabilityId,
        capabilityVersion: request.node.capabilityVersion,
        inputRef: request.inputRef,
        idempotencyKey: request.idempotencyKey,
        correlationId: request.correlationId,
        params: { keywords: params.params.keywords, maxItems: params.params.maxItems },
      }, { deadlineAt: request.deadlineAt, signal: request.signal });
    } catch {
      await this.trace(request, 'reconciliation', 'attention_required', 'result_unknown', [], []);
      return this.result('submitted_unknown', 'result_unknown');
    }

    if (outcome.executionTarget !== request.executionTarget
      || outcome.accountId !== request.accountId
      || outcome.attemptId !== request.attemptId) {
      await this.trace(request, 'reconciliation', 'attention_required', 'result_unknown', [], []);
      return this.result('submitted_unknown', 'result_unknown');
    }
    if (outcome.status !== 'completed' && outcome.status !== 'empty') {
      await this.traceNegative(request, outcome.status, outcome.reasonCode);
      return this.result(outcome.status, outcome.reasonCode);
    }

    const normalized = normalizeEvidence(
      outcome.evidence,
      request.node.capabilityId,
      request.node.capabilityVersion,
      outcome.status === 'empty',
    );
    if (!normalized.ok) {
      await this.trace(request, 'evidence', 'attention_required', 'evidence_invalid', [], [outcome.evidence.evidenceRef]);
      return this.result('submitted_unknown', 'result_unknown');
    }

    const known = new Set(request.knownStableContentRefs);
    const crossAttemptDuplicates = normalized.evidence.stableContentRefs.filter((ref) => known.has(ref));
    const duplicates = [...new Set([...normalized.duplicates, ...crossAttemptDuplicates])];
    if (duplicates.length > 0) {
      await this.trace(
        request,
        'evidence',
        'skipped',
        'duplicate_evidence',
        duplicates,
        [normalized.evidence.evidenceRef],
      );
    }
    return {
      status: outcome.status,
      reasonCode: outcome.reasonCode,
      evidence: normalized.evidence,
    };
  }

  private result(status: StepExecutionResult['status'], reasonCode: ReasonCode): StepExecutionResult {
    return { status, reasonCode, evidence: null };
  }

  private async traceNegative(
    request: StepExecutionRequest,
    status: Exclude<ResearchDispatchOutcome['status'], 'completed' | 'empty'>,
    reasonCode: ReasonCode,
  ): Promise<void> {
    const outcome = status === 'submitted_unknown' ? 'attention_required' : 'denied';
    const decisionType = status === 'submitted_unknown' ? 'reconciliation' : 'dispatch';
    await this.trace(request, decisionType, outcome, reasonCode, [], []);
  }

  private async trace(
    request: StepExecutionRequest,
    decisionType: 'dispatch' | 'evidence' | 'reconciliation',
    outcome: 'denied' | 'skipped' | 'attention_required',
    reasonCode: ReasonCode,
    inputRefs: string[],
    evidenceRefs: string[],
  ): Promise<void> {
    await this.options.traces.append(request.executionTarget, {
      traceId: this.newTraceId(),
      executionTarget: request.executionTarget,
      correlationId: request.correlationId,
      causationId: request.attemptId,
      taskId: request.taskId,
      runId: request.runId,
      stepRunId: request.stepRunId,
      attemptId: request.attemptId,
      decisionType,
      outcome,
      reasonCode,
      inputRefs,
      evidenceRefs,
    });
  }
}
