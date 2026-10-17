import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Button,
  Chip,
  EmptyState,
  Field,
  HeaderButton,
  ScreenHeader,
  Segmented,
  ui,
} from '../components/ui';
import { theme } from '../config/theme';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { resolveDue, toIsoDate } from '../meetings/dateResolver';
import { getMeetingSettings } from '../meetings/settings';
import type { ActionPriority } from '../meetings/types';
import {
  bucketOf,
  isMine,
  parseQuickAdd,
  sortTasks,
  taskStore,
  type UnifiedTask,
} from '../tasks/TaskStore';
import { createCalendarEvent } from '../tools/calendarEvent';

interface Props {
  onOpenMeeting: (id: string) => void;
  onDraftEmail: () => void;
}

type View_ = 'focus' | 'upcoming' | 'open' | 'done';

// Android 15+ draws apps edge-to-edge, where adjustResize no longer shrinks the window for
// the keyboard; the sheet has to move itself or the Due/Notes fields end up underneath it.
const KEYBOARD_BEHAVIOR =
  Platform.OS === 'ios' || (Platform.OS === 'android' && Platform.Version >= 35)
    ? 'padding'
    : undefined;
type Scope = 'all' | 'mine' | 'personal' | 'meetings';

function dueLabel(t: UnifiedTask): string {
  if (!t.dueDate) return t.dueText ?? '';
  const today = toIsoDate(new Date());
  const tomorrow = toIsoDate(new Date(Date.now() + 86400000));
  if (t.dueDate === today) return 'Today';
  if (t.dueDate === tomorrow) return 'Tomorrow';
  const [y, m, d] = t.dueDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const now = new Date();
  // new Date('YYYY-MM-DD') is UTC midnight; compare local midnights instead.
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((dt.getTime() - startOfToday.getTime()) / 86400000);
  if (days < 0) return `${-days}d overdue`;
  if (days < 7) return dt.toLocaleDateString('en-IN', { weekday: 'short' });
  return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

export default function TasksScreen({ onOpenMeeting, onDraftEmail }: Props) {
  const [tasks, setTasks] = useState<UnifiedTask[]>([]);
  const [view, setView] = useState<View_>('focus');
  const [scope, setScope] = useState<Scope>('all');
  const [client, setClient] = useState<string | null>(null);
  const [quick, setQuick] = useState('');
  const [editing, setEditing] = useState<UnifiedTask | null>(null);
  const [myNames, setMyNames] = useState<string[]>([]);
  const [sttModel, setSttModel] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => setTasks(await taskStore.all()), []);
  useEffect(() => {
    load();
    getMeetingSettings().then(s => {
      setMyNames([s.letterhead.preparedBy].filter(Boolean));
      setSttModel(s.sttModel.startsWith('parakeet') ? 'whisper-small' : s.sttModel);
    });
    return taskStore.subscribe(load);
  }, [load]);

  const clients = useMemo(
    () => [...new Set(tasks.map(t => t.client).filter((c): c is string => !!c))],
    [tasks],
  );

  const filtered = useMemo(() => {
    let xs = tasks;
    if (scope === 'mine') xs = xs.filter(t => isMine(t, myNames));
    if (scope === 'personal') xs = xs.filter(t => t.source === 'personal');
    if (scope === 'meetings') xs = xs.filter(t => t.source === 'meeting');
    if (client) xs = xs.filter(t => t.client === client);
    xs = xs.filter(t => {
      const b = bucketOf(t);
      if (view === 'focus') return b === 'overdue' || b === 'today';
      if (view === 'upcoming') return b === 'upcoming' || b === 'someday';
      if (view === 'open') return b !== 'done';
      return b === 'done';
    });
    return sortTasks(xs);
  }, [tasks, scope, client, view, myNames]);

  const counts = useMemo(() => {
    const open = tasks.filter(t => t.status === 'open');
    return {
      overdue: open.filter(t => bucketOf(t) === 'overdue').length,
      today: open.filter(t => bucketOf(t) === 'today').length,
      open: open.length,
    };
  }, [tasks]);

  const addQuick = async (text = quick) => {
    if (!text.trim()) return;
    const created = await taskStore.quickAdd(text);
    if (created) setQuick('');
    else Alert.alert('Add a task', 'Type what needs doing, not just a date or priority.');
  };

  const preview = quick.trim() ? parseQuickAdd(quick) : null;

  return (
    <SafeAreaView style={ui.screen} edges={['top']}>
      <ScreenHeader
        title="Tasks"
        subtitle={`${counts.open} open · ${counts.today} today${counts.overdue ? ` · ${counts.overdue} overdue` : ''}`}
        right={<HeaderButton label="✉ Draft" onPress={onDraftEmail} />}
      />

      <View style={styles.quickWrap}>
        <TextInput
          value={quick}
          // Keyboards re-insert an auto-space after the field is cleared, hiding the hint.
          onChangeText={t => setQuick(t.trim() ? t : '')}
          placeholder="Add a task… “call Acme Friday !high”"
          placeholderTextColor={theme.colors.textMuted}
          style={styles.quickInput}
          onSubmitEditing={() => addQuick()}
          returnKeyType="done"
        />
        {sttModel ? (
          <VoiceAdd
            key={sttModel}
            sttModel={sttModel}
            onText={t => setQuick(q => (q ? `${q} ${t}` : t))}
          />
        ) : null}
        <TouchableOpacity style={styles.addBtn} onPress={() => addQuick()}>
          <Text style={styles.addText}>+</Text>
        </TouchableOpacity>
      </View>
      {preview && (preview.dueDate || preview.priority || preview.client) ? (
        <View style={[ui.wrap, ui.pad, { marginTop: 6 }]}>
          {preview.dueDate ? <Chip label={`📅 ${preview.dueDate}`} tone="info" /> : null}
          {preview.priority ? <Chip label={`! ${preview.priority}`} tone="warn" /> : null}
          {preview.client ? <Chip label={`@ ${preview.client}`} tone="muted" /> : null}
        </View>
      ) : null}

      <View style={[ui.pad, { marginTop: 12 }]}>
        <Segmented
          options={[
            {
              key: 'focus',
              label: `Today${counts.overdue + counts.today ? ` (${counts.overdue + counts.today})` : ''}`,
            },
            { key: 'upcoming', label: 'Upcoming' },
            { key: 'open', label: 'All open' },
            { key: 'done', label: 'Done' },
          ]}
          value={view}
          onChange={setView}
        />
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
        style={styles.chipBar}
      >
        {(
          [
            ['all', 'All'],
            ['mine', 'Mine'],
            ['personal', 'Personal'],
            ['meetings', 'From meetings'],
          ] as const
        ).map(([k, l]) => (
          <Chip key={k} label={l} active={scope === k} onPress={() => setScope(k)} />
        ))}
        {clients.map(c => (
          <Chip
            key={c}
            label={`@${c}`}
            active={client === c}
            onPress={() => setClient(client === c ? null : c)}
          />
        ))}
      </ScrollView>

      <ScrollView
        contentContainerStyle={{ padding: theme.spacing.lg, paddingTop: 4, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
      >
        {filtered.length === 0 ? (
          <EmptyState
            title={
              view === 'focus'
                ? 'Nothing due today'
                : view === 'done'
                  ? 'Nothing completed yet'
                  : 'No tasks'
            }
            body={
              view === 'focus'
                ? 'Enjoy it — or check Upcoming.'
                : 'Type above or tap 🎙 to add one. Meeting action items show up here automatically.'
            }
          />
        ) : (
          filtered.map(t => (
            <TaskRow
              key={t.key}
              t={t}
              onToggle={() => taskStore.setStatus(t, t.status === 'open' ? 'done' : 'open')}
              onPress={() => setEditing(t)}
            />
          ))
        )}
      </ScrollView>

      <TaskEditor task={editing} onClose={() => setEditing(null)} onOpenMeeting={onOpenMeeting} />
    </SafeAreaView>
  );
}

function VoiceAdd({ sttModel, onText }: { sttModel: string; onText: (t: string) => void }) {
  const v = useVoiceInput({
    sttModel,
    onTranscription: onText,
    onError: msg => Alert.alert('Voice', msg),
  });
  const label =
    v.state === 'recording'
      ? '■'
      : v.state === 'transcribing' || v.sttInitializing || v.sttDownloading
        ? '…'
        : '🎙';
  return (
    <TouchableOpacity
      style={[
        styles.addBtn,
        styles.micBtn,
        v.state === 'recording' && { backgroundColor: theme.colors.error },
      ]}
      onPress={v.toggleRecording}
    >
      <Text style={[styles.addText, { fontSize: 18 }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function TaskRow({
  t,
  onToggle,
  onPress,
}: {
  t: UnifiedTask;
  onToggle: () => void;
  onPress: () => void;
}) {
  const b = bucketOf(t);
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.75}>
      <TouchableOpacity
        onPress={onToggle}
        hitSlop={10}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: t.status === 'done' }}
        accessibilityLabel={`${t.status === 'done' ? 'Reopen' : 'Complete'}: ${t.title}`}
        style={[
          styles.check,
          t.status === 'done' && styles.checkDone,
          t.priority === 'high' && t.status === 'open' && { borderColor: theme.colors.warning },
        ]}
      >
        {t.status === 'done' ? <Text style={styles.checkMark}>✓</Text> : null}
      </TouchableOpacity>
      <View style={{ flex: 1 }}>
        <Text style={[ui.body, t.status === 'done' && styles.done]}>{t.title}</Text>
        <View style={[ui.row, { marginTop: 4, flexWrap: 'wrap', gap: 8 }]}>
          {t.dueDate || t.dueText ? (
            <Text
              style={[
                styles.meta,
                b === 'overdue' && { color: theme.colors.error, fontWeight: '700' },
                b === 'today' && { color: theme.colors.warning, fontWeight: '700' },
              ]}
            >
              📅 {dueLabel(t)}
            </Text>
          ) : null}
          {t.source === 'meeting' ? (
            <Text style={styles.meta} numberOfLines={1}>
              🗓 {t.meetingTitle}
              {t.owner ? ` · ${t.owner}` : ''}
            </Text>
          ) : t.client ? (
            <Text style={styles.meta}>@{t.client}</Text>
          ) : null}
        </View>
      </View>
    </TouchableOpacity>
  );
}

function TaskEditor({
  task,
  onClose,
  onOpenMeeting,
}: {
  task: UnifiedTask | null;
  onClose: () => void;
  onOpenMeeting: (id: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [priority, setPriority] = useState<ActionPriority>('medium');
  const [client, setClient] = useState('');
  const [notes, setNotes] = useState('');
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!task) return;
    setTitle(task.title);
    setDue(task.dueDate ?? task.dueText ?? '');
    setPriority(task.priority ?? 'medium');
    setClient(task.client ?? '');
    setNotes(task.notes ?? '');
  }, [task]);

  if (!task) return null;
  const personal = task.source === 'personal';
  const resolved = resolveDue(due, new Date());

  const save = async () => {
    if (personal) {
      await taskStore.updatePersonal(task.id, {
        title: title.trim() || task.title,
        dueDate: resolved,
        dueText: due.trim() || undefined,
        priority,
        client: client.trim() || undefined,
        notes: notes.trim() || undefined,
      });
    } else {
      await taskStore.setDue(task, resolved, due.trim() || undefined);
    }
    onClose();
  };

  const toCalendar = async () => {
    const date = resolved ?? task.dueDate;
    if (!date) {
      Alert.alert('No due date', 'Set a due date first.');
      return;
    }
    const r = await createCalendarEvent(task.title, date, task.notes);
    if (r.success) await taskStore.markCalendarAdded(task);
    else Alert.alert('Calendar', r.message);
  };

  // The dialog gets Back before the keyboard does; closing here would drop unsaved edits.
  const onBack = () => (Keyboard.isVisible() ? Keyboard.dismiss() : onClose());

  const confirmDelete = () =>
    Alert.alert('Delete task', `Delete "${task.title}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await taskStore.deletePersonal(task.id);
          onClose();
        },
      },
    ]);

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onBack}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={KEYBOARD_BEHAVIOR}>
        <View style={[styles.sheet, { paddingBottom: 16 + insets.bottom }]}>
          <ScrollView keyboardShouldPersistTaps="handled" bounces={false}>
            <View style={[ui.row, { justifyContent: 'space-between' }]}>
              <Text style={styles.sheetTitle}>{personal ? 'Task' : 'Meeting action item'}</Text>
              <TouchableOpacity onPress={onClose} hitSlop={12} accessibilityLabel="Close">
                <Text style={styles.close}>✕</Text>
              </TouchableOpacity>
            </View>
            {!personal ? (
              <TouchableOpacity
                onPress={() => {
                  onClose();
                  if (task.meetingId) onOpenMeeting(task.meetingId);
                }}
              >
                <Text style={[ui.muted, { marginBottom: 12, color: theme.colors.accent }]}>
                  From “{task.meetingTitle}” — open meeting ›
                </Text>
              </TouchableOpacity>
            ) : (
              <View style={{ height: 12 }} />
            )}
            {personal ? (
              <Field
                label="Task"
                value={title}
                onChangeText={setTitle}
                multiline
                style={{ minHeight: 56 }}
              />
            ) : (
              <Text style={[ui.body, { marginBottom: 12 }]}>{task.title}</Text>
            )}
            <Field
              label="Due"
              value={due}
              onChangeText={setDue}
              placeholder="tomorrow · Friday · 24 Oct"
              hint={due ? `→ ${resolved ?? 'not recognised'}` : undefined}
            />
            {personal ? (
              <>
                <Segmented
                  options={[
                    { key: 'high', label: 'High' },
                    { key: 'medium', label: 'Medium' },
                    { key: 'low', label: 'Low' },
                  ]}
                  value={priority}
                  onChange={setPriority}
                />
                <View style={{ height: 12 }} />
                <Field
                  label="Client / project"
                  value={client}
                  onChangeText={setClient}
                  placeholder="optional"
                />
                <Field label="Notes" value={notes} onChangeText={setNotes} multiline />
              </>
            ) : null}
            <View style={styles.actions}>
              {personal ? (
                <Button label="Delete" kind="danger" small onPress={confirmDelete} />
              ) : null}
              <Button label="📅 Calendar" kind="secondary" small onPress={toCalendar} />
              <View style={{ flex: 1 }} />
              <Button label="Cancel" kind="ghost" small onPress={onClose} />
              <Button label="Save" small onPress={save} />
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  quickWrap: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: 14,
    alignItems: 'center',
  },
  quickInput: {
    flex: 1,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: theme.fontSize.md,
    color: theme.colors.text,
  },
  addBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: theme.colors.secondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micBtn: { backgroundColor: theme.colors.accent },
  addText: { color: theme.colors.textLight, fontSize: 24, fontWeight: '600', marginTop: -2 },
  chips: { paddingHorizontal: theme.spacing.lg, paddingVertical: 12, gap: 6 },
  // A long task list must not squeeze the filter row down to empty pills.
  chipBar: { flexGrow: 0, flexShrink: 0 },
  row: {
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
  done: { textDecorationLine: 'line-through', color: theme.colors.textMuted },
  meta: { fontSize: theme.fontSize.sm, color: theme.colors.textSecondary, flexShrink: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: theme.colors.background,
    borderTopLeftRadius: theme.borderRadius.xl,
    borderTopRightRadius: theme.borderRadius.xl,
    padding: theme.spacing.lg,
    maxHeight: '92%',
  },
  sheetTitle: { fontSize: theme.fontSize.xl, fontWeight: '700', color: theme.colors.text },
  close: { fontSize: 20, color: theme.colors.textSecondary, paddingHorizontal: 4 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
});
