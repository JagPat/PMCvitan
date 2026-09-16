import { appendFileSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES = 10_000;
const ASSISTANT_ERRORS = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'billing_error',
  'rate_limit',
  'invalid_request',
  'model_not_found',
  'server_error',
  'max_output_tokens',
  'unknown',
]);
const FALLBACK = Object.freeze({
  assistant_error: 'unclassified',
  initialized: false,
  result_present: false,
  is_error: false,
  structured_output_present: false,
});

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function categorizeClaudeExecution(value) {
  if (!Array.isArray(value) || value.length > MAX_MESSAGES) return { ...FALLBACK };
  let initialized = false;
  let result = null;
  let assistantError = null;
  for (const message of value) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    if (message.type === 'system' && message.subtype === 'init') initialized = true;
    if (message.type === 'assistant' && typeof message.error === 'string') {
      assistantError = ASSISTANT_ERRORS.has(message.error) ? message.error : 'unclassified';
    }
    if (message.type === 'result') result = message;
  }
  return {
    assistant_error: assistantError ?? 'unclassified',
    initialized,
    result_present: result !== null,
    is_error: result?.is_error === true,
    structured_output_present: Boolean(result && own(result, 'structured_output') && result.structured_output !== undefined),
  };
}

export function readClaudeExecutionDiagnostic({ runnerTemp, executionFile }) {
  const expected = typeof runnerTemp === 'string'
    ? join(runnerTemp, 'claude-execution-output.json')
    : null;
  if (!expected || executionFile !== expected) return { ...FALLBACK };
  try {
    const stat = lstatSync(expected);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BYTES) return { ...FALLBACK };
    return categorizeClaudeExecution(JSON.parse(readFileSync(expected, 'utf8')));
  } catch {
    return { ...FALLBACK };
  }
}

export function emitClaudeExecutionDiagnostic({ env = process.env } = {}) {
  const diagnostic = readClaudeExecutionDiagnostic({
    runnerTemp: env.RUNNER_TEMP,
    executionFile: env.CLAUDE_EXECUTION_FILE,
  });
  const serialized = JSON.stringify(diagnostic);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `diagnostic=${serialized}\n`);
  process.stdout.write(`claude-shadow-diagnostic: ${serialized}\n`);
  return diagnostic;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  emitClaudeExecutionDiagnostic();
}
