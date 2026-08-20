/* ============================================================
   Journey — a session as the arc of the work.

   The backend hands us one record per user prompt (see asm/goals.py):
   when it started, when it ended, which kinds of tools ran inside it,
   whether the agent stopped to ask something, and what it cost. This
   view draws that.

   The ribbon is a canvas, for two reasons. A busy session is tens of
   thousands of tool marks and a DOM node each would crawl; and the
   time axis needs *collapsed idle gaps* — an overnight pause between
   two prompts must not push the rest of the session into a sliver.
   Both are far easier to get right with an explicit time-to-pixel map
   than with layout.
   ============================================================ */

(function (ASM) {
  "use strict";

  const { esc, fmt, dom, clamp } = ASM.util;
  const ui = ASM.ui;
  const State = ASM.state;

  /* ---------------------------------------------------------------- */
  /* time mapping                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Build a piecewise-linear map from wall-clock time to pixels.
   *
   * Active stretches keep their real proportions. A gap longer than
   * `threshold` is squeezed into a fixed `GAP_PIXELS` band, so the
   * hour you spent at lunch costs the chart 26 pixels instead of
   * two-thirds of its width. The bands are drawn hatched, and labelled
   * with the real duration, so nothing is silently hidden.
   */
  const GAP_PIXELS = 26;

  function buildTimeMap(goals, width) {
    const spans = goals
      .map((goal) => [fmt.ms(goal.start), fmt.ms(goal.end || goal.start)])
      .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
      .map(([a, b]) => [a, Math.max(a, b)])
      .sort((x, y) => x[0] - y[0]);
    if (!spans.length) return null;

    // Merge overlaps so concurrent-looking goals do not double-count time.
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
        if (gap > threshold) { pieces.push({ gap: true, t0: merged[i - 1][1], t1: merged[i][0] }); gapCount += 1; }
        else merged[i - 1][1] = merged[i][0];   // absorb short gaps into the run
      }
      pieces.push({ gap: false, t0: merged[i][0], t1: merged[i][1] });
    }

    const liveMs = pieces.filter((p) => !p.gap).reduce((sum, p) => sum + Math.max(1, p.t1 - p.t0), 0);
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

  /* ---------------------------------------------------------------- */
  /* the ribbon                                                        */
  /* ---------------------------------------------------------------- */

  const AXIS_HEIGHT = 20;
  const ribbon = {
    canvas: null, goals: [], map: null, rowHeight: 16, hitRows: [],
  };

  function colour(name) { return dom.token(name, "#888"); }

  function outcomeColour(outcome) {
    return colour(`--out-${outcome}`) || colour("--out-empty");
  }

  function drawRibbon() {
    const canvas = ribbon.canvas;
    if (!canvas || !canvas.isConnected) return;
    const goals = ribbon.goals;
    const cssWidth = canvas.parentElement.clientWidth;
    if (cssWidth < 40) return;

    const rowHeight = clamp(Math.floor(320 / Math.max(1, goals.length)), 5, 20);
    ribbon.rowHeight = rowHeight;
    const cssHeight = AXIS_HEIGHT + goals.length * rowHeight + 4;
    const ratio = window.devicePixelRatio || 1;

    canvas.width = Math.round(cssWidth * ratio);
    canvas.height = Math.round(cssHeight * ratio);
    canvas.style.height = cssHeight + "px";

    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const map = buildTimeMap(goals, cssWidth - 2);
    ribbon.map = map;
    if (!map) return;

    const line = colour("--line");
    const lineStrong = colour("--line-strong");
    const faint = colour("--fg-faint");
    const panel = colour("--panel");
    const accent = colour("--accent");

    /* --- collapsed idle bands, painted behind everything --- */
    ctx.save();
    for (const piece of map.pieces) {
      if (!piece.gap) continue;
      ctx.fillStyle = panel;
      ctx.globalAlpha = 0.5;
      ctx.fillRect(piece.x0 + 1, 0, piece.width, cssHeight);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = lineStrong;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(piece.x0 + 1.5, 0); ctx.lineTo(piece.x0 + 1.5, cssHeight);
      ctx.moveTo(piece.x1 + 0.5, 0); ctx.lineTo(piece.x1 + 0.5, cssHeight);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = faint;
      ctx.font = `9px ${getComputedStyle(document.body).getPropertyValue("--mono") || "monospace"}`;
      ctx.save();
      ctx.translate(piece.x0 + piece.width / 2 + 3, cssHeight / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "center";
      ctx.fillText(fmt.duration(piece.t1 - piece.t0) + " idle", 0, 0);
      ctx.restore();
    }
    ctx.restore();

    /* --- axis --- */
    ctx.strokeStyle = line;
    ctx.beginPath();
    ctx.moveTo(0, AXIS_HEIGHT - 0.5);
    ctx.lineTo(cssWidth, AXIS_HEIGHT - 0.5);
    ctx.stroke();

    ctx.fillStyle = faint;
    ctx.font = "9.5px ui-monospace, monospace";
    ctx.textBaseline = "middle";
    const ticks = Math.max(2, Math.min(8, Math.floor(cssWidth / 110)));
    for (let i = 0; i <= ticks; i += 1) {
      const x = (i / ticks) * (cssWidth - 2);
      const time = timeAtX(map, x);
      ctx.textAlign = i === 0 ? "left" : i === ticks ? "right" : "center";
      ctx.fillText(fmt.clock(time), clamp(x, 2, cssWidth - 2), AXIS_HEIGHT / 2);
      ctx.strokeStyle = line;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, AXIS_HEIGHT - 5);
      ctx.lineTo(x + 0.5, AXIS_HEIGHT);
      ctx.stroke();
    }

    /* --- one row per goal --- */
    ribbon.hitRows = [];
    const hidden = State.goalFilter;
    goals.forEach((goal, index) => {
      const top = AXIS_HEIGHT + index * rowHeight;
      ribbon.hitRows.push({ top, bottom: top + rowHeight, goal });

      if (index % 2 === 1) {
        ctx.fillStyle = panel;
        ctx.globalAlpha = 0.35;
        ctx.fillRect(0, top, cssWidth, rowHeight);
        ctx.globalAlpha = 1;
      }

      const x0 = map.toX(fmt.ms(goal.start));
      const x1 = Math.max(x0 + 2, map.toX(fmt.ms(goal.end || goal.start)));
      const barTop = top + 1.5;
      const barHeight = Math.max(3, rowHeight - 3);

      // The span of the goal, tinted by how it ended.
      const tone = outcomeColour(goal.outcome);
      ctx.fillStyle = tone;
      ctx.globalAlpha = 0.16;
      ctx.fillRect(x0, barTop, x1 - x0, barHeight);
      ctx.globalAlpha = 1;
      // A hard left cap: the instant the request was made.
      ctx.fillRect(x0, barTop, 2, barHeight);

      // Every tool call as a tick in its category colour.
      const tickHeight = Math.max(2, barHeight - 2);
      for (const step of goal.steps || []) {
        if (hidden.has(step.c)) continue;
        const x = map.toX(fmt.ms(step.t));
        ctx.fillStyle = step.e ? colour("--error") : colour(`--cat-${step.c}`);
        ctx.fillRect(x, barTop + 1, step.e ? 2.5 : 1.6, tickHeight);
      }

      // A question is the one event that hands control back to the human,
      // so it gets a shape rather than another tick.
      if (goal.asked) {
        const askStep = (goal.steps || []).find((step) => step.c === "ask");
        const x = askStep ? map.toX(fmt.ms(askStep.t)) : x1;
        ctx.fillStyle = colour("--cat-ask");
        ctx.beginPath();
        ctx.moveTo(x, barTop - 1);
        ctx.lineTo(x + 4, barTop + 4);
        ctx.lineTo(x - 4, barTop + 4);
        ctx.closePath();
        ctx.fill();
      }

      if (State.goalIndex === goal.i) {
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x0 - 1, top + 0.75, x1 - x0 + 2, rowHeight - 1.5);
        ctx.lineWidth = 1;
      }
    });
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

  function goalAt(clientY, canvas) {
    const rect = canvas.getBoundingClientRect();
    const y = clientY - rect.top;
    const row = ribbon.hitRows.find((entry) => y >= entry.top && y < entry.bottom);
    return row ? row.goal : null;
  }

  /* ---------------------------------------------------------------- */
  /* markup                                                            */
  /* ---------------------------------------------------------------- */

  function goalsOf(detail) {
    const payload = (detail && detail.goals) || {};
    return { payload, list: payload.goals || [] };
  }

  function visibleGoals(list) {
    const hidden = State.goalFilter;
    if (!hidden.size) return list;
    // A category filter hides goals that consist *only* of hidden work —
    // it never hides a goal that also did something you asked to see.
    return list.filter((goal) => {
      const categories = Object.keys(goal.by_cat || {});
      if (!categories.length) return true;
      return categories.some((category) => !hidden.has(category));
    });
  }

  function sortedGoals(list) {
    const copy = [...list];
    if (State.goalSort === "duration") copy.sort((a, b) => b.ms - a.ms);
    else if (State.goalSort === "tools") copy.sort((a, b) => b.tools - a.tools);
    else if (State.goalSort === "errors") copy.sort((a, b) => (b.errors - a.errors) || (b.tools - a.tools));
    return copy;
  }

  function outcomeBadge(goal) {
    const map = {
      done: ["done", "green"],
      recovered: ["recovered", "amber"],
      error: ["failed", "red"],
      question: ["asked you", "violet"],
      empty: ["no work", ""],
    };
    const [label, cls] = map[goal.outcome] || ["done", ""];
    return ui.badge(label, cls);
  }

  /** What to show where the prompt would be, when there is no prompt. */
  function promptLabel(goal) {
    if (goal.prompt) return goal.prompt;
    if (goal.kind === "implicit") return "Session start — work before the first recorded prompt";
    return "(no prompt text)";
  }

  function goalRow(goal) {
    const active = State.goalIndex === goal.i;
    const prompt = promptLabel(goal);
    const meta = [];
    if (goal.turns) meta.push(`${goal.turns} turn${goal.turns === 1 ? "" : "s"}`);
    if (goal.tools) meta.push(`${goal.tools} tools`);
    if (goal.errors) meta.push(`<span class="c-ask">${goal.errors} err</span>`);
    if (goal.subagents) meta.push(`${goal.subagents} agent${goal.subagents === 1 ? "" : "s"}`);
    if (goal.tokens) meta.push(fmt.tokens(goal.tokens));
    return `<div class="jn-goal ${active ? "active" : ""}" data-action="goal" data-goal="${goal.i}"
        data-outcome="${esc(goal.outcome)}" data-kind="${esc(goal.kind || "prompt")}">
      <span class="jg-num">${goal.i + 1}</span>
      <span class="jg-outcome" aria-hidden="true"></span>
      <span class="jg-main">
        <span class="jg-prompt" title="${esc(prompt)}">${esc(prompt)}</span>
        ${ui.stackBar(goal.by_cat)}
        <span class="jg-meta">${meta.join(" · ")}</span>
      </span>
      <span class="jg-right">
        <span class="jg-dur">${goal.ms ? fmt.duration(goal.ms) : "—"}</span>
        <span class="faint" style="font-size:10px">${esc(fmt.clock(goal.start))}</span>
      </span></div>`;
  }

  function inspector(goal, priced) {
    if (!goal) {
      return `<div class="jn-detail">${ui.emptyState("◎", "Pick a goal",
        "Click a row in the ribbon or the list to see what the agent actually did between your prompt and the next one.")}</div>`;
    }
    const facts = [
      ["Duration", goal.ms ? fmt.duration(goal.ms) : "—", ""],
      ["First reply", goal.latency_ms ? fmt.duration(goal.latency_ms) : "—", ""],
      ["Tool calls", fmt.num(goal.tools), ""],
      ["Turns", fmt.num(goal.turns), ""],
      ["Errors", fmt.num(goal.errors), goal.errors ? "bad" : ""],
      ["Tokens", fmt.tokens(goal.tokens), ""],
    ];
    if (priced) facts.push(["Estimate", fmt.cost(goal.cost), ""]);
    if (goal.compactions) facts.push(["Compactions", fmt.num(goal.compactions), "warn"]);

    const steps = (goal.steps || []).map((step) =>
      `<span class="jn-step bg-${esc(step.c)} ${step.e ? "err" : ""}"
        title="${esc(step.n)}${step.e ? " — returned an error" : ""} · ${esc(fmt.clock(step.t))}"></span>`).join("");

    const errorChips = Object.entries(goal.error_names || {}).map(([name, count]) =>
      `<span class="jn-chip err">${esc(name)} ×${count}</span>`).join("");
    const fileChips = (goal.files || []).map((file) =>
      `<span class="jn-chip" title="${esc(file)}">${esc(fmt.shortPath(file))}</span>`).join("");
    const commandChips = (goal.commands || []).map((command) =>
      `<span class="jn-chip">${esc(command)}</span>`).join("");

    return `<div class="jn-detail">
      <div class="jn-detail-head">
        <div class="jd-eyebrow">
          <span>Goal ${goal.i + 1}</span>${outcomeBadge(goal)}
          <span class="spacer"></span>
          <span>${esc(fmt.time(goal.start))}</span>
        </div>
        <div class="jd-prompt selectable">${esc(promptLabel(goal))}</div>
      </div>
      <div class="jn-detail-body">
        <div class="jn-facts">${facts.map(([label, value, cls]) =>
          `<div class="jn-fact ${cls}"><div class="jf-label">${esc(label)}</div>
            <div class="jf-value">${esc(value)}</div></div>`).join("")}</div>
        ${Object.keys(goal.by_cat || {}).length ? `<div>
          ${ui.stackBar(goal.by_cat, { tall: true })}
          <div style="margin-top:8px">${ui.categoryLegend(goal.by_cat)}</div></div>` : ""}
        ${steps ? `<div><div class="section-title" style="margin-bottom:6px"><span>Every step, in order</span></div>
          <div class="jn-steps">${steps}</div>
          ${goal.dropped_steps ? `<div class="faint" style="font-size:10.5px;margin-top:6px">
            +${goal.dropped_steps} more steps not shown — this goal exceeded the per-goal cap.</div>` : ""}</div>` : ""}
        ${errorChips ? `<div><div class="section-title" style="margin-bottom:6px"><span>Failed tools</span></div>
          <div class="jn-chips">${errorChips}</div></div>` : ""}
        ${fileChips ? `<div><div class="section-title" style="margin-bottom:6px"><span>Files touched</span></div>
          <div class="jn-chips">${fileChips}</div></div>` : ""}
        ${commandChips ? `<div><div class="section-title" style="margin-bottom:6px"><span>Commands</span></div>
          <div class="jn-chips">${commandChips}</div></div>` : ""}
        <div class="row wrap" style="gap:6px">
          <button class="btn sm" data-action="goal-copy" data-goal="${goal.i}">Copy prompt</button>
          <button class="btn sm" data-action="goal-transcript" data-goal="${goal.i}">Open in transcript</button>
        </div>
      </div></div>`;
  }

  /** The whole tab. */
  function render(detail) {
    const { payload, list } = goalsOf(detail);
    if (!list.length) {
      return ui.emptyState("◎", "No goals to chart",
        "This session has no user prompts yet, so there is nothing to segment. Open the transcript to see the raw messages.");
    }

    const priced = payload.priced !== false;
    const shown = visibleGoals(list);
    const selected = list.find((goal) => goal.i === State.goalIndex) || null;
    const worked = list.filter((goal) => goal.tools || goal.turns);
    const longest = worked.reduce((best, goal) => (goal.ms > (best ? best.ms : 0) ? goal : best), null);

    const sortChip = (key, label) =>
      `<button class="chip ${State.goalSort === key ? "on" : ""}" data-action="goal-sort" data-sort="${key}">${label}</button>`;

    return `<div class="journey">
      <div class="tiles">
        ${ui.tile("Goals", fmt.num(payload.count || list.length),
          `${worked.length} did work${payload.dropped ? ` · ${payload.dropped} older not shown` : ""}`,
          { tip: "One goal per prompt you sent. Tool results do not start a new one." })}
        ${ui.tile("Median goal", worked.length ? fmt.duration(payload.median_ms) : "—",
          longest ? `longest ${fmt.duration(longest.ms)}` : "",
          { tip: "Wall-clock time from a prompt to the moment the next one arrived" })}
        ${ui.tile("Questions back", fmt.num(payload.questions || 0),
          payload.questions ? "the agent asked you" : "never interrupted you",
          { accent: !!payload.questions, tip: "Goals where the agent stopped and asked you something" })}
        ${ui.tile("Goals that failed", fmt.num(payload.failed || 0),
          payload.failed ? "mostly failing tools" : "none",
          { tip: "Goals where a third or more of the tool calls came back as errors" })}
      </div>

      ${ui.categoryLegend(payload.by_cat, { filter: State.goalFilter, action: "goal-filter" })}

      <div class="jn-ribbon">
        <div class="jn-ribbon-head">
          <span class="jrh-title">The session on a clock</span>
          <span>${esc(fmt.time(payload.goals[0] && payload.goals[0].start))}</span>
          <span class="jrh-hint">One row per goal · idle gaps collapsed · click a row to inspect</span>
        </div>
        <div class="jn-canvas-wrap">
          <canvas id="jn-canvas" tabindex="0" aria-label="Timeline of goals in this session"></canvas>
          <div class="jn-hover" id="jn-hover" hidden></div>
        </div>
      </div>

      <div class="jn-split">
        <div class="jn-list-col">
          <div class="section-title">
            <span>${shown.length} goal${shown.length === 1 ? "" : "s"}</span>
            <span class="st-actions">${sortChip("order", "In order")}${sortChip("duration", "Longest")}${sortChip("tools", "Busiest")}${sortChip("errors", "Most errors")}</span>
          </div>
          <div class="jn-list">${sortedGoals(shown).map(goalRow).join("")}</div>
        </div>
        <div class="jn-detail-col">${inspector(selected, priced)}</div>
      </div>
    </div>`;
  }

  /* ---------------------------------------------------------------- */
  /* wiring                                                            */
  /* ---------------------------------------------------------------- */

  let resizeObserver = null;

  /** Called after the tab markup lands in the DOM. */
  function mount(detail) {
    const canvas = document.getElementById("jn-canvas");
    if (!canvas) return;
    const { list } = goalsOf(detail);
    ribbon.canvas = canvas;
    ribbon.goals = visibleGoals(list);
    drawRibbon();

    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = new ResizeObserver(ASM.util.raf(() => drawRibbon()));
    resizeObserver.observe(canvas.parentElement);

    const hover = document.getElementById("jn-hover");
    canvas.addEventListener("mousemove", (event) => {
      const goal = goalAt(event.clientY, canvas);
      if (!goal) { hover.hidden = true; return; }
      hover.hidden = false;
      hover.innerHTML = hoverCard(goal);
      const rect = canvas.getBoundingClientRect();
      const x = clamp(event.clientX - rect.left, 8, rect.width - 8);
      const wide = hover.offsetWidth;
      hover.style.left = clamp(x - wide / 2, 6, Math.max(6, rect.width - wide - 6)) + "px";
      const rowTop = ribbon.hitRows.find((entry) => entry.goal === goal).bottom;
      hover.style.top = (rowTop + 6 > rect.height - hover.offsetHeight
        ? Math.max(4, rowTop - hover.offsetHeight - 6) : rowTop + 6) + "px";
    });
    canvas.addEventListener("mouseleave", () => { hover.hidden = true; });
    canvas.addEventListener("click", (event) => {
      const goal = goalAt(event.clientY, canvas);
      if (goal) select(goal.i);
    });
    canvas.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const goals = ribbon.goals;
      if (!goals.length) return;
      const current = goals.findIndex((goal) => goal.i === State.goalIndex);
      const next = clamp(current + (event.key === "ArrowDown" ? 1 : -1), 0, goals.length - 1);
      select(goals[current < 0 ? 0 : next].i);
    });
  }

  function hoverCard(goal) {
    const parts = [];
    if (goal.tools) parts.push(`<b>${goal.tools}</b> tools`);
    if (goal.turns) parts.push(`<b>${goal.turns}</b> turns`);
    if (goal.errors) parts.push(`<b>${goal.errors}</b> errors`);
    if (goal.tokens) parts.push(`<b>${fmt.tokens(goal.tokens)}</b> tok`);
    return `<div class="jh-head"><span class="jh-idx">#${goal.i + 1}</span>${outcomeBadge(goal)}
        <span class="spacer"></span><span class="jh-idx">${esc(fmt.clock(goal.start))} → ${esc(fmt.clock(goal.end))}</span></div>
      <div class="jh-prompt">${esc(promptLabel(goal))}</div>
      <div class="jh-stats"><span>${esc(fmt.duration(goal.ms))}</span>${parts.map((part) => `<span>${part}</span>`).join("")}</div>`;
  }

  function select(index) {
    State.goalIndex = State.goalIndex === index ? null : index;
    ASM.router.renderTab();
  }

  /** Actions this view owns, dispatched from the app's click delegate. */
  async function handle(action, element) {
    const detail = State.detail;
    const { list } = goalsOf(detail);
    switch (action) {
      case "goal":
        select(Number(element.dataset.goal));
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
      case "goal-copy": {
        const goal = list.find((item) => item.i === Number(element.dataset.goal));
        if (goal) {
          const ok = await dom.copy(goal.prompt || "");
          ASM.toast(ok ? "Prompt copied" : "Could not copy", ok ? "ok" : "err");
        }
        return true;
      }
      case "goal-transcript": {
        State.tab = "transcript";
        ASM.router.renderMain();
        return true;
      }
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
