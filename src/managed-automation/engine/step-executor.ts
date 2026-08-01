import type { ExecutionTarget } from '../contracts/common.js';
import type { ExecutionPlanNode } from '../contracts/execution-plan.js';
import type { ReadEvidence } from '../contracts/execution-attempt.js';
import type { ReasonCode } from '../contracts/reason-codes.js';

export interface StepExecutionRequest {
  executionTarget: ExecutionTarget;
  accountId: string;
  taskId: string;
  runId: string;
  stepRunId: string;
  attemptId: string;
  idempotencyKey: string;
  node: ExecutionPlanNode;
  inputRef: string;
  deadlineAt: number;
  correlationId: string;
  knownStableContentRefs: readonly string[];
  signal: AbortSignal;
}

export interface StepExecutionResult {
  status:
    | 'submitted_unknown'
    | 'completed'
    | 'empty'
    | 'failed'
    | 'timeout'
    | 'undeliverable'
    | 'aborted'
    | 'unsupported';
  reasonCode: ReasonCode;
  evidence: ReadEvidence | null;
}

export interface StepExecutor {
  supports(capabilityId: string, capabilityVersion: number): boolean;
  execute(request: StepExecutionRequest): Promise<StepExecutionResult>;
}

export class StepExecutorRegistry {
  constructor(private readonly executors: readonly StepExecutor[]) {}

  resolve(capabilityId: string, capabilityVersion: number): StepExecutor | null {
    const matches = this.executors.filter((executor) => executor.supports(capabilityId, capabilityVersion));
    if (matches.length > 1) throw new Error(`duplicate step executor ${capabilityId}@${capabilityVersion}`);
    return matches[0] ?? null;
  }
}
