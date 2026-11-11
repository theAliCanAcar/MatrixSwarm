import { execFile } from 'node:child_process';
import { openAsBlob } from 'node:fs';
import { access, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { deploymentRoot, deploymentService } from './archil-deploy.mjs';

const execFileAsync = promisify(execFile);
const guestPath = '/workspace';
const sandboxTtl = 900;
const maxOutputBytes = 256 * 1024;
const maxPatchBytes = 8 * 1024 * 1024;
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const asAgent = (command) => `/usr/sbin/runuser -u matrix -- /usr/bin/setpriv --no-new-privs /bin/bash -c ${quote(command)}`;

function describeArchilError(error) {
  if (error?.status === 401) return 'Archil rejected the API key.';
  if (error?.status === 403) return 'Archil denied the request. Sandbox execution requires an API key with sandbox permissions and a plan that supports custom egress policies.';
  return 'Archil could not complete the sandbox request.';
}

async function runCommand(sandbox, command, {
  cwd = guestPath, signal, timeoutSeconds = 120, maxBytes = maxOutputBytes, log,
} = {}) {
  signal?.throwIfAborted();
  const buffers = { stdout: [], stderr: [] };
  const sizes = { stdout: 0, stderr: 0 };
  const overflow = { stdout: false, stderr: false };
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const child = await sandbox.run(command, {
    cwd,
    timeoutSeconds,
    collectOutput: false,
    onOutput({ stream, data }) {
      if (!buffers[stream]) return;
      const accepted = data.subarray(0, Math.max(0, maxBytes - sizes[stream]));
      sizes[stream] += accepted.length;
      if (accepted.length) {
        buffers[stream].push(Buffer.from(accepted));
        const message = decoders[stream].decode(accepted, { stream: true });
        if (message) log?.(message, stream === 'stderr' ? 'warn' : 'info', stream);
      }
      if (!overflow[stream] && accepted.length < data.length) {
        overflow[stream] = true;
        log?.('[Sandbox output limit reached]', 'warn', stream);
      }
    },
  });
  const kill = () => { void child.kill().catch(() => {}); };
  signal?.addEventListener('abort', kill, { once: true });
  if (signal?.aborted) kill();

  try {
    const result = await child.wait();
    signal?.throwIfAborted();
    return {
      exitCode: Number.isInteger(result.exitCode) ? result.exitCode : result.status === 'timed_out' ? 124 : 1,
      stdout: Buffer.concat(buffers.stdout).toString('utf8'),
      stderr: Buffer.concat(buffers.stderr).toString('utf8'),
      truncated: overflow.stdout || overflow.stderr,
    };
  } finally {
    signal?.removeEventListener('abort', kill);
    await child.disconnect().catch(() => {});
  }
}

function checked(result, message) {
  if (result.exitCode !== 0 || result.truncated) throw new Error(message);
  return result;
}

function pathInWorkspace(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\0')
      || path.split('/').some((segment) => ['..', '.git'].includes(segment))) {
    throw new Error('Supply a relative path inside the workspace.');
  }
  return `${guestPath}/${path}`;
}

// Official sandbox lifecycle and process API: https://docs.archil.com/guides/agents/parallel-agents
export function createArchilRuntime({
  apiKey, region = 'aws-us-east-1', image = 'node:24-bookworm', baseSandboxId, runId, record, getUsage, sdk,
}) {
  let base;
  let prefix;
  let currentRunId = runId;
  const children = new Map();

  async function observe(operation, detail, execute, metrics = []) {
    const start = performance.now();
    let value;
    try {
      value = await execute();
    } catch (error) {
      const message = describeArchilError(error);
      record?.({ provider: 'archil', operation, runId: currentRunId, status: 'failed', detail: message,
        durationMs: Math.round(performance.now() - start) });
      throw new Error(message);
    }
    record?.({ provider: 'archil', operation, runId: currentRunId, status: 'success', detail,
      durationMs: Math.round(performance.now() - start), metrics });
    return value;
  }

  async function archiveUsage(sandbox) {
    if (!getUsage) return;
    const start = performance.now();
    try {
      const usage = await getUsage(sandbox.id);
      if (!Number.isFinite(usage?.vcpu_hours) || !Number.isFinite(usage?.memory_gib_hours) || !Number.isFinite(usage?.cost)) {
        throw new Error('Missing Archil sandbox metrics.');
      }
      record?.({
        provider: 'archil', operation: 'Sandbox usage', runId: currentRunId, status: 'success',
        detail: `Archil reported metered usage for ${sandbox.name}.`,
        durationMs: Math.round(performance.now() - start),
        metrics: [
          { label: 'Swarm vCPU hours', value: usage.vcpu_hours, unit: 'vCPU-hours' },
          { label: 'Swarm memory hours', value: usage.memory_gib_hours, unit: 'GiB-hours' },
          { label: 'Swarm compute cost before allowances', value: usage.cost, unit: 'USD' },
        ],
      });
    } catch {
      record?.({
        provider: 'archil', operation: 'Sandbox usage', runId: currentRunId, status: 'failed',
        detail: `Metered usage for ${sandbox.name} was unavailable.`, durationMs: Math.round(performance.now() - start),
      });
    }
  }

  async function destroy(sandbox) {
    await observe('Sandbox cleanup', `Deleted ${sandbox.name}.`, async () => {
      await sandbox.refresh();
      if (!['stopped', 'failed', 'exited'].includes(sandbox.status)) await sandbox.stop();
      try {
        await archiveUsage(sandbox);
      } finally {
        await sandbox.delete();
      }
    });
  }

  function disposeChild(sandbox) {
    const state = children.get(sandbox.id);
    if (!state) return Promise.resolve();
    state.cleanup ??= destroy(sandbox).then(
      () => children.delete(sandbox.id),
      (error) => { state.cleanup = undefined; throw error; },
    );
    return state.cleanup;
  }

  async function forkSandbox(kind, signal) {
    signal?.throwIfAborted();
    const name = `${prefix}-${kind}-${randomUUID().slice(0, 6)}`;
    const sandbox = await observe('Sandbox fork', `Created isolated fork ${name}.`,
      () => base.fork({ name }), [{ label: 'Sandbox forks', value: 1, unit: 'forks' }]);
    children.set(sandbox.id, { sandbox });
    return sandbox;
  }

  return {
    async prepare({ checkpointDir, baseCommit, runDir, log, signal, runId: id }) {
      currentRunId ??= id;
      if (!apiKey) throw new Error('Add an Archil API key in Settings.');
      if (!['aws-us-east-1', 'aws-us-west-2', 'aws-eu-west-1'].includes(region)) {
        throw new Error('Archil sandbox execution requires an AWS region.');
      }
      signal?.throwIfAborted();
      const { Archil } = sdk ?? await import('disk');
      const client = new Archil({ apiKey, region });
      prefix = `matrix-${randomUUID().slice(0, 12)}`;
      const archivePath = join(runDir, `${prefix}.tar.gz`);
      try {
        const entries = ['HEAD', 'config', 'objects', 'refs'];
        for (const entry of ['shallow', 'packed-refs']) {
          try {
            await access(join(checkpointDir, entry));
            entries.push(entry);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
        // Preserve shallow history markers so a depth-one checkpoint can be cloned.
        await execFileAsync('tar', ['--no-xattrs', '-czf', archivePath, '-C', checkpointDir, ...entries], {
          signal, env: { ...process.env, COPYFILE_DISABLE: '1' },
        });
        if (baseSandboxId) {
          const source = await client.sandboxes.get(baseSandboxId);
          if (source.mounts?.length || source.endpoints?.length) {
            throw new Error('Select a base sandbox without additional disk mounts or exposed ports.');
          }
          base = await observe('Template sandbox fork', `Forked ${source.name} (${source.baseImage}) into ${prefix}.`,
            () => source.fork({ name: prefix }), [{ label: 'Sandbox forks', value: 1, unit: 'forks' }]);
          log?.(`Using Archil sandbox ${source.name} (${source.baseImage}) as the run template.`);
          const policy = await base.getNetwork();
          const egress = policy.egress;
          if (egress?.default !== 'deny' || egress.allow?.length || egress.rules?.length) {
            await observe('Sandbox firewall', `Applied deny-all egress to ${prefix}.`,
              () => base.updateNetwork({ egress: { default: 'deny' } }));
          }
          // A template fork can inherit running processes. Cold boot the disposable copy.
          await base.stop();
          await base.start();
          await base.setTimeout({ timeoutSeconds: sandboxTtl, idleTtlSeconds: 300 });
          const cleaned = await runCommand(base, `set -e
if test -d ${deploymentRoot}; then
  if test -L ${deploymentRoot}/current && archil-sandbox services get ${deploymentService} >/dev/null 2>&1; then
    archil-sandbox services delete ${deploymentService} >/dev/null
  fi
  rm -rf -- ${deploymentRoot}
fi`, { cwd: '/', signal, log });
          checked(cleaned, 'The disposable fork could not clear inherited deployment files.');
        } else {
          base = await observe('Sandbox create', `Created checkpoint sandbox ${prefix}.`,
            () => client.sandboxes.create({
              name: prefix,
              baseImage: image,
              maxTtlSeconds: sandboxTtl,
              idleTtlSeconds: 300,
              network: { egress: { default: 'deny' } },
            }), [{ label: 'Base sandboxes', value: 1, unit: 'sandboxes' }]);
        }
        signal?.throwIfAborted();
        await base.files.uploadFile(await openAsBlob(archivePath), '/tmp/matrix-base.tar.gz');
        const setup = await runCommand(base, [
          'set -eu',
          'useradd --create-home --shell /bin/bash matrix',
          'install -d -m 700 /opt/matrix',
          'install -d -m 700 /opt/matrix/trusted.git',
          'install -d -m 755 /opt/matrix-transfer',
          'tar --extract --gzip --no-same-owner --file /tmp/matrix-base.tar.gz --directory /opt/matrix/trusted.git',
          'git -c core.hooksPath=/dev/null clone --quiet --no-local -b checkpoint /opt/matrix/trusted.git /workspace',
          'git -C /workspace remote remove origin',
          'rm /tmp/matrix-base.tar.gz',
          'chown -hR matrix:matrix /workspace',
          'git --git-dir=/opt/matrix/trusted.git rev-parse HEAD',
        ].join('\n'), { cwd: '/', signal, log });
        if (setup.exitCode !== 0 || setup.stdout.trim() !== baseCommit) {
          throw new Error('Archil could not restore the expected Git checkpoint. The sandbox image must provide Git.');
        }
        // An idle paused base has an immutable disk snapshot and uses no running compute.
        await observe('Sandbox checkpoint', `Checkpointed ${baseCommit.slice(0, 12)} in Archil.`, () => base.pause());
        return { commit: baseCommit, checkpointId: base.checkpoint ?? base.id };
      } finally {
        await rm(archivePath, { force: true });
      }
    },

    async fork({ log, signal }) {
      const sandbox = await forkSandbox('agent', signal);
      const execute = (command, options = {}) => runCommand(sandbox, command, { log, signal, ...options });
      return {
        tools: {
          async exec(command) {
            if (typeof command !== 'string' || !command.trim()) throw new Error('A shell command is required.');
            log?.(`$ ${command}`);
            const result = await execute(asAgent(command));
            log?.(`Exited with code ${result.exitCode}`, result.exitCode ? 'warn' : 'info');
            return result;
          },
          async read(path) {
            log?.(`Read ${path}`);
            const result = await execute(asAgent(`cat -- ${quote(pathInWorkspace(path))}`));
            return checked(result, 'Could not read the requested file.').stdout;
          },
          async write(path, content) {
            const destination = quote(pathInWorkspace(path));
            const transfer = `/opt/matrix-transfer/${randomUUID()}`;
            log?.(`Write ${path}`);
            await sandbox.files.uploadFile(Buffer.from(content), transfer);
            try {
              const result = await execute(asAgent(`mkdir -p -- "$(dirname -- ${destination})" && cat -- ${quote(transfer)} > ${destination}`));
              checked(result, 'Could not write the requested file.');
            } finally {
              await execute(`rm -f -- ${quote(transfer)}`, { signal: undefined });
            }
          },
        },
        inspect(command) {
          return execute(asAgent(command), { log: undefined, timeoutSeconds: 4, maxBytes: 24 * 1024 });
        },
        async snapshot() {
          signal?.throwIfAborted();
          // Cold boot ends background agent processes. The scanner uses root-owned Git metadata.
          await sandbox.stop();
          signal?.throwIfAborted();
          await sandbox.start();
          const result = await execute([
            'set -eu',
            'export GIT_DIR=/opt/matrix/trusted.git GIT_WORK_TREE=/workspace',
            'export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null',
            'git read-tree HEAD',
            'git -c core.hooksPath=/dev/null add --all',
            'git diff --cached --binary --full-index --no-renames --no-ext-diff --no-textconv HEAD --',
          ].join('\n'), { maxBytes: maxPatchBytes, log: undefined });
          return { patch: checked(result, 'The agent could not export a complete Git patch.').stdout };
        },
        dispose: () => disposeChild(sandbox),
      };
    },

    async verify({ patch, command, log, signal }) {
      const sandbox = await forkSandbox('check', signal);
      try {
        if (patch) {
          await sandbox.files.uploadFile(Buffer.from(patch), '/tmp/matrix-candidate.patch');
          const applied = await runCommand(sandbox,
            asAgent('git -c core.hooksPath=/dev/null apply --binary -- /tmp/matrix-candidate.patch'), { signal, log });
          checked(applied, 'The frozen patch could not be applied to the Archil verification fork.');
          await runCommand(sandbox, 'rm /tmp/matrix-candidate.patch', { signal });
        }
        return await runCommand(sandbox, asAgent(command), { signal, log, timeoutSeconds: 180 });
      } finally {
        await disposeChild(sandbox);
      }
    },

    async dispose() {
      const cleanup = await Promise.allSettled([...children.values()].map(({ sandbox }) => disposeChild(sandbox)));
      if (cleanup.some((result) => result.status === 'rejected')) {
        throw new Error('Some Archil forks could not be removed. Their sandbox lifetime remains bounded.');
      }
      if (base) {
        await destroy(base);
        base = undefined;
      }
    },
  };
}
