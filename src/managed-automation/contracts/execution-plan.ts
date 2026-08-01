import type { EpochMillis, ExecutionTarget } from './common.js';
import type { CapabilityId } from './capability.js';

export interface ExecutionPlanNode {
  nodeId: string;
  capabilityId: CapabilityId;
  capabilityVersion: number;
  inputBindingRef: string | null;
}

export interface ExecutionPlanEdge {
  kind: 'linear';
  from: string;
  to: string;
}

export interface ExecutionPlan {
  executionPlanId: string;
  executionTarget: ExecutionTarget;
  taskId: string;
  taskRevisionId: string;
  taskDefinitionId: string;
  taskDefinitionVersion: number;
  authorizationRevision: string;
  nodes: ExecutionPlanNode[];
  edges: ExecutionPlanEdge[];
  entryNodeId: string;
  bounds: {
    maxNodes: number;
    maxExecutionAttempts: number;
    maxWallClockMs: number;
  };
  completionConditionRef: string;
  /** Hash of the canonical compiled plan payload; the plan is never updated in place. */
  planHash: string;
  compiledAt: EpochMillis;
}
