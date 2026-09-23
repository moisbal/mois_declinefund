#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'test-automation', 'runner.mjs');

function makeRunId(offsetSeconds = 0) {
  const now = new Date(Date.now() + offsetSeconds * 1_000);
  const stamp = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(now).replace(/[-: ]/g, '');
  return `AUTO-INT-${stamp.slice(0, 8)}-${stamp.slice(8)}`;
}

function shiftedRunId(base, offsetSeconds) {
  const match = base.match(/^AUTO-INT-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!match) throw new Error('--run-id는 AUTO-INT-YYYYMMDD-HHMMSS 형식이어야 합니다.');
  const [, year, month, day, hour, minute, second] = match;
  const instant = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`);
  if (Number.isNaN(instant.getTime())) throw new Error('--run-id 날짜가 올바르지 않습니다.');
  const shifted = new Date(instant.getTime() + offsetSeconds * 1_000);
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(shifted).replace(/[-: ]/g, '');
  return `AUTO-INT-${parts.slice(0, 8)}-${parts.slice(8)}`;
}

function parseArgs(argv) {
  const args = { mode: '', runId: '', referenceRunId: '', baseUrl: '', sourceProjectId: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const value = argv[index + 1];
    if (item === '--mode') { args.mode = value; index += 1; }
    else if (item === '--run-id') { args.runId = value; index += 1; }
    else if (item === '--reference-run-id') { args.referenceRunId = value; index += 1; }
    else if (item === '--base-url') { args.baseUrl = value; index += 1; }
    else if (item === '--source-project-id') { args.sourceProjectId = value; index += 1; }
    else if (item === '...') throw new Error('`...`은 설명용 생략 표시이므로 명령에 입력하지 마세요. 필요한 실제 옵션만 입력하세요.');
    else throw new Error(`알 수 없는 인수: ${item}`);
  }
  if (!['read-only', 'mutate'].includes(args.mode)) throw new Error('--mode는 read-only 또는 mutate여야 합니다.');
  if (args.mode === 'read-only' && !args.referenceRunId) throw new Error('전체 조회 시험은 --reference-run-id <완료된 핵심 실행 ID>가 필요합니다.');
  return args;
}

const args = parseArgs(process.argv.slice(2));
const baseRunId = args.runId || makeRunId();
const tasks = args.mode === 'read-only'
  ? [
      { scenario: 'smoke', offset: 0 },
      { scenario: 'regression', offset: 1, referenceRunId: args.referenceRunId },
      { scenario: 'validation', offset: 2 },
      { scenario: 'coverage', offset: 3, referenceRunId: args.referenceRunId },
    ]
  : [
      { scenario: 'core', offset: 0 },
      { scenario: 'existing-transfer', offset: 1 },
      { scenario: 'split-funding-first', offset: 2 },
      { scenario: 'rejection-resubmit', offset: 3 },
      { scenario: 'project-metadata', offset: 4, referenceRunId: baseRunId },
      { scenario: 'small-category-lifecycle', offset: 5, referenceRunId: baseRunId },
      { scenario: 'native-execution', offset: 6, referenceRunId: baseRunId },
    ];

const failures = [];
for (const task of tasks) {
  const runId = shiftedRunId(baseRunId, task.offset);
  const runnerArgs = [RUNNER, '--mode', args.mode, '--scenario', task.scenario, '--headed', '--run-id', runId];
  if (args.mode === 'mutate') runnerArgs.push('--confirm-test-write');
  if (task.referenceRunId) runnerArgs.push('--reference-run-id', task.referenceRunId);
  if (args.baseUrl) runnerArgs.push('--base-url', args.baseUrl);
  if (args.sourceProjectId) runnerArgs.push('--source-project-id', args.sourceProjectId);
  process.stdout.write(`\n[전체 실행] ${task.scenario} · ${runId}\n`);
  const result = spawnSync(process.execPath, runnerArgs, { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) failures.push({ scenario: task.scenario, runId, exitCode: result.status });
}

if (failures.length > 0) {
  process.stderr.write(`\n[전체 실행 완료] 실패 ${failures.length}개 · 다른 독립 시나리오는 계속 실행했습니다.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('\n[전체 실행 완료] 모든 선택 시나리오가 통과했습니다.\n');
}
