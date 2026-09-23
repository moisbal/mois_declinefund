const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env.local');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

const jsonPath = path.join(root, 'data', 'fund_projects_raw.json');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const useAll = args.includes('--all');
const limitArg = args.find((arg) => arg.startsWith('--limit='));

let limit = 10;
if (limitArg) {
  const value = parseInt(limitArg.split('=')[1], 10);
  if (!Number.isInteger(value) || value <= 0) {
    console.error('Invalid --limit value. Use a positive integer.');
    process.exit(1);
  }
  limit = value;
}

function parsePeriod(period) {
  if (!period || typeof period !== 'string') {
    return { start_year: null, end_year: null };
  }

  const normalized = period.trim();
  const rangeMatch = normalized.match(/^(\d{4})\s*~\s*(\d{4})$/);
  if (rangeMatch) {
    return {
      start_year: Number(rangeMatch[1]),
      end_year: Number(rangeMatch[2]),
    };
  }

  const singleMatch = normalized.match(/^(\d{4})$/);
  if (singleMatch) {
    const year = Number(singleMatch[1]);
    return { start_year: year, end_year: year };
  }

  return { start_year: null, end_year: null };
}

function parseRegionCode(projectId) {
  if (!projectId || typeof projectId !== 'string') return null;
  const parts = projectId.split('-');
  if (parts.length < 4) return null;
  const [ , second, third ] = parts;
  if (!second || !third) return null;
  return `${second}-${third}`;
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validateRows(rows) {
  const errors = [];
  const duplicateIds = new Set();
  const seenProjectIds = new Set();
  let amountErrors = 0;
  let regionMappingFailures = 0;

  rows.forEach((row, index) => {
    const line = index + 1;
    const projectId = row.id?.trim();
    const regionCode = parseRegionCode(projectId);
    const year = parseNumber(row.yr);
    const allocated = parseNumber(row.alloc);
    const executed = parseNumber(row.exec);
    const period = row.period?.trim();

    if (!projectId) {
      errors.push(`Row ${line}: missing project id`);
    }
    if (!regionCode) {
      errors.push(`Row ${line}: cannot parse region_code from project id '${row.id}'`);
    }
    if (!Number.isInteger(year)) {
      errors.push(`Row ${line}: invalid year '${row.yr}'`);
    }
    if (!row.sido) {
      errors.push(`Row ${line}: missing sido`);
    }
    if (!row.gungu) {
      errors.push(`Row ${line}: missing gungu`);
    }
    if (!row.name1) {
      errors.push(`Row ${line}: missing name1 (fund_project_name)`);
    }
    if (!row.name2) {
      errors.push(`Row ${line}: missing name2 (detail_project_name)`);
    }
    if (!period) {
      errors.push(`Row ${line}: missing period`);
    }
    if (!row.cat) {
      errors.push(`Row ${line}: missing cat (category)`);
    }
    if (!row.subcat) {
      errors.push(`Row ${line}: missing subcat (project_type)`);
    }
    if (projectId) {
      if (seenProjectIds.has(projectId)) {
        duplicateIds.add(projectId);
      }
      seenProjectIds.add(projectId);
    }

    if (allocated === null || allocated < 0) {
      errors.push(`Row ${line}: invalid allocated amount '${row.alloc}'`);
      amountErrors += 1;
    }
    if (executed === null || executed < 0) {
      errors.push(`Row ${line}: invalid executed amount '${row.exec}'`);
      amountErrors += 1;
    }
    if (allocated !== null && executed !== null && executed > allocated) {
      errors.push(`Row ${line}: executed_amount ${executed} is greater than allocated_amount ${allocated}`);
      amountErrors += 1;
    }
    if (!regionCode) {
      regionMappingFailures += 1;
    }
  });

  return {
    errors,
    duplicateCount: duplicateIds.size,
    amountErrorCount: amountErrors,
    regionMappingFailureCount: regionMappingFailures,
  };
}

function computeExecutionRate(alloc, exec) {
  if (alloc === null || exec === null) return null;
  if (alloc <= 0) return 0;
  return Number(((exec / alloc) * 100).toFixed(2));
}

function buildUpsertRecord(row, regionMap) {
  const projectId = row.id.trim();
  const regionCode = parseRegionCode(projectId);
  const region_id = regionMap[regionCode] || null;
  const year = parseNumber(row.yr);
  const alloc = parseNumber(row.alloc);
  const exec = parseNumber(row.exec);
  const period = row.period?.trim() || null;
  const dates = parsePeriod(period);
  const rate = computeExecutionRate(alloc, exec);
  const fundName = row.name1?.trim() || null;
  const detailName = row.name2?.trim() || null;

  return {
    project_id: projectId,
    project_code: projectId,
    region_id,
    year,
    region_type: row.gubun?.trim() || null,
    sido: row.sido?.trim() || null,
    sigungu: row.gungu?.trim() || null,
    project_name: detailName || fundName || null,
    fund_project_name: fundName,
    detail_project_name: detailName,
    period,
    project_period: period,
    project_type: row.subcat?.trim() || null,
    category: row.cat?.trim() || null,
    alloc,
    exec,
    rate,
    project_start_year: dates.start_year,
    project_end_year: dates.end_year,
  };
}

async function run() {
  if (!fs.existsSync(jsonPath)) {
    console.error(`Missing file: ${jsonPath}`);
    process.exit(1);
  }

  const rawText = fs.readFileSync(jsonPath, 'utf8');
  let rawRows;
  try {
    rawRows = JSON.parse(rawText);
  } catch (err) {
    console.error('Failed to parse data/fund_projects_raw.json:', err.message);
    process.exit(1);
  }

  const targetRows = useAll ? rawRows : rawRows.slice(0, limit);
  const effectiveLimit = useAll ? targetRows.length : limit;

  console.log(`Mode: ${dryRun ? 'dry-run' : 'live'}; target rows: ${targetRows.length}${useAll ? ' (all)' : ''}`);

  const validation = validateRows(targetRows);
  if (validation.duplicateCount > 0) {
    console.warn(`Duplicate project_code count: ${validation.duplicateCount}`);
  }

  const regionCodes = Array.from(
    new Set(
      targetRows
        .map((row) => parseRegionCode(row.id?.trim()))
        .filter(Boolean)
    )
  );

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let supabase = null;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing required environment variables. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.');
    process.exit(1);
  }

  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  let regionMap = {};
  if (regionCodes.length > 0) {
    const { data, error } = await supabase
      .from('regions')
      .select('id, region_code')
      .in('region_code', regionCodes);

    if (error) {
      console.error('Failed to query regions:', error.message || error);
      process.exit(1);
    }

    regionMap = (data || []).reduce((map, region) => {
      if (region.region_code) {
        map[region.region_code] = region.id;
      }
      return map;
    }, {});
  }

  const projects = targetRows.map((row) => buildUpsertRecord(row, regionMap));
  let regionMatchCount = 0;
  let regionFailCount = 0;

  projects.forEach((project) => {
    if (project.region_id) {
      regionMatchCount += 1;
    } else {
      regionFailCount += 1;
    }
  });

  let parseFailureCount = 0;
  const missingRequired = [];
  projects.forEach((project, index) => {
    const line = index + 1;
    const requiredFields = [
      'project_id',
      'project_code',
      'region_id',
      'year',
      'sido',
      'sigungu',
      'project_name',
      'fund_project_name',
      'detail_project_name',
      'project_period',
      'alloc',
      'exec',
      'rate',
    ];

    requiredFields.forEach((key) => {
      if (project[key] === null || project[key] === undefined || project[key] === '') {
        missingRequired.push(`Row ${line}: missing required field ${key}`);
      }
    });

    if (project.project_period && (project.start_year === null || project.end_year === null)) {
      parseFailureCount += 1;
    }
  });

  const firstProjectCode = targetRows[0]?.id ?? 'N/A';
  const lastProjectCode = targetRows[targetRows.length - 1]?.id ?? 'N/A';
  const summary = {
    targetCount: targetRows.length,
    regionMatchCount,
    regionFailCount,
    duplicateProjectCodeCount: validation.duplicateCount,
    amountIssueCount: validation.amountErrorCount,
    missingRequiredCount: missingRequired.length,
    parseFailureCount,
    firstProjectCode,
    lastProjectCode,
  };

  console.log(`Summary:`);
  console.log(`  dryRun: ${dryRun}`);
  console.log(`  target rows: ${summary.targetCount}`);
  console.log(`  first project_code: ${summary.firstProjectCode}`);
  console.log(`  last project_code: ${summary.lastProjectCode}`);
  console.log(`  region mapping success: ${summary.regionMatchCount}`);
  console.log(`  region mapping failure: ${summary.regionFailCount}`);
  console.log(`  duplicate project_code count: ${summary.duplicateProjectCodeCount}`);
  console.log(`  amount issue count: ${summary.amountIssueCount}`);
  console.log(`  missing required field count: ${summary.missingRequiredCount}`);
  console.log(`  project_period parse failure count: ${summary.parseFailureCount}`);

  if (validation.errors.length > 0 || missingRequired.length > 0) {
    console.error('\nValidation failed. No database writes will be performed.');
    validation.errors.forEach((err) => console.error(`  - ${err}`));
    missingRequired.forEach((err) => console.error(`  - ${err}`));
    process.exit(1);
  }

  if (regionFailCount > 0) {
    console.error('\nRegion mapping failed for one or more rows. No database writes will be performed.');
    process.exit(1);
  }

  if (dryRun) {
    console.log('\nDry run complete. No changes were made.');
    return;
  }

  const batchSize = 200;
  let totalUpserted = 0;

  for (let batchIndex = 0; batchIndex < projects.length; batchIndex += batchSize) {
    const batchNumber = Math.floor(batchIndex / batchSize) + 1;
    const batch = projects.slice(batchIndex, batchIndex + batchSize);
    const firstCode = batch[0]?.project_code ?? 'N/A';

    const { data, error } = await supabase
      .from('projects')
      .upsert(batch, {
        onConflict: 'project_code',
        ignoreDuplicates: false,
      })
      .select('id, project_id, project_code');

    if (error) {
      console.error(`\nBatch ${batchNumber} failed on first project_code ${firstCode}:`, error);
      process.exit(1);
    }

    if (!Array.isArray(data) || data.length === 0) {
      console.error(`\nBatch ${batchNumber} returned no data on first project_code ${firstCode}. Aborting.`);
      process.exit(1);
    }

    if (data.length !== batch.length) {
      console.error(`\nBatch ${batchNumber} returned ${data.length} records but ${batch.length} were sent. Aborting.`);
      process.exit(1);
    }

    totalUpserted += data.length;
    console.log(`Batch ${batchNumber}: upserted ${data.length} records; first project_code ${firstCode}`);
  }

  console.log(`\nTotal upserted records: ${totalUpserted}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
