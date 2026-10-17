/**
 * Skills (PRD §9): browse, enable, run, create from natural language, import
 * and export, and schedule. Generated and imported skills are reviewed here
 * before activation — the permission list and every step are shown.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, Share, Switch, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { agentRuntime } from '../agent/runtime';
import { Button, Card, Chip, EmptyState, Field, HeaderButton, ScreenHeader, SectionTitle, ui } from '../components/ui';
import { theme } from '../config/theme';
import { SkillError } from '../skills/SkillRegistry';
import type { InstalledSkill, SkillManifest } from '../skills/types';

interface Props {
  onBack: () => void;
  onRunResult: (text: string) => void;
}

export default function SkillsScreen({ onBack, onRunResult }: Props) {
  const [skills, setSkills] = useState<InstalledSkill[]>([]);
  const [selected, setSelected] = useState<InstalledSkill | null>(null);
  const [mode, setMode] = useState<'list' | 'create' | 'import'>('list');
  const [request, setRequest] = useState('');
  const [importText, setImportText] = useState('');
  const [draft, setDraft] = useState<SkillManifest | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      await agentRuntime.ready();
      setSkills(await agentRuntime.skills.list());
    } catch (e) {
      Alert.alert('Skills', e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (s: InstalledSkill, enabled: boolean) => {
    try {
      await agentRuntime.skills.setEnabled(s.id, enabled);
      if (!enabled) await agentRuntime.unscheduleSkill(s.id);
      else await agentRuntime.scheduleSkill(s.id);
    } catch (e) {
      showSkillError(e);
    }
    load();
  };

  const run = async (s: InstalledSkill) => {
    setBusy(true);
    try {
      const res = await agentRuntime.runSkill(s.id);
      onRunResult(res.response);
    } catch (e) {
      showSkillError(e);
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    if (!request.trim()) return;
    setBusy(true);
    try {
      const d = await agentRuntime.generator.draft(request);
      if (!d.manifest) {
        Alert.alert('Could not create a valid skill', d.issues.map(i => `${i.path}: ${i.message}`).join('\n'));
      } else setDraft(d.manifest);
    } catch (e) {
      showSkillError(e);
    } finally {
      setBusy(false);
    }
  };

  const installDraft = async () => {
    if (!draft) return;
    try {
      const s = await agentRuntime.skills.install(draft, 'generated');
      setDraft(null);
      setRequest('');
      setMode('list');
      await load();
      setSelected(s);
    } catch (e) {
      showSkillError(e);
    }
  };

  const doImport = async () => {
    try {
      const s = await agentRuntime.skills.import(importText);
      setImportText('');
      setMode('list');
      await load();
      setSelected(s);
    } catch (e) {
      showSkillError(e);
    }
  };

  return (
    <SafeAreaView style={ui.screen} edges={['top']}>
      <ScreenHeader
        title="Skills"
        subtitle="Reusable workflows the agent can run"
        onBack={selected ? () => setSelected(null) : onBack}
        right={
          !selected ? (
            <>
              <HeaderButton label="Import" onPress={() => setMode(mode === 'import' ? 'list' : 'import')} />
              <HeaderButton label="+" onPress={() => setMode(mode === 'create' ? 'list' : 'create')} />
            </>
          ) : undefined
        }
      />
      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
        {selected ? (
          <SkillDetail skill={selected} busy={busy} onRun={() => run(selected)} onChanged={async () => { await load(); setSelected((await agentRuntime.skills.get(selected.id)) ?? null); }} onDeleted={() => { setSelected(null); load(); }} onToggle={toggle} />
        ) : mode === 'create' ? (
          <>
            <Field
              label="Describe the skill"
              value={request}
              onChangeText={setRequest}
              multiline
              placeholder="Every morning, summarize important notifications and show my calendar."
            />
            <Button label="Draft skill" loading={busy} onPress={generate} />
            {draft ? <ManifestReview manifest={draft} onInstall={installDraft} onDiscard={() => setDraft(null)} /> : null}
          </>
        ) : mode === 'import' ? (
          <>
            <Field label="Paste a skill (JSON bundle or YAML)" value={importText} onChangeText={setImportText} multiline style={{ minHeight: 200 }} />
            <Text style={[ui.muted, { marginBottom: 10 }]}>Imported skills are installed disabled. Review permissions and steps, then enable.</Text>
            <Button label="Import" onPress={doImport} />
          </>
        ) : skills.length === 0 ? (
          <EmptyState title="No skills" body="Create one in plain language with +." />
        ) : (
          skills.map(s => (
            <TouchableOpacity key={s.id} onPress={() => setSelected(s)}>
              <Card style={{ marginBottom: 8 }}>
                <View style={[ui.row, { justifyContent: 'space-between' }]}>
                  <Text style={[ui.body, { fontWeight: '700', flex: 1 }]}>{s.manifest.name}</Text>
                  <Switch value={s.enabled} onValueChange={v => toggle(s, v)} trackColor={{ true: theme.colors.secondary, false: theme.colors.border }} />
                </View>
                <Text style={[ui.muted, { marginTop: 2 }]}>{s.manifest.description}</Text>
                <View style={[ui.wrap, { marginTop: 8 }]}>
                  <Chip label={s.source} tone="muted" />
                  {(s.manifest.triggers ?? []).filter(t => t.type === 'daily').map((t, i) => (
                    <Chip key={i} label={`daily ${t.type === 'daily' ? t.time : ''}`} tone="info" />
                  ))}
                  {s.manifest.permissions.length ? <Chip label={`${s.manifest.permissions.length} permission(s)`} tone="warn" /> : null}
                </View>
              </Card>
            </TouchableOpacity>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function SkillDetail({
  skill,
  busy,
  onRun,
  onChanged,
  onDeleted,
  onToggle,
}: {
  skill: InstalledSkill;
  busy: boolean;
  onRun: () => void;
  onChanged: () => void;
  onDeleted: () => void;
  onToggle: (s: InstalledSkill, enabled: boolean) => Promise<void>;
}) {
  return (
    <>
      <Text style={{ fontSize: theme.fontSize.xl, fontWeight: '700', color: theme.colors.text }}>{skill.manifest.name}</Text>
      <Text style={[ui.muted, { marginTop: 4 }]}>
        v{skill.manifest.version} · {skill.source}
        {skill.publisher ? ` · by ${skill.publisher}` : ''} · {skill.enabled ? 'enabled' : 'disabled'}
      </Text>
      <ManifestReview manifest={skill.manifest} />
      <Text style={[ui.muted, { marginTop: 8 }]}>Integrity hash {skill.hash.slice(0, 16)}…</Text>
      <View style={{ gap: 8, marginTop: 16 }}>
        <Button label="Run now" loading={busy} disabled={!skill.enabled} onPress={onRun} />
        <Button label={skill.enabled ? 'Disable' : 'Review done — enable'} kind="secondary" onPress={async () => { await onToggle(skill, !skill.enabled); onChanged(); }} />
        <Button label="Export / share" kind="secondary" onPress={async () => Share.share({ message: await agentRuntime.skills.export(skill.id) })} />
        {skill.source !== 'builtin' ? (
          <Button label="Delete" kind="danger" onPress={async () => { await agentRuntime.skills.remove(skill.id); onDeleted(); }} />
        ) : null}
      </View>
    </>
  );
}

function ManifestReview({ manifest, onInstall, onDiscard }: { manifest: SkillManifest; onInstall?: () => void; onDiscard?: () => void }) {
  return (
    <Card style={{ marginTop: 12 }}>
      <Text style={ui.body}>{manifest.description}</Text>
      <SectionTitle>Permissions</SectionTitle>
      {manifest.permissions.length ? (
        <View style={ui.wrap}>
          {manifest.permissions.map(p => <Chip key={p} label={p.replace('special:', '')} tone="warn" />)}
        </View>
      ) : (
        <Text style={ui.muted}>None</Text>
      )}
      <SectionTitle>Triggers</SectionTitle>
      <Text style={ui.muted}>
        {(manifest.triggers ?? [{ type: 'manual' }])
          .map(t => (t.type === 'daily' ? `daily at ${t.time}` : t.type === 'phrase' ? `says “${t.phrases[0]}”` : t.type === 'interval' ? `every ${t.minutes} min` : t.type === 'once' ? `once at ${t.at}` : 'manual'))
          .join(' · ')}
      </Text>
      <SectionTitle>Steps</SectionTitle>
      {manifest.steps.map((s, i) => (
        <Text key={s.id} style={[ui.body, { marginBottom: 4 }]}>
          {i + 1}. {s.tool ? `🔧 ${s.tool}` : `🧠 ${s.operation}`}
          {s.requiresApproval ? ' · asks first' : ''}
          {s.dataClass && s.dataClass !== 'public' ? ` · ${s.dataClass} data` : ''}
        </Text>
      ))}
      {onInstall ? (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
          <Button label="Discard" kind="secondary" style={{ flex: 1 }} onPress={onDiscard ?? (() => {})} />
          <Button label="Install (disabled)" style={{ flex: 1 }} onPress={onInstall} />
        </View>
      ) : null}
    </Card>
  );
}

function showSkillError(e: unknown) {
  if (e instanceof SkillError && e.issues.length) {
    Alert.alert(e.message, e.issues.map(i => `${i.path}: ${i.message}`).join('\n'));
  } else Alert.alert('Skill', e instanceof Error ? e.message : String(e));
}
