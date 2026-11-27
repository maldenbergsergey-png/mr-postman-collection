import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const root = fileURLToPath(new URL('.', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'run-groups.stage.json'), 'utf8'));
const selection = manifest.groups.publicSmoke;
if (!selection.length || selection.some((item) => item.method !== 'GET')) {
  throw new Error('Публичный smoke должен содержать только GET-запросы.');
}

const workingDirectory = mkdtempSync(join(tmpdir(), 'mr-postman-stage-'));
try {
  cpSync(join(root, 'collections', 'MR Group Automation'), join(workingDirectory, 'collection'), {
    recursive: true,
  });
  cpSync(join(root, 'environments', 'STAGE.environment.yaml'), join(workingDirectory, 'stage.environment.yaml'));

  const env = { ...process.env };
  delete env.POSTMAN_API_KEY;
  const args = [
    'collection', 'run', './collection', '-e', './stage.environment.yaml',
    '--env-var', 'baseUrl=https://stage-superapp.mr-group.ru/api',
    '--no-report-events', '--ignore-redirects', '--no-insecure-file-read',
    '--timeout-request', '12000', '--timeout', '90000', '-n', '1',
    ...selection.flatMap((item) => ['-i', item.selector]),
  ];
  const runner = spawn('postman', args, {
    cwd: workingDirectory,
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  let requests;
  let assertions;
  let summaryTimer;
  const runLimit = setTimeout(() => runner.kill('SIGKILL'), 105000);
  const lines = createInterface({ input: runner.stdout });
  lines.on('line', (line) => {
    console.log(line);
    const row = /[│|]\s*(requests|assertions)\s*[│|]\s*(\d+)\s*[│|]\s*(\d+)\s*[│|]/.exec(line);
    if (row?.[1] === 'requests') requests = row.slice(2).map(Number);
    if (row?.[1] === 'assertions') assertions = row.slice(2).map(Number);
    if (requests && assertions && line.includes('average response time:')) {
      clearTimeout(summaryTimer);
      summaryTimer = setTimeout(() => runner.kill(), 5000);
    }
  });

  try {
    await new Promise((resolve, reject) => {
      runner.once('error', reject);
      runner.once('close', resolve);
    });
  } finally {
    clearTimeout(runLimit);
    clearTimeout(summaryTimer);
  }
  const passed = requests?.[0] === selection.length && requests[1] === 0
    && assertions?.[0] > 0 && assertions[1] === 0;
  process.exitCode = passed ? 0 : 1;
} finally {
  rmSync(workingDirectory, { recursive: true, force: true });
}
