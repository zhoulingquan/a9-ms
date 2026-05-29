"""A9MS-specific tools for the productized A9Bot runtime."""

from __future__ import annotations

import json
from typing import Any

from a9bot.agent.tools.base import Tool, tool_parameters
from a9bot.agent.tools.schema import IntegerSchema, StringSchema, tool_parameters_schema
from a9bot.config.schema import Base
from a9bot.integrations.a9ms.client import A9MSClient


class A9MSToolsConfig(Base):
    """Configuration for A9MS business tools."""

    enable: bool = False
    base_url: str = ""
    session_cookie: str = ""
    service_token: str = ""
    timeout_s: float = 30.0
    max_results: int = 20


class A9MSToolMixin:
    """Shared A9MS client dependency for tool instances."""

    def __init__(self, client: A9MSClient):
        self.client = client

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        config = getattr(ctx.config, "a9ms", None)
        return bool(config and config.enable and config.base_url.strip())

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        config = ctx.config.a9ms
        return cls(
            A9MSClient(
                base_url=config.base_url,
                session_cookie=config.session_cookie,
                service_token=config.service_token,
                timeout_s=config.timeout_s,
            )
        )


@tool_parameters(tool_parameters_schema(required=[]))
class A9MSGetSectionsTool(A9MSToolMixin, Tool):
    name = "a9ms_get_sections"
    description = "List A9MS ledger sections available to the current user."

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, **kwargs: Any) -> str:
        data = await self.client.get_sections()
        return json.dumps(data, ensure_ascii=False)


@tool_parameters(
    tool_parameters_schema(
        sectionId=StringSchema("A9MS section id to read"),
        required=["sectionId"],
    )
)
class A9MSGetSectionDataTool(A9MSToolMixin, Tool):
    name = "a9ms_get_section_data"
    description = "Read one A9MS ledger section by id."

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, section_id: str = "", **kwargs: Any) -> str:
        section_id = kwargs.get("sectionId", section_id)
        data = await self.client.get_section_data(section_id)
        return json.dumps(data, ensure_ascii=False)


@tool_parameters(
    tool_parameters_schema(
        query=StringSchema("Keyword to search across customer names, locations, industries, notes, and contacts"),
        limit=IntegerSchema(20, description="Maximum number of matches to return", minimum=1, maximum=100),
        required=["query"],
    )
)
class A9MSSearchLedgerTool(A9MSToolMixin, Tool):
    name = "a9ms_search_ledger"
    description = "Search A9MS ledger rows by keyword across all sections."

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, query: str, limit: int = 20, **kwargs: Any) -> str:
        data = await self.client.search_ledger(query, limit=limit)
        return json.dumps(data, ensure_ascii=False)


@tool_parameters(tool_parameters_schema(required=[]))
class A9MSAnalyzeLedgerTool(A9MSToolMixin, Tool):
    name = "a9ms_analyze_ledger"
    description = "Summarize A9MS ledger totals by section, status, rating, and amount level."

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, **kwargs: Any) -> str:
        data = await self.client.analyze_ledger()
        return json.dumps(data, ensure_ascii=False)
