/**
 * Fetches Lumi's published JSON (https://lumitrades.io/data/*.json) with a
 * short in-isolate cache. Stale data is served for a while if the origin is
 * briefly unreachable, so a paid call is never settled against missing data.
 */

export type DataFile = "coins" | "prices" | "signals" | "analysis" | "ideas" | "context" | "events" | "brief" | "institutional_brief";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = any;

const STALE_GRACE_MS = 15 * 60 * 1000;

export class DataSource {
  private cache = new Map<DataFile, { at: number; data: Json }>();
  private inflight = new Map<DataFile, Promise<Json>>();

  constructor(
    private baseUrl: string,
    private ttlMs: number,
    private fetcher: typeof fetch,
  ) {}

  async get(file: DataFile): Promise<Json> {
    const hit = this.cache.get(file);
    const now = Date.now();
    if (hit && now - hit.at < this.ttlMs) return hit.data;

    let p = this.inflight.get(file);
    if (!p) {
      p = this.load(file).finally(() => this.inflight.delete(file));
      this.inflight.set(file, p);
    }
    try {
      return await p;
    } catch (err) {
      if (hit && now - hit.at < STALE_GRACE_MS) return hit.data;
      throw err;
    }
  }

  async getMany<K extends DataFile>(files: K[]): Promise<Record<K, Json>> {
    const values = await Promise.all(files.map((f) => this.get(f)));
    return Object.fromEntries(files.map((f, i) => [f, values[i]])) as Record<K, Json>;
  }

  /** Like getMany, but files that fail to load come back as undefined (for optional inputs). */
  async getOptional<K extends DataFile>(files: K[]): Promise<Partial<Record<K, Json>>> {
    const values = await Promise.all(files.map((f) => this.get(f).catch(() => undefined)));
    return Object.fromEntries(files.map((f, i) => [f, values[i]])) as Partial<Record<K, Json>>;
  }

  private async load(file: DataFile): Promise<Json> {
    const res = await this.fetcher(`${this.baseUrl}/${file}.json`, {
      headers: { Accept: "application/json", "User-Agent": "lumi-api/0.2 (+https://lumitrades.io)" },
    });
    if (!res.ok) throw new Error(`upstream ${file}.json: HTTP ${res.status}`);
    const data = await res.json();
    this.cache.set(file, { at: Date.now(), data });
    return data;
  }
}

export class UpstreamError extends Error {}
