import React from 'react';
import {
  ActivityIndicator,
  type StyleProp,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  type TextInputProps,
  TouchableOpacity,
  View,
  type ViewStyle,
} from 'react-native';

import { theme } from '../config/theme';

/** Small shared primitives for the Meetings / Tasks / Email screens. */

export function ScreenHeader({
  title,
  subtitle,
  onBack,
  right,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  right?: React.ReactNode;
}) {
  return (
    <View style={s.header}>
      {onBack ? (
        <TouchableOpacity onPress={onBack} style={s.backBtn} hitSlop={12}>
          <Text style={s.backText}>‹</Text>
        </TouchableOpacity>
      ) : null}
      <View style={{ flex: 1 }}>
        <Text style={s.headerTitle} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={s.headerSub} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ? <View style={s.headerRight}>{right}</View> : null}
    </View>
  );
}

export function HeaderButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} style={s.headerBtn} hitSlop={8}>
      <Text style={s.headerBtnText}>{label}</Text>
    </TouchableOpacity>
  );
}

type BtnKind = 'primary' | 'secondary' | 'danger' | 'ghost' | 'record';

export function Button({
  label,
  onPress,
  kind = 'primary',
  disabled,
  loading,
  style,
  small,
}: {
  label: string;
  onPress: () => void;
  kind?: BtnKind;
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  small?: boolean;
}) {
  const bg =
    kind === 'primary'
      ? theme.colors.secondary
      : kind === 'record'
        ? theme.colors.error
        : kind === 'danger'
          ? '#FBE9E9'
          : kind === 'secondary'
            ? theme.colors.surface
            : 'transparent';
  const fg =
    kind === 'primary' || kind === 'record'
      ? theme.colors.textLight
      : kind === 'danger'
        ? theme.colors.error
        : theme.colors.text;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.8}
      style={[
        s.btn,
        small && s.btnSmall,
        { backgroundColor: bg, opacity: disabled ? 0.5 : 1 },
        kind === 'secondary' && s.btnOutline,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} size="small" />
      ) : (
        <Text style={[s.btnText, small && s.btnTextSmall, { color: fg }]}>{label}</Text>
      )}
    </TouchableOpacity>
  );
}

export function Chip({
  label,
  active,
  onPress,
  onLongPress,
  tone,
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  tone?: 'warn' | 'ok' | 'info' | 'muted';
}) {
  const toneStyle =
    tone === 'warn'
      ? { backgroundColor: '#FFF1E6', borderColor: '#FFC89E' }
      : tone === 'ok'
        ? { backgroundColor: '#E8F3E6', borderColor: '#B9D8B2' }
        : tone === 'info'
          ? { backgroundColor: theme.colors.toolCallBg, borderColor: '#B6DDF0' }
          : tone === 'muted'
            ? { backgroundColor: theme.colors.surfaceLight, borderColor: theme.colors.border }
            : null;
  return (
    <TouchableOpacity
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!onPress && !onLongPress}
      style={[s.chip, toneStyle, active && s.chipActive]}
    >
      <Text style={[s.chipText, active && s.chipTextActive]} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function SectionTitle({
  children,
  right,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <View style={s.sectionRow}>
      <Text style={s.sectionTitle}>{children}</Text>
      {right}
    </View>
  );
}

export function Field({
  label,
  hint,
  ...props
}: TextInputProps & { label: string; hint?: string }) {
  return (
    <View style={s.field}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput
        placeholderTextColor={theme.colors.textMuted}
        {...props}
        style={[s.input, props.multiline && s.inputMulti, props.style]}
      />
      {hint ? <Text style={s.hint}>{hint}</Text> : null}
    </View>
  );
}

export function ToggleRow({
  label,
  hint,
  value,
  onValueChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
}) {
  return (
    <View style={s.toggleRow}>
      <View style={{ flex: 1, paddingRight: 12 }}>
        <Text style={s.toggleLabel}>{label}</Text>
        {hint ? <Text style={s.hint}>{hint}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ true: theme.colors.secondary, false: theme.colors.border }}
        thumbColor={theme.colors.surface}
      />
    </View>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={s.segmented}>
      {options.map(o => (
        <TouchableOpacity
          key={o.key}
          onPress={() => onChange(o.key)}
          style={[s.segment, value === o.key && s.segmentActive]}
        >
          <Text style={[s.segmentText, value === o.key && s.segmentTextActive]} numberOfLines={1}>
            {o.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  return (
    <View style={s.empty}>
      <Text style={s.emptyTitle}>{title}</Text>
      {body ? <Text style={s.emptyBody}>{body}</Text> : null}
      {action}
    </View>
  );
}

export function ProgressBar({ value, color }: { value: number; color?: string }) {
  return (
    <View style={s.progressTrack}>
      <View
        style={[
          s.progressFill,
          {
            width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`,
            backgroundColor: color ?? theme.colors.accent,
          },
        ]}
      />
    </View>
  );
}

export const ui = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  pad: { paddingHorizontal: theme.spacing.lg },
  muted: { color: theme.colors.textSecondary, fontSize: theme.fontSize.sm },
  body: { color: theme.colors.text, fontSize: theme.fontSize.md, lineHeight: 21 },
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    backgroundColor: theme.colors.primary,
    minHeight: 56,
  },
  backBtn: { paddingRight: 12, paddingVertical: 2 },
  backText: { color: theme.colors.textLight, fontSize: 30, lineHeight: 30, fontWeight: '300' },
  headerTitle: { color: theme.colors.textLight, fontSize: theme.fontSize.xl, fontWeight: '700' },
  headerSub: { color: 'rgba(255,255,255,0.65)', fontSize: theme.fontSize.sm, marginTop: 1 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 8 },
  headerBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  headerBtnText: { color: theme.colors.textLight, fontSize: theme.fontSize.md, fontWeight: '600' },
  btn: {
    borderRadius: theme.borderRadius.md,
    paddingVertical: 13,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnSmall: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: theme.borderRadius.sm },
  btnOutline: { borderWidth: 1, borderColor: theme.colors.border },
  btnText: { fontSize: theme.fontSize.lg, fontWeight: '700' },
  btnTextSmall: { fontSize: theme.fontSize.md, fontWeight: '600' },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    maxWidth: 220,
  },
  chipActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  chipText: { fontSize: theme.fontSize.sm, color: theme.colors.text, fontWeight: '600' },
  chipTextActive: { color: theme.colors.textLight },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.lg,
  },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 18,
    marginBottom: 8,
  },
  sectionTitle: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: '700',
    color: theme.colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  field: { marginBottom: 12 },
  fieldLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: '600',
    color: theme.colors.textSecondary,
    marginBottom: 4,
  },
  input: {
    backgroundColor: theme.colors.inputBg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: theme.fontSize.md,
    color: theme.colors.text,
  },
  inputMulti: { minHeight: 90, textAlignVertical: 'top' },
  hint: { fontSize: theme.fontSize.xs + 1, color: theme.colors.textSecondary, marginTop: 3 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  toggleLabel: { fontSize: theme.fontSize.md, color: theme.colors.text, fontWeight: '600' },
  segmented: {
    flexDirection: 'row',
    backgroundColor: theme.colors.surfaceLight,
    borderRadius: theme.borderRadius.sm,
    padding: 3,
  },
  segment: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 6 },
  segmentActive: { backgroundColor: theme.colors.surface },
  segmentText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.textSecondary,
    fontWeight: '600',
  },
  segmentTextActive: { color: theme.colors.text },
  empty: { alignItems: 'center', paddingHorizontal: 32, paddingVertical: 48, gap: 8 },
  emptyTitle: {
    fontSize: theme.fontSize.xl,
    fontWeight: '700',
    color: theme.colors.text,
    textAlign: 'center',
  },
  emptyBody: {
    fontSize: theme.fontSize.md,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 8,
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.surfaceLight,
    overflow: 'hidden',
  },
  progressFill: { height: 6, borderRadius: 3 },
});
