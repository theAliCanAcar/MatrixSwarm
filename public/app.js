import {icon, iconSpan} from "./icons.js";
import {mountFlightScope} from "./flight-scope.js";
import {matrixRain} from "./matrix-rain.js";
import {currentTeamName} from "./team-names.js";

const main = document.querySelector("#main");
const navigation = document.querySelector("#navigation");
const dialog = document.querySelector("#run-dialog");
const chatDialog = document.querySelector("#chat-dialog");
const chatMessages = [];
const sidebar = document.querySelector("#sidebar-status");
const toasts = document.querySelector("#toasts");
const showRain = matrixRain(document.querySelector("#matrix-rain"));
const navItems = {
  overview: ["Control", "overview"],
  runs: ["Runs", "runs"],
  repositories: ["Repositories", "repo"],
  logs: ["Logs", "log"],
  usage: ["Usage", "usage"],
  settings: ["Settings", "settings"]
};

const data = {
  state: null,
  error: "",
  run: null,
  branch: null,
  branchTab: "tests",
  logRun: "",
  logStream: "",
  logText: "",
  logs: [],
  logError: "",
  busy: false,
  selectedRepo: "",
  runDraft: null,
  file: "",
  workspaceView: "auto",
  repoBrowse: false,
  repoFolder: "",
  repoFile: "",
  repoEntries: new Map(),
  reviewFile: "",
  reviewPoint: "",
  reviewJump: false,
  launchId: null,
  resetRepo: null
};

document.querySelectorAll("[data-icon]").forEach(el => {
  el.innerHTML = icon(el.dataset.icon);
});

const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[char]);
const id = value => encodeURIComponent(value);
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const number = value => typeof value === "number" ? value.toLocaleString(undefined, {maximumFractionDigits: 4}) : esc(value);
const readable = value => String(value ?? "").replaceAll("_", " ").replaceAll("-", " ").replace(/^./, char => char.toUpperCase());

function formatTime(value, timeOnly = false) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return "—";
  const date = new Date(value);
  return timeOnly
    ? date.toLocaleTimeString(undefined, {hour12: false})
    : date.toLocaleString(undefined, {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"});
}

function route() {
  const [page, param, branch] = location.hash.slice(1).split("/");
  return {page: Object.hasOwn(navItems, page) ? page : "overview", param, branch};
}

function button(text, action, glyph, className = "") {
  return `<button class="button ${className}" data-action="${action}">${glyph ? iconSpan(glyph) : ""}${text}</button>`;
}

function pill(status, text) {
  const color = {
    ready: "success", promoted: "success", passed: "success", connected: "success", ok: "success", success: "success",
    failed: "failed", rejected: "failed", error: "failed", unavailable: "failed",
    queued: "running", preparing: "running", running: "running", evaluating: "running", promoting: "running",
    warning: "warning", unconfigured: "warning", missing: "warning", unchecked: "warning"
  }[status] ?? "";
  const label = text || ({ready: "Verified", unconfigured: "Not configured", unchecked: "Not checked"}[status] ?? readable(status || "Unknown"));
  return `<span class="pill ${color}">${esc(label)}</span>`;
}

function heading(title, subtitle = "", extra = "") {
  return `<div class="page-heading"><div><h1>${title}</h1>${subtitle ? `<p>${subtitle}</p>` : ""}</div>${extra}</div>`;
}

function cardHeader(title, subtitle, extra = "") {
  return `<div class="section-header"><div><h2>${title}</h2>${subtitle ? `<p>${subtitle}</p>` : ""}</div>${extra}</div>`;
}

function empty(title, subtitle, glyph, extra = "") {
  return `<div class="empty">${iconSpan(glyph, "empty-icon")}<h3>${title}</h3><p>${subtitle}</p>${extra}</div>`;
}

function link(text, target, glyph, className = "") {
  return `<a class="button ${className}" href="#${target}">${text}${glyph ? iconSpan(glyph) : ""}</a>`;
}

function notice(text) {
  return `<p class="notice error" role="alert">${esc(text)}</p>`;
}

function toast(message, error = false) {
  const item = document.createElement("div");
  item.className = error ? "toast error" : "toast";
  item.textContent = message;
  toasts.append(item);
  setTimeout(() => item.remove(), 5200);
}

async function request(path, method = "GET", body) {
  const response = await fetch(`/api${path}`, {
    method,
    ...(body ? {headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)} : {})
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}

function repoLabel(run) {
  return data.state.repos.find(repo => repo.id === run.repoId)?.name || run.repo || "Repository";
}

function runsTable(runs) {
  if (!runs.length) return empty("No runs yet", "Your runs will appear here once you launch a swarm.", "runs");
  return `<div class="scroll-table"><table>
    <thead><tr><th scope="col">Task</th><th scope="col">Repository</th><th scope="col">Status</th><th scope="col">Agents</th><th scope="col">Created</th></tr></thead>
    <tbody>${runs.map(run => `<tr>
      <td><a href="#runs/${id(run.id)}">${esc(run.task)}</a></td>
      <td>${esc(repoLabel(run))}</td><td>${pill(run.status)}</td><td>${run.testOnly ? "—" : esc(run.agentCount)}</td><td>${formatTime(run.createdAt)}</td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

const inFlight = new Set(["queued", "preparing", "running", "evaluating", "promoting"]);
let flightScope;

function currentFlight() {
  return data.state.runs.find(run => inFlight.has(run.status)) || data.state.runs[0];
}

function findRun(runId) {
  return data.run?.id === runId ? data.run : data.state.runs.find(run => run.id === runId);
}

function flightPhases(run) {
  const branches = run?.branches || [];
  const stages = [["Checkpoint", Boolean(run?.baseCommit)]];
  if (!run?.testOnly) stages.push(["Sentinels", branches.length > 0 && branches.every(branch => branch.completedAt || branch.status === "evaluating")]);
  stages.push(["Verification", Boolean(run?.winner || (run?.testOnly && run.status === "ready"))]);
  if (!run?.testOnly) stages.push(["Promotion", Boolean(run?.promotedAt)]);
  let active = stages.findIndex(([, done]) => !done);
  if (!run || !inFlight.has(run.status)) active = -1;
  return `<ol class="phase-track" aria-label="Run phases">${stages.map(([label, done], index) =>
    `<li class="${done ? "complete" : index === active ? "current" : ""}"${index === active ? ' aria-current="step"' : ""}>
      <span class="phase-mark" aria-hidden="true">${done ? icon("check") : `0${index + 1}`}</span>
      <span>${label}${done ? '<span class="visually-hidden"> complete</span>' : ""}</span>
    </li>`).join("")}</ol>`;
}

function preflight() {
  const {repos, runtime, settings} = data.state;
  const demoCount = repos.filter(repo => repo.demo).length;
  const model = settings.providers.find(provider => provider.id === settings.modelProvider);
  const runtimeName = runtime.options?.find(option => option.available)?.name;
  const checks = [
    ["Repository", demoCount ? `${plural(demoCount, "demo")} available` : repos.length ? "Connected" : "Add a repository", Boolean(repos.length), "#repositories"],
    ["Agent model", model?.configured ? `${model.name} key saved` : "Add a Fireworks AI key", Boolean(model?.configured), "#settings"],
    ["Isolation", runtimeName ? `${runtimeName} available` : "Connect a runtime", Boolean(runtime.available), "#settings"]
  ];
  return `<section class="preflight-panel" aria-labelledby="preflight-title">
    <h2 id="preflight-title">Preflight</h2>
    ${checks.map(([label, detail, ready, target]) => `<a class="preflight-check" href="${target}">
      <span class="check-state${ready ? " complete" : ""}" aria-hidden="true">${icon(ready ? "check" : "arrow")}</span>
      <span><strong>${label}</strong><small>${detail}</small></span>
    </a>`).join("")}
  </section>`;
}

function overview() {
  const {runs} = data.state;
  const run = currentFlight();
  const activeCount = runs.filter(item => inFlight.has(item.status)).length;
  return `<section class="flight-stage" aria-labelledby="flight-title">
    <div class="flight-landscape" aria-hidden="true"></div>
    <div class="flight-shade" aria-hidden="true"></div>
    <div class="flight-frame" aria-hidden="true"></div>
    <div class="flight-copy">
      <div class="flight-kicker"><span></span>${run ? (inFlight.has(run.status) ? "Run in progress" : "Latest run") : "Standby"}</div>
      <h1 id="flight-title">Sentinel<br>control<span>.</span></h1>
      ${run ? `<div class="flight-task">${esc(run.task)}</div><p>${esc(repoLabel(run))} <span aria-hidden="true">/</span> ${run.testOnly ? "Checkpoint test" : esc(plural(run.agentCount, "agent"))}</p>`
        : "<p>Deploy parallel coding agents against a Git checkpoint. Review the verified branch before promotion.</p>"}
      <div class="flight-actions">${run ? link("Inspect run", `runs/${id(run.id)}`, "arrow", "primary") : button("Deploy a swarm", "new-run", "arrow", "primary")}</div>
    </div>
    <div class="flight-scope">
      <canvas id="flight-canvas" aria-hidden="true"></canvas>
      <div class="scope-caption"><span class="scope-indicator" aria-hidden="true"></span>
      ${run ? pill(run.status) : "<span>Awaiting checkpoint</span>"}</div>
      ${run?.branches?.length ? `<div class="sentinel-links" aria-label="Inspect an agent">
        ${run.branches.map(branch => `<a href="#runs/${id(run.id)}/${id(branch.id)}"
          title="${esc(branch.name)} · ${esc(readable(branch.status))}">
          <span class="sentinel-dot ${esc(branch.status)}"></span>${esc(branch.id)}
          <span class="visually-hidden"> ${esc(readable(branch.status))}</span></a>`).join("")}
      </div>` : ""}
    </div>
    ${flightPhases(run)}
  </section>
  <div class="flight-console">
    <section class="manifest" aria-labelledby="manifest-title">
      <div class="manifest-head"><div><h2 id="manifest-title">Run manifest</h2><p>${activeCount ? `${plural(activeCount, "active run")} · ` : ""}${plural(runs.length, "recorded run")}</p></div>
      ${link("All runs", "runs", "arrow", "text-button")}</div>
      ${runs.length ? runsTable(runs.slice(0, 5)) : '<p class="manifest-empty">No runs recorded. Your first run will appear here.</p>'}
    </section>
    ${preflight()}
  </div>`;
}

function runsPage() {
  return `${heading("Runs", "Open a run to see its branches, tests, and promotion history.")}
    <section class="card">${cardHeader("Run history", plural(data.state.runs.length, "run"))}${runsTable(data.state.runs)}</section>`;
}

function repositoriesPage() {
  const {repos, active, deployment} = data.state;
  const demos = repos.filter(repo => repo.demo);
  const connected = repos.filter(repo => !repo.demo);
  const actions = (repo, demo) => `<div class="repo-actions">
    <button class="button${demo ? " primary" : ""}" data-action="run-repo" data-repo="${esc(repo.id)}">${iconSpan("plus")} ${demo ? "Run demo" : "New run"}</button>
    <button class="button" data-action="reset-repo" data-repo="${esc(repo.id)}">${iconSpan("refresh")} Reset</button></div>`;
  const deployedRepo = repos.find(repo => repo.id === deployment?.repoId);
  return `${heading("Repositories", "Choose a repository and ref for each swarm.", button("Add repository", "add-repo", "plus", "primary"))}
    ${deployment ? `<p class="notice success">${esc(deployedRepo?.name || "Verified project")} deployed to ${esc(deployment.sandbox)}
      ${link("View release", `runs/${id(deployment.runId)}`, "arrow", "text-button")}</p>` : ""}
    ${demos.length ? `<section class="card">${cardHeader("Demo repositories", "Run live coding agents against a sample Git repository.")}
      <div class="demo-grid">${demos.map(repo => `<article class="demo-repo"><h3>${esc(repo.name)}</h3>
        <p>${esc(repo.demo.task)}</p>
        ${active[repo.id] ? link("Promoted run", `runs/${id(active[repo.id].runId)}`, "arrow", "text-button") : ""}
        <div class="demo-actions">${actions(repo, true)}</div>
      </article>`).join("")}</div></section>` : ""}
    <section class="card section">${cardHeader("Connected repositories", plural(connected.length, "repository").replace("repositorys", "repositories"))}
    ${connected.length ? `<div class="scroll-table"><table>
      <thead><tr><th scope="col">Repository</th><th scope="col">Ref</th><th scope="col">Active workspace</th><th scope="col"></th></tr></thead>
      <tbody>${connected.map(repo => `<tr>
        <td><strong>${esc(repo.name)}</strong><small>${esc(repo.source)}</small></td><td>${esc(repo.ref || "Default branch")}</td>
        <td>${active[repo.id] ? `<a href="#runs/${id(active[repo.id].runId)}">Promoted run</a><small>${esc(active[repo.id].path)}</small>` : "Original ref"}</td>
        <td>${actions(repo, false)}</td></tr>`).join("")}</tbody>
    </table></div>` : empty("No repositories added", "Add a Git remote or local repository path to use as the starting point for a swarm.", "repo", button("Add repository", "add-repo", "plus", "primary"))}
    </section>`;
}

function logOutput(logs, message = "Logs will appear here as commands run.") {
  if (!logs.length) return `<div class="log-view">${empty("No log entries", message, "log")}</div>`;
  return `<div class="log-view" tabindex="0" aria-label="Log output">
    ${logs.map(log => `<div class="log-line ${esc(log.stream || log.level)}">
      <time datetime="${esc(log.time || log.at)}" title="${formatTime(log.time || log.at)}">${formatTime(log.time || log.at, true)}</time>
      <span class="log-source">${esc(log.source || log.stream || log.level || "system")}</span>
      <span class="log-message">${esc(log.message)}</span>
    </div>`).join("")}</div>`;
}

function filteredLogs() {
  const query = data.logText.trim().toLowerCase();
  return data.logs.filter(log => (!data.logRun || log.runId === data.logRun)
    && (!data.logStream || log.stream === data.logStream)
    && (!query || [log.message, log.source, log.level].some(value => String(value ?? "").toLowerCase().includes(query))));
}

function refreshLogOutput() {
  const target = document.querySelector("#log-output");
  if (target) target.innerHTML = (data.logError ? notice(data.logError) : "") + logOutput(filteredLogs(), data.logs.length ? "Try changing the run, stream, or search filter." : "Command output and orchestration events appear here during a run.");
}

function logsPage() {
  return `${heading("Logs", "Inspect command output and orchestration events across every run.")}
    <section class="card">
      ${cardHeader("All activity", "Includes agent output, test results, and workspace events.", button("Download", "download-logs", "download"))}
      <div class="filters">
        <label>Run <select id="log-run" class="control"><option value="">All runs</option>${data.state.runs.map(run =>
          `<option value="${esc(run.id)}"${run.id === data.logRun ? " selected" : ""}>${esc(run.task.slice(0, 70))}</option>`).join("")}</select></label>
        <label>Stream <select id="log-stream" class="control"><option value="">All streams</option>${["system","stdout","stderr"].map(stream =>
          `<option${stream === data.logStream ? " selected" : ""}>${stream}</option>`).join("")}</select></label>
        <input class="control" id="log-search" type="search" placeholder="Search logs" aria-label="Search logs" value="${esc(data.logText)}">
      </div>
      <div id="log-output"></div>
    </section>`;
}

function providerIcon(provider) {
  return {fireworks: "spark", anthropic: "spark", archil: "box", keenable: "search", casco: "shield"}[provider] || "globe";
}

function metricsList(metrics = []) {
  if (!metrics.length) return "";
  return `<dl class="provider-metrics">${metrics.map(metric => `<div><dt>${esc(metric.label)}</dt><dd>${number(metric.value)} ${esc(metric.unit)}</dd></div>`).join("")}</dl>`;
}

function providerHeader(provider) {
  return `<div class="provider-heading">${iconSpan(providerIcon(provider.id), "provider-icon")}
    <h3>${esc(provider.name)}</h3>${pill(provider.status || (provider.configured ? "ready" : "unconfigured"), provider.status === "ready" ? (provider.source === "keyless" ? "Public access" : "Configured") : "")}</div>`;
}

function usageGrowth(points) {
  const first = points[0];
  const latest = points.at(-1);
  return `<section class="card growth-card">${cardHeader("Fireworks AI usage growth", "Cumulative requests and tokens over time")}
    ${latest ? `<div class="growth-grid">${[["requests", "API requests"], ["tokens", "Input and output tokens"]].map(([key, label]) =>
      `<figure class="growth-series"><figcaption><span>${label}</span><strong>${number(latest[key])}</strong></figcaption>
        <canvas width="660" height="144" data-growth="${key}" role="img" aria-label="${label} grew from 0 to ${latest[key]} across ${latest.requests} requests"></canvas>
        <div class="growth-axis"><span>${formatTime(first.at || first.day)}</span><span>${formatTime(latest.at || latest.day)}</span></div></figure>`).join("")}</div>`
      : '<p class="growth-empty">Fireworks usage appears here after the first request.</p>'}
  </section>`;
}

function drawGrowth() {
  const points = data.state.usage.fireworksGrowth || [];
  if (!points.length) return;
  for (const canvas of main.querySelectorAll("[data-growth]")) {
    const context = canvas.getContext("2d");
    if (!context) continue;
    const {width, height} = canvas;
    const key = canvas.dataset.growth;
    const total = Math.max(1, points.at(-1)[key]);
    const start = Date.parse(points[0].at);
    const span = Date.parse(points.at(-1).at) - start;
    const baseline = height - 8;
    const coords = [[8, baseline], ...points.map(point => {
      const progress = span > 0 ? (Date.parse(point.at) - start) / span : point.requests / points.at(-1).requests;
      return [8 + progress * (width - 16), baseline - point[key] / total * (height - 20)];
    })];
    context.strokeStyle = "#234235";
    for (const y of [12, height / 2, baseline]) {
      context.beginPath();
      context.moveTo(8, y);
      context.lineTo(width - 8, y);
      context.stroke();
    }
    const line = new Path2D();
    line.moveTo(...coords[0]);
    for (let index = 1; index < coords.length; index += 1) {
      const [x, y] = coords[index];
      line.lineTo(x, coords[index - 1][1]);
      line.lineTo(x, y);
    }
    const fill = new Path2D(line);
    fill.lineTo(width - 8, baseline);
    fill.closePath();
    const color = key === "tokens" ? "#78d5ec" : "#88f7a4";
    const gradient = context.createLinearGradient(0, 12, 0, baseline);
    gradient.addColorStop(0, color + "52");
    gradient.addColorStop(1, color + "07");
    context.fillStyle = gradient;
    context.fill(fill);
    context.strokeStyle = color;
    context.lineWidth = 2.5;
    context.stroke(line);
    const [x, y] = coords.at(-1);
    context.beginPath();
    context.arc(x, y, 4, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
  }
}

function fireworksCapacity(provider, cooldowns, models) {
  if (!provider?.configured) return "";
  return `<section class="card capacity-card" aria-label="Fireworks model availability">
    ${cardHeader("Fireworks capacity", "", cooldowns.length ? pill("warning", "Cooling down") : pill("connected", "No active cooldown"))}
    <div class="capacity-body">
      ${cooldowns.length ? `<ul>${cooldowns.map(({model, reason, until}) =>
        `<li><strong>${esc(models.find(item => item.id === model)?.name || model)}</strong>
          <span>${esc(reason)} · Retry after ${formatTime(until, true)}</span></li>`).join("")}</ul>` : ""}
      <dl>
        <div><dt>Rate limited (429)</dt><dd>${number(provider.rateLimited ?? 0)}</dd></div>
        <div><dt>Overloaded (503)</dt><dd>${number(provider.overloaded ?? 0)}</dd></div>
        <div><dt>Retry requests</dt><dd>${number(provider.retries ?? 0)}</dd></div>
      </dl>
    </div>
  </section>`;
}

function usagePage() {
  const {providers, events, fireworksGrowth, fireworksCooldowns} = data.state.usage;
  return `${heading("Usage", "Provider activity recorded by this workspace.")}
    ${usageGrowth(fireworksGrowth || [])}
    ${fireworksCapacity(providers.find(provider => provider.id === "fireworks"), fireworksCooldowns || [], data.state.settings.fireworksModels || [])}
    <section class="providers" aria-label="Provider usage">
      ${providers.map(provider => `<article class="card provider">
        ${providerHeader(provider)}
        <p>${esc(provider.description)}</p>
        <strong class="provider-value">${number(provider.requests ?? 0)}</strong>
        <p>${plural(provider.requests ?? 0, "request")} · ${number(provider.successes ?? 0)} succeeded · ${number(provider.failures ?? 0)} failed</p>
        ${metricsList(provider.metrics)}
        ${provider.accountUsage ? `<div class="account-usage"><h3>Account usage</h3>
          ${provider.accountUsage.start && provider.accountUsage.end ? `<p>${esc(provider.accountUsage.start.slice(0, 10))} – ${esc(provider.accountUsage.end.slice(0, 10))}</p>` : ""}
          ${metricsList(provider.accountUsage.metrics)}</div>` : ""}
        ${provider.detail ? `<p class="provider-detail">${esc(provider.detail)}</p>` : ""}
        ${provider.id === "archil" && provider.configured ? `<button class="button" data-action="test-provider" data-provider="archil">${iconSpan("refresh")} Refresh account usage</button>` : ""}
      </article>`).join("")}
    </section>
    <section class="card section">${cardHeader("Provider activity", "Requests and metrics returned by connected providers.", link("Manage connections", "settings", "arrow"))}
      ${events.length ? `<div class="scroll-table"><table>
        <thead><tr><th scope="col">Time</th><th scope="col">Provider</th><th scope="col">Operation</th><th scope="col">Result</th><th scope="col">Metrics</th></tr></thead>
        <tbody>${events.map(event => `<tr><td>${formatTime(event.at)}</td><td>${esc(providers.find(provider => provider.id === event.provider)?.name || readable(event.provider))}</td>
          <td>${esc(readable(event.operation))}${event.attempt > 1 ? `<small>Retry attempt ${event.attempt - 1}</small>` : ""}${event.detail ? `<small>${esc(event.detail)}</small>` : ""}</td>
          <td>${event.httpStatus === 429 ? pill("warning", "Rate limited") : event.httpStatus === 503 ? pill("warning", "Overloaded")
            : event.timedOut ? pill("failed", "Timed out") : pill(event.status)}${event.runId ? `<small><a href="#runs/${id(event.runId)}">Open run</a></small>` : ""}</td>
          <td>${event.durationMs != null ? `${number(event.durationMs)} ms` : ""}${metricsList(event.metrics)}</td></tr>`).join("")}</tbody>
      </table></div>` : empty("No provider activity yet", "Usage will appear after a provider is used by this workspace.", "usage")}
    </section>`;
}

function runtimeSettings() {
  const {runtime} = data.state;
  const options = runtime.options?.length ? runtime.options : [{name: "Execution runtime", available: runtime.available, detail: runtime.detail}];
  return `<section class="card">${cardHeader("Execution runtimes", "Each agent needs an available isolated runtime.")}
    ${options.map(option => `<div class="setting-row"><div class="provider-heading">
      ${iconSpan("box", "provider-icon")}<h3>${esc(option.name)}</h3>${pill(option.available ? "connected" : "unavailable", option.available ? "Available" : "Unavailable")}
      </div><p>${esc(option.detail)}</p></div>`).join("")}
  </section>`;
}

function settingsPage() {
  return `${heading("Settings", "Manage credentials and check your execution runtimes.")}
    ${runtimeSettings()}
    <section class="card section">
      ${cardHeader("Provider connections", "Save API credentials to this workspace and test each connection.")}
      ${data.state.settings.providers.map(provider => `<div class="setting-row">
        ${providerHeader(provider)}
        <p>${esc(provider.description)}</p>
        ${provider.detail ? `<p class="provider-detail">${esc(provider.detail)}</p>` : ""}
        <form class="setting-form" data-provider-form="${esc(provider.id)}">
          ${provider.fields.map(field => `<label class="field">
            ${esc(field.label)} <input class="control" name="${esc(field.id)}" ${field.secret === false ? 'type="text"' : 'type="password"'} autocomplete="off"
              ${field.secret === false && field.value != null ? `value="${esc(field.value)}"` : ""}
              placeholder="${esc(field.configured && field.secret !== false ? "Saved · enter to replace" : field.placeholder || "")}">
          </label>`).join("")}
          ${provider.fields.length ? '<button class="button primary" type="submit">Save</button>' : ""}
          <button type="button" class="button" data-action="test-provider" data-provider="${esc(provider.id)}">${iconSpan("refresh")} Test connection</button>
          ${provider.fields.some(field => field.source === "settings") ?
            `<button type="button" class="button destructive" data-action="clear-provider" data-provider="${esc(provider.id)}">Clear saved values</button>` : ""}
        </form>
      </div>`).join("")}
    </section>`;
}

function displayDiff(diff) {
  return `<pre class="diff" aria-label="Unified diff">${diff.split("\n").map(line => {
    const type = line.startsWith("+") && !line.startsWith("+++") ? "addition" : line.startsWith("-") && !line.startsWith("---") ? "deletion" : "";
    return `<span class="${type}">${esc(line) || " "}</span>`;
  }).join("")}</pre>`;
}

function branchDetail(run, branch) {
  if (!branch) return empty("Waiting for branches", "Branches will appear once the run starts.", "branch");
  const tests = branch.tests || [];
  const tabs = ["tests", "diff", "logs"];
  let body;
  if (data.branchTab === "logs") {
    body = logOutput((run.logs || []).filter(log => log.branchId === branch.id));
  } else if (data.branchTab === "diff") {
    body = `<div class="branch-body">
      <p>${plural(branch.files?.length || 0, "file")} · +${number(branch.added || 0)} / −${number(branch.removed || 0)}</p>
      ${branch.diff ? displayDiff(branch.diff) : "<p>No diff recorded yet.</p>"}
    </div>`;
  } else {
    body = `<div class="branch-body">
      ${branch.error ? notice(branch.error) : ""}
      <p>${esc(branch.model)}${branch.hint ? ` · ${esc(branch.hint)}` : ""}</p>
      ${branch.summary ? `<p class="agent-summary">${esc(branch.summary)}</p>` : ""}
      ${tests.length ? tests.map(test => `<details class="test-result">
        <summary><strong>${esc(test.name)}</strong> ${pill(test.status)}</summary>
        <p>Exit code ${esc(test.exitCode ?? "—")} · ${number(test.durationMs ?? "—")} ms</p>
        ${test.error ? `<p>${esc(test.error)}</p>` : ""}
        ${test.output ? `<pre>${esc(test.output)}</pre>` : ""}
      </details>`).join("") : "<p>Verification results will appear here.</p>"}
      ${branch.benchmarkScore != null ? `<p>Benchmark score · ${number(branch.benchmarkScore)}</p>` : ""}
      ${branch.usage?.tokens != null ? `<p>Model tokens used · ${number(branch.usage.tokens)}</p>` : ""}
      ${branch.usage?.cost != null ? `<p>Model cost · $${number(branch.usage.cost)}</p>` : ""}
    </div>`;
  }
  return `<section class="card" aria-label="Branch details">
    ${cardHeader(esc(currentTeamName(branch.teamName) || branch.name), branch.id === run.winner ? "Selected for promotion" : "", pill(branch.status))}
    <div class="tabs" role="tablist" aria-label="Branch detail">
      ${tabs.map(tab => `<button id="branch-tab-${tab}" role="tab" aria-controls="branch-panel" aria-selected="${data.branchTab === tab}" tabindex="${data.branchTab === tab ? "0" : "-1"}" data-action="branch-tab" data-tab="${tab}">${readable(tab)}</button>`).join("")}
    </div>
    <div id="branch-panel" role="tabpanel" aria-labelledby="branch-tab-${data.branchTab}">${body}</div>
  </section>`;
}

function missionDiff(branch, file) {
  const diff = branch?.diff ?? branch?.preview?.diff ?? "";
  if (!diff || !file) return diff;
  const sections = diff.split(/(?=^diff --git )/mu);
  const path = line => {
    const value = line.slice(4).split("\t")[0];
    try { return (value.startsWith('"') ? JSON.parse(value) : value).slice(2); }
    catch { return ""; }
  };
  return sections.find(section => section.split("\n").some(line =>
    (line.startsWith("+++ ") || line.startsWith("--- ")) && path(line) === file
  )) || (sections.length === 1 ? diff : "");
}

function changedFiles(branch) {
  return branch?.diff != null ? branch.files || [] : branch?.preview?.files || branch?.files || [];
}

function selectedBranch(run) {
  const branches = run?.branches || [];
  return branches.find(branch => branch.id === data.branch)
    || branches.find(branch => branch.id === run?.winner)
    || branches.find(branch => changedFiles(branch).length) || branches[0];
}

function workspaceView(run, branch) {
  if (data.workspaceView !== "auto") return data.workspaceView;
  return !run?.testOnly && changedFiles(branch).length && (branch?.diff || branch?.preview?.diff) ? "changes" : "repository";
}

function repositoryKey(run, branch, path) {
  return `${run.id}/${branch?.snapshotTree || run.baseCommit}\0${path}`;
}

async function loadRepositoryEntry(run, branch, path) {
  const key = repositoryKey(run, branch, path);
  const entries = data.repoEntries;
  if (entries.has(key)) return;
  entries.set(key, {});
  const query = new URLSearchParams({path});
  if (branch?.snapshotTree) query.set("branch", branch.id);
  try {
    entries.set(key, {value: await request(`/runs/${id(run.id)}/repository?${query}`)});
  } catch (error) {
    entries.set(key, {error: error.message});
  }
  if (entries === data.repoEntries && ["auto", "repository", "review"].includes(data.workspaceView)) renderPage();
}

function repositoryMessage(entry, path) {
  return entry?.error
    ? `<p class="mission-placeholder">${esc(entry.error)} <button class="button text-button" data-action="retry-repository" data-file="${esc(path)}">Retry</button></p>`
    : '<p class="mission-placeholder" role="status">Loading…</p>';
}

function repositoryFiles(directory, folder, selectedFile) {
  if (!directory?.value) return repositoryMessage(directory, folder);
  const {entries} = directory.value;
  if (!entries) return '<p class="mission-placeholder">This path is no longer a folder.</p>';
  if (!entries.length) return '<p class="mission-placeholder">This folder is empty.</p>';
  return entries.slice().sort((a, b) =>
    Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name)
  ).map(entry => {
    const path = folder ? `${folder}/${entry.name}` : entry.name;
    const isFolder = entry.type === "directory";
    return `<button data-action="${isFolder ? "browse-folder" : "preview-repository"}" data-file="${esc(path)}"${isFolder ? "" : ` aria-pressed="${path === selectedFile}"`}>
      ${iconSpan(isFolder ? "folder" : "file")}<span>${esc(entry.name)}</span>${isFolder ? iconSpan("chevron-right") : ""}
    </button>`;
  }).join("");
}

function repositoryLocation(run, branch) {
  if (data.repoBrowse) return {folder: data.repoFolder, file: data.repoFile};
  let folder = "";
  for (let depth = 0; depth < 4; depth += 1) {
    const entries = data.repoEntries.get(repositoryKey(run, branch, folder))?.value?.entries;
    if (!entries) break;
    const source = entries.find(entry => entry.type === "file" &&
      /\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|cs|cpp?|swift|php|vue|svelte|sql|html)$/iu.test(entry.name) &&
      !/(?:test|spec)[._-]|config\./iu.test(entry.name));
    if (source) return {folder, file: folder ? `${folder}/${source.name}` : source.name};
    const directory = ["src", "app", "lib", "server", "backend", "frontend", "web", "packages"].map(name =>
      entries.find(entry => entry.name === name && entry.type === "directory")).find(Boolean);
    if (!directory || depth === 3) {
      const text = entries.find(entry => entry.type === "file" && /\.(?:[cm]?[jt]sx?|py|go|rs|md|txt)$/iu.test(entry.name));
      return {folder, file: text ? [folder, text.name].filter(Boolean).join("/") : ""};
    }
    folder = [folder, directory.name].filter(Boolean).join("/");
  }
  return {folder, file: ""};
}

function repositoryExplorer(run, branch) {
  if (!run.baseCommit) {
    return `<p class="mission-placeholder">${run.status === "failed" ? "This run has no repository checkpoint." : "Waiting for the repository checkpoint."}</p>`;
  }
  const {folder, file} = repositoryLocation(run, branch);
  const parts = folder ? folder.split("/") : [];
  const directory = data.repoEntries.get(repositoryKey(run, branch, folder));
  const preview = file && data.repoEntries.get(repositoryKey(run, branch, file));
  let contents = directory?.value ? '<p class="mission-placeholder">Select a file to see its code.</p>'
    : '<p class="mission-placeholder" role="status">Opening project files…</p>';
  if (file) {
    const item = preview?.value;
    if (!item) contents = repositoryMessage(preview, file);
    else if (item.type === "submodule") contents = `<p class="mission-placeholder">Submodule at <code>${esc(item.commit)}</code></p>`;
    else if (item.preview) contents = `<p class="mission-placeholder">${item.preview === "binary" ? "Binary file" : "File exceeds the 128 KiB preview limit"} · ${number(item.size)} bytes</p>`;
    else contents = `<pre><code>${esc(item.content)}</code></pre>`;
  }
  return `<div class="repository-explorer">
    <nav class="repository-path" aria-label="Repository path">
      <button data-action="browse-folder" data-file=""${folder ? "" : ' aria-current="location"'}>Root</button>
      ${parts.map((part, index) => `${iconSpan("chevron-right")}<button data-action="browse-folder" data-file="${esc(parts.slice(0, index + 1).join("/"))}"${index === parts.length - 1 ? ' aria-current="location"' : ""}>${esc(part)}</button>`).join("")}
    </nav>
    <div class="repository-entries" data-scroll-path="${esc(folder)}" role="group" aria-label="Repository files">
      ${repositoryFiles(directory, folder, file)}
    </div>
    ${file ? `<div class="repository-filename">${esc(file)}${preview?.value?.type === "symlink" ? " · Symbolic link target" : ""}</div>` : ""}
    <div class="mission-code repository-source" data-scroll-path="${esc(file)}">${contents}</div>
  </div>`;
}

function reviewPoints(branch) {
  return (branch?.council || []).flatMap(member => (member.points || []).map((point, index) => ({
    ...point, key: `${member.id}/${index}`, name: member.name, role: member.role,
  })));
}

function reviewExplorer(run, branch) {
  const points = reviewPoints(branch);
  if (!points.length) return '<p class="mission-placeholder">No line notes recorded for this team.</p>';
  const files = [...new Set(points.map(point => point.path))];
  const file = files.includes(data.reviewFile) ? data.reviewFile : files[0];
  const filePoints = points.filter(point => point.path === file);
  const byLine = new Map();
  for (const point of filePoints) {
    if (!byLine.has(point.line)) byLine.set(point.line, []);
    byLine.get(point.line).push(point);
  }
  const entry = data.repoEntries.get(repositoryKey(run, null, file));
  const content = entry?.value?.content;
  const lines = typeof content === "string" ? content.split(/\r?\n/) : [];
  const limit = Math.max(75, ...filePoints.map(point => point.line + 5));
  return `<div class="workspace-files" aria-label="Reviewed files">${files.map(path =>
    `<button data-action="choose-review-file" data-file="${esc(path)}" aria-pressed="${path === file}">${iconSpan("file")}${esc(path)}</button>`
  ).join("")}</div>
  <div class="review-legend"><span><i class="review-signal strength"></i>Strength</span><span><i class="review-signal concern"></i>Concern</span><span>Checkpoint source</span></div>
  <div class="mission-code review-source" data-scroll-path="${esc(file)}" aria-label="Annotated checkpoint source">
    ${typeof content !== "string" ? entry?.value ? '<p class="mission-placeholder">Source preview unavailable.</p>' : repositoryMessage(entry, file) : lines.slice(0, limit).map((line, index) => {
      const lineNumber = index + 1;
      const notes = byLine.get(lineNumber) || [];
      const active = notes.find(point => point.key === data.reviewPoint);
      return `<div class="review-line"><span class="review-line-number" aria-hidden="true">${lineNumber}</span>
        <span class="review-gutter">${notes.map(point => `<button class="review-marker" data-action="review-marker" data-point="${esc(point.key)}"
          aria-expanded="${point.key === active?.key}" aria-label="${esc(`${readable(point.kind)} from ${point.name}, line ${lineNumber}`)}"
          title="${esc(`${point.name} · ${readable(point.kind)}`)}"><i class="review-signal ${esc(point.kind)}"></i></button>`).join("")}</span>
        <code>${esc(line) || " "}</code></div>
        ${active ? `<div class="review-note ${esc(active.kind)}"><strong>${esc(active.name)} · ${esc(readable(active.kind))}</strong>
          <p>${esc(active.note)}</p></div>` : ""}`;
    }).join("")}
    ${lines.length > limit ? `<p class="mission-placeholder">Showing the first ${limit} lines.</p>` : ""}
  </div>`;
}

const teamProgressStates = {
  queued: {label: "Waiting to start", icon: "clock", tone: "waiting"},
  running: {label: "Working on changes", icon: "activity", tone: "working"},
  evaluating: {label: "Running checks", icon: "search", tone: "working"},
  passed: {label: "Passed all checks", icon: "check", tone: "passed"},
  rejected: {label: "Didn’t pass review", icon: "close", tone: "failed"},
  failed: {label: "Couldn’t finish", icon: "close", tone: "failed"}
};

function missionTeamProgress(run, selected) {
  const branches = run.branches || [];
  if (!branches.length) return "";
  return `<section class="team-progress" aria-labelledby="team-progress-title">
    <h2 id="team-progress-title">Team progress</h2>
    ${branches.length > 1 ? "<p>Choose a team to see its work below.</p>" : ""}
    <div class="mission-team-grid">${branches.map(branch => {
      const progress = teamProgressStates[branch.status] ?? {label: readable(branch.status || "Unknown"), icon: "clock", tone: "waiting"};
      const winner = branch.id === run.winner;
      return `<button type="button" class="team-progress-card branch-link" data-action="choose-branch" data-branch="${esc(branch.id)}"
        aria-pressed="${branch.id === selected?.id}">
        ${iconSpan(winner ? "shield" : progress.icon, `team-progress-icon ${progress.tone}`)}
        <span class="team-progress-copy">
          <strong>${esc(currentTeamName(branch.teamName) || branch.name)}</strong>
          <span>${esc(progress.label)}${winner ? " · Winner" : ""}</span>
        </span>
      </button>`;
    }).join("")}</div>
  </section>`;
}

function missionTeams(run, selected) {
  const branches = (run.branches || []).filter(branch => branch.council?.length);
  if (!branches.length) return "";
  return `<section class="mission-teams" aria-labelledby="mission-teams-title">
    <h2 id="mission-teams-title">Team members</h2>
    <div class="mission-team-grid">${branches.map(branch => {
      const team = currentTeamName(branch.teamName) || branch.name;
      return `<article class="mission-team${branch.id === selected?.id ? " selected" : ""}">
        <header class="team-roster-head">
          <h3>${esc(team)}</h3>${branch.subject ? `<p>${esc(branch.subject)}</p>` : ""}
        </header>
        <div class="team-roster">${branch.council.map(member => `<details data-member="${esc(`${branch.id}/${member.id}`)}" class="team-member ${esc(member.status)}${member.id === "lead" ? " team-lead" : ""}">
          <summary>
            ${iconSpan(`robot-${member.id}`, "team-robot")}
            <span class="member-identity"><strong>${esc(member.name)}</strong><small>${esc(member.role || "Agent")}</small></span>
            ${member.rating ? `<span class="member-rating" title="Self-reported confidence">${esc(member.rating)}/5</span>` : ""}
            <span class="member-signal" title="${esc(readable(member.status))}"><span class="visually-hidden">${esc(readable(member.status))}</span></span>
          </summary>
          <p>${esc(member.recommendation || member.focus || "Waiting for a recommendation.")}</p>
          ${member.points?.length ? `<div class="member-points">${member.points.map((point, index) =>
            `<button data-action="open-review" data-branch="${esc(branch.id)}" data-file="${esc(point.path)}" data-point="${esc(`${member.id}/${index}`)}">
              <i class="review-signal ${esc(point.kind)}"></i>${esc(point.path)}:${esc(point.line)}</button>`).join("")}</div>` : ""}
        </details>`).join("")}</div>
      </article>`;
    }).join("")}</div>
  </section>`;
}

function runStory(run) {
  const teams = run.branches || [];
  const submitted = teams.filter(team => ["evaluating", "passed", "rejected"].includes(team.status)).length;
  const winner = teams.find(team => team.id === run.winner);
  const winnerName = currentTeamName(winner?.teamName) || winner?.name || "The winning team";
  const edited = teams.some(team => changedFiles(team).length);
  switch (run.status) {
    case "queued": return ["Waiting to start", "The run will begin when a workspace is available."];
    case "preparing": return ["Copying the code", run.testOnly ? "Getting the project ready for its checks." : "Each team gets its own copy of the project."];
    case "running":
      if (submitted === teams.length && submitted) return ["Getting ready to check the fixes", "All teams have sent in their work."];
      if (edited) return ["Teams are editing the code", submitted ? `${submitted} of ${teams.length} teams have sent in their work.` : "You can watch their changes below."];
      return ["Teams are working out a fix", "The agents are reading the code and choosing what to change."];
    case "evaluating": return [run.testOnly ? "Checking the project" : "Checking the fixes", run.testOnly ? "The project’s tests are running." : "Each submitted fix goes through the same tests."];
    case "ready": return run.testOnly ? ["The checks passed", "The tests passed on this copy of the project."]
      : [`${winnerName} found a fix that passed`, "Review the code below. The fix is ready to use."];
    case "promoting": return ["Saving the winning fix", "The verified changes are becoming the active version."];
    case "promoted": return ["The winning fix is saved", `${winnerName}’s changes passed the checks and became the active version.`];
    case "failed": return teams.some(team => team.tests?.length)
      ? [run.testOnly ? "The checks failed" : "No fix passed the checks", "Open the test results to see what failed."]
      : ["The run stopped early", "Open the run details to see what stopped it."];
    default: return ["Checking run status", "Updates will appear here."];
  }
}

function runProgress(run) {
  const checked = ["ready", "promoted", "promoting"].includes(run.status) || run.status === "failed" && (run.branches || []).some(team => team.tests?.length);
  const startedChecks = run.status === "evaluating" || checked;
  const steps = [
    ["Copy the code", Boolean(run.baseCommit), run.status === "preparing"],
    ...(!run.testOnly ? [["Try fixes", startedChecks, run.status === "running"]] : []),
    ["Run the checks", checked, run.status === "evaluating"],
  ];
  return `<ol class="run-progress" aria-label="Run progress">${steps.map(([name, done, current], index) =>
    `<li${current ? ' aria-current="step"' : ""}><span class="progress-mark ${done ? "done" : current ? "current" : ""}">${done ? icon("check") : index + 1}</span>
      <span>${name}</span><small>${done ? "Done" : current ? "Now" : run.status === "failed" ? "Skipped" : "Waiting"}</small></li>`).join("")}</ol>`;
}

function missionConsole(run, branch) {
  const branches = run.branches || [];
  const files = changedFiles(branch);
  const view = workspaceView(run, branch);
  const file = files.includes(data.file) ? data.file : files[0];
  const patch = view === "changes" ? missionDiff(branch, file) : "";
  const diff = patch.split("\n").filter(line => !/^(diff --git |index |--- |\+\+\+ |@@ )/.test(line)).join("\n");
  const events = (run.logs || []).slice(-45);
  return `<div class="mission-grid">
    <section class="mission-panel" aria-label="Code">
      <div class="mission-panel-head"><h2>Code</h2>${!run.testOnly && branches.length > 1 ? `<label class="code-team">Team <select id="code-team" aria-label="Team shown in code">${branches.map(team =>
        `<option value="${esc(team.id)}"${team.id === branch?.id ? " selected" : ""}>${esc(currentTeamName(team.teamName) || team.name)}</option>`).join("")}</select></label>` : ""}</div>
      <div class="workspace-views" role="group" aria-label="Workspace view">
        <button data-action="workspace-view" data-tab="repository" aria-pressed="${view === "repository"}">Files</button>
        ${run.testOnly ? "" : `<button data-action="workspace-view" data-tab="changes" aria-pressed="${view === "changes"}">Changes${files.length ? ` (${files.length})` : ""}</button>`}
        <button data-action="workspace-view" data-tab="review" aria-pressed="${view === "review"}">Review${reviewPoints(branch).length ? ` (${reviewPoints(branch).length})` : ""}</button>
        ${view === "repository" && run.baseCommit ? `<span>${branch?.snapshotTree ? "Team snapshot" : "Checkpoint"}</span>` : ""}
      </div>
      ${view === "repository" ? repositoryExplorer(run, branch) : view === "review" ? reviewExplorer(run, branch) : `
      <div class="workspace-files" aria-label="Changed files">${files.length ? files.map(path =>
        `<button data-action="choose-file" data-file="${esc(path)}" aria-pressed="${path === file}">${iconSpan("repo")}${esc(path)}</button>`
      ).join("") : '<p>No changed files yet.</p>'}</div>
      ${diff ? '<div class="code-change-key"><span class="code-added">+ Added</span><span class="code-removed">− Removed</span></div>' : ""}
      <div class="mission-code">${diff ? displayDiff(diff.slice(0, 14000)) :
        `<p class="mission-placeholder">${file ? "No text preview for this file." : "Code changes appear here as the selected agent edits files."}</p>`}</div>
      `}
    </section>
    <section class="mission-panel" aria-label="Run progress and commands">
      <div class="mission-panel-head"><h2>Progress</h2>${link("Full logs", `logs/${id(run.id)}`, "arrow", "text-button")}</div>
      ${runProgress(run)}
      <details class="run-technical"><summary>Agent commands and output</summary>
      <div class="mission-terminal" tabindex="0" aria-label="Latest agent actions">
        ${events.length ? events.map(event => `<div class="terminal-event ${esc(event.stream || "system")}">
          <span>${event.branchId ? esc(currentTeamName(branches.find(item => item.id === event.branchId)?.teamName) || `AGENT ${event.branchId}`) : "SWARM"} <time>${formatTime(event.time, true)}</time></span>
          <div>${esc(String(event.message || "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "").slice(0, 2400))}</div>
        </div>`).join("") : '<p class="mission-placeholder">Waiting for command output.</p>'}
      </div>
      </details>
    </section>
  </div>`;
}

function runPage(run) {
  if (!run) return `${heading("Run details")}${empty("Run unavailable", "The run could not be loaded.", "runs", link("View runs", "runs", "arrow"))}`;
  const branch = selectedBranch(run);
  const configured = data.state.settings.providers.find(provider => provider.id === "archil")?.fields
    .some(field => field.id === "baseSandboxId" && field.configured);
  const deployable = !run.testOnly && configured && ["ready", "promoted"].includes(run.status);
  const extra = deployable ? button("Deploy to Archil", "deploy-run", "up", "primary")
    : !run.testOnly && run.status === "ready" ? button("Promote winner", "promote", "up", "primary") : "";
  const deployment = data.state.deployment?.runId === run.id ? data.state.deployment : null;
  const [story, explanation] = runStory(run);
  return `<section class="mission-stage" aria-label="Swarm run">
    <div class="mission-title">
      <div><p class="mission-kicker"><span></span> ${run.demoKey ? "Archived scripted demo" : run.testOnly ? "Checkpoint test" : run.sampleKey ? "Live sample run" : "Swarm run"} · ${esc(repoLabel(run))}</p>
        <h1>${esc(run.task)}</h1></div>
      <div class="mission-status">${pill(run.status, run.testOnly && run.status === "ready" ? "Checks passed" : "")} ${extra}</div>
    </div>
    <div class="run-story ${esc(run.status)}" aria-label="Current step">
      ${iconSpan(run.status === "failed" ? "close" : ["ready", "promoted"].includes(run.status) ? "check" : "activity", "story-icon")}
      <div><h2>${esc(story)}</h2><p>${esc(explanation)}</p></div>
    </div>
    ${run.error ? notice(run.error) : ""}
    ${deployment ? `<p class="notice success">Deployed to ${esc(deployment.sandbox)} · ${deployment.service ? "Service running" : "Project files"}${deployment.port ? ` · Port ${esc(deployment.port)}` : ""}</p>` : ""}
    ${run.testOnly ? "" : missionTeamProgress(run, branch)}
    ${missionConsole(run, branch)}
    ${missionTeams(run, branch)}
    </section>
    <div class="mission-review">
    ${branchDetail(run, branch)}
    <section class="card section">${cardHeader("Run configuration", "")}
      <dl class="run-config">
        ${run.activeWorkspace ? `<div><dt>Saved workspace</dt><dd><code>${esc(run.activeWorkspace)}</code></dd></div>` : ""}
        <div><dt>Functional test</dt><dd><code>${esc(run.functionalCommand)}</code></dd></div>
        ${run.securityCommand ? `<div><dt>Security test</dt><dd><code>${esc(run.securityCommand)}</code></dd></div>` : ""}
        ${run.benchmarkCommand ? `<div><dt>Benchmark</dt><dd><code>${esc(run.benchmarkCommand)}</code></dd></div>` : ""}
      </dl>
    </section></div>`;
}

function buildDialog(title, subtitle, form, submitLabel, fields, returnToRun = false) {
  dialog.innerHTML = `<form id="${form}">
    <header class="dialog-head"><div><h2 id="dialog-title">${title}</h2><p>${subtitle}</p></div>
      <button type="button" class="button icon-button" data-action="close-dialog" aria-label="Close">${icon("close")}</button></header>
    <div class="dialog-body">${fields}<p class="inline-error" role="alert" hidden></p></div>
    <footer class="dialog-actions">
      <button type="button" class="button" data-action="${returnToRun ? "new-run" : "close-dialog"}">${returnToRun ? "Back" : "Cancel"}</button>
      <button type="submit" class="button primary">${submitLabel}</button>
    </footer>
  </form>`;
  if (!dialog.open) dialog.showModal();
  dialog.querySelector("input:not([type=hidden]),select,textarea")?.focus();
}

function addRepoDialog(returnToRun = false) {
  buildDialog("Add repository", "Connect a Git repository to use for your runs.", "repo-form", "Add repository", `
    <input type="hidden" name="returnToRun" value="${returnToRun}">
    <label class="field">Repository source<input class="control" name="source" required placeholder="https://github.com/owner/repo or /path/to/repo"><small>Enter an HTTPS Git URL or a local repository path on the server.</small></label>
    <div class="form-grid">
      <label class="field">Display name <input class="control" name="name" placeholder="Derived from the repository"></label>
      <label class="field">Git ref <input class="control" name="ref" placeholder="Default branch"></label>
    </div>`, returnToRun);
}

function newRunDialog(repoId = "", plan = null) {
  if (!data.state) {
    toast("Workspace is still connecting.", true);
    return;
  }
  const {repos, runtime, settings} = data.state;
  if (!repos.length) {
    addRepoDialog(true);
    return;
  }
  const provider = settings.providers.find(provider => provider.id === settings.modelProvider);
  const testOnly = plan?.testOnly === true || data.runDraft?.has("testOnly");
  const research = settings.providers.find(provider => provider.id === "keenable");
  const runtimes = runtime.options || [];
  const warnings = [
    !runtime.available ? "Set up an available runtime in Settings." : "",
    !testOnly && provider && !provider.configured ? "Add a Fireworks AI API key in Settings." : ""
  ].filter(Boolean);
  const lastRepo = repoId || data.runDraft?.get("repoId") || data.selectedRepo || repos[0]?.id;
  const samplePreset = !testOnly && !plan && Boolean(repos.find(repo => repo.id === lastRepo)?.demo);
  const sampleRuntime = samplePreset && runtimes.some(option => option.id === "archil" && option.available) ? "archil" : "";
  buildDialog(testOnly ? "Review checkpoint test" : "New swarm run",
    testOnly ? "Run checks against the selected Git checkpoint in isolation." : "Choose a repository and task. Each team has four advisors and a lead.",
    "run-form", testOnly ? "Run checks" : "Launch swarm", `
    ${testOnly ? '<input type="hidden" name="testOnly" value="true">' : ""}
    ${warnings.length ? `<div class="notice">${warnings.join(" ")} ${link("Open Settings", "settings", "arrow", "text-button").replace('href="#settings"', 'href="#settings" data-action="close-dialog"')}</div>` : ""}
    <div class="field"><label for="run-repository">Repository</label>
      <div class="repo-picker">
        <select class="control" id="run-repository" name="repoId" required>${repos.map(repo => `<option value="${esc(repo.id)}"${repo.id === lastRepo ? " selected" : ""}>${esc(repo.name)} · ${esc(repo.ref === "HEAD" ? "default branch" : repo.ref || "default branch")}</option>`).join("")}</select>
        <button type="button" class="button" data-action="add-repo-for-run">${iconSpan("plus")} Add</button>
      </div>
    </div>
    <label class="check-field demo-mode" id="demo-mode" hidden><input type="checkbox" name="demo"> Use sample task and checks</label>
    ${testOnly ? "" : '<label class="field">Task <textarea class="control" name="task" rows="3" required placeholder="Describe the change the agents should make."></textarea></label>'}
    <div class="form-grid">
      ${testOnly ? "" : '<label class="field">Teams <input class="control" name="agentCount" type="number" min="2" max="6" value="3" required></label>'}
      ${runtimes.length ? `<label class="field">Runtime <select class="control" name="runtime">${runtimes.map(option =>
        `<option value="${esc(option.id)}"${option.available ? "" : " disabled"}${option.id === sampleRuntime ? " selected" : ""}>${esc(option.name)}${option.available ? "" : " · Unavailable"}</option>`).join("")}</select></label>` : ""}
    </div>
    <div class="form-grid">
      <label class="field">Functional test command <input class="control" name="functionalCommand" required placeholder="npm test"></label>
      <label class="field">Security test command <input class="control" name="securityCommand" ${testOnly ? "" : "required"} placeholder="npm run test:security"></label>
    </div>
    ${!testOnly && research ? '<label class="check-field"><input type="checkbox" name="research"> Gather research with Keenable <small>Sends the task text to Keenable and gives the teams relevant search excerpts.</small></label>' : ""}
    <label class="check-field"><input type="checkbox" name="dependencyCheck"> Check locked npm dependencies with Casco <small id="casco-help">Sends package names and versions from the root npm lockfile.</small></label>
    <details class="advanced">
      <summary>Advanced options</summary>
      <div class="advanced-fields">
        <label class="field">Benchmark command <input class="control" name="benchmarkCommand" placeholder="npm run benchmark"><small>Optional. Print one nonnegative number to stdout. Lower scores rank first.</small></label>
        <label class="field">Protected paths <textarea class="control" name="protectedPaths" rows="2" placeholder="One path per line"></textarea></label>
        <label class="field">Agent hints <textarea class="control" name="hints" rows="2" placeholder="One optional hint per agent, in order"></textarea></label>
        <label class="field">Agent models <textarea class="control" name="models" rows="2" placeholder="One model ID per agent, in order"></textarea><small>${settings.modelProvider === "fireworks" ? esc(settings.fireworksModels.map(model => model.name).join(" · ")) : "Default model is claude-sonnet-4-6."}</small></label>
      </div>
    </details>`);
  const fromDraft = data.runDraft?.get("repoId") === lastRepo;
  if (data.runDraft) {
    const form = dialog.querySelector("#run-form");
    for (const [key, value] of data.runDraft) {
      if (key === "repoId") continue;
      const field = form.elements.namedItem(key);
      if (!field) continue;
      if (field.type === "checkbox") field.checked = true;
      else field.value = value;
    }
    data.runDraft = null;
  }
  const form = dialog.querySelector("#run-form");
  applyDemoPreset(form, !plan && !fromDraft, !fromDraft);
  if (plan) {
    for (const name of ["task", "functionalCommand", "securityCommand"]) {
      if (form.elements[name]) form.elements[name].value = plan[name] || "";
    }
  }
}

function applyDemoPreset(form, chooseDefault = false, resetResearch = true) {
  const fields = form.elements;
  const repo = data.state.repos.find(item => item.id === fields.repoId.value);
  const demo = fields.testOnly ? null : repo?.demo;
  if (fields.testOnly) {
    form.querySelector(".advanced").hidden = true;
    return;
  }
  form.querySelector("#demo-mode").hidden = !demo;
  if (chooseDefault || !demo) fields.demo.checked = Boolean(demo);
  const preset = Boolean(demo && fields.demo.checked);
  if (fields.research && resetResearch) fields.research.checked = preset;
  fields.dependencyCheck.disabled = preset;
  form.querySelector("#casco-help").textContent = preset
    ? "This sample uses Node.js built-ins and has no npm lockfile."
    : "Sends package names and versions from the root npm lockfile.";
  for (const name of ["task", "functionalCommand", "securityCommand"]) {
    if (preset) fields[name].value = demo[name];
    fields[name].readOnly = preset;
  }
  if (preset) fields.agentCount.value = "3";
  fields.agentCount.readOnly = preset;
  form.querySelector(".advanced").hidden = preset;
}

function renderPage() {
  const {page, param} = route();
  const mission = page === "runs" && Boolean(param);
  navigation.innerHTML = Object.entries(navItems).map(([key, [name, glyph]]) =>
    `<a href="#${key}"${key === page ? ' aria-current="page"' : ""}>${iconSpan(glyph)}${name}</a>`).join("");
  main.classList.toggle("flight-main", page === "overview");
  main.classList.toggle("mission-main", mission);
  document.title = `${navItems[page][0]} · Matrix Swarm`;
  const ready = data.state && !data.error;
  sidebar.innerHTML = `<div class="connection-state"><span class="state-dot${ready ? "" : " offline"}"></span>${ready ? "Local online" : data.error ? "Offline" : "Connecting"}</div>`;
  if (!data.state) {
    main.innerHTML = data.error ? `${heading(navItems[page][0])}${notice(data.error)}` : '<div class="loading" role="status">Connecting to the workspace…</div>';
    return;
  }
  const views = {overview, repositories: repositoriesPage, logs: logsPage, usage: usagePage, settings: settingsPage};
  const run = page === "overview" ? currentFlight() : mission ? findRun(decodeURIComponent(param)) : null;
  const content = page === "runs" ? (mission ? runPage(run) : runsPage()) : views[page]();
  const scrollTarget = main.querySelector(".log-view, .diff");
  const previousScroll = scrollTarget?.scrollTop || 0;
  const technicalOpen = Boolean(main.querySelector(".run-technical")?.open);
  const openTests = [...main.querySelectorAll(".test-result")].map(test => test.open);
  const openMembers = new Set([...main.querySelectorAll(".team-member[open]")].map(member => member.dataset.member));
  const codeTeamFocused = document.activeElement?.id === "code-team";
  const oldTerminal = main.querySelector(".mission-terminal");
  const terminalScroll = oldTerminal?.scrollTop || 0;
  const followOutput = !oldTerminal || oldTerminal.scrollHeight - terminalScroll - oldTerminal.clientHeight < 36;
  const repositoryScroll = [...main.querySelectorAll("[data-scroll-path]")];
  const activeElement = document.activeElement;
  const focusedControl = main.contains(activeElement) ? activeElement.dataset : null;
  const focusedMember = main.contains(activeElement) ? activeElement.closest(".team-member")?.dataset.member : null;
  const view = document.createElement("template");
  view.innerHTML = (data.error ? notice(data.error) : "") + content;
  const canvas = view.content.querySelector("#flight-canvas");
  const scopeKey = canvas ? `${page}/${run?.id || ""}` : null;
  if (flightScope && flightScope.key !== scopeKey) {
    flightScope.dispose();
    flightScope = undefined;
  }
  if (flightScope) canvas.replaceWith(flightScope.canvas);
  main.replaceChildren(view.content);
  if (canvas && !flightScope) {
    const controller = mountFlightScope(canvas);
    if (controller) flightScope = {key: scopeKey, canvas, ...controller};
  }
  flightScope?.update(run);
  if (page === "logs") refreshLogOutput();
  if (page === "usage") drawGrowth();
  const nextScroll = main.querySelector(".log-view, .diff");
  if (nextScroll) nextScroll.scrollTop = previousScroll;
  const technical = main.querySelector(".run-technical");
  if (technical) technical.open = technicalOpen;
  if (codeTeamFocused) main.querySelector("#code-team")?.focus({preventScroll: true});
  const terminal = main.querySelector(".mission-terminal");
  if (terminal) terminal.scrollTop = followOutput ? terminal.scrollHeight : terminalScroll;
  for (const panel of main.querySelectorAll("[data-scroll-path]")) {
    const previous = repositoryScroll.find(item => item.className === panel.className && item.dataset.scrollPath === panel.dataset.scrollPath);
    if (previous) panel.scrollTo(previous.scrollLeft, previous.scrollTop);
  }
  if (focusedControl?.branch || focusedControl?.file !== undefined || focusedControl?.tab || focusedControl?.point) {
    const replacement = [...main.querySelectorAll("button[data-action]")].find(item =>
      item.dataset.action === focusedControl.action && item.dataset.branch === focusedControl.branch &&
      item.dataset.file === focusedControl.file && item.dataset.tab === focusedControl.tab && item.dataset.point === focusedControl.point);
    replacement?.focus({preventScroll: true});
  }
  main.querySelectorAll(".test-result").forEach((test, index) => { test.open = openTests[index] ?? false; });
  main.querySelectorAll(".team-member").forEach(member => {
    member.open = openMembers.has(member.dataset.member);
    if (!focusedControl?.action && member.dataset.member === focusedMember) member.querySelector("summary")?.focus({preventScroll: true});
  });
  if (mission && run?.baseCommit && workspaceView(run, selectedBranch(run)) === "repository") {
    const branch = selectedBranch(run);
    const {folder, file} = repositoryLocation(run, branch);
    void loadRepositoryEntry(run, branch, folder);
    if (file) void loadRepositoryEntry(run, branch, file);
  }
  if (mission && run?.baseCommit && data.workspaceView === "review") {
    const files = reviewPoints(selectedBranch(run)).map(point => point.path);
    const file = files.includes(data.reviewFile) ? data.reviewFile : files[0];
    if (file) void loadRepositoryEntry(run, null, file);
    if (data.reviewJump) {
      const marker = [...main.querySelectorAll(".review-marker")].find(button => button.dataset.point === data.reviewPoint);
      if (marker) {
        data.reviewJump = false;
        marker.scrollIntoView({block: "nearest"});
        marker.focus({preventScroll: true});
      }
    }
  }
}

function downloadLogs() {
  const logs = filteredLogs();
  if (!logs.length) {
    toast("There are no matching log entries.");
    return;
  }
  const lines = logs.map(log => `[${log.time || log.at}] [${log.source}] ${log.message}`).join("\n");
  const url = URL.createObjectURL(new Blob([lines], {type: "text/plain"}));
  const anchor = Object.assign(document.createElement("a"), {href: url, download: "matrix-swarm-logs.txt"});
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function poll() {
  if (data.busy) return;
  data.busy = true;
  const current = route();
  const runId = current.page === "runs" && current.param ? decodeURIComponent(current.param) : null;
  const requests = [request("/state")];
  if (runId) requests.push(request(`/runs/${id(runId)}`));
  if (current.page === "logs") requests.push(request("/logs"));
  try {
    const [stateResult, detailResult] = await Promise.allSettled(requests);
    if (stateResult.status !== "fulfilled") throw stateResult.reason;
    const state = stateResult.value;
    const changed = JSON.stringify(state) !== JSON.stringify(data.state) || Boolean(data.error);
    data.state = state;
    data.error = "";
    if (current.page !== route().page || current.param !== route().param || current.branch !== route().branch) return;
    if (runId) {
      const nextRun = detailResult.status === "fulfilled" ? detailResult.value : null;
      const updated = JSON.stringify(nextRun) !== JSON.stringify(data.run);
      data.run = nextRun;
      if (changed || updated) renderPage();
    } else if (current.page === "logs") {
      const logs = detailResult.status === "fulfilled" ? detailResult.value.logs || [] : [];
      const nextLogs = logs.map(log => {
        const run = state.runs.find(run => run.id === log.runId);
        const branch = run?.branches?.find(branch => branch.id === log.branchId);
        return {...log, source: [run?.task.slice(0, 24) || log.runId, branch?.name || log.branchId, log.stream].filter(Boolean).join(" · ")};
      });
      const logError = detailResult.status === "rejected" ? detailResult.reason.message : "";
      const logsChanged = JSON.stringify(data.logs) !== JSON.stringify(nextLogs) || data.logError !== logError;
      data.logs = nextLogs;
      data.logError = logError;
      if (changed && !main.contains(document.activeElement)) renderPage();
      else if (logsChanged) {
        const view = document.querySelector("#log-output .log-view");
        const top = view?.scrollTop || 0;
        refreshLogOutput();
        const newView = document.querySelector("#log-output .log-view");
        if (newView) newView.scrollTop = top;
      }
    } else if (changed && (current.page !== "settings" || !main.contains(document.activeElement))) {
      renderPage();
    }
  } catch (error) {
    if (data.error !== error.message) {
      data.error = error.message;
      renderPage();
    }
  } finally {
    data.busy = false;
  }
}

async function withButton(button, action) {
  if (button) button.disabled = true;
  try {
    await action();
  } finally {
    if (button) button.disabled = false;
  }
}

function openChat() {
  if (!data.state) return toast("Workspace is still connecting.", true);
  const selector = chatDialog.querySelector("#chat-repo");
  const current = route();
  const run = current.page === "runs" && current.param ? findRun(decodeURIComponent(current.param)) : null;
  const repoId = run?.repoId || selector.value || data.selectedRepo;
  selector.replaceChildren(new Option("Choose a repository", ""));
  for (const repo of data.state.repos) selector.add(new Option(repo.name, repo.id));
  selector.value = repoId || "";
  chatDialog.dataset.runId = run?.id || "";
  chatDialog.showModal();
}

function appendChat(role, text) {
  const item = document.createElement("article");
  item.className = `chat-message ${role}`;
  const label = document.createElement("strong");
  label.textContent = role === "user" ? "You" : "Matrix";
  const body = document.createElement("p");
  body.textContent = text;
  item.append(label, body);
  const log = chatDialog.querySelector(".chat-history");
  log.append(item);
  log.scrollTop = log.scrollHeight;
  return item;
}

chatDialog.querySelector("#chat-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const field = form.elements.message;
  const text = field.value.trim();
  if (!text || field.disabled) return;
  const user = { role: "user", content: text };
  const repoId = chatDialog.querySelector("#chat-repo").value;
  const runId = chatDialog.dataset.runId;
  appendChat(user.role, user.content);
  field.value = "";
  field.disabled = true;
  const pending = chatDialog.querySelector(".chat-status");
  pending.textContent = "Waiting for Fireworks…";
  try {
    await withButton(form.querySelector("button"), async () => {
      const result = await request("/chat", "POST", { repoId, runId, messages: [...chatMessages.slice(-10), user] });
      chatMessages.push(user, { role: "assistant", content: result.reply });
      if (chatMessages.length > 12) chatMessages.splice(0, chatMessages.length - 12);
      const item = appendChat("assistant", result.reply);
      if (result.plan) {
        const review = document.createElement("button");
        review.type = "button";
        review.className = "button";
        review.textContent = result.plan.testOnly ? "Review test run" : "Review swarm run";
        review.addEventListener("click", () => {
          chatDialog.close();
          newRunDialog(result.plan.repoId, result.plan);
        });
        item.append(review);
      }
      if (result.runId) {
        const anchor = document.createElement("a");
        anchor.href = `#runs/${id(result.runId)}`;
        anchor.textContent = "Open recorded results";
        anchor.addEventListener("click", () => chatDialog.close());
        item.append(anchor);
      }
      item.scrollIntoView({block: "end"});
    });
  } catch (error) {
    appendChat("assistant", error.message);
    field.value = text;
  } finally {
    pending.textContent = "";
    field.disabled = false;
    if (chatDialog.open) field.focus();
  }
});

async function formSubmit(event) {
  const form = event.target;
  if (form !== dialog.querySelector("form") && !form.matches("[data-provider-form]")) return;
  event.preventDefault();
  const values = new FormData(form);
  const text = name => String(values.get(name) ?? "").trim();
  const lines = name => {
    const entries = String(values.get(name) ?? "").split(/\r?\n/).map(line => line.trim());
    while (entries.length && !entries.at(-1)) entries.pop();
    return entries;
  };
  const errorTarget = form.querySelector(".inline-error");
  try {
    await withButton(form.querySelector("[type=submit]"), async () => {
      if (form.id === "repo-form") {
        const repo = await request("/repos", "POST", {source: text("source"), name: text("name"), ref: text("ref")});
        data.state.repos = [...data.state.repos.filter(item => item.id !== repo.id), repo];
        data.selectedRepo = repo.id;
        renderPage();
        toast("Repository added.");
        if (text("returnToRun") === "true") newRunDialog(repo.id);
        else dialog.close();
      } else if (form.id === "run-form") {
        const run = await request("/runs", "POST", {
          repoId: text("repoId"),
          demo: values.has("demo"),
          testOnly: values.has("testOnly"),
          runtime: text("runtime") || undefined,
          task: text("task"),
          agentCount: Number(text("agentCount")),
          functionalCommand: text("functionalCommand"),
          securityCommand: text("securityCommand"),
          benchmarkCommand: text("benchmarkCommand") || undefined,
          protectedPaths: lines("protectedPaths").filter(Boolean),
          hints: lines("hints"),
          models: lines("models"),
          research: values.has("research"),
          dependencyCheck: values.has("dependencyCheck")
        });
        data.selectedRepo = text("repoId");
        data.runDraft = null;
        data.state.runs = [run, ...data.state.runs.filter(item => item.id !== run.id)];
        dialog.close();
        data.launchId = run.id;
        location.hash = `runs/${id(run.id)}`;
        toast(run.testOnly ? "Checkpoint test started." : "Swarm run started.");
      } else if (form.id === "deploy-form") {
        const result = await request(`/runs/${id(text("runId"))}/deploy`, "POST", {
          command: text("command"), port: text("port") ? Number(text("port")) : undefined,
          reuse: values.has("reuse"),
        });
        data.run = result.run;
        data.state.deployment = result.deployment;
        dialog.close();
        renderPage();
        toast(`Verified project deployed to ${result.deployment.sandbox}.`);
        await poll();
      } else if (form.id === "reset-repo-form") {
        const {repo} = await request(`/repos/${id(text("repoId"))}/reset`, "POST");
        data.state.repos = data.state.repos.map(item => item.id === repo.id ? repo : item);
        delete data.state.active[repo.id];
        dialog.close();
        renderPage();
        toast("Repository reset to its registered ref.");
        await poll();
      } else {
        const provider = data.state.settings.providers.find(item => item.id === form.dataset.providerForm);
        const valuesToSave = Object.fromEntries(provider.fields.filter(field => text(field.id) && (field.secret !== false || text(field.id) !== field.value)).map(field => [field.id, text(field.id)]));
        if (!Object.keys(valuesToSave).length) {
          toast("Enter a value to save.");
          return;
        }
        data.state.settings = await request("/settings", "PATCH", {provider: provider.id, values: valuesToSave});
        renderPage();
        toast("Settings saved.");
        await poll();
      }
    });
  } catch (error) {
    if (errorTarget) {
      errorTarget.textContent = error.message;
      errorTarget.hidden = false;
    } else {
      toast(error.message, true);
    }
  }
}

async function handleAction(event) {
  const element = event.target.closest("[data-action]");
  if (!element) return;
  const {action, provider, repo, branch, tab} = element.dataset;
  if (action === "open-chat") openChat();
  if (action === "new-run") newRunDialog();
  if (action === "run-repo") newRunDialog(repo);
  if (action === "reset-repo") {
    const selected = data.state.repos.find(item => item.id === repo);
    if (!selected) return;
    buildDialog(`Reset ${esc(selected.name)}?`, "Future runs will start from the registered Git ref.", "reset-repo-form", "Reset repository",
      `<input type="hidden" name="repoId" value="${esc(selected.id)}">`);
  }
  if (action === "add-repo") addRepoDialog();
  if (action === "add-repo-for-run") {
    data.runDraft = new FormData(dialog.querySelector("#run-form"));
    addRepoDialog(true);
  }
  if (action === "close-dialog") dialog.close();
  if (action === "download-logs") downloadLogs();
  if (action === "deploy-run") {
    const runId = decodeURIComponent(route().param);
    const run = data.run?.id === runId ? data.run : data.state.runs.find(item => item.id === runId);
    const previous = data.state.deployment;
    const reusable = previous?.repoId === run?.repoId && previous?.service;
    buildDialog("Deploy verified winner", "Activate this release in your configured Archil sandbox.", "deploy-form", "Deploy to Archil",
      `<input type="hidden" name="runId" value="${esc(runId)}">
      ${previous?.service ? `<div class="notice">This will replace the running Matrix Swarm service in ${esc(previous.sandbox)}.</div>` : ""}
      ${reusable ? '<label class="check-field"><input type="checkbox" name="reuse" checked> Keep the current service command</label>' : ""}
      <label class="field">Start command <input class="control" name="command" placeholder="npm start"><small>${reusable ? "Enter a command to override the existing one." : "Optional. Leave blank to deploy the files."}</small></label>
      <label class="field">Local health-check port <input class="control" name="port" type="number" min="1" max="65535" placeholder="3000"><small>Optional. Matrix Swarm checks this port inside the sandbox.</small></label>`);
  }
  if (action === "choose-review-file") {
    data.reviewFile = element.dataset.file;
    data.reviewPoint = "";
    data.reviewJump = false;
    renderPage();
  }
  if (action === "review-marker") {
    const point = element.dataset.point;
    data.reviewPoint = data.reviewPoint === point ? "" : point;
    renderPage();
  }
  if (action === "open-review") {
    data.branch = branch;
    data.reviewFile = element.dataset.file;
    data.reviewPoint = element.dataset.point;
    data.reviewJump = true;
    data.workspaceView = "review";
    renderPage();
  }
  if (action === "choose-file") {
    data.file = element.dataset.file;
    renderPage();
  }
  if (action === "workspace-view") {
    data.workspaceView = tab;
    renderPage();
  }
  if (action === "browse-folder") {
    data.repoBrowse = true;
    const folder = element.dataset.file;
    data.repoFolder = folder;
    data.repoFile = "";
    renderPage();
  }
  if (action === "preview-repository") {
    data.repoBrowse = true;
    data.repoFile = element.dataset.file;
    data.repoFolder = data.repoFile.split("/").slice(0, -1).join("/");
    renderPage();
  }
  if (action === "retry-repository") {
    const run = findRun(decodeURIComponent(route().param));
    data.repoEntries.delete(repositoryKey(run, data.workspaceView === "review" ? null : selectedBranch(run), element.dataset.file));
    renderPage();
  }
  if (action === "choose-branch") {
    data.branch = branch;
    data.file = "";
    data.reviewPoint = "";
    data.reviewJump = false;
    renderPage();
    [...main.querySelectorAll(".branch-link")].find(item => item.dataset.branch === branch)?.focus();
  }
  if (action === "branch-tab") {
    data.branchTab = tab;
    renderPage();
    document.getElementById(`branch-tab-${tab}`)?.focus();
  }
  try {
    if (action === "promote") {
      const runId = decodeURIComponent(route().param);
      await withButton(element, async () => {
        data.run = await request(`/runs/${id(runId)}/promote`, "POST");
        renderPage();
        toast("Verified branch promoted.");
      });
      await poll();
    }
    if (action === "test-provider") {
      await withButton(element, async () => {
        const result = await request(`/settings/${id(provider)}/test`, "POST");
        const details = result.provider || result;
        toast(details.detail || "Connection check complete.", ["error", "unavailable"].includes(details.status));
      });
      await poll();
      renderPage();
    }
    if (action === "clear-provider") {
      const current = data.state.settings.providers.find(item => item.id === provider);
      await withButton(element, async () => {
        data.state.settings = await request("/settings", "PATCH", {
          provider, values: Object.fromEntries(current.fields.map(field => [field.id, null]))
        });
        renderPage();
        toast("Saved settings cleared.");
      });
      await poll();
    }
  } catch (error) {
    toast(error.message, true);
  }
}

function onRouteChange() {
  const current = route();
  const mission = current.page === "runs" && Boolean(current.param);
  const intro = mission && current.param === data.launchId;
  data.launchId = null;
  showRain(mission ? "mission" : current.page === "overview" ? "control" : "", intro);
  data.branch = current.page === "runs" ? current.branch || null : null;
  data.file = "";
  data.workspaceView = "auto";
  data.repoBrowse = false;
  data.repoFolder = "";
  data.repoFile = "";
  data.repoEntries = new Map();
  data.reviewFile = "";
  data.reviewPoint = "";
  data.reviewJump = false;
  data.branchTab = "tests";
  data.logRun = current.page === "logs" && current.param ? decodeURIComponent(current.param) : "";
  renderPage();
  if (intro) window.scrollTo(0, 0);
  void poll();
}

document.addEventListener("submit", formSubmit);
document.addEventListener("click", handleAction);
document.addEventListener("input", event => {
  const target = event.target;
  if (target.id === "log-search") {
    data.logText = target.value;
    refreshLogOutput();
  }
});
document.addEventListener("change", event => {
  const target = event.target;
  if (target.id === "code-team") {
    data.branch = target.value;
    data.file = "";
    data.reviewPoint = "";
    data.reviewJump = false;
    renderPage();
  }
  if (target.form?.id === "run-form" && ["repoId", "demo"].includes(target.name)) {
    applyDemoPreset(target.form, target.name === "repoId");
  }
  if (target.id === "log-run" || target.id === "log-stream") {
    if (target.id === "log-run") data.logRun = target.value;
    else data.logStream = target.value;
    refreshLogOutput();
  }
});
document.addEventListener("keydown", event => {
  const tab = event.target.closest('[role="tab"]');
  if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...tab.parentElement.querySelectorAll('[role="tab"]')];
  const offset = event.key === "ArrowLeft" ? -1 : 1;
  const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (tabs.indexOf(tab) + offset + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[index].click();
});
dialog.addEventListener("close", () => { data.runDraft = null; });
window.addEventListener("hashchange", onRouteChange);
onRouteChange();
setInterval(poll, 1500);
