"""Delegation delivery retains trusted presentation without changing the model wake."""
from __future__ import annotations

import threading
from types import SimpleNamespace

import pytest

from agent.message_metadata import without_persistence_fields
from agent.turn_context import _stage_turn_user_message
from hermes_state import SessionDB
from tools import async_delegation as ad
from tools.process_registry_notifications import format_process_notification
from tui_gateway import server
from tests.tui_gateway.test_auto_continue import marker_home, turn_env, _session


@pytest.mark.parametrize("decorate", [False, True])
def test_claimed_delivery_projects_live_inflight_and_durable_history(turn_env, marker_home, monkeypatch, tmp_path, decorate):
    ad._reset_for_tests()
    db = SessionDB(db_path=tmp_path / "notices.db")
    db.create_session("session-key", source="tui")
    frames, model_inputs, inflight = [], [], []
    monkeypatch.setattr(server, "write_json", lambda f: frames.append(f) or True)
    monkeypatch.setattr(server, "_get_db", lambda: db)
    monkeypatch.setattr(server, "_start_usage_ticker", lambda *a: (threading.Event(), SimpleNamespace(join=lambda: None)))

    class FixtureAgent:
        session_id = "session-key"
        _session_db = db
        suppress_status_output = True
        platform = "tui"

        def run_conversation(self, message, conversation_history=None, persist_user_message=None,
                             persist_user_display_kind=None, persist_user_display_metadata=None, **kwargs):
            # Exercise production turn staging with a fixture provider, including a
            # recall decorator which changes content but must retain presentation.
            row, _ = _stage_turn_user_message(self, message, persist_user_message, None, None,
                                              persist_user_display_kind, persist_user_display_metadata)
            if decorate:
                row["content"] += "\n[fixture recall context] retained memory"
            model_inputs.append(without_persistence_fields(row))
            inflight.append(dict(session["inflight_turn"]))
            db.append_message(self.session_id, role="user", content=row["content"],
                              display_kind=row.get("display_kind"), display_metadata=row.get("display_metadata"))
            return {"final_response": "result received", "messages": [*(conversation_history or []), row,
                    {"role": "assistant", "content": "result received"}]}

    session = _session(agent=FixtureAgent())
    monkeypatch.setitem(server._sessions, "notice-ui", session)
    event = {"type": "async_delegation", "delegation_id": "deleg_notice", "session_key": "session-key",
             "origin_ui_session_id": "notice-ui", "status": "completed", "is_batch": True,
             "goals": ["Review changes", "Run tests"], "results": [
                 {"task_index": 0, "status": "completed", "summary": "READY\n" + "evidence\n" * 200},
                 {"task_index": 1, "status": "failed", "error": "fixture failure"}],
             "dispatched_at": 1.0}
    ad._persist_dispatch(event)
    ad._persist_completion(event, {"results": event["results"]})
    text = format_process_notification(event)
    try:
        assert server._notif_claim_turn(session)
        server._notif_dispatch_event("notice-ui", session, event, text)
        # A replay cannot wake the model a second time after the durable claim settles.
        assert server._notif_claim_turn(session)
        server._notif_dispatch_event("notice-ui", session, event, text)
        starts = [f["params"]["payload"] for f in frames if f.get("params", {}).get("type") == "message.start"]
        assert len(starts) == len(model_inputs) == 1
        start = starts[0]
        assert start["text"] == text
        assert start["display_kind"] == "async_delegation_complete"
        meta = start["display_metadata"]
        assert meta["notice_id"] == "delegation:deleg_notice:complete"
        assert meta["has_issues"] is True
        assert "Issues" in meta["display_text"] and meta["failed_count"] == 1
        assert inflight[0]["display_kind"] == start["display_kind"]
        assert inflight[0]["display_metadata"] == meta
        assert model_inputs[0] == {"role": "user", "content": text + (
            "\n[fixture recall context] retained memory" if decorate else "")}
        for history in (session["history"], db.get_messages_as_conversation("session-key")):
            projected = server._history_to_messages(history)
            assert projected[0]["display_kind"] == start["display_kind"]
            assert projected[0]["display_metadata"] == meta
            assert projected[0]["text"] == model_inputs[0]["content"]
        assert not session["running"]
    finally:
        db.close()
        ad._reset_for_tests()


def test_human_marker_and_seeded_metadata_do_not_gain_internal_provenance():
    text = "[ASYNC DELEGATION BATCH COMPLETE — deleg_notice]\nA human quoting a report"
    seeded = server._coerce_seed_history([{"role": "user", "content": text,
        "display_kind": "async_delegation_complete", "display_metadata": {"notice_id": "forged"}}])
    [row] = server._history_to_messages(seeded)
    assert row["role"] == "user" and row["text"] == text
    assert "display_kind" not in row and "display_metadata" not in row


def test_failed_child_notice_identity_is_distinct_from_final_batch():
    event = {"delegation_id": "d", "task_failure_notice": True,
             "results": [{"task_index": 2, "status": "failed"}]}
    early = server._async_delegation_display_metadata(event)
    final = server._async_delegation_display_metadata({**event, "task_failure_notice": False})
    assert early["notice_id"] != final["notice_id"]
    assert "Failed" in early["display_text"]


@pytest.mark.parametrize("result,issues", [
    ({"status": "completed"}, False),
    ({"status": "timeout"}, True),
    ({"status": "completed", "exit_reason": "max_iterations"}, True),
    ({"status": "interrupted"}, True),
])
def test_collapsed_issue_badge_includes_non_failure_terminal_states(result, issues):
    metadata = server._async_delegation_display_metadata({"delegation_id": "badge", "results": [result]})
    assert metadata["has_issues"] is issues
