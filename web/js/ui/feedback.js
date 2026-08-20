/* ============================================================
   Toasts and confirmation dialogs.

   The app never calls window.confirm: a native dialog blocks the
   QtWebEngine event loop, cannot be styled, and — the reason that
   actually matters — cannot carry the extra choice most destructive
   actions here need ("also purge the uploads?"). A test enforces the
   ban, so this is the only confirmation path.
   ============================================================ */

(function (ASM) {
  "use strict";

  const { esc } = ASM.util;

  function toast(message, kind = "") {
    let wrap = document.getElementById("toast-wrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = "toast-wrap";
      wrap.setAttribute("role", "status");
      wrap.setAttribute("aria-live", "polite");
      document.body.appendChild(wrap);
    }
    const element = document.createElement("div");
    element.className = "toast " + kind;
    element.textContent = message;
    wrap.appendChild(element);
    setTimeout(() => {
      element.style.opacity = "0";
      element.style.transition = "opacity .3s";
      setTimeout(() => element.remove(), 320);
    }, 2800);
  }

  function focusFirst(root) {
    const focusable = root.querySelectorAll("button, input, textarea, select, [tabindex='0']");
    if (focusable.length) focusable[0].focus();
  }

  /**
   * A confirmation the user has to mean.
   *
   * `extraHtml` is rendered inside the dialog and is still in the DOM when
   * `onConfirm` runs, so a handler can read its own checkbox before the
   * overlay is torn down.
   */
  function confirmDialog(title, body, onConfirm, extraHtml = "", options = {}) {
    const previous = document.activeElement;
    const back = document.createElement("div");
    back.className = "backdrop center";
    back.setAttribute("role", "dialog");
    back.setAttribute("aria-modal", "true");
    const label = options.confirmLabel ||
      (title.startsWith("Clean up") ? "Clean up" : title.startsWith("Archive") ? "Archive" : "Delete");
    const danger = options.danger !== undefined ? options.danger : label === "Delete";
    back.innerHTML = `<div class="dialog" style="width:min(480px,92vw)">
      <div class="dialog-head"><div><div class="eyebrow">Confirm</div><h2>${esc(title)}</h2></div></div>
      <div class="dialog-body"><p>${esc(body)}</p>${extraHtml}</div>
      <div class="dialog-foot">
        <span class="spacer"></span>
        <button class="btn" data-modal="cancel">Cancel</button>
        <button class="btn primary ${danger ? "danger" : ""}" data-modal="ok">${esc(label)}</button>
      </div></div>`;
    document.body.appendChild(back);
    focusFirst(back);

    const close = () => {
      back.remove();
      if (previous && previous.focus) previous.focus();
    };
    back.addEventListener("click", (event) => {
      const action = event.target.dataset ? event.target.dataset.modal : null;
      if (event.target === back || action === "cancel") close();
      else if (action === "ok") { onConfirm(); close(); }
    });
    return close;
  }

  /** A read-only look at a file, used from Monitor and the config editors. */
  async function viewFile(path) {
    const result = await ASM.api.call("readFile", path);
    const previous = document.activeElement;
    const back = document.createElement("div");
    back.className = "backdrop center";
    back.setAttribute("role", "dialog");
    back.setAttribute("aria-modal", "true");
    back.innerHTML = `<div class="dialog" style="width:min(820px,94vw)">
      <div class="dialog-head"><div><div class="eyebrow">File</div>
        <h2 class="mono">${esc(String(path).split(/[\\/]/).pop())}</h2></div></div>
      <div class="dialog-body"><pre class="code" style="max-height:56vh">${esc(result && result.ok ? result.content : "Could not read this file.")}</pre></div>
      <div class="dialog-foot"><span class="spacer"></span>
        <button class="btn" data-modal="open">Open externally</button>
        <button class="btn primary" data-modal="cancel">Close</button></div></div>`;
    document.body.appendChild(back);
    focusFirst(back);
    const close = () => { back.remove(); if (previous && previous.focus) previous.focus(); };
    back.addEventListener("click", async (event) => {
      const action = event.target.dataset ? event.target.dataset.modal : null;
      if (event.target === back || action === "cancel") close();
      else if (action === "open") { await ASM.api.call("openInEditor", path); close(); }
    });
  }

  ASM.toast = toast;
  ASM.confirm = confirmDialog;
  ASM.viewFile = viewFile;
})(window.ASM = window.ASM || {});
