/**
 * OpenTelemetry export settings (opt-in). Everything else is the SDK's: one instrument() call
 * traces on-device model calls (Cactus is found on its own), and the app's agent runs, tool calls,
 * retrieval and pipelines are traced with its helpers where they happen. Sent over OTLP/HTTP to
 * the user's collector, and optionally to a second destination too. Off by default; prompts and
 * replies are not exported unless the user turns that on. Auth headers live in the
 * Keystore-backed credential store.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  flushTelemetry,
  instrument,
  isInstrumented,
  uninstrument,
} from '@traceverse/genai-otel-instrument-node/react-native';

import { isSafeBaseUrl } from '../inference/ModelRegistry';
import { credentials } from '../platform/android';

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

function hostOf(url: string): string {
  const m = /^[a-z]+:\/\/([^/:?#]+)/i.exec(url.trim());
  return m ? m[1].toLowerCase() : url.trim().toLowerCase();
}

/**
 * What to store for a destination's headers on save: what was typed; '' (remove) when the user
 * asked, the destination was cleared, or its endpoint moved to another host, since saved headers
 * belong to the backend they were entered for and must never be sent to another; else null (keep).
 */
export function nextHeaders(
  typed: string,
  remove: boolean,
  savedEndpoint: string,
  newEndpoint: string,
): string | null {
  if (typed.trim()) return typed;
  if (remove || !newEndpoint.trim()) return '';
  if (savedEndpoint.trim() && hostOf(savedEndpoint) !== hostOf(newEndpoint)) return '';
  return null;
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

/** Starts or stops export to match the settings. Never throws: telemetry must not break the app. */
export async function applyOtel(s?: OtelSettings): Promise<boolean> {
  try {
    const settings = s ?? (await getOtelSettings());
    if (isInstrumented()) uninstrument();
    if (!settings.enabled || endpointProblem(settings.endpoint)) return false;
    const mirror = settings.mirrorEndpoint?.trim() ?? '';
    instrument({
      serviceName: 'liquidchat',
      endpoint: settings.endpoint.trim(),
      headers: parseHeaders(await getOtelHeaders()),
      additionalDestinations:
        mirror && !endpointProblem(mirror)
          ? [{ endpoint: mirror, headers: parseHeaders(await getOtelMirrorHeaders()) }]
          : [],
      enableContentCapture: settings.captureContent,
      // Whole tool results and transcripts, not the SDK's 200-character default.
      contentMaxLength: 8000,
    });
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
