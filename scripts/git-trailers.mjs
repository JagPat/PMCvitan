// Leaf: git's own terminal-trailer reading, shared by every trailer reader (`Correction-Owner`, `Codex-Fix-Probe`,
// `Work-Item`). Moved down out of correction-owner.mjs so the work-item parser does not depend sideways on the
// correction-routing subsystem (POLICY "Module boundaries"; #761 Codex 4235840412). Behaviour is unchanged.

import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Strip only git's ASCII horizontal padding (never Unicode whitespace, which git preserves in the value).
export const asciiTrim = (value) => value.replace(/^[ \t]+|[ \t]+$/gu, '');

// The terminal trailers of a commit message, exactly as `git interpret-trailers --parse --unfold` emits
// them: `Key: value` lines with folded continuations already joined. The message is fed on STDIN, never as
// an argument, so no content can be read as a flag. Returns null when git cannot be run at all (binary
// missing or non-zero exit), so the caller fails closed rather than reading an unreadable commit as owning
// nothing. Exported so other terminal-trailer readers (the `Codex-Fix-Probe` binding) share git's reading.
// A single empty directory pointed at by `GIT_DIR`, so git uses it AS the repository and never discovers
// the ambient one from the working directory. It stays empty (`--parse` reads config, writes nothing), so
// it holds no local config; created lazily and reused. Discovery matters because a repository's local
// config — including a `trailer.<name>.key` that changes block recognition — would otherwise be read, and
// `GIT_DIR`/`GIT_WORK_TREE`/a repo-inside-`TMPDIR` are all repository-selection inputs that no
// `GIT_CEILING_DIRECTORIES` reliably fences once the cwd is inside a repo.
let cleanGitDir;
function isolatedGitDir() {
  if (!cleanGitDir) cleanGitDir = mkdtempSync(join(tmpdir(), 'owner-trailer-gitdir-'));
  return cleanGitDir;
}

// The environment that ISOLATES git from every external config source, so `--parse` depends only on the
// config this module pins and never on the runner. Every inherited `GIT_*` variable is dropped (config
// sources AND repository-selection inputs — `GIT_DIR`, `GIT_WORK_TREE`, `GIT_CONFIG*`, …); global
// (`~/.gitconfig`) and system (`/etc/gitconfig`) are redirected to `/dev/null` with `GIT_CONFIG_NOSYSTEM`;
// and `GIT_DIR` is set to the empty directory above so git reads no local repository config. The remaining
// config comes only from the command-line `-c` flags this module passes.
function isolatedGitEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('GIT_')) continue;
    env[key] = value;
  }
  env.GIT_DIR = isolatedGitDir();
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_SYSTEM = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
}

export function gitParsedTrailers(commitMessage) {
  let out;
  try {
    // Pin the two config keys that still shape `--parse` output under the isolated environment above:
    // `trailer.separators` decides the accepted AND output separator (its first character), and
    // `core.commentChar` decides which comment lines `--parse` strips.
    out = execFileSync('git', [
      '-c', 'trailer.separators=:',
      '-c', 'core.commentChar=#',
      'interpret-trailers', '--parse', '--unfold',
    ], {
      input: String(commitMessage ?? ''),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024,
      cwd: isolatedGitDir(),
      env: isolatedGitEnv(),
    });
  } catch {
    return null;
  }
  const trailers = [];
  for (const line of out.split('\n')) {
    if (line.length === 0) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    trailers.push({ key: asciiTrim(line.slice(0, separator)), value: line.slice(separator + 1) });
  }
  return trailers;
}
