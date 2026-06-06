"""A9MS v3.0 tools for the productized A9Bot runtime.

Reads from Grist-backed APIs: /api/stats, /api/customers, /api/regions.
"""

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


# ---------- 统计概览 ----------

@tool_parameters(tool_parameters_schema(required=[]))
class A9MSGetStatsTool(A9MSToolMixin, Tool):
    name = "a9ms_get_stats"
    description = "获取 A9MS 客户台账的聚合统计数据，包括各区域客户数、评级分布、合作状态分布、预计年度贡献等。"

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, **kwargs: Any) -> str:
        data = await self.client.get_stats()
        return json.dumps(data, ensure_ascii=False)


# ---------- 客户列表 ----------

@tool_parameters(
    tool_parameters_schema(
        query=StringSchema("搜索关键词，用于筛选客户名称、行业、合作点等", required=False),
        limit=IntegerSchema(20, description="返回记录数上限", minimum=1, maximum=200),
        offset=IntegerSchema(0, description="分页偏移量", minimum=0),
        filter_str=StringSchema("Grist filter 条件", required=False),
        required=[],
    )
)
class A9MSGetCustomersTool(A9MSToolMixin, Tool):
    name = "a9ms_get_customers"
    description = "获取客户台账列表，支持关键词搜索、分页和条件筛选。"

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, query: str = "", limit: int = 20, offset: int = 0,
                      filter_str: str = "", **kwargs: Any) -> str:
        data = await self.client.get_customers(limit=limit, offset=offset, filter_str=filter_str)
        return json.dumps(data, ensure_ascii=False)


# ---------- 区域配置 ----------

@tool_parameters(tool_parameters_schema(required=[]))
class A9MSGetRegionsTool(A9MSToolMixin, Tool):
    name = "a9ms_get_regions"
    description = "获取所有区域配置，包括区域名称、标签、代表省份、地图坐标等。"

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, **kwargs: Any) -> str:
        data = await self.client.get_regions()
        return json.dumps(data, ensure_ascii=False)


# ---------- 操作日志 ----------

@tool_parameters(
    tool_parameters_schema(
        limit=IntegerSchema(50, description="返回日志条数上限", minimum=1, maximum=200),
        username=StringSchema("按操作人筛选", required=False),
        required=[],
    )
)
class A9MSGetLogsTool(A9MSToolMixin, Tool):
    name = "a9ms_get_logs"
    description = "获取操作日志，可按操作人筛选。"

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, limit: int = 50, username: str = "", **kwargs: Any) -> str:
        data = await self.client.get_logs(limit=limit, username=username)
        return json.dumps(data, ensure_ascii=False)
