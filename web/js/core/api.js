/* ============================================================
   The one way this frontend talks to Python.

   Every read goes through `backend.invoke(id, method, argsJson)`,
   which returns at once; the answer arrives later on the `replied`
   signal and resolves the matching promise. The GUI thread in
   Python is never blocked by a scan, and several calls can be in
   flight at the same time, so a slow aggregate never holds up the
   session the user just clicked.

   The bridge answers a superseded request with {stale: true}. That
   resolves to null here; every loader already drops results whose
   ticket is out of date, so a stale answer is simply nothing.

   When no backend is attached — a plain browser opening
   web/index.html for a design pass — every call resolves to null and
   the app falls back to its preview fixtures instead of throwing.
   ============================================================ */

(function (ASM) {
  "use strict";

  let backend = null;
  let seq = 0;
  const pending = new Map();
  const progressListeners = new Set();

  function parse(result) {
    if (typeof result !== "string") return result;
    try { return JSON.parse(result); } catch { return result; }
  }

  function onReply(id, payload) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    const value = parse(payload);
    entry.resolve(value && typeof value === "object" && value.stale ? null : value);
  }

  function onProgress(payload) {
    const event = parse(payload);
    if (!event) return;
    progressListeners.forEach((fn) => {
      try { fn(event); } catch (error) { console.warn("progress listener failed", error); }
    });
  }

  function attach(object) {
    backend = object;
    if (object && object.replied && typeof object.replied.connect === "function") {
      object.replied.connect(onReply);
    }
    if (object && object.progress && typeof object.progress.connect === "function") {
      object.progress.connect(onProgress);
    }
  }

  function isLive() { return backend !== null; }

  function call(method, ...args) {
    if (!backend) return Promise.resolve(null);
    if (typeof backend.invoke === "function") {
      return new Promise((resolve) => {
        seq += 1;
        const id = String(seq);
        pending.set(id, { resolve, method });
        try {
          backend.invoke(id, method, JSON.stringify(args));
        } catch (error) {
          pending.delete(id);
          console.warn("bridge invoke failed:", method, error);
          resolve(null);
        }
      });
    }
    // Older bridges without the async lane: the slot answers in its callback.
    return new Promise((resolve) => {
      if (typeof backend[method] !== "function") { resolve(null); return; }
      try {
        backend[method](...args, (result) => resolve(parse(result)));
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

  /** Subscribe to indexing progress from the backend's cold parses. */
  function onIndexProgress(fn) { progressListeners.add(fn); return () => progressListeners.delete(fn); }

  ASM.api = {
    attach, call, send, isLive, onIndexProgress,
    get backend() { return backend; },
    get inflight() { return pending.size; },
  };
})(window.ASM = window.ASM || {});
