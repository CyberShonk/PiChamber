import type { TailscaleState, TailscaleStatus } from '@/lib/tailscale';

/**
 * Pure view-model for the Tailscale "Ways to connect" row.
 *
 * Kept free of React/fetch so every status → UI mapping (all states and
 * error codes), the public-confirmation gate, the polling cadence, and the
 * failed-fetch-never-Off rule are unit-testable without a DOM.
 */

export const TAILSCALE_FAST_POLL_MS = 2_000;
export const TAILSCALE_SLOW_POLL_MS = 15_000;

/** Poll every ~2s while transitional, otherwise every ~15s while visible. */
export const getTailscalePollIntervalMs = (state: TailscaleState | null): number =>
  state === 'starting' || state === 'needs-approval' ? TAILSCALE_FAST_POLL_MS : TAILSCALE_SLOW_POLL_MS;

export type TailscaleModeValue = 'off' | 'private' | 'public';

export const getTailscaleModeValue = (status: TailscaleStatus): TailscaleModeValue =>
  !status.config.enabled ? 'off' : status.config.mode;

/**
 * Public (Funnel) must be confirmed every time it is switched on from
 * Off/Private. Re-selecting Public while already public needs no confirm.
 */
export const requiresPublicConfirm = (current: TailscaleModeValue, target: TailscaleModeValue): boolean =>
  target === 'public' && current !== 'public';

export type TailscaleTone = 'neutral' | 'success' | 'warning' | 'error' | 'info';

export interface TailscalePresentation {
  pill: string;
  tone: TailscaleTone;
  /** Segmented control disabled + why (screen-reader + tooltip text). */
  controlDisabled: boolean;
  controlDisabledReason: string | null;
  showUrl: boolean;
  showPortPicker: boolean;
  showApproval: boolean;
  showPermissionFix: boolean;
  showAuthCallout: boolean;
  /** Funnel (public) active only: live public-DNS readiness note; null when ready/missing/private. */
  publicDnsNote: 'pending' | 'unknown' | null;
  headline: string | null;
}

/**
 * Per-mode enablement from the server auth gate. `authGate` is authoritative:
 * private may stay allowed via PICHAMBER_ALLOW_UNAUTHENTICATED_LAN while
 * public is blocked. A missing gate (older server) allows both so the
 * blocked-state callout still carries the password signal.
 */
export const isTailscaleModeAllowed = (
  status: TailscaleStatus | null,
  mode: 'private' | 'public',
): boolean => {
  if (!status) return false;
  const gate = status.authGate;
  if (!gate) return true;
  return mode === 'private' ? gate.privateAllowed !== false : gate.publicAllowed !== false;
};

/**
 * Maps an authoritative status to row UI. Returns null when there is no
 * authoritative status yet: callers must render a loading or load-failed
 * state — never "Off" (a failed fetch must not masquerade as Off).
 *
 * Prerequisites come from installed/running/loggedIn regardless of state:
 * a status reporting not-installed (or signed-out) while `state` is still
 * 'off' must render Not installed (or Not signed in), never Off.
 */
export const presentTailscaleStatus = (status: TailscaleStatus | null): TailscalePresentation | null => {
  if (!status) return null;

  if (status.installed === false) {
    return {
      pill: 'Not installed',
      tone: 'neutral',
      controlDisabled: true,
      controlDisabledReason: 'Install Tailscale to use this route.',
      showUrl: false,
      showPortPicker: false,
      showApproval: false,
      showPermissionFix: false,
      showAuthCallout: false,
      publicDnsNote: null,
      headline: 'Tailscale is not installed on this computer.',
    };
  }
  if (status.running === false || status.loggedIn === false) {
    const notRunning = status.running === false;
    return {
      pill: 'Not signed in',
      tone: 'warning',
      controlDisabled: true,
      controlDisabledReason: 'Open Tailscale and sign in first.',
      showUrl: false,
      showPortPicker: false,
      showApproval: false,
      showPermissionFix: false,
      showAuthCallout: false,
      publicDnsNote: null,
      headline: notRunning
        ? 'The Tailscale daemon is not running.'
        : 'Tailscale is installed but you are not signed in.',
    };
  }

  switch (status.state) {
    case 'off':
      return {
        pill: 'Off',
        tone: 'neutral',
        controlDisabled: false,
        controlDisabledReason: null,
        showUrl: false,
        showPortPicker: false,
        showApproval: false,
        showPermissionFix: false,
        showAuthCallout: false,
        publicDnsNote: null,
        headline: null,
      };
    case 'unavailable': {
      if (status.errorCode === 'not_installed') {
        return {
          pill: 'Not installed',
          tone: 'neutral',
          controlDisabled: true,
          controlDisabledReason: 'Install Tailscale to use this route.',
          showUrl: false,
          showPortPicker: false,
          showApproval: false,
          showPermissionFix: false,
          showAuthCallout: false,
          publicDnsNote: null,
          headline: 'Tailscale is not installed on this computer.',
        };
      }
      if (status.errorCode === 'not_running' || status.errorCode === 'not_logged_in') {
        return {
          pill: 'Not signed in',
          tone: 'warning',
          controlDisabled: true,
          controlDisabledReason: 'Open Tailscale and sign in first.',
          showUrl: false,
          showPortPicker: false,
          showApproval: false,
          showPermissionFix: false,
          showAuthCallout: false,
          publicDnsNote: null,
          headline: status.errorCode === 'not_running'
            ? 'The Tailscale daemon is not running.'
            : 'Tailscale is installed but you are not signed in.',
        };
      }
      return {
        pill: 'Unavailable',
        tone: 'neutral',
        controlDisabled: true,
        controlDisabledReason: status.errorMessage,
        showUrl: false,
        showPortPicker: false,
        showApproval: false,
        showPermissionFix: false,
        showAuthCallout: false,
        publicDnsNote: null,
        headline: status.errorMessage,
      };
    }
    case 'blocked':
      return {
        pill: 'Blocked',
        tone: 'warning',
        controlDisabled: false,
        controlDisabledReason: null,
        showUrl: false,
        showPortPicker: false,
        showApproval: false,
        showPermissionFix: false,
        showAuthCallout: true,
        publicDnsNote: null,
        headline: 'Tailscale needs a UI password before it can be enabled.',
      };
    case 'starting':
      return {
        pill: 'Setting up…',
        tone: 'info',
        controlDisabled: false,
        controlDisabledReason: null,
        showUrl: false,
        showPortPicker: false,
        showApproval: false,
        showPermissionFix: false,
        showAuthCallout: false,
        publicDnsNote: null,
        headline: null,
      };
    case 'needs-approval':
      return {
        pill: 'Waiting for approval…',
        tone: 'warning',
        controlDisabled: false,
        controlDisabledReason: null,
        showUrl: false,
        showPortPicker: false,
        showApproval: true,
        showPermissionFix: false,
        showAuthCallout: false,
        publicDnsNote: null,
        headline: 'Your tailnet admin must approve this route.',
      };
    case 'active': {
      const publicDnsNote = status.config.mode === 'public'
        && (status.publicDns === 'pending' || status.publicDns === 'unknown')
        ? status.publicDns
        : null;
      return {
        pill: status.config.mode === 'public' ? 'On · Public' : 'On · Private',
        tone: status.config.mode === 'public' ? 'warning' : 'success',
        controlDisabled: false,
        controlDisabledReason: null,
        showUrl: true,
        showPortPicker: false,
        showApproval: false,
        showPermissionFix: false,
        showAuthCallout: false,
        publicDnsNote,
        headline: null,
      };
    }
    case 'conflict':
      return {
        pill: 'Port in use',
        tone: 'error',
        controlDisabled: false,
        controlDisabledReason: null,
        showUrl: false,
        showPortPicker: true,
        showApproval: false,
        showPermissionFix: false,
        showAuthCallout: false,
        publicDnsNote: null,
        headline: status.errorMessage ?? 'Another destination already uses this port in Tailscale.',
      };
    case 'error': {
      if (status.errorCode === 'status_query_failed') {
        return {
          pill: 'Error',
          tone: 'error',
          controlDisabled: false,
          controlDisabledReason: null,
          showUrl: false,
          showPortPicker: false,
          showApproval: false,
          showPermissionFix: false,
          showAuthCallout: false,
          publicDnsNote: null,
          // The row renders its Try again button for every non-permission
          // error state; this headline is the readable copy for it.
          headline: status.errorMessage ?? 'Could not read the current Tailscale status, so nothing was changed. Try again.',
        };
      }
      if (status.errorCode === 'permission_denied') {
        return {
          pill: 'Permission needed',
          tone: 'error',
          controlDisabled: false,
          controlDisabledReason: null,
          showUrl: false,
          showPortPicker: false,
          showApproval: false,
          showPermissionFix: true,
          showAuthCallout: false,
          publicDnsNote: null,
          headline: status.errorMessage ?? 'Tailscale denied the serve configuration.',
        };
      }
      return {
        pill: 'Error',
        tone: 'error',
        controlDisabled: false,
        controlDisabledReason: null,
        showUrl: false,
        showPortPicker: false,
        showApproval: false,
        showPermissionFix: false,
        showAuthCallout: false,
        publicDnsNote: null,
        headline: status.errorMessage ?? 'Something went wrong.',
      };
    }
    default:
      return null;
  }
};
