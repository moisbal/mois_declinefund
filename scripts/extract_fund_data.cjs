const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const srcPath = path.join(root, 'data', 'source_dashboard.html');
const outJsonPath = path.join(root, 'data', 'fund_projects_raw.json');
const outCsvPath = path.join(root, 'data', 'fund_projects_raw.csv');
const validationPath = path.join(root, 'data', 'fund_data_validation.json');

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (text.includes('"') || text.includes(',') || text.includes('\n') || text.includes('\r')) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

function createValidationSummary(records, rawRows, errors) {
  const ids = records.map((r) => r.id);
  const duplicates = ids.filter((id, index) => id && ids.indexOf(id) !== index);
  const duplicateIds = [...new Set(duplicates)];
  const numericAlloc = records.filter((r) => typeof r.alloc === 'number' && !Number.isNaN(r.alloc)).length;
  const numericExec = records.filter((r) => typeof r.exec === 'number' && !Number.isNaN(r.exec)).length;

  return {
    sourceFile: srcPath,
    generatedAt: new Date().toISOString(),
    rawRowCount: rawRows.length,
    recordCount: records.length,
    uniqueIdCount: new Set(ids.filter(Boolean)).size,
    duplicateIdCount: duplicateIds.length,
    duplicateIds,
    numericAllocCount: numericAlloc,
    numericExecCount: numericExec,
    invalidRows: errors.length,
    errors,
    sampleRecord: records.slice(0, 3),
  };
}

function main() {
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Source HTML not found: ${srcPath}`);
  }

  const html = fs.readFileSync(srcPath, 'utf8');
  const match = html.match(/<script[^>]*id=["']fund-data["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) {
    throw new Error('Could not locate <script id="fund-data" type="application/json"> in source_dashboard.html');
  }

  const jsonText = match[1].trim();
  let raw;
  try {
    raw = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Failed to parse fund-data JSON: ${err.message}`);
  }

  if (!Array.isArray(raw)) {
    throw new Error('Expected fund-data JSON root to be an array');
  }

  const columns = [
    'id',
    'yr',
    'gubun',
    'sido',
    'gungu',
    'name1',
    'name2',
    'period',
    'alloc',
    'exec',
    'cat',
    'subcat',
  ];

  const records = [];
  const errors = [];

  raw.forEach((row, index) => {
    if (!Array.isArray(row)) {
      errors.push({ index, reason: 'Row is not an array' });
      return;
    }

    if (row.length !== columns.length) {
      errors.push({ index, reason: `Expected ${columns.length} columns but found ${row.length}` });
    }

    const record = columns.reduce((acc, key, colIndex) => {
      const value = row[colIndex];
      acc[key] = value === null ? null : value;
      return acc;
    }, {});

    record.alloc = Number(record.alloc);
    record.exec = Number(record.exec);

    if (!record.id || typeof record.id !== 'string') {
      errors.push({ index, field: 'id', reason: 'Missing or invalid id', value: record.id });
    }
    if (record.yr === null || record.yr === undefined || Number.isNaN(Number(record.yr))) {
      errors.push({ index, field: 'yr', reason: 'Missing or invalid year', value: record.yr });
    }
    if (Number.isNaN(record.alloc)) {
      errors.push({ index, field: 'alloc', reason: 'Invalid alloc value', value: row[8] });
    }
    if (Number.isNaN(record.exec)) {
      errors.push({ index, field: 'exec', reason: 'Invalid exec value', value: row[9] });
    }

    records.push(record);
  });

  const jsonOutput = JSON.stringify(records, null, 2);
  fs.writeFileSync(outJsonPath, jsonOutput, 'utf8');

  const csvRows = [columns.join(',')].concat(
    records.map((record) => columns.map((column) => csvEscape(record[column])).join(','))
  );
  fs.writeFileSync(outCsvPath, csvRows.join('\n'), 'utf8');

  const validation = createValidationSummary(records, raw, errors);
  fs.writeFileSync(validationPath, JSON.stringify(validation, null, 2), 'utf8');

  console.log('Extraction complete:');
  console.log(`  ${outJsonPath}`);
  console.log(`  ${outCsvPath}`);
  console.log(`  ${validationPath}`);
  if (errors.length) {
    console.warn(`Warning: ${errors.length} validation issue(s) found. Check ${validationPath}`);
    process.exitCode = 1;
  }
}

main();
