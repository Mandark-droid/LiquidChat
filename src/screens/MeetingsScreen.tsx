import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  Button,
  Card,
  Chip,
  EmptyState,
  Field,
  HeaderButton,
  ScreenHeader,
  Segmented,
  ui,
} from '../components/ui';
import { theme } from '../config/theme';
import { useLiveSession, useMeetingList } from '../meetings/hooks';
import { detectSpeakers, parseAttendees, parseTranscript } from '../meetings/importTranscript';
import { meetingSession } from '../meetings/MeetingSession';
import { meetingStore } from '../meetings/MeetingStore';
import { defaultTitle, formatClock } from '../meetings/MinutesGenerator';
import { isAudioImportAvailable, isRecorderAvailable, Recorder } from '../meetings/native';
import { getMeetingSettings } from '../meetings/settings';
import type { MeetingIndexEntry, MeetingStatus, PickedAudio } from '../meetings/types';

interface Props {
  onOpenMeeting: (id: string) => void;
  onOpenRecorder: () => void;
  onOpenSettings: () => void;
}

const STATUS_LABEL: Record<
  MeetingStatus,
  { label: string; tone: 'warn' | 'ok' | 'info' | 'muted' }
> = {
  recording: { label: '● Recording', tone: 'warn' },
  paused: { label: 'Paused', tone: 'warn' },
  transcribing: { label: 'Transcribing…', tone: 'info' },
  summarizing: { label: 'Writing minutes…', tone: 'info' },
  ready: { label: 'Ready', tone: 'ok' },
  interrupted: { label: 'Interrupted', tone: 'warn' },
  error: { label: 'Needs attention', tone: 'warn' },
};

export default function MeetingsScreen({ onOpenMeeting, onOpenRecorder, onOpenSettings }: Props) {
  const { meetings, refresh } = useMeetingList();
  const live = useLiveSession();
  const [clientFilter, setClientFilter] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'none' | 'new'>('none');
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    meetingSession.recoverInterrupted().catch(() => {});
  }, []);

  const clients = useMemo(() => {
    const c = new Map<string, number>();
    meetings.forEach(m => m.client && c.set(m.client, (c.get(m.client) ?? 0) + 1));
    return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  }, [meetings]);

  const visible = clientFilter ? meetings.filter(m => m.client === clientFilter) : meetings;
  const openActions = meetings.reduce((n, m) => n + m.openActions, 0);
  const recordingActive =
    live.phase === 'recording' || live.phase === 'paused' || live.phase === 'starting';

  return (
    <SafeAreaView style={ui.screen} edges={['top']}>
      <ScreenHeader
        title="Meetings"
        subtitle={`${meetings.length} meetings · ${openActions} open action items`}
        right={<HeaderButton label="⚙" onPress={onOpenSettings} />}
      />

      {recordingActive || live.phase === 'transcribing' || live.phase === 'summarizing' ? (
        <TouchableOpacity
          style={[styles.liveBanner, !recordingActive && { backgroundColor: theme.colors.accent }]}
          onPress={() =>
            recordingActive ? onOpenRecorder() : live.meetingId && onOpenMeeting(live.meetingId)
          }
        >
          <Text style={styles.liveText}>
            {recordingActive
              ? `${live.phase === 'paused' ? '⏸ Paused' : '● Recording'} · ${formatClock(live.elapsedMs)}`
              : `${live.progressLabel ?? 'Processing'}${live.progress ? ` · ${Math.round(live.progress * 100)}%` : ''}`}
          </Text>
          <Text style={styles.liveText}>Open ›</Text>
        </TouchableOpacity>
      ) : null}

      <ScrollView
        contentContainerStyle={{ paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await refresh();
              setRefreshing(false);
            }}
            tintColor={theme.colors.accent}
          />
        }
      >
        <View style={[ui.pad, { paddingTop: 16 }]}>
          <Button
            label={recordingActive ? 'Recording in progress' : '●  New meeting'}
            kind="record"
            disabled={recordingActive}
            onPress={() => setSheet('new')}
          />
        </View>

        {clients.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chips}
          >
            <Chip
              label="All clients"
              active={!clientFilter}
              onPress={() => setClientFilter(null)}
            />
            {clients.map(c => (
              <Chip
                key={c}
                label={c}
                active={clientFilter === c}
                onPress={() => setClientFilter(clientFilter === c ? null : c)}
              />
            ))}
          </ScrollView>
        ) : null}

        {visible.length === 0 ? (
          <EmptyState
            title="No meetings yet"
            body="Record a client call or paste a Zoom/Meet/Teams transcript. Transcription and minutes run entirely on your phone."
          />
        ) : (
          <View style={[ui.pad, { gap: 8, marginTop: 8 }]}>
            {visible.map(m => (
              <MeetingRow
                key={m.id}
                m={m}
                onPress={() => onOpenMeeting(m.id)}
                onDeleted={refresh}
              />
            ))}
          </View>
        )}
      </ScrollView>

      <NewMeetingSheet
        visible={sheet === 'new'}
        knownClients={clients}
        onClose={() => setSheet('none')}
        onStarted={() => {
          setSheet('none');
          onOpenRecorder();
        }}
        onImported={id => {
          setSheet('none');
          onOpenMeeting(id);
        }}
      />
    </SafeAreaView>
  );
}

function MeetingRow({
  m,
  onPress,
  onDeleted,
}: {
  m: MeetingIndexEntry;
  onPress: () => void;
  onDeleted: () => void;
}) {
  const st = STATUS_LABEL[m.status];
  const d = new Date(m.startedAt);
  return (
    <TouchableOpacity
      activeOpacity={0.75}
      onPress={onPress}
      onLongPress={() =>
        Alert.alert('Delete meeting', `Delete "${m.title}" with its audio and transcript?`, [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: async () => {
              await meetingStore.delete(m.id);
              onDeleted();
            },
          },
        ])
      }
    >
      <Card>
        <View style={[ui.row, { justifyContent: 'space-between' }]}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {m.title}
          </Text>
          <Chip label={st.label} tone={st.tone} />
        </View>
        <Text style={[ui.muted, { marginTop: 4 }]}>
          {d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })} ·{' '}
          {d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
          {m.durationMs > 0 ? ` · ${Math.max(1, Math.round(m.durationMs / 60000))} min` : ''}
          {m.client ? ` · ${m.client}` : ''}
        </Text>
        {m.totalActions > 0 ? (
          <Text style={[styles.actions, m.openActions === 0 && { color: theme.colors.success }]}>
            {m.openActions > 0
              ? `${m.openActions} open of ${m.totalActions} action items`
              : `All ${m.totalActions} action items done`}
          </Text>
        ) : null}
      </Card>
    </TouchableOpacity>
  );
}

function NewMeetingSheet({
  visible,
  knownClients,
  onClose,
  onStarted,
  onImported,
}: {
  visible: boolean;
  knownClients: string[];
  onClose: () => void;
  onStarted: () => void;
  onImported: (id: string) => void;
}) {
  const [mode, setMode] = useState<'record' | 'upload' | 'import'>('record');
  const [file, setFile] = useState<PickedAudio | null>(null);
  const [title, setTitle] = useState('');
  const [client, setClient] = useState('');
  const [attendees, setAttendees] = useState('');
  const [agenda, setAgenda] = useState('');
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (visible) {
      setTitle('');
      setAgenda('');
      setPasted('');
      setFile(null);
      setBusy(false);
    }
  }, [visible]);

  const start = async () => {
    if (!isRecorderAvailable()) {
      Alert.alert(
        'Rebuild required',
        'The meeting recorder native module is missing. Rebuild the Android app.',
      );
      return;
    }
    setBusy(true);
    try {
      await meetingSession.start({
        title,
        client,
        attendees: parseAttendees(attendees),
        agenda,
      });
      onStarted();
    } catch (e) {
      Alert.alert('Could not start', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pickFile = async () => {
    if (!isAudioImportAvailable()) {
      Alert.alert('Rebuild required', 'Audio upload needs the latest app build.');
      return;
    }
    try {
      const picked = await Recorder.pickAudio();
      if (picked) setFile(picked);
    } catch (e) {
      Alert.alert('Could not open file', e instanceof Error ? e.message : String(e));
    }
  };

  const uploadNow = async () => {
    if (!file) {
      await pickFile();
      return;
    }
    setBusy(true);
    try {
      const id = await meetingSession.importRecording({
        file,
        title,
        client,
        attendees: parseAttendees(attendees),
        agenda,
      });
      onImported(id);
    } catch (e) {
      Alert.alert('Upload failed', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const importNow = async () => {
    const segments = parseTranscript(pasted);
    if (!segments.length) {
      Alert.alert('Nothing to import', 'Paste a transcript first.');
      return;
    }
    setBusy(true);
    try {
      const settings = await getMeetingSettings();
      const now = Date.now();
      const people = parseAttendees(attendees);
      for (const sp of detectSpeakers(segments)) {
        if (!people.some(p => p.name.toLowerCase() === sp.toLowerCase())) people.push({ name: sp });
      }
      const timed = segments.filter(s => s.startMs >= 0);
      const duration = timed.length ? Math.max(...timed.map(s => s.startMs)) : 0;
      const id = meetingStore.newId();
      await meetingStore.create({
        schemaVersion: 1,
        id,
        title: title.trim() || defaultTitle(now, client.trim() || undefined),
        client: client.trim() || undefined,
        attendees: people,
        agenda: agenda.trim() || undefined,
        startedAt: now,
        endedAt: now,
        durationMs: duration,
        status: 'summarizing',
        source: 'import',
        language: settings.language,
        segments,
        markers: [],
        actionItems: [],
        updatedAt: now,
      });
      meetingSession.processMeeting(id, { forceMinutes: true }).catch(() => {});
      onImported(id);
    } catch (e) {
      Alert.alert('Import failed', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.sheet}>
          <View style={[ui.row, { justifyContent: 'space-between', marginBottom: 12 }]}>
            <Text style={styles.sheetTitle}>New meeting</Text>
            <TouchableOpacity onPress={onClose} hitSlop={12}>
              <Text style={styles.close}>✕</Text>
            </TouchableOpacity>
          </View>
          <Segmented
            options={[
              { key: 'record', label: 'Record' },
              { key: 'upload', label: 'Upload' },
              { key: 'import', label: 'Paste text' },
            ]}
            value={mode}
            onChange={setMode}
          />
          <ScrollView style={{ marginTop: 12 }} keyboardShouldPersistTaps="handled">
            <Field
              label="Title (optional)"
              value={title}
              onChangeText={setTitle}
              placeholder="Auto-generated from the discussion"
            />
            <Field
              label="Client"
              value={client}
              onChangeText={setClient}
              placeholder="e.g. Acme Bank"
            />
            {knownClients.length > 0 ? (
              <View style={[ui.wrap, { marginTop: -6, marginBottom: 12 }]}>
                {knownClients.slice(0, 8).map(c => (
                  <Chip key={c} label={c} active={client === c} onPress={() => setClient(c)} />
                ))}
              </View>
            ) : null}
            <Field
              label="Attendees"
              value={attendees}
              onChangeText={setAttendees}
              placeholder="Rahul Mehta <rahul@acme.com>; Priya (Acme)"
              hint="Names improve transcription; emails pre-fill the follow-up mail."
            />
            <Field
              label="Agenda (optional)"
              value={agenda}
              onChangeText={setAgenda}
              multiline
              placeholder="What should this meeting decide?"
            />
            {mode === 'upload' ? (
              <View style={{ marginBottom: 12 }}>
                <Text style={styles.fieldLabel}>Recording</Text>
                <TouchableOpacity style={styles.filePick} onPress={pickFile} activeOpacity={0.75}>
                  <Text style={styles.fileName}>
                    {file ? file.name : 'Choose an audio or video file'}
                  </Text>
                  <Text style={ui.muted}>
                    {file
                      ? [
                          file.durationMs > 0 ? formatClock(file.durationMs) : null,
                          file.size > 0 ? `${(file.size / 1048576).toFixed(1)} MB` : null,
                          'tap to change',
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : 'm4a, mp3, wav, ogg, opus, amr, mp4 — from Files, Drive, WhatsApp, Recorder'}
                  </Text>
                </TouchableOpacity>
                <Text style={[ui.muted, { marginTop: 8 }]}>
                  Transcribed and summarised on this phone. Long recordings take a while; you can
                  leave the screen.
                </Text>
              </View>
            ) : mode === 'import' ? (
              <Field
                label="Transcript"
                value={pasted}
                onChangeText={setPasted}
                multiline
                style={{ minHeight: 180 }}
                placeholder="Paste from Zoom, Google Meet, Teams, Otter or a .vtt file"
              />
            ) : (
              <Text style={[ui.muted, { marginBottom: 12 }]}>
                Recording continues with the screen off. Audio and transcript stay on this phone.
              </Text>
            )}
          </ScrollView>
          <Button
            label={
              mode === 'record'
                ? '●  Start recording'
                : mode === 'upload'
                  ? file
                    ? 'Transcribe & write minutes'
                    : 'Choose file'
                  : 'Import & write minutes'
            }
            kind={mode === 'record' ? 'record' : 'primary'}
            loading={busy}
            onPress={mode === 'record' ? start : mode === 'upload' ? uploadNow : importNow}
          />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  liveBanner: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: theme.colors.error,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: 10,
  },
  liveText: { color: theme.colors.textLight, fontWeight: '700', fontSize: theme.fontSize.md },
  chips: { paddingHorizontal: theme.spacing.lg, paddingTop: 14, gap: 6 },
  rowTitle: {
    flex: 1,
    fontSize: theme.fontSize.lg,
    fontWeight: '700',
    color: theme.colors.text,
    marginRight: 8,
  },
  actions: {
    marginTop: 6,
    fontSize: theme.fontSize.sm,
    color: theme.colors.warning,
    fontWeight: '600',
  },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: theme.colors.background,
    borderTopLeftRadius: theme.borderRadius.xl,
    borderTopRightRadius: theme.borderRadius.xl,
    padding: theme.spacing.lg,
    paddingBottom: 28,
    maxHeight: '92%',
  },
  sheetTitle: { fontSize: theme.fontSize.xl, fontWeight: '700', color: theme.colors.text },
  close: { fontSize: 20, color: theme.colors.textSecondary },
  fieldLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: '600',
    color: theme.colors.textSecondary,
    marginBottom: 6,
  },
  filePick: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing.lg,
    gap: 4,
  },
  fileName: {
    fontSize: theme.fontSize.md,
    fontWeight: '600',
    color: theme.colors.text,
    flexShrink: 1,
  },
});
