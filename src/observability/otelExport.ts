/**
 * OpenTelemetry export (opt-in): a span and metrics for every on-device model call (Cactus
 * downloads, loads, completions, embeddings, transcriptions: tokens, time to first token,
 * speed, memory) sent over OTLP/HTTP to the user's own collector, through
 * @traceverse/genai-otel-instrument-node. Off by default; prompts and replies are not exported unless the
 * user turns that on. Auth headers live in the Keystore-backed credential store.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  flushTelemetry,
  instrument,
  instrumentCactus,
  isInstrumented,
  uninstrument,
} from '@traceverse/genai-otel-instrument-node/react-native';
import { CactusLM, CactusSTT } from 'cactus-react-native';
import { AppState } from 'react-native';

import { isSafeBaseUrl } from '../inference/ModelRegistry';
import { credentials } from '../platform/android';
import { setContentCapture } from './spans';

const KEY = '@liquid_otel_v1';
const HEADERS_KEY = 'otel.headers';

export interface OtelSettings {
  enabled: boolean;
  /** OTLP/HTTP base URL, e.g. https://otel.example.com:4318 (the SDK adds /v1/traces). */
  endpoint: string;
  /** Include prompts and replies in spans. */
  captureContent: boolean;
}

export const DEFAULT_OTEL: OtelSettings = { enabled: false, endpoint: '', captureContent: false };

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

/** Saves and applies; a header value of null keeps the stored one. */
export async function saveOtelSettings(s: OtelSettings, headers: string | null): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(s));
  if (headers !== null) {
    if (headers.trim()) await credentials.set(HEADERS_KEY, headers.trim());
    else await credentials.delete(HEADERS_KEY).catch(() => undefined);
  }
  await applyOtel(s);
}

/** Starts or stops export to match the settings. Never throws: telemetry must not break the app. */
export async function applyOtel(s?: OtelSettings): Promise<boolean> {
  try {
    const settings = s ?? (await getOtelSettings());
    setContentCapture(settings.enabled && settings.captureContent);
    if (isInstrumented()) uninstrument();
    if (!settings.enabled || endpointProblem(settings.endpoint)) return false;
    instrument({
      serviceName: 'liquidchat',
      endpoint: settings.endpoint.trim(),
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
