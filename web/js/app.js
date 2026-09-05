/* ============================================================
   The router: chrome, navigation, data loading, event delegation,
   keyboard, live refresh and boot.

   Loading is progressive. Boot fires every independent request at
   once and each paints its own region when it lands: the project
   list, the recent sessions, the dashboard figures. Nothing waits
   for the slowest scan, and while a cold index runs the status bar
   shows how far it is.

   Rendering is coarse on purpose — a view is a pure function of
   state and the router replaces one pane's innerHTML — but the
   session inspector re-renders only its tab body on a live tick, so
   a running session never resets the reader's scroll or selection.

   Every async load takes a ticket from State.requestSeq before it
   starts and discards its result if a newer ticket was issued while
   it was in flight. Clicking through sessions quickly must not paint
   whichever backend call happened to return last.
   ============================================================ */

(function (ASM) {
  "use strict";

  const { esc, fmt, dom, clamp, debounce, throttle, raf } = ASM.util;
  const ui = ASM.ui;
  const scope = ASM.scope;
  const State = ASM.state;
  const call = (...args) => ASM.api.call(...args);

  const MAX_BROWSER_TRANSCRIPT_EVENTS = 1200;
  const MIN_MAIN_WIDTH = 420;
  const SIDEBAR = { css: "--sidebar-width", storage: "asm.sidebarWidth", default: 300, min: 220, max: 520 };
  const SESSION_TABS = ["summary", "timeline", "transcript", "trace", "subagents", "tasks", "workspace", "images", "details"];

  const VIEWS = [
    ["overview", "Overview", "◱"],
    ["sessions", "Sessions", "◈"],
    ["activity", "Activity", "◎"],
    ["monitor", "Monitor", "◉"],
    ["cleanup", "Cleanup", "⌫"],
    ["tune", "Instructions", "✎"],
    ["settings", "Settings", "⚙"],
  ];

  const SHORTCUTS = [
    ["Command launcher", "Ctrl K"],
    ["Quick open a session", "Ctrl P"],
    ["Filter the sidebar", "Ctrl F"],
    ["Search all history", "Ctrl Shift F"],
    ["Previous / next session", "[ / ]"],
    ["Move in the sidebar", "↑ / ↓"],
    ["Open the highlighted row", "Enter"],
    ["Refresh data", "F5"],
    ["New agent session", "Ctrl N"],
    ["Resume this session", "Ctrl Enter"],
    ["Overview · Activity · Monitor · Cleanup · Instructions", "Ctrl 1…5"],
    ["Settings", "Ctrl ,"],
    ["Toggle the sidebar", "Ctrl B"],
    ["Toggle light / dark", "Ctrl Shift L"],
    ["Cycle session tabs", "Ctrl Tab"],
    ["Save the open editor", "Ctrl S"],
    ["Close or clear", "Esc"],
    ["This reference", "?"],
  ];

  State.sorts = State.sorts || {};
  State.timing = { boot: Math.round(performance.now()) };

  function markTiming(key) {
    if (State.timing[key] == null) State.timing[key] = Math.round(performance.now());
  }

  /* ================================================================ */
  /* chrome                                                            */
  /* ================================================================ */

  function renderChrome() {
    renderRail();
    renderPickers();
    renderTabs();
    renderStatus();
  }

  function railActive() {
    if (["session", "project", "memory"].includes(State.view)) return "sessions";
    if (State.view === "search") return "overview";
    return State.view;
  }

  function renderRail() {
    const rail = dom.id("view-rail");
    if (!rail) return;
    const active = railActive();
    rail.innerHTML = VIEWS.map(([key, label, glyph]) =>
      `<button class="rail-btn ${key === active ? "active" : ""}" data-action="nav" data-view="${key}"
        title="${esc(label)}" aria-current="${key === active ? "page" : "false"}">
        <span class="rb-glyph" aria-hidden="true">${glyph}</span><span class="rb-label">${esc(label)}</span></button>`).join("");
  }

  function renderPickers() {
    const agent = dom.id("agent-switch");
    if (agent) agent.value = State.agent;
    const source = dom.id("source-switch");
    if (source) {
      const enabled = State.sources.filter((item) => State.enabledSources.has(item.id));
      source.innerHTML = `${enabled.length > 1 ? `<option value="all">All enabled</option>` : ""}${
        State.sources.map((item) => `<option value="${esc(item.id)}" ${State.enabledSources.has(item.id) ? "" : "disabled"}>
          ${esc(item.label)}${State.enabledSources.has(item.id) ? "" : " (off)"}</option>`).join("")}`;
      source.value = State.source;
      source.hidden = State.sources.length <= 1;
    }
  }

  function renderTabs() {
    const strip = dom.id("session-tabs");
    if (!strip) return;
    if (!State.openTabs.length) { strip.classList.add("hidden"); strip.innerHTML = ""; return; }
    strip.classList.remove("hidden");
    strip.innerHTML = State.openTabs.map((tab) =>
      `<button class="session-tab ${tab.sid === State.sessionId && State.view === "session" ? "active" : ""} ${esc(tab.provider || "")}"
        data-action="open-session" data-pid="${esc(tab.pid)}" data-sid="${esc(tab.sid)}" title="${esc(tab.title)}">
        <span class="st-dot"></span><span class="st-label">${esc(tab.title)}</span>
        <span class="st-close" data-action="close-tab" data-sid="${esc(tab.sid)}" title="Close">×</span></button>`).join("");
    const active = strip.querySelector(".session-tab.active");
    if (active) active.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function renderStatus() {
    const scopeText = dom.id("status-scope");
    const summary = dom.id("status-summary");
    const project = scope.currentProject();
    const environment = State.source === "all"
      ? "All enabled"
      : ((State.sources.find((item) => item.id === State.source) || {}).label || State.source);
    if (scopeText) {
      scopeText.textContent = `${environment} · ${ASM.agentInfo(State.agent).short} · ${project ? project.name : "All projects"}`;
    }
    if (!summary) return;
    if (State.indexing && State.indexing.total > State.indexing.done) {
      const which = State.indexing.provider === "codex" ? "Codex" : "Claude";
      summary.innerHTML = `<span class="spinner"></span> Indexing ${esc(which)} sessions · ${State.indexing.done} of ${State.indexing.total}`;
      return;
    }
    if (State.view === "session" && State.sessionId) {
      const session = scope.currentSession() || {};
      const detail = State.detail || {};
      const analytics = detail.analytics || {};
      summary.textContent = `${session.active ? "live · " : ""}${fmt.hours(analytics.active_ms || session.active_ms)} active · ` +
        `${fmt.tokens((detail.usage || session.usage || {}).total)} tokens${session.provider === "codex" ? "" : ` · ${fmt.cost(detail.cost != null ? detail.cost : session.cost)}`}`;
    } else if (project) {
      summary.textContent = `${fmt.plural(State.sessions.length, "session")}${project.provider === "codex" ? "" : ` · ${fmt.cost(project.total_cost)}`}`;
    } else {
      const stats = State.globalStats;
      summary.textContent = stats
        ? `${fmt.plural(State.projects.length, "project")} · ${fmt.plural(stats.sessions, "session")} · ${fmt.hours(stats.active_ms)} with agents`
        : `${fmt.plural(State.projects.length, "project")} · indexing…`;
    }
  }

  function refreshUpdatePill() {
    const pill = dom.id("update-pill");
    if (!pill) return;
    const available = !!(State.update && State.update.ok !== false && State.update.update_available);
    pill.hidden = !available;
    if (available) pill.textContent = `Update ${State.update.latest}`;
  }

  /* ================================================================ */
  /* rendering                                                         */
  /* ================================================================ */

  function mainView() {
    switch (State.view) {
      case "settings": return ASM.views.settings.render();
      case "monitor": return ASM.views.monitor.render();
      case "cleanup": return ASM.views.cleanup.render();
      case "tune": return ASM.views.tune.render();
      case "activity": return ASM.views.activity.render();
      case "search": return ASM.views.misc.searchView();
      case "memory": return ASM.views.misc.memoryView();
      case "session": return ASM.views.session.render();
      case "project": return ASM.views.overview.projectView();
      default: return ASM.views.overview.render();
    }
  }

  let renderedAt = "";

  function renderMain() {
    const pane = dom.id("main-pane");
    if (!pane) return;
    hideTip();
    pane.innerHTML = `<div class="view">${mainView()}</div>`;
    // A new place starts at the top; a re-render of the same place keeps the
    // reader where they were.
    const key = `${State.view}:${State.projectId || ""}:${State.sessionId || ""}`;
    if (key !== renderedAt) pane.scrollTop = 0;
    renderedAt = key;
    dom.enhance(pane);
    if (State.view === "session") ASM.views.session.mountTab();
    renderChrome();
  }

  /** Redraw only the session tab body — used by Journey's own interactions. */
  function renderTab() {
    const body = dom.id("tab-body");
    if (!body || State.view !== "session") { renderMain(); return; }
    hideTip();
    body.innerHTML = ASM.views.session.tabBody();
    dom.enhance(body);
    ASM.views.session.mountTab();
    dom.all(".tab").forEach((element) => {
      const active = element.dataset.tab === State.tab;
      element.classList.toggle("active", active);
      element.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  /** Redraw the session header facts without touching the tab body. */
  function renderSessionHead() {
    const head = dom.q(".session-head");
    if (!head || State.view !== "session") return;
    head.outerHTML = ASM.views.session.header();
    dom.enhance(dom.q(".session-head"));
  }

  function renderSidebar() { ASM.views.sidebar.render(); }

  function renderAll() {
    renderSidebar();
    renderMain();
  }

  /* ================================================================ */
  /* the shared hover readout                                          */
  /* ================================================================ */

  let tipElement = null;
  let tipTarget = null;

  function tipNode() {
    if (!tipElement) {
      tipElement = document.createElement("div");
      tipElement.className = "tip";
      tipElement.hidden = true;
      document.body.appendChild(tipElement);
    }
    return tipElement;
  }

  function showTip(target, x, y) {
    const text = target.getAttribute("data-tip");
    if (!text) return;
    const node = tipNode();
    node.replaceChildren();
    const lines = text.split("\n").filter((line) => line.length);
    lines.forEach((line, index) => {
      const row = document.createElement(index === 0 ? "strong" : "span");
      row.textContent = line;
      node.appendChild(row);
    });
    node.hidden = false;
    placeTip(x, y);
  }

  function placeTip(x, y) {
    const node = tipNode();
    if (node.hidden) return;
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    let left = x + 12;
    let top = y - height - 12;
    if (left + width > window.innerWidth - 8) left = x - width - 12;
    if (top < 8) top = y + 16;
    node.style.left = `${Math.max(6, left)}px`;
    node.style.top = `${Math.max(6, top)}px`;
  }

  function hideTip() {
    if (tipElement) tipElement.hidden = true;
    tipTarget = null;
  }

  document.addEventListener("mousemove", (event) => {
    const target = event.target.closest && event.target.closest("[data-tip]");
    if (!target) { if (tipTarget) hideTip(); return; }
    if (target !== tipTarget) { tipTarget = target; showTip(target, event.clientX, event.clientY); }
    else placeTip(event.clientX, event.clientY);
  });
  document.addEventListener("mouseleave", hideTip);
  document.addEventListener("scroll", hideTip, true);
  document.addEventListener("focusin", (event) => {
    const target = event.target.closest && event.target.closest("[data-tip]");
    if (!target) return;
    const rect = target.getBoundingClientRect();
    tipTarget = target;
    showTip(target, rect.left + rect.width / 2, rect.top);
  });
  document.addEventListener("focusout", hideTip);

  /* ================================================================ */
  /* sidebar sizing                                                    */
  /* ================================================================ */

  let sidebarCustomised = localStorage.getItem(SIDEBAR.storage) !== null;

  function savedSidebarWidth() {
    const value = Number(localStorage.getItem(SIDEBAR.storage));
    return Number.isFinite(value) && value > 0 ? clamp(value, SIDEBAR.min, SIDEBAR.max) : SIDEBAR.default;
  }

  function sidebarBounds() {
    const body = dom.q(".body");
    const available = body ? body.clientWidth - MIN_MAIN_WIDTH - 6 : SIDEBAR.max;
    const max = Math.max(SIDEBAR.min, Math.min(SIDEBAR.max, available));
    return { min: SIDEBAR.min, max };
  }

  function setSidebarWidth(value, persist = false) {
    const bounds = sidebarBounds();
    const width = Math.round(clamp(Number(value) || SIDEBAR.default, bounds.min, bounds.max));
    document.documentElement.style.setProperty(SIDEBAR.css, width + "px");
    const grip = dom.id("sidebar-grip");
    if (grip) {
      grip.setAttribute("aria-valuemin", String(bounds.min));
      grip.setAttribute("aria-valuemax", String(bounds.max));
      grip.setAttribute("aria-valuenow", String(width));
    }
    if (persist) {
      localStorage.setItem(SIDEBAR.storage, String(width));
      sidebarCustomised = true;
    }
    return width;
  }

  function resetSidebarWidth() {
    localStorage.removeItem(SIDEBAR.storage);
    sidebarCustomised = false;
    setSidebarWidth(SIDEBAR.default);
  }

  function initPaneResizers() {
    setSidebarWidth(savedSidebarWidth());
    const grip = dom.id("sidebar-grip");
    if (!grip) return;
    let drag = null;

    grip.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || window.innerWidth <= 860) return;
      const sidebar = dom.id("sidebar");
      drag = { startX: event.clientX, startWidth: sidebar.getBoundingClientRect().width };
      grip.dataset.active = "true";
      document.body.classList.add("resizing");
      event.preventDefault();
    });
    window.addEventListener("mousemove", (event) => {
      if (!drag) return;
      setSidebarWidth(drag.startWidth + event.clientX - drag.startX);
    });
    const finish = () => {
      if (!drag) return;
      const sidebar = dom.id("sidebar");
      setSidebarWidth(sidebar.getBoundingClientRect().width, true);
      drag = null;
      delete grip.dataset.active;
      document.body.classList.remove("resizing");
      if (ASM.views.journey) ASM.views.journey.redraw();
    };
    window.addEventListener("mouseup", finish);
    window.addEventListener("blur", finish);
    grip.addEventListener("dblclick", resetSidebarWidth);
    grip.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Home") { resetSidebarWidth(); return; }
      const sidebar = dom.id("sidebar");
      const direction = event.key === "ArrowRight" ? 1 : -1;
      setSidebarWidth(sidebar.getBoundingClientRect().width + direction * (event.shiftKey ? 32 : 12), true);
    });

    window.addEventListener("resize", raf(() => {
      setSidebarWidth(sidebarCustomised ? savedSidebarWidth() : SIDEBAR.default);
    }));
  }

  /* ================================================================ */
  /* loaders                                                           */
  /* ================================================================ */

  /**
   * Call once per enabled source. `argsFor` receives one source's scope JSON
   * and returns the call's arguments. `onPart(found)` runs each time a source
   * answers, so the Windows figures paint while a WSL walk is still under
   * way; the promise resolves with every answer once the last one lands.
   */
  async function perSource(method, argsFor, onPart) {
    const found = [];
    await Promise.all(scope.sourceIds().map(async (id) => {
      const part = await call(method, ...argsFor(JSON.stringify([id])));
      if (!part) return;
      found.push(part);
      if (onPart) onPart(found);
    }));
    return found;
  }

  /** The answer for the native machine when several sources answered. */
  function localPart(found) {
    return found.find((item) => (item.sources || []).some((source) => source.kind === "local")) || found[0];
  }

  async function loadSources(refresh = false) {
    if (!ASM.api.isLive()) return;
    const data = await call(refresh ? "refreshSources" : "getSources");
    State.sources = (data && data.sources) || [{ id: "windows", label: "Windows", kind: "local", available: true }];
    const known = new Set(State.sources.map((source) => source.id));
    State.enabledSources = new Set([...State.enabledSources].filter((id) => known.has(id)));
    const local = State.sources.find((source) => source.kind === "local") || State.sources[0];
    if (local) State.enabledSources.add(local.id);
    if (State.source !== "all" && !State.enabledSources.has(State.source)) {
      State.source = local ? local.id : "windows";
    }
    renderPickers();
  }

  /** The project list — the Projects browser and the dashboard's roll-ups. */
  async function loadOverview() {
    if (!ASM.api.isLive()) return;
    const ticket = ++State.requestSeq.overview;
    State.loading.overview = true;
    await perSource("getProviderOverview", (id) => [State.agent, id], (found) => {
      if (ticket !== State.requestSeq.overview) return;
      State.loading.overview = false;
      markTiming("projects");
      State.projects = found.flatMap((item) => item.projects || [])
        .sort((a, b) => (b.last_activity || 0) - (a.last_activity || 0));
      const first = localPart(found);
      State.agentHome = first.home;
      State.claudeHome = first.claude_home || State.claudeHome;
      State.codexHome = first.codex_home || State.codexHome;
      State.overviewDirty = false;
      if (State.browseMode === "projects") renderSidebar();
      if (State.view === "overview" || State.view === "activity") renderMain();
      else renderChrome();
    });
    if (ticket !== State.requestSeq.overview) return;
    // No source answered: stop the skeletons rather than leave them shimmering.
    if (State.loading.overview) { State.loading.overview = false; renderSidebar(); renderChrome(); }
  }

  /** The dashboard figures: spend, time, reliability, skills and agents. */
  async function loadStats() {
    if (!ASM.api.isLive()) return;
    const ticket = ++State.requestSeq.stats;
    State.loading.stats = true;
    await perSource("getProviderGlobalStats", (id) => [State.agent, id], (found) => {
      if (ticket !== State.requestSeq.stats) return;
      State.loading.stats = false;
      markTiming("stats");
      State.globalStats = found.length === 1 ? found[0] : mergeStats(found);
      if (State.view === "overview" || State.view === "activity") renderMain();
      else renderChrome();
    });
    if (ticket !== State.requestSeq.stats) return;
    if (State.loading.stats) { State.loading.stats = false; renderChrome(); }
  }

  /** Fold per-source stats payloads into one, the way the bridge does. */
  function mergeStats(parts) {
    const out = JSON.parse(JSON.stringify(parts[0]));
    const days = new Map((out.daily || []).map((day) => [day.d, day]));
    const tables = { skills: {}, agents: {}, commands: {} };
    for (const table of Object.keys(tables)) Object.assign(tables[table], out[table] || {});
    for (const part of parts.slice(1)) {
      for (const key of ["cost", "sessions", "active", "prompts", "turns", "tool_calls", "subagent_sessions",
        "tool_errors", "compactions", "active_ms", "kills", "interrupts", "cache_savings"]) {
        out[key] = (Number(out[key]) || 0) + (Number(part[key]) || 0);
      }
      for (const [key, value] of Object.entries(part.usage || {})) out.usage[key] = (out.usage[key] || 0) + value;
      for (const [model, values] of Object.entries(part.by_model || {})) {
        const bucket = out.by_model[model] || (out.by_model[model] = { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 });
        for (const key of ["input", "output", "cache_read", "cache_write", "total", "cost"]) bucket[key] = (bucket[key] || 0) + (values[key] || 0);
      }
      for (const [name, count] of Object.entries(part.tool_counts || {})) out.tool_counts[name] = (out.tool_counts[name] || 0) + count;
      (part.activity || []).forEach((row, day) => row.forEach((count, hour) => { out.activity[day][hour] += count; }));
      for (const day of part.daily || []) {
        const bucket = days.get(day.d);
        if (!bucket) { days.set(day.d, JSON.parse(JSON.stringify(day))); continue; }
        for (const key of ["cost", "tokens", "turns", "prompts", "errors", "active_ms", "sessions"]) bucket[key] += day[key] || 0;
        for (const [model, cost] of Object.entries(day.models || {})) bucket.models[model] = (bucket.models[model] || 0) + cost;
      }
      out.by_project = (out.by_project || []).concat(part.by_project || []);
      for (const table of Object.keys(tables)) {
        for (const [name, row] of Object.entries(part[table] || {})) {
          const bucket = tables[table][name] || (tables[table][name] = { count: 0, sessions: 0, projects: 0, last: 0 });
          bucket.count += row.count; bucket.sessions += row.sessions; bucket.projects += row.projects;
          bucket.last = Math.max(bucket.last, row.last);
        }
      }
      if (part.first_activity && (!out.first_activity || part.first_activity < out.first_activity)) out.first_activity = part.first_activity;
    }
    out.daily = [...days.values()].sort((a, b) => a.d.localeCompare(b.d));
    out.by_project.sort((a, b) => (b.last_activity || 0) - (a.last_activity || 0));
    Object.assign(out, tables);
    return out;
  }

  /** Every session on the machine — the Recent sidebar, Monitor and Cleanup need it. */
  async function loadRecent(force = false) {
    if (!ASM.api.isLive()) return;
    if (State.recent && !force) return;
    const ticket = ++State.requestSeq.recent;
    State.loading.recent = true;
    await perSource("getProviderAllSessions", (id) => [State.agent, id], (found) => {
      if (ticket !== State.requestSeq.recent) return;
      State.loading.recent = false;
      markTiming("recent");
      State.recent = found.flatMap((item) => item.sessions || []);
      if (State.browseMode === "recent") renderSidebar();
      if (State.view === "monitor") renderMain();
    });
    if (ticket !== State.requestSeq.recent) return;
    if (State.loading.recent) {
      State.loading.recent = false;
      State.recent = State.recent || [];
      if (State.browseMode === "recent") renderSidebar();
    }
  }

  async function loadProjectSessions(projectId) {
    const ticket = ++State.requestSeq.project;
    const project = State.projects.find((item) => item.id === projectId);
    const provider = (project && project.provider) || (State.agent === "all" ? "claude" : State.agent);
    const data = await call("getProviderSessions", provider, projectId);
    if (ticket !== State.requestSeq.project) return false;
    State.sessions = (data && data.sessions) || [];
    return true;
  }

  async function loadMemory(projectId) {
    State.memory = await call("getMemory", projectId);
    State._memFile = null;
    renderMain();
  }

  async function loadSettings() {
    const source = State.sources.find((item) => item.id === State.source);
    if (State.source === "all" || (source && source.kind === "wsl")) {
      State.settings = { source_only: true };
      State.configFiles = [];
      renderMain();
      return;
    }
    if (State.agent === "all") {
      State.settings = {};
      State.configFiles = [];
      renderMain();
      return;
    }
    renderMain();
    const [settings, statusline, files] = await Promise.all([
      State.agent === "codex" ? call("getCodexSettings") : call("getSettings"),
      State.agent === "claude" ? call("statuslineStatus") : Promise.resolve(null),
      State.agent === "codex"
        ? call("listCodexConfigFiles", ((scope.currentProject() || {}).path) || "")
        : call("listConfigFiles"),
    ]);
    State.settings = settings;
    State.statuslineStatus = statusline;
    State.configFiles = (files && files.files) || [];
    renderMain();
  }

  async function loadMonitor() {
    renderMain();
    loadRecent();
    const source = State.sources.find((item) => item.id === State.source);
    if (State.agent !== "claude" || State.source === "all" || (source && source.kind === "wsl")) {
      State.shells = { snapshots: [], envs: [] };
      renderMain();
      return;
    }
    const [settings, shells] = await Promise.all([call("getSettings"), call("getShells")]);
    State.settings = settings || State.settings;
    State.shells = shells || State.shells;
    renderMain();
  }

  async function loadCleanup() {
    const ticket = ++State.requestSeq.cleanup;
    State.cleanup = null;
    State.assets = null;
    State.assetSel.clear();
    State.cleanupLimit = 300;
    scope.clearSelection();
    renderMain();
    if (!ASM.api.isLive()) {
      const sessions = State.recent || [];
      State.cleanup = { sessions, total_bytes: sessions.reduce((sum, item) => sum + (item.size_bytes || 0) + (item.extra_bytes || 0), 0), cost_available: State.agent === "claude" };
      renderMain();
      return;
    }
    const found = await perSource("getProviderAllSessions", (id) => [State.agent, id]);
    if (ticket !== State.requestSeq.cleanup || State.view !== "cleanup") return;
    State.cleanup = {
      sessions: found.flatMap((item) => item.sessions || []),
      total_bytes: found.reduce((sum, item) => sum + (item.total_bytes || 0), 0),
      cost_available: State.agent === "claude",
    };
    renderMain();
  }

  async function loadTune() {
    if (State.agent !== "claude") { State.tune = {}; renderMain(); return; }
    const source = State.sources.find((item) => item.id === State.source);
    if (State.source === "all" || (source && source.kind === "wsl")) {
      State.tune = { source_readonly: true };
      renderMain();
      return;
    }
    if (!State.tune || State.tune.source_readonly || !State.tune.mode) {
      State.tune = {
        mode: "guidance", scope: "global",
        projectId: (State.projects[0] || {}).id || "",
        instruction: "", sessions: null, guidance: null, proposal: null,
        notes: null, noteSel: new Set(), busy: false, jobId: null, cost: 0, error: null,
      };
    }
    renderMain();
    if (!State.tune.sessions) {
      const found = await perSource("getProviderAllSessions", (id) => ["claude", id]);
      State.tune.sessions = found.flatMap((item) => item.sessions || []);
    }
    await ASM.views.tune.refreshGuidance();
    renderMain();
  }

  /** Skills, agents, kills and interruptions across every session. */
  async function loadTrace(force = false) {
    if (!ASM.api.isLive()) return;
    if (State.trace && !force) return;
    const ticket = ++State.requestSeq.trace;
    State.loading.trace = true;
    const found = await perSource("getTrace", (id) => [State.agent, id, 600]);
    if (ticket !== State.requestSeq.trace) return;
    State.loading.trace = false;
    State.trace = { events: found.flatMap((item) => item.events || []).sort((a, b) => (b.t || 0) - (a.t || 0)) };
    if (State.view === "activity") renderMain();
  }

  /* ================================================================ */
  /* navigation                                                        */
  /* ================================================================ */

  function detailSignature(detail) {
    return [
      detail.total_events || 0,
      (detail.usage || {}).total || 0,
      ((detail.scratchpad && detail.scratchpad.files) || []).length,
      (detail.goals && detail.goals.count) || 0,
      (detail.requests && detail.requests.count) || 0,
      ((detail.trace && detail.trace.events) || []).length,
    ].join(":");
  }

  function rememberTab(session) {
    const title = session.title || session.first_prompt || "Untitled session";
    State.openTabs = [{ pid: State.projectId, sid: session.session_id, title, provider: session.provider }]
      .concat(State.openTabs.filter((tab) => tab.sid !== session.session_id))
      .slice(0, 12);
    ASM.persist.tabs();
  }

  async function openSession(projectId, sessionId, options = {}) {
    closePalette();
    if (projectId && projectId !== State.projectId) {
      State.projectId = projectId;
      State.expandedProjects.add(projectId);
      const fresh = await loadProjectSessions(projectId);
      if (!fresh) return;
    }
    const ticket = ++State.requestSeq.session;
    State.sessionId = sessionId;
    State.view = "session";
    State.goalIndex = null;
    State.promptIndex = null;
    if (options.tab) State.tab = options.tab;
    if (!SESSION_TABS.includes(State.tab)) State.tab = "summary";
    State.detail = null;
    renderSidebar();
    renderMain();   // header from the summary, skeleton body

    const session = State.sessions.find((item) => item.session_id === sessionId) || {};
    const provider = session.provider || scope.currentProvider();
    const detail = await call("getProviderSessionDetail", provider, State.projectId, sessionId);
    if (ticket !== State.requestSeq.session || State.sessionId !== sessionId) return;

    State.detail = detail || {};
    State.transcript = {
      events: (detail && detail.events) || [],
      start: (detail && detail.events_start) || 0,
      total: (detail && detail.total_events) || 0,
    };
    trimTranscript();
    State._detailSig = detailSignature(State.detail);
    if (session.session_id) rememberTab(session);
    renderMain();
  }

  function trimTranscript() {
    const window_ = State.transcript;
    if (!window_ || window_.events.length <= MAX_BROWSER_TRANSCRIPT_EVENTS) return;
    const removed = window_.events.length - MAX_BROWSER_TRANSCRIPT_EVENTS;
    window_.events.splice(0, removed);
    window_.start += removed;
    window_.trimmed = true;
  }

  async function toggleProject(projectId) {
    const wasOpen = State.expandedProjects.has(projectId);
    if (wasOpen && State.projectId === projectId && State.view === "project") {
      State.expandedProjects.delete(projectId);
      renderSidebar();
      return;
    }
    State.expandedProjects.add(projectId);
    State.projectId = projectId;
    State.sessionId = null;
    State.detail = null;
    State.transcript = null;
    State.view = "project";
    ASM.api.send("leaveSession");
    renderSidebar();
    renderMain();
    await loadProjectSessions(projectId);
    renderSidebar();
    renderMain();
  }

  async function selectProject(projectId) {
    State.browseMode = "projects";
    ASM.persist.set("browseMode", "projects");
    await toggleProject(projectId);
  }

  async function navigate(view) {
    closePalette();
    if (State.view === "session" && view !== "session") {
      ASM.api.send("leaveSession");
    }
    if (view === "sessions") {
      // The rail's "Sessions" means "take me back to my work", so it restores
      // whatever was open rather than dumping the user on an empty pane.
      if (State.sessionId && State.detail) { State.view = "session"; renderMain(); return; }
      if (State.projectId) { State.view = "project"; renderMain(); return; }
      const last = State.openTabs[0];
      if (last) { await openSession(last.pid, last.sid); return; }
      await loadRecent();
      const newest = (State.recent || [])[0];
      if (newest) { await openSession(newest.project_id, newest.session_id); return; }
      State.view = "overview";
      renderMain();
      return;
    }

    State.view = view;
    State.requestSeq.project += 1;
    State.requestSeq.session += 1;
    State.requestSeq.search += 1;
    State.requestSeq.cleanup += 1;
    scope.clearSelection();

    if (view === "settings") await loadSettings();
    else if (view === "monitor") await loadMonitor();
    else if (view === "cleanup") await loadCleanup();
    else if (view === "tune") await loadTune();
    else if (view === "activity") { renderMain(); loadTrace(); if (!State.globalStats) loadStats(); }
    else if (view === "overview") { renderMain(); if (State.overviewDirty || !State.globalStats) { loadOverview(); loadStats(); } }
    else renderMain();
    renderChrome();
  }

  function resetScope() {
    State.projectId = null;
    State.sessionId = null;
    State.sessions = [];
    State.detail = null;
    State.transcript = null;
    State.recent = null;
    State.settings = null;
    State.cleanup = null;
    State.tune = null;
    State.trace = null;
    State.globalStats = null;
    State.projects = [];
    State.expandedProjects.clear();
    scope.clearSelection();
  }

  async function switchAgent(provider, nextView = "") {
    if (!ASM.AGENTS[provider] || provider === State.agent) return;
    ASM.api.send("leaveSession");
    State.agent = provider;
    ASM.persist.set("agent", provider);
    resetScope();
    State.view = "overview";
    renderAll();
    loadOverview();
    loadStats();
    loadRecent(true);
    if (nextView) await navigate(nextView);
  }

  async function switchSource(sourceId) {
    if (sourceId !== "all" && !State.enabledSources.has(sourceId)) return;
    if (sourceId === State.source) return;
    ASM.api.send("leaveSession");
    State.source = sourceId;
    resetScope();
    State.view = "overview";
    renderPickers();
    renderAll();
    loadOverview();
    loadStats();
    loadRecent(true);
  }

  async function toggleSource(sourceId, enabled) {
    const source = State.sources.find((item) => item.id === sourceId);
    if (!source || source.kind === "local") return;
    if (enabled) State.enabledSources.add(sourceId);
    else State.enabledSources.delete(sourceId);
    if (!enabled && State.source === sourceId) {
      State.source = (State.sources.find((item) => item.kind === "local") || {}).id || "windows";
    }
    renderPickers();
    renderMain();
    loadOverview();
    loadStats();
  }

  async function refreshAll() {
    State.trace = null;
    // WSL sources have no watcher; only an explicit refresh walks them again.
    await call("invalidateCaches");
    await Promise.all([loadOverview(), loadStats(), loadRecent(true)]);
    if (State.projectId) await loadProjectSessions(State.projectId);
    if (State.view === "activity") await loadTrace(true);
    renderAll();
    ASM.toast("Data refreshed", "ok");
  }

  async function refreshAfterDelete() {
    State.recent = null;
    State.trace = null;
    await Promise.all([loadOverview(), loadStats(), loadRecent(true)]);
    if (State.view === "cleanup") await loadCleanup();
    else if (State.projectId) { await loadProjectSessions(State.projectId); renderAll(); }
    else renderAll();
  }

  async function launchSession(sessionId = "", path = "") {
    const project = scope.currentProject();
    const fallback = !path && !project
      ? State.projects.find((item) => item.exists && (State.agent === "all" || item.provider === State.agent))
      : null;
    const target = project || fallback;
    const cwd = path || (target && target.path) || "";
    if (!cwd) { ASM.toast("Choose a project with an available folder first", "err"); return; }
    const session = State.sessions.find((item) => item.session_id === sessionId);
    const provider = (session || target || {}).provider || scope.currentProvider();
    const sourceId = (session || target || {}).source_id || State.source;
    const result = await call("launchAgent", provider, sourceId, cwd, sessionId || "", "resume");
    if (result && result.ok) {
      const where = result.target === "desktop" ? " in the Codex desktop app" : (sessionId ? " in a terminal" : "");
      ASM.toast(`${sessionId ? "" : "New "}${ASM.agentInfo(provider).short} session opened${where}`, "ok");
    } else {
      ASM.toast((result && result.error) || `Could not open ${ASM.agentInfo(provider).short}`, "err");
    }
  }

  async function runGlobalSearch(query) {
    const ticket = ++State.requestSeq.search;
    State.view = "search";
    State.searchQuery = query;
    State.searchResults = null;
    renderMain();
    const found = await perSource("searchProvider", (id) => [State.agent, id, query]);
    if (ticket !== State.requestSeq.search || State.view !== "search" || State.searchQuery !== query) return;
    State.searchResults = found.length ? {
      sessions: found.flatMap((item) => item.sessions || []),
      prompts: found.flatMap((item) => item.prompts || []),
    } : { sessions: [], prompts: [] };
    renderMain();
  }

  /* ================================================================ */
  /* command palette                                                   */
  /* ================================================================ */

  function paletteEntries(mode) {
    const project = scope.currentProject();
    const provider = (project && project.provider) || (State.agent === "all" ? "claude" : State.agent);
    const entries = [
      { glyph: "+", title: `New ${ASM.agentInfo(provider).label} session`,
        sub: project ? project.name : "Select a project", shortcut: "Ctrl N", run: () => launchSession() },
      ...(State.sessionId ? [{ glyph: "▶", title: "Resume this session", sub: State.sessionId,
        shortcut: "Ctrl Enter", run: () => launchSession(State.sessionId) }] : []),
      ...VIEWS.map(([key, label], index) => ({
        glyph: String(index + 1).padStart(2, "0"), title: `Go to ${label}`, sub: "Navigation",
        shortcut: "", run: () => navigate(key),
      })),
      { glyph: "☀", title: "Toggle light / dark theme", sub: "Appearance", shortcut: "Ctrl Shift L", run: () => ASM.theme.toggle() },
      { glyph: "A", title: "Show all agents", sub: "Claude Code and Codex", shortcut: "", run: () => switchAgent("all") },
      { glyph: "C", title: "Show Claude Code only", sub: "Filter the workbench", shortcut: "", run: () => switchAgent("claude") },
      { glyph: "X", title: "Show Codex only", sub: "Filter the workbench", shortcut: "", run: () => switchAgent("codex") },
      { glyph: "R", title: "Refresh all data", sub: "Re-index changed sessions", shortcut: "F5", run: refreshAll },
      { glyph: "?", title: "Keyboard shortcuts", sub: "Reference", shortcut: "?", run: showShortcuts },
      ...State.projects.map((item) => ({
        glyph: "P", title: `Project: ${item.name}`, sub: item.path || item.id, shortcut: "",
        run: () => selectProject(item.id),
      })),
      ...(State.recent || []).slice(0, 200).map((session) => ({
        glyph: "S", title: session.title || session.first_prompt || "Untitled session",
        sub: `${session.project_name || ""} · ${fmt.rel(session.mtime)}`, shortcut: "",
        run: () => openSession(session.project_id, session.session_id),
      })),
    ];
    return mode === "open" ? entries.filter((entry) => entry.glyph === "P" || entry.glyph === "S") : entries;
  }

  function renderPaletteResults() {
    const input = dom.id("command-input");
    const query = ((input && input.value) || "").trim().toLowerCase();
    const words = query.split(/\s+/).filter(Boolean);
    const entries = paletteEntries(State.paletteMode).filter((entry) => {
      const haystack = `${entry.title} ${entry.sub || ""}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    }).slice(0, 60);
    State.paletteEntries = entries;
    State.paletteIndex = clamp(State.paletteIndex, 0, Math.max(0, entries.length - 1));
    const results = dom.id("command-results");
    results.innerHTML = entries.length
      ? entries.map((entry, index) => `<button class="command-row ${index === State.paletteIndex ? "active" : ""}"
          data-action="palette-run" data-index="${index}" role="option" aria-selected="${index === State.paletteIndex}">
          <span class="command-glyph">${esc(entry.glyph)}</span>
          <span><span class="command-title">${esc(entry.title)}</span>
            <span class="command-sub">${esc(entry.sub || "")}</span></span>
          ${entry.shortcut ? `<kbd>${esc(entry.shortcut)}</kbd>` : ""}</button>`).join("")
      : `<div class="command-empty">No matching commands</div>`;
    const active = results.querySelector(".active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  function openPalette(mode = "all") {
    const back = dom.id("command-backdrop");
    const input = dom.id("command-input");
    // Already up in this mode: keep what was typed and the highlighted row.
    if (!back.hidden && State.paletteMode === mode) { input.focus(); return; }
    State.paletteMode = mode;
    State.paletteIndex = 0;
    if (back.hidden) State.palettePreviousFocus = document.activeElement;
    if (mode === "open") loadRecent();
    back.hidden = false;
    input.value = "";
    dom.id("palette-title").textContent = mode === "open" ? "Quick open a session" : "Command launcher";
    renderPaletteResults();
    input.focus();
  }

  function closePalette() {
    const back = dom.id("command-backdrop");
    if (back.hidden) return false;
    back.hidden = true;
    if (State.palettePreviousFocus && State.palettePreviousFocus.focus) State.palettePreviousFocus.focus();
    return true;
  }

  async function runPaletteEntry(index) {
    const entry = (State.paletteEntries || [])[index];
    if (!entry) return;
    closePalette();
    await entry.run();
  }

  function showShortcuts() {
    closePalette();
    const back = dom.id("shortcut-backdrop");
    dom.id("shortcut-grid").innerHTML = SHORTCUTS.map(([label, key]) =>
      `<div class="shortcut-row"><span>${esc(label)}</span><kbd>${esc(key)}</kbd></div>`).join("");
    State.shortcutPreviousFocus = document.activeElement;
    back.hidden = false;
    const button = back.querySelector("button");
    if (button) button.focus();
  }

  function closeShortcuts() {
    const back = dom.id("shortcut-backdrop");
    if (back.hidden) return false;
    back.hidden = true;
    if (State.shortcutPreviousFocus && State.shortcutPreviousFocus.focus) State.shortcutPreviousFocus.focus();
    return true;
  }

  /* ================================================================ */
  /* destructive actions                                               */
  /* ================================================================ */

  function confirmDeleteSession() {
    const project = scope.currentProject();
    const extra = `<label class="checkbox-row"><input type="checkbox" class="chk" id="purge-chk">
      Also purge tasks, file history, image cache and session-env</label>`;
    ASM.confirm("Delete this session?",
      "The transcript is permanently deleted. This cannot be undone.", async () => {
        const purge = document.getElementById("purge-chk");
        const payload = [{
          provider: "claude", source_id: (project && project.source_id) || State.source,
          project_id: State.projectId, session_id: State.sessionId,
        }];
        const result = await call("cleanupSessions", JSON.stringify(payload), !!(purge && purge.checked));
        if (result && result.ok) {
          ASM.toast("Session deleted", "ok");
          State.openTabs = State.openTabs.filter((tab) => tab.sid !== State.sessionId);
          ASM.persist.tabs();
          State.sessionId = null;
          State.detail = null;
          State.view = "project";
          await refreshAfterDelete();
        } else {
          ASM.toast((result && result.results && result.results[0] && result.results[0].error) || "Delete failed", "err");
        }
      }, extra);
  }

  function confirmArchiveSession() {
    const project = scope.currentProject();
    ASM.confirm("Archive this Codex session?",
      "Codex moves it out of the active session list. The archive stays recoverable from Codex storage, and no disk space is reclaimed.",
      async () => {
        const payload = [{
          provider: "codex", source_id: (project && project.source_id) || State.source,
          project_id: State.projectId, session_id: State.sessionId || "",
        }];
        const result = await call("cleanupSessions", JSON.stringify(payload), false);
        if (result && result.ok) {
          ASM.toast("Codex session archived", "ok");
          State.sessionId = null;
          State.detail = null;
          State.view = "project";
          await refreshAfterDelete();
        } else {
          ASM.toast((result && result.results && result.results[0] && result.results[0].error) || "Archive failed", "err");
        }
      }, "", { confirmLabel: "Archive", danger: false });
  }

  /* ================================================================ */
  /* events                                                            */
  /* ================================================================ */

  document.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    const path = target.dataset.path;

    // Views own their own actions first; the shell only handles what is left.
    for (const view of ["journey", "cleanup", "tune", "activity", "session"]) {
      const handler = ASM.views[view] && ASM.views[view].handle;
      if (handler && await handler(action, target)) return;
    }

    switch (action) {
      case "nav": return void navigate(target.dataset.view);
      case "switch-agent": return void switchAgent(target.dataset.agent, target.dataset.next || "");
      case "project": return void selectProject(target.dataset.id);
      case "toggle-project": return void toggleProject(target.dataset.id);
      case "open-session": {
        event.stopPropagation();
        return void openSession(target.dataset.pid, target.dataset.sid, { tab: target.dataset.tab || "" });
      }
      case "close-tab": {
        event.stopPropagation();
        State.openTabs = State.openTabs.filter((tab) => tab.sid !== target.dataset.sid);
        ASM.persist.tabs();
        renderTabs();
        return;
      }
      case "session": return void openSession(State.projectId, target.dataset.id);
      case "browse-mode": {
        State.browseMode = target.dataset.mode;
        ASM.persist.set("browseMode", State.browseMode);
        State.browseLimit = 120;
        State.cursorIndex = -1;
        if (State.browseMode === "recent") loadRecent();
        renderSidebar();
        return;
      }
      case "browse-more": {
        State.browseLimit += 120;
        dom.keepScroll(dom.id("sb-body"), () => renderSidebar());
        return;
      }
      case "toggle-sidebar": {
        State.sidebarCollapsed = !State.sidebarCollapsed;
        ASM.persist.set("sidebarCollapsed", State.sidebarCollapsed ? "1" : "0");
        renderSidebar();
        dom.id("sidebar").classList.toggle("collapsed", State.sidebarCollapsed);
        if (ASM.views.journey) ASM.views.journey.redraw();
        return;
      }
      case "tab": {
        State.tab = target.dataset.tab;
        ASM.persist.set("tab", State.tab);
        renderTab();
        return;
      }
      case "period": {
        State.period = target.dataset.value;
        ASM.persist.set("period", State.period);
        dom.keepScroll(dom.id("main-pane"), () => renderMain());
        return;
      }
      case "breakdown": {
        State.breakdown = target.dataset.value;
        ASM.persist.set("breakdown", State.breakdown);
        dom.keepScroll(dom.id("main-pane"), () => renderMain());
        return;
      }
      case "sort": {
        const key = target.dataset.key;
        const sortScope = target.dataset.scope || State.view;
        const current = State.sorts[sortScope] || {};
        State.sorts[sortScope] = { key, dir: current.key === key && current.dir === "desc" ? "asc" : "desc" };
        dom.keepScroll(dom.id("main-pane"), () => (State.view === "session" ? renderTab() : renderMain()));
        return;
      }
      case "open-memory": {
        State.view = "memory";
        renderMain();
        return void loadMemory(State.projectId);
      }
      case "memory": {
        State.view = "memory";
        return void loadMemory(State.projectId);
      }
      case "mem-file": {
        State._memFile = path;
        renderMain();
        const box = dom.id("mem-editor");
        if (box) box.innerHTML = ASM.views.misc.memoryEditor(path);
        dom.enhance(box);
        return;
      }
      case "mem-save": return void ASM.views.misc.saveMemory(path);
      case "mem-delete": return void ASM.views.misc.confirmDeleteMemory(path);
      case "preview-file": return void ASM.views.misc.previewFile(path);
      case "cfg-file": return void ASM.views.misc.openConfigFile(path);
      case "cfg-save": return void ASM.views.misc.saveConfigFile(path);
      case "cfg-view": return void ASM.viewFile(path);

      case "show-commands": return void openPalette("all");
      case "show-shortcuts": return void showShortcuts();
      case "close-shortcuts": return void closeShortcuts();
      case "palette-run": return void runPaletteEntry(Number(target.dataset.index));
      case "focus-search": return void focusSearch(false);
      case "focus-search-global": return void focusSearch(true);
      case "theme-toggle": return void ASM.theme.toggle();

      case "launch-new": return void launchSession("", path || "");
      case "launch-resume": return void launchSession(State.sessionId);
      case "launch-fork": {
        const project = scope.currentProject();
        const result = await call("launchAgent", "codex", (project && project.source_id) || State.source,
          (project && project.path) || "", State.sessionId || "", "fork");
        ASM.toast(result && result.ok ? "Codex fork opened in a terminal"
          : ((result && result.error) || "Could not fork this session"), result && result.ok ? "ok" : "err");
        return;
      }
      case "delete-session": return void confirmDeleteSession();
      case "archive-session": return void confirmArchiveSession();

      case "open-editor": {
        const result = await call("openInEditor", path);
        ASM.toast(result && result.ok ? `Opened in ${result.editor || "editor"}` : "Could not open",
          result && result.ok ? "ok" : "err");
        return;
      }
      case "open-folder": return void call("openPath", path);
      case "open-home": return void call("openPath",
        State.agentHome || (State.agent === "codex" ? State.codexHome : State.claudeHome));
      case "open-jsonl": {
        const jsonl = State.detail && State.detail.path;
        if (jsonl) await call("openInEditor", jsonl);
        return;
      }
      case "open-settings-json": return void call("openInEditor", `${State.claudeHome}/settings.json`);
      case "open-agents": {
        const file = (State.configFiles || []).find((item) => item.name === "AGENTS.md");
        if (file) await call("openInEditor", file.path);
        else await navigate("settings");
        return;
      }
      case "goto-codex-settings": return void navigate("settings");
      case "refresh": return void refreshAll();

      case "refresh-sources": {
        await loadSources(true);
        loadOverview();
        loadStats();
        renderMain();
        ASM.toast("Environments detected", "ok");
        return;
      }
      case "sources-all-on": {
        State.sources.filter((source) => source.kind === "wsl").forEach((source) => State.enabledSources.add(source.id));
        renderPickers();
        renderMain();
        ASM.toast("WSL sources enabled for this run. They scan when selected or included in All.", "ok");
        return;
      }
      case "sources-all-off": {
        State.sources.filter((source) => source.kind === "wsl").forEach((source) => State.enabledSources.delete(source.id));
        if (State.source === "all" || String(State.source).startsWith("wsl:")) {
          State.source = (State.sources.find((source) => source.kind === "local") || {}).id || "windows";
        }
        renderPickers();
        loadOverview();
        loadStats();
        renderMain();
        ASM.toast("WSL sources disabled", "ok");
        return;
      }

      case "setting-remove": return void ASM.views.settings.apply(target.dataset.key, null);
      case "add-custom": return void ASM.views.settings.addCustom();
      case "add-env": return void ASM.views.settings.addEnv();
      case "privacy-apply-all": return void ASM.views.settings.applyPrivacyDefaults();
      case "statusline-install": {
        const result = await call("installStatusline");
        State.statuslineStatus = await call("statuslineStatus");
        renderMain();
        ASM.toast(result && result.ok ? "Capture enabled" : `Failed: ${(result && result.error) || ""}`,
          result && result.ok ? "ok" : "err");
        return;
      }
      case "statusline-uninstall": {
        await call("uninstallStatusline");
        State.statuslineStatus = await call("statuslineStatus");
        renderMain();
        ASM.toast("Capture removed", "ok");
        return;
      }

      case "goto-update": {
        await navigate("settings");
        const anchor = dom.id("updates");
        if (anchor) anchor.scrollIntoView({ block: "center" });
        return;
      }
      case "check-update": {
        State.updateBusy = "check";
        State.updateRequested = true;
        renderMain();
        const result = await call("checkForUpdate", true);
        if (!result || !result.ok) {
          State.updateBusy = "";
          State.updateRequested = false;
          State.update = { ok: false, error: (result && result.error) || "Could not start the update check" };
          renderMain();
        }
        return;
      }
      case "install-update": {
        State.updateBusy = "install";
        State.updateRequested = true;
        renderMain();
        const result = await call("installUpdate");
        if (!result || !result.ok) {
          State.updateBusy = "";
          State.updateRequested = false;
          ASM.toast((result && result.error) || "Could not start the update", "err");
          renderMain();
        }
        return;
      }
      case "open-release": return void call("openReleasePage");

      case "show-earlier": {
        const window_ = State.transcript;
        if (!window_ || window_.start <= 0) return;
        const page = await call("getProviderTranscriptBefore", scope.currentProvider(),
          State.projectId, State.sessionId, window_.start, 200);
        if (page && page.events) {
          window_.events = page.events.concat(window_.events);
          window_.start = page.start;
          renderTab();
        }
        return;
      }
      case "toggle-noise": {
        State.showNoise = !State.showNoise;
        renderTab();
        return;
      }
      case "copy-resume": {
        const provider = scope.currentProvider();
        const command = provider === "codex" ? `codex resume ${State.sessionId}` : `claude --resume ${State.sessionId}`;
        const ok = await dom.copy(command);
        ASM.toast(ok ? `Copied: ${command}` : "Could not copy", ok ? "ok" : "err");
        return;
      }
      case "copy-compact": {
        const command = "/compact Focus on the current objective, verified decisions, changed files, open risks, and the next concrete step.";
        const ok = await dom.copy(command);
        ASM.toast(ok ? "Copied a focused /compact command" : "Could not copy", ok ? "ok" : "err");
        return;
      }
      default:
        break;
    }
  });

  /* ---------- change ---------- */

  document.addEventListener("change", async (event) => {
    const element = event.target;

    const cleanFilter = element.closest("[data-clean-filter]");
    if (cleanFilter) {
      const key = cleanFilter.dataset.cleanFilter;
      State.cleanupFilters[key] = ["query", "state", "asset"].includes(key)
        ? cleanFilter.value : Number(cleanFilter.value);
      renderMain();
      return;
    }
    if (element.matches("[data-role='session-filter']")) {
      State.sessionFilter = element.value;
      ASM.persist.set("sessionFilter", State.sessionFilter);
      State.browseLimit = 120;
      renderSidebar();
      return;
    }
    if (element.matches("[data-role='session-sort']")) {
      State.sessionSort = element.value;
      ASM.persist.set("sessionSort", State.sessionSort);
      State.browseLimit = 120;
      renderSidebar();
      return;
    }
    if (element.matches("[data-role='trace-kind']")) {
      State.traceFilter.kind = element.value;
      State.traceLimit = 200;
      renderMain();
      return;
    }
    if (element.matches("[data-role='source-toggle']")) {
      await toggleSource(element.dataset.source, element.checked);
      return;
    }
    if (element.matches("[data-role='privacy']")) {
      await ASM.views.settings.applyPrivacy(element.dataset.key, element.checked);
      return;
    }
    if (element.matches("[data-role='add-setting']")) {
      const key = element.value;
      element.value = "";
      if (key) await ASM.views.settings.addFromCatalog(key);
      return;
    }
    if (element.matches("[data-tune='project']") && State.tune) {
      State.tune.projectId = element.value;
      State.tune.proposal = null;
      State.tune.notes = null;
      State.tune.error = null;
      await ASM.views.tune.refreshGuidance();
      renderMain();
      return;
    }
    if (element.closest("[data-setting]")) {
      await ASM.views.settings.onControlChange(element.closest("[data-setting]"));
    }
  });

  /* ---------- input ---------- */

  const debouncedCleanupSearch = debounce(() => {
    if (State.view !== "cleanup") return;
    const pane = dom.id("main-pane");
    dom.keepScroll(pane, () => renderMain());
    const next = dom.q("[data-clean-filter='query']");
    if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
  }, 140);

  const debouncedTraceSearch = debounce(() => {
    if (State.view !== "activity") return;
    dom.keepScroll(dom.id("main-pane"), () => renderMain());
    const next = dom.q("[data-role='trace-query']");
    if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
  }, 140);

  document.addEventListener("input", (event) => {
    const cleanQuery = event.target.closest("[data-clean-filter='query']");
    if (cleanQuery) {
      State.cleanupFilters.query = cleanQuery.value;
      debouncedCleanupSearch();
      return;
    }
    const traceQuery = event.target.closest("[data-role='trace-query']");
    if (traceQuery) {
      State.traceFilter.query = traceQuery.value;
      State.traceLimit = 200;
      debouncedTraceSearch();
    }
  });

  const renderSidebarSoon = raf(() => renderSidebar());

  function focusSearch(global = false) {
    const input = dom.id("search");
    input.dataset.scope = global ? "global" : "filter";
    input.placeholder = global
      ? "Search every session and prompt · Enter"
      : "Filter sessions · Enter searches all";
    input.focus();
    input.select();
  }

  /* ---------- keyboard ---------- */

  document.addEventListener("keydown", async (event) => {
    const paletteOpen = !dom.id("command-backdrop").hidden;
    if (paletteOpen) {
      if (event.key === "Escape") { event.preventDefault(); closePalette(); return; }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const total = (State.paletteEntries || []).length;
        if (total) {
          State.paletteIndex = (State.paletteIndex + (event.key === "ArrowDown" ? 1 : -1) + total) % total;
        }
        renderPaletteResults();
        return;
      }
      if (event.key === "Enter") { event.preventDefault(); await runPaletteEntry(State.paletteIndex); return; }
    }

    // A dialog owns the keyboard while it is up: Escape closes it and every
    // other shortcut waits, so "?" cannot stack the shortcut sheet on top of
    // a confirmation and Ctrl+K cannot open the launcher behind one.
    const dialog = dom.q(".backdrop:not([hidden])");
    if (dialog && dialog.id !== "command-backdrop") {
      if (event.key === "Escape") {
        event.preventDefault();
        hideTip();
        if (!closeShortcuts()) {
          if (typeof dialog._close === "function") dialog._close();
          else dialog.remove();
        }
      }
      return;
    }
    if (event.key === "Escape") hideTip();

    // A held chord auto-repeats keydown. Reopening the launcher on every
    // repeat reset its input and list, which read as flicker.
    if (event.repeat) return;

    const target = event.target;
    const editing = target && (target.matches("input, textarea, select") || target.isContentEditable);
    const ctrl = event.ctrlKey || event.metaKey;

    if ((ctrl && event.key.toLowerCase() === "k") || (ctrl && event.shiftKey && event.key.toLowerCase() === "p") || event.key === "F1") {
      event.preventDefault(); openPalette("all"); return;
    }
    if (ctrl && !event.shiftKey && event.key.toLowerCase() === "p") { event.preventDefault(); openPalette("open"); return; }
    if (ctrl && event.shiftKey && event.key.toLowerCase() === "f") { event.preventDefault(); focusSearch(true); return; }
    if (ctrl && !event.shiftKey && event.key.toLowerCase() === "f") { event.preventDefault(); focusSearch(false); return; }
    if (ctrl && event.shiftKey && event.key.toLowerCase() === "l") { event.preventDefault(); ASM.theme.toggle(); return; }

    if (editing) {
      if (ctrl && event.key.toLowerCase() === "s") {
        const config = dom.id("cfg-textarea");
        const memory = dom.id("mem-textarea");
        if (target === config && State._cfgFile) { event.preventDefault(); await ASM.views.misc.saveConfigFile(State._cfgFile); }
        else if (target === memory && State._memFile) { event.preventDefault(); await ASM.views.misc.saveMemory(State._memFile); }
      }
      return;
    }

    if (event.key === "?" && !ctrl && !event.altKey) { event.preventDefault(); showShortcuts(); return; }
    if (event.key === "/" && !ctrl && !event.altKey) { event.preventDefault(); focusSearch(false); return; }
    if (event.key === "F5" || (ctrl && event.key.toLowerCase() === "r")) { event.preventDefault(); await refreshAll(); return; }
    if (ctrl && event.key.toLowerCase() === "n") { event.preventDefault(); await launchSession(); return; }
    if (ctrl && event.key.toLowerCase() === "b") {
      event.preventDefault();
      State.sidebarCollapsed = !State.sidebarCollapsed;
      ASM.persist.set("sidebarCollapsed", State.sidebarCollapsed ? "1" : "0");
      renderSidebar();
      dom.id("sidebar").classList.toggle("collapsed", State.sidebarCollapsed);
      if (ASM.views.journey) ASM.views.journey.redraw();
      return;
    }
    if (ctrl && event.key === "Enter" && State.sessionId) { event.preventDefault(); await launchSession(State.sessionId); return; }
    if (ctrl && event.key === ",") { event.preventDefault(); await navigate("settings"); return; }
    if (ctrl && ["1", "2", "3", "4", "5"].includes(event.key)) {
      event.preventDefault();
      await navigate(["overview", "activity", "monitor", "cleanup", "tune"][Number(event.key) - 1]);
      return;
    }
    if (ctrl && event.key === "Tab" && State.view === "session") {
      event.preventDefault();
      const tabs = dom.all(".tab");
      const index = tabs.findIndex((element) => element.dataset.tab === State.tab);
      const next = tabs[(index + (event.shiftKey ? -1 : 1) + tabs.length) % tabs.length];
      if (next) next.click();
      return;
    }

    // Sidebar traversal — the reason this app exists is getting between sessions.
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      ASM.views.sidebar.move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter" && State.cursorIndex >= 0 && !target.matches("[data-action]")) {
      event.preventDefault();
      await ASM.views.sidebar.activate();
      return;
    }
    if (event.key === "[") { event.preventDefault(); await ASM.views.sidebar.step(-1); return; }
    if (event.key === "]") { event.preventDefault(); await ASM.views.sidebar.step(1); return; }

    if ((event.key === "Enter" || event.key === " ") && target && target.matches("[role='button'][data-action]")) {
      event.preventDefault();
      target.click();
    }
  });

  /* ================================================================ */
  /* live refresh                                                      */
  /* ================================================================ */

  function indicateActivity() {
    const dotElement = dom.id("live-dot");
    const label = dom.id("live-label");
    if (!dotElement) return;
    dotElement.classList.add("flash");
    if (label) label.textContent = "activity";
    clearTimeout(indicateActivity.timer);
    indicateActivity.timer = setTimeout(() => {
      dotElement.classList.remove("flash");
      if (label) label.textContent = "watching";
    }, 1300);
  }

  // Machine-wide aggregates are rebuilt at most this often while sessions
  // write continuously; the open session itself refreshes on every tick.
  const refreshAggregates = throttle(() => {
    if (State.view === "overview" || State.view === "activity") { loadOverview(); loadStats(); }
    else State.overviewDirty = true;
    if (State.browseMode === "recent" || State.view === "monitor") loadRecent(true);
    if (State.view === "activity") loadTrace(true);
    if (State.view === "project" && State.projectId) loadProjectSessions(State.projectId).then((ok) => { if (ok) renderAll(); });
  }, 4000);

  const refreshSession = debounce(() => runSessionRefresh(), 280);

  function onDataChanged(reason) {
    indicateActivity();

    if (reason === "statusline") {
      // The statusline file is rewritten constantly while Claude runs. It is
      // routed as its own cheap tick so it never triggers a full rescan.
      clearTimeout(State._statuslineTimer);
      State._statuslineTimer = setTimeout(async () => {
        if (State.view !== "monitor" && State.view !== "settings") return;
        const live = await call("getStatuslineLive");
        if (live && Object.keys(live).length && State.settings) {
          State.settings.live = live;
          renderMain();
        }
      }, 250);
      return;
    }

    const parts = String(reason || "").split(":");
    if (parts[0] === "session" && parts[1] !== "claude" && parts[1] !== "codex") parts.splice(1, 0, "claude");
    const provider = scope.currentProvider();
    const nativeProject = String(State.projectId || "").split("::").pop();
    const mine = State.view === "session" && State.sessionId && parts[0] === "session"
      && parts[1] === provider && parts[2] === nativeProject && parts[3] === State.sessionId;
    const codexMine = State.view === "session" && State.sessionId && parts[0] === "codex" && provider === "codex";

    if (mine || codexMine) refreshSession();
    if (State.view === "monitor" && State.agent === "claude") refreshShells();
    refreshAggregates();
  }

  const refreshShells = throttle(async () => {
    State.shells = await call("getShells");
    if (State.view === "monitor") renderMain();
  }, 3000);

  async function runSessionRefresh() {
    if (State.liveRefreshInFlight) { State.liveRefreshQueued = true; return; }
    if (State.view !== "session" || !State.sessionId || !State.detail) return;
    State.liveRefreshInFlight = true;
    const sessionId = State.sessionId;
    try {
      const provider = scope.currentProvider();
      const meta = await call("getSessionMeta", provider, State.projectId, sessionId);
      if (!meta || meta.error || State.sessionId !== sessionId || State.view !== "session") return;
      if (detailSignature(meta) === State._detailSig) return;
      const pane = dom.id("main-pane");
      const top = pane ? pane.scrollTop : 0;
      State._detailSig = detailSignature(meta);
      // Keep the parts the meta call does not carry (scratchpad, images…).
      State.detail = { ...State.detail, ...meta };
      const window_ = State.transcript;
      if (window_ && window_.events.length) {
        const lastIndex = window_.start + window_.events.length - 1;
        const page = await call("getProviderTranscriptAfter", provider, State.projectId, sessionId, lastIndex);
        if (State.sessionId !== sessionId) return;
        if (page && page.events && page.events.length) {
          window_.events = window_.events.concat(page.events);
          window_.total = page.total;
          trimTranscript();
        }
      }
      renderSessionHead();
      renderTab();
      renderStatus();
      if (pane) pane.scrollTop = top;
    } finally {
      State.liveRefreshInFlight = false;
      if (State.liveRefreshQueued) {
        State.liveRefreshQueued = false;
        refreshSession();
      }
    }
  }

  function onIndexProgress(event) {
    if (!event || event.kind !== "index") return;
    State.indexing = event;
    renderStatus();
    if (event.done >= event.total) {
      clearTimeout(onIndexProgress.timer);
      onIndexProgress.timer = setTimeout(() => { State.indexing = null; renderStatus(); }, 1200);
    }
  }

  function onUpdateEvent(payload) {
    let result;
    try { result = typeof payload === "string" ? JSON.parse(payload) : payload; } catch { return; }
    if (!result) return;
    State.updateBusy = "";
    State.update = { ...(State.update || {}), ...result };
    refreshUpdatePill();
    if (State.view === "settings") renderMain();
    if (result.kind === "install" && result.ok && result.launched) {
      ASM.toast("Verified installer opened", "ok");
    } else if (!result.ok && State.updateRequested) {
      ASM.toast(result.error || "The update operation failed", "err");
    } else if (result.kind === "check" && result.ok && result.update_available && !State.updateRequested) {
      ASM.toast(`Version ${result.latest} is available`, "ok");
    }
    State.updateRequested = false;
  }

  /* ================================================================ */
  /* boot                                                              */
  /* ================================================================ */

  function wireStaticControls() {
    dom.id("agent-switch").addEventListener("change", (event) => switchAgent(event.target.value));
    dom.id("source-switch").addEventListener("change", (event) => switchSource(event.target.value));
    dom.id("refresh-btn").addEventListener("click", refreshAll);
    dom.id("theme-toggle").addEventListener("click", () => ASM.theme.toggle());
    dom.id("command-trigger").addEventListener("click", () => openPalette("all"));
    dom.id("help-trigger").addEventListener("click", showShortcuts);
    dom.id("win-min").addEventListener("click", () => ASM.api.send("windowMinimize"));
    dom.id("win-close").addEventListener("click", () => ASM.api.send("windowClose"));

    dom.id("command-input").addEventListener("input", () => {
      State.paletteIndex = 0;
      renderPaletteResults();
    });
    dom.id("command-backdrop").addEventListener("click", (event) => {
      if (event.target.id === "command-backdrop") closePalette();
    });
    dom.id("shortcut-backdrop").addEventListener("click", (event) => {
      if (event.target.id === "shortcut-backdrop") closeShortcuts();
    });

    const search = dom.id("search");
    search.addEventListener("input", (event) => {
      State.search = event.target.value;
      State.browseLimit = 120;
      renderSidebarSoon();
    });
    search.addEventListener("keydown", (event) => {
      const query = event.target.value.trim();
      if (event.key === "Enter" && query) { runGlobalSearch(query); return; }
      if (event.key === "Escape") {
        event.target.value = "";
        State.search = "";
        if (State.view === "search") State.view = State.projectId ? "project" : "overview";
        renderSidebar();
        renderMain();
      }
    });
  }

  async function boot() {
    ASM.theme.init();
    initPaneResizers();
    wireStaticControls();
    renderChrome();
    renderAll();   // skeletons: every region shows its shape before data lands

    if (typeof QWebChannel === "undefined" || !window.qt || !window.qt.webChannelTransport) {
      bootPreview();
      return;
    }
    new QWebChannel(qt.webChannelTransport, async (channel) => {
      ASM.api.attach(channel.objects.backend);
      channel.objects.backend.dataChanged.connect(onDataChanged);
      channel.objects.backend.assistantEvent.connect((payload) => ASM.views.tune.onEvent(payload));
      channel.objects.backend.updateEvent.connect(onUpdateEvent);
      ASM.api.onIndexProgress(onIndexProgress);

      const info = await call("getAppInfo");
      markTiming("channel");
      if (info && info.version) {
        State.appVersion = info.version;
        dom.id("app-version").textContent = `v${info.version}`;
      }
      document.body.classList.toggle("custom-window-controls", !!(info && info.custom_window_controls));
      if (info && info.local_source) {
        // Every launch scopes to the native machine. A WSL distribution is
        // enabled for a run, never remembered: booting one and walking its
        // tree over the network is a cost the user has to ask for each time.
        State.localSource = info.local_source;
        State.source = info.local_source;
        State.enabledSources = new Set([info.local_source]);
      }
      call("checkForUpdate", false);
      // Everything below is independent; each paints its region when it lands.
      loadSources();
      loadOverview();
      loadStats();
      loadRecent(true);
    });
  }

  /**
   * A browser opening web/index.html directly gets a working design preview.
   *
   * The fixtures in js/preview.js are shaped exactly like the backend's, so
   * this exercises the real rendering path — and it is what the repository
   * screenshots are taken from, so no real session of anyone's is published.
   */
  function bootPreview() {
    const label = dom.id("live-label");
    if (label) label.textContent = "preview";
    const dot = dom.id("live-dot");
    if (dot) dot.title = "Static browser preview — launch the desktop app for live data";

    const fixtures = ASM.preview;
    State.projects = fixtures.PROJECTS;
    State.globalStats = fixtures.GLOBAL;
    State.recent = fixtures.RECENT;
    State.trace = { events: fixtures.TRACE };
    State.sources = [{ id: "windows", label: "Windows", kind: "local", available: true, writable: true }];
    State.enabledSources = new Set(["windows"]);
    State.source = "windows";
    State.appVersion = "preview";
    const version = dom.id("app-version");
    if (version) version.textContent = "preview";
    renderAll();
  }

  /** Open the fixture session, so the preview can show the inspector too. */
  function previewSession(tab = "summary") {
    const fixtures = ASM.preview;
    State.projectId = fixtures.DETAIL.project_id;
    State.sessions = fixtures.RECENT.filter((item) => item.project_id === State.projectId);
    State.sessionId = fixtures.DETAIL.session_id;
    State.detail = fixtures.DETAIL;
    State.transcript = {
      events: fixtures.DETAIL.events, start: fixtures.DETAIL.events_start, total: fixtures.DETAIL.total_events,
    };
    State.view = "session";
    State.tab = tab;
    rememberTab(State.sessions[0] || { session_id: State.sessionId, title: "Make the payment webhook idempotent" });
    renderAll();
  }

  ASM.router = {
    renderAll, renderMain, renderTab, renderChrome, renderSidebar, renderSessionHead,
    navigate, openSession, toggleProject, selectProject, loadOverview, loadStats, loadRecent,
    loadTrace, loadMemory, loadSettings, refreshAfterDelete, refreshAll, launchSession,
    switchAgent, switchSource, initPaneResizers, showShortcuts, openPalette, runGlobalSearch,
    focusSearch, previewSession, hideTip,
  };

  if (document.readyState === "loading") window.addEventListener("load", boot);
  else boot();
})(window.ASM = window.ASM || {});
