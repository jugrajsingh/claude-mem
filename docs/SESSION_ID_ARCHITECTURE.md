# Session ID Architecture

## Overview

Claude-mem uses **two distinct session IDs** to track conversations and memory:

1. **`contentSessionId`** - The user's Claude Code conversation session ID
2. **`memorySessionId`** - The SDK agent's internal session ID for resume functionality

## Critical Architecture

### Initialization Flow

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Hook creates session                                     │
│    createSDKSession(contentSessionId, project, prompt)      │
│                                                              │
│    Database state:                                          │
│    ├─ content_session_id: "user-session-123"               │
│    └─ memory_session_id: NULL (not yet captured)           │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. SDKAgent starts, checks hasRealMemorySessionId           │
│    const hasReal = !!memorySessionId                        │
│    → FALSE (it's NULL)                                      │
│    → Resume NOT used (fresh SDK session)                    │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. First SDK message arrives with session_id                │
│    ensureMemorySessionIdRegistered(sessionDbId, "sdk-gen-abc123") │
│                                                              │
│    Database state:                                          │
│    ├─ content_session_id: "user-session-123"               │
│    └─ memory_session_id: "sdk-gen-abc123" (real!)          │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. Subsequent prompts may use resume                        │
│    const shouldResume =                                      │
│      !!memorySessionId && lastPromptNumber > 1 && !forceInit│
│    → TRUE only for continuation prompts in the same runtime │
│    → Resume parameter: { resume: "sdk-gen-abc123" }         │
└─────────────────────────────────────────────────────────────┘
```

### Observation Storage

**CRITICAL**: Observations are stored with the real `memorySessionId`, NOT `contentSessionId`.

```typescript
// SessionStore.ts
storeObservation(memorySessionId, project, observation, ...);
```

This means:

- Database column: `observations.memory_session_id`
- Stored value: the captured or synthesized `memorySessionId`
- Foreign key: References `sdk_sessions.memory_session_id`

Observation storage is blocked until a real `memorySessionId` is registered in `sdk_sessions`.
This is why `SDKAgent` persists the SDK-returned `session_id` immediately through
`ensureMemorySessionIdRegistered(...)` before any observation insert can succeed.

## Key Invariants

### 1. NULL-Based Detection

```typescript
const hasRealMemorySessionId = !!session.memorySessionId;
```

- When `memorySessionId` is falsy → Not yet captured
- When `memorySessionId` is truthy → Real SDK session captured

### 2. Resume Safety

**NEVER** use `contentSessionId` for resume:

```typescript
// ❌ FORBIDDEN - Would resume user's session instead of memory session!
query({ resume: contentSessionId })

// ✅ CORRECT - Only resume for a continuation prompt in a valid runtime
query({
  ...(
    !!memorySessionId &&
    lastPromptNumber > 1 &&
    !forceInit &&
    { resume: memorySessionId }
  )
})
```

`memorySessionId` is necessary but not sufficient.
Worker restart and crash-recovery paths may still carry a persisted ID while forcing a fresh INIT run.

### 3. Session Isolation

- Each `contentSessionId` maps to exactly one database session
- Each database session has one `memorySessionId` (initially NULL, then captured)
- Observations from different content sessions must NEVER mix

### 4. Foreign Key Integrity

- Observations reference `sdk_sessions.memory_session_id`
- Initially, `sdk_sessions.memory_session_id` is NULL (no observations can be stored yet)
- When SDK session ID is captured, `sdk_sessions.memory_session_id` is set to the real value
- Observations are stored using that real `memory_session_id`
- Queries can still find the session from `content_session_id`, but observation rows themselves stay keyed by `memory_session_id`

## Testing Strategy

The test suite validates all critical invariants:

### Test File

`tests/session_id_usage_validation.test.ts`

### Test Categories

1. **NULL-Based Detection** - Validates `hasRealMemorySessionId` logic
2. **Observation Storage** - Confirms observations use real `memorySessionId` values after registration
3. **Resume Safety** - Prevents `contentSessionId` and stale INIT sessions from being used for resume
4. **Cross-Contamination Prevention** - Ensures session isolation
5. **Foreign Key Integrity** - Validates cascade behavior
6. **Session Lifecycle** - Tests create → capture → resume flow
7. **Edge Cases** - Handles NULL, duplicate IDs, etc.

### Running Tests

```bash
# Run all session ID tests
bun test tests/session_id_usage_validation.test.ts

# Run all tests
bun test

# Run with verbose output
bun test --verbose
```

## Common Pitfalls

### ❌ Using memorySessionId for observations

```typescript
// WRONG - Don't store observations before memorySessionId is available
storeObservation(session.contentSessionId, ...)
```

### ❌ Resuming without checking for NULL

```typescript
// WRONG - memorySessionId alone is not enough
if (session.memorySessionId) {
  query({ resume: session.memorySessionId })
}
```

### ❌ Assuming memorySessionId is always set

```typescript
// WRONG - Can be NULL before SDK session is captured
const resumeId = session.memorySessionId
```

## Correct Usage Patterns

### ✅ Storing observations

```typescript
// Only store after a real memorySessionId has been captured or synthesized
storeObservation(session.memorySessionId, project, obs, ...)
```

### ✅ Checking for real memory session ID

```typescript
const hasRealMemorySessionId = !!session.memorySessionId;
```

### ✅ Using resume parameter

```typescript
query({
  prompt: messageGenerator,
  options: {
    ...(
      hasRealMemorySessionId &&
      session.lastPromptNumber > 1 &&
      !session.forceInit &&
      { resume: session.memorySessionId }
    ),
    // ... other options
  }
})
```

## Debugging Tips

### Check session state

```sql
-- See both session IDs
SELECT
  id,
  content_session_id,
  memory_session_id,
  CASE
    WHEN memory_session_id IS NULL THEN 'NOT_CAPTURED'
    ELSE 'CAPTURED'
  END as state
FROM sdk_sessions
WHERE content_session_id = 'your-session-id';
```

### Find orphaned observations

```sql
-- Should return 0 rows if FK integrity is maintained
SELECT o.*
FROM observations o
LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
WHERE s.id IS NULL;
```

### Verify observation linkage

```sql
-- See which observations belong to a session
SELECT
  o.id,
  o.title,
  o.memory_session_id,
  s.content_session_id,
  s.memory_session_id as session_memory_id
FROM observations o
JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
WHERE s.content_session_id = 'your-session-id';
```

## Internal vs User Sessions

claude-mem records exactly **one `sdk_sessions` row per user content session**.
The observer's SDK call captures its own session ID into the user's existing row
(via `memory_session_id`) — there is no separate "observer session" entity by
design.

### The historical leak

The observer's SDK call uses `cwd: OBSERVER_SESSIONS_DIR` to isolate the spawned
`claude` subprocess from the user's `claude --resume` list (PR #832). But that
subprocess inherited the same Claude Code hooks → it fired its own
`UserPromptSubmit` → those hooks re-entered claude-mem and registered the
observer's run as if it were a user session, creating phantom rows tagged
`project='observer-sessions'` in `sdk_sessions`, `user_prompts`, and
`session_summaries`. Those rows then got embedded into Chroma (incurring
embedding cost), surfaced in viewer detail pages, and bloated SQLite. See
upstream issues #2104, #2093, #2118 for user reports.

### The fix

`CLAUDE_MEM_OBSERVER_SESSION_DIR` declares the observer's internal working
directory. Every claude-mem entry point — CLI hook handlers (`session-init`,
`observation`, `file-context`), HTTP routes (`SessionRoutes`), Chroma sync
(`ChromaSync`), and viewer reads (`DataRoutes` LIST + DETAIL via
`PaginationHelper`) — gates on `shouldSkipForClaudeMem({cwd, project})`.

The composite gate returns true if any of the following hold:

1. `cwd` resolves under `CLAUDE_MEM_OBSERVER_SESSION_DIR`, OR
2. project equals the basename of that dir, OR
3. `cwd` matches a `CLAUDE_MEM_EXCLUDED_PROJECTS` pattern (full path or basename), OR
4. project matches a `CLAUDE_MEM_EXCLUDED_PROJECTS` pattern.

This is distinct from `CLAUDE_MEM_EXCLUDED_PROJECTS` — that setting targets
*user* projects (e.g. paid client work that shouldn't be recorded);
`CLAUDE_MEM_OBSERVER_SESSION_DIR` targets the *internal mechanism*. Both gates
fire at every layer.

### Glob basename matching

Previously, `*observer-sessions*` silently failed against absolute paths because
`*` does not cross `/` (becomes `[^/]*`). Patterns are now also tested against
`path.basename(cwd)` so bare names and single-star patterns work as users
intuitively expect. Globstar (`**`) patterns are unaffected.

### Naming reservation

The basename of `CLAUDE_MEM_OBSERVER_SESSION_DIR` (default: `observer-sessions`)
is reserved as the internal project name. Naming a real user project literally
`observer-sessions` is unsupported — relocate the observer dir via the new
setting if needed.

### Cleaning up legacy rows

Pre-fix deployments accumulated rows tagged `project='observer-sessions'`
and possibly user-excluded projects (when those gates didn't fire at every
layer). Run:

```bash
npx claude-mem cleanup --internal --user-excluded --dry-run    # preview
npx claude-mem cleanup --internal --user-excluded --yes        # apply
```

The cleanup is transactional on SQLite and best-effort on Chroma (warns and
continues on Chroma failure).

## References

- **Implementation**: `src/services/worker/SDKAgent.ts` (lines 72-94)
- **Session Store**: `src/services/sqlite/SessionStore.ts`
- **Tests**: `tests/session_id_usage_validation.test.ts`
- **Related Tests**: `tests/session_id_refactor.test.ts`
- **Composite gate**: `src/utils/project-filter.ts` (`shouldSkipForClaudeMem`)
- **CLI cleanup**: `src/services/infrastructure/CleanupCommand.ts`
