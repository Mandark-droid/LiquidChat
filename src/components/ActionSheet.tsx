import React from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { theme } from '../config/theme';

export interface ActionSheetOption {
  text: string;
  onPress: () => void;
  destructive?: boolean;
}

/**
 * Menu for more than three choices. Android's Alert keeps at most three buttons and silently
 * drops the rest (including Cancel), which left a menu that could not be closed.
 */
export default function ActionSheet({
  visible,
  title,
  options,
  onClose,
}: {
  visible: boolean;
  title?: string;
  options: ActionSheetOption[];
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close menu">
        <Pressable style={[styles.sheet, { paddingBottom: 8 + insets.bottom }]}>
          {title ? (
            <Text style={styles.title} numberOfLines={2}>
              {title}
            </Text>
          ) : null}
          {options.map(o => (
            <TouchableOpacity
              key={o.text}
              style={styles.row}
              onPress={() => {
                onClose();
                o.onPress();
              }}
            >
              <Text style={[styles.label, o.destructive && styles.destructive]}>{o.text}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={[styles.row, styles.cancelRow]} onPress={onClose}>
            <Text style={styles.cancel}>Cancel</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

type SheetRequest = { title?: string; options: ActionSheetOption[] };
let present: ((r: SheetRequest) => void) | null = null;

/** Imperative menu for call sites outside a component; needs <ActionSheetHost /> mounted once. */
export function showActionSheet(request: SheetRequest): void {
  present?.(request);
}

export function ActionSheetHost() {
  const [request, setRequest] = React.useState<SheetRequest | null>(null);
  React.useEffect(() => {
    present = setRequest;
    return () => {
      present = null;
    };
  }, []);
  return (
    <ActionSheet
      visible={!!request}
      title={request?.title}
      options={request?.options ?? []}
      onClose={() => setRequest(null)}
    />
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: theme.colors.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
  },
  title: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    paddingVertical: theme.spacing.sm,
  },
  row: {
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  label: { fontSize: theme.fontSize.lg, color: theme.colors.text, textAlign: 'center' },
  destructive: { color: theme.colors.error },
  cancelRow: { marginTop: 4 },
  cancel: {
    fontSize: theme.fontSize.lg,
    fontWeight: '600',
    color: theme.colors.textSecondary,
    textAlign: 'center',
  },
});
