import { NativeModules, Platform } from 'react-native';

import { createCalendarEvent, eventWindow } from '../../src/tools/calendarEvent';

describe('eventWindow', () => {
  it('makes a date-only value an all-day event at UTC midnight', () => {
    expect(eventWindow('2026-10-24')).toEqual({
      begin: Date.UTC(2026, 9, 24),
      end: Date.UTC(2026, 9, 25),
      allDay: true,
    });
  });

  it('gives a date-time a one-hour local event', () => {
    const w = eventWindow('2026-10-24T10:00:00');
    expect(w.allDay).toBe(false);
    expect(w.begin).toBe(new Date(2026, 9, 24, 10).getTime());
    expect(w.end - w.begin).toBe(3_600_000);
  });

  it('rejects garbage instead of creating an event at the epoch', () => {
    expect(() => eventWindow('next week-ish')).toThrow(/Unrecognised date/);
  });
});

describe('createCalendarEvent (android)', () => {
  const original = Platform.OS;
  beforeAll(() => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  });
  afterAll(() => {
    Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
  });
  afterEach(() => {
    delete (NativeModules as Record<string, unknown>).SystemControls;
  });

  it('passes epoch millis and the all-day flag to the native insert intent', async () => {
    const insert = jest.fn().mockResolvedValue(true);
    (NativeModules as Record<string, unknown>).SystemControls = { insertCalendarEvent: insert };
    const r = await createCalendarEvent('Send notes', '2026-10-24', 'from meeting');
    expect(r.success).toBe(true);
    expect(insert).toHaveBeenCalledWith(
      'Send notes',
      Date.UTC(2026, 9, 24),
      Date.UTC(2026, 9, 25),
      true,
      'from meeting',
    );
  });

  it('reports failure when the calendar cannot be opened', async () => {
    (NativeModules as Record<string, unknown>).SystemControls = {
      insertCalendarEvent: jest.fn().mockRejectedValue(new Error('No calendar app is installed.')),
    };
    const r = await createCalendarEvent('Send notes', '2026-10-24');
    expect(r).toMatchObject({ success: false });
    expect(r.message).toMatch(/No calendar app/);
  });

  it('does not claim success on an old build without the native method', async () => {
    (NativeModules as Record<string, unknown>).SystemControls = {};
    expect((await createCalendarEvent('x', '2026-10-24')).success).toBe(false);
  });
});
