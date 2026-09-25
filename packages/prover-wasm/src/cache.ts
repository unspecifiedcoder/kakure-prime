/**
 * Caches a fetched artifact (typically the 7-30MB `.pk`) in the browser's Cache Storage (the
 * `caches` API), so a returning user doesn't re-download it on every visit. Cache Storage was
 * chosen over IndexedDB for this: it's designed exactly for "cache a Response by URL" and needs no
 * blob-to-ArrayBuffer ceremony -- `Cache.put`/`Cache.match` do that natively.
 */
export interface CachedFetchOptions {
  /** Cache Storage bucket name. Bump this if the artifacts a given URL serves ever change shape
   * incompatibly, to avoid serving a stale cached version. */
  readonly cacheName?: string;
}

const DEFAULT_CACHE_NAME = "kakure-prover-wasm-artifacts-v1";

/** Fetches `url`'s bytes, serving from Cache Storage on a hit and populating it on a miss. Falls
 * back to a plain (uncached) `fetch` when `caches` isn't available (Node/vitest, or a browser
 * context -- e.g. some private-browsing modes -- without Cache Storage), so callers can use this
 * unconditionally rather than feature-detecting themselves. */
export async function cachedFetchBytes(url: string | URL, opts: CachedFetchOptions = {}): Promise<Uint8Array> {
  const href = url.toString();
  const cacheStorage = (globalThis as unknown as { caches?: CacheStorage }).caches;
  if (!cacheStorage) {
    return fetchBytes(href);
  }
  const cache = await cacheStorage.open(opts.cacheName ?? DEFAULT_CACHE_NAME);
  const cached = await cache.match(href);
  if (cached) {
    return new Uint8Array(await cached.arrayBuffer());
  }
  const res = await fetch(href);
  if (!res.ok) {
    throw new Error(`cachedFetchBytes: ${href} -> HTTP ${res.status}`);
  }
  // Cache the response before consuming its body -- Response bodies are single-use streams.
  await cache.put(href, res.clone());
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchBytes(href: string): Promise<Uint8Array> {
  const res = await fetch(href);
  if (!res.ok) {
    throw new Error(`cachedFetchBytes: ${href} -> HTTP ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Clears one (or, with no argument, every) cached artifact bucket this module writes to. Exposed
 * for a "clear cache" debug/settings affordance, or test teardown. */
export async function clearArtifactCache(cacheName: string = DEFAULT_CACHE_NAME): Promise<void> {
  const cacheStorage = (globalThis as unknown as { caches?: CacheStorage }).caches;
  if (!cacheStorage) return;
  await cacheStorage.delete(cacheName);
}
