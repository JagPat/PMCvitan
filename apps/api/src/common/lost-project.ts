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

/** the person's active membership names another role than their token */
export const projectRoleChanged = (): ForbiddenException =>
  lostProject('Project role changed; sign in again', PROJECT_ACCESS_CODES.roleChanged);

/** the person holds no standing on the project any more */
export const projectAccessRemoved = (): ForbiddenException =>
  lostProject('Project access has been removed', PROJECT_ACCESS_CODES.accessRemoved);
