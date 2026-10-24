"""Android uses the shared per-turn contract, not a new session source or system prompt."""
import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from gateway.session_surface import (
    admit_surface, arm_surface_turn, restore_surface, surface_note, surface_turn_scope,
)
from hermes_state_runtime import RuntimeStoreError


def test_android_admission_roundtrip_and_legacy_validation():
    committed = admit_surface({'surface': 'android'})['surface_v1']
    assert restore_surface(json.loads(json.dumps(committed))) == {'surface': 'android'}
    assert admit_surface({}) == {}
    assert surface_note({}) == ''
    with pytest.raises(RuntimeStoreError, match='invalid_params'):
        admit_surface({'surface': 'unknown-client'})
    with pytest.raises(RuntimeStoreError, match='invalid_params'):
        admit_surface({'surface': 'android', 'voice_context': 'smuggled'})


def test_android_note_uses_native_delivery_contract():
    note = surface_note({'surface': 'android'})
    for fact in ('native Android', 'not a terminal', 'host', 'MEDIA:/absolute/host/path',
                 'separate line', 'inline file cards', 'Download', 'picker', 'Share', 'share sheet'):
        assert fact in note
    assert 'HTML widgets' in note and 'attachments' in note


@pytest.mark.asyncio
async def test_android_admission_runs_once_and_next_plain_turn_is_clean(tmp_path, monkeypatch):
    from gateway.session_controls import AuthorityConnection
    from hermes_state_runtime import list_session_admissions
    from tests.gateway.test_surface_admission import _authority

    seen = []
    agent = SimpleNamespace(valid_tool_names=set())
    async def answer(event):
        arm_surface_turn(agent)
        seen.append((event.text, agent._gateway_turn_context_notes, agent._voice_turn_pending))
        return 'ok'

    authority = await _authority(tmp_path, monkeypatch, answer)
    connection = AuthorityConnection(authority, object(), {'user_id': 'owner'})
    try:
        await connection.dispatch({'id': 1, 'method': 'session.resume', 'params': {'session_id': 's'}})
        for request_id, extra in (('phone', {'surface': 'android'}), ('plain', {})):
            result = await connection.dispatch({'id': 2, 'method': 'prompt.submit', 'params': {
                'session_id': 's', 'submission_id': request_id, 'text': request_id, **extra}})
            assert result['result']['status'] == 'queued', result
            await authority.sessions['s'].task
    finally:
        await connection.close()
    rows = {row['request_id']: row for row in list_session_admissions(
        authority.db, session_id='s', pending_only=False)}
    assert rows['phone']['payload']['surface_v1'] == {'surface': 'android'}
    assert 'surface_v1' not in rows['plain']['payload']
    assert seen == [('phone', surface_note({'surface': 'android'}), False), ('plain', '', False)]


def test_android_note_is_api_sidecar_without_rewriting_warm_history_or_prefix():
    from tests.agent.test_gateway_turn_sidecar import _FakeAgent, _build

    agent = _FakeAgent()
    history = [{'role': 'user', 'content': 'earlier'}, {'role': 'assistant', 'content': 'answer'}]
    original = json.loads(json.dumps(history))
    with surface_turn_scope(restore_surface({'surface': 'android'})):
        arm_surface_turn(agent)
        with patch('agent.auxiliary_client.set_runtime_main'), patch('hermes_cli.plugins.invoke_hook', return_value=[]):
            ctx = _build(agent, user_message='send the report', conversation_history=history)
    message = ctx.messages[ctx.current_turn_user_idx]
    assert message['content'] == 'send the report'
    assert message['api_content'] == 'send the report\n\n' + surface_note({'surface': 'android'})
    assert history == original
    assert agent._cached_system_prompt == 'SYSTEM'
    assert agent._gateway_turn_context_notes == ''
    arm_surface_turn(agent)
    with patch('agent.auxiliary_client.set_runtime_main'), patch('hermes_cli.plugins.invoke_hook', return_value=[]):
        plain = _build(agent, user_message='next')
    assert 'api_content' not in plain.messages[plain.current_turn_user_idx]
    assert agent._voice_turn_pending is False


def test_android_shared_note_also_reaches_legacy_tui_submit(monkeypatch):
    from tests.tui_gateway.test_hud_surface_note import _session
    from tui_gateway import server

    session = _session(running=True)
    monkeypatch.setitem(server._sessions, 'android-surface-test', session)
    for extra, expected in (({'surface': 'android'}, surface_note({'surface': 'android'})),
                            ({}, ''), ({'surface': 'unknown-client'}, '')):
        server._methods['prompt.submit']('request', {
            'session_id': 'android-surface-test', 'text': 'unchanged', 'queued': True, **extra})
        assert server._hud_surface_note(session) == expected
        if extra.get('surface') == 'android':
            assert session['client_surface'] == 'android'
            assert 'native Android' in expected
    assert session['history'] == []


def test_android_managed_worker_bootstrap_reuses_shared_contract(tmp_path, monkeypatch):
    from agent.managed_worker import validate_bootstrap
    from gateway.session_kanban import run_worker_turns
    from gateway.session_managed_worker import _bootstrap
    from tests.gateway.test_managed_turn_contract import assignment

    plain, (authority, ref, row, policy, scope) = assignment(tmp_path, monkeypatch)
    phone = validate_bootstrap(json.loads(json.dumps(_bootstrap(
        authority, ref, {'payload': {**row['payload'], 'surface_v1': {'surface': 'android'}}}, policy, scope))))
    seen = []
    agent = SimpleNamespace(valid_tool_names=set(), run_conversation=lambda text, **kwargs: seen.append(
        (agent._voice_turn_pending, agent._gateway_turn_context_notes)) or {'final_response': 'ok'})
    run_worker_turns(agent, phone, [])
    run_worker_turns(agent, plain, [])
    assert seen == [(False, surface_note({'surface': 'android'})), (False, '')]
