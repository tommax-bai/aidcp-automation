/**
 * aidcp:test-owner=derived
 * Automation-derived tests verify the factory boundary without importing the
 * content-owned role implementations that are intentionally absent here.
 */
import type {
  RoleFactoryRegistry,
  SubscribableRole,
} from '../../src/orchestrator/role-dispatcher.js';
import type { RoleName } from '../../src/event-bus/types.js';

const CONTENT_ROLE_NAMES = [
  'concept_extractor',
  'curated_note_evaluator',
  'curated_comment_evaluator',
  'valuable_comment_archivist',
] as const satisfies readonly RoleName[];

function inertRole(roleName: RoleName): SubscribableRole {
  return {
    roleName,
    subscribe() {},
    unsubscribe() {},
  };
}

export function contentRoleTestDoubles(): RoleFactoryRegistry {
  return Object.fromEntries(
    CONTENT_ROLE_NAMES.map((roleName) => [
      roleName,
      () => inertRole(roleName),
    ]),
  ) as RoleFactoryRegistry;
}
