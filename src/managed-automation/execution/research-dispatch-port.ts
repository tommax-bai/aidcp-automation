import type { PlatformId } from 'aidcp-kernel/kernel/platform-types.js';
import type { CapabilityId } from '../contracts/capability.js';
import type { ExecutionTarget, StructuredConstraints } from '../contracts/common.js';
import type { ReadEvidence } from '../contracts/execution-attempt.js';
import type { ReasonCode } from '../contracts/reason-codes.js';

export interface ReadOnlyResearchCommand {
  commandKind: 'managed.research.read';
  commandId: string;
  executionTarget: ExecutionTarget;
  accountId: string;
  envKey: string;
  platform: PlatformId;
  taskId: string;
  runId: string;
  stepRunId: string;
  attemptId: string;
  capabilityId: CapabilityId;
  capabilityVersion: number;
  inputRef: string;
  idempotencyKey: string;
  correlationId: string;
  params: StructuredConstraints;
}

interface BoundResearchReceipt {
  executionTarget: ExecutionTarget;
  accountId: string;
  attemptId: string;
}

export type ResearchDispatchOutcome = BoundResearchReceipt & (
  | { status: 'completed' | 'empty'; reasonCode: ReasonCode; evidence: ReadEvidence }
  | { status: 'submitted_unknown'; reasonCode: 'result_unknown'; evidence: null }
  | {
    status: 'failed' | 'timeout' | 'undeliverable' | 'aborted' | 'unsupported';
    reasonCode: ReasonCode;
    evidence: null;
  }
);

export interface ResearchDispatchOptions {
  deadlineAt: number;
  signal: AbortSignal;
}

/** One call represents one durable Attempt. Implementations must never retry an ambiguous send. */
export interface ResearchDispatchPort {
  dispatchReadOnly(
    command: ReadOnlyResearchCommand,
    options: ResearchDispatchOptions,
  ): Promise<ResearchDispatchOutcome>;
}
