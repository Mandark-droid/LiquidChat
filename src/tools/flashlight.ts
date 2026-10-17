import { NativeModules } from 'react-native';

import type { ToolResult } from '../types';

interface TorchNative {
  switchState(on: boolean, ok: (v: boolean) => void, fail: (msg: string) => void): void;
}

// The new architecture no longer strips the "RCT" prefix, so react-native-torch's own
// JS (which reads NativeModules.Torch) gets null and fails silently.
const torch = (): TorchNative | null =>
  (NativeModules.RCTTorch as TorchNative | null) ?? (NativeModules.Torch as TorchNative | null);

function setTorch(on: boolean): Promise<void> {
  const native = torch();
  if (!native) return Promise.reject(new Error('Torch native module is not available'));
  return new Promise((resolve, reject) =>
    native.switchState(
      on,
      () => resolve(),
      msg => reject(new Error(String(msg))),
    ),
  );
}

async function switchTorch(on: boolean): Promise<ToolResult> {
  const label = on ? 'on' : 'off';
  try {
    await setTorch(on);
    return { success: true, message: `Flashlight turned ${label}` };
  } catch (error) {
    return {
      success: false,
      message: `Failed to turn ${label} flashlight: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export const turnOnFlashlight = () => switchTorch(true);
export const turnOffFlashlight = () => switchTorch(false);
