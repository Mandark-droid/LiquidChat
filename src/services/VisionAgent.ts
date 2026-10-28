import type { CactusLM, CactusLMMessage } from 'cactus-react-native';

import { usageLedger } from '../observability/usageLedger';
import { modelLifecycle } from './ModelLifecycleManager';

class VisionAgent {
  private vlm: CactusLM | null = null;
  private model = 'lfm2-vl-450m';
  private initialized = false;
  private initializing = false;

  async init(model: string = 'lfm2-vl-450m'): Promise<void> {
    if (this.initialized || this.initializing) return;
    this.initializing = true;

    try {
      this.model = model;
      this.vlm = (await modelLifecycle.ensure(model)).instance;
      this.initialized = !!this.vlm;
    } finally {
      this.initializing = false;
    }
  }

  async destroy(): Promise<void> {
    if (this.vlm) {
      this.vlm = null;
      this.initialized = false;
      await modelLifecycle.release(this.model);
    }
  }

  async describeScreen(imagePath: string): Promise<string> {
    if (!this.initialized || !this.vlm) {
      await this.init();
    }

    const messages: CactusLMMessage[] = [
      {
        role: 'user',
        content:
          'Describe all UI elements visible on this screen, including their approximate positions (top, center, bottom) and types (button, text, input, icon). Be concise.',
        images: [imagePath],
      },
    ];

    const result = await this.vlm!.complete({
      messages,
      options: { temperature: 0.3, maxTokens: 512 },
    });
    modelLifecycle.recordCompletion(this.vlm, result);
    usageLedger.record('local', result.prefillTokens, result.decodeTokens);

    return result.response || '';
  }

  async seeAndAct(imagePath: string, userIntent: string): Promise<string> {
    if (!this.initialized || !this.vlm) {
      await this.init();
    }

    const messages: CactusLMMessage[] = [
      {
        role: 'user',
        content: `Look at this screen and help me: ${userIntent}\n\nDescribe what you see and which UI element I should interact with to accomplish this task. Include the element's text or description and its position.`,
        images: [imagePath],
      },
    ];

    const result = await this.vlm!.complete({
      messages,
      options: { temperature: 0.3, maxTokens: 512 },
    });
    modelLifecycle.recordCompletion(this.vlm, result);
    usageLedger.record('local', result.prefillTokens, result.decodeTokens);

    return result.response || '';
  }

  get isInitialized(): boolean {
    return this.initialized;
  }
}

export const visionAgent = new VisionAgent();
