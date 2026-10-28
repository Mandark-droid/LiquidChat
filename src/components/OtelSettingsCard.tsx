/** Agent settings: opt-in OpenTelemetry export of on-device model telemetry to the user's collector. */
import React, { useEffect, useState } from 'react';
import { Alert, Text, View } from 'react-native';

import {
  DEFAULT_OTEL,
  endpointProblem,
  flushOtel,
  getOtelHeaders,
  getOtelMirrorHeaders,
  getOtelSettings,
  nextHeaders,
  type OtelSettings,
  saveOtelSettings,
} from '../observability/otelExport';
import { Button, Card, Field, SectionTitle, ToggleRow, ui } from './ui';

/** `bare`: no title or card around it (inside a screen's own section). */
export default function OtelSettingsCard({ bare = false }: { bare?: boolean }) {
  const [s, setS] = useState<OtelSettings>(DEFAULT_OTEL);
  const [headers, setHeaders] = useState('');
  const [hasHeaders, setHasHeaders] = useState(false);
  const [mirrorHeaders, setMirrorHeaders] = useState('');
  const [hasMirrorHeaders, setHasMirrorHeaders] = useState(false);
  const [removeHeaders, setRemoveHeaders] = useState(false);
  const [removeMirrorHeaders, setRemoveMirrorHeaders] = useState(false);
  const [saved, setSaved] = useState<OtelSettings>(DEFAULT_OTEL);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getOtelSettings().then(v => {
      setS(v);
      setSaved(v);
    });
    getOtelHeaders().then(h => setHasHeaders(!!h));
    getOtelMirrorHeaders().then(h => setHasMirrorHeaders(!!h));
  }, []);

  const change = (patch: Partial<OtelSettings>) => {
    setS(prev => ({ ...prev, ...patch }));
    setDirty(true);
  };

  const save = async () => {
    const problem = s.enabled
      ? (endpointProblem(s.endpoint) ??
        (s.mirrorEndpoint.trim() ? endpointProblem(s.mirrorEndpoint) : null))
      : null;
    if (problem) {
      Alert.alert('OpenTelemetry', problem);
      return;
    }
    setBusy(true);
    try {
      const mainHeaders = nextHeaders(headers, removeHeaders, saved.endpoint, s.endpoint);
      const secondHeaders = nextHeaders(
        mirrorHeaders,
        removeMirrorHeaders,
        saved.mirrorEndpoint,
        s.mirrorEndpoint,
      );
      await saveOtelSettings(s, mainHeaders, secondHeaders);
      if (mainHeaders !== null) setHasHeaders(!!mainHeaders.trim());
      if (secondHeaders !== null) setHasMirrorHeaders(!!secondHeaders.trim());
      setHeaders('');
      setMirrorHeaders('');
      setRemoveHeaders(false);
      setRemoveMirrorHeaders(false);
      setSaved(s);
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
        placeholder={
          hasHeaders && !removeHeaders ? '•••• saved (type to replace)' : 'Authorization=Bearer …'
        }
        hint="Comma-separated key=value, e.g. for an API key. Stored in Android Keystore-encrypted storage, and removed if the URL moves to another host."
      />
      {hasHeaders ? (
        <RemoveHeaders
          pending={removeHeaders}
          onPress={() => {
            setRemoveHeaders(true);
            setHeaders('');
            setDirty(true);
          }}
        />
      ) : null}
      <Field
        label="Second destination (optional)"
        value={s.mirrorEndpoint}
        onChangeText={v => change({ mirrorEndpoint: v })}
        autoCapitalize="none"
        keyboardType="url"
        placeholder="https://otel.example.com"
        hint="Another OTLP/HTTP endpoint that gets the same telemetry, e.g. a hosted backend next to your own collector. Leave empty for one destination."
      />
      {s.mirrorEndpoint.trim() ? (
        <Field
          label="Second destination headers"
          value={mirrorHeaders}
          onChangeText={v => {
            setMirrorHeaders(v);
            setDirty(true);
          }}
          autoCapitalize="none"
          secureTextEntry
          placeholder={
            hasMirrorHeaders && !removeMirrorHeaders
              ? '•••• saved (type to replace)'
              : 'Authorization=Bearer …'
          }
          hint="Comma-separated key=value. Stored in Android Keystore-encrypted storage."
        />
      ) : null}
      {s.mirrorEndpoint.trim() && hasMirrorHeaders ? (
        <RemoveHeaders
          pending={removeMirrorHeaders}
          onPress={() => {
            setRemoveMirrorHeaders(true);
            setMirrorHeaders('');
            setDirty(true);
          }}
        />
      ) : null}
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
        <Text style={[ui.muted, { marginTop: 8 }]}>
          Exporting to {s.endpoint}
          {s.mirrorEndpoint.trim() ? ` and ${s.mirrorEndpoint.trim()}` : ''}
        </Text>
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

function RemoveHeaders({ pending, onPress }: { pending: boolean; onPress: () => void }) {
  return pending ? (
    <Text style={[ui.muted, { marginTop: -4, marginBottom: 8 }]}>
      Saved headers will be removed when you save.
    </Text>
  ) : (
    <Text
      style={[ui.muted, { marginTop: -4, marginBottom: 8, textDecorationLine: 'underline' }]}
      onPress={onPress}
      accessibilityRole="button"
    >
      Remove saved headers
    </Text>
  );
}
