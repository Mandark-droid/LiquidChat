/** Agent settings: opt-in OpenTelemetry export of on-device model telemetry to the user's collector. */
import React, { useEffect, useState } from 'react';
import { Alert, Text, View } from 'react-native';

import {
  DEFAULT_OTEL,
  endpointProblem,
  flushOtel,
  getOtelHeaders,
  getOtelSettings,
  type OtelSettings,
  saveOtelSettings,
} from '../observability/otelExport';
import { Button, Card, Field, SectionTitle, ToggleRow, ui } from './ui';

/** `bare`: no title or card around it (inside a screen's own section). */
export default function OtelSettingsCard({ bare = false }: { bare?: boolean }) {
  const [s, setS] = useState<OtelSettings>(DEFAULT_OTEL);
  const [headers, setHeaders] = useState('');
  const [hasHeaders, setHasHeaders] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getOtelSettings().then(setS);
    getOtelHeaders().then(h => setHasHeaders(!!h));
  }, []);

  const change = (patch: Partial<OtelSettings>) => {
    setS(prev => ({ ...prev, ...patch }));
    setDirty(true);
  };

  const save = async () => {
    const problem = s.enabled ? endpointProblem(s.endpoint) : null;
    if (problem) {
      Alert.alert('OpenTelemetry', problem);
      return;
    }
    setBusy(true);
    try {
      await saveOtelSettings(s, headers.trim() ? headers : null);
      if (headers.trim()) setHasHeaders(true);
      setHeaders('');
      setDirty(false);
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      const ok = await flushOtel();
      Alert.alert(
        'OpenTelemetry',
        ok
          ? 'Buffered telemetry was sent to the collector.'
          : 'Nothing was sent. Check that export is on and saved, the URL and headers are right, and the collector is reachable from the phone.',
      );
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <>
      <ToggleRow
        label="Export telemetry"
        hint="Sends a span per on-device model call (tokens, speed, time to first token, memory) to your OpenTelemetry collector over OTLP/HTTP. Off by default; nothing is sent anywhere else."
        value={s.enabled}
        onValueChange={v => change({ enabled: v })}
      />
      <Field
        label="Collector URL"
        value={s.endpoint}
        onChangeText={v => change({ endpoint: v })}
        autoCapitalize="none"
        keyboardType="url"
        placeholder="https://otel.example.com:4318"
        hint="OTLP/HTTP endpoint; /v1/traces and /v1/metrics are added. https:// unless the collector is on your local network."
      />
      <Field
        label="Headers"
        value={headers}
        onChangeText={v => {
          setHeaders(v);
          setDirty(true);
        }}
        autoCapitalize="none"
        secureTextEntry
        placeholder={hasHeaders ? '•••• saved (type to replace)' : 'Authorization=Bearer …'}
        hint="Comma-separated key=value, e.g. for an API key. Stored in Android Keystore-encrypted storage."
      />
      <ToggleRow
        label="Include prompts and replies"
        hint="Off: spans carry counts and timings only. On: message text is exported too."
        value={s.captureContent}
        onValueChange={v => change({ captureContent: v })}
      />
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
        <Button
          label="Send now"
          kind="secondary"
          style={{ flex: 1 }}
          disabled={busy || dirty || !s.enabled}
          onPress={test}
        />
        <Button label="Save" style={{ flex: 1 }} disabled={busy || !dirty} onPress={save} />
      </View>
      {s.enabled && !dirty ? (
        <Text style={[ui.muted, { marginTop: 8 }]}>Exporting to {s.endpoint}</Text>
      ) : null}
    </>
  );
  if (bare) return body;
  return (
    <>
      <SectionTitle>OpenTelemetry export</SectionTitle>
      <Card>{body}</Card>
    </>
  );
}
