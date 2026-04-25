/**
 * Project Filter Utility
 *
 * Provides glob-based path matching for project exclusion.
 * Supports: ~ (home), * (any chars except /), ** (any path), ? (single char)
 *
 * Also exports composite gates that combine internal-cwd detection
 * (CLAUDE_MEM_OBSERVER_SESSION_DIR) with user-pattern exclusion
 * (CLAUDE_MEM_EXCLUDED_PROJECTS).
 */

import { homedir } from 'os';
import path from 'path';
import { getObserverSessionsDir, USER_SETTINGS_PATH } from '../shared/paths.js';
import { SettingsDefaultsManager } from '../shared/SettingsDefaultsManager.js';

/**
 * Convert a glob pattern to a regular expression
 * Supports: ~ (home dir), * (any non-slash), ** (any path), ? (single char)
 */
function globToRegex(pattern: string): RegExp {
  // Expand ~ to home directory
  let expanded = pattern.startsWith('~')
    ? homedir() + pattern.slice(1)
    : pattern;

  // Normalize path separators to forward slashes
  expanded = expanded.replace(/\\/g, '/');

  // Escape regex special characters except * and ?
  let regex = expanded.replace(/[.+^${}()|[\]\\]/g, '\\$&');

  // Convert glob patterns to regex:
  // ** matches any path (including /)
  // * matches any characters except /
  // ? matches single character except /
  regex = regex
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')  // Temporary placeholder
    .replace(/\*/g, '[^/]*')              // * = any non-slash
    .replace(/\?/g, '[^/]')               // ? = single non-slash
    .replace(/<<<GLOBSTAR>>>/g, '.*');    // ** = anything

  return new RegExp(`^${regex}$`);
}

/**
 * Check if a path matches any of the exclusion patterns
 *
 * Tests both the full normalized path AND the path's basename, so that
 * intuitive patterns like "observer-sessions" or "*observer-sessions*"
 * (which historically failed against absolute paths because `*` does not
 * cross `/`) match by basename.
 *
 * @param projectPath - Project name OR absolute path
 * @param exclusionPatterns - Comma-separated glob patterns (e.g., "~/kunden/*,/tmp/*")
 * @returns true if path should be excluded
 */
export function isProjectExcluded(projectPath: string, exclusionPatterns: string): boolean {
  if (!exclusionPatterns || !exclusionPatterns.trim()) {
    return false;
  }

  // Normalize cwd path separators
  const normalizedProjectPath = projectPath.replace(/\\/g, '/');

  // Parse comma-separated patterns
  const patternList = exclusionPatterns
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);

  // First pass: full-path match (existing behaviour)
  for (const pattern of patternList) {
    try {
      if (globToRegex(pattern).test(normalizedProjectPath)) {
        return true;
      }
    } catch (error: unknown) {
      console.warn(`[project-filter] Invalid exclusion pattern "${pattern}":`, error instanceof Error ? error.message : String(error));
      continue;
    }
  }

  // Second pass: basename match — fixes the historical foot-gun where
  // `*observer-sessions*` silently failed against `/x/.claude-mem/observer-sessions`
  // because `*` becomes `[^/]*` which does not cross `/`.
  if (normalizedProjectPath.includes('/')) {
    const baseName = normalizedProjectPath.split('/').filter(Boolean).pop() ?? '';
    if (baseName && baseName !== normalizedProjectPath) {
      for (const pattern of patternList) {
        try {
          if (globToRegex(pattern).test(baseName)) {
            return true;
          }
        } catch {
          // Already warned in first pass
          continue;
        }
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Cached settings access — avoid synchronous file reads on every call
// ---------------------------------------------------------------------------

let _excludedCache: { val: string; loadedAt: number } | null = null;
const EXCLUDED_TTL_MS = 5_000;

function loadExcludedPatterns(): string {
  const now = Date.now();
  if (!_excludedCache || now - _excludedCache.loadedAt > EXCLUDED_TTL_MS) {
    try {
      const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
      _excludedCache = { val: settings.CLAUDE_MEM_EXCLUDED_PROJECTS ?? '', loadedAt: now };
    } catch {
      _excludedCache = { val: '', loadedAt: now };
    }
  }
  return _excludedCache.val;
}

export function invalidateExcludedCache(): void {
  _excludedCache = null;
}

// ---------------------------------------------------------------------------
// Internal-session detection (CLAUDE_MEM_OBSERVER_SESSION_DIR)
// ---------------------------------------------------------------------------

/**
 * True iff `cwd` resolves under the configured observer session directory.
 * Used to detect when the observer's spawned `claude` subprocess fires hooks
 * back into claude-mem so we can short-circuit them.
 */
export function isInternalSessionCwd(cwd: string | undefined): boolean {
  if (!cwd) return false;
  try {
    const observerDir = path.resolve(getObserverSessionsDir());
    const candidate = path.resolve(cwd);
    return candidate === observerDir || candidate.startsWith(observerDir + path.sep);
  } catch {
    return false;
  }
}

/**
 * True iff `projectName` equals the basename of the observer session directory.
 * Used to detect rows whose `project` column was tagged with the observer name.
 */
export function isInternalSessionProject(projectName: string | undefined): boolean {
  if (!projectName) return false;
  try {
    return projectName === path.basename(getObserverSessionsDir());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Composite gate
// ---------------------------------------------------------------------------

/**
 * Cached EXCLUDED_PROJECTS test against any project name or cwd.
 */
export function isProjectExcludedFromAll(projectOrCwd: string | undefined): boolean {
  if (!projectOrCwd) return false;
  return isProjectExcluded(projectOrCwd, loadExcludedPatterns());
}

/**
 * Composite gate for "should claude-mem skip this entirely?".
 * Combines internal-session detection with user-defined EXCLUDED_PROJECTS.
 *
 * Returns true if:
 *   1. cwd is under the observer session directory (internal mechanism), OR
 *   2. project name equals the observer session basename, OR
 *   3. cwd matches a CLAUDE_MEM_EXCLUDED_PROJECTS pattern, OR
 *   4. project name matches a CLAUDE_MEM_EXCLUDED_PROJECTS pattern.
 *
 * Use this at every claude-mem entry point (CLI handlers, HTTP routes,
 * Chroma sync, viewer reads) for consistent behaviour.
 */
export function shouldSkipForClaudeMem(opts: { cwd?: string; project?: string }): boolean {
  if (opts.cwd && isInternalSessionCwd(opts.cwd)) return true;
  if (opts.project && isInternalSessionProject(opts.project)) return true;
  if (opts.cwd && isProjectExcludedFromAll(opts.cwd)) return true;
  if (opts.project && isProjectExcludedFromAll(opts.project)) return true;
  return false;
}
