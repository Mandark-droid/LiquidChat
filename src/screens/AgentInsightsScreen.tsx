/**
 * Agent dashboard (PRD §10, §13): live metrics from the trace store, recent
 * executions with a step/routing/state inspector, unfinished-task resume, and
 * the offline evaluation set for the current on-device model.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { agentRuntime } from '../agent/runtime';
import type { ExecutionRecord } from '../agent/types';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  HeaderButton,
  ProgressBar,
  ScreenHeader,
  SectionTitle,
  ui,
} from '../components/ui';
import { theme } from '../config/theme';
import { listEvalRuns, type StoredEvalRun } from '../observability/EvaluationRunner';
import type { AgentMetrics } from '../observability/MetricsCollector';

const pct = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const ms = (v: number | null | undefined) =>
  v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;

export default function AgentInsightsScreen({ onBack }: { onBack: () => void }) {
  const [metrics, setMetrics] = useState<AgentMetrics | null>(null);
  const [execs, setExecs] = useState<ExecutionRecord[]>([]);
  const [unfinished, setUnfinished] = useState<ExecutionRecord[]>([]);
  const [runs, setRuns] = useState<StoredEvalRun[]>([]);
  const [selected, setSelected] = useState<ExecutionRecord | null>(null);
  const [evalProgress, setEvalProgress] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      await agentRuntime.ready();
      setMetrics(await agentRuntime.metrics.collect());
      setExecs(await agentRuntime.repo.list({ limit: 30 }));
      setUnfinished(await agentRuntime.controller.unfinished());
      setRuns(await listEvalRuns({ limit: 5 }));
    } catch (e) {
      Alert.alert('Dashboard', e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const runEval = async () => {
    setEvalProgress(0);
    try {
      const r = await agentRuntime.evaluate({ onProgress: (d, t) => setEvalProgress(d / t) });
      Alert.alert(
        'Evaluation',
        `${r.metrics.passed}/${r.metrics.total} passed · tool accuracy ${pct(r.metrics.toolAccuracy)} · injection safety ${pct(r.metrics.injectionSafety)}`,
      );
    } catch (e) {
      Alert.alert('Evaluation', e instanceof Error ? e.message : String(e));
    } finally {
      setEvalProgress(null);
      load();
    }
  };

  if (selected) return <Inspector record={selected} onBack={() => setSelected(null)} />;

  return (
    <SafeAreaView style={ui.screen} edges={['top', 'bottom']}>
      <ScreenHeader
        title="Agent insights"
        subtitle="Last 7 days"
        onBack={onBack}
        right={<HeaderButton label="Refresh" onPress={load} />}
      />
      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: 60 }}>
        {metrics ? (
          <>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Stat label="Tasks done" value={pct(metrics.taskCompletionRate)} />
              <Stat label="On-device" value={pct(metrics.routing.localShare)} />
              <Stat label="Median" value={ms(metrics.latency.medianMs)} />
            </View>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <Stat label="Multi-step" value={pct(metrics.multiStep.successRate)} />
              <Stat label="Valid args" value={pct(metrics.toolCalls.argumentValidity)} />
              <Stat label="Cloud spend" value={`$${metrics.cost.totalUsd.toFixed(3)}`} />
            </View>
            <Text style={[ui.muted, { marginTop: 8 }]}>
              {metrics.executions.total} tasks · {metrics.routing.decisions} routing decisions ·{' '}
              {metrics.routing.escalations} escalations · {metrics.policyViolationsBlocked} unsafe
              actions blocked · p95 {ms(metrics.latency.p95Ms)}
            </Text>
            {metrics.routing.perModel.length ? (
              <>
                <SectionTitle>Models</SectionTitle>
                {metrics.routing.perModel.map(m => (
                  <Text key={`${m.modelId}:${m.mode}`} style={ui.body}>
                    {m.modelId} ({m.mode}) · {m.calls} calls · median {ms(m.medianMs)}
                  </Text>
                ))}
              </>
            ) : null}
          </>
        ) : null}

        {unfinished.length ? (
          <>
            <SectionTitle>Interrupted</SectionTitle>
            {unfinished.map(r => (
              <Card key={r.id} style={{ marginBottom: 8 }}>
                <Text style={ui.body} numberOfLines={2}>
                  {r.request.text}
                </Text>
                <Text style={ui.muted}>
                  stopped in {r.state} · {new Date(r.updatedAt).toLocaleString()}
                </Text>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                  <Button
                    label="Resume"
                    small
                    onPress={async () => {
                      const res = await agentRuntime.controller.resume(r.id);
                      Alert.alert('Resumed', res.response || res.state);
                      load();
                    }}
                  />
                  <Button
                    label="Cancel"
                    small
                    kind="secondary"
                    onPress={async () => {
                      await agentRuntime.cancel(r.id);
                      load();
                    }}
                  />
                </View>
              </Card>
            ))}
          </>
        ) : null}

        <SectionTitle>Evaluation</SectionTitle>
        {evalProgress != null ? <ProgressBar value={evalProgress} /> : null}
        <Button
          label={evalProgress != null ? 'Running…' : 'Run offline evaluation'}
          kind="secondary"
          disabled={evalProgress != null}
          onPress={runEval}
        />
        <Text style={[ui.muted, { marginTop: 6 }]}>
          Plans every case with the current model and scores tools and arguments. Nothing is
          executed on the phone.
        </Text>
        {runs.map(r => (
          <Text key={r.runId} style={[ui.body, { marginTop: 6 }]}>
            {new Date(r.at).toLocaleDateString()} · {r.modelId} · {r.passed}/{r.total} · tools{' '}
            {pct(r.metrics.toolAccuracy)} · injection {pct(r.metrics.injectionSafety)}
          </Text>
        ))}

        <SectionTitle>Recent tasks</SectionTitle>
        {execs.length === 0 ? (
          <EmptyState
            title="No tasks yet"
            body="Agent tasks from chat, skills and routines appear here."
          />
        ) : (
          execs.map(r => (
            <TouchableOpacity key={r.id} onPress={() => setSelected(r)}>
              <Card style={{ marginBottom: 8 }}>
                <View style={[ui.row, { justifyContent: 'space-between' }]}>
                  <Text style={[ui.body, { flex: 1 }]} numberOfLines={1}>
                    {r.request.text}
                  </Text>
                  <Chip
                    label={r.state.toLowerCase()}
                    tone={r.state === 'COMPLETED' ? 'ok' : r.state === 'FAILED' ? 'warn' : 'muted'}
                  />
                </View>
                <Text style={ui.muted}>
                  {r.request.source} · {Object.keys(r.steps).length} steps · {r.remoteCalls} cloud
                  calls · {new Date(r.createdAt).toLocaleString()}
                </Text>
              </Card>
            </TouchableOpacity>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card style={{ flex: 1, alignItems: 'center', paddingVertical: 12 }}>
      <Text style={{ fontSize: theme.fontSize.xl, fontWeight: '800', color: theme.colors.text }}>
        {value}
      </Text>
      <Text style={ui.muted}>{label}</Text>
    </Card>
  );
}

function Inspector({ record, onBack }: { record: ExecutionRecord; onBack: () => void }) {
  const [transitions, setTransitions] = useState<
    { from: string | null; to: string; reason: string | null; at: number }[]
  >([]);
  useEffect(() => {
    agentRuntime.repo.transitions(record.id).then(setTransitions);
  }, [record.id]);
  const plan = record.plan;
  return (
    <SafeAreaView style={ui.screen} edges={['top', 'bottom']}>
      <ScreenHeader title="Task" subtitle={record.state} onBack={onBack} />
      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: 60 }}>
        <Text style={ui.body}>{record.request.text}</Text>
        <Text style={[ui.muted, { marginTop: 4 }]}>
          {record.request.source} · plan from {plan?.source ?? '—'} · {record.remoteCalls} cloud
          calls · ${record.spendUsd.toFixed(4)}
        </Text>
        {record.response ? (
          <Card style={{ marginTop: 10 }}>
            <Text style={ui.body}>{record.response}</Text>
          </Card>
        ) : null}
        <SectionTitle>Steps</SectionTitle>
        {(plan?.steps ?? []).map(s => {
          const st = record.steps[s.id];
          return (
            <Card key={s.id} style={{ marginBottom: 8 }}>
              <View style={[ui.row, { justifyContent: 'space-between' }]}>
                <Text style={[ui.body, { fontWeight: '700' }]}>
                  {s.id} · {s.kind === 'tool' ? s.tool : s.operation}
                </Text>
                <Chip
                  label={st?.status ?? 'pending'}
                  tone={st?.status === 'succeeded' ? 'ok' : 'muted'}
                />
              </View>
              {st?.routing?.map((d, i) => (
                <Text key={i} style={ui.muted}>
                  → {d.executionMode} {d.selectedModelId}: {d.reason}
                </Text>
              ))}
              {st?.display ? <Text style={ui.muted}>{st.display}</Text> : null}
              {st?.error ? (
                <Text style={{ color: theme.colors.error }}>
                  {st.error.code}: {st.error.message}
                </Text>
              ) : null}
            </Card>
          );
        })}
        <SectionTitle>State history</SectionTitle>
        {transitions.map((t, i) => (
          <Text key={i} style={ui.muted}>
            {new Date(t.at).toLocaleTimeString()} {t.from ?? '∅'} → {t.to}
            {t.reason ? ` (${t.reason})` : ''}
          </Text>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
