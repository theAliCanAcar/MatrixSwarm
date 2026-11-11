const paths = {
  "robot-build": '<path d="M6 8h12l2 4v6H4v-6l2-4Zm6-5v5m-2-5h4M4 12H2m18 0h2m-13 3h6m-8 3v3m10-3v3"/><path d="M8 11v1m8-1v1"/>',
  "robot-security": '<path d="M12 3 20 6v7c0 4-5 7-8 8-3-1-8-4-8-8V6l8-3Z"/><path d="M8 9h8v5H8zM10 16h4m-4-5h.1m4 0h.1"/>',
  "robot-tests": '<path d="M7 7h10l3 4v6l-3 3H7l-3-3v-6l3-4Zm5-4v4m-4 7h2l1-3 2 5 1-2h2"/><circle cx="12" cy="3" r="1"/>',
  "robot-review": '<path d="M5 6h14l2 5v5l-4 3H7l-4-3v-5l2-5Zm-2 7h5m8 0h5"/><circle cx="12" cy="13" r="3"/><path d="M12 11v4m-2-2h4"/>',
  "robot-lead": '<path d="m12 3 8 5v8l-8 5-8-5V8l8-5Zm-5 7h10v4H7zm5-7V1m-4 19-2 2m10-2 2 2M9 12h.1m6 0h.1"/><path d="M10 17h4"/>',
  swarm: '<path d="M7 8.5 12 6l5 2.5v7L12 18l-5-2.5zM7 8.5l5 2.7 5-2.7M12 11.2V18"/><path d="M12 3v1m8.5 3-.9.5m.9 9.5-.9-.5M12 20v1M3.5 17l.9-.5m-.9-9.5.9.5"/>',
  overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  runs: '<path d="M4 7h16M4 12h16M4 17h11"/><path d="M3 4h18v16H3z" opacity=".5"/>',
  log: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  usage: '<path d="M4 19h16M7 15v-4m5 4V6m5 9V9"/>',
  settings: '<path d="M10 3h4l.6 2.1 1.7 1 2.2-.6 2 3.4-1.6 1.6v2l1.6 1.6-2 3.4-2.2-.6-1.7 1L14 20h-4l-.6-2.1-1.7-1-2.2.6-2-3.4 1.6-1.6v-2L3.5 9l2-3.4 2.2.6 1.7-1z"/><circle cx="12" cy="11.5" r="2.8"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  'chevron-right': '<path d="m9 6 6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M4 12h15m-5-5 5 5-5 5"/>',
  repo: '<path d="M5 18.5V6a2 2 0 0 1 2-2h12v15H7a2 2 0 0 1 0-4h12M8 8h7m-7 3h4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  file: '<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 7v10m12-9c0 5-4 6-12 6"/>',
  shield: '<path d="m12 3 8 3v5c0 5-3.8 8.4-8 10-4.2-1.6-8-5-8-10V6z"/><path d="m8.6 11.8 2.4 2.4 4.5-4.6"/>',
  activity: '<path d="M3 12h5l2-6 4 12 2-6h5"/>',
  box: '<path d="m4 7 8-4 8 4v10l-8 4-8-4zM4 7l8 4 8-4m-8 4v10"/>',
  search: '<circle cx="10.5" cy="10.5" r="5.8"/><path d="m15 15 4.5 4.5"/>',
  key: '<circle cx="8" cy="8" r="4.2"/><path d="m11 11 8 8m-3-3 2-2m-5-1 2-2"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12 4 4 10-10"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18m-9-9c4 4 4 14 0 18m0-18c-4 4-4 14 0 18"/>',
  spark: '<path d="M12 2c0 6-4 10-10 10 6 0 10 4 10 10 0-6 4-10 10-10-6 0-10-4-10-10z"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 8a8 8 0 0 1 13-2l2 6M4 12l2 6a8 8 0 0 0 13-2"/>',
  up: '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 17v3h16v-3"/>'
};

export function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.box}</svg>`;
}

export function iconSpan(name, className = "") {
  return `<span class="${className}" data-icon="${name}">${icon(name)}</span>`;
}
