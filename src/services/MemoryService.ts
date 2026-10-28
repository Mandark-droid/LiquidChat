import * as RNFS from '@dr.pogodin/react-native-fs';

import { getModelBySlug } from '../config/models';
import type { DocumentResult, MemoryResult } from '../types';
import { type ManagedModel, modelLifecycle } from './ModelLifecycleManager';
import { VectorStore } from './VectorStore';

// Cactus 1.7 slugs still present in saved settings; same weights, so stored vectors stay valid.
const RENAMED_EMBED_SLUGS: Record<string, string> = {
  'qwen3-0.6-embed': 'qwen3-embedding-0.6b',
};

export const MAX_CONVERSATIONS = 1500;
/** The embedding model is released after this long without use. */
export const EMBED_IDLE_MS = 20_000;
const MAX_PENDING = 50;

/** The embedding model would not fit next to the loaded chat models right now. */
export class EmbedderBusyError extends Error {
  constructor() {
    super('Not enough memory for the embedding model right now');
    this.name = 'EmbedderBusyError';
  }
}

export const MAX_DOCUMENT_CHUNKS = 3000;
/** One very long file must not crowd everything else out of the document store. */
export const MAX_CHUNKS_PER_DOCUMENT = 300;

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Splits text over `maxChars` at line breaks, then sentence ends, then spaces, then anywhere. */
function splitLong(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  for (const sep of [/\n/, /(?<=[.!?])\s+/, /\s+/]) {
    const parts = text.split(sep).filter(Boolean);
    if (parts.length < 2) continue;
    const out: string[] = [];
    let current = '';
    for (const part of parts) {
      if (current && current.length + part.length + 1 > maxChars) {
        out.push(current);
        current = '';
      }
      if (part.length > maxChars) out.push(...splitLong(part, maxChars));
      else current = current ? `${current} ${part}` : part;
    }
    if (current) out.push(current);
    return out;
  }
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) out.push(text.slice(i, i + maxChars));
  return out;
}

/**
 * Chunks of at most about `maxChars` (plus `overlap` carried from the previous chunk), on
 * paragraph boundaries where it can. A paragraph longer than that is split too: a meeting
 * transcript has no blank lines, and embedding it as one piece took gigabytes of native memory.
 */
export function chunkText(text: string, maxChars: number = 500, overlap: number = 50): string[] {
  const pieces = text
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean)
    .flatMap(p => splitLong(p, maxChars));
  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > maxChars) {
      chunks.push(current.trim());
      // Keep overlap from the end of current chunk
      current = `${current.slice(-overlap)} ${piece}`;
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current.trim()) chunks.push(current.trim());
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
    // ~10 KB per entry (1024-d embedding as JSON): about 15 MB and 30 MB at most.
    this.memoryStore = new VectorStore('memory', { maxEntries: MAX_CONVERSATIONS });
    this.documentStore = new VectorStore('documents', {
      maxEntries: MAX_DOCUMENT_CHUNKS,
      groupBy: e => e.metadata?.sourceFile,
    });
  }

  async init(model?: string): Promise<void> {
    if (this.initialized || this.initializing) return;
    this.initializing = true;

    try {
      if (model) {
        const slug = RENAMED_EMBED_SLUGS[model] ?? model;
        if (getModelBySlug(slug)) this.modelSlug = slug;
        else
          console.warn(
            `[MemoryService] Unknown embedding model "${model}", using ${this.modelSlug}`,
          );
      }

      await this.loadStores();
      // The embedding model loads on first use, only when it fits (see embed()).
      if (!modelLifecycle.initialized) await modelLifecycle.init();
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

  /** The saved vectors, without the embedding model (enough for counts and listing). */
  loadStores(): Promise<void> {
    return Promise.all([this.memoryStore.ensureLoaded(), this.documentStore.ensureLoaded()]).then(
      () => undefined,
    );
  }

  async destroy(): Promise<void> {
    try {
      // Flush pending saves
      await Promise.all([this.memoryStore.save(), this.documentStore.save()]);
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

  /**
   * Embeds with the model loaded on demand. It only loads when it fits in the RAM budget next to
   * the chat models (loading it anyway got the app killed by Android), and it is released after
   * EMBED_IDLE_MS without use.
   */
  private async embed(text: string): Promise<number[]> {
    if (!this.managedModel?.instance || modelLifecycle.getModelState(this.modelSlug) !== 'ready') {
      if (!modelLifecycle.fitsInBudget(this.modelSlug)) throw new EmbedderBusyError();
      this.managedModel = await modelLifecycle.ensure(this.modelSlug);
      this.flushPendingSoon();
    }
    if (!this.managedModel?.instance) throw new Error('Embedding model not initialized');
    this.scheduleRelease();
    const result = await this.managedModel.instance.embed({ text });
    return result.embedding;
  }

  private releaseTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleRelease(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      this.managedModel = null;
      modelLifecycle.release(this.modelSlug).catch(() => undefined);
    }, EMBED_IDLE_MS);
  }

  // Conversations to remember while the embedding model did not fit; embedded on its next load.
  private pending: { text: string; metadata?: Record<string, any> }[] = [];
  private flushing = false;

  private flushPendingSoon(): void {
    if (this.flushing || !this.pending.length) return;
    this.flushing = true;
    setTimeout(async () => {
      try {
        while (this.pending.length) {
          const p = this.pending[0];
          const embedding = await this.embed(p.text);
          await this.memoryStore.add(generateId(), p.text, embedding, p.metadata);
          this.pending.shift();
        }
      } catch {
        // Model gone again: the rest wait for the next load.
      } finally {
        this.flushing = false;
      }
    }, 0);
  }

  // === Memory (auto-remember interactions) ===

  async remember(text: string, metadata?: Record<string, any>): Promise<string> {
    await this.ensureInit();
    const id = generateId();
    try {
      const embedding = await this.embed(text);
      await this.memoryStore.add(id, text, embedding, metadata);
    } catch (e) {
      if (!(e instanceof EmbedderBusyError)) throw e;
      this.pending.push({ text, metadata });
      this.pending = this.pending.slice(-MAX_PENDING);
      return '';
    }
    return id;
  }

  async recall(query: string, topK: number = 3): Promise<MemoryResult[]> {
    await this.ensureInit();
    // Nothing stored: no reason to load a 750 MB model to search it.
    if (!this.memoryStore.count) return [];
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

  /**
   * Indexes a text file for retrieval. Indexing the same file name again replaces its earlier
   * chunks (a meeting re-indexed after new minutes), so nothing is duplicated.
   */
  async addDocument(filePath: string): Promise<number> {
    await this.ensureInit();

    const exists = await RNFS.exists(filePath);
    if (!exists) {
      throw new Error(`File not found: ${filePath}`);
    }

    const content = await RNFS.readFile(filePath, 'utf8');
    const fileName = filePath.split('/').pop() || filePath;
    const docId = generateId();
    const chunks = chunkText(content).slice(0, MAX_CHUNKS_PER_DOCUMENT);

    // Embed everything first: a failure halfway leaves the previous version in place.
    const embedded: { text: string; embedding: number[] }[] = [];
    for (const chunk of chunks) embedded.push({ text: chunk, embedding: await this.embed(chunk) });

    this.removeSource(fileName);
    for (let i = 0; i < embedded.length; i++) {
      await this.documentStore.add(`${docId}_chunk_${i}`, embedded[i].text, embedded[i].embedding, {
        docId,
        sourceFile: fileName,
        chunkIndex: i,
        totalChunks: embedded.length,
      });
    }

    return embedded.length;
  }

  /** Drops every chunk indexed from this file name. */
  removeSource(fileName: string): number {
    const stale = this.documentStore.getAll().filter(e => e.metadata?.sourceFile === fileName);
    for (const e of stale) this.documentStore.remove(e.id);
    return stale.length;
  }

  /** Whether chunks from this file name are indexed (without loading the embedding model). */
  async hasSource(fileName: string): Promise<boolean> {
    await this.loadStores();
    return this.documentStore.getAll().some(e => e.metadata?.sourceFile === fileName);
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
    if (!this.documentStore.count) return [];
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
