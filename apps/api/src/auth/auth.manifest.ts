import type { ModuleManifest } from '@vitan/shared';

/**
 * Identity + session. Auth owns no domain tables: its provisioning writes create the
 * orgs-owned identity rows (User + Membership + WorkerDevice) on first sign-in, and its
 * credential-security writes append to the platform security tables. The
 * identity-provisioning reach into orgs tables is the ONE documented cross-module
 * persistence exception (the boundary check's single bounded waiver, removed by Task 10's
 * identity-command work — the actor does not yet exist at provisioning time, so the
 * command ledger's `(scope, actorId, key)` subject is undefined).
 */
export const authManifest: ModuleManifest = {
  id: 'auth',
  title: 'Identity & Session',
  kind: 'domain',
  ownsModels: [],
  dependsOn: [],
  workflowParticipants: [],
  producesEvents: [],
  consumesEvents: [],
  commands: [
    'auth.switch',
    'auth.session',
    'auth.login',
    'auth.passwordRequest',
    'auth.passwordVerify',
    'auth.passwordComplete',
    'auth.otpRequest',
    'auth.otpVerify',
    'auth.workerToken',
    'auth.emailRequest',
    'auth.emailVerify',
    'auth.google',
  ],
  queries: [],
  routes: [
    'POST /auth/switch',
    'POST /auth/session',
    'POST /auth/login',
    'POST /auth/password/request',
    'POST /auth/password/verify',
    'POST /auth/password/complete',
    'POST /auth/otp/request',
    'POST /auth/otp/verify',
    'POST /auth/worker/token',
    'POST /auth/email/request',
    'POST /auth/email/verify',
    'POST /auth/google',
  ],
  permissions: [],
};
