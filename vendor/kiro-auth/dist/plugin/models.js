import { MODEL_MAPPING, SUPPORTED_MODELS, isLongContextModel } from '../constants.js';
export function resolveKiroModel(model) {
    const resolved = MODEL_MAPPING[model];
    if (resolved)
        return resolved;
    // Account-scoped models fetched live from Kiro's control plane
    // (e.g. claude-opus-5.5, gpt-5.6-sol) already use their Kiro-native id, so a
    // well-formed id passes straight through instead of being rejected here.
    if (typeof model === 'string' && /^[a-z0-9][a-z0-9._-]*$/i.test(model))
        return model;
    throw new Error(`Unsupported model: ${model}. Supported models: ${SUPPORTED_MODELS.join(', ')}`);
}
// Kiro reports usage only as a percentage of the model's context window, so token
// counts are only as right as this window. The bridge registers the real ones by
// Kiro model id (setContextWindow); unknown models fall back to the old guess.
const contextWindows = new Map();
export function setContextWindow(kiroModel, tokens) {
    if (typeof kiroModel === 'string' && Number.isFinite(tokens) && tokens > 0)
        contextWindows.set(kiroModel, tokens);
}
export function getContextWindowSize(model) {
    const kiroModel = MODEL_MAPPING[model] ?? model;
    return contextWindows.get(kiroModel) ?? (isLongContextModel(model) ? 1000000 : 200000);
}
