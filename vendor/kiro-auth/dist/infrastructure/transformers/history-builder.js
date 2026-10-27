import { KIRO_CONSTANTS } from '../../constants.js';
import { convertImagesToKiroFormat, extractAllImages, extractTextFromParts } from '../../plugin/image-handler.js';
import { getContentText } from './message-transformer.js';
import { deduplicateToolResults } from './tool-transformer.js';
/**
 * Collapse agentic loop sequences in the built history.
 *
 * Each agentic iteration gets a fresh conversationId, so the model re-derives its preamble
 * (intent detection, greeting) every iteration. When replayed for the next user turn, the
 * model sees duplicate preambles and gets confused.
 *
 * Strips text from intermediate ASST(toolUses)→USER(toolResults) pairs, keeping only the
 * first assistant text and all tool_use/tool_result pairs.
 */
export function collapseAgenticLoops(history) {
    if (history.length < 4)
        return history;
    const result = [];
    let i = 0;
    while (i < history.length) {
        const entry = history[i];
        if (entry?.assistantResponseMessage?.toolUses &&
            i + 1 < history.length &&
            history[i + 1]?.userInputMessage?.userInputMessageContext?.toolResults) {
            const seqStart = i;
            let j = i;
            while (j < history.length) {
                const asst = history[j];
                if (!asst?.assistantResponseMessage?.toolUses)
                    break;
                const nextUser = j + 1 < history.length ? history[j + 1] : null;
                if (!nextUser?.userInputMessage?.userInputMessageContext?.toolResults)
                    break;
                j += 2;
            }
            const seqEnd = j;
            const pairCount = (seqEnd - seqStart) / 2;
            if (pairCount > 1) {
                for (let k = seqStart; k < seqEnd; k += 2) {
                    const asst = history[k];
                    const user = history[k + 1];
                    if (k === seqStart) {
                        result.push(asst);
                    }
                    else {
                        result.push({
                            assistantResponseMessage: {
                                content: '[system: tool calling continues]',
                                toolUses: asst.assistantResponseMessage.toolUses
                            }
                        });
                    }
                    result.push(user);
                }
            }
            else {
                for (let k = seqStart; k < seqEnd; k++) {
                    result.push(history[k]);
                }
            }
            i = seqEnd;
        }
        else {
            result.push(entry);
            i++;
        }
    }
    return result;
}
export function buildHistory(msgs, resolved) {
    let history = [];
    for (let i = 0; i < msgs.length - 1; i++) {
        const m = msgs[i];
        if (!m)
            continue;
        if (m.role === 'user') {
            const uim = { content: '', modelId: resolved, origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR };
            const trs = [];
            if (Array.isArray(m.content)) {
                uim.content = extractTextFromParts(m.content);
                for (const p of m.content) {
                    if (p.type === 'tool_result') {
                        trs.push({
                            content: [{ text: getContentText(p.content || p) }],
                            status: 'success',
                            toolUseId: p.tool_use_id
                        });
                    }
                }
                const unifiedImages = extractAllImages(m.content);
                if (unifiedImages.length > 0) {
                    const { images, omitted } = convertImagesToKiroFormat(unifiedImages);
                    uim.images = images;
                    if (omitted > 0) {
                        uim.content += `\n\n[${omitted} image(s) omitted due to API limits]`;
                    }
                }
            }
            else {
                uim.content = getContentText(m);
            }
            if (trs.length)
                uim.userInputMessageContext = { toolResults: deduplicateToolResults(trs) };
            const prev = history[history.length - 1];
            if (prev && prev.userInputMessage)
                history.push({ assistantResponseMessage: { content: '[system: conversation continues]' } });
            history.push({ userInputMessage: uim });
        }
        else if (m.role === 'tool') {
            const trs = [];
            if (m.tool_results) {
                for (const tr of m.tool_results)
                    trs.push({
                        content: [{ text: getContentText(tr) }],
                        status: 'success',
                        toolUseId: tr.tool_call_id
                    });
            }
            else {
                trs.push({
                    content: [{ text: getContentText(m) }],
                    status: 'success',
                    toolUseId: m.tool_call_id
                });
            }
            const prev = history[history.length - 1];
            if (prev && prev.userInputMessage)
                history.push({ assistantResponseMessage: { content: '[system: conversation continues]' } });
            history.push({
                userInputMessage: {
                    content: 'Tool results provided.',
                    modelId: resolved,
                    origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
                    userInputMessageContext: { toolResults: deduplicateToolResults(trs) }
                }
            });
        }
        else if (m.role === 'assistant') {
            const arm = { content: '' };
            const tus = [];
            let th = '';
            if (Array.isArray(m.content)) {
                for (const p of m.content) {
                    if (p.type === 'text')
                        arm.content += p.text || '';
                    else if (p.type === 'thinking')
                        th += p.thinking || p.text || '';
                    else if (p.type === 'tool_use')
                        tus.push({ input: p.input, name: p.name, toolUseId: p.id });
                }
            }
            else
                arm.content = getContentText(m);
            if (m.tool_calls && Array.isArray(m.tool_calls)) {
                for (const tc of m.tool_calls) {
                    tus.push({
                        input: typeof tc.function?.arguments === 'string'
                            ? JSON.parse(tc.function.arguments)
                            : tc.function?.arguments,
                        name: tc.function?.name,
                        toolUseId: tc.id
                    });
                }
            }
            if (th)
                arm.content = arm.content
                    ? `<thinking>${th}</thinking>\n\n${arm.content}`
                    : `<thinking>${th}</thinking>`;
            if (tus.length)
                arm.toolUses = tus;
            if (!arm.content && !arm.toolUses) {
                continue;
            }
            const prevMsg = history[history.length - 1];
            if (prevMsg && prevMsg.assistantResponseMessage) {
                // Merge consecutive assistant messages instead of injecting synthetic user turn
                const prev = prevMsg.assistantResponseMessage;
                if (arm.content) {
                    prev.content = prev.content ? `${prev.content}\n\n${arm.content}` : arm.content;
                }
                if (arm.toolUses) {
                    prev.toolUses = [...(prev.toolUses || []), ...arm.toolUses];
                }
            }
            else {
                history.push({ assistantResponseMessage: arm });
            }
        }
    }
    return collapseAgenticLoops(history);
}
/**
 * Fold the oldest history entries into one plain-text user entry.
 *
 * Kiro rejects a conversation once its history reaches 200 entries ("Input is
 * too long"), however few tokens it holds, and every tool round adds two. Past
 * FOLD_AT entries the oldest ones become a transcript in a single user entry.
 * The cut moves in FOLD_STEP steps, so consecutive requests share the same
 * folded prefix.
 */
const FOLD_AT = 180;
const FOLD_STEP = 100;
const FILLER = new Set([
    '[system: conversation continues]',
    '[system: tool calling continues]',
    'Tool results provided.',
    'Running tools...',
    'I will execute the following tools.'
]);
export function foldHistory(history, resolved) {
    if (history.length <= FOLD_AT)
        return history;
    // Cut just before an assistant entry that follows a user entry: the folded
    // entry is a user turn, and no toolUse is separated from its toolResults.
    let cut = FOLD_STEP * Math.ceil((history.length - FOLD_AT) / FOLD_STEP);
    while (cut < history.length && !(history[cut].assistantResponseMessage && history[cut - 1].userInputMessage))
        cut++;
    if (cut >= history.length)
        return history;
    const toolNames = new Map();
    const blocks = [];
    for (const entry of history.slice(0, cut)) {
        const arm = entry.assistantResponseMessage;
        if (arm) {
            const lines = [];
            const text = (arm.content || '').replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '').trim();
            if (text && !FILLER.has(text))
                lines.push(text);
            for (const tu of arm.toolUses || []) {
                toolNames.set(tu.toolUseId, tu.name);
                lines.push(`<tool_call name="${tu.name}">${JSON.stringify(tu.input ?? {})}</tool_call>`);
            }
            if (lines.length)
                blocks.push(`<assistant>\n${lines.join('\n')}\n</assistant>`);
            continue;
        }
        const uim = entry.userInputMessage;
        if (!uim)
            continue;
        for (const tr of uim.userInputMessageContext?.toolResults || []) {
            const output = (tr.content || [])
                .map((c) => (typeof c.text === 'string' ? c.text : JSON.stringify(c.json ?? c)))
                .join('\n');
            const status = tr.status === 'error' ? ' status="error"' : '';
            blocks.push(`<tool_result name="${toolNames.get(tr.toolUseId) || 'tool'}"${status}>\n${output}\n</tool_result>`);
        }
        const raw = (uim.content || '').trim();
        const text = FILLER.has(raw) ? '' : raw;
        const images = uim.images?.length ? `[${uim.images.length} image(s) not kept]` : '';
        const body = [text, images].filter(Boolean).join('\n');
        if (body)
            blocks.push(`<user>\n${body}\n</user>`);
    }
    const content = '<earlier_conversation>\n' +
        `The first ${cut} messages of this conversation, kept as plain text because Kiro accepts at most 200 history messages. ` +
        'They already happened; continue from the messages that follow and call tools the normal way.\n\n' +
        `${blocks.join('\n\n')}\n</earlier_conversation>`;
    return [
        { userInputMessage: { content, modelId: resolved, origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR } },
        ...history.slice(cut)
    ];
}
export function injectSystemPrompt(history, system, resolved) {
    if (!system)
        return history;
    const firstUserMsg = history.find((h) => !!h.userInputMessage);
    if (firstUserMsg && firstUserMsg.userInputMessage) {
        const oldContent = firstUserMsg.userInputMessage.content || '';
        firstUserMsg.userInputMessage.content = `${system}\n\n${oldContent}`;
    }
    else {
        history.unshift({
            userInputMessage: {
                content: system,
                modelId: resolved,
                origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
            }
        });
    }
    return history;
}
export function historyHasToolCalling(history) {
    return history.some((h) => h.assistantResponseMessage?.toolUses ||
        h.userInputMessage?.userInputMessageContext?.toolResults);
}
export function extractToolNamesFromHistory(history) {
    const toolNames = new Set();
    for (const h of history) {
        if (h.assistantResponseMessage?.toolUses) {
            for (const tu of h.assistantResponseMessage.toolUses) {
                if (tu.name)
                    toolNames.add(tu.name);
            }
        }
    }
    return toolNames;
}
