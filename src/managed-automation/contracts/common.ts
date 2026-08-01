import type { DeploymentTarget } from 'aidcp-kernel/deployment-target.js';

/** Server-injected durable-work target. Clients and natural language never select it. */
export type ExecutionTarget = DeploymentTarget;
export type EpochMillis = number;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type StructuredConstraints = Record<string, JsonValue>;

export interface ContractVersionRef {
  name: string;
  version: number;
}

export interface CorrelationRef {
  correlationId: string;
  causationId: string | null;
}
