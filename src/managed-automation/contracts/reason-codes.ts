export type RejectionReasonCode =
  | 'account_not_authorized'
  | 'capability_not_available'
  | 'capability_scope_denied'
  | 'contract_invalid'
  | 'execution_target_mismatch'
  | 'feature_disabled'
  | 'idempotency_collision'
  | 'invalid_task_request'
  | 'platform_write_not_supported'
  | 'protocol_version_mismatch'
  | 'schema_not_ready'
  | 'unsupported';

export type WaitReasonCode =
  | 'waiting_for_account_lane'
  | 'waiting_for_edge'
  | 'waiting_for_reconciliation'
  | 'waiting_until';

export type TerminalReasonCode =
  | 'cancelled_by_actor'
  | 'content_exhausted'
  | 'deadline_exceeded'
  | 'empty_result'
  | 'execution_failed'
  | 'execution_timeout'
  | 'no_qualified_target'
  | 'partial_completion'
  | 'result_unknown'
  | 'succeeded';

export type EvidenceReasonCode =
  | 'duplicate_evidence'
  | 'evidence_invalid';

export type ReasonCode = RejectionReasonCode | WaitReasonCode | TerminalReasonCode | EvidenceReasonCode;

export const REJECTION_REASON_CODES = [
  'account_not_authorized',
  'capability_not_available',
  'capability_scope_denied',
  'contract_invalid',
  'execution_target_mismatch',
  'feature_disabled',
  'idempotency_collision',
  'invalid_task_request',
  'platform_write_not_supported',
  'protocol_version_mismatch',
  'schema_not_ready',
  'unsupported',
] as const satisfies readonly RejectionReasonCode[];

export const WAIT_REASON_CODES = [
  'waiting_for_account_lane',
  'waiting_for_edge',
  'waiting_for_reconciliation',
  'waiting_until',
] as const satisfies readonly WaitReasonCode[];

export const TERMINAL_REASON_CODES = [
  'cancelled_by_actor',
  'content_exhausted',
  'deadline_exceeded',
  'empty_result',
  'execution_failed',
  'execution_timeout',
  'no_qualified_target',
  'partial_completion',
  'result_unknown',
  'succeeded',
] as const satisfies readonly TerminalReasonCode[];

export const EVIDENCE_REASON_CODES = [
  'duplicate_evidence',
  'evidence_invalid',
] as const satisfies readonly EvidenceReasonCode[];
