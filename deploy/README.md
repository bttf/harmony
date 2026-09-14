# Waxnerd deployment

This directory holds the configuration that runs this fork of Harmony at
`https://harmony.waxnerd.com`, on the same DigitalOcean droplet as the Waxnerd MusicBrainz mirror
(`mb.waxnerd.com`, Ubuntu 22.04). The app runs in Docker Compose behind a Caddy container that
terminates TLS.

## Branches and tags

- `main` is an untouched mirror of `kellnerd/harmony`.
- `waxnerd` is the deployed branch and the default branch of this fork. It was created from the
  upstream tag `v2026.8.30` and carries the deployment configuration on top.
- Upstream updates are **merged** into `waxnerd`, never rebased, so the merge base with upstream
  stays intact.
- Deploys are marked with fork tags of the form `waxnerd-<upstream tag>-<ordinal>`, for example
  `waxnerd-v2026.8.30-1`. The droplet checks out a tag, and `HARMONY_REVISION` in the droplet's
  `.env` holds the same tag. Compose passes it into the image as `DENO_DEPLOYMENT_ID`, which is what
  Harmony reports as its revision and what turns off Fresh's development mode.

## First deploy on the droplet

The user `bttf` is not in the `docker` group, so every `docker` command needs `sudo`.

### 1. Disk pre-flight

The droplet is tight on disk (the MusicBrainz mirror owns most of it).

```sh
df -h /
sudo docker system df
sudo docker image prune -f
sudo docker builder prune -f
df -h /
free -m
```

Proceed only with at least 5 GB free. The expected footprint of the Harmony image, the Caddy image
and the build cache is under 1.5 GB.

`free -m` matters because `deno cache` and `deno task build` run uncapped during the image build;
the `mem_limit` in `compose.yaml` applies to the running container only. The mirror's Postgres holds
2 GB of shared buffers, so if memory is tight, build while the mirror is idle.

### 2. Firewall

```sh
sudo ufw status verbose
```

If ufw is active, open the web ports:

```sh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
```

Those ufw rules are for consistency, not for reachability: Docker publishes ports through its own
`DOCKER` chain in `nat`/`FORWARD`, which bypasses ufw's `INPUT` chain, so the containers are reachable
whether or not ufw allows 80 and 443.

The layer that does have to allow the traffic is the DigitalOcean cloud firewall. If one is attached
to the droplet, add inbound rules for 80/tcp, 443/tcp and 443/udp there, otherwise Caddy cannot
complete the ACME challenge and no certificate is issued.

### 3. DNS

In Cloudflare, on the `waxnerd.com` zone, add an A record `harmony` → `146.190.166.125`, **DNS only**
(grey cloud), matching how `mb` is configured. Caddy issues its own certificate, so the record must
not be proxied.

```sh
dig +short harmony.waxnerd.com
```

Wait until that prints `146.190.166.125` before starting the containers.

### 4. Clone the fork

```sh
cd ~
git clone --branch waxnerd https://github.com/bttf/harmony.git harmony
cd ~/harmony
git fetch --tags
git checkout waxnerd-v2026.8.30-1
```

### 5. Environment file

```sh
cp deploy/env.example .env
chmod 600 .env
```

`HARMONY_REVISION` in `.env` must match the checked-out tag. No secrets are needed today: Bandcamp,
Deezer and iTunes require no credentials, and Spotify is deferred.

### 6. Data directory

The container runs as the base image's `deno` user, uid/gid 1993, so the bind-mounted data directory
has to be owned by that uid on the host.

```sh
mkdir -p ~/harmony/data
sudo chown -R 1993:1993 ~/harmony/data
```

### 7. Port check

Nothing else on the droplet may hold 80 or 443. Today only 22 and 15417 listen.

```sh
sudo ss -ltnp '( sport = :80 or sport = :443 )'
```

Expect no output. If something listens, stop it or change the `caddy` port mappings in
`compose.yaml` before continuing.

### 8. Build and start

```sh
sudo docker compose build harmony
sudo docker compose up -d
sudo docker compose ps
sudo docker compose logs harmony | grep Revision
sudo docker compose logs caddy | grep -i -E 'certificate obtained|error'
free -m; df -h /
```

`grep Revision` must print the tag from `.env`, not `unknown`; `unknown` means `DENO_DEPLOYMENT_ID`
did not reach the image and the app is running in development mode.

### 9. Reclaim build space

```sh
sudo docker builder prune -f
```

## Smoke tests

1. Open `https://harmony.waxnerd.com/release?url=<Bandcamp album URL>` in a browser. The release
   renders with its tracklist and an Import button.
2. The seeder form targets this host:

   ```sh
   curl -s 'https://harmony.waxnerd.com/release?url=<Bandcamp album URL>' |
     grep -o 'name="redirect_uri" value="[^"]*"'
   ```

   This must print an `https://harmony.waxnerd.com/release/actions?...` value. An `http://` value or
   a wrong host means `FORWARD_PROTO` or the Caddy headers are wrong.
3. `https://harmony.waxnerd.com/release/actions?release_mbid=<MBID>` renders the actions page for an
   existing MusicBrainz release.
4. HTTP redirects to HTTPS:

   ```sh
   curl -I http://harmony.waxnerd.com
   ```

5. Persistent data is being written:

   ```sh
   ls ~/harmony/data
   ```

   This shows `snaps.db` and `snaps/`.

## Update to a new upstream tag

```sh
# on a workstation
cd /path/to/harmony
git fetch upstream --tags
git checkout waxnerd
git merge <new upstream tag>       # merge, never rebase
# resolve conflicts, then push and tag the deploy
git push origin waxnerd
git tag waxnerd-<new upstream tag>-1
git push origin waxnerd-<new upstream tag>-1
```

```sh
# on the droplet
cd ~/harmony
git fetch --tags
git checkout waxnerd-<new upstream tag>-1
sed -i 's/^HARMONY_REVISION=.*/HARMONY_REVISION=waxnerd-<new upstream tag>-1/' .env
sudo docker compose up -d --build
sudo docker compose logs harmony | grep Revision
```

Keep the previous image until the new revision is verified (see Notes).

## Rollback

```sh
cd ~/harmony
git checkout <previous tag>
sed -i 's/^HARMONY_REVISION=.*/HARMONY_REVISION=<previous tag>/' .env
sudo docker compose up -d
```

No `--build`: the previous revision's image is tagged `waxnerd/harmony:<previous tag>` and is still
on the droplet, so Compose starts it as is. This is why the Notes below say to keep the previous
image.

## Remove

```sh
cd ~/harmony
sudo docker compose down -v --rmi all
cd ~ && sudo rm -rf ~/harmony     # copy data/ out first if it is worth keeping
```

`--rmi all` rather than `--rmi local`: `compose.yaml` sets an explicit `image:` name, so Compose does
not treat the Harmony image as locally built and `--rmi local` leaves it behind. To remove any
stragglers from earlier revisions:

```sh
sudo docker image rm $(sudo docker images -q 'waxnerd/harmony')
```

`sudo` on the `rm -rf`: `data/` is owned by uid 1993, not by `bttf`.

Then delete the Cloudflare `harmony` A record and the ufw (and cloud firewall) rules for 80 and 443.

## Data

`data/` holds `snaps.db` and `snaps/`, Harmony's cache of provider snapshots. It is a cache: deleting
it loses nothing but re-fetch time.

## Notes

- The instance is unauthenticated, the same as upstream's public instance. Anyone who reaches
  `harmony.waxnerd.com` can use it, and MusicBrainz edits are attributed to whoever is logged into
  MusicBrainz in their own browser.
- Upstream sets `"lock": false` in `deno.json`, so every image build resolves remote dependencies
  fresh and two builds of the same commit are not guaranteed to be identical. Keep the previous
  image around until a new revision is verified, so a rollback does not depend on a rebuild.
- The `denoland/deno` pin in the `Dockerfile` should be bumped when upstream CI's Deno minor version
  moves (`.github/workflows/deno.yml`, `deno-version`).
