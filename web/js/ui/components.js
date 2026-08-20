/* ============================================================
   The markup primitives every view is assembled from. All of them
   return HTML strings — the app renders by replacing innerHTML on a
   pane, which is fast enough for these payloads and keeps each view
   a plain function of state.
   ============================================================ */

(function (ASM) {
  "use strict";

  const { esc, fmt } = ASM.util;
  const State = ASM.state;

  /** The ten work categories, in the order the backend declares them. */
  const CATEGORIES = ["read", "search", "edit", "exec", "web", "agent", "plan", "ask", "mcp", "other"];
  const CATEGORY_LABELS = {
    read: "read", search: "search", edit: "edit", exec: "shell", web: "web",
    agent: "subagent", plan: "plan", ask: "question", mcp: "mcp", other: "other",
  };

  function section(title, body, options = {}) {
    const actions = options.actions ? `<div class="st-actions">${options.actions}</div>` : "";
    const desc = options.desc ? `<div class="section-desc">${esc(options.desc)}</div>` : "";
    return `<section class="section">
      <div class="section-title"><span>${esc(title)}</span>${actions}</div>
      ${desc}${body}</section>`;
  }

  function card(body, extraClass = "") {
    return `<div class="card ${extraClass}">${body}</div>`;
  }

  function tile(label, value, sub, options = {}) {
    const cls = options.accent ? "tile accent" : "tile";
    const tip = options.tip ? ` title="${esc(options.tip)}"` : "";
    const spark = options.spark ? `<div class="t-spark">${options.spark}</div>` : "";
    return `<div class="${cls}"${tip}>
      <div class="t-label">${esc(label)}</div>
      <div class="t-value">${value}</div>
      ${sub ? `<div class="t-sub">${esc(sub)}</div>` : ""}${spark}</div>`;
  }

  function badge(text, cls = "") {
    return `<span class="badge ${cls}">${esc(text)}</span>`;
  }

  function providerBadge(provider) {
    if (!provider) return "";
    if (State.agent !== "all" && State.view !== "search") return "";
    return badge(ASM.agentInfo(provider).short, provider);
  }

  function sourceBadge(item) {
    if (!item || !item.source_label) return "";
    if (State.source !== "all" && State.enabledSources.size <= 1) return "";
    return badge(item.source_label);
  }

  /** The ten-slot context meter, mirroring the terminal statusline. */
  function meter(percent) {
    const value = Math.max(0, Math.min(100, Number(percent) || 0));
    const filled = Math.round(value / 10);
    const cls = value > 80 ? "meter crit" : value > 50 ? "meter warn" : "meter";
    let slots = "";
    for (let i = 0; i < 10; i += 1) slots += `<span class="slot ${i < filled ? "on" : ""}"></span>`;
    return `<span class="${cls}" title="${value.toFixed(0)}% of the context window">${slots}</span>`;
  }

  function meterRow(label, percent, text) {
    const value = Number(percent) || 0;
    return `<div class="meter-row"><span class="m-label">${esc(label)}</span>${meter(value)}
      <span class="m-val">${esc(text != null ? text : value.toFixed(0) + "%")}</span></div>`;
  }

  function emptyState(glyph, title, sub) {
    return `<div class="empty"><div class="empty-ic">${esc(glyph)}</div>
      <h3>${esc(title)}</h3>${sub ? `<p>${esc(sub)}</p>` : ""}</div>`;
  }

  function skeleton(text) {
    return `<div class="skeleton">${esc(text)}</div>`;
  }

  function notice(html, cls = "") {
    return `<div class="notice ${cls}">${html}</div>`;
  }

  /** One small square in a category colour — the legend atom. */
  function categoryDot(category) {
    return `<span class="dot bg-${esc(category)}"></span>`;
  }

  /**
   * A composition bar: one segment per category, widths proportional.
   * This is the same shape everywhere it appears — in a goal row, in a
   * session summary and in the project rollup — so the eye learns it once.
   */
  function stackBar(byCategory, options = {}) {
    const entries = CATEGORIES
      .map((category) => [category, Number(byCategory && byCategory[category]) || 0])
      .filter(([, count]) => count > 0);
    const total = entries.reduce((sum, [, count]) => sum + count, 0);
    if (!total) return `<div class="stack ${options.tall ? "tall" : ""}"></div>`;
    const segments = entries.map(([category, count]) =>
      `<span class="seg bg-${category}" style="width:${(100 * count / total).toFixed(2)}%"
        title="${count} ${esc(CATEGORY_LABELS[category] || category)}"></span>`).join("");
    return `<div class="stack ${options.tall ? "tall" : ""}">${segments}</div>`;
  }

  /**
   * The work legend: one chip per category, with how many calls and — when the
   * caller has the timings — how long that kind of work actually took.
   *
   * The times are a union of overlapping calls, so they do not add up to the
   * session length and are not presented as if they did.
   */
  function categoryLegend(byCategory, options = {}) {
    const times = options.ms || {};
    const entries = CATEGORIES
      .map((category) => [category, Number(byCategory && byCategory[category]) || 0])
      .filter(([category, count]) => count > 0 || times[category] > 0 || options.showEmpty);
    if (!entries.length) return "";
    return `<div class="jn-legend">${entries.map(([category, count]) => {
      const off = options.filter && options.filter.has(category);
      const spent = Number(times[category]) || 0;
      const label = CATEGORY_LABELS[category] || category;
      const tip = `${label} — ${count} call${count === 1 ? "" : "s"}` +
        (spent ? `, ${fmt.duration(spent)} of wall clock` : "") +
        (options.action ? ` · click to ${off ? "show" : "hide"}` : "");
      return `<button class="jn-cat ${off ? "off" : ""}" data-action="${esc(options.action || "")}"
        data-cat="${category}" title="${esc(tip)}">
        ${categoryDot(category)}<span>${esc(label)}</span><b>${count}</b>
        ${spent ? `<i class="jc-ms">${esc(fmt.duration(spent))}</i>` : ""}</button>`;
    }).join("")}</div>`;
  }

  /** Horizontal bars for a ranked list. */
  function barList(items, options = {}) {
    if (!items.length) return `<div class="chart-empty">No data yet.</div>`;
    const max = Math.max(1, ...items.map((item) => item.value));
    return `<div class="chart-bars">${items.map((item, index) => {
      const colour = item.color || `var(--series-${(index % 8) + 1})`;
      const width = (100 * item.value / max).toFixed(1);
      const label = options.rtl === false ? esc(item.label) : esc(item.label);
      return `<div class="bar-row"${item.action ? ` data-action="${esc(item.action)}" data-id="${esc(item.id || "")}" style="cursor:pointer"` : ""}>
        <span class="bar-label" title="${esc(item.label)}">${label}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${width}%;background:${colour}"></span></span>
        <span class="bar-val">${esc(item.valueText != null ? item.valueText : item.value)}</span>
      </div>`;
    }).join("")}</div>`;
  }

  function kv(pairs) {
    return `<div class="kv">${pairs.map(([key, value]) =>
      `<div class="k">${esc(key)}</div><div class="v">${esc(value)}</div>`).join("")}</div>`;
  }

  function tabs(items, current, action = "tab") {
    return `<div class="tabs">${items.map(([key, label, count]) =>
      `<button class="tab ${key === current ? "active" : ""}" data-action="${esc(action)}" data-tab="${esc(key)}">
        ${esc(label)}${count != null ? `<span class="tab-count">${count}</span>` : ""}
      </button>`).join("")}</div>`;
  }

  /**
   * Map a tool name onto a work category.
   *
   * The backend already categorises everything it aggregates (asm/goals.py);
   * this exists only for the transcript, which streams raw tool names the
   * server never pre-labelled. The two tables must agree, so keep this in
   * step with `_CATEGORY_BY_NAME` there.
   */
  const CATEGORY_BY_NAME = {
    read: "read", notebookread: "read", view: "read", read_file: "read", ls: "read", cat: "read",
    grep: "search", glob: "search", search: "search", find: "search", toolsearch: "search",
    edit: "edit", multiedit: "edit", write: "edit", notebookedit: "edit", apply_patch: "edit", artifact: "edit",
    bash: "exec", bashoutput: "exec", killshell: "exec", powershell: "exec", exec: "exec",
    shell: "exec", shell_command: "exec", monitor: "exec",
    websearch: "web", webfetch: "web", web_search: "web", web_fetch: "web", fetch: "web",
    agent: "agent", task: "agent", workflow: "agent", spawn_agent: "agent", sendmessage: "agent",
    taskoutput: "agent", taskstop: "agent",
    todowrite: "plan", todoread: "plan", update_plan: "plan", exitplanmode: "plan",
    enterplanmode: "plan", skill: "plan", slashcommand: "plan", taskcreate: "plan",
    taskupdate: "plan", reportfindings: "plan",
    askuserquestion: "ask", ask_user: "ask",
  };

  function categorize(name) {
    if (!name) return "other";
    const lowered = String(name).trim().toLowerCase();
    if (CATEGORY_BY_NAME[lowered]) return CATEGORY_BY_NAME[lowered];
    if (lowered.startsWith("mcp__") || lowered.startsWith("mcp.")) return "mcp";
    const rules = [
      ["question", "ask"], ["search", "search"], ["grep", "search"], ["write", "edit"],
      ["edit", "edit"], ["patch", "edit"], ["read", "read"], ["shell", "exec"],
      ["bash", "exec"], ["exec", "exec"], ["fetch", "web"], ["http", "web"],
      ["agent", "agent"], ["plan", "plan"],
    ];
    for (const [needle, category] of rules) if (lowered.includes(needle)) return category;
    return "other";
  }

  ASM.categorize = categorize;
  ASM.ui = {
    CATEGORIES, CATEGORY_LABELS, categorize,
    section, card, tile, badge, providerBadge, sourceBadge, meter, meterRow,
    emptyState, skeleton, notice, categoryDot, stackBar, categoryLegend,
    barList, kv, tabs,
  };
})(window.ASM = window.ASM || {});
