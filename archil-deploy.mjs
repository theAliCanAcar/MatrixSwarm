import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const deploymentRoot = "/opt/matrix-deployment";
export const deploymentService = "matrix-swarm-project";
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

export async function deployToArchil({ apiKey, region, baseSandboxId, workspace, commit, command, port, reuse }) {
  const { Archil } = await import("disk");
  const client = new Archil({ apiKey, region });
  const target = await client.sandboxes.get(baseSandboxId);
  if (target.status === "paused") await target.resume();
  else if (target.status === "stopped") await target.start();
  await target.refresh();
  if (target.status !== "running") throw new Error("The configured Archil sandbox is not running.");

  const { stdout: archive } = await exec("git", ["-C", workspace, "archive", "--format=tar.gz", commit], {
    encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 45_000,
  });
  const tag = randomUUID();
  const upload = `/tmp/matrix-release-${tag}.tar.gz`;
  const release = `release-${commit.slice(0, 12)}-${tag.slice(0, 8)}`;
  const launch = [
    "#!/bin/bash",
    "set -eu",
    'cd "$(dirname "$(readlink -f "$0")")/project"',
    ...(port ? [`export PORT=${port}`] : []),
    `exec /usr/sbin/runuser -u matrix-deploy -- /usr/bin/setpriv --no-new-privs /bin/bash -c ${quote(command)}`,
  ].join("\n");
  const script = [
    "set -euo pipefail",
    `root=${quote(deploymentRoot)}`,
    `name=${quote(deploymentService)}`,
    `upload=${quote(upload)}`,
    `release=${quote(release)}`,
    'install -d -m 755 "$root"',
    'exec 9>"$root/.lock"',
    'flock -w 20 9',
    'trap \'rm -f -- "$upload" "$root/.next"\' EXIT',
    'if ! id matrix-deploy >/dev/null 2>&1; then useradd --create-home --shell /bin/bash matrix-deploy; fi',
    'install -d -m 755 "$root/$release/project"',
    'tar --extract --gzip --no-same-owner --no-same-permissions --file "$upload" --directory "$root/$release/project"',
    'chown -hR matrix-deploy:matrix-deploy "$root/$release/project"',
    ...(command ? [`printf '%s\\n' ${quote(launch)} > "$root/$release/start.sh"`, 'chmod 700 "$root/$release/start.sh"'] : []),
    'previous=$(readlink "$root/current" || true)',
    'if [ -z "$previous" ] && archil-sandbox services get "$name" >/dev/null 2>&1; then echo "The managed service name is already in use." >&2; exit 1; fi',
    ...(reuse ? ['if [ ! -f "$root/current/start.sh" ]; then echo "There is no prior launch command to reuse." >&2; exit 1; fi',
      'install -m 700 "$root/current/start.sh" "$root/$release/start.sh"'] : []),
    'switch_release() { ln -s -- "$1" "$root/.next"; mv -Tf -- "$root/.next" "$root/current"; }',
    'stop_service() { if archil-sandbox services get "$name" >/dev/null 2>&1; then archil-sandbox services stop "$name" >/dev/null; fi; }',
    'start_service() {',
    '  if archil-sandbox services get "$name" >/dev/null 2>&1; then archil-sandbox services start "$name" >/dev/null;',
    '  else archil-sandbox services create --dir "$root" "$name" -- /bin/bash "$root/current/start.sh" >/dev/null; fi',
    '}',
    'restore_release() {',
    '  stop_service || true',
    '  if [ -n "$previous" ]; then switch_release "$previous"; if [ -f "$root/current/start.sh" ]; then start_service; fi;',
    '  else rm -f -- "$root/current"; archil-sandbox services delete "$name" >/dev/null 2>&1 || true; fi',
    '}',
    ...(port ? [`port_is_open() { node -e 'const s = require("net").connect(${port},"127.0.0.1"); s.setTimeout(500); s.on("connect",()=>process.exit(0)); s.on("error",()=>process.exit(1)); s.on("timeout",()=>process.exit(1));'; }`] : []),
    'stop_service',
    ...(port ? ['if port_is_open; then restore_release; echo "The health-check port is already in use." >&2; exit 1; fi'] : []),
    'if ! switch_release "$release"; then restore_release; exit 1; fi',
    ...(command || reuse ? [
      'healthy() {',
      '  start_service || return 1',
      ...(port ? [
        '  for attempt in {1..20}; do port_is_open && return 0; sleep 1; done',
        '  return 1',
      ] : [
        '  sleep 2',
        '  archil-sandbox services get "$name" | node -e \'let text=""; process.stdin.on("data", chunk=>text+=chunk); process.stdin.on("end",()=>{const s=JSON.parse(text); if(!s.enabled || !["active","running"].includes(s.state?.status) || !s.state?.pid) process.exitCode=1;});\'',
      ]),
      '}',
      'if ! healthy; then restore_release; echo "The new service failed its startup check. Restored the previous release." >&2; exit 1; fi',
    ] : []),
    'echo "Release deployed."',
  ].join("\n");

  try {
    await target.files.uploadFile(archive, upload);
    const result = await target.exec(`/bin/bash -c ${quote(script)}`, { cwd: "/", timeoutSeconds: 100 });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim().split("\n").at(-1) || "Archil could not activate the release.");
    }
    return {
      sandboxId: target.id, sandbox: target.name, path: `${deploymentRoot}/current/project`,
      commit, service: command || reuse ? deploymentService : null, port: port || null,
    };
  } finally {
    await target.exec(`rm -f -- ${quote(upload)}`, { cwd: "/", timeoutSeconds: 10 }).catch(() => {});
  }
}
