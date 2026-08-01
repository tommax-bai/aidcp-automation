import type { PlatformId } from 'aidcp-kernel/kernel/platform-types.js';
import type {
  ConnectionRuntimeRegistry,
  ManagedTaskConnectionTarget,
} from '../../orchestrator/connection-runtime.js';
import type { PersonaResearchCapabilityId } from '../registry/persona-research.js';
import type {
  ReadOnlyResearchCommand,
  ResearchDispatchOptions,
  ResearchDispatchOutcome,
  ResearchDispatchPort,
} from './research-dispatch-port.js';

export const MANAGED_RESEARCH_EDGE_CAPABILITIES = {
  'research.search': 'managed_research_search_v1',
  'research.browse': 'managed_research_browse_v1',
  'research.assess': 'managed_research_assess_v1',
  'research.summarize': 'managed_research_summarize_v1',
} as const satisfies Record<PersonaResearchCapabilityId, string>;

const PLATFORM_CAPABILITIES: Readonly<Record<PlatformId, readonly PersonaResearchCapabilityId[]>> = {
  xiaohongshu: ['research.search', 'research.browse', 'research.assess', 'research.summarize'],
  facebook: ['research.search', 'research.browse', 'research.assess', 'research.summarize'],
  wechat_channels: [],
};

export type AtomicResearchReceipt = ResearchDispatchOutcome & {
  edgeId: string;
  connectionGeneration: string;
  capabilityId: string;
  capabilityVersion: number;
};

export type AtomicResearchSendResult =
  | { outcome: 'dispatched' }
  | { outcome: 'not_started'; reason: string };

/** Existing connection command/receipt mechanics adapted at the production root in task 6.2. */
export interface AtomicResearchCommandChannel {
  subscribeReceipt(
    target: ManagedTaskConnectionTarget,
    attemptId: string,
    receive: (receipt: AtomicResearchReceipt) => void,
  ): () => void;
  sendAtomic(
    target: ManagedTaskConnectionTarget,
    command: ReadOnlyResearchCommand,
  ): AtomicResearchSendResult;
}

export interface ConnectionRuntimeResearchDispatchOptions {
  targets: Pick<ConnectionRuntimeRegistry, 'managedTaskTargetFor'>;
  commands: AtomicResearchCommandChannel;
  now?: () => number;
}

function bound(
  command: ReadOnlyResearchCommand,
  status: ResearchDispatchOutcome['status'],
  reasonCode: ResearchDispatchOutcome['reasonCode'],
): ResearchDispatchOutcome {
  return {
    executionTarget: command.executionTarget,
    accountId: command.accountId,
    attemptId: command.attemptId,
    status,
    reasonCode,
    evidence: null,
  } as ResearchDispatchOutcome;
}

function isPersonaCapability(value: string): value is PersonaResearchCapabilityId {
  return Object.hasOwn(MANAGED_RESEARCH_EDGE_CAPABILITIES, value);
}

/**
 * Exact-target atomic receipt adapter. It never retries sendAtomic and never lets a reconnect's
 * receipt settle a command dispatched on an older connection generation.
 */
export class ConnectionRuntimeResearchDispatchAdapter implements ResearchDispatchPort {
  private readonly now: () => number;

  constructor(private readonly options: ConnectionRuntimeResearchDispatchOptions) {
    this.now = options.now ?? Date.now;
  }

  async dispatchReadOnly(
    command: ReadOnlyResearchCommand,
    options: ResearchDispatchOptions,
  ): Promise<ResearchDispatchOutcome> {
    if (options.signal.aborted) return bound(command, 'aborted', 'execution_failed');
    if (this.now() >= options.deadlineAt) return bound(command, 'timeout', 'deadline_exceeded');
    if (!isPersonaCapability(command.capabilityId)
      || !PLATFORM_CAPABILITIES[command.platform].includes(command.capabilityId)) {
      return bound(command, 'unsupported', 'unsupported');
    }

    const target = this.options.targets.managedTaskTargetFor(command.accountId, command.envKey);
    if (target === null) return bound(command, 'undeliverable', 'waiting_for_edge');
    if (target.accountId !== command.accountId || target.platform !== command.platform) {
      return bound(command, 'unsupported', 'unsupported');
    }
    const requiredCapability = MANAGED_RESEARCH_EDGE_CAPABILITIES[command.capabilityId];
    if (!target.capabilities.includes(requiredCapability)) {
      return bound(command, 'unsupported', 'capability_not_available');
    }

    return new Promise<ResearchDispatchOutcome>((resolve) => {
      let settled = false;
      let dispatched = false;
      let timer: NodeJS.Timeout | null = null;
      let bufferedReceipt: AtomicResearchReceipt | null = null;

      const finish = (outcome: ResearchDispatchOutcome): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        options.signal.removeEventListener('abort', onAbort);
        if (timer) clearTimeout(timer);
        resolve(outcome);
      };
      const receiptMatches = (receipt: AtomicResearchReceipt): boolean =>
        receipt.executionTarget === command.executionTarget
        && receipt.accountId === command.accountId
        && receipt.attemptId === command.attemptId
        && receipt.edgeId === target.edgeId
        && receipt.connectionGeneration === target.connectionGeneration
        && receipt.capabilityId === command.capabilityId
        && receipt.capabilityVersion === command.capabilityVersion;
      const consumeReceipt = (receipt: AtomicResearchReceipt): void => {
        if (!receiptMatches(receipt)) return;
        if (!dispatched) {
          bufferedReceipt = receipt;
          return;
        }
        const { edgeId: _edgeId, connectionGeneration: _generation,
          capabilityId: _capabilityId, capabilityVersion: _capabilityVersion, ...outcome } = receipt;
        finish(outcome);
      };
      const onAbort = (): void => {
        finish(dispatched
          ? bound(command, 'submitted_unknown', 'result_unknown')
          : bound(command, 'aborted', 'execution_failed'));
      };

      const unsubscribe = this.options.commands.subscribeReceipt(
        target,
        command.attemptId,
        consumeReceipt,
      );
      options.signal.addEventListener('abort', onAbort, { once: true });
      try {
        const sent = this.options.commands.sendAtomic(target, command);
        if (sent.outcome === 'not_started') {
          finish(bound(command, 'undeliverable', 'waiting_for_edge'));
          return;
        }
        dispatched = true;
      } catch {
        finish(bound(command, 'submitted_unknown', 'result_unknown'));
        return;
      }
      if (bufferedReceipt !== null) {
        consumeReceipt(bufferedReceipt);
        return;
      }
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      const remaining = Math.max(0, options.deadlineAt - this.now());
      timer = setTimeout(() => {
        finish(bound(command, 'submitted_unknown', 'result_unknown'));
      }, remaining);
    });
  }
}
