import { phaseOneActionAllowed } from '../contracts/action-classification.js';
import type { CapabilityDefinition, TaskDefinition } from '../contracts/capability.js';
import {
  PERSONA_RESEARCH_CAPABILITIES,
  PERSONA_RESEARCH_TASK_DEFINITION,
} from './persona-research.js';

export * from './persona-research.js';

export type RegistryValidationFailure =
  | 'unsupported'
  | 'contract_invalid'
  | 'platform_write_not_supported';

export type RegistryValidationResult =
  | { ok: true; definition: TaskDefinition; capabilities: CapabilityDefinition[] }
  | { ok: false; reason: RegistryValidationFailure; detail: string };

export interface PhaseOneRegistry {
  resolveTaskDefinition(id: string, version: number): TaskDefinition | null;
  resolveCapability(id: string, version: number): CapabilityDefinition | null;
  validateTaskDefinition(id: string, version: number): RegistryValidationResult;
}

export interface PhaseOneRegistryOptions {
  additionalDefinitions?: readonly TaskDefinition[];
  additionalCapabilities?: readonly CapabilityDefinition[];
}

function key(id: string, version: number): string {
  return `${id}@${version}`;
}

function validateLinearGraph(definition: TaskDefinition): string | null {
  if (definition.nodes.length === 0 || definition.nodes.length > definition.bounds.maxNodes) {
    return 'node count is outside the declared bound';
  }
  if (definition.edges.length !== definition.nodes.length - 1) {
    return 'phase-one graph must be a single linear chain';
  }
  for (let index = 0; index < definition.edges.length; index += 1) {
    const edge = definition.edges[index]!;
    if (edge.from !== definition.nodes[index]!.nodeId || edge.to !== definition.nodes[index + 1]!.nodeId) {
      return 'phase-one graph contains a branch, cycle, or disconnected edge';
    }
  }
  return null;
}

export function createPhaseOneRegistry(options: PhaseOneRegistryOptions = {}): PhaseOneRegistry {
  const definitions = new Map<string, TaskDefinition>();
  const capabilities = new Map<string, CapabilityDefinition>();

  for (const definition of [PERSONA_RESEARCH_TASK_DEFINITION, ...(options.additionalDefinitions ?? [])]) {
    const definitionKey = key(definition.taskDefinitionId, definition.version);
    if (definitions.has(definitionKey)) throw new Error(`duplicate task definition ${definitionKey}`);
    definitions.set(definitionKey, definition);
  }
  for (const capability of [
    ...PERSONA_RESEARCH_CAPABILITIES,
    ...(options.additionalCapabilities ?? []),
  ]) {
    const capabilityKey = key(capability.capabilityId, capability.version);
    if (capabilities.has(capabilityKey)) throw new Error(`duplicate capability ${capabilityKey}`);
    capabilities.set(capabilityKey, capability);
  }

  const resolveTaskDefinition = (id: string, version: number): TaskDefinition | null =>
    definitions.get(key(id, version)) ?? null;
  const resolveCapability = (id: string, version: number): CapabilityDefinition | null =>
    capabilities.get(key(id, version)) ?? null;

  return {
    resolveTaskDefinition,
    resolveCapability,
    validateTaskDefinition(id, version) {
      const definition = resolveTaskDefinition(id, version);
      if (definition === null) {
        return { ok: false, reason: 'unsupported', detail: `unknown task definition ${key(id, version)}` };
      }
      const graphError = validateLinearGraph(definition);
      if (graphError !== null) {
        return { ok: false, reason: 'contract_invalid', detail: graphError };
      }

      const resolved: CapabilityDefinition[] = [];
      for (const node of definition.nodes) {
        const capability = resolveCapability(node.capabilityId, node.capabilityVersion);
        if (capability === null) {
          return {
            ok: false,
            reason: 'unsupported',
            detail: `unknown capability ${key(node.capabilityId, node.capabilityVersion)}`,
          };
        }
        if (capability.sideEffect !== 'none' || !phaseOneActionAllowed(capability.classification)) {
          return {
            ok: false,
            reason: 'platform_write_not_supported',
            detail: `phase one rejects mutation capability ${key(node.capabilityId, node.capabilityVersion)}`,
          };
        }
        resolved.push(capability);
      }
      return { ok: true, definition, capabilities: resolved };
    },
  };
}
