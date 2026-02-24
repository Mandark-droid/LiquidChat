import { useCallback, useRef } from 'react';
import { intentRouter, type RoutingResult } from '../services/IntentRouter';
import { modelLifecycle } from '../services/ModelLifecycleManager';

interface RouteAndLoadResult {
  routing: RoutingResult;
  modelSlug: string;
  swapped: boolean;
}

export function useIntentRouter() {
  const loadingRef = useRef(false);

  const routeAndLoad = useCallback(
    async (
      message: string,
      currentModelSlug: string,
      hasDocumentCorpus: boolean,
    ): Promise<RouteAndLoadResult> => {
      const routing = intentRouter.route(message, {
        currentModelSlug,
        hasDocumentCorpus,
      });

      console.log(
        `[IntentRouter] "${message.slice(0, 40)}..." -> ${routing.intent} (${routing.targetModelSlug}, ${routing.confidence})`,
      );

      // If target is already the current model, no swap needed
      if (routing.targetModelSlug === currentModelSlug) {
        return { routing, modelSlug: currentModelSlug, swapped: false };
      }

      // Try to load the target model
      if (!loadingRef.current) {
        loadingRef.current = true;
        try {
          const targetState = modelLifecycle.getModelState(routing.targetModelSlug);
          if (targetState === 'ready') {
            return { routing, modelSlug: routing.targetModelSlug, swapped: true };
          }

          // Attempt to load — if it fails, fall back to current
          await modelLifecycle.ensure(routing.targetModelSlug);
          return { routing, modelSlug: routing.targetModelSlug, swapped: true };
        } catch (e) {
          console.warn(
            `[IntentRouter] Failed to load ${routing.targetModelSlug}, staying on ${currentModelSlug}:`,
            e,
          );
          return { routing, modelSlug: currentModelSlug, swapped: false };
        } finally {
          loadingRef.current = false;
        }
      }

      // If already loading something, don't swap
      return { routing, modelSlug: currentModelSlug, swapped: false };
    },
    [],
  );

  return { routeAndLoad };
}
