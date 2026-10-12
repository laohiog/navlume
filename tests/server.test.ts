import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/server/app.js';
import { createTempDatabase, type TempDatabase } from './helpers/temp-database.js';

let temp: TempDatabase;

beforeEach(() => {
  temp = createTempDatabase();
});

afterEach(() => {
  temp.dispose();
});

describe('server scaffold', () => {
  it('responds 404 with a JSON body for unhandled routes', async () => {
    const app = createApp({ db: temp.handle.db, auth: temp.auth });
    const response = await app.request('/');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Not Found' });
  });
});
