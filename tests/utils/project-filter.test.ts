/**
 * Project Filter Tests
 *
 * Tests glob-based path matching for project exclusion.
 * Source: src/utils/project-filter.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  isProjectExcluded,
  isInternalSessionCwd,
  isInternalSessionProject,
  isProjectExcludedFromAll,
  shouldSkipForClaudeMem,
  invalidateExcludedCache,
} from '../../src/utils/project-filter.js';
import { invalidateObserverDirCache } from '../../src/shared/paths.js';
import { homedir } from 'os';
import { join } from 'path';

describe('Project Filter', () => {
  describe('isProjectExcluded', () => {
    describe('with empty patterns', () => {
      it('returns false for empty pattern string', () => {
        expect(isProjectExcluded('/Users/test/project', '')).toBe(false);
        expect(isProjectExcluded('/Users/test/project', '   ')).toBe(false);
      });
    });

    describe('with exact path matching', () => {
      it('matches exact paths', () => {
        expect(isProjectExcluded('/tmp/secret', '/tmp/secret')).toBe(true);
        expect(isProjectExcluded('/tmp/public', '/tmp/secret')).toBe(false);
      });
    });

    describe('with * wildcard (single directory level)', () => {
      it('matches any directory name', () => {
        expect(isProjectExcluded('/tmp/secret', '/tmp/*')).toBe(true);
        expect(isProjectExcluded('/tmp/anything', '/tmp/*')).toBe(true);
      });

      it('does not match across directory boundaries', () => {
        expect(isProjectExcluded('/tmp/a/b', '/tmp/*')).toBe(false);
      });
    });

    describe('with ** wildcard (any path depth)', () => {
      it('matches any path depth', () => {
        expect(isProjectExcluded('/Users/test/kunden/client1/project', '/Users/*/kunden/**')).toBe(true);
        expect(isProjectExcluded('/Users/test/kunden/deep/nested/project', '/Users/*/kunden/**')).toBe(true);
      });
    });

    describe('with ? wildcard (single character)', () => {
      it('matches single character', () => {
        expect(isProjectExcluded('/tmp/a', '/tmp/?')).toBe(true);
        expect(isProjectExcluded('/tmp/ab', '/tmp/?')).toBe(false);
      });
    });

    describe('with ~ home directory expansion', () => {
      it('expands ~ to home directory', () => {
        const home = homedir();
        expect(isProjectExcluded(`${home}/secret`, '~/secret')).toBe(true);
        expect(isProjectExcluded(`${home}/projects/secret`, '~/projects/*')).toBe(true);
      });
    });

    describe('with multiple patterns', () => {
      it('returns true if any pattern matches', () => {
        const patterns = '/tmp/*,~/kunden/*,/var/secret';
        expect(isProjectExcluded('/tmp/test', patterns)).toBe(true);
        expect(isProjectExcluded(`${homedir()}/kunden/client`, patterns)).toBe(true);
        expect(isProjectExcluded('/var/secret', patterns)).toBe(true);
        expect(isProjectExcluded('/home/user/public', patterns)).toBe(false);
      });
    });

    describe('with Windows-style paths', () => {
      it('normalizes backslashes to forward slashes', () => {
        expect(isProjectExcluded('C:\\Users\\test\\secret', 'C:/Users/*/secret')).toBe(true);
      });
    });

    describe('real-world patterns', () => {
      it('excludes customer projects', () => {
        const patterns = '~/kunden/*,~/customers/**';
        const home = homedir();

        expect(isProjectExcluded(`${home}/kunden/acme-corp`, patterns)).toBe(true);
        expect(isProjectExcluded(`${home}/customers/bigco/project1`, patterns)).toBe(true);
        expect(isProjectExcluded(`${home}/projects/opensource`, patterns)).toBe(false);
      });

      it('excludes temporary directories', () => {
        const patterns = '/tmp/*,/var/tmp/*';

        expect(isProjectExcluded('/tmp/scratch', patterns)).toBe(true);
        expect(isProjectExcluded('/var/tmp/test', patterns)).toBe(true);
        expect(isProjectExcluded('/home/user/tmp', patterns)).toBe(false);
      });
    });

    describe('basename matching (fixes historical foot-gun)', () => {
      it('test_should_match_basename_when_pattern_is_bare_name', () => {
        // Bare name "observer-sessions" historically failed against absolute paths.
        // The basename pass now makes this work as users intuitively expect.
        expect(isProjectExcluded('/home/user/.claude-mem/observer-sessions', 'observer-sessions')).toBe(true);
        expect(isProjectExcluded('/x/y/secrets', 'secrets')).toBe(true);
      });

      it('test_should_match_basename_when_pattern_uses_single_star', () => {
        // The historical foot-gun: `*observer-sessions*` becomes `[^/]*observer-sessions[^/]*`
        // which never matches a path containing slashes. Basename matching saves this.
        expect(isProjectExcluded('/home/user/.claude-mem/observer-sessions', '*observer-sessions*')).toBe(true);
      });

      it('test_should_match_full_path_when_pattern_uses_globstar', () => {
        // Globstar still works on full path (existing behaviour, not affected by basename pass)
        expect(isProjectExcluded('/home/user/.claude-mem/observer-sessions', '**observer-sessions**')).toBe(true);
        expect(isProjectExcluded('/x/y/observer-sessions/sub', '**/observer-sessions/**')).toBe(true);
      });

      it('test_should_not_match_when_pattern_is_unrelated', () => {
        expect(isProjectExcluded('/home/user/normal-project', 'observer-sessions')).toBe(false);
        expect(isProjectExcluded('/home/user/normal-project', '*observer*')).toBe(false);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Internal-session detection + composite gate
  // -------------------------------------------------------------------------

  describe('isInternalSessionCwd / isInternalSessionProject / shouldSkipForClaudeMem', () => {
    let originalObserverDir: string | undefined;
    let originalExcluded: string | undefined;
    let testObserverDir: string;

    beforeEach(() => {
      originalObserverDir = process.env.CLAUDE_MEM_OBSERVER_SESSION_DIR;
      originalExcluded = process.env.CLAUDE_MEM_EXCLUDED_PROJECTS;
      testObserverDir = '/tmp/test-observer-dir-fixture';
      process.env.CLAUDE_MEM_OBSERVER_SESSION_DIR = testObserverDir;
      invalidateObserverDirCache();
      invalidateExcludedCache();
    });

    afterEach(() => {
      if (originalObserverDir === undefined) {
        delete process.env.CLAUDE_MEM_OBSERVER_SESSION_DIR;
      } else {
        process.env.CLAUDE_MEM_OBSERVER_SESSION_DIR = originalObserverDir;
      }
      if (originalExcluded === undefined) {
        delete process.env.CLAUDE_MEM_EXCLUDED_PROJECTS;
      } else {
        process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = originalExcluded;
      }
      invalidateObserverDirCache();
      invalidateExcludedCache();
    });

    it('test_should_treat_internal_cwd_as_excluded_when_under_observer_dir', () => {
      expect(isInternalSessionCwd(testObserverDir)).toBe(true);
    });

    it('test_should_treat_internal_cwd_as_excluded_when_subdirectory', () => {
      expect(isInternalSessionCwd(join(testObserverDir, 'sub', 'dir'))).toBe(true);
    });

    it('test_should_not_treat_normal_cwd_as_internal_when_outside_observer_dir', () => {
      expect(isInternalSessionCwd('/home/user/normal-project')).toBe(false);
      expect(isInternalSessionCwd(undefined)).toBe(false);
      expect(isInternalSessionCwd('')).toBe(false);
    });

    it('test_should_match_internal_project_by_basename', () => {
      // basename('/tmp/test-observer-dir-fixture') === 'test-observer-dir-fixture'
      expect(isInternalSessionProject('test-observer-dir-fixture')).toBe(true);
      expect(isInternalSessionProject('something-else')).toBe(false);
      expect(isInternalSessionProject(undefined)).toBe(false);
    });

    it('test_should_combine_internal_and_user_excluded_when_either_matches', () => {
      process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = 'secrets,scratch-*';
      invalidateExcludedCache();

      // Internal cwd
      expect(shouldSkipForClaudeMem({ cwd: testObserverDir })).toBe(true);
      // Internal project basename
      expect(shouldSkipForClaudeMem({ project: 'test-observer-dir-fixture' })).toBe(true);
      // User-excluded by project name
      expect(shouldSkipForClaudeMem({ project: 'secrets' })).toBe(true);
      // User-excluded by glob pattern (basename match)
      expect(shouldSkipForClaudeMem({ cwd: '/home/user/scratch-2026' })).toBe(true);
      // Normal project, normal cwd
      expect(shouldSkipForClaudeMem({ cwd: '/home/user/normal', project: 'normal' })).toBe(false);
      // Empty input
      expect(shouldSkipForClaudeMem({})).toBe(false);
    });

    it('test_should_invalidate_cache_when_explicit_call', () => {
      process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = 'foo';
      invalidateExcludedCache();
      expect(isProjectExcludedFromAll('foo')).toBe(true);

      // Change the env without invalidating — caller still sees old value within TTL
      process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = '';
      // Cache is hot, still returns true
      // (Don't assert this — it's flaky if test runs slow enough to cross 5s)

      // Explicit invalidation forces re-read
      invalidateExcludedCache();
      expect(isProjectExcludedFromAll('foo')).toBe(false);
    });
  });
});
