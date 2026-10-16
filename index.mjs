// OpenCode V2 plugin for the Kiro provider.
//
// One install does everything:
//   1. registers the `kiro` provider (OpenAI-compatible, pointed at the local bridge)
//   2. starts the bridge process if it is not already running
//
// Works on Windows, Linux, and macOS. All paths derive from this file.
//
// The provider is registered with `activation: "enabled"` and the bridge API key
// inline, so the models show up as soon as the plugin loads — no manual
// `/connect` step and no chance of falling back to a built-in provider such as
// Amazon Bedrock.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.KIRO_BRIDGE_PORT || '4141';
const HOST = process.env.KIRO_BRIDGE_HOST || '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}/v1`;
const HEALTH_URL = `http://${HOST}:${PORT}/health`;
const LOG_FILE = path.join(DIR, 'bridge.log');
const KEY_FILE = path.join(DIR, 'api-key.txt');
const NODE = process.env.KIRO_NODE || 'node';
const PROVIDER_ID = 'kiro';

const spec = JSON.parse(fs.readFileSync(path.join(DIR, 'models.json'), 'utf8'));

// The bridge gates /v1/* behind a bearer key. Reuse an existing api-key.txt, or
// generate + persist one so the plugin and the bridge always agree. Passing the
// same value as KIRO_BRIDGE_TOKEN makes it independent of the file once running.
function ensureToken() {
  const fromEnv = (process.env.KIRO_BRIDGE_TOKEN || '').split(/[\s,]+/).filter(Boolean)[0];
  if (fromEnv) return fromEnv;
  try {
    const existing = fs
      .readFileSync(KEY_FILE, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (existing.length) return existing[0];
  } catch {}
  const token = 'kiro-' + crypto.randomBytes(24).toString('base64url');
  try {
    fs.writeFileSync(KEY_FILE, token + '\n', { mode: 0o600 });
  } catch (e) {
    console.log('[kiro] could not write api-key.txt: ' + e.message);
  }
  return token;
}

const TOKEN = ensureToken();

function buildModels() {
  return Object.entries(spec.models).map(([id, m]) => ({
    id,
    modelID: id,
    providerID: PROVIDER_ID,
    name: m.name,
    capabilities: m.capabilities,
    variants: m.variants || [],
    time: { released: 0 },
    cost: [],
    status: 'active',
    enabled: m.enabled !== false,
    limit: m.limit,
    ...(m.compatibility ? { compatibility: m.compatibility } : {}),
  }));
}

// Thinking budgets per effort level (mirrors Kiro's 1024–128000 range) used to
// build the variant presets advertised for models that expose an effort enum.
const EFFORT_BUDGETS = { low: 16384, medium: 32768, high: 65536, xhigh: 98304, max: 128000 };

// Ask the bridge for the account's live catalog (Kiro is the source of truth).
// Returns null on any failure so the caller can fall back to models.json.
async function fetchLiveModels() {
  try {
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const data = Array.isArray(body?.data) ? body.data : [];
    return data.length ? data : null;
  } catch {
    return null;
  }
}

// Turn one Kiro catalog entry into the OpenCode model shape.
function mapLiveModel(m) {
  const inputs = (Array.isArray(m.supportedInputTypes) ? m.supportedInputTypes : ['TEXT']).map((t) =>
    t === 'IMAGE' ? 'image' : t === 'PDF' ? 'pdf' : 'text',
  );
  const thinking = !!m.thinking?.properties?.thinking;
  const effort = m.thinking?.properties?.output_config?.properties?.effort?.enum || [];
  const variants = effort.map((level) => ({
    id: level,
    body: { thinkingConfig: { thinkingBudget: EFFORT_BUDGETS[level] ?? 32768 } },
  }));
  const limits = m.tokenLimits || {};
  return {
    id: m.id,
    modelID: m.id,
    providerID: PROVIDER_ID,
    name: m.rateMultiplier ? `${m.name} (${m.rateMultiplier}x)` : m.name,
    capabilities: { tools: true, input: inputs.length ? inputs : ['text'], output: ['text'] },
    variants,
    time: { released: 0 },
    cost: [],
    status: 'active',
    enabled: true,
    limit: { context: limits.maxInputTokens || 200000, output: limits.maxOutputTokens || 64000 },
    ...(thinking ? { compatibility: { reasoningField: 'reasoning_content' } } : {}),
  };
}

let attempted = false;

async function ensureBridge() {
  const healthy = () =>
    fetch(HEALTH_URL, { signal: AbortSignal.timeout(1500) })
      .then((r) => r.ok)
      .catch(() => false);

  if (await healthy()) {
    console.log('[kiro] bridge already running');
    return;
  }

  // Give a concurrent instance a moment to bind before spawning another.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  if (await healthy()) {
    console.log('[kiro] bridge came up');
    return;
  }

  const out = fs.openSync(LOG_FILE, 'a');
  const child = spawn(NODE, ['server.mjs'], {
    cwd: DIR,
    detached: true,
    // windowsHide is ignored on Linux/macOS.
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: { ...process.env, KIRO_BRIDGE_TOKEN: TOKEN, ...(apiKey ? { KIRO_API_KEY: apiKey } : {}) },
  });
  child.on('error', (e) =>
    console.log('[kiro] spawn failed (' + e.message + '). Set KIRO_NODE to the node binary path.'),
  );
  child.unref();
  console.log('[kiro] started bridge (pid ' + child.pid + ')');
}

// Resolve the Kiro headless API key (ksk_...) connected through the `kiro`
// integration, if any. Passing it to the bridge lets Kiro run without OAuth
// accounts or kiro.db.
async function resolveConnectedApiKey(ctx) {
  try {
    const connection = await ctx.integration.connection.active(PROVIDER_ID);
    if (!connection) return null;
    const credential = await ctx.integration.connection.resolve(connection);
    const key =
      typeof credential === 'string'
        ? credential
        : credential?.key || credential?.value || credential?.token || credential?.apiKey;
    return typeof key === 'string' && key.trim() ? key.trim() : null;
  } catch (e) {
    console.log('[kiro] could not resolve API key: ' + (e?.message || e));
    return null;
  }
}

// Hand the connected Kiro API key to the running bridge. The key is sent over
// loopback and kept in the bridge's memory only — it is never written to disk.
async function pushApiKey(key) {
  try {
    const res = await fetch(`http://${HOST}:${PORT}/internal/api-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ key }),
    });
    if (res.ok) console.log('[kiro] API key handed to bridge');
    else console.log('[kiro] bridge rejected API key: HTTP ' + res.status);
  } catch (e) {
    console.log('[kiro] could not hand API key to bridge: ' + (e?.message || e));
  }
}

let apiKey = null;

export default {
  id: 'kiro.provider',
  async setup(ctx) {
    // Migration: earlier versions wrote the Kiro API key to disk — remove it.
    try {
      fs.rmSync(path.join(DIR, 'kiro-api-key.txt'), { force: true });
    } catch {}

    apiKey = await resolveConnectedApiKey(ctx);

    if (!attempted) {
      attempted = true;
      await ensureBridge();
    }

    if (apiKey) await pushApiKey(apiKey);

    // Register the models Kiro reports for this account. The account catalog is
    // the source of truth; models.json is only a fallback when it is unreachable.
    const live = await fetchLiveModels();
    const models = live ? live.map(mapLiveModel) : buildModels();
    console.log(
      `[kiro] registering ${models.length} models (${live ? 'live account catalog' : 'fallback models.json'})`,
    );

    await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          id: PROVIDER_ID,
          name: spec.provider.name,
          activation: 'enabled',
          package: spec.provider.package,
          settings: { baseURL: BASE_URL, apiKey: TOKEN },
        },
        models,
      });
    });

    // Register the `kiro` auth integration so a Kiro API key can be stored with
    // `opencode auth login kiro --method key` (or /connect).
    try {
      await ctx.integration.transform((editor) => {
        editor.update(PROVIDER_ID, (integration) => {
          integration.name = spec.provider.name;
        });
        editor.method.update({
          integrationID: PROVIDER_ID,
          method: { id: 'key', type: 'key', label: 'Manually enter API Key' },
        });
      });
    } catch (e) {
      console.log('[kiro] integration registration failed: ' + (e?.message || e));
    }
  },
};
