const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env.local');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

const csvPath = path.join(root, 'data', 'region_mapping_candidates.csv');
const dryRun = process.argv.includes('--dry-run');

let supabase = null;
if (!dryRun) {
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing required environment variables. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(1);
  }

  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line, index) => {
    const values = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];

      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    values.push(current.trim());

    if (values.length !== header.length) {
      throw new Error(`CSV parse error on line ${index + 2}: expected ${header.length} columns, got ${values.length}`);
    }

    return header.reduce((obj, key, i) => {
      obj[key] = values[i];
      return obj;
    }, {});
  });
}

function normalizeBoolean(value) {
  return String(value).toLowerCase() === 'true';
}

function buildRegion(row) {
  const region_code = row.proposed_region_code?.trim();
  const sido = row.sido?.trim();
  const sigungu = row.sigungu?.trim();
  const region_type = row.source_region_type?.trim();
  const is_head_office = normalizeBoolean(row.is_head_office);
  const display_name = sigungu === '본청' ? `${sido} 본청` : `${sido} ${sigungu}`;

  return { region_code, sido, sigungu, region_type, display_name, is_head_office };
}

function validateRows(rows) {
  const errors = [];
  const codes = new Set();
  let headOfficeCount = 0;
  let nonHeadOfficeCount = 0;
  let reviewOrErrorCount = 0;

  rows.forEach((row, index) => {
    const line = index + 2;
    const regionCode = row.proposed_region_code?.trim();
    if (!regionCode) {
      errors.push(`Line ${line}: missing proposed_region_code`);
    }
    if (!row.sido) {
      errors.push(`Line ${line}: missing sido`);
    }
    if (!row.sigungu) {
      errors.push(`Line ${line}: missing sigungu`);
    }
    if (!row.source_region_type) {
      errors.push(`Line ${line}: missing source_region_type`);
    }
    if (!row.mapping_status || !['READY', 'HEAD_OFFICE'].includes(row.mapping_status)) {
      if (row.mapping_status === 'REVIEW' || row.mapping_status === 'ERROR') {
        reviewOrErrorCount += 1;
      } else {
        errors.push(`Line ${line}: unexpected mapping_status '${row.mapping_status}'`);
      }
    }
    if (regionCode) {
      if (codes.has(regionCode)) {
        errors.push(`Duplicate region_code on line ${line}: ${regionCode}`);
      }
      codes.add(regionCode);
    }
    if (row.sigungu === '본청') {
      headOfficeCount += 1;
    } else {
      nonHeadOfficeCount += 1;
    }
  });

  return {
    errors,
    total: rows.length,
    headOfficeCount,
    nonHeadOfficeCount,
    reviewOrErrorCount,
    duplicates: rows.length - codes.size,
  };
}

async function run() {
  const dryRun = process.argv.includes('--dry-run');
  const csvText = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsv(csvText);

  const validation = validateRows(rows);
  const sample = rows.slice(0, 10).map((row) => ({
    region_code: row.proposed_region_code,
    sido: row.sido,
    sigungu: row.sigungu,
    region_type: row.source_region_type,
    display_name: row.sigungu === '본청' ? `${row.sido} 본청` : `${row.sido} ${row.sigungu}`,
    is_head_office: normalizeBoolean(row.is_head_office),
    mapping_status: row.mapping_status,
  }));

  console.log('Dry run:', dryRun);
  console.log('Total rows:', validation.total);
  console.log('Head office rows:', validation.headOfficeCount);
  console.log('Non-head office rows:', validation.nonHeadOfficeCount);
  console.log('Duplicate region_code count:', validation.duplicates);
  console.log('Review/Error count:', validation.reviewOrErrorCount);
  console.log('Sample rows:', sample);

  if (validation.errors.length > 0) {
    console.error('Validation errors:');
    validation.errors.forEach((err) => console.error(`  - ${err}`));
    process.exit(1);
  }

  if (validation.reviewOrErrorCount > 0) {
    console.error('Found rows with mapping_status REVIEW or ERROR. Aborting.');
    process.exit(1);
  }

  if (dryRun) {
    console.log('Dry run complete. No changes were made.');
    return;
  }

  const regions = rows.map((row) => buildRegion(row));
  const { data, error } = await supabase.from('regions').upsert(regions, {
    onConflict: 'region_code',
    ignoreDuplicates: false,
  });

  if (error) {
    console.error('Supabase upsert error:', error);
    process.exit(1);
  }

  const upsertedCount = Array.isArray(data) ? data.length : regions.length;
  console.log(`Upserted ${upsertedCount} region records (by attempt).`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
