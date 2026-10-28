import * as RNFS from '@dr.pogodin/react-native-fs';
import { traceRetrieval } from '@traceverse/genai-otel-instrument-node/react-native';

export interface VectorEntry {
  id: string;
  text: string;
  embedding: number[];
  metadata?: Record<string, any>;
  createdAt: number;
  /** Last time a search returned it; drives eviction. */
  usedAt?: number;
}

export interface VectorStoreLimits {
  /** Most entries kept; the least recently used go first. */
  maxEntries: number;
  /** Evict whole groups (e.g. every chunk of one document) instead of single entries. */
  groupBy?: (e: VectorEntry) => string | undefined;
}

export interface SearchResult {
  id: string;
  text: string;
  score: number;
  metadata?: Record<string, any>;
  createdAt: number;
}

function chunkMetadata(m?: Record<string, any>): Record<string, string | number> | undefined {
  if (!m) return undefined;
  const out: Record<string, string | number> = {};
  if (m.sourceFile !== undefined) out.source = m.sourceFile;
  if (m.chunkIndex !== undefined) out.chunk = m.chunkIndex;
  return Object.keys(out).length ? out : undefined;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

export class VectorStore {
  private entries: VectorEntry[] = [];
  private name: string;
  private filePath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private loading: Promise<void> | null = null;

  constructor(
    name: string,
    private readonly limits?: VectorStoreLimits,
  ) {
    this.name = name;
    // App documents, not the cache: Android may clear the cache at any time.
    this.filePath = `${RNFS.DocumentDirectoryPath}/vectorstore_${name}.json`;
  }

  /** Loads once; later calls wait for the same load. */
  ensureLoaded(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  async load(): Promise<void> {
    try {
      const legacy = `${RNFS.CachesDirectoryPath}/vectorstore_${this.name}.json`;
      if (!(await RNFS.exists(this.filePath)) && (await RNFS.exists(legacy))) {
        await RNFS.moveFile(legacy, this.filePath);
      }
      const exists = await RNFS.exists(this.filePath);
      if (exists) {
        const raw = await RNFS.readFile(this.filePath, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          this.entries = data;
        }
      }
    } catch (e) {
      console.warn(`[VectorStore:${this.name}] Failed to load:`, e);
      this.entries = [];
    }
  }

  async save(): Promise<void> {
    try {
      const json = JSON.stringify(this.entries);
      await RNFS.writeFile(this.filePath, json, 'utf8');
      this.dirty = false;
    } catch (e) {
      console.warn(`[VectorStore:${this.name}] Failed to save:`, e);
    }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.save();
      this.saveTimer = null;
    }, 2000);
  }

  async add(
    id: string,
    text: string,
    embedding: number[],
    metadata?: Record<string, any>,
  ): Promise<void> {
    // Remove existing entry with same id
    this.entries = this.entries.filter(e => e.id !== id);
    this.entries.push({
      id,
      text,
      embedding,
      metadata,
      createdAt: Date.now(),
    });
    this.enforceLimit();
    this.scheduleSave();
  }

  /** Drops the least recently used entries (or groups) until the store is within its limit. */
  private enforceLimit(): void {
    const max = this.limits?.maxEntries;
    if (!max || this.entries.length <= max) return;
    const lastUse = (e: VectorEntry) => e.usedAt ?? e.createdAt;
    const groupOf = (e: VectorEntry) => this.limits?.groupBy?.(e) ?? `#${e.id}`;
    const groups = new Map<string, number>();
    for (const e of this.entries) {
      const g = groupOf(e);
      groups.set(g, Math.max(groups.get(g) ?? 0, lastUse(e)));
    }
    // The newest group is never evicted: it is what was just added.
    const order = [...groups.entries()].sort((a, b) => a[1] - b[1]).map(([g]) => g);
    const drop = new Set<string>();
    let count = this.entries.length;
    for (const g of order.slice(0, -1)) {
      if (count <= max) break;
      drop.add(g);
      count -= this.entries.filter(e => groupOf(e) === g).length;
    }
    if (drop.size) {
      this.entries = this.entries.filter(e => !drop.has(groupOf(e)));
      console.log(
        `[VectorStore:${this.name}] evicted ${drop.size} oldest item(s) to stay under ${max}`,
      );
    }
  }

  /** The closest entries, best first. `queryText` is recorded on the span (with content capture). */
  query(
    embedding: number[],
    topK: number = 5,
    threshold: number = 0.0,
    queryText?: string,
  ): Promise<SearchResult[]> {
    return traceRetrieval(
      this.name,
      {
        query: queryText,
        system: 'liquidchat.vectorstore',
        topK,
        attributes: {
          'gen_ai.embeddings.dimension.count': embedding.length,
          'liquidchat.vectorstore.entries': this.entries.length,
        },
        // Each chunk with its cosine similarity, the document it came from and its position there.
        documents: top =>
          top.map(r => ({
            id: r.id,
            score: r.score,
            content: r.text,
            metadata: chunkMetadata(r.metadata),
          })),
      },
      async () => this.search(embedding, topK, threshold),
    );
  }

  private search(embedding: number[], topK: number, threshold: number): SearchResult[] {
    const scored = this.entries.map(entry => ({
      id: entry.id,
      text: entry.text,
      score: cosineSimilarity(embedding, entry.embedding),
      metadata: entry.metadata,
      createdAt: entry.createdAt,
    }));

    const top = scored
      .filter(r => r.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    if (top.length) {
      const now = Date.now();
      const ids = new Set(top.map(r => r.id));
      for (const e of this.entries) if (ids.has(e.id)) e.usedAt = now;
      this.scheduleSave();
    }
    return top;
  }

  remove(id: string): void {
    this.entries = this.entries.filter(e => e.id !== id);
    this.scheduleSave();
  }

  clear(): void {
    this.entries = [];
    this.scheduleSave();
  }

  get count(): number {
    return this.entries.length;
  }

  getAll(): VectorEntry[] {
    return this.entries;
  }
}
