/* ============================================================
   Application state and the small amount of it that is persisted.

   One mutable object, deliberately. Everything that renders reads
   from here, and every loader writes to here and then asks the
   router to redraw — there is no second source of truth to drift.

   `requestSeq` is the guard against stale renders: every async load
   takes a ticket before it starts and drops its result if a newer
   ticket was issued while it was in flight. Without it, clicking
   through three sessions quickly paints whichever backend call
   happened to finish last.
   ============================================================ */

(function (ASM) {
  "use strict";

  const PREFIX = "asm.";

  function stored(name, fallback = null) {
    const value = localStorage.getItem(PREFIX + name);
    if (value !== null) return value;
    // Migrate settings written by the pre-rename builds.
    const legacy = localStorage.getItem("csm." + name);
    if (legacy !== null) localStorage.setItem(PREFIX + name, legacy);
    return legacy !== null ? legacy : fallback;
  }

  function storeJSON(name, value) {
    localStorage.setItem(PREFIX + name, JSON.stringify(value));
  }

  function readJSON(name, fallback) {
    try {
      const value = JSON.parse(stored(name, "null"));
      return value == null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  // The scope is not remembered between launches: every run starts on the
  // native machine and a WSL distribution is enabled for that run only, so a
  // choice made weeks ago can never boot a distro at startup. Drop what
  // earlier builds stored.
  for (const key of ["asm.enabledSources", "asm.source", "csm.enabledSources", "csm.source"]) {
    try { localStorage.removeItem(key); } catch { /* storage can be unavailable */ }
  }

  const State = {
    /* -- scope ---------------------------------------------------------- */
    agent: stored("agent", "all"),                  // all | claude | codex
    source: "windows",                              // set from getAppInfo at boot
    localSource: "windows",
    sources: [],
    enabledSources: new Set(["windows"]),

    /* -- data ----------------------------------------------------------- */
    projects: [],
    sessions: [],
    globalStats: null,
    detail: null,
    transcript: null,
    memory: null,
    settings: null,
    configFiles: [],
    statuslineStatus: null,
    shells: null,
    cleanup: null,
    assets: null,
    tune: null,
    trace: null,             // machine-wide skills / agents / kills / interruptions
    searchResults: null,
    searchQuery: "",

    /* -- selection ------------------------------------------------------ */
    projectId: null,
    sessionId: null,
    view: "overview",        // overview | activity | monitor | cleanup | tune | settings | session | project | memory | search
    tab: stored("tab", "summary"),
    search: "",

    /* -- dashboard controls --------------------------------------------- */
    period: stored("period", "30"),                 // 7 | 30 | 90 | all
    breakdown: stored("breakdown", "model"),        // model | project — the spend chart's stacks
    projectSort: "recent",                          // recent | cost | duration | errors
    traceFilter: { kind: "", query: "" },
    traceLimit: 200,

    /* -- sidebar browser ------------------------------------------------ */
    browseMode: stored("browseMode", "recent"),     // recent | projects
    sessionFilter: stored("sessionFilter", "all"),  // all | active | idle
    sessionSort: stored("sessionSort", "recent"),   // recent | context | turns | cost
    sidebarCollapsed: stored("sidebarCollapsed", "0") === "1",
    expandedProjects: new Set(),
    browseLimit: 120,
    cursorIndex: -1,
    browseRows: [],
    recent: null,            // all sessions across projects, for the recent list

    /* -- session tabs --------------------------------------------------- */
    openTabs: readJSON("openTabs", []),             // [{pid, sid, title, provider}]

    /* -- journey -------------------------------------------------------- */
    goalIndex: null,        // the selected /goal run
    promptIndex: null,      // the selected prompt inside it
    goalFilter: new Set(),   // categories toggled *off*
    goalSort: "order",       // order | duration | tools | errors

    /* -- multiselect (cleanup + bulk delete) ---------------------------- */
    sel: new Map(),
    assetSel: new Map(),
    selectMode: false,

    /* -- cleanup -------------------------------------------------------- */
    cleanupSort: "size",
    cleanupLimit: 300,
    cleanupMode: "sessions",
    cleanupFilters: { query: "", age: 0, minSize: 0, maxTurns: -1, state: "active", asset: "" },
    cleanupFilterSets: {
      sessions: { query: "", age: 0, minSize: 0, maxTurns: -1, state: "active", asset: "" },
      assets: { query: "", age: 0, minSize: 0, maxTurns: -1, state: "all", asset: "" },
    },

    /* -- palette -------------------------------------------------------- */
    paletteMode: "all",
    paletteIndex: 0,
    paletteEntries: [],

    /* -- app ------------------------------------------------------------ */
    appVersion: "0.0.0",
    update: null,
    updateBusy: "",
    updateRequested: false,
    overviewDirty: false,
    liveRefreshInFlight: false,
    liveRefreshQueued: false,
    indexing: null,          // {provider, source, done, total} while the backend parses cold files
    loading: { overview: false, stats: false, recent: false, trace: false },
    showNoise: false,
    theme: stored("theme", "dark"),

    /* -- stale-render guard --------------------------------------------- */
    requestSeq: { overview: 0, stats: 0, project: 0, session: 0, search: 0, cleanup: 0, recent: 0, trace: 0 },
  };

  /* ---------- persistence helpers ---------- */

  const persist = {
    set(name, value) { localStorage.setItem(PREFIX + name, String(value)); },
    json: storeJSON,
    tabs() {
      storeJSON("openTabs", State.openTabs.slice(0, 12));
    },
  };

  /* ---------- selection keys ---------- */

  function selKey(pid, sid, provider, source) {
    const src = source || String(pid).split("::", 1)[0] || State.source;
    return [src, provider || State.agent, pid, sid].join("␟");
  }

  function isSelected(pid, sid, provider, source) {
    return State.sel.has(selKey(pid, sid, provider, source));
  }

  function toggleSelected(record) {
    const key = selKey(record.pid, record.sid, record.provider || State.agent, record.source_id);
    if (State.sel.has(key)) State.sel.delete(key);
    else State.sel.set(key, record);
  }

  function clearSelection() { State.sel.clear(); }

  function selectionTotals() {
    let cost = 0;
    let bytes = 0;
    for (const record of State.sel.values()) {
      cost += record.cost || 0;
      bytes += record.bytes || 0;
    }
    return { count: State.sel.size, cost, bytes };
  }

  function selectionItems() {
    return [...State.sel.values()].map((record) => ({
      provider: record.provider || State.agent,
      source_id: record.source_id || String(record.pid).split("::", 1)[0],
      project_id: record.pid,
      session_id: record.sid,
    }));
  }

  /** The source ids a backend call should scan, as the bridge expects them. */
  function sourceScope() {
    return JSON.stringify(sourceIds());
  }

  /** The same ids, one per call, so a slow source never delays a fast one. */
  function sourceIds() {
    const ids = State.source === "all" ? [...State.enabledSources] : [State.source];
    return ids.length ? ids : [State.localSource];
  }

  function currentProject() {
    return State.projects.find((project) => project.id === State.projectId) || null;
  }

  function currentSession() {
    return State.sessions.find((session) => session.session_id === State.sessionId) || null;
  }

  /** Which agent owns what is on screen — never a guess when it is knowable. */
  function currentProvider() {
    const session = currentSession();
    const project = currentProject();
    return (session && session.provider) || (project && project.provider) ||
      (State.agent === "all" ? "claude" : State.agent);
  }

  /** Whether dollar figures mean anything for what is on screen. */
  function priced(provider) {
    return (provider || State.agent) !== "codex";
  }

  ASM.state = State;
  ASM.stored = stored;
  ASM.persist = persist;
  ASM.scope = {
    selKey, isSelected, toggleSelected, clearSelection, selectionTotals,
    selectionItems, sourceScope, sourceIds, currentProject, currentSession, currentProvider, priced,
  };

  ASM.AGENTS = {
    claude: { label: "Claude Code", short: "Claude", home: "~/.claude", command: "claude" },
    codex: { label: "Codex", short: "Codex", home: "$CODEX_HOME", command: "codex" },
    all: { label: "All agents", short: "All", home: "", command: "" },
  };
  ASM.agentInfo = function agentInfo(provider) {
    return ASM.AGENTS[provider || State.agent] || ASM.AGENTS.claude;
  };
})(window.ASM = window.ASM || {});
