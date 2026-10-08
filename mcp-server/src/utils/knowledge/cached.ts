
import { knowledgeManager } from '../../server.js';
import { stripMutableKnowledgeMetadata, stripPublicKnowledgeMetadata } from './strip-metadata.js';

/**
 * Read cached knowledge for a player, with automatic fetching if not found.
 * Attempts to read from mutable knowledge store first, then fetches if needed.
 *
 * @param playerId - The player ID to read knowledge for
 * @param table - The table name in the knowledge database
 * @param fetch - Callback to fetch the knowledge if not found in cache
 * @param retainTurn - Preserve the saved row's turn in the returned knowledge
 * @returns The knowledge data, null if not found/not visible, or undefined when no player ID is provided
 */
export async function readPlayerKnowledge<T>
  (playerId: number | undefined, table: string, fetch: (playerId: number) => Promise<T | null>, retainTurn = false): Promise<(T & { Turn?: number }) | null | undefined> {
  if (playerId === undefined) return undefined;

  // First attempt to read from the mutable knowledge store
  const store = knowledgeManager.getStore();

  // Use getMutableKnowledge to read from the knowledge database
  // The key for player-specific knowledge is typically the playerId
  const cached = await store.getMutableKnowledge(
    table as any,
    playerId,
    undefined,
    async () => {
      // If not found in cache, fetch the data
      await fetch(playerId);
    }
  );

  const turn = retainTurn ? cached?.Turn : undefined;
  const stripped = stripMutableKnowledgeMetadata(cached as any) as (T & { Turn?: number }) | null;
  if (retainTurn && turn !== undefined && stripped) stripped.Turn = turn;

  // Return the cached data if found, otherwise null
  return stripped;
}

/**
 * Read cached public knowledge in batch, with automatic fetching if not found.
 * Attempts to read from mutable knowledge store first, then fetches if needed.
 *
 * @param table - The table name in the knowledge database
 * @param fetch - Callback to fetch the knowledge if not found in cache
 * @returns The knowledge data array or empty array if not found
 */
export async function readPublicKnowledgeBatch<T>
  (table: string, fetch: () => Promise<T[]>): Promise<T[]> {
  // First attempt to read from the mutable knowledge store
  const store = knowledgeManager.getStore();

  // Use getMutableKnowledgeBatch to read all entries from the knowledge database
  let cached = await store.getAllPublicKnowledge(
    table as any
  );

  if (cached.length === 0) return fetch();

  // Strip metadata from each cached entry
  cached = cached.map(item => stripPublicKnowledgeMetadata(item as any));

  // Return the cached data if found, otherwise empty array
  return cached as T[];
}
