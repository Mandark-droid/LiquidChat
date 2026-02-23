import DeviceInfo from 'react-native-device-info';
import { Platform } from 'react-native';

export interface DeviceMetrics {
  totalMemory: number;
  usedMemory: number;
  freeMemory: number;
  batteryLevel: number;
  isCharging: boolean;
  cpuArchitecture: string;
  deviceModel: string;
  systemVersion: string;
  totalDiskSpace: number;
  freeDiskSpace: number;
}

export async function getDeviceMetrics(): Promise<DeviceMetrics> {
  try {
    const [
      totalMemory,
      usedMemory,
      batteryLevel,
      isCharging,
      totalDiskSpace,
      freeDiskSpace,
    ] = await Promise.all([
      DeviceInfo.getTotalMemory(),
      DeviceInfo.getUsedMemory(),
      DeviceInfo.getBatteryLevel(),
      DeviceInfo.isBatteryCharging(),
      DeviceInfo.getTotalDiskCapacity(),
      DeviceInfo.getFreeDiskStorage(),
    ]);

    const freeMemory = totalMemory - usedMemory;

    return {
      totalMemory,
      usedMemory,
      freeMemory,
      batteryLevel,
      isCharging,
      cpuArchitecture: Platform.OS === 'ios' ? 'arm64' : (await DeviceInfo.supportedAbis())[0] || 'unknown',
      deviceModel: DeviceInfo.getModel(),
      systemVersion: DeviceInfo.getSystemVersion(),
      totalDiskSpace,
      freeDiskSpace,
    };
  } catch (error) {
    console.error('Error getting device metrics:', error);
    return {
      totalMemory: 0,
      usedMemory: 0,
      freeMemory: 0,
      batteryLevel: -1,
      isCharging: false,
      cpuArchitecture: 'unknown',
      deviceModel: 'unknown',
      systemVersion: 'unknown',
      totalDiskSpace: 0,
      freeDiskSpace: 0,
    };
  }
}

export function getThermalState(): string {
  return 'nominal';
}

export function formatMemorySize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(1)} ${units[i]}`;
}

export function getBatteryStatusText(level: number, isCharging: boolean): string {
  if (level < 0) return 'Unknown';
  const percentage = Math.round(level * 100);
  const status = isCharging ? ' (Charging)' : '';
  return `${percentage}%${status}`;
}

export function getCPUUsageText(): string {
  return 'N/A';
}
