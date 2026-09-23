import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync('lib/supabaseAdmin.ts', 'utf8');
const middleware = readFileSync('middleware.ts', 'utf8');

test('server Supabase reads bypass the Next fetch cache', () => {
  assert.match(source, /global:\s*\{[\s\S]*fetch:\s*\(input, init\)\s*=>\s*fetch\(input,\s*\{\s*\.\.\.init,\s*cache:\s*'no-store'\s*\}\)/);
});

test('authenticated API success and error responses are forced to private no-store', () => {
  assert.match(middleware, /pathname\.startsWith\('\/api\/'\)/);
  assert.match(middleware, /Cache-Control', 'private, no-store, no-cache, max-age=0, must-revalidate'/);
  assert.match(middleware, /Pragma', 'no-cache'/);
  assert.match(middleware, /Expires', '0'/);
});
