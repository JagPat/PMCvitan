import { ForbiddenException } from '@nestjs/common';
import { PROJECT_ACCESS_CODES, type ProjectAccessCode } from '@vitan/shared';

/**
 * #1373: the three "you no longer have this project" 403s, each with its machine `code`. The body is Nest's default for
 * a 403 (`message`, `error`, `statusCode`, in that order) plus `code`, so the status, message and key order are as
 * before and a client that ignores `code` sees no change. This is the one place a message is paired with its code:
 * the live project check (`ProjectAccessService.authorize`) and every in-transaction re-check of the same state throw
 * through these, never a bare `ForbiddenException` with the same words.
 */
function lostProject(message: string, code: ProjectAccessCode): ForbiddenException {
  return new ForbiddenException({ message, error: 'Forbidden', statusCode: 403, code });
}

/** the project is archived, or missing */
export const projectUnavailable = (): ForbiddenException =>
  lostProject('Project is unavailable', PROJECT_ACCESS_CODES.unavailable);

/**
 * The words of each "the role your token names no longer stands" refusal. They differ by where it is judged, and each
 * keeps the words it had before #1373; all carry `project-role-changed`.
 * - `guard`: the live project check, an active membership naming another role than the token;
 * - `stale`: an act whose actor pair (the token's role) no longer resolves (`STALE_ROLE_MESSAGE`, the Board's Decision 2);
 * - `envelope`: the same, judged by a site visit, visit file, poster or voice-note write;
 * - `approving`, `forwarding`, `consulting`, `naming`: a decision approve, a forward, a consultation request and an
 *   inspection's responsible naming, each re-reading the caller's role standing inside its transaction.
 */
export const ROLE_CHANGED_MESSAGES = {
  guard: 'Project role changed; sign in again',
  stale: 'Your role on this project changed — sign in again',
  envelope: 'Your role on this project has changed; sign in again',
  approving: 'Your project standing changed while approving — the role that authorized this approval is no longer yours',
  forwarding: 'Your project standing changed while forwarding — the role that authorized this forward is no longer yours',
  consulting: 'Your project standing changed — asking for advice on this decision is a PMC or architect authority',
  naming: 'Your project standing changed — the role that allowed naming who fixes this is no longer yours',
} as const;

/** the role the person's token names no longer stands on the project; `where` picks the words (see above) */
export const projectRoleChanged = (where: keyof typeof ROLE_CHANGED_MESSAGES = 'guard'): ForbiddenException =>
  lostProject(ROLE_CHANGED_MESSAGES[where], PROJECT_ACCESS_CODES.roleChanged);

/** the person holds no standing on the project any more */
export const projectAccessRemoved = (): ForbiddenException =>
  lostProject('Project access has been removed', PROJECT_ACCESS_CODES.accessRemoved);
