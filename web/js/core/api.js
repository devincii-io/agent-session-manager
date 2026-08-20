/* ============================================================
   The one way this frontend talks to Python.

   Every bridge slot returns a JSON string; `call` parses it and
   resolves. When no backend is attached — a plain browser opening
   web/index.html for a design pass — every call resolves to null and
   the app falls back to its preview fixtures instead of throwing.
   ============================================================ */

(function (ASM) {
  "use strict";

  let backend = null;

  function attach(object) { backend = object; }
  function isLive() { return backend !== null; }

  function call(method, ...args) {
    return new Promise((resolve) => {
      if (!backend || typeof backend[method] !== "function") {
        resolve(null);
        return;
      }
      try {
        backend[method](...args, (result) => {
          if (typeof result !== "string") { resolve(result); return; }
          try { resolve(JSON.parse(result)); }
          catch { resolve(result); }
        });
      } catch (error) {
        console.warn("bridge call failed:", method, error);
        resolve(null);
      }
    });
  }

  /** Fire-and-forget slots that take no callback (window controls, leaveSession). */
  function send(method, ...args) {
    if (backend && typeof backend[method] === "function") {
      try { backend[method](...args); } catch { /* the window may be closing */ }
    }
  }

  ASM.api = { attach, call, send, isLive, get backend() { return backend; } };
})(window.ASM = window.ASM || {});
