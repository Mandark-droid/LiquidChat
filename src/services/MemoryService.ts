import * as RNFS from '@dr.pogodin/react-native-fs';
import { VectorStore } from './VectorStore';
import { modelLifecycle, type ManagedModel } from './ModelLifecycleManager';
import type { MemoryResult, DocumentResult } from '../types';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function chunkText(text: string, maxChars: number = 500, overlap: number = 50): string[] {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (current.length + trimmed.length + 1 > maxChars && current.length > 0) {
      chunks.push(current.trim());
      // Keep overlap from the end of current chunk
      const overlapText = current.slice(-overlap);
      current = overlapText + ' ' + trimmed;
    } else {
      current = current ? current + '\n\n' + trimmed : trimmed;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  // If no paragraphs found, chunk by character limit
  if (chunks.length === 0 && text.trim()) {
    const words = text.trim().split(/\s+/);
    current = '';
    for (const word of words) {
      if (current.length + word.length + 1 > maxChars && current.length > 0) {
        chunks.push(current.trim());
        const overlapText = current.slice(-overlap);
        current = overlapText + ' ' + word;
      } else {
        current = current ? current + ' ' + word : word;
      }
    }
    if (current.trim()) {
      chunks.push(current.trim());
    }
  }

  return chunks;
}

class MemoryService {
  private memoryStore: VectorStore;
  private documentStore: VectorStore;
  private managedModel: ManagedModel | null = null;
  private initialized = false;
  private initializing = false;
  private modelSlug = 'qwen3-embedding-0.6b';

  constructor() {
    this.memoryStore = new VectorStore('memory');
    this.documentStore = new VectorStore('documents');
  }

  async init(model?: string): Promise<void> {
    if (this.initialized || this.initializing) return;
    this.initializing = true;

    try {
      if (model) this.modelSlug = model;

      // Load persisted vector stores
      await Promise.all([
        this.memoryStore.load(),
        this.documentStore.load(),
      ]);

      // Use ModelLifecycleManager for robust download + native fallback support
      if (!modelLifecycle.initialized) await modelLifecycle.init();
      this.managedModel = await modelLifecycle.ensure(this.modelSlug);

      this.initialized = true;
      console.log('[MemoryService] Initialized successfully');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[MemoryService] Init unavailable: ${msg}`);
      this.managedModel = null;
      throw e;
    } finally {
      this.initializing = false;
    }
  }

  async destroy(): Promise<void> {
    try {
      // Flush pending saves
      await Promise.all([
        this.memoryStore.save(),
        this.documentStore.save(),
      ]);
      // ModelLifecycleManager owns the model instance — don't destroy it here
      this.managedModel = null;
    } catch (e) {
      console.warn('[MemoryService] Destroy error:', e);
    }
    this.initialized = false;
  }

  private async ensureInit(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
  }

  private async embed(text: string): Promise<number[]> {
    if (!this.managedModel?.instance) {
      throw new Error('Embedding model not initialized');
    }
    const result = await this.managedModel.instance.embed({ text });
    return result.embedding;
  }

  // === Memory (auto-remember interactions) ===

  async remember(text: string, metadata?: Record<string, any>): Promise<string> {
    await this.ensureInit();
    const id = generateId();
    const embedding = await this.embed(text);
    await this.memoryStore.add(id, text, embedding, metadata);
    return id;
  }

  async recall(query: string, topK: number = 3): Promise<MemoryResult[]> {
    await this.ensureInit();
    const embedding = await this.embed(query);
    const results = await this.memoryStore.query(embedding, topK, 0.0);
    return results.map(r => ({
      id: r.id,
      text: r.text,
      score: r.score,
      metadata: r.metadata,
      createdAt: r.createdAt,
    }));
  }

  async forget(id: string): Promise<void> {
    this.memoryStore.remove(id);
  }

  async clearMemory(): Promise<void> {
    this.memoryStore.clear();
    await this.memoryStore.save();
  }

  // === Documents (RAG corpus) ===

  async addDocument(filePath: string): Promise<number> {
    await this.ensureInit();

    const exists = await RNFS.exists(filePath);
    if (!exists) {
      throw new Error(`File not found: ${filePath}`);
    }

    const content = await RNFS.readFile(filePath, 'utf8');
    const fileName = filePath.split('/').pop() || filePath;
    const docId = generateId();
    const chunks = chunkText(content);

    for (let i = 0; i < chunks.length; i++) {
      const chunkId = `${docId}_chunk_${i}`;
      const embedding = await this.embed(chunks[i]);
      await this.documentStore.add(chunkId, chunks[i], embedding, {
        docId,
        sourceFile: fileName,
        chunkIndex: i,
        totalChunks: chunks.length,
      });
    }

    return chunks.length;
  }

  async removeDocument(docId: string): Promise<void> {
    const all = this.documentStore.getAll();
    for (const entry of all) {
      if (entry.metadata?.docId === docId) {
        this.documentStore.remove(entry.id);
      }
    }
    await this.documentStore.save();
  }

  async queryDocuments(query: string, topK: number = 3): Promise<DocumentResult[]> {
    await this.ensureInit();
    const embedding = await this.embed(query);
    const results = await this.documentStore.query(embedding, topK, 0.0);
    return results.map(r => ({
      id: r.id,
      text: r.text,
      score: r.score,
      metadata: r.metadata,
      createdAt: r.createdAt,
      sourceFile: r.metadata?.sourceFile || 'unknown',
      chunkIndex: r.metadata?.chunkIndex ?? 0,
    }));
  }

  async clearDocuments(): Promise<void> {
    this.documentStore.clear();
    await this.documentStore.save();
  }

  // === Stats ===

  getStats(): { memoryCount: number; documentCount: number; documentFiles: string[] } {
    const docEntries = this.documentStore.getAll();
    const fileSet = new Set<string>();
    for (const entry of docEntries) {
      if (entry.metadata?.sourceFile) {
        fileSet.add(entry.metadata.sourceFile);
      }
    }

    return {
      memoryCount: this.memoryStore.count,
      documentCount: this.documentStore.count,
      documentFiles: Array.from(fileSet),
    };
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  get isInitializing(): boolean {
    return this.initializing;
  }
}

export const memoryService = new MemoryService();
