const slots = ["build", "security", "tests", "review", "lead"];

const teams = [
  ["Engineering Team", "Implementation & architecture", [
    ["Anvil", "Software Architect", "Find the relevant interfaces and design the smallest coherent implementation."],
    ["Aegis", "API Engineer", "Preserve input and output contracts, including invalid input and error behavior."],
    ["Gauge", "Integration Engineer", "Trace downstream callers and identify how to verify the integration."],
    ["Specter", "Code Reviewer", "Look for unnecessary changes, brittle assumptions, and maintainability risks."],
    ["Cortex", "Technical Lead", "Choose a focused implementation that fits the repository and preserves its contracts."],
  ]],
  ["Security Team", "Security & abuse resistance", [
    ["Solder", "Application Security Engineer", "Identify trust boundaries and propose validation at the correct layer."],
    ["Rampart", "Threat Modeler", "Describe the realistic attacker, entry points, and consequences of failure."],
    ["Probe", "Penetration Tester", "Find bypasses and adversarial inputs the implementation must reject."],
    ["Trace", "Security Reviewer", "Check for unsafe defaults, leaked information, and regressions in existing controls."],
    ["Relay", "Security Lead", "Select a plan that closes the relevant abuse paths and keeps legitimate use working."],
  ]],
  ["Quality Team", "Quality & regression coverage", [
    ["Torque", "QA Engineer", "Map the requested behavior to reproducible success and failure cases."],
    ["Warden", "Compatibility Engineer", "Find platform, version, and caller compatibility risks."],
    ["Quanta", "Test Automation Engineer", "Choose fast, deterministic checks and keep the existing test configuration intact."],
    ["Lens", "Defect Analyst", "Explain the likely root cause and how to distinguish it from similar failures."],
    ["Nexus", "Quality Lead", "Choose the implementation with the clearest evidence of correctness and regression coverage."],
  ]],
  ["Phase", "Performance & efficiency", [
    ["Rivet", "Performance Engineer", "Identify bottlenecks introduced or removed by the task and propose a measurable improvement."],
    ["Citadel", "Concurrency Engineer", "Review contention, ordering, and behavior with simultaneous requests."],
    ["Tally", "Benchmark Engineer", "Specify how to measure the effect using representative workloads."],
    ["Scope", "Resource Analyst", "Check allocations, I/O, and growth under larger inputs."],
    ["Axiom", "Performance Lead", "Choose a measured improvement that preserves correctness and readability."],
  ]],
  ["Prism", "Reliability & operations", [
    ["Forge", "Reliability Engineer", "Identify failure modes and design safe recovery behavior."],
    ["Shield", "Resilience Engineer", "Look for timeout, retry, and partial-failure risks."],
    ["Pulse", "Observability Engineer", "Identify useful diagnostics and verification signals without exposing sensitive data."],
    ["Beacon", "Operations Engineer", "Check that the change is easy to run, troubleshoot, and roll back."],
    ["Vector", "Reliability Lead", "Choose the safest operational plan and explain its recovery behavior."],
  ]],
  ["Helix", "Delivery & compatibility", [
    ["Flux", "Release Engineer", "Identify the smallest independently deployable change."],
    ["Bastion", "Build Engineer", "Check toolchain and dependency assumptions across supported environments."],
    ["Metric", "Acceptance Engineer", "Define the acceptance checks needed before release."],
    ["Optic", "Migration Engineer", "Check backward compatibility and rollout sequencing."],
    ["Prime", "Delivery Lead", "Select a release-ready approach with clear verification and rollback steps."],
  ]],
];

export function assembleTeam(index) {
  const [teamName, subject, roster] = teams[index % teams.length];
  return {
    teamName, subject,
    council: roster.map(([name, role, focus], slot) => ({
      id: slots[slot], name, role, focus, status: "queued",
    })),
  };
}
