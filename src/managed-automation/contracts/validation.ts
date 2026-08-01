import { createHash } from 'node:crypto';
import { parseDeploymentTarget } from 'aidcp-kernel/deployment-target.js';
import type { JsonValue, ContractVersionRef, ExecutionTarget } from './common.js';
import type { ExecutionAttemptStatus } from './execution-attempt.js';
import type { OrthogonalRunState, RunStatus } from './task-run.js';

export type ContractValidationErrorCode =
  | 'contract_invalid'
  | 'protocol_version_mismatch'
  | 'execution_target_mismatch';

export class ContractValidationError extends Error {
  constructor(
    readonly code: ContractValidationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ContractValidationError';
  }
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;

  const sorted: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = canonicalize(value[key]!);
  }
  return sorted;
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}

export function payloadHash(value: JsonValue): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function requireContractVersion(
  value: unknown,
  expectedName: string,
  supportedVersion: number,
): ContractVersionRef {
  if (value === null || typeof value !== 'object') {
    throw new ContractValidationError('contract_invalid', 'contract version must be an object');
  }
  const candidate = value as Partial<ContractVersionRef>;
  if (candidate.name !== expectedName || candidate.version !== supportedVersion) {
    throw new ContractValidationError(
      'protocol_version_mismatch',
      `unsupported contract ${String(candidate.name)}@${String(candidate.version)}`,
    );
  }
  return { name: expectedName, version: supportedVersion };
}

export function requireExecutionTarget(value: unknown): ExecutionTarget {
  const target = parseDeploymentTarget(value);
  if (target === null) {
    throw new ContractValidationError(
      'execution_target_mismatch',
      `invalid execution target ${String(value)}`,
    );
  }
  return target;
}

export function isOrthogonalRunStateValid(state: OrthogonalRunState): boolean {
  return (state.status === 'waiting') === (state.waitReason !== null)
    && (state.status === 'terminal') === (state.terminalOutcome !== null)
    && (state.status === 'waiting' || state.status === 'terminal' || state.reasonCode === null);
}

const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ['queued', 'waiting', 'running', 'cancel_requested', 'terminal'],
  waiting: ['waiting', 'running', 'cancel_requested', 'terminal'],
  running: ['running', 'waiting', 'cancel_requested', 'terminal'],
  cancel_requested: ['cancel_requested', 'terminal'],
  terminal: ['terminal'],
};

export function canTransitionRunStatus(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

const TERMINAL_ATTEMPT_STATUSES = new Set<ExecutionAttemptStatus>([
  'completed',
  'empty',
  'failed',
  'timeout',
  'undeliverable',
  'aborted',
  'unsupported',
]);

export function isTerminalAttemptStatus(status: ExecutionAttemptStatus): boolean {
  return TERMINAL_ATTEMPT_STATUSES.has(status);
}

export function canTransitionAttemptStatus(
  from: ExecutionAttemptStatus,
  to: ExecutionAttemptStatus,
): boolean {
  if (isTerminalAttemptStatus(from)) return from === to;
  if (from === to) return true;
  if (from === 'prepared') return to === 'dispatching' || to === 'aborted' || to === 'unsupported';
  if (from === 'dispatching') {
    return to === 'submitted_unknown'
      || to === 'completed'
      || to === 'empty'
      || to === 'failed'
      || to === 'undeliverable'
      || to === 'aborted';
  }
  return isTerminalAttemptStatus(to);
}
