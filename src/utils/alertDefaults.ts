import { Alert, Platform } from 'react-native';

// React Native's Android alerts default to non-cancelable, so Back and taps outside did
// nothing and a dialog without a Cancel button could not be closed at all.
if (Platform.OS === 'android') {
  const alert = Alert.alert.bind(Alert);
  Alert.alert = (title, message, buttons, options) =>
    alert(title, message, buttons, { cancelable: true, ...options });
}
