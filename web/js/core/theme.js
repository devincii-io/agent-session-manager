/* ============================================================
   Theme switching.

   Only three things happen here: the attribute goes on <html>, the
   choice is remembered, and anything that painted itself imperatively
   (the journey canvas) is told to repaint. Every other colour in the
   app is a CSS custom property and follows the attribute on its own.
   ============================================================ */

(function (ASM) {
  "use strict";

  const listeners = new Set();

  function apply(theme) {
    const value = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", value);
    ASM.state.theme = value;
    ASM.persist.set("theme", value);
    const button = document.getElementById("theme-toggle");
    if (button) {
      button.textContent = value === "light" ? "☾" : "☀";
      button.title = value === "light" ? "Switch to the dark theme" : "Switch to the light theme";
    }
    listeners.forEach((fn) => {
      try { fn(value); } catch (error) { console.warn("theme listener failed", error); }
    });
  }

  function toggle() { apply(ASM.state.theme === "light" ? "dark" : "light"); }

  /** Register a repaint callback for anything drawn to a canvas. */
  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  function init() { apply(ASM.state.theme); }

  ASM.theme = { apply, toggle, onChange, init };
})(window.ASM = window.ASM || {});
