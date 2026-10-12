/**
 * `npm run restore` — operator entry point for a physical restore (P6.2).
 *
 * Usage:
 *
 *     npm run restore -- --app-stopped --confirm-restore --backup <dir>
 *                       [--database <path>] [--uploads <path>]
 *
 * Both acknowledgements are mandatory:
 *
 *  - `--app-stopped`      the application is stopped (see the contract below)
 *  - `--confirm-restore`  the operator accepts that live data is replaced
 *
 * Requiring explicit flags rather than an interactive prompt keeps the command
 * deterministic for server/automation use. When either flag is missing the command
 * exits non-zero and changes nothing.
 */

import { pathToFileURL } from 'node:url';

import { restorePhysicalBackup } from './backup-restore.js';
import {
  APP_STOPPED_FLAG,
  CONFIRM_RESTORE_FLAG,
  parseArguments,
  report,
  reportError,
  requireAppStopped,
  resolveLivePaths,
} from './backup-cli.js';

/** Exit code used when rollback could not fully recover the previous state. */
export const EXIT_RECOVERY_INCOMPLETE = 2;

/**
 * Run the restore command.
 *
 * Returns a process exit code so tests can exercise the exact CLI behavior without
 * spawning a child process. `2` specifically means "the restore failed *and* the
 * previous state could not be fully recovered", which an operator must not confuse
 * with an ordinary refusal.
 */
export async function runRestore(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const args = parseArguments(argv);

  if (!requireAppStopped(args, 'restore')) {
    return 1;
  }

  if (!args.flags.has(CONFIRM_RESTORE_FLAG)) {
    reportError(
      `restore refused: this replaces the live database and uploads. ` +
        `Re-run with ${CONFIRM_RESTORE_FLAG} to confirm.`,
    );
    return 1;
  }

  const backupDir = args.values.get('--backup');

  if (backupDir === undefined) {
    reportError('restore refused: --backup <dir> is required.');
    return 1;
  }

  const { databasePath, uploadsDir } = resolveLivePaths(args, env);

  report(`backup source:   ${backupDir}`);
  report(`target database: ${databasePath}`);
  report(`target uploads:  ${uploadsDir}`);

  const result = await restorePhysicalBackup({ backupDir, databasePath, uploadsDir });

  if (result.status === 'failed') {
    reportError(result.message);

    if (result.recoveryIncomplete) {
      reportError('recovery is incomplete; the following artifacts were retained for manual recovery:');
      for (const artifact of result.retainedArtifacts) {
        reportError(`  ${artifact}`);
      }

      return EXIT_RECOVERY_INCOMPLETE;
    }

    return 1;
  }

  report(`restored from ${result.restoredFrom}`);
  report(`  database: ${result.databasePath}`);
  report(`  uploads:  ${result.uploadsDir}`);
  report('restore complete: restart the application to serve the restored state.');

  return 0;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  const missingAcknowledgements = [APP_STOPPED_FLAG, CONFIRM_RESTORE_FLAG].filter(
    (flag) => !process.argv.includes(flag),
  );

  if (missingAcknowledgements.length > 0 || !process.argv.includes('--backup')) {
    reportError(
      `usage: npm run restore -- ${APP_STOPPED_FLAG} ${CONFIRM_RESTORE_FLAG} --backup <dir> ` +
        '[--database <path>] [--uploads <path>]',
    );
  }

  process.exitCode = await runRestore(process.argv.slice(2));
}
