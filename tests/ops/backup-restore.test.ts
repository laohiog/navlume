import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BACKUP_DATABASE_FILENAME,
  BACKUP_FORMAT_VERSION,
  BACKUP_UPLOADS_DIRNAME,
  MANIFEST_FILENAME,
  createPhysicalBackup,
  defaultFileOperations,
  restorePhysicalBackup,
  validateBackupDirectory,
  type RestoreFileOperations,
} from '../../src/server/backup-restore.js';
import { runBackup } from '../../src/server/backup.js';
import { runRestore, EXIT_RECOVERY_INCOMPLETE } from '../../src/server/restore.js';

/* -------------------------------------------------------------------------- */
/* Isolated environment                                                        */
/* -------------------------------------------------------------------------- */

let root: string;

/** Fresh isolated directory per test; the real `data/` tree is never touched. */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bnp-p62-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function paths() {
  return {
    databasePath: join(root, 'live', 'nav.sqlite'),
    uploadsDir: join(root, 'live', 'uploads'),
    backupRoot: join(root, 'backups'),
  };
}

/** A real, minimal schema with a foreign key so FK checks are meaningful. */
function createDatabase(path: string, value: string): void {
  mkdirSync(join(path, '..'), { recursive: true });

  const database = new Database(path);
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE IF NOT EXISTS parent(id INTEGER PRIMARY KEY, label TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS child(
      id INTEGER PRIMARY KEY,
      parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE
    );
  `);
  database.prepare('DELETE FROM child').run();
  database.prepare('DELETE FROM parent').run();
  database.prepare('INSERT INTO parent(id, label) VALUES (1, ?)').run(value);
  database.prepare('INSERT INTO child(id, parent_id) VALUES (1, 1)').run();
  database.close();
}

function readValue(databasePath: string): string {
  const database = new Database(databasePath, { readonly: true });

  try {
    return (database.prepare('SELECT label FROM parent WHERE id = 1').get() as { label: string })
      .label;
  } finally {
    database.close();
  }
}

function databaseHealth(databasePath: string): { integrity: string; violations: number } {
  const database = new Database(databasePath, { readonly: true });

  try {
    return {
      integrity: database.pragma('integrity_check', { simple: true }) as string,
      violations: (database.pragma('foreign_key_check') as unknown[]).length,
    };
  } finally {
    database.close();
  }
}

/** Write an asset file, creating directories as needed. */
function writeAsset(uploadsDir: string, relativePath: string, contents: string): void {
  const target = join(uploadsDir, relativePath);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, contents);
}

/** Recursively hash every file under `directory`, keyed by relative path. */
function hashTree(directory: string): Record<string, string> {
  const result: Record<string, string> = {};

  if (!existsSync(directory)) {
    return result;
  }

  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      const relative = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        walk(absolute, relative);
      } else {
        result[relative] = createHash('sha256').update(readFileSync(absolute)).digest('hex');
      }
    }
  };

  walk(directory, '');
  return result;
}

/** Materialise State A (database + uploads) and return the relevant paths. */
function establishStateA(): ReturnType<typeof paths> {
  const target = paths();
  createDatabase(target.databasePath, 'A');
  writeAsset(target.uploadsDir, 'branding/a.bin', 'ASSET-A');
  return target;
}

/** Move to State B, changing the database, the asset set, and the branding asset. */
function establishStateB(target: ReturnType<typeof paths>): void {
  createDatabase(target.databasePath, 'B');
  rmSync(join(target.uploadsDir, 'branding'), { recursive: true, force: true });
  writeAsset(target.uploadsDir, 'branding/b.bin', 'ASSET-B');
  writeAsset(target.uploadsDir, 'branding/changed.bin', 'STATE-B-ONLY');
}

const QUIET_ENV = {} as NodeJS.ProcessEnv;

/**
 * Run `body` with the CLI's stdout/stderr suppressed.
 *
 * The commands intentionally print operator-facing progress; the tests assert on
 * exit codes and filesystem effects, so the chatter is silenced to keep the report
 * readable without weakening what is asserted.
 */
async function quietly<T>(body: () => Promise<T>): Promise<T> {
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;

  try {
    return await body();
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

/* -------------------------------------------------------------------------- */
/* Acknowledgement contract                                                    */
/* -------------------------------------------------------------------------- */

describe('app-stopped acknowledgement', () => {
  it('refuses backup without --app-stopped and changes nothing', async () => {
    const target = establishStateA();

    const exitCode = await quietly(() =>
      runBackup(
        ['--output', target.backupRoot, '--database', target.databasePath, '--uploads', target.uploadsDir],
        QUIET_ENV,
      ),
    );

    expect(exitCode).toBe(1);
    expect(existsSync(target.backupRoot)).toBe(false);
    expect(readValue(target.databasePath)).toBe('A');
  });

  it('refuses restore without --app-stopped and changes nothing', async () => {
    const target = establishStateA();
    const backup = await createPhysicalBackup({ ...target });

    if (backup.status !== 'ok') throw new Error('backup setup failed');
    establishStateB(target);

    const exitCode = await quietly(() =>
      runRestore(
        ['--confirm-restore', '--backup', backup.backupDir, '--database', target.databasePath, '--uploads', target.uploadsDir],
        QUIET_ENV,
      ),
    );

    expect(exitCode).toBe(1);
    expect(readValue(target.databasePath)).toBe('B');
  });

  it('requires --confirm-restore in addition to --app-stopped', async () => {
    const target = establishStateA();
    const backup = await createPhysicalBackup({ ...target });

    if (backup.status !== 'ok') throw new Error('backup setup failed');
    establishStateB(target);

    const exitCode = await quietly(() =>
      runRestore(
        ['--app-stopped', '--backup', backup.backupDir, '--database', target.databasePath, '--uploads', target.uploadsDir],
        QUIET_ENV,
      ),
    );

    expect(exitCode).toBe(1);
    expect(readValue(target.databasePath)).toBe('B');
  });

  it('requires an explicit --backup directory', async () => {
    const target = establishStateA();

    const exitCode = await quietly(() =>
      runRestore(
        ['--app-stopped', '--confirm-restore', '--database', target.databasePath, '--uploads', target.uploadsDir],
        QUIET_ENV,
      ),
    );

    expect(exitCode).toBe(1);
  });

  it('does not rely on an interactive prompt', async () => {
    // Both acknowledgements are flags; nothing is read from stdin during the run.
    const target = establishStateA();

    const exitCode = await quietly(() => runRestore(['--backup', join(root, 'nope')], QUIET_ENV));

    expect(exitCode).toBe(1);
    expect(existsSync(target.databasePath)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Backup creation                                                             */
/* -------------------------------------------------------------------------- */

describe('backup creation', () => {
  it('uses the configured database and uploads paths', async () => {
    const target = establishStateA();

    const result = await createPhysicalBackup({ ...target });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(readValue(join(result.backupDir, BACKUP_DATABASE_FILENAME))).toBe('A');
    expect(existsSync(join(result.backupDir, BACKUP_UPLOADS_DIRNAME, 'branding', 'a.bin'))).toBe(true);
  });

  it('resolves paths from the environment when no flags are given', async () => {
    const target = establishStateA();

    const exitCode = await quietly(() =>
      runBackup(['--app-stopped'], {
        DATABASE_PATH: target.databasePath,
        UPLOADS_DIR: target.uploadsDir,
        BACKUP_DIR: target.backupRoot,
      } as unknown as NodeJS.ProcessEnv),
    );

    expect(exitCode).toBe(0);

    const created = readdirSync(target.backupRoot);
    expect(created).toHaveLength(1);
    expect(existsSync(join(target.backupRoot, created[0]!, MANIFEST_FILENAME))).toBe(true);
  });

  it('succeeds when the uploads directory does not exist yet', async () => {
    const target = paths();
    createDatabase(target.databasePath, 'NO-UPLOADS');

    const result = await createPhysicalBackup({ ...target });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    // The artifact still carries an empty uploads directory.
    const uploadsDir = join(result.backupDir, BACKUP_UPLOADS_DIRNAME);
    expect(existsSync(uploadsDir)).toBe(true);
    expect(statSync(uploadsDir).isDirectory()).toBe(true);
    expect(readdirSync(uploadsDir)).toEqual([]);
  });

  it('fails cleanly when the source database does not exist', async () => {
    const target = paths();
    mkdirSync(target.uploadsDir, { recursive: true });

    const result = await createPhysicalBackup({ ...target });

    expect(result.status).toBe('failed');
    // Nothing that looks like a completed backup was left behind.
    expect(existsSync(target.backupRoot) && readdirSync(target.backupRoot).length > 0).toBe(false);
  });

  it('produces a versioned manifest with only relative internal names', async () => {
    const target = establishStateA();
    const result = await createPhysicalBackup({ ...target });

    if (result.status !== 'ok') throw new Error('backup failed');

    const manifest = JSON.parse(readFileSync(join(result.backupDir, MANIFEST_FILENAME), 'utf8')) as Record<string, unknown>;

    expect(manifest).toEqual({
      format_version: BACKUP_FORMAT_VERSION,
      type: 'physical-backup',
      created_at: expect.any(String),
      database: BACKUP_DATABASE_FILENAME,
      uploads: BACKUP_UPLOADS_DIRNAME,
    });

    // No secrets, absolute paths, or hostnames leak into the manifest.
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('DATABASE_PATH');
  });

  it('contains a self-contained database and complete uploads state', async () => {
    const target = establishStateA();
    writeAsset(target.uploadsDir, 'branding/nested/deep.bin', 'DEEP');

    const result = await createPhysicalBackup({ ...target });
    if (result.status !== 'ok') throw new Error('backup failed');

    expect(readdirSync(result.backupDir).sort()).toEqual([
      MANIFEST_FILENAME,
      BACKUP_DATABASE_FILENAME,
      BACKUP_UPLOADS_DIRNAME,
    ]);
    // Nested upload content is preserved, not just referenced files.
    expect(existsSync(join(result.backupDir, BACKUP_UPLOADS_DIRNAME, 'branding', 'nested', 'deep.bin'))).toBe(true);
  });

  it('produces a backup whose integrity and foreign keys are valid', async () => {
    const target = establishStateA();
    const result = await createPhysicalBackup({ ...target });

    if (result.status !== 'ok') throw new Error('backup failed');

    const health = databaseHealth(join(result.backupDir, BACKUP_DATABASE_FILENAME));
    expect(health.integrity).toBe('ok');
    expect(health.violations).toBe(0);
  });

  it('does not require WAL/SHM as part of a valid backup', async () => {
    const target = establishStateA();

    // Present in the live location but deliberately not part of the artifact.
    writeFileSync(`${target.databasePath}-wal`, 'BOGUS-WAL');
    writeFileSync(`${target.databasePath}-shm`, 'BOGUS-SHM');

    const result = await createPhysicalBackup({ ...target });
    if (result.status !== 'ok') throw new Error('backup failed');

    expect(existsSync(join(result.backupDir, `${BACKUP_DATABASE_FILENAME}-wal`))).toBe(false);
    expect(existsSync(join(result.backupDir, `${BACKUP_DATABASE_FILENAME}-shm`))).toBe(false);

    // And the artifact opens cleanly on its own.
    expect(databaseHealth(join(result.backupDir, BACKUP_DATABASE_FILENAME)).integrity).toBe('ok');
  });

  it('never silently overwrites an existing backup', async () => {
    const target = establishStateA();
    const instant = new Date('2026-01-02T03:04:05.000Z');

    const first = await createPhysicalBackup({ ...target, now: instant });
    const second = await createPhysicalBackup({ ...target, now: instant });

    if (first.status !== 'ok' || second.status !== 'ok') throw new Error('backups failed');

    expect(second.backupDir).not.toBe(first.backupDir);
    expect(existsSync(first.backupDir)).toBe(true);
    expect(existsSync(second.backupDir)).toBe(true);
  });

  it('rejects a backup root placed inside the uploads directory', async () => {
    const target = establishStateA();

    const result = await createPhysicalBackup({
      databasePath: target.databasePath,
      uploadsDir: target.uploadsDir,
      backupRoot: join(target.uploadsDir, 'backups'),
    });

    expect(result.status).toBe('failed');
  });

  it('publishes no completed backup when the source database is unusable', async () => {
    const target = paths();
    mkdirSync(target.uploadsDir, { recursive: true });
    writeAsset(target.uploadsDir, 'branding/a.bin', 'ASSET-A');

    // A file that exists but is not a database: the snapshot cannot be valid, so the
    // incomplete directory must be discarded rather than published.
    mkdirSync(join(target.databasePath, '..'), { recursive: true });
    writeFileSync(target.databasePath, 'not a sqlite database at all');

    const result = await createPhysicalBackup({ ...target });

    expect(result.status).toBe('failed');
    const entries = existsSync(target.backupRoot) ? readdirSync(target.backupRoot) : [];
    // Nothing that looks like a completed backup, and no incomplete directory left.
    expect(entries.filter((name) => name.startsWith('backup-'))).toEqual([]);
    expect(entries.filter((name) => name.startsWith('.incomplete-'))).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Restore preflight                                                           */
/* -------------------------------------------------------------------------- */

describe('restore preflight', () => {
  it('rejects a missing backup directory without touching live state', async () => {
    const target = establishStateA();

    const result = await restorePhysicalBackup({
      backupDir: join(root, 'does-not-exist'),
      databasePath: target.databasePath,
      uploadsDir: target.uploadsDir,
    });

    expect(result.status).toBe('failed');
    expect(readValue(target.databasePath)).toBe('A');
  });

  it('rejects an unsupported manifest version before any live mutation', async () => {
    const target = establishStateA();
    const backup = await createPhysicalBackup({ ...target });
    if (backup.status !== 'ok') throw new Error('backup failed');

    writeFileSync(
      join(backup.backupDir, MANIFEST_FILENAME),
      JSON.stringify({ format_version: 99, type: 'physical-backup', database: BACKUP_DATABASE_FILENAME, uploads: BACKUP_UPLOADS_DIRNAME }),
    );
    establishStateB(target);

    const result = await restorePhysicalBackup({
      backupDir: backup.backupDir,
      databasePath: target.databasePath,
      uploadsDir: target.uploadsDir,
    });

    expect(result.status).toBe('failed');
    expect(readValue(target.databasePath)).toBe('B');
  });

  it('rejects a manifest that is not valid JSON', async () => {
    const target = establishStateA();
    const backup = await createPhysicalBackup({ ...target });
    if (backup.status !== 'ok') throw new Error('backup failed');

    writeFileSync(join(backup.backupDir, MANIFEST_FILENAME), '{ not json');

    expect(validateBackupDirectory(backup.backupDir).ok).toBe(false);
  });

  it('rejects a manifest redirecting at an absolute or unexpected path', async () => {
    const target = establishStateA();
    const backup = await createPhysicalBackup({ ...target });
    if (backup.status !== 'ok') throw new Error('backup failed');

    for (const manifest of [
      { format_version: 1, type: 'physical-backup', database: '/etc/passwd', uploads: BACKUP_UPLOADS_DIRNAME },
      { format_version: 1, type: 'physical-backup', database: BACKUP_DATABASE_FILENAME, uploads: '../outside' },
      { format_version: 1, type: 'wrong-type', database: BACKUP_DATABASE_FILENAME, uploads: BACKUP_UPLOADS_DIRNAME },
    ]) {
      writeFileSync(join(backup.backupDir, MANIFEST_FILENAME), JSON.stringify(manifest));
      expect(validateBackupDirectory(backup.backupDir).ok).toBe(false);
    }
  });

  it('rejects a missing or corrupt backup database before live mutation', async () => {
    const target = establishStateA();
    const backup = await createPhysicalBackup({ ...target });
    if (backup.status !== 'ok') throw new Error('backup failed');

    const backupDb = join(backup.backupDir, BACKUP_DATABASE_FILENAME);
    rmSync(backupDb);
    establishStateB(target);

    const missing = await restorePhysicalBackup({
      backupDir: backup.backupDir,
      databasePath: target.databasePath,
      uploadsDir: target.uploadsDir,
    });
    expect(missing.status).toBe('failed');
    expect(readValue(target.databasePath)).toBe('B');

    // Now a file that exists but is not a database.
    writeFileSync(backupDb, 'this is definitely not sqlite');

    const corrupt = await restorePhysicalBackup({
      backupDir: backup.backupDir,
      databasePath: target.databasePath,
      uploadsDir: target.uploadsDir,
    });
    expect(corrupt.status).toBe('failed');
    expect(readValue(target.databasePath)).toBe('B');
  });

  it('rejects a backup with no uploads directory', async () => {
    const target = establishStateA();
    const backup = await createPhysicalBackup({ ...target });
    if (backup.status !== 'ok') throw new Error('backup failed');

    rmSync(join(backup.backupDir, BACKUP_UPLOADS_DIRNAME), { recursive: true, force: true });

    expect(validateBackupDirectory(backup.backupDir).ok).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Restore round trip                                                          */
/* -------------------------------------------------------------------------- */

describe('restore round trip', () => {
  it('reproduces the backup-time database and uploads state', async () => {
    const target = establishStateA();
    writeAsset(target.uploadsDir, 'branding/keep.bin', 'KEEP-A');

    const uploadsAtBackup = hashTree(target.uploadsDir);
    const backup = await createPhysicalBackup({ ...target });
    if (backup.status !== 'ok') throw new Error('backup failed');

    establishStateB(target);

    const result = await restorePhysicalBackup({
      backupDir: backup.backupDir,
      databasePath: target.databasePath,
      uploadsDir: target.uploadsDir,
    });

    expect(result.status).toBe('ok');
    expect(readValue(target.databasePath)).toBe('A');

    // Uploads are restored byte-for-byte.
    expect(hashTree(target.uploadsDir)).toEqual(uploadsAtBackup);
  });

  it('removes data and assets that only appeared after the backup', async () => {
    const target = establishStateA();
    const backup = await createPhysicalBackup({ ...target });
    if (backup.status !== 'ok') throw new Error('backup failed');

    establishStateB(target);

    await restorePhysicalBackup({
      backupDir: backup.backupDir,
      databasePath: target.databasePath,
      uploadsDir: target.uploadsDir,
    });

    expect(readValue(target.databasePath)).toBe('A');
    expect(existsSync(join(target.uploadsDir, 'branding', 'b.bin'))).toBe(false);
    expect(existsSync(join(target.uploadsDir, 'branding', 'changed.bin'))).toBe(false);
  });

  it('brings back assets deleted after the backup', async () => {
    const target = establishStateA();
    const backup = await createPhysicalBackup({ ...target });
    if (backup.status !== 'ok') throw new Error('backup failed');

    // Delete the asset and change the database.
    rmSync(join(target.uploadsDir, 'branding', 'a.bin'), { force: true });
    createDatabase(target.databasePath, 'B');
    expect(existsSync(join(target.uploadsDir, 'branding', 'a.bin'))).toBe(false);

    await restorePhysicalBackup({
      backupDir: backup.backupDir,
      databasePath: target.databasePath,
      uploadsDir: target.uploadsDir,
    });

    expect(readFileSync(join(target.uploadsDir, 'branding', 'a.bin'), 'utf8')).toBe('ASSET-A');
  });

  it('does not mutate the backup source it restored from', async () => {
    const target = establishStateA();
    const backup = await createPhysicalBackup({ ...target });
    if (backup.status !== 'ok') throw new Error('backup failed');

    const before = hashTree(backup.backupDir);
    const manifestBefore = readFileSync(join(backup.backupDir, MANIFEST_FILENAME), 'utf8');

    establishStateB(target);

    const result = await restorePhysicalBackup({
      backupDir: backup.backupDir,
      databasePath: target.databasePath,
      uploadsDir: target.uploadsDir,
    });

    expect(result.status).toBe('ok');
    // The artifact is read-only input: identical bytes, identical structure.
    expect(hashTree(backup.backupDir)).toEqual(before);
    expect(readFileSync(join(backup.backupDir, MANIFEST_FILENAME), 'utf8')).toBe(manifestBefore);
    expect(readdirSync(backup.backupDir).sort()).toEqual([
      MANIFEST_FILENAME,
      BACKUP_DATABASE_FILENAME,
      BACKUP_UPLOADS_DIRNAME,
    ]);
  });

  it('leaves no temporary or incomplete artifacts after success', async () => {
    const target = establishStateA();
    const backup = await createPhysicalBackup({ ...target });
    if (backup.status !== 'ok') throw new Error('backup failed');

    establishStateB(target);

    await restorePhysicalBackup({
      backupDir: backup.backupDir,
      databasePath: target.databasePath,
      uploadsDir: target.uploadsDir,
    });

    const liveEntries = readdirSync(join(root, 'live'));
    expect(liveEntries.filter((name) => name.startsWith('.'))).toEqual([]);
    expect(liveEntries.sort()).toEqual(['nav.sqlite', 'uploads']);
    expect(readdirSync(target.backupRoot).filter((name) => name.startsWith('.incomplete-'))).toEqual([]);
  });

  it('ignores stale target WAL/SHM so a restored database reopens cleanly', async () => {
    const target = establishStateA();
    const backup = await createPhysicalBackup({ ...target });
    if (backup.status !== 'ok') throw new Error('backup failed');

    establishStateB(target);

    // Stale sidecars belonging to the previous database.
    writeFileSync(`${target.databasePath}-wal`, 'STALE-WAL-CONTENT');
    writeFileSync(`${target.databasePath}-shm`, 'STALE-SHM-CONTENT');

    const result = await restorePhysicalBackup({
      backupDir: backup.backupDir,
      databasePath: target.databasePath,
      uploadsDir: target.uploadsDir,
    });

    expect(result.status).toBe('ok');
    expect(readValue(target.databasePath)).toBe('A');

    const health = databaseHealth(target.databasePath);
    expect(health.integrity).toBe('ok');
    expect(health.violations).toBe(0);
  });

  it('restores a backup that contained an empty uploads directory', async () => {
    const target = paths();
    createDatabase(target.databasePath, 'EMPTY-UPLOADS');

    const backup = await createPhysicalBackup({ ...target });
    if (backup.status !== 'ok') throw new Error('backup failed');

    // Live state gains an asset after the backup.
    writeAsset(target.uploadsDir, 'branding/later.bin', 'LATER');

    const result = await restorePhysicalBackup({
      backupDir: backup.backupDir,
      databasePath: target.databasePath,
      uploadsDir: target.uploadsDir,
    });

    expect(result.status).toBe('ok');
    expect(existsSync(join(target.uploadsDir, 'branding'))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Mid-restore failure and rollback                                            */
/* -------------------------------------------------------------------------- */

describe('mid-restore failure', () => {
  /**
   * Inject a failure on the Nth `rename` through the filesystem seam.
   *
   * The rename sequence is: 1 = move live uploads aside, 2 = install restored
   * database, 3 = install restored uploads. Injecting at 2 and 3 exercises a
   * failure after at least one destructive replacement has begun.
   */
  function failingAt(n: number): { ops: RestoreFileOperations; renames: () => number } {
    let count = 0;

    return {
      ops: {
        ...defaultFileOperations,
        rename(from, to) {
          count += 1;

          if (count === n) {
            throw new Error(`injected rename failure #${String(n)}`);
          }

          defaultFileOperations.rename(from, to);
        },
      },
      renames: () => count,
    };
  }

  for (const failAt of [2, 3]) {
    it(`rolls the database and uploads back when rename #${String(failAt)} fails`, async () => {
      const target = establishStateA();
      const backup = await createPhysicalBackup({ ...target });
      if (backup.status !== 'ok') throw new Error('backup failed');

      establishStateB(target);
      const uploadsInB = hashTree(target.uploadsDir);

      const { ops, renames } = failingAt(failAt);

      const result = await restorePhysicalBackup({
        backupDir: backup.backupDir,
        databasePath: target.databasePath,
        uploadsDir: target.uploadsDir,
        ops,
      });

      // Narrow before reading the failure-specific fields.
      if (result.status !== 'failed') throw new Error(`expected failure, got ${result.status}`);

      expect(result.recoveryIncomplete).toBe(false);

      // A destructive replacement genuinely began before the failure.
      expect(renames()).toBeGreaterThanOrEqual(failAt);

      // State B is intact on both resources: no A/B mixture.
      expect(readValue(target.databasePath)).toBe('B');
      expect(hashTree(target.uploadsDir)).toEqual(uploadsInB);
      expect(existsSync(join(target.uploadsDir, 'branding', 'a.bin'))).toBe(false);

      // Rollback output is internally consistent.
      const health = databaseHealth(target.databasePath);
      expect(health.integrity).toBe('ok');
      expect(health.violations).toBe(0);

      // No recovery material is discarded when recovery reported success.
      expect(result.retainedArtifacts).toEqual([]);
    });
  }

  it('cleans up its staging artifacts after a rolled-back failure', async () => {
    const target = establishStateA();
    const backup = await createPhysicalBackup({ ...target });
    if (backup.status !== 'ok') throw new Error('backup failed');

    establishStateB(target);

    const { ops } = failingAt(3);

    await restorePhysicalBackup({
      backupDir: backup.backupDir,
      databasePath: target.databasePath,
      uploadsDir: target.uploadsDir,
      ops,
    });

    const liveEntries = readdirSync(join(root, 'live'));
    expect(liveEntries.filter((name) => name.startsWith('.'))).toEqual([]);
    expect(liveEntries.sort()).toEqual(['nav.sqlite', 'uploads']);
  });

  it('reports incomplete recovery and retains artifacts when rollback cannot finish', async () => {
    const target = establishStateA();
    const backup = await createPhysicalBackup({ ...target });
    if (backup.status !== 'ok') throw new Error('backup failed');

    establishStateB(target);

    // Install the restored uploads (rename #3) normally, then break rollback by
    // failing the recovery rename (#4) as well.
    let count = 0;
    const ops: RestoreFileOperations = {
      ...defaultFileOperations,
      rename(from, to) {
        count += 1;

        if (count === 2) {
          throw new Error('injected install failure');
        }

        if (count === 3) {
          throw new Error('injected recovery failure');
        }

        defaultFileOperations.rename(from, to);
      },
    };

    const result = await restorePhysicalBackup({
      backupDir: backup.backupDir,
      databasePath: target.databasePath,
      uploadsDir: target.uploadsDir,
      ops,
    });

    // Narrowing first so the failure shape is asserted before its fields are read.
    if (result.status !== 'failed') throw new Error(`expected failure, got ${result.status}`);

    // The failure is reported honestly rather than as a clean rollback.
    expect(result.recoveryIncomplete).toBe(true);
    expect(result.message).toContain('recovery incomplete');

    // Recovery material is retained and its location is reported.
    expect(result.retainedArtifacts.length).toBeGreaterThan(0);
    for (const artifact of result.retainedArtifacts) {
      expect(existsSync(artifact)).toBe(true);
    }
  });

  it('restores the same backup successfully once the fault is removed', async () => {
    const target = establishStateA();
    const backup = await createPhysicalBackup({ ...target });
    if (backup.status !== 'ok') throw new Error('backup failed');

    establishStateB(target);

    const { ops } = failingAt(3);
    const failed = await restorePhysicalBackup({
      backupDir: backup.backupDir,
      databasePath: target.databasePath,
      uploadsDir: target.uploadsDir,
      ops,
    });
    expect(failed.status).toBe('failed');

    // No injection: the very same backup now restores State A.
    const succeeded = await restorePhysicalBackup({
      backupDir: backup.backupDir,
      databasePath: target.databasePath,
      uploadsDir: target.uploadsDir,
    });

    expect(succeeded.status).toBe('ok');
    expect(readValue(target.databasePath)).toBe('A');
    expect(readFileSync(join(target.uploadsDir, 'branding', 'a.bin'), 'utf8')).toBe('ASSET-A');
  });

  it('exits with the recovery-incomplete code when rollback cannot finish', async () => {
    // The CLI surfaces exit code 2 for incomplete recovery, which an operator
    // must not confuse with an ordinary refusal.
    expect(EXIT_RECOVERY_INCOMPLETE).toBe(2);
    expect(EXIT_RECOVERY_INCOMPLETE).not.toBe(0);
    expect(EXIT_RECOVERY_INCOMPLETE).not.toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Path isolation                                                              */
/* -------------------------------------------------------------------------- */

describe('path safety', () => {
  it('keeps every operation inside the isolated temporary environment', async () => {
    const target = establishStateA();
    const backup = await createPhysicalBackup({ ...target });
    if (backup.status !== 'ok') throw new Error('backup failed');

    establishStateB(target);
    await restorePhysicalBackup({
      backupDir: backup.backupDir,
      databasePath: target.databasePath,
      uploadsDir: target.uploadsDir,
    });

    // Everything the module touched lives under the temp root, never `data/`.
    expect(resolve(backup.backupDir).startsWith(resolve(root))).toBe(true);
    expect(resolve(target.databasePath).startsWith(resolve(root))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Restore source / live target path overlap (F1)                              */
/* -------------------------------------------------------------------------- */

describe('restore source/target path overlap', () => {
  /**
   * Copy a valid backup to `destination` so the dangerous layout is exercised with
   * a genuinely valid backup rather than a synthetic directory.
   */
  function copyBackup(source: string, destination: string): void {
    defaultFileOperations.copyDirectory(source, destination);
  }

  /** Leftover staging/safety artifacts in the live directory. */
  function transientArtifacts(target: ReturnType<typeof paths>): string[] {
    return readdirSync(join(target.databasePath, '..')).filter((name) => name.startsWith('.restore'));
  }

  /**
   * Assert the restore is refused as a plain preflight failure: nothing in the
   * source or the live state changes, and no recovery artifacts are produced.
   *
   * `uploadsDir` is overridable so a test can express a layout where the live
   * uploads path is not the default one.
   */
  async function expectRejected(
    backupDir: string,
    target: ReturnType<typeof paths>,
    expectedMessage: RegExp,
    uploadsDir: string = target.uploadsDir,
  ): Promise<void> {
    const snapshot = (): Record<string, unknown> => ({
      source: hashTree(backupDir),
      liveDirectory: hashTree(join(target.databasePath, '..')),
      liveUploads: hashTree(uploadsDir),
      liveValue: readValue(target.databasePath),
    });

    const before = snapshot();

    const result = await restorePhysicalBackup({
      backupDir,
      databasePath: target.databasePath,
      uploadsDir,
    });

    expect(result.status).toBe('failed');

    if (result.status !== 'failed') return;

    // An ordinary refusal, not an incomplete recovery: nothing destructive ran.
    expect(result.recoveryIncomplete).toBe(false);
    expect(result.retainedArtifacts).toEqual([]);
    expect(result.message).toMatch(expectedMessage);

    // The backup source is read-only input and must survive intact; live state and
    // the live directory are untouched, with no recovery artifacts left behind.
    expect(snapshot()).toEqual(before);
    expect(transientArtifacts(target)).toEqual([]);
  }

  it('rejects a backup source located inside the live uploads directory', async () => {
    const target = establishStateA();
    const backup = await createPhysicalBackup({ ...target });
    if (backup.status !== 'ok') throw new Error('backup failed');

    establishStateB(target);

    // The dangerous layout from the review: a valid backup copied beneath uploads.
    const nested = join(target.uploadsDir, 'manual-backup');
    copyBackup(backup.backupDir, nested);

    await expectRejected(nested, target, /overlaps the live uploads directory/);

    // The source directory itself still exists with identical contents.
    expect(existsSync(nested)).toBe(true);
  });

  it('rejects a backup source that contains the live uploads directory', async () => {
    const target = establishStateA();
    const backup = await createPhysicalBackup({ ...target });
    if (backup.status !== 'ok') throw new Error('backup failed');

    establishStateB(target);

    // Live uploads is deliberately `<backupDir>/uploads`: the live path restore
    // would move aside is itself inside the backup source. The backup already
    // contains that directory, which is exactly the overlap being tested.
    const nestedUploads = join(backup.backupDir, BACKUP_UPLOADS_DIRNAME);
    expect(existsSync(nestedUploads)).toBe(true);

    await expectRejected(
      backup.backupDir,
      target,
      /overlaps the live uploads directory/,
      nestedUploads,
    );

    // The backup's own uploads directory still exists untouched.
    expect(existsSync(nestedUploads)).toBe(true);
  });

  it('rejects a live database located inside the backup source', async () => {
    const target = establishStateA();
    const backup = await createPhysicalBackup({ ...target });
    if (backup.status !== 'ok') throw new Error('backup failed');

    const innerDatabase = join(backup.backupDir, 'live', 'nav.sqlite');
    createDatabase(innerDatabase, 'INNER');
    writeAsset(target.uploadsDir, 'branding/keep.bin', 'KEEP');

    const sourceBefore = hashTree(backup.backupDir);

    const result = await restorePhysicalBackup({
      backupDir: backup.backupDir,
      databasePath: innerDatabase,
      uploadsDir: target.uploadsDir,
    });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;

    expect(result.message).toMatch(/overlaps the live database/);
    expect(result.recoveryIncomplete).toBe(false);
    expect(hashTree(backup.backupDir)).toEqual(sourceBefore);
  });

  it('rejects a backup source that coincides with any live database sidecar path', async () => {
    const target = establishStateA();
    const backup = await createPhysicalBackup({ ...target });
    if (backup.status !== 'ok') throw new Error('backup failed');

    establishStateB(target);

    for (const suffix of ['-wal', '-shm', '-journal']) {
      // A representative valid backup placed exactly at the sidecar path.
      const sidecarPath = `${target.databasePath}${suffix}`;
      copyBackup(backup.backupDir, sidecarPath);

      await expectRejected(sidecarPath, target, /overlaps a live database sidecar/);
      expect(existsSync(sidecarPath)).toBe(true);

      rmSync(sidecarPath, { recursive: true, force: true });
    }
  });

  it('rejects a backup source equal to the live uploads directory', async () => {
    const target = establishStateA();
    const backup = await createPhysicalBackup({ ...target });
    if (backup.status !== 'ok') throw new Error('backup failed');

    establishStateB(target);

    await expectRejected(target.uploadsDir, target, /overlaps the live uploads directory/);
  });

  it('rejects a backup source inside a live database sidecar directory', async () => {
    const target = establishStateA();
    const backup = await createPhysicalBackup({ ...target });
    if (backup.status !== 'ok') throw new Error('backup failed');

    // A sidecar path used as a directory that contains the backup.
    const insideSidecar = join(`${target.databasePath}-wal`, 'nested-backup');
    copyBackup(backup.backupDir, insideSidecar);

    await expectRejected(insideSidecar, target, /overlaps a live database sidecar/);
    expect(existsSync(insideSidecar)).toBe(true);
  });

  it('rejects the overlap before reading or writing anything', async () => {
    const target = establishStateA();

    // The backup path does not exist at all: a layout rejection must not depend on
    // the directory being readable, which proves the check precedes preflight.
    const missingInsideUploads = join(target.uploadsDir, 'not-created');

    const result = await restorePhysicalBackup({
      backupDir: missingInsideUploads,
      databasePath: target.databasePath,
      uploadsDir: target.uploadsDir,
    });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;

    // Reported as an overlap rather than as a missing directory.
    expect(result.message).toMatch(/overlaps the live uploads directory/);
    expect(readValue(target.databasePath)).toBe('A');
    expect(existsSync(missingInsideUploads)).toBe(false);
  });

  it('still accepts a disjoint sibling backup root', async () => {
    const target = establishStateA();
    const backup = await createPhysicalBackup({ ...target });
    if (backup.status !== 'ok') throw new Error('backup failed');

    establishStateB(target);

    // `/live/backups/backup-*` is a sibling of `/live/uploads`, not inside it.
    const sibling = join(root, 'live', 'backups');
    copyBackup(backup.backupDir, sibling);

    const result = await restorePhysicalBackup({
      backupDir: sibling,
      databasePath: target.databasePath,
      uploadsDir: target.uploadsDir,
    });

    expect(result.status).toBe('ok');
    expect(readValue(target.databasePath)).toBe('A');
  });

  it('still accepts a backup stored outside the live tree entirely', async () => {
    const target = establishStateA();
    const backup = await createPhysicalBackup({ ...target });
    if (backup.status !== 'ok') throw new Error('backup failed');

    establishStateB(target);

    const result = await restorePhysicalBackup({
      backupDir: backup.backupDir,
      databasePath: target.databasePath,
      uploadsDir: target.uploadsDir,
    });

    expect(result.status).toBe('ok');
    expect(readValue(target.databasePath)).toBe('A');
    expect(readFileSync(join(target.uploadsDir, 'branding', 'a.bin'), 'utf8')).toBe('ASSET-A');
  });
});

/* -------------------------------------------------------------------------- */
/* Symlink / junction-aware path safety (F1b)                                  */
/* -------------------------------------------------------------------------- */

/**
 * Create a directory link.
 *
 * Windows directory junctions are used there because ordinary directory symlinks
 * need elevated privileges; both resolve identically through `realpathSync.native`,
 * which is what the production check relies on. Returns `false` when the platform
 * refuses to create one, so the test can skip rather than fail spuriously.
 */
function tryCreateDirectoryLink(target: string, linkPath: string): boolean {
  const type = process.platform === 'win32' ? 'junction' : 'dir';

  try {
    symlinkSync(target, linkPath, type);
    return true;
  } catch {
    return false;
  }
}

describe('restore source/target path overlap through a filesystem alias', () => {
  /** Leftover staging/safety artifacts in the live directory. */
  function transientArtifacts(target: ReturnType<typeof paths>): string[] {
    return readdirSync(join(target.databasePath, '..')).filter((name) => name.startsWith('.restore'));
  }

  it('rejects an external alias that resolves inside the live uploads directory', async () => {
    const target = establishStateA();
    const backup = await createPhysicalBackup({ ...target });
    if (backup.status !== 'ok') throw new Error('backup failed');

    establishStateB(target);

    // A real backup beneath live uploads, reached only through an external alias.
    const realNested = join(target.uploadsDir, 'manual-backup');
    defaultFileOperations.copyDirectory(backup.backupDir, realNested);

    const aliasDir = join(root, 'operator');
    mkdirSync(aliasDir, { recursive: true });
    const alias = join(aliasDir, 'backup-link');

    if (!tryCreateDirectoryLink(realNested, alias)) {
      // Platform cannot create links; the lexical cases still cover that platform.
      return;
    }

    // The guard must be reached through the alias, not the lexical spelling.
    expect(alias.startsWith(target.uploadsDir)).toBe(false);
    expect(realpathSync.native(alias).startsWith(realpathSync.native(target.uploadsDir))).toBe(true);

    const sourceBefore = hashTree(realNested);
    const liveBefore = {
      directory: hashTree(join(target.databasePath, '..')),
      uploads: hashTree(target.uploadsDir),
      value: readValue(target.databasePath),
    };

    const result = await restorePhysicalBackup({
      backupDir: alias,
      databasePath: target.databasePath,
      uploadsDir: target.uploadsDir,
    });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;

    // An ordinary preflight refusal, not an incomplete recovery.
    expect(result.recoveryIncomplete).toBe(false);
    expect(result.retainedArtifacts).toEqual([]);
    expect(result.message).toMatch(/overlaps the live uploads directory/);

    // The real source survives, and the alias still resolves to it.
    expect(existsSync(realNested)).toBe(true);
    expect(hashTree(realNested)).toEqual(sourceBefore);
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(existsSync(realpathSync.native(alias))).toBe(true);

    // Live state untouched, with no recovery material left behind.
    expect(readValue(target.databasePath)).toBe(liveBefore.value);
    expect(hashTree(target.uploadsDir)).toEqual(liveBefore.uploads);
    expect(hashTree(join(target.databasePath, '..'))).toEqual(liveBefore.directory);
    expect(transientArtifacts(target)).toEqual([]);
  });

  it('rejects an external alias that resolves into a live database sidecar path', async () => {
    const target = establishStateA();
    const backup = await createPhysicalBackup({ ...target });
    if (backup.status !== 'ok') throw new Error('backup failed');

    establishStateB(target);

    const sidecarDir = `${target.databasePath}-wal`;
    defaultFileOperations.copyDirectory(backup.backupDir, sidecarDir);

    const aliasDir = join(root, 'operator');
    mkdirSync(aliasDir, { recursive: true });
    const alias = join(aliasDir, 'sidecar-link');

    if (!tryCreateDirectoryLink(sidecarDir, alias)) {
      return;
    }

    const sourceBefore = hashTree(sidecarDir);

    const result = await restorePhysicalBackup({
      backupDir: alias,
      databasePath: target.databasePath,
      uploadsDir: target.uploadsDir,
    });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;

    expect(result.message).toMatch(/overlaps a live database sidecar/);
    expect(result.recoveryIncomplete).toBe(false);
    expect(hashTree(sidecarDir)).toEqual(sourceBefore);
    expect(existsSync(sidecarDir)).toBe(true);
  });

  it('still allows an external alias to a genuinely disjoint backup', async () => {
    const target = establishStateA();
    const backup = await createPhysicalBackup({ ...target });
    if (backup.status !== 'ok') throw new Error('backup failed');

    establishStateB(target);

    const aliasDir = join(root, 'operator');
    mkdirSync(aliasDir, { recursive: true });
    const alias = join(aliasDir, 'good-link');

    if (!tryCreateDirectoryLink(backup.backupDir, alias)) {
      return;
    }

    const sourceBefore = hashTree(backup.backupDir);

    const result = await restorePhysicalBackup({
      backupDir: alias,
      databasePath: target.databasePath,
      uploadsDir: target.uploadsDir,
    });

    // Aliasing a disjoint backup is legitimate and must keep working.
    expect(result.status).toBe('ok');
    expect(readValue(target.databasePath)).toBe('A');
    expect(readFileSync(join(target.uploadsDir, 'branding', 'a.bin'), 'utf8')).toBe('ASSET-A');

    // The source is still intact after a successful restore.
    expect(hashTree(backup.backupDir)).toEqual(sourceBefore);
    expect(transientArtifacts(target)).toEqual([]);
  });

  it('rejects a backup output root aliased into the live uploads directory', async () => {
    const target = establishStateA();

    // A real destination inside live uploads, reached only through an alias.
    const realBackupRoot = join(target.uploadsDir, 'backups');
    mkdirSync(realBackupRoot, { recursive: true });

    const aliasDir = join(root, 'operator');
    mkdirSync(aliasDir, { recursive: true });
    const alias = join(aliasDir, 'backups-link');

    if (!tryCreateDirectoryLink(realBackupRoot, alias)) {
      return;
    }

    expect(alias.startsWith(target.uploadsDir)).toBe(false);
    expect(realpathSync.native(alias).startsWith(realpathSync.native(target.uploadsDir))).toBe(true);

    const result = await createPhysicalBackup({
      databasePath: target.databasePath,
      uploadsDir: target.uploadsDir,
      backupRoot: alias,
      now: new Date('2026-01-02T03:04:05.000Z'),
    });

    // Refused deliberately, before anything is copied into the live uploads tree.
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;

    expect(result.message).toMatch(/must not be inside the uploads directory/);

    // No completed backup and no incomplete artifact was published there.
    const published = readdirSync(realBackupRoot);
    expect(published.filter((name) => name.startsWith('backup-'))).toEqual([]);
    expect(published.filter((name) => name.startsWith('.incomplete-'))).toEqual([]);

    // The live database is untouched by the refusal.
    expect(readValue(target.databasePath)).toBe('A');
  });

  it('still allows a disjoint aliased backup output root', async () => {
    const target = establishStateA();

    const realBackupRoot = join(root, 'external-backups');
    mkdirSync(realBackupRoot, { recursive: true });

    const aliasDir = join(root, 'operator');
    mkdirSync(aliasDir, { recursive: true });
    const alias = join(aliasDir, 'good-backups-link');

    if (!tryCreateDirectoryLink(realBackupRoot, alias)) {
      return;
    }

    const result = await createPhysicalBackup({
      databasePath: target.databasePath,
      uploadsDir: target.uploadsDir,
      backupRoot: alias,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    // Written through to the real directory, not into the uploads tree.
    expect(existsSync(join(realBackupRoot, result.backupDir.slice(result.backupDir.lastIndexOf('backup-')))))
      .toBe(true);
  });

  it('rejects an aliased source whose target is not a valid backup', async () => {
    // Guards the ordering requirement: the layout check is a preflight decision
    // reached before the backup contents are validated, so an alias into the live
    // tree is rejected as an overlap rather than as an unreadable backup.
    const target = establishStateA();

    // An existing directory inside uploads that is deliberately not a backup.
    const insideUploads = join(target.uploadsDir, 'not-a-backup');
    mkdirSync(insideUploads, { recursive: true });
    writeFileSync(join(insideUploads, 'random.txt'), 'not a backup');

    const aliasDir = join(root, 'operator');
    mkdirSync(aliasDir, { recursive: true });
    const alias = join(aliasDir, 'alias-to-invalid');

    if (!tryCreateDirectoryLink(insideUploads, alias)) {
      return;
    }

    const result = await restorePhysicalBackup({
      backupDir: alias,
      databasePath: target.databasePath,
      uploadsDir: target.uploadsDir,
    });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;

    // Reported as a path overlap, not as a missing/invalid backup: the layout check
    // must run first.
    expect(result.message).toMatch(/overlaps the live uploads directory/);
    expect(result.message).not.toMatch(/not found|missing|manifest/);
    expect(readValue(target.databasePath)).toBe('A');
    expect(existsSync(insideUploads)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Live database / uploads layout safety (F1c)                                 */
/* -------------------------------------------------------------------------- */

/**
 * Restore places database staging and safety files beside the live database, then
 * moves the whole uploads directory aside. A database inside the uploads tree
 * therefore gets relocated by the uploads swap, so that layout is rejected.
 */
describe('live database / uploads layout safety', () => {
  /** A backup created from a genuinely safe layout, usable as restore input. */
  async function disjointBackup(): Promise<string> {
    const safeRoot = join(root, 'safe');
    const databasePath = join(safeRoot, 'nav.sqlite');
    const uploadsDir = join(safeRoot, 'uploads');

    createDatabase(databasePath, 'SAFE');
    writeAsset(uploadsDir, 'branding/safe.bin', 'SAFE-ASSET');

    const backup = await createPhysicalBackup({ databasePath, uploadsDir, backupRoot: join(root, 'backups') });
    if (backup.status !== 'ok') throw new Error('backup setup failed');

    return backup.backupDir;
  }

  /** Leftover restore/backup artifacts in a directory. */
  function leftovers(dir: string): string[] {
    try {
      return readdirSync(dir).filter((name) => name.startsWith('.restore') || name.startsWith('.incomplete-'));
    } catch {
      return [];
    }
  }

  /**
   * Assert both commands refuse the layout, change nothing, and leave no artifacts.
   */
  async function expectUnsafeLayoutRejected(
    databasePath: string,
    uploadsDir: string,
    backupRoot: string,
  ): Promise<void> {
    const backupDir = await disjointBackup();

    const databaseExisted = existsSync(databasePath);
    const databaseBefore = databaseExisted ? readValue(databasePath) : null;
    const uploadsBefore = hashTree(uploadsDir);
    const backupBefore = hashTree(backupDir);

    const restore = await restorePhysicalBackup({ backupDir, databasePath, uploadsDir });

    expect(restore.status).toBe('failed');
    if (restore.status !== 'failed') return;

    // Ordinary preflight refusal, not a damaged recovery.
    expect(restore.recoveryIncomplete).toBe(false);
    expect(restore.retainedArtifacts).toEqual([]);
    expect(restore.message).toMatch(/database must not be located inside the uploads directory/);

    // Nothing changed anywhere.
    expect(databaseExisted ? existsSync(databasePath) : !existsSync(databasePath)).toBe(true);
    if (databaseExisted) {
      expect(readValue(databasePath)).toBe(databaseBefore);
    }
    expect(hashTree(uploadsDir)).toEqual(uploadsBefore);
    expect(hashTree(backupDir)).toEqual(backupBefore);
    expect(leftovers(dirname(databasePath))).toEqual([]);
    expect(leftovers(dirname(uploadsDir))).toEqual([]);

    // The backup command refuses the same layout.
    const created = await createPhysicalBackup({ databasePath, uploadsDir, backupRoot });

    expect(created.status).toBe('failed');
    if (created.status !== 'failed') return;

    expect(created.message).toMatch(/database must not be located inside the uploads directory/);
    // No completed backup and no incomplete directory was published.
    const published = existsSync(backupRoot) ? readdirSync(backupRoot) : [];
    expect(published.filter((name) => name.startsWith('backup-'))).toEqual([]);
    expect(published.filter((name) => name.startsWith('.incomplete-'))).toEqual([]);

    // Live state is still untouched after the refused backup.
    expect(hashTree(uploadsDir)).toEqual(uploadsBefore);
    if (databaseExisted) {
      expect(readValue(databasePath)).toBe(databaseBefore);
    }
  }

  it('rejects a database located directly inside the uploads directory', async () => {
    const uploadsDir = join(root, 'case-a', 'uploads');
    const databasePath = join(uploadsDir, 'nav.sqlite');

    createDatabase(databasePath, 'B');
    writeAsset(uploadsDir, 'branding/a.bin', 'ASSET-A');

    await expectUnsafeLayoutRejected(databasePath, uploadsDir, join(root, 'bk-a'));
  });

  it('rejects a database nested deeper inside the uploads directory', async () => {
    const uploadsDir = join(root, 'case-b', 'uploads');
    const databasePath = join(uploadsDir, 'db', 'nav.sqlite');

    createDatabase(databasePath, 'B');
    writeAsset(uploadsDir, 'branding/b.bin', 'ASSET-B');

    await expectUnsafeLayoutRejected(databasePath, uploadsDir, join(root, 'bk-b'));
  });

  it('rejects a missing database whose parent is inside the uploads directory', async () => {
    const uploadsDir = join(root, 'case-c', 'uploads');
    const databasePath = join(uploadsDir, 'db', 'nav.sqlite');

    // The database does not exist yet: the layout check must not depend on it.
    mkdirSync(uploadsDir, { recursive: true });
    writeAsset(uploadsDir, 'branding/c.bin', 'ASSET-C');
    expect(existsSync(databasePath)).toBe(false);

    await expectUnsafeLayoutRejected(databasePath, uploadsDir, join(root, 'bk-c'));

    // And it stays absent.
    expect(existsSync(databasePath)).toBe(false);
  });

  it('rejects a database reached through a directory alias that resolves inside uploads', async () => {
    const uploadsDir = join(root, 'case-d', 'uploads');
    const realDatabaseDir = join(uploadsDir, 'db');
    const realDatabasePath = join(realDatabaseDir, 'nav.sqlite');

    createDatabase(realDatabasePath, 'B');
    writeAsset(uploadsDir, 'branding/d.bin', 'ASSET-D');

    const aliasDir = join(root, 'operator', 'db-link');
    mkdirSync(join(root, 'operator'), { recursive: true });

    if (!tryCreateDirectoryLink(realDatabaseDir, aliasDir)) {
      return;
    }

    const aliasedDatabase = join(aliasDir, 'nav.sqlite');

    // Lexically outside the uploads tree, but the real directory is inside it.
    expect(aliasedDatabase.startsWith(uploadsDir)).toBe(false);
    expect(realpathSync.native(aliasDir).startsWith(realpathSync.native(uploadsDir))).toBe(true);

    const aliasBefore = hashTree(realDatabaseDir);

    const backupDir = await disjointBackup();
    const restore = await restorePhysicalBackup({
      backupDir,
      databasePath: aliasedDatabase,
      uploadsDir,
    });

    expect(restore.status).toBe('failed');
    if (restore.status !== 'failed') return;

    expect(restore.message).toMatch(/database must not be located inside the uploads directory/);
    expect(restore.recoveryIncomplete).toBe(false);
    expect(hashTree(realDatabaseDir)).toEqual(aliasBefore);

    const created = await createPhysicalBackup({
      databasePath: aliasedDatabase,
      uploadsDir,
      backupRoot: join(root, 'bk-d'),
    });
    expect(created.status).toBe('failed');
    expect(hashTree(realDatabaseDir)).toEqual(aliasBefore);
  });

  it('still accepts the normal sibling layout with uploads beneath the database parent', async () => {
    const liveDir = join(root, 'case-e');
    const databasePath = join(liveDir, 'nav.sqlite');
    const uploadsDir = join(liveDir, 'uploads');

    createDatabase(databasePath, 'A');
    writeAsset(uploadsDir, 'branding/e.bin', 'ASSET-E');

    // `dirname(databasePath)` contains `uploadsDir`. That is the standard deployment
    // shape and must stay valid: the rule is directional, not symmetric.
    const backup = await createPhysicalBackup({ databasePath, uploadsDir, backupRoot: join(root, 'bk-e') });
    expect(backup.status).toBe('ok');
    if (backup.status !== 'ok') return;

    const restore = await restorePhysicalBackup({ backupDir: backup.backupDir, databasePath, uploadsDir });
    expect(restore.status).toBe('ok');
    expect(readValue(databasePath)).toBe('A');
    expect(existsSync(join(uploadsDir, 'branding', 'e.bin'))).toBe(true);
  });

  it('still accepts a deeper database parent that is a sibling of uploads', async () => {
    const liveDir = join(root, 'case-f');
    const databasePath = join(liveDir, 'db', 'nav.sqlite');
    const uploadsDir = join(liveDir, 'uploads');

    createDatabase(databasePath, 'A');
    writeAsset(uploadsDir, 'branding/f.bin', 'ASSET-F');

    const backup = await createPhysicalBackup({ databasePath, uploadsDir, backupRoot: join(root, 'bk-f') });
    expect(backup.status).toBe('ok');
    if (backup.status !== 'ok') return;

    const restore = await restorePhysicalBackup({ backupDir: backup.backupDir, databasePath, uploadsDir });
    expect(restore.status).toBe('ok');
    expect(readValue(databasePath)).toBe('A');
  });

  it('rejects the unsafe layout even when the uploads directory does not exist yet', async () => {
    // A valid installation may have no uploads directory at all, yet the database
    // path is still destined for inside it. The layout check must not require the
    // uploads directory (or the database) to exist.
    const uploadsDir = join(root, 'case-g', 'uploads');
    const databasePath = join(uploadsDir, 'db', 'nav.sqlite');

    createDatabase(databasePath, 'B');

    // Remove only the uploads tree's non-database content, keeping the database in
    // place, so the layout stays unsafe while `uploadsDir` itself is absent.
    rmSync(join(uploadsDir, 'db', 'nav.sqlite'), { force: true });
    rmSync(join(uploadsDir, 'db'), { recursive: true, force: true });
    rmSync(uploadsDir, { recursive: true, force: true });
    expect(existsSync(uploadsDir)).toBe(false);

    const backupDir = await disjointBackup();
    const restore = await restorePhysicalBackup({ backupDir, databasePath, uploadsDir });

    expect(restore.status).toBe('failed');
    if (restore.status !== 'failed') return;

    expect(restore.message).toMatch(/database must not be located inside the uploads directory/);
    // The database stays absent and no uploads directory is created.
    expect(existsSync(databasePath)).toBe(false);
    expect(existsSync(uploadsDir)).toBe(false);
  });
});
