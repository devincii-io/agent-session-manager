/* ============================================================
   Formatting, escaping and small DOM helpers.

   Every file in web/js is an IIFE that hangs its exports off the one
   global `ASM`. Classic scripts share a single top-level lexical
   scope, so without the wrapper two files could not both declare a
   local called `esc`. There is no bundler and no module loader here
   on purpose: the page is loaded from file:// inside QtWebEngine,
   where `type="module"` fetches are subject to CORS and would fail.
   ============================================================ */

(function (ASM) {
  "use strict";

  /** HTML-escape anything destined for an innerHTML template. */
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** Attribute-safe escape for values interpolated into data-* slots. */
  const attr = esc;

  // Currency is formatted by Intl rather than by gluing a "$" onto a grouped
  // number: in a German locale the latter produces "$1.998" for $1,998, which
  // reads as one dollar ninety-nine. Intl puts the symbol and the separators
  // where that locale actually expects them.
  const currency = new Intl.NumberFormat(undefined, {
    style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  const currencyRound = new Intl.NumberFormat(undefined, {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  });
  const dayMonth = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });

  const fmt = {
    cost(value) {
      const n = Number(value) || 0;
      if (n === 0) return currency.format(0);
      if (n > 0 && n < 0.01) return "<" + currency.format(0.01);
      return n >= 1000 ? currencyRound.format(n) : currency.format(n);
    },
    tokens(value) {
      const n = Number(value) || 0;
      if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
      if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
      return String(n);
    },
    num(value) { return (Number(value) || 0).toLocaleString(); },
    /** 1,284 · 12.9k · 4.2M — the compact figure a stat tile wants. */
    compact(value) {
      const n = Number(value) || 0;
      if (Math.abs(n) < 10000) return n.toLocaleString();
      return fmt.tokens(n);
    },
    bytes(value) {
      const n = Number(value) || 0;
      if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
      if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
      if (n >= 1e3) return (n / 1e3).toFixed(1) + " KB";
      return n + " B";
    },
    pct(value, digits = 0) { return (Number(value) || 0).toFixed(digits) + "%"; },

    /** A duration a person can read: 340ms, 12s, 4m 30s, 2h 05m. */
    duration(ms) {
      const n = Math.max(0, Math.round(Number(ms) || 0));
      if (n < 1000) return n + "ms";
      const seconds = n / 1000;
      if (seconds < 60) return (seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)) + "s";
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + "m " + String(Math.round(seconds % 60)).padStart(2, "0") + "s";
      const hours = Math.floor(minutes / 60);
      if (hours < 48) return hours + "h " + String(minutes % 60).padStart(2, "0") + "m";
      return Math.floor(hours / 24) + "d " + (hours % 24) + "h";
    },

    /** Hours of work, coarse: 0m, 45m, 3h 20m, 18h, 61h. */
    hours(ms) {
      const minutes = Math.round((Number(ms) || 0) / 60000);
      if (minutes < 1) return "0m";
      if (minutes < 60) return minutes + "m";
      const hours = Math.floor(minutes / 60);
      const rest = minutes % 60;
      if (hours >= 10 || !rest) return hours + "h";
      return hours + "h " + String(rest).padStart(2, "0") + "m";
    },

    /** A signed percentage change, or "new" when there is no baseline. */
    delta(current, previous) {
      const now = Number(current) || 0;
      const then = Number(previous) || 0;
      if (!then) return now ? "new" : "";
      // A baseline under a twentieth of today's figure turns any change into
      // a four-digit percentage that reads as noise; say nothing instead.
      if (then < now * 0.05) return "";
      const change = (100 * (now - then)) / then;
      if (Math.abs(change) < 0.5) return "±0%";
      return (change > 0 ? "+" : "−") + Math.abs(change).toFixed(Math.abs(change) < 10 ? 1 : 0) + "%";
    },

    /** Epoch seconds or an ISO string → milliseconds, or NaN. */
    ms(value) {
      if (value == null || value === "") return NaN;
      if (typeof value === "number") return value > 1e11 ? value : value * 1000;
      return Date.parse(value);
    },

    rel(value) {
      const t = fmt.ms(value);
      if (isNaN(t)) return "—";
      const seconds = (Date.now() - t) / 1000;
      if (seconds < 0) return "just now";
      if (seconds < 60) return "just now";
      if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
      if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
      if (seconds < 604800) return Math.floor(seconds / 86400) + "d ago";
      return new Date(t).toLocaleDateString();
    },

    time(value) {
      const t = fmt.ms(value);
      return isNaN(t) ? "" : new Date(t).toLocaleString();
    },

    clock(value) {
      const t = fmt.ms(value);
      if (isNaN(t)) return "";
      return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    },

    /** "Aug 20" — for axes and rows where the year is obvious. */
    day(value) {
      const t = fmt.ms(value);
      if (isNaN(t)) return "";
      return dayMonth.format(new Date(t));
    },

    /** "Aug 20 · 09:12" */
    dayClock(value) {
      const t = fmt.ms(value);
      if (isNaN(t)) return "";
      return `${dayMonth.format(new Date(t))} · ${fmt.clock(t)}`;
    },

    weekday(value) {
      const t = fmt.ms(value);
      return isNaN(t) ? "" : weekday.format(new Date(t));
    },

    /** A YYYY-MM-DD key in local time. */
    isoDay(value) {
      const t = fmt.ms(value);
      if (isNaN(t)) return "";
      const d = new Date(t);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    },

    /** The day bucket a timestamp belongs to, as a person would name it. */
    dayBucket(value) {
      const t = fmt.ms(value);
      if (isNaN(t)) return "Undated";
      const then = new Date(t);
      const today = new Date();
      const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
      const days = Math.floor((startOfToday - new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) / 86400000);
      if (days <= 0) return "Today";
      if (days === 1) return "Yesterday";
      if (days < 7) return "This week";
      if (days < 30) return "This month";
      if (days < 365) return then.toLocaleDateString(undefined, { month: "long", year: "numeric" });
      return String(then.getFullYear());
    },

    model(name) {
      return String(name || "unknown").replace(/^claude-/, "").replace(/-\d{8}$/, "");
    },

    /** Trim a path to its last two segments — enough to identify a file. */
    shortPath(path) {
      const parts = String(path || "").split(/[\\/]/).filter(Boolean);
      return parts.slice(-2).join("/") || String(path || "");
    },

    plural(count, noun, plural) {
      const n = Number(count) || 0;
      return `${n.toLocaleString()} ${n === 1 ? noun : (plural || noun + "s")}`;
    },
  };

  /* ---------- DOM ---------- */

  const dom = {
    id(name) { return document.getElementById(name); },
    q(selector, root) { return (root || document).querySelector(selector); },
    all(selector, root) { return Array.from((root || document).querySelectorAll(selector)); },

    /** Replace a container's markup and restore its scroll position. */
    keepScroll(element, render) {
      if (!element) { render(); return; }
      const top = element.scrollTop;
      render();
      element.scrollTop = top;
    },

    /** Make non-button [data-action] nodes reachable by keyboard. */
    enhance(root) {
      if (!root) return;
      dom.all("[data-action]:not(button):not(input):not(select):not(textarea):not(a)", root)
        .forEach((el) => {
          if (!el.hasAttribute("tabindex")) el.tabIndex = 0;
          if (!el.hasAttribute("role")) el.setAttribute("role", "button");
        });
      dom.all(".tabs", root).forEach((el) => el.setAttribute("role", "tablist"));
      dom.all(".tab", root).forEach((el) => {
        el.setAttribute("role", "tab");
        el.setAttribute("aria-selected", el.classList.contains("active") ? "true" : "false");
      });
    },

    /** Read a CSS custom property off the document element. */
    token(name, fallback = "#888") {
      const value = getComputedStyle(document.documentElement).getPropertyValue(name);
      return (value || "").trim() || fallback;
    },

    async copy(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // QtWebEngine can refuse the async clipboard; the legacy path works.
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        area.remove();
        return ok;
      }
    },
  };

  /** Coalesce rapid calls into one animation frame. */
  function raf(fn) {
    let handle = 0;
    return function scheduled(...args) {
      cancelAnimationFrame(handle);
      handle = requestAnimationFrame(() => fn(...args));
    };
  }

  /** Trailing debounce. */
  function debounce(fn, wait) {
    let timer = 0;
    return function scheduled(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  /** At most one call per `wait` ms, trailing edge kept. */
  function throttle(fn, wait) {
    let last = 0;
    let timer = 0;
    return function scheduled(...args) {
      const now = Date.now();
      const remaining = wait - (now - last);
      clearTimeout(timer);
      if (remaining <= 0) { last = now; fn(...args); return; }
      timer = setTimeout(() => { last = Date.now(); fn(...args); }, remaining);
    };
  }

  function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }

  function sum(list, pick) {
    let total = 0;
    for (const item of list || []) total += Number(pick ? pick(item) : item) || 0;
    return total;
  }

  ASM.util = { esc, attr, fmt, dom, raf, debounce, throttle, clamp, sum };
})(window.ASM = window.ASM || {});
