import { NativeModules, Platform } from 'react-native';

import { setAlarm } from '../../src/tools/alarm';
import { createContact } from '../../src/tools/contacts';
import { setTimer } from '../../src/tools/timer';

const launch = jest.fn(async () => true);

beforeAll(() => {
  Object.defineProperty(Platform, 'OS', { get: () => 'android' });
});

beforeEach(() => {
  launch.mockClear();
  (NativeModules as { SystemControls?: unknown }).SystemControls = { launchIntent: launch };
});

describe('intents to other apps', () => {
  it('sends alarm hour and minutes as numbers (AlarmClock ignores strings)', async () => {
    const r = await setAlarm(7, 30, 'Gym');
    expect(r.success).toBe(true);
    expect(launch).toHaveBeenCalledWith('android.intent.action.SET_ALARM', null, null, {
      'android.intent.extra.alarm.HOUR': 7,
      'android.intent.extra.alarm.MINUTES': 30,
      'android.intent.extra.alarm.SKIP_UI': false,
      'android.intent.extra.alarm.MESSAGE': 'Gym',
    });
  });

  it('sends the timer length as a number', async () => {
    await setTimer(90);
    expect(launch).toHaveBeenCalledWith('android.intent.action.SET_TIMER', null, null, {
      'android.intent.extra.alarm.LENGTH': 90,
      'android.intent.extra.alarm.SKIP_UI': false,
    });
  });

  it('targets the contacts app with the raw-contact type', async () => {
    await createContact('Priya', 'Shah', '+91 98765 43210');
    expect(launch).toHaveBeenCalledWith(
      'android.intent.action.INSERT',
      null,
      'vnd.android.cursor.dir/raw_contact',
      { name: 'Priya Shah', phone: '+91 98765 43210' },
    );
  });

  it('reports failure when no app handles the intent', async () => {
    launch.mockRejectedValueOnce(new Error('No app on this phone can handle SET_ALARM.'));
    const r = await setAlarm(6, 0);
    expect(r.success).toBe(false);
  });
});
