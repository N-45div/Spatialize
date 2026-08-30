"""The OpenAI voice stack, tested against fake clients — no network."""

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from fastapi.testclient import TestClient

from spatialize_api.agents.openai_agent import TOOL_SPECS, OpenAIVoiceAgent
from spatialize_api.agents.tools import SceneSession
from spatialize_api.app import create_app
from spatialize_api.config import Settings
from spatialize_api.media.openai_media import OpenAINarrator, OpenAITranscriber
from spatialize_api.media.pipelines import ChainNarrator, build_narrator, build_transcriber
from tests.test_api import FixtureExtractor, create_run, valid_scene


# ---------- fakes ----------


def tool_call(call_id: str, name: str, arguments: dict[str, Any]):
    return SimpleNamespace(
        id=call_id,
        function=SimpleNamespace(name=name, arguments=json.dumps(arguments)),
    )


def completion(content: str | None = None, tool_calls: list | None = None):
    message = SimpleNamespace(content=content, tool_calls=tool_calls)
    return SimpleNamespace(choices=[SimpleNamespace(message=message)])


class ScriptedChat:
    """Replays a fixed sequence of completions and records what it was asked."""

    def __init__(self, turns: list):
        self._turns = list(turns)
        self.requests: list[dict[str, Any]] = []

    def create(self, **kwargs: Any):
        self.requests.append(kwargs)
        return self._turns.pop(0)


def fake_client(turns: list):
    chat = ScriptedChat(turns)
    return SimpleNamespace(chat=SimpleNamespace(completions=chat)), chat


def settings(**overrides: Any) -> Settings:
    return Settings(storage_backend="local", openai_api_key="test-key", **overrides)


def session() -> SceneSession:
    return SceneSession(scene=valid_scene("run_x"), spoken_quote="add a cafe in the gallery")


# ---------- agent loop ----------


def test_agent_runs_tools_then_answers() -> None:
    client, chat = fake_client(
        [
            completion(tool_calls=[tool_call("c1", "resolve_landmark", {"query": "the gallery"})]),
            completion(tool_calls=[tool_call("c2", "describe_route", {"from_landmark_id": "entrance", "to_landmark_id": "gallery-mark"})]),
            completion(content="The gallery is 8 metres from the entrance, through the gallery door."),
        ]
    )
    agent = OpenAIVoiceAgent(settings(), client=client)

    answer = agent.answer(session(), "how far is the gallery?")

    assert answer.startswith("The gallery is 8 metres")
    assert len(chat.requests) == 3
    # The contract the model sees is the published tool list, every time.
    assert all(request["tools"] is TOOL_SPECS for request in chat.requests)
    # Tool results were fed back as tool messages, in order.
    roles = [message["role"] for message in chat.requests[-1]["messages"]]
    assert roles[-4:] == ["assistant", "tool", "assistant", "tool"]
    assert chat.requests[-1]["model"] == "gpt-5.6-luna"


def test_agent_edit_becomes_a_proposal_not_a_direct_write() -> None:
    client, _ = fake_client(
        [
            completion(tool_calls=[tool_call("c1", "add_landmark", {"label": "Cafe", "landmark_type": "destination", "room_id": "gallery"})]),
            completion(content="I have queued the cafe for the venue team."),
        ]
    )
    scene_session = session()

    OpenAIVoiceAgent(settings(), client=client).answer(scene_session, "add a cafe in the gallery")

    assert len(scene_session.mutations) == 1
    proposal = scene_session.mutations[0].proposal
    assert proposal["kind"] == "add-landmark"
    assert proposal["label"] == "Cafe"
    assert proposal["reason"] == "add a cafe in the gallery"


def test_agent_feeds_tool_errors_back_instead_of_crashing() -> None:
    client, chat = fake_client(
        [
            completion(tool_calls=[tool_call("c1", "describe_route", {"from_landmark_id": "nope", "to_landmark_id": "gallery-mark"})]),
            completion(content="I could not find that starting point."),
        ]
    )

    answer = OpenAIVoiceAgent(settings(), client=client).answer(session(), "route me from nowhere")

    tool_message = chat.requests[-1]["messages"][-1]
    assert tool_message["role"] == "tool"
    assert "error" in json.loads(tool_message["content"])
    assert answer == "I could not find that starting point."


def test_agent_reports_queued_edits_when_the_provider_fails_midway() -> None:
    class Failing:
        def __init__(self, first):
            self._first = first

        def create(self, **kwargs):
            if self._first is not None:
                turn, self._first = self._first, None
                return turn
            raise RuntimeError("429 rate limited")

    first = completion(tool_calls=[tool_call("c1", "add_landmark", {"label": "Cafe", "landmark_type": "destination", "room_id": "gallery"})])
    client = SimpleNamespace(chat=SimpleNamespace(completions=Failing(first)))

    answer = OpenAIVoiceAgent(settings(), client=client).answer(session(), "add a cafe")

    assert "queued for the venue team" in answer
    assert "Cafe" in answer


def test_agent_gives_up_gracefully_after_the_round_budget() -> None:
    looping = [completion(tool_calls=[tool_call(f"c{i}", "scene_overview", {})]) for i in range(20)]
    client, chat = fake_client(looping)

    answer = OpenAIVoiceAgent(settings(agent_max_tool_rounds=3), client=client).answer(session(), "hmm")

    assert len(chat.requests) == 3
    assert "simpler question" in answer


# ---------- speech ----------


def test_transcriber_returns_text_from_bytes_with_a_stable_hash() -> None:
    calls: list[dict[str, Any]] = []

    def create(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(text="  add a cafe in the gallery ")

    client = SimpleNamespace(audio=SimpleNamespace(transcriptions=SimpleNamespace(create=create)))
    transcriber = OpenAITranscriber(settings(), client=client)

    first = transcriber.transcribe_bytes(b"RIFFfake", "audio/wav", "run_x")
    second = transcriber.transcribe_bytes(b"RIFFfake", "audio/wav", "run_x")

    assert first.text == "add a cafe in the gallery"
    assert first.mean_confidence == 1.0
    assert first.manifest_hash == second.manifest_hash
    assert calls[0]["model"] == "gpt-4o-mini-transcribe"
    assert calls[0]["file"][0] == "question.wav"


def test_narrator_returns_mp3_bytes() -> None:
    calls: list[dict[str, Any]] = []

    def create(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(content=b"ID3fakemp3")

    client = SimpleNamespace(audio=SimpleNamespace(speech=SimpleNamespace(create=create)))

    narration = OpenAINarrator(settings(), client=client).narrate("Turn left.", "run_x")

    assert narration.audio_bytes == b"ID3fakemp3"
    assert narration.media_type == "audio/mpeg"
    assert narration.provider == "openai-tts"
    assert calls[0]["model"] == "gpt-4o-mini-tts"
    assert calls[0]["voice"] == "coral"


# ---------- selection ----------


def test_openai_takes_the_whole_voice_path_when_its_key_is_set() -> None:
    chosen = settings(gemini_api_key="g", assemblyai_api_key="a")

    assert isinstance(build_transcriber(chosen, None), OpenAITranscriber)
    narrator = build_narrator(chosen, None)
    assert isinstance(narrator, ChainNarrator)
    assert isinstance(narrator._narrators[0], OpenAINarrator)


def test_fallback_providers_remain_when_openai_is_absent() -> None:
    without = Settings(storage_backend="local", assemblyai_api_key="a", gemini_api_key="g")

    assert not isinstance(build_transcriber(without, None), OpenAITranscriber)
    assert not isinstance(build_narrator(without, None)._narrators[0], OpenAINarrator)


# ---------- through the API, in local storage mode ----------


class BytesTranscriber:
    def transcribe(self, audio_url: str, run_id: str):
        raise AssertionError("the bytes path should be used")

    def transcribe_bytes(self, data: bytes, content_type: str, run_id: str):
        from spatialize_api.media.pipelines import Transcript

        assert data.startswith(b"RIFF")
        return Transcript(text="how far is the gallery", words=[], run_id="openai_stt_x", manifest_hash="h")


class AnsweringAgent:
    def answer(self, session, question, history=None):
        return f"You asked: {question}"


def test_voice_question_works_without_b2_when_the_transcriber_takes_bytes(tmp_path: Path) -> None:
    app = create_app(
        settings=Settings(storage_backend="local", local_data_dir=tmp_path, max_upload_bytes=1024),
        extractor=FixtureExtractor(),
        transcriber=BytesTranscriber(),
        voice_agent=AnsweringAgent(),
    )
    with TestClient(app) as client:
        run = create_run(client)
        client.post(f"/api/runs/{run['runId']}/extract")

        response = client.post(
            f"/api/runs/{run['runId']}/ask",
            files={"audio": ("q.wav", b"RIFF" + b"\x00" * 2000, "audio/wav")},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["transcript"]["text"] == "how far is the gallery"
        assert body["answer"]["script"] == "You asked: how far is the gallery"
        assert "stt-skipped-local-storage" not in body["warnings"]
