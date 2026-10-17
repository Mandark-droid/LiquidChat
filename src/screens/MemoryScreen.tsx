/**
 * Memory management (PRD §8.3): inspect, search, add, edit, pin, delete,
 * export and clear everything LiquidChat remembers; approve or dismiss
 * proposed memories.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, Share, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { showActionSheet } from '../components/ActionSheet';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  Field,
  HeaderButton,
  ScreenHeader,
  SectionTitle,
  Segmented,
  ui,
} from '../components/ui';
import { theme } from '../config/theme';
import { type Memory, type MemoryKind, memoryManager } from '../memory/MemoryManager';
import { memoryProposals, type PendingProposal } from '../memory/proposals';

type Filter = 'all' | MemoryKind;

export default function MemoryScreen({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState<Memory[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [proposals, setProposals] = useState<PendingProposal[]>([]);
  const [editing, setEditing] = useState<Memory | 'new' | null>(null);
  const [draft, setDraft] = useState({ title: '', content: '', kind: 'profile' as MemoryKind });

  const load = useCallback(async () => {
    try {
      const list = query.trim()
        ? await memoryManager.retrieve(query, {
            limit: 50,
            kinds: filter === 'all' ? undefined : [filter],
          })
        : await memoryManager.list({ kind: filter === 'all' ? undefined : filter });
      setItems(list);
    } catch (e) {
      Alert.alert('Memory', e instanceof Error ? e.message : String(e));
    }
  }, [filter, query]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => memoryProposals.subscribe(setProposals), []);

  const save = async () => {
    if (!draft.content.trim()) return;
    if (editing === 'new') {
      await memoryManager.create({
        kind: draft.kind,
        title: draft.title,
        content: draft.content,
        source: 'user',
      });
    } else if (editing) {
      await memoryManager.update(editing.id, {
        title: draft.title,
        content: draft.content,
        kind: draft.kind,
      });
    }
    setEditing(null);
    load();
  };

  const open = (m: Memory | 'new') => {
    setEditing(m);
    setDraft(
      m === 'new'
        ? { title: '', content: '', kind: 'profile' }
        : { title: m.title, content: m.content, kind: m.kind },
    );
  };

  return (
    <SafeAreaView style={ui.screen} edges={['top', 'bottom']}>
      <ScreenHeader
        title="Memory"
        subtitle="What LiquidChat remembers — on this phone only"
        onBack={onBack}
        right={
          <>
            <HeaderButton
              label="Export"
              onPress={async () => Share.share({ message: await memoryManager.export() })}
            />
            <HeaderButton label="+" onPress={() => open('new')} />
          </>
        }
      />
      <ScrollView
        contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: 60 }}
        keyboardShouldPersistTaps="handled"
      >
        {proposals.length ? (
          <>
            <SectionTitle>Suggested to remember</SectionTitle>
            {proposals.map(p => (
              <Card key={p.id} style={{ marginBottom: 8 }}>
                <Text style={ui.body}>{p.content}</Text>
                <Text style={[ui.muted, { marginTop: 4 }]}>
                  {p.kind} · {p.reason}
                  {p.sensitive ? ' · sensitive' : ''}
                </Text>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                  <Button
                    label="Dismiss"
                    kind="secondary"
                    small
                    onPress={() => memoryProposals.dismiss(p.id)}
                  />
                  <Button
                    label="Remember"
                    small
                    onPress={async () => {
                      await memoryProposals.accept(p.id, memoryManager);
                      load();
                    }}
                  />
                </View>
              </Card>
            ))}
          </>
        ) : null}

        {editing ? (
          <Card style={{ marginTop: 12 }}>
            <Segmented
              options={[
                { key: 'profile', label: 'Preference' },
                { key: 'episodic', label: 'Episode' },
                { key: 'procedural', label: 'Procedure' },
              ]}
              value={draft.kind}
              onChange={k => setDraft(d => ({ ...d, kind: k }))}
            />
            <View style={{ height: 12 }} />
            <Field
              label="Title"
              value={draft.title}
              onChangeText={t => setDraft(d => ({ ...d, title: t }))}
            />
            <Field
              label="Content"
              value={draft.content}
              multiline
              onChangeText={t => setDraft(d => ({ ...d, content: t }))}
            />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button
                label="Cancel"
                kind="secondary"
                style={{ flex: 1 }}
                onPress={() => setEditing(null)}
              />
              <Button label="Save" style={{ flex: 1 }} onPress={save} />
            </View>
          </Card>
        ) : null}

        <View style={{ marginTop: 14 }}>
          <Field
            label="Search"
            value={query}
            onChangeText={setQuery}
            placeholder="Full-text search"
          />
          <View style={ui.wrap}>
            {(['all', 'profile', 'episodic', 'procedural'] as Filter[]).map(f => (
              <Chip
                key={f}
                label={f === 'all' ? 'All' : f}
                active={filter === f}
                onPress={() => setFilter(f)}
              />
            ))}
          </View>
        </View>

        {items.length === 0 ? (
          <EmptyState
            title="Nothing remembered yet"
            body='Say "remember that I prefer Google Maps" or add one with +. LiquidChat asks before saving anything.'
          />
        ) : (
          items.map(m => (
            <TouchableOpacity
              key={m.id}
              onPress={() => open(m)}
              onLongPress={() => memoryActions(m, load)}
            >
              <Card style={{ marginTop: 8 }}>
                <View style={[ui.row, { justifyContent: 'space-between' }]}>
                  <Text style={[ui.body, { fontWeight: '700', flex: 1 }]} numberOfLines={1}>
                    {m.title}
                  </Text>
                  <View style={ui.wrap}>
                    {m.pinned ? <Chip label="Pinned" tone="info" /> : null}
                    {m.sensitive ? <Chip label="Sensitive" tone="warn" /> : null}
                    <Chip label={m.kind} tone="muted" />
                  </View>
                </View>
                <Text style={[ui.body, { marginTop: 6 }]}>{m.content}</Text>
                <Text style={[ui.muted, { marginTop: 4 }]}>
                  {m.source} · updated {new Date(m.updatedAt).toLocaleDateString()}
                </Text>
              </Card>
            </TouchableOpacity>
          ))
        )}

        <Button
          label="Clear all memory"
          kind="danger"
          style={{ marginTop: 24 }}
          onPress={() =>
            Alert.alert(
              'Clear all memory?',
              'This permanently deletes everything LiquidChat remembers.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete all',
                  style: 'destructive',
                  onPress: async () => {
                    await memoryManager.clearAll();
                    load();
                  },
                },
              ],
            )
          }
        />
      </ScrollView>
    </SafeAreaView>
  );
}

function memoryActions(m: Memory, reload: () => void) {
  showActionSheet({
    title: m.title,
    options: [
      {
        text: m.pinned ? 'Unpin' : 'Pin (always use)',
        onPress: async () => {
          await memoryManager.update(m.id, { pinned: !m.pinned });
          reload();
        },
      },
      {
        text: m.sensitive ? 'Mark not sensitive' : 'Mark sensitive',
        onPress: async () => {
          await memoryManager.update(m.id, { sensitive: !m.sensitive });
          reload();
        },
      },
      {
        text: 'Delete',
        destructive: true,
        onPress: async () => {
          await memoryManager.delete(m.id);
          reload();
        },
      },
    ],
  });
}
