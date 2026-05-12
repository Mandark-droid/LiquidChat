import type { IntentType } from '../types';
import { getModelBySlug } from '../config/models';

interface RoutingContext {
  currentModelSlug: string;
  hasDocumentCorpus: boolean;
  loadedSlugs?: string[];
}

interface RoutingResult {
  intent: IntentType;
  targetModelSlug: string;
  confidence: number;
  reason: string;
}

const ACTION_VERBS = [
  'turn', 'set', 'open', 'toggle', 'create', 'send', 'tap', 'scroll',
  'click', 'swipe', 'press', 'enable', 'disable', 'launch', 'close',
  'start', 'stop', 'switch', 'navigate', 'call', 'dial', 'text',
  'compose', 'share', 'search', 'find', 'show', 'hide', 'move',
  'adjust', 'increase', 'decrease', 'mute', 'unmute',
];

const QUERY_PATTERNS = [
  /^what\s+(is|are|was|were)\b/i,
  /^who\s+(is|are|was|were)\b/i,
  /^where\s+(is|are|was|were)\b/i,
  /^when\s+(is|are|was|were|did)\b/i,
  /^how\s+(does|do|did|is|are|to)\b/i,
  /^explain\b/i,
  /^tell\s+me\s+about\b/i,
  /^describe\b/i,
  /^define\b/i,
  /^summarize\b/i,
];

const REASON_PATTERNS = [
  /\bplan\b/i,
  /\bstep\s+by\s+step\b/i,
  /\banalyze\b/i,
  /\bcompare\b/i,
  /\bevaluate\b/i,
  /\bthink\s+(about|through)\b/i,
  /\breason\b/i,
  /\bbreak\s+(it\s+)?down\b/i,
  /\bpros\s+and\s+cons\b/i,
];

const CHAT_PATTERNS = [
  /^(hi|hello|hey|howdy|yo|sup|greetings)\b/i,
  /^(good\s+(morning|afternoon|evening|night))\b/i,
  /^(thanks|thank\s+you|thx)\b/i,
  /^(bye|goodbye|see\s+you|later)\b/i,
  /^(ok|okay|sure|yes|no|yeah|nah)\b$/i,
];

class IntentRouterService {
  route(message: string, context: RoutingContext): RoutingResult {
    const trimmed = message.trim();
    const firstWord = trimmed.split(/\s+/)[0]?.toLowerCase() ?? '';

    let result: RoutingResult;

    // Check ACTION: starts with imperative verb
    if (ACTION_VERBS.includes(firstWord)) {
      result = {
        intent: 'ACTION',
        targetModelSlug: 'lfm2-1.2b',
        confidence: 0.9,
        reason: `Imperative verb "${firstWord}" detected`,
      };
    // Check REASON: reasoning patterns (only if thinking model available)
    } else if (getModelBySlug('lfm2.5-1.2b-thinking') && REASON_PATTERNS.some(p => p.test(trimmed))) {
      result = {
        intent: 'REASON',
        targetModelSlug: 'lfm2.5-1.2b-thinking',
        confidence: 0.8,
        reason: 'Reasoning pattern matched',
      };
    // Check QUERY: question patterns (only if document corpus exists)
    } else if (context.hasDocumentCorpus && QUERY_PATTERNS.some(p => p.test(trimmed))) {
      result = {
        intent: 'QUERY',
        targetModelSlug: 'lfm2-1.2b',
        confidence: 0.85,
        reason: 'Query pattern matched',
      };
    // Check CHAT: greetings, short messages
    } else if (CHAT_PATTERNS.some(p => p.test(trimmed))) {
      result = {
        intent: 'CHAT',
        targetModelSlug: 'lfm2-350m',
        confidence: 0.9,
        reason: 'Chat/greeting pattern matched',
      };
    // Very short messages are likely chat
    } else if (trimmed.split(/\s+/).length <= 3) {
      result = {
        intent: 'CHAT',
        targetModelSlug: 'lfm2-350m',
        confidence: 0.6,
        reason: 'Short message defaulted to chat',
      };
    } else {
      // Default: stay on current model
      result = {
        intent: 'CHAT',
        targetModelSlug: context.currentModelSlug,
        confidence: 0.5,
        reason: 'No strong pattern match, using current model',
      };
    }

    // Prefer already-loaded models: if the target isn't loaded but the current is,
    // stay on the current model to avoid cold load delays
    const loaded = context.loadedSlugs ?? [];
    if (
      result.targetModelSlug !== context.currentModelSlug &&
      !loaded.includes(result.targetModelSlug) &&
      loaded.includes(context.currentModelSlug)
    ) {
      result = {
        ...result,
        targetModelSlug: context.currentModelSlug,
        confidence: Math.max(result.confidence - 0.15, 0.3),
        reason: `${result.reason}; stayed on loaded model to avoid cold load`,
      };
    }

    return result;
  }
}

export const intentRouter = new IntentRouterService();
export type { RoutingContext, RoutingResult };
