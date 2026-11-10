"""End-to-end test with real model turns: run before every install.

Starts a fresh Cadre server and a fake OAuth app (scripts/e2e/mock-app.mts), then checks the flows
the user relies on: app sign-in, app tool calls with their inputs, read-only vs approval-gated app
tools, Chief delegation (hire / task to a Bot, never doing app work itself), Stop, cleanup of
replies cut off by a restart, and the API smoke suite.

    python3 -I scripts/e2e.py [--model codex:gpt-6.1-sol] [--keep]

Spends a few model turns on the chosen subscription. Exit code 0 only if every check passes.
"""
import argparse, json, os, shutil, signal, subprocess, sys, tempfile, time, urllib.error, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TSX = os.path.join(ROOT, "node_modules", ".bin", "tsx")
ap = argparse.ArgumentParser()
ap.add_argument("--model", default="codex:gpt-6.1-sol")
ap.add_argument("--port", type=int, default=3199)
ap.add_argument("--mock-port", type=int, default=4560)
ap.add_argument("--keep", action="store_true", help="keep the temp data dir")
args = ap.parse_args()
B = f"http://localhost:{args.port}"
data = tempfile.mkdtemp(prefix="cadre-e2e-")
call_log = os.path.join(data, "mock-calls.jsonl")
procs = []
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""), flush=True)
    return ok


def req(path, body=None, method=None, timeout=60):
    r = urllib.request.Request(B + path, data=json.dumps(body).encode() if body is not None else None,
                               method=method or ("POST" if body is not None else "GET"), headers={"content-type": "application/json"})
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else None


def start_server():
    env = dict(os.environ, PORT=str(args.port), DATA_DIR=data, SERVER_URL=B)
    p = subprocess.Popen([TSX, "src/index.ts"], cwd=os.path.join(ROOT, "apps", "server"), env=env,
                         stdout=open(os.path.join(data, "server.log"), "a"), stderr=subprocess.STDOUT, start_new_session=True)
    procs.append(p)
    for _ in range(80):
        try:
            req("/api/health", timeout=2)
            return p
        except Exception:
            time.sleep(0.5)
    raise SystemExit("server did not start; see " + os.path.join(data, "server.log"))


def stop_proc(p):
    try:
        os.killpg(p.pid, signal.SIGTERM)
        p.wait(timeout=10)
    except Exception:
        pass


def messages(conv):
    return req(f"/api/conversations/{conv}/messages")


def wait_turn(conv, before, timeout=240):
    """Wait for a bot reply newer than `before` messages to finish; returns it."""
    end = time.time() + timeout
    while time.time() < end:
        ms = messages(conv)
        bots = [m for m in ms[before:] if m["role"] == "bot"]
        if bots and all(m["status"] != "streaming" for m in bots):
            return bots[-1]
        time.sleep(2)
    return None


def say(conv, text):
    before = len(messages(conv))
    req(f"/api/conversations/{conv}/messages", {"content": text, "attachmentIds": []})
    return before


def calls(tool=None):
    if not os.path.exists(call_log):
        return []
    rows = [json.loads(l) for l in open(call_log) if l.strip()]
    return [r for r in rows if tool is None or r["tool"] == tool]


def tool_names(msg):
    return [p["name"] for p in msg.get("parts", []) if p["type"] == "tool-call"]


def cadre_codex_procs():
    out = subprocess.run(["pgrep", "-f", "skip-git-repo-check"], capture_output=True, text=True).stdout.split()
    return [x for x in out if x != str(os.getpid())]


try:
    mock = subprocess.Popen([TSX, os.path.join(ROOT, "scripts", "e2e", "mock-app.mts")], cwd=ROOT,
                            env=dict(os.environ, MOCK_PORT=str(args.mock_port), CALL_LOG=call_log),
                            stdout=open(os.path.join(data, "mock.log"), "a"), stderr=subprocess.STDOUT, start_new_session=True)
    procs.append(mock)
    time.sleep(3)
    server = start_server()
    print(f"e2e: model {args.model}, data {data}", flush=True)
    # Match the user's setup: other subscriptions off, so Bots the Chief hires use the same provider.
    for pid in ("claude-code", "codex", "gemini-cli"):
        if not args.model.startswith(pid + ":"):
            req(f"/api/providers/{pid}", {"disabled": True}, method="PUT")

    # 1. App sign-in (OAuth + dynamic registration), like Jira.
    c = req("/api/connectors", {"name": "mockapp", "label": "Mock App", "transport": "http", "url": f"http://localhost:{args.mock_port}/mcp"})
    check("app asks for browser sign-in", c["status"] == "needs-auth" and c.get("authUrl"), c["status"])
    if c.get("authUrl"):
        urllib.request.urlopen(c["authUrl"], timeout=30).read()  # the "browser" follows sign-in and comes back
    c = next(x for x in req("/api/connectors") if x["name"] == "mockapp")
    check("app connected after sign-in", c["status"] == "connected" and len(c["tools"]) == 2, f'{c["status"]}, {len(c["tools"])} tools')

    # The Chief is the user's lead Bot, so it is created first (the first Bot becomes the lead).
    chief = req("/api/templates/chief-of-staff/create", {"introduce": False, "withRoutines": False, "makePrimary": True, "modelRef": args.model})
    cconv = chief["conversation"]["id"]
    check("Chief is the lead Bot", req(f"/api/bots/{chief['bot']['id']}")["isPrimary"] if True else False)

    # 2. A worker Bot calls a read-only app tool with its input; no approval needed.
    w = req("/api/bots", {"name": "Tester", "modelRef": args.model})
    wconv = w["conversation"]["id"]
    n = say(wconv, "Use the Mock App search_items tool with query \"blue widget\", then tell me the item IDs it returned.")
    r = wait_turn(wconv, n)
    got = [x["args"].get("query", "") for x in calls("search_items")]
    check("app tool received its input", any("blue widget" in q.lower() for q in got), f"queries seen: {got}")
    check("read-only app tool ran without approval", not any(a["toolName"].endswith("search_items") for a in req("/api/approvals?status=allowed") + req("/api/approvals?status=pending")) if r else False)
    check("worker replied with the result", r and r["status"] == "done" and "ITEM-7" in r["content"], (r or {}).get("content", "")[:120])

    # 3. A tool that changes data waits for approval, then runs after Allow.
    n = say(wconv, "Use the Mock App create_item tool to create an item titled \"Alpha\".")
    pending = None
    for _ in range(90):
        pend = [a for a in req("/api/approvals?status=pending") if a["toolName"].endswith("create_item")]
        if pend:
            pending = pend[0]
            break
        time.sleep(2)
    check("data-changing app tool asks for approval", pending is not None)
    if pending:
        req(f"/api/approvals/{pending['id']}", {"decision": "allow"})
    r = wait_turn(wconv, n)
    check("approved app tool ran with its input", any(x["args"].get("title") == "Alpha" for x in calls("create_item")), str(calls("create_item")))

    # 4. The Chief delegates: no app tools of its own; hands work to a Bot and relays the answer.
    n = say(cconv, "Search our Mock App for \"red lamp\" and tell me what it finds.")
    r = wait_turn(cconv, n)
    names = [t for m in messages(cconv)[n:] if m["role"] == "bot" for t in tool_names(m)]
    check("Chief did not call the app itself", r and not any("mockapp" in t or t.startswith("browser_") for t in names), str(names))
    check("Chief handed the work to a Bot", any(t in ("task_create", "bot_hire") for t in names), str(names))
    deadline = time.time() + 300
    while time.time() < deadline and not any("red lamp" in x["args"].get("query", "").lower() for x in calls("search_items")):
        time.sleep(3)
    check("a Bot ran the app search for the Chief", any("red lamp" in x["args"].get("query", "").lower() for x in calls("search_items")))
    relayed = None
    while time.time() < deadline and not relayed:
        ms = messages(cconv)
        relayed = next((m for m in ms[n:] if m["role"] == "bot" and m["status"] == "done" and "ITEM-7" in m["content"]), None)
        time.sleep(3)
    check("Chief relayed the Bot's result", relayed is not None, (relayed or {}).get("content", "")[:120])
    time.sleep(10)
    relays = [m for m in messages(cconv)[n:] if m["role"] == "bot" and "ITEM-7" in m["content"]]
    check("Chief relayed it once, not twice", len(relays) == 1, f"{len(relays)} replies carried the result")
    check("Chief did not poll while waiting", not any(t in ("task_list", "bot_read") for t in names), str(names))

    # 5. Hiring on request.
    n = say(cconv, "Hire a Deal Hunter to watch Australian Black Friday deals on electronics. Do it now.")
    r = wait_turn(cconv, n)
    hired = [b for b in req("/api/bots") if b.get("hiredBy")]
    check("Chief hired a Bot when asked", any("deal" in (b["label"] or b["name"]).lower() for b in hired), str([(b["name"], b["label"]) for b in hired]))

    # 6. Stop ends a running reply fast and kills the model process.
    s = req("/api/bots", {"name": "Stoppy", "modelRef": args.model})
    sconv = s["conversation"]["id"]
    before_pids = set(cadre_codex_procs())
    say(sconv, "Write a 2000-word essay about tides, in detail.")
    time.sleep(8)
    turn_pids = set(cadre_codex_procs()) - before_pids
    t0 = time.time()
    req(f"/api/conversations/{sconv}/stop", {})
    st = None
    while time.time() - t0 < 5:
        bots = [m for m in messages(sconv) if m["role"] == "bot"]
        st = bots[-1]["status"] if bots else None
        if st and st != "streaming":
            break
        time.sleep(0.3)
    check("Stop ends the reply", st == "stopped", f"{st} after {time.time() - t0:.1f}s")
    time.sleep(2)
    left = turn_pids & set(cadre_codex_procs())
    check("Stop ends the model process", not left, f"{len(turn_pids)} started, {len(left)} still running")

    # 7. A reply cut off by a restart is cleaned up, and Stop clears one when nothing runs.
    say(sconv, "Write another long essay about the moon.")
    time.sleep(6)
    stop_proc(server)
    procs.remove(server)
    server = start_server()
    bots = [m for m in messages(sconv) if m["role"] == "bot"]
    check("restart marks a cut-off reply stopped", bots and all(m["status"] != "streaming" for m in bots), str([m["status"] for m in bots]))

    # 8. API regression suite.
    smoke = subprocess.run([sys.executable, "-I", os.path.join(ROOT, "scripts", "smoke.py"), "--base", B, "--skip-chat"], capture_output=True, text=True)
    check("API smoke suite", "ALL PASS" in smoke.stdout, smoke.stdout.strip().splitlines()[-1] if smoke.stdout.strip() else smoke.stderr[-200:])
finally:
    for p in procs:
        stop_proc(p)
    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed" + (f"; FAILED: {', '.join(failed)}" if failed else ""))
    if args.keep or failed:
        print("data kept at", data)
    else:
        shutil.rmtree(data, ignore_errors=True)
    sys.exit(1 if failed or not results else 0)
