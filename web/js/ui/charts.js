/* ============================================================
   Charts, as inline SVG strings.

   Rules that hold everywhere in this file:

   1. No colour literals. Every fill and stroke is a CSS custom
      property, so both themes are correct without a second code
      path and a theme switch needs no redraw.
   2. Every chart states its units: the caller passes a formatter
      and the axis and the hover readout use it.
   3. Thin marks, hairline grid, a 2px surface gap between touching
      fills, and a hover readout on every mark — carried by `data-tip`
      attributes that one delegated handler in app.js turns into the
      floating readout. Every value is also reachable without hover:
      the tables and lists beside the charts repeat them.
   ============================================================ */

(function (ASM) {
  "use strict";

  const { esc, fmt } = ASM.util;

  let uid = 0;
  function nextId(prefix) { uid += 1; return `${prefix}-${uid}`; }

  function empty(message) {
    return `<div class="chart-empty">${esc(message)}</div>`;
  }

  /** "Nice" axis maximum so gridlines land on round numbers. */
  function niceMax(value) {
    if (!(value > 0)) return 1;
    const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
    const scaled = value / magnitude;
    const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
    return step * magnitude;
  }

  function seriesColour(index) { return `var(--series-${Math.min(8, index + 1)})`; }

  /**
   * Columns over an ordered axis, optionally stacked.
   *
   * series: [{ key, label, color, values: number[] }]
   * options.labels: one x label per index; options.tips: one readout title
   * per index (a date, usually); options.average: draw a trailing mean line.
   */
  function columns(series, options = {}) {
    const list = (series || []).filter((entry) => entry && entry.values && entry.values.length);
    if (!list.length) return empty(options.emptyText || "No activity recorded.");
    const count = Math.max(...list.map((entry) => entry.values.length));
    const width = 720;
    const height = options.height || 150;
    const padLeft = options.axis === false ? 6 : 44;
    const padRight = 6;
    const padBottom = options.labels ? 18 : 6;
    const padTop = 8;
    const format = options.format || fmt.num;
    const plotWidth = width - padLeft - padRight;
    const plotHeight = height - padTop - padBottom;
    const gap = count > 60 ? 1 : 2;
    const slot = plotWidth / count;
    const barWidth = Math.max(1, Math.min(24, slot - gap));

    const totals = Array.from({ length: count }, (_, index) =>
      list.reduce((sum, entry) => sum + (Number(entry.values[index]) || 0), 0));
    const max = niceMax(Math.max(...totals));
    const sy = (value) => plotHeight * (value / max);

    let grid = "";
    if (options.axis !== false) {
      grid = [0, 0.5, 1].map((fraction) => {
        const y = padTop + plotHeight - sy(max * fraction);
        return `<line class="grid-line" x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - padRight}" y2="${y.toFixed(1)}"/>
          <text class="axis-text" x="${padLeft - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${esc(format(max * fraction))}</text>`;
      }).join("");
    }

    const bars = [];
    const hits = [];
    for (let index = 0; index < count; index += 1) {
      const x = padLeft + index * slot + (slot - barWidth) / 2;
      let stackY = padTop + plotHeight;
      list.forEach((entry) => {
        const value = Number(entry.values[index]) || 0;
        if (value <= 0) return;
        const barHeight = Math.max(1.5, sy(value));
        const top = stackY - barHeight;
        // A 2px surface gap separates stacked segments; the top segment gets
        // the rounded cap and everything sits square on the baseline.
        const isTop = stackY - barHeight <= padTop + plotHeight - sy(totals[index]) + 0.01;
        const radius = isTop ? Math.min(4, barWidth / 2) : 0;
        bars.push(`<path class="col" fill="${entry.color || "var(--series-1)"}" d="${roundedTop(x, top, barWidth, Math.max(0.5, barHeight - (stackY === padTop + plotHeight ? 0 : 2)), radius)}"/>`);
        stackY = top;
      });
      const title = options.tips ? options.tips[index] : (options.labels ? options.labels[index] : String(index));
      const lines = [String(title)];
      if (list.length === 1) lines.push(format(totals[index]));
      else {
        lines.push(`${format(totals[index])} total`);
        list.forEach((entry) => {
          const value = Number(entry.values[index]) || 0;
          if (value > 0) lines.push(`${format(value)}  ${entry.label}`);
        });
      }
      hits.push(`<rect class="hit" x="${(padLeft + index * slot).toFixed(1)}" y="${padTop}" width="${slot.toFixed(1)}" height="${plotHeight}"
        fill="transparent" data-tip="${esc(lines.join("\n"))}"/>`);
    }

    let average = "";
    if (options.average && count > 3) {
      const window_ = options.average === true ? 7 : Number(options.average);
      const points = totals.map((_, index) => {
        const from = Math.max(0, index - window_ + 1);
        const slice = totals.slice(from, index + 1);
        const mean = slice.reduce((sum, value) => sum + value, 0) / slice.length;
        return `${(padLeft + index * slot + slot / 2).toFixed(1)},${(padTop + plotHeight - sy(mean)).toFixed(1)}`;
      });
      average = `<polyline class="avg-line" points="${points.join(" ")}"/>`;
    }

    let axis = "";
    if (options.labels) {
      const every = Math.max(1, Math.ceil(count / (options.labelEvery || 10)));
      axis = options.labels.map((label, index) => (index % every === 0 || index === count - 1) && label
        ? `<text class="axis-text" x="${(padLeft + index * slot + slot / 2).toFixed(1)}" y="${height - 4}" text-anchor="middle">${esc(String(label))}</text>`
        : "").join("");
    }
    return `<div class="chart"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img"
      aria-label="${esc(options.ariaLabel || "Column chart")}">${grid}${bars.join("")}${average}${axis}${hits.join("")}</svg></div>`;
  }

  /** A column with rounded top corners and a flat base. */
  function roundedTop(x, y, w, h, r) {
    if (!(h > 0)) return "";
    const radius = Math.min(r, h / 2, w / 2);
    if (!radius) return `M${x.toFixed(1)},${y.toFixed(1)}h${w.toFixed(1)}v${h.toFixed(1)}h${(-w).toFixed(1)}Z`;
    return `M${x.toFixed(1)},${(y + radius).toFixed(1)}a${radius},${radius} 0 0 1 ${radius},${-radius}h${(w - 2 * radius).toFixed(1)}a${radius},${radius} 0 0 1 ${radius},${radius}v${(h - radius).toFixed(1)}h${(-w).toFixed(1)}Z`;
  }

  /**
   * Area chart over an ordered series with a hover band per point.
   *
   * points: [{ x:number, y:number, label?:string }]
   * The x scale is linear over the given x values, so an irregular
   * series keeps its real spacing instead of being flattened to an
   * index — a two-hour gap should look like a two-hour gap.
   * options.marks: [{ x, label }] draws a vertical marker (a compaction).
   * options.ceiling: a horizontal reference line (the context window).
   */
  function area(points, options = {}) {
    const data = (points || []).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (data.length < 2) return empty(options.emptyText || "Not enough data for a trend yet.");

    const width = 720;
    const height = options.height || 150;
    const padLeft = options.padLeft != null ? options.padLeft : 46;
    const padRight = 8;
    const padBottom = options.xLabels ? 18 : 8;
    const padTop = 10;
    const colour = options.color || "var(--series-1)";
    const format = options.format || fmt.num;

    const xs = data.map((point) => point.x);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const rawMax = Math.max(...data.map((point) => point.y), options.ceiling || 0);
    const maxY = niceMax(rawMax);

    const sx = (x) => padLeft + ((x - minX) / (maxX - minX || 1)) * (width - padLeft - padRight);
    const sy = (y) => height - padBottom - (y / maxY) * (height - padTop - padBottom);

    const line = data.map((point, index) =>
      `${index ? "L" : "M"}${sx(point.x).toFixed(1)},${sy(point.y).toFixed(1)}`).join(" ");
    const fill = `${line} L${sx(maxX).toFixed(1)},${height - padBottom} L${sx(minX).toFixed(1)},${height - padBottom} Z`;

    const gradient = nextId("grad");
    const ticks = [0, 0.5, 1].map((fraction) => {
      const y = sy(maxY * fraction);
      return `<line class="grid-line" x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - padRight}" y2="${y.toFixed(1)}"/>
        <text class="axis-text" x="${padLeft - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${esc(format(maxY * fraction))}</text>`;
    }).join("");

    const ceiling = options.ceiling && options.ceiling <= maxY
      ? `<line class="ceiling-line" x1="${padLeft}" y1="${sy(options.ceiling).toFixed(1)}" x2="${width - padRight}" y2="${sy(options.ceiling).toFixed(1)}"/>
         <text class="axis-text" x="${width - padRight}" y="${(sy(options.ceiling) - 4).toFixed(1)}" text-anchor="end">${esc(options.ceilingLabel || format(options.ceiling))}</text>`
      : "";

    const marks = (options.marks || []).filter((mark) => Number.isFinite(mark.x)).map((mark) =>
      `<line class="marker-line" x1="${sx(mark.x).toFixed(1)}" y1="${padTop}" x2="${sx(mark.x).toFixed(1)}" y2="${height - padBottom}"/>`).join("");

    // Hover bands: each point owns the half-way to its neighbours, so a
    // reader aims at a moment, never at a 2px line.
    const hotspots = data.map((point, index) => {
      const left = index ? (sx(data[index - 1].x) + sx(point.x)) / 2 : padLeft;
      const right = index < data.length - 1 ? (sx(data[index + 1].x) + sx(point.x)) / 2 : width - padRight;
      const tip = `${point.label || ""}${point.label ? "\n" : ""}${format(point.y)}${point.extra ? "\n" + point.extra : ""}`;
      return `<g class="hit-band"><rect x="${left.toFixed(1)}" y="${padTop}" width="${Math.max(1, right - left).toFixed(1)}"
        height="${height - padTop - padBottom}" fill="transparent" data-tip="${esc(tip)}"/>
        <circle class="hover-dot" cx="${sx(point.x).toFixed(1)}" cy="${sy(point.y).toFixed(1)}" r="4" fill="${colour}"/></g>`;
    }).join("");

    let xAxis = "";
    if (options.xLabels) {
      // Labels go where there is room, not every Nth point: an irregular
      // series would otherwise pile them up where the points are dense.
      let lastX = -Infinity;
      xAxis = data.map((point, index) => {
        const x = sx(point.x);
        if (!point.label || x - lastX < 84 || x > width - padRight - 30) return "";
        lastX = x;
        return `<text class="axis-text" x="${x.toFixed(1)}" y="${height - 4}" text-anchor="${index === 0 ? "start" : "middle"}">${esc(point.label)}</text>`;
      }).join("");
    }

    const last = data[data.length - 1];
    return `<div class="chart"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img"
      aria-label="${esc(options.ariaLabel || "Trend chart")}">
      <defs><linearGradient id="${gradient}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${colour}" stop-opacity="0.22"/>
        <stop offset="1" stop-color="${colour}" stop-opacity="0.02"/></linearGradient></defs>
      ${ticks}${ceiling}
      <path d="${fill}" fill="url(#${gradient})"/>
      <path class="series-line" d="${line}" stroke="${colour}"/>
      ${marks}
      <circle class="series-dot" cx="${sx(last.x).toFixed(1)}" cy="${sy(last.y).toFixed(1)}" r="4" fill="${colour}"/>
      ${xAxis}${hotspots}
    </svg></div>`;
  }

  /** Donut with a readable centre — the total the slices add up to. */
  function donut(items, options = {}) {
    const data = (items || []).filter((item) => item.value > 0);
    if (!data.length) return empty(options.emptyText || "Nothing to break down.");
    const total = data.reduce((sum, item) => sum + item.value, 0);
    const size = options.size || 120;
    const radius = size / 2 - 8;
    const circumference = 2 * Math.PI * radius;
    const gap = data.length > 1 ? 2 : 0;
    let offset = 0;

    const rings = data.map((item, index) => {
      const fraction = item.value / total;
      const length = Math.max(0, fraction * circumference - gap);
      const segment = `<circle r="${radius}" cx="${size / 2}" cy="${size / 2}" fill="none"
        stroke="${item.color || seriesColour(index)}" stroke-width="12"
        stroke-dasharray="${length.toFixed(2)} ${(circumference - length).toFixed(2)}"
        stroke-dashoffset="${(-offset * circumference).toFixed(2)}"
        transform="rotate(-90 ${size / 2} ${size / 2})"
        data-tip="${esc(item.label)}\n${esc(options.format ? options.format(item.value) : fmt.num(item.value))} · ${(100 * fraction).toFixed(0)}%"/>`;
      offset += fraction;
      return segment;
    }).join("");

    const centre = options.centerValue
      ? `<div class="donut-center"><div class="dc-value">${options.centerValue}</div>
         <div class="dc-label">${esc(options.centerLabel || "")}</div></div>`
      : "";

    return `<div class="donut" style="width:${size}px;height:${size}px">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img"
        aria-label="${esc(options.ariaLabel || "Composition")}">
        <circle class="ring-track" r="${radius}" cx="${size / 2}" cy="${size / 2}" fill="none" stroke-width="12"/>
        ${rings}</svg>${centre}</div>`;
  }

  /** Sparkline for a stat tile — no axes, no labels, just the shape. */
  function sparkline(values, options = {}) {
    const data = (values || []).map((value) => Number(value) || 0);
    if (data.length < 2) return "";
    const width = 120;
    const height = 24;
    const max = Math.max(1, ...data);
    const step = width / (data.length - 1);
    const colour = options.color || "var(--series-1)";
    const line = data.map((value, index) =>
      `${index ? "L" : "M"}${(index * step).toFixed(1)},${(height - 2 - (value / max) * (height - 5)).toFixed(1)}`).join(" ");
    const last = data[data.length - 1];
    return `<div class="chart spark"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <path class="series-line" d="${line}" stroke="${colour}" stroke-width="1.5"/>
      <circle class="series-dot" cx="${width}" cy="${(height - 2 - (last / max) * (height - 5)).toFixed(1)}" r="2.5" fill="${colour}"/></svg></div>`;
  }

  /**
   * Contribution calendar. `days` is [{d, value, tip}] oldest first (or the
   * legacy [[date, count]] pairs). Levels are quartiles of the non-zero
   * values, so a quiet month still shows contrast.
   */
  function calendar(days, options = {}) {
    const data = (days || []).map((entry) => Array.isArray(entry)
      ? { d: entry[0], value: Number(entry[1]) || 0 }
      : { d: entry.d, value: Number(entry.value) || 0, tip: entry.tip });
    if (!data.length) return empty("No activity recorded yet.");
    const nonZero = data.map((entry) => entry.value).filter(Boolean).sort((a, b) => a - b);
    const quartile = (fraction) => nonZero.length ? nonZero[Math.min(nonZero.length - 1, Math.floor(nonZero.length * fraction))] : 0;
    const cuts = [quartile(0.25), quartile(0.5), quartile(0.85)];
    const level = (count) => {
      if (!count) return 0;
      if (count <= cuts[0]) return 1;
      if (count <= cuts[1]) return 2;
      if (count <= cuts[2]) return 3;
      return 4;
    };
    const format = options.format || ((value) => `${value} session${value === 1 ? "" : "s"}`);

    // Pad the first week so columns line up with real weekdays.
    const first = new Date(data[0].d + "T00:00:00");
    const lead = (first.getDay() + 6) % 7;   // Monday-first
    const cells = Array.from({ length: lead }, () => null).concat(data);
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

    let lastMonth = -1;
    const months = weeks.map((week) => {
      const firstCell = week.find(Boolean);
      if (!firstCell) return `<div class="cal-month"></div>`;
      const date = new Date(firstCell.d + "T00:00:00");
      if (date.getMonth() === lastMonth) return `<div class="cal-month"></div>`;
      lastMonth = date.getMonth();
      return `<div class="cal-month">${esc(date.toLocaleDateString(undefined, { month: "short" }))}</div>`;
    }).join("");

    const grid = weeks.map((week) => `<div class="cal-week">${
      week.map((cell) => cell
        ? `<span class="cal-day" data-level="${level(cell.value)}" data-tip="${esc(cell.tip || `${fmt.day(cell.d + "T00:00:00")}\n${format(cell.value)}`)}"></span>`
        : `<span class="cal-day" style="visibility:hidden"></span>`).join("")
    }</div>`).join("");

    return `<div class="calendar-wrap" role="img" aria-label="${esc(options.ariaLabel || "Daily activity")}">
      <div class="cal-months">${months}</div>
      <div class="calendar">${grid}</div>
      <div class="cal-legend"><span class="spacer"></span><span>less</span>
        ${[0, 1, 2, 3, 4].map((n) => `<span class="cal-day" data-level="${n}"></span>`).join("")}<span>more</span></div></div>`;
  }

  /** Weekday x hour heatmap: when the work actually happens. */
  function heatmap(grid, options = {}) {
    const rows = grid && grid.length === 7 ? grid : null;
    if (!rows) return empty("No activity recorded yet.");
    const flat = rows.flat().filter(Boolean).sort((a, b) => a - b);
    if (!flat.length) return empty("No activity recorded yet.");
    const quartile = (fraction) => flat[Math.min(flat.length - 1, Math.floor(flat.length * fraction))];
    const cuts = [quartile(0.25), quartile(0.5), quartile(0.85)];
    const level = (count) => {
      if (!count) return 0;
      if (count <= cuts[0]) return 1;
      if (count <= cuts[1]) return 2;
      if (count <= cuts[2]) return 3;
      return 4;
    };
    const unit = options.unit || "turns";
    const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    let html = `<div class="heat" role="img" aria-label="${esc(options.ariaLabel || "Activity by weekday and hour")}">`;
    html += `<span></span>`;
    for (let hour = 0; hour < 24; hour += 1) {
      html += `<span class="h-hour">${hour % 3 === 0 ? hour : ""}</span>`;
    }
    rows.forEach((row, day) => {
      html += `<span class="h-label">${names[day]}</span>`;
      row.slice(0, 24).forEach((count, hour) => {
        html += `<span class="h-cell" data-level="${level(count)}"
          data-tip="${names[day]} ${String(hour).padStart(2, "0")}:00\n${count} ${unit}"></span>`;
      });
    });
    return html + "</div>";
  }

  ASM.charts = { area, columns, donut, sparkline, calendar, heatmap, empty, niceMax, seriesColour };
})(window.ASM = window.ASM || {});
