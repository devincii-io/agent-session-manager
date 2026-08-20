/* ============================================================
   Overview — what all of this machine's agent work adds up to.
   ============================================================ */

(function (ASM) {
  "use strict";

  const { esc, fmt } = ASM.util;
  const ui = ASM.ui;
  const charts = ASM.charts;
  const State = ASM.state;

  const MODEL_COLOURS = {
    "claude-fable-5": "var(--cat-web)",
    "claude-opus-5": "var(--primary)",
    "claude-opus-4-8": "var(--primary)",
    "claude-opus-4-7": "var(--cat-agent)",
    "claude-sonnet-5": "var(--cat-read)",
    "claude-sonnet-4-6": "var(--cat-search)",
    "claude-haiku-4-5": "var(--cat-edit)",
  };

  function modelColour(model, index) {
    return MODEL_COLOURS[model] || `var(--series-${(index % 8) + 1})`;
  }

  function render() {
    const stats = State.globalStats;
    if (!stats) return ui.skeleton("Aggregating every session on disk…");

    const projects = State.projects;
    const usage = stats.usage || {};
    const contextTokens = (usage.input || 0) + (usage.cache_read || 0) + (usage.cache_write || 0);
    const cacheHit = contextTokens ? (100 * (usage.cache_read || 0)) / contextTokens : 0;
    const costKnown = State.agent !== "codex";
    const info = ASM.agentInfo();
    const recent = projects[0];

    const models = Object.entries(stats.by_model || {})
      .filter(([name, value]) => name !== "unknown" && name !== "<synthetic>" && (value.total || 0) > 0)
      .sort((a, b) => b[1].total - a[1].total);

    const days = stats.sessions_by_day || [];
    const last14 = days.slice(-14);

    const costBars = projects
      .filter((project) => project.provider !== "codex" && project.total_cost > 0)
      .sort((a, b) => b.total_cost - a.total_cost).slice(0, 8)
      .map((project) => ({
        label: project.name, value: project.total_cost,
        valueText: fmt.cost(project.total_cost), action: "project", id: project.id,
      }));

    const toolBars = Object.entries(stats.tool_counts || {}).slice(0, 12)
      .map(([name, count]) => ({ label: name, value: count, valueText: fmt.num(count) }));

    const launchProvider = (recent && recent.provider) || (State.agent === "all" ? "claude" : State.agent);

    return `
      <div class="page-head">
        <div class="ph-title"><h1>Overview</h1>
          <div class="ph-sub">${State.agent === "all"
            ? "Every local Claude Code and Codex project and session, indexed in one place."
            : `Every local ${esc(info.label)} project and session, indexed in one place.`}</div></div>
        <div class="page-actions">
          ${State.agent === "all"
            ? `<button class="btn sm" data-action="switch-agent" data-agent="claude">Claude only</button>
               <button class="btn sm" data-action="switch-agent" data-agent="codex">Codex only</button>`
            : `<button class="btn sm" data-action="open-home">Open ${esc(info.home)}</button>`}
        </div>
      </div>

      <div class="quick-launch">
        <button class="quick-action primary" data-action="launch-new" data-path="${esc((recent && recent.path) || "")}">
          <strong>New ${esc(ASM.agentInfo(launchProvider).label)} session</strong>
          <span>${recent ? `Start in ${esc(recent.name)} · Ctrl N` : "Choose a project first"}</span></button>
        <button class="quick-action" data-action="open-editor" data-path="${esc((recent && recent.path) || "")}">
          <strong>Open recent project</strong><span>${recent ? esc(recent.name) + " in VS Code" : "No recent project"}</span></button>
        <button class="quick-action" data-action="show-commands">
          <strong>Command launcher</strong><span>Every action · Ctrl K</span></button>
        <button class="quick-action" data-action="focus-search-global">
          <strong>Search all history</strong><span>Sessions and prompts · Ctrl Shift F</span></button>
      </div>

      <div class="tiles">
        ${costKnown
          ? ui.tile(State.agent === "all" ? "Claude API-price estimate" : "API-price estimate",
              fmt.cost(stats.cost), "Not a billing statement", { accent: true,
              tip: "Estimated from Claude token usage at list prices. Codex ChatGPT-plan usage carries no dollar amount." })
          : ui.tile("Usage", "ChatGPT plan", "No dollar cost inferred", { accent: true,
              tip: "Local Codex token records prove nothing about API billing" })}
        ${ui.tile("Tokens", fmt.tokens(usage.total), fmt.tokens(usage.output) + " generated",
          { tip: "Input + output + cache reads and writes across every session" })}
        ${ui.tile("Cache hit rate", fmt.pct(cacheHit), fmt.tokens(usage.cache_read) + " served from cache",
          { tip: "Cached context costs about a tenth of fresh input" })}
        ${ui.tile("Sessions", fmt.num(stats.sessions),
          `${stats.active} recently active · ${projects.length} projects`,
          { tip: "Recent means the transcript was written to in the last two minutes" })}
      </div>

      <div class="tiles">
        ${ui.tile("Prompts", fmt.num(stats.prompts), "messages you sent",
          { tip: "User messages across all sessions; tool results excluded" })}
        ${ui.tile("Assistant turns", fmt.num(stats.turns), "API responses")}
        ${ui.tile("Tool calls", fmt.num(stats.tool_calls),
          `${Object.keys(stats.tool_counts || {}).length} distinct tools`)}
        ${ui.tile("Subagent sessions", fmt.num(stats.subagent_sessions), "detected locally")}
      </div>

      ${ui.section("Activity", `<div class="card">
        ${charts.calendar(days, { ariaLabel: "Sessions per day over the last 90 days" })}
      </div>`, { desc: "Sessions with activity per day over the last 90 days, by the last write to the transcript." })}

      <div class="split-2">
        ${ui.section("When you work", `<div class="card">
          ${charts.heatmap(stats.activity, { ariaLabel: "Sessions by weekday and hour" })}
        </div>`, { desc: "Local time. The darker the cell, the more sessions were last touched then." })}

        ${ui.section("Last 14 days", `<div class="card">
          ${charts.columns(last14.map(([, count]) => count), {
            labels: last14.map(([day]) => day.slice(5)), color: "var(--series-1)", height: 120,
          })}
        </div>`, { desc: "Session count per day." })}
      </div>

      ${models.length ? ui.section(costKnown ? "Models — tokens and estimate" : "Models — tokens",
        `<div class="card"><div class="donut-wrap">
          ${charts.donut(models.map(([name, value], index) => ({
            label: fmt.model(name), value: value.total, color: modelColour(name, index),
          })), { format: fmt.tokens, centerValue: fmt.tokens(usage.total), centerLabel: "tokens" })}
          <div class="legend" style="flex-direction:column;gap:7px">
            ${models.map(([name, value], index) => `<div class="legend-item">
              <span class="legend-swatch" style="background:${modelColour(name, index)}"></span>
              <span>${esc(fmt.model(name))}</span>
              ${costKnown && value.cost != null ? `<b>${fmt.cost(value.cost)}</b>` : ""}
              <span class="faint">${fmt.tokens(value.total)} tok</span></div>`).join("")}
          </div></div></div>`,
        { desc: costKnown ? "Token share and the Claude API-price estimate per model." : "Token share per model; no billing amount is inferred." }) : ""}

      ${costKnown && costBars.length ? ui.section("Estimate by project",
        `<div class="card">${ui.barList(costBars)}</div>`,
        { desc: "Every session's estimated cost, grouped by the project it ran in. Click a row to open it." }) : ""}

      ${toolBars.length ? ui.section("Tool usage — all sessions",
        `<div class="card">${ui.barList(toolBars)}</div>`,
        { desc: "Total invocations per tool across every session on this machine." }) : ""}

      ${ui.section("Token composition", `<div class="card">${ui.barList([
        { label: "Input", value: usage.input || 0, valueText: fmt.tokens(usage.input), color: "var(--cat-read)" },
        { label: "Output", value: usage.output || 0, valueText: fmt.tokens(usage.output), color: "var(--primary)" },
        { label: "Cache write", value: usage.cache_write || 0, valueText: fmt.tokens(usage.cache_write), color: "var(--cat-exec)" },
        { label: "Cache read", value: usage.cache_read || 0, valueText: fmt.tokens(usage.cache_read), color: "var(--cat-edit)" },
      ])}</div>`, { desc: "Cache reads are re-served context and cost about a tenth of fresh input; cache writes cost about 1.25x." })}
    `;
  }

  /* ---------- project view: one project's sessions in aggregate ---------- */

  function projectView() {
    const project = ASM.scope.currentProject();
    if (!project) return ui.emptyState("◈", "Select a project");
    const sessions = State.sessions;
    const totalCost = sessions.reduce((sum, session) => sum + (session.cost || 0), 0);
    const totalTokens = sessions.reduce((sum, session) => sum + ((session.usage && session.usage.total) || 0), 0);
    const totalTools = sessions.reduce((sum, session) => sum + (session.tool_calls || 0), 0);
    const totalTurns = sessions.reduce((sum, session) => sum + (session.assistant_messages || 0), 0);
    const costKnown = project.provider !== "codex";

    const modelTokens = {};
    sessions.forEach((session) => {
      Object.entries(session.usage_by_model || {}).forEach(([model, usage]) => {
        if (model === "unknown" || model === "<synthetic>") return;
        modelTokens[model] = (modelTokens[model] || 0) + (usage.total || 0);
      });
    });
    const models = Object.entries(modelTokens).sort((a, b) => b[1] - a[1]);

    // Cost, or failing that tokens, over the project's most recent sessions —
    // read oldest-first so the trend runs the way time does.
    const trend = [...sessions].sort((a, b) => (a.mtime || 0) - (b.mtime || 0)).slice(-40);
    const trendPoints = trend.map((session, index) => ({
      x: index,
      y: costKnown ? (session.cost || 0) : ((session.usage && session.usage.total) || 0),
      label: session.title || session.session_id.slice(0, 8),
    }));

    return `
      <div class="page-head">
        <div class="ph-title"><h1>${esc(project.name)}</h1>
          <div class="ph-sub mono">${esc(project.path || project.id)}</div></div>
        <div class="page-actions">
          <button class="btn sm primary" data-action="launch-new" data-path="${esc(project.path)}">New session</button>
          <button class="btn sm" data-action="open-editor" data-path="${esc(project.path)}">VS Code</button>
          <button class="btn sm" data-action="open-folder" data-path="${esc(project.path)}">Open folder</button>
        </div>
      </div>

      <div class="tiles">
        ${costKnown
          ? ui.tile("API-price estimate", fmt.cost(totalCost), "Not a billing statement", { accent: true })
          : ui.tile("Usage", "ChatGPT plan", "No dollar cost inferred", { accent: true })}
        ${ui.tile("Tokens", fmt.tokens(totalTokens), fmt.num(totalTurns) + " assistant turns")}
        ${ui.tile("Sessions", fmt.num(sessions.length), `${project.active_count || 0} recently active`)}
        ${ui.tile("Tool calls", fmt.num(totalTools), `${project.memory_count || 0} memory files`)}
      </div>

      ${trendPoints.length > 1 ? ui.section(costKnown ? "Estimate per session" : "Tokens per session",
        `<div class="card">${charts.area(trendPoints, {
          color: costKnown ? "var(--primary)" : "var(--cat-read)",
          format: costKnown ? fmt.cost : fmt.tokens, height: 140,
        })}</div>`, { desc: "The project's most recent sessions, oldest first." }) : ""}

      ${models.length ? ui.section("Token share by model", `<div class="card"><div class="donut-wrap">
        ${charts.donut(models.map(([model, tokens], index) => ({
          label: fmt.model(model), value: tokens, color: modelColour(model, index),
        })), { format: fmt.tokens, centerValue: fmt.tokens(totalTokens), centerLabel: "tokens" })}
        <div class="legend" style="flex-direction:column;gap:7px">${models.map(([model, tokens], index) =>
          `<div class="legend-item"><span class="legend-swatch" style="background:${modelColour(model, index)}"></span>
            <span>${esc(fmt.model(model))}</span><span class="faint">${fmt.tokens(tokens)}</span></div>`).join("")}</div>
      </div></div>`) : ""}

      ${ui.section("Heaviest sessions", `<div class="card">${ui.barList(
        [...sessions].sort((a, b) => (costKnown ? b.cost - a.cost : (b.usage?.total || 0) - (a.usage?.total || 0)))
          .slice(0, 12).map((session) => ({
            label: session.title || session.session_id.slice(0, 8),
            value: costKnown ? session.cost : (session.usage?.total || 0),
            valueText: costKnown ? fmt.cost(session.cost) : fmt.tokens(session.usage?.total),
            action: "session", id: session.session_id,
          })))}</div>`, { desc: "Click a row to open the session." })}

      ${ui.section("Memory", `<div class="card">
        <div class="row"><div class="spacer">
          <div>${project.memory_count || 0} memory file${project.memory_count === 1 ? "" : "s"} in this project's store.</div>
          <div class="faint" style="font-size:11.5px">MEMORY.md plus one file per remembered fact.</div>
        </div><button class="btn sm" data-action="open-memory">Open memory</button></div></div>`)}
    `;
  }

  ASM.views = ASM.views || {};
  ASM.views.overview = { render, projectView, modelColour };
})(window.ASM = window.ASM || {});
