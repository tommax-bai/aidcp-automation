import type { EpochMillis } from './common.js';
import type { ActionClassification } from './action-classification.js';

export type CapabilityId = string;
export type CapabilitySideEffect = 'none' | 'external_write';

export interface CapabilityDefinition {
  capabilityId: CapabilityId;
  version: number;
  inputSchemaRef: string;
  outputSchemaRef: string;
  sideEffect: CapabilitySideEffect;
  classification: ActionClassification;
  requiredEvidenceRef: string;
  bounds: {
    maxWallClockMs: number;
    maxExecutionAttempts: number;
  };
}

export interface LinearCapabilityNode {
  nodeId: string;
  capabilityId: CapabilityId;
  capabilityVersion: number;
  inputBindingRef: string | null;
}

export interface LinearCapabilityEdge {
  kind: 'linear';
  from: string;
  to: string;
}

/** Code-reviewed definitions only; phase one rejects branches, loops, and scripts. */
export interface TaskDefinition {
  taskDefinitionId: string;
  version: number;
  inputSchemaRef: string;
  nodes: LinearCapabilityNode[];
  edges: LinearCapabilityEdge[];
  bounds: {
    maxNodes: number;
    maxExecutionAttempts: number;
    maxWallClockMs: number;
  };
  completionConditionRef: string;
  publishedAt: EpochMillis;
}
