/**
 * Physical backup and restore for the complete persistent application state
 * (P6.2): the SQLite database plus the uploads directory.
 *
 * ## Why "the application must be stopped" is a contract, not a nicety
 *
 * The database and the uploads directory together are the recovery point. SQLite
 * can produce a consistent snapshot while the application is running, but an asset
 * upload is a multi-step filesystem operation:
 *
 *     write new file  →  update the database reference  →  delete the old file
 *
 * An online database snapshot plus an independently copied uploads directory is
 * therefore not guaranteed to describe one coherent application state. Both
 * operations require an explicit `--app-stopped` acknowledgement from the
 * operator. That flag records intent; it is not proof, and no cross-platform
 * process detection is attempted.
 *
 * ## Design
 *
 * - The backup is a plain directory (`manifest.json`, `nav.sqlite`, `uploads/`), so
 *   it needs no archive dependency and stays inspectable by ordinary tools.
 * - The database is captured with SQLite's own backup API through `better-sqlite3`
 *   rather than by copying the file. That yields one self-contained database with
 *   no `-wal`/`-shm` dependency, and it reads the source through a **read-only**
 *   connection so the live database is never written to.
 * - Restore is validate → stage → commit, and the commit is a two-step swap with
 *   rollback. A failure after the first replacement restores both resources, so a
 *   recoverable failure never leaves an old-database/new-uploads mix.
 */

import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import Database from 'better-sqlite3';

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** The only backup format this build produces and accepts. */
export const BACKUP_FORMAT_VERSION = 1;

export const MANIFEST_FILENAME = 'manifest.json';

/** Internal, relative names used inside a backup directory. Never absolute paths. */
export const BACKUP_DATABASE_FILENAME = 'nav.sqlite';
export const BACKUP_UPLOADS_DIRNAME = 'uploads';

/** Default backup output root, matching the repository-local data convention. */
export const DEFAULT_BACKUP_ROOT = 'data/backups';

/** Prefix for the temporary directory a backup is assembled in. */
const INCOMPLETE_PREFIX = '.incomplete-';

/** Prefix for restore staging/safety artifacts. */
const RESTORE_STAGING_DB_PREFIX = '.restore-staging-';
const RESTORE_SAFETY_DB_PREFIX = '.restore-safety-';
const RESTORE_STAGING_UPLOADS_PREFIX = '.restore-staging-uploads-';
const RESTORE_SAFETY_UPLOADS_PREFIX = '.restore-safety-uploads-';

/** SQLite sidecars that must never be restored and must not survive a swap. */
const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

/* -------------------------------------------------------------------------- */
/* Manifest                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Versioned backup manifest.
 *
 * Deliberately minimal: no environment variables, secrets, absolute paths, or
 * hostnames. The database itself naturally contains application and auth rows,
 * which is expected for a physical backup and is not restated here.
 */
export interface BackupManifest {
  format_version: number;
  type: 'physical-backup';
  created_at: string;
  database: string;
  uploads: string;
}

/* -------------------------------------------------------------------------- */
/* Results                                                                     */
/* -------------------------------------------------------------------------- */

export type BackupResult =
  | { status: 'ok'; backupDir: string; manifest: BackupManifest }
  | { status: 'failed'; message: string };

export type RestoreResult =
  | { status: 'ok'; databasePath: string; uploadsDir: string; restoredFrom: string }
  | {
      status: 'failed';
      message: string;
      /** True when rollback could not fully restore the previous live state. */
      recoveryIncomplete: boolean;
      /** Locations the operator must inspect when recovery is incomplete. */
      retainedArtifacts: string[];
    };

/* -------------------------------------------------------------------------- */
/* Filesystem seam                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The filesystem operations restore performs.
 *
 * Exists so a test can inject a failing operation deterministically and prove the
 * rollback path, which would otherwise require deliberately corrupting a machine.
 * It is a thin pass-through to `node:fs` in production and is deliberately not a
 * general filesystem abstraction.
 */
export interface RestoreFileOperations {
  rename(from: string, to: string): void;
  copyDirectory(from: string, to: string): void;
  remove(path: string): void;
  exists(path: string): boolean;
}

export const defaultFileOperations: RestoreFileOperations = {
  rename(from, to) {
    renameSync(from, to);
  },
  copyDirectory(from, to) {
    cpSync(from, to, { recursive: true });
  },
  remove(path) {
    rmSync(path, { recursive: true, force: true });
  },
  exists(path) {
    return existsSync(path);
  },
};

/* -------------------------------------------------------------------------- */
/* Inspection helpers                                                          */
/* -------------------------------------------------------------------------- */

/** True when `child` is `parent` itself or lives underneath it. */
function isSameOrInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));

  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * True when two paths are the same, or either one contains the other.
 *
 * A single-direction check is not enough for path safety: `a` being inside `b`
 * and `b` being inside `a` are both overlaps, and both are dangerous when one side
 * is a backup source and the other is a path restore removes or renames.
 */
function pathsOverlap(a: string, b: string): boolean {
  return isSameOrInside(a, b) || isSameOrInside(b, a);
}

/**
 * Resolve a path to its real filesystem location, tolerating a missing leaf.
 *
 * `realpathSync.native` needs every component to exist, but a destructive-target
 * path such as `nav.sqlite-wal` usually does not yet exist at preflight time. The
 * nearest existing ancestor is therefore resolved and the remaining requested
 * suffix appended, so the returned path is the location the operating system would
 * actually use.
 *
 * This is what makes symlinks and Windows directory junctions visible: a junction
 * at `/operator/backup-link` pointing into the live uploads tree resolves to that
 * tree even though its lexical path looks disjoint.
 *
 * Resolution is best-effort by design. When nothing along the path can be resolved
 * the purely lexical form is returned, because the lexical check already covers
 * that case and a resolution failure must not silently disable path safety.
 */
function resolveFilesystemIdentity(targetPath: string): string {
  const absolute = resolve(targetPath);

  /** Suffixes peeled off while walking up towards an existing ancestor. */
  const trailing: string[] = [];
  let candidate = absolute;

  for (;;) {
    try {
      const resolved = realpathSync.native(candidate);
      return trailing.length === 0 ? resolved : join(resolved, ...trailing.reverse());
    } catch {
      const parent = dirname(candidate);

      // Reached the filesystem root without resolving anything.
      if (parent === candidate) {
        return absolute;
      }

      trailing.push(candidate.slice(parent.length + 1));
      candidate = parent;
    }
  }
}

/**
 * True when two paths overlap after resolving symlinks and junctions.
 *
 * Complements `pathsOverlap`, which is purely lexical. Both are required: the
 * lexical form catches paths that do not exist yet, and the resolved form catches
 * an existing path reached through a filesystem alias.
 */
function resolvedPathsOverlap(a: string, b: string): boolean {
  return pathsOverlap(resolveFilesystemIdentity(a), resolveFilesystemIdentity(b));
}

/**
 * Reject a live layout whose database would be relocated by the uploads swap.
 *
 * Restore places its database staging and safety files **beside the live
 * database** (`dirname(databasePath)`), and then moves the entire live uploads
 * directory aside. If the database — or the directory that holds its staging
 * files — sits anywhere inside the uploads directory, that single uploads move
 * relocates the live database, the staged database, and the database safety
 * snapshot at once. The two swaps stop being independent recoverable resources and
 * a failure leaves the database unrecoverable (observed as recovery-incomplete).
 *
 * The rule is deliberately **directional**. Only one nesting is unsafe:
 *
 *     database inside uploads        → unsafe (restore would move its own DB files)
 *     uploads inside database parent → safe
 *
 * The second case is the normal deployment shape (`/data/nav.sqlite` with
 * `/data/uploads/`), where the database parent merely contains the uploads
 * directory. A symmetric rule would reject every standard installation, so the
 * check is written in one direction only.
 *
 * Returns an operator-facing message, or `null` when the layout is safe.
 */
function findUnsafeLivePathLayout(databasePath: string, uploadsDir: string): string | null {
  const databaseParent = dirname(databasePath);

  const databaseIsInsideUploads =
    isSameOrInside(databasePath, uploadsDir) ||
    isSameOrInside(databaseParent, uploadsDir) ||
    isSameOrInside(resolveFilesystemIdentity(databasePath), resolveFilesystemIdentity(uploadsDir)) ||
    isSameOrInside(resolveFilesystemIdentity(databaseParent), resolveFilesystemIdentity(uploadsDir));

  if (!databaseIsInsideUploads) {
    return null;
  }

  return (
    'refused: the database must not be located inside the uploads directory. ' +
    'Restore places temporary database recovery files beside the database, so an ' +
    'uploads directory that contains the database would move them during the ' +
    'uploads swap. Use a separate database directory, for example data/nav.sqlite ' +
    'with data/uploads/.'
  );
}

interface DatabaseHealth {
  integrity: string;
  foreignKeyViolations: number;
}

/**
 * Open a database read-only and report integrity and foreign-key health.
 *
 * Read-only so validation can never modify the artifact under test. Throws when
 * the file cannot be opened at all, which callers turn into a clean operator error.
 */
function inspectDatabase(databasePath: string): DatabaseHealth {
  const connection = new Database(databasePath, { readonly: true, fileMustExist: true });

  try {
    const integrity = connection.pragma('integrity_check', { simple: true }) as string;
    const violations = connection.pragma('foreign_key_check') as unknown[];

    return { integrity, foreignKeyViolations: violations.length };
  } finally {
    connection.close();
  }
}

/** Validate a database file, returning a human-readable failure or `null`. */
function validateDatabaseFile(databasePath: string, label: string): string | null {
  let health: DatabaseHealth;

  try {
    health = inspectDatabase(databasePath);
  } catch (error) {
    return `${label} is not a readable SQLite database (${String(error).slice(0, 120)})`;
  }

  if (health.integrity !== 'ok') {
    return `${label} failed integrity_check: ${health.integrity}`;
  }

  if (health.foreignKeyViolations !== 0) {
    return `${label} has ${String(health.foreignKeyViolations)} foreign key violation(s)`;
  }

  return null;
}

/**
 * Copy a SQLite database through SQLite's own backup API.
 *
 * The source is opened read-only so it is never modified, and the destination is a
 * single self-contained file with no sidecar dependency. This is used for the
 * backup itself, for restore staging, and for the pre-restore safety snapshot.
 */
async function copyDatabaseConsistently(sourcePath: string, destinationPath: string): Promise<void> {
  mkdirSync(dirname(destinationPath), { recursive: true });

  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });

  try {
    await source.backup(destinationPath);
  } finally {
    source.close();
  }
}

/** Remove a database's sidecars so a stale WAL/SHM cannot attach to a restored DB. */
function removeDatabaseSidecars(databasePath: string, ops: RestoreFileOperations): void {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    ops.remove(`${databasePath}${suffix}`);
  }
}

/** `backup-YYYYMMDDTHHMMSSZ`, matching the documented artifact shape. */
export function backupDirectoryName(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `backup-${stamp}`;
}

/** Pick a directory name that does not already exist; never overwrite a backup. */
function uniqueBackupDirectory(root: string, baseName: string): string {
  let candidate = join(root, baseName);
  let counter = 2;

  while (existsSync(candidate)) {
    candidate = join(root, `${baseName}-${String(counter)}`);
    counter += 1;
  }

  return candidate;
}

/* -------------------------------------------------------------------------- */
/* Backup                                                                      */
/* -------------------------------------------------------------------------- */

export interface CreateBackupOptions {
  databasePath: string;
  uploadsDir: string;
  backupRoot: string;
  now?: Date;
}

/**
 * Create a physical backup directory.
 *
 * Assembly happens in a hidden, incomplete directory that is renamed into place
 * only after every step succeeds, so a partially written backup can never be
 * mistaken for a completed one.
 */
export async function createPhysicalBackup(options: CreateBackupOptions): Promise<BackupResult> {
  const databasePath = resolve(options.databasePath);
  const uploadsDir = resolve(options.uploadsDir);
  const backupRoot = resolve(options.backupRoot);
  const now = options.now ?? new Date();

  // Live layout first: a database captured from inside the uploads tree would put
  // the database (and any SQLite sidecars) into the backup's own `uploads/`,
  // producing an ambiguous physical recovery artifact.
  const unsafeLayout = findUnsafeLivePathLayout(databasePath, uploadsDir);

  if (unsafeLayout !== null) {
    return { status: 'failed', message: unsafeLayout };
  }

  if (!existsSync(databasePath)) {
    return { status: 'failed', message: `database not found: ${databasePath}` };
  }

  // Recursively backing an uploads directory into a location inside itself would
  // copy the backup while it is being written. Both the lexical and the resolved
  // form are checked, so a symlink or junction cannot smuggle the destination into
  // the live uploads tree.
  if (isSameOrInside(backupRoot, uploadsDir) || resolvedPathsOverlap(backupRoot, uploadsDir)) {
    return {
      status: 'failed',
      message: `backup output root must not be inside the uploads directory: ${backupRoot}`,
    };
  }

  mkdirSync(backupRoot, { recursive: true });

  const finalDir = uniqueBackupDirectory(backupRoot, backupDirectoryName(now));
  const incompleteDir = join(backupRoot, `${INCOMPLETE_PREFIX}${randomUUID()}`);

  // Re-checked after creation: the directory may only now be resolvable, and the
  // resolution must cover the directory the backup will actually be written into.
  if (
    isSameOrInside(incompleteDir, uploadsDir) ||
    resolvedPathsOverlap(incompleteDir, uploadsDir)
  ) {
    return {
      status: 'failed',
      message: `backup output root must not be inside the uploads directory: ${incompleteDir}`,
    };
  }

  const cleanup = (): void => {
    rmSync(incompleteDir, { recursive: true, force: true });
  };

  try {
    mkdirSync(incompleteDir, { recursive: true });

    // 1. Consistent, self-contained database snapshot.
    const backupDatabasePath = join(incompleteDir, BACKUP_DATABASE_FILENAME);
    await copyDatabaseConsistently(databasePath, backupDatabasePath);

    // 2. Complete uploads state. A valid installation may not have uploaded
    //    anything yet, in which case the artifact still carries an empty directory.
    const backupUploadsDir = join(incompleteDir, BACKUP_UPLOADS_DIRNAME);

    if (existsSync(uploadsDir)) {
      cpSync(uploadsDir, backupUploadsDir, { recursive: true });
    } else {
      mkdirSync(backupUploadsDir, { recursive: true });
    }

    // 3. Validate the artifact before it can be presented as a backup.
    const databaseProblem = validateDatabaseFile(backupDatabasePath, 'backup database');

    if (databaseProblem !== null) {
      cleanup();
      return { status: 'failed', message: databaseProblem };
    }

    const manifest: BackupManifest = {
      format_version: BACKUP_FORMAT_VERSION,
      type: 'physical-backup',
      created_at: now.toISOString(),
      database: BACKUP_DATABASE_FILENAME,
      uploads: BACKUP_UPLOADS_DIRNAME,
    };

    writeFileSync(join(incompleteDir, MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`);

    // 4. Publish atomically. Nothing before this point is visible as a backup.
    renameSync(incompleteDir, finalDir);

    return { status: 'ok', backupDir: finalDir, manifest };
  } catch (error) {
    cleanup();
    return { status: 'failed', message: `backup failed: ${String(error).slice(0, 200)}` };
  }
}

/* -------------------------------------------------------------------------- */
/* Restore preflight                                                           */
/* -------------------------------------------------------------------------- */

interface ValidatedBackup {
  backupDir: string;
  databasePath: string;
  uploadsDir: string;
}

type PreflightResult = { ok: true; backup: ValidatedBackup } | { ok: false; message: string };

/**
 * Validate a backup directory without touching any live path.
 *
 * Every check here happens before the first destructive action, so an unusable or
 * unsupported backup can never partially overwrite live data.
 */
export function validateBackupDirectory(backupDir: string): PreflightResult {
  const resolvedDir = resolve(backupDir);

  if (!existsSync(resolvedDir)) {
    return { ok: false, message: `backup directory not found: ${resolvedDir}` };
  }

  const manifestPath = join(resolvedDir, MANIFEST_FILENAME);

  if (!existsSync(manifestPath)) {
    return { ok: false, message: `backup is missing ${MANIFEST_FILENAME}` };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return { ok: false, message: `${MANIFEST_FILENAME} is not valid JSON` };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: `${MANIFEST_FILENAME} must be a JSON object` };
  }

  const manifest = parsed as Record<string, unknown>;

  if (manifest['format_version'] !== BACKUP_FORMAT_VERSION) {
    return {
      ok: false,
      message: `unsupported format_version (expected ${String(BACKUP_FORMAT_VERSION)})`,
    };
  }

  if (manifest['type'] !== 'physical-backup') {
    return { ok: false, message: 'manifest type must be "physical-backup"' };
  }

  // Internal names are fixed and relative: a manifest cannot redirect the restore
  // at an arbitrary path.
  if (manifest['database'] !== BACKUP_DATABASE_FILENAME) {
    return { ok: false, message: `manifest database must be "${BACKUP_DATABASE_FILENAME}"` };
  }

  if (manifest['uploads'] !== BACKUP_UPLOADS_DIRNAME) {
    return { ok: false, message: `manifest uploads must be "${BACKUP_UPLOADS_DIRNAME}"` };
  }

  const backupDatabasePath = join(resolvedDir, BACKUP_DATABASE_FILENAME);
  const backupUploadsDir = join(resolvedDir, BACKUP_UPLOADS_DIRNAME);

  if (!existsSync(backupDatabasePath)) {
    return { ok: false, message: `backup is missing ${BACKUP_DATABASE_FILENAME}` };
  }

  if (!existsSync(backupUploadsDir) || !statSync(backupUploadsDir).isDirectory()) {
    return { ok: false, message: `backup is missing the ${BACKUP_UPLOADS_DIRNAME} directory` };
  }

  const databaseProblem = validateDatabaseFile(backupDatabasePath, 'backup database');

  if (databaseProblem !== null) {
    return { ok: false, message: databaseProblem };
  }

  return {
    ok: true,
    backup: { backupDir: resolvedDir, databasePath: backupDatabasePath, uploadsDir: backupUploadsDir },
  };
}

/* -------------------------------------------------------------------------- */
/* Restore                                                                     */
/* -------------------------------------------------------------------------- */

export interface RestoreBackupOptions {
  backupDir: string;
  databasePath: string;
  uploadsDir: string;
  /** Test seam; defaults to the real filesystem. */
  ops?: RestoreFileOperations;
}

/**
 * Reject a restore whose backup source overlaps a live path restore will destroy.
 *
 * Restore removes and renames the live database, its SQLite sidecars, and the live
 * uploads directory. If the backup source is the same as — or nested anywhere
 * inside or around — any of those paths, the restore algorithm would move or
 * delete its own recovery input. That silently destroys the operator's only copy of
 * the data they are trying to restore, which is why this is checked before staging
 * begins rather than handled by the rollback path.
 *
 * The check is bidirectional on purpose: "the backup is inside uploads" and "the
 * uploads are inside the backup" are both unsafe, and the database case includes
 * the sidecar paths that are removed next to the live database.
 *
 * Returns an operator-facing message, or `null` when the layout is safe.
 */
function findRestorePathOverlap(
  backupDir: string,
  databasePath: string,
  uploadsDir: string,
): string | null {
  const livePaths = [
    { label: 'the live database', path: databasePath },
    ...SQLITE_SIDECAR_SUFFIXES.map((suffix) => ({
      label: `a live database sidecar (${suffix})`,
      path: `${databasePath}${suffix}`,
    })),
    { label: 'the live uploads directory', path: uploadsDir },
  ];

  for (const live of livePaths) {
    // Lexical first (it also covers paths that do not exist yet), then resolved, so
    // a symlink or junction cannot hide a live target behind a disjoint spelling.
    if (pathsOverlap(backupDir, live.path) || resolvedPathsOverlap(backupDir, live.path)) {
      return (
        `restore refused: backup source overlaps ${live.label}. ` +
        'Keep physical backups outside the live database and uploads paths.'
      );
    }
  }

  return null;
}

/**
 * Restore a physical backup over the live database and uploads directory.
 *
 * Validate → stage → swap, with rollback. Recovery material for the previous live
 * state is created before the first destructive action and is only removed once
 * **both** replacements have succeeded, so a recoverable failure restores both
 * resources rather than leaving a mixed state.
 */
export async function restorePhysicalBackup(options: RestoreBackupOptions): Promise<RestoreResult> {
  const ops = options.ops ?? defaultFileOperations;
  const databasePath = resolve(options.databasePath);
  const uploadsDir = resolve(options.uploadsDir);
  const requestedBackupDir = resolve(options.backupDir);

  // ---- Preflight: no live path is touched until this passes. ----

  // Live layout first: if the database sits inside the uploads tree, the uploads
  // swap would relocate the database and its staging/safety files, making the two
  // swaps non-independent and unrecoverable. This is a pure path check.
  const unsafeLayout = findUnsafeLivePathLayout(databasePath, uploadsDir);

  if (unsafeLayout !== null) {
    return { status: 'failed', message: unsafeLayout, recoveryIncomplete: false, retainedArtifacts: [] };
  }

  // Source layout: also a pure path check, and it must be reachable without
  // reading or writing anything at all.
  const overlap = findRestorePathOverlap(requestedBackupDir, databasePath, uploadsDir);

  if (overlap !== null) {
    return { status: 'failed', message: overlap, recoveryIncomplete: false, retainedArtifacts: [] };
  }

  const preflight = validateBackupDirectory(options.backupDir);

  if (!preflight.ok) {
    return { status: 'failed', message: preflight.message, recoveryIncomplete: false, retainedArtifacts: [] };
  }

  const { backupDir, databasePath: backupDatabasePath, uploadsDir: backupUploadsDir } = preflight.backup;

  const databaseParent = dirname(databasePath);
  const uploadsParent = dirname(uploadsDir);
  const token = randomUUID();

  const stagedDatabase = join(databaseParent, `${RESTORE_STAGING_DB_PREFIX}${token}.sqlite`);
  const safetyDatabase = join(databaseParent, `${RESTORE_SAFETY_DB_PREFIX}${token}.sqlite`);
  const stagedUploads = join(uploadsParent, `${RESTORE_STAGING_UPLOADS_PREFIX}${token}`);
  const safetyUploads = join(uploadsParent, `${RESTORE_SAFETY_UPLOADS_PREFIX}${token}`);

  /** Artifacts kept on disk so an operator can recover manually if needed. */
  const transientArtifacts = [stagedDatabase, stagedUploads];
  const safetyArtifacts = [safetyDatabase, safetyUploads];

  const removeAll = (paths: string[]): void => {
    for (const path of paths) {
      try {
        ops.remove(path);
      } catch {
        // Best-effort: a leftover temporary file is harmless.
      }
    }
  };

  let hasSafetyDatabase = false;
  let hasSafetyUploads = false;
  /**
   * Set immediately *before* the first destructive database action.
   *
   * Deliberately not set after the install succeeds: the live database is removed
   * before the staged file is renamed into place, so a failure in between still
   * requires the database to be restored from its safety snapshot.
   */
  let databaseSwapStarted = false;
  let uploadsInstalled = false;

  const cleanupTransients = (): void => {
    removeAll(transientArtifacts);
  };

  const discardSafety = (): void => {
    removeAll(safetyArtifacts);
  };

  try {
    /* ---- Stage the replacement material (still no live mutation). ---- */

    await copyDatabaseConsistently(backupDatabasePath, stagedDatabase);

    const stagedProblem = validateDatabaseFile(stagedDatabase, 'staged database');

    if (stagedProblem !== null) {
      cleanupTransients();
      return { status: 'failed', message: stagedProblem, recoveryIncomplete: false, retainedArtifacts: [] };
    }

    ops.copyDirectory(backupUploadsDir, stagedUploads);

    /* ---- Capture recovery material for the current live state. ---- */

    if (existsSync(databasePath)) {
      await copyDatabaseConsistently(databasePath, safetyDatabase);
      hasSafetyDatabase = true;
    }

    if (ops.exists(uploadsDir)) {
      // Moving the current directory aside is itself the recovery copy: it stays
      // byte-identical and can be renamed back.
      ops.rename(uploadsDir, safetyUploads);
      hasSafetyUploads = true;
    }

    /* ---- Commit: install the restored database, then the uploads. ---- */

    databaseSwapStarted = true;
    removeAll([databasePath]);
    removeDatabaseSidecars(databasePath, ops);
    ops.rename(stagedDatabase, databasePath);

    // Step two. A failure here is the injected/recoverable mid-restore case.
    ops.rename(stagedUploads, uploadsDir);
    uploadsInstalled = true;
  } catch (error) {
    /* ---- Rollback: restore whichever resources were replaced. ---- */

    const rollbackFailures: string[] = [];

    if (databaseSwapStarted) {
      try {
        // Whatever sits at the database path is either the restored file or a
        // partial install; the safety snapshot is authoritative either way.
        removeAll([databasePath]);
        removeDatabaseSidecars(databasePath, ops);

        if (hasSafetyDatabase) {
          await copyDatabaseConsistently(safetyDatabase, databasePath);
        }
      } catch (rollbackError) {
        rollbackFailures.push(`database rollback failed: ${String(rollbackError).slice(0, 120)}`);
      }
    }

    try {
      // Remove the restored uploads if they were installed. When the live uploads
      // directory did not exist before the restore, removing them returns to that
      // empty state rather than leaving restored data behind.
      if (uploadsInstalled) {
        removeAll([uploadsDir]);
      }

      // Put the previous uploads back, byte-identical, when they were moved aside.
      if (hasSafetyUploads && !ops.exists(uploadsDir)) {
        ops.rename(safetyUploads, uploadsDir);
      }
    } catch (rollbackError) {
      rollbackFailures.push(`uploads rollback failed: ${String(rollbackError).slice(0, 120)}`);
    }

    cleanupTransients();

    if (rollbackFailures.length > 0) {
      // Never claim success and never delete what might be needed for manual recovery.
      return {
        status: 'failed',
        message: `restore failed (${String(error).slice(0, 140)}); recovery incomplete: ${rollbackFailures.join('; ')}`,
        recoveryIncomplete: true,
        retainedArtifacts: safetyArtifacts.filter((path) => ops.exists(path)),
      };
    }

    discardSafety();

    return {
      status: 'failed',
      message: `restore failed and was rolled back: ${String(error).slice(0, 200)}`,
      recoveryIncomplete: false,
      retainedArtifacts: [],
    };
  }

  /* ---- Success: the previous state is no longer needed. ---- */
  cleanupTransients();
  discardSafety();

  return { status: 'ok', databasePath, uploadsDir, restoredFrom: backupDir };
}
