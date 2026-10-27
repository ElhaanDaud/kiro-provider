// Kiro OpenAI-compatible bridge for OpenCode V2.
//
// Vendored Kiro internals (auth, account rotation, token refresh, request and
// stream translation) — see vendor/kiro-auth. Exposes a local OpenAI-compatible
// API that OpenCode's @opencode/ai/providers/openai-compatible runtime talks to.
//
// The HTTP port is bound first so a duplicate instance exits before it touches
// the shared SQLite database. Provider internals initialize lazily on the first
// /v1 request (or a /health probe).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

// The plugin internals open the shared SQLite database at module import time,
// so they are imported lazily inside init(), after this process owns the port.
const PKG = './vendor/kiro-auth/dist';
const DIR = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.KIRO_BRIDGE_PORT || 4141);
const HOST = process.env.KIRO_BRIDGE_HOST || '127.0.0.1';
const START_DIR = process.env.KIRO_PROJECT_DIR || DIR;
const KEY_PATH = path.join(DIR, 'api-key.txt');

// Redact secrets (Kiro API keys, bridge keys) from anything we log or return.
function redact(value) {
  return String(value ?? '')
    .replace(/ksk_[A-Za-z0-9._-]+/g, 'ksk_[redacted]')
    .replace(/kiro-[A-Za-z0-9._-]{16,}/g, 'kiro-[redacted]');
}

// NTFS ignores POSIX file modes, so the bridge token file would inherit the
// folder ACL (readable by other local accounts). Restrict it to the current
// user explicitly. No-op off Windows.
function hardenFile(file) {
  if (process.platform !== 'win32') return;
  const user = process.env.USERNAME;
  if (!user) return;
  try {
    execFile('icacls', [file, '/inheritance:r', '/grant:r', `${user}:(F)`], () => {});
  } catch {}
}

// Kiro headless API key (prefixed "ksk_"). Held in memory only: seeded from
// KIRO_API_KEY at startup and updated at runtime through the authenticated
// /internal/api-key endpoint. It is never written to disk.
let currentApiKey = (process.env.KIRO_API_KEY || '').trim() || null;

function resolveApiKey() {
  return currentApiKey;
}

// Lazily loaded dependencies for the API-key path. Kept out of init() so the
// SQLite-backed OAuth path is never touched when a key is configured.
let apiKeyDepsPromise = null;
function loadApiKeyDeps() {
  if (!apiKeyDepsPromise) {
    apiKeyDepsPromise = (async () => {
      const [configMod, requestMod, responseMod, sdk, registryMod] = await Promise.all([
        import(`${PKG}/plugin/config/index.js`),
        import(`${PKG}/plugin/request.js`),
        import(`${PKG}/core/request/response-handler.js`),
        import('@aws/codewhisperer-streaming-client'),
        import(`${PKG}/plugin/model-registry.js`),
      ]);
      return {
        config: configMod.loadConfig(START_DIR),
        transformToSdkRequest: requestMod.transformToSdkRequest,
        ResponseHandler: responseMod.ResponseHandler,
        GenerateAssistantResponseCommand: sdk.GenerateAssistantResponseCommand,
        CodeWhispererStreamingClient: sdk.CodeWhispererStreamingClient,
        buildModelRegistry: registryMod.buildModelRegistry,
      };
    })();
  }
  return apiKeyDepsPromise;
}

// One client per region+key; the API key is region-scoped. Bounded so a long
// running bridge cannot accumulate clients.
const MAX_CACHED_CLIENTS = 8;
const apiKeyClients = new Map();
function apiKeyClient(deps, apiKey, region) {
  const cacheKey = `${region}:${apiKey.slice(-8)}`;
  const cached = apiKeyClients.get(cacheKey);
  if (cached) return cached;
  const client = new deps.CodeWhispererStreamingClient({
    region,
    endpoint: `https://q.${region}.amazonaws.com`,
    token: () => Promise.resolve({ token: apiKey }),
    maxAttempts: 3,
    retryMode: 'standard',
    customUserAgent: [['KiroIDE']],
  });
  // API keys require the tokentype header; without it Kiro rejects the bearer.
  client.middlewareStack.add(
    (next) => async (args) => {
      args.request.headers['tokentype'] = 'API_KEY';
      args.request.headers['Origin'] = 'AI_EDITOR';
      args.request.headers['x-amzn-kiro-agent-mode'] = 'vibe';
      return next(args);
    },
    { step: 'build', name: 'apiKeyHeaders' },
  );
  if (apiKeyClients.size >= MAX_CACHED_CLIENTS) {
    const oldest = apiKeyClients.keys().next().value;
    try {
      apiKeyClients.get(oldest)?.destroy();
    } catch {}
    apiKeyClients.delete(oldest);
  }
  apiKeyClients.set(cacheKey, client);
  return client;
}

// Replace the active Kiro API key at runtime (called by the plugin through the
// authenticated /internal/api-key endpoint). Changing it drops cached clients
// so the next request uses the new key.
function setApiKey(key) {
  const next = typeof key === 'string' && key.trim() ? key.trim() : null;
  if (next === currentApiKey) return false;
  currentApiKey = next;
  for (const client of apiKeyClients.values()) {
    try {
      client.destroy();
    } catch {}
  }
  apiKeyClients.clear();
  return true;
}

const log = (...a) =>
  console.log(new Date().toISOString(), ...a.map((v) => (typeof v === 'string' ? redact(v) : v)));
const toast = (message, variant) => {
  if (variant === 'error') log(`[toast:${variant}] ${message}`);
  else log(`[toast:${variant}] ${message}`);
};

// Accepted bearer tokens. api-key.txt may contain one or more keys (one per
// line): the generated local token and/or whatever key you chose at
// `opencode auth login kiro --method key`.
function loadKeys() {
  const keys = new Set();
  if (process.env.KIRO_BRIDGE_TOKEN) {
    for (const k of process.env.KIRO_BRIDGE_TOKEN.split(/[\s,]+/)) if (k.trim()) keys.add(k.trim());
  }
  if (fs.existsSync(KEY_PATH)) {
    for (const line of fs.readFileSync(KEY_PATH, 'utf8').split(/\r?\n/)) if (line.trim()) keys.add(line.trim());
    hardenFile(KEY_PATH);
  }
  if (keys.size === 0) {
    const token = 'kiro-' + crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(KEY_PATH, token + '\n', { mode: 0o600 });
    hardenFile(KEY_PATH);
    keys.add(token);
  }
  return keys;
}
const KEYS = loadKeys();

// --- Lazy provider state (built after the port is bound) --------------------

let state = null;
let readyPromise = null;

async function init() {
  const [{ loadConfig }, { AccountCache }, { AccountRepository }, { AccountManager }, { AuthHandler }, { RequestHandler }, { buildModelRegistry }] =
    await Promise.all([
      import(`${PKG}/plugin/config/index.js`),
      import(`${PKG}/infrastructure/database/account-cache.js`),
      import(`${PKG}/infrastructure/database/account-repository.js`),
      import(`${PKG}/plugin/accounts.js`),
      import(`${PKG}/core/auth/auth-handler.js`),
      import(`${PKG}/core/request/request-handler.js`),
      import(`${PKG}/plugin/model-registry.js`),
    ]);

  const config = loadConfig(START_DIR);
  const region = config.default_region || 'us-east-1';
  const repository = new AccountRepository(new AccountCache(60000));
  const accountManager = await AccountManager.loadFromDisk(config.account_selection_strategy);
  const authHandler = new AuthHandler(config, repository);
  authHandler.setAccountManager(accountManager);

  log(`provider ready: region=${region} strategy=${config.account_selection_strategy} accounts=${accountManager.getAccountCount()}`);
  try {
    await authHandler.initialize(toast);
    log('auth handler initialized');
  } catch (e) {
    log('auth handler init failed (continuing):', e?.message || e);
  }

  const requestHandler = new RequestHandler(accountManager, config, repository, undefined);
  state = { config, region, accountManager, requestHandler, registry: buildModelRegistry() };
  log(`provider initialized (${Object.keys(state.registry).length} models)`);
  return state;
}

function ensureReady() {
  if (state) return Promise.resolve(state);
  if (!readyPromise) readyPromise = init();
  return readyPromise;
}

// --- HTTP helpers -----------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// Stream an upstream body to the client. An error mid-stream (for example Kiro's
// "InternalServerException: Encountered unexpectedly high load" carrying
// MODEL_TEMPORARILY_UNAVAILABLE) surfaces as an 'error' event on the Node
// Readable. Without a listener Node treats it as unhandled and kills the whole
// bridge process, so every later request gets ConnectionRefused. Fail just this
// response instead: close the client socket if the response already started.
function pipeUpstreamBody(upstream, res) {
  const source = Readable.fromWeb(upstream.body);
  source.on('error', (e) => {
    log('upstream stream error:', redact(e?.message || e));
    if (res.headersSent) {
      try {
        res.destroy();
      } catch {}
      return;
    }
    try {
      sendJson(res, 502, { error: { message: redact(e?.message || String(e)), type: 'api_error' } });
    } catch {}
  });
  // Client disconnected or wrote back an error: stop pulling from upstream
  // instead of letting the rejection escape.
  res.on('error', () => {
    try {
      source.destroy();
    } catch {}
  });
  res.on('close', () => {
    try {
      source.destroy();
    } catch {}
  });
  source.pipe(res);
}

function presentedTokens(req) {
  const auth = (req.headers['authorization'] || '').toString();
  const bearer = auth.replace(/^Bearer\s+/i, '').trim();
  const apiKey = (req.headers['x-api-key'] || req.headers['api-key'] || '').toString().trim();
  return [bearer, apiKey].filter(Boolean);
}

function authorized(req) {
  const presented = presentedTokens(req);
  const kiroKey = resolveApiKey();
  // API-key mode: ONLY the Kiro API key may call the API. The local bridge token
  // is not a credential for /v1/* (it is only used by the /internal endpoint).
  if (kiroKey) return presented.includes(kiroKey);
  // OAuth mode (no API key configured): fall back to the local bridge token.
  if (KEYS.size === 0) return true;
  return presented.some((token) => KEYS.has(token));
}

// Fixed-window rate limit per presented token, to keep a runaway local client
// from burning the Kiro quota. Set KIRO_BRIDGE_RATE_LIMIT=0 to disable.
const RATE_LIMIT = Number(process.env.KIRO_BRIDGE_RATE_LIMIT ?? 120);
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map();
function rateLimited(token) {
  if (!RATE_LIMIT || RATE_LIMIT <= 0) return false;
  const now = Date.now();
  const bucket = rateBuckets.get(token);
  if (!bucket || now >= bucket.reset) {
    rateBuckets.set(token, { count: 1, reset: now + RATE_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function modelList(registry) {
  return {
    object: 'list',
    data: Object.entries(registry).map(([id, m]) => ({
      id,
      object: 'model',
      created: 0,
      owned_by: 'kiro',
      name: m?.name || id,
    })),
  };
}

// --- Live account model catalog (Kiro control plane) ------------------------

// Kiro exposes the models available to the signed-in account through its control
// plane. That is the source of truth: OpenCode lists exactly what the account can
// use, so nothing here (or in models.json) is treated as authoritative.
const MODELS_TTL_MS = 5 * 60 * 1000;
let modelsCache = { at: 0, region: null, list: null };

async function fetchControlPlaneModels(token, region) {
  const res = await fetch(`https://management.${region}.kiro.dev/`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      tokentype: 'API_KEY',
      origin: 'AI_EDITOR',
      'x-amzn-kiro-agent-mode': 'vibe',
      'content-type': 'application/x-amz-json-1.0',
      'x-amz-target': 'KiroControlPlaneBearerService.ListAvailableModels',
    },
    body: JSON.stringify({ origin: 'AI_EDITOR' }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ListAvailableModels HTTP ${res.status} ${redact(detail).slice(0, 200)}`);
  }
  return res.json();
}

// Pass Kiro's own fields through so the plugin can build accurate models (name,
// rate multiplier, token limits, input types, thinking/effort schema). Standard
// OpenAI clients ignore the extra keys.
function toOpenAIModels(models) {
  return models.map((m) => ({
    id: m.modelId,
    object: 'model',
    created: 0,
    owned_by: 'kiro',
    name: m.modelName || m.modelId,
    description: m.description,
    rateMultiplier: m.rateMultiplier,
    rateUnit: m.rateUnit,
    tokenLimits: m.tokenLimits || null,
    supportedInputTypes: m.supportedInputTypes || null,
    thinking: m.additionalModelRequestFieldsSchema || null,
  }));
}

async function liveModelList(token, region) {
  const now = Date.now();
  if (modelsCache.list && modelsCache.region === region && now - modelsCache.at < MODELS_TTL_MS) {
    return modelsCache.list;
  }
  const data = await fetchControlPlaneModels(token, region);
  const modeled = toOpenAIModels(Array.isArray(data.models) ? data.models : []);
  if (modeled.length === 0) throw new Error('ListAvailableModels returned no models');
  const list = { object: 'list', data: modeled };
  modelsCache = { at: now, region, list };
  log(`live model catalog: ${modeled.length} models (region=${region})`);
  return list;
}

// Warm the catalog in the background so the first /v1/models call is fast and the
// plugin never races a cold control-plane round-trip.
async function warmModelCatalog() {
  const token = resolveApiKey();
  if (!token) return;
  try {
    const deps = await loadApiKeyDeps();
    await liveModelList(token, deps.config.default_region || 'us-east-1');
  } catch (e) {
    log('model catalog warm-up skipped:', e?.message || e);
  }
}

// --- Context windows ----------------------------------------------------------

// Kiro reports usage only as a percentage of the model's context window, which
// the bridge turns into token counts. Register each model's real window: the
// static registry first, then the account's catalog from kiro-cli.
const LOCAL_KIRO_CLI = path.join(os.homedir(), '.local/bin/kiro-cli');
const KIRO_CLI = process.env.KIRO_CLI || (fs.existsSync(LOCAL_KIRO_CLI) ? LOCAL_KIRO_CLI : 'kiro-cli');

async function loadContextWindows() {
  const [{ resolveKiroModel, setContextWindow }, { buildModelRegistry }] = await Promise.all([
    import(`${PKG}/plugin/models.js`),
    import(`${PKG}/plugin/model-registry.js`),
  ]);
  for (const [id, m] of Object.entries(buildModelRegistry())) setContextWindow(resolveKiroModel(id), m.limit?.context);
  const child = execFile(KIRO_CLI, ['chat', '--list-models', '--format', 'json'], { timeout: 10_000 }, (err, out) => {
    try {
      if (err) throw err;
      const models = JSON.parse(out).models ?? [];
      for (const m of models) setContextWindow(m.model_id, m.context_window_tokens);
      log(`context windows: ${models.length} models from kiro-cli`);
    } catch (e) {
      log('context windows: no kiro-cli catalog, using the static registry:', e?.message || e);
    }
  });
  child.stdin?.end();
}

async function handleApiKeyChat(res, body, apiKey) {
  const deps = await loadApiKeyDeps();
  const parsed = JSON.parse(body);
  const model = parsed.model || 'claude-sonnet-4-5';
  const think =
    model.endsWith('-thinking') || !!parsed.providerOptions?.thinkingConfig || !!parsed.thinkingConfig;
  const budget =
    parsed.providerOptions?.thinkingConfig?.thinkingBudget ||
    parsed.thinkingConfig?.thinkingBudget ||
    parsed.thinkingConfig?.budget_tokens ||
    20000;
  const region = deps.config.default_region || 'us-east-1';
  const auth = {
    access: apiKey,
    expires: Date.now() + 31536000000,
    authMethod: 'api_key',
    region,
    email: 'api-key',
  };
  const sdkPrep = deps.transformToSdkRequest(body, model, auth, think, budget, toast, {
    effort: deps.config.effort,
    autoEffortMapping: deps.config.auto_effort_mapping,
  });
  const client = apiKeyClient(deps, apiKey, sdkPrep.region || region);
  const command = new deps.GenerateAssistantResponseCommand({
    conversationState: sdkPrep.conversationState,
    profileArn: sdkPrep.profileArn,
  });
  const sdkResponse = await client.send(command);
  const responseHandler = new deps.ResponseHandler();
  const upstream = await responseHandler.handleSdkSuccess(
    sdkResponse,
    model,
    sdkPrep.conversationId,
    sdkPrep.streaming,
    sdkPrep.toolNameMap,
  );
  const headers = {};
  upstream.headers.forEach((v, k) => {
    if (k.toLowerCase() === 'content-length') return;
    headers[k] = v;
  });
  res.writeHead(upstream.status, headers);
  if (!upstream.body) {
    res.end(await upstream.text());
    return;
  }
  pipeUpstreamBody(upstream, res);
}

async function handleChat(req, res) {
  const body = await readBody(req);
  try {
    JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: { message: 'invalid JSON body', type: 'invalid_request_error' } });
  }

  const apiKey = resolveApiKey();
  if (apiKey) return handleApiKeyChat(res, body, apiKey);

  const s = await ensureReady();
  const kiroUrl = `https://q.${s.region}.amazonaws.com/v1/chat/completions`;
  const upstream = await s.requestHandler.handle(kiroUrl, { method: 'POST', headers: req.headers, body }, toast);

  const headers = {};
  upstream.headers.forEach((v, k) => {
    if (k.toLowerCase() === 'content-length') return;
    headers[k] = v;
  });
  res.writeHead(upstream.status, headers);

  if (!upstream.body) {
    res.end(await upstream.text());
    return;
  }
  pipeUpstreamBody(upstream, res);
}

// --- Server -----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      const apiKey = resolveApiKey();
      // Respond immediately; warm the OAuth provider in the background.
      if (!apiKey && !state) void ensureReady().catch((e) => log('init failed:', e?.message || e));
      return sendJson(res, 200, {
        status: 'ok',
        ready: apiKey ? true : !!state,
        auth: apiKey ? 'api_key' : 'accounts',
        accounts: state ? state.accountManager.getAccountCount() : null,
        region: state ? state.region : (apiKey ? 'api-key' : null),
      });
    }
    if (req.method === 'POST' && url.pathname === '/internal/api-key') {
      const token = presentedTokens(req)[0];
      // Only the plugin's own bridge key may change the stored Kiro API key.
      if (!token || !KEYS.has(token)) {
        return sendJson(res, 401, { error: { message: 'unauthorized', type: 'invalid_request_error' } });
      }
      let key = null;
      try {
        key = JSON.parse(await readBody(req))?.key ?? null;
      } catch {}
      const changed = setApiKey(key);
      log(`api key ${key ? 'set' : 'cleared'}${changed ? '' : ' (unchanged)'}`);
      if (changed && resolveApiKey()) void warmModelCatalog();
      return sendJson(res, 200, { ok: true, changed, configured: !!resolveApiKey() });
    }
    if (!authorized(req)) {
      return sendJson(res, 401, { error: { message: 'unauthorized', type: 'invalid_request_error' } });
    }
    if (url.pathname.startsWith('/v1') && rateLimited(presentedTokens(req)[0] || 'anon')) {
      return sendJson(res, 429, { error: { message: 'rate limit exceeded', type: 'rate_limit_error' } });
    }
    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      const apiKey = resolveApiKey();
      if (apiKey) {
        const deps = await loadApiKeyDeps();
        const region = deps.config.default_region || 'us-east-1';
        try {
          return sendJson(res, 200, await liveModelList(apiKey, region));
        } catch (e) {
          log('live model list unavailable, using static registry:', e?.message || e);
          return sendJson(res, 200, modelList(deps.buildModelRegistry()));
        }
      }
      const s = await ensureReady();
      return sendJson(res, 200, modelList(s.registry));
    }
    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
      return await handleChat(req, res);
    }
    return sendJson(res, 404, { error: { message: `not found: ${req.method} ${url.pathname}`, type: 'invalid_request_error' } });
  } catch (e) {
    log('request error:', e?.stack || e?.message || e);
    const message = redact(e?.message || String(e));
    if (res.headersSent) {
      try {
        res.end();
      } catch {}
      return;
    }
    return sendJson(res, 500, { error: { message, type: 'api_error' } });
  }
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    log(`port ${PORT} already in use; another bridge instance is running — exiting`);
    process.exit(0);
  }
  log('server error:', e?.message || e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log(`kiro bridge listening on http://${HOST}:${PORT}/v1`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
    log(`WARNING: KIRO_BRIDGE_HOST=${HOST} is not loopback — the bridge is reachable from the network`);
  }
  log(`auth: required (${KEYS.size} accepted key(s)); connect a Kiro API key with "opencode auth login kiro --method key"`);
  void warmModelCatalog();
  void loadContextWindows().catch((e) => log('context windows:', e?.message || e));
});
