/* ============================================================
   Activity — what was invoked, delegated, killed or interrupted,
   across every project and both agents.

   Every session keeps a compact trace of these moments in the
   summary cache, so this view is one walk of the summaries and
   never opens a transcript. The tables at the top roll the trace
   up by skill and by agent type; the log below is the raw order
   of events with a jump into the session each one happened in.
   ============================================================ */

(function (ASM) {
  "use strict";

  const { esc, fmt, sum } = ASM.util;
  const ui = ASM.ui;
  const State = ASM.state;

  const KINDS = [["", "Everything"], ["skill", "Skills"], ["agent", "Agents"], ["kill", "Kills"],
    ["interrupt", "Interruptions"], ["command", "Commands"], ["compaction", "Compactions"]];

  function rollup(table, kind, scopeKey) {
    const sort = State.sorts[scopeKey] || { key: "count", dir: "desc" };
    const rows = Object.entries(table || {}).map(([name, row]) => ({ name, ...row }));
    rows.sort((a, b) => {
      const av = sort.key === "name" ? a.name.toLowerCase() : Number(a[sort.key]) || 0;
      const bv = sort.key === "name" ? b.name.toLowerCase() : Number(b[sort.key]) || 0;
      const order = av < bv ? -1 : av > bv ? 1 : 0;
      return sort.dir === "asc" ? order : -order;
    });
    const columns = [
      { key: "name", label: kind === "skill" ? "Skill" : "Agent type", format: (row) => `${ui.traceChip(kind, row.name)}` },
      { key: "count", label: kind === "skill" ? "Uses" : "Spawns", align: "right", format: (row) => fmt.num(row.count) },
      { key: "sessions", label: "Sessions", align: "right", format: (row) => fmt.num(row.sessions) },
      { key: "projects", label: "Projects", align: "right", format: (row) => fmt.num(row.projects) },
      { key: "last", label: "Last used", align: "right", format: (row) => esc(fmt.rel(row.last)) },
    ];
    return ui.table(columns, rows.slice(0, 12), {
      sortKey: sort.key, sortDir: sort.dir, sortScope: scopeKey,
      rowAttrs: (row) => `class="clickable" data-action="trace-filter" data-kind="${kind}" data-name="${esc(row.name)}"`,
      empty: kind === "skill" ? "No skill invocations recorded." : "No subagents recorded.",
    });
  }

  function filtered(events) {
    const kind = State.traceFilter.kind;
    const query = (State.traceFilter.query || "").trim().toLowerCase();
    return events.filter((event) => {
      if (kind && event.k !== kind) return false;
      if (!query) return true;
      return `${event.n || ""} ${event.d || ""} ${event.project_name || ""} ${event.title || ""}`.toLowerCase().includes(query);
    });
  }

  function log(events) {
    const rows = filtered(events);
    const shown = rows.slice(0, State.traceLimit);
    let day = "";
    const body = shown.map((event) => {
      const bucket = fmt.isoDay(event.t);
      const header = bucket !== day ? `<div class="trace-day">${esc(fmt.weekday(event.t))} ${esc(fmt.day(event.t))}</div>` : "";
      day = bucket;
      return `${header}<div class="trace-row" data-action="open-session" data-pid="${esc(event.project_id)}" data-sid="${esc(event.session_id)}" data-tab="trace">
        <span class="tr-time">${esc(fmt.clock(event.t))}</span>
        ${ui.traceChip(event.k)}
        <span class="tr-name">${esc(event.n)}</span>
        <span class="tr-detail">${esc(event.d || "")}</span>
        <span class="tr-where"><span class="tr-project">${esc(event.project_name || "")}</span>
          <span class="tr-session">${esc(event.title || event.session_id)}</span>${ui.providerBadge(event.provider)}</span>
        <span class="tr-ms">${event.ms ? esc(fmt.duration(event.ms)) : ""}${event.e ? ` <span class="badge red">failed</span>` : ""}</span>
      </div>`;
    }).join("");
    const more = rows.length > shown.length
      ? `<button class="btn" data-action="trace-more" style="width:100%;justify-content:center;border-radius:0">Show 200 more · ${rows.length - shown.length} remaining</button>` : "";
    return `<div class="card flush"><div class="trace-list">${body || `<div class="sb-empty">Nothing matches.</div>`}</div>${more}</div>`;
  }

  function render() {
    const stats = State.globalStats;
    const trace = State.trace;
    const head = `<div class="page-head">
      <div class="ph-title"><h1>Activity</h1>
        <div class="ph-sub">Skills invoked, subagents spawned, tasks killed and turns interrupted, across every project${State.agent === "all" ? " and both agents" : ""}.</div></div>
      <div class="page-actions"><button class="btn sm" data-action="refresh">Refresh</button></div></div>`;
    if (!stats || !trace) {
      return `${head}${ui.skeletonTiles(4)}<div class="split-2"><div class="card">${ui.skeletonRows(5)}</div><div class="card">${ui.skeletonRows(5)}</div></div>`;
    }
    const events = trace.events || [];
    const skillUses = sum(Object.values(stats.skills || {}), (row) => row.count);
    const agentSpawns = sum(Object.values(stats.agents || {}), (row) => row.count);
    const kinds = KINDS.map(([key, label]) => [key, key ? `${label} · ${events.filter((event) => event.k === key).length}` : label]);

    return `${head}
      <div class="tiles">
        ${ui.tile("Skills invoked", fmt.compact(skillUses), `${fmt.plural(Object.keys(stats.skills || {}).length, "distinct skill")}`, { accent: true })}
        ${ui.tile("Subagents spawned", fmt.compact(agentSpawns), `${fmt.plural(Object.keys(stats.agents || {}).length, "agent type")}`)}
        ${ui.tile("Tasks and shells killed", fmt.compact(stats.kills || 0), "TaskStop and KillShell calls", { cls: stats.kills ? "warn" : "" })}
        ${ui.tile("Turns you interrupted", fmt.compact(stats.interrupts || 0), "Escape pressed on a running turn", { cls: stats.interrupts ? "warn" : "" })}
      </div>
      <div class="split-2">
        ${ui.section("Skills", `<div class="card flush">${rollup(stats.skills, "skill", "skills")}</div>`, { desc: "Click a row to filter the log." })}
        ${ui.section("Agents", `<div class="card flush">${rollup(stats.agents, "agent", "agents")}</div>`, { desc: "Subagent types, by how often they were spawned." })}
      </div>
      ${ui.section("Log", `
        <div class="filter-row">
          <select class="picker" data-role="trace-kind" aria-label="Kind">${kinds.map(([key, label]) =>
            `<option value="${esc(key)}" ${State.traceFilter.kind === key ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>
          <input class="s-input" data-role="trace-query" value="${esc(State.traceFilter.query)}" placeholder="Skill, agent, project or session">
          ${State.traceFilter.kind || State.traceFilter.query ? `<button class="chip" data-action="trace-clear">Clear</button>` : ""}
          <span class="faint" style="margin-left:auto;font-size:11.5px">${fmt.plural(filtered(events).length, "event")} · newest first · the last 80 per session are kept</span>
        </div>
        ${log(events)}`, { desc: "Click an event to open its session on the Trace tab." })}`;
  }

  async function handle(action, element) {
    switch (action) {
      case "trace-filter": {
        State.traceFilter = { kind: element.dataset.kind || "", query: element.dataset.name || "" };
        State.traceLimit = 200;
        if (State.view !== "activity") { await ASM.router.navigate("activity"); }
        else ASM.router.renderMain();
        const anchor = document.querySelector(".filter-row");
        if (anchor) anchor.scrollIntoView({ block: "start" });
        return true;
      }
      case "trace-clear":
        State.traceFilter = { kind: "", query: "" };
        State.traceLimit = 200;
        ASM.router.renderMain();
        return true;
      case "trace-more":
        State.traceLimit += 200;
        ASM.util.dom.keepScroll(document.getElementById("main-pane"), () => ASM.router.renderMain());
        return true;
      default:
        return false;
    }
  }

  ASM.views = ASM.views || {};
  ASM.views.activity = { render, handle, filtered };
})(window.ASM = window.ASM || {});
