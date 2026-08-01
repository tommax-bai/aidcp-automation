import type { DecisionTrace } from './decision-trace.js';
import type { Task } from './task.js';
import type { TaskRun } from './task-run.js';
import type { ReasonCode } from './reason-codes.js';

export type CustomerTaskState =
  | 'queued'
  | 'waiting_for_lane'
  | 'waiting'
  | 'running'
  | 'cancelled'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'submitted_unknown'
  | 'unsupported'
  | 'attention_required';

export interface CustomerTaskSummary {
  taskId: string;
  accountId: string;
  taskDefinitionId: string;
  taskDefinitionVersion: number;
  state: CustomerTaskState;
  reasonCode: ReasonCode | null;
  confirmedUnits: number;
  targetUnits: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CustomerDecisionTraceSummary {
  decisionType: DecisionTrace['decisionType'];
  outcome: DecisionTrace['outcome'];
  reasonCode: ReasonCode;
  createdAt: number;
}

function terminalState(run: TaskRun): CustomerTaskState {
  if (run.state.reasonCode === 'unsupported') return 'unsupported';
  switch (run.state.terminalOutcome) {
    case 'succeeded': return 'completed';
    case 'partially_succeeded': return 'partial';
    case 'cancelled': return 'cancelled';
    case 'attention_required':
      return run.state.reasonCode === 'result_unknown' ? 'submitted_unknown' : 'attention_required';
    case 'skipped':
    case 'failed':
      return 'failed';
    case null:
      return 'attention_required';
  }
}

function activeState(task: Task, run: TaskRun | null): CustomerTaskState {
  if (run === null) {
    if (task.status === 'cancelled') return 'cancelled';
    if (task.status === 'completed') return 'completed';
    return 'queued';
  }
  if (run.state.status === 'terminal') return terminalState(run);
  if (run.state.status === 'cancel_requested') return 'running';
  if (run.state.status === 'waiting') {
    return run.state.waitReason === 'waiting_for_account_lane' ? 'waiting_for_lane' : 'waiting';
  }
  return run.state.status;
}

export function projectCustomerTask(task: Task, run: TaskRun | null): CustomerTaskSummary {
  return {
    taskId: task.taskId,
    accountId: task.accountId,
    taskDefinitionId: task.taskDefinitionId,
    taskDefinitionVersion: task.taskDefinitionVersion,
    state: activeState(task, run),
    reasonCode: run?.state.reasonCode ?? null,
    confirmedUnits: run?.progress.confirmedUnits ?? 0,
    targetUnits: run?.progress.targetUnits ?? null,
    createdAt: task.createdAt,
    updatedAt: run?.updatedAt ?? task.updatedAt,
  };
}

export function projectCustomerDecisionTrace(trace: DecisionTrace): CustomerDecisionTraceSummary {
  return {
    decisionType: trace.decisionType,
    outcome: trace.outcome,
    reasonCode: trace.reasonCode,
    createdAt: trace.createdAt,
  };
}
