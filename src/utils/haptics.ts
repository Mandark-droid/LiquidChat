import ReactNativeHapticFeedback, {
  HapticFeedbackTypes,
} from 'react-native-haptic-feedback';

const options = {
  enableVibrateFallback: true,
  ignoreAndroidSystemSettings: false,
};

export function triggerLightHaptic(): void {
  try {
    ReactNativeHapticFeedback.trigger(HapticFeedbackTypes.impactLight, options);
  } catch (error) {
    // Haptics not available
  }
}

export function triggerMediumHaptic(): void {
  try {
    ReactNativeHapticFeedback.trigger(HapticFeedbackTypes.impactMedium, options);
  } catch (error) {
    // Haptics not available
  }
}

export function triggerHeavyHaptic(): void {
  try {
    ReactNativeHapticFeedback.trigger(HapticFeedbackTypes.impactHeavy, options);
  } catch (error) {
    // Haptics not available
  }
}

export function triggerSuccessHaptic(): void {
  try {
    ReactNativeHapticFeedback.trigger(HapticFeedbackTypes.notificationSuccess, options);
  } catch (error) {
    // Haptics not available
  }
}

export function triggerErrorHaptic(): void {
  try {
    ReactNativeHapticFeedback.trigger(HapticFeedbackTypes.notificationError, options);
  } catch (error) {
    // Haptics not available
  }
}
