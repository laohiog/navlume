import type { DatabaseHandle } from '../db/index.js';

// Internal instance state in the existing verification table, independent of
// user deletion. The far-future expiry keeps Better Auth cleanup from removing it.
export const INITIALIZATION_CLOSED_ID = 'navlume:initialization-completed';

export function markInitializationComplete(handle: DatabaseHandle): void {
  handle.sqlite.prepare(`INSERT OR IGNORE INTO verification
    (id, identifier, value, expires_at) VALUES (?, ?, 'closed', ?)`).run(
    INITIALIZATION_CLOSED_ID, INITIALIZATION_CLOSED_ID, Date.parse('9999-12-31T23:59:59Z'),
  );
}

/** Adopt existing instances without schema changes; physical backups carry the marker. */
export function isInitializationClosed(handle: DatabaseHandle): boolean {
  if (handle.sqlite.prepare('SELECT 1 FROM verification WHERE id = ?').get(INITIALIZATION_CLOSED_ID)) return true;
  if (handle.sqlite.prepare('SELECT 1 FROM user LIMIT 1').get()) {
    markInitializationComplete(handle);
    return true;
  }
  return false;
}
