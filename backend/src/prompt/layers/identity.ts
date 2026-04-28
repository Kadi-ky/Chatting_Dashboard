import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * L1 — IDENTITY. Persona bible loaded from disk and cached in-process. Frozen
 * per account, versioned by file hash. Part of the cached prefix.
 *
 * Resolution order:
 *   1. personas/<accountId>/identity.md
 *   2. personas/default/identity.md
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const PERSONAS_ROOT = resolve(__dirname, "../../../personas");

interface CachedIdentity {
  content: string;
  loadedAt: number;
  source: string;
}

// In-memory cache — process-lifetime. Editing identity.md does NOT trigger
// a reload by itself (tsx watch only watches src/). Restart the worker to
// pick up persona changes. Tests can call __resetIdentityCacheForTests().
const cache = new Map<string, CachedIdentity>();

export function loadIdentityLayer(accountId: string): string {
  const cached = cache.get(accountId);
  if (cached) return cached.content;

  const candidates = [
    resolve(PERSONAS_ROOT, accountId, "identity.md"),
    resolve(PERSONAS_ROOT, "default", "identity.md"),
  ];

  for (const path of candidates) {
    try {
      const raw = readFileSync(path, "utf8").trim();
      cache.set(accountId, { content: raw, loadedAt: Date.now(), source: path });
      return raw;
    } catch {
      // try next candidate
    }
  }

  throw new Error(
    `No identity.md found for account ${accountId}. Tried: ${candidates.join(", ")}`,
  );
}

/** Test-only hook. */
export function clearIdentityCache(): void {
  cache.clear();
}
