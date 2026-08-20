/* ============================================================
   The sidebar browser — how you get to a session.

   Two modes, because there are two ways people look for work they
   did: "the thing I was doing this morning" and "that project".

     Recent    every session on the machine, newest first, grouped
               into Today / Yesterday / This week / …
     Projects  projects ranked by activity, each expanding in place
               into its own sessions

   Both render into one flat row list so a single pair of arrow keys
   walks the whole thing regardless of which mode is on.
   ============================================================ */

(function (ASM) {
  "use strict";

  const { esc, fmt, dom } = ASM.util;
  const ui = ASM.ui;
  const State = ASM.state;

  function matches(session) {
    const query = State.search.trim().toLowerCase();
    if (!query) return true;
    return (session.title || "").toLowerCase().includes(query)
      || (session.first_prompt || "").toLowerCase().includes(query)
      || (session.project_name || "").toLowerCase().includes(query)
      || String(session.session_id || "").includes(query);
  }

  function passesFilter(session) {
    if (State.sessionFilter === "active") return !!session.active;
    if (State.sessionFilter === "idle") return !session.active;
    return true;
  }

  function sortSessions(list) {
    const sorted = [...list];
    if (State.sessionSort === "context") sorted.sort((a, b) => (b.context_pct || 0) - (a.context_pct || 0));
    else if (State.sessionSort === "turns") sorted.sort((a, b) => (b.assistant_messages || 0) - (a.assistant_messages || 0));
    else if (State.sessionSort === "cost") sorted.sort((a, b) => (b.cost || 0) - (a.cost || 0));
    else sorted.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    return sorted;
  }

  /* ---------- rows ---------- */

  function sessionRow(session, options = {}) {
    const active = session.session_id === State.sessionId;
    const title = session.title || session.first_prompt || "Untitled session";
    const tags = [];
    if (session.active) tags.push(`<span class="dot-active" title="written to in the last two minutes"></span>`);
    if (session.has_subagents) tags.push(`<span class="c-web" title="spawned subagents">◈</span>`);
    const cost = session.provider === "codex" ? "" : fmt.cost(session.cost);
    const context = Number(session.context_pct || 0);
    return `<div class="sb-row ${options.nested ? "nested" : ""} ${active ? "active" : ""}"
        data-action="open-session" data-pid="${esc(session.project_id || State.projectId || "")}"
        data-sid="${esc(session.session_id)}" data-row="${options.rowIndex}">
      <span class="sb-main">
        <span class="sb-title">${esc(title)}</span>
        <span class="sb-sub">
          ${options.showProject && session.project_name ? `<span class="nowrap">${esc(session.project_name)}</span>` : ""}
          <span><b>${session.assistant_messages || 0}</b> turns</span>
          <span><b>${session.tool_calls || 0}</b> tools</span>
          ${cost ? `<span class="p-cost">${cost}</span>` : ""}
        </span>
      </span>
      <span class="sb-right">
        <span class="sb-when">${esc(fmt.rel(session.mtime))} ${tags.join("")}</span>
        ${context ? ui.meter(context) : ""}
      </span></div>`;
  }

  function projectRow(project, expanded, rowIndex) {
    const active = project.id === State.projectId;
    return `<div class="sb-row ${active ? "active" : ""} ${expanded ? "open" : ""}"
        data-action="toggle-project" data-id="${esc(project.id)}" data-row="${rowIndex}">
      <span class="sb-caret">▶</span>
      <span class="sb-main">
        <span class="sb-title">${esc(project.name)}</span>
        <span class="sb-sub">
          <span><b>${project.session_count || 0}</b> sessions</span>
          ${project.provider && State.agent === "all" ? `<span>${esc(ASM.agentInfo(project.provider).short)}</span>` : ""}
          ${project.provider === "codex" ? "" : `<span class="p-cost">${fmt.cost(project.total_cost)}</span>`}
        </span>
      </span>
      <span class="sb-right">
        <span class="sb-when">${esc(fmt.rel(project.last_activity))}</span>
        ${project.active_count ? `<span class="dot-active"></span>` : ""}
      </span></div>`;
  }

  /* ---------- modes ---------- */

  function recentBody() {
    if (!State.recent) return `<div class="skeleton">Indexing every session…</div>`;
    const list = sortSessions(State.recent.filter((session) => matches(session) && passesFilter(session)));
    if (!list.length) {
      return `<div class="sb-empty">${State.search ? "No session matches that." : "No sessions indexed yet."}</div>`;
    }
    const shown = list.slice(0, State.browseLimit);
    const rows = [];
    let html = "";
    let bucket = "";
    // Grouping only makes sense while the list is in time order; any other
    // sort would produce headings that repeat and mean nothing.
    const grouped = State.sessionSort === "recent";
    shown.forEach((session) => {
      if (grouped) {
        const next = fmt.dayBucket(session.mtime);
        if (next !== bucket) { bucket = next; html += `<div class="sb-group">${esc(bucket)}</div>`; }
      }
      html += sessionRow(session, { showProject: true, rowIndex: rows.length });
      rows.push({ type: "session", pid: session.project_id, sid: session.session_id });
    });
    if (list.length > shown.length) {
      html += `<button class="sb-more" data-action="browse-more">Show ${Math.min(120, list.length - shown.length)} more
        <span class="faint">· ${shown.length} of ${list.length}</span></button>`;
    }
    State.browseRows = rows;
    return html;
  }

  function projectsBody() {
    const query = State.search.trim().toLowerCase();
    const projects = State.projects.filter((project) =>
      !query || project.name.toLowerCase().includes(query) || String(project.path || "").toLowerCase().includes(query));
    if (!projects.length) {
      return `<div class="sb-empty">${query ? "No project matches that." : "No projects indexed yet."}</div>`;
    }
    const rows = [];
    let html = "";
    projects.slice(0, State.browseLimit).forEach((project) => {
      const expanded = State.expandedProjects.has(project.id);
      html += projectRow(project, expanded, rows.length);
      rows.push({ type: "project", id: project.id });
      if (!expanded) return;
      if (project.id !== State.projectId || !State.sessions.length) {
        html += `<div class="sb-empty" style="padding:8px 26px">Loading sessions…</div>`;
        return;
      }
      const sessions = sortSessions(State.sessions.filter((session) => matches(session) && passesFilter(session)));
      if (!sessions.length) {
        html += `<div class="sb-empty" style="padding:8px 26px">No sessions match.</div>`;
        return;
      }
      sessions.slice(0, 60).forEach((session) => {
        html += sessionRow(session, { nested: true, rowIndex: rows.length });
        rows.push({ type: "session", pid: project.id, sid: session.session_id });
      });
      if (sessions.length > 60) {
        html += `<div class="sb-empty" style="padding:6px 26px">+${sessions.length - 60} older sessions — use search or Cleanup.</div>`;
      }
    });
    if (projects.length > State.browseLimit) {
      html += `<button class="sb-more" data-action="browse-more">Show more projects</button>`;
    }
    State.browseRows = rows;
    return html;
  }

  /* ---------- shell ---------- */

  function render() {
    const element = document.getElementById("sidebar");
    if (!element) return;
    element.classList.toggle("collapsed", State.sidebarCollapsed);
    if (State.sidebarCollapsed) { element.innerHTML = ""; return; }

    const mode = State.browseMode;
    const body = mode === "projects" ? projectsBody() : recentBody();

    element.innerHTML = `
      <div class="sb-head">
        <div class="sb-modes">
          <button class="sb-mode ${mode === "recent" ? "active" : ""}" data-action="browse-mode" data-mode="recent">Recent</button>
          <button class="sb-mode ${mode === "projects" ? "active" : ""}" data-action="browse-mode" data-mode="projects">Projects</button>
        </div>
        <div class="sb-filters">
          <select class="picker" data-role="session-filter" aria-label="Filter sessions by status">
            <option value="all" ${State.sessionFilter === "all" ? "selected" : ""}>All</option>
            <option value="active" ${State.sessionFilter === "active" ? "selected" : ""}>Active</option>
            <option value="idle" ${State.sessionFilter === "idle" ? "selected" : ""}>History</option>
          </select>
          <select class="picker" data-role="session-sort" aria-label="Sort sessions">
            <option value="recent" ${State.sessionSort === "recent" ? "selected" : ""}>Recent</option>
            <option value="context" ${State.sessionSort === "context" ? "selected" : ""}>Context</option>
            <option value="turns" ${State.sessionSort === "turns" ? "selected" : ""}>Turns</option>
            <option value="cost" ${State.sessionSort === "cost" ? "selected" : ""}>Cost</option>
          </select>
        </div>
      </div>
      <div class="sb-body" id="sb-body" tabindex="-1">${body}</div>`;

    dom.enhance(element);
    markCursor();
  }

  /* ---------- keyboard traversal ---------- */

  function markCursor() {
    dom.all(".sb-row.cursor").forEach((row) => row.classList.remove("cursor"));
    if (State.cursorIndex < 0) return;
    const row = dom.q(`.sb-row[data-row="${State.cursorIndex}"]`);
    if (row) {
      row.classList.add("cursor");
      row.scrollIntoView({ block: "nearest" });
    }
  }

  function move(delta) {
    const total = State.browseRows.length;
    if (!total) return;
    State.cursorIndex = State.cursorIndex < 0
      ? (delta > 0 ? 0 : total - 1)
      : ASM.util.clamp(State.cursorIndex + delta, 0, total - 1);
    markCursor();
  }

  /** Enter on the highlighted row. */
  async function activate() {
    const entry = State.browseRows[State.cursorIndex];
    if (!entry) return;
    if (entry.type === "project") await ASM.router.toggleProject(entry.id);
    else await ASM.router.openSession(entry.pid, entry.sid);
  }

  /** `[` and `]` — step to the neighbouring session without leaving the pane. */
  async function step(delta) {
    const sessions = State.browseRows.filter((row) => row.type === "session");
    if (!sessions.length) return;
    const current = sessions.findIndex((row) => row.sid === State.sessionId);
    const next = current < 0 ? 0 : ASM.util.clamp(current + delta, 0, sessions.length - 1);
    const target = sessions[next];
    if (target) await ASM.router.openSession(target.pid, target.sid);
  }

  ASM.views = ASM.views || {};
  ASM.views.sidebar = { render, move, activate, step, markCursor };
})(window.ASM = window.ASM || {});
