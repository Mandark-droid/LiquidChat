import type { ToolResult } from '../types';

export async function takeScreenshot(): Promise<ToolResult> {
  return {
    success: false,
    message: 'Screenshot is not yet available. This feature requires MediaProjection API and will be added in a future update (Phase 4).',
  };
}
