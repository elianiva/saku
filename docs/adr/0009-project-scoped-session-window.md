# 0009 — The session window is project-scoped; threads archive

Status: accepted

## Context

The rail listed **every** pi session on the machine at connect: `list_pi_sessions`
scanned all of `~/.pi/agent/sessions/**` (114 project dirs, hundreds of files — every
file read for its summary) on every connect. That was the startup cost the console
existed to avoid, and it got worse as pi usage grew.

pi's own layout is already per-cwd (`sessions/--<cwd with / and : → - >--/`), but the
window ignored it. The t3code sidebar shape (few sessions at a time, show more,
archive) was the target for the rail.

Two facts shaped the design:

- **34% of real session dirs are nested under another session dir** (sessions started
  in `apps/web` or `paper/report` of a repo whose root also has sessions) — exact-cwd
  matching would silently hide a third of the user's sessions.
- **pi's dir encoding is lossy** (a literal `-` in a name is indistinguishable from a
  separator), so dir-name matching alone can misattribute — but every session file's
  header carries the real `cwd`, and the files are read anyway for the list view.

## Decision

**The pi-session window is project-scoped, and threads get an archive lifecycle.**

1. **Project = an explicitly added cwd** (the "add project" gesture: the rail's `＋`
   input, or `saku project add`). A project is a scoping list entry — never a thread
   grouping; threads carry their own cwd, and removing a project never touches
   adopted threads.
2. **Subtree matching with header verification**: an added project claims its own
   session dir plus every dir whose encoded name extends it (longest prefix wins on
   overlap); dir names only pick *candidate* dirs (zero file reads for anything not
   added), and the file header's real `cwd` confirms membership — the lossy encoding
   can never misattribute. Pre-cwd sessions (`cwd: ""`) pass on their dir match.
3. **Lazy per project**: connect fetches threads + projects only; a project's sessions
   load on first expand and cache. The refresh edge reloads what is on screen.
4. **Daemon-local store**: the project list is one JSON document under the saku home
   (`projects.json`, atomic KvStore writes). The hub has no `~/.pi`, so it answers
   `projects_not_served` exactly like `list_pi_sessions` — the whole window is one
   local-daemon feature with one "not served" story.
5. **Archive**: `ThreadRecord.archivedAt` (null = active), wire `archive_thread` /
   `unarchive_thread`, CLI `saku archive|unarchive`. Archive is **visibility-only**:
   the trail, session, and env are untouched, unarchive is always possible, and an
   archived thread still runs and broadcasts. The rail's active list filters
   `archivedAt === null`; a header toggle opens the archived view (muted rows,
   unarchive + delete).
6. **t3code sidebar mechanics**: preview limits (6) with "show more/less" on the
   active thread list and per-project session lists; two-line rows; rename via
   double-click on the title (inline edit); archive moves a thread between views.

## Alternatives considered

- **Exact-cwd matching** (pi's own `findMostRecentSession` semantics): rejected — 34%
  of real session dirs are nested, and "I added my project and half my sessions are
  gone" is worse than the dash-collision risk (which header verification removes).
- **Full scan at connect, filtered**: shrinks the cost but keeps the shape; lazy
  per-project eliminates it.
- **Projects in the registry** (hub-owned): rejected — the list's only consumer is the
  daemon-local session window; a hub-side list you can see but never use is dead
  state, and the registry's domain stays "threads".
- **Archive as hide-in-place**: rejected — t3code's separate archived view keeps the
  active list purely active, and the toggle is one click.
