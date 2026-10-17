import { NativeModules, PermissionsAndroid } from 'react-native';

import type * as AndroidPlatformModule from '../../src/platform/android';

type AndroidModule = typeof AndroidPlatformModule;

function load(): AndroidModule {
  let mod: AndroidModule | undefined;
  jest.isolateModules(() => {
    mod = require('../../src/platform/android');
  });
  return mod!;
}

describe('platform/android adapters', () => {
  afterEach(() => {
    delete (NativeModules as any).DeviceContext;
    delete (NativeModules as any).CredentialStore;
    jest.restoreAllMocks();
  });

  test('missing native modules: distribution falls back to play, calls throw a clear error', () => {
    const { platform } = load();
    expect(platform.device.distribution()).toBe('play');
    expect(() => platform.credentials.databaseKey()).toThrow(/CredentialStore native module/);
  });

  test('routes special:* to DeviceContext and android.permission.* to PermissionsAndroid', async () => {
    const checkSpecial = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const openSpecialSettings = jest.fn().mockResolvedValue(true);
    (NativeModules as any).DeviceContext = {
      getConstants: () => ({ distribution: 'full' }),
      checkSpecial,
      openSpecialSettings,
    };
    const check = jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(true);

    const { platform } = load();
    expect(platform.device.distribution()).toBe('full');

    expect(await platform.permissions.request('special:notification_policy')).toBe(true);
    expect(openSpecialSettings).toHaveBeenCalledWith('special:notification_policy');
    expect(checkSpecial).toHaveBeenCalledTimes(2);

    expect(await platform.permissions.check('android.permission.READ_CALENDAR')).toBe(true);
    expect(check).toHaveBeenCalledWith('android.permission.READ_CALENDAR');
  });
});
