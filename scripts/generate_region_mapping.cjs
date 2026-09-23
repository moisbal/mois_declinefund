const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const inputPath = path.join(root, 'data', 'fund_projects_raw.json');
const csvPath = path.join(root, 'data', 'region_mapping_candidates.csv');
const validationPath = path.join(root, 'data', 'region_mapping_validation.json');

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (text.includes('"') || text.includes(',') || text.includes('\n') || text.includes('\r')) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

function parseProjectRegionCode(projectId) {
  if (!projectId || typeof projectId !== 'string') return null;
  const parts = projectId.split('-');
  if (parts.length < 4) return null;
  const sido = parts[1];
  const sigungu = parts[2];
  if (!sido || !sigungu) return null;
  if (!/^\d+$/.test(sido) || !/^\d+$/.test(sigungu)) return null;
  return `${sido}-${sigungu}`;
}

function buildNotes(entry) {
  const notes = [];
  if (entry.codeErrors.size > 0) {
    notes.push(`invalid project IDs: ${[...entry.codeErrors].join(', ')}`);
  }
  if (entry.codes.size > 1) {
    notes.push(`multiple region codes: ${[...entry.codes].join(', ')}`);
  }
  if (entry.sourceRegionTypes.size > 1) {
    notes.push(`multiple source_region_type values: ${[...entry.sourceRegionTypes].join(', ')}`);
  }
  return notes.join(' | ');
}

function main() {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const rows = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const combos = new Map();
  const codeToRegions = new Map();

  rows.forEach((row) => {
    const sido = String(row.sido || '').trim();
    const sigungu = String(row.gungu || '').trim();
    const key = `${sido}||${sigungu}`;
    const code = parseProjectRegionCode(row.id);
    const sourceType = String(row.gubun || '').trim();

    if (!combos.has(key)) {
      combos.set(key, {
        sido,
        sigungu,
        projectCount: 0,
        sourceRegionTypes: new Set(),
        codes: new Set(),
        codeErrors: new Set(),
      });
    }

    const entry = combos.get(key);
    entry.projectCount += 1;
    if (sourceType) entry.sourceRegionTypes.add(sourceType);
    if (code) entry.codes.add(code);
    else entry.codeErrors.add(row.id);

    if (code) {
      if (!codeToRegions.has(code)) codeToRegions.set(code, new Set());
      codeToRegions.get(code).add(key);
    }
  });

  const rowsOut = [];
  const summary = {
    totalUniqueRegionCombos: combos.size,
    headOfficeCombos: 0,
    nonHeadOfficeCombos: 0,
    감소RegionCombos: 0,
    관심RegionCombos: 0,
    READY: 0,
    REVIEW: 0,
    ERROR: 0,
    sameRegionMultipleCodes: [],
    sameCodeMultipleRegionNames: [],
    sameRegionMultipleRegionTypes: [],
    basicRegionCountsBySido: {},
    projectCountsByRegion: {},
  };

  for (const [key, entry] of combos.entries()) {
    const isHeadOffice = entry.sigungu === '본청';
    if (isHeadOffice) summary.headOfficeCombos += 1;
    else summary.nonHeadOfficeCombos += 1;

    const sourceRegionType = [...entry.sourceRegionTypes].sort().join(',');
    if (entry.sourceRegionTypes.has('감소')) summary.감소RegionCombos += 1;
    if (entry.sourceRegionTypes.has('관심')) summary.관심RegionCombos += 1;

    const parsedCode = entry.codes.size === 1 ? [...entry.codes][0] : null;
    const codeConflict = entry.codes.size > 1;
    const typeConflict = entry.sourceRegionTypes.size > 1;
    const parseError = entry.codeErrors.size > 0;

    let mappingStatus = 'READY';
    if (isHeadOffice) mappingStatus = 'HEAD_OFFICE';
    else if (parseError || !parsedCode) mappingStatus = 'REVIEW';
    if (!isHeadOffice && (codeConflict || typeConflict)) mappingStatus = 'REVIEW';
    if (!isHeadOffice && !parsedCode && parseError) mappingStatus = 'ERROR';

    if (mappingStatus === 'ERROR' && parsedCode) {
      mappingStatus = 'REVIEW';
    }

    const notes = buildNotes(entry);
    const proposedRegionCode = parsedCode || '';
    const proposedDisplayName = `${entry.sido} ${entry.sigungu}`;

    rowsOut.push({
      sido: entry.sido,
      sigungu: entry.sigungu,
      source_region_type: sourceRegionType,
      project_count: entry.projectCount,
      is_head_office: isHeadOffice,
      proposed_region_code: proposedRegionCode,
      proposed_display_name: proposedDisplayName,
      mapping_status: mappingStatus,
      notes,
    });

    if (codeConflict) {
      summary.sameRegionMultipleCodes.push({
        sido: entry.sido,
        sigungu: entry.sigungu,
        codes: [...entry.codes].sort(),
      });
    }
    if (typeConflict) {
      summary.sameRegionMultipleRegionTypes.push({
        sido: entry.sido,
        sigungu: entry.sigungu,
        source_region_types: [...entry.sourceRegionTypes].sort(),
      });
    }

    summary.basicRegionCountsBySido[entry.sido] = (summary.basicRegionCountsBySido[entry.sido] || 0) + 1;
    summary.projectCountsByRegion[`${entry.sido}||${entry.sigungu}`] = entry.projectCount;

    summary[mappingStatus] = (summary[mappingStatus] || 0) + 1;
  }

  for (const [code, regionKeys] of codeToRegions.entries()) {
    if (regionKeys.size > 1) {
      summary.sameCodeMultipleRegionNames.push({
        proposed_region_code: code,
        regions: [...regionKeys].map((key) => {
          const [sido, sigungu] = key.split('||');
          return { sido, sigungu };
        }),
      });
    }
  }

  const header = [
    'sido',
    'sigungu',
    'source_region_type',
    'project_count',
    'is_head_office',
    'proposed_region_code',
    'proposed_display_name',
    'mapping_status',
    'notes',
  ];

  const csvLines = [header.join(',')].concat(
    rowsOut.map((row) =>
      header.map((col) => csvEscape(row[col])).join(',')
    )
  );

  fs.writeFileSync(csvPath, csvLines.join('\n'), 'utf8');
  fs.writeFileSync(validationPath, JSON.stringify(summary, null, 2), 'utf8');

  console.log('Generated:', csvPath);
  console.log('Generated:', validationPath);
  console.log('Unique region combos:', summary.totalUniqueRegionCombos);
  console.log('HEAD_OFFICE combos:', summary.headOfficeCombos);
  console.log('Non-HEAD_OFFICE combos:', summary.nonHeadOfficeCombos);
  console.log('READY count:', summary.READY || 0);
  console.log('REVIEW count:', summary.REVIEW || 0);
  console.log('ERROR count:', summary.ERROR || 0);
}

main();
