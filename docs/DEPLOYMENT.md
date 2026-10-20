# Navlume v0.2.0 Deployment

Release availability and attachments are listed on the
[v0.2.0 release page](https://github.com/laohiog/navlume/releases/tag/v0.2.0).
The documentation commit and annotated tag object are recorded separately from
the runtime source in `RELEASE-IDENTITY.json`. Documentation does not require an image rebuild.

Self-hosted deployment of Navlume as a **single
application container**.

This page retains the developer/source-build path (`compose.yml`). For source-free
Linux/NAS installation using `compose.install.yml`, see [INSTALL.md](./INSTALL.md).

Public source: [laohiog/navlume](https://github.com/laohiog/navlume).
The default prebuilt image in the current templates is
`ghcr.io/laohiog/navlume:latest`. It tracks deliberately accepted stable releases;
running containers update only after an explicit pull and recreation. Keep a
verified immutable Digest for pinned deployments and compatible rollback.

The repository templates keep `latest`. The v0.2.0 release attachments instead pin
the verified Digest in `default.env.install.example` and `compose.lan.yml`, so a
Digest-pinned installation does not follow `latest`; switching it to follow stable
releases is an explicit edit that keeps the project, data volume, secret and Origin.
Publishing a GitHub Release does not promote `latest`.

The v0.2.0 release attachments are the current set. Their Linux AMD64 runtime
source is `bf5de8ceb2bba07513c23ff5ac440468e76de0e1`, with immutable image
`ghcr.io/laohiog/navlume@sha256:9a0bcedf9ae803d0ef2ec6d7b06e246bb217e8088ce47f44ee6ca95b0091cca2`
for fixed v0.2.0 installations. Its OCI revision remains the runtime source,
not the documentation commit. `RELEASE-IDENTITY.json` distinguishes
the runtime source, documentation commit, intended tag and immutable image.
Source builds identify their own actual revision.

The v0.1.3 release attachments remain unchanged. Their runtime source is
`361aaa6439ba16e3579d097629ac75fe2df4fc91`, with immutable image
`ghcr.io/laohiog/navlume@sha256:81081c094488af19bda6fa1d0b37a582c76053084ce9410d358f15efe70af857`
for fixed v0.1.3 installations and rollback.

The historical release
[v0.1.2](https://github.com/laohiog/navlume/releases/tag/v0.1.2) has runtime
source `3a9ad4c716b0f961dd089969c387603e4e631576`. Use its original
attachments when installing that version.

The standalone `compose.lan.yml` explicitly sets `INSTALL_MODE=lan-http`,
accepts one exact RFC1918 IPv4 HTTP origin and supports browser creation without a
log code. Its automatically persisted key is included in full uploads backups.
HTTP has no transport encryption; private-IP validation does not replace a firewall.
See [INSTALL.md](./INSTALL.md) for the LAN limitations and recovery instructions.

---

## 1. Architecture

```
Browser
   ↓
one HTTP origin
   ↓
one Node/Hono container
   ├── built React client
   ├── Hono API + Better Auth
   └── SQLite database
          ↓
      /data named volume
```

One service, one persistent volume. There is no database container, no Redis, and
no bundled reverse proxy.

| Path | Purpose |
|------|---------|
| `/data/nav.sqlite` | SQLite database |
| `/data/uploads/` | Uploaded brand assets |

Both live under a single `/data` root. This preserves the physical backup/restore
layout documented in [BACKUP_RESTORE.md](./BACKUP_RESTORE.md), which requires the
database **not** to sit inside the uploads directory.

---

## 2. Requirements

- Docker Engine with Compose v2 (`docker version`, `docker compose version`)
- Roughly 1 GB of free disk for the image and dependencies
- An existing reverse proxy / TLS terminator for standard non-localhost access
  (see §9); explicit LAN HTTP uses the separate single-file Compose

The application does not terminate TLS itself.

---

## 3. Configure

Create a `.env` file beside `compose.yml` (Compose reads it automatically):

```bash
# Required. Generate a strong secret:
#   openssl rand -base64 32
BETTER_AUTH_SECRET=<paste-generated-secret>

# Required. The exact origin the browser uses.
#   Internet-facing: https://nav.example.com
#   localhost trial:  http://localhost:3000   (see the note below)
BETTER_AUTH_URL=http://localhost:3000
```

`BETTER_AUTH_URL` must be the **browser-visible origin**. Better Auth validates the
request `Origin` against it for cookie-bearing requests, so a mismatch breaks
sign-in even though the container itself is healthy.

> ### Standard production authentication cookies are always `Secure`
>
> In standard mode the container runs `NODE_ENV=production`, and cookies are issued
> with `Secure`, `HttpOnly`, and `SameSite=Lax`, under the `__Secure-` name prefix.
> This is set explicitly rather than derived from `BETTER_AUTH_URL`, so it cannot be
> downgraded by the origin value.
>
> A `Secure` cookie is only returned by **HTTPS** origins. Browsers treat
> `http://localhost` as a secure context, so a `http://localhost:3000` trial works —
> but a plain-HTTP deployment on any other hostname **will not be able to sign in**,
> because the browser will refuse to store the cookie.
>
> **For any standard non-localhost deployment, terminate TLS in front of this container and
> set `BETTER_AUTH_URL` to the `https://` origin.** See §9.

Do not commit `.env`. It is already covered by `.gitignore`.

Compose deliberately fails fast when either variable is missing:

```
service "app" is missing required environment variable: BETTER_AUTH_SECRET
```

---

## 4. Build and start

```bash
docker compose build
docker compose up -d
```

On the first start the container:

1. validates the production configuration;
2. applies pending Drizzle migrations to `/data/nav.sqlite`;
3. prints a random, one-time setup code in standard mode if initialization is open and there are no users;
4. starts the HTTP server.

Migration runs **before** the server begins listening, so a migration failure
stops the container instead of serving a half-migrated schema. A fresh volume
becomes a migrated, empty installation — no demo data is inserted, and
`db:seed` is never run in production.

Check status:

```bash
docker compose ps
docker compose logs -f app
```

Wait for the health status to become `healthy` (up to ~30 s on a cold volume).

---

## 5. Health check

```bash
curl http://localhost:3000/api/health
# {"status":"ok"}
```

`200` means the process is running and its database is readable. `503` with
`{"status":"unhealthy"}` means the database check failed. The endpoint returns no
paths, secrets, environment values, or counts, and requires no authentication.

Container health uses the same endpoint on `127.0.0.1:3000` internally, so it does
not depend on `BETTER_AUTH_URL` being reachable from inside the container.

---

## 6. Create the first administrator

A fresh installation has **no administrator**, and public sign-up is disabled.
For standard-mode Navlume v0.1.2 and later, read the
`[setup] First-run initialization code` in `docker compose logs app`, open
`BETTER_AUTH_URL`, and create the first administrator
on the welcome page. Then choose **进入登录页面** to sign in normally. The code is
valid for 60 minutes; a restart generates a new code on an uninitialized empty instance and
invalidates the old one. Creation persistently closes web setup; any existing user prevents it.
Deleting all users does not reopen setup. Explicit LAN HTTP uses the same web
flow without a code; see the LAN installation section.
Protect container-log access and never share the code. No default password exists.

**Historical compatibility:** v0.1.0 images do not contain web setup. See the
[installation guide](INSTALL.md) for standard Docker Compose → container logs →
one-time code → web administrator setup → login, and the release availability
requirements above.

The CLI remains an optional fallback in v0.1.2 and later (required for
first administrator creation on v0.1.0). Use one-shot variables:

```bash
docker compose run --rm \
  -e BOOTSTRAP_ADMIN_USERNAME=admin \
  -e BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
  -e BOOTSTRAP_ADMIN_PASSWORD='choose-a-strong-password' \
  -e BOOTSTRAP_ADMIN_NAME='Administrator' \
  app node dist/server/server/bootstrap-admin.js
```

Success prints `[bootstrap] created administrator "admin"`.

The command:

- uses Better Auth to hash the password and create the credential account;
- creates the account with the `admin` role;
- **refuses** to run when an administrator already exists;
- refuses when required values are missing or the password is too short;
- never logs the password.

These are one-shot variables — do **not** add them to `compose.yml`, or the
password would persist as deployment state.

Then sign in at `BETTER_AUTH_URL` with that username and password.

### Create ordinary users

Ordinary users are created by the administrator through the built-in user
management UI. There is no public registration.

---

## 7. Day-to-day operations

```bash
docker compose logs -f app      # follow logs
docker compose restart app      # restart
docker compose stop             # stop (sends SIGTERM; database is closed cleanly)
docker compose start            # start again
docker compose down             # stop and remove the container
```

### Prebuilt image upgrade from v0.1.3

Follow [INSTALL.md §6](./INSTALL.md#6-保留数据升级): make an off-volume physical
backup, preserve Origin, authentication secret, project and data volume, and change
only the image. v0.2.0 adds no API, authentication or dependency changes; migration
`0004` only adds a nullable `site_settings.home_theme_config` column and is applied on
start. The isolated runtime upgrade (migrations 4 → 5, existing data and sign-in
preserved) and same-volume rollback to v0.1.3 were verified; reverting the image does
not normally require replacing current data with a backup, although saved home-theme
settings are ignored while the older image runs. Keep the existing standard HTTPS or
explicit LAN mode. Do not build another image for a documentation-only release.

### Source-build upgrade

```bash
git pull                       # or copy the new source
docker compose build
docker compose up -d
```

The named volume is untouched by this sequence; migrations are applied on start.

> **`docker compose down` keeps the named volume.** Application data survives.
>
> **`docker compose down -v` deletes the named volume and all persistent
> application data — database, users, navigation, branding, and uploaded files.
> There is no undo.** Use it only when you intend to discard the instance.

---

## 8. Backup and restore

Physical backup and restore reuse the P6.2 tooling shipped in the image. Both
require the application to be **stopped**, because the database and uploads
directory together form the recovery point.

### Backup

```bash
docker compose stop

docker compose run --rm app \
  node dist/server/server/backup.js --app-stopped --output /data/backups

docker compose start
```

The backup directory is written inside the volume at `/data/backups`, so it
survives container recreation. Copy it somewhere else (`docker compose cp`, or a
host bind mount) to keep an off-instance copy.

### Restore

> **⚠️ Restore replaces the live database and the entire uploads directory.**

```bash
docker compose stop

docker compose run --rm app \
  node dist/server/server/restore.js \
    --app-stopped \
    --confirm-restore \
    --backup /data/backups/backup-<timestamp>

docker compose start
```

Both `--app-stopped` and `--confirm-restore` are required. `--app-stopped` is an
acknowledgement that you stopped the service; it is not an automatic check.

See [BACKUP_RESTORE.md](./BACKUP_RESTORE.md) for the full contract, the path-safety
rules, and the meaning of each exit code.

---

## 9. Internet-facing HTTPS

The application serves plain HTTP inside the container. **Its authentication cookies
are always `Secure` in standard production** (see §3), which means a browser will only accept
them from an HTTPS origin. `http://localhost` is the one exception, because browsers
treat it as a secure context.

For standard mode other than a localhost trial, place the single container behind an
**existing** reverse proxy or TLS terminator of your choice and:

- forward `https://nav.example.com` → the container's published port;
- set `BETTER_AUTH_URL` to exactly `https://nav.example.com`;
- pass through the `Host` and `X-Forwarded-*` headers your proxy already sends.

Terminating TLS at the proxy and forwarding plain HTTP to the container is the
intended topology: the `Secure` flag is enforced by the application regardless, so
sign-in works over the HTTPS origin while the internal hop stays simple.

A plain-HTTP deployment on a non-localhost hostname in standard mode is **not** a supported
login configuration — the browser rejects the session cookie and sign-in
silently fails. No proxy is bundled with this project, and none is needed for a
localhost trial or for HTTPS terminated by your own proxy.

---

## 10. Environment reference

| Variable | Required | Purpose |
|----------|----------|---------|
| `NODE_ENV` | Docker | `production` enables production validation and static serving |
| `INSTALL_MODE` | Optional | `standard` default; explicit `lan-http` for private IPv4 HTTP only |
| `HOST` | Docker | Bind interface (`0.0.0.0` in the container) |
| `PORT` | Docker | Bind port (`3000` in the container) |
| `DATABASE_PATH` | Docker | `/data/nav.sqlite` |
| `UPLOADS_DIR` | Docker | `/data/uploads` |
| `BETTER_AUTH_SECRET` | **Standard production** | Signing secret; LAN persists/generates it automatically |
| `BETTER_AUTH_URL` | **Production** | Browser-visible origin |
| `BOOTSTRAP_ADMIN_*` | One-shot | First administrator creation only |

Invalid `PORT`, a missing standard-mode secret, or a malformed `BETTER_AUTH_URL` stop the
container before it creates a database, so a misconfigured deployment cannot leave
a stray file on a fresh volume.

---

## Distribution maintainer workflow

The repository is `laohiog/navlume`. Its initial commit was created from the reviewed
public source snapshot with no private Git metadata, branches or tags. Release
revisions refer to this public history. Publication requires an independently
reviewed source revision and explicit maintainer authorization.

`.github/workflows/docker-image.yml` runs only on manual dispatch. Its repository
guard refuses execution outside `laohiog/navlume`. A push, merge or tag does not
publish an image. `publish` defaults to false: it builds an AMD64 image, loads it
locally on the runner and checks the native SQLite module without registry login.
ARM64 is unverified.

After review, preserve the exact public Candidate in a new public-repository
commit. The workflow must be present on the default branch for manual dispatch.
Select the reviewed ref and supply its full 40-character SHA as `expected_commit`.
The checked-out HEAD and GitHub's selected SHA must both match it, and the source
must be clean. The image is
`ghcr.io/laohiog/navlume:sha-<full-reviewed-public-commit>`.
OCI labels record the public source URL, revision and version. This build workflow
does not create or advance `latest`. Independent verification and pinned installs
use the registry Digest, preferably
`ghcr.io/laohiog/navlume@sha256:<digest>`.

With explicit publication authorization, `publish=true` logs in using the
workflow's scoped `GITHUB_TOKEN`, pushes the already-built and SQLite-checked
image, and records Commit, Tag and `NAV_IMAGE=ghcr.io/...@sha256:...` in the run
summary. A local image ID is not a registry Digest. Keep the summary and distribute
installation files from the same reviewed public version. Tags can be overwritten;
source/version binding does not promise identical rebuilds because base images
and OS package repositories can change.

### Stable latest promotion boundary

1. Build and publish the candidate under its commit-specific tag; retain its Digest.
2. Complete normal verification and the official GitHub Release.
3. After the stable release is accepted, explicitly promote that verified manifest
   to `latest`, without rebuilding or changing the original SHA tag or OCI labels.
4. Independently retrieve `latest` and require its manifest Digest to equal the
   accepted stable Digest exactly. A different result requires review.
5. Preserve the previous stable Digest for compatible rollback.

A candidate image publication alone never advances `latest`. This is a deliberate
release action, not a new workflow or an automatic updater. Default users manually
run `docker compose pull` and `docker compose up -d --no-build`, retaining their
original `-f`, `-p` and environment settings. Back up first; preserve project,
database/uploads volume, authentication secret and Origin. Never use `down -v`.
Existing Digest-pinned users must opt into `latest` once; see
[INSTALL §6](./INSTALL.md#6-保留数据升级) for manual update and rollback rules.

Repository and package visibility are separate. This workflow changes neither.
A newly created GHCR package may be private; before advertising a public image,
the maintainer must separately authorize its visibility change and verify an
anonymous Digest pull. Public images require no installer login. A restricted
preview requires explicit read permission; tokens stay in Docker/GitHub credential
storage, never in installation files or the application image.

The Docker context is an allowlist of actual build inputs. It excludes local
configuration, Git metadata, databases, uploads, backups, tests and internal
documents. A build-only workflow run does not publish an image or change
repository/package visibility.

References: [Docker Actions build guidance](https://docs.docker.com/build/ci/github-actions/push-multi-registries/),
[GHCR authentication and digest pulls](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
