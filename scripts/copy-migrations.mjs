/**
 * Copy Drizzle migration files into the compiled server output (P6.3).
 *
 * `src/db/migrate.ts` resolves migrations relative to its own module URL, so once
 * it is compiled to `dist/server/db/migrate.js` the SQL files must sit alongside it
 * at `dist/server/db/migrations/`. TypeScript does not emit non-JS assets, so this
 * small standard-library copy step closes that gap without adding a build
 * dependency.
 *
 * Usage: `node scripts/copy-migrations.mjs`
 */

import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(repositoryRoot, 'src', 'db', 'migrations');
const targetDir = join(repositoryRoot, 'dist', 'server', 'db', 'migrations');

if (!existsSync(sourceDir)) {
  console.error(`[build] migration source directory not found: ${sourceDir}`);
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true });

const copied = readdirSync(targetDir).length;
console.log(`[build] copied ${String(copied)} migration entr(ies) to dist/server/db/migrations`);
