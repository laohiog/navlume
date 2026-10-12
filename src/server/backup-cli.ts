/**
 * Shared operator-interface helpers for the physical backup and restore commands
 * (P6.2).
 *
 * Deliberately small: manual argument parsing, no CLI framework dependency, and one
 * place where both commands interpret the live paths and the `--app-stopped`
 * acknowledgement identically.
 */

import { resolve } from 'node:path';

/** Repository-local fallbacks, mirroring `src/db/index.ts` and `src/server/branding.ts`. */
export const DEFAULT_DATABASE_PATH = 'data/nav.sqlite';
export const DEFAULT_UPLOADS_DIR = 'data/uploads';

/** Default destination root for created backups. */
export const DEFAULT_BACKUP_ROOT = 'data/backups';

/** The environment variables the application itself reads. */
export const DATABASE_PATH_ENV = 'DATABASE_PATH';
export const UPLOADS_DIR_ENV = 'UPLOADS_DIR';

/**
 * The explicit operator acknowledgement that the application is stopped.
 *
 * A statement of intent, not a verified fact. No cross-platform process detection
 * is attempted: a wrong detector would be worse than an honest contract, and the
 * documentation says so plainly.
 */
export const APP_STOPPED_FLAG = '--app-stopped';

/** Restore-only acknowledgement of the destructive replacement. */
export const CONFIRM_RESTORE_FLAG = '--confirm-restore';

export interface ParsedArguments {
  flags: Set<string>;
  values: Map<string, string>;
}

/**
 * Parse `--flag` and `--key value` arguments.
 *
 * A `--key` followed by a non-flag token consumes it; anything else is boolean.
 * Minimal by design rather than a general option parser.
 */
export function parseArguments(argv: readonly string[]): ParsedArguments {
  const flags = new Set<string>();
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === undefined || !token.startsWith('--')) {
      continue;
    }

    const next = argv[index + 1];

    if (next !== undefined && !next.startsWith('--')) {
      values.set(token, next);
      index += 1;
    } else {
      flags.add(token);
    }
  }

  return { flags, values };
}

export interface ResolvedPaths {
  databasePath: string;
  uploadsDir: string;
}

/**
 * Resolve the live database and uploads locations.
 *
 * Command-line values win, then the environment variables the application reads,
 * then the repository-local defaults. No `/data` path is hard-coded: P6.3 maps
 * these to persistent storage in the container.
 */
export function resolveLivePaths(
  args: ParsedArguments,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedPaths {
  const databasePath =
    args.values.get('--database') ?? nonEmpty(env[DATABASE_PATH_ENV]) ?? DEFAULT_DATABASE_PATH;

  const uploadsDir = args.values.get('--uploads') ?? nonEmpty(env[UPLOADS_DIR_ENV]) ?? DEFAULT_UPLOADS_DIR;

  return { databasePath: resolve(databasePath), uploadsDir: resolve(uploadsDir) };
}

/** Trimmed value, or `undefined` when absent or empty. */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/** Resolve the backup destination root (backup command only). */
export function resolveBackupRoot(
  args: ParsedArguments,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = args.values.get('--output') ?? nonEmpty(env['BACKUP_DIR']);
  return resolve(configured ?? DEFAULT_BACKUP_ROOT);
}

/** Write an operator-facing message to stdout. */
export function report(message: string): void {
  process.stdout.write(`[backup] ${message}\n`);
}

/** Write an operator-facing error to stderr. */
export function reportError(message: string): void {
  process.stderr.write(`[backup] error: ${message}\n`);
}

/**
 * Refuse to proceed unless the operator acknowledged the application is stopped.
 *
 * Returns `true` when the operation may continue. When the flag is absent, both
 * callers exit before touching any state, so a mistaken invocation cannot change
 * anything.
 */
export function requireAppStopped(args: ParsedArguments, command: string): boolean {
  if (args.flags.has(APP_STOPPED_FLAG)) {
    return true;
  }

  reportError(
    `${command} refused: the application must be stopped first. ` +
      `Re-run with ${APP_STOPPED_FLAG} to acknowledge that it is stopped. ` +
      'That flag is an acknowledgement, not an automatic check.',
  );

  return false;
}
