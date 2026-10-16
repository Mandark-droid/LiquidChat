import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
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
  ProgressBar,
  ScreenHeader,
  SectionTitle,
  Segmented,
  ToggleRow,
  ui,
} from '../components/ui';
import { theme } from '../config/theme';
import { resolveDue } from '../meetings/dateResolver';
import {
  type ExportFormat,
  type ExportOptions,
  fmtDue,
  saveMinutesToDownloads,
  shareMinutes,
} from '../meetings/documents';
import { useLiveSession, useMeeting } from '../meetings/hooks';
import { formatAttendees, parseAttendees } from '../meetings/importTranscript';
import { meetingSession } from '../meetings/MeetingSession';
import { meetingStore, newActionId } from '../meetings/MeetingStore';
import { formatClock } from '../meetings/MinutesGenerator';
import type { ActionItem, ActionPriority, Meeting, Minutes } from '../meetings/types';
import { createCalendarEvent } from '../tools/calendarEvent';

interface Props {
  meetingId: string;
  onBack: () => void;
  onOpenRecorder: () => void;
  onDraftEmail: (meetingId: string) => void;
  onAskInChat: (meetingId: string) => void;
}

type Tab = 'minutes' | 'actions' | 'transcript';

export default function MeetingDetailScreen({
  meetingId,
  onBack,
  onOpenRecorder,
  onDraftEmail,
  onAskInChat,
}: Props) {
  const meeting = useMeeting(meetingId);
  const live = useLiveSession();
  const [tab, setTab] = useState<Tab>('minutes');
  const [editing, setEditing] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [editAction, setEditAction] = useState<ActionItem | 'new' | null>(null);
  const [audioBytes, setAudioBytes] = useState(0);

  useEffect(() => {
    meetingStore.storageBytes(meetingId).then(setAudioBytes);
  }, [meetingId, meeting?.audioDeleted, meeting?.segments.length]);

  if (!meeting) {
    return (
      <SafeAreaView style={ui.screen} edges={['top']}>
        <ScreenHeader title="Meeting" onBack={onBack} />
        <ActivityIndicator style={{ marginTop: 40 }} color={theme.colors.accent} />
      </SafeAreaView>
    );
  }

  const processingHere =
    live.meetingId === meetingId && (live.phase === 'transcribing' || live.phase === 'summarizing');
  const recordingHere =
    live.meetingId === meetingId && (live.phase === 'recording' || live.phase === 'paused');
  const busy = processingHere || recordingHere || meetingSession.isBusy(meetingId);
  const openCount = meeting.actionItems.filter(a => a.status === 'open').length;

  const more = () => {
    const opts: { text: string; onPress?: () => void; style?: 'cancel' | 'destructive' }[] = [
      { text: 'Ask about this meeting in chat', onPress: () => onAskInChat(meetingId) },
    ];
    if (meeting.segments.some(s => s.status === 'done')) {
      opts.push({
        text: meeting.minutes ? 'Regenerate minutes' : 'Generate minutes',
        onPress: () => {
          const run = () => meetingSession.processMeeting(meetingId, { forceMinutes: true });
          if (meeting.minutes?.edited) {
            Alert.alert(
              'Overwrite your edits?',
              'Regenerating replaces edited minutes. Action items you added or changed are kept.',
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Regenerate', style: 'destructive', onPress: run },
              ],
            );
          } else run();
        },
      });
    }
    if (meeting.source === 'recording' && !busy && meeting.status !== 'recording') {
      opts.push({
        text: 'Continue recording',
        onPress: async () => {
          try {
            await meetingSession.start({ continueMeetingId: meetingId });
            onOpenRecorder();
          } catch (e) {
            Alert.alert('Could not start', e instanceof Error ? e.message : String(e));
          }
        },
      });
    }
    if (audioBytes > 0) {
      opts.push({
        text: `Delete audio (${(audioBytes / 1e6).toFixed(0)} MB)`,
        style: 'destructive',
        onPress: () => meetingStore.deleteAudio(meetingId),
      });
    }
    opts.push({
      text: 'Delete meeting',
      style: 'destructive',
      onPress: () =>
        Alert.alert('Delete meeting', 'Delete audio, transcript and minutes?', [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: async () => {
              await meetingStore.delete(meetingId);
              onBack();
            },
          },
        ]),
    });
    opts.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert(meeting.title, undefined, opts);
  };

  return (
    <SafeAreaView style={ui.screen} edges={['top']}>
      <ScreenHeader
        title={meeting.title}
        subtitle={[
          new Date(meeting.startedAt).toLocaleDateString('en-IN', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          }),
          meeting.client,
          meeting.durationMs > 0
            ? `${Math.max(1, Math.round(meeting.durationMs / 60000))} min`
            : '',
        ]
          .filter(Boolean)
          .join(' · ')}
        onBack={onBack}
        right={
          <>
            <HeaderButton label="⤴" onPress={() => setExportOpen(true)} />
            <HeaderButton label="⋯" onPress={more} />
          </>
        }
      />

      <View style={[ui.pad, { paddingTop: 12 }]}>
        <Segmented
          options={[
            { key: 'minutes', label: 'Minutes' },
            { key: 'actions', label: `Actions${openCount ? ` (${openCount})` : ''}` },
            { key: 'transcript', label: 'Transcript' },
          ]}
          value={tab}
          onChange={t => {
            setTab(t);
            setEditing(false);
          }}
        />
      </View>

      <StatusCard
        meeting={meeting}
        processing={processingHere}
        recording={recordingHere}
        label={live.progressLabel}
        progress={live.progress}
        onOpenRecorder={onOpenRecorder}
      />

      <ScrollView
        contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: 120 }}
        keyboardShouldPersistTaps="handled"
      >
        {tab === 'minutes' ? (
          editing ? (
            <MinutesEditor meeting={meeting} onDone={() => setEditing(false)} />
          ) : (
            <MinutesView meeting={meeting} onEdit={() => setEditing(true)} />
          )
        ) : tab === 'actions' ? (
          <ActionsView meeting={meeting} onEdit={a => setEditAction(a)} />
        ) : (
          <TranscriptView meeting={meeting} />
        )}
      </ScrollView>

      {!editing ? (
        <View style={styles.footer}>
          <Button
            label="Export MoM"
            kind="secondary"
            style={{ flex: 1 }}
            onPress={() => setExportOpen(true)}
            disabled={!meeting.minutes && openCount === 0}
          />
          <Button
            label="✉ Follow-up email"
            style={{ flex: 1 }}
            onPress={() => onDraftEmail(meetingId)}
            disabled={!meeting.minutes}
          />
        </View>
      ) : null}

      <ExportSheet visible={exportOpen} meeting={meeting} onClose={() => setExportOpen(false)} />
      <ActionEditor meeting={meeting} item={editAction} onClose={() => setEditAction(null)} />
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------

function StatusCard({
  meeting,
  processing,
  recording,
  label,
  progress,
  onOpenRecorder,
}: {
  meeting: Meeting;
  processing: boolean;
  recording: boolean;
  label?: string;
  progress?: number;
  onOpenRecorder: () => void;
}) {
  if (recording) {
    return (
      <TouchableOpacity
        style={[styles.status, { backgroundColor: '#FBE9E9' }]}
        onPress={onOpenRecorder}
      >
        <Text style={[styles.statusText, { color: theme.colors.error }]}>
          ● Recording — tap to open recorder
        </Text>
      </TouchableOpacity>
    );
  }
  if (processing) {
    return (
      <View style={styles.status}>
        <Text style={styles.statusText}>
          {label ?? 'Processing'}… (on-device, keep the app open for best speed)
        </Text>
        <ProgressBar value={progress ?? 0} />
      </View>
    );
  }
  if (meeting.status === 'interrupted' || meeting.status === 'error') {
    return (
      <View style={[styles.status, { backgroundColor: '#FFF1E6' }]}>
        <Text style={styles.statusText}>
          {meeting.status === 'interrupted'
            ? 'This meeting was interrupted (app closed or crashed). Audio on disk is safe.'
            : `Something went wrong: ${meeting.error ?? 'unknown error'}`}
        </Text>
        <Button
          label="Resume processing"
          small
          onPress={() => meetingSession.processMeeting(meeting.id, { forceMinutes: true })}
        />
      </View>
    );
  }
  return null;
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <>
      <SectionTitle>{title}</SectionTitle>
      <Card>
        {items.map((x, i) => (
          <Text key={i} style={[ui.body, i > 0 && { marginTop: 6 }]}>
            • {x}
          </Text>
        ))}
      </Card>
    </>
  );
}

function MinutesView({ meeting, onEdit }: { meeting: Meeting; onEdit: () => void }) {
  const mn = meeting.minutes;
  return (
    <>
      <SectionTitle right={<Button label="Edit" small kind="secondary" onPress={onEdit} />}>
        Details
      </SectionTitle>
      <Card>
        <Text style={ui.body}>
          <Text style={styles.k}>Client </Text>
          {meeting.client ?? '—'}
        </Text>
        <Text style={[ui.body, { marginTop: 4 }]}>
          <Text style={styles.k}>Attendees </Text>
          {meeting.attendees.length ? meeting.attendees.map(a => a.name).join(', ') : '—'}
        </Text>
        {meeting.agenda ? (
          <Text style={[ui.body, { marginTop: 4 }]}>
            <Text style={styles.k}>Agenda </Text>
            {meeting.agenda}
          </Text>
        ) : null}
        {meeting.nextMeeting ? (
          <Text style={[ui.body, { marginTop: 4 }]}>
            <Text style={styles.k}>Next </Text>
            {meeting.nextMeeting}
          </Text>
        ) : null}
      </Card>
      {!mn ? (
        <EmptyState
          title="No minutes yet"
          body={
            meeting.segments.some(s => s.status === 'done')
              ? 'Generate them from the ⋯ menu.'
              : 'Minutes appear after the transcript is ready.'
          }
        />
      ) : (
        <>
          {mn.summary ? (
            <>
              <SectionTitle>Summary</SectionTitle>
              <Card>
                <Text style={ui.body}>{mn.summary}</Text>
              </Card>
            </>
          ) : null}
          <List title="Key discussion points" items={mn.keyPoints} />
          <List title="Decisions" items={mn.decisions} />
          <List title="Open questions" items={mn.openQuestions} />
          <List title="Next steps" items={mn.nextSteps} />
          <Text style={[ui.muted, { marginTop: 16 }]}>
            {mn.edited ? 'Edited by you · ' : ''}Generated on-device with {mn.model} · review before
            sending to clients
          </Text>
        </>
      )}
    </>
  );
}

const lines = (s: string) =>
  s
    .split('\n')
    .map(x => x.replace(/^[-•*]\s*/, '').trim())
    .filter(Boolean);

function MinutesEditor({ meeting, onDone }: { meeting: Meeting; onDone: () => void }) {
  const mn = meeting.minutes;
  const [title, setTitle] = useState(meeting.title);
  const [client, setClient] = useState(meeting.client ?? '');
  const [attendees, setAttendees] = useState(formatAttendees(meeting.attendees));
  const [agenda, setAgenda] = useState(meeting.agenda ?? '');
  const [nextMeeting, setNextMeeting] = useState(meeting.nextMeeting ?? '');
  const [summary, setSummary] = useState(mn?.summary ?? '');
  const [keyPoints, setKeyPoints] = useState((mn?.keyPoints ?? []).join('\n'));
  const [decisions, setDecisions] = useState((mn?.decisions ?? []).join('\n'));
  const [openQ, setOpenQ] = useState((mn?.openQuestions ?? []).join('\n'));
  const [nextSteps, setNextSteps] = useState((mn?.nextSteps ?? []).join('\n'));

  const save = async () => {
    await meetingStore.update(meeting.id, m => {
      m.title = title.trim() || m.title;
      m.client = client.trim() || undefined;
      m.attendees = parseAttendees(attendees);
      m.agenda = agenda.trim() || undefined;
      m.nextMeeting = nextMeeting.trim() || undefined;
      const base: Minutes = m.minutes ?? {
        summary: '',
        keyPoints: [],
        decisions: [],
        openQuestions: [],
        nextSteps: [],
        generatedAt: Date.now(),
        model: 'manual',
        edited: true,
      };
      m.minutes = {
        ...base,
        summary: summary.trim(),
        keyPoints: lines(keyPoints),
        decisions: lines(decisions),
        openQuestions: lines(openQ),
        nextSteps: lines(nextSteps),
        edited: true,
      };
    });
    onDone();
  };

  return (
    <>
      <Field label="Title" value={title} onChangeText={setTitle} />
      <Field label="Client" value={client} onChangeText={setClient} />
      <Field
        label="Attendees"
        value={attendees}
        onChangeText={setAttendees}
        hint="Name (Org) <email>; separated by ;"
      />
      <Field label="Agenda" value={agenda} onChangeText={setAgenda} multiline />
      <Field
        label="Summary"
        value={summary}
        onChangeText={setSummary}
        multiline
        style={{ minHeight: 120 }}
      />
      <Field
        label="Key discussion points (one per line)"
        value={keyPoints}
        onChangeText={setKeyPoints}
        multiline
      />
      <Field
        label="Decisions (one per line)"
        value={decisions}
        onChangeText={setDecisions}
        multiline
      />
      <Field
        label="Open questions (one per line)"
        value={openQ}
        onChangeText={setOpenQ}
        multiline
      />
      <Field
        label="Next steps (one per line)"
        value={nextSteps}
        onChangeText={setNextSteps}
        multiline
      />
      <Field
        label="Next meeting"
        value={nextMeeting}
        onChangeText={setNextMeeting}
        placeholder="e.g. Thu 24 Oct, 4 pm — demo review"
      />
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
        <Button label="Cancel" kind="secondary" style={{ flex: 1 }} onPress={onDone} />
        <Button label="Save" style={{ flex: 1 }} onPress={save} />
      </View>
    </>
  );
}

function ActionsView({
  meeting,
  onEdit,
}: {
  meeting: Meeting;
  onEdit: (a: ActionItem | 'new') => void;
}) {
  const open = meeting.actionItems.filter(a => a.status === 'open');
  const done = meeting.actionItems.filter(a => a.status === 'done');
  const toggle = (a: ActionItem) =>
    meetingStore.update(meeting.id, m => {
      const x = m.actionItems.find(i => i.id === a.id);
      if (!x) return;
      x.status = x.status === 'open' ? 'done' : 'open';
      x.completedAt = x.status === 'done' ? Date.now() : undefined;
    });
  return (
    <>
      <SectionTitle
        right={<Button label="+ Add" small kind="secondary" onPress={() => onEdit('new')} />}
      >
        {`Open (${open.length})`}
      </SectionTitle>
      {open.length === 0 ? <Text style={ui.muted}>Nothing open.</Text> : null}
      {open.map(a => (
        <ActionRow key={a.id} a={a} onToggle={() => toggle(a)} onPress={() => onEdit(a)} />
      ))}
      {done.length ? <SectionTitle>{`Done (${done.length})`}</SectionTitle> : null}
      {done.map(a => (
        <ActionRow key={a.id} a={a} onToggle={() => toggle(a)} onPress={() => onEdit(a)} />
      ))}
    </>
  );
}

export function ActionRow({
  a,
  onToggle,
  onPress,
  subtitle,
}: {
  a: ActionItem;
  onToggle: () => void;
  onPress: () => void;
  subtitle?: string;
}) {
  const overdue =
    a.status === 'open' && a.dueDate && a.dueDate < new Date().toISOString().slice(0, 10);
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.75} style={styles.actionRow}>
      <TouchableOpacity
        onPress={onToggle}
        hitSlop={10}
        style={[styles.check, a.status === 'done' && styles.checkDone]}
      >
        {a.status === 'done' ? <Text style={styles.checkMark}>✓</Text> : null}
      </TouchableOpacity>
      <View style={{ flex: 1 }}>
        <Text style={[ui.body, a.status === 'done' && styles.doneText]}>{a.task}</Text>
        <View style={[ui.wrap, { marginTop: 6 }]}>
          {a.owner ? <Chip label={`👤 ${a.owner}`} tone="muted" /> : null}
          {a.dueDate || a.dueText ? (
            <Chip label={`📅 ${fmtDue(a)}`} tone={overdue ? 'warn' : 'muted'} />
          ) : null}
          {a.priority === 'high' ? <Chip label="High" tone="warn" /> : null}
          {a.calendarAdded ? <Chip label="In calendar" tone="ok" /> : null}
        </View>
        {subtitle ? (
          <Text style={[ui.muted, { marginTop: 4 }]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

function TranscriptView({ meeting }: { meeting: Meeting }) {
  const segs = meeting.segments;
  if (!segs.length) return <EmptyState title="No transcript" />;
  const errors = segs.filter(s => s.status === 'error').length;
  return (
    <>
      {errors > 0 ? (
        <Card style={{ marginBottom: 12, backgroundColor: '#FFF1E6' }}>
          <Text style={ui.body}>{errors} segment(s) failed to transcribe.</Text>
          <Button
            label="Retry"
            small
            onPress={() => meetingSession.processMeeting(meeting.id)}
            style={{ marginTop: 8, alignSelf: 'flex-start' }}
          />
        </Card>
      ) : null}
      {segs.map(s => (
        <View key={s.index} style={{ marginBottom: 10 }}>
          {s.startMs >= 0 ? <Text style={styles.ts}>{formatClock(s.startMs)}</Text> : null}
          <Text
            style={[
              ui.body,
              s.status !== 'done' && { color: theme.colors.textMuted, fontStyle: 'italic' },
            ]}
          >
            {s.status === 'done'
              ? s.text
              : s.status === 'skipped'
                ? '(silence)'
                : s.status === 'pending'
                  ? '(transcribing…)'
                  : `(failed: ${s.error ?? 'error'})`}
          </Text>
        </View>
      ))}
      {meeting.markers.length ? <SectionTitle>Marked moments</SectionTitle> : null}
      {meeting.markers.map((mk, i) => (
        <Text key={i} style={[ui.body, { color: theme.colors.warning }]}>
          ★ {formatClock(mk.atMs)} — {mk.note}
        </Text>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------

function ExportSheet({
  visible,
  meeting,
  onClose,
}: {
  visible: boolean;
  meeting: Meeting;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<ExportFormat>('pdf');
  const [includeTranscript, setIncludeTranscript] = useState(false);
  const [includeCompleted, setIncludeCompleted] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const opts: ExportOptions = { format, includeTranscript, includeCompleted };
  const emails = meeting.attendees.filter(a => a.email).length;

  const run = async (kind: 'share' | 'download' | 'email') => {
    setBusy(kind);
    try {
      if (kind === 'download') {
        const where = await saveMinutesToDownloads(meeting.id, opts);
        Alert.alert('Saved', where);
      } else {
        await shareMinutes(meeting.id, opts, kind === 'email');
      }
      onClose();
    } catch (e) {
      Alert.alert('Export failed', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={[ui.row, { justifyContent: 'space-between', marginBottom: 12 }]}>
            <Text style={styles.sheetTitle}>Export minutes</Text>
            <TouchableOpacity onPress={onClose} hitSlop={12}>
              <Text style={styles.close}>✕</Text>
            </TouchableOpacity>
          </View>
          <Segmented
            options={[
              { key: 'pdf', label: 'PDF' },
              { key: 'docx', label: 'Word' },
              { key: 'md', label: 'Markdown' },
              { key: 'txt', label: 'Text' },
            ]}
            value={format}
            onChange={setFormat}
          />
          <ToggleRow
            label="Include completed action items"
            value={includeCompleted}
            onValueChange={setIncludeCompleted}
          />
          <ToggleRow
            label="Append full transcript"
            hint="Usually keep this off for clients"
            value={includeTranscript}
            onValueChange={setIncludeTranscript}
          />
          {meeting.minutes && !meeting.minutes.edited ? (
            <Text style={[ui.muted, { marginBottom: 10 }]}>
              Tip: minutes are AI-generated — review or edit them before sending.
            </Text>
          ) : null}
          <View style={{ gap: 8 }}>
            <Button
              label={`✉ Email to attendees${emails ? ` (${emails})` : ''}`}
              loading={busy === 'email'}
              onPress={() => run('email')}
            />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button
                label="Share…"
                kind="secondary"
                style={{ flex: 1 }}
                loading={busy === 'share'}
                onPress={() => run('share')}
              />
              <Button
                label="Save to Downloads"
                kind="secondary"
                style={{ flex: 1 }}
                loading={busy === 'download'}
                onPress={() => run('download')}
              />
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function ActionEditor({
  meeting,
  item,
  onClose,
}: {
  meeting: Meeting;
  item: ActionItem | 'new' | null;
  onClose: () => void;
}) {
  const editingItem = item && item !== 'new' ? item : null;
  const [task, setTask] = useState('');
  const [owner, setOwner] = useState('');
  const [due, setDue] = useState('');
  const [priority, setPriority] = useState<ActionPriority>('medium');

  useEffect(() => {
    if (!item) return;
    setTask(editingItem?.task ?? '');
    setOwner(editingItem?.owner ?? '');
    setDue(editingItem?.dueDate ?? editingItem?.dueText ?? '');
    setPriority(editingItem?.priority ?? 'medium');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item]);

  if (!item) return null;

  const save = async () => {
    if (!task.trim()) return;
    const dueDate = resolveDue(due, new Date(meeting.startedAt));
    await meetingStore.update(meeting.id, m => {
      if (editingItem) {
        const x = m.actionItems.find(i => i.id === editingItem.id);
        if (x) {
          x.task = task.trim();
          x.owner = owner.trim() || undefined;
          x.dueText = due.trim() || undefined;
          x.dueDate = dueDate;
          x.priority = priority;
          x.manual = true;
        }
      } else {
        m.actionItems.push({
          id: newActionId(),
          task: task.trim(),
          owner: owner.trim() || undefined,
          dueText: due.trim() || undefined,
          dueDate,
          priority,
          status: 'open',
          createdAt: Date.now(),
          manual: true,
        });
      }
    });
    onClose();
  };

  const toCalendar = async () => {
    if (!editingItem?.dueDate) {
      Alert.alert('No due date', 'Set a due date first.');
      return;
    }
    const r = await createCalendarEvent(
      `${editingItem.task}${meeting.client ? ` (${meeting.client})` : ''}`,
      `${editingItem.dueDate}T10:00:00`,
    );
    if (r.success) {
      await meetingStore.update(meeting.id, m => {
        const x = m.actionItems.find(i => i.id === editingItem.id);
        if (x) x.calendarAdded = true;
      });
    } else Alert.alert('Calendar', r.message);
  };

  const remove = () =>
    meetingStore
      .update(meeting.id, m => {
        m.actionItems = m.actionItems.filter(i => i.id !== editingItem?.id);
      })
      .then(onClose);

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.sheet}>
          <Text style={[styles.sheetTitle, { marginBottom: 12 }]}>
            {editingItem ? 'Edit action item' : 'New action item'}
          </Text>
          <Field
            label="Action"
            value={task}
            onChangeText={setTask}
            multiline
            style={{ minHeight: 60 }}
          />
          <Field
            label="Owner"
            value={owner}
            onChangeText={setOwner}
            placeholder="Who is responsible?"
          />
          {meeting.attendees.length ? (
            <View style={[ui.wrap, { marginTop: -6, marginBottom: 12 }]}>
              {['Me', ...meeting.attendees.map(a => a.name)].slice(0, 8).map(n => (
                <Chip key={n} label={n} active={owner === n} onPress={() => setOwner(n)} />
              ))}
            </View>
          ) : null}
          <Field
            label="Due"
            value={due}
            onChangeText={setDue}
            placeholder="Friday · 24 Oct · end of next week"
            hint={
              due
                ? `→ ${resolveDue(due, new Date(meeting.startedAt)) ?? 'not recognised (kept as text)'}`
                : undefined
            }
          />
          <Segmented
            options={[
              { key: 'high', label: 'High' },
              { key: 'medium', label: 'Medium' },
              { key: 'low', label: 'Low' },
            ]}
            value={priority}
            onChange={setPriority}
          />
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 16 }}>
            {editingItem ? <Button label="Delete" kind="danger" small onPress={remove} /> : null}
            {editingItem ? (
              <Button label="📅 Calendar" kind="secondary" small onPress={toCalendar} />
            ) : null}
            <View style={{ flex: 1 }} />
            <Button label="Cancel" kind="ghost" small onPress={onClose} />
            <Button label="Save" small onPress={save} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  status: {
    marginHorizontal: theme.spacing.lg,
    marginTop: 12,
    padding: 12,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.toolCallBg,
    gap: 8,
  },
  statusText: { color: theme.colors.text, fontSize: theme.fontSize.sm, fontWeight: '600' },
  k: { color: theme.colors.textSecondary, fontWeight: '700', fontSize: theme.fontSize.sm },
  ts: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSize.xs + 1,
    fontVariant: ['tabular-nums'],
    marginBottom: 2,
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    gap: 8,
    padding: theme.spacing.lg,
    paddingBottom: 20,
    backgroundColor: theme.colors.background,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 12,
    padding: 14,
    marginBottom: 8,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  check: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: theme.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  checkDone: { backgroundColor: theme.colors.secondary, borderColor: theme.colors.secondary },
  checkMark: { color: theme.colors.textLight, fontWeight: '800', fontSize: 14 },
  doneText: { textDecorationLine: 'line-through', color: theme.colors.textMuted },
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
});
