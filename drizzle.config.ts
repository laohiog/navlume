import { defineConfig } from 'drizzle-kit';

const databasePath = process.env.DATABASE_PATH?.trim();

export default defineConfig({
  dialect: 'sqlite',
  schema: ['./src/db/schema.ts', './src/db/auth-schema.ts'],
  out: './src/db/migrations',
  dbCredentials: {
    url: databasePath !== undefined && databasePath.length > 0 ? databasePath : 'data/nav.sqlite',
  },
  strict: true,
  verbose: true,
});
