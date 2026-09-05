/* ============================================================
   Preview fixtures.

   Opening web/index.html in a plain browser — no Qt, no backend —
   boots the app against these instead of a live machine. That makes
   the frontend workable on its own for a design pass, and it is what
   the repository screenshots are taken from, so no real project name
   or prompt of anyone's ever ends up in the README.

   The data is shaped exactly like the backend's, including the goal
   records asm/goals.py emits, the per-day ledger the scanner rolls
   up, and the trace of skills, agents, kills and interruptions, so
   the preview exercises the real rendering path rather than a
   simplified one.
   ============================================================ */

(function (ASM) {
  "use strict";

  const HOUR = 3600 * 1000;
  const MINUTE = 60 * 1000;
  const DAY = 24 * HOUR;

  /** A fixed clock so screenshots are reproducible run to run. */
  const BASE = new Date();
  BASE.setHours(9, 12, 0, 0);

  function at(offsetMs) { return new Date(BASE.getTime() + offsetMs).toISOString(); }
  function seconds(value) { return value * 1000; }
  function isoDay(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  /** Build one prompt record in the shape asm/goals.py produces. */
  function request(index, spec) {
    const start = spec.start;
    const end = start + spec.ms;
    // Interleave the work rather than emitting it in blocks: a real prompt
    // reads, edits, runs something, reads again — and the step strip is only
    // honest if the fixture looks like that too.
    const remaining = spec.work.map(([category, count, name]) => ({ category, count, name }));
    const steps = [];
    const byCategory = {};
    let cursor = start + seconds(4);
    const totalSteps = remaining.reduce((sum, entry) => sum + entry.count, 0);
    const tick = totalSteps ? Math.max(seconds(1), (spec.ms * 0.85) / totalSteps) : 0;
    while (remaining.some((entry) => entry.count > 0)) {
      for (const entry of remaining) {
        if (entry.count <= 0) continue;
        entry.count -= 1;
        byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
        const step = { t: at(cursor), c: entry.category, n: entry.name };
        if (spec.failAt && spec.failAt.includes(steps.length)) step.e = true;
        steps.push(step);
        cursor += tick;
      }
    }
    const tools = Object.values(byCategory).reduce((sum, count) => sum + count, 0);
    const errors = (spec.failAt || []).length;
    // Each call occupies a slice of the request; shells take the longest.
    const weight = { exec: 4, agent: 6, web: 3, read: 1, search: 1, edit: 1, plan: 1, ask: 8, mcp: 2, other: 1 };
    const catMs = {};
    let weighted = 0;
    Object.entries(byCategory).forEach(([category, count]) => {
      weighted += count * (weight[category] || 1);
    });
    Object.entries(byCategory).forEach(([category, count]) => {
      catMs[category] = Math.round((count * (weight[category] || 1) / (weighted || 1)) * spec.ms * 0.62);
    });
    return {
      i: index,
      kind: spec.kind || "prompt",
      prompt: spec.prompt,
      start: at(start),
      end: at(end),
      first_response: at(start + (spec.latency || seconds(3))),
      ms: spec.ms,
      latency_ms: spec.latency || seconds(3),
      turns: spec.turns,
      tools,
      by_cat: byCategory,
      cat_ms: catMs,
      tool_ms: Object.values(catMs).reduce((sum, value) => sum + value, 0),
      steps,
      dropped_steps: 0,
      errors,
      error_names: errors ? { Bash: errors } : {},
      subagents: byCategory.agent || 0,
      asked: !!byCategory.ask,
      compactions: spec.compactions || 0,
      files: spec.files || [],
      commands: spec.commands || [],
      tokens: spec.tokens,
      output_tokens: Math.round(spec.tokens * 0.06),
      cost: spec.cost,
      models: ["claude-opus-5"],
      thinking_chars: spec.thinking || 0,
      text_chars: spec.text || 0,
      outcome: spec.outcome,
    };
  }

  const REQUEST_SPECS = [
    { prompt: "Read the payment webhook handler and tell me why retries duplicate charges.",
      start: 0, ms: 4 * MINUTE + seconds(20), latency: seconds(2), turns: 6, tokens: 148000, cost: 0.94,
      work: [["read", 7, "Read"], ["search", 4, "Grep"]], files: ["api/payments/webhook.py", "api/payments/retry.py"],
      thinking: 4200, text: 3100, outcome: "done" },
    { prompt: "Make the handler idempotent — key on the provider event id, and add the migration.",
      start: 5 * MINUTE, ms: 18 * MINUTE, latency: seconds(4), turns: 21, tokens: 612000, cost: 4.18,
      work: [["read", 6, "Read"], ["edit", 9, "Edit"], ["exec", 7, "Bash"], ["plan", 2, "TodoWrite"]],
      failAt: [16, 19], files: ["api/payments/webhook.py", "migrations/0042_event_key.py"],
      commands: ["alembic", "pytest", "ruff"], thinking: 18400, text: 9200, outcome: "recovered" },
    { prompt: "/compact", kind: "command",
      start: 24 * MINUTE, ms: seconds(38), latency: seconds(6), turns: 1, tokens: 24000, cost: 0.11,
      work: [], compactions: 1, outcome: "done" },
    { prompt: "Now the same for the refund path. Use a subagent to audit every caller first.",
      start: 26 * MINUTE, ms: 26 * MINUTE, latency: seconds(3), turns: 28, tokens: 940000, cost: 6.72,
      work: [["agent", 2, "Agent"], ["read", 5, "Read"], ["search", 6, "Grep"], ["edit", 7, "Edit"], ["exec", 9, "Bash"]],
      files: ["api/payments/refund.py", "api/payments/webhook.py"], commands: ["pytest", "git", "rg"],
      thinking: 26100, text: 14300, outcome: "done" },
    { prompt: "Should the refund key include the original charge id, or just the refund event id?",
      start: 54 * MINUTE, ms: 3 * MINUTE + seconds(10), latency: seconds(5), turns: 4, tokens: 96000, cost: 0.61,
      work: [["read", 2, "Read"], ["ask", 1, "AskUserQuestion"]], thinking: 5600, text: 2100, outcome: "question" },
    { prompt: "Run the full suite and the load test, then write up what changed.",
      start: 4 * HOUR + 12 * MINUTE, ms: 21 * MINUTE, latency: seconds(2), turns: 17, tokens: 488000, cost: 3.31,
      work: [["exec", 14, "Bash"], ["read", 3, "Read"], ["edit", 4, "Write"], ["web", 1, "WebFetch"], ["plan", 1, "Skill"]],
      failAt: [2, 5, 7, 9], commands: ["pytest", "k6", "docker"], files: ["docs/idempotency.md"],
      thinking: 12800, text: 18600, outcome: "error" },
    { prompt: "Fix the flaky load-test threshold and re-run just that one.",
      start: 4 * HOUR + 36 * MINUTE, ms: 7 * MINUTE + seconds(45), latency: seconds(3), turns: 9, tokens: 214000, cost: 1.44,
      work: [["read", 2, "Read"], ["edit", 3, "Edit"], ["exec", 5, "Bash"]],
      commands: ["k6", "git"], files: ["load/checkout.js"], thinking: 6100, text: 4400, outcome: "done" },
  ];

  const REQUESTS = REQUEST_SPECS.map((spec, index) => request(index, spec));
  const totalTools = REQUESTS.reduce((sum, entry) => sum + entry.tools, 0);
  const byCategory = {};
  const categoryTime = {};
  REQUESTS.forEach((entry) => {
    Object.entries(entry.by_cat).forEach(([category, count]) => {
      byCategory[category] = (byCategory[category] || 0) + count;
    });
    Object.entries(entry.cat_ms).forEach(([category, value]) => {
      categoryTime[category] = (categoryTime[category] || 0) + value;
    });
  });

  /** Roll a set of requests up into the /goal run that contained them. */
  function goalRun(index, spec) {
    const inside = spec.requests.map((i) => REQUESTS[i]);
    const by = {};
    const times = {};
    inside.forEach((entry) => {
      Object.entries(entry.by_cat).forEach(([category, count]) => {
        by[category] = (by[category] || 0) + count;
      });
      Object.entries(entry.cat_ms).forEach(([category, value]) => {
        times[category] = (times[category] || 0) + value;
      });
    });
    const blocked = spec.checks.filter((check) => !check.met);
    return {
      i: index,
      condition: spec.condition,
      start: at(spec.start),
      end: spec.end == null ? "" : at(spec.end),
      ms: (spec.end == null ? 5 * HOUR : spec.end) - spec.start,
      open: spec.end == null,
      met: !!spec.met,
      superseded: !!spec.superseded,
      status: spec.met ? "met" : spec.superseded ? "superseded" : spec.end == null ? "open" : "ended",
      checks: spec.checks.map((check) => ({ t: at(check.t), met: check.met, reason: check.reason })),
      dropped_checks: 0,
      blocked_stops: blocked.length,
      last_reason: blocked.length ? blocked[blocked.length - 1].reason : "",
      follow_ups: inside.filter((entry) => entry.kind === "prompt").length,
      commands: inside.filter((entry) => entry.kind === "command").length,
      request_ids: inside.map((entry) => entry.i),
      turns: inside.reduce((sum, entry) => sum + entry.turns, 0),
      tools: inside.reduce((sum, entry) => sum + entry.tools, 0),
      by_cat: by,
      cat_ms: times,
      tool_ms: Object.values(times).reduce((sum, value) => sum + value, 0),
      errors: inside.reduce((sum, entry) => sum + entry.errors, 0),
      asked: inside.filter((entry) => entry.asked).length,
      subagents: inside.reduce((sum, entry) => sum + entry.subagents, 0),
      compactions: inside.reduce((sum, entry) => sum + entry.compactions, 0),
      tokens: inside.reduce((sum, entry) => sum + entry.tokens, 0),
      cost: Number(inside.reduce((sum, entry) => sum + entry.cost, 0).toFixed(2)),
      files: [...new Set(inside.flatMap((entry) => entry.files))],
    };
  }

  const GOAL_RUNS = [
    goalRun(0, {
      condition: "make the webhook idempotent and prove it with the tests",
      start: 4 * MINUTE, end: 25 * MINUTE, superseded: true,
      requests: [1, 2], checks: [],
    }),
    goalRun(1, {
      condition: "keep going until refunds are idempotent too, the full suite is green, and it is written up",
      start: 25 * MINUTE, end: 4 * HOUR + 44 * MINUTE, met: true,
      requests: [3, 4, 5, 6],
      checks: [
        { t: 55 * MINUTE, met: false, reason: "Refunds are guarded but the load test has not been run since the change." },
        { t: 4 * HOUR + 33 * MINUTE, met: false, reason: "The load test failed its p95 threshold; the write-up is still missing." },
        { t: 4 * HOUR + 44 * MINUTE, met: true, reason: "Both paths key on the provider event id, the full suite and the load test pass, and docs/idempotency.md describes the change." },
      ],
    }),
  ];

  const PROJECTS = [
    { provider: "claude", id: "windows::checkout-service", name: "checkout-service",
      path: "~/code/checkout-service", session_count: 24, active_count: 1, total_cost: 128.4,
      total_tokens: 18_400_000, active_ms: 31 * HOUR, tool_errors: 84, last_activity: Date.now() / 1000 - 120, memory_count: 6, exists: true },
    { provider: "claude", id: "windows::design-system", name: "design-system",
      path: "~/code/design-system", session_count: 11, active_count: 0, total_cost: 42.15,
      total_tokens: 6_100_000, active_ms: 9 * HOUR, tool_errors: 12, last_activity: Date.now() / 1000 - 5 * 3600, memory_count: 3, exists: true },
    { provider: "codex", id: "windows::infra-terraform", name: "infra-terraform",
      path: "~/code/infra-terraform", session_count: 9, active_count: 0, total_cost: 0,
      total_tokens: 3_900_000, active_ms: 6 * HOUR, tool_errors: 5, last_activity: Date.now() / 1000 - 26 * 3600, memory_count: 0, exists: true },
    { provider: "claude", id: "windows::docs-site", name: "docs-site",
      path: "~/code/docs-site", session_count: 7, active_count: 0, total_cost: 18.9,
      total_tokens: 2_300_000, active_ms: 4 * HOUR, tool_errors: 3, last_activity: Date.now() / 1000 - 3 * 86400, memory_count: 1, exists: true },
  ];

  const SESSION_TITLES = [
    // project, title, seconds ago, turns, tools, cost, context %, active hours, errors, skills, agents
    ["checkout-service", "Make the payment webhook idempotent", 1, 96, 141, 17.31, 46, 3.2, 6, { unslop: 1 }, { Explore: 2 }],
    ["checkout-service", "Refund path audit and rollout plan", 3600, 74, 108, 12.04, 61, 2.4, 3, {}, { "general-purpose": 3 }],
    ["design-system", "Token contrast pass for the light theme", 5 * 3600, 41, 63, 6.88, 28, 1.1, 0, { "artifact-design": 1 }, {}],
    ["checkout-service", "Trace the duplicate-charge report from support", 9 * 3600, 58, 92, 9.42, 71, 1.9, 9, {}, { Explore: 1 }],
    ["infra-terraform", "Split the staging state file", 26 * 3600, 33, 51, 0, 39, 0.9, 2, {}, { spawn_agent: 2 }],
    ["design-system", "Replace the ad-hoc spacing scale", 30 * 3600, 22, 30, 3.11, 18, 0.6, 0, { "artifact-design": 2 }, {}],
    ["docs-site", "Rewrite the getting-started page", 3 * 86400, 19, 24, 2.40, 12, 0.5, 0, { unslop: 2 }, {}],
    ["checkout-service", "Backfill the event-key column safely", 4 * 86400, 64, 97, 11.72, 55, 2.1, 4, {}, { "general-purpose": 1 }],
    ["infra-terraform", "Pin provider versions and re-plan", 6 * 86400, 15, 26, 0, 22, 0.4, 1, {}, {}],
    ["docs-site", "Search index rebuild on deploy", 8 * 86400, 12, 17, 1.60, 9, 0.3, 0, { "code-review": 1 }, {}],
  ];

  const RECENT = SESSION_TITLES.map(([project, title, ago, turns, tools, cost, context, hours, errors, skills, agents], index) => {
    const entry = PROJECTS.find((item) => item.name === project);
    const when = new Date(Date.now() - ago * 1000);
    const day = isoDay(when);
    const daily = { [day]: { c: cost, t: turns * 26000, n: turns, p: Math.round(turns / 4), e: errors, a: Math.round(hours * HOUR), m: cost ? { "claude-opus-5": cost } : {} } };
    return {
      provider: entry.provider,
      source_id: "windows",
      source_label: "Windows",
      source_writable: true,
      project_id: entry.id,
      project_name: project,
      project_path: entry.path,
      session_id: `preview-session-${index + 1}`,
      title,
      first_prompt: title,
      cost,
      tokens: turns * 26000,
      usage: { total: turns * 26000, input: turns * 2000, output: turns * 1500, cache_read: turns * 21000, cache_write: turns * 1500 },
      usage_by_model: entry.provider === "codex" ? { "gpt-5.6-sol": { total: turns * 26000 } } : { "claude-opus-5": { total: turns * 26000, cost } },
      user_messages: Math.round(turns / 4),
      assistant_messages: turns,
      tool_calls: tools,
      tool_errors: errors,
      compactions: index === 0 ? 1 : 0,
      interrupts: index % 4 === 1 ? 1 : 0,
      kills: index === 3 ? 2 : 0,
      active_ms: Math.round(hours * HOUR),
      skills,
      agents,
      daily,
      size_bytes: 1_200_000 + index * 340_000,
      extra_bytes: 180_000,
      asset_bytes: { total: 180_000, images: 40_000 },
      mtime: Date.now() / 1000 - ago,
      updated: when.toISOString(),
      created: new Date(Date.now() - (ago + hours * 3600) * 1000).toISOString(),
      active: ago < 120,
      protected: ago < 600,
      has_subagents: Object.keys(agents).length > 0,
      context_pct: context,
      models: entry.provider === "codex" ? ["gpt-5.6-sol"] : ["claude-opus-5"],
    };
  });

  /* ---------- the open session ---------- */

  const TRACE_EVENTS = [
    { t: BASE.getTime() + 24 * MINUTE, k: "command", n: "/compact" },
    { t: BASE.getTime() + 24 * MINUTE + seconds(30), k: "compaction", n: "compacted", d: "612000 -> 214000 tokens" },
    { t: BASE.getTime() + 27 * MINUTE, k: "agent", n: "Explore", d: "Audit every caller of the refund path", ms: 4 * MINUTE + seconds(12), id: "a1" },
    { t: BASE.getTime() + 34 * MINUTE, k: "agent", n: "Explore", d: "Check the migration against the staging schema snapshot", ms: 2 * MINUTE + seconds(48), id: "a2" },
    { t: BASE.getTime() + 4 * HOUR + 14 * MINUTE, k: "skill", n: "unslop", d: "", ms: seconds(3), id: "s1" },
    { t: BASE.getTime() + 4 * HOUR + 22 * MINUTE, k: "kill", n: "TaskStop", d: "b53y0wkqp", ms: seconds(1), id: "k1" },
    { t: BASE.getTime() + 4 * HOUR + 31 * MINUTE, k: "interrupt", n: "interrupted" },
  ];

  const DETAIL = {
    provider: "claude",
    session_id: "preview-session-1",
    project_id: "windows::checkout-service",
    path: "~/.claude/projects/checkout-service/preview-session-1.jsonl",
    total_events: 412,
    events_start: 400,
    cost: 17.31,
    cache_savings: 19.62,
    usage: { input: 214_000, output: 148_000, cache_read: 2_180_000, cache_write: 156_000, total: 2_698_000 },
    usage_by_model: {
      "claude-opus-5": { input: 214_000, output: 148_000, cache_read: 2_180_000, cache_write: 156_000, total: 2_698_000, cost: 17.31 },
    },
    context_window: 1_000_000,
    last_context_tokens: 460_000,
    peak_context_tokens: 612_000,
    context_pct: 46,
    tool_counts: { Bash: 35, Read: 25, Edit: 23, Grep: 10, Agent: 2, TodoWrite: 2, WebFetch: 1, AskUserQuestion: 1, Skill: 1, TaskStop: 1 },
    timeline: Array.from({ length: 42 }, (_, index) => ({
      t: at(index < 22 ? index * 2 * MINUTE : 4 * HOUR + 12 * MINUTE + (index - 22) * 2 * MINUTE),
      // A compaction at step 22 — the drop the chart is there to show.
      ctx: index < 22 ? 40_000 + index * 26_000 : 214_000 + (index - 22) * 12_300,
      cost: Number((index * 0.42).toFixed(2)),
    })),
    requests: {
      requests: REQUESTS,
      dropped: 0,
      count: REQUESTS.length,
      by_cat: byCategory,
      cat_ms: categoryTime,
      tool_ms: Object.values(categoryTime).reduce((sum, value) => sum + value, 0),
      total_ms: REQUESTS.reduce((sum, entry) => sum + entry.ms, 0),
      median_ms: 7 * MINUTE + seconds(45),
      questions: REQUESTS.filter((entry) => entry.asked).length,
      failed: REQUESTS.filter((entry) => entry.outcome === "error").length,
      priced: true,
      categories: ASM.ui ? ASM.ui.CATEGORIES : [],
    },
    goals: {
      goals: GOAL_RUNS,
      dropped: 0,
      count: GOAL_RUNS.length,
      open: GOAL_RUNS.filter((run) => run.open).length,
      met: GOAL_RUNS.filter((run) => run.met).length,
      superseded: GOAL_RUNS.filter((run) => run.superseded).length,
      total_ms: GOAL_RUNS.reduce((sum, run) => sum + run.ms, 0),
      median_ms: GOAL_RUNS.length ? GOAL_RUNS[0].ms : 0,
      blocked_stops: GOAL_RUNS.reduce((sum, run) => sum + run.blocked_stops, 0),
      follow_ups: GOAL_RUNS.reduce((sum, run) => sum + run.follow_ups, 0),
    },
    analytics: {
      user_prompts: REQUESTS.length,
      assistant_turns: 86,
      tool_calls: totalTools,
      tool_error_total: 6,
      tool_errors: { Bash: 5, Edit: 1 },
      files_touched: {
        "api/payments/webhook.py": 14, "api/payments/refund.py": 9,
        "migrations/0042_event_key.py": 5, "load/checkout.js": 4, "docs/idempotency.md": 3,
      },
      file_reads: { "api/payments/webhook.py": 9, "api/payments/refund.py": 5, "migrations/0042_event_key.py": 2, "load/checkout.js": 2 },
      file_edits: { "api/payments/webhook.py": 5, "api/payments/refund.py": 4, "migrations/0042_event_key.py": 3, "load/checkout.js": 2, "docs/idempotency.md": 3 },
      bash_commands: { pytest: 18, git: 9, alembic: 5, k6: 4, ruff: 3, docker: 2 },
      command_repeats: { "pytest -q tests/payments": 11, "k6 run load/checkout.js": 4 },
      thinking_chars: 73_200,
      text_chars: 51_700,
      output_per_turn: Array.from({ length: 42 }, (_, index) => 900 + Math.round(2600 * Math.abs(Math.sin(index / 3)))),
      hourly: Array.from({ length: 24 }, (_, hour) => (hour > 8 && hour < 15 ? 2 + ((hour * 5) % 9) : 0)),
      daily: [],
      compactions: 1,
      compaction_marks: [{ t: at(24 * MINUTE + seconds(30)), from: 612_000, to: 214_000 }],
      first_ts: at(0),
      last_ts: at(4 * HOUR + 44 * MINUTE),
      active_ms: 1 * HOUR + 32 * MINUTE,
      idle: [[BASE.getTime() + 58 * MINUTE, BASE.getTime() + 4 * HOUR + 12 * MINUTE]],
    },
    subagents: {
      count: 2,
      agent_calls: [
        { name: "Agent", kind: "Explore", desc: "Audit every caller of the refund path and report unguarded retries", ts: at(27 * MINUTE) },
        { name: "Agent", kind: "Explore", desc: "Check the migration against the staging schema snapshot", ts: at(34 * MINUTE) },
      ],
      events: [],
    },
    trace: {
      events: TRACE_EVENTS,
      skills: { unslop: 1 },
      agents: { Explore: 2 },
      commands: { "/compact": 1 },
      kills: 1,
      interrupts: 1,
    },
    tasks: [
      { subject: "Key the webhook on the provider event id", status: "completed" },
      { subject: "Add the migration and backfill", status: "completed" },
      { subject: "Apply the same guard to refunds", status: "completed" },
      { subject: "Stabilise the load-test threshold", status: "in_progress" },
      { subject: "Write up the change for the runbook", status: "pending" },
    ],
    scratchpad: { exists: false, files: [] },
    images: [],
    file_history: { count: 18, bytes: 940_000, dir: "~/.claude/file-history/preview-session-1" },
  };

  DETAIL.events = [
    { role: "user", ts: at(4 * HOUR + 36 * MINUTE), blocks: [
      { type: "text", text: "Fix the flaky load-test threshold and re-run just that one." }] },
    { role: "assistant", ts: at(4 * HOUR + 36 * MINUTE + seconds(3)), model: "claude-opus-5", blocks: [
      { type: "thinking", text: "The p95 assertion is 180ms against a warm cache. The first iteration runs cold, so the threshold is measuring warm-up, not the change." },
      { type: "text", text: "The threshold is being applied to the cold first iteration. I'll add a warm-up stage and assert on the steady-state window only." }] },
    { role: "assistant", ts: at(4 * HOUR + 37 * MINUTE), model: "claude-opus-5", blocks: [
      { type: "tool_use", id: "t1", name: "Read", input_preview: '{"file_path": "load/checkout.js"}' }] },
    { role: "user", ts: at(4 * HOUR + 37 * MINUTE + seconds(1)), blocks: [
      { type: "tool_result", tool_use_id: "t1", content_preview: "export const options = { stages: [...], thresholds: { http_req_duration: ['p(95)<180'] } }" }] },
    { role: "assistant", ts: at(4 * HOUR + 38 * MINUTE), model: "claude-opus-5", blocks: [
      { type: "tool_use", id: "t2", name: "Edit", input_preview: '{"file_path": "load/checkout.js", "old_string": "stages: [{ duration: \'2m\' ...", "new_string": "stages: [{ duration: \'30s\', target: 5 }, ..."}' }] },
    { role: "user", ts: at(4 * HOUR + 38 * MINUTE + seconds(2)), blocks: [
      { type: "tool_result", tool_use_id: "t2", content_preview: "load/checkout.js updated" }] },
    { role: "assistant", ts: at(4 * HOUR + 39 * MINUTE), model: "claude-opus-5", blocks: [
      { type: "tool_use", id: "t3", name: "Bash", input_preview: '{"command": "k6 run load/checkout.js", "description": "Re-run the load test"}' }] },
    { role: "user", ts: at(4 * HOUR + 43 * MINUTE), blocks: [
      { type: "tool_result", tool_use_id: "t3", content_preview: "checks.........................: 100.00%\nhttp_req_duration..............: p(95)=142.3ms\n✓ threshold met" }] },
    { role: "assistant", ts: at(4 * HOUR + 44 * MINUTE), model: "claude-opus-5", blocks: [
      { type: "text", text: "Green. p95 is 142ms against the steady-state window; the earlier failures were the cold first iteration being measured. The warm-up stage is 30s at 5 VUs, which is enough for the connection pool to fill." }] },
  ];

  /* ---------- machine-wide figures ---------- */

  const MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"];
  const DAILY = Array.from({ length: 90 }, (_, index) => {
    const date = new Date(Date.now() - (89 - index) * DAY);
    const weekday = date.getDay();
    const weekend = weekday === 0 || weekday === 6;
    const recent = index > 62;
    const pulse = weekend ? (index % 5 === 0 ? 0.3 : 0) : (recent ? 0.8 + ((index * 7) % 5) / 5 : (index % 3 === 0 ? 0.5 : 0.15));
    const cost = Number((pulse * 9.4).toFixed(2));
    const models = cost ? { "claude-opus-5": Number((cost * 0.72).toFixed(2)), "claude-sonnet-5": Number((cost * 0.24).toFixed(2)), "claude-haiku-4-5": Number((cost * 0.04).toFixed(2)) } : {};
    return {
      d: isoDay(date), cost, tokens: Math.round(pulse * 1_400_000), turns: Math.round(pulse * 70),
      prompts: Math.round(pulse * 18), errors: Math.round(pulse * 3 * ((index % 4) === 0 ? 2 : 1)),
      active_ms: Math.round(pulse * 2.6 * HOUR), sessions: pulse ? 1 + (index % 3) : 0, models,
    };
  });
  const PROJECT_DAILY = {};
  PROJECTS.filter((project) => project.provider === "claude").forEach((project, index) => {
    const share = [0.62, 0.24, 0.14][index] || 0.1;
    PROJECT_DAILY[project.id] = Object.fromEntries(DAILY.filter((day) => day.cost).map((day) => [day.d, Number((day.cost * share).toFixed(2))]));
  });

  const GLOBAL = {
    cost: 189.45,
    cache_savings: 214.6,
    sessions: 51,
    active: 1,
    prompts: 1_284,
    turns: 4_916,
    tool_calls: 8_742,
    tool_errors: 104,
    compactions: 27,
    active_ms: 50 * HOUR,
    subagent_sessions: 14,
    kills: 26,
    interrupts: 42,
    first_activity: new Date(Date.now() - 88 * DAY).toISOString(),
    usage: { input: 2_140_000, output: 1_486_000, cache_read: 24_800_000, cache_write: 2_270_000, total: 30_696_000 },
    by_model: {
      "claude-opus-5": { total: 19_400_000, output: 1_010_000, cache_read: 15_600_000, cost: 148.2 },
      "claude-sonnet-5": { total: 8_100_000, output: 372_000, cache_read: 6_900_000, cost: 41.25 },
      "claude-haiku-4-5": { total: 3_196_000, output: 104_000, cache_read: 2_300_000, cost: 0 },
    },
    tool_counts: {
      Read: 2_140, Edit: 1_486, Bash: 1_402, Grep: 968, Write: 604, Glob: 512,
      TodoWrite: 388, Agent: 214, WebFetch: 142, AskUserQuestion: 61, Skill: 13, TaskStop: 26,
    },
    sessions_by_day: DAILY.map((day) => [day.d, day.sessions]),
    daily: DAILY,
    project_daily: PROJECT_DAILY,
    by_project: PROJECTS.map((project) => ({
      id: project.id, name: project.name, path: project.path, provider: project.provider, sessions: project.session_count,
      cost: project.total_cost, tokens: project.total_tokens, turns: project.session_count * 41, active_ms: project.active_ms,
      errors: project.tool_errors, last_activity: project.last_activity, compactions: 3, skills: 4, agents: 12, kills: 5, interrupts: 9,
    })),
    activity: Array.from({ length: 7 }, (_, day) => Array.from({ length: 24 }, (_, hour) => {
      if (day > 4) return hour > 13 && hour < 19 ? (hour + day) % 3 : 0;
      if (hour < 8 || hour > 22) return 0;
      return 1 + ((hour * 3 + day * 5) % 6);
    })),
    skills: {
      unslop: { count: 9, sessions: 7, projects: 3, last: Date.now() / 1000 - 3600 },
      "artifact-design": { count: 5, sessions: 4, projects: 2, last: Date.now() / 1000 - 5 * 3600 },
      "code-review": { count: 3, sessions: 3, projects: 2, last: Date.now() / 1000 - 8 * 86400 },
      "company-kb:company-kb": { count: 2, sessions: 2, projects: 2, last: Date.now() / 1000 - 12 * 86400 },
    },
    agents: {
      Explore: { count: 25, sessions: 6, projects: 4, last: Date.now() / 1000 - 120 },
      "general-purpose": { count: 85, sessions: 9, projects: 6, last: Date.now() / 1000 - 3600 },
      spawn_agent: { count: 37, sessions: 8, projects: 6, last: Date.now() / 1000 - 26 * 3600 },
      "kb-researcher": { count: 2, sessions: 2, projects: 2, last: Date.now() / 1000 - 20 * 86400 },
    },
    commands: {
      "/compact": { count: 8, sessions: 6, projects: 4, last: Date.now() / 1000 - 1500 },
      "/model": { count: 5, sessions: 5, projects: 3, last: Date.now() / 1000 - 2 * 86400 },
      "/goal": { count: 2, sessions: 1, projects: 1, last: Date.now() / 1000 - 1500 },
    },
  };

  /* ---------- the machine-wide trace log ---------- */

  const TRACE = RECENT.flatMap((session, index) => {
    const base = session.mtime * 1000 - 40 * MINUTE;
    const rows = [];
    Object.entries(session.skills).forEach(([name, count], offset) => {
      for (let i = 0; i < count; i += 1) rows.push({ t: base + (offset + i) * 6 * MINUTE, k: "skill", n: name, d: "", ms: seconds(2 + i) });
    });
    Object.entries(session.agents).forEach(([name, count], offset) => {
      for (let i = 0; i < count; i += 1) rows.push({ t: base + 8 * MINUTE + (offset + i) * 5 * MINUTE, k: "agent", n: name, d: ["Audit every caller of the refund path", "Check the migration against staging", "Find every use of the old token"][i % 3], ms: (2 + i) * MINUTE });
    });
    for (let i = 0; i < session.kills; i += 1) rows.push({ t: base + 20 * MINUTE + i * MINUTE, k: "kill", n: "TaskStop", d: `b53y0wkq${i}` });
    for (let i = 0; i < session.interrupts; i += 1) rows.push({ t: base + 30 * MINUTE, k: "interrupt", n: "interrupted" });
    if (index % 3 === 0) rows.push({ t: base + 25 * MINUTE, k: "command", n: "/compact" });
    return rows.map((row) => ({
      ...row, session_id: session.session_id, project_id: session.project_id, project_name: session.project_name,
      title: session.title, provider: session.provider, source_id: "windows",
    }));
  }).sort((a, b) => b.t - a.t);

  ASM.preview = { PROJECTS, RECENT, DETAIL, GLOBAL, TRACE, GOALS: REQUESTS };
})(window.ASM = window.ASM || {});
