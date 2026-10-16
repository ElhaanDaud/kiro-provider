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
export function getContextWindowSize(model) {
    return isLongContextModel(model) ? 1000000 : 200000;
}
