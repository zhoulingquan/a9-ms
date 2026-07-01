#!/usr/bin/env python3
"""测试 Munchkin 生成 4 种图表(metric/bar/pie/line)的完整链路。

WS 协议:
  1. 连接 → 收到 {"event":"ready","chat_id":"...","client_id":"..."}
  2. 发送 {"type":"message","chat_id":"...","content":"..."}
  3. 接收流: reasoning_delta / delta / tool_call_hint / stream_end / turn_end
  4. turn_end 即一轮完成
"""
import asyncio
import json
import time
import urllib.request
import urllib.parse
import websockets

def log(*args, **kwargs):
    print(*args, **kwargs, flush=True)

A9_URL = "http://localhost:3000"
WS_PROXY_URL = "ws://localhost:3000/api/agent/ws"
EMAIL = "admin@a9.com"
PASSWORD = "admin"

TEST_CASES = [
    {"name": "metric - 指标卡(客户总数)", "prompt": "请帮我统计所有客户总数,用指标卡片形式添加到看板"},
    {"name": "bar - 柱状图(各区域客户数)", "prompt": "帮我做一个柱状图,展示各区域客户数量对比,添加到看板"},
    {"name": "pie - 饼图(客户级别分布)", "prompt": "帮我做一个饼图,展示不同客户级别的分布占比,加到看板"},
    {"name": "line - 折线图(各区域项目数)", "prompt": "帮我做一个折线图,展示各区域的项目数量趋势,加到看板"},
]


def http_req(method, path, cookie=None, body=None):
    url = A9_URL + path
    headers = {"Content-Type": "application/json"}
    if cookie:
        headers["Cookie"] = cookie
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            set_cookies = resp.headers.get_all("Set-Cookie") or []
            return resp.status, resp.read().decode(), set_cookies
    except urllib.error.HTTPError as e:
        set_cookies = e.headers.get_all("Set-Cookie") or []
        return e.code, e.read().decode(), set_cookies


def login_and_get_cookie():
    status, body, set_cookies = http_req("POST", "/api/auth/login", body={"email": EMAIL, "password": PASSWORD})
    if status != 200:
        raise RuntimeError(f"登录失败: {status} {body}")
    parts = []
    for sc in set_cookies:
        kv = sc.split(";")[0].strip()
        if kv.startswith("connect.sid=") or kv.startswith("grist_core="):
            parts.append(kv)
    if not parts:
        raise RuntimeError(f"cookie 未找到: {set_cookies}")
    return "; ".join(parts)


def get_ws_token(cookie):
    status, body, _ = http_req("GET", "/api/agent/bootstrap", cookie=cookie)
    if status != 200:
        raise RuntimeError(f"bootstrap 失败: {status} {body}")
    return json.loads(body)["token"]


async def recv_until_ready(ws, timeout=10):
    """接收 ready 事件,返回 chat_id"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        raw = await asyncio.wait_for(ws.recv(), timeout=deadline - time.time())
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if msg.get("event") == "ready":
            return msg.get("chat_id"), msg.get("client_id")
    raise RuntimeError("未收到 ready 事件")


async def send_and_wait(ws, chat_id, prompt, timeout=180):
    """发送消息并等待 turn_end"""
    user_msg = {"type": "message", "chat_id": chat_id, "content": prompt}
    await ws.send(json.dumps(user_msg))
    responses = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=min(30, deadline - time.time()))
        except asyncio.TimeoutError:
            continue
        except websockets.exceptions.ConnectionClosed:
            break
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue
        responses.append(msg)
        event = msg.get("event") or msg.get("type", "")
        # turn_end 是一轮完成的信号
        if event == "turn_end":
            break
        if event == "error":
            log(f"  [错误] {msg}")
            break
    return responses


def extract_tool_info(responses):
    """从响应中提取工具调用和 save_widget 参数"""
    tool_calls = []
    save_widget_args = []
    final_reply_parts = []
    for msg in responses:
        event = msg.get("event") or msg.get("type", "")
        # delta 是流式文本
        if event in ("delta", "message") and msg.get("role") == "assistant":
            final_reply_parts.append(msg.get("content", ""))
        # tool_call_hint 包含工具调用信息
        if event == "tool_call_hint":
            tc = msg.get("tool_call", {})
            name = tc.get("name", "")
            args_raw = tc.get("arguments", {})
            tool_calls.append({"name": name, "args": args_raw})
            if name == "save_widget":
                save_widget_args.append(args_raw)
    return {
        "tool_calls": tool_calls,
        "save_widget_args": save_widget_args,
        "reply": "".join(final_reply_parts),
    }


async def main():
    log("=" * 60)
    log("Munchkin 图表生成测试")
    log("=" * 60)

    log("\n[1] 登录 A9...")
    cookie = login_and_get_cookie()
    log(f"  OK, cookie: {cookie[:30]}...")

    log("\n[2] 获取 WS token...")
    token = get_ws_token(cookie)
    log(f"  OK, token: {token[:30]}...")

    log("\n[3] 连接 WebSocket...")
    ws_url = f"{WS_PROXY_URL}?token={urllib.parse.quote(token)}"
    ws_headers = {"Cookie": cookie}

    all_results = []
    async with websockets.connect(ws_url, max_size=50 * 1024 * 1024, additional_headers=ws_headers) as ws:
        log("  已连接,等待 ready...")
        chat_id, client_id = await recv_until_ready(ws)
        log(f"  ready: chat_id={chat_id[:8]}..., client_id={client_id[:8]}...")

        for i, case in enumerate(TEST_CASES, 1):
            log(f"\n[4.{i}] 测试: {case['name']}")
            log(f"  Prompt: {case['prompt']}")

            t0 = time.time()
            responses = await send_and_wait(ws, chat_id, case["prompt"])
            elapsed = time.time() - t0

            info = extract_tool_info(responses)
            events = [m.get("event") or m.get("type", "?") for m in responses]

            result = {
                "case": case["name"],
                "elapsed": round(elapsed, 1),
                "resp_count": len(responses),
                "tool_count": len(info["tool_calls"]),
                "save_count": len(info["save_widget_args"]),
                "save_args": info["save_widget_args"],
                "reply": info["reply"][:300],
                "events": events,
            }
            all_results.append(result)

            log(f"  耗时: {elapsed:.1f}s, 响应数: {len(responses)}")
            log(f"  事件流: {events}")
            log(f"  工具调用: {len(info['tool_calls'])} 次")
            for tc in info["tool_calls"]:
                log(f"    - {tc['name']}")
            log(f"  save_widget: {len(info['save_widget_args'])} 次")
            for args in info["save_widget_args"]:
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except Exception:
                        pass
                if isinstance(args, dict):
                    log(f"    type={args.get('type')}, title={args.get('title')}, table={args.get('table_id')}, dim={args.get('dimension')}")
                else:
                    log(f"    raw: {str(args)[:200]}")
            if info["reply"]:
                log(f"  回复: {info['reply'][:200]}")
            await asyncio.sleep(2)

    # 检查后端 widget
    log("\n[5] 检查后端 widget...")
    status, body, _ = http_req("GET", "/api/dashboard-widgets", cookie=cookie)
    if status == 200:
        try:
            data = json.loads(body)
            wl = data.get("widgets", []) if isinstance(data, dict) else (data if isinstance(data, list) else [])
            log(f"  后端 widget 总数: {len(wl)}")
            agent_widgets = [w for w in wl if str(w.get("id", "")).startswith("agent_")]
            log(f"  Agent 生成的 widget: {len(agent_widgets)}")
            for w in agent_widgets:
                log(f"    type={w.get('type')}, title={w.get('title')}, table={w.get('tableId')}, dim={w.get('dimension')}")
        except Exception as e:
            log(f"  解析失败: {e}")
    else:
        log(f"  获取失败: {status}")

    # 总结
    log("\n" + "=" * 60)
    log("测试总结")
    log("=" * 60)
    ok = sum(1 for r in all_results if r["save_count"] > 0)
    log(f"图表生成成功: {ok}/{len(all_results)}")
    for r in all_results:
        s = "PASS" if r["save_count"] > 0 else "FAIL"
        log(f"  [{s}] {r['case']} ({r['elapsed']}s, {r['tool_count']} 工具调用)")


if __name__ == "__main__":
    asyncio.run(main())
