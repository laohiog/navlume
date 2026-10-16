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

Source repository: [laohiog/navlume](https://github.com/laohiog/navlume).
The latest published release is [v0.1.2](https://github.com/laohiog/navlume/releases/tag/v0.1.2).
This working tree prepares **v0.1.3 — version and documentation approved, not yet published**.
Its installation templates use this already published and verified image:

```text
ghcr.io/laohiog/navlume@sha256:81081c094488af19bda6fa1d0b37a582c76053084ce9410d358f15efe70af857
```

Runtime source is `361aaa6439ba16e3579d097629ac75fe2df4fc91`; the separate
release-documentation commit is recorded in the accompanying `RELEASE-IDENTITY.json`.
The `v0.1.3` tag and GitHub Release have not been created. Documentation changes
do not rebuild the image or change its OCI revision. Release attachment inputs
record these identities separately; `SHA256SUMS` is calculated from their actual
bytes. Publication requires separate authorization; no v0.1.3 download URL is available yet.

v0.1.3 adds floating category selection and back-to-top on long navigation
pages, plus top/bottom/specific-position moves for personal and Admin public links.
Existing ↑/↓ controls and **＋ 添加网址 → Clipboard or manual paste → Save** remain.
There are no API, authentication, schema, dependency or installation-mode changes.

**Historical v0.1.2 identity:** runtime source
`3a9ad4c716b0f961dd089969c387603e4e631576`, image
`ghcr.io/laohiog/navlume@sha256:f1178e3a8954c00e56e5c178006224d3421ee93b739a2d71025a1a71bb80be4d`.
Its release tag points to documentation commit
`fd97f3c6d0f04f5c0e91e99bc9ad27003f16d087`. Keep using the original release
attachments for that historical version; do not mix their image references with
v0.1.3.

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

The single-file [LAN Compose](./compose.lan.yml) supports explicit private IPv4 HTTP,
browser setup without a log code, and an automatically persisted authentication
key. Its image is pinned to the verified Registry Digest above. For a fresh
installation, change the two NAS IP values and, if needed, the host port.
HTTP provides no transport encryption; use a trusted LAN and firewall restrictions.
Complete administrator setup promptly to prevent someone else claiming the instance.
See the LAN section in [INSTALL.md](./docs/INSTALL.md). Standard HTTPS
installation remains the default and retains its code and Secure cookies.

For installation without Node.js or a source build, see the
[Linux/NAS installation guide](./docs/INSTALL.md). It uses `compose.install.yml`
and `.env.install.example`. Before publication, use the accompanying release
attachment inputs or files from this working tree; rename the attachment
`default.env.install.example` to `.env.install.example`. Public v0.1.3 distribution
still requires separate approval; the existing v0.1.2 release remains available.
The example fixes `NAV_IMAGE` to the verified Digest; generate and preserve your
standard-mode authentication secret and configure the exact HTTPS origin.

To build this source locally, create `.env` beside `compose.yml`:

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

For standard-mode Navlume v0.1.2 and v0.1.3, open `BETTER_AUTH_URL` in your
browser, read the one-time initialization code from the container logs, and create your first
administrator on the welcome page:

```bash
docker compose logs app
```

The `[setup] First-run initialization code` is random, valid for 60 minutes, and
printed once at startup only when initialization is open and there are no users. Do not share it;
restrict access to container logs. If it expires, restart the container and use
the new code; the old one stops working. After creation, choose **进入登录页面**
and sign in normally. This does not enable public registration or supply any
default administrator password. Existing instances with any users cannot use
web setup. Initialization remains closed after success, even if all users are
later removed. LAN mode uses the same web flow without the code.

**Historical compatibility:** v0.1.0 images do not include web setup. The CLI
fallback remains available for v0.1.2 and v0.1.3; it is required for first
administrator creation on v0.1.0.

CLI fallback (retained), using your own email:

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
For standard NAS, LAN or any non-localhost installation, use an existing HTTPS proxy and
set `BETTER_AUTH_URL` to the exact browser-visible HTTPS origin. Authentication
cookies stay `Secure` in standard production. See [Deployment](./docs/DEPLOYMENT.md).

## Data and backup

The `navigation-data` volume contains `/data/nav.sqlite` and `/data/uploads`.
Keep the same Compose project and volume when upgrading. `docker compose down`
preserves the volume; `docker compose down -v` deletes it.

For v0.1.2 → v0.1.3, back up the database and complete uploads outside the
volume, preserve the original Origin and authentication secret, then change only
the image reference. A compatible rollback changes the image back while retaining
the updated volume; restoring an older backup is a separate destructive recovery
operation. See [the upgrade instructions](./docs/INSTALL.md#6-保留数据升级).

Stop the application before a physical backup or restore. Store an off-volume
backup and keep the standard-mode environment secret separately. In the LAN
mode, the private key is included in the full uploads backup. Restore replaces the
database and uploads. See [Backup & Restore](./docs/BACKUP_RESTORE.md) and the
installation guide for commands. JSON exports cover navigation content and do
not replace a full-instance backup.

## Development and checks

Use Node.js 24 and npm. Copy `.env.example` to `.env`; the development origin is
`http://localhost:5173`. Install from the lockfile:

```bash
npm ci
npm run db:migrate
npm run dev
```

Read the `[setup]` code in the server output and create the administrator at
`http://localhost:5173`. Alternatively, use `npm run admin:create` with one-shot
`BOOTSTRAP_ADMIN_*` variables.

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
