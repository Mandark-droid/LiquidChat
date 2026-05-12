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

  /**
   * Generate a streamed answer from the VLM given the user's question and an
   * attached image. Strips "file://" prefix that image-picker emits on Android.
   */
  async answerWithImage(
    imagePath: string,
    userQuestion: string,
    onToken: (token: string) => void,
    systemPrompt?: string,
  ): Promise<{ response: string; tokens: number; ttftMs: number; totalMs: number }> {
    if (!this.initialized || !this.vlm) {
      console.log('[VisionAgent] answerWithImage: init() starting...');
      await this.init();
      console.log(`[VisionAgent] answerWithImage: init done, hasVlm=${!!this.vlm}`);
    }

    let resolvedPath = imagePath;
    if (resolvedPath.startsWith('file://')) {
      resolvedPath = resolvedPath.slice('file://'.length);
    }
    console.log(`[VisionAgent] answerWithImage: path="${resolvedPath}" q="${userQuestion.slice(0, 80)}"`);

    const messages: CactusLMMessage[] = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({
      role: 'user',
      content: userQuestion,
      images: [resolvedPath],
    });

    let fullResponse = '';
    let tokenCount = 0;
    const startMs = Date.now();
    let ttftMs = 0;

    const result = await this.vlm!.complete({
      messages,
      // confidenceThreshold: 0 disables Cactus's local-confidence cloud handoff.
      // This app is fully on-device; without this, low-confidence local outputs
      // are routed to a cloud API we don't configure, producing decode=0 errors.
      options: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        confidenceThreshold: 0,
        telemetryEnabled: false,
      },
      onToken: (token: string) => {
        tokenCount++;
        if (tokenCount === 1) ttftMs = Date.now() - startMs;
        fullResponse += token;
        onToken(token);
      },
    } as any);

    const totalMs = Date.now() - startMs;
    const finalText = (result.response || fullResponse || '').trim();
    console.log(
      `[VisionAgent] result: success=${result.success} response.len=${(result.response || '').length} ` +
      `prefill=${result.prefillTokens} decode=${result.decodeTokens} total=${result.totalTokens} ` +
      `ramMb=${result.ramUsageMb ?? '?'} cloudHandoff=${result.cloudHandoff ?? false}`
    );
    console.log(`[VisionAgent] answerWithImage done: streamed=${tokenCount} tokens, ${totalMs}ms, finalLen=${finalText.length}`);
    if (!finalText) {
      throw new Error(
        `VLM returned empty response (prefill=${result.prefillTokens}, decode=${result.decodeTokens})`
      );
    }
    return { response: finalText, tokens: result.totalTokens || tokenCount, ttftMs, totalMs };
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

    return result.response || '';
  }

  /**
   * Scene-grounded intent rewrite: expand deictic references in the user's utterance
   * ("this", "that", "it") against the visual scene so downstream routing and tool-
   * arg selection see a concrete, self-contained query.
   *
   * Returns `{ rewritten, scene }`. On any failure, `rewritten` equals the original
   * utterance — never blocks the chat flow.
   */
  async rewriteWithScene(
    imagePath: string,
    utterance: string,
  ): Promise<{ rewritten: string; scene: string }> {
    const original = utterance.trim();
    console.log(`[VisionAgent] rewrite start: path="${imagePath}" utterance="${original}"`);
    if (!original) return { rewritten: original, scene: '' };

    try {
      if (!this.initialized || !this.vlm) {
        console.log('[VisionAgent] init() starting...');
        await this.init();
        console.log(`[VisionAgent] init() done. initialized=${this.initialized} hasVlm=${!!this.vlm}`);
      }

      // image-picker on Android may return "file://" or "content://" URIs.
      // Cactus often expects a plain filesystem path — strip the "file://" prefix.
      let resolvedPath = imagePath;
      if (resolvedPath.startsWith('file://')) {
        resolvedPath = resolvedPath.slice('file://'.length);
      }
      console.log(`[VisionAgent] resolved image path: "${resolvedPath}"`);

      const messages: CactusLMMessage[] = [
        {
          role: 'user',
          content:
            'Rewrite the user\'s request so it is self-contained and unambiguous, ' +
            'resolving references like "this", "that", "it", "here", "the price" ' +
            'against what is visible in the image. Output ONLY the rewritten request ' +
            'on a single line, with no quotes, no preamble, no explanation.\n\n' +
            `User request: ${original}`,
          images: [resolvedPath],
        },
      ];

      console.log('[VisionAgent] calling vlm.complete()...');
      const result = await this.vlm!.complete({
        messages,
        options: { temperature: 0.2, maxTokens: 128 },
      });
      const raw = (result.response || '').trim();
      console.log(`[VisionAgent] vlm raw response (len=${raw.length}): "${raw.slice(0, 200)}"`);

      // Strip common preambles, surrounding quotes, and trailing punctuation noise
      const cleaned = raw
        .replace(/^["'`]+|["'`]+$/g, '')
        .replace(/^(rewritten[^:]*:|request[^:]*:|sure[,!\s]*|here[^:]*:)\s*/i, '')
        .split('\n')[0]
        .trim();

      // Sanity guards — fall back to original if rewrite is empty, identical, or
      // wildly longer than the original (likely the model ignored the instruction).
      if (!cleaned) {
        console.log('[VisionAgent] guard: cleaned empty -> fallback');
        return { rewritten: original, scene: '' };
      }
      if (cleaned.toLowerCase() === original.toLowerCase()) {
        console.log('[VisionAgent] guard: cleaned identical to original -> fallback');
        return { rewritten: original, scene: '' };
      }
      if (cleaned.length > Math.max(original.length * 6, 240)) {
        console.log(`[VisionAgent] guard: cleaned too long (${cleaned.length}) -> fallback`);
        return { rewritten: original, scene: '' };
      }

      console.log(`[VisionAgent] success rewrite: "${cleaned}"`);
      return { rewritten: cleaned, scene: '' };
    } catch (e) {
      const errMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      console.warn(`[VisionAgent] rewriteWithScene THREW: ${errMsg}`);
      return { rewritten: original, scene: '' };
    }
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

    return result.response || '';
  }

  get isInitialized(): boolean {
    return this.initialized;
  }
}

export const visionAgent = new VisionAgent();
