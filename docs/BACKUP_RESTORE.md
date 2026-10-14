# Navlume Physical Backup & Restore

This document covers the **physical** recovery workflow: a byte-level copy of the
complete persistent application state, and putting it back.

It is deliberately narrow. Docker operator commands are documented in
[DEPLOYMENT.md](./DEPLOYMENT.md) for source builds and [INSTALL.md](./INSTALL.md)
for prebuilt installations. This page defines the shared recovery contract.

---

## 1. What is backed up

A physical backup contains exactly two things:

| Item | Meaning |
|------|---------|
| `nav.sqlite` | The whole SQLite database, captured as one self-contained file. |
| `uploads/` | The complete uploads directory, including brand assets and LAN mode's private `.auth-secret`. |

Because the database is captured in full rather than filtered, the backup naturally
includes:

- site settings and branding text (site name, tagline, primary color, theme, footer, access mode)
- public navigation (categories and links)
- personal navigation (per-user categories and links)
- Better Auth users, accounts, and sessions
- the Drizzle migration state

That is intentional. A physical backup is not a logical export and does not select
tables.

### What is NOT backed up

- `.env` or any environment file
- Environment-provided `BETTER_AUTH_SECRET` in standard mode (save it separately).
- application source code, `node_modules/`, or `dist/`
- logs
- previously created backup directories
- SQLite sidecar files (`-wal`, `-shm`, `-journal`)

Sidecars are excluded on purpose: the database is captured through SQLite's own
backup mechanism, so the result is a single self-contained file that does not
depend on any WAL or SHM file. Do not copy `nav.sqlite` by hand and expect the same
guarantee.

LAN mode in v0.1.2 stores a private key at `UPLOADS_DIR/.auth-secret`
(0600), outside public `branding/` assets, and records initialization closure in
the existing SQLite verification table. The unchanged v1 physical backup includes
both naturally. Keep hidden files and permissions, and protect backups as credentials.
Restart or deleting every user does not reopen setup; a post-init backup remains
closed even without users. Restoring a genuinely pre-init full backup or creating
a new independent volume still permits first installation. Older backups without
a marker cannot prove historical provisioning if already empty; existing users
are adopted on v0.1.2 startup. No backup format or restore algorithm changes.

---

## 2. The application must be stopped

**Both commands require `--app-stopped`, and they refuse to do anything without it.**

This is a real requirement, not a formality. SQLite can produce a consistent
snapshot while the application is running — and the backup command does so — but an
asset upload is a multi-step operation:

```
write the new file  →  point the database at it  →  delete the old file
```

A snapshot of the database plus an independently copied uploads directory is
therefore not guaranteed to describe one single, coherent application state. The
database and the uploads directory together are the recovery point, so both
commands require the application to be stopped.

> **`--app-stopped` is an acknowledgement, not a check.**
>
> The command does not detect whether the server is running. It cannot do so
> reliably across platforms, and a detector that guesses wrongly would be worse
> than an honest contract. The flag records that *you* stopped the application.
> Nothing else enforces it.

Before either command, stop the server and let the database connection close. Under
Docker, use the Compose stop command in the relevant installation/deployment guide.
Locally, stop the process running
`npm run dev` (or `npm run dev:server`).

---

## 3. Creating a backup

```bash
npm run backup -- --app-stopped
```

With an explicit destination:

```bash
npm run backup -- --app-stopped --output /path/to/backups
```

Optional overrides:

```bash
npm run backup -- --app-stopped --database /path/to/nav.sqlite --uploads /path/to/uploads
```

### Where the backup is created

The default destination root is `data/backups`. Each run creates a new,
timestamped directory:

```
data/backups/backup-20260917T012345Z/
├── manifest.json
├── nav.sqlite
└── uploads/
    └── branding/
        └── <uuid>.png
```

The output is a plain directory — no archive, no compression. You can inspect it,
copy it with ordinary tools, and store it anywhere.

An existing backup is **never** overwritten. If the generated name is already
taken, a suffix is added (`…-2`, `…-3`) so no earlier backup is lost.

### What the command does

1. Verifies the source database exists.
2. Assembles the backup in a hidden, incomplete directory.
3. Captures the database consistently through SQLite's backup mechanism.
4. Copies the uploads directory in full (or an empty one, if nothing has been uploaded yet).
5. Validates the captured database on its own.
6. Writes the manifest.
7. Only then publishes the directory under its final name.

If any step fails, the incomplete directory is removed and **no completed backup is
produced**. A directory that exists is a directory that passed validation.

### `manifest.json`

```json
{
  "format_version": 1,
  "type": "physical-backup",
  "created_at": "2026-09-17T01:23:45.000Z",
  "database": "nav.sqlite",
  "uploads": "uploads"
}
```

The manifest records only the format version and the internal, relative names of
the two items. It contains no environment variables, secrets, absolute paths, or
hostnames. It is not a logical export schema.

### Verifying a backup

The command already validates what it produced, and reports:

```
backup verified: integrity_check = ok, foreign_key_check = clean
```

To check a backup yourself:

```bash
sqlite3 data/backups/backup-20260917T012345Z/nav.sqlite "PRAGMA integrity_check;"
sqlite3 data/backups/backup-20260917T012345Z/nav.sqlite "PRAGMA foreign_key_check;"
```

The first must print `ok`; the second must print nothing.

---

## 4. Restoring a backup

> ### ⚠️ This is destructive
>
> Restore **replaces the live database and the entire uploads directory** with the
> contents of the backup. Everything created since that backup was taken is
> discarded — including users, navigation, branding, and uploaded files. There is no
> undo once it completes.

Both acknowledgements are mandatory:

```bash
npm run restore -- \
  --app-stopped \
  --backup /path/to/backups/backup-20260917T012345Z \
  --confirm-restore
```

Optional overrides, as with backup:

```bash
npm run restore -- --app-stopped --confirm-restore --backup <dir> \
  --database /path/to/nav.sqlite --uploads /path/to/uploads
```

### Preconditions

- The application is stopped (see §2).
- `--backup` points at a directory produced by `npm run backup`.
- The backup directory does **not** overlap the live database or uploads paths (see below).
- You have accepted that current live data will be replaced.

Both `--app-stopped` and `--confirm-restore` are required. There is no interactive
prompt, so the command behaves identically when run from a script or an automation
tool. If either flag is absent, the command exits non-zero and **changes nothing**.

#### Keep backups outside the live paths

Restore **replaces** the live database and uploads, and it removes the live
SQLite sidecar files (`-wal`, `-shm`, `-journal`) next to the database. A backup
directory that sits inside — or contains — any of those paths would be moved or
deleted along with them.

Restore therefore refuses to run when the backup source overlaps any of:

- the target database file
- the target database's `-wal`, `-shm`, or `-journal` sidecar paths
- the target uploads directory

Overlap is checked in both directions, so all of these are rejected:

```text
uploads/manual-backup/          backup inside the live uploads directory
<backup>/uploads/               live uploads inside the backup
<backup>/nav.sqlite             live database inside the backup
<database>-wal                  backup at a sidecar path
```

The check resolves filesystem aliases as well as comparing the paths as written.
A symlink or directory junction that points into the live tree is detected even
though its own path looks disjoint, so the check is about where the backup really
is rather than how it is spelled.

> **Keep physical backups outside the live database and uploads paths — outside
> both lexically and by resolved filesystem location.**
>
> A sibling location is fine — `data/backups/` next to `data/uploads/` does not
> overlap. The default backup destination already satisfies this. A symlink to a
> genuinely separate backup is also fine; only aliases that resolve into the live
> tree are refused.

The same rule applies when creating a backup: the output destination is resolved
the same way, so a destination reached through an alias into the live uploads
directory is refused instead of being copied into itself.

The check runs before anything is read or written, so a refusal changes nothing:
the backup source and the live state are both left exactly as they were, and no
temporary files are created. A refusal exits with code `1`, not `2`, because no
destructive step was reached.

### What the command does

1. **Validates** the backup before touching anything live: first the path layout
   (the overlap check above), then the directory, the manifest (version and type),
   the internal file names, and the database's `integrity_check` and
   `foreign_key_check`.
2. **Stages** a complete replacement next to the live paths and revalidates it.
3. **Captures** the current database and uploads so they can be put back.
4. **Commits** the swap: install the restored database, then the restored uploads.
5. **Cleans up** the staging and recovery copies once both replacements succeed.

A backup that is missing, unsupported, or corrupt is rejected during step 1 —
**before any live data is modified**.

If the commit fails partway through, both resources are rolled back to their
previous state, so you are not left with a mixed result such as an old database
next to restored uploads. If rollback itself cannot complete, the command exits
with code `2`, says so explicitly, and prints the paths of the recovery files it
retained. It never reports success in that situation.

The backup directory is read-only input: restore never renames, deletes, or
rewrites anything inside it.

### After restoring

Restart the application. It will serve the restored state — the database, its users
and their credentials, the navigation, the branding, and the uploaded assets as they
were at backup time.

---

## 5. Environment variables

Both commands read the same variables the application does, and command-line flags
win over them:

| Variable | Purpose | Default |
|----------|---------|---------|
| `DATABASE_PATH` | SQLite database location | `data/nav.sqlite` |
| `UPLOADS_DIR` | Uploads root | `data/uploads` |
| `BACKUP_DIR` | Default backup destination root | `data/backups` |

No `/data` path is hard-coded in the tools: both Docker Compose files map these
variables to persistent storage inside the container.

### Supported path layout

The two persistent locations are configurable, but the database must **not** live
inside the uploads directory:

```text
DATABASE_PATH must not be located inside UPLOADS_DIR
The directory containing DATABASE_PATH must not be inside UPLOADS_DIR
```

The second line matters because restore writes its temporary database recovery
files **beside the database**. If that directory were inside the uploads tree,
restoring would move those files along with the uploads and the database could not
be recovered.

The normal layout is supported and is what the defaults use:

```text
data/nav.sqlite      database outside uploads
data/uploads/        uploads directory
```

Here `data/` contains `uploads/`, which is fine: the rule is directional. Only a
database that sits inside the uploads directory is refused.

The check resolves symlinks and directory junctions too, so an alias pointing into
the uploads tree is rejected even when its own path looks separate.

Both commands apply this check. A backup is refused as well, because a database
captured from inside the uploads tree would place the database — and any SQLite
sidecar files — inside the backup's own `uploads/`, producing an ambiguous recovery
artifact.

---

## 6. Relationship to P6.3

Both Docker deployment paths use one named volume with `/data/nav.sqlite` and
`/data/uploads`. The compiled backup and restore CLIs ship in the runtime image;
they run in a one-shot container against that same volume after the application
has been stopped. See the linked guides for stop/run/start and off-volume copy
commands. Supply `--app-stopped` only when you have genuinely stopped the server.

### Relationship to JSON export/import (P6.1)

The two mechanisms are complementary and both are supported:

| | Physical backup (this document) | JSON export/import (P6.1) |
|---|---|---|
| Scope | Entire application state | Public navigation, or one user's personal navigation |
| Includes users and credentials | Yes | No |
| Includes uploaded files | Yes | No (asset paths are instance-local) |
| Portability | One instance's recovery point | Human-readable, movable between instances |
| Destructive on import | Yes | Yes, for the imported scope only |

Use JSON export to move or review navigation content. Use a physical backup to
recover the instance.
