/** Minimal cactus-react-native double; tests inject scripted inference instead. */
export class CactusLM {
  constructor(_: unknown = {}) {}
  async download() {}
  async init() {}
  async complete() {
    return {
      success: true,
      response: '',
      totalTokens: 0,
      timeToFirstTokenMs: 0,
      totalTimeMs: 0,
      prefillTokens: 0,
      prefillTps: 0,
      decodeTokens: 0,
      decodeTps: 0,
    };
  }
  async reset() {}
  async destroy() {}
  async embed() {
    return { embedding: [0, 0, 0] };
  }
  async getModels() {
    return [];
  }
}
export class CactusSTT {
  constructor(_: unknown = {}) {}
  async download() {}
  async init() {}
  async transcribe() {
    return { success: true, response: '' };
  }
  async destroy() {}
}
export const useCactusSTT = () => ({});
