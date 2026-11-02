/** Delete races (S1): the server's 404 texts for removing a company from a project, or a member from an org, that is no
 *  longer there, before the removal or after losing a race to another one. The web reads a 404 on that removal as
 *  "already removed" only when it carries exactly this text, never a route's or a proxy's 404. */
export const COMPANY_NOT_FOUND_MESSAGE = 'Company not found on this project';
export const NOT_AN_ORG_MEMBER_MESSAGE = 'Not a member of this org';
