import { z } from 'zod';
import { assistantStreamFirstTokenTime } from '@deepseek-ai/dsh-llm';

// Patched fork of @deepseek-ai/dsh-session-stats 0.2.1-rc.5.
//
// Upstream divides the provider's whole completion count by a decode window that
// collapses to ~0 ms on pure tool-call steps, so the rendered tok/s is really
// `ΣoutputTokens / Σ~0`. This fork adds three things and changes no existing field:
//
//   1. `decodeMs` / `decodeTokens` keep their name and meaning, so every existing
//      consumer keeps working — but a step is only entered when it actually observed
//      a decode window (> DECODE_GATE_MS). A turn whose visible content is a single
//      instant burst contributes no window instead of a fake 0 ms one.
//   2. `decodeFrameTokens` / `decodeTextTokens` / `decodeReasoningTokens` estimate how
//      the provider's output count splits across tool-call frames, visible text and
//      reasoning, from the channel payload lengths already in the log. They let a
//      reader divide by the payload it cares about instead of the whole count.
//   3. `answerTokens` / `answerThroughput`-style consumers can subtract frames; this
//      fork only publishes the split, it does not pick a headline number.
//
// The estimate is character-weighted, not a real tokenizer: one provider output
// token is not one character and the three channels do not tokenize identically.
// It is deliberately published as a separate field so nothing silently redefines
// `decodeTokens`; treat the split as a proportional attribution, not a count.

/** A decode window at or below this is an instant burst, not generation. */
const DECODE_GATE_MS = 5;

const sessionStatsSchema = z.object({
  turns: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
  llmMs: z.number().nonnegative(),
  toolMs: z.number().nonnegative(),
  ttftMs: z.number().nonnegative(),
  ttftSteps: z.number().int().nonnegative(),
  decodeMs: z.number().nonnegative(),
  decodeTokens: z.number().nonnegative(),
  decodeFrameTokens: z.number().nonnegative(),
  decodeTextTokens: z.number().nonnegative(),
  decodeReasoningTokens: z.number().nonnegative()
}).strict();

const sessionStatsStateSchema = sessionStatsSchema.extend({
  lastTurn: z.number().int().nonnegative().nullable(),
  openStep: z.object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    startTime: z.number().nonnegative(),
    firstTokenTime: z.number().nonnegative().nullable()
  }).nullable(),
  pendingCalls: z.record(z.string(), z.number().nonnegative())
});

function usageOutputTokens(usage) {
  if (typeof usage !== 'object' || usage === null) return null;
  const value = usage.outputTokens;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Character length of one packed run: packed runs concatenate their members, so
 * the length of the concatenation is what the provider actually emitted.
 * @param run - a compact stream record.
 * @param pick - which member array to read.
 * @returns summed character length.
 */
function packedLength(run, pick) {
  let total = 0;
  for (const fragment of pick(run) || []) total += typeof fragment === 'string' ? fragment.length : 0;
  return total;
}

/**
 * Character length per channel of one assembled stream. Unpacked chunks and
 * packed runs are both counted, because a settlement may carry either.
 * @param stream - the assistant/message compact stream.
 * @returns reasoning / text / tool-frame character lengths.
 */
function channelChars(stream) {
  const out = { reasoning: 0, text: 0, frame: 0 };
  for (const record of stream || []) {
    switch (record.type) {
      case 'reasoning-chunks': out.reasoning += packedLength(record, (r) => r.texts); break;
      case 'text-chunks': out.text += packedLength(record, (r) => r.texts); break;
      case 'tool-call-chunks': out.frame += packedLength(record, (r) => r.args); break;
      case 'chunk': {
        const chunk = record.chunk || {};
        if (chunk.type === 'reasoning-delta') out.reasoning += (chunk.text || '').length;
        else if (chunk.type === 'text-delta') out.text += (chunk.text || '').length;
        else if (chunk.type === 'tool-call-delta') out.frame += (chunk.argumentsDelta || '').length;
        break;
      }
      default: break;
    }
  }
  return out;
}

const sessionStatsProjectionDefinition = {
  key: 'sessionStats',
  // Bumped from 1: a row folded by the upstream unit carries no split fields, and
  // the cache's ver gate discards rather than migrates, so old rows are re-folded.
  stateVersion: 2,
  stateSchema: sessionStatsStateSchema,
  init: () => ({
    turns: 0,
    steps: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
    decodeFrameTokens: 0,
    decodeTextTokens: 0,
    decodeReasoningTokens: 0,
    lastTurn: null,
    openStep: null,
    pendingCalls: {}
  }),
  apply: (state, event) => {
    switch (event.type) {
      case 'step/start': return {
        ...state,
        openStep: {
          turn: event.data.turn,
          step: event.data.step,
          startTime: event.time,
          firstTokenTime: null
        }
      };
      case 'assistant/attempt': {
        const open = state.openStep;
        if (open === null || open.turn !== event.data.turn || open.step !== event.data.step) return state;
        const first = assistantStreamFirstTokenTime(event.data.stream) ?? null;
        if (open.firstTokenTime !== null || first === null) return state;
        return { ...state, openStep: { ...open, firstTokenTime: first } };
      }
      case 'assistant/message': {
        const open = state.openStep;
        if (open === null || open.turn !== event.data.turn || open.step !== event.data.step) return state;
        const firstToken = open.firstTokenTime ?? assistantStreamFirstTokenTime(event.data.stream) ?? null;
        const next = {
          ...state,
          llmMs: state.llmMs + Math.max(0, event.time - open.startTime),
          openStep: null
        };
        if (firstToken === null) return next;
        next.ttftMs += Math.max(0, firstToken - open.startTime);
        next.ttftSteps += 1;
        const outputTokens = usageOutputTokens(event.data.usage);
        if (outputTokens === null) return next;
        const span = Math.max(0, event.time - firstToken);
        // An instant burst carries no generation time. Counting its tokens against a
        // ~0 ms window is what produced four-digit speeds, so such a step stays out.
        if (span <= DECODE_GATE_MS) return next;
        next.decodeMs += span;
        next.decodeTokens += outputTokens;
        const chars = channelChars(event.data.stream);
        const total = chars.reasoning + chars.text + chars.frame;
        if (total === 0) return next;
        // Proportional attribution: the provider count split by channel payload share.
        next.decodeFrameTokens += outputTokens * (chars.frame / total);
        next.decodeTextTokens += outputTokens * (chars.text / total);
        next.decodeReasoningTokens += outputTokens * (chars.reasoning / total);
        return next;
      }
      case 'tool/call': return {
        ...state,
        pendingCalls: { ...state.pendingCalls, [event.data.callId]: event.time }
      };
      case 'tool/result': {
        const callId = event.data.message.source.callId;
        const dispatched = Object.hasOwn(state.pendingCalls, callId) ? state.pendingCalls[callId] : undefined;
        if (dispatched === undefined) return state;
        const pendingCalls = Object.fromEntries(
          Object.entries(state.pendingCalls).filter(([id]) => id !== callId),
        );
        return { ...state, toolMs: state.toolMs + Math.max(0, event.time - dispatched), pendingCalls };
      }
      case 'step/end': return {
        ...state,
        turns: state.lastTurn === event.data.turn ? state.turns : state.turns + 1,
        steps: state.steps + 1,
        lastTurn: event.data.turn,
        openStep: null
      };
      case 'turn/end': return Object.keys(state.pendingCalls).length === 0
        ? state
        : { ...state, pendingCalls: {} };
      default: return state;
    }
  },
  wire: {
    viewSchema: sessionStatsSchema,
    view: (state) => ({
      turns: state.turns,
      steps: state.steps,
      llmMs: state.llmMs,
      toolMs: state.toolMs,
      ttftMs: state.ttftMs,
      ttftSteps: state.ttftSteps,
      decodeMs: state.decodeMs,
      decodeTokens: state.decodeTokens,
      decodeFrameTokens: state.decodeFrameTokens,
      decodeTextTokens: state.decodeTextTokens,
      decodeReasoningTokens: state.decodeReasoningTokens
    })
  }
};

export const DECODE_GATE_MS_ = DECODE_GATE_MS;
export { sessionStatsProjectionDefinition };
export const name = 'session-stats';
export const inject = ['sessionProjections'];

function apply(ctx) {
  ctx.sessionProjections.register(sessionStatsProjectionDefinition);
}
export { apply };
