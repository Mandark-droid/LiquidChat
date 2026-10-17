/**
 * Renders pending approvals from the ApprovalManager as a bottom sheet.
 * This is the only place approvals are granted — never from model output.
 */
import React, { useEffect, useState } from 'react';
import { Modal, StyleSheet, Text, View } from 'react-native';

import { theme } from '../config/theme';
import { type ApprovalRequest, approvals } from '../security/ApprovalManager';
import { speak } from '../utils/ttsManager';
import { Button } from './ui';

export default function ApprovalHost() {
  const [queue, setQueue] = useState<ApprovalRequest[]>([]);
  useEffect(() => approvals.subscribe(setQueue), []);
  const current = queue[0];

  useEffect(() => {
    if (current?.speak) speak(current.speak);
  }, [current?.id, current?.speak]);

  if (!current) return null;
  const tone =
    current.risk === 'high'
      ? theme.colors.error
      : current.risk === 'medium'
        ? theme.colors.warning
        : theme.colors.accent;

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={() => approvals.respond(current.id, 'deny')}
    >
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={[styles.badge, { backgroundColor: tone }]}>
            <Text style={styles.badgeText}>
              {current.kind === 'remote_inference' ? 'CLOUD' : current.risk.toUpperCase()} ·
              approval needed
            </Text>
          </View>
          <Text style={styles.title}>{current.title}</Text>
          <Text style={styles.detail}>{current.detail}</Text>
          {queue.length > 1 ? (
            <Text style={styles.more}>+{queue.length - 1} more waiting</Text>
          ) : null}
          <View style={styles.row}>
            <Button
              label="Deny"
              kind="danger"
              style={{ flex: 1 }}
              onPress={() => approvals.respond(current.id, 'deny')}
            />
            <Button
              label="Allow once"
              style={{ flex: 1 }}
              onPress={() => approvals.respond(current.id, 'approve_once')}
            />
          </View>
          {current.allowAlways ? (
            <Button
              label="Always allow this"
              kind="ghost"
              small
              style={{ marginTop: 6 }}
              onPress={() => approvals.respond(current.id, 'approve_always')}
            />
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: theme.colors.background,
    borderTopLeftRadius: theme.borderRadius.xl,
    borderTopRightRadius: theme.borderRadius.xl,
    padding: theme.spacing.xl,
    paddingBottom: 32,
  },
  badge: {
    alignSelf: 'flex-start',
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: 10,
    paddingVertical: 3,
    marginBottom: 10,
  },
  badgeText: {
    color: theme.colors.textLight,
    fontSize: theme.fontSize.xs + 1,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  title: {
    fontSize: theme.fontSize.xl,
    fontWeight: '700',
    color: theme.colors.text,
    marginBottom: 6,
  },
  detail: { fontSize: theme.fontSize.md, color: theme.colors.text, lineHeight: 21 },
  more: { marginTop: 8, color: theme.colors.textSecondary, fontSize: theme.fontSize.sm },
  row: { flexDirection: 'row', gap: 8, marginTop: 18 },
});
