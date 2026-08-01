/** Phase one executes only read-only capabilities. */
export type ActionExecutionClass = 'read_only' | 'platform_write';

export type ActionDomain =
  | 'research'
  | 'interaction'
  | 'publish'
  | 'reply'
  | 'account_admin';

export type ActionAuthorizationLevel =
  | 'disabled'
  | 'require_approval'
  | 'standing_authorized';

export type ActionDomainAuthorization = Partial<Record<ActionDomain, ActionAuthorizationLevel>>;

export interface ActionClassification {
  domain: ActionDomain;
  executionClass: ActionExecutionClass;
}

export function phaseOneActionAllowed(classification: ActionClassification): boolean {
  return classification.domain === 'research' && classification.executionClass === 'read_only';
}
