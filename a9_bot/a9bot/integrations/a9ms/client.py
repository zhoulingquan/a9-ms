"""Small HTTP client for A9MS business APIs."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

import httpx


@dataclass(slots=True)
class A9MSClient:
    """Typed wrapper around the A9MS HTTP API used by A9Bot tools."""

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

    async def get_sections(self) -> Any:
        return await self.get_json("/api/a9bot/ledger/sections")

    async def get_section_data(self, section_id: str) -> Any:
        encoded = quote(str(section_id).strip(), safe="")
        return await self.get_json(f"/api/a9bot/ledger/sections/{encoded}")

    async def search_ledger(self, query: str, limit: int = 20) -> Any:
        encoded_query = quote(str(query).strip(), safe="")
        safe_limit = max(1, min(int(limit or 20), 100))
        return await self.get_json(f"/api/a9bot/ledger/search?q={encoded_query}&limit={safe_limit}")

    async def analyze_ledger(self) -> Any:
        return await self.get_json("/api/a9bot/ledger/analyze")

    async def put_json(self, path: str, payload: Any) -> Any:
        client = await self._http()
        response = await client.put(self.url(path), json=payload)
        response.raise_for_status()
        return response.json()

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
