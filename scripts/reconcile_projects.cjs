const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env.local');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

const jsonPath = path.join(root, 'data', 'fund_projects_raw.json');
const reconciliationPath = path.join(root, 'data', 'project_reconciliation.json');
const missingPath = path.join(root, 'data', 'missing_projects.json');

function loadSourceCodes() {
  const rawText = fs.readFileSync(jsonPath, 'utf8');
  const rows = JSON.parse(rawText);
  const sourceCodes = [];
  const duplicates = [];
  const seen = new Set();

  rows.forEach((row) => {
    const code = row.id?.trim() ?? null;
    if (code) {
      sourceCodes.push(code);
      if (seen.has(code)) {
        duplicates.push(code);
      } else {
        seen.add(code);
      }
    }
  });

  return { rows, sourceCodes, sourceUniqueCodes: Array.from(seen), sourceDuplicates: Array.from(new Set(duplicates)) };
}

async function loadDbCodes(supabase) {
  const pageSize = 1000;
  let offset = 0;
  let dbCodes = [];

  while (true) {
    const from = offset;
    const to = offset + pageSize - 1;
    const { data, error, count, status } = await supabase
      .from('projects')
      .select('project_code', { count: 'exact' })
      .range(from, to);

    if (error) {
      throw new Error(`Failed to query projects: ${error.message || JSON.stringify(error)}`);
    }

    if (!Array.isArray(data)) {
      throw new Error('Unexpected Supabase response while querying projects.');
    }

    const batchCodes = data.map((row) => row.project_code?.trim()).filter(Boolean);
    dbCodes = dbCodes.concat(batchCodes);

    console.log(`Fetched DB batch ${from}-${to}: ${data.length} rows, ${batchCodes.length} project_code values`);

    if (data.length < pageSize) {
      break;
    }

    offset += pageSize;
  }

  const duplicates = [];
  const seen = new Set();
  dbCodes.forEach((code) => {
    if (seen.has(code)) {
      duplicates.push(code);
    } else {
      seen.add(code);
    }
  });

  return { dbCodes, dbUniqueCodes: Array.from(seen), dbDuplicates: Array.from(new Set(duplicates)) };
}

function summarizeMissing(missingRows) {
  const byYear = {};
  const byRegion = {};

  missingRows.forEach((row) => {
    const year = row.yr ?? 'unknown';
    byYear[year] = (byYear[year] || 0) + 1;
    const regionCode = row.id?.trim()?.split('-').slice(0, 2).join('-') ?? 'unknown';
    byRegion[regionCode] = (byRegion[regionCode] || 0) + 1;
  });

  return { byYear, byRegion };
}

function analyzeContinuity(codes) {
  const sorted = codes.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const gaps = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const current = sorted[i];
    if (prev === current) continue;
    const [pYear, pFirst, pSecond] = prev.split('-').map((segment) => parseInt(segment, 10));
    const [cYear, cFirst, cSecond] = current.split('-').map((segment) => parseInt(segment, 10));
    if (Number.isNaN(pYear) || Number.isNaN(cYear)) {
      gaps.push({ prev, current });
      continue;
    }
    if (pYear !== cYear || pFirst !== cFirst) {
      gaps.push({ prev, current });
    }
  }
  return { sorted, gaps, isContinuous: gaps.length === 0 };
}

async function run() {
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing required environment variables. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.');
    process.exit(1);
  }

  const { rows, sourceCodes, sourceUniqueCodes, sourceDuplicates } = loadSourceCodes();
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { dbCodes, dbUniqueCodes, dbDuplicates } = await loadDbCodes(supabase);

  const sourceSet = new Set(sourceUniqueCodes);
  const dbSet = new Set(dbUniqueCodes);
  const missingFromDb = sourceUniqueCodes.filter((code) => !dbSet.has(code));
  const extraInDb = dbUniqueCodes.filter((code) => !sourceSet.has(code));

  const missingRows = rows.filter((row) => missingFromDb.includes(row.id?.trim()));

  const summary = {
    sourceCount: sourceCodes.length,
    sourceUniqueCount: sourceUniqueCodes.length,
    dbCount: dbCodes.length,
    dbUniqueCount: dbUniqueCodes.length,
    missingCount: missingFromDb.length,
    extraCount: extraInDb.length,
    sourceDuplicateCount: sourceDuplicates.length,
    dbDuplicateCount: dbDuplicates.length,
    missingProjectCodes: missingFromDb,
    extraProjectCodes: extraInDb,
    sourceDuplicates,
    dbDuplicates,
    missingSummary: summarizeMissing(missingRows),
    continuity: analyzeContinuity(missingFromDb),
  };

  fs.writeFileSync(reconciliationPath, JSON.stringify(summary, null, 2), 'utf8');
  fs.writeFileSync(missingPath, JSON.stringify(missingRows, null, 2), 'utf8');

  console.log('Reconciliation complete. Output files generated:');
  console.log(`  ${reconciliationPath}`);
  console.log(`  ${missingPath}`);
  console.log(`Summary:`);
  console.log(`  source project_code count: ${summary.sourceCount}`);
  console.log(`  db project_code count: ${summary.dbCount}`);
  console.log(`  missing project_code count: ${summary.missingCount}`);
  console.log(`  db-only project_code count: ${summary.extraCount}`);
  console.log(`  missing project_code list: ${summary.missingProjectCodes.join(', ')}`);
  console.log(`  missing project year counts: ${JSON.stringify(summary.missingSummary.byYear, null, 2)}`);
  console.log(`  missing project region counts: ${JSON.stringify(summary.missingSummary.byRegion, null, 2)}`);
  console.log(`  continuous missing range: ${summary.continuity.isContinuous}`);
  if (!summary.continuity.isContinuous) {
    console.log(`  missing gaps: ${JSON.stringify(summary.continuity.gaps.slice(0, 20), null, 2)}`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
