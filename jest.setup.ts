/* Global test doubles for native modules. */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('react-native-device-info', () => ({ getTotalMemory: async () => 8 * 1024 ** 3 }));
jest.mock('react-native-haptic-feedback', () => ({ trigger: () => {}, HapticFeedbackTypes: {} }));
jest.mock('react-native-tts', () => ({
  speak: () => {},
  stop: async () => {},
  setDefaultRate: async () => {},
  setDefaultLanguage: async () => {},
  setDefaultPitch: async () => {},
}));
jest.mock('react-native-torch', () => ({ switchState: () => {} }), { virtual: true });
