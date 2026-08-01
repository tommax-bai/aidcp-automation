import type { EpochMillis, ExecutionTarget } from './common.js';
import type { CapabilityId } from './capability.js';
import type { ReasonCode } from './reason-codes.js';

export interface ExecutionIntent {
  intentId: string;
  executionTarget: ExecutionTarget;
  runId: string;
  stepRunId: string;
  accountId: string;
  capabilityId: CapabilityId;
  capabilityVersion: number;
  inputRef: string;
  idempotencyKey: string;
  correlationId: string;
  createdAt: EpochMillis;
}

export type ExecutionAttemptStatus =
  | 'prepared'
  | 'dispatching'
  | 'submitted_unknown'
  | 'completed'
  | 'empty'
  | 'failed'
  | 'timeout'
  | 'undeliverable'
  | 'aborted'
  | 'unsupported';

export const EXECUTION_ATTEMPT_STATUSES = [
  'prepared',
  'dispatching',
  'submitted_unknown',
  'completed',
  'empty',
  'failed',
  'timeout',
  'undeliverable',
  'aborted',
  'unsupported',
] as const satisfies readonly ExecutionAttemptStatus[];

export interface ReadEvidence {
  evidenceRef: string;
  stableContentRefs: string[];
  postconditionRef: string | null;
}

export interface ExecutionAttempt {
  attemptId: string;
  executionTarget: ExecutionTarget;
  intentId: string;
  runId: string;
  stepRunId: string;
  ordinal: number;
  status: ExecutionAttemptStatus;
  reasonCode: ReasonCode | null;
  evidence: ReadEvidence | null;
  strongestProgressEvidenceRef: string | null;
  reconciliationCount: number;
  preparedAt: EpochMillis;
  dispatchedAt: EpochMillis | null;
  settledAt: EpochMillis | null;
}
