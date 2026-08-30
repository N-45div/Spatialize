"""The voice agent on the OpenAI SDK: one function-calling loop, no framework.

Same tools, same system prompt and same session as the LangGraph agent in
voice.py; only the loop is different. The client is injectable so the loop is
tested without a network call.
"""

from __future__ import annotations

import json
from typing import Any, Callable

from ..config import Settings
from .tools import SceneSession, ToolError
from .voice import SYSTEM_PROMPT, AgentUnavailable, _call

_STR = {"type": "string"}


def _spec(name: str, description: str, properties: dict[str, Any], required: list[str]) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": False,
            },
        },
    }


TOOL_SPECS: list[dict[str, Any]] = [
    _spec("scene_overview", "Venue name, dimensions, rooms, counts, review state.", {}, []),
    _spec("list_landmarks", "All landmarks with ids, labels, types, and positions.", {}, []),
    _spec("list_doors", "All doors with ids, the rooms they connect, and accessibility state.", {}, []),
    _spec(
        "resolve_landmark",
        "Match a spoken phrase (like 'the washroom') to a landmark id. May report ambiguity.",
        {"query": _STR},
        ["query"],
    ),
    _spec(
        "describe_route",
        "Step-free route between two landmark ids: total distance, doors, turn-by-turn legs.",
        {"from_landmark_id": _STR, "to_landmark_id": _STR},
        ["from_landmark_id", "to_landmark_id"],
    ),
    _spec(
        "spatial_context",
        "The room containing a landmark and its nearest neighbours.",
        {"landmark_id": _STR},
        ["landmark_id"],
    ),
    _spec(
        "scene_confidence",
        "Extraction confidence and open review issues; pass an entity id for its evidence.",
        {"entity_id": _STR},
        [],
    ),
    _spec(
        "add_landmark",
        "Add a landmark. Give room_id or near_landmark_id. Types: entrance, elevator, stairs, restroom, destination.",
        {"label": _STR, "landmark_type": _STR, "room_id": _STR, "near_landmark_id": _STR},
        ["label", "landmark_type"],
    ),
    _spec(
        "rename_entity",
        "Rename a room, door, or landmark.",
        {"entity_id": _STR, "new_label": _STR},
        ["entity_id", "new_label"],
    ),
    _spec(
        "set_door_accessibility",
        "Mark a door accessible or not. Reports destinations that lose their step-free route.",
        {"door_id": _STR, "accessible": {"type": "boolean"}},
        ["door_id", "accessible"],
    ),
    _spec(
        "set_room_category",
        "Set a room category: public, service, circulation, or restricted.",
        {"room_id": _STR, "category": _STR},
        ["room_id", "category"],
    ),
    _spec(
        "add_review_note",
        "Record a human-review note when a change cannot be applied safely.",
        {"entity_id": _STR, "message": _STR},
        ["entity_id", "message"],
    ),
]


def bind_tools(session: SceneSession) -> dict[str, Callable[..., str]]:
    """Tool name -> callable over this session, each returning a JSON string."""
    return {
        "scene_overview": lambda: _call(session.scene_overview),
        "list_landmarks": lambda: _call(session.list_landmarks),
        "list_doors": lambda: _call(session.list_doors),
        "resolve_landmark": lambda query="": _call(session.resolve_landmark, query),
        "describe_route": lambda from_landmark_id="", to_landmark_id="": _call(
            session.describe_route, from_landmark_id, to_landmark_id
        ),
        "spatial_context": lambda landmark_id="": _call(session.spatial_context, landmark_id),
        "scene_confidence": lambda entity_id="": _call(session.scene_confidence, entity_id or None),
        "add_landmark": lambda label="", landmark_type="", room_id="", near_landmark_id="": _call(
            session.add_landmark, label, landmark_type, room_id or None, near_landmark_id or None
        ),
        "rename_entity": lambda entity_id="", new_label="": _call(
            session.rename_entity, entity_id, new_label
        ),
        "set_door_accessibility": lambda door_id="", accessible=False: _call(
            session.set_door_accessibility, door_id, bool(accessible)
        ),
        "set_room_category": lambda room_id="", category="": _call(
            session.set_room_category, room_id, category
        ),
        "add_review_note": lambda entity_id="", message="": _call(
            session.add_review_note, entity_id, message
        ),
    }


def _queued_summary(session: SceneSession) -> str:
    return "; ".join(mutation.summary for mutation in session.mutations)


class OpenAIVoiceAgent:
    """Live voice agent over the OpenAI chat completions API with function calling."""

    def __init__(self, settings: Settings, client: Any | None = None):
        self._settings = settings
        self._client = client

    def _get_client(self) -> Any:
        if self._client is None:
            from openai import OpenAI

            self._client = OpenAI(api_key=self._settings.openai_api_key, max_retries=3)
        return self._client

    def answer(
        self, session: SceneSession, question: str, history: list[dict] | None = None
    ) -> str:
        messages: list[dict[str, Any]] = [{"role": "system", "content": SYSTEM_PROMPT}]
        for turn in (history or [])[-4:]:
            if turn.get("question"):
                messages.append({"role": "user", "content": str(turn["question"])[:500]})
            if turn.get("answer"):
                messages.append({"role": "assistant", "content": str(turn["answer"])[:500]})
        messages.append({"role": "user", "content": question})

        handlers = bind_tools(session)
        client = self._get_client()

        for _ in range(self._settings.agent_max_tool_rounds):
            try:
                response = client.chat.completions.create(
                    model=self._settings.openai_agent_model,
                    messages=messages,
                    tools=TOOL_SPECS,
                    tool_choice="auto",
                )
            except Exception as error:  # quota, availability, network
                if session.mutations:
                    return (
                        f"The model provider interrupted me, but these changes were queued for "
                        f"the venue team: {_queued_summary(session)}. Nothing is live until a "
                        f"person approves it."
                    )
                raise AgentUnavailable(
                    "The voice agent is temporarily unavailable at its model provider. "
                    "Please try again in a minute."
                ) from error

            message = response.choices[0].message
            calls = list(message.tool_calls or [])
            if not calls:
                return (message.content or "").strip()

            messages.append(
                {
                    "role": "assistant",
                    "content": message.content or "",
                    "tool_calls": [
                        {
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.function.name,
                                "arguments": call.function.arguments or "{}",
                            },
                        }
                        for call in calls
                    ],
                }
            )
            for call in calls:
                handler = handlers.get(call.function.name)
                try:
                    arguments = json.loads(call.function.arguments or "{}")
                except json.JSONDecodeError:
                    arguments = {}
                if handler is None:
                    result = json.dumps({"error": f"Unknown tool {call.function.name}"})
                else:
                    try:
                        result = handler(**arguments)
                    except TypeError as error:
                        result = json.dumps({"error": f"Bad arguments: {error}", "instruction": "Adjust and retry."})
                    except ToolError as error:
                        result = json.dumps({"error": str(error), "instruction": "Adjust and retry."})
                messages.append({"role": "tool", "tool_call_id": call.id, "content": result})

        if session.mutations:
            return (
                f"I ran out of thinking budget, but these changes were queued for the venue "
                f"team: {_queued_summary(session)}. Nothing is live until a person approves it."
            )
        return "I could not finish working that out. Please try a simpler question."
