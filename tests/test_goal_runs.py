"""Claude Code's `/goal`, reconstructed from the transcript.

A goal is a session-scoped Stop hook: it blocks the agent from finishing until
its condition holds. The transcript records that as `goal_status` attachments —
one when it is set, one every time the hook refuses a stop, and one when the
condition is finally met. These tests pin that reconstruction, and the time
accounting that hangs off it.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from asm import codex_session_parser, session_parser


def write_jsonl(path: Path, records: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(record) for record in records) + "\n", encoding="utf-8")


def user(text: str, ts: str) -> dict:
    return {"type": "user", "timestamp": ts, "uuid": ts,
            "message": {"role": "user", "content": [{"type": "text", "text": text}]}}


def tool_result(call_id: str, ts: str, *, error: bool = False) -> dict:
    return {"type": "user", "timestamp": ts, "uuid": ts + "-r", "message": {
        "role": "user",
        "content": [{"type": "tool_result", "tool_use_id": call_id, "content": "out", "is_error": error}],
    }}


def assistant(ts: str, blocks: list[dict], *, message_id: str, model: str = "claude-opus-4-8") -> dict:
    return {"type": "assistant", "timestamp": ts, "uuid": ts + "-a", "message": {
        "role": "assistant", "id": message_id, "model": model, "content": blocks,
        "usage": {"input_tokens": 100, "output_tokens": 50,
                  "cache_read_input_tokens": 900, "cache_creation_input_tokens": 0},
    }}


def tool_use(name: str, call_id: str, **inp) -> dict:
    return {"type": "tool_use", "id": call_id, "name": name, "input": inp}


def goal_set(condition: str, ts: str) -> dict:
    """The attachment Claude Code writes when /goal arms the Stop hook."""
    return {"type": "attachment", "timestamp": ts, "attachment": {
        "type": "goal_status", "met": False, "sentinel": True, "condition": condition}}


def goal_status(condition: str, ts: str, *, met: bool, reason: str = "") -> dict:
    """The Stop hook evaluating the condition — either blocking, or releasing."""
    return {"type": "attachment", "timestamp": ts, "attachment": {
        "type": "goal_status", "met": met, "condition": condition, "reason": reason}}


def goal_directive(condition: str, ts: str) -> dict:
    """The isMeta user record the CLI injects alongside the attachment."""
    text = ('A session-scoped Stop hook is now active with condition: "' + condition +
            '". Briefly acknowledge the goal, then immediately start working toward it.')
    record = user(text, ts)
    record["isMeta"] = True
    return record


def build(records: list[dict]) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "session.jsonl"
        write_jsonl(path, records)
        return session_parser.detail(path)


class GoalRunTests(unittest.TestCase):
    def test_a_goal_runs_from_when_it_was_set_until_it_was_met(self) -> None:
        result = build([
            user("start something", "2026-08-01T10:00:00.000Z"),
            goal_set("finish the migration", "2026-08-01T10:01:00.000Z"),
            goal_directive("finish the migration", "2026-08-01T10:01:00.000Z"),
            assistant("2026-08-01T10:02:00.000Z",
                      [tool_use("Bash", "t1", command="alembic upgrade head")], message_id="m1"),
            tool_result("t1", "2026-08-01T10:02:30.000Z"),
            goal_status("finish the migration", "2026-08-01T10:20:00.000Z",
                        met=True, reason="Migration applied and the tests pass."),
        ])["goals"]
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["met"], 1)
        self.assertEqual(result["open"], 0)
        goal = result["goals"][0]
        self.assertEqual(goal["condition"], "finish the migration")
        self.assertEqual(goal["status"], "met")
        self.assertEqual(goal["ms"], 19 * 60 * 1000)
        self.assertIn("Migration applied", goal["last_reason"])

    def test_the_stop_hook_directive_is_not_a_prompt(self) -> None:
        """It *is* the goal, and it is tracked as one. Nobody typed it."""
        detail = build([
            goal_set("keep going", "2026-08-01T10:00:00.000Z"),
            goal_directive("keep going", "2026-08-01T10:00:00.000Z"),
            user("a real prompt", "2026-08-01T10:01:00.000Z"),
        ])
        prompts = [item["prompt"] for item in detail["requests"]["requests"]]
        self.assertEqual(prompts, ["a real prompt"])

    def test_blocked_stops_are_kept_with_their_reasoning(self) -> None:
        result = build([
            goal_set("do it all", "2026-08-01T10:00:00.000Z"),
            goal_status("do it all", "2026-08-01T10:05:00.000Z", met=False, reason="Two tasks are still open."),
            goal_status("do it all", "2026-08-01T10:30:00.000Z", met=False, reason="The suite is still red."),
            goal_status("do it all", "2026-08-01T11:00:00.000Z", met=True, reason="Everything is green."),
        ])["goals"]
        goal = result["goals"][0]
        self.assertEqual(goal["blocked_stops"], 2)
        self.assertEqual(result["blocked_stops"], 2)
        self.assertEqual([check["met"] for check in goal["checks"]], [False, False, True])
        self.assertEqual(goal["checks"][1]["reason"], "The suite is still red.")

    def test_setting_a_second_goal_replaces_the_first_without_losing_it(self) -> None:
        result = build([
            goal_set("first condition", "2026-08-01T10:00:00.000Z"),
            goal_set("second condition", "2026-08-01T10:10:00.000Z"),
            goal_status("second condition", "2026-08-01T10:40:00.000Z", met=True, reason="done"),
        ])["goals"]
        self.assertEqual(result["count"], 2)
        first, second = result["goals"]
        self.assertEqual(first["status"], "superseded")
        self.assertEqual(first["ms"], 10 * 60 * 1000)
        self.assertEqual(second["status"], "met")
        self.assertEqual(result["superseded"], 1)

    def test_re_announcing_the_same_goal_does_not_start_another_run(self) -> None:
        result = build([
            goal_set("same condition", "2026-08-01T10:00:00.000Z"),
            goal_set("same condition", "2026-08-01T10:00:02.000Z"),
        ])["goals"]
        self.assertEqual(result["count"], 1)

    def test_a_goal_still_open_is_measured_but_never_reported_as_met(self) -> None:
        result = build([
            goal_set("keep working", "2026-08-01T10:00:00.000Z"),
            assistant("2026-08-01T10:30:00.000Z",
                      [{"type": "text", "text": "still going"}], message_id="m1"),
        ])["goals"]
        goal = result["goals"][0]
        self.assertTrue(goal["open"])
        self.assertFalse(goal["met"])
        self.assertEqual(goal["end"], "")
        self.assertEqual(goal["ms"], 30 * 60 * 1000)
        self.assertEqual(result["open"], 1)

    def test_work_is_attributed_to_the_goal_that_was_actually_running(self) -> None:
        """A prompt spanning a goal change must not take its work with it."""
        detail = build([
            user("kick off", "2026-08-01T10:00:00.000Z"),
            goal_set("goal one", "2026-08-01T10:00:10.000Z"),
            assistant("2026-08-01T10:00:20.000Z", [tool_use("Read", "t1", file_path="/a")], message_id="m1"),
            tool_result("t1", "2026-08-01T10:00:21.000Z"),
            goal_set("goal two", "2026-08-01T10:01:00.000Z"),
            assistant("2026-08-01T10:01:10.000Z", [tool_use("Bash", "t2", command="make")], message_id="m2"),
            tool_result("t2", "2026-08-01T10:01:40.000Z"),
            assistant("2026-08-01T10:02:00.000Z", [tool_use("Bash", "t3", command="make test")], message_id="m3"),
            tool_result("t3", "2026-08-01T10:02:20.000Z"),
        ])
        first, second = detail["goals"]["goals"]
        self.assertEqual(first["by_cat"], {"read": 1})
        self.assertEqual(second["by_cat"], {"exec": 2})
        self.assertEqual(first["tools"], 1)
        self.assertEqual(second["tools"], 2)

    def test_follow_ups_sent_while_a_goal_runs_are_counted_as_such(self) -> None:
        result = build([
            goal_set("keep going", "2026-08-01T10:00:00.000Z"),
            user("also do this", "2026-08-01T10:05:00.000Z"),
            user("and this", "2026-08-01T10:09:00.000Z"),
            goal_status("keep going", "2026-08-01T10:20:00.000Z", met=True, reason="done"),
            user("something after the goal ended", "2026-08-01T10:30:00.000Z"),
        ])["goals"]
        goal = result["goals"][0]
        self.assertEqual(goal["follow_ups"], 2)
        self.assertEqual(result["follow_ups"], 2)
        self.assertEqual(len(goal["request_ids"]), 2)

    def test_a_status_without_a_preceding_set_still_opens_a_run(self) -> None:
        """A resumed session can start in the middle of a goal."""
        result = build([
            goal_status("something already running", "2026-08-01T10:00:00.000Z",
                        met=False, reason="not yet"),
            goal_status("something already running", "2026-08-01T10:20:00.000Z",
                        met=True, reason="now it is"),
        ])["goals"]
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["goals"][0]["status"], "met")

    def test_codex_has_no_goals_and_says_so_rather_than_inventing_them(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rollout.jsonl"
            write_jsonl(path, [
                {"timestamp": "2026-08-01T10:00:00.000Z", "type": "event_msg",
                 "payload": {"type": "user_message", "message": "do a thing"}},
            ])
            result = codex_session_parser.detail(path)["goals"]
        self.assertEqual(result["count"], 0)
        self.assertEqual(result["goals"], [])


class ToolTimeTests(unittest.TestCase):
    """Time per kind of work, measured from the call to its result."""

    def test_a_call_is_timed_from_when_it_was_made_to_when_it_came_back(self) -> None:
        detail = build([
            user("run the tests", "2026-08-01T10:00:00.000Z"),
            assistant("2026-08-01T10:00:02.000Z", [tool_use("Bash", "t1", command="pytest")], message_id="m1"),
            tool_result("t1", "2026-08-01T10:00:32.000Z"),
        ])
        request = detail["requests"]["requests"][0]
        self.assertEqual(request["cat_ms"], {"exec": 30_000})
        self.assertEqual(request["tool_ms"], 30_000)
        self.assertEqual(request["steps"][0]["ms"], 30_000)

    def test_parallel_calls_of_one_kind_are_counted_once(self) -> None:
        """Three greps at the same time are not three grep-minutes."""
        detail = build([
            user("search everywhere", "2026-08-01T10:00:00.000Z"),
            assistant("2026-08-01T10:00:00.000Z", [
                tool_use("Grep", "t1", pattern="a"),
                tool_use("Grep", "t2", pattern="b"),
                tool_use("Grep", "t3", pattern="c"),
            ], message_id="m1"),
            tool_result("t1", "2026-08-01T10:00:10.000Z"),
            tool_result("t2", "2026-08-01T10:00:10.000Z"),
            tool_result("t3", "2026-08-01T10:00:10.000Z"),
        ])
        self.assertEqual(detail["requests"]["requests"][0]["cat_ms"], {"search": 10_000})

    def test_sequential_calls_of_one_kind_add_up(self) -> None:
        detail = build([
            user("run them", "2026-08-01T10:00:00.000Z"),
            assistant("2026-08-01T10:00:00.000Z", [tool_use("Bash", "t1", command="a")], message_id="m1"),
            tool_result("t1", "2026-08-01T10:00:10.000Z"),
            assistant("2026-08-01T10:00:20.000Z", [tool_use("Bash", "t2", command="b")], message_id="m2"),
            tool_result("t2", "2026-08-01T10:00:35.000Z"),
        ])
        self.assertEqual(detail["requests"]["requests"][0]["cat_ms"], {"exec": 25_000})

    def test_a_call_that_never_returned_claims_no_time(self) -> None:
        detail = build([
            user("start it", "2026-08-01T10:00:00.000Z"),
            assistant("2026-08-01T10:00:02.000Z", [tool_use("Bash", "t1", command="sleep")], message_id="m1"),
        ])
        request = detail["requests"]["requests"][0]
        self.assertEqual(request["cat_ms"], {})
        self.assertEqual(request["tools"], 1)

    def test_goal_level_time_matches_the_work_inside_it(self) -> None:
        detail = build([
            goal_set("do it", "2026-08-01T10:00:00.000Z"),
            user("go", "2026-08-01T10:00:01.000Z"),
            assistant("2026-08-01T10:00:02.000Z", [tool_use("Bash", "t1", command="make")], message_id="m1"),
            tool_result("t1", "2026-08-01T10:00:42.000Z"),
            goal_status("do it", "2026-08-01T10:01:00.000Z", met=True, reason="done"),
        ])
        goal = detail["goals"]["goals"][0]
        self.assertEqual(goal["cat_ms"], {"exec": 40_000})
        self.assertEqual(goal["tool_ms"], 40_000)


if __name__ == "__main__":
    unittest.main()
