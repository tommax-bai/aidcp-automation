import type { EpochMillis, ExecutionTarget } from './common.js';
import type { ReasonCode } from './reason-codes.js';

export type DecisionType =
  | 'creation'
  | 'compilation'
  | 'lane_admission'
  | 'dispatch'
  | 'evidence'
  | 'cancellation'
  | 'reconciliation';

export type DecisionOutcome =
  | 'allowed'
  | 'denied'
  | 'delayed'
  | 'selected'
  | 'skipped'
  | 'attention_required';

export interface DecisionTrace {
  traceId: string;
  executionTarget: ExecutionTarget;
  correlationId: string;
  causationId: string | null;
  taskId: string | null;
  runId: string | null;
  stepRunId: string | null;
  attemptId: string | null;
  decisionType: DecisionType;
  outcome: DecisionOutcome;
  reasonCode: ReasonCode;
  inputRefs: string[];
  evidenceRefs: string[];
  createdAt: EpochMillis;
}
