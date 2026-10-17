/**
 * Agent settings (PRD §6, §11, §16, §17): routing mode, energy, remote data
 * policy and budgets; remote providers with keys kept in the Keystore-backed
 * CredentialStore (never shown again, never logged); privacy and tool grants;
 * notification capture; MCP servers.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { agentRuntime } from '../agent/runtime';
import {
  Button,
  Card,
  Chip,
  Field,
  ScreenHeader,
  SectionTitle,
  Segmented,
  ToggleRow,
  ui,
} from '../components/ui';
import { theme } from '../config/theme';
import type { RemoteProviderConfig, RemoteProviderKind } from '../inference/ModelRegistry';
import type { RoutingPolicy } from '../inference/RoutingPolicy';
import type { DataClass, EnergyMode, RoutingMode } from '../inference/types';
import type { McpServerRecord } from '../mcp/McpServerStore';
import type { NotificationSettings } from '../notifications/NotificationStore';
import { platform } from '../platform/android';
import { DEFAULT_SETTINGS } from '../types';
import { storage } from '../utils/storage';

const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

export default function AgentSettingsScreen({ onBack }: { onBack: () => void }) {
  const stack = agentRuntime.inferenceStack;
  const [runtimeOn, setRuntimeOn] = useState(true);
  const [policy, setPolicy] = useState<RoutingPolicy | null>(null);
  const [providers, setProviders] = useState<(RemoteProviderConfig & { hasKey: boolean })[]>([]);
  const [spend, setSpend] = useState({ todayUsd: 0, monthUsd: 0 });
  const [privacy, setPrivacy] = useState<{ providerId: string; dataClass: DataClass }[]>([]);
  const [grants, setGrants] = useState<string[]>([]);
  const [notif, setNotif] = useState<NotificationSettings | null>(null);
  const [notifAccess, setNotifAccess] = useState(false);
  const [servers, setServers] = useState<McpServerRecord[]>([]);
  const [adding, setAdding] = useState<'provider' | 'mcp' | null>(null);

  const load = useCallback(async () => {
    try {
      await agentRuntime.ready();
      const s = await storage.getSettings();
      setRuntimeOn((s ?? DEFAULT_SETTINGS).agentRuntimeEnabled !== false);
      if (stack) {
        setPolicy(await stack.policyStore.get());
        const ps = await stack.registry.remoteProviders();
        setProviders(
          await Promise.all(
            ps.map(async p => ({ ...p, hasKey: await stack.registry.hasProviderKey(p.id) })),
          ),
        );
        setSpend(await stack.ledger.summary());
        setPrivacy(await stack.grants.list());
      }
      setGrants(await agentRuntime.repo.grants());
      setNotif(await agentRuntime.notificationStore.getSettings());
      setNotifAccess(await platform.notifications.isAccessGranted().catch(() => false));
      setServers(await agentRuntime.mcpServers.list());
    } catch (e) {
      Alert.alert('Agent settings', e instanceof Error ? e.message : String(e));
    }
  }, [stack]);

  useEffect(() => {
    load();
  }, [load]);

  const patchPolicy = async (p: Partial<RoutingPolicy>) => {
    if (!stack) return;
    setPolicy(await stack.policyStore.update(p));
  };

  const toggleClass = (c: DataClass, on: boolean) => {
    if (!policy) return;
    const set = new Set(policy.allowRemoteDataClasses);
    if (on) set.add(c);
    else set.delete(c);
    set.add('public');
    patchPolicy({ allowRemoteDataClasses: [...set] });
  };

  const patchNotif = async (p: Partial<NotificationSettings>) => {
    const next = await agentRuntime.notificationStore.updateSettings(p);
    setNotif(next);
    await agentRuntime.notificationStore.applyFiltersTo(platform.notifications).catch(() => {});
  };

  return (
    <SafeAreaView style={ui.screen} edges={['top']}>
      <ScreenHeader title="Agent" subtitle="Routing, privacy, permissions" onBack={onBack} />
      <ScrollView
        contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: 80 }}
        keyboardShouldPersistTaps="handled"
      >
        <ToggleRow
          label="Use the agent runtime in chat"
          hint="Plans multi-step tasks, asks before sensitive actions, routes each step to the right model."
          value={runtimeOn}
          onValueChange={async v => {
            setRuntimeOn(v);
            const s = (await storage.getSettings()) ?? DEFAULT_SETTINGS;
            await storage.saveSettings({ ...s, agentRuntimeEnabled: v });
          }}
        />

        {policy ? (
          <>
            <SectionTitle>Where models run</SectionTitle>
            <Segmented<RoutingMode>
              options={[
                { key: 'local_only', label: 'On-device only' },
                { key: 'hybrid', label: 'Hybrid' },
                { key: 'cloud_preferred', label: 'Cloud first' },
              ]}
              value={policy.mode}
              onChange={mode => patchPolicy({ mode })}
            />
            <Text style={[ui.muted, { marginTop: 6 }]}>
              Hybrid decides per step: planning and phone actions stay local; only a step that needs
              stronger reasoning may go to the cloud, then control returns on-device.
            </Text>
            <SectionTitle>Energy</SectionTitle>
            <Segmented<EnergyMode>
              options={[
                { key: 'battery_saver', label: 'Saver' },
                { key: 'balanced', label: 'Balanced' },
                { key: 'performance', label: 'Performance' },
              ]}
              value={policy.energy}
              onChange={energy => patchPolicy({ energy })}
            />
            <SectionTitle>Data allowed to leave the phone</SectionTitle>
            <ToggleRow label="Public (no personal data)" value onValueChange={() => {}} />
            <ToggleRow
              label="Personal (tasks, meetings, memory)"
              hint="Still asks the first time per provider."
              value={policy.allowRemoteDataClasses.includes('personal')}
              onValueChange={v => toggleClass('personal', v)}
            />
            <ToggleRow
              label="Sensitive"
              hint="Asked every time; never 'always allow'."
              value={policy.allowRemoteDataClasses.includes('sensitive')}
              onValueChange={v => toggleClass('sensitive', v)}
            />
            <SectionTitle>Cloud budget</SectionTitle>
            <Text style={ui.muted}>
              Spent today {usd(spend.todayUsd)} · this month {usd(spend.monthUsd)}
            </Text>
            <BudgetField
              label="Max per task (USD)"
              value={policy.maxSpendPerTaskUsd}
              onCommit={v => patchPolicy({ maxSpendPerTaskUsd: v })}
            />
            <BudgetField
              label="Daily budget (USD)"
              value={policy.dailyBudgetUsd}
              onCommit={v => patchPolicy({ dailyBudgetUsd: v })}
            />
            <BudgetField
              label="Monthly budget (USD)"
              value={policy.monthlyBudgetUsd}
              onCommit={v => patchPolicy({ monthlyBudgetUsd: v })}
            />
            <BudgetField
              label="Max cloud calls per task"
              value={policy.maxRemoteCallsPerTask}
              integer
              onCommit={v => patchPolicy({ maxRemoteCallsPerTask: v })}
            />

            <SectionTitle>Cloud providers</SectionTitle>
            {providers.map(p => (
              <Card key={p.id} style={{ marginBottom: 8 }}>
                <View style={[ui.row, { justifyContent: 'space-between' }]}>
                  <Text style={[ui.body, { fontWeight: '700' }]}>{p.id}</Text>
                  <View style={ui.wrap}>
                    <Chip label={p.kind} tone="muted" />
                    <Chip
                      label={p.hasKey ? 'key stored' : 'no key'}
                      tone={p.hasKey ? 'info' : 'warn'}
                    />
                  </View>
                </View>
                <Text style={[ui.muted, { marginTop: 4 }]}>
                  {p.models.map(m => m.id).join(', ')}
                </Text>
                <ToggleRow
                  label="Enabled"
                  value={p.enabled}
                  onValueChange={async v => {
                    await stack?.registry.setProviderEnabled(p.id, v);
                    load();
                  }}
                />
                <Button
                  label="Remove (deletes key)"
                  kind="danger"
                  small
                  onPress={async () => {
                    await stack?.registry.removeProvider(p.id);
                    await stack?.grants.revoke(p.id);
                    load();
                  }}
                />
              </Card>
            ))}
            {adding === 'provider' ? (
              <ProviderForm
                onCancel={() => setAdding(null)}
                onSave={async (cfg, key) => {
                  await stack?.registry.upsertProvider(cfg, key);
                  setAdding(null);
                  load();
                }}
              />
            ) : (
              <Button label="Add provider" kind="secondary" onPress={() => setAdding('provider')} />
            )}

            {privacy.length ? (
              <>
                <SectionTitle>Cloud data permissions</SectionTitle>
                {privacy.map(g => (
                  <View
                    key={`${g.providerId}:${g.dataClass}`}
                    style={[ui.row, { justifyContent: 'space-between', marginBottom: 6 }]}
                  >
                    <Text style={ui.body}>
                      {g.providerId} · {g.dataClass}
                    </Text>
                    <Button
                      label="Revoke"
                      kind="ghost"
                      small
                      onPress={async () => {
                        await stack?.grants.revoke(g.providerId, g.dataClass);
                        load();
                      }}
                    />
                  </View>
                ))}
              </>
            ) : null}
          </>
        ) : null}

        <SectionTitle>Always-allowed actions</SectionTitle>
        {grants.length === 0 ? (
          <Text style={ui.muted}>None. Sending messages is never eligible.</Text>
        ) : (
          grants.map(g => (
            <View key={g} style={[ui.row, { justifyContent: 'space-between', marginBottom: 6 }]}>
              <Text style={ui.body}>{g}</Text>
              <Button
                label="Revoke"
                kind="ghost"
                small
                onPress={async () => {
                  await agentRuntime.repo.revokeGrant(g);
                  load();
                }}
              />
            </View>
          ))
        )}

        {notif ? (
          <>
            <SectionTitle>Notification summaries</SectionTitle>
            <ToggleRow
              label="Store notifications for summaries"
              hint={
                notifAccess
                  ? 'Access granted. Kept on this phone, encrypted.'
                  : 'Needs notification access (Android settings).'
              }
              value={notif.enabled}
              onValueChange={v => patchNotif({ enabled: v })}
            />
            {!notifAccess ? (
              <Button
                label="Grant notification access"
                kind="secondary"
                small
                onPress={() => platform.notifications.openAccessSettings()}
              />
            ) : null}
            <ToggleRow
              label="Never send notification content to the cloud"
              value={notif.localOnly}
              onValueChange={v => patchNotif({ localOnly: v })}
            />
            <ToggleRow
              label="Skip OTPs, balances and passwords"
              value={notif.excludeSensitive}
              onValueChange={v => patchNotif({ excludeSensitive: v })}
            />
            <BudgetField
              label="Keep for (days)"
              value={notif.retentionDays}
              integer
              onCommit={v => patchNotif({ retentionDays: Math.max(1, Math.min(30, v)) })}
            />
            <Text style={ui.muted}>
              {notif.block.length} apps blocked by default (authenticators, SMS, banking, UPI).
            </Text>
            <Button
              label="Delete stored notifications"
              kind="ghost"
              small
              onPress={async () => {
                const n = await agentRuntime.notificationStore.clearAll();
                Alert.alert('Notifications', `Deleted ${n}.`);
              }}
            />
          </>
        ) : null}

        <SectionTitle>MCP servers</SectionTitle>
        {servers.map(s => (
          <Card key={s.id} style={{ marginBottom: 8 }}>
            <Text style={[ui.body, { fontWeight: '700' }]}>{s.name}</Text>
            <Text style={ui.muted}>{s.url}</Text>
            <Text style={[ui.muted, { marginTop: 4 }]}>
              {s.tools?.length ?? 0} tools · each call asks unless the server marks it read-only
            </Text>
            <ToggleRow
              label="Enabled"
              value={s.enabled}
              onValueChange={async v => {
                await agentRuntime.mcpServers.update(s.id, { enabled: v });
                if (!v) agentRuntime.removeMcpTools(s.id);
                load();
              }}
            />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button
                label="Refresh tools"
                small
                kind="secondary"
                onPress={async () => {
                  try {
                    const n = await agentRuntime.refreshMcpServer(s.id);
                    Alert.alert(s.name, `${n} tools available.`);
                  } catch (e) {
                    Alert.alert(s.name, e instanceof Error ? e.message : String(e));
                  }
                  load();
                }}
              />
              <Button
                label="Remove"
                small
                kind="danger"
                onPress={async () => {
                  agentRuntime.removeMcpTools(s.id);
                  await agentRuntime.mcpServers.remove(s.id);
                  load();
                }}
              />
            </View>
          </Card>
        ))}
        {adding === 'mcp' ? (
          <McpForm
            onCancel={() => setAdding(null)}
            onSave={async (name, url, token) => {
              try {
                const s = await agentRuntime.mcpServers.add({
                  name,
                  url,
                  token: token || undefined,
                });
                setAdding(null);
                await agentRuntime
                  .refreshMcpServer(s.id)
                  .catch(e =>
                    Alert.alert(
                      name,
                      `Saved, but connecting failed: ${e instanceof Error ? e.message : e}`,
                    ),
                  );
                load();
              } catch (e) {
                Alert.alert('MCP server', e instanceof Error ? e.message : String(e));
              }
            }}
          />
        ) : (
          <Button label="Add MCP server" kind="secondary" onPress={() => setAdding('mcp')} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function BudgetField({
  label,
  value,
  integer,
  onCommit,
}: {
  label: string;
  value: number;
  integer?: boolean;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <Field
      label={label}
      value={text}
      keyboardType={integer ? 'number-pad' : 'decimal-pad'}
      onChangeText={setText}
      onEndEditing={() => {
        const n = integer ? parseInt(text, 10) : parseFloat(text);
        if (Number.isFinite(n) && n >= 0) onCommit(n);
        else setText(String(value));
      }}
    />
  );
}

const KIND_DEFAULTS: Record<RemoteProviderKind, { id: string; model: string; ctx: number }> = {
  openai: { id: 'openai', model: 'gpt-4.1-mini', ctx: 128000 },
  anthropic: { id: 'anthropic', model: 'claude-sonnet-5-5', ctx: 200000 },
  gemini: { id: 'gemini', model: 'gemini-2.5-flash', ctx: 1000000 },
};

function ProviderForm({
  onSave,
  onCancel,
}: {
  onSave: (cfg: RemoteProviderConfig, key: string) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<RemoteProviderKind>('anthropic');
  const [id, setId] = useState(KIND_DEFAULTS.anthropic.id);
  const [model, setModel] = useState(KIND_DEFAULTS.anthropic.model);
  const [baseUrl, setBaseUrl] = useState('');
  const [inCost, setInCost] = useState('3');
  const [outCost, setOutCost] = useState('15');
  const [key, setKey] = useState('');
  return (
    <Card style={{ marginTop: 8 }}>
      <Segmented<RemoteProviderKind>
        options={[
          { key: 'anthropic', label: 'Anthropic' },
          { key: 'openai', label: 'OpenAI-compatible' },
          { key: 'gemini', label: 'Gemini' },
        ]}
        value={kind}
        onChange={k => {
          setKind(k);
          setId(KIND_DEFAULTS[k].id);
          setModel(KIND_DEFAULTS[k].model);
        }}
      />
      <View style={{ height: 10 }} />
      <Field label="Provider id" value={id} onChangeText={setId} autoCapitalize="none" />
      <Field label="Model" value={model} onChangeText={setModel} autoCapitalize="none" />
      {kind === 'openai' ? (
        <Field
          label="Base URL (optional)"
          value={baseUrl}
          onChangeText={setBaseUrl}
          autoCapitalize="none"
          placeholder="https://api.openai.com/v1"
          hint="Any OpenAI-compatible endpoint (OpenRouter, Groq, vLLM). HTTPS only."
        />
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Field
            label="$ / M input"
            value={inCost}
            onChangeText={setInCost}
            keyboardType="decimal-pad"
          />
        </View>
        <View style={{ flex: 1 }}>
          <Field
            label="$ / M output"
            value={outCost}
            onChangeText={setOutCost}
            keyboardType="decimal-pad"
          />
        </View>
      </View>
      <Field
        label="API key"
        value={key}
        onChangeText={setKey}
        secureTextEntry
        autoCapitalize="none"
        hint="Stored in Android Keystore-encrypted storage. Never shown again or sent to any model."
      />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button label="Cancel" kind="secondary" style={{ flex: 1 }} onPress={onCancel} />
        <Button
          label="Save"
          style={{ flex: 1 }}
          disabled={!id.trim() || !model.trim() || !key.trim()}
          onPress={() => {
            const url = baseUrl.trim();
            if (url && !url.startsWith('https://')) {
              Alert.alert('Base URL', 'Use an https:// endpoint.');
              return;
            }
            onSave(
              {
                id: id.trim(),
                kind,
                baseUrl: url || undefined,
                enabled: true,
                models: [
                  {
                    id: model.trim(),
                    displayName: model.trim(),
                    contextTokens: KIND_DEFAULTS[kind].ctx,
                    vision: true,
                    tools: true,
                    inputCostPerM: parseFloat(inCost) || 0,
                    outputCostPerM: parseFloat(outCost) || 0,
                  },
                ],
              },
              key.trim(),
            );
            setKey('');
          }}
        />
      </View>
    </Card>
  );
}

function McpForm({
  onSave,
  onCancel,
}: {
  onSave: (name: string, url: string, token: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  return (
    <Card style={{ marginTop: 8 }}>
      <Field label="Name" value={name} onChangeText={setName} />
      <Field
        label="URL (Streamable HTTP)"
        value={url}
        onChangeText={setUrl}
        autoCapitalize="none"
        placeholder="https://example.com/mcp"
      />
      <Field
        label="Bearer token (optional)"
        value={token}
        onChangeText={setToken}
        secureTextEntry
        autoCapitalize="none"
        hint="Kept in encrypted storage; never placed in prompts."
      />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button label="Cancel" kind="secondary" style={{ flex: 1 }} onPress={onCancel} />
        <Button
          label="Connect"
          style={{ flex: 1 }}
          disabled={!name.trim() || !url.trim()}
          onPress={() => onSave(name.trim(), url.trim(), token.trim())}
        />
      </View>
    </Card>
  );
}
