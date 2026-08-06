/**
 * automation-owned panel configuration facades over internal HTTP.
 *
 * The owner keeps validation, writes, mirror-version bumps, and write-after-read
 * truth. The api process only holds these kernel ports and never opens the five
 * automation tables.
 */
import type {
  PacingConfigCatalogView,
  PacingConfigPatchInput,
  PacingConfigSetResult,
  PanelPacingConfig,
  PanelQuotaConfig,
  PanelRestrictedPolicy,
  PanelResumeConfig,
  PanelSessionLimits,
  QuotaConfigCatalogView,
  QuotaConfigPatchInput,
  QuotaConfigSetResult,
  RestrictedPolicyPatchInput,
  RestrictedPolicySetResult,
  RestrictedPolicyView,
  ResumeConfigPatchInput,
  ResumeConfigSetResult,
  ResumeConfigView,
  SessionLimitPatchInput,
  SessionLimitSetResult,
  SessionLimitView,
} from 'aidcp-kernel/kernel/config-panel-ports.js';
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';

export const PANEL_CONFIG_ROUTES = {
  quotaGetCatalog: 'quota-config/get-catalog',
  quotaSet: 'quota-config/set-quota',
  pacingGetCatalog: 'pacing-config/get-catalog',
  pacingSet: 'pacing-config/set-pacing',
  sessionGetView: 'session-limits/get-view',
  sessionSet: 'session-limits/set',
  resumeGetView: 'resume-config/get-view',
  resumeSet: 'resume-config/set',
  restrictedPolicyGetView: 'restricted-policy/get-view',
  restrictedPolicySet: 'restricted-policy/set',
} as const;

export interface PanelConfigOwnerPorts {
  quota: PanelQuotaConfig;
  pacing: PanelPacingConfig;
  session: PanelSessionLimits;
  resume: PanelResumeConfig;
  /**
   * Restricted-account disposal policy (change restricted-policy-global-config).
   * Required, not optional: a missing wire must fail the owner's typecheck, not
   * silently 404 the panel route.
   */
  restrictedPolicy: PanelRestrictedPolicy;
}

/** Register owner facades without duplicating validation or view construction. */
export function registerPanelConfigRoutes(
  server: InternalHttpServer,
  local: PanelConfigOwnerPorts,
): void {
  server.register(PANEL_CONFIG_ROUTES.quotaGetCatalog, () => local.quota.getCatalog());
  server.register(PANEL_CONFIG_ROUTES.quotaSet, (args) => {
    const a = args as { patch: QuotaConfigPatchInput; updatedBy: string };
    return local.quota.setQuota(a.patch, a.updatedBy);
  });
  server.register(PANEL_CONFIG_ROUTES.pacingGetCatalog, () => local.pacing.getCatalog());
  server.register(PANEL_CONFIG_ROUTES.pacingSet, (args) => {
    const a = args as { patch: PacingConfigPatchInput; updatedBy: string };
    return local.pacing.setPacing(a.patch, a.updatedBy);
  });
  server.register(PANEL_CONFIG_ROUTES.sessionGetView, () => local.session.getView());
  server.register(PANEL_CONFIG_ROUTES.sessionSet, (args) => {
    const a = args as { patch: SessionLimitPatchInput; updatedBy: string };
    return local.session.set(a.patch, a.updatedBy);
  });
  server.register(PANEL_CONFIG_ROUTES.resumeGetView, () => local.resume.getView());
  server.register(PANEL_CONFIG_ROUTES.resumeSet, (args) => {
    const a = args as { patch: ResumeConfigPatchInput; updatedBy: string };
    return local.resume.set(a.patch, a.updatedBy);
  });
  server.register(PANEL_CONFIG_ROUTES.restrictedPolicyGetView, () =>
    local.restrictedPolicy.getView(),
  );
  server.register(PANEL_CONFIG_ROUTES.restrictedPolicySet, (args) => {
    const a = args as { patch: RestrictedPolicyPatchInput; updatedBy: string };
    return local.restrictedPolicy.set(a.patch, a.updatedBy);
  });
}

export class PanelQuotaConfigHttpClient implements PanelQuotaConfig {
  constructor(private readonly http: InternalHttpClient) {}

  getCatalog(): Promise<QuotaConfigCatalogView> {
    return this.http.call<QuotaConfigCatalogView>(PANEL_CONFIG_ROUTES.quotaGetCatalog, {});
  }

  setQuota(patch: QuotaConfigPatchInput, updatedBy: string): Promise<QuotaConfigSetResult> {
    return this.http.call<QuotaConfigSetResult>(PANEL_CONFIG_ROUTES.quotaSet, { patch, updatedBy });
  }
}

export class PanelPacingConfigHttpClient implements PanelPacingConfig {
  constructor(private readonly http: InternalHttpClient) {}

  getCatalog(): Promise<PacingConfigCatalogView> {
    return this.http.call<PacingConfigCatalogView>(PANEL_CONFIG_ROUTES.pacingGetCatalog, {});
  }

  setPacing(patch: PacingConfigPatchInput, updatedBy: string): Promise<PacingConfigSetResult> {
    return this.http.call<PacingConfigSetResult>(PANEL_CONFIG_ROUTES.pacingSet, { patch, updatedBy });
  }
}

export class PanelSessionLimitsHttpClient implements PanelSessionLimits {
  constructor(private readonly http: InternalHttpClient) {}

  getView(): Promise<SessionLimitView> {
    return this.http.call<SessionLimitView>(PANEL_CONFIG_ROUTES.sessionGetView, {});
  }

  set(patch: SessionLimitPatchInput, updatedBy: string): Promise<SessionLimitSetResult> {
    return this.http.call<SessionLimitSetResult>(PANEL_CONFIG_ROUTES.sessionSet, { patch, updatedBy });
  }
}

export class PanelResumeConfigHttpClient implements PanelResumeConfig {
  constructor(private readonly http: InternalHttpClient) {}

  getView(): Promise<ResumeConfigView> {
    return this.http.call<ResumeConfigView>(PANEL_CONFIG_ROUTES.resumeGetView, {});
  }

  set(patch: ResumeConfigPatchInput, updatedBy: string): Promise<ResumeConfigSetResult> {
    return this.http.call<ResumeConfigSetResult>(PANEL_CONFIG_ROUTES.resumeSet, { patch, updatedBy });
  }
}

export class PanelRestrictedPolicyHttpClient implements PanelRestrictedPolicy {
  constructor(private readonly http: InternalHttpClient) {}

  getView(): Promise<RestrictedPolicyView> {
    return this.http.call<RestrictedPolicyView>(PANEL_CONFIG_ROUTES.restrictedPolicyGetView, {});
  }

  set(patch: RestrictedPolicyPatchInput, updatedBy: string): Promise<RestrictedPolicySetResult> {
    return this.http.call<RestrictedPolicySetResult>(PANEL_CONFIG_ROUTES.restrictedPolicySet, {
      patch,
      updatedBy,
    });
  }
}
