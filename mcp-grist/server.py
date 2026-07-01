"""
Grist MCP Server —— 供 Munchkin 调用，操作 Grist 数据并生成 A9 widget。
传输方式：stdio
依赖：mcp, httpx（munchkin 镜像已内置）
"""
import json
import os
import re
import asyncio
from collections import Counter, defaultdict
from typing import Any

import httpx
from mcp.server import Server
from mcp.server.stdio import stdio_server
import mcp.types as types

# ---------- 配置 ----------
GRIST_URL = os.environ.get("GRIST_URL", "http://grist:8484").rstrip("/")
GRIST_API_KEY = os.environ.get("GRIST_API_KEY", "")
A9_API_URL = os.environ.get("A9_API_URL", "http://app:3000").rstrip("/")
A9_AGENT_TOKEN = os.environ.get("A9_AGENT_TOKEN", "")

# 路径段校验：防止路径穿越
_SEGMENT_RE = re.compile(r"^[A-Za-z0-9_\-]+$")


def _valid_segment(value: str, name: str) -> str:
    """校验 Grist 路径段，拒绝含 / \\ .. 等的值"""
    v = str(value or "").strip()
    if not v or v == "." or v == ".." or not _SEGMENT_RE.match(v):
        raise ValueError(f"Invalid Grist {name}: {value!r}")
    return v


# ---------- Grist HTTP 客户端 ----------
class GristClient:
    def __init__(self):
        self._doc_id: str | None = None
        self._docs_cache: list[dict] | None = None
        self._docs_cache_time: float = 0
        self._client = httpx.AsyncClient(
            base_url=GRIST_URL,
            headers={"Authorization": f"Bearer {GRIST_API_KEY}"},
            timeout=30.0,
        )

    async def _fetch_docs(self) -> list[dict]:
        """拉取工作区文档列表（30s 软缓存）"""
        import time
        now = time.time()
        if self._docs_cache and (now - self._docs_cache_time) < 30:
            return self._docs_cache
        resp = await self._client.get("/api/orgs/current/workspaces")
        resp.raise_for_status()
        workspaces = resp.json()
        docs = []
        for ws in workspaces or []:
            docs.extend(ws.get("docs") or [])
        self._docs_cache = docs
        self._docs_cache_time = now
        return docs

    async def _ensure_doc_id(self) -> str:
        """确保有可用 docId，自动发现首个文档"""
        if self._doc_id:
            return self._doc_id
        docs = await self._fetch_docs()
        if not docs:
            raise RuntimeError("Grist 工作区中没有文档")
        env_doc = os.environ.get("GRIST_DOC_ID", "")
        if env_doc:
            _valid_segment(env_doc, "docId")
            for d in docs:
                if d["id"] == env_doc:
                    self._doc_id = env_doc
                    return self._doc_id
        # 自动选首个
        self._doc_id = docs[0]["id"]
        print(f"[Grist MCP] 自动发现文档: {self._doc_id}", flush=True)
        return self._doc_id

    async def get_tables(self) -> list[dict]:
        doc_id = await self._ensure_doc_id()
        resp = await self._client.get(f"/api/docs/{doc_id}/tables")
        resp.raise_for_status()
        return resp.json().get("tables", [])

    async def get_columns(self, table_id: str) -> list[dict]:
        table_id = _valid_segment(table_id, "tableId")
        doc_id = await self._ensure_doc_id()
        resp = await self._client.get(f"/api/docs/{doc_id}/tables/{table_id}/columns")
        resp.raise_for_status()
        return resp.json().get("columns", [])

    async def get_records(self, table_id: str, limit: int = 500) -> list[dict]:
        table_id = _valid_segment(table_id, "tableId")
        doc_id = await self._ensure_doc_id()
        resp = await self._client.get(
            f"/api/docs/{doc_id}/tables/{table_id}/records",
            params={"limit": limit},
        )
        resp.raise_for_status()
        return resp.json().get("records", [])

    async def create_record(self, table_id: str, fields: dict) -> dict:
        table_id = _valid_segment(table_id, "tableId")
        doc_id = await self._ensure_doc_id()
        resp = await self._client.post(
            f"/api/docs/{doc_id}/tables/{table_id}/records",
            json={"records": [{"fields": fields}]},
        )
        resp.raise_for_status()
        return resp.json()

    async def update_record(self, table_id: str, record_id: int, fields: dict) -> dict:
        table_id = _valid_segment(table_id, "tableId")
        doc_id = await self._ensure_doc_id()
        resp = await self._client.patch(
            f"/api/docs/{doc_id}/tables/{table_id}/records",
            json={"records": [{"id": record_id, "fields": fields}]},
        )
        resp.raise_for_status()
        return resp.json()

    async def delete_record(self, table_id: str, record_id: int) -> dict:
        table_id = _valid_segment(table_id, "tableId")
        doc_id = await self._ensure_doc_id()
        resp = await self._client.delete(
            f"/api/docs/{doc_id}/tables/{table_id}/records",
            json={"records": [record_id]},
        )
        resp.raise_for_status()
        return resp.json()


grist = GristClient()
server = Server("grist")


# ---------- 工具定义 ----------
TOOLS = [
    types.Tool(
        name="list_tables",
        description="列出 Grist 文档中的所有表",
        inputSchema={"type": "object", "properties": {}},
    ),
    types.Tool(
        name="get_table_schema",
        description="获取指定表的列定义（字段名、类型）",
        inputSchema={
            "type": "object",
            "properties": {"table_id": {"type": "string", "description": "表 ID"}},
            "required": ["table_id"],
        },
    ),
    types.Tool(
        name="query_records",
        description="查询表中的记录，可按字段过滤，默认返回最多 500 条",
        inputSchema={
            "type": "object",
            "properties": {
                "table_id": {"type": "string", "description": "表 ID"},
                "filter_field": {"type": "string", "description": "过滤字段名（可选）"},
                "filter_value": {"type": "string", "description": "过滤值（可选）"},
                "limit": {"type": "integer", "description": "返回上限", "default": 500},
            },
            "required": ["table_id"],
        },
    ),
    types.Tool(
        name="create_record",
        description="在指定表中新增一条记录",
        inputSchema={
            "type": "object",
            "properties": {
                "table_id": {"type": "string", "description": "表 ID"},
                "fields": {"type": "object", "description": "字段键值对"},
            },
            "required": ["table_id", "fields"],
        },
    ),
    types.Tool(
        name="update_record",
        description="更新指定记录的字段",
        inputSchema={
            "type": "object",
            "properties": {
                "table_id": {"type": "string", "description": "表 ID"},
                "record_id": {"type": "integer", "description": "记录 ID"},
                "fields": {"type": "object", "description": "要更新的字段键值对"},
            },
            "required": ["table_id", "record_id", "fields"],
        },
    ),
    types.Tool(
        name="delete_record",
        description="删除指定记录",
        inputSchema={
            "type": "object",
            "properties": {
                "table_id": {"type": "string", "description": "表 ID"},
                "record_id": {"type": "integer", "description": "记录 ID"},
            },
            "required": ["table_id", "record_id"],
        },
    ),
    types.Tool(
        name="aggregate",
        description="对表数据做聚合统计（计数/求和/平均值），按指定字段分组",
        inputSchema={
            "type": "object",
            "properties": {
                "table_id": {"type": "string", "description": "表 ID"},
                "group_by": {"type": "string", "description": "分组字段名"},
                "metric": {
                    "type": "string",
                    "enum": ["count", "sum", "average"],
                    "description": "统计方式",
                    "default": "count",
                },
                "value_field": {
                    "type": "string",
                    "description": "求和/平均值时的数值字段名（count 时忽略）",
                },
            },
            "required": ["table_id", "group_by"],
        },
    ),
    types.Tool(
        name="save_widget",
        description="生成一个 A9 看板 widget 配置并保存到用户看板。用于将查询结果可视化为图表。",
        inputSchema={
            "type": "object",
            "properties": {
                "type": {
                    "type": "string",
                    "enum": ["metric", "bar", "pie", "line"],
                    "description": "图表类型",
                },
                "title": {"type": "string", "description": "图表标题"},
                "table_id": {"type": "string", "description": "数据源表 ID"},
                "dimension": {"type": "string", "description": "维度字段名（X 轴/分组）"},
                "metric": {
                    "type": "string",
                    "enum": ["count", "sum", "average"],
                    "default": "count",
                    "description": "统计方式",
                },
                "value_field": {"type": "string", "description": "数值字段名（sum/average 时需要）"},
            },
            "required": ["type", "title", "table_id", "dimension"],
        },
    ),
]


@server.list_tools()
async def handle_list_tools() -> list[types.Tool]:
    return TOOLS


# ---------- 工具执行 ----------
def _records_to_table(records: list[dict], limit: int = 20) -> str:
    """将记录格式化为可读的文本表格"""
    if not records:
        return "（无记录）"
    rows = [r.get("fields", {}) for r in records[:limit]]
    if not rows:
        return "（无字段）"
    cols = list(rows[0].keys())
    header = " | ".join(cols)
    sep = "-+-".join("-" * len(c) for c in cols)
    lines = [header, sep]
    for r in rows:
        lines.append(" | ".join(str(r.get(c, "")) for c in cols))
    if len(records) > limit:
        lines.append(f"... 共 {len(records)} 条，仅显示前 {limit} 条")
    return "\n".join(lines)


def _try_number(v: Any) -> float | None:
    """尝试转为数值"""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).replace(",", "").strip())
    except (ValueError, TypeError):
        return None


async def _do_aggregate(
    table_id: str, group_by: str, metric: str, value_field: str = ""
) -> str:
    records = await grist.get_records(table_id)
    if not records:
        return "（无记录，无法聚合）"

    groups: dict[str, list[Any]] = defaultdict(list)
    for r in records:
        fields = r.get("fields", {})
        key = str(fields.get(group_by, "未填写"))
        groups[key].append(fields.get(value_field) if value_field else 1)

    result = []
    for key, vals in sorted(groups.items()):
        if metric == "count":
            val = len(vals)
        elif metric == "sum":
            val = sum(_try_number(v) or 0 for v in vals)
        elif metric == "average":
            nums = [n for n in (_try_number(v) for v in vals) if n is not None]
            val = round(sum(nums) / len(nums), 2) if nums else 0
        else:
            val = len(vals)
        result.append(f"{key}: {val}")

    return "\n".join(result) + f"\n\n共 {len(groups)} 组，{len(records)} 条记录"


async def _do_save_widget(cfg: dict) -> str:
    """调用 A9 后端 API 保存 widget 配置"""
    widget = {
        "type": cfg["type"],
        "title": cfg["title"],
        "tableId": cfg["table_id"],
        "dimension": cfg["dimension"],
        "metric": cfg.get("metric", "count"),
        "valueField": cfg.get("value_field", ""),
    }
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"{A9_API_URL}/api/agent/widgets",
            json={"widget": widget},
            headers={"X-Agent-Token": A9_AGENT_TOKEN},
        )
        resp.raise_for_status()
        data = resp.json()
    return f"已保存 widget「{widget['title']}」到看板。ID: {data.get('id', '?')}"


@server.call_tool()
async def handle_call_tool(
    name: str, arguments: dict | None
) -> list[types.TextContent]:
    args = arguments or {}
    try:
        if name == "list_tables":
            tables = await grist.get_tables()
            lines = [f"- {t['id']}（{t.get('name', t['id'])}）" for t in tables]
            return [types.TextContent(type="text", text="\n".join(lines) or "（无表）")]

        elif name == "get_table_schema":
            cols = await grist.get_columns(args["table_id"])
            lines = [f"- {c['id']}（{c.get('type', '?')}）" for c in cols]
            return [types.TextContent(type="text", text="\n".join(lines) or "（无列）")]

        elif name == "query_records":
            records = await grist.get_records(args["table_id"], args.get("limit", 500))
            ff = args.get("filter_field")
            fv = args.get("filter_value")
            if ff and fv:
                records = [
                    r for r in records
                    if str(r.get("fields", {}).get(ff, "")) == fv
                ]
            text = _records_to_table(records)
            return [types.TextContent(type="text", text=text)]

        elif name == "create_record":
            result = await grist.create_record(args["table_id"], args["fields"])
            return [types.TextContent(type="text", text=f"创建成功: {json.dumps(result, ensure_ascii=False)}")]

        elif name == "update_record":
            result = await grist.update_record(args["table_id"], args["record_id"], args["fields"])
            return [types.TextContent(type="text", text=f"更新成功: {json.dumps(result, ensure_ascii=False)}")]

        elif name == "delete_record":
            result = await grist.delete_record(args["table_id"], args["record_id"])
            return [types.TextContent(type="text", text=f"删除成功: {json.dumps(result, ensure_ascii=False)}")]

        elif name == "aggregate":
            text = await _do_aggregate(
                args["table_id"],
                args["group_by"],
                args.get("metric", "count"),
                args.get("value_field", ""),
            )
            return [types.TextContent(type="text", text=text)]

        elif name == "save_widget":
            text = await _do_save_widget(args)
            return [types.TextContent(type="text", text=text)]

        else:
            return [types.TextContent(type="text", text=f"未知工具: {name}")]

    except Exception as e:
        return [types.TextContent(type="text", text=f"工具执行失败: {e}")]


# ---------- 入口 ----------
async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
