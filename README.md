# Navlume

A lightweight, self-hosted, brandable URL navigation platform.

**Simple · Brandable · Self-hosted · Portable · Fast**

Navlume provides public navigation, per-user navigation, search, quick URL adding,
administrator controls and instance branding. Personal navigation is stored on
the server and available when the same user signs in on another device. JSON
import/export and physical SQLite plus uploads backup support portability and
recovery.

Each deployment owns its own database, users, navigation and brand assets.
This is a single-instance, multi-brandable application. Branding is configured
inside each instance; existing brand settings and demo defaults are retained.

## Release availability

This source Candidate prepares the first Navlume public release. The planned
repository is `laohiog/navlume`, and the planned image is `ghcr.io/laohiog/navlume`.
The repository and image are not advertised as available yet. Wait for a maintainer
release announcement before downloading from those targets or pulling an image.

No Git history or runtime data is needed to install this source snapshot.

## Environment

| Layer | Technology |
| --- | --- |
| Runtime | Node.js 24, TypeScript 5 |
| Server | Hono |
| Client | React 19, Vite |
| Database | SQLite, better-sqlite3, Drizzle ORM |
| Authentication | Better Auth 1.7.4 (pinned) |
| Packaging | npm, one Docker application container |

One repository, one application, one database, same-origin frontend and API.
The prebuilt installation target is Linux AMD64/x86-64 with Docker and Compose.
ARM64 and real NAS hardware are unverified.

## Docker installation

For installation without Node.js or a source build, see the
[Linux/NAS installation guide](./docs/INSTALL.md). It uses `compose.install.yml`
and `.env.install.example`. Supply the maintainer's published fixed version or
registry Digest after release; the example image reference is a placeholder.

To build this source Candidate locally, create `.env` beside `compose.yml`:

```dotenv
BETTER_AUTH_SECRET=<generate-with-openssl-rand-base64-32>
BETTER_AUTH_URL=http://localhost:3000
```

Replace the secret placeholder, then run:

```bash
docker compose build
docker compose up -d
docker compose ps
curl http://localhost:3000/api/health
```

The application applies migrations before serving requests. A fresh installation
has no default account or demo navigation. Public sign-up is disabled.

Create the first administrator once from a Bash terminal, using your own email:

```bash
read -r -s -p 'First administrator password: ' BOOTSTRAP_ADMIN_PASSWORD; printf '\n'
export BOOTSTRAP_ADMIN_PASSWORD
docker compose run --rm -T \
  -e BOOTSTRAP_ADMIN_USERNAME=admin \
  -e BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
  -e BOOTSTRAP_ADMIN_PASSWORD \
  app node dist/server/server/bootstrap-admin.js
unset BOOTSTRAP_ADMIN_PASSWORD
```

Open `http://localhost:3000`, sign in and create ordinary users in the admin UI.
For NAS, LAN or any non-localhost installation, use an existing HTTPS proxy and
set `BETTER_AUTH_URL` to the exact browser-visible HTTPS origin. Authentication
cookies stay `Secure` in production. See [Deployment](./docs/DEPLOYMENT.md).

## Data and backup

The `navigation-data` volume contains `/data/nav.sqlite` and `/data/uploads`.
Keep the same Compose project and volume when upgrading. `docker compose down`
preserves the volume; `docker compose down -v` deletes it.

Stop the application before a physical backup or restore. Store an off-volume
backup and keep the authentication secret separately. Restore replaces the
database and uploads. See [Backup & Restore](./docs/BACKUP_RESTORE.md) and the
installation guide for commands. JSON exports cover navigation content and do
not replace a full-instance backup.

## Development and checks

Use Node.js 24 and npm. Copy `.env.example` to `.env`; the development origin is
`http://localhost:5173`. Install from the lockfile:

```bash
npm ci
npm run db:migrate
npm run admin:create    # provide one-shot BOOTSTRAP_ADMIN_* variables
npm run dev
```

`npm run db:seed` optionally inserts generic demo content in an empty development
database. Production startup never seeds it.

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm start
```

## Documentation

- [Docker installation](./docs/INSTALL.md)
- [Deployment and image distribution](./docs/DEPLOYMENT.md)
- [Physical backup and restore](./docs/BACKUP_RESTORE.md)
- [Product](./docs/PRODUCT.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Data model](./docs/DATA_MODEL.md)
- [Security reporting](./SECURITY.md)

## License

MIT. See [LICENSE](./LICENSE) for the existing copyright notice and terms.
Third-party dependencies retain their own licenses.
