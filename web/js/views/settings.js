/* ============================================================
   Settings.

   The governing rule: *only settings you actually set are written*.
   The catalog below is a menu, not a default set — nothing reaches
   settings.json until you turn it on, and removing a row prunes the
   key rather than writing a "default" value. That is why the file
   never accumulates dead keys.
   ============================================================ */

(function (ASM) {
  "use strict";

  const { esc, fmt } = ASM.util;
  const ui = ASM.ui;
  const State = ASM.state;

  // [group, key, label, type, options?, description?]
  // type: bool | enum | number | string | envflag | envstr
  //   envflag → lives under env.*, stored as the string "1" (a switch)
  //   envstr  → lives under env.*, free-form value
  const CATALOG = [
    ["Model & behavior", "model", "Model", "enum", ["default", "opus", "sonnet", "haiku", "fable"]],
    ["Model & behavior", "effortLevel", "Effort level", "enum", ["low", "medium", "high", "xhigh", "max"]],
    ["Model & behavior", "outputStyle", "Output style", "string"],
    ["Model & behavior", "alwaysThinkingEnabled", "Always thinking", "bool"],
    ["Model & behavior", "autoCompactEnabled", "Auto-compact context", "bool"],
    ["Model & behavior", "fileCheckpointingEnabled", "File checkpointing", "bool"],
    ["Model & behavior", "todoFeatureEnabled", "Todo feature", "bool"],
    ["Model & behavior", "promptSuggestionEnabled", "Prompt suggestions", "bool"],
    ["Model & behavior", "enableAllProjectMcpServers", "Enable all project MCP servers", "bool"],
    ["Model & behavior", "cleanupPeriodDays", "Keep transcripts (days)", "number", null,
      "Claude Code auto-deletes local session transcripts after this many days."],

    ["Interface", "theme", "Theme", "enum", ["dark", "light"]],
    ["Interface", "tui", "Interface", "enum", ["fullscreen", "inline"]],
    ["Interface", "verbose", "Verbose output", "bool"],
    ["Interface", "spinnerTipsEnabled", "Spinner tips", "bool"],
    ["Interface", "enableArtifact", "Artifacts", "bool"],

    ["Notifications", "preferredNotifChannel", "Notification channel", "enum",
      ["iterm2", "terminal_bell", "iterm2_with_bell", "kitty", "notifications_disabled"]],
    ["Notifications", "inputNeededNotifEnabled", "Input-needed notifications", "bool"],
    ["Notifications", "agentPushNotifEnabled", "Agent push notifications", "bool"],
    ["Notifications", "messageIdleNotifThresholdMs", "Idle-notify threshold (ms)", "number"],

    ["Permissions", "permissions.defaultMode", "Permission mode", "enum",
      ["default", "acceptEdits", "plan", "bypassPermissions"]],
    ["Permissions", "skipDangerousModePermissionPrompt", "Skip dangerous-mode prompt", "bool"],
    ["Permissions", "teammateMode", "Teammate mode", "enum", ["auto", "on", "off"]],

    ["Workflows", "enableWorkflows", "Workflows", "bool"],
    ["Workflows", "workflowKeywordTriggerEnabled", "Workflow keyword trigger", "bool"],
    ["Workflows", "skipWorkflowUsageWarning", "Skip workflow usage warning", "bool"],

    ["Updates", "autoUpdatesChannel", "Updates channel", "enum", ["latest", "stable"]],

    ["Privacy & data", "autoUploadSessions", "Auto-upload sessions to claude.ai", "bool"],
    ["Privacy & data", "includeCoAuthoredBy", "Add “Co-Authored-By: Claude” to commits", "bool"],
    ["Privacy & data", "apiKeyHelper", "API key helper (script path)", "string"],

    ["Environment", "env.DISABLE_TELEMETRY", "Disable telemetry", "envflag"],
    ["Environment", "env.DISABLE_ERROR_REPORTING", "Disable error reporting", "envflag"],
    ["Environment", "env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "Disable all non-essential traffic", "envflag"],
    ["Environment", "env.DISABLE_AUTOUPDATER", "Disable auto-updater", "envflag"],
    ["Environment", "env.ANTHROPIC_MODEL", "ANTHROPIC_MODEL", "envstr"],
    ["Environment", "env.ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "envstr"],
    ["Environment", "env.BASH_DEFAULT_TIMEOUT_MS", "BASH_DEFAULT_TIMEOUT_MS", "envstr"],
    ["Environment", "env.BASH_MAX_TIMEOUT_MS", "BASH_MAX_TIMEOUT_MS", "envstr"],
    ["Environment", "env.MCP_TIMEOUT", "MCP_TIMEOUT", "envstr"],
    ["Environment", "env.CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "envstr"],
  ];
  const BY_KEY = Object.fromEntries(CATALOG.map((row) => [row[1], row]));
  // First path segment of every known key, so a truly unknown top-level key
  // lands in "Other" instead of being edited twice.
  const KNOWN_TOP = new Set(CATALOG.map((row) => row[1].split(".")[0]).concat("env"));

  // Turning a protection ON writes its most-private value; turning it OFF
  // removes the key entirely, so the file only holds choices you made.
  const PRIVACY = [
    { key: "autoUploadSessions", label: "Keep sessions on this machine",
      desc: "Don’t mirror your sessions to claude.ai.", private: false },
    { key: "env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", label: "Disable all non-essential traffic",
      desc: "The master switch — telemetry, error reports, feedback and surveys at once.", private: "1" },
    { key: "env.DISABLE_TELEMETRY", label: "Disable usage telemetry",
      desc: "No usage or latency metrics leave your machine.", private: "1" },
    { key: "env.DISABLE_ERROR_REPORTING", label: "Disable error reporting",
      desc: "No crash reports or stack traces are sent.", private: "1" },
    { key: "includeCoAuthoredBy", label: "No “Co-Authored-By: Claude” in commits",
      desc: "Keep Claude out of your git history and pull requests.", private: false },
  ];

  /* ---------- nested key helpers ---------- */

  function getNested(object, key) {
    return key.split(".").reduce((node, part) => (node == null ? undefined : node[part]), object);
  }
  function isSet(merged, key) { return getNested(merged, key) !== undefined; }
  function isScalar(value) { return value === null || ["boolean", "number", "string"].includes(typeof value); }

  function privacyOn(merged, item) {
    const value = getNested(merged, item.key);
    if (value === undefined) return false;
    if (item.private === "1") return value === "1" || value === "true" || value === 1 || value === true;
    return value === item.private;
  }

  /* ---------- rows ---------- */

  function control(key, type, options, value) {
    const id = esc(key);
    if (type === "bool" || type === "envflag") {
      const on = type === "bool" ? !!value : (value === "1" || value === "true" || value === true || value === 1);
      return `<label class="switch"><input type="checkbox" data-setting="${id}" data-type="${type}" ${on ? "checked" : ""}>
        <span class="track"><span class="thumb"></span></span></label>`;
    }
    if (type === "enum") {
      const list = value != null && !options.includes(value) ? [value, ...options] : options;
      return `<select class="select" data-setting="${id}" data-type="str">${list.map((option) =>
        `<option ${option === value ? "selected" : ""}>${esc(option)}</option>`).join("")}</select>`;
    }
    const dataType = type === "number" ? "num" : (type === "envstr" ? "envstr" : "str");
    return `<input class="s-input" type="${type === "number" ? "number" : "text"}" data-setting="${id}"
      data-type="${dataType}" value="${esc(value == null ? "" : value)}" placeholder="unset">`;
  }

  function settingRow(key, value) {
    const row = BY_KEY[key];
    const label = row ? row[2] : key;
    const type = row ? row[3]
      : (typeof value === "boolean" ? "bool" : typeof value === "number" ? "number" : "string");
    const description = row && row[5] ? row[5] : "";
    return `<div class="setting-row">
      <div class="s-main"><div class="s-label">${esc(label)}</div><div class="s-key">${esc(key)}</div>
        ${description ? `<div class="s-desc">${esc(description)}</div>` : ""}</div>
      <div class="s-ctl">${control(key, type, row ? row[4] : null, value)}
        <button class="s-x" data-action="setting-remove" data-key="${esc(key)}" title="Remove from settings.json">×</button></div>
    </div>`;
  }

  function complexRow(key, value) {
    let preview;
    try { preview = JSON.stringify(value); } catch { preview = String(value); }
    if (preview.length > 120) preview = preview.slice(0, 117) + "…";
    return `<div class="setting-row">
      <div class="s-main"><div class="s-label">${esc(key)}</div><div class="s-key">${esc(preview)}</div></div>
      <div class="s-ctl"><button class="btn sm" data-action="open-settings-json">Edit in settings.json</button>
        <button class="s-x" data-action="setting-remove" data-key="${esc(key)}" title="Remove">×</button></div></div>`;
  }

  function privacyRow(merged, item) {
    const on = privacyOn(merged, item);
    return `<div class="setting-row priv ${on ? "on" : ""}">
      <div class="s-main"><div class="s-label">${esc(item.label)}${on ? `<span class="priv-tag">on</span>` : ""}</div>
        <div class="s-desc">${esc(item.desc)}</div><div class="s-key">${esc(item.key)}</div></div>
      <label class="switch"><input type="checkbox" data-role="privacy" data-key="${esc(item.key)}" ${on ? "checked" : ""}>
        <span class="track"><span class="thumb"></span></span></label></div>`;
  }

  /* ---------- shared sections ---------- */

  function sourcesSection() {
    return ui.section("Environments", `<div class="card source-settings">${State.sources.map((source) => `
      <div class="source-setting">
        <div class="s-main"><div class="s-label">${esc(source.label)}</div>
          <div class="s-desc">${source.kind === "local" ? "Native live scanning"
            : `${State.enabledSources.has(source.id) ? "Enabled · manual refresh" : "Off · no scan cost"} · Claude and Codex`}</div></div>
        <label class="switch"><input type="checkbox" data-role="source-toggle" data-source="${esc(source.id)}"
          ${State.enabledSources.has(source.id) ? "checked" : ""} ${source.kind === "local" ? "disabled" : ""}>
          <span class="track"><span class="thumb"></span></span></label>
      </div>`).join("")}</div>`, {
      desc: "Windows is always on. WSL distributions are opt-in — only enabled sources are scanned, which keeps refreshes fast.",
      actions: `<button class="btn sm" data-action="sources-all-on">Enable WSL</button>
        <button class="btn sm" data-action="sources-all-off">Disable WSL</button>
        <button class="btn sm" data-action="refresh-sources">Detect again</button>`,
    });
  }

  /**
   * The update card. Every state the updater can be in is spelled out here,
   * including the one people care about most: *why* an update cannot be
   * installed in place when it can't.
   */
  function updatesSection() {
    const update = State.update;
    let title = "Automatic update checks";
    let detail = "Checks the official GitHub release, then verifies the installer's filename and SHA-256 against SHA256SUMS.txt before opening it.";
    let actions = `<button class="btn sm" data-action="check-update">Check now</button>`;
    let status = ui.badge(`v${State.appVersion}`);

    if (State.updateBusy === "check") {
      title = "Checking for updates…";
      actions = `<button class="btn sm" disabled>Checking…</button>`;
    } else if (State.updateBusy === "install") {
      title = "Downloading and verifying the installer…";
      detail = "The release asset is downloaded, checksum-verified, and only then opened.";
      actions = `<button class="btn sm" disabled>Downloading…</button>`;
    } else if (update && update.ok === false) {
      title = "Update check failed";
      detail = update.error || "GitHub could not be reached.";
      status = ui.badge("offline", "amber");
    } else if (update && update.update_available) {
      title = `Version ${update.latest} is available`;
      detail = update.installable
        ? "The release asset will be downloaded, checksum-verified, then opened for an in-place upgrade."
        : "This release has no verified installer for your platform. Open its release page for the other downloads.";
      status = ui.badge("update", "accent");
      actions = update.installable
        ? `<button class="btn sm primary" data-action="install-update">Install update</button>
           <button class="btn sm" data-action="open-release">Release notes</button>`
        : `<button class="btn sm" data-action="open-release">Open release</button>`;
    } else if (update && update.latest) {
      title = "Agent Session Manager is up to date";
      detail = `Installed ${State.appVersion} · latest ${update.latest}. Background checks are cached for six hours.`;
      status = ui.badge("up to date", "green");
    }

    return `<section class="section" id="updates">
      <div class="section-title"><span>App updates</span></div>
      <div class="card update-row">
        <div class="update-copy"><div class="s-label">${esc(title)} ${status}</div>
          <div class="s-desc">${esc(detail)}</div></div>
        <div class="update-actions">${actions}</div>
      </div></section>`;
  }

  /* ---------- views ---------- */

  function codexView() {
    const settings = State.settings || {};
    const files = State.configFiles || [];
    return `
      <div class="page-head"><div class="ph-title"><h1>Codex settings</h1>
        <div class="ph-sub mono">${esc(settings.home || State.agentHome || "$CODEX_HOME")}</div></div>
        <div class="page-actions"><button class="btn sm" data-action="open-folder"
          data-path="${esc(settings.home || State.agentHome || "")}">Open Codex home</button></div></div>
      ${sourcesSection()}
      ${ui.notice(`<strong>A deliberately small surface.</strong> Only <span class="mono">config.toml</span> and
        <span class="mono">AGENTS.md</span> are editable here. Credentials, SQLite state, encrypted reasoning and
        sandbox secrets are never exposed.`)}
      ${ui.section("Configuration and instructions", `<div class="config-layout">
        <div class="config-files">${files.map((file) => `
          <button class="cfg-file ${State._cfgFile === file.path ? "active" : ""}" data-action="cfg-file" data-path="${esc(file.path)}">
            <span class="f-name">${esc(file.name)}</span>
            <small>${esc(file.group || "Codex")}${file.missing ? " · new" : ` · ${fmt.bytes(file.size)}`}</small></button>`).join("")}</div>
        <div id="cfg-editor" class="config-editor">${State._cfgFile
          ? ui.skeleton("Select the file again to load it.")
          : ui.emptyState("▤", "Select config.toml or AGENTS.md", "A project AGENTS.md appears once a project is selected.")}</div>
      </div>`, { desc: "Codex owns the TOML schema and its session indexes. Existing files are backed up before this app writes them." })}
      ${updatesSection()}`;
  }

  function render() {
    const selectedSource = State.source === "all" ? null : State.sources.find((source) => source.id === State.source);

    if (State.source === "all" || (selectedSource && selectedSource.kind === "wsl")) {
      return `<div class="page-head"><div class="ph-title"><h1>Environment settings</h1>
          <div class="ph-sub">Choose which Windows and WSL stores participate in scans.</div></div></div>
        ${sourcesSection()}
        ${ui.emptyState("R", "Configuration is read-only here",
          "Select Windows to edit agent configuration. WSL browsing, metrics, search, resume and Codex archive stay source-aware.")}
        ${updatesSection()}`;
    }
    if (State.agent === "codex") return codexView();
    if (State.agent === "all") {
      return `<div class="page-head"><div class="ph-title"><h1>Settings</h1>
          <div class="ph-sub">Configuration never crosses agent boundaries — pick one.</div></div></div>
        ${sourcesSection()}
        <div class="quick-launch">
          <button class="quick-action" data-action="switch-agent" data-agent="claude" data-next="settings">
            <strong>Claude Code settings</strong><span>settings.json, privacy, statusline</span></button>
          <button class="quick-action" data-action="switch-agent" data-agent="codex" data-next="settings">
            <strong>Codex settings</strong><span>config.toml and AGENTS.md</span></button>
        </div>${updatesSection()}`;
    }

    const settings = State.settings;
    if (!settings) return ui.skeleton("Loading settings…");
    const merged = settings.merged || {};
    const env = merged.env && typeof merged.env === "object" ? merged.env : {};
    const live = settings.live;
    const statusline = State.statuslineStatus || {};
    const files = State.configFiles || [];

    const activeKnown = CATALOG.filter((row) => !row[1].startsWith("env.") && isSet(merged, row[1]));
    const otherKeys = Object.keys(merged).filter((key) => !KNOWN_TOP.has(key));
    const allPrivacyOn = PRIVACY.every((item) => privacyOn(merged, item));

    const groups = [];
    for (const row of CATALOG) {
      if (row[1].startsWith("env.") || isSet(merged, row[1])) continue;
      let group = groups.find((entry) => entry.name === row[0]);
      if (!group) { group = { name: row[0], items: [] }; groups.push(group); }
      group.items.push(row);
    }

    return `
      <div class="page-head"><div class="ph-title"><h1>Settings</h1>
        <div class="ph-sub mono">${esc(settings.home)}/settings.json</div></div>
        <div class="page-actions">
          <button class="btn sm" data-action="open-settings-json">Open settings.json</button>
          <button class="btn sm" data-action="open-folder" data-path="${esc(settings.home)}">Open folder</button></div></div>

      ${sourcesSection()}

      ${ui.section("Privacy & data", `<div class="card"><div class="setting-list">
        ${PRIVACY.map((item) => privacyRow(merged, item)).join("")}</div></div>`, {
        desc: "Turning a protection on writes only that switch; turning it off removes the key. Values are written verbatim as documented Claude Code settings and environment variables.",
        actions: `<button class="btn sm ${allPrivacyOn ? "" : "primary"}" data-action="privacy-apply-all"
          ${allPrivacyOn ? "disabled" : ""}>${allPrivacyOn ? "All protections on" : "Apply privacy-first defaults"}</button>`,
      })}

      ${ui.section("Active settings", `<div class="card">
        <div class="setting-list">
          ${activeKnown.map((row) => settingRow(row[1], getNested(merged, row[1]))).join("")}
          ${otherKeys.map((key) => (isScalar(merged[key]) ? settingRow(key, merged[key]) : complexRow(key, merged[key]))).join("")}
          ${(activeKnown.length || otherKeys.length) ? "" :
            `<div class="faint" style="font-size:12px;padding:6px 2px">Nothing set yet — a clean slate. Add settings below.</div>`}
        </div>
        <div class="add-bar">
          <select class="picker" data-role="add-setting">
            <option value="">+ Add a setting…</option>
            ${groups.map((group) => `<optgroup label="${esc(group.name)}">${group.items.map((row) =>
              `<option value="${esc(row[1])}">${esc(row[2])}</option>`).join("")}</optgroup>`).join("")}
          </select>
          <span class="add-sep">or</span>
          <input class="s-input" id="custom-key" placeholder="custom.key.path" style="max-width:190px">
          <input class="s-input" id="custom-val" placeholder="value (JSON or text)" style="max-width:160px">
          <button class="btn sm" data-action="add-custom">Add</button>
        </div></div>`, {
        desc: "Only settings you have actually set live in settings.json. Remove one with × and the key is pruned.",
        actions: (activeKnown.length + otherKeys.length)
          ? `<span class="faint" style="font-weight:400;font-size:11px">${activeKnown.length + otherKeys.length} set</span>` : "",
      })}

      ${ui.section("Environment variables", `<div class="card">
        <div class="setting-list">${Object.keys(env).length
          ? Object.entries(env).map(([name, value]) => `<div class="setting-row">
              <div class="s-main"><div class="s-label mono">${esc(name)}</div></div>
              <div class="s-ctl"><input class="s-input" data-setting="env.${esc(name)}" data-type="envstr"
                value="${esc(value == null ? "" : value)}">
                <button class="s-x" data-action="setting-remove" data-key="env.${esc(name)}" title="Remove">×</button></div>
            </div>`).join("")
          : `<div class="faint" style="font-size:12px;padding:6px 2px">No environment variables set.</div>`}</div>
        <div class="add-bar">
          <input class="s-input" id="env-name" list="known-env" placeholder="ENV_VAR_NAME" style="max-width:230px">
          <input class="s-input" id="env-val" placeholder="value" style="max-width:170px">
          <button class="btn sm" data-action="add-env">Add env var</button>
          <datalist id="known-env">${CATALOG.filter((row) => row[1].startsWith("env."))
            .map((row) => `<option value="${esc(row[1].slice(4))}">`).join("")}</datalist>
        </div></div>`, { desc: "The env block Claude Code injects into every session." })}

      ${ui.section("Live statusline capture", `<div class="card">
        <p class="dim" style="font-size:12.5px;margin-bottom:12px">Rate limits (5h / 7d) and live context percentage are
          only handed to your statusline command by Claude Code — they are never written to disk. Enabling capture inserts
          one guarded line into your statusline script so this app can read the latest values, and it can be removed at any time.</p>
        <div class="row">
          ${statusline.installed
            ? `<span class="badge green"><span class="dot-active"></span> capture installed</span>
               <button class="btn sm danger" data-action="statusline-uninstall">Remove</button>`
            : `<button class="btn sm primary" data-action="statusline-install">Enable capture</button>`}
          <span class="faint" style="font-size:11.5px">${esc(statusline.script || "no statusline script found")}</span>
        </div>
        ${live ? livePanel(live) : `<div class="faint" style="font-size:12px;margin-top:12px">
          No live snapshot captured yet — run Claude Code once after enabling.</div>`}
      </div>`)}

      ${ui.section("Config files", `<div class="card">
        <div class="config-files">${files.map((file) => `
          <button class="cfg-file ${State._cfgFile === file.path ? "active" : ""}" data-action="cfg-file" data-path="${esc(file.path)}">
            <span class="cf-ext">${esc(file.ext || "txt")}</span>
            <span class="f-name">${esc(file.name)}</span>
            <small>${fmt.bytes(file.size)}</small></button>`).join("")
          || `<div class="faint" style="font-size:12px">No config files.</div>`}</div>
        <div id="cfg-editor" style="margin-top:14px"></div></div>`)}

      ${updatesSection()}`;
  }

  function livePanel(live) {
    const context = live.context_window || {};
    const limits = live.rate_limits || {};
    const fiveHour = limits.five_hour || {};
    const sevenDay = limits.seven_day || {};
    const rows = [];
    if (context.used_percentage != null) rows.push(ui.meterRow("ctx", context.used_percentage, fmt.pct(+context.used_percentage)));
    if (fiveHour.used_percentage != null) rows.push(ui.meterRow("5h", fiveHour.used_percentage, fmt.pct(+fiveHour.used_percentage)));
    if (sevenDay.used_percentage != null) rows.push(ui.meterRow("7d", sevenDay.used_percentage, fmt.pct(+sevenDay.used_percentage)));
    return `<div style="margin-top:14px;display:flex;flex-direction:column;gap:8px">
      <div class="faint" style="font-size:11px">Live snapshot · ${esc((live.model && live.model.display_name) || "")}
        · captured ${esc(fmt.rel(live._captured_mtime))}</div>
      ${rows.join("") || `<div class="faint">No meters in the snapshot.</div>`}</div>`;
  }

  /* ---------- writes ---------- */

  async function apply(key, value, quiet) {
    const result = await ASM.api.call("updateSetting", key, JSON.stringify(value === undefined ? null : value));
    if (result && result.ok) {
      // Refetch rather than patching locally: the backend prunes empty parents,
      // and the "active settings" list has to reflect what is really on disk.
      State.settings = await ASM.api.call("getSettings");
      ASM.router.renderMain();
      if (!quiet) ASM.toast(value === null ? `Removed ${key.split(".").pop()}` : `Saved ${key.split(".").pop()}`, "ok");
      return true;
    }
    ASM.toast("Update failed", "err");
    return false;
  }

  async function addFromCatalog(key) {
    const row = BY_KEY[key];
    const type = row ? row[3] : "string";
    const value = type === "bool" ? true
      : type === "enum" ? row[4][0]
      : type === "number" ? 0
      : type === "envflag" ? "1" : "";
    await apply(key, value);
  }

  async function applyPrivacy(key, on) {
    const item = PRIVACY.find((entry) => entry.key === key);
    if (!item) return;
    await apply(key, on ? item.private : null, true);
    ASM.toast(on ? "Protection on" : "Protection off", "ok");
  }

  async function applyPrivacyDefaults() {
    const items = PRIVACY.map((item) => ({ key: item.key, value: item.private }));
    const result = await ASM.api.call("updateSettings", JSON.stringify(items));
    if (result && result.ok) {
      State.settings = await ASM.api.call("getSettings");
      ASM.router.renderMain();
      ASM.toast("Privacy-first defaults applied", "ok");
    } else ASM.toast("Failed", "err");
  }

  async function addCustom() {
    const keyInput = document.getElementById("custom-key");
    const valueInput = document.getElementById("custom-val");
    const key = ((keyInput && keyInput.value) || "").trim();
    if (!key) { ASM.toast("Enter a key", "err"); return; }
    const raw = ((valueInput && valueInput.value) || "").trim();
    let value;
    try { value = JSON.parse(raw); } catch { value = raw; }
    await apply(key, value);
  }

  async function addEnv() {
    const nameInput = document.getElementById("env-name");
    const valueInput = document.getElementById("env-val");
    const name = ((nameInput && nameInput.value) || "").trim();
    if (!name) { ASM.toast("Enter a variable name", "err"); return; }
    await apply("env." + name, (valueInput && valueInput.value) || "");
  }

  /** Wire an editable control's change event to a settings.json write. */
  async function onControlChange(element) {
    const key = element.dataset.setting;
    const type = element.dataset.type;
    let value;
    if (type === "bool") value = element.checked;
    else if (type === "envflag") value = element.checked ? "1" : null;
    else if (type === "num") {
      const text = element.value.trim();
      if (text === "") value = null;
      else {
        value = Number(text);
        if (Number.isNaN(value)) { ASM.toast("Not a number", "err"); return; }
      }
    } else {
      value = element.value === "" ? null : element.value;   // blank removes the key
    }
    await apply(key, value);
  }

  ASM.views = ASM.views || {};
  ASM.views.settings = {
    render, apply, addFromCatalog, applyPrivacy, applyPrivacyDefaults,
    addCustom, addEnv, onControlChange, updatesSection, sourcesSection, CATALOG,
  };
})(window.ASM = window.ASM || {});
