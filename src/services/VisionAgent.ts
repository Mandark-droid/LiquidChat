import { CactusLM, type CactusLMMessage } from 'cactus-react-native';

class VisionAgent {
  private vlm: CactusLM | null = null;
  private initialized = false;
  private initializing = false;

  async init(model: string = 'lfm2-vl-450m'): Promise<void> {
    if (this.initialized || this.initializing) return;
    this.initializing = true;

    try {
      const cactus = new CactusLM({ model });
      await cactus.download();
      await cactus.init();
      this.vlm = cactus;
      this.initialized = true;
    } finally {
      this.initializing = false;
    }
  }

  async destroy(): Promise<void> {
    if (this.vlm) {
      await this.vlm.destroy();
      this.vlm = null;
      this.initialized = false;
    }
  }

  async describeScreen(imagePath: string): Promise<string> {
    if (!this.initialized || !this.vlm) {
      await this.init();
    }

    const messages: CactusLMMessage[] = [
      {
        role: 'user',
        content: 'Describe all UI elements visible on this screen, including their approximate positions (top, center, bottom) and types (button, text, input, icon). Be concise.',
        images: [imagePath],
      },
    ];

    const result = await this.vlm!.complete({
      messages,
      options: { temperature: 0.3, maxTokens: 512 },
    });

    return result.text || '';
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

    return result.text || '';
  }

  get isInitialized(): boolean {
    return this.initialized;
  }
}

export const visionAgent = new VisionAgent();
