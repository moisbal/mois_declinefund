// Keep UUID-based PostgREST `in(...)` filters below the upstream request-line
// limit. A 1,000-UUID request is about 39 KB in TEST and is rejected with 400.
export const POSTGREST_IN_FILTER_CHUNK_SIZE = 200;

export function chunkPostgrestInValues<T>(
  values: readonly T[],
  chunkSize = POSTGREST_IN_FILTER_CHUNK_SIZE,
): T[][] {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error('PostgREST chunk size must be a positive safe integer.');
  }

  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}
