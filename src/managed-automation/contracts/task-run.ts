import type { EpochMillis, ExecutionTarget } from './common.js';
import type { CapabilityId } from './capability.js';
import type { ReasonCode, WaitReasonCode } from './reason-codes.js';

export type RunStatus = 'queued' | 'waiting' | 'running' | 'cancel_requested' | 'terminal';

export type RunTerminalOutcome =
  | 'succeeded'
  | 'partially_succeeded'
  | 'skipped'
  | 'failed'
  | 'cancelled'
  | 'attention_required';

export interface OrthogonalRunState {
  status: RunStatus;
  waitReason: WaitReasonCode | null;
  terminalOutcome: RunTerminalOutcome | null;
  reasonCode: ReasonCode | null;
}

export interface RunProgress {
  confirmedUnits: number;
  targetUnits: number | null;
  lastCheckpointRef: string | null;
}

export interface TaskRun {
  runId: string;
  executionTarget: ExecutionTarget;
  taskId: string;
  taskRevisionId: string;
  executionPlanId: string;
  accountId: string;
  state: OrthogonalRunState;
  progress: RunProgress;
  currentNodeId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: EpochMillis | null;
  attemptCount: number;
  version: number;
  createdAt: EpochMillis;
  updatedAt: EpochMillis;
  terminalAt: EpochMillis | null;
}

export interface StepRun {
  stepRunId: string;
  executionTarget: ExecutionTarget;
  runId: string;
  nodeId: string;
  capabilityId: CapabilityId;
  capabilityVersion: number;
  state: OrthogonalRunState;
  progress: RunProgress;
  attemptCount: number;
  version: number;
  startedAt: EpochMillis | null;
  updatedAt: EpochMillis;
  terminalAt: EpochMillis | null;
}
