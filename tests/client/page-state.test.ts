import { describe, expect, it } from 'vitest';

import {
  ADMIN_HASH,
  HOME_HASH,
  SETTINGS_HASH,
  hashFromPage,
  pageFromHash,
  resolveEffectivePage,
  type Page,
} from '../../src/client/page-state.js';

describe('pageFromHash', () => {
  it('selects Admin only for the exact admin hash', () => {
    expect(pageFromHash(ADMIN_HASH)).toBe('admin');
  });

  it('selects Settings only for its exact hash', () => {
    expect(pageFromHash(SETTINGS_HASH)).toBe('settings');
    expect(pageFromHash('#SETTINGS')).toBe('home');
    expect(pageFromHash('#settings/other')).toBe('home');
  });

  it('maps empty, #home and unknown hashes to Home', () => {
    for (const hash of ['', '#', HOME_HASH, '#adminx', '#ADMIN', '#other']) {
      expect(pageFromHash(hash), hash).toBe('home');
    }
  });
});

describe('hashFromPage', () => {
  it('writes the admin hash for Admin', () => {
    expect(hashFromPage('admin')).toBe(ADMIN_HASH);
  });

  it('writes the home hash for Home', () => {
    expect(hashFromPage('home')).toBe(HOME_HASH);
  });

  it('writes the settings hash for Settings', () => {
    expect(hashFromPage('settings')).toBe(SETTINGS_HASH);
  });
});

describe('resolveEffectivePage', () => {
  const guest = { isAuthenticated: false, isAdmin: false, isSessionPending: false };
  const user = { ...guest, isAuthenticated: true };
  const admin = { ...user, isAdmin: true };

  it('lets an admin resolve the admin page', () => {
    expect(resolveEffectivePage('admin', admin)).toBe('admin');
  });

  it('falls back to Home for a non-admin on the admin page (forged or stale hash)', () => {
    expect(resolveEffectivePage('admin', user)).toBe('home');
    expect(resolveEffectivePage('admin', guest)).toBe('home');
  });

  it('keeps Home for everyone else', () => {
    for (const access of [guest, user, admin]) {
      expect(resolveEffectivePage('home', access)).toBe('home');
    }
  });

  it('allows Settings for either signed-in role and rejects guests', () => {
    expect(resolveEffectivePage('settings', guest)).toBe('home');
    expect(resolveEffectivePage('settings', user)).toBe('settings');
    expect(resolveEffectivePage('settings', admin)).toBe('settings');
  });

  it.each<Page>(['admin', 'settings'])('never exposes %s while the session is pending', (page) => {
    for (const access of [guest, user, admin]) {
      expect(resolveEffectivePage(page, { ...access, isSessionPending: true })).toBe('home');
    }
  });

  it('drops protected pages when logout removes authentication, even with a stale admin flag', () => {
    for (const page of ['admin', 'settings'] as const) {
      expect(resolveEffectivePage(page, { ...guest, isAdmin: true })).toBe('home');
    }
  });
});
