import React, { useEffect, useState } from 'react';
import { Alert, ScrollView, Share, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  Button,
  Card,
  Chip,
  Field,
  HeaderButton,
  ScreenHeader,
  SectionTitle,
  Segmented,
  ui,
} from '../components/ui';
import { COMPLETION_MODELS } from '../config/models';
import { theme } from '../config/theme';
import {
  deleteDraft,
  draftAsText,
  draftEmail,
  type EmailDraft,
  type EmailMode,
  type EmailTone,
  listDrafts,
  openInMailApp,
  refineDraft,
  saveDraft,
  TONES,
} from '../email/EmailDrafter';
import { exportMinutes } from '../meetings/documents';
import { meetingStore } from '../meetings/MeetingStore';
import { Docs } from '../meetings/native';
import { getMeetingSettings } from '../meetings/settings';
import type { Meeting } from '../meetings/types';

interface Props {
  meetingId?: string;
  onBack: () => void;
}

const QUICK_REFINES = [
  'Shorter',
  'More formal',
  'Warmer',
  'Add a clear call to action',
  'Bullet the action items',
  'Fix grammar only',
];

export default function EmailDraftScreen({ meetingId, onBack }: Props) {
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [mode, setMode] = useState<EmailMode>(meetingId ? 'followup' : 'compose');
  const [tone, setTone] = useState<EmailTone>('professional');
  const [to, setTo] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [intent, setIntent] = useState('');
  const [sourceEmail, setSourceEmail] = useState('');
  const [model, setModel] = useState('lfm2.5-1.2b-instruct');
  const [senderName, setSenderName] = useState('');
  const [draft, setDraft] = useState<EmailDraft | null>(null);
  const [refine, setRefine] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [history, setHistory] = useState<EmailDraft[]>([]);

  useEffect(() => {
    getMeetingSettings().then(s => {
      setModel(s.summaryModel);
      setSenderName(s.letterhead.preparedBy);
    });
    listDrafts().then(setHistory);
    if (meetingId) {
      meetingStore.get(meetingId).then(m => {
        if (!m) return;
        setMeeting(m);
        setTo(
          m.attendees
            .map(a => a.email)
            .filter(Boolean)
            .join(', '),
        );
        const first = m.attendees[0]?.name;
        setRecipientName(m.attendees.length > 1 ? 'all' : (first ?? ''));
      });
    }
  }, [meetingId]);

  const generate = async () => {
    if (mode === 'compose' && !intent.trim()) {
      Alert.alert('What should the email say?', 'Describe it in a sentence.');
      return;
    }
    if (mode === 'reply' && !sourceEmail.trim()) {
      Alert.alert('Paste the email to reply to');
      return;
    }
    setBusy('draft');
    try {
      const d = await draftEmail({
        mode,
        tone,
        intent,
        model,
        to: splitEmails(to),
        recipientName:
          recipientName === 'all' ? 'everyone in the meeting' : recipientName || undefined,
        senderName: senderName || undefined,
        sourceEmail: mode === 'reply' ? sourceEmail : undefined,
        meeting: mode === 'followup' ? (meeting ?? undefined) : undefined,
      });
      setDraft(d);
      await saveDraft(d);
      setHistory(await listDrafts());
    } catch (e) {
      Alert.alert('Drafting failed', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const doRefine = async (instruction: string) => {
    if (!draft || !instruction.trim()) return;
    setBusy('refine');
    try {
      const d = await refineDraft({ ...draft, to: splitEmails(to) }, instruction.trim(), model);
      setDraft(d);
      setRefine('');
      await saveDraft(d);
    } catch (e) {
      Alert.alert('Refine failed', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const updateDraft = (patch: Partial<EmailDraft>) => {
    if (!draft) return;
    const d = { ...draft, ...patch, updatedAt: Date.now() };
    setDraft(d);
    saveDraft(d);
  };

  const sendWithMinutes = async () => {
    if (!draft || !meeting) return;
    setBusy('send');
    try {
      const file = await exportMinutes(meeting.id, {
        format: 'pdf',
        includeTranscript: false,
        includeCompleted: true,
      });
      await Docs.shareFile(file.path, {
        mime: file.mime,
        subject: draft.subject,
        text: draft.body,
        emails: splitEmails(to),
        emailOnly: true,
        chooserTitle: 'Send follow-up',
      });
    } catch (e) {
      Alert.alert('Could not attach minutes', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <SafeAreaView style={ui.screen} edges={['top']}>
      <ScreenHeader
        title="Email drafter"
        subtitle={
          meeting ? `Follow-up · ${meeting.title}` : 'On-device · nothing leaves your phone'
        }
        onBack={onBack}
        right={draft ? <HeaderButton label="New" onPress={() => setDraft(null)} /> : undefined}
      />
      <ScrollView
        contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: 60 }}
        keyboardShouldPersistTaps="handled"
      >
        {!draft ? (
          <>
            <Segmented
              options={[
                ...(meetingId ? [{ key: 'followup' as const, label: 'Meeting follow-up' }] : []),
                { key: 'compose', label: 'Compose' },
                { key: 'reply', label: 'Reply' },
              ]}
              value={mode}
              onChange={setMode}
            />
            <View style={{ height: 14 }} />
            <Field
              label="To"
              value={to}
              onChangeText={setTo}
              placeholder="name@client.com, …"
              autoCapitalize="none"
              keyboardType="email-address"
            />
            <Field
              label="Recipient name"
              value={recipientName === 'all' ? 'Everyone' : recipientName}
              onChangeText={setRecipientName}
              placeholder="Used in the greeting"
            />
            {mode === 'reply' ? (
              <Field
                label="Email you received"
                value={sourceEmail}
                onChangeText={setSourceEmail}
                multiline
                style={{ minHeight: 140 }}
                placeholder="Paste the email here"
              />
            ) : null}
            <Field
              label={
                mode === 'followup'
                  ? 'Anything to add? (optional)'
                  : mode === 'reply'
                    ? 'What should the reply say?'
                    : 'What should the email say?'
              }
              value={intent}
              onChangeText={setIntent}
              multiline
              placeholder={
                mode === 'followup'
                  ? 'e.g. mention we will share the SOW by Monday'
                  : mode === 'reply'
                    ? 'e.g. accept, propose Thursday 4 pm instead'
                    : 'e.g. tell Rahul the demo moves to Tuesday because staging is down; apologise'
              }
            />
            <Text style={ui.muted}>Tone</Text>
            <View style={[ui.wrap, { marginTop: 8, marginBottom: 14 }]}>
              {TONES.map(t => (
                <Chip
                  key={t.key}
                  label={t.label}
                  active={tone === t.key}
                  onPress={() => setTone(t.key)}
                />
              ))}
            </View>
            <Text style={ui.muted}>Model</Text>
            <View style={[ui.wrap, { marginTop: 8, marginBottom: 18 }]}>
              {COMPLETION_MODELS()
                .filter(m => !m.supportsThinking)
                .map(m => (
                  <Chip
                    key={m.slug}
                    label={m.name}
                    active={model === m.slug}
                    onPress={() => setModel(m.slug)}
                  />
                ))}
            </View>
            <Button label="✨ Draft email" loading={busy === 'draft'} onPress={generate} />

            {history.length ? (
              <>
                <SectionTitle>Recent drafts</SectionTitle>
                {history.slice(0, 8).map(h => (
                  <TouchableOpacity
                    key={h.id}
                    onPress={() => {
                      setDraft(h);
                      setTo(h.to.join(', '));
                    }}
                    onLongPress={() =>
                      Alert.alert('Delete draft?', h.subject, [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Delete',
                          style: 'destructive',
                          onPress: async () => {
                            await deleteDraft(h.id);
                            setHistory(await listDrafts());
                          },
                        },
                      ])
                    }
                  >
                    <Card style={{ marginBottom: 8 }}>
                      <Text style={styles.histSubject} numberOfLines={1}>
                        {h.subject || '(no subject)'}
                      </Text>
                      <Text style={ui.muted} numberOfLines={2}>
                        {h.body}
                      </Text>
                    </Card>
                  </TouchableOpacity>
                ))}
              </>
            ) : null}
          </>
        ) : (
          <>
            <Field
              label="To"
              value={to}
              onChangeText={setTo}
              autoCapitalize="none"
              keyboardType="email-address"
            />
            <Field
              label="Subject"
              value={draft.subject}
              onChangeText={v => updateDraft({ subject: v })}
            />
            <Field
              label="Body"
              value={draft.body}
              onChangeText={v => updateDraft({ body: v })}
              multiline
              style={{ minHeight: 260 }}
            />

            <SectionTitle>Refine</SectionTitle>
            <View style={ui.wrap}>
              {QUICK_REFINES.map(r => (
                <Chip key={r} label={r} onPress={() => doRefine(r)} />
              ))}
            </View>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, alignItems: 'flex-start' }}>
              <View style={{ flex: 1 }}>
                <Field
                  label="Your instruction"
                  value={refine}
                  onChangeText={setRefine}
                  placeholder="e.g. mention the invoice is attached"
                />
              </View>
              <Button
                label="Apply"
                small
                onPress={() => doRefine(refine)}
                loading={busy === 'refine'}
                style={{ marginTop: 22 }}
              />
            </View>
            {draft.refinements.length ? (
              <Text style={[ui.muted, { marginTop: -4 }]}>
                Applied: {draft.refinements.join(' → ')}
              </Text>
            ) : null}

            <View style={{ gap: 8, marginTop: 20 }}>
              {meeting ? (
                <Button
                  label="✉ Send with minutes (PDF) attached"
                  loading={busy === 'send'}
                  onPress={sendWithMinutes}
                />
              ) : null}
              <Button
                label="Open in mail app"
                kind={meeting ? 'secondary' : 'primary'}
                onPress={() =>
                  openInMailApp({ ...draft, to: splitEmails(to) }).catch(e =>
                    Alert.alert('Mail', String(e)),
                  )
                }
              />
              <Button
                label="Share / copy text"
                kind="secondary"
                onPress={() =>
                  Share.share({ message: draftAsText({ ...draft, to: splitEmails(to) }) })
                }
              />
            </View>
            <Text style={[ui.muted, { marginTop: 12 }]}>
              Drafted on-device with {draft.model}. Always read before sending.
            </Text>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function splitEmails(s: string): string[] {
  return s
    .split(/[,;\s]+/)
    .map(x => x.trim())
    .filter(x => /@/.test(x));
}

const styles = StyleSheet.create({
  histSubject: {
    fontSize: theme.fontSize.md,
    fontWeight: '700',
    color: theme.colors.text,
    marginBottom: 2,
  },
});
