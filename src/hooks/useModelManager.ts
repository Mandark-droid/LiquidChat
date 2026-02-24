import { useState, useEffect, useCallback } from 'react';
import { modelLifecycle, type ManagedModel } from '../services/ModelLifecycleManager';
import type { DeviceProfile } from '../config/modelTiers';

export interface UseModelManagerReturn {
  loadedModels: ManagedModel[];
  allModels: ManagedModel[];
  totalRamMb: number;
  ramBudgetMb: number;
  deviceProfile: DeviceProfile | null;
  isInitialized: boolean;
}

export function useModelManager(): UseModelManagerReturn {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const unsubscribe = modelLifecycle.subscribe(() => {
      forceUpdate(n => n + 1);
    });
    return unsubscribe;
  }, []);

  return {
    loadedModels: modelLifecycle.getLoadedModels(),
    allModels: modelLifecycle.getAllModels(),
    totalRamMb: modelLifecycle.getTotalLoadedRamMb(),
    ramBudgetMb: modelLifecycle.getRamBudgetMb(),
    deviceProfile: modelLifecycle.getDeviceProfile(),
    isInitialized: modelLifecycle.initialized,
  };
}
