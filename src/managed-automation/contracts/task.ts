import type { PlatformId } from 'aidcp-kernel/kernel/platform-types.js';
import type { EpochMillis, ExecutionTarget, StructuredConstraints } from './common.js';
import type { CapabilityId } from './capability.js';

export interface CapabilityScope {
  allow: CapabilityId[];
  deny: CapabilityId[];
}

export interface TaskExecutionBudget {
  maxBrowserMinutes: number;
  maxSteps: number;
  maxExecutionAttempts: number;
  maxWaitMs: number;
}

export interface TaskScheduleWindow {
  scheduledAt: EpochMillis;
  latestStartAt: EpochMillis;
  missPolicy: 'skip' | 'execute_when_available';
}

export type TaskLifecycleStatus = 'active' | 'cancelled' | 'completed';

/** Automation-owned runtime authority. API remains the actor/account authorization owner. */
export interface Task {
  taskId: string;
  executionTarget: ExecutionTarget;
  accountId: string;
  envKey: string;
  platform: PlatformId;
  taskDefinitionId: string;
  taskDefinitionVersion: number;
  currentRevisionId: string;
  capabilityScope: CapabilityScope;
  constraints: StructuredConstraints;
  budget: TaskExecutionBudget;
  schedule: TaskScheduleWindow;
  authorizationRevision: string;
  actorRef: string;
  status: TaskLifecycleStatus;
  correlationId: string;
  aggregateVersion: number;
  createdAt: EpochMillis;
  updatedAt: EpochMillis;
}

export type TaskRevisionCause = 'create' | 'revise' | 'cancel';

export interface TaskRevision {
  revisionId: string;
  taskId: string;
  executionTarget: ExecutionTarget;
  ordinal: number;
  cause: TaskRevisionCause;
  capabilityScope: CapabilityScope;
  constraints: StructuredConstraints;
  budget: TaskExecutionBudget;
  schedule: TaskScheduleWindow;
  authorizationRevision: string;
  actorRef: string;
  supersedesRevisionId: string | null;
  createdAt: EpochMillis;
}
