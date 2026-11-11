import { spawn } from 'node:child_process';
import { isUtf8 } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join, posix, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { assembleTeam } from './council.mjs';
import { currentTeamName } from './public/team-names.js';

const maxPatchBytes = 8 * 1024 * 1024;
const maxPreviewBytes = 128 * 1024;
const agentTimeoutMs = 12 * 60 * 1000;
const terminal = new Set(['ready', 'failed', 'promoted']);

function gitEnvironment(extra = {}) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...environment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', ...extra };
}

function runProcess(file, args, options = {}) {
  const { input, signal, env, cwd, onOutput, rawStdout = false, maxBytes = maxPatchBytes, timeoutMs = 120_000 } = options;
  return new Promise((resolveProcess, reject) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const abortSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const child = spawn(file, args, { env, cwd, signal: abortSignal, killSignal: 'SIGKILL', stdio: ['pipe', 'pipe', 'pipe'] });
    let failed;
    child.once('error', (error) => { failed = error; });
    child.stdin.on('error', () => {});
    const chunks = { stdout: [], stderr: [] };
    let bytes = 0;
    for (const stream of ['stdout', 'stderr']) {
      const decoder = new StringDecoder('utf8');
      child[stream].on('data', (buffer) => {
        bytes += buffer.length;
        if (bytes > maxBytes) {
          failed ??= new Error(`Command output exceeded ${maxBytes} bytes.`);
          child.kill('SIGKILL');
          return;
        }
        chunks[stream].push(buffer);
        const output = decoder.write(buffer);
        if (output) onOutput?.(stream, output);
      });
      child[stream].once('end', () => {
        const output = decoder.end();
        if (output) onOutput?.(stream, output);
      });
    }
    child.once('close', (exitCode) => {
      if (failed) {
        if (timeout.aborted && !signal?.aborted) reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
        else reject(failed);
        return;
      }
      const stdout = Buffer.concat(chunks.stdout);
      resolveProcess({
        exitCode: exitCode ?? 1,
        stdout: rawStdout ? stdout : stdout.toString('utf8'),
        stderr: Buffer.concat(chunks.stderr).toString('utf8'),
      });
    });
    child.stdin.end(input);
  });
}

async function checked(file, args, options) {
  const result = await runProcess(file, args, options);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim().slice(-1800) || `${file} exited with code ${result.exitCode}.`);
  }
  return result.stdout;
}

function git(args, { index, ...options } = {}) {
  return checked('git', [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.quotePath=true',
    '-c', 'core.attributesFile=/dev/null',
    '-c', 'protocol.ext.allow=never',
    ...args,
  ], { ...options, env: gitEnvironment(index ? { GIT_INDEX_FILE: index } : {}) });
}

function repositorySource(repo) {
  if (isAbsolute(repo)) return realpathSync(repo);
  let url;
  try { url = new URL(repo); } catch { throw new Error('Select an absolute local repository path or an HTTPS clone URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Clone URLs must use HTTPS and omit credentials, query strings and fragments.');
  }
  return url.href;
}

async function createCheckpoint(config, checkpointDir, signal) {
  const source = repositorySource(config.repo);
  await git(['init', '--bare', '--template=', checkpointDir], { signal });
  const inCheckpoint = (args) => git(['--git-dir', checkpointDir, ...args], { signal });
  await inCheckpoint(['fetch', '--no-tags', '--depth=1', '--', source, config.repoRef]);
  const commit = (await inCheckpoint(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim();
  await inCheckpoint(['update-ref', 'refs/heads/checkpoint', commit]);
  await inCheckpoint(['symbolic-ref', 'HEAD', 'refs/heads/checkpoint']);
  return commit;
}

async function commitVerifiedTree(checkpointDir, run, branch) {
  return (await git([
    '--git-dir', checkpointDir,
    '-c', 'user.name=Matrix Swarm', '-c', 'user.email=swarm@localhost', 'commit-tree',
    branch.tree, '-p', run.baseCommit, '-m', `Matrix Swarm verified agent ${branch.id}`,
  ])).trim();
}

function treeEntries(output) {
  return output.split('\0').filter(Boolean).map(row => {
    const tab = row.indexOf('\t');
    const [mode, type, oid] = row.slice(0, tab).split(' ');
    return {
      name: row.slice(tab + 1), oid,
      type: type === 'tree' ? 'directory' : type === 'commit' ? 'submodule' : mode === '120000' ? 'symlink' : 'file',
    };
  });
}

async function readRepository(checkpointDir, revision, path) {
  const inCheckpoint = (args, options) => git(['--git-dir', checkpointDir, '--literal-pathspecs', ...args], {
    timeoutMs: 5000, ...options,
  });
  const entry = path
    ? treeEntries(await inCheckpoint(['ls-tree', '--full-tree', '-z', revision, '--', path]))
      .find(item => item.name === path)
    : { oid: revision, type: 'directory' };
  if (!entry) return null;
  if (entry.type === 'directory') {
    const entries = treeEntries(await inCheckpoint(['ls-tree', '-z', entry.oid]));
    return { type: entry.type, entries: entries.map(({ name, type }) => ({ name, type })) };
  }
  if (entry.type === 'submodule') return { type: entry.type, commit: entry.oid };
  const size = Number(await inCheckpoint(['cat-file', '-s', entry.oid]));
  if (size > maxPreviewBytes) return { type: entry.type, size, preview: 'too_large' };
  const bytes = await inCheckpoint(['cat-file', 'blob', entry.oid], { rawStdout: true, maxBytes: maxPreviewBytes });
  if (bytes.includes(0) || !isUtf8(bytes)) return { type: entry.type, size, preview: 'binary' };
  return { type: entry.type, size, content: bytes.toString('utf8') };
}

async function collectReviewSources(checkpointDir, revision, task, signal) {
  const output = await git(['--git-dir', checkpointDir, 'ls-tree', '-r', '-z', revision], {
    signal, timeoutMs: 8000,
  });
  const terms = new Set(task.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) || []);
  const sources = treeEntries(output).filter(entry => entry.type === 'file' &&
    /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|cs|cpp?|h|swift|php|vue|svelte|sh|sql|html|css)$/i.test(entry.name));
  function relevance(path) {
    const pieces = path.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) || [];
    return pieces.filter(term => terms.has(term)).length * 3 - Number(/(?:test|spec)[/.\-_]/i.test(path));
  }
  sources.sort((first, second) => relevance(second.name) - relevance(first.name) || first.name.localeCompare(second.name));
  const snippets = await Promise.all(sources.slice(0, 6).map(async ({ name }) => {
    const entry = await readRepository(checkpointDir, revision, name).catch(() => null);
    if (!entry?.content) return null;
    const lines = entry.content.slice(0, 2400).split(/\r?\n/).slice(0, 60).map(line => line.slice(0, 180));
    return { path: name, lines };
  }));
  return snippets.filter(Boolean);
}

function protectedFile(path, config) {
  const name = posix.basename(path);
  if (
    path.split('/').some((segment) => /^\.(?:git|gitmodules|gitattributes|github)$/i.test(segment) ||
      /^(?:tests?|specs?|__tests__|__mocks__|__snapshots__|fixtures|benchmarks?|e2e)$/i.test(segment)) ||
    /(?:[._-](?:test|spec)\.|^test[_-]|^conftest\.py$|^pytest\.ini$|^tox\.ini$|^\.npmrc$|^\.yarnrc(?:\.yml)?$|^(?:jest|vitest|playwright|cypress)\.config\.)/i.test(name)
  ) return true;

  const commands = [config.functionalCommand, config.securityCommand, config.benchmarkCommand].join('\n');
  if (/\b(?:npm|pnpm|yarn|bun)\b/.test(commands) && name === 'package.json') return true;
  if (/\bmake\b/.test(commands) && /^(?:gnumakefile|makefile)$/i.test(name)) return true;
  return config.protectedPaths.some((protectedPath) => path === protectedPath || path.startsWith(`${protectedPath}/`));
}

async function freezePatch(checkpointDir, runDir, branch, patch, signal) {
  if (typeof patch !== 'string' || Buffer.byteLength(patch) > maxPatchBytes) {
    throw new Error('The branch patch is missing or exceeds 8 MiB.');
  }
  const index = join(runDir, `index-${branch.id}`);
  const inIndex = (args, options) => git(['--git-dir', checkpointDir, ...args], { signal, index, ...options });
  try {
    await inIndex(['read-tree', 'HEAD']);
    if (patch) await inIndex(['apply', '--cached', '--binary', '-'], { input: patch });
    const paths = (await inIndex(['diff', '--cached', '--no-renames', '--name-only', '-z'])).split('\0').filter(Boolean);
    const raw = await inIndex(['diff', '--cached', '--no-renames', '--raw', '-z']);
    if (raw.split('\0').some((field, index) => index % 2 === 0 && /^:(?:160000 |[0-9]{6} 160000 )/.test(field))) {
      throw new Error('Changes to Git submodules are unsupported.');
    }
    const numstat = await inIndex(['diff', '--cached', '--no-renames', '--numstat', '-z']);
    const totals = numstat.split('\0').filter(Boolean).reduce((counts, line) => {
      const [added, removed] = line.split('\t');
      return { added: counts.added + (Number(added) || 0), removed: counts.removed + (Number(removed) || 0) };
    }, { added: 0, removed: 0 });
    const canonical = await inIndex(['diff', '--cached', '--binary', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv']);
    const tree = (await inIndex(['write-tree'])).trim();
    return { paths, patch: canonical, tree, ...totals };
  } finally {
    rmSync(index, { force: true });
  }
}

function docker(args, options) {
  return checked('docker', args, options);
}

export async function dockerStatus() {
  try {
    const version = (await docker(['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 7_000 })).trim();
    return { available: true, version };
  } catch {
    return { available: false, error: 'Start Docker to run swarms with local isolation.' };
  }
}

const shell = ['bash', '--noprofile', '--norc'];
const uid = '1000:1000';
const workspace = '/workspace';
const checkpoint = '/checkpoint';

function sandboxPath(path) {
  if (typeof path !== 'string' || !path || path.includes('\0') || posix.isAbsolute(path) ||
      posix.normalize(path) === '..' || posix.normalize(path).startsWith('../')) {
    throw new Error('File paths must be relative to the isolated workspace.');
  }
  return `./${posix.normalize(path)}`;
}

function createDockerRuntime() {
  let checkpointDir;
  const image = process.env.MATRIX_SANDBOX_IMAGE || 'node:22-bookworm';
  const sandboxFlags = [
    '--init', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '2g', '--cpus', '2',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=768m', '--env', 'HOME=/tmp', '--env', 'CI=true',
  ];
  const helperFlags = [
    ...sandboxFlags, '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE',
    '--env', 'GIT_CONFIG_COUNT=1', '--env', 'GIT_CONFIG_KEY_0=safe.directory', '--env', 'GIT_CONFIG_VALUE_0=/checkpoint',
  ];

  async function cleanup(args) {
    await docker(args, { timeoutMs: 30_000 }).catch(() => {});
  }

  async function sandbox(signal) {
    const id = `matrix-${randomUUID()}`;
    const setup = `${id}-setup`;
    const volume = `${id}-work`;
    const source = /[",]/.test(checkpointDir) ? `"source=${checkpointDir.replaceAll('"', '""')}"` : `source=${checkpointDir}`;
    const mount = ['--mount', `type=bind,${source},target=${checkpoint},readonly`];
    const mountWorkspace = ['--mount', `type=volume,source=${volume},target=${workspace}`];
    let stopped = false;
    const dispose = async () => {
      await cleanup(['rm', '--force', id]);
      await cleanup(['rm', '--force', setup]);
      await cleanup(['volume', 'rm', volume]);
    };
    try {
      await docker(['volume', 'create', volume], { signal });
      await docker([
        'run', '--rm', '--name', setup, ...helperFlags, '--network', 'none', ...mount, ...mountWorkspace,
        image, ...shell, '-ec', 'git -c core.hooksPath=/dev/null clone --quiet --no-local /checkpoint /workspace\n' +
          'chown -hR 1000:1000 /workspace',
      ], { signal });
      await docker([
        'run', '--detach', '--name', id, ...sandboxFlags, '--user', uid, '--network', 'none', ...mountWorkspace,
        image, 'sleep', 'infinity',
      ], { signal });
      return {
        id, volume, mount, dispose,
        async stop() {
          if (stopped) return;
          await docker(['stop', '--time', '1', id], { signal });
          stopped = true;
        },
      };
    } catch (error) {
      await dispose();
      throw error;
    }
  }

  function command(container, commandText, { log, signal, maxBytes = 1024 * 1024, seconds = 180 } = {}) {
    return runProcess('docker', [
      'exec', '--user', uid, '--workdir', workspace, container.id,
      'timeout', '--kill-after=3s', `${seconds}s`, ...shell, '-c', commandText,
    ], {
      signal, maxBytes, timeoutMs: (seconds + 5) * 1000,
      onOutput: log && ((stream, output) => log(output, stream === 'stderr' ? 'warn' : 'info', stream)),
    });
  }

  return {
    async prepare(context) {
      checkpointDir = context.checkpointDir;
      const status = await dockerStatus();
      if (!status.available) throw new Error(status.error);
      await docker(['image', 'inspect', image], { signal: context.signal }).catch(() => docker(
        ['pull', image], { signal: context.signal, timeoutMs: 300_000, onOutput: (stream, data) => context.log(data, 'info', stream) },
      ));
    },
    async fork({ log, signal }) {
      const container = await sandbox(signal);
      return {
        tools: {
          async exec(commandText) {
            if (typeof commandText !== 'string' || !commandText.trim()) throw new Error('A shell command is required.');
            log(`$ ${commandText}`);
            const result = await command(container, commandText, { log, signal });
            log(`Exited with code ${result.exitCode}`, result.exitCode ? 'warn' : 'info');
            return result;
          },
          async read(path) {
            log(`Read ${path}`);
            return docker(['exec', '--user', uid, '--workdir', workspace, container.id, 'cat', '--', sandboxPath(path)], { signal });
          },
          async write(path, content) {
            log(`Write ${path}`);
            await docker([
              'exec', '-i', '--user', uid, '--workdir', workspace, container.id, ...shell, '-c',
              'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'write', sandboxPath(path),
            ], { input: content, signal });
          },
        },
        inspect(commandText) {
          return command(container, commandText, { signal, seconds: 4, maxBytes: 24 * 1024 });
        },
        async snapshot() {
          await container.stop();
          const snapshotContainer = `${container.id}-snapshot`;
          // Use a new process with the candidate volume mounted read-only. Git metadata
          // lives in its own tmpfs, so a candidate's index, refs and config have no effect.
          try {
            const patch = await docker([
              'run', '--rm', '--name', snapshotContainer, ...helperFlags, '--network', 'none', ...container.mount,
              '--mount', `type=volume,source=${container.volume},target=${workspace},readonly`, image, ...shell, '-ec',
              'git -c safe.directory=/checkpoint clone --quiet --bare --no-local /checkpoint /tmp/trusted.git\n' +
              'export GIT_DIR=/tmp/trusted.git GIT_WORK_TREE=/workspace GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null\n' +
              'git read-tree HEAD\n' +
              'git -c core.hooksPath=/dev/null add --all\n' +
              'git diff --cached --binary --full-index --no-renames --no-ext-diff --no-textconv',
            ], { signal, timeoutMs: 90_000 });
            return { patch };
          } finally {
            await cleanup(['rm', '--force', snapshotContainer]);
          }
        },
        dispose: container.dispose,
      };
    },
    async verify({ patch, command: commandText, log, signal }) {
      const container = await sandbox(signal);
      try {
        if (patch) {
          await docker(['exec', '--user', uid, '--workdir', workspace, container.id, 'git', 'update-index', '--refresh'], { signal });
          await docker([
            'exec', '-i', '--user', uid, '--workdir', workspace, container.id, 'git', 'apply', '--index', '--binary', '-',
          ], { input: patch, signal });
        }
        return await command(container, commandText, { log, signal });
      } finally {
        await container.dispose();
      }
    },
  };
}

function textField(value, label, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) {
    throw new Error(`${label} is required and must be at most ${limit} characters.`);
  }
  return value.trim();
}

function configFor(input) {
  if (!input || typeof input !== 'object') throw new Error('Run configuration is required.');
  const agentCount = Number(input.agentCount ?? 3);
  if (!Number.isInteger(agentCount) || agentCount < 1 || agentCount > 8) throw new Error('Choose between 1 and 8 agents.');
  const repoRef = textField(input.repoRef || 'HEAD', 'Git ref', 255);
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(repoRef) || repoRef.includes('..')) throw new Error('Enter a valid Git ref or commit.');
  const protectedPaths = (input.protectedPaths ?? []).map((path) => sandboxPath(path).slice(2).replace(/\/$/, ''));
  return {
    repoId: input.repoId ?? null, repo: textField(input.repo, 'Repository', 4096), repoRef,
    task: textField(input.task, 'Task', 32_000), agentCount,
    functionalCommand: textField(input.functionalCommand, 'Functional test command', 4000),
    securityCommand: input.testOnly && !input.securityCommand ? '' : textField(input.securityCommand, 'Security test command', 4000),
    benchmarkCommand: input.benchmarkCommand ? textField(input.benchmarkCommand, 'Benchmark command', 4000) : '',
    protectedPaths, hints: Array.isArray(input.hints) ? input.hints : [],
    models: Array.isArray(input.models) ? input.models : [],
    runtime: input.runtime || 'docker', research: input.research === true,
    dependencyCheck: input.dependencyCheck === true, useActiveWorkspace: input.useActiveWorkspace !== false,
    sampleKey: input.sampleKey || null, modelProvider: input.modelProvider, testOnly: input.testOnly === true,
    ...(input.followUpRunId ? { followUpRunId: input.followUpRunId } : {}),
  };
}

function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function atomicJson(file, value) {
  const temporary = `${file}.new`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, file);
}

const now = () => new Date().toISOString();
const messageOf = (error) => error instanceof Error ? error.message : String(error);

function branchUsage(result) {
  return Object.fromEntries(['tokens', 'inputTokens', 'outputTokens', 'cost'].filter((key) =>
    Number.isFinite(result?.[key]) && result[key] >= 0).map((key) => [key, result[key]]));
}

function selectWinner(branches) {
  const eligible = branches.filter((branch) => branch.status === 'passed');
  const metric = ['cost', 'tokens'].find((key) => eligible.every((branch) => Number.isFinite(branch.usage[key])));
  return eligible.sort((a, b) =>
    (a.benchmarkScore ?? 0) - (b.benchmarkScore ?? 0) ||
    (metric ? a.usage[metric] - b.usage[metric] : 0) ||
    (a.added + a.removed) - (b.added + b.removed) ||
    a.files.length - b.files.length || a.id.localeCompare(b.id)
  )[0];
}

function previewCommand(commit) {
  return [
    "export GIT_OPTIONAL_LOCKS=0",
    `git -c core.quotePath=false diff --name-only -z --no-renames ${commit} -- | head -c 8000`,
    "git ls-files --others --exclude-standard -z | head -c 4000",
    "printf '\\0'",
    `{ git -c core.quotePath=false diff --no-ext-diff --no-textconv --no-color ${commit} -- | head -c 6000
      git ls-files --others --exclude-standard -z | head -c 4000 |
      { count=0; while IFS= read -r -d '' file && [ "$count" -lt 4 ]; do
        if [ -f "$file" ] && [ ! -L "$file" ]; then
          git -c core.quotePath=false diff --no-index --no-ext-diff --no-textconv --no-color -- /dev/null "$file" | head -c 1800
          count=$((count + 1))
        fi
      done; }; } | head -c 9000`,
  ].join("\n");
}

export function createEngine({ rootDir, agent, resolveRuntime, research, checkDependencies }) {
  if (typeof agent !== 'function') throw new TypeError('An agent runner is required.');
  const directory = resolve(rootDir);
  const runsDir = join(directory, 'runs');
  const workspacesDir = join(directory, 'workspaces');
  mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  mkdirSync(workspacesDir, { recursive: true, mode: 0o700 });
  const runs = new Map();

  function persist(run) {
    const { logs, ...state } = run;
    atomicJson(join(runsDir, run.id, 'run.json'), state);
  }

  function record(run, branchId, message, level = 'info', stream = 'system') {
    const entry = { seq: (run.logs.at(-1)?.seq ?? 0) + 1, time: now(), level, message: String(message), branchId, stream };
    run.logs.push(entry);
    appendFileSync(join(runsDir, run.id, 'logs.jsonl'), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const state = join(runsDir, entry.name, 'run.json');
    if (!existsSync(state)) continue;
    const run = readJson(state);
    for (const branch of run.branches) {
      if (branch.teamName) branch.teamName = currentTeamName(branch.teamName);
    }
    const logFile = join(runsDir, entry.name, 'logs.jsonl');
    run.logs = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }) : [];
    if (run.status === 'promoting') {
      run.status = 'ready';
      record(run, run.winner, 'The server restarted before promotion completed. Promotion can be retried.', 'warn');
      persist(run);
    } else if (!terminal.has(run.status)) {
      run.status = 'failed';
      run.error = 'The server restarted before the run completed.';
      run.completedAt = now();
      for (const branch of run.branches) {
        if (['queued', 'running', 'evaluating'].includes(branch.status)) {
          branch.status = 'failed';
          branch.error = run.error;
          branch.completedAt = run.completedAt;
        }
      }
      record(run, null, run.error, 'error');
      persist(run);
    }
    runs.set(run.id, run);
  }

  function transition(run, status) {
    run.status = status;
    persist(run);
  }

  function activeFor(repoId, repo) {
    return [...runs.values()].filter((run) => run.status === 'promoted' && (
      repoId ? run.repoId === repoId : !repo || run.repo === repo
    )).sort((a, b) => b.promotedAt.localeCompare(a.promotedAt))[0] ?? null;
  }

  async function execute(run, config) {
    const runDir = join(runsDir, run.id);
    const checkpointDir = join(runDir, 'checkpoint.git');
    const signal = AbortSignal.timeout(agentTimeoutMs + 600_000);
    const log = (message, level, stream) => record(run, null, message, level, stream);
    let runtime;
    run.startedAt = now();
    transition(run, 'preparing');
    try {
      const active = run.repoRef === 'HEAD' && config.useActiveWorkspace ? activeFor(run.repoId, run.repo) : null;
      if (active) {
        run.sourceRunId = active.id;
        log(`Using promoted workspace ${active.promotedCommit.slice(0, 12)}.`);
      }
      log(`Checkpointing ${run.repoRef}.`);
      run.baseCommit = await createCheckpoint(active ? { ...config, repo: active.activeWorkspace } : config, checkpointDir, signal);
      log(`Created checkpoint ${run.baseCommit.slice(0, 12)}.`);
      runtime = await resolveRuntime?.({ config, runDir, runId: run.id });
      if (!runtime && config.runtime !== 'docker') throw new Error(`The ${config.runtime} runtime is unavailable.`);
      runtime ??= createDockerRuntime();
      const prepared = await runtime.prepare({ repo: config.repo, ref: config.repoRef, runId: run.id, runDir, checkpointDir, baseCommit: run.baseCommit, log, signal });
      if (prepared?.checkpointId) run.checkpointId = prepared.checkpointId;

      let findings;
      if (config.research && research) {
        try {
          log('Collecting research context.');
          findings = await research({ runId: run.id, task: run.task, signal });
          log(findings ? 'Keenable research added to agent context.' : 'Keenable returned no usable research excerpts.');
        } catch (error) {
          log(`Research unavailable: ${messageOf(error)}`, 'warn');
        }
      }
      if (config.testOnly) {
        const [branch] = run.branches;
        branch.startedAt = now();
        branch.status = 'evaluating';
      } else {
        const reviewSources = await collectReviewSources(checkpointDir, run.baseCommit, run.task, signal).catch(() => []);
        transition(run, 'running');
        await Promise.all(run.branches.map(async (branch) => {
          const branchSignal = AbortSignal.any([signal, AbortSignal.timeout(agentTimeoutMs)]);
          const branchLog = (message, level, stream) => record(run, branch.id, message, level, stream);
          let fork;
          branch.startedAt = now();
          branch.status = 'running';
          persist(run);
          try {
            fork = await runtime.fork({ branch, log: branchLog, signal: branchSignal });
            branchLog('Isolated workspace ready.');
            const tools = { ...fork.tools };
            if (fork.inspect) {
              for (const method of ['exec', 'write']) {
                if (!fork.tools[method]) continue;
                tools[method] = async (...args) => {
                  const result = await fork.tools[method](...args);
                  try {
                    const preview = await fork.inspect(previewCommand(run.baseCommit));
                    const boundary = preview.stdout.startsWith('\0') ? 0 : preview.stdout.indexOf('\0\0') + 1;
                    if (!preview.exitCode && (boundary > 0 || preview.stdout.startsWith('\0'))) {
                      const files = [...new Set(preview.stdout.slice(0, boundary).split('\0').filter(Boolean))].slice(0, 64);
                      const diff = preview.stdout.slice(boundary + 1);
                      branch.preview = { files, diff };
                    }
                  } catch {
                    // The live preview is best-effort. Verification uses the frozen patch.
                  }
                  return result;
                };
              }
            }
            const result = await agent({
              runId: run.id, branch: branch.id, task: run.task, hint: branch.hint, model: branch.model,
              functionalCommand: run.functionalCommand, securityCommand: run.securityCommand, benchmarkCommand: run.benchmarkCommand,
              tools, research: findings, log: branchLog, signal: branchSignal, modelProvider: config.modelProvider, council: branch.council, subject: branch.subject, reviewSources,
              updateCouncil(memberId, update) {
                const member = branch.council.find(item => item.id === memberId);
                if (!member) return;
                Object.assign(member, update);
                if (update.recommendation) {
                  branchLog(`${member.name}${update.rating ? ` · ${update.rating}/5` : ''}: ${update.recommendation}`, update.status === 'failed' ? 'warn' : 'info');
                }
                persist(run);
              },
            });
            branch.usage = branchUsage(result);
            if (result?.summary) branch.summary = String(result.summary).slice(0, 12_000);
            const snapshot = await fork.snapshot();
            const frozen = await freezePatch(checkpointDir, runDir, branch, snapshot.patch ?? snapshot, branchSignal);
            branch.files = frozen.paths;
            delete branch.preview;
            branch.added = frozen.added;
            branch.removed = frozen.removed;
            branch.tree = frozen.tree;
            writeFileSync(join(runDir, `${branch.id}.patch`), frozen.patch, { mode: 0o600 });
            branch.status = 'evaluating';
            branchLog(`Captured changes to ${branch.files.length} files.`);
            persist(run);
          } catch (error) {
            branch.status = 'failed';
            for (const member of branch.council) {
              if (member.status === 'working') member.status = 'failed';
            }
            branch.error = messageOf(error);
            branch.completedAt = now();
            branchLog(branch.error, 'error');
            persist(run);
          } finally {
            if (fork?.dispose) {
              try { await fork.dispose(); } catch (error) { branchLog(`Workspace cleanup failed: ${messageOf(error)}`, 'warn'); }
            }
          }
        }));
      }

      transition(run, 'evaluating');
      await Promise.all(run.branches.filter((branch) => branch.status === 'evaluating').map(async (branch) => {
        const branchLog = (message, level, stream) => record(run, branch.id, message, level, stream);
        const modifiedTests = branch.files.filter((path) => protectedFile(path, config));
        if (modifiedTests.length) {
          branch.status = 'rejected';
          branch.error = `Protected files modified: ${modifiedTests.join(', ')}`;
          branchLog(branch.error, 'warn');
        } else {
          const patch = config.testOnly ? '' : readFileSync(join(runDir, `${branch.id}.patch`), 'utf8');
          const verifyCommand = async (name, command) => {
            const started = Date.now();
            branchLog(`${name} check: $ ${command}`);
            let exitCode = null;
            let error = null;
            let output;
            try {
              const result = await runtime.verify({ branch, patch, command, log: branchLog, signal });
              exitCode = result.exitCode;
              if (exitCode !== 0) output = (result.stderr?.trim() || result.stdout?.trim())?.slice(0, 1000);
              if (name === 'Benchmark' && exitCode === 0) {
                const output = result.stdout.trim();
                const score = Number(output);
                if (!/^\+?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?$/i.test(output) || !Number.isFinite(score)) {
                  throw new Error('The benchmark must print one finite nonnegative number to stdout.');
                }
                branch.benchmarkScore = score;
              }
            } catch (failure) {
              error = messageOf(failure);
              branchLog(error, 'error');
            }
            const status = exitCode === 0 && !error ? 'passed' : 'failed';
            branch.tests.push({ name, status, exitCode, durationMs: Date.now() - started, error, ...(output ? { output } : {}) });
            branchLog(`${name} check ${status}${exitCode === null ? '.' : ` (exit ${exitCode}).`}`, status === 'passed' ? 'info' : 'warn');
            persist(run);
          };
          await verifyCommand('Functional', config.functionalCommand);
          if (config.securityCommand) await verifyCommand('Security', config.securityCommand);
          if (config.dependencyCheck) {
            const started = Date.now();
            let error = null;
            try {
              if (!checkDependencies) throw new Error('Casco dependency checks are unavailable.');
              const tree = config.testOnly ? run.baseCommit : branch.tree;
              const lockfile = await git(['--git-dir', checkpointDir, 'show', `${tree}:package-lock.json`], { signal })
                .catch(() => { throw new Error('The verified tree must contain package-lock.json for the Casco check.'); });
              const result = await checkDependencies({ lockfile, runId: run.id, signal });
              if (!result.complete) throw new Error('Casco did not cover all locked dependencies.');
              if (result.affected.length) {
                const vulnerabilities = result.affected.flatMap((item) =>
                  item.vulnerabilities.map(({ id }) => `${item.package.name}@${item.package.version} (${id})`)
                );
                throw new Error(`Casco reported vulnerabilities: ${vulnerabilities.join(', ')}`);
              }
              branchLog(`Casco checked ${result.checked} locked dependencies.`);
            } catch (failure) {
              error = messageOf(failure);
              branchLog(error, 'warn');
            }
            branch.tests.push({ name: 'Casco', status: error ? 'failed' : 'passed', exitCode: error ? 1 : 0, durationMs: Date.now() - started, error });
            branchLog(`Casco check ${error ? 'failed' : 'passed'}.`, error ? 'warn' : 'info');
            persist(run);
          }
          if (config.benchmarkCommand && branch.tests.every((test) => test.status === 'passed')) {
            await verifyCommand('Benchmark', config.benchmarkCommand);
          }
          branch.status = branch.tests.every((test) => test.status === 'passed') ? 'passed' : 'rejected';
          if (branch.status === 'rejected') branch.error = 'One or more required checks failed.';
        }
        branch.completedAt = now();
        persist(run);
      }));
      run.completedAt = now();
      const winner = selectWinner(run.branches);
      run.winner = config.testOnly ? null : winner?.id ?? null;
      if (!winner) run.error = config.testOnly ? 'One or more checkpoint checks failed.' : 'No branch passed all required checks.';
      const success = config.testOnly ? 'Checkpoint passed the requested checks.' : `${winner?.name} selected after verification.`;
      log(winner ? success : run.error, winner ? 'info' : 'error');
      transition(run, winner ? 'ready' : 'failed');
    } catch (error) {
      run.error = messageOf(error);
      run.completedAt = now();
      for (const branch of run.branches.filter((item) => !item.completedAt)) {
        branch.status = 'failed';
        branch.error = run.error;
        branch.completedAt = run.completedAt;
      }
      log(run.error, 'error');
      transition(run, 'failed');
    } finally {
      if (runtime?.dispose) {
        try { await runtime.dispose(); } catch (error) { log(`Runtime cleanup failed: ${messageOf(error)}`, 'warn'); }
      }
    }
  }

  function present(run, detail) {
    if (!run) return null;
    const { logs, ...state } = run;
    const branches = run.branches.map(({ tree, preview, ...branch }) => {
      if (!detail) return branch;
      const patchFile = join(runsDir, run.id, `${branch.id}.patch`);
      return { ...branch, preview, snapshotTree: tree, diff: existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : null };
    });
    return { ...state, branches, ...(detail ? { logs: logs.slice() } : {}) };
  }

  return {
    list() { return [...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((run) => present(run, false)); },
    get(id) { return present(runs.get(id), true); },
    async followUpSource(id, branchId, repoId) {
      const run = runs.get(id);
      const branch = run?.branches.find(item => item.id === branchId);
      if (!run?.baseCommit || !branch || !terminal.has(run.status) || run.repoId !== repoId) return null;
      const repo = join(runsDir, run.id, 'checkpoint.git');
      if (!existsSync(repo)) return null;
      const repoRef = branch.status === 'passed' && branch.tree
        ? await commitVerifiedTree(repo, run, branch)
        : run.baseCommit;
      return { repo, repoRef };
    },
    repository(id, path, branchId) {
      const run = runs.get(id);
      const revision = branchId ? run?.branches.find(branch => branch.id === branchId)?.tree : run?.baseCommit;
      return revision ? readRepository(join(runsDir, id, 'checkpoint.git'), revision, path) : null;
    },
    logs() { return [...runs.values()].flatMap((run) => run.logs.map((entry) => ({ ...entry, runId: run.id }))); },
    getActive(repoId) {
      const run = activeFor(repoId);
      return run && { runId: run.id, branchId: run.winner, workspace: run.activeWorkspace, commit: run.promotedCommit, time: run.promotedAt };
    },
    start(input) {
      const config = configFor(input);
      const id = randomUUID();
      mkdirSync(join(runsDir, id), { mode: 0o700 });
      const run = {
        id, ...config, status: 'queued', createdAt: now(), startedAt: null, completedAt: null,
        baseCommit: null, winner: null, error: null, logs: [],
        branches: Array.from({ length: config.agentCount }, (_, index) => {
          const letter = String.fromCharCode(65 + index);
          return {
            id: letter, name: config.testOnly ? 'Checkpoint' : `Agent ${letter}`,
            model: config.testOnly ? null : config.models[index] || config.models[0] || 'default',
            hint: config.hints[index] || '', status: 'queued', startedAt: null, completedAt: null,
            tests: [], files: [], added: 0, removed: 0, error: null, usage: {},
            ...(config.testOnly ? { council: [] } : assembleTeam(index)),
          };
        }),
      };
      runs.set(id, run);
      persist(run);
      record(run, null, config.testOnly ? 'Checkpoint test queued.' : `Run queued with ${run.agentCount} agents.`);
      queueMicrotask(() => void execute(run, config));
      return present(run, true);
    },
    async promote(id) {
      const run = runs.get(id);
      if (!run) return null;
      if (run.status === 'promoted') return present(run, true);
      if (run.status !== 'ready' || !run.winner) throw new Error('This run has no verified branch available to promote.');
      const branch = run.branches.find((item) => item.id === run.winner && item.status === 'passed');
      const checkpointDir = join(runsDir, id, 'checkpoint.git');
      const path = join(workspacesDir, id);
      const inCheckpoint = (args, options) => git(['--git-dir', checkpointDir, ...args], options);
      transition(run, 'promoting');
      try {
        if (existsSync(path)) await inCheckpoint(['worktree', 'remove', '--force', path]);
        const commit = await commitVerifiedTree(checkpointDir, run, branch);
        let checkoutWarnings = '';
        await inCheckpoint(['worktree', 'add', '--detach', path, commit], {
          onOutput: (stream, output) => { if (stream === 'stderr') checkoutWarnings += output; },
        });
        if (/paths have collided/i.test(checkoutWarnings)) {
          throw new Error('The verified tree contains paths that collide on the local filesystem.');
        }
        const status = await git(['-C', path, 'status', '--porcelain', '--untracked-files=no']);
        if (status) throw new Error('The managed worktree does not match the verified commit.');
        run.activeWorkspace = path;
        run.promotedCommit = commit;
        run.promotedAt = now();
        transition(run, 'promoted');
        record(run, branch.id, `Promoted verified commit ${commit.slice(0, 12)}.`);
        return present(run, true);
      } catch (error) {
        if (run.status === 'promoted') throw error;
        await inCheckpoint(['worktree', 'remove', '--force', path]).catch(() => {});
        record(run, branch.id, `Promotion failed: ${messageOf(error)}`, 'error');
        transition(run, 'ready');
        throw error;
      }
    },
  };
}
