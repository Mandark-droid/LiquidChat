import AsyncStorage from '@react-native-async-storage/async-storage';

import { DEFAULT_SPACE_ID } from '../services/hfSpace';
import type { MeetingSettings } from './types';

const KEY = '@liquid_meeting_settings';
/** v2: auto-detect the spoken language and translate to English. v3: meetings indexed for chat. */
export const MEETING_DEFAULTS_VERSION = 3;

export const DEFAULT_MEETING_SETTINGS: MeetingSettings = {
  sttModel: 'whisper-small',
  language: 'auto',
  task: 'translate',
  contextPrompting: true,
  vocabulary: '',
  summaryModel: 'lfm2.5-1.2b-instruct',
  audioSource: 'voice_recognition',
  keepAudio: true,
  autoGenerateMinutes: true,
  indexForChat: true,
  engine: 'device',
  spaceId: DEFAULT_SPACE_ID,
  spaceAsrModel: 'hinglish',
  defaultsVersion: MEETING_DEFAULTS_VERSION,
  letterhead: {
    // Empty = documents are branded "LiquidChat". Set your own organisation in Meeting settings.
    companyName: '',
    preparedBy: '',
    contactLine: '',
    footerNote: 'Confidential — prepared for the named recipients only.',
    accentColor: '#3A8FB7',
  },
};

let cache: MeetingSettings | null = null;

export async function getMeetingSettings(): Promise<MeetingSettings> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const merged: MeetingSettings = {
      ...DEFAULT_MEETING_SETTINGS,
      ...parsed,
      letterhead: { ...DEFAULT_MEETING_SETTINGS.letterhead, ...(parsed.letterhead ?? {}) },
    };
    const from = raw ? (parsed.defaultsVersion ?? 1) : MEETING_DEFAULTS_VERSION;
    if (from < MEETING_DEFAULTS_VERSION) {
      // One-time moves to new defaults; later user choices are kept.
      if (from < 2) {
        merged.language = 'auto';
        merged.task = 'translate';
      }
      if (from < 3) merged.indexForChat = true; // background indexing keeps meetings searchable
      merged.defaultsVersion = MEETING_DEFAULTS_VERSION;
      await AsyncStorage.setItem(KEY, JSON.stringify(merged));
    }
    cache = merged;
  } catch {
    cache = { ...DEFAULT_MEETING_SETTINGS };
  }
  return cache!;
}

export async function saveMeetingSettings(s: MeetingSettings): Promise<void> {
  cache = s;
  await AsyncStorage.setItem(KEY, JSON.stringify(s));
}

/** Whisper language options exposed in the UI (Whisper supports ~99). */
export const LANGUAGE_OPTIONS: { code: string; label: string }[] = [
  { code: 'auto', label: 'Auto-detect' },
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'Hindi' },
  { code: 'mr', label: 'Marathi' },
  { code: 'gu', label: 'Gujarati' },
  { code: 'ta', label: 'Tamil' },
  { code: 'te', label: 'Telugu' },
  { code: 'bn', label: 'Bengali' },
];
