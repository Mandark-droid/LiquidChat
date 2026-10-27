/** The agent's plan under a reply: the goal and every step (tool calls and model steps) with its outcome. */
import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { theme } from '../config/theme';
import type { AgentPlanRecord, AgentStepRecord } from '../types';

const STATUS: Record<AgentStepRecord['status'], { icon: string; color: string }> = {
  success: { icon: '✓', color: theme.colors.success },
  error: { icon: '✗', color: theme.colors.error },
  running: { icon: '…', color: theme.colors.accent },
  pending: { icon: '○', color: theme.colors.textMuted },
};

const OPERATION: Record<string, string> = {
  plan: 'Planning',
  reason: 'Reasoning',
  summarize: 'Summarizing',
  extract: 'Extracting',
  respond: 'Writing the reply',
  classify: 'Classifying',
};

function argsText(args?: Record<string, unknown>): string {
  if (!args) return '';
  const s = Object.entries(args)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ');
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}

export default function AgentPlanView({ plan }: { plan: AgentPlanRecord }) {
  const [open, setOpen] = useState(plan.steps.length <= 4);
  const done = plan.steps.filter(s => s.status === 'success').length;
  const failed = plan.steps.some(s => s.status === 'error');
  return (
    <View style={styles.box}>
      <TouchableOpacity onPress={() => setOpen(o => !o)} hitSlop={8}>
        <Text style={styles.header}>
          {open ? '▾' : '▸'} {plan.steps.length === 1 ? '1 step' : `${plan.steps.length} steps`} ·{' '}
          {failed ? 'stopped with an error' : `${done}/${plan.steps.length} done`}
          {plan.source === 'skill' ? ' · skill' : ''}
        </Text>
      </TouchableOpacity>
      {open ? (
        <>
          {plan.goal ? <Text style={styles.goal}>Goal: {plan.goal}</Text> : null}
          {plan.steps.map((s, i) => {
            const st = STATUS[s.status];
            const args = argsText(s.args);
            return (
              <View key={i} style={styles.step}>
                <Text style={[styles.icon, { color: st.color }]}>{st.icon}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>
                    {i + 1}. {s.kind === 'tool' ? '🔧 ' : '🧠 '}
                    {s.kind === 'tool' ? s.name : (OPERATION[s.name] ?? s.name)}
                  </Text>
                  {args ? <Text style={styles.detail}>{args}</Text> : null}
                  {s.result ? (
                    <Text
                      style={[styles.detail, s.status === 'error' && { color: theme.colors.error }]}
                      numberOfLines={4}
                    >
                      → {s.result}
                    </Text>
                  ) : null}
                </View>
              </View>
            );
          })}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 10,
    borderRadius: 10,
    backgroundColor: theme.colors.toolCallBg,
    borderWidth: 1,
    borderColor: theme.colors.toolCallBorder,
  },
  header: { fontSize: theme.fontSize.sm, fontWeight: '700', color: theme.colors.text },
  goal: { fontSize: theme.fontSize.sm, color: theme.colors.textSecondary, marginTop: 6 },
  step: { flexDirection: 'row', gap: 8, marginTop: 8 },
  icon: { width: 16, fontSize: theme.fontSize.md, fontWeight: '800', textAlign: 'center' },
  name: { fontSize: theme.fontSize.sm, fontWeight: '600', color: theme.colors.text },
  detail: { fontSize: theme.fontSize.sm, color: theme.colors.textSecondary, marginTop: 2 },
});
