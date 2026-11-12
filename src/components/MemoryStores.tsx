/**
 * The Memory screen's views of the vector stores behind chat: conversations remembered for
 * recall, and documents (meetings among them) indexed for retrieval. These are what the Agent
 * dashboard counts as "Memories" and "Document chunks".
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Text, TouchableOpacity, View } from 'react-native';

import { meetingStore } from '../meetings/MeetingStore';
import { indexFileName } from '../memory/autoIndex';
import { memoryService } from '../services/MemoryService';
import { showActionSheet } from './ActionSheet';
import { Button, Card, Chip, EmptyState, ui } from './ui';

const PAGE = 50;

const when = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function RecalledConversations({ query }: { query: string }) {
  const [items, setItems] = useState<{ id: string; text: string; createdAt: number }[]>([]);
  const [shown, setShown] = useState(PAGE);

  const load = useCallback(
    () =>
      memoryService
        .listRecalled()
        .then(setItems)
        .catch(e => Alert.alert('Memory', e instanceof Error ? e.message : String(e))),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  const q = query.trim().toLowerCase();
  const visible = q ? items.filter(i => i.text.toLowerCase().includes(q)) : items;

  if (!items.length)
    return (
      <EmptyState
        title="No conversations remembered"
        body="With memory on in Settings, chat turns are saved here so later questions can recall them."
      />
    );
  return (
    <>
      <Text style={[ui.muted, { marginTop: 12 }]}>
        {visible.length} of {items.length} conversation{items.length === 1 ? '' : 's'} chat can
        recall. Long-press to forget one.
      </Text>
      {visible.slice(0, shown).map(m => (
        <TouchableOpacity
          key={m.id}
          onLongPress={() =>
            showActionSheet({
              title: 'Remembered conversation',
              options: [
                {
                  text: 'Forget',
                  destructive: true,
                  onPress: async () => {
                    await memoryService.forget(m.id);
                    load();
                  },
                },
              ],
            })
          }
        >
          <Card style={{ marginTop: 8 }}>
            <Text style={ui.body} numberOfLines={6}>
              {m.text}
            </Text>
            <Text style={[ui.muted, { marginTop: 4 }]}>{when(m.createdAt)}</Text>
          </Card>
        </TouchableOpacity>
      ))}
      {visible.length > shown ? (
        <Button
          label={`Show more (${visible.length - shown})`}
          kind="secondary"
          style={{ marginTop: 12 }}
          onPress={() => setShown(n => n + PAGE)}
        />
      ) : null}
      <Button
        label="Forget all conversations"
        kind="danger"
        style={{ marginTop: 24 }}
        onPress={() =>
          Alert.alert('Forget all conversations?', 'Chat will no longer recall earlier turns.', [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Forget all',
              style: 'destructive',
              onPress: async () => {
                await memoryService.clearMemory();
                load();
              },
            },
          ])
        }
      />
    </>
  );
}

interface Doc {
  sourceFile: string;
  chunks: number;
  indexedAt: number;
  /** Set when the file is a meeting's chat index. */
  meetingTitle?: string;
}

export function IndexedDocuments({ query }: { query: string }) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [chunks, setChunks] = useState<{ id: string; text: string; chunkIndex: number }[]>([]);

  const load = useCallback(async () => {
    try {
      const [files, meetings] = await Promise.all([
        memoryService.listDocuments(),
        meetingStore.list(),
      ]);
      const titles = new Map(meetings.map(m => [indexFileName(m.id), m.title]));
      setDocs(files.map(f => ({ ...f, meetingTitle: titles.get(f.sourceFile) })));
    } catch (e) {
      Alert.alert('Memory', e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (open) memoryService.documentChunks(open).then(setChunks);
    else setChunks([]);
  }, [open]);

  const q = query.trim().toLowerCase();
  const visible = q
    ? docs.filter(d => `${d.meetingTitle ?? ''} ${d.sourceFile}`.toLowerCase().includes(q))
    : docs;
  const total = docs.reduce((n, d) => n + d.chunks, 0);

  if (!docs.length)
    return (
      <EmptyState
        title="No documents indexed"
        body="Meetings are indexed here automatically once their minutes are ready (Meeting settings → Index for chat)."
      />
    );
  return (
    <>
      <Text style={[ui.muted, { marginTop: 12 }]}>
        {docs.length} file{docs.length === 1 ? '' : 's'} · {total} chunks chat can search. Tap one
        to see its chunks.
      </Text>
      {visible.map(d => {
        const expanded = open === d.sourceFile;
        return (
          <TouchableOpacity
            key={d.sourceFile}
            onPress={() => setOpen(expanded ? null : d.sourceFile)}
            onLongPress={() => (d.meetingTitle ? undefined : removeDoc(d, load))}
          >
            <Card style={{ marginTop: 8 }}>
              <View style={[ui.row, { justifyContent: 'space-between' }]}>
                <Text style={[ui.body, { fontWeight: '700', flex: 1 }]} numberOfLines={2}>
                  {d.meetingTitle ?? d.sourceFile}
                </Text>
                <Chip label={d.meetingTitle ? 'Meeting' : 'File'} tone="muted" />
              </View>
              <Text style={[ui.muted, { marginTop: 4 }]}>
                {d.chunks} chunk{d.chunks === 1 ? '' : 's'} · indexed {when(d.indexedAt)}
              </Text>
              {expanded ? (
                <>
                  {d.meetingTitle ? (
                    <Text style={[ui.muted, { marginTop: 8 }]}>
                      Kept in sync with the meeting: it is re-indexed when its minutes change and
                      removed when the meeting is deleted.
                    </Text>
                  ) : null}
                  {chunks.map(c => (
                    <View key={c.id} style={{ marginTop: 10 }}>
                      <Text style={ui.muted}>Chunk {c.chunkIndex + 1}</Text>
                      <Text style={ui.body}>{c.text}</Text>
                    </View>
                  ))}
                </>
              ) : null}
            </Card>
          </TouchableOpacity>
        );
      })}
    </>
  );
}

function removeDoc(d: Doc, reload: () => void) {
  showActionSheet({
    title: d.sourceFile,
    options: [
      {
        text: 'Remove from chat search',
        destructive: true,
        onPress: () => {
          memoryService.removeSource(d.sourceFile);
          reload();
        },
      },
    ],
  });
}
