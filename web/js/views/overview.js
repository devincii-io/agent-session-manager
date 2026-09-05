/* ============================================================
   Overview — what all of this machine's agent work adds up to.

   The page answers four questions in order: how much did this
   cost and how much time went into it; where did it go, by day, by
   model, by project; when do I work; and how reliably did it go
   (errors, compactions, interruptions, kills). One period control
   at the top scopes the figures and the daily chart together, so
   the numbers on the page always agree with each other.
   ============================================================ */

(function (ASM) {
  "use strict";

  const { esc, fmt, sum } = ASM.util;
  const ui = ASM.ui;
  const charts = ASM.charts;
  const State = ASM.state;

  const PERIODS = [["7", "7 days"], ["30", "30 days"], ["90", "90 days"], ["all", "All time"]];
  const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  // Model families in the order they take colour slots; whatever else appears
  // follows alphabetically. Colour follows the model, never its rank today.
  const MODEL_ORDER = ["fable", "mythos", "opus", "sonnet", "haiku", "gpt"];

  /* ---------- colour by entity ---------- */

  const modelSlots = new Map();

  function assignModelSlots(models) {
    const known = [...new Set([...modelSlots.keys(), ...models])];
    const rank = (name) => {
      const short = fmt.model(name);
      const family = MODEL_ORDER.findIndex((key) => short.includes(key));
      return [family < 0 ? MODEL_ORDER.length : family, short];
    };
    known.sort((a, b) => {
      const [fa, sa] = rank(a);
      const [fb, sb] = rank(b);
      return fa - fb || sa.localeCompare(sb);
    });
    known.forEach((name, index) => { if (!modelSlots.has(name)) modelSlots.set(name, index); });
  }

  function modelColour(model) {
    if (!modelSlots.has(model)) assignModelSlots([model]);
    const slot = modelSlots.get(model);
    return slot < 8 ? `var(--series-${slot + 1})` : "var(--series-other)";
  }

  function projectColour(index) {
    return index < 7 ? `var(--series-${index + 1})` : "var(--series-other)";
  }

  /* ---------- the period window ---------- */

  function periodDays() { return State.period === "all" ? 0 : Number(State.period) || 30; }

  function windows(stats) {
    const daily = stats.daily || [];
    const days = periodDays();
    if (!days) return { current: daily, previous: [] };
    return {
      current: daily.slice(-days),
      previous: daily.slice(-2 * days, -days),
    };
  }

  function total(rows, key) { return sum(rows, (row) => row[key]); }

  function periodLabel() {
    return State.period === "all" ? "all time" : `the last ${State.period} days`;
  }

  /* ---------- pieces ---------- */

  function tiles(stats, priced) {
    const { current, previous } = windows(stats);
    const all = State.period === "all";
    const spend = all ? stats.cost : total(current, "cost");
    const spendBefore = total(previous, "cost");
    const tokens = all ? (stats.usage || {}).total : total(current, "tokens");
    const tokensBefore = total(previous, "tokens");
    const activeMs = all ? stats.active_ms : total(current, "active_ms");
    const activeBefore = total(previous, "active_ms");
    const prompts = all ? stats.prompts : total(current, "prompts");
    const activeDays = current.filter((day) => day.turns > 0).length;
    const sessionsNow = sessionsInWindow();
    const usage = stats.usage || {};
    const contextTokens = (usage.input || 0) + (usage.cache_read || 0) + (usage.cache_write || 0);
    const cacheHit = contextTokens ? (100 * (usage.cache_read || 0)) / contextTokens : 0;
    const hasPrevious = previous.length > 0;

    const spendTile = priced
      ? ui.tile("Spend", fmt.cost(spend),
          activeDays && !all ? `≈ ${fmt.cost(spend / activeDays)} per active day` : "API list prices, not a bill",
          { accent: true, delta: hasPrevious ? fmt.delta(spend, spendBefore) : "",
            deltaLabel: `vs the ${State.period} days before`, upIsGood: false,
            spark: charts.sparkline(current.map((day) => day.cost), { color: "var(--primary)" }),
            tip: "Estimated from token usage at Claude API list prices. Not a billing statement." })
      : ui.tile("Tokens", fmt.tokens(tokens), "Codex usage is plan-based; no dollar figure is inferred",
          { accent: true, delta: hasPrevious ? fmt.delta(tokens, tokensBefore) : "", upIsGood: false,
            spark: charts.sparkline(current.map((day) => day.tokens), { color: "var(--primary)" }) });

    return `<div class="tiles">
      ${spendTile}
      ${ui.tile("Time with agents", fmt.hours(activeMs),
        `${fmt.plural(prompts, "prompt")}${activeDays && !all ? ` · ${fmt.plural(activeDays, "active day")}` : ""}`,
        { delta: hasPrevious ? fmt.delta(activeMs, activeBefore) : "", upIsGood: true,
          spark: charts.sparkline(current.map((day) => day.active_ms), { color: "var(--series-1)" }),
          tip: "Wall-clock time while a session was writing, with pauses over five minutes left out." })}
      ${ui.tile("Sessions", fmt.compact(sessionsNow.count),
        stats.active ? `${fmt.plural(stats.active, "session")} writing right now` : (sessionsNow.last ? `last activity ${fmt.rel(sessionsNow.last)}` : "none yet"),
        { tip: "Sessions whose transcript was last written to inside the period." })}
      ${ui.tile("Cache hit rate", fmt.pct(cacheHit),
        priced && stats.cache_savings ? `saved ≈ ${fmt.cost(stats.cache_savings)} versus fresh input` : `${fmt.tokens(usage.cache_read)} tokens served from cache`,
        { tip: "Share of context tokens that came from the prompt cache. A cached token costs about a tenth of a fresh one." })}
    </div>`;
  }

  function sessionsInWindow() {
    const days = periodDays();
    const list = State.recent || [];
    if (!list.length) {
      const stats = State.globalStats || {};
      return { count: days ? total(windows(stats).current, "sessions") : stats.sessions || 0, last: 0 };
    }
    const cutoff = days ? Date.now() / 1000 - days * 86400 : 0;
    const inside = list.filter((session) => (session.mtime || 0) >= cutoff);
    return { count: inside.length, last: Math.max(0, ...list.map((session) => session.mtime || 0)) };
  }

  function dailyChart(stats, priced) {
    const { current } = windows(stats);
    const rows = State.period === "all" ? stats.daily || [] : current;
    if (!rows.length) return ui.section("Spend per day", `<div class="card">${charts.empty("No activity recorded yet.")}</div>`);
    const byProject = State.breakdown === "project" && stats.project_daily;
    const format = priced ? fmt.cost : fmt.tokens;
    let series;
    let legend;
    if (!priced) {
      series = [{ key: "tokens", label: "tokens", color: "var(--series-1)", values: rows.map((day) => day.tokens) }];
      legend = "";
    } else if (byProject) {
      const names = new Map(State.projects.map((project) => [project.id, project.name]));
      const entries = Object.entries(stats.project_daily)
        .map(([id, days]) => ({ id, label: id === "other" ? "other projects" : (names.get(id) || String(id).split("::").pop()),
          total: rows.reduce((acc, day) => acc + (days[day.d] || 0), 0), days }))
        .filter((entry) => entry.total > 0)
        .sort((a, b) => (a.id === "other") - (b.id === "other") || b.total - a.total);
      series = entries.map((entry, index) => ({
        key: entry.id, label: entry.label, color: entry.id === "other" ? "var(--series-other)" : projectColour(index),
        values: rows.map((day) => entry.days[day.d] || 0),
      }));
      legend = legendRow(series.map((entry, index) => ({ label: entry.label, color: entry.color, value: format(entries[index].total) })));
    } else {
      const models = new Map();
      rows.forEach((day) => Object.entries(day.models || {}).forEach(([model, cost]) => models.set(model, (models.get(model) || 0) + cost)));
      assignModelSlots([...models.keys()]);
      const ordered = [...models.entries()].sort((a, b) => b[1] - a[1]);
      series = ordered.map(([model]) => ({
        key: model, label: fmt.model(model), color: modelColour(model),
        values: rows.map((day) => (day.models || {})[model] || 0),
      }));
      legend = legendRow(ordered.map(([model, cost]) => ({ label: fmt.model(model), color: modelColour(model), value: format(cost) })));
    }
    const labels = rows.map((day) => fmt.day(day.d + "T00:00:00"));
    const tips = rows.map((day) => `${fmt.weekday(day.d + "T00:00:00")} ${fmt.day(day.d + "T00:00:00")}`);
    const controls = priced ? ui.segmented([["model", "By model"], ["project", "By project"]], State.breakdown, "breakdown") : "";
    return ui.section(priced ? "Spend per day" : "Tokens per day", `<div class="card">
      ${charts.columns(series, { labels, tips, format, height: 190, average: rows.length > 10, labelEvery: rows.length > 40 ? 9 : 7,
        ariaLabel: priced ? "Spend per day" : "Tokens per day" })}
      ${legend}</div>`, {
      actions: controls,
      desc: rows.length > 10 ? "The line is the trailing seven-day average." : "",
    });
  }

  function legendRow(items) {
    if (!items.length) return "";
    return `<div class="legend" style="margin-top:10px">${items.map((item) =>
      `<span class="legend-item"><span class="legend-swatch" style="background:${item.color}"></span>
        <span>${esc(item.label)}</span><b>${esc(item.value)}</b></span>`).join("")}</div>`;
  }

  function projectsTable(stats, priced) {
    const sort = State.sorts.overview || { key: "last_activity", dir: "desc" };
    const rows = [...(stats.by_project || [])];
    const key = sort.key;
    rows.sort((a, b) => {
      const av = key === "name" ? String(a.name).toLowerCase() : Number(a[key]) || 0;
      const bv = key === "name" ? String(b.name).toLowerCase() : Number(b[key]) || 0;
      const order = av < bv ? -1 : av > bv ? 1 : 0;
      return sort.dir === "asc" ? order : -order;
    });
    const shown = rows.slice(0, 14);
    const columns = [
      { key: "name", label: "Project", format: (row) => `<span class="cell-main">${esc(row.name)}</span>${State.agent === "all" ? ` ${ui.badge(ASM.agentInfo(row.provider).short, row.provider)}` : ""}` },
      { key: "sessions", label: "Sessions", align: "right", format: (row) => fmt.num(row.sessions) },
      priced
        ? { key: "cost", label: "Spend", align: "right", format: (row) => row.provider === "codex" ? `<span class="faint">—</span>` : fmt.cost(row.cost) }
        : { key: "tokens", label: "Tokens", align: "right", format: (row) => fmt.tokens(row.tokens) },
      { key: "active_ms", label: "Time", align: "right", format: (row) => fmt.hours(row.active_ms) },
      { key: "errors", label: "Errors", align: "right", format: (row) => row.errors ? fmt.num(row.errors) : `<span class="faint">0</span>`,
        tip: "Tool calls that returned an error" },
      { key: "last_activity", label: "Last active", align: "right", format: (row) => esc(fmt.rel(row.last_activity)) },
    ];
    const body = ui.table(columns, shown, {
      sortKey: sort.key, sortDir: sort.dir, sortScope: "overview",
      rowAttrs: (row) => `class="clickable" data-action="project" data-id="${esc(row.id)}"`,
      empty: "No projects indexed yet.",
    });
    const more = rows.length > shown.length
      ? `<div class="table-foot">${rows.length - shown.length} more in the Projects browser</div>` : "";
    return ui.section("Projects", `<div class="card flush">${body}${more}</div>`,
      { desc: "All time. Click a project to open it." });
  }

  function whenYouWork(stats) {
    const heat = stats.activity || [];
    const flat = heat.flat();
    const totalTurns = sum(flat);
    let insight = "";
    if (totalTurns) {
      let best = { day: 0, hour: 0, value: -1 };
      heat.forEach((row, day) => row.forEach((value, hour) => { if (value > best.value) best = { day, hour, value }; }));
      const late = heat.reduce((acc, row) => acc + sum(row.slice(22)) + sum(row.slice(0, 6)), 0);
      const weekend = sum(heat[5] || []) + sum(heat[6] || []);
      const parts = [`Busiest around ${DAY_NAMES[best.day]} ${String(best.hour).padStart(2, "0")}:00.`];
      if (late / totalTurns >= 0.05) parts.push(`${fmt.pct(100 * late / totalTurns)} of the work happens between 22:00 and 06:00.`);
      if (weekend / totalTurns >= 0.05) parts.push(`${fmt.pct(100 * weekend / totalTurns)} on weekends.`);
      insight = `<div class="section-note">${esc(parts.join(" "))}</div>`;
    }
    return ui.section("When you work", `<div class="card">
      ${charts.heatmap(heat, { unit: "turns", ariaLabel: "Assistant turns by weekday and hour" })}${insight}</div>`,
      { desc: "Assistant turns by local weekday and hour, all time." });
  }

  function modelsSection(stats, priced) {
    const usage = stats.usage || {};
    const models = Object.entries(stats.by_model || {})
      .filter(([name, value]) => name !== "unknown" && name !== "<synthetic>" && (value.total || 0) > 0)
      .sort((a, b) => b[1].total - a[1].total);
    if (!models.length) return "";
    assignModelSlots(models.map(([name]) => name));
    const shown = models.slice(0, 6);
    const rest = models.slice(6);
    const items = shown.map(([name, value]) => ({ label: fmt.model(name), value: value.total, color: modelColour(name) }));
    if (rest.length) items.push({ label: "other", value: sum(rest, ([, value]) => value.total), color: "var(--series-other)" });
    const legend = `<div class="legend col">${shown.map(([name, value]) =>
      `<div class="legend-item"><span class="legend-swatch" style="background:${modelColour(name)}"></span>
        <span class="legend-name">${esc(fmt.model(name))}</span>
        ${priced && value.cost != null && value.cost > 0 ? `<b>${fmt.cost(value.cost)}</b>` : ""}
        <span class="faint">${fmt.tokens(value.total)} tokens</span></div>`).join("")}
      ${rest.length ? `<div class="legend-item"><span class="legend-swatch" style="background:var(--series-other)"></span><span class="legend-name">${rest.length} other</span></div>` : ""}</div>`;
    return ui.section("Models", `<div class="card"><div class="donut-wrap">
      ${charts.donut(items, { format: fmt.tokens, centerValue: fmt.tokens(usage.total), centerLabel: "tokens", size: 116 })}
      ${legend}</div></div>`, { desc: priced ? "Token share and the price estimate per model, all time." : "Token share per model, all time." });
  }

  function reliabilitySection(stats) {
    const categories = ui.categoryTotals(stats.tool_counts);
    const calls = stats.tool_calls || 0;
    const errorRate = calls ? (100 * (stats.tool_errors || 0)) / calls : 0;
    const rows = [
      { label: "Tool calls that failed", value: `${fmt.num(stats.tool_errors || 0)} · ${fmt.pct(errorRate, 1)}`, tone: errorRate >= 8 ? "bad" : errorRate >= 4 ? "warn" : "" },
      { label: "Context compactions", value: fmt.num(stats.compactions || 0), tone: "" },
      { label: "Turns you interrupted", value: fmt.num(stats.interrupts || 0), tone: "", action: "nav", view: "activity" },
      { label: "Tasks and shells killed", value: fmt.num(stats.kills || 0), tone: "", action: "nav", view: "activity" },
      { label: "Subagents spawned", value: fmt.num(sum(Object.values(stats.agents || {}), (row) => row.count)), tone: "", action: "nav", view: "activity" },
      { label: "Skills invoked", value: fmt.num(sum(Object.values(stats.skills || {}), (row) => row.count)), tone: "", action: "nav", view: "activity" },
    ];
    return ui.section("What the agents do", `<div class="card">
      ${ui.stackBar(categories, { tall: true })}
      <div style="margin-top:8px">${ui.categoryLegend(categories)}</div>
      <div class="fact-list">${rows.map((row) =>
        `<div class="fact-row ${row.tone}"${row.action ? ` data-action="${row.action}" data-view="${row.view}"` : ""}>
          <span>${esc(row.label)}</span><b>${esc(row.value)}</b></div>`).join("")}</div></div>`,
      { desc: "Every tool call on this machine grouped by the kind of work it was, and how often something went sideways." });
  }

  function skillsAndAgents(stats) {
    const top = (table) => Object.entries(table || {}).sort((a, b) => b[1].count - a[1].count).slice(0, 6);
    const skills = top(stats.skills);
    const agents = top(stats.agents);
    if (!skills.length && !agents.length) {
      return ui.section("Skills and agents", `<div class="card">${ui.emptyState("◎", "Nothing traced yet",
        "Skill invocations, subagents, kills and interruptions appear here as sessions use them.")}</div>`);
    }
    const list = (rows, kind) => rows.length ? `<div class="mini-table">${rows.map(([name, row]) =>
      `<div class="mini-row" data-action="trace-filter" data-kind="${kind}" data-name="${esc(name)}" data-tip="${esc(name)}\n${fmt.plural(row.count, "use")} · ${fmt.plural(row.sessions, "session")} · ${fmt.plural(row.projects, "project")}\nlast ${esc(fmt.rel(row.last))}">
        <span class="mr-name">${ui.traceChip(kind, name)}</span>
        <span class="mr-num">${fmt.num(row.count)}</span>
        <span class="mr-sub">${fmt.plural(row.projects, "project")}</span>
        <span class="mr-when">${esc(fmt.rel(row.last))}</span></div>`).join("")}</div>`
      : `<div class="faint" style="font-size:12px">None recorded.</div>`;
    return ui.section("Skills and agents", `<div class="split-2">
      <div class="card"><div class="card-title">Skills invoked</div>${list(skills, "skill")}</div>
      <div class="card"><div class="card-title">Subagents spawned</div>${list(agents, "agent")}</div>
    </div>`, {
      desc: "Across every project. Open Activity for the full log with kills and interruptions.",
      actions: `<button class="btn sm" data-action="nav" data-view="activity">Open Activity</button>`,
    });
  }

  /* ---------- the page ---------- */

  function render() {
    const stats = State.globalStats;
    const info = ASM.agentInfo();
    const priced = State.agent !== "codex";
    const head = `<div class="page-head">
        <div class="ph-title"><h1>Overview</h1>
          <div class="ph-sub">${State.agent === "all"
            ? "Every local Claude Code and Codex session, in one place."
            : `Every local ${esc(info.label)} session, in one place.`}${
            State.projects.length ? ` ${fmt.plural(State.projects.length, "project")}.` : ""}</div></div>
        <div class="page-actions">
          ${ui.segmented(PERIODS, State.period, "period", { label: "Period" })}
          <button class="btn sm primary" data-action="launch-new">New session</button>
        </div>
      </div>`;

    if (!stats) {
      return `${head}${ui.skeletonTiles(4)}
        <div class="section"><div class="section-title"><span>Spend per day</span></div><div class="card">${ui.skeletonChart(190)}</div></div>
        <div class="split-2"><div class="card">${ui.skeletonRows(6)}</div><div class="card">${ui.skeletonChart(150)}</div></div>`;
    }

    return `${head}
      ${tiles(stats, priced)}
      ${dailyChart(stats, priced)}
      <div class="split-2 wide-left">
        ${projectsTable(stats, priced)}
        ${whenYouWork(stats)}
      </div>
      <div class="split-2">
        ${modelsSection(stats, priced)}
        ${reliabilitySection(stats)}
      </div>
      ${skillsAndAgents(stats)}`;
  }

  /* ---------- project view: one project's sessions in aggregate ---------- */

  function projectView() {
    const project = ASM.scope.currentProject();
    if (!project) return ui.emptyState("◈", "Select a project");
    const sessions = State.sessions;
    const priced = project.provider !== "codex";
    const head = `<div class="page-head">
        <div class="ph-title"><h1>${esc(project.name)}</h1>
          <div class="ph-sub mono">${esc(project.path || project.id)}</div></div>
        <div class="page-actions">
          <button class="btn sm primary" data-action="launch-new" data-path="${esc(project.path)}">New session</button>
          <button class="btn sm" data-action="open-editor" data-path="${esc(project.path)}">VS Code</button>
          <button class="btn sm" data-action="open-folder" data-path="${esc(project.path)}">Open folder</button>
          <button class="btn sm" data-action="open-memory">Memory${project.memory_count ? ` · ${project.memory_count}` : ""}</button>
        </div>
      </div>`;
    if (!sessions.length) return `${head}${ui.skeletonTiles(4)}<div class="card">${ui.skeletonRows(6)}</div>`;

    const totalCost = sum(sessions, (session) => session.cost);
    const totalTokens = sum(sessions, (session) => (session.usage && session.usage.total) || 0);
    const activeMs = sum(sessions, (session) => session.active_ms);
    const errors = sum(sessions, (session) => session.tool_errors);
    const calls = sum(sessions, (session) => session.tool_calls);
    const last = Math.max(0, ...sessions.map((session) => session.mtime || 0));

    // Spend per day for this project, from each session's own ledger.
    const days = new Map();
    sessions.forEach((session) => Object.entries(session.daily || {}).forEach(([day, row]) => {
      const bucket = days.get(day) || { d: day, cost: 0, tokens: 0, models: {} };
      bucket.cost += row.c || 0;
      bucket.tokens += row.t || 0;
      Object.entries(row.m || {}).forEach(([model, cost]) => { bucket.models[model] = (bucket.models[model] || 0) + cost; });
      days.set(day, bucket);
    }));
    const rows = [...days.values()].sort((a, b) => a.d.localeCompare(b.d)).slice(-60);
    let chart = "";
    if (rows.length > 1) {
      const models = new Map();
      rows.forEach((day) => Object.entries(day.models).forEach(([model, cost]) => models.set(model, (models.get(model) || 0) + cost)));
      assignModelSlots([...models.keys()]);
      const series = priced
        ? [...models.entries()].sort((a, b) => b[1] - a[1]).map(([model]) => ({
            key: model, label: fmt.model(model), color: modelColour(model), values: rows.map((day) => day.models[model] || 0) }))
        : [{ key: "tokens", label: "tokens", color: "var(--series-1)", values: rows.map((day) => day.tokens) }];
      chart = ui.section(priced ? "Spend per day" : "Tokens per day", `<div class="card">${charts.columns(series, {
        labels: rows.map((day) => fmt.day(day.d + "T00:00:00")), tips: rows.map((day) => fmt.day(day.d + "T00:00:00")),
        format: priced ? fmt.cost : fmt.tokens, height: 160, labelEvery: 8 })}</div>`,
        { desc: `Days with activity in this project, most recent ${rows.length}.` });
    }

    const sort = State.sorts.project || { key: "mtime", dir: "desc" };
    const sorted = [...sessions].sort((a, b) => {
      const pick = (session) => {
        if (sort.key === "title") return String(session.title || session.first_prompt || "").toLowerCase();
        if (sort.key === "tokens") return (session.usage && session.usage.total) || 0;
        return Number(session[sort.key]) || 0;
      };
      const av = pick(a); const bv = pick(b);
      const order = av < bv ? -1 : av > bv ? 1 : 0;
      return sort.dir === "asc" ? order : -order;
    });
    const columns = [
      { key: "title", label: "Session", format: (session) => `<span class="cell-main">${esc(session.title || session.first_prompt || "Untitled session")}</span>${session.active ? ` <span class="badge green"><span class="dot-active"></span> live</span>` : ""}` },
      { key: "mtime", label: "Last active", align: "right", format: (session) => esc(fmt.rel(session.mtime)) },
      { key: "active_ms", label: "Time", align: "right", format: (session) => fmt.hours(session.active_ms) },
      { key: "assistant_messages", label: "Turns", align: "right", format: (session) => fmt.num(session.assistant_messages) },
      { key: "tool_errors", label: "Errors", align: "right", format: (session) => session.tool_errors ? fmt.num(session.tool_errors) : `<span class="faint">0</span>` },
      { key: "context_pct", label: "Context", align: "right", format: (session) => session.context_pct ? ui.meter(session.context_pct) : `<span class="faint">—</span>` },
      priced
        ? { key: "cost", label: "Spend", align: "right", format: (session) => fmt.cost(session.cost) }
        : { key: "tokens", label: "Tokens", align: "right", format: (session) => fmt.tokens((session.usage || {}).total) },
    ];
    const table = ui.table(columns, sorted, {
      sortKey: sort.key, sortDir: sort.dir, sortScope: "project",
      rowAttrs: (session) => `class="clickable" data-action="session" data-id="${esc(session.session_id)}"`,
    });

    const skills = {};
    const agents = {};
    sessions.forEach((session) => {
      Object.entries(session.skills || {}).forEach(([name, count]) => { skills[name] = (skills[name] || 0) + count; });
      Object.entries(session.agents || {}).forEach(([name, count]) => { agents[name] = (agents[name] || 0) + count; });
    });
    const chips = (table, kind) => Object.entries(table).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([name, count]) => `<span class="trace-chip k-${kind}"><span class="tc-dot"></span>${esc(name)}<b>${count}</b></span>`).join("");
    const traced = chips(skills, "skill") + chips(agents, "agent");

    return `${head}
      <div class="tiles">
        ${priced ? ui.tile("Spend", fmt.cost(totalCost), "API list prices, not a bill", { accent: true })
          : ui.tile("Tokens", fmt.tokens(totalTokens), "Codex plan usage; no dollar figure", { accent: true })}
        ${ui.tile("Time with agents", fmt.hours(activeMs), `${fmt.plural(sessions.length, "session")} · last ${fmt.rel(last)}`)}
        ${ui.tile("Tool errors", fmt.num(errors), calls ? `${fmt.pct(100 * errors / calls, 1)} of ${fmt.compact(calls)} calls` : "no tool calls yet",
          { cls: errors && calls && errors / calls >= 0.08 ? "warn" : "" })}
        ${ui.tile("Interruptions", fmt.num(sum(sessions, (session) => session.interrupts)),
          `${fmt.plural(sum(sessions, (session) => session.kills), "kill")} · ${fmt.plural(sum(sessions, (session) => session.compactions), "compaction")}`)}
      </div>
      ${chart}
      ${ui.section("Sessions", `<div class="card flush">${table}</div>`, { desc: "Click a row to open the session." })}
      ${traced ? ui.section("Skills and agents used here", `<div class="card"><div class="trace-chips">${traced}</div></div>`) : ""}`;
  }

  ASM.views = ASM.views || {};
  ASM.views.overview = { render, projectView, modelColour, assignModelSlots, projectColour };
})(window.ASM = window.ASM || {});
