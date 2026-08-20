/* ============================================================
   Monitor — what is happening right now, and the runtime state
   Claude Code leaves on disk while it works.

   Activity here is inferred from file writes. That is stated in the
   view rather than dressed up as process monitoring, because a
   recent timestamp does not prove an agent is running.
   ============================================================ */

(function (ASM) {
  "use strict";

  const { esc, fmt } = ASM.util;
  const ui = ASM.ui;
  const State = ASM.state;

  function render() {
    if (State.agent === "codex") return codexView();
    if (State.agent === "all") {
      return ui.emptyState("M", "Choose an agent",
        "Runtime monitoring has agent-specific capabilities. Select Claude or Codex in the top bar.");
    }

    const active = State.projects.filter((project) => project.active_count);
    const live = State.settings && State.settings.live;
    const shells = State.shells || {};
    const snapshots = shells.snapshots || [];
    const environments = shells.envs || shells.environments || [];
    const liveSessions = (State.recent || []).filter((session) => session.active)
      .sort((a, b) => b.mtime - a.mtime).slice(0, 12);

    return `
      <div class="page-head"><div class="ph-title"><h1>Monitor</h1>
        <div class="ph-sub">What Claude Code is doing right now. Totals and spend live on Overview.</div></div>
        <div class="page-actions"><button class="btn sm" data-action="refresh">Refresh</button></div></div>

      ${live ? ui.section("Live statusline", `<div class="card">${ASM.views.settings ? "" : ""}
        ${liveMeters(live)}</div>`,
        { desc: "The exact context and rate-limit payload Claude Code last handed to your statusline command — the same numbers your terminal shows." }) : ""}

      ${ui.section(`Active sessions (${liveSessions.length})`, `<div class="card flush"><div class="rows">
        ${liveSessions.length ? liveSessions.map((session) => `
          <div class="row-item" data-action="open-session" data-pid="${esc(session.project_id)}" data-sid="${esc(session.session_id)}">
            <div class="ri-ic"><span class="dot-active"></span></div>
            <div class="ri-main"><div class="ri-name">${esc(session.title || session.session_id)}</div>
              <div class="ri-desc">${esc(session.project_name || "")} · ${session.assistant_messages} turns · ${session.tool_calls} tools</div></div>
            <div class="ri-meta">${esc(fmt.rel(session.mtime))}${session.context_pct ? `<br>${fmt.pct(session.context_pct)} ctx` : ""}</div>
          </div>`).join("")
          : `<div class="sb-empty">No session transcript has been written to in the last two minutes.</div>`}
      </div></div>`, { desc: "Sessions whose transcript changed in the last two minutes — i.e. an agent is, or just was, working there." })}

      ${ui.section(`Active projects (${active.length})`, `<div class="card flush"><div class="rows">
        ${active.length ? active.map((project) => `
          <div class="row-item" data-action="project" data-id="${esc(project.id)}">
            <div class="ri-ic"><span class="dot-active"></span></div>
            <div class="ri-main"><div class="ri-name">${esc(project.name)}</div>
              <div class="ri-desc">${project.active_count} active · ${esc(fmt.rel(project.last_activity))}</div></div>
            <div class="ri-meta p-cost">${fmt.cost(project.total_cost)}</div>
          </div>`).join("")
          : `<div class="sb-empty">No projects active in the last two minutes.</div>`}
      </div></div>`)}

      ${ui.section(`Shell snapshots (${snapshots.length})`, `<div class="card flush"><div class="rows">
        ${snapshots.length ? snapshots.map((file) => `
          <div class="row-item" data-action="cfg-view" data-path="${esc(file.path)}">
            <div class="ri-ic">sh</div>
            <div class="ri-main"><div class="ri-name mono">${esc(file.name)}</div></div>
            <div class="ri-meta">${fmt.bytes(file.size)}<br>${esc(fmt.rel(file.mtime))}</div>
          </div>`).join("")
          : `<div class="sb-empty">No shell snapshots.</div>`}
      </div></div>`, { desc: "When a session starts, Claude Code snapshots your shell profile and sources it for every Bash call. These are those scripts." })}

      ${ui.section(`Session environments (${environments.length})`, `<div class="card flush"><div class="rows">
        ${environments.length ? environments.map((entry) => `
          <div class="row-item" data-action="open-folder" data-path="${esc(entry.path)}">
            <div class="ri-ic">env</div>
            <div class="ri-main"><div class="ri-name mono">${esc(entry.session_id)}</div></div>
            <div class="ri-meta">${esc(fmt.rel(entry.mtime))}</div>
          </div>`).join("")
          : `<div class="sb-empty">No session environments.</div>`}
      </div></div>`, { desc: "Per-session working state under ~/.claude/session-env so a session can be resumed. Purged with the session; Cleanup's purge option removes them too." })}
    `;
  }

  function liveMeters(live) {
    const context = live.context_window || {};
    const limits = live.rate_limits || {};
    const fiveHour = limits.five_hour || {};
    const sevenDay = limits.seven_day || {};
    const rows = [];
    if (context.used_percentage != null) rows.push(ui.meterRow("ctx", context.used_percentage, fmt.pct(+context.used_percentage)));
    if (fiveHour.used_percentage != null) rows.push(ui.meterRow("5h", fiveHour.used_percentage, fmt.pct(+fiveHour.used_percentage)));
    if (sevenDay.used_percentage != null) rows.push(ui.meterRow("7d", sevenDay.used_percentage, fmt.pct(+sevenDay.used_percentage)));
    return `<div style="display:flex;flex-direction:column;gap:8px">
      <div class="faint" style="font-size:11px">Captured ${esc(fmt.rel(live._captured_mtime))}
        · ${esc((live.model && live.model.display_name) || "")}</div>
      ${rows.join("") || `<div class="faint">No meters in the snapshot.</div>`}</div>`;
  }

  function codexView() {
    return `
      <div class="page-head"><div class="ph-title"><h1>Monitor</h1>
        <div class="ph-sub">Recently active Codex session files</div></div></div>
      ${ui.notice(`<strong>Activity is inferred from file writes.</strong> A recent timestamp does not prove that a Codex process is currently running.`)}
      ${ui.section("Recent projects", `<div class="card flush"><div class="rows">
        ${State.projects.slice(0, 14).map((project) => `
          <div class="row-item" data-action="project" data-id="${esc(project.id)}">
            <div class="ri-main"><div class="ri-name">${esc(project.name)}</div>
              <div class="ri-desc mono">${esc(project.path || "")}</div></div>
            <div class="ri-meta">${project.active_count || 0} recent<br>${project.session_count} sessions</div>
          </div>`).join("") || `<div class="sb-empty">No Codex sessions indexed.</div>`}
      </div></div>`)}
      ${ui.section("Not available from Codex session storage", `<div class="card">
        <p class="faint" style="font-size:12.5px">Shell snapshots, captured rate limits and Claude statusline hooks are
        not shown for Codex. The app does not infer them from unrelated logs or credentials.</p></div>`)}`;
  }

  ASM.views = ASM.views || {};
  ASM.views.monitor = { render };
})(window.ASM = window.ASM || {});
