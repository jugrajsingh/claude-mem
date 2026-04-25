/**
 * Cleanup Command
 *
 * Scrubs legacy rows from SQLite (and best-effort matching Chroma documents)
 * for projects that should never have been recorded — namely:
 *   - The internal observer-session basename (CLAUDE_MEM_OBSERVER_SESSION_DIR).
 *   - Projects matching CLAUDE_MEM_EXCLUDED_PROJECTS patterns.
 *
 * Defaults to dry-run unless `yes` is set.
 *
 * Usage from Bun (via worker-service.cjs):
 *   bun plugin/scripts/worker-service.cjs cleanup --internal --dry-run
 *   bun plugin/scripts/worker-service.cjs cleanup --user-excluded --yes
 *   bun plugin/scripts/worker-service.cjs cleanup --internal --user-excluded --yes
 */

import path from 'path';
import { SessionStore } from '../sqlite/SessionStore.js';
import { ChromaMcpManager } from '../sync/ChromaMcpManager.js';
import { isProjectExcludedFromAll } from '../../utils/project-filter.js';
import { getObserverSessionsDir } from '../../shared/paths.js';

export interface CleanupOptions {
  internal?: boolean;
  userExcluded?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

export interface CleanupResult {
  deleted: number;
  dryRun: boolean;
  projects: string[];
  counts: Record<string, Record<string, number>>;
}

// Most tables have a direct `project` column. `user_prompts` does not — it
// links to sdk_sessions via `content_session_id`, so we resolve it via subquery.
const DIRECT_PROJECT_TABLES = ['observations', 'session_summaries', 'sdk_sessions'] as const;
const COUNT_USER_PROMPTS_SQL =
  'SELECT COUNT(*) AS n FROM user_prompts WHERE content_session_id IN (SELECT content_session_id FROM sdk_sessions WHERE project = ?)';
const DELETE_USER_PROMPTS_SQL =
  'DELETE FROM user_prompts WHERE content_session_id IN (SELECT content_session_id FROM sdk_sessions WHERE project = ?)';

export async function runCleanup(opts: CleanupOptions): Promise<CleanupResult> {
  const dryRun = opts.dryRun ?? !opts.yes;

  if (!opts.internal && !opts.userExcluded) {
    console.log('Nothing to do. Pass --internal and/or --user-excluded.');
    return { deleted: 0, dryRun, projects: [], counts: {} };
  }

  const db = new SessionStore();
  const internalName = path.basename(getObserverSessionsDir());

  const projectsToRemove = new Set<string>();
  if (opts.internal) projectsToRemove.add(internalName);
  if (opts.userExcluded) {
    const allProjects = db.db
      .prepare('SELECT DISTINCT project FROM sdk_sessions WHERE project IS NOT NULL')
      .all() as Array<{ project: string }>;
    for (const { project } of allProjects) {
      if (project && isProjectExcludedFromAll(project)) {
        projectsToRemove.add(project);
      }
    }
  }

  if (projectsToRemove.size === 0) {
    console.log('Nothing to clean.');
    db.close();
    return { deleted: 0, dryRun, projects: [], counts: {} };
  }

  // Count phase
  const counts: Record<string, Record<string, number>> = {};
  for (const project of projectsToRemove) {
    counts[project] = {};
    for (const tbl of DIRECT_PROJECT_TABLES) {
      const r = db.db.prepare(`SELECT COUNT(*) as n FROM ${tbl} WHERE project = ?`).get(project) as { n: number };
      counts[project][tbl] = r.n;
    }
    const upr = db.db.prepare(COUNT_USER_PROMPTS_SQL).get(project) as { n: number };
    counts[project]['user_prompts'] = upr.n;
  }

  console.log(`Cleanup target projects: ${[...projectsToRemove].join(', ')}`);
  for (const [project, c] of Object.entries(counts)) {
    console.log(`  ${project}:`);
    for (const [tbl, n] of Object.entries(c)) console.log(`    ${tbl}: ${n}`);
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing deleted. Re-run with --yes to apply.');
    db.close();
    return { deleted: 0, dryRun: true, projects: [...projectsToRemove], counts };
  }

  // Delete phase (transactional for SQLite). Order matters: delete dependent
  // rows (observations, session_summaries, user_prompts) BEFORE the parent
  // sdk_sessions row to keep FK referential semantics tidy.
  let totalDeleted = 0;
  const tx = db.db.transaction(() => {
    for (const project of projectsToRemove) {
      // Delete user_prompts via content_session_id subquery (no project column)
      const upr = db.db.prepare(DELETE_USER_PROMPTS_SQL).run(project);
      totalDeleted += upr.changes;

      // Delete tables with direct project column. Order: children
      // (observations, session_summaries) before parent (sdk_sessions).
      for (const tbl of ['observations', 'session_summaries', 'sdk_sessions'] as const) {
        const r = db.db.prepare(`DELETE FROM ${tbl} WHERE project = ?`).run(project);
        totalDeleted += r.changes;
      }
    }
  });
  tx();

  // Chroma cleanup (best-effort)
  try {
    const chroma = ChromaMcpManager.getInstance();
    for (const project of projectsToRemove) {
      try {
        await chroma.callTool('chroma_delete_documents', {
          collection_name: 'cm__claude-mem',
          where: { project },
        });
      } catch (innerErr) {
        console.warn(`Chroma cleanup for project ${project} failed:`, innerErr instanceof Error ? innerErr.message : String(innerErr));
      }
    }
  } catch (err) {
    console.warn('Chroma cleanup skipped:', err instanceof Error ? err.message : String(err));
  }

  console.log(`\n✓ Deleted ${totalDeleted} SQLite rows across ${projectsToRemove.size} project(s).`);
  db.close();
  return { deleted: totalDeleted, dryRun: false, projects: [...projectsToRemove], counts };
}
