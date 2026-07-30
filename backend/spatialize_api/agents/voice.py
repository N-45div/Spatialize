"""The voice agent harness: Gemini + LangGraph over scene-grounded tools."""

from __future__ import annotations

import json
from dataclasses import asdict
from typing import Any, Protocol

from ..config import Settings
from .tools import SceneSession, ToolError

SYSTEM_PROMPT = """You are the voice of a venue's spatial twin in Spatialize.
You answer wayfinding questions and apply spoken edits to the scene.

Hard rules:
- Answer ONLY from tool results. Never invent rooms, doors, landmarks, or distances.
- Resolve spoken names with resolve_landmark before routing or editing; find \
door ids with list_doors. If a match is ambiguous, ask the user which one they \
meant instead of acting.
- For edits: apply them with the mutation tools. If the topology gate rejects a \
change, adjust once (different position or room); if it still fails, record an \
add_review_note instead and say so.
- If a mutation result contains a warning, you MUST repeat that warning to the user.
- Never make live-navigation or safety claims. This is rehearsal guidance only; \
say so if asked about real-time use.
- If the request is out of scope (bookings, opening hours, anything beyond this \
venue's geometry), say you cannot help with that.
- Keep the final answer short and speakable: 2-4 sentences, no markdown, metric \
units, distances rounded to whole metres."""


class AgentUnavailable(RuntimeError):
    pass


class VoiceAgent(Protocol):
    def answer(self, session: SceneSession, question: str) -> str: ...


class DisabledVoiceAgent:
    def answer(self, session: SceneSession, question: str) -> str:
        raise AgentUnavailable(
            "The voice agent is not configured. Set GEMINI_API_KEY to enable it."
        )


def _tool_payload(value: Any) -> str:
    if hasattr(value, "__dataclass_fields__"):
        value = asdict(value)
    return json.dumps(value, default=str)


def _call(fn: Any, *args: Any, **kwargs: Any) -> str:
    """Run a session tool; a ToolError becomes feedback the agent can act on."""
    try:
        return _tool_payload(fn(*args, **kwargs))
    except ToolError as error:
        return json.dumps({"error": str(error), "instruction": "Adjust and retry."})


def build_langchain_tools(session: SceneSession) -> list[Any]:
    from langchain_core.tools import tool

    @tool
    def scene_overview() -> str:
        """Venue name, dimensions, rooms, counts, review state."""
        return _call(session.scene_overview)

    @tool
    def list_landmarks() -> str:
        """All landmarks with ids, labels, types, and positions."""
        return _call(session.list_landmarks)

    @tool
    def list_doors() -> str:
        """All doors with ids, the rooms they connect, and accessibility state."""
        return _call(session.list_doors)

    @tool
    def resolve_landmark(query: str) -> str:
        """Match a spoken phrase (like 'the washroom') to a landmark id. May report ambiguity."""
        return _call(session.resolve_landmark, query)

    @tool
    def describe_route(from_landmark_id: str, to_landmark_id: str) -> str:
        """Step-free route between two landmark ids: total distance, doors, turn-by-turn legs."""
        return _call(session.describe_route, from_landmark_id, to_landmark_id)

    @tool
    def spatial_context(landmark_id: str) -> str:
        """The room containing a landmark and its nearest neighbours."""
        return _call(session.spatial_context, landmark_id)

    @tool
    def scene_confidence(entity_id: str = "") -> str:
        """Extraction confidence and open review issues; pass an entity id for its evidence."""
        return _call(session.scene_confidence, entity_id or None)

    @tool
    def add_landmark(
        label: str, landmark_type: str, room_id: str = "", near_landmark_id: str = ""
    ) -> str:
        """Add a landmark. Give room_id or near_landmark_id. Types: entrance, elevator, stairs, restroom, destination."""
        return _call(
            session.add_landmark, label, landmark_type, room_id or None, near_landmark_id or None
        )

    @tool
    def rename_entity(entity_id: str, new_label: str) -> str:
        """Rename a room, door, or landmark."""
        return _call(session.rename_entity, entity_id, new_label)

    @tool
    def set_door_accessibility(door_id: str, accessible: bool) -> str:
        """Mark a door accessible or not. Reports destinations that lose their step-free route."""
        return _call(session.set_door_accessibility, door_id, accessible)

    @tool
    def set_room_category(room_id: str, category: str) -> str:
        """Set a room category: public, service, circulation, or restricted."""
        return _call(session.set_room_category, room_id, category)

    @tool
    def add_review_note(entity_id: str, message: str) -> str:
        """Record a human-review note when a change cannot be applied safely."""
        return _call(session.add_review_note, entity_id, message)

    return [
        scene_overview,
        list_landmarks,
        list_doors,
        resolve_landmark,
        describe_route,
        spatial_context,
        scene_confidence,
        add_landmark,
        rename_entity,
        set_door_accessibility,
        set_room_category,
        add_review_note,
    ]


class GeminiVoiceAgent:
    def __init__(self, settings: Settings):
        self._settings = settings

    def answer(self, session: SceneSession, question: str) -> str:
        from langchain_core.messages import HumanMessage
        from langchain_google_genai import ChatGoogleGenerativeAI
        from langgraph.errors import GraphRecursionError
        from langgraph.prebuilt import create_react_agent

        rate_limiter = None
        if self._settings.gemini_requests_per_minute:
            from langchain_core.rate_limiters import InMemoryRateLimiter

            rate_limiter = InMemoryRateLimiter(
                requests_per_second=self._settings.gemini_requests_per_minute / 60,
                max_bucket_size=2,
            )
        model = ChatGoogleGenerativeAI(
            model=self._settings.gemini_agent_model,
            google_api_key=self._settings.gemini_api_key,
            temperature=0.2,
            max_retries=4,
            rate_limiter=rate_limiter,
        )
        graph = create_react_agent(
            model, build_langchain_tools(session), prompt=SYSTEM_PROMPT
        )
        # Each tool round is a model step plus a tool step.
        limit = 2 * self._settings.agent_max_tool_rounds + 1
        try:
            state = graph.invoke(
                {"messages": [HumanMessage(content=question)]},
                config={"recursion_limit": limit},
            )
        except ToolError as error:
            return str(error)
        except GraphRecursionError:
            if session.mutations:
                applied = "; ".join(m.summary for m in session.mutations)
                return (
                    f"I ran out of thinking budget, but these changes were applied: {applied}. "
                    "They are marked for human review."
                )
            return "I could not finish working that out. Please try a simpler question."
        except Exception as error:  # provider quota/availability failures
            if session.mutations:
                applied = "; ".join(m.summary for m in session.mutations)
                return (
                    f"The model provider interrupted me, but these changes were applied: "
                    f"{applied}. They are marked for human review."
                )
            raise AgentUnavailable(
                "The voice agent is temporarily rate-limited by its model provider. "
                "Please try again in a minute."
            ) from error
        content = state["messages"][-1].content
        if isinstance(content, list):
            content = " ".join(
                part.get("text", "") if isinstance(part, dict) else str(part)
                for part in content
            )
        return content.strip()
