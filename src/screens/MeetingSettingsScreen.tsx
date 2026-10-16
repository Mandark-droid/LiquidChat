import React, { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  Card,
  Chip,
  Field,
  ScreenHeader,
  SectionTitle,
  Segmented,
  ToggleRow,
  ui,
} from '../components/ui';
import { COMPLETION_MODELS, STT_MODELS } from '../config/models';
import { theme } from '../config/theme';
import {
  DEFAULT_MEETING_SETTINGS,
  getMeetingSettings,
  LANGUAGE_OPTIONS,
  saveMeetingSettings,
} from '../meetings/settings';
import { isWhisperModel } from '../meetings/Transcriber';
import type { MeetingSettings } from '../meetings/types';

export default function MeetingSettingsScreen({ onBack }: { onBack: () => void }) {
  const [s, setS] = useState<MeetingSettings>(DEFAULT_MEETING_SETTINGS);

  useEffect(() => {
    getMeetingSettings().then(setS);
  }, []);

  const update = (patch: Partial<MeetingSettings>) => {
    const next = { ...s, ...patch };
    setS(next);
    saveMeetingSettings(next);
  };
  const updateLh = (patch: Partial<MeetingSettings['letterhead']>) =>
    update({ letterhead: { ...s.letterhead, ...patch } });

  const whisper = isWhisperModel(s.sttModel);

  return (
    <SafeAreaView style={ui.screen} edges={['top']}>
      <ScreenHeader title="Meeting settings" onBack={onBack} />
      <ScrollView
        contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: 48 }}
        keyboardShouldPersistTaps="handled"
      >
        <SectionTitle>Transcription</SectionTitle>
        <Card>
          <Text style={ui.muted}>Speech model</Text>
          <View style={[ui.wrap, { marginTop: 8 }]}>
            {STT_MODELS().map(m => (
              <Chip
                key={m.slug}
                label={`${m.name} · ${m.sizeMb} MB`}
                active={s.sttModel === m.slug}
                onPress={() => update({ sttModel: m.slug })}
              />
            ))}
          </View>
          <Text style={[ui.muted, { marginTop: 10 }]}>
            Whisper Small is the balanced default (Hindi + English, translate). Parakeet is the most
            accurate for English/European meetings. Moonshine is tiny and English-only.
          </Text>

          <Text style={[ui.muted, { marginTop: 16 }]}>
            Language {whisper ? '' : '(Whisper only)'}
          </Text>
          <View style={[ui.wrap, { marginTop: 8, opacity: whisper ? 1 : 0.4 }]}>
            {LANGUAGE_OPTIONS.map(l => (
              <Chip
                key={l.code}
                label={l.label}
                active={s.language === l.code}
                onPress={whisper ? () => update({ language: l.code }) : undefined}
              />
            ))}
          </View>
          <View style={{ marginTop: 14, opacity: whisper ? 1 : 0.4 }}>
            <Segmented
              options={[
                { key: 'transcribe', label: 'Keep original language' },
                { key: 'translate', label: 'Translate to English' },
              ]}
              value={s.task}
              onChange={v => whisper && update({ task: v })}
            />
          </View>
          <ToggleRow
            label="Context prompting"
            hint="Feeds client, attendee names and the previous sentence to Whisper for better names and continuity."
            value={s.contextPrompting}
            onValueChange={v => update({ contextPrompting: v })}
          />
          <Field
            label="Custom vocabulary"
            value={s.vocabulary}
            onChangeText={v => update({ vocabulary: v })}
            placeholder="UPI, NetBanking, Kubernetes, OpenTelemetry"
            hint="Product names and jargon that often get misheard."
          />
          <Text style={ui.muted}>Microphone</Text>
          <View style={[ui.wrap, { marginTop: 8 }]}>
            {(
              [
                ['voice_recognition', 'Voice (default)'],
                ['mic', 'Raw mic'],
                ['voice_communication', 'Speakerphone / echo-cancel'],
                ['camcorder', 'Room (far-field)'],
              ] as const
            ).map(([k, label]) => (
              <Chip
                key={k}
                label={label}
                active={s.audioSource === k}
                onPress={() => update({ audioSource: k })}
              />
            ))}
          </View>
        </Card>

        <SectionTitle>Minutes</SectionTitle>
        <Card>
          <Text style={ui.muted}>Summarisation model</Text>
          <View style={[ui.wrap, { marginTop: 8 }]}>
            {COMPLETION_MODELS().map(m => (
              <Chip
                key={m.slug}
                label={`${m.name}${m.minRamGb ? ` · ${m.minRamGb} GB+` : ''}`}
                active={s.summaryModel === m.slug}
                onPress={() => update({ summaryModel: m.slug })}
              />
            ))}
          </View>
          <Text style={[ui.muted, { marginTop: 10 }]}>
            LFM2-2.6B writes noticeably better minutes on 8 GB+ phones; LFM2.5-1.2B is the fast
            default.
          </Text>
          <ToggleRow
            label="Write minutes automatically"
            value={s.autoGenerateMinutes}
            onValueChange={v => update({ autoGenerateMinutes: v })}
          />
          <ToggleRow
            label="Make meetings searchable in chat"
            hint="Indexes minutes + transcript into on-device memory (needs the embedding model)."
            value={s.indexForChat}
            onValueChange={v => update({ indexForChat: v })}
          />
          <ToggleRow
            label="Keep audio after transcription"
            hint="~115 MB per hour. Lets you re-transcribe with a better model later."
            value={s.keepAudio}
            onValueChange={v => update({ keepAudio: v })}
          />
        </Card>

        <SectionTitle>Document branding</SectionTitle>
        <Card>
          <Field
            label="Organisation name"
            value={s.letterhead.companyName}
            onChangeText={v => updateLh({ companyName: v })}
            placeholder="LiquidChat"
            hint="Shown as the letterhead. Leave empty to brand documents as LiquidChat."
          />
          <Field
            label="Prepared by"
            value={s.letterhead.preparedBy}
            onChangeText={v => updateLh({ preparedBy: v })}
            placeholder="Your name"
          />
          <Field
            label="Contact line"
            value={s.letterhead.contactLine}
            onChangeText={v => updateLh({ contactLine: v })}
            placeholder="you@example.com · +91 …"
          />
          <Field
            label="Footer note"
            value={s.letterhead.footerNote}
            onChangeText={v => updateLh({ footerNote: v })}
          />
          <Field
            label="Accent colour"
            value={s.letterhead.accentColor}
            onChangeText={v => updateLh({ accentColor: v })}
            autoCapitalize="none"
            placeholder="#3A8FB7"
          />
          <Text style={ui.muted}>
            Every document ends with “Generated on-device by LiquidChat”.
          </Text>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}
