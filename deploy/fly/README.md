# Fly.io deployment — OmniRoute + self-hosted Hindsight

This directory holds the deployment manifests for running OmniRoute with
self-hosted [Hindsight](https://github.com/vectorize-io/hindsight) as its durable
memory backend.

Everything here is deployed **manually from committed source**. There is no CI/CD
pipeline for it: `fly deploy` builds the image from the checked-out commit, so the
Git commit you pushed is the artifact you shipped.

The upstream repository already documents a single-service Fly deployment in
[`docs/ops/FLY_IO_DEPLOYMENT_GUIDE.md`](../../docs/ops/FLY_IO_DEPLOYMENT_GUIDE.md)
and ships a root `fly.toml`. This directory is additive and does not change
either; read the upstream guide first — the secret names, volume contract and
`DATA_DIR` requirement come from there.

## Topology

```
Hermes / FibStation
        │  HTTPS + API key
        ▼
  omniroute-memory                 Fly app #1  ← public https://, force_https
  OmniRoute (node, port 20128)     volume: omniroute_data → /data
        │  MemoryManager → HindsightBackend
        │  http://omniroute-hindsight.internal:8888   (Fly 6PN, private)
        ▼
  omniroute-hindsight              Fly app #2  ← no public service at all
  Hindsight 0.8.6 (API 8888, CP 9999)   volume: hindsight_data → /home/hindsight/.pg0
```

**Why two Fly apps rather than one machine with two processes.** A Fly app has one
image for all of its machines, and `fly deploy` manages machines from a single
manifest. OmniRoute and Hindsight ship as genuinely different images (OmniRoute is
built from this repository; Hindsight is a pinned upstream image), so co-locating
them would mean publishing a third, combined ~12 GB image that neither project
maintains — a bespoke artifact that would have to be rebuilt on every upstream
release. Two apps in the same organisation keep the images independent, keep each
service's restart/scale/upgrade lifecycle separate, and still give the private
6PN networking the topology needs. The `explicit process/service boundary` is
therefore the app boundary itself.

Hindsight is **not** publicly exposed: `hindsight.fly.toml` declares no
`[http_service]`, so nothing routes to port 8888 or 9999 from the internet.
OmniRoute reaches it by DNS name over the private network.

## Resource baseline

Measured locally (Docker Desktop, CPU-only, Hindsight full image with local
embedding + reranker models):

| | image (uncompressed) | image (compressed, what Fly pulls) | RSS |
|---|---|---|---|
| Hindsight (all-in-one, `INCLUDE_LOCAL_MODELS=true`) | ~6.4 GB | ~0.84 GB | ~785 MiB idle, ~865 MiB during boot |
| OmniRoute (`runner-base`) | ~0.5 GB | ~0.2 GB | ~500 MiB |

That is why the manifests provision `shared-cpu-2x` / 2048 MB for Hindsight and
`shared-cpu-1x` / 1024 MB for OmniRoute. Hindsight's own documentation asks for
1.5 GB minimum and 2 GB recommended for the full image, and the measured idle RSS
of ~0.8 GB leaves no headroom at 1 GB during model initialisation. Raise
`[[vm]] memory` in `hindsight.fly.toml` only if `fly logs` shows OOM kills.

Volumes: 5 GB for Hindsight (embedded PostgreSQL cluster + WAL + growth) and 3 GB
for OmniRoute (SQLite database, call logs, pre-migration snapshots).

## Preconditions

```powershell
fly auth whoami        # must be the account that owns the apps
```

Both apps and both volumes are created **once**, before the first deploy:

```powershell
fly apps create omniroute-hindsight --org personal
fly apps create omniroute-memory    --org personal

fly volumes create hindsight_data  --region ord --size 5 -a omniroute-hindsight
fly volumes create omniroute_data  --region ord --size 3 -a omniroute-memory

# Public ingress is NOT allocated automatically on deploy; the app answers on
# 6PN but not on the internet until you do this.
fly ips allocate-v4 --shared -a omniroute-memory
fly ips allocate-v6           -a omniroute-memory
```

## Networking: two things that will bite

**1. Fly's 6PN private network is IPv6-only.** A service that binds `0.0.0.0`
creates an `AF_INET` socket only and is then unreachable from the other app, even
though it answers on `127.0.0.1` inside its own container. That is exactly how
this first deployed: Hindsight was healthy locally while every 6PN request from
OmniRoute returned `ECONNREFUSED` against its `fdaa:...` address.
`hindsight.fly.toml` therefore sets `HINDSIGHT_API_HOST = "::"`, which
dual-stacks on Linux so loopback and 6PN both work. Confirm with the listener
table rather than by assuming:

```powershell
fly ssh console -a omniroute-hindsight -C "cat /proc/net/tcp6"
# expect a LISTEN on :::8888, not only a v4 entry for 8888
```

OmniRoute is only a *client* of that address and does not need to change its own
bind, which is why its `HOSTNAME` stays `0.0.0.0`.

**2. Hindsight has no `[http_service]` and no public IPs.** That is deliberate —
nothing routes to 8888 or 9999 from the internet. If you ever add one, put
Hindsight's own API-key auth in front of it first
(`HINDSIGHT_API_TENANT_EXTENSION` + `HINDSIGHT_API_TENANT_API_KEY`; auth is
disabled by default, and `/health` and `/metrics` stay open regardless).

**3. OmniRoute's bind comes from `OMNIROUTE_HOSTNAME`.** The standalone launcher
overrides the child's `HOSTNAME` and defaults it back to `0.0.0.0`
(`scripts/build/runtime-env.mjs:177`), so setting `HOSTNAME`/`HOST`/`BIND` alone is
silently ignored. Only `OMNIROUTE_HOSTNAME` changes the bind. This matters if you
want Hindsight to call OmniRoute (see the chain note below); the deployed value is
`::`, and public ingress is verified unaffected.

## Hindsight's LLM chain

Retain, reflect and consolidation call an LLM, so `hindsight.fly.toml` pins a
failover chain. Two rules learned the hard way:

- **Every model id must be verified reachable before it goes in.** Failover
  rescues *transient* failures. It cannot rescue a retired model: the original
  configuration led with `minimax/minimax-m3:free`, which now returns 404, and
  every retain failed outright. Indices must also be contiguous from 1 —
  Hindsight stops scanning at the first unset `_PROVIDER`, so a gap silently
  truncates the chain.
- **The cheapest models are not always the right lead.** The two free models
  answer quickly in isolation but emit prose instead of the strict JSON that
  `HINDSIGHT_API_LLM_STRICT_SCHEMA=true` requires, so extraction retries; a retain
  led by them ran past the client's timeout, which then fell back to SQLite. They
  are kept as failovers, where they cost nothing and only run on an error.

Point the OmniRoute-side retain timeout at Hindsight's own budget, not below it:

```powershell
# backendConfigs.hindsight.retainTimeout, via PUT /api/settings/memory
# Hindsight keeps working after the client stops waiting, so a client that gives
# up early can commit server-side while MemoryManager falls back to SQLite —
# the same memory in two stores, visible only in one. Default is 300000.
```

**opencode's free tier is not reachable this way.** OmniRoute does expose opencode
models (as `oc/…`, including `oc/deepseek-v4-flash-free`, `oc/mimo-v2.5-free`), and
Hindsight can now reach OmniRoute over 6PN, but calling them returns
`403 "OpenCode's free tier can only be used from within OpenCode"` — the provider
gates free usage to the OpenCode client itself. Other `oc/*` models need an
authorised opencode connection (`401 No active credentials for provider: opencode`).



## Secrets

Secret **names** only — never commit or paste values. Set them with
`fly secrets import` (reads `NAME=VALUE` from stdin) so values never appear in
shell history or logs.

### `omniroute-hindsight`

| Secret | Why |
|---|---|
| `HINDSIGHT_API_LLM_API_KEY` | Retain/reflect call an LLM. Hindsight refuses to boot without a key. |
| `HINDSIGHT_API_LLM_1_API_KEY`, `HINDSIGHT_API_LLM_2_API_KEY` | The failover chain members declared in `hindsight.fly.toml`. |

The OpenRouter key is shared by all three members; only the models differ, and
model ids are pinned in `hindsight.fly.toml` because they are not secret.

### `omniroute-memory`

| Secret | Why |
|---|---|
| `STORAGE_ENCRYPTION_KEY` | **Must be the original value** when migrating a database: provider credentials are stored as `enc:v1:` ciphertext and are unreadable without it. |
| `STORAGE_ENCRYPTION_KEY_VERSION` | Version tag written by the original deployment. |
| `JWT_SECRET` | Login sessions / JWT signing. |
| `API_KEY_SECRET` | Salt for generated gateway API keys (`sk-…`). Reusing the original avoids key-format drift. |
| `MACHINE_ID_SALT` | Stable machine identifier. |
| `OMNIROUTE_WS_BRIDGE_SECRET` | WebSocket bridge handshake — required in production. |
| `OMNIROUTE_API_KEY` | A master gateway key that always validates, independent of the database. |
| `INITIAL_PASSWORD` | Seeds the dashboard password on a *fresh* database only. |

`DATA_DIR=/data` and `NEXT_PUBLIC_BASE_URL` are not secrets; `DATA_DIR` is in the
manifest (it **must** match the volume mount) and set
`NEXT_PUBLIC_BASE_URL` when you bind a custom domain or use OAuth providers.

## Deploy

Deploy Hindsight first — OmniRoute's memory backend initialises against it at
startup (and degrades cleanly if it is not there yet).

```powershell
cd <repo root>

# 1. Hindsight — deployed straight from the pinned upstream image
fly deploy --config deploy/fly/hindsight.fly.toml

# 2. OmniRoute — deployed from the image published by .github/workflows/publish-fly-image.yml
fly deploy --config deploy/fly/omniroute.fly.toml `
  --image ghcr.io/<owner>/omniroute:hindsight
```

**Why OmniRoute is deployed as a published image instead of being built by Fly.**
The Next.js production build for this codebase needs a ~6 GB V8 heap per
process. The Dockerfile raises its own default to 6144 MB for exactly that reason,
and lowering it aborts the build worker with
`FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed`.

- Fly's remote builder cannot hold it: the build dies mid-flight and takes the
  build daemon with it (`builder ... connection error ... unable to upgrade to
  h2c, received 500`).
- The build cannot run on a typical operator workstation either — it needs
  several GB per process, more than Docker Desktop commonly gets.

The `publish-fly-image` workflow builds `runner-base` from committed source on a
GitHub-hosted runner (the machine class the Dockerfile's build args are calibrated
against) and pushes it to GHCR tagged with the commit SHA, so the deployed
artifact is reproducible and addressable:

```powershell
fly deploy --config deploy/fly/omniroute.fly.toml `
  --image ghcr.io/<owner>/omniroute:sha-<commit>
```

Two more build gotchas, already handled:

- `[build] dockerfile` is resolved relative to the **config file**, not the
  working directory, hence the `../../Dockerfile`. The build context is still the
  repository root.
- If your Fly organisation defaults to a Depot builder, `fly deploy` can sit at
  "Waiting for depot builder..." indefinitely; pass `--depot=false`.

The first Hindsight boot is slow: it downloads its embedded PostgreSQL
distribution into the volume, runs migrations, then loads the local embedding and
reranker models. Ten minutes is normal on a shared CPU. `HINDSIGHT_API_STARTUP_WAIT_SECONDS`
bounds it, and there is deliberately **no Fly health check** on that app — a check
that fired mid-initialisation would put the machine into a restart loop that never
finishes. Liveness comes from `/app/start-all.sh` exiting non-zero if the API fails,
which Fly treats as a crash, and memory-service health is reported by OmniRoute at
`GET /api/memory/backends`.

### Volume ownership and seeding the database (one-time)

A Fly volume is created root-owned, but both images run as UID 1000. Fix
ownership once per volume, and seed the migrated database **before** the app
first opens it:

```powershell
# 1. Boot a throwaway machine that just holds the volume open.
fly machine run -a omniroute-memory --region ord --detach `
  -v omniroute_data:/data --entrypoint sleep python:3.10-slim 3600

fly ssh console -a omniroute-memory -C "chown -R 1000:1000 /data"

# 2. Upload the WAL-safe snapshot taken in the migration section.
fly sftp put .\storage.sqlite /data/storage.sqlite -a omniroute-memory
fly ssh console -a omniroute-memory -C "chown 1000:1000 /data/storage.sqlite"
fly ssh console -a omniroute-memory -C "chmod 600 /data/storage.sqlite"
# Verify the bytes end-to-end; a truncated upload is a silently corrupt database.
fly ssh console -a omniroute-memory -C "sha256sum /data/storage.sqlite"

# 3. Drop the throwaway machine BEFORE deploying, so `fly deploy` owns the app.
fly machine destroy <temp-machine-id> -a omniroute-memory
```

Seeding before first boot is preferable to importing into a running app: the
import endpoint is behind management auth, and a fresh deployment has no
management credential to present. If you do import into a running app instead,
`POST /api/db-backups/import` validates integrity and takes a pre-import backup,
but you must restart the machine afterwards.

Skipping the ownership fix shows up as `check-permissions.sh` warnings on
OmniRoute and as pg0's explicit "Permission denied (os error 13)" on Hindsight.


## Migrating an existing working configuration

Provider LLM credentials live **only** in `storage.sqlite`, encrypted with
`STORAGE_ENCRYPTION_KEY`. There is no environment-variable path for them
(`docs/reference/ENVIRONMENT.md` — the `${PROVIDER}_API_KEY` runtime variables
were removed in v3.8.0), so a working local configuration is migrated by moving
the database **and** reusing the original crypto secrets.

1. **Read the original secrets** from `DATA_DIR/server.env` on the source host
   (`JWT_SECRET`, `STORAGE_ENCRYPTION_KEY`, `STORAGE_ENCRYPTION_KEY_VERSION`,
   `API_KEY_SECRET`) and set them as Fly secrets with their original values.

2. **Verify the source actually has ciphertext** before assuming the key matters:

   ```powershell
   # any row here means STORAGE_ENCRYPTION_KEY is mandatory
   node -e "const D=require('better-sqlite3');const db=new D('<DATA_DIR>/storage.sqlite',{readonly:true});console.log(db.prepare(\"select count(*) c from provider_connections where api_key like 'enc:v1:%' or access_token like 'enc:v1:%' or refresh_token like 'enc:v1:%' or id_token like 'enc:v1:%'\").get())"
   ```

3. **Take a WAL-safe snapshot.** Do not copy `storage.sqlite` on its own: the
   live database is in WAL mode, so a raw copy can silently lose recent commits
   (including the credentials you are trying to move). Use SQLite's online backup
   API, or `bin/snapshot-data.sh` which does a `VACUUM INTO`.

4. **Import the snapshot** through the supported endpoint once the app is up —
   it validates integrity, requires the expected tables, and takes a pre-import
   safety backup:

   ```powershell
   # authenticated; replaces the live database, then restart the machine
   curl.exe -X POST "https://<app>.fly.dev/api/db-backups/import" `
     -H "Authorization: Bearer $env:OMNIROUTE_API_KEY" `
     -F "file=@storage.sqlite"
   fly machine restart <id> -a omniroute-memory
   ```

   Note the 100 MB default limit (`OMNIROUTE_DB_IMPORT_MAX_MB` raises it).

5. **Confirm decryption worked.** `fly logs -a omniroute-memory` must not contain
   `[Encryption] ... Cannot decrypt` or `credentialDecryptFailed`. If it does, the
   `STORAGE_ENCRYPTION_KEY` is not the one that encrypted the data — fix the secret
   and restart; do not re-enter credentials until you have ruled that out.

`omniroute backup`, `bin/snapshot-data.sh` and `GET /api/db-backups/exportAll` all
**omit** the secrets file, so none of them is a complete migration artifact by
itself.

## Verify a deployment

```powershell
fly status -a omniroute-hindsight
fly status -a omniroute-memory
fly logs   -a omniroute-memory --no-tail | Select-String "bootstrap|SQLite|MEMORY_MANAGER|memory.backends"

# OmniRoute's own backend view: primary/fallback plus per-backend health + latency
curl.exe -s https://<app>.fly.dev/api/memory/backends -H "Authorization: Bearer $env:OMNIROUTE_API_KEY"
```

Expected on a healthy OmniRoute boot:

```
[bootstrap] Secrets persisted to: /data/server.env
[DB] SQLite database ready: /data/storage.sqlite
[MEMORY_MANAGER] Registered backend {"id":"hindsight", ...}
[memory.backends.selected] {"primary":"hindsight","fallbacks":["sqlite"],"source":"environment"}
```

If those paths read `/app/data/...` instead of `/data/...`, `DATA_DIR` does not
match the volume mount and nothing is persisting.

End-to-end, through OmniRoute's real HTTP surface:

```powershell
$H = @{ Authorization = "Bearer $env:OMNIROUTE_API_KEY"; "Content-Type" = "application/json" }

# retain (Hindsight extracts facts with an LLM — this takes seconds, not ms)
curl.exe -s -X POST "https://<app>.fly.dev/api/memory" -H $H `
  -d '{"key":"deploy-check","content":"Deployment check: memory survives redeploys.","type":"factual"}'

# list: proves the durable backend reads back identity + metadata
curl.exe -s "https://<app>.fly.dev/api/memory?limit=10" -H $H
```

Then prove durability by restarting the machine and reading again:

```powershell
fly machine restart <id> -a omniroute-hindsight
# wait for /health, then repeat the GET above
```

## Operating notes

- **Stop Hindsight gracefully.** `fly machine stop` / `fly machine restart` send
  SIGTERM and let PostgreSQL shut down cleanly. Do not delete a machine while it
  is running: a killed `postmaster` leaves a stale `postmaster.pid` in the volume,
  and the next boot stalls before it ever logs a line. If that happens, remove the
  stale file (`/home/hindsight/.pg0/instances/hindsight/data/postmaster.pid`) and
  start the machine again.
- **Never scale OmniRoute above one machine.** Its configuration and fallback
  memory live in a single SQLite file; more than one writer on that file is
  unsupported (`docs/reference/ENVIRONMENT.md`).
- **`auto_stop_machines` is off for both apps.** Hindsight's background worker
  processes consolidations, and OmniRoute injects memory on the request path; a
  suspended machine would either stall consolidation or pay a cold start on the
  first memory-bearing request.
- **Upgrading Hindsight** means changing the pinned tag in `hindsight.fly.toml`.
  Hindsight runs its own database migrations on startup, and the OmniRoute adapter
  only uses endpoints present in both 0.8.6 and current releases, so a tag bump is
  the whole change — but take a volume snapshot first (`fly volumes snapshots`).
- **Back up the volume, not just the database.** Provider credentials and the
  uploaded configuration only decrypt with the `STORAGE_ENCRYPTION_KEY` stored in
  Fly secrets; keep both in whatever backup plan you trust. Fly already keeps
  scheduled volume snapshots.

## Known limitations

- Hindsight has no per-memory TTL, so OmniRoute's `expiresAt` is preserved in
  Hindsight metadata and enforced on read by the adapter rather than by the memory
  engine. Expired entries remain in Hindsight until the document is deleted.
- Hindsight's metadata type is `dict[str, str]`; OmniRoute's arbitrary nested
  metadata is carried as a JSON string under one reserved key.
- Hindsight's `memory_units` are extracted facts, not the retained blob. `search()`
  therefore returns facts (one `Memory` per fact) while `get()`/`list()` return the
  retained document. Both are intentional and covered by tests.
- `GET /documents` does not return the stored text, so a listing hydrates each row
  from `GET /documents/{id}` — bounded to 100 rows at concurrency 4.
