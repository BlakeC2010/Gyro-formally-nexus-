#!/usr/bin/env python3
"""Coder - AI Coding Agent powered by Gemma 4"""

import os, sys, json, time, re, subprocess, uuid, mimetypes, traceback
from pathlib import Path
from flask import (Flask, request, jsonify, send_from_directory,
                   Response, stream_with_context)

# ── Configuration ────────────────────────────────────────────────────────────
APP_DIR   = Path(__file__).parent.resolve()
CFG_FILE  = APP_DIR / ".coder_config.json"
DATA_DIR  = APP_DIR / ".coder_data"
CHATS_DIR = DATA_DIR / "chats"

MODELS = {
    "gemma-4-31b-it":      {"label": "Gemma 4 31B",      "desc": "Dense 31B · 256K context"},
    "gemma-4-26b-a4b-it":  {"label": "Gemma 4 26B MoE",  "desc": "MoE · 4B active params"},
    "gemini-2.5-flash":    {"label": "Gemini 2.5 Flash",  "desc": "Fast & capable"},
    "gemini-2.5-pro":      {"label": "Gemini 2.5 Pro",    "desc": "Most capable Gemini"},
}

IGNORE_DIRS  = {'.git','__pycache__','node_modules','.venv','venv',
                '.next','dist','build','.cache','.coder_data','__MACOSX',
                '.eggs','*.egg-info','.tox','.mypy_cache','.pytest_cache'}
IGNORE_FILES = {'.DS_Store','Thumbs.db','.env'}

DANGEROUS_CMD = [
    r'\brm\s+-r',r'\brmdir\s+/s',r'\bdel\s+/[sfq]',r'\bformat\b',
    r'\bdrop\s+(database|table)',r'\bshutdown\b',r'\bmkfs\b',
    r'\bdd\s+if=',r'>\s*/dev/sd',r'\breg\s+delete\b',
]

# ── Flask ────────────────────────────────────────────────────────────────────
app = Flask(__name__, static_folder="static")
app.secret_key = os.urandom(32)

# ── Config helpers ───────────────────────────────────────────────────────────
def load_config():
    if CFG_FILE.exists():
        try: return json.loads(CFG_FILE.read_text("utf-8"))
        except Exception: pass
    return {"api_key":"","model":"gemma-4-31b-it","mode":"auto","project_path":""}

def save_config(cfg):
    CFG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CFG_FILE.write_text(json.dumps(cfg, indent=2), "utf-8")

# ── Path security ────────────────────────────────────────────────────────────
def _safe(root, rel):
    """Resolve *rel* inside *root*; raise on escape."""
    r = Path(root).resolve()
    t = (r / rel).resolve()
    if not str(t).startswith(str(r)):
        raise ValueError("Path traversal blocked")
    return t

# ── File helpers ─────────────────────────────────────────────────────────────
def list_dir(root, rel="."):
    t = _safe(root, rel)
    if not t.is_dir():
        return {"error": f"Not a directory: {rel}"}
    items = []
    for p in sorted(t.iterdir(), key=lambda x: (x.is_file(), x.name.lower())):
        if p.is_dir() and p.name in IGNORE_DIRS: continue
        if p.is_file() and p.name in IGNORE_FILES: continue
        items.append({
            "name": p.name,
            "path": str(p.relative_to(Path(root).resolve())).replace("\\","/"),
            "type": "dir" if p.is_dir() else "file",
        })
    return {"items": items}

def read_file(root, rel):
    t = _safe(root, rel)
    if not t.is_file(): return {"error": f"Not found: {rel}"}
    try:
        return {"content": t.read_text("utf-8", errors="replace"),
                "path": rel, "size": t.stat().st_size}
    except Exception as e:
        return {"error": str(e)}

def write_file(root, rel, content):
    t = _safe(root, rel)
    t.parent.mkdir(parents=True, exist_ok=True)
    t.write_text(content, "utf-8")
    return {"ok": True, "path": rel}

def edit_file(root, rel, find, replace):
    t = _safe(root, rel)
    if not t.is_file(): return {"error": f"Not found: {rel}"}
    src = t.read_text("utf-8")
    if find not in src:
        return {"error": f"Text not found in {rel}"}
    t.write_text(src.replace(find, replace, 1), "utf-8")
    return {"ok": True, "path": rel}

def delete_path(root, rel):
    t = _safe(root, rel)
    if t == Path(root).resolve():
        return {"error": "Cannot delete project root"}
    if t.is_file():
        t.unlink()
    elif t.is_dir():
        import shutil; shutil.rmtree(t)
    else:
        return {"error": f"Not found: {rel}"}
    return {"ok": True, "path": rel}

def search_text(root, query, rel="."):
    base = Path(root).resolve()
    t = _safe(root, rel)
    hits = []
    for p in t.rglob("*"):
        if not p.is_file(): continue
        if any(d in p.parts for d in IGNORE_DIRS): continue
        try:
            for i, ln in enumerate(p.read_text("utf-8","ignore").splitlines(), 1):
                if query.lower() in ln.lower():
                    hits.append({"file": str(p.relative_to(base)).replace("\\","/"),
                                 "line": i, "text": ln.strip()[:200]})
                    if len(hits) >= 60: return {"results": hits, "truncated": True}
        except Exception: pass
    return {"results": hits, "truncated": False}

# ── Terminal ─────────────────────────────────────────────────────────────────
def run_cmd(root, cmd, timeout=120):
    for pat in DANGEROUS_CMD:
        if re.search(pat, cmd, re.I):
            return {"error": f"Blocked dangerous command", "blocked": True}
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                           cwd=root, timeout=timeout,
                           env={**os.environ, "PYTHONIOENCODING":"utf-8"})
        return {"stdout": (r.stdout or "")[-12000:],
                "stderr": (r.stderr or "")[-6000:],
                "code": r.returncode}
    except subprocess.TimeoutExpired:
        return {"error": f"Timed out ({timeout}s)", "code": -1}
    except Exception as e:
        return {"error": str(e), "code": -1}

# ── Project tree ─────────────────────────────────────────────────────────────
def build_tree(root, max_depth=3, max_files=120):
    base = Path(root).resolve()
    lines, count = [], [0]
    def walk(d, pre="", depth=0):
        if depth > max_depth or count[0] > max_files: return
        try: entries = sorted(d.iterdir(), key=lambda x: (x.is_file(), x.name.lower()))
        except PermissionError: return
        dirs  = [e for e in entries if e.is_dir()  and e.name not in IGNORE_DIRS]
        files = [e for e in entries if e.is_file() and e.name not in IGNORE_FILES]
        all_items = dirs + files
        for i, item in enumerate(all_items):
            last = (i == len(all_items)-1)
            conn = "└── " if last else "├── "
            suffix = "/" if item.is_dir() else ""
            lines.append(f"{pre}{conn}{item.name}{suffix}")
            count[0] += 1
            if item.is_dir():
                walk(item, pre + ("    " if last else "│   "), depth+1)
    walk(base)
    return "\n".join(lines) if lines else "(empty project)"

# ── Conversation persistence ─────────────────────────────────────────────────
def _conv_path(cid):
    return CHATS_DIR / f"{cid}.json"

def list_convs():
    CHATS_DIR.mkdir(parents=True, exist_ok=True)
    convs = []
    for f in sorted(CHATS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            d = json.loads(f.read_text("utf-8"))
            convs.append({"id": d["id"], "title": d.get("title","Untitled"),
                          "updated": d.get("updated",0)})
        except Exception: pass
    return convs

def load_conv(cid):
    p = _conv_path(cid)
    if p.exists():
        return json.loads(p.read_text("utf-8"))
    return None

def save_conv(conv):
    CHATS_DIR.mkdir(parents=True, exist_ok=True)
    conv["updated"] = time.time()
    _conv_path(conv["id"]).write_text(json.dumps(conv, ensure_ascii=False), "utf-8")

def delete_conv(cid):
    p = _conv_path(cid)
    if p.exists(): p.unlink()

def new_conv():
    c = {"id": uuid.uuid4().hex[:12], "title":"New Chat",
         "messages":[], "model_history":[], "created": time.time(), "updated": time.time()}
    save_conv(c)
    return c

# ── Agent system prompt ──────────────────────────────────────────────────────
MODE_INSTRUCTIONS = {
    "auto": (
        "You are in AUTO mode. Execute tools immediately as needed to accomplish the task. "
        "Act decisively and efficiently. Do not ask for permission — just do the work."
    ),
    "ask": (
        "You are in ASK mode. Before executing ANY tool, describe exactly what you plan to do "
        "and why. List the specific files you'll change and commands you'll run. Then STOP and "
        "wait for the user to say 'go ahead', 'yes', 'do it', or similar before proceeding. "
        "If the user hasn't approved yet, do NOT output any <tool_call> blocks."
    ),
    "plan": (
        "You are in PLAN mode. First, create a comprehensive numbered plan listing ALL changes "
        "needed — every file to create/edit, every command to run, and why. Present the full plan. "
        "STOP and wait for the user to approve. Only after explicit approval, execute the "
        "entire plan step by step."
    ),
}

def build_system_prompt(project_path, mode, project_tree=""):
    return f"""You are **Coder**, an expert AI coding agent built for software development. You think step-by-step, write clean code, and use tools to interact with the user's project.

## TOOLS
Use these tools by outputting a tool_call block. Use EXACTLY this format:

<tool_call>
{{"name": "tool_name", "args": {{"param": "value"}}}}
</tool_call>

Available tools:

| Tool | Args | Description |
|------|------|-------------|
| read_file | path | Read a file's contents |
| write_file | path, content | Create or overwrite a file |
| edit_file | path, find, replace | Find-and-replace in a file (first match) |
| run_command | command | Run a shell command |
| list_dir | path (default ".") | List directory contents |
| search | query, path (default ".") | Search text across files |
| delete | path | Delete a file or directory |

## RULES
1. **Always read before editing.** Never guess file contents — use read_file first.
2. **Minimal edits.** Use edit_file for targeted changes. Only use write_file for new files or full rewrites.
3. **Explain your reasoning.** Before acting, briefly explain what you're doing and why.
4. **Test when possible.** After making changes, run tests or verify the code works.
5. **One tool per block.** Each <tool_call> block should contain exactly one tool call.
6. **Handle errors.** If a tool returns an error, explain the issue and try an alternative approach.
7. **Security first.** Never write secrets/passwords in code. Never run destructive commands without thinking.
8. **Clean code.** Follow the project's existing style, conventions, and patterns.

## MODE
{MODE_INSTRUCTIONS.get(mode, MODE_INSTRUCTIONS["auto"])}

## PROJECT
Working directory: {project_path}

```
{project_tree}
```

## RESPONSE STYLE
- Use markdown formatting for explanations
- Show code in fenced blocks with language tags
- Be concise but thorough
- When showing diffs or changes, be specific about what changed and why
- If a task is ambiguous, state your interpretation before proceeding
"""

# ── Tool parsing & execution ─────────────────────────────────────────────────
_TOOL_RE = re.compile(r'<tool_call>\s*(\{.*?\})\s*</tool_call>', re.DOTALL)

def parse_tools(text):
    """Extract tool calls from model output."""
    calls = []
    for m in _TOOL_RE.finditer(text):
        try:
            obj = json.loads(m.group(1))
            calls.append(obj)
        except json.JSONDecodeError:
            pass
    return calls

def strip_tools(text):
    """Remove tool_call blocks, returning clean display text."""
    return _TOOL_RE.sub("", text).strip()

def exec_tool(tc, root):
    """Execute one tool call. Returns result dict."""
    name = tc.get("name","")
    args = tc.get("args",{})
    try:
        if name == "read_file":
            return read_file(root, args["path"])
        elif name == "write_file":
            return write_file(root, args["path"], args["content"])
        elif name == "edit_file":
            return edit_file(root, args["path"], args["find"], args["replace"])
        elif name == "run_command":
            return run_cmd(root, args["command"], timeout=args.get("timeout",120))
        elif name == "list_dir":
            return list_dir(root, args.get("path","."))
        elif name == "search":
            return search_text(root, args["query"], args.get("path","."))
        elif name == "delete":
            return delete_path(root, args["path"])
        else:
            return {"error": f"Unknown tool: {name}"}
    except Exception as e:
        return {"error": str(e)}

# ── Google AI helpers ────────────────────────────────────────────────────────
def _genai():
    from google import genai
    from google.genai import types
    return genai, types

def _build_contents(history):
    """Convert model_history list to google-genai Content objects."""
    _, types = _genai()
    contents = []
    for msg in history:
        role = "user" if msg["role"] == "user" else "model"
        contents.append(types.Content(
            role=role,
            parts=[types.Part.from_text(text=msg["text"])]
        ))
    return contents

# ── Agent loop ───────────────────────────────────────────────────────────────
MAX_AGENT_TURNS = 25

def agent_stream(conv_id, user_text):
    """Generator that yields SSE events for an agent turn."""
    cfg   = load_config()
    key   = cfg.get("api_key","")
    model = cfg.get("model","gemma-4-31b-it")
    mode  = cfg.get("mode","auto")
    root  = cfg.get("project_path","")

    if not key:
        yield _sse({"type":"error","content":"No API key configured. Open Settings to add your Google AI API key."})
        return
    if not root or not Path(root).is_dir():
        yield _sse({"type":"error","content":"No valid project folder set. Open Settings to choose a project folder."})
        return

    # Load / create conversation
    conv = load_conv(conv_id)
    if not conv:
        conv = new_conv()
        conv["id"] = conv_id

    # Add user message
    conv["messages"].append({"role":"user","content": user_text})
    conv["model_history"].append({"role":"user","text": user_text})

    # Auto-title from first message
    if conv["title"] == "New Chat" and len(conv["messages"]) == 1:
        words = re.sub(r'\s+',' ', user_text).strip().split()
        conv["title"] = " ".join(words[:6])[:48] or "New Chat"
        yield _sse({"type":"title","content": conv["title"]})

    genai, types = _genai()
    client = genai.Client(api_key=key, http_options={"timeout": 300_000})

    tree = build_tree(root, max_depth=2, max_files=80)
    system = build_system_prompt(root, mode, tree)

    accumulated_text = ""
    all_tools = []     # [{name, args, result}, ...]

    for turn in range(MAX_AGENT_TURNS):
        yield _sse({"type":"status","content": "thinking..." if turn == 0 else "continuing..."})

        contents = _build_contents(conv["model_history"])
        config = types.GenerateContentConfig(
            system_instruction=system,
            max_output_tokens=16384,
            temperature=0.2,
        )

        # Stream from model
        full_text = ""
        try:
            stream = client.models.generate_content_stream(
                model=model, contents=contents, config=config
            )
            for chunk in stream:
                t = ""
                try: t = chunk.text or ""
                except Exception: pass
                if t:
                    full_text += t
                    yield _sse({"type":"text","content": t})
        except Exception as e:
            err_msg = str(e)
            if "API key" in err_msg or "401" in err_msg or "403" in err_msg:
                yield _sse({"type":"error","content":"Invalid API key. Check your Google AI API key in Settings."})
            elif "not found" in err_msg.lower() or "404" in err_msg:
                yield _sse({"type":"error","content":f"Model '{model}' not available. Try a different model in Settings."})
            else:
                yield _sse({"type":"error","content":f"Model error: {err_msg[:500]}"})
            # Save what we have
            if accumulated_text:
                conv["messages"].append({"role":"assistant","content": accumulated_text, "tools": all_tools})
                conv["model_history"].append({"role":"model","text": accumulated_text})
            save_conv(conv)
            return

        # Parse tool calls
        tools = parse_tools(full_text)
        clean = strip_tools(full_text)
        accumulated_text += ("\n" if accumulated_text else "") + clean if clean else ""

        if not tools:
            # No tool calls — done
            conv["model_history"].append({"role":"model","text": full_text})
            break

        # Execute tools
        conv["model_history"].append({"role":"model","text": full_text})

        results_parts = []
        for tc in tools:
            name = tc.get("name","")
            args = tc.get("args",{})
            yield _sse({"type":"tool_start","name": name,"args": args})

            result = exec_tool(tc, root)
            all_tools.append({"name": name, "args": args, "result": result})

            # Truncate large results for display
            display_result = _truncate_result(result)
            yield _sse({"type":"tool_result","name": name,"result": display_result})

            # Check if file was changed
            if name in ("write_file","edit_file","delete"):
                yield _sse({"type":"file_changed","path": args.get("path","")})

            results_parts.append(json.dumps(result, ensure_ascii=False))

        # Feed results back
        results_text = "\n".join(
            f'<tool_result name="{t["name"]}">\n{r}\n</tool_result>'
            for t, r in zip(tools, results_parts)
        )
        conv["model_history"].append({"role":"user","text": results_text})
    else:
        yield _sse({"type":"status","content":"Reached maximum agent steps."})

    # Save assistant message
    conv["messages"].append({"role":"assistant","content": accumulated_text, "tools": all_tools})
    save_conv(conv)
    yield _sse({"type":"done","conversation": {"id": conv["id"],"title": conv["title"]}})

def _truncate_result(result):
    """Truncate large tool results for SSE display."""
    if isinstance(result, dict):
        r = dict(result)  # shallow copy
        if "content" in r and isinstance(r["content"], str) and len(r["content"]) > 3000:
            r["content"] = r["content"][:3000] + f"\n... ({len(result['content'])} chars total)"
        if "stdout" in r and isinstance(r["stdout"], str) and len(r["stdout"]) > 3000:
            r["stdout"] = r["stdout"][:3000] + "\n... (truncated)"
        if "results" in r and isinstance(r["results"], list) and len(r["results"]) > 20:
            r["results"] = r["results"][:20]
            r["truncated"] = True
        return r
    return result

def _sse(data):
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"

# ── Browse directories (for project picker) ──────────────────────────────────
def _browse(path_str):
    """List subdirectories at a given path for the folder picker."""
    p = Path(path_str).resolve()
    if not p.is_dir():
        return {"error": "Not a directory", "path": str(p)}
    dirs = []
    try:
        for item in sorted(p.iterdir()):
            if item.is_dir() and not item.name.startswith('.'):
                dirs.append({"name": item.name, "path": str(item).replace("\\","/")})
    except PermissionError:
        return {"error": "Permission denied", "path": str(p)}
    parent = str(p.parent).replace("\\","/") if p.parent != p else None
    return {"path": str(p).replace("\\","/"), "parent": parent, "dirs": dirs}

# ══════════════════════════════════════════════════════════════════════════════
#  ROUTES
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/")
def index():
    return send_from_directory("static", "index.html")

@app.route("/static/<path:p>")
def static_files(p):
    return send_from_directory("static", p)

# ── Config ───────────────────────────────────────────────────────────────────
@app.route("/api/config", methods=["GET","POST"])
def config_route():
    if request.method == "GET":
        c = load_config()
        # Mask API key for display
        masked = c.copy()
        if masked.get("api_key"):
            k = masked["api_key"]
            masked["api_key_display"] = k[:6] + "..." + k[-4:] if len(k) > 10 else "***"
        else:
            masked["api_key_display"] = ""
        return jsonify(masked)
    else:
        data = request.json or {}
        c = load_config()
        for k in ("api_key","model","mode","project_path"):
            if k in data:
                c[k] = data[k]
        save_config(c)
        return jsonify({"ok": True})

@app.route("/api/models")
def models_route():
    return jsonify(MODELS)

# ── Browse ───────────────────────────────────────────────────────────────────
@app.route("/api/browse")
def browse_route():
    p = request.args.get("path","")
    if not p:
        # Default to user home
        p = str(Path.home())
    return jsonify(_browse(p))

# ── Files ────────────────────────────────────────────────────────────────────
@app.route("/api/files")
@app.route("/api/files/<path:rel>")
def files_route(rel="."):
    cfg = load_config()
    root = cfg.get("project_path","")
    if not root: return jsonify({"error":"No project set"}), 400
    return jsonify(list_dir(root, rel))

@app.route("/api/file/<path:rel>", methods=["GET","PUT"])
def file_route(rel):
    cfg = load_config()
    root = cfg.get("project_path","")
    if not root: return jsonify({"error":"No project set"}), 400
    if request.method == "GET":
        return jsonify(read_file(root, rel))
    else:
        data = request.json or {}
        return jsonify(write_file(root, rel, data.get("content","")))

# ── Terminal ─────────────────────────────────────────────────────────────────
@app.route("/api/terminal", methods=["POST"])
def terminal_route():
    cfg = load_config()
    root = cfg.get("project_path","")
    if not root: return jsonify({"error":"No project set"}), 400
    data = request.json or {}
    cmd = data.get("command","").strip()
    if not cmd: return jsonify({"error":"No command"}), 400
    return jsonify(run_cmd(root, cmd, timeout=data.get("timeout",120)))

# ── Conversations ────────────────────────────────────────────────────────────
@app.route("/api/conversations", methods=["GET","POST"])
def conversations_route():
    if request.method == "GET":
        return jsonify(list_convs())
    else:
        c = new_conv()
        return jsonify(c)

@app.route("/api/conversations/<cid>", methods=["GET","DELETE"])
def conversation_route(cid):
    if request.method == "DELETE":
        delete_conv(cid)
        return jsonify({"ok": True})
    c = load_conv(cid)
    if not c: return jsonify({"error":"Not found"}), 404
    return jsonify(c)

# ── Chat (SSE) ───────────────────────────────────────────────────────────────
@app.route("/api/chat", methods=["POST"])
def chat_route():
    data = request.json or {}
    conv_id = data.get("conversation_id", uuid.uuid4().hex[:12])
    message = (data.get("message","") or "").strip()
    if not message:
        return jsonify({"error":"Empty message"}), 400

    def generate():
        try:
            for event in agent_stream(conv_id, message):
                yield event
        except Exception as e:
            yield _sse({"type":"error","content": f"Server error: {str(e)[:500]}"})
            yield _sse({"type":"done","conversation":{"id": conv_id,"title":"Error"}})

    return Response(stream_with_context(generate()),
                    mimetype="text/event-stream",
                    headers={"Cache-Control":"no-cache","X-Accel-Buffering":"no"})

# ══════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CHATS_DIR.mkdir(parents=True, exist_ok=True)
    print()
    print("  ╔══════════════════════════════════════╗")
    print("  ║   Coder · AI Coding Agent            ║")
    print("  ║   http://localhost:5001               ║")
    print("  ╚══════════════════════════════════════╝")
    print()
    app.run(host="127.0.0.1", port=5001, debug=False, threaded=True)
