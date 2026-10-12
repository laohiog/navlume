/**
 * `npm run backup` — operator entry point for a physical backup (P6.2).
 *
 * Usage:
 *
 *     npm run backup -- --app-stopped [--output <dir>]
 *                     [--database <path>] [--uploads <path>]
 *
 * The command refuses to run without `--app-stopped` and changes nothing when it
 * refuses. See `docs/BACKUP_RESTORE.md` for the operational contract.
 */

import { pathToFileURL } from 'node:url';

import { createPhysicalBackup } from './backup-restore.js';
import {
  APP_STOPPED_FLAG,
  parseArguments,
  report,
  reportError,
  requireAppStopped,
  resolveBackupRoot,
  resolveLivePaths,
} from './backup-cli.js';

/**
 * Run the backup command.
 *
 * Returns a process exit code so tests can exercise the exact CLI behavior without
 * spawning a child process.
 */
export async function runBackup(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const args = parseArguments(argv);

  if (!requireAppStopped(args, 'backup')) {
    return 1;
  }

  const { databasePath, uploadsDir } = resolveLivePaths(args, env);
  const backupRoot = resolveBackupRoot(args, env);

  report(`source database: ${databasePath}`);
  report(`source uploads:  ${uploadsDir}`);
  report(`output root:     ${backupRoot}`);

  const result = await createPhysicalBackup({ databasePath, uploadsDir, backupRoot });

  if (result.status === 'failed') {
    reportError(result.message);
    return 1;
  }

  const { manifest } = result;

  report(`created ${result.backupDir}`);
  report(`  format_version: ${String(manifest.format_version)}`);
  report(`  created_at:     ${manifest.created_at}`);
  report(`  database:       ${manifest.database}`);
  report(`  uploads:        ${manifest.uploads}`);
  report(`backup verified: integrity_check = ok, foreign_key_check = clean`);

  return 0;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  // The acknowledgement flag is included in the usage hint so a mistaken run is
  // self-correcting.
  if (!process.argv.includes(APP_STOPPED_FLAG)) {
    reportError(
      `usage: npm run backup -- ${APP_STOPPED_FLAG} [--output <dir>] [--database <path>] [--uploads <path>]`,
    );
  }

  process.exitCode = await runBackup(process.argv.slice(2));
}
