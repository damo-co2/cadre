#!/usr/bin/env python3
"""End-to-end smoke test against a running server (default http://localhost:3123).

Usage: python3 -I scripts/smoke.py [--base URL] [--bot NAME] [--skip-chat]
Chat steps spend model usage on whatever provider the Bot uses; pass --skip-chat for a pure API check.
"""
import argparse, json, sys, time, urllib.error, urllib.request, uuid

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://localhost:3123")
ap.add_argument("--bot", default="Smoke")
ap.add_argument("--skip-chat", action="store_true")
args = ap.parse_args()
BASE = args.base
FAILS = []


def req(method, path, body=None, raw=None, headers=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=headers or {"content-type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=60) as x:
            payload = x.read()
            ct = x.headers.get("content-type", "")
            return x.status, (json.loads(payload) if payload and ct.startswith("application/json") else payload)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}{(' — ' + str(detail)[:160]) if detail else ''}")
    if not ok:
        FAILS.append(name)


def wait_idle(conv, seconds=240):
    for _ in range(seconds // 3):
        _, ms = req("GET", f"/api/conversations/{conv}/messages")
        pending = req("GET", "/api/approvals?status=pending")[1]
        for a in pending:
            req("POST", f"/api/approvals/{a['id']}", {"decision": "allow"})
        forms = req("GET", "/api/secureforms?status=pending")[1]
        for f in forms:
            req("POST", f"/api/secureforms/{f['id']}/fill", {"values": {fld["key"]: "smoke-secret-value" for fld in f["fields"]}})
        if ms and ms[-1]["role"] == "bot" and ms[-1]["status"] != "streaming":
            return ms[-1]
        time.sleep(3)
    return None


# --- health, providers, settings
s, h = req("GET", "/api/health"); check("health", s == 200 and h.get("ok"))
s, providers = req("GET", "/api/providers"); check("providers", s == 200 and len(providers) >= 9, [p["id"] + ":" + p["status"] for p in providers])
s, settings = req("GET", "/api/settings"); check("settings", s == 200 and "defaultModelRef" in settings)

# --- bot
s, bots = req("GET", "/api/bots")
bot = next((b for b in bots if b["name"] == args.bot), None)
created_bot = False
if not bot:
    s, created = req("POST", "/api/bots", {"name": args.bot, "avatarColor": "#06b6d4"}); check("create bot", s == 201)
    bot = created["bot"]
    created_bot = True
s, conv = req("GET", f"/api/bots/{bot['id']}/conversation"); check("direct conversation", s == 200 and conv["kind"] == "direct")
s, screen = req("GET", f"/api/bots/{bot['id']}/computer"); check("computer state", s == 200 and "status" in screen, screen.get("status"))

# --- routines
s, bad = req("POST", f"/api/bots/{bot['id']}/routines", {"name": "x", "instruction": "x", "trigger": {"kind": "schedule", "cron": "* * * * *"}})
check("routine rejects <5 min spacing", s == 400, bad)
s, hook = req("POST", f"/api/bots/{bot['id']}/routines", {"name": "smoke hook", "instruction": "Reply with the trigger data verbatim, nothing else.", "trigger": {"kind": "webhook"}})
check("create webhook routine", s == 201 and hook.get("webhookKey"))
s, _ = req("POST", f"/api/hooks/{hook['id']}", raw=b"{}", headers={"content-type": "application/json"}); check("webhook rejects bad key", s == 401)

# --- vault + csv
s, item = req("POST", "/api/vault", {"kind": "login", "title": "Smoke Login", "website": "https://smoke.test", "username": "u", "password": "p"})
check("vault create hides secret", s == 201 and item["hasSecret"] and "password" not in json.dumps(item))
s, imp = req("POST", "/api/vault/import-csv", {"csv": "name,url,username,password\nA,https://a.test,ua,pa\n"}); check("vault csv import", s == 200 and imp.get("imported") == 1)

# --- uploads
boundary = "----smoke" + uuid.uuid4().hex
body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"note.txt\"\r\nContent-Type: text/plain\r\n\r\nhello smoke\r\n--{boundary}--\r\n").encode()
s, ups = req("POST", "/api/uploads", raw=body, headers={"content-type": f"multipart/form-data; boundary={boundary}"}); check("upload", s == 201 and ups[0]["name"] == "note.txt")
s, dl = req("GET", f"/api/files/{ups[0]['id']}"); check("download", s == 200 and dl == b"hello smoke")

# --- mcp endpoint
s, init = req("POST", f"/mcp/{bot['id']}", {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "smoke", "version": "0"}}}, headers={"content-type": "application/json", "accept": "application/json, text/event-stream"})
check("mcp initialize", s == 200 and b"cadre-computer" in (init if isinstance(init, bytes) else json.dumps(init).encode()))

# --- chat
if not args.skip_chat:
    s, _ = req("POST", f"/api/conversations/{conv['id']}/messages", {"content": "Reply with exactly the word pong."}); check("send message", s == 201)
    reply = wait_idle(conv["id"]); check("bot replies", bool(reply) and reply["status"] == "done" and "pong" in reply["content"].lower(), reply and (reply["content"] or reply.get("error")))
    s, _ = req("POST", f"/api/hooks/{hook['id']}", raw=b'{"smoke":true}', headers={"content-type": "application/json", "authorization": f"Bearer {hook['webhookKey']}"}); check("webhook accepted", s == 200)
    reply = wait_idle(conv["id"]); check("webhook run replied", bool(reply) and "smoke" in reply["content"].lower(), reply and reply["content"])
    s, _ = req("POST", f"/api/conversations/{conv['id']}/messages", {"content": "Write a file smoke.txt in your workspace containing OK and tell me when done.", "attachmentIds": [ups[0]["id"]]})
    reply = wait_idle(conv["id"]); check("file result card", bool(reply) and any(p["type"] == "file" for p in reply["parts"]), reply and [p["type"] for p in reply["parts"]])

# --- templates, task board, phone access (no model usage)
s, cat = req("GET", "/api/templates")
check("templates catalog", s == 200 and len(cat["bots"]) >= 10 and len(cat["squads"]) >= 3, s == 200 and f"{len(cat['bots'])} bots")
check("chief template is primary", s == 200 and any(t.get("primary") for t in cat["bots"]))
s, made = req("POST", "/api/templates/archivist/create", {"name": f"SmokeArchie{uuid.uuid4().hex[:4]}", "introduce": False, "makePrimary": False})
check("create from template", s == 201 and made["bot"]["brief"] and len(made["routines"]) == 1, s)
if s == 201:
    check("template routine armed", bool(made["routines"][0]["nextRunAt"]), made["routines"][0]["nextRunAt"])
    check("template bot not primary", made["bot"]["isPrimary"] is False)
s, task = req("POST", "/api/tasks", {"title": "Smoke task", "detail": "nothing"})
check("task create", s == 201 and task["status"] == "open", s)
s, task2 = req("PATCH", f"/api/tasks/{task['id']}", {"status": "done", "result": "ok"})
check("task update", s == 200 and task2["status"] == "done" and task2["result"] == "ok", s)
s, open_tasks = req("GET", "/api/tasks")
check("closed task hidden by default", s == 200 and all(t["id"] != task["id"] for t in open_tasks))
req("DELETE", f"/api/tasks/{task['id']}")
s, acc = req("GET", "/api/access")
check("phone access info", s == 200 and "token=" in acc["url"] and acc["qrSvg"].startswith("<svg"), s)
s, _ = req("GET", "/api/bots", headers={"host": "evil.example"})
check("foreign host refused", s == 403, s)

# --- spaces (Work / Personal): own Bots, own lead, own default model
s, spaces = req("GET", "/api/spaces")
check("spaces exist (Work, Personal by default)", s == 200 and len(spaces) >= 2, s == 200 and [x["name"] for x in spaces])
s, side = req("POST", "/api/spaces", {"name": "Smoke space", "emoji": "🧪"})
check("create space", s == 201 and side["name"] == "Smoke space", s)
s, side2 = req("PATCH", f"/api/spaces/{side['id']}", {"defaultModelRef": "codex:gpt-5.6-sol"})
check("space default model saved", s == 200 and side2["defaultModelRef"] == "codex:gpt-5.6-sol", s)
s, sb = req("POST", "/api/bots", {"name": "SmokeSpaceBot", "spaceId": side["id"]})
check("bot created in a chosen space", s == 201 and sb["bot"]["spaceId"] == side["id"] and not sb["bot"]["isPrimary"], s)
s, chief = req("POST", "/api/templates/chief-of-staff/create", {"introduce": False, "withRoutines": False, "spaceId": side["id"], "name": "SmokeChief"})
check("Chief template leads its own space", s == 201 and chief["bot"]["spaceId"] == side["id"] and chief["bot"]["isPrimary"], s)
s, allbots = req("GET", "/api/bots")
other_leads = [b for b in allbots if b["isPrimary"] and b["spaceId"] != side["id"]]
before_leads = {b["id"] for b in allbots if b["isPrimary"]}
check("other spaces keep their own lead", all(b["isPrimary"] for b in other_leads))
s, moved = req("PATCH", f"/api/bots/{sb['bot']['id']}", {"spaceId": spaces[0]["id"]})
check("moving a Bot never makes it lead", s == 200 and moved["spaceId"] == spaces[0]["id"] and not moved["isPrimary"], s)
s, _ = req("DELETE", f"/api/spaces/{side['id']}")
check("space with Bots can't be deleted", s == 400, s)
s, overview = req("POST", f"/mcp/{chief['bot']['id']}", {"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": "team_overview", "arguments": {}}}, headers={"content-type": "application/json", "accept": "application/json, text/event-stream"})
ov = overview if isinstance(overview, (bytes, str)) else json.dumps(overview)
ov = ov.decode() if isinstance(ov, bytes) else ov
check("Chief's team view is only its space", "SmokeChief" in ov and "SmokeSpaceBot" not in ov, ov[:200])
req("DELETE", f"/api/bots/{sb['bot']['id']}")
req("DELETE", f"/api/bots/{chief['bot']['id']}")
s, _ = req("DELETE", f"/api/spaces/{side['id']}")
check("empty space can be deleted", s == 204, s)

# --- default model: space default → app default → automatic; turned-off defaults are skipped
s, before = req("GET", "/api/settings")
s, d0 = req("GET", "/api/settings/default-model")
check("default model endpoint", s == 200 and ":" in d0["modelRef"] and d0["source"] in ("app", "auto"), d0)
req("PUT", "/api/settings", {"defaultModelRef": "codex:gpt-5.6-sol"})
s, d1 = req("GET", "/api/settings/default-model")
check("app default is used", d1["modelRef"] == "codex:gpt-5.6-sol" and d1["source"] == "app", d1)
s, sp = req("GET", "/api/spaces")
req("PATCH", f"/api/spaces/{sp[1]['id']}", {"defaultModelRef": "gemini-cli:gemini-2.5-pro"})
s, d2 = req("GET", f"/api/settings/default-model?spaceId={sp[1]['id']}")
check("space default beats app default", d2["modelRef"] == "gemini-cli:gemini-2.5-pro" and d2["source"] == "space", d2)
req("PUT", "/api/providers/gemini-cli", {"disabled": True})
s, d3 = req("GET", f"/api/settings/default-model?spaceId={sp[1]['id']}")
check("turned-off default is skipped", d3["modelRef"] == "codex:gpt-5.6-sol" and d3["source"] == "app", d3)
req("PUT", "/api/providers/gemini-cli", {"disabled": False})
req("PATCH", f"/api/spaces/{sp[1]['id']}", {"defaultModelRef": None})
req("PUT", "/api/settings", {"defaultModelRef": before["defaultModelRef"]})

# --- About you: the user's profile (add, scope to a space, edit, forget; Bots get the tools)
s, sp = req("GET", "/api/spaces")
s, f1 = req("POST", "/api/profile", {"text": "Smoke: likes flat whites", "category": "likes"})
check("add a fact about you", s == 201 and f1["source"] == "you" and f1["spaceId"] is None and f1["category"] == "likes", s)
s, f2 = req("POST", "/api/profile", {"text": "Smoke: standup 9:30 weekdays", "category": "routines", "spaceId": sp[0]["id"]})
check("add a fact for one space", s == 201 and f2["spaceId"] == sp[0]["id"], s)
s, _ = req("POST", "/api/profile", {"text": "x", "category": "likes", "spaceId": "nope"})
check("unknown space refused", s == 400, s)
s, f1b = req("PATCH", f"/api/profile/{f1['id']}", {"text": "Smoke: likes long blacks", "spaceId": sp[1]["id"]})
check("edit a fact", s == 200 and f1b["text"] == "Smoke: likes long blacks" and f1b["spaceId"] == sp[1]["id"], s)
s, allf = req("GET", "/api/profile")
check("profile lists facts", s == 200 and {f1["id"], f2["id"]} <= {f["id"] for f in allf}, s)
s, tl = req("POST", f"/mcp/{bot['id']}", {"jsonrpc": "2.0", "id": 11, "method": "tools/list", "params": {}}, headers={"content-type": "application/json", "accept": "application/json, text/event-stream"})
tl = tl.decode() if isinstance(tl, bytes) else json.dumps(tl)
check("Bots get remember/forget tools", "remember_about_user" in tl and "forget_about_user" in tl)
s, st = req("PUT", "/api/settings", {"learnAboutMe": False})
check("learning can be paused", s == 200 and st["learnAboutMe"] is False, s)
req("PUT", "/api/settings", {"learnAboutMe": True})
for f in (f1, f2):
    s, _ = req("DELETE", f"/api/profile/{f['id']}")
check("forget a fact", s == 204, s)

# --- cleanup
if "made" in dir() and isinstance(made, dict) and made.get("bot"):
    req("DELETE", f"/api/bots/{made['bot']['id']}")
req("DELETE", f"/api/routines/{hook['id']}")
req("DELETE", f"/api/vault/{item['id']}")
for v in req("GET", "/api/vault")[1]:
    if v["title"] in ("A", "a.test"):
        req("DELETE", f"/api/vault/{v['id']}")
if created_bot:
    req("DELETE", f"/api/bots/{bot['id']}")

print()
print("ALL PASS" if not FAILS else f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
sys.exit(1 if FAILS else 0)
