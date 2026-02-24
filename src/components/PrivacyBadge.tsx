import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export default function PrivacyBadge() {
  return (
    <View style={styles.badge}>
      <Text style={styles.text}>{'\uD83D\uDD12'} Local AI</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    backgroundColor: 'rgba(74,103,65,0.12)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
  },
  text: {
    fontSize: 9,
    fontWeight: '600',
    color: '#4A6741',
  },
});
