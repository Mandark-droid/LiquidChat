/**
 * Dropdown for the reply voice: the voices installed in the phone's TTS engine, filterable,
 * with a preview on selection. Replaces a free-text field that expected a raw voice id.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { theme } from '../config/theme';
import { getAvailableVoices, setVoice, speak, type TTSVoice } from '../utils/ttsManager';

const DEFAULT_LABEL = 'System default';

// Hermes has no Intl.DisplayNames, so the languages people here are likely to pick are named
// in-app; anything else keeps its tag.
const LANGUAGES: Record<string, string> = {
  en: 'English',
  hi: 'Hindi',
  mr: 'Marathi',
  gu: 'Gujarati',
  ta: 'Tamil',
  te: 'Telugu',
  bn: 'Bengali',
  kn: 'Kannada',
  ml: 'Malayalam',
  pa: 'Punjabi',
  ur: 'Urdu',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  ja: 'Japanese',
  zh: 'Chinese',
  ar: 'Arabic',
};
const REGIONS: Record<string, string> = {
  US: 'US',
  GB: 'UK',
  IN: 'India',
  AU: 'Australia',
  CA: 'Canada',
  NG: 'Nigeria',
  BR: 'Brazil',
  ES: 'Spain',
  MX: 'Mexico',
  FR: 'France',
};

export function languageName(tag: string): string {
  const [lang, region] = tag.replace('_', '-').split('-');
  const name = LANGUAGES[lang?.toLowerCase()];
  if (!name) return tag;
  return region ? `${name} (${REGIONS[region.toUpperCase()] ?? region.toUpperCase()})` : name;
}

/** Google voice ids ("en-in-x-ena-local", "en-IN-language") as something readable. */
export function voiceName(v: TTSVoice): string {
  const variant = /-x-([a-z0-9]+)-(?:local|network)$/i.exec(v.id)?.[1];
  if (variant) return `${languageName(v.language)} · Voice ${variant.toUpperCase()}`;
  if (/-language$/i.test(v.id)) return `${languageName(v.language)} · Standard`;
  return v.name;
}

function describe(v: TTSVoice): string {
  return [v.id, v.network ? 'online (needs internet)' : 'offline'].join(' · ');
}

export default function VoicePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [voices, setVoices] = useState<TTSVoice[] | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    getAvailableVoices().then(setVoices);
  }, []);

  const selected = voices?.find(v => v.id === value);
  const label = !value
    ? DEFAULT_LABEL
    : selected
      ? voiceName(selected)
      : `${value} (not installed)`;

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = voices ?? [];
    if (!q) return list;
    return list.filter(v => `${voiceName(v)} ${v.id} ${v.language}`.toLowerCase().includes(q));
  }, [voices, filter]);

  const pick = async (id: string) => {
    onChange(id);
    setOpen(false);
    await setVoice(id);
    speak('This is how replies will sound.');
  };

  return (
    <>
      <TouchableOpacity
        style={styles.field}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`TTS voice: ${label}`}
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.value} numberOfLines={1}>
            {label}
          </Text>
          {selected ? <Text style={styles.sub}>{describe(selected)}</Text> : null}
        </View>
        <Text style={styles.caret}>▾</Text>
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={[styles.sheet, { paddingBottom: 8 + insets.bottom }]}>
            <Text style={styles.title}>Reply voice</Text>
            <TextInput
              style={styles.search}
              value={filter}
              onChangeText={setFilter}
              placeholder="Filter by name or language (e.g. en-IN, Hindi)"
              placeholderTextColor={theme.colors.textMuted}
            />
            {voices === null ? (
              <ActivityIndicator style={{ margin: 24 }} color={theme.colors.accent} />
            ) : (
              <FlatList
                data={[null, ...shown]}
                keyExtractor={v => v?.id ?? '__default'}
                keyboardShouldPersistTaps="handled"
                ListEmptyComponent={null}
                ListFooterComponent={
                  voices.length === 0 ? (
                    <Text style={styles.sub}>
                      The phone's text-to-speech engine reported no voices. Install voice data in
                      Android Settings → Text-to-speech.
                    </Text>
                  ) : null
                }
                renderItem={({ item }) => {
                  const id = item?.id ?? '';
                  const active = id === value;
                  return (
                    <TouchableOpacity
                      style={[styles.row, active && styles.rowActive]}
                      onPress={() => pick(id)}
                    >
                      <Text style={[styles.value, active && styles.activeText]} numberOfLines={1}>
                        {item ? voiceName(item) : DEFAULT_LABEL}
                      </Text>
                      <Text style={styles.sub}>
                        {item ? describe(item) : "The TTS engine's own choice"}
                      </Text>
                    </TouchableOpacity>
                  );
                }}
              />
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.inputBg,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    marginTop: theme.spacing.sm,
  },
  value: { fontSize: theme.fontSize.md, color: theme.colors.text },
  sub: { fontSize: theme.fontSize.sm, color: theme.colors.textSecondary, marginTop: 2 },
  caret: { fontSize: theme.fontSize.md, color: theme.colors.textSecondary, marginLeft: 8 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '75%',
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.borderRadius.lg,
    borderTopRightRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.lg,
  },
  title: {
    fontSize: theme.fontSize.lg,
    fontWeight: '700',
    color: theme.colors.text,
    marginBottom: theme.spacing.sm,
  },
  search: {
    backgroundColor: theme.colors.inputBg,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    color: theme.colors.text,
    marginBottom: theme.spacing.sm,
  },
  row: {
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.sm,
    borderRadius: theme.borderRadius.sm,
  },
  rowActive: { backgroundColor: theme.colors.toolCallBg },
  activeText: { color: theme.colors.accent, fontWeight: '700' },
});
