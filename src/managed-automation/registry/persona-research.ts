import type { JsonValue, StructuredConstraints } from '../contracts/common.js';
import type { CapabilityDefinition, TaskDefinition } from '../contracts/capability.js';

export const PERSONA_RESEARCH_TASK_DEFINITION_ID = 'persona.research';
export const PERSONA_RESEARCH_TASK_DEFINITION_VERSION = 1;

export const PERSONA_RESEARCH_CAPABILITY_IDS = [
  'research.search',
  'research.browse',
  'research.assess',
  'research.summarize',
] as const;

export type PersonaResearchCapabilityId = (typeof PERSONA_RESEARCH_CAPABILITY_IDS)[number];

const boundsByCapability: Record<PersonaResearchCapabilityId, number> = {
  'research.search': 90_000,
  'research.browse': 300_000,
  'research.assess': 120_000,
  'research.summarize': 120_000,
};

export const PERSONA_RESEARCH_CAPABILITIES: readonly CapabilityDefinition[] =
  PERSONA_RESEARCH_CAPABILITY_IDS.map((capabilityId) => ({
    capabilityId,
    version: 1,
    inputSchemaRef: `schema:${capabilityId}/input@1`,
    outputSchemaRef: `schema:${capabilityId}/output@1`,
    sideEffect: 'none',
    classification: { domain: 'research', executionClass: 'read_only' },
    requiredEvidenceRef: 'evidence:stable-content-read@1',
    bounds: { maxWallClockMs: boundsByCapability[capabilityId], maxExecutionAttempts: 3 },
  }));

function nodeIdFor(capabilityId: PersonaResearchCapabilityId): string {
  return capabilityId.slice('research.'.length);
}

export const PERSONA_RESEARCH_TASK_DEFINITION: TaskDefinition = {
  taskDefinitionId: PERSONA_RESEARCH_TASK_DEFINITION_ID,
  version: PERSONA_RESEARCH_TASK_DEFINITION_VERSION,
  inputSchemaRef: 'schema:persona.research/input@1',
  nodes: PERSONA_RESEARCH_CAPABILITY_IDS.map((capabilityId) => ({
    nodeId: nodeIdFor(capabilityId),
    capabilityId,
    capabilityVersion: 1,
    inputBindingRef: `bind:persona.research@1/${nodeIdFor(capabilityId)}`,
  })),
  edges: PERSONA_RESEARCH_CAPABILITY_IDS.slice(0, -1).map((capabilityId, index) => ({
    kind: 'linear',
    from: nodeIdFor(capabilityId),
    to: nodeIdFor(PERSONA_RESEARCH_CAPABILITY_IDS[index + 1]!),
  })),
  bounds: { maxNodes: 4, maxExecutionAttempts: 3, maxWallClockMs: 660_000 },
  completionConditionRef: 'completion:persona.research@1',
  publishedAt: 1_785_369_600_000,
};

export const PERSONA_RESEARCH_MAX_ITEMS = 20;
const PERSONA_RESEARCH_MAX_KEYWORDS = 8;
const PERSONA_RESEARCH_DEFAULT_MAX_ITEMS = 5;

export interface PersonaResearchParams {
  keywords: string[];
  maxItems: number;
}

export type PersonaResearchParamsResult =
  | { ok: true; params: PersonaResearchParams }
  | { ok: false; detail: string };

export function parsePersonaResearchParams(
  constraints: StructuredConstraints,
): PersonaResearchParamsResult {
  const rawKeywords: JsonValue | undefined = constraints.keywords;
  if (!Array.isArray(rawKeywords) || rawKeywords.length === 0) {
    return { ok: false, detail: 'keywords must be a non-empty string array' };
  }

  const keywords: string[] = [];
  for (const value of rawKeywords) {
    if (typeof value !== 'string' || value.trim() === '') {
      return { ok: false, detail: 'keywords contains an invalid item' };
    }
    const keyword = value.trim();
    if (!keywords.includes(keyword)) keywords.push(keyword);
  }
  if (keywords.length > PERSONA_RESEARCH_MAX_KEYWORDS) {
    return { ok: false, detail: `keywords exceeds ${PERSONA_RESEARCH_MAX_KEYWORDS}` };
  }

  const rawMaxItems: JsonValue | undefined = constraints.maxItems;
  if (rawMaxItems === undefined) {
    return { ok: true, params: { keywords, maxItems: PERSONA_RESEARCH_DEFAULT_MAX_ITEMS } };
  }
  if (!Number.isInteger(rawMaxItems) || typeof rawMaxItems !== 'number' || rawMaxItems < 1) {
    return { ok: false, detail: 'maxItems must be a positive integer' };
  }
  if (rawMaxItems > PERSONA_RESEARCH_MAX_ITEMS) {
    return { ok: false, detail: `maxItems exceeds ${PERSONA_RESEARCH_MAX_ITEMS}` };
  }
  return { ok: true, params: { keywords, maxItems: rawMaxItems } };
}
