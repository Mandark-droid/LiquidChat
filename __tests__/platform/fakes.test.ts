import { createFakePlatform, FakePermissionChecker } from '../../src/platform/fakes';
import type { CapturedNotification } from '../../src/platform/types';

describe('platform fakes', () => {
  test('device context returns configured snapshot and distribution', async () => {
    const p = createFakePlatform({
      snapshot: { batteryPercent: 12, charging: true },
      distribution: 'play',
    });
    const snap = await p.device.snapshot();
    expect(snap.batteryPercent).toBe(12);
    expect(snap.charging).toBe(true);
    expect(snap.online).toBe(true);
    expect(p.device.distribution()).toBe('play');
    p.device.setSnapshot({ thermal: 'severe' });
    expect((await p.device.snapshot()).thermal).toBe('severe');
    expect(p.device.snapshotCalls).toBe(2);
  });

  test('permission checker: map, request outcome, network always granted', async () => {
    const perms = new FakePermissionChecker({ 'android.permission.READ_CALENDAR': true });
    expect(await perms.check('android.permission.READ_CALENDAR')).toBe(true);
    expect(await perms.check('special:network')).toBe(true);
    expect(await perms.check('special:notification_policy')).toBe(false);

    perms.onRequest('special:notification_policy', false);
    expect(await perms.request('special:notification_policy')).toBe(false);
    expect(await perms.request('android.permission.READ_CONTACTS')).toBe(true);
    expect(await perms.check('android.permission.READ_CONTACTS')).toBe(true);
    expect(perms.requested).toEqual([
      'special:notification_policy',
      'android.permission.READ_CONTACTS',
    ]);
  });

  test('credential store: get/set/delete/has and stable database key', async () => {
    const { credentials } = createFakePlatform();
    expect(await credentials.get('gmail')).toBeNull();
    await credentials.set('gmail', 'token');
    expect(await credentials.has('gmail')).toBe(true);
    expect(await credentials.get('gmail')).toBe('token');
    await credentials.delete('gmail');
    expect(await credentials.has('gmail')).toBe(false);

    const k1 = await credentials.databaseKey();
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    expect(await credentials.databaseKey()).toBe(k1);

    credentials.failWith = new Error('KEYSTORE_UNAVAILABLE');
    await expect(credentials.get('x')).rejects.toThrow('KEYSTORE_UNAVAILABLE');
  });

  test('alarm scheduler: schedule, cancel, fire and consume launch payload once', async () => {
    const { alarms } = createFakePlatform();
    await alarms.schedule({ id: 'b', triggerAtMs: 2000, title: 'B', body: '', payload: 'pb' });
    await alarms.schedule({ id: 'a', triggerAtMs: 1000, title: 'A', body: '', payload: 'pa' });
    await alarms.schedule({ id: 'c', triggerAtMs: 3000, title: 'C', body: '', payload: 'pc' });
    await alarms.cancel('c');
    expect(alarms.list().map(a => a.id)).toEqual(['a', 'b']);

    const fired = alarms.advanceTo(1500, true);
    expect(fired.map(a => a.id)).toEqual(['a']);
    expect(alarms.list().map(a => a.id)).toEqual(['b']);
    expect(await alarms.consumeLaunchPayload()).toBe('pa');
    expect(await alarms.consumeLaunchPayload()).toBeNull();

    await expect(
      alarms.schedule({ id: '', triggerAtMs: 1, title: '', body: '', payload: '' }),
    ).rejects.toThrow();
  });

  test('notification source: filters, drain, subscribe', async () => {
    const { notifications } = createFakePlatform();
    const seen: CapturedNotification[] = [];
    const unsubscribe = notifications.subscribe(n => seen.push(n));

    await notifications.setFilters({ allow: [], block: ['com.spam'], retentionDays: 3 });
    expect(notifications.post({ packageName: 'com.whatsapp', title: 'Hi', text: 'there' })).toBe(
      true,
    );
    expect(notifications.post({ packageName: 'com.spam', title: 'Buy' })).toBe(false);
    expect(notifications.post({ packageName: 'com.music', isOngoing: true })).toBe(false);

    await notifications.setFilters({ allow: ['com.slack'], block: [], retentionDays: 3 });
    expect(notifications.post({ packageName: 'com.whatsapp' })).toBe(false);
    expect(notifications.post({ packageName: 'com.slack', title: 'standup' })).toBe(true);

    expect(seen.map(n => n.packageName)).toEqual(['com.whatsapp', 'com.slack']);
    unsubscribe();
    notifications.post({ packageName: 'com.slack' });
    expect(seen).toHaveLength(2);

    const drained = await notifications.drain();
    expect(drained).toHaveLength(3);
    expect(await notifications.drain()).toEqual([]);

    notifications.accessGranted = false;
    expect(await notifications.isAccessGranted()).toBe(false);
    expect(notifications.post({ packageName: 'com.slack' })).toBe(false);
    await notifications.openAccessSettings();
    expect(notifications.openSettingsCalls).toBe(1);
  });

  test('device state reader returns configured values', async () => {
    const { deviceState } = createFakePlatform();
    expect(await deviceState.getInterruptionFilter()).toBe('all');
    deviceState.interruptionFilter = 'none';
    deviceState.volumes.set('media', 30);
    expect(await deviceState.getInterruptionFilter()).toBe('none');
    expect(await deviceState.getStreamVolumePercent('media')).toBe(30);
  });
});
