/**
 * OpenTelemetry export (opt-in): a span and metrics for every on-device model call (Cactus
 * downloads, loads, completions, embeddings, transcriptions: tokens, time to first token,
 * speed, memory) sent over OTLP/HTTP to the user's own collector, through
 * @traceverse/genai-otel-instrument-node, and optionally to a second destination as well (each
 * batch is sent to both). Off by default; prompts and replies are not exported unless the user
 * turns that on. Auth headers live in the Keystore-backed credential store.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  flushTelemetry,
  instrument,
  instrumentCactus,
  isInstrumented,
  setLogger,
  uninstrument,
} from '@traceverse/genai-otel-instrument-node/react-native';
import { CactusLM, CactusSTT } from 'cactus-react-native';
import { AppState } from 'react-native';

import { isSafeBaseUrl } from '../inference/ModelRegistry';
import { credentials } from '../platform/android';
import { setContentCapture } from './spans';

const KEY = '@liquid_otel_v1';
const HEADERS_KEY = 'otel.headers';
const MIRROR_HEADERS_KEY = 'otel.mirrorHeaders';

export interface OtelSettings {
  enabled: boolean;
  /** OTLP/HTTP base URL, e.g. https://otel.example.com:4318 (the SDK adds /v1/traces). */
  endpoint: string;
  /** Include prompts and replies in spans. */
  captureContent: boolean;
  /** Optional second OTLP/HTTP base URL that receives the same telemetry; '' for none. */
  mirrorEndpoint: string;
}

export const DEFAULT_OTEL: OtelSettings = {
  enabled: false,
  endpoint: '',
  captureContent: false,
  mirrorEndpoint: '',
};

/** "Authorization=Bearer abc, x-tenant=lc" (the OTEL_EXPORTER_OTLP_HEADERS format). */
export function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

/**
 * Arize rejects traces it cannot file under a project (HTTP 400, "requires project routing"). Unless
 * the user named one, an Arize endpoint gets the project "liquidchat".
 */
export function withProjectRouting(endpoint: string, headers: Record<string, string>) {
  let host = '';
  try {
    host = new URL(endpoint.trim()).hostname;
  } catch {
    return headers;
  }
  const isArize = host === 'arize.com' || host.endsWith('.arize.com');
  const named = Object.keys(headers).some(k => k.toLowerCase() === 'x-project-name');
  return isArize && !named ? { ...headers, 'x-project-name': 'liquidchat' } : headers;
}

/** https only, except a collector on this phone, the PC (adb reverse) or the local network. */
export function endpointProblem(endpoint: string): string | null {
  const e = endpoint.trim();
  if (!e) return 'Enter the collector URL.';
  if (!isSafeBaseUrl(e))
    return 'Use https:// (plain http only for a collector on your local network).';
  return null;
}

export async function getOtelSettings(): Promise<OtelSettings> {
  try {
    return { ...DEFAULT_OTEL, ...JSON.parse((await AsyncStorage.getItem(KEY)) ?? '{}') };
  } catch {
    return { ...DEFAULT_OTEL };
  }
}

export async function getOtelHeaders(): Promise<string> {
  return (await credentials.get(HEADERS_KEY).catch(() => null)) ?? '';
}

export async function getOtelMirrorHeaders(): Promise<string> {
  return (await credentials.get(MIRROR_HEADERS_KEY).catch(() => null)) ?? '';
}

async function storeHeaders(key: string, headers: string | null): Promise<void> {
  if (headers === null) return;
  if (headers.trim()) await credentials.set(key, headers.trim());
  else await credentials.delete(key).catch(() => undefined);
}

/** Saves and applies; a header value of null keeps the stored one. */
export async function saveOtelSettings(
  s: OtelSettings,
  headers: string | null,
  mirrorHeaders: string | null = null,
): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(s));
  await storeHeaders(HEADERS_KEY, headers);
  await storeHeaders(MIRROR_HEADERS_KEY, mirrorHeaders);
  await applyOtel(s);
}

type FetchLike = typeof fetch;

/**
 * A fetch that also sends every OTLP request to a second destination: the same body, to the same
 * signal path (/v1/traces, /v1/metrics) under `mirrorBase`, with that destination's own headers.
 * The primary destination's answer is what the SDK sees; a mirror failure is only logged.
 */
export function mirroringFetch(
  primaryBase: string,
  mirrorBase: string,
  mirrorHeaders: Record<string, string>,
  base: FetchLike = fetch,
): FetchLike {
  const from = primaryBase.trim().replace(/\/+$/, '');
  const to = mirrorBase.trim().replace(/\/+$/, '');
  return (async (input: any, init?: any) => {
    const url = String(input);
    if (url.startsWith(from)) {
      const path = url.slice(from.length);
      const own = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).filter(
          ([k]) => k.toLowerCase() === 'content-type',
        ),
      );
      base(`${to}${path}`, { ...init, headers: { ...own, ...mirrorHeaders } })
        .then(r => {
          if (!r.ok)
            console.warn(`[OTel] second destination answered HTTP ${r.status} for ${path}`);
        })
        .catch(e => console.warn(`[OTel] second destination unreachable: ${String(e)}`));
    }
    return base(input, init);
  }) as FetchLike;
}

/** Starts or stops export to match the settings. Never throws: telemetry must not break the app. */
export async function applyOtel(s?: OtelSettings): Promise<boolean> {
  try {
    const settings = s ?? (await getOtelSettings());
    setContentCapture(settings.enabled && settings.captureContent);
    if (isInstrumented()) uninstrument();
    if (!settings.enabled || endpointProblem(settings.endpoint)) return false;
    // Export failures are debug-level in the SDK; surface them, or a rejected export is silent.
    setLogger({
      debug: (m, ...a) => {
        if (/export failed/i.test(m)) console.warn('[OTel]', m, ...a);
      },
      info: () => {},
      warn: (m, ...a) => console.warn('[OTel]', m, ...a),
      error: (m, ...a) => console.warn('[OTel]', m, ...a),
    });
    const mirror = settings.mirrorEndpoint?.trim() ?? '';
    const mirrorOk = !!mirror && !endpointProblem(mirror);
    instrument({
      serviceName: 'liquidchat',
      endpoint: settings.endpoint.trim(),
      fetch: mirrorOk
        ? mirroringFetch(
            settings.endpoint,
            mirror,
            withProjectRouting(mirror, parseHeaders(await getOtelMirrorHeaders())),
          )
        : undefined,
      headers: withProjectRouting(settings.endpoint, parseHeaders(await getOtelHeaders())),
      enableContentCapture: settings.captureContent,
      // Flush when the app leaves the foreground: a backgrounded app can be killed.
      appState: AppState,
    });
    instrumentCactus({ CactusLM, CactusSTT });
    return true;
  } catch (e) {
    console.warn('[OTel] export not started:', e);
    return false;
  }
}

/** Sends whatever is buffered now; true when the collector accepted it. */
export function flushOtel(): Promise<boolean> {
  return isInstrumented() ? flushTelemetry(10) : Promise.resolve(false);
}
