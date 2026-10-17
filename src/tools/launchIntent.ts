import { NativeModules } from 'react-native';

type Extras = Record<string, string | number | boolean>;

interface SystemControlsNative {
  launchIntent?: (
    action: string,
    data: string | null,
    type: string | null,
    extras: Extras | null,
  ) => Promise<boolean>;
}

/**
 * Starts another app's activity. Use instead of Linking.sendIntent, whose resolveActivity()
 * pre-check fails on Android 11+ for apps that exist, and which sends every extra as a string.
 */
export async function launchIntent(
  action: string,
  opts: { data?: string; type?: string; extras?: Extras } = {},
): Promise<void> {
  const native = NativeModules.SystemControls as SystemControlsNative | undefined;
  if (!native?.launchIntent) throw new Error('System controls are unavailable in this build');
  await native.launchIntent(action, opts.data ?? null, opts.type ?? null, opts.extras ?? null);
}
