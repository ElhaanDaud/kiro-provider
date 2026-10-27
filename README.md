# OpenCode Kiro Provider

Adds the **AWS Kiro (CodeWhisperer)** models (Claude Sonnet/Opus/Haiku,
DeepSeek, GLM, MiniMax, Qwen) to OpenCode as `kiro/<model>`, through a local
OpenAI-compatible bridge that talks to Kiro.

This is a fork of [steverova/kiro-provider](https://github.com/steverova/kiro-provider)
that also runs on **OpenCode 1.x**. Pick the plugin for your OpenCode version
(`opencode --version`):

| OpenCode | Plugin | Setup |
| --- | --- | --- |
| 1.x | `opencode-v1.mjs` | [Linux setup (OpenCode 1.x)](#linux-setup-opencode-1x) |
| V2 | `index.mjs` | [Quick start (OpenCode V2)](#quick-start-opencode-v2) |

```
OpenCode 1.x / V2 ──(OpenAI /v1/chat/completions)──▶ bridge (127.0.0.1:4141)
   ▲                                                    │
   └── plugin registers provider + starts bridge        └─▶ AWS Kiro (CodeWhisperer)
```

## What this fork adds

- **OpenCode 1.x plugin** (`opencode-v1.mjs`). `index.mjs` uses the V2 plugin
  API, which OpenCode 1.x rejects (`must default export an object with
  server()`), so `kiro` never shows up. The 1.x plugin starts the same bridge and
  registers the same `kiro` provider.
- **Your account's models, including 5.5** (1.x plugin). The bundled model list
  stops at Opus/Sonnet 5, and the bridge's live list only works with an API key.
  The plugin reads `kiro-cli chat --list-models` and adds what is missing:
  `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `gpt-5.6-sol`,
  `gpt-5.6-terra`, `gpt-5.6-luna`, ...
- **Subagents follow the session's provider** (1.x plugin). Subagents started
  from a `kiro/...` session run on kiro, and from an `anthropic/...` session on
  anthropic, even when their agent pins an `anthropic/...` model (as every
  oh-my-openagent agent does). See [Subagents](#subagents).
- **Token refresh in your Identity Center region** (both plugins). The kiro-cli
  sync refreshed tokens in the region of the Kiro profile ARN (`us-east-1`), so
  Identity Center logins from another region (e.g. `ap-south-1`) failed with
  `Refresh failed: Invalid request`. It now uses the region kiro-cli's token was
  issued in (`vendor/kiro-auth/dist/plugin/sync/kiro-cli.js`).
- **Long sessions no longer fail with `Input is too long`** (both plugins). Kiro
  rejects any conversation with 200 or more history messages, however few
  tokens they hold, and each round of tool calls adds two. OpenCode took the
  error for a full context window and compacted the session. The bridge now
  folds the oldest messages into a plain-text transcript once the history passes
  180 (`vendor/kiro-auth/dist/infrastructure/transformers/history-builder.js`).
  See [Long sessions and DCP](#long-sessions-and-dcp).
- **Real token counts** (both plugins). Kiro reports context use as a percentage
  of the model's window, and the bridge read it against 200K for nearly every
  model, so 1M models reported a fifth of the tokens they used, to OpenCode's
  context meter and to DCP alike. It now uses each model's window from
  `kiro-cli chat --list-models` (the bundled list without kiro-cli), and the 1.x
  plugin gives OpenCode the same windows.

## Linux setup (OpenCode 1.x)

Tested with OpenCode 1.19.3, Node.js 24 and kiro-cli 2.34, signed in through IAM
Identity Center.

### 1. Requirements

- **OpenCode 1.x**: `opencode --version` prints `1.*`.
- **Node.js 20.11+** with npm, and **git**.
- **Kiro CLI**, to sign in and to read your model list:

  ```bash
  curl -fsSL https://cli.kiro.dev/install | bash
  kiro-cli --version
  ```

### 2. Sign in to Kiro

```bash
# Kiro through your organisation (IAM Identity Center)
kiro-cli login --license pro \
  --identity-provider https://<your-org>.awsapps.com/start \
  --region <identity-center-region>

# or Builder ID, Google or GitHub
kiro-cli login --license free
```

Add `--use-device-flow` on a machine without a browser (e.g. over SSH). Then
check:

```bash
kiro-cli whoami                # account and Kiro profile
kiro-cli chat --list-models    # the models you will get as kiro/...
```

OpenCode needs no credentials of its own: the bridge copies the kiro-cli login
into `~/.config/opencode/kiro.db` when it starts and refreshes it from there. To
use a Kiro API key instead, see [API key](#api-key).

### 3. Clone and install

```bash
git clone https://github.com/ElhaanDaud/kiro-provider.git ~/.local/opt/kiro-provider
cd ~/.local/opt/kiro-provider
npm install
```

Any folder works. The bridge runs from it and keeps `api-key.txt` (its local
bearer token) and `bridge.log` there.

### 4. Load the plugin

OpenCode 1.x loads every `.js` and `.ts` file in `~/.config/opencode/plugins/`.
Add one that re-exports the plugin from your clone:

```bash
mkdir -p ~/.config/opencode/plugins
echo "export { default } from '$HOME/.local/opt/kiro-provider/opencode-v1.mjs';" \
  > ~/.config/opencode/plugins/kiro-provider.js
```

- Keep the `.js` extension (`.mjs` files there are not loaded) and the absolute
  path.
- Leave `opencode.json` alone: adding this repo with `opencode plugin` or to the
  `plugin` list loads `index.mjs`, the V2 plugin. Files in `plugins/` also load
  after the `plugin` list, so the subagent routing runs after other plugins
  (like oh-my-openagent) have picked a model.

### 5. Check it

```bash
opencode models kiro           # lists the kiro/... models (and starts the bridge)
curl -s http://127.0.0.1:4141/health
# {"status":"ok","ready":true,"auth":"accounts","accounts":1,"region":"us-east-1"}
opencode run -m kiro/claude-haiku-4-5 "Reply with exactly: pong"
```

In the TUI, pick a `kiro/...` model with `/models`.

## Using it on OpenCode 1.x

### Thinking

Claude models take a thinking budget as a variant, `low` to `max` (16K to 128K
tokens): on the `-thinking` ids for the bundled models
(`kiro/claude-opus-5-thinking`), on the plain id for the models added from your
account (`kiro/claude-opus-5-5`). Use `--variant` with `opencode run`, or
`ctrl+t` in the TUI:

```bash
opencode run -m kiro/claude-opus-5-thinking --variant high "..."
```

In testing, Kiro returned no reasoning text for the 5.5 models, even at `max`.

### Subagents

When a session on `kiro` or `anthropic` starts a subagent (OpenCode's `task`
tool, oh-my-openagent's agents), the subagent is moved to that provider. It keeps
its agent's model where the provider has it:

| Agent's model | Under a `kiro/...` session |
| --- | --- |
| `anthropic/claude-opus-4-8`, variant `low` | `kiro/claude-opus-4-8-thinking`, variant `low` |
| `anthropic/claude-opus-5`, variant `max` | `kiro/claude-opus-5-thinking`, variant `max` |
| `anthropic/claude-opus-5-5` | `kiro/claude-opus-5-5` |
| `anthropic/claude-haiku-4-5-20251001` | `kiro/claude-haiku-4-5` |
| one kiro lacks, e.g. `anthropic/claude-fable-5-1` | the session's own model |

Under an `anthropic/...` session it works the other way round, e.g.
`kiro/claude-opus-5-thinking` becomes `anthropic/claude-opus-5`.

- Model ids are compared without `-thinking` or a date suffix, with `.` read as
  `-`. A variant is kept only if the new model has it.
- Top-level sessions are never changed, and sessions on any other provider leave
  their subagents alone.
- If the lookup fails, the subagent keeps its agent's model and `bridge.log`
  gets a `[kiro adapter] kept ...` line.
- Subagents can run in parallel: the bridge queues a request only until Kiro
  starts streaming the reply, and allows 120 requests a minute
  (`KIRO_BRIDGE_RATE_LIMIT`).

### Long sessions and DCP

Kiro accepts at most 200 messages of history, and each round of tool calls adds
two. Past 180, the bridge turns the oldest messages into one plain-text
transcript at the start of the conversation, in steps of 100 so that the start
stays the same from one request to the next. The model still sees what happened
there, as text; images in that part are left out.

To have DCP (`@tarquinen/opencode-dcp`) manage the context alone, with no
compaction, set these (tested with DCP 3.2.0 and oh-my-openagent 5.1.35):

- `~/.config/opencode/opencode.json`: turn off OpenCode's auto-compaction. It is
  a global setting, so it covers every provider.

  ```json
  "compaction": { "auto": false }
  ```

- `~/.omo/omo.jsonc`, if you use oh-my-openagent: its
  `anthropic-context-window-limit-recovery` hook compacts the session after a
  "too long" error from any provider, not just Anthropic.

  ```jsonc
  "[opencode]": { "disabled_hooks": ["anthropic-context-window-limit-recovery"] }
  ```

- `~/.config/opencode/dcp.jsonc`: give the limits as a share of each model's
  window, so they fit 200K and 1M models alike, and run DCP in subagents too.

  ```jsonc
  "compress": { "maxContextLimit": "60%", "minContextLimit": "40%" },
  "experimental": { "allowSubAgents": true }
  ```

DCP goes by the token counts the bridge reports, which are now the real ones. A
session that does fill its model's window stops with an error instead of being
compacted; run `/compact` yourself or start a new session.

### The bridge

When OpenCode starts, the plugin starts the bridge in the background unless it
is already running, and leaves it running when OpenCode exits. Restart it after
updating, changing a `KIRO_*` variable or signing in to another account:

```bash
fuser -k 4141/tcp                              # stop; the next OpenCode start brings it back
cd ~/.local/opt/kiro-provider && npm start     # or run it in the foreground
```

To update:

```bash
cd ~/.local/opt/kiro-provider && git pull && npm install && fuser -k 4141/tcp
```

then restart OpenCode.

### API key

The 1.x plugin doesn't add `opencode auth login kiro`. To use a Kiro API key
(`ksk_...`) instead of the kiro-cli login, put it in the environment OpenCode
starts from, e.g. in `~/.bashrc`:

```bash
export KIRO_API_KEY=ksk_...
```

Then stop the bridge (`fuser -k 4141/tcp`) and start OpenCode from a new shell;
`/health` reports `"auth":"api_key"`. The model list still comes from kiro-cli,
or from the bundled list without it.

### Troubleshooting (OpenCode 1.x)

`bridge.log` is in the clone; `grep 'kiro adapter' bridge.log` shows the
plugin's own messages.

| Symptom | Fix |
| --- | --- |
| `Provider not found: kiro`, or no `kiro/...` models | The plugin isn't loaded. Check that `~/.config/opencode/plugins/kiro-provider.js` ends in `.js` and imports the absolute path of `opencode-v1.mjs`, and remove this repo from the `plugin` list in `opencode.json` if you added it. |
| No 5.5 or GPT 5.6 models | `bridge.log` says `no live model list from kiro-cli`: sign in with `kiro-cli login`, or set `KIRO_CLI` to the kiro-cli binary. |
| Bridge not running (`curl` gets no answer) | `bridge.log` says `could not start bridge`: OpenCode can't find `node` (common with nvm or desktop launchers). Set `KIRO_NODE` to the output of `command -v node`. |
| `Refresh failed: Invalid request` | Your Identity Center is outside `us-east-1` and the clone predates the region fix. `git pull`, then restart the bridge. |
| A subagent doesn't follow the session's provider | Only sessions on `kiro` or `anthropic` are followed. A `kept ...` line in `bridge.log` gives the reason. |
| `/health` says `"region":"us-east-1"`, but your Identity Center is elsewhere | Expected. `/health` shows `default_region` from `kiro.json`; requests go to the region of your Kiro profile (`kiro-cli whoami`), token refresh to your Identity Center region. |
| `input is too long for requested model` | Usually the conversation no longer fits the model's window: run `/compact` or start a new session. A clone from before the history fold gets it after about 100 rounds of tool calls: `git pull`, then restart the bridge. |
| A session is compacted although `"compaction": { "auto": false }` is set | oh-my-openagent compacted it (toast `Context Limit Hit`). Disable its hook as in [Long sessions and DCP](#long-sessions-and-dcp). |

## Quick start (OpenCode V2)

One install does everything: the plugin **registers the `kiro` provider**, adds
the **`kiro` auth integration**, and **starts a local bridge** that talks to
Kiro. Works on **Windows, Linux, and macOS**.

```bash
# 1. Install the plugin (only appends one entry to your config)
opencode plugin add github:ElhaanDaud/kiro-provider

# 2. Connect your Kiro API key (ksk_...)
opencode auth login kiro --method key

# 3. Reload and pick a kiro/... model
opencode reload
```

## Requirements (OpenCode V2)

- **Node.js 20.11+** (the plugin spawns the bridge with `node`; override with
  `KIRO_NODE`).
- **OpenCode V2**.
- A **Kiro API key** (`ksk_...`) **or** a Kiro account in `kiro.db` (see
  Authentication). API keys are available to Kiro Pro, Pro+, Pro Max, and Power
  subscribers; generate one at <https://app.kiro.dev> → **API Keys**.

## Install (OpenCode V2)

```bash
opencode plugin add github:ElhaanDaud/kiro-provider
opencode reload
```

This command **only adds** the plugin to the `plugins` array in your global
`~/.config/opencode/opencode.json`; it never replaces the rest of your config.
Verify with:

```bash
opencode plugin list      # shows: kiro.provider  <commit>  https://github.com/ElhaanDaud/kiro-provider.git
```

Once loaded, the plugin registers the `kiro` provider by itself, so there is no
manual provider setup. Pick a model with `/models` — you'll see `kiro/...`.

## Authentication

The bridge can authenticate to Kiro in two ways. **Option A (API key)** is
recommended on OpenCode V2. On OpenCode 1.x, use Option B (as the
[Linux setup](#linux-setup-opencode-1x) does) or set [`KIRO_API_KEY`](#api-key).

### Option A — Kiro API key (recommended)

1. Generate a key at <https://app.kiro.dev> → **API Keys** (Pro/Pro+/Pro
   Max/Power).
2. Connect it:

   ```bash
   opencode auth login kiro --method key
   ```

   Paste your `ksk_...` key when prompted. In the TUI you can use `/connect` →
   **AWS Kiro** → *Manually enter API Key* instead.

3. Reload so the plugin picks it up:

   ```bash
   opencode reload
   ```

The plugin passes the key to the bridge **in memory** (over loopback only); it is
never written to disk, and no `kiro.db` is needed. Verify:

```bash
curl http://127.0.0.1:4141/health
# {"status":"ok","ready":true,"auth":"api_key","accounts":null,"region":"api-key"}
```

`"auth":"api_key"` means the key is in use. You can also set the key with the
`KIRO_API_KEY` environment variable instead of logging in (the plugin passes the
environment through to the bridge).

### Option B — OAuth accounts (fallback)

Without an API key, the bridge can use the accounts in **`kiro.db`**:

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\opencode\kiro.db` |
| Linux / macOS | `~/.config/opencode/kiro.db` |

Fill it by signing in with the **Kiro CLI** (`kiro-cli login`); on start the
bridge syncs the tokens from the Kiro CLI database into `kiro.db` (enabled by
default via `auto_sync_kiro_cli`). Accounts already in `kiro.db` are used
directly.

```bash
curl http://127.0.0.1:4141/health
# {"status":"ok","ready":true,"auth":"accounts","accounts":1,"region":"us-east-1"}
```

> The bridge also requires a bearer key on every `/v1/*` request (except
> `/health`). The plugin **generates this key on first run**, stores it in
> `api-key.txt`, and injects it into the provider — no action needed. It is a
> local gate, unrelated to your Kiro API key.

## Configuration

Optional settings live in `kiro.json`, auto-created with defaults on first run:

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\opencode\kiro.json` |
| Linux / macOS | `~/.config/opencode/kiro.json` |

Useful keys: `default_region` (`us-east-1`), `account_selection_strategy`
(`lowest-usage`, `sticky`, or `round-robin`), and `auto_sync_kiro_cli`
(`true`).

Environment variables (optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `KIRO_API_KEY` | – | Kiro API key (`ksk_...`); alternative to `auth login`, and the only way to pass one on OpenCode 1.x. |
| `KIRO_BRIDGE_RATE_LIMIT` | `120` | Max requests per minute per token (`0` disables). |
| `KIRO_BRIDGE_PORT` | `4141` | Bridge port; must match the provider `baseURL`. |
| `KIRO_BRIDGE_HOST` | `127.0.0.1` | Bind address. |
| `KIRO_BRIDGE_TOKEN` | – | Extra accepted bridge key(s), comma/space separated. |
| `KIRO_NODE` | `node` | Node binary used to spawn the bridge. |
| `KIRO_CLI` | `~/.local/bin/kiro-cli`, else `kiro-cli` on `PATH` | kiro-cli the 1.x plugin reads your model list from, and the bridge the models' context windows. |
| `KIROCLI_DB_PATH` | – | Override the Kiro CLI database path used for sync. |

## Models

`-thinking` models stream reasoning in `reasoning_content`.

On OpenCode 1.x the plugin also adds the models your account lists in
`kiro-cli chat --list-models`, and takes every model's context window from that
list. Claude ids use dashes as on `anthropic/...`
(`kiro/claude-opus-5-5` requests `claude-opus-5.5`), and the names show the
credit multiplier, e.g. `Claude Opus 5.5 (2x)`.

Disabled because Kiro rejects the effort field on them
(`additionalModelRequestFields is not supported for this model`):

- `claude-sonnet-4-5-thinking`
- `claude-opus-4-5-thinking`

To change the list, edit `DISABLED_MODELS` in `gen-models.mjs`, run
`npm run gen-models`, and commit `models.json`.

## Install from a local clone (OpenCode V2)

```powershell
git clone https://github.com/ElhaanDaud/kiro-provider.git kiro-provider
cd kiro-provider
npm install
```

Then add the folder to `plugins` in your global `opencode.json` (this preserves
every other setting — it only appends one entry):

```json
{
  "plugins": [
    "C:/Users/you/Documents/kiro-provider"
  ]
}
```

Run `opencode reload`, then connect your API key as in Authentication.
`npm start` runs the bridge manually if you don't want the plugin to spawn it.

## Troubleshooting (OpenCode V2)

| Symptom | Fix |
| --- | --- |
| Provider missing / 0 models | `opencode reload`, then check `opencode plugin list`. |
| `No accounts` / request errors | Connect a key: `opencode auth login kiro --method key`, then `opencode reload`. Check `/health` reports `"auth":"api_key"`. |
| `/health` shows `accounts: 0` (OAuth) | Sign in with `kiro-cli login`, or set `KIROCLI_DB_PATH` if your Kiro CLI database is elsewhere. Check `bridge.log`. |
| `Kiro Error: 400/403` (API key) | The key must match its region and be entitled. Check `default_region` and regenerate the key. |
| `Kiro Error: 400/403` (OAuth) | Account problem in `kiro.db`. Sign in again (`kiro-cli login`); a Pro account may need a `profileArn`. |
| `Integration not found: kiro` | The plugin is not loaded. `opencode plugin list`, then `opencode reload`. |
| Bridge unreachable | `curl http://127.0.0.1:4141/health`; check `bridge.log`. |
| Autostart does nothing | Ensure `node` is on PATH or set `KIRO_NODE`; check `bridge.log`. |
| `database is locked` | Two bridges ran at once. The bridge binds the port first, so duplicates exit early; kill stray `node server.mjs` processes if needed. |

## Files

| File | Role |
| --- | --- |
| `index.mjs` | The OpenCode V2 plugin: registers the provider + integration, starts the bridge. |
| `opencode-v1.mjs` | The OpenCode 1.x plugin: starts the bridge, registers the provider with your account's models, routes subagents. |
| `server.mjs` | Local OpenAI-compatible bridge; supports API-key and OAuth auth. |
| `vendor/kiro-auth/` | Vendored Kiro internals (MIT, from `@zhafron/opencode-kiro-auth`). |
| `models.json` | Model metadata (generated), so the plugin never imports SQLite. |
| `gen-models.mjs` | Regenerates `models.json` from the Kiro registry. |
| `login.mjs` | Runs `opencode auth login kiro --method key`. |
| `spike.mjs` | Quick check that the plugin internals work standalone. |

## How it works

- On setup, the plugin calls `ctx.provider.transform` to add the `kiro` provider
  (package `@opencode/ai/providers/openai-compatible`, `baseURL`
  `http://127.0.0.1:4141/v1`) with all models from `models.json`.
- It registers the `kiro` auth integration with a `key` method, so
  `opencode auth login kiro --method key` (or `/connect`) can store a Kiro API
  key.
- It resolves the stored key and hands it to the bridge in memory, then probes
  `/health`; if the bridge is down it spawns `server.mjs` detached (surviving
  OpenCode closing), appending output to `bridge.log`.
- The bridge calls Kiro's CodeWhisperer endpoint and speaks the OpenAI Chat
  Completions API, including `reasoning_content` for thinking models.
  - **API key:** sends `Authorization: Bearer <ksk_...>` with the
    `tokentype: API_KEY` header. The key lives in the bridge's memory only.
  - **OAuth:** rotates and refreshes the accounts in `kiro.db`.
  - Kiro accepts at most 200 history messages, so past 180 the bridge folds the
    oldest into one plain-text transcript.
  - Kiro sends no token counts, only how full the context is in percent; the
    bridge multiplies that by the model's window (from kiro-cli, else the
    bundled list).

On OpenCode 1.x, `opencode-v1.mjs` starts the bridge the same way and adds the
provider through the 1.x `config` hook (package `@ai-sdk/openai-compatible`),
with the bundled models plus those from `kiro-cli chat --list-models`. Its
`chat.message` hook moves each subagent's model to the provider of the session
that started it. It registers no auth integration.

## Why this exists

The popular plugin `@zhafron/opencode-kiro-auth` is written for the **V1** plugin
API and **does not load in OpenCode V2**
(`Plugin must export a default definition with an id and an effect or setup function`).

This project **vendors its internals** under `vendor/kiro-auth` (MIT, by
tickernelz) — auth, account rotation, token refresh, request/stream translation —
behind a small local OpenAI-compatible bridge, and wires it into OpenCode with a
native V2 plugin. There is no runtime dependency on the original package and no
build step.

OpenCode 1.x has the opposite problem: it rejects V2 plugins like `index.mjs`,
so this fork adds `opencode-v1.mjs`.

## Security

- The Kiro API key is held **in memory only** in the bridge. The plugin sends it
  over loopback (`127.0.0.1`) and it is never written to disk or logs. On
  OpenCode 1.x the key comes from `KIRO_API_KEY`, so it is as private as the
  place you set it.
- Every `/v1/*` request requires a bearer token; `/internal/api-key` (used to
  update the key) additionally requires the plugin's own bridge key.
- Secrets are redacted from `bridge.log`.
- The bridge binds to `127.0.0.1` by default. If you override
  `KIRO_BRIDGE_HOST`, it logs a warning — never expose it to untrusted networks.
- A per-token rate limit (`KIRO_BRIDGE_RATE_LIMIT`, default 120/min) protects
  your Kiro quota from a runaway client.
- If a Kiro API key may have leaked, rotate it at <https://app.kiro.dev>, then
  `opencode auth logout` and `opencode auth login kiro --method key` again.

## Notes

- `node_modules/`, `api-key.txt` and `bridge.log` are git-ignored. **Never commit
  them** — `api-key.txt` is a local bridge secret.
- Installing with `opencode plugin add` appends a single entry to your global
  `plugins` array; it never rewrites the rest of the configuration.
