/* ============================================================
   Charts, as inline SVG strings.

   Two rules hold everywhere in this file:

   1. No colour literals. Every fill and stroke is a CSS custom
      property, so both themes are correct without a second code
      path and a theme switch needs no redraw.
   2. Every chart states its units. A bare number on an axis that
      could be tokens, dollars or calls is a chart that lies by
      omission, so the caller passes a formatter and the axis uses it.
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
    const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
    return step * magnitude;
  }

  /**
   * Area chart over an ordered series.
   *
   * points: [{ x:number, y:number, label?:string }]
   * The x scale is linear over the given x values, so an irregular
   * series keeps its real spacing instead of being flattened to an
   * index — a two-hour gap should look like a two-hour gap.
   */
  function area(points, options = {}) {
    const data = (points || []).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (data.length < 2) return empty(options.emptyText || "Not enough data for a trend yet.");

    const width = 720;
    const height = options.height || 150;
    const padLeft = options.padLeft != null ? options.padLeft : 46;
    const padBottom = 20;
    const padTop = 10;
    const colour = options.color || "var(--series-1)";
    const format = options.format || fmt.num;

    const xs = data.map((point) => point.x);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const maxY = niceMax(Math.max(...data.map((point) => point.y)));

    const sx = (x) => padLeft + ((x - minX) / (maxX - minX || 1)) * (width - padLeft - 8);
    const sy = (y) => height - padBottom - (y / maxY) * (height - padTop - padBottom);

    const line = data.map((point, index) =>
      `${index ? "L" : "M"}${sx(point.x).toFixed(1)},${sy(point.y).toFixed(1)}`).join(" ");
    const fill = `${line} L${sx(maxX).toFixed(1)},${height - padBottom} L${sx(minX).toFixed(1)},${height - padBottom} Z`;

    const gradient = nextId("grad");
    const ticks = [0, 0.5, 1].map((fraction) => {
      const y = sy(maxY * fraction);
      return `<line class="grid-line" x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - 8}" y2="${y.toFixed(1)}"/>
        <text class="axis-text" x="${padLeft - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${esc(format(maxY * fraction))}</text>`;
    }).join("");

    // A dot per point would be noise on a long series; mark the ends only,
    // and hang a native tooltip on an invisible band per point instead.
    const hotspots = data.map((point) => {
      const x = sx(point.x);
      const bandWidth = (width - padLeft - 8) / data.length;
      return `<rect x="${(x - bandWidth / 2).toFixed(1)}" y="${padTop}" width="${Math.max(1, bandWidth).toFixed(1)}"
        height="${height - padTop - padBottom}" fill="transparent"><title>${esc(point.label || "")}${point.label ? " · " : ""}${esc(format(point.y))}</title></rect>`;
    }).join("");

    const last = data[data.length - 1];
    return `<div class="chart"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img"
      aria-label="${esc(options.ariaLabel || "Trend chart")}">
      <defs><linearGradient id="${gradient}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${colour}" stop-opacity="0.30"/>
        <stop offset="1" stop-color="${colour}" stop-opacity="0"/></linearGradient></defs>
      ${ticks}
      <path d="${fill}" fill="url(#${gradient})"/>
      <path class="series-line" d="${line}" stroke="${colour}"/>
      <circle class="series-dot" cx="${sx(last.x).toFixed(1)}" cy="${sy(last.y).toFixed(1)}" r="3" fill="${colour}"/>
      ${hotspots}
    </svg></div>`;
  }

  /** Column chart for histograms — hours of the day, values per turn. */
  function columns(values, options = {}) {
    const data = (values || []).map((value) => Number(value) || 0);
    if (!data.length) return empty(options.emptyText || "No activity recorded.");

    const width = 720;
    const height = options.height || 110;
    const padBottom = options.labels ? 18 : 6;
    const padTop = 6;
    const colour = options.color || "var(--series-2)";
    const max = Math.max(1, ...data);
    const gap = data.length > 60 ? 1 : 2;
    const barWidth = (width - gap * data.length) / data.length;
    const format = options.format || fmt.num;

    const bars = data.map((value, index) => {
      const barHeight = value > 0 ? Math.max(2, (value / max) * (height - padTop - padBottom)) : 0;
      const x = index * (barWidth + gap);
      const y = height - padBottom - barHeight;
      const label = options.labels ? options.labels[index] : index;
      return `<rect class="col" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}"
        height="${barHeight.toFixed(1)}" rx="1.5" fill="${colour}" opacity="${value ? 0.88 : 0.2}">
        <title>${esc(String(label))}: ${esc(format(value))}</title></rect>`;
    }).join("");

    let axis = "";
    if (options.labels) {
      const every = Math.max(1, Math.ceil(data.length / 12));
      axis = options.labels.map((label, index) => index % every === 0
        ? `<text class="axis-text" x="${(index * (barWidth + gap) + barWidth / 2).toFixed(1)}"
             y="${height - 4}" text-anchor="middle">${esc(String(label))}</text>`
        : "").join("");
    }
    return `<div class="chart"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img"
      aria-label="${esc(options.ariaLabel || "Column chart")}">${bars}${axis}</svg></div>`;
  }

  /** Donut with a readable centre — the total the slices add up to. */
  function donut(items, options = {}) {
    const data = (items || []).filter((item) => item.value > 0);
    if (!data.length) return empty(options.emptyText || "Nothing to break down.");
    const total = data.reduce((sum, item) => sum + item.value, 0);
    const size = options.size || 128;
    const radius = size / 2 - 9;
    const circumference = 2 * Math.PI * radius;
    let offset = 0;

    const rings = data.map((item, index) => {
      const fraction = item.value / total;
      const segment = `<circle r="${radius}" cx="${size / 2}" cy="${size / 2}" fill="none"
        stroke="${item.color || `var(--series-${(index % 8) + 1})`}" stroke-width="14"
        stroke-dasharray="${(fraction * circumference).toFixed(2)} ${circumference.toFixed(2)}"
        stroke-dashoffset="${(-offset * circumference).toFixed(2)}"
        transform="rotate(-90 ${size / 2} ${size / 2})">
        <title>${esc(item.label)}: ${esc(options.format ? options.format(item.value) : fmt.num(item.value))} (${(100 * fraction).toFixed(0)}%)</title>
      </circle>`;
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
        <circle class="ring-track" r="${radius}" cx="${size / 2}" cy="${size / 2}" fill="none" stroke-width="14"/>
        ${rings}</svg>${centre}</div>`;
  }

  /** Sparkline for a stat tile — no axes, no labels, just the shape. */
  function sparkline(values, options = {}) {
    const data = (values || []).map((value) => Number(value) || 0);
    if (data.length < 2) return "";
    const width = 120;
    const height = 22;
    const max = Math.max(1, ...data);
    const step = width / (data.length - 1);
    const colour = options.color || "var(--series-1)";
    const line = data.map((value, index) =>
      `${index ? "L" : "M"}${(index * step).toFixed(1)},${(height - 1 - (value / max) * (height - 3)).toFixed(1)}`).join(" ");
    return `<div class="chart"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <path class="series-line" d="${line}" stroke="${colour}" stroke-width="1.5"/></svg></div>`;
  }

  /**
   * Contribution calendar. `days` is [[YYYY-MM-DD, count], …] oldest first.
   * Levels are quartiles of the non-zero counts, so a quiet month still
   * shows contrast instead of collapsing to one shade.
   */
  function calendar(days, options = {}) {
    const data = (days || []).map(([date, count]) => [date, Number(count) || 0]);
    if (!data.length) return empty("No activity recorded yet.");
    const nonZero = data.map(([, count]) => count).filter(Boolean).sort((a, b) => a - b);
    const quartile = (fraction) => nonZero.length ? nonZero[Math.min(nonZero.length - 1, Math.floor(nonZero.length * fraction))] : 0;
    const cuts = [quartile(0.25), quartile(0.5), quartile(0.85)];
    const level = (count) => {
      if (!count) return 0;
      if (count <= cuts[0]) return 1;
      if (count <= cuts[1]) return 2;
      if (count <= cuts[2]) return 3;
      return 4;
    };

    // Pad the first week so columns line up with real weekdays.
    const first = new Date(data[0][0] + "T00:00:00");
    const lead = (first.getDay() + 6) % 7;   // Monday-first
    const cells = Array.from({ length: lead }, () => null).concat(data);
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

    // A month label above the week where that month starts, so a 90-day strip
    // can be read as dates rather than as an anonymous run of squares.
    let lastMonth = -1;
    const months = weeks.map((week) => {
      const first = week.find(Boolean);
      if (!first) return `<div class="cal-month"></div>`;
      const date = new Date(first[0] + "T00:00:00");
      if (date.getMonth() === lastMonth) return `<div class="cal-month"></div>`;
      lastMonth = date.getMonth();
      return `<div class="cal-month">${esc(date.toLocaleDateString(undefined, { month: "short" }))}</div>`;
    }).join("");

    const grid = weeks.map((week) => `<div class="cal-week">${
      week.map((cell) => cell
        ? `<span class="cal-day" data-level="${level(cell[1])}" title="${esc(cell[0])}: ${cell[1]} session${cell[1] === 1 ? "" : "s"}"></span>`
        : `<span class="cal-day" style="visibility:hidden"></span>`).join("")
    }</div>`).join("");

    const total = data.reduce((sum, [, count]) => sum + count, 0);
    const busiest = data.reduce((best, entry) => (entry[1] > best[1] ? entry : best), data[0]);
    const legend = `<div class="cal-legend">
      <span>${total} session${total === 1 ? "" : "s"} · busiest ${esc(busiest[0])} with ${busiest[1]}</span>
      <span class="spacer"></span><span>less</span>
      ${[0, 1, 2, 3, 4].map((n) => `<span class="cal-day" data-level="${n}"></span>`).join("")}<span>more</span></div>`;
    return `<div class="calendar-wrap" role="img" aria-label="${esc(options.ariaLabel || "Daily activity")}">
      <div class="cal-months">${months}</div>
      <div class="calendar">${grid}</div>${legend}</div>`;
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
          title="${names[day]} ${String(hour).padStart(2, "0")}:00 — ${count} session${count === 1 ? "" : "s"}"></span>`;
      });
    });
    return html + "</div>";
  }

  ASM.charts = { area, columns, donut, sparkline, calendar, heatmap, empty, niceMax };
})(window.ASM = window.ASM || {});
