/* ============================================================
   Summary — one session, explained.

   The Timeline shows what happened; this tab says what it meant.
   The headline figures come first, then findings in plain
   sentences (what the numbers say when someone reads them for
   you), then the two curves worth watching in any session (the
   context window and the running cost), then where the time and
   the attention went.
   ============================================================ */

(function (ASM) {
  "use strict";

  const { esc, fmt, sum } = ASM.util;
  const ui = ASM.ui;
  const charts = ASM.charts;
  const State = ASM.state;

  /* ---------- findings ---------- */

  function findings(detail) {
    const analytics = detail.analytics || {};
    const requests = detail.requests || {};
    const list = requests.requests || [];
    const trace = detail.trace || {};
    const priced = ASM.scope.priced(ASM.scope.currentProvider());
    const items = [];
    const calls = analytics.tool_calls || 0;
    const errors = analytics.tool_error_total || 0;
    const errorRate = calls ? (100 * errors) / calls : 0;
    const wall = analytics.first_ts && analytics.last_ts ? fmt.ms(analytics.last_ts) - fmt.ms(analytics.first_ts) : 0;
    const active = analytics.active_ms || 0;
    const window_ = detail.context_window || 0;
    const peakPct = window_ ? (100 * (detail.peak_context_tokens || 0)) / window_ : 0;

    // Time: where the hours went.
    const catMs = requests.cat_ms || {};
    const heaviest = Object.entries(catMs).sort((a, b) => b[1] - a[1])[0];
    if (heaviest && active) {
      const [category, ms] = heaviest;
      const share = Math.min(100, (100 * ms) / active);
      items.push({ tone: "note",
        text: `<b>${esc(ui.CATEGORY_LABELS[category] || category)}</b> work took ${esc(fmt.duration(ms))}, about ${esc(fmt.pct(share))} of the active time.` });
    }
    const idle = analytics.idle || [];
    if (idle.length && wall) {
      const longest = idle.reduce((best, gap) => (gap[1] - gap[0] > best[1] - best[0] ? gap : best), idle[0]);
      items.push({ tone: "note",
        text: `Idle for ${esc(fmt.hours(wall - active))} of the ${esc(fmt.hours(wall))} wall clock; the longest pause was ${esc(fmt.duration(longest[1] - longest[0]))} from ${esc(fmt.clock(longest[0]))}.` });
    }

    // Context pressure.
    if (analytics.compactions) {
      const marks = analytics.compaction_marks || [];
      const when = marks.length ? ` The first was at ${fmt.clock(marks[0].t)}, from ${fmt.tokens(marks[0].from)} down to ${fmt.tokens(marks[0].to)} tokens.` : "";
      items.push({ tone: analytics.compactions >= 3 ? "warn" : "note",
        text: `The context was compacted <b>${analytics.compactions}</b> time${analytics.compactions === 1 ? "" : "s"}.${esc(when)}` });
    } else if (peakPct >= 75) {
      items.push({ tone: "warn", text: `The context reached <b>${esc(fmt.pct(peakPct))}</b> of the window without a compaction.` });
    }

    // Reliability.
    if (errors) {
      const byTool = Object.entries(analytics.tool_errors || {}).slice(0, 3)
        .map(([name, count]) => `${name} ×${count}`).join(", ");
      items.push({ tone: errorRate >= 10 ? "bad" : errorRate >= 4 ? "warn" : "note",
        text: `<b>${fmt.num(errors)}</b> of ${fmt.num(calls)} tool calls failed (${esc(fmt.pct(errorRate, 1))})${byTool ? `: ${esc(byTool)}` : "."}` });
    } else if (calls >= 20) {
      items.push({ tone: "good", text: `All <b>${fmt.num(calls)}</b> tool calls succeeded.` });
    }
    const repeats = Object.entries(analytics.command_repeats || {}).sort((a, b) => b[1] - a[1]);
    if (repeats.length && repeats[0][1] >= 3) {
      const [command, count] = repeats[0];
      items.push({ tone: "note", text: `The same command ran <b>${count}</b> times: <code>${esc(command.length > 70 ? command.slice(0, 69) + "…" : command)}</code>` });
    }
    const reads = Object.entries(analytics.file_reads || {}).sort((a, b) => b[1] - a[1]);
    if (reads.length && reads[0][1] >= 5) {
      items.push({ tone: "note", text: `<b>${esc(fmt.shortPath(reads[0][0]))}</b> was read ${reads[0][1]} times.`,
        detail: "Re-reading the same file is a sign the context lost it, or that the agent was checking its own edits." });
    }

    // People and delegation.
    if (trace.interrupts) {
      items.push({ tone: "warn", text: `You interrupted the agent <b>${trace.interrupts}</b> time${trace.interrupts === 1 ? "" : "s"}.` });
    }
    if (requests.questions) {
      items.push({ tone: "note", text: `The agent stopped to ask you something <b>${requests.questions}</b> time${requests.questions === 1 ? "" : "s"}.` });
    }
    const agentCount = sum(Object.values(trace.agents || {}));
    if (agentCount) {
      const kinds = Object.entries(trace.agents || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, count]) => `${name} ×${count}`).join(", ");
      items.push({ tone: "note", text: `<b>${agentCount}</b> subagent${agentCount === 1 ? "" : "s"} spawned: ${esc(kinds)}.`, action: "tab", id: "trace" });
    }
    if (trace.kills) {
      items.push({ tone: "warn", text: `<b>${trace.kills}</b> background task${trace.kills === 1 ? " was" : "s were"} killed.`, action: "tab", id: "trace" });
    }
    const skillCount = sum(Object.values(trace.skills || {}));
    if (skillCount) {
      items.push({ tone: "note", text: `Skills used: ${esc(Object.keys(trace.skills).join(", "))}.` });
    }

    // Money.
    if (priced && detail.cache_savings > 0.5) {
      items.push({ tone: "good", text: `Prompt caching saved about <b>${esc(fmt.cost(detail.cache_savings))}</b> against fresh input.` });
    }
    const latencies = list.map((item) => item.latency_ms).filter((value) => value > 0).sort((a, b) => a - b);
    if (latencies.length >= 3) {
      const median = latencies[Math.floor(latencies.length / 2)];
      const slowest = list.reduce((best, item) => (item.ms > (best ? best.ms : 0) ? item : best), null);
      items.push({ tone: "note",
        text: `First reply in <b>${esc(fmt.duration(median))}</b> (median).${slowest ? ` The longest prompt ran ${fmt.duration(slowest.ms)}.` : ""}`,
        action: slowest ? "prompt-open" : "", id: slowest ? String(slowest.i) : "" });
    }
    return items;
  }

  /* ---------- pieces ---------- */

  function headlineTiles(detail, priced) {
    const usage = detail.usage || {};
    const analytics = detail.analytics || {};
    const requests = detail.requests || {};
    const trace = detail.trace || {};
    const wall = analytics.first_ts && analytics.last_ts ? fmt.ms(analytics.last_ts) - fmt.ms(analytics.first_ts) : 0;
    const window_ = detail.context_window || 0;
    const contextPct = window_ ? (100 * (detail.last_context_tokens || 0)) / window_ : Number(detail.context_pct || 0);
    const peakPct = window_ ? (100 * (detail.peak_context_tokens || 0)) / window_ : 0;
    const calls = analytics.tool_calls || 0;
    const errors = analytics.tool_error_total || 0;
    const errorRate = calls ? (100 * errors) / calls : 0;
    const tone = contextPct >= 80 ? "bad" : contextPct >= 60 ? "warn" : "";
    return `<div class="tiles">
      ${priced
        ? ui.tile("Spend", fmt.cost(detail.cost), `${fmt.tokens(usage.total)} tokens · ${fmt.tokens(usage.output)} generated`, { accent: true,
            tip: "Estimated from this session's usage at API list prices." })
        : ui.tile("Tokens", fmt.tokens(usage.total), `${fmt.tokens(usage.output)} generated`, { accent: true })}
      ${ui.tile("Active time", fmt.hours(analytics.active_ms), wall ? `${fmt.hours(wall)} wall clock · ${fmt.plural(requests.count || analytics.user_prompts || 0, "prompt")}` : "",
        { tip: "Time while the transcript was being written, with pauses over five minutes left out." })}
      ${ui.tile("Context", `${ui.meter(contextPct)} <span class="t-inline">${fmt.pct(contextPct)}</span>`,
        `${peakPct ? `peak ${fmt.pct(peakPct)} · ` : ""}${fmt.plural(analytics.compactions || 0, "compaction")}`,
        { cls: tone, tip: "How full the context window was at the last turn, reconstructed from token usage." })}
      ${ui.tile("Reliability", fmt.pct(100 - errorRate),
        `${fmt.plural(errors, "failed call")} · ${fmt.plural(trace.interrupts || 0, "interruption")}`,
        { cls: errorRate >= 10 ? "bad" : errorRate >= 4 ? "warn" : "", tip: "Share of tool calls that returned without an error." })}
    </div>`;
  }

  function curves(detail, priced) {
    const timeline = detail.timeline || [];
    const analytics = detail.analytics || {};
    if (timeline.length < 2) return "";
    const contextPoints = timeline.map((point) => ({ x: fmt.ms(point.t), y: point.ctx, label: fmt.clock(point.t) }));
    const marks = (analytics.compaction_marks || []).map((mark) => ({ x: fmt.ms(mark.t) }));
    const window_ = detail.context_window || 0;
    const context = ui.section("Context window", `<div class="card">${charts.area(contextPoints, {
      color: "var(--series-1)", format: fmt.tokens, height: 150, marks, xLabels: true,
      ceiling: window_ || 0, ceilingLabel: window_ ? `window ${fmt.tokens(window_)}` : "",
      ariaLabel: "Context tokens over the session" })}</div>`,
      { desc: marks.length ? "Each dashed line is a compaction: the conversation was summarised to free context." : "Tokens in the window at each turn." });
    if (!priced) return context;
    const costPoints = timeline.filter((point) => point.cost != null)
      .map((point) => ({ x: fmt.ms(point.t), y: point.cost, label: fmt.clock(point.t) }));
    const cost = costPoints.length > 1 ? ui.section("Running cost", `<div class="card">${charts.area(costPoints, {
      color: "var(--primary)", format: fmt.cost, height: 150, xLabels: true, ariaLabel: "Cumulative cost over the session" })}</div>`,
      { desc: "Cumulative estimate. A steep stretch is expensive work, a flat one is thinking or waiting." }) : "";
    return `<div class="split-2">${context}${cost}</div>`;
  }

  function workMix(detail) {
    const requests = detail.requests || {};
    if (!requests.count) return "";
    return ui.section("Where the time went", `<div class="card">
      ${ui.stackBar(requests.by_cat, { tall: true })}
      <div style="margin-top:10px">${ui.categoryLegend(requests.by_cat, { ms: requests.cat_ms })}</div>
      <div class="section-note">${fmt.plural(requests.count, "prompt")}${requests.tool_ms ? ` · ${fmt.duration(requests.tool_ms)} inside tool calls` : ""}${
        requests.questions ? ` · asked you ${fmt.plural(requests.questions, "time")}` : ""}.
        <button class="link-btn" data-action="tab" data-tab="timeline">Open the timeline</button></div></div>`, {
      desc: "Every tool call grouped by the kind of work it was. Times are wall clock with parallel calls counted once.",
    });
  }

  function attention(detail) {
    const analytics = detail.analytics || {};
    const reads = analytics.file_reads || {};
    const edits = analytics.file_edits || {};
    const files = [...new Set([...Object.keys(reads), ...Object.keys(edits)])]
      .map((file) => ({ file, reads: reads[file] || 0, edits: edits[file] || 0 }))
      .sort((a, b) => (b.reads + b.edits) - (a.reads + a.edits)).slice(0, 10);
    const commands = Object.entries(analytics.bash_commands || {}).slice(0, 8);
    const errors = Object.entries(analytics.tool_errors || {});
    if (!files.length && !commands.length && !errors.length) return "";
    const max = Math.max(1, ...files.map((entry) => entry.reads + entry.edits));
    const fileRows = files.length ? `<div class="chart-bars">${files.map((entry) =>
      `<div class="bar-row" data-tip="${esc(entry.file)}\n${entry.reads} reads · ${entry.edits} edits">
        <span class="bar-label">${esc(fmt.shortPath(entry.file))}</span>
        <span class="bar-track two-tone">
          <span class="bar-fill" style="width:${(100 * entry.reads / max).toFixed(1)}%;background:var(--cat-read)"></span>
          <span class="bar-fill" style="width:${(100 * entry.edits / max).toFixed(1)}%;background:var(--cat-edit)"></span></span>
        <span class="bar-val">${entry.reads + entry.edits}</span></div>`).join("")}</div>
      <div class="legend" style="margin-top:8px"><span class="legend-item"><span class="legend-swatch" style="background:var(--cat-read)"></span>reads</span>
        <span class="legend-item"><span class="legend-swatch" style="background:var(--cat-edit)"></span>edits</span></div>` : `<div class="faint">No files touched.</div>`;
    const commandRows = commands.length
      ? ui.barList(commands.map(([command, count]) => ({ label: command, value: count, valueText: fmt.num(count) })), { color: "var(--cat-exec)" })
      : `<div class="faint">No shell commands.</div>`;
    const errorRows = errors.length
      ? ui.barList(errors.map(([name, count]) => ({ label: name, value: count, valueText: fmt.num(count) })), { color: "var(--error)" })
      : "";
    return ui.section("Files and commands", `<div class="split-2">
      <div class="card"><div class="card-title">Files, by attention</div>${fileRows}</div>
      <div class="card"><div class="card-title">Shell commands</div>${commandRows}
        ${errorRows ? `<div class="card-title" style="margin-top:14px">Errors by tool</div>${errorRows}` : ""}</div>
    </div>`);
  }

  function tracedHere(detail) {
    const trace = detail.trace || {};
    const events = trace.events || [];
    if (!events.length) return "";
    const counts = {};
    events.forEach((event) => { counts[event.k] = (counts[event.k] || 0) + 1; });
    const chips = Object.entries(counts).map(([kind, count]) =>
      `<span class="trace-chip k-${esc(kind)}"><span class="tc-dot"></span>${esc(ui.TRACE_LABELS[kind] || kind)}<b>${count}</b></span>`).join("");
    const recent = events.slice(-5).reverse();
    return ui.section("Skills, agents and interruptions", `<div class="card">
      <div class="trace-chips">${chips}</div>
      <div class="trace-list compact">${recent.map((event) => `<div class="trace-row">
        <span class="tr-time">${esc(fmt.clock(event.t))}</span>
        ${ui.traceChip(event.k)}
        <span class="tr-name">${esc(event.n)}</span>
        <span class="tr-detail">${esc(event.d || "")}</span>
        <span class="tr-ms">${event.ms ? esc(fmt.duration(event.ms)) : ""}${event.e ? ` <span class="badge red">failed</span>` : ""}</span></div>`).join("")}</div>
    </div>`, {
      desc: "The last few traced moments in this session.",
      actions: `<button class="btn sm" data-action="tab" data-tab="trace">Full trace · ${events.length}</button>`,
    });
  }

  function render(detail) {
    const priced = ASM.scope.priced(ASM.scope.currentProvider());
    const items = findings(detail);
    return `${headlineTiles(detail, priced)}
      ${items.length ? ui.section("What stands out", `<div class="card">${ui.insights(items)}</div>`) : ""}
      ${curves(detail, priced)}
      ${workMix(detail)}
      ${attention(detail)}
      ${tracedHere(detail)}`;
  }

  ASM.views = ASM.views || {};
  ASM.views.summary = { render, findings };
})(window.ASM = window.ASM || {});
