/* ============================================================
   Journey — a session as the arc of the work, at two levels.

   **Goals** are Claude Code's `/goal` directives: a Stop hook with a
   condition that blocks the agent from stopping until it holds. Each
   has a real start, a real end, and a measurable middle. That is the
   headline of this view.

   **Prompts** are what you sent. While a goal is active they are
   follow-ups inside it, so they are shown under the goal that was
   running rather than as a list of little goals of their own.

   The ribbon is a canvas, for two reasons. A busy session is tens of
   thousands of tool marks and a DOM node each would crawl; and the
   time axis needs *collapsed idle gaps*, so an overnight pause does
   not squeeze the rest of the session into a sliver. Both are easier
   to get right with an explicit time-to-pixel map than with layout.
   ============================================================ */

(function (ASM) {
  "use strict";

  const { esc, fmt, dom, clamp } = ASM.util;
  const ui = ASM.ui;
  const State = ASM.state;

  /* ---------------------------------------------------------------- */
  /* time mapping                                                      */
  /* ---------------------------------------------------------------- */

  const GAP_PIXELS = 26;

  /**
   * Build a piecewise-linear map from wall-clock time to pixels.
   *
   * Active stretches keep their real proportions. A gap longer than the
   * threshold is squeezed into a fixed band, so the hour you spent at lunch
   * costs the chart 26 pixels instead of two-thirds of its width. The bands
   * are hatched and labelled with the real duration, so nothing is hidden.
   */
  function buildTimeMap(spansIn, width) {
    const spans = spansIn
      .map(([a, b]) => [fmt.ms(a), fmt.ms(b || a)])
      .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
      .map(([a, b]) => [a, Math.max(a, b)])
      .sort((x, y) => x[0] - y[0]);
    if (!spans.length) return null;

    // Merge overlaps so concurrent-looking spans do not double-count time.
    const merged = [spans[0].slice()];
    for (const [start, end] of spans.slice(1)) {
      const last = merged[merged.length - 1];
      if (start <= last[1]) last[1] = Math.max(last[1], end);
      else merged.push([start, end]);
    }

    const activeMs = merged.reduce((sum, [a, b]) => sum + (b - a), 0);
    // Anything longer than a fifth of the total work, or five minutes,
    // whichever is larger, is dead air worth collapsing.
    const threshold = Math.max(5 * 60 * 1000, activeMs * 0.2);

    const pieces = [];
    let gapCount = 0;
    for (let i = 0; i < merged.length; i += 1) {
      if (i > 0) {
        const gap = merged[i][0] - merged[i - 1][1];
        if (gap > threshold) {
          pieces.push({ gap: true, t0: merged[i - 1][1], t1: merged[i][0] });
          gapCount += 1;
        } else {
          merged[i - 1][1] = merged[i][0];   // absorb short gaps into the run
        }
      }
      pieces.push({ gap: false, t0: merged[i][0], t1: merged[i][1] });
    }

    const liveMs = pieces.filter((piece) => !piece.gap)
      .reduce((sum, piece) => sum + Math.max(1, piece.t1 - piece.t0), 0);
    const drawable = Math.max(40, width - gapCount * GAP_PIXELS);
    let x = 0;
    for (const piece of pieces) {
      piece.x0 = x;
      piece.width = piece.gap ? GAP_PIXELS : Math.max(1, ((piece.t1 - piece.t0) / liveMs) * drawable);
      x += piece.width;
      piece.x1 = x;
    }

    function toX(time) {
      if (!Number.isFinite(time)) return 0;
      for (const piece of pieces) {
        if (time <= piece.t1) {
          if (time <= piece.t0) return piece.x0;
          const fraction = (time - piece.t0) / Math.max(1, piece.t1 - piece.t0);
          return piece.x0 + fraction * piece.width;
        }
      }
      return x;
    }

    return { pieces, toX, total: x, start: merged[0][0], end: merged[merged.length - 1][1] };
  }

  function timeAtX(map, x) {
    for (const piece of map.pieces) {
      if (x <= piece.x1) {
        const fraction = (x - piece.x0) / Math.max(1, piece.width);
        return piece.t0 + fraction * (piece.t1 - piece.t0);
      }
    }
    return map.end;
  }

  /* ---------------------------------------------------------------- */
  /* data                                                              */
  /* ---------------------------------------------------------------- */

  function arcOf(detail) {
    const payload = detail || {};
    const requests = payload.requests || { requests: [], by_cat: {}, cat_ms: {} };
    const goals = payload.goals || { goals: [] };
    return { requests, goals, list: requests.requests || [], runs: goals.goals || [] };
  }

  /** The prompts that ran inside one goal. */
  function promptsOf(goal, list) {
    const ids = new Set(goal.request_ids || []);
    return list.filter((item) => ids.has(item.i));
  }

  /** Every tool call inside a goal, in the order it happened. */
  function stepsOf(goal, list) {
    const steps = [];
    for (const item of promptsOf(goal, list)) {
      for (const step of item.steps || []) steps.push(step);
    }
    return steps.sort((a, b) => String(a.t).localeCompare(String(b.t)));
  }

  function visiblePrompts(list) {
    const hidden = State.goalFilter;
    if (!hidden.size) return list;
    // A category filter hides prompts that consist *only* of hidden work — it
    // never hides one that also did something you asked to see.
    return list.filter((item) => {
      const categories = Object.keys(item.by_cat || {});
      if (!categories.length) return true;
      return categories.some((category) => !hidden.has(category));
    });
  }

  function sortedPrompts(list) {
    const copy = [...list];
    if (State.goalSort === "duration") copy.sort((a, b) => b.ms - a.ms);
    else if (State.goalSort === "tools") copy.sort((a, b) => b.tools - a.tools);
    else if (State.goalSort === "errors") copy.sort((a, b) => (b.errors - a.errors) || (b.tools - a.tools));
    return copy;
  }

  /** Prompts belonging to the selected goal, or all of them when none is picked. */
  function scopedPrompts(list, runs) {
    if (State.goalIndex == null) return list;
    const goal = runs.find((run) => run.i === State.goalIndex);
    return goal ? promptsOf(goal, list) : list;
  }

  /* ---------------------------------------------------------------- */
  /* the ribbon                                                        */
  /* ---------------------------------------------------------------- */

  const AXIS_HEIGHT = 20;
  const GOAL_BAND = 18;
  const ribbon = { canvas: null, prompts: [], runs: [], map: null, rowHeight: 16, hitRows: [], bandTop: 0 };

  function colour(name) { return dom.token(name, "#888"); }

  function goalColour(goal) {
    if (goal.met) return colour("--success");
    if (goal.superseded) return colour("--fg-faint");
    return colour("--primary");
  }

  function drawRibbon() {
    const canvas = ribbon.canvas;
    if (!canvas || !canvas.isConnected) return;
    const prompts = ribbon.prompts;
    const runs = ribbon.runs;
    const cssWidth = canvas.parentElement.clientWidth;
    if (cssWidth < 40) return;

    const bandHeight = runs.length ? GOAL_BAND : 0;
    const rowHeight = clamp(Math.floor(300 / Math.max(1, prompts.length)), 5, 20);
    ribbon.rowHeight = rowHeight;
    ribbon.bandTop = AXIS_HEIGHT;
    const cssHeight = AXIS_HEIGHT + bandHeight + prompts.length * rowHeight + 4;
    const ratio = window.devicePixelRatio || 1;

    canvas.width = Math.round(cssWidth * ratio);
    canvas.height = Math.round(cssHeight * ratio);
    canvas.style.height = cssHeight + "px";

    const context = canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, cssWidth, cssHeight);

    // The axis spans goals *and* prompts, so a goal band never falls outside it.
    const spans = prompts.map((item) => [item.start, item.end])
      .concat(runs.map((run) => [run.start, run.end || run.start]));
    const map = buildTimeMap(spans, cssWidth - 2);
    ribbon.map = map;
    if (!map) return;

    const line = colour("--line");
    const lineStrong = colour("--line-strong");
    const faint = colour("--fg-faint");
    const panel = colour("--panel");
    const accent = colour("--accent");

    /* --- collapsed idle bands, painted behind everything --- */
    context.save();
    for (const piece of map.pieces) {
      if (!piece.gap) continue;
      context.fillStyle = panel;
      context.globalAlpha = 0.5;
      context.fillRect(piece.x0 + 1, 0, piece.width, cssHeight);
      context.globalAlpha = 1;
      context.strokeStyle = lineStrong;
      context.setLineDash([2, 3]);
      context.beginPath();
      context.moveTo(piece.x0 + 1.5, 0); context.lineTo(piece.x0 + 1.5, cssHeight);
      context.moveTo(piece.x1 + 0.5, 0); context.lineTo(piece.x1 + 0.5, cssHeight);
      context.stroke();
      context.setLineDash([]);
      context.fillStyle = faint;
      context.font = "9px ui-monospace, monospace";
      context.save();
      context.translate(piece.x0 + piece.width / 2 + 3, cssHeight / 2);
      context.rotate(-Math.PI / 2);
      context.textAlign = "center";
      context.fillText(fmt.duration(piece.t1 - piece.t0) + " idle", 0, 0);
      context.restore();
    }
    context.restore();

    /* --- axis --- */
    context.strokeStyle = line;
    context.beginPath();
    context.moveTo(0, AXIS_HEIGHT - 0.5);
    context.lineTo(cssWidth, AXIS_HEIGHT - 0.5);
    context.stroke();

    context.fillStyle = faint;
    context.font = "9.5px ui-monospace, monospace";
    context.textBaseline = "middle";
    const ticks = Math.max(2, Math.min(8, Math.floor(cssWidth / 110)));
    for (let i = 0; i <= ticks; i += 1) {
      const x = (i / ticks) * (cssWidth - 2);
      context.textAlign = i === 0 ? "left" : i === ticks ? "right" : "center";
      context.fillText(fmt.clock(timeAtX(map, x)), clamp(x, 2, cssWidth - 2), AXIS_HEIGHT / 2);
      context.strokeStyle = line;
      context.beginPath();
      context.moveTo(x + 0.5, AXIS_HEIGHT - 5);
      context.lineTo(x + 0.5, AXIS_HEIGHT);
      context.stroke();
    }

    /* --- the goal band: what was running, and for how long --- */
    runs.forEach((run) => {
      const x0 = map.toX(fmt.ms(run.start));
      const x1 = Math.max(x0 + 3, map.toX(fmt.ms(run.end || map.end)));
      const tone = goalColour(run);
      const top = ribbon.bandTop + 2;
      const height = GOAL_BAND - 5;

      context.fillStyle = tone;
      context.globalAlpha = State.goalIndex === run.i ? 0.45 : 0.24;
      context.fillRect(x0, top, x1 - x0, height);
      context.globalAlpha = 1;
      context.fillRect(x0, top, 2, height);                       // set here
      if (!run.open) context.fillRect(x1 - 2, top, 2, height);     // ended here

      // A goal still running has no right edge to draw, so it fades out.
      if (run.open && x1 - x0 > 6) {
        const from = Math.max(x0, x1 - 30);
        const fade = context.createLinearGradient(from, 0, x1, 0);
        fade.addColorStop(0, "rgba(0,0,0,0)");
        fade.addColorStop(1, colour("--surface"));
        context.fillStyle = fade;
        context.fillRect(from, top, x1 - from, height);
      }

      // Every blocked stop: the hook saying "not yet".
      for (const check of run.checks || []) {
        if (check.met) continue;
        const x = map.toX(fmt.ms(check.t));
        context.fillStyle = colour("--warning");
        context.fillRect(x - 1, top, 2, height);
      }

      // The label, if the band is wide enough to carry one.
      if (x1 - x0 > 70) {
        context.save();
        context.beginPath();
        context.rect(x0 + 5, top, x1 - x0 - 10, height);
        context.clip();
        context.fillStyle = faint;
        context.font = "9.5px ui-monospace, monospace";
        context.textAlign = "left";
        context.textBaseline = "middle";
        context.fillText(`goal ${run.i + 1} · ${fmt.duration(run.ms)}`, x0 + 6, top + height / 2);
        context.restore();
      }

      if (State.goalIndex === run.i) {
        context.strokeStyle = accent;
        context.lineWidth = 1.5;
        context.strokeRect(x0 - 1, top - 1, x1 - x0 + 2, height + 2);
        context.lineWidth = 1;
      }
    });

    /* --- one row per prompt --- */
    ribbon.hitRows = [];
    const hidden = State.goalFilter;
    const rowsTop = AXIS_HEIGHT + bandHeight;
    prompts.forEach((item, index) => {
      const top = rowsTop + index * rowHeight;
      ribbon.hitRows.push({ top, bottom: top + rowHeight, item });

      if (index % 2 === 1) {
        context.fillStyle = panel;
        context.globalAlpha = 0.35;
        context.fillRect(0, top, cssWidth, rowHeight);
        context.globalAlpha = 1;
      }

      const x0 = map.toX(fmt.ms(item.start));
      const x1 = Math.max(x0 + 2, map.toX(fmt.ms(item.end || item.start)));
      const barTop = top + 1.5;
      const barHeight = Math.max(3, rowHeight - 3);

      context.fillStyle = colour(`--out-${item.outcome}`) || colour("--out-empty");
      context.globalAlpha = 0.16;
      context.fillRect(x0, barTop, x1 - x0, barHeight);
      context.globalAlpha = 1;
      context.fillRect(x0, barTop, 2, barHeight);

      const tickHeight = Math.max(2, barHeight - 2);
      for (const step of item.steps || []) {
        if (hidden.has(step.c)) continue;
        const x = map.toX(fmt.ms(step.t));
        context.fillStyle = step.e ? colour("--error") : colour(`--cat-${step.c}`);
        context.fillRect(x, barTop + 1, step.e ? 2.5 : 1.6, tickHeight);
      }

      if (item.asked) {
        const askStep = (item.steps || []).find((step) => step.c === "ask");
        const x = askStep ? map.toX(fmt.ms(askStep.t)) : x1;
        context.fillStyle = colour("--cat-ask");
        context.beginPath();
        context.moveTo(x, barTop - 1);
        context.lineTo(x + 4, barTop + 4);
        context.lineTo(x - 4, barTop + 4);
        context.closePath();
        context.fill();
      }

      if (State.promptIndex === item.i) {
        context.strokeStyle = accent;
        context.lineWidth = 1.5;
        context.strokeRect(x0 - 1, top + 0.75, x1 - x0 + 2, rowHeight - 1.5);
        context.lineWidth = 1;
      }
    });
  }

  function hitAt(clientY, canvas) {
    const rect = canvas.getBoundingClientRect();
    const y = clientY - rect.top;
    if (ribbon.runs.length && y >= ribbon.bandTop && y < ribbon.bandTop + GOAL_BAND) {
      return { kind: "band" };
    }
    const row = ribbon.hitRows.find((entry) => y >= entry.top && y < entry.bottom);
    return row ? { kind: "prompt", item: row.item, row } : null;
  }

  function goalAtX(clientX, canvas) {
    if (!ribbon.map) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    for (const run of ribbon.runs) {
      const x0 = ribbon.map.toX(fmt.ms(run.start));
      const x1 = Math.max(x0 + 3, ribbon.map.toX(fmt.ms(run.end || ribbon.map.end)));
      if (x >= x0 - 2 && x <= x1 + 2) return run;
    }
    return null;
  }

  /* ---------------------------------------------------------------- */
  /* markup                                                            */
  /* ---------------------------------------------------------------- */

  function goalBadge(goal) {
    if (goal.met) return ui.badge("met", "green");
    if (goal.superseded) return ui.badge("replaced", "");
    if (goal.open) return ui.badge("still open", "accent");
    return ui.badge("ended", "");
  }

  function outcomeBadge(item) {
    const map = {
      done: ["done", "green"], recovered: ["recovered", "amber"], error: ["failed", "red"],
      question: ["asked you", "violet"], empty: ["no work", ""],
    };
    const [label, cls] = map[item.outcome] || ["done", ""];
    return ui.badge(label, cls);
  }

  /**
   * One `/goal` run. Collapsed it is the headline; selected it opens into
   * everything that happened while it was active — every tool call in order,
   * the prompts you sent, the files, the commands, and each time the hook
   * refused to let the agent stop.
   */
  function goalCard(goal, list, priced) {
    const active = State.goalIndex === goal.i;
    const facts = [
      ["Ran for", goal.ms ? fmt.duration(goal.ms) : "—", ""],
      ["Follow-ups", fmt.num(goal.follow_ups), ""],
      ["Turns", fmt.num(goal.turns), ""],
      ["Tool calls", fmt.num(goal.tools), ""],
      ["In tools", goal.tool_ms ? fmt.duration(goal.tool_ms) : "—", ""],
      ["Errors", fmt.num(goal.errors), goal.errors ? "bad" : ""],
    ];
    if (goal.blocked_stops) facts.push(["Stops blocked", fmt.num(goal.blocked_stops), "warn"]);
    if (goal.asked) facts.push(["Asked you", fmt.num(goal.asked), "warn"]);
    if (goal.compactions) facts.push(["Compactions", fmt.num(goal.compactions), ""]);
    facts.push(["Tokens", fmt.tokens(goal.tokens), ""]);
    if (priced) facts.push(["Estimate", fmt.cost(goal.cost), ""]);

    const blocked = (goal.checks || []).filter((check) => !check.met);
    const met = (goal.checks || []).find((check) => check.met);

    return `<div class="jn-goal-card ${active ? "active" : ""}" data-status="${esc(goal.status)}">
      <button class="jg-head" data-action="goal" data-goal="${goal.i}">
        <span class="jg-index">Goal ${goal.i + 1}</span>${goalBadge(goal)}
        <span class="jg-when">${esc(fmt.time(goal.start))}${goal.end ? ` → ${esc(fmt.clock(goal.end))}` : ""}</span>
        <span class="spacer"></span>
        <span class="jg-dur">${goal.ms ? fmt.duration(goal.ms) : "—"}</span>
        <span class="jg-toggle">${active ? "Hide detail" : "Show everything"}</span>
      </button>
      <div class="jg-condition selectable">${esc(goal.condition || "(no condition recorded)")}</div>
      <div class="jn-facts">${facts.map(([label, value, cls]) =>
        `<div class="jn-fact ${cls}"><div class="jf-label">${esc(label)}</div>
          <div class="jf-value">${esc(value)}</div></div>`).join("")}</div>
      ${Object.keys(goal.by_cat || {}).length ? `<div class="jg-work">
        ${ui.stackBar(goal.by_cat, { tall: true })}
        <div style="margin-top:8px">${ui.categoryLegend(goal.by_cat, { ms: goal.cat_ms })}</div>
      </div>` : ""}
      ${active ? goalDetail(goal, list, blocked, met) : shortOutcome(goal, blocked, met)}
    </div>`;
  }

  function shortOutcome(goal, blocked, met) {
    if (met) return `<div class="jg-met"><b>Met:</b> ${esc(trim(met.reason, 190))}</div>`;
    if (goal.open) return `<div class="jg-open">Still active when the transcript ended.</div>`;
    if (goal.superseded) return `<div class="jg-open">Replaced by the next goal before it was met.</div>`;
    if (blocked.length) return `<div class="jg-open">Last check: ${esc(trim(blocked[blocked.length - 1].reason, 190))}</div>`;
    return "";
  }

  function trim(text, limit) {
    const value = String(text || "");
    return value.length > limit ? value.slice(0, limit - 1) + "…" : value;
  }

  /** Everything that happened inside the goal. */
  function goalDetail(goal, list, blocked, met) {
    const prompts = promptsOf(goal, list);
    const steps = stepsOf(goal, list);
    const commands = [...new Set(prompts.flatMap((item) => item.commands || []))];

    return `<div class="jg-detail">
      ${steps.length ? `<div class="jg-block">
        <div class="section-title"><span>Every tool call, in order (${steps.length})</span></div>
        <div class="jn-steps">${steps.map((step) =>
          `<span class="jn-step bg-${esc(step.c)} ${step.e ? "err" : ""}"
            data-tip="${esc(step.n)}${step.e ? " (returned an error)" : ""}
${esc(fmt.clock(step.t))}${
              step.ms ? ` · ${esc(fmt.duration(step.ms))}` : ""}"></span>`).join("")}</div>
      </div>` : ""}

      ${prompts.length ? `<div class="jg-block">
        <div class="section-title"><span>What you sent while it ran (${prompts.length})</span></div>
        <div class="jg-prompts">${prompts.map((item) => `
          <button class="jg-prompt-row ${State.promptIndex === item.i ? "active" : ""}"
              data-action="prompt" data-prompt="${item.i}" data-outcome="${esc(item.outcome)}">
            <span class="jg-outcome" aria-hidden="true"></span>
            <span class="jgp-text">${esc(promptLabel(item))}</span>
            <span class="jgp-meta">${item.tools ? `${item.tools} tools` : ""}${
              item.ms ? ` · ${fmt.duration(item.ms)}` : ""}</span>
          </button>`).join("")}</div>
      </div>` : ""}

      ${blocked.length ? `<div class="jg-block">
        <div class="section-title"><span>The hook refused to stop ${blocked.length} time${blocked.length === 1 ? "" : "s"}</span></div>
        ${blocked.map((check) => `<div class="jg-check">
          <span class="jc-time">${esc(fmt.clock(check.t))}</span>
          <span class="jc-reason">${esc(check.reason || "no reason recorded")}</span></div>`).join("")}
      </div>` : ""}

      ${(goal.files || []).length ? `<div class="jg-block">
        <div class="section-title"><span>Files touched (${goal.files.length})</span></div>
        <div class="jn-chips">${goal.files.map((file) =>
          `<span class="jn-chip" data-tip="${esc(file)}">${esc(fmt.shortPath(file))}</span>`).join("")}</div>
      </div>` : ""}

      ${commands.length ? `<div class="jg-block">
        <div class="section-title"><span>Commands</span></div>
        <div class="jn-chips">${commands.map((command) =>
          `<span class="jn-chip">${esc(command)}</span>`).join("")}</div>
      </div>` : ""}

      ${met ? `<div class="jg-met"><b>Met:</b> ${esc(met.reason || "the condition held")}</div>` : ""}
      ${goal.open ? `<div class="jg-open">This goal was still active when the transcript ended.</div>` : ""}
    </div>`;
  }

  /** What to show where the prompt would be, when there is no prompt. */
  function promptLabel(item) {
    if (item.prompt) return item.prompt;
    if (item.kind === "implicit") return "Session start — work before the first recorded prompt";
    return "(no prompt text)";
  }

  function promptRow(item) {
    const active = State.promptIndex === item.i;
    const prompt = promptLabel(item);
    const meta = [];
    if (item.turns) meta.push(`${item.turns} turn${item.turns === 1 ? "" : "s"}`);
    if (item.tools) meta.push(`${item.tools} tools`);
    if (item.tool_ms) meta.push(`${fmt.duration(item.tool_ms)} in tools`);
    if (item.errors) meta.push(`<span class="c-ask">${item.errors} err</span>`);
    if (item.tokens) meta.push(fmt.tokens(item.tokens));
    return `<div class="jn-prompt ${active ? "active" : ""}" data-action="prompt" data-prompt="${item.i}"
        data-outcome="${esc(item.outcome)}" data-kind="${esc(item.kind || "prompt")}">
      <span class="jg-num">${item.i + 1}</span>
      <span class="jg-outcome" aria-hidden="true"></span>
      <span class="jg-main">
        <span class="jg-prompt-text">${esc(prompt)}</span>
        ${ui.stackBar(item.by_cat)}
        <span class="jg-meta">${meta.join(" · ")}</span>
      </span>
      <span class="jg-right">
        <span class="jg-dur">${item.ms ? fmt.duration(item.ms) : "—"}</span>
        <span class="faint" style="font-size:10px">${esc(fmt.clock(item.start))}</span>
      </span></div>`;
  }

  function promptInspector(item, priced) {
    if (!item) {
      return `<div class="jn-detail">${ui.emptyState("◎", "Pick a prompt",
        "Click a row to see exactly what the agent did between that prompt and the next one.")}</div>`;
    }
    const facts = [
      ["Duration", item.ms ? fmt.duration(item.ms) : "—", ""],
      ["First reply", item.latency_ms ? fmt.duration(item.latency_ms) : "—", ""],
      ["In tools", item.tool_ms ? fmt.duration(item.tool_ms) : "—", ""],
      ["Tool calls", fmt.num(item.tools), ""],
      ["Turns", fmt.num(item.turns), ""],
      ["Errors", fmt.num(item.errors), item.errors ? "bad" : ""],
      ["Tokens", fmt.tokens(item.tokens), ""],
    ];
    if (priced) facts.push(["Estimate", fmt.cost(item.cost), ""]);
    if (item.compactions) facts.push(["Compactions", fmt.num(item.compactions), "warn"]);

    const steps = (item.steps || []).map((step) =>
      `<span class="jn-step bg-${esc(step.c)} ${step.e ? "err" : ""}"
        data-tip="${esc(step.n)}${step.e ? " (returned an error)" : ""}
${esc(fmt.clock(step.t))}${
          step.ms ? ` · ${esc(fmt.duration(step.ms))}` : ""}"></span>`).join("");
    const errorChips = Object.entries(item.error_names || {}).map(([name, count]) =>
      `<span class="jn-chip err">${esc(name)} ×${count}</span>`).join("");
    const fileChips = (item.files || []).map((file) =>
      `<span class="jn-chip" data-tip="${esc(file)}">${esc(fmt.shortPath(file))}</span>`).join("");
    const commandChips = (item.commands || []).map((command) =>
      `<span class="jn-chip">${esc(command)}</span>`).join("");

    return `<div class="jn-detail">
      <div class="jn-detail-head">
        <div class="jd-eyebrow"><span>Prompt ${item.i + 1}</span>${outcomeBadge(item)}
          <span class="spacer"></span><span>${esc(fmt.time(item.start))}</span></div>
        <div class="jd-prompt selectable">${esc(promptLabel(item))}</div>
      </div>
      <div class="jn-detail-body">
        <div class="jn-facts">${facts.map(([label, value, cls]) =>
          `<div class="jn-fact ${cls}"><div class="jf-label">${esc(label)}</div>
            <div class="jf-value">${esc(value)}</div></div>`).join("")}</div>
        ${Object.keys(item.by_cat || {}).length ? `<div>
          ${ui.stackBar(item.by_cat, { tall: true })}
          <div style="margin-top:8px">${ui.categoryLegend(item.by_cat, { ms: item.cat_ms })}</div></div>` : ""}
        ${steps ? `<div><div class="section-title" style="margin-bottom:6px"><span>Every step, in order</span></div>
          <div class="jn-steps">${steps}</div>
          ${item.dropped_steps ? `<div class="faint" style="font-size:10.5px;margin-top:6px">
            +${item.dropped_steps} more steps not shown — this prompt exceeded the per-prompt cap.</div>` : ""}</div>` : ""}
        ${errorChips ? `<div><div class="section-title" style="margin-bottom:6px"><span>Failed tools</span></div>
          <div class="jn-chips">${errorChips}</div></div>` : ""}
        ${fileChips ? `<div><div class="section-title" style="margin-bottom:6px"><span>Files touched</span></div>
          <div class="jn-chips">${fileChips}</div></div>` : ""}
        ${commandChips ? `<div><div class="section-title" style="margin-bottom:6px"><span>Commands</span></div>
          <div class="jn-chips">${commandChips}</div></div>` : ""}
        <div class="row wrap" style="gap:6px">
          <button class="btn sm" data-action="prompt-copy" data-prompt="${item.i}">Copy prompt</button>
          <button class="btn sm" data-action="goal-transcript">Open in transcript</button>
        </div>
      </div></div>`;
  }

  /* ---------------------------------------------------------------- */
  /* the tab                                                           */
  /* ---------------------------------------------------------------- */

  function render(detail) {
    const { requests, goals, list, runs } = arcOf(detail);
    if (!list.length && !runs.length) {
      return ui.emptyState("◎", "Nothing to chart yet",
        "This session has no prompts and no goals. Open the transcript to see the raw messages.");
    }

    const priced = requests.priced !== false;
    const selectedGoal = runs.find((run) => run.i === State.goalIndex) || null;
    const shown = visiblePrompts(scopedPrompts(list, runs));
    const selectedPrompt = list.find((item) => item.i === State.promptIndex) || null;

    const sortChip = (key, label) =>
      `<button class="chip ${State.goalSort === key ? "on" : ""}" data-action="goal-sort" data-sort="${key}">${label}</button>`;

    return `<div class="journey">
      ${runs.length ? goalsSection(goals, runs, list, priced) : noGoalsNotice()}

      ${ui.categoryLegend(requests.by_cat, {
        ms: requests.cat_ms, filter: State.goalFilter, action: "goal-filter",
      })}

      <div class="jn-ribbon">
        <div class="jn-ribbon-head">
          <span class="jrh-title">On a clock</span>
          <span>${esc(fmt.time(list[0] ? list[0].start : (runs[0] && runs[0].start)))}</span>
          <span class="jrh-hint">${runs.length ? "Goal bands on top, one row per prompt · " : "One row per prompt · "}idle gaps collapsed</span>
        </div>
        <div class="jn-canvas-wrap">
          <canvas id="jn-canvas" tabindex="0" aria-label="Timeline of goals and prompts in this session"></canvas>
          <div class="jn-hover" id="jn-hover" hidden></div>
        </div>
      </div>

      <div class="jn-split">
        <div class="jn-list-col">
          <div class="section-title">
            <span>${shown.length} prompt${shown.length === 1 ? "" : "s"}${
              selectedGoal ? ` in goal ${selectedGoal.i + 1}` : ""}</span>
            <span class="st-actions">
              ${selectedGoal ? `<button class="chip on" data-action="goal-clear">Goal ${selectedGoal.i + 1} ×</button>` : ""}
              ${sortChip("order", "In order")}${sortChip("duration", "Longest")}${sortChip("tools", "Busiest")}${sortChip("errors", "Most errors")}
            </span>
          </div>
          <div class="jn-list">${sortedPrompts(shown).map(promptRow).join("")
            || `<div class="sb-empty">No prompts match this filter.</div>`}</div>
        </div>
        <div class="jn-detail-col">${promptInspector(selectedPrompt, priced)}</div>
      </div>
    </div>`;
  }

  function goalsSection(goals, runs, list, priced) {
    const longest = runs.reduce((best, run) => (run.ms > (best ? best.ms : 0) ? run : best), null);
    return `
      <div class="tiles">
        ${ui.tile("Goals set", fmt.num(goals.count),
          `${goals.met} met${goals.open ? ` · ${goals.open} still open` : ""}${goals.superseded ? ` · ${goals.superseded} replaced` : ""}`,
          { accent: true, tip: "Claude Code /goal directives — a Stop hook that blocks the agent from stopping until its condition holds" })}
        ${ui.tile("Time under a goal", goals.total_ms ? fmt.duration(goals.total_ms) : "—",
          longest ? `longest ${fmt.duration(longest.ms)}` : "",
          { tip: "From the moment each goal was set until it was met, replaced, or the transcript ended" })}
        ${ui.tile("Follow-ups sent", fmt.num(goals.follow_ups), "while a goal was running",
          { tip: "Prompts you sent to steer work that was already under way" })}
        ${ui.tile("Stops blocked", fmt.num(goals.blocked_stops),
          goals.blocked_stops ? "the hook said not yet" : "never needed",
          { tip: "Times the Stop hook refused to let the agent finish because the condition did not hold yet" })}
      </div>
      ${ui.section("Goals", `<div class="jn-goals">${runs.map((run) => goalCard(run, list, priced)).join("")}</div>`,
        { desc: "Every /goal set in this session. Open one to see everything that happened while it was active." })}`;
  }

  function noGoalsNotice() {
    return `<div class="section-note">No <span class="mono">/goal</span> was set in this session, so there is no goal band.
      Each row below is one prompt you sent and everything the agent did until the next one.</div>`;
  }

  /* ---------------------------------------------------------------- */
  /* wiring                                                            */
  /* ---------------------------------------------------------------- */

  let resizeObserver = null;

  function mount(detail) {
    const canvas = document.getElementById("jn-canvas");
    if (!canvas) return;
    const { list, runs } = arcOf(detail);
    ribbon.canvas = canvas;
    ribbon.prompts = visiblePrompts(scopedPrompts(list, runs));
    ribbon.runs = runs;
    drawRibbon();

    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = new ResizeObserver(ASM.util.raf(() => drawRibbon()));
    resizeObserver.observe(canvas.parentElement);

    const hover = document.getElementById("jn-hover");
    canvas.addEventListener("mousemove", (event) => {
      const hit = hitAt(event.clientY, canvas);
      const goal = hit && hit.kind === "band" ? goalAtX(event.clientX, canvas) : null;
      if (!hit || (hit.kind === "band" && !goal)) { hover.hidden = true; return; }
      hover.hidden = false;
      hover.innerHTML = goal ? goalHoverCard(goal) : promptHoverCard(hit.item);

      const rect = canvas.getBoundingClientRect();
      const x = clamp(event.clientX - rect.left, 8, rect.width - 8);
      const wide = hover.offsetWidth;
      hover.style.left = clamp(x - wide / 2, 6, Math.max(6, rect.width - wide - 6)) + "px";

      // Place it under what it describes, and flip above only when that would
      // take it off the *window* — the ribbon's own edge is not a boundary.
      const top = goal ? ribbon.bandTop : hit.row.top;
      const bottom = goal ? ribbon.bandTop + GOAL_BAND : hit.row.bottom;
      const tall = hover.offsetHeight;
      const below = bottom + 8;
      const above = top - tall - 8;
      const fitsBelow = rect.top + below + tall <= window.innerHeight - 12;
      const fitsAbove = rect.top + above >= 12;
      hover.style.top = (fitsBelow || !fitsAbove ? below : above) + "px";
    });
    canvas.addEventListener("mouseleave", () => { hover.hidden = true; });
    canvas.addEventListener("click", (event) => {
      const hit = hitAt(event.clientY, canvas);
      if (!hit) return;
      if (hit.kind === "band") {
        const goal = goalAtX(event.clientX, canvas);
        if (goal) selectGoal(goal.i);
        return;
      }
      selectPrompt(hit.item.i);
    });
    canvas.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const prompts = ribbon.prompts;
      if (!prompts.length) return;
      const current = prompts.findIndex((item) => item.i === State.promptIndex);
      const next = clamp(current + (event.key === "ArrowDown" ? 1 : -1), 0, prompts.length - 1);
      selectPrompt(prompts[current < 0 ? 0 : next].i);
    });
  }

  function goalHoverCard(goal) {
    const parts = [];
    if (goal.follow_ups) parts.push(`<b>${goal.follow_ups}</b> follow-ups`);
    if (goal.tools) parts.push(`<b>${goal.tools}</b> tools`);
    if (goal.blocked_stops) parts.push(`<b>${goal.blocked_stops}</b> blocked stops`);
    if (goal.errors) parts.push(`<b>${goal.errors}</b> errors`);
    return `<div class="jh-head"><span class="jh-idx">Goal ${goal.i + 1}</span>${goalBadge(goal)}
        <span class="spacer"></span><span class="jh-idx">${esc(fmt.clock(goal.start))}${
          goal.end ? ` → ${esc(fmt.clock(goal.end))}` : " → open"}</span></div>
      <div class="jh-prompt">${esc(goal.condition)}</div>
      <div class="jh-stats"><span>${esc(fmt.duration(goal.ms))}</span>${
        parts.map((part) => `<span>${part}</span>`).join("")}</div>`;
  }

  function promptHoverCard(item) {
    const parts = [];
    if (item.tools) parts.push(`<b>${item.tools}</b> tools`);
    if (item.turns) parts.push(`<b>${item.turns}</b> turns`);
    if (item.errors) parts.push(`<b>${item.errors}</b> errors`);
    if (item.tokens) parts.push(`<b>${fmt.tokens(item.tokens)}</b> tok`);
    return `<div class="jh-head"><span class="jh-idx">#${item.i + 1}</span>${outcomeBadge(item)}
        <span class="spacer"></span><span class="jh-idx">${esc(fmt.clock(item.start))} → ${esc(fmt.clock(item.end))}</span></div>
      <div class="jh-prompt">${esc(promptLabel(item))}</div>
      <div class="jh-stats"><span>${esc(fmt.duration(item.ms))}</span>${
        parts.map((part) => `<span>${part}</span>`).join("")}</div>`;
  }

  function selectGoal(index) {
    State.goalIndex = State.goalIndex === index ? null : index;
    State.promptIndex = null;
    ASM.router.renderTab();
  }

  function selectPrompt(index) {
    State.promptIndex = State.promptIndex === index ? null : index;
    ASM.router.renderTab();
  }

  async function handle(action, element) {
    const { list } = arcOf(State.detail);
    switch (action) {
      case "goal":
        selectGoal(Number(element.dataset.goal));
        return true;
      case "goal-clear":
        State.goalIndex = null;
        ASM.router.renderTab();
        return true;
      case "prompt":
        selectPrompt(Number(element.dataset.prompt));
        return true;
      case "goal-sort":
        State.goalSort = element.dataset.sort;
        ASM.router.renderTab();
        return true;
      case "goal-filter": {
        const category = element.dataset.cat;
        if (State.goalFilter.has(category)) State.goalFilter.delete(category);
        else State.goalFilter.add(category);
        ASM.router.renderTab();
        return true;
      }
      case "prompt-copy": {
        const item = list.find((entry) => entry.i === Number(element.dataset.prompt));
        if (item) {
          const ok = await dom.copy(item.prompt || "");
          ASM.toast(ok ? "Prompt copied" : "Could not copy", ok ? "ok" : "err");
        }
        return true;
      }
      case "goal-transcript":
        State.tab = "transcript";
        ASM.router.renderMain();
        return true;
      default:
        return false;
    }
  }

  ASM.views = ASM.views || {};
  ASM.views.journey = { render, mount, handle, redraw: drawRibbon };

  // Canvas pixels do not follow a CSS custom property, so the one thing in
  // the app that is painted by hand has to be told when the theme changes.
  if (ASM.theme) ASM.theme.onChange(() => drawRibbon());
})(window.ASM = window.ASM || {});
