import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, ProgressBar, ScreenHeader, ui } from '../components/ui';
import { theme } from '../config/theme';
import { useLiveSession, useMeeting, useTranscriberStatus } from '../meetings/hooks';
import { meetingSession } from '../meetings/MeetingSession';
import { formatClock } from '../meetings/MinutesGenerator';

interface Props {
  onBack: () => void;
  onFinished: (meetingId: string) => void;
}

const BARS = 32;

export default function MeetingRecorderScreen({ onBack, onFinished }: Props) {
  const live = useLiveSession();
  const meeting = useMeeting(live.meetingId);
  const stt = useTranscriberStatus();
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0));
  const [markerOpen, setMarkerOpen] = useState(false);
  const [markerText, setMarkerText] = useState('');
  const scrollRef = useRef<ScrollView>(null);
  const meetingIdRef = useRef<string | null>(null);

  if (live.meetingId) meetingIdRef.current = live.meetingId;

  useEffect(() => {
    // dBFS -> 0..1 (−60 dB floor)
    const v = Math.max(0, Math.min(1, (live.levelDb + 60) / 50));
    setLevels(prev => [...prev.slice(1), live.phase === 'recording' ? v : 0]);
  }, [live.levelDb, live.phase]);

  // When recording ends the session moves to post-processing; hand over to the detail screen.
  useEffect(() => {
    if ((live.phase === 'idle' || live.phase === 'transcribing') && meetingIdRef.current) {
      onFinished(meetingIdRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.phase]);

  const segments = meeting?.segments ?? [];
  const doneText = segments.filter(s => s.status === 'done' && s.text);
  const pending = segments.filter(s => s.status === 'pending').length;

  const stop = () =>
    Alert.alert(
      'Stop recording?',
      'The rest of the audio will be transcribed and minutes written on-device.',
      [
        { text: 'Keep recording', style: 'cancel' },
        {
          text: 'Stop & process',
          style: 'destructive',
          onPress: () => {
            meetingSession.stop().catch(() => {});
          },
        },
      ],
    );

  const addMarker = async () => {
    await meetingSession.addMarker(markerText || 'Important');
    setMarkerText('');
    setMarkerOpen(false);
  };

  const sttLine =
    stt.phase === 'downloading'
      ? `Downloading speech model… ${Math.round(stt.downloadProgress * 100)}%`
      : stt.phase === 'initializing'
        ? 'Loading speech model…'
        : stt.phase === 'error'
          ? `Speech model error: ${stt.error ?? ''}`
          : pending > 0
            ? `Transcribing · ${pending} segment${pending > 1 ? 's' : ''} queued`
            : doneText.length
              ? 'Live transcript'
              : 'Listening — first text appears after ~20 s';

  return (
    <SafeAreaView style={ui.screen} edges={['top']}>
      <ScreenHeader
        title={meeting?.title ?? 'Meeting'}
        subtitle={meeting?.client ?? 'Recording on-device'}
        onBack={onBack}
      />

      <View style={styles.top}>
        <Text style={styles.timer}>{formatClock(live.elapsedMs)}</Text>
        <Text style={[styles.state, live.phase === 'paused' && { color: theme.colors.warning }]}>
          {live.phase === 'paused'
            ? 'PAUSED'
            : live.phase === 'starting'
              ? 'STARTING…'
              : live.phase === 'stopping'
                ? 'STOPPING…'
                : '● REC'}
        </Text>
        <View style={styles.meter}>
          {levels.map((v, i) => (
            <View
              key={i}
              style={[
                styles.bar,
                { height: 4 + v * 44, opacity: 0.35 + 0.65 * (i / BARS) },
                live.isSpeech && i === BARS - 1 && { backgroundColor: theme.colors.secondary },
              ]}
            />
          ))}
        </View>
        {live.silenced ? (
          <Text style={styles.warn}>Another app is using the microphone — audio is silent.</Text>
        ) : null}
        {live.error ? <Text style={styles.warn}>{live.error}</Text> : null}
      </View>

      <View style={[ui.pad, { marginBottom: 6 }]}>
        <Text style={ui.muted}>{sttLine}</Text>
        {stt.phase === 'downloading' ? <ProgressBar value={stt.downloadProgress} /> : null}
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.transcript}
        contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: 24 }}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        {doneText.length === 0 ? (
          <Text style={[ui.muted, { textAlign: 'center', marginTop: 24 }]}>
            Speak normally. The phone transcribes every ~20–30 seconds.
          </Text>
        ) : (
          doneText.map(s => (
            <Text key={s.index} style={styles.line}>
              <Text style={styles.ts}>{formatClock(s.startMs)} </Text>
              {s.text}
            </Text>
          ))
        )}
        {(meeting?.markers ?? []).map((mk, i) => (
          <Text key={`mk${i}`} style={styles.marker}>
            ★ {formatClock(mk.atMs)} — {mk.note}
          </Text>
        ))}
      </ScrollView>

      {markerOpen ? (
        <View style={styles.markerRow}>
          <TextInput
            autoFocus
            value={markerText}
            onChangeText={setMarkerText}
            placeholder="What was important? (optional)"
            placeholderTextColor={theme.colors.textMuted}
            style={styles.markerInput}
            onSubmitEditing={addMarker}
          />
          <Button label="Add" small onPress={addMarker} />
        </View>
      ) : null}

      <View style={styles.controls}>
        <TouchableOpacity style={styles.ctrl} onPress={() => setMarkerOpen(o => !o)}>
          <Text style={styles.ctrlIcon}>★</Text>
          <Text style={styles.ctrlLabel}>Mark</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.ctrl, styles.ctrlMain]}
          onPress={() =>
            live.phase === 'paused' ? meetingSession.resume() : meetingSession.pause()
          }
          disabled={live.phase !== 'recording' && live.phase !== 'paused'}
        >
          <Text style={[styles.ctrlIcon, { color: theme.colors.textLight }]}>
            {live.phase === 'paused' ? '▶' : '❚❚'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.ctrl}
          onPress={stop}
          disabled={live.phase !== 'recording' && live.phase !== 'paused'}
        >
          <Text style={[styles.ctrlIcon, { color: theme.colors.error }]}>■</Text>
          <Text style={styles.ctrlLabel}>Stop</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  top: { alignItems: 'center', paddingTop: 20, paddingBottom: 12 },
  timer: {
    fontSize: 52,
    fontWeight: '200',
    color: theme.colors.text,
    fontVariant: ['tabular-nums'],
  },
  state: {
    fontSize: theme.fontSize.sm,
    fontWeight: '800',
    letterSpacing: 2,
    color: theme.colors.error,
    marginTop: 2,
  },
  meter: { flexDirection: 'row', alignItems: 'center', height: 52, gap: 3, marginTop: 14 },
  bar: { width: 5, borderRadius: 3, backgroundColor: theme.colors.accent },
  warn: {
    color: theme.colors.error,
    fontSize: theme.fontSize.sm,
    marginTop: 8,
    paddingHorizontal: 24,
    textAlign: 'center',
  },
  transcript: {
    flex: 1,
    marginHorizontal: theme.spacing.lg,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  line: { fontSize: theme.fontSize.md, color: theme.colors.text, lineHeight: 22, marginBottom: 8 },
  ts: { color: theme.colors.textMuted, fontSize: theme.fontSize.sm, fontVariant: ['tabular-nums'] },
  marker: { color: theme.colors.warning, fontWeight: '600', marginTop: 4 },
  markerRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: 10,
    alignItems: 'center',
  },
  markerInput: {
    flex: 1,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: theme.colors.text,
  },
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingVertical: 18,
  },
  ctrl: { alignItems: 'center', width: 72 },
  ctrlMain: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: theme.colors.primary,
    justifyContent: 'center',
  },
  ctrlIcon: { fontSize: 26, color: theme.colors.text },
  ctrlLabel: { fontSize: theme.fontSize.sm, color: theme.colors.textSecondary, marginTop: 2 },
});
