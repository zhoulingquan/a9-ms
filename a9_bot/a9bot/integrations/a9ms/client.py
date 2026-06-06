"""HTTP client for A9MS v3.0 — Grist-backed APIs."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

import httpx


@dataclass(slots=True)
class A9MSClient:
    """Typed wrapper around the A9MS HTTP API used by A9Bot tools.

    v3.0: Reads from Grist-backed endpoints (/api/stats, /api/customers, /api/regions).
    """

    base_url: str
    session_cookie: str = ""
    service_token: str = ""
    timeout_s: float = 30.0
    _client: httpx.AsyncClient | None = field(default=None, init=False, repr=False)

    def __post_init__(self) -> None:
        self.base_url = self.base_url.strip().rstrip("/")
        if not self.base_url:
            raise ValueError("base_url is required")

    def url(self, path: str) -> str:
        normalized = path if path.startswith("/") else f"/{path}"
        return f"{self.base_url}{normalized}"

    def headers(self) -> dict[str, str]:
        headers: dict[str, str] = {}
        if self.service_token:
            headers["Authorization"] = f"Bearer {self.service_token}"
        if self.session_cookie:
            headers["Cookie"] = self.session_cookie
        return headers

    async def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.timeout_s, headers=self.headers())
        return self._client

    async def get_json(self, path: str) -> Any:
        client = await self._http()
        response = await client.get(self.url(path))
        response.raise_for_status()
        return response.json()

    # ---------- v3.0 Grist-backed API ----------

    async def get_stats(self) -> Any:
        """获取聚合统计数据（看板数据源）。"""
        return await self.get_json("/api/stats")

    async def get_customers(self, limit: int = 100, offset: int = 0, filter_str: str = "") -> Any:
        """获取客户列表，支持分页和筛选。"""
        params = f"limit={limit}&offset={offset}"
        if filter_str:
            params += f"&filter={quote(filter_str)}"
        return await self.get_json(f"/api/customers?{params}")

    async def get_regions(self) -> Any:
        """获取区域配置列表。"""
        return await self.get_json("/api/regions")

    async def get_logs(self, limit: int = 50, username: str = "") -> Any:
        """获取操作日志。"""
        params = f"limit={limit}"
        if username:
            params += f"&username={quote(username)}"
        return await self.get_json(f"/api/logs?{params}")

    async def get_tables(self) -> Any:
        """获取 Grist 表列表。"""
        return await self.get_json("/api/tables")

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
