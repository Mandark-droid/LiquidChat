import * as RNFS from '@dr.pogodin/react-native-fs';

export interface VectorEntry {
  id: string;
  text: string;
  embedding: number[];
  metadata?: Record<string, any>;
  createdAt: number;
}

export interface SearchResult {
  id: string;
  text: string;
  score: number;
  metadata?: Record<string, any>;
  createdAt: number;
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

  constructor(name: string) {
    this.name = name;
    this.filePath = `${RNFS.CachesDirectoryPath}/vectorstore_${name}.json`;
  }

  async load(): Promise<void> {
    try {
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
    this.scheduleSave();
  }

  async query(
    embedding: number[],
    topK: number = 5,
    threshold: number = 0.0,
  ): Promise<SearchResult[]> {
    const scored = this.entries.map(entry => ({
      id: entry.id,
      text: entry.text,
      score: cosineSimilarity(embedding, entry.embedding),
      metadata: entry.metadata,
      createdAt: entry.createdAt,
    }));

    return scored
      .filter(r => r.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
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
