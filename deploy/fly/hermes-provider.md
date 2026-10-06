# Connecting Hermes to OmniRoute

Hermes Agent is a first-class consumer of the OmniRoute gateway: it can use
OmniRoute as an OpenAI-compatible provider for both its CLI/desktop runtime and
the `hermes-germ` Sprite.

## Why a second provider slug instead of re-pointing the existing one

Hermes already ships an `omniroute` provider entry in every config:

```yaml
  omniroute:
    name: OmniRoute
    base_url: http://127.0.0.1:20128/v1
    key_env: OMNIROUTE_API_KEY
    api_mode: chat_completions
    model: auto/best-free
```

That entry is bound to the **loopback** gateway on the workstation and is the
lane the desktop UI and the FibStation bridge runner already use. Re-pointing it
at the Fly deployment would silently move that traffic and break the local lane
whenever the workstation gateway is down.

So add a **second slug** (`omniroute-cloud`) and leave `omniroute` alone. Both
stay visible in the picker.

## 1. Put the key where Hermes can read it, and nowhere else

Use a gateway key scoped `policy:auto-best-free` (+ `self:usage`) so Hermes cannot
spend metered credit by accident — the same scope the existing `fib0-agui-server`
key carries. Mint one through the dashboard or `POST /api/keys`:

```json
{ "name": "hermes-agent-cloud", "scopes": ["policy:auto-best-free", "self:usage"] }
```

Store it in the Hermes home `.env` files under a **new** name, so the loopback
lane keeps its own credential:

```powershell
# $HERMES_HOME is C:\Users\germi\AppData\Local\hermes on this workstation.
$key = '<the gateway key>'
foreach ($f in @("$env:HERMES_HOME\.env",
                 "$env:HERMES_HOME\profiles\default\.env",
                 "$env:HERMES_HOME\profiles\overseer\.env",
                 "$env:HERMES_HOME\profiles\hermes-research\.env")) {
  if ((Test-Path $f) -and -not (Select-String -Path $f -Pattern '^OMNIROUTE_CLOUD_API_KEY=' -Quiet)) {
    Add-Content -Path $f -Value "OMNIROUTE_CLOUD_API_KEY=$key"
  }
}
```

The key must never be committed. `.env` files are ignored by both repositories;
keep it that way.

## 2. Add the provider entry

Append to the `providers:` mapping in `$HERMES_HOME\config.yaml` and in each
`profiles\<name>\config.yaml` that should see it:

```yaml
  omniroute-cloud:
    name: OmniRoute (Fly)
    base_url: https://omniroute-memory.fly.dev/v1
    key_env: OMNIROUTE_CLOUD_API_KEY
    api_mode: chat_completions
    model: auto/best-free
```

Two details that are easy to get wrong:

- **`/v1` must be on the base URL.** Hermes appends the OpenAI path itself; a
  base of `https://omniroute-memory.fly.dev` produces 404s.
- **Keep `api_mode: chat_completions`.** An unrecognised `api_mode` is silently
  ignored and the transport falls back to hostname guessing
  (`hermes_cli/config_providers.py`), which can flip a working provider to a
  different protocol after an upgrade.

Hermes' own tool guardrail refuses automated `patch`/`write_file` against the
**root** `config.yaml`. Profile configs under `profiles/<name>/config.yaml` are
not guarded, so scripted edits should target those and the root entry should be
made by hand or through the dashboard's provider form.

## 3. Verify

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" https://omniroute-memory.fly.dev/v1/models `
  -H "Authorization: Bearer $env:OMNIROUTE_CLOUD_API_KEY"   # expect 200
```

Then confirm the slug resolves in Hermes itself (`hermes doctor`, or the provider
picker in `hermes dashboard` on 127.0.0.1:9119). Do not launch the CLI while
`$HERMES_HOME\.hermes-update-in-progress` exists — it holds a live updater PID.

## 4. The `hermes-germ` Sprite

The Sprite runs its own Hermes home, so it needs the same two changes applied
inside the Sprite (it does **not** read the workstation's config):

1. Add `OMNIROUTE_CLOUD_API_KEY=<key>` to the Sprite's Hermes `.env`.
2. Add the same `providers.omniroute-cloud` block to its config/profile configs.

This must be done over the Sprites control plane (`mcp__sprites__*` tools,
`exec` against sprite `hermes-germ`). The Sprites skill explicitly forbids
substituting the `sprite` CLI or raw HTTP for that channel, so if the tools are
not available in a session the change has to wait rather than be improvised.

A Sprite needs outbound network access to `omniroute-memory.fly.dev`. Check the
Sprite's network policy before assuming a failure is an auth problem.

### Note on `hermes-germ.fly.dev`

The FibStation hub is configured with
`FIB_HERMES_BASE_URL = 'https://hermes-germ.fly.dev/v1'`. That hostname does not
resolve (checked 2026-10-06), and the `hermes` route is first in FibStation's AI
chain, so it is a dead first hop. It is unrelated to this OmniRoute provider
entry and needs its own decision.
