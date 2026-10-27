// OpenCode 1.x plugin for kiro-provider.
//
// index.mjs targets the OpenCode 2 plugin API, which OpenCode 1.x rejects
// ("must default export an object with server()"). This file does the same job
// with the 1.x API: start the local bridge and register the `kiro` provider.
// Load it from a file in ~/.config/opencode/plugins/ containing:
//   export { default } from '/path/to/kiro-provider/opencode-v1.mjs';
//
// It also makes subagents follow the provider of the session that spawned them
// (kiro <-> anthropic), because oh-my-openagent pins every agent to anthropic/*.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.KIRO_BRIDGE_HOST || '127.0.0.1';
const PORT = process.env.KIRO_BRIDGE_PORT || '4141';
const NODE = process.env.KIRO_NODE || 'node';
const LOCAL_KIRO_CLI = path.join(os.homedir(), '.local/bin/kiro-cli');
const KIRO_CLI = process.env.KIRO_CLI || (fs.existsSync(LOCAL_KIRO_CLI) ? LOCAL_KIRO_CLI : 'kiro-cli');
const KEY_FILE = path.join(DIR, 'api-key.txt');
const LOG_FILE = path.join(DIR, 'bridge.log');

// Bearer token the bridge requires on /v1/*: reuse api-key.txt, else create it.
function bridgeToken() {
  const fromEnv = (process.env.KIRO_BRIDGE_TOKEN || '').split(/[\s,]+/).find(Boolean);
  if (fromEnv) return fromEnv;
  if (fs.existsSync(KEY_FILE)) {
    const existing = fs.readFileSync(KEY_FILE, 'utf8').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (existing) return existing;
  }
  const token = 'kiro-' + crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(KEY_FILE, token + '\n', { mode: 0o600 });
  return token;
}

// Spawn server.mjs detached (it outlives OpenCode) unless it already answers.
async function startBridge(token) {
  const up = await fetch(`http://${HOST}:${PORT}/health`, { signal: AbortSignal.timeout(1500) }).then(
    (r) => r.ok,
    () => false,
  );
  if (up) return;
  const log = fs.openSync(LOG_FILE, 'a');
  const child = spawn(NODE, ['server.mjs'], {
    cwd: DIR,
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, KIRO_BRIDGE_TOKEN: token },
  });
  fs.closeSync(log);
  child.on('error', (e) =>
    fs.appendFileSync(LOG_FILE, `[kiro adapter] could not start bridge (${e.message}); set KIRO_NODE to your node binary\n`),
  );
  child.unref();
}

// The vendored registry is a static list that stops at Opus/Sonnet 5. kiro-cli
// reports the account's live catalog (claude-*-5.5, gpt-5.6-*, ...).
function accountModels() {
  return new Promise((resolve) => {
    const child = execFile(KIRO_CLI, ['chat', '--list-models', '--format', 'json'], { timeout: 5000 }, (err, out) => {
      try {
        if (err) throw err;
        resolve((JSON.parse(out).models ?? []).filter((m) => typeof m?.model_id === 'string'));
      } catch (e) {
        fs.appendFileSync(LOG_FILE, `[kiro adapter] no live model list from kiro-cli (${e.message}); using the static one\n`);
        resolve([]);
      }
    });
    child.stdin.end();
  });
}

// Subagents follow the provider of the session that spawned them: under a kiro
// session they run on kiro, under an anthropic session on anthropic, whatever
// model their agent pins.
const FOLLOW = new Set(['kiro', 'anthropic']);
const sessionModel = new Map(); // sessionID -> model of its latest user message
const parentOf = new Map(); // sessionID -> parentID ('' for a top-level session)

async function parentModel(client, sessionID) {
  if (!parentOf.has(sessionID)) {
    const { data } = await client.session.get({ path: { id: sessionID } });
    if (!data) return;
    parentOf.set(sessionID, data.parentID ?? '');
  }
  const parentID = parentOf.get(sessionID);
  if (!parentID) return;
  if (sessionModel.has(parentID)) return sessionModel.get(parentID);
  // Parent was last prompted before this process started: use its latest message.
  const { data } = await client.session.messages({ path: { id: parentID }, query: { limit: 1 } });
  const info = data?.at(-1)?.info;
  if (!info) return;
  return info.role === 'user' ? info.model : { providerID: info.providerID, modelID: info.modelID };
}

// The same model on the parent's provider (keeping the thinking variant when it
// exists there), else the parent's own model.
async function followParent(client, model, parent) {
  const { data } = await client.config.providers();
  const models = data?.providers.find((p) => p.id === parent.providerID)?.models ?? {};
  const base = model.modelID.replace(/-thinking$/, '').replace(/-\d{8}$/, '');
  const id = base.startsWith('claude-') ? base.replaceAll('.', '-') : base;
  const { variant } = model;
  const to = (modelID) => ({
    providerID: parent.providerID,
    modelID,
    ...(variant && models[modelID]?.variants?.[variant] && { variant }),
  });
  // kiro keeps thinking variants on "-thinking" twins (claude-opus-5-thinking).
  const thinking = variant && [id, `${id}-thinking`].find((m) => models[m]?.variants?.[variant]);
  return to(thinking || (models[id] ? id : parent.modelID));
}

let started;

export default {
  id: 'kiro.provider',
  async server({ client }) {
    const token = bridgeToken();
    started ??= startBridge(token);
    const [{ buildModelRegistry }, { THINKING_BUDGETS }, live] = await Promise.all([
      import(pathToFileURL(path.join(DIR, 'vendor/kiro-auth/dist/plugin/model-registry.js')).href),
      import(pathToFileURL(path.join(DIR, 'vendor/kiro-auth/dist/plugin/effort.js')).href),
      accountModels(),
      started,
    ]);

    const models = buildModelRegistry();
    // Add catalog models the registry lacks. Claude ids take the registry's dashed
    // form (claude-opus-5-5, as on anthropic/*) and send the Kiro id upstream.
    // Thinking goes in variants on the base id: the bridge only strips "-thinking"
    // from ids it already knows.
    const variants = Object.fromEntries(
      Object.entries(THINKING_BUDGETS).map(([level, thinkingBudget]) => [level, { thinkingConfig: { thinkingBudget } }]),
    );
    for (const m of live) {
      const claude = m.model_id.startsWith('claude-');
      const key = claude ? m.model_id.replaceAll('.', '-') : m.model_id;
      if (models[key]) {
        // The registry's windows are static guesses; the catalog has the real ones
        // (DCP limits and OpenCode's context meter are computed from them).
        const context = m.context_window_tokens;
        for (const k of [key, `${key}-thinking`])
          if (context && models[k]) models[k] = { ...models[k], limit: { ...models[k].limit, context } };
        continue;
      }
      const name = m.model_id
        .split('-')
        .map((w) => (w === 'gpt' ? 'GPT' : w.charAt(0).toUpperCase() + w.slice(1)))
        .join(' ');
      models[key] = {
        ...(key !== m.model_id && { id: m.model_id }),
        name: `${name} (${m.rate_multiplier}x)`,
        limit: { context: m.context_window_tokens || 200000, output: 64000 },
        modalities: { input: claude ? ['text', 'image'] : ['text'], output: ['text'] },
        ...(claude && { reasoning: true, interleaved: { field: 'reasoning_content' }, variants }),
      };
    }
    // Drop the models kiro-provider disables (Kiro rejects their effort field).
    const spec = JSON.parse(fs.readFileSync(path.join(DIR, 'models.json'), 'utf8'));
    for (const [id, m] of Object.entries(spec.models)) if (m.enabled === false) delete models[id];

    return {
      async 'chat.message'(input, output) {
        const msg = output.message;
        if (!msg?.model) return;
        try {
          const parent = await parentModel(client, input.sessionID);
          if (parent && FOLLOW.has(parent.providerID) && msg.model.providerID !== parent.providerID)
            msg.model = await followParent(client, msg.model, parent);
        } catch (e) {
          fs.appendFileSync(LOG_FILE, `[kiro adapter] kept ${msg.model.providerID}/${msg.model.modelID} for ${input.sessionID}: ${e.message}\n`);
        }
        sessionModel.set(input.sessionID, msg.model);
      },

      async config(cfg) {
        const user = cfg.provider?.kiro ?? {};
        cfg.provider = {
          ...cfg.provider,
          kiro: {
            name: 'AWS Kiro',
            npm: '@ai-sdk/openai-compatible',
            models,
            ...user,
            options: { baseURL: `http://${HOST}:${PORT}/v1`, apiKey: token, ...user.options },
          },
        };
      },
    };
  },
};
