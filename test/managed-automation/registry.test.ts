import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CapabilityDefinition, TaskDefinition } from '../../src/managed-automation/contracts/index.js';
import {
  PERSONA_RESEARCH_CAPABILITIES,
  PERSONA_RESEARCH_CAPABILITY_IDS,
  PERSONA_RESEARCH_TASK_DEFINITION,
  createPhaseOneRegistry,
  parsePersonaResearchParams,
} from '../../src/managed-automation/registry/index.js';

describe('phase-one managed automation registry', () => {
  it('publishes exactly the bounded four-step read-only research graph', () => {
    assert.deepEqual(
      PERSONA_RESEARCH_TASK_DEFINITION.nodes.map((node) => node.capabilityId),
      [...PERSONA_RESEARCH_CAPABILITY_IDS],
    );
    assert.equal(PERSONA_RESEARCH_TASK_DEFINITION.edges.length, 3);
    assert.equal(PERSONA_RESEARCH_CAPABILITIES.every(
      (capability) => capability.sideEffect === 'none'
        && capability.classification.domain === 'research'
        && capability.classification.executionClass === 'read_only',
    ), true);
    assert.equal(createPhaseOneRegistry().validateTaskDefinition('persona.research', 1).ok, true);
  });

  it('parses bounded research parameters without hiding invalid values', () => {
    assert.deepEqual(parsePersonaResearchParams({ keywords: ['alpha', ' alpha ', 'beta'] }), {
      ok: true,
      params: { keywords: ['alpha', 'beta'], maxItems: 5 },
    });
    assert.equal(parsePersonaResearchParams({ keywords: ['alpha'], maxItems: 21 }).ok, false);
    assert.equal(parsePersonaResearchParams({ keywords: [], maxItems: 1 }).ok, false);
  });

  it('rejects unknown definitions without version fallback', () => {
    const result = createPhaseOneRegistry().validateTaskDefinition('persona.research', 2);
    assert.deepEqual(result, {
      ok: false,
      reason: 'unsupported',
      detail: 'unknown task definition persona.research@2',
    });
  });

  it('rejects every mutation domain before execution', () => {
    const mutationDomains = ['interaction', 'publish', 'reply', 'account_admin'] as const;
    for (const domain of mutationDomains) {
      const capability: CapabilityDefinition = {
        capabilityId: `${domain}.mutation`,
        version: 1,
        inputSchemaRef: 'schema:mutation/input@1',
        outputSchemaRef: 'schema:mutation/output@1',
        sideEffect: 'external_write',
        classification: { domain, executionClass: 'platform_write' },
        requiredEvidenceRef: 'evidence:platform-write@1',
        bounds: { maxWallClockMs: 1_000, maxExecutionAttempts: 1 },
      };
      const definition: TaskDefinition = {
        taskDefinitionId: `${domain}.task`,
        version: 1,
        inputSchemaRef: 'schema:mutation/task@1',
        nodes: [{
          nodeId: 'mutation',
          capabilityId: capability.capabilityId,
          capabilityVersion: 1,
          inputBindingRef: null,
        }],
        edges: [],
        bounds: { maxNodes: 1, maxExecutionAttempts: 1, maxWallClockMs: 1_000 },
        completionConditionRef: 'completion:mutation@1',
        publishedAt: 1,
      };
      const result = createPhaseOneRegistry({
        additionalDefinitions: [definition],
        additionalCapabilities: [capability],
      }).validateTaskDefinition(definition.taskDefinitionId, 1);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, 'platform_write_not_supported');
    }
  });

  it('rejects a disconnected graph even when every capability is read-only', () => {
    const disconnected: TaskDefinition = {
      ...PERSONA_RESEARCH_TASK_DEFINITION,
      taskDefinitionId: 'persona.research.disconnected',
      edges: PERSONA_RESEARCH_TASK_DEFINITION.edges.slice(0, 2),
    };
    const result = createPhaseOneRegistry({ additionalDefinitions: [disconnected] })
      .validateTaskDefinition(disconnected.taskDefinitionId, disconnected.version);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'contract_invalid');
  });
});
