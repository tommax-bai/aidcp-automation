export interface ManagedTaskFeatureFlags {
  apiEnabled: boolean;
  createEnabled: boolean;
  workerEnabled: boolean;
  laneEnabled: boolean;
}

type Env = Record<string, string | undefined>;

export function readManagedTaskFeatureFlags(env: Env = process.env): ManagedTaskFeatureFlags {
  return {
    apiEnabled: env.AIDCP_MANAGED_TASK_API_ENABLED === 'true',
    createEnabled: env.AIDCP_MANAGED_TASK_CREATE_ENABLED === 'true',
    workerEnabled: env.AIDCP_MANAGED_TASK_WORKER_ENABLED === 'true',
    laneEnabled: env.AIDCP_MANAGED_TASK_LANE_ENABLED === 'true',
  };
}

