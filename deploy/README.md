# Waxnerd deployment

This directory holds the runbook for this fork of Harmony at `https://harmony.waxnerd.com`. It runs
as the `harmony` service in the Waxnerd Railway project (`intelligent-courage`), next to the api and
Typesense. Railway builds the root `Dockerfile` and terminates TLS. The caller is the Waxnerd import
app (`apps/import` in `bttf/waxnerd`), which sends `POST /api/waxnerd/lookup`.

## Branches and revisions

- `main` is an untouched mirror of `kellnerd/harmony`.
- `waxnerd` is the deployed branch and the default branch of this fork. It was created from the
  upstream tag `v2026.8.30` and carries the deployment configuration on top.
- Upstream updates are **merged** into `waxnerd`, never rebased, so the merge base with upstream
  stays intact.
- Railway deploys every push to `waxnerd`. The Dockerfile takes the deployed commit from Railway's
  `RAILWAY_GIT_COMMIT_SHA` build argument and passes it to the app as `DENO_DEPLOYMENT_ID`, which is
  what Harmony reports as its revision and what turns off Fresh's development mode.

## First deploy on Railway

### 1. Service

In the `intelligent-courage` project, production environment: New → GitHub Repo → `bttf/harmony`.
Name the service `harmony`. In its settings:

- Source: branch `waxnerd`.
- Build: Dockerfile (Railway picks up the root `Dockerfile`).
- Networking: target port `8000`.

### 2. Variables

| Variable                 | Value                             |
| ------------------------ | --------------------------------- |
| `PORT`                   | `8000`                            |
| `FORWARD_PROTO`          | `true`                            |
| `HARMONY_CODE_URL`       | `https://github.com/bttf/harmony` |
| `HARMONY_WAXNERD_SECRET` | output of `openssl rand -hex 32`  |
| `RAILWAY_RUN_UID`        | `0`                               |

`FORWARD_PROTO=true` makes Harmony build its own URLs from Railway's `X-Forwarded-Proto` header.
Without it the seeder's `redirect_uri` and edit notes carry `http://`.

`HARMONY_WAXNERD_SECRET` is the bearer token for `POST /api/waxnerd/lookup`. The same value has to
be set as `HARMONY_WAXNERD_SECRET` in the import app's Railway env. While it is unset, the endpoint
answers 401 to every request and nothing else on the instance changes.

`RAILWAY_RUN_UID=0` runs the container as root. The image's `deno` user cannot write to a Railway
volume, which is mounted owned by root.

Providers need no credentials today: Bandcamp, Deezer and iTunes are free, and Spotify is deferred.

### 3. Volume

Attach a volume to the service at mount path `/data` (`HARMONY_DATA_DIR`, set in the Dockerfile).
1 GB is enough.

### 4. Domain

Settings → Networking → Custom Domain → `harmony.waxnerd.com`. Railway shows a CNAME target. In
Cloudflare, on the `waxnerd.com` zone, add a CNAME `harmony` → that target, **DNS only** (grey
cloud), so Railway can issue the certificate.

### 5. Deploy

Connecting the repo in step 1 starts a build, and steps 2–4 each trigger a redeploy. Check the
latest deployment once all four are done.

Deploy the service, then check the deploy log for the revision:

```
Revision: <commit sha, 7 characters>
```

`unknown` means `DENO_DEPLOYMENT_ID` did not reach the image and the app is running in development
mode.

## Smoke tests

1. Open `https://harmony.waxnerd.com/release?url=<Bandcamp album URL>` in a browser. The release
   renders with its tracklist and an Import button.
2. The seeder form targets this host:

   ```sh
   curl -s 'https://harmony.waxnerd.com/release?url=<Bandcamp album URL>' |
     grep -o 'name="redirect_uri" value="[^"]*"'
   ```

   This must print an `https://harmony.waxnerd.com/release/actions?...` value. An `http://` value or
   a wrong host means `FORWARD_PROTO` is not set.
3. `https://harmony.waxnerd.com/release/actions?release_mbid=<MBID>` renders the actions page for an
   existing MusicBrainz release.
4. Persistent data is being written: after test 1, `railway ssh --service harmony ls /data` shows
   `snaps.db` and `snaps/`.
5. The Waxnerd lookup endpoint rejects an unauthenticated request:

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' -X POST \
     -H 'Content-Type: application/json' \
     -d '{"url":"<Bandcamp album URL>","redirectUrl":"https://import.waxnerd.com/release-imports/rows/<uuid>/callback"}' \
     https://harmony.waxnerd.com/api/waxnerd/lookup
   ```

   This must print `401`.
6. The Waxnerd lookup endpoint answers an authenticated request:

   ```sh
   curl -s -X POST \
     -H "Authorization: Bearer $HARMONY_WAXNERD_SECRET" \
     -H 'Content-Type: application/json' \
     -d '{"url":"<Bandcamp album URL>","redirectUrl":"https://import.waxnerd.com/release-imports/rows/<uuid>/callback"}' \
     https://harmony.waxnerd.com/api/waxnerd/lookup |
     jq '{title, existingMbid, redirect_uri: .seed.redirect_uri, edit_note: .seed.edit_note}'
   ```

   Export `HARMONY_WAXNERD_SECRET` in the shell first, with the value from the service's variables.
   `redirect_uri` must start with the `redirectUrl` that was sent, followed by a query string which
   Harmony adds (the lookup state). `edit_note` must reference `https://harmony.waxnerd.com/release?`;
   an `http://` value or a wrong host means `FORWARD_PROTO` is not set. The first
   call is slow (3-30 s) because nothing is cached yet.

## Update to a new upstream tag

```sh
cd /path/to/harmony
git fetch upstream --tags
git checkout waxnerd
git merge <new upstream tag>       # merge, never rebase
# resolve conflicts, then push; Railway deploys the new head of waxnerd
git push origin waxnerd
```

`server/fresh.gen.ts` conflicts whenever upstream adds a route or an island: keep upstream's version
of the file and re-add the two `./routes/api/waxnerd/lookup.ts` lines (or run `deno task dev` once,
which regenerates the manifest).

## Rollback

In the Railway dashboard, open the `harmony` service's Deployments tab and redeploy the previous
successful deployment. Railway reuses that deployment's image, so a rollback does not depend on a
rebuild. Then revert the bad commit on `waxnerd`, or the next push redeploys it.

## Local run

`compose.yaml` builds the same image and runs it on `127.0.0.1:8000` in production mode:

```sh
cp deploy/env.example .env
docker compose up --build
```

## Remove

Delete the `harmony` service (with its volume) in the Railway dashboard, then delete the Cloudflare
`harmony` CNAME.

## Data

`/data` holds `snaps.db` and `snaps/`, Harmony's cache of provider snapshots. Permalinks point at
these snapshots. It is a cache: losing it loses nothing but re-fetch time, and old permalinks then
show freshly fetched data.

## Notes

- The HTML UI is unauthenticated, the same as upstream's public instance. Anyone who reaches
  `harmony.waxnerd.com` can use it, and MusicBrainz edits are attributed to whoever is logged into
  MusicBrainz in their own browser. `POST /api/waxnerd/lookup` is the one authenticated surface: it
  requires `HARMONY_WAXNERD_SECRET` as a bearer token and answers 401 without it.
- Upstream sets `"lock": false` in `deno.json`, so every image build resolves remote dependencies
  fresh and two builds of the same commit are not guaranteed to be identical. Roll back by
  redeploying an earlier Railway deployment, not by rebuilding an older commit.
- The `denoland/deno` pin in the `Dockerfile` should be bumped when upstream CI's Deno minor version
  moves (`.github/workflows/deno.yml`, `deno-version`).
