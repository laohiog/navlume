import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { RuntimeConfigError, type RuntimeConfig } from './runtime-config.js';

// Kept outside branding/, which is the only public asset directory. The existing
// physical backup copies the complete uploads tree, including this private file.
export const AUTH_SECRET_FILENAME = '.auth-secret';

function readSecret(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new RuntimeConfigError('Cannot open persisted auth secret');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
      throw new RuntimeConfigError('Persisted auth secret must be a private regular file (mode 0600)');
    }
    const value = readFileSync(fd, 'utf8').trim();
    if (value.length < 32) throw new RuntimeConfigError('Persisted auth secret is invalid; restore it, do not regenerate it');
    return value;
  } finally {
    closeSync(fd);
  }
}

export function resolveAuthSecret(config: RuntimeConfig, provisioned: boolean): string {
  if (!config.lanHttp) return config.authSecret;
  mkdirSync(config.uploadsDir, { recursive: true });
  const path = join(config.uploadsDir, AUTH_SECRET_FILENAME);
  const existing = readSecret(path);
  if (existing !== undefined) {
    if (config.authSecret !== '' && config.authSecret !== existing) {
      throw new RuntimeConfigError('BETTER_AUTH_SECRET differs from persisted auth secret');
    }
    return existing;
  }
  if (provisioned && config.authSecret === '') {
    throw new RuntimeConfigError('Existing users or completed initialization but no auth secret: restore the original secret or supply BETTER_AUTH_SECRET');
  }
  const value = config.authSecret || randomBytes(48).toString('base64url');
  const temporary = join(config.uploadsDir, `.auth-secret-${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, value + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    try {
      // Publishing a complete file with an exclusive hard link is atomic even
      // if two cold-start processes race; never overwrite the winning secret.
      linkSync(temporary, path);
      if (process.platform !== 'win32') {
        const directory = openSync(config.uploadsDir, 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    unlinkSync(temporary);
  }
  const persisted = readSecret(path);
  if (persisted === undefined || (config.authSecret !== '' && config.authSecret !== persisted)) {
    throw new RuntimeConfigError('Cannot persist the configured auth secret');
  }
  return persisted;
}
