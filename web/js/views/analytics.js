/* ============================================================
   Analytics — the numbers behind one session.

   Journey answers "what happened"; this tab answers "what did it
   cost, where did the context go, and what kept failing".
   ============================================================ */

(function (ASM) {
  "use strict";

  const { esc, fmt } = ASM.util;
  const ui = ASM.ui;
  const charts = ASM.charts;
  const State = ASM.state;

  /**
   * A plain-language read on whether this session is worth resuming.
   * Deliberately an estimate, and labelled as one: context percentage is
   * reconstructed from token usage, not read from the running process.
   */
  function health(detail) {
    const session = ASM.scope.currentSession() || {};
    const analytics = detail.analytics || {};
    const context = Number(session.context_pct || detail.context_pct || 0);
    const compactions = Number(analytics.compactions || 0);
    const errors = Number(analytics.tool_error_total || 0);
    const calls = Number(analytics.tool_calls || 0);
    const errorRate = calls ? (100 * errors) / calls : 0;

    let level = "";
    let label = "Roomy";
    let guidance = "A good candidate to resume. A long wall-clock duration on its own is not a problem.";
    if (context >= 80 || compactions >= 4 || errorRate >= 15) {
      level = "attention";
      label = "Near limit";
      guidance = "Context pressure, repeated compaction or a high tool-error rate. Compact with a clear focus, or start fresh with a handoff.";
    } else if (context >= 60 || compactions >= 2 || errorRate >= 8) {
      level = "watch";
      label = "Filling";
      guidance = "Still usable. Consider a focused compact before the next large phase of work.";
    }

    return `<div class="health ${level}">
      <span class="hp-state">${esc(label)}</span>
      <div class="hp-copy"><strong>Context status <span class="faint">· estimate</span></strong><p>${esc(guidance)}</p></div>
      <div class="hp-metrics">
        <span>context <b>${context.toFixed(0)}%</b></span>
        <span>compactions <b>${compactions}</b></span>
        <span>tool errors <b>${errorRate.toFixed(1)}%</b></span>
      </div>
      <div class="hp-actions">
        <button class="btn sm" data-action="copy-compact">Copy /compact</button>
        <button class="btn sm" data-action="launch-new">Start fresh</button>
      </div></div>`;
  }

  function render(detail) {
    const usage = detail.usage || {};
    const analytics = detail.analytics || {};
    const byModel = detail.usage_by_model || {};
    const provider = ASM.scope.currentProvider();
    const costKnown = provider !== "codex";
    const goals = detail.goals || {};

    const models = Object.entries(byModel)
      .filter(([name, value]) => name !== "unknown" && name !== "<synthetic>" && (value.total || 0) > 0)
      .sort((a, b) => b[1].total - a[1].total);

    const contextTokens = (usage.input || 0) + (usage.cache_read || 0) + (usage.cache_write || 0);
    const cacheHit = contextTokens ? (100 * (usage.cache_read || 0)) / contextTokens : 0;
    const turns = analytics.assistant_turns || 1;
    const reasoning = (analytics.thinking_chars + analytics.text_chars)
      ? (100 * analytics.thinking_chars) / (analytics.thinking_chars + analytics.text_chars) : 0;
    const errorRate = analytics.tool_calls ? (100 * analytics.tool_error_total) / analytics.tool_calls : 0;

    const timeline = detail.timeline || [];
    const contextPoints = timeline.map((point, index) => ({
      x: index, y: point.ctx, label: fmt.clock(point.t),
    }));
    const costPoints = timeline.filter((point) => point.cost != null)
      .map((point, index) => ({ x: index, y: point.cost, label: fmt.clock(point.t) }));
    const outputPoints = (analytics.output_per_turn || []).map((value, index) => ({ x: index, y: value }));

    const toolBars = Object.entries(detail.tool_counts || {}).slice(0, 14)
      .map(([name, count]) => ({
        label: name, value: count, valueText: fmt.num(count),
        color: `var(--cat-${ASM.categorize(name)})`,
      }));
    const fileBars = Object.entries(analytics.files_touched || {}).slice(0, 12)
      .map(([file, count]) => ({
        label: fmt.shortPath(file), value: count, valueText: fmt.num(count), color: "var(--cat-edit)",
      }));
    const commandBars = Object.entries(analytics.bash_commands || {}).slice(0, 10)
      .map(([command, count]) => ({ label: command, value: count, valueText: fmt.num(count), color: "var(--cat-exec)" }));
    const errorBars = Object.entries(analytics.tool_errors || {})
      .map(([name, count]) => ({ label: name, value: count, valueText: fmt.num(count), color: "var(--error)" }));

    const duration = analytics.first_ts && analytics.last_ts
      ? fmt.duration(fmt.ms(analytics.last_ts) - fmt.ms(analytics.first_ts)) : "—";

    return `${health(detail)}
      <div class="tiles" style="margin-top:14px">
        ${costKnown
          ? ui.tile("API-price estimate", fmt.cost(detail.cost), "Not a billing statement",
              { accent: true, tip: "Estimated from this session's Claude usage at list prices" })
          : ui.tile("Usage", "ChatGPT plan", "No dollar cost inferred", { accent: true })}
        ${ui.tile("Total tokens", fmt.tokens(usage.total),
          fmt.tokens(Math.round((usage.output || 0) / turns)) + " out per turn")}
        ${ui.tile("Cache hit rate", fmt.pct(cacheHit), fmt.tokens(usage.cache_read) + " read from cache",
          { tip: "Cached context costs about a tenth of fresh input" })}
        ${ui.tile("Duration", duration, `${analytics.user_prompts || 0} prompts · ${turns} turns`,
          { tip: "Wall-clock time from the first to the last message" })}
      </div>

      <div class="tiles">
        ${ui.tile("Tool calls", fmt.num(analytics.tool_calls),
          `${Object.keys(detail.tool_counts || {}).length} distinct tools`)}
        ${ui.tile("Tool errors", fmt.num(analytics.tool_error_total), fmt.pct(errorRate, 1) + " error rate")}
        ${ui.tile("Compactions", fmt.num(analytics.compactions), "context resets",
          { tip: "The context meter drops sharply at each one" })}
        ${ui.tile("Reasoning share", fmt.pct(reasoning), "of generated text",
          { tip: "How much generated text was reasoning rather than a visible reply" })}
      </div>

      ${goals.count ? ui.section("Work mix", `<div class="card">
        ${ui.stackBar(goals.by_cat, { tall: true })}
        <div style="margin-top:10px">${ui.categoryLegend(goals.by_cat)}</div>
        <div class="faint" style="font-size:11.5px;margin-top:8px">
          ${goals.count} goal${goals.count === 1 ? "" : "s"} · median ${fmt.duration(goals.median_ms)} ·
          ${goals.questions} question${goals.questions === 1 ? "" : "s"} back to you ·
          ${goals.failed} goal${goals.failed === 1 ? "" : "s"} dominated by failing tools.
          <button class="link-btn" data-action="tab" data-tab="journey">Open the Journey view</button>
        </div></div>`, { desc: "Every tool call in this session, grouped by the kind of work it was." }) : ""}

      ${ui.section("Token composition", `<div class="card">${ui.barList([
        { label: "Input", value: usage.input || 0, valueText: fmt.tokens(usage.input), color: "var(--cat-read)" },
        { label: "Output", value: usage.output || 0, valueText: fmt.tokens(usage.output), color: "var(--primary)" },
        { label: "Cache write", value: usage.cache_write || 0, valueText: fmt.tokens(usage.cache_write), color: "var(--cat-exec)" },
        { label: "Cache read", value: usage.cache_read || 0, valueText: fmt.tokens(usage.cache_read), color: "var(--cat-edit)" },
      ])}</div>`)}

      ${models.length ? ui.section("Tokens by model", `<div class="card"><div class="donut-wrap">
        ${charts.donut(models.map(([model, value], index) => ({
          label: fmt.model(model), value: value.total,
          color: ASM.views.overview.modelColour(model, index),
        })), { format: fmt.tokens, centerValue: fmt.tokens(usage.total), centerLabel: "tokens" })}
        <div class="legend" style="flex-direction:column;gap:7px">${models.map(([model, value], index) =>
          `<div class="legend-item">
            <span class="legend-swatch" style="background:${ASM.views.overview.modelColour(model, index)}"></span>
            <span>${esc(fmt.model(model))}</span>
            ${costKnown && value.cost != null ? `<b>${fmt.cost(value.cost)}</b>` : ""}
            <span class="faint">${fmt.tokens(value.total)} tok · ${fmt.tokens(value.output)} out</span></div>`).join("")}
        </div></div></div>`) : ""}

      ${contextPoints.length > 1 ? ui.section(
        `Context window over time${analytics.compactions ? ` · ${analytics.compactions} compaction${analytics.compactions === 1 ? "" : "s"}` : ""}`,
        `<div class="card">${charts.area(contextPoints, { color: "var(--cat-read)", format: fmt.tokens, height: 150 })}</div>`,
        { desc: "Each sharp drop is a compaction: the conversation was summarised to free context." }) : ""}

      ${costKnown && costPoints.length > 1 ? ui.section("Cumulative estimate",
        `<div class="card">${charts.area(costPoints, { color: "var(--primary)", format: fmt.cost, height: 130 })}</div>`) : ""}

      ${outputPoints.length > 1 ? ui.section("Output tokens per turn",
        `<div class="card">${charts.area(outputPoints, { color: "var(--cat-edit)", format: fmt.tokens, height: 120 })}</div>`) : ""}

      ${ui.section("Activity by hour (UTC)", `<div class="card">${charts.columns(analytics.hourly_utc || [], {
        labels: Array.from({ length: 24 }, (_, hour) => hour), color: "var(--cat-exec)", height: 110,
      })}</div>`)}

      ${toolBars.length ? ui.section("Tool usage", `<div class="card">${ui.barList(toolBars)}</div>`,
        { desc: "Coloured by the kind of work each tool does — the same colours as the Journey view." }) : ""}
      ${fileBars.length ? ui.section("Hottest files", `<div class="card">${ui.barList(fileBars)}</div>`) : ""}
      ${commandBars.length ? ui.section("Top shell commands", `<div class="card">${ui.barList(commandBars)}</div>`) : ""}
      ${errorBars.length ? ui.section("Errors by tool", `<div class="card">${ui.barList(errorBars)}</div>`) : ""}
    `;
  }

  ASM.views = ASM.views || {};
  ASM.views.analytics = { render, health };
})(window.ASM = window.ASM || {});
