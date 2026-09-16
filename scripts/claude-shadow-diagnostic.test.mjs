import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { categorizeClaudeExecution, emitClaudeExecutionDiagnostic, readClaudeExecutionDiagnostic } from './claude-shadow-diagnostic.mjs';

const fallback = {
  assistant_error: 'unclassified', initialized: false, result_present: false,
  is_error: false, structured_output_present: false,
};

test('categorizes only documented assistant errors and fixed result booleans', () => {
  assert.deepEqual(categorizeClaudeExecution([
    { type: 'system', subtype: 'init', session_id: 'private' },
    { type: 'assistant', error: 'rate_limit', message: 'never emit me' },
    { type: 'result', subtype: 'success', is_error: true },
  ]), { assistant_error: 'rate_limit', initialized: true, result_present: true, is_error: true, structured_output_present: false });
  assert.deepEqual(categorizeClaudeExecution([
    { type: 'assistant', error: 'SECRET=ghp_private', result: 'private transcript' },
    { type: 'result', is_error: false, structured_output: {} },
  ]), { assistant_error: 'unclassified', initialized: false, result_present: true, is_error: false, structured_output_present: true });
});

test('diagnostic accepts only the exact regular bounded runner-temp execution file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-diagnostic-'));
  const executionFile = join(directory, 'claude-execution-output.json');
  try {
    writeFileSync(executionFile, JSON.stringify([{ type: 'assistant', error: 'authentication_failed' }]));
    assert.equal(readClaudeExecutionDiagnostic({ runnerTemp: directory, executionFile }).assistant_error, 'authentication_failed');
    assert.deepEqual(readClaudeExecutionDiagnostic({ runnerTemp: directory, executionFile: join(directory, 'other.json') }), fallback);
    rmSync(executionFile);
    writeFileSync(join(directory, 'target'), '[]');
    symlinkSync(join(directory, 'target'), executionFile);
    assert.deepEqual(readClaudeExecutionDiagnostic({ runnerTemp: directory, executionFile }), fallback);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('emitted diagnostic cannot contain injected secret-like payload or unexpected fields', () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-diagnostic-'));
  const executionFile = join(directory, 'claude-execution-output.json');
  const output = join(directory, 'output');
  const secret = 'ghp_DO_NOT_PRINT_THIS_SECRET';
  try {
    writeFileSync(executionFile, JSON.stringify([{ type: 'assistant', error: secret, message: secret, unexpected: secret }]));
    const originalWrite = process.stdout.write;
    let stdout = '';
    process.stdout.write = (chunk) => { stdout += String(chunk); return true; };
    try {
      emitClaudeExecutionDiagnostic({ env: { RUNNER_TEMP: directory, CLAUDE_EXECUTION_FILE: executionFile, GITHUB_OUTPUT: output } });
    } finally {
      process.stdout.write = originalWrite;
    }
    const emitted = `${stdout}\n${readFileSync(output, 'utf8')}`;
    assert.doesNotMatch(emitted, new RegExp(secret, 'u'));
    assert.doesNotMatch(emitted, /message|unexpected|transcript/u);
    assert.match(emitted, /"assistant_error":"unclassified"/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
