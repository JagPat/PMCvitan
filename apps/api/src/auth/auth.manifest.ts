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
  // #482 — the sign-in access rule (`OrgsParticipant.signInLanding`/`projectRole`), the operator-door QA sign-in's
  // account side (`OrgsParticipant.qaSignInAccount`) and every account, project and credential-eligibility read the
  // sign-in channels make (`accountByAddress`, `accountById`, `devAccount`, `projectLive`, `reachableProjects`,
  // `credentialAccount`, `accountByPhone`, `rememberLastProject`) are the orgs module's, asked through its participant
  workflowParticipants: ['orgs'],
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
    'auth.opsQaSignIn',
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
    'POST /auth/ops/qa-sign-in',
  ],
  permissions: [],
};
