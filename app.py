#!/usr/bin/env python3
"""Gyro - The Flow-State Architect"""

import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

import os, json, uuid, datetime, re, base64, mimetypes, secrets, hashlib, random, io, time, threading
import urllib.request, urllib.parse
from pathlib import Path
from functools import wraps
from flask import Flask, request, jsonify, send_from_directory, session, Response, stream_with_context
from system_prompt import (
    build_system_prompt as _build_system_prompt_template,
    build_tool_instructions as _build_tool_instructions_template,
    build_hf_connector_instructions,
    build_reminder_instructions,
    build_location_instructions,
    build_stream_thinking_instructions,
)

def _import_google():
    from google import genai; from google.genai import types; return genai, types
def _import_openai():
    import openai; return openai
def _import_anthropic():
    import anthropic; return anthropic

# --- Firebase / Firestore init ------------------------------------------------
import firebase_admin
from firebase_admin import credentials, firestore, storage as fb_storage

FIREBASE_ENABLED = False
db = None

WORKSPACE = Path(__file__).parent.resolve()
DATA_DIR = WORKSPACE / ".gyro_data"
SECRET_FILE = DATA_DIR / ".secret_key"
SESSION_SECRET_FILE = WORKSPACE / ".gyro_session_secret"

def _init_firebase():
    """Initialise Firebase once. Falls back to local file storage if not configured."""
    global FIREBASE_ENABLED, db
    if firebase_admin._apps:
        db = firestore.client()
        FIREBASE_ENABLED = True
        return
    sa_path = WORKSPACE / "serviceAccount.json"
    bucket = os.environ.get("FIREBASE_STORAGE_BUCKET", "").strip()
    if not bucket:
        ef = WORKSPACE / ".env"
        if ef.exists():
            for line in ef.read_text(encoding="utf-8").splitlines():
                if line.strip().startswith("FIREBASE_STORAGE_BUCKET="):
                    bucket = line.split("=", 1)[1].strip().strip('"\'')
    opts = {"storageBucket": bucket} if bucket else {}

    cred = None
    # 1) Service account JSON file on disk (local dev)
    if sa_path.exists():
        cred = credentials.Certificate(str(sa_path))
    # 2) Service account JSON passed as an environment variable (cloud deploys)
    elif os.environ.get("FIREBASE_SERVICE_ACCOUNT", "").strip():
        try:
            sa_dict = json.loads(os.environ["FIREBASE_SERVICE_ACCOUNT"])
            cred = credentials.Certificate(sa_dict)
        except Exception as e:
            print(f"  [!] FIREBASE_SERVICE_ACCOUNT env var invalid ({e})")
    # 3) Application Default Credentials (GCP environments)
    elif os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        cred = credentials.ApplicationDefault()

    if cred is None:
        print("  [!] Firebase not configured - using local file storage (.gyro_data/).")
        print("      To persist data across deploys, set the FIREBASE_SERVICE_ACCOUNT")
        print("      environment variable to your Firebase service account JSON.")
        return
    try:
        firebase_admin.initialize_app(cred, opts)
        db = firestore.client()
        # Verify Firestore is actually reachable (not just authenticated)
        try:
            db.collection("_health").document("ping").set({"ts": datetime.datetime.now().isoformat()})
            print("  [✓] Firebase connected & Firestore verified — data will persist across deploys.")
        except Exception as fs_err:
            print(f"  [!] Firebase authenticated but Firestore unreachable: {fs_err}")
            print("      Make sure you've created a Firestore database in Firebase Console.")
            print("      Go to: https://console.firebase.google.com ? Your project ? Firestore Database ? Create database")
            print("      Falling back to local file storage.")
            db = None
            FIREBASE_ENABLED = False
            return
        FIREBASE_ENABLED = True
    except Exception as e:
        print(f"  [!] Firebase init failed ({e}) - using local file storage.")

_init_firebase()

def _storage_bucket():
    if not FIREBASE_ENABLED: return None
    try:
        return fb_storage.bucket()
    except Exception:
        return None

# --- Local file storage (fallback when Firebase not configured) ---------------

def _local_user_dir(uid):
    d = DATA_DIR / "users" / uid
    d.mkdir(parents=True, exist_ok=True)
    return d

def _load_json(path, default=None):
    if default is None: default = {}
    try:
        return json.loads(path.read_text(encoding='utf-8')) if path.exists() else default
    except Exception:
        return default

def _save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')

def _local_load_users():
    return _load_json(DATA_DIR / "users.json", {})

def _local_save_user(user):
    users = _local_load_users()
    users[user["id"]] = user
    _save_json(DATA_DIR / "users.json", users)

def _local_find_user_by_email(email):
    for u in _local_load_users().values():
        if u.get("email", "").lower() == email.lower():
            return u
    return None

def _local_load_user_by_id(uid):
    return _local_load_users().get(uid)

LEGACY_DEFAULT_GOOGLE_CLIENT_ID = "253818541787-cal4ulgrb5otqjj8htg55l8c6gvl750o.apps.googleusercontent.com"

IGNORED_DIRS = {".git", "__pycache__", ".venv", "venv", "node_modules",
                ".gyro_history", ".gyro_data", ".nexus_data", ".nexus_history",
                "static", "templates"}
IGNORED_FILES = {"gyro.py", "app.py", "requirements.txt", ".env", ".gitignore",
                 "gunicorn.ctl", "Procfile", "render.yaml", "system_prompt.py", "prompts.md",
                 "NEXUS_INSTRUCTIONS.md", "README.md", "STATUS.md", "TEST_PROMPTS.md"}
# Server-side files hidden from the user file browser
SERVER_FILES = {"app.py", "requirements.txt", "Procfile", "render.yaml",
                "gyro_INSTRUCTIONS.md", "KAIRO_INSTRUCTIONS.md", "NEXUS_INSTRUCTIONS.md",
                "README.md", "STATUS.md", "TEST_PROMPTS.md", "gunicorn.ctl",
                "system_prompt.py", "prompts.md",
                ".env", ".gitignore", ".gyro_session_secret", ".nexus_session_secret"}
SERVER_DIRS = {".git", "__pycache__", ".venv", "venv", "node_modules",
               ".gyro_history", ".gyro_data", ".nexus_data", ".nexus_history",
               "static", "templates", "logos", "_code_output", "_uploads"}
MAX_CONTEXT_CHARS = 900_000
DEFAULT_MODEL = "gemini-2.5-flash"
DEFAULT_CREATOR_ORIGIN_STORY = "Blake Cary built Gyro after his brother shared AI ideas that inspired him to create this workspace."
CREATOR_EMAIL = "blakecary2010@gmail.com"

GUEST_MODEL = "gemini-2.5-flash"

MODELS = {
    # Google — free tier (server API key, no per-user cost)
    "gemini-2.5-flash":  {"provider": "google",    "label": "Gemini 2.5 Flash",    "tier": "free"},
    "gemini-2.5-pro":  {"provider": "google",    "label": "Gemini 2.5 Pro",    "tier": "free"},
    # Google — pro tier
    "gemini-3-flash-preview":        {"provider": "google",    "label": "Gemini 3 Flash",   "tier": "pro"},
    "gemini-3.1-pro-preview":        {"provider": "google",    "label": "Gemini 3.1 Pro",     "tier": "pro"},
    # OpenAI — pro tier
    "gpt-5.4-mini":            {"provider": "openai",    "label": "GPT-5.4 Mini",       "tier": "pro"},
    "gpt-5.4":                 {"provider": "openai",    "label": "GPT-5.4",            "tier": "pro"},
    # Anthropic — pro tier
    "claude-sonnet-4-6":       {"provider": "anthropic", "label": "Claude Sonnet 4.6",  "tier": "pro"},
    "claude-opus-4-6":         {"provider": "anthropic", "label": "Claude Opus 4.6",    "tier": "pro"},
}

app = Flask(__name__, static_folder="static")
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
_BOOT_TS = str(int(time.time()))

# In-memory guest runtime state (backed by disk)
GUEST_RUNTIME = {}

def _guest_dir(guest_id):
    """Return (and create) the on-disk directory for a guest user."""
    d = DATA_DIR / "guests" / guest_id
    d.mkdir(parents=True, exist_ok=True)
    return d

def _hash_remember_token(token):
    return hashlib.sha256(token.encode()).hexdigest()

def _ensure_dirs():
    DATA_DIR.mkdir(exist_ok=True)

def _get_secret():
    _ensure_dirs()
    # Use environment variable if set (survives Render deploys).
    env_key = os.environ.get("gyro_SECRET_KEY", "").strip()
    if env_key:
        return env_key
    # Prefer a workspace-level secret so auth survives data-folder cleanup.
    if SESSION_SECRET_FILE.exists():
        key = SESSION_SECRET_FILE.read_text(encoding="utf-8").strip()
        if key and not SECRET_FILE.exists():
            SECRET_FILE.write_text(key, encoding="utf-8")
        return key
    if SECRET_FILE.exists():
        key = SECRET_FILE.read_text(encoding="utf-8").strip()
        if key:
            SESSION_SECRET_FILE.write_text(key, encoding="utf-8")
            return key
    k = secrets.token_hex(32)
    SECRET_FILE.write_text(k, encoding="utf-8")
    SESSION_SECRET_FILE.write_text(k, encoding="utf-8")
    return k

app.secret_key = _get_secret()
app.config["PERMANENT_SESSION_LIFETIME"] = datetime.timedelta(days=30)
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_NAME"] = "gyro_session"

@app.before_request
def _refresh_session():
    """Touch the session on every request so the cookie expiry is refreshed."""
    if session.get("user_id") or session.get("guest"):
        session.modified = True

@app.errorhandler(Exception)
def handle_exception(e):
    """Catch-all so Firestore / unexpected errors return JSON, not a 500 HTML page."""
    from werkzeug.exceptions import HTTPException
    if isinstance(e, HTTPException):
        return e
    print(f"  [!] Unhandled error: {e}")
    return jsonify({"error": f"Server error: {str(e)[:200]}"}), 500

# --- Auth helpers -------------------------------------------------------------

def _hash_pw(pw, salt=None):
    salt = salt or secrets.token_hex(16)
    return hashlib.sha256((salt + pw).encode()).hexdigest(), salt

# --- Firestore user helpers ---------------------------------------------------

def _users_col():
    if not FIREBASE_ENABLED: return None
    return db.collection("users")

def _user_doc(uid):
    col = _users_col()
    if col is None: return None
    return col.document(uid)

def _find_user_by_email(email):
    if not FIREBASE_ENABLED:
        return _local_find_user_by_email(email)
    ref = db.collection("user_emails").document(email.lower())
    snap = ref.get()
    if not snap.exists: return None
    uid = snap.to_dict().get("uid")
    if not uid: return None
    usnap = _user_doc(uid).get()
    return usnap.to_dict() if usnap.exists else None

def _save_user(user):
    if not FIREBASE_ENABLED:
        _local_save_user(user)
        return
    _user_doc(user["id"]).set(user)
    db.collection("user_emails").document(user["email"]).set({"uid": user["id"]})

def _load_user_by_id(uid):
    if not FIREBASE_ENABLED:
        return _local_load_user_by_id(uid)
    snap = _user_doc(uid).get()
    return snap.to_dict() if snap.exists else None

def _update_user_field(uid, **fields):
    """Update fields on a user record (works for both storage backends)."""
    if not uid: return
    if not FIREBASE_ENABLED:
        user = _local_load_user_by_id(uid)
        if user:
            user.update(fields)
            _local_save_user(user)
        return
    _user_doc(uid).update(fields)

def _safe_id(s):
    return bool(s and re.match(r'^[a-zA-Z0-9\-_]{1,36}$', s))

def create_user(email, pw, name="", provider="local"):
    if _find_user_by_email(email):
        return None, "Account already exists with this email"
    uid = str(uuid.uuid4())[:12]
    h, s = _hash_pw(pw) if pw else ("", "")
    user = {"id": uid, "email": email.lower(), "name": name or email.split("@")[0],
            "password_hash": h, "salt": s, "provider": provider,
            "created": datetime.date.today().isoformat(), "theme": "dark", "plan": "free"}
    _save_user(user)
    return user, None

def verify_pw(email, pw):
    u = _find_user_by_email(email)
    if not u or not u.get("password_hash"): return None
    h, _ = _hash_pw(pw, u["salt"])
    return u if h == u["password_hash"] else None

def oauth_user(email, name, provider):
    existing = _find_user_by_email(email)
    if existing:
        return existing
    uid = str(uuid.uuid4())[:12]
    user = {"id": uid, "email": email.lower(), "name": name or email.split("@")[0],
            "password_hash": "", "salt": "", "provider": provider,
            "created": datetime.date.today().isoformat(), "theme": "dark", "plan": "free"}
    _save_user(user)
    return user

def require_auth(f):
    @wraps(f)
    def dec(*args, **kw):
        if not session.get("user_id"):
            return jsonify({"error": "Not authenticated"}), 401
        return f(*args, **kw)
    return dec

def require_auth_or_guest(f):
    @wraps(f)
    def dec(*args, **kw):
        if not session.get("user_id") and not session.get("guest"):
            keys = list(session.keys())
            return jsonify({"error": f"Not authenticated (session has no user_id or guest flag, keys={keys})"}), 401
        return f(*args, **kw)
    return dec

# ~20k tokens/day ˜ 80 typical exchanges with the lite model
GUEST_TOKEN_LIMIT = 20_000

def _guest_runtime_state():
    guest_id = session.get("guest_id")
    if not guest_id:
        return None
    if guest_id not in GUEST_RUNTIME:
        # Try to restore from disk
        gdir = _guest_dir(guest_id)
        meta = _load_json(gdir / "meta.json", {})
        chats = {}
        chats_dir = gdir / "chats"
        if chats_dir.exists():
            for f in chats_dir.glob("*.json"):
                try:
                    c = _load_json(f, None)
                    if c and c.get("id"):
                        chats[c["id"]] = c
                except Exception:
                    pass
        GUEST_RUNTIME[guest_id] = {
            "date": meta.get("date", datetime.date.today().isoformat()),
            "tokens": meta.get("tokens", 0),
            "chats": chats,
        }
    state = GUEST_RUNTIME[guest_id]
    today = datetime.date.today().isoformat()
    if state.get("date") != today:
        state["date"] = today
        state["tokens"] = 0
    return state

def _guest_tokens_used():
    state = _guest_runtime_state()
    if not state:
        return 0
    return int(state.get("tokens", 0))

def _add_guest_tokens(n):
    state = _guest_runtime_state()
    if not state:
        return
    state["tokens"] = int(state.get("tokens", 0)) + max(0, int(n))
    # Persist token count to disk
    guest_id = session.get("guest_id")
    if guest_id:
        gdir = _guest_dir(guest_id)
        _save_json(gdir / "meta.json", {"date": state["date"], "tokens": state["tokens"]})

def _cur_user():
    uid = session.get("user_id")
    if not uid:
        if session.get("guest"):
            return {"id": "guest", "name": "Guest", "email": "", "provider": "guest"}
        return None
    return _load_user_by_id(uid)

# Store OAuth config in Firestore (or local file)
def _load_oauth():
    if not FIREBASE_ENABLED:
        return _load_json(DATA_DIR / "oauth.json", {})
    try:
        snap = db.collection("config").document("oauth").get()
        return snap.to_dict() if snap.exists else {}
    except Exception as e:
        print(f"  [!] Firestore _load_oauth failed: {e}")
        return {}

def _save_oauth(cfg):
    if not FIREBASE_ENABLED:
        _save_json(DATA_DIR / "oauth.json", cfg)
        return
    db.collection("config").document("oauth").set(cfg)

# --- Per-user data ------------------------------------------------------------

def _uid_doc(sub):
    """Return a Firestore DocumentReference for the current user's sub-document."""
    uid = session.get("user_id")
    if not uid:
        return None
    return _user_doc(uid).collection("data").document(sub)

def load_settings():
    uid = session.get("user_id")
    defaults = {"keys": {}, "selected_model": DEFAULT_MODEL, "custom_endpoints": []}
    if not uid: return defaults
    if not FIREBASE_ENABLED:
        s = _load_json(_local_user_dir(uid) / "settings.json", {})
        for k, v in defaults.items(): s.setdefault(k, v)
        return s
    ref = _uid_doc("settings")
    snap = ref.get()
    s = snap.to_dict() if snap.exists else {}
    for k, v in defaults.items(): s.setdefault(k, v)
    return s

def save_settings(s):
    if not FIREBASE_ENABLED:
        uid = session.get("user_id")
        if uid: _save_json(_local_user_dir(uid) / "settings.json", s)
        return
    ref = _uid_doc("settings")
    if ref: ref.set(s)

def _load_server_key(provider):
    """Load a server-side API key from environment or .env file."""
    env_map = {"google": "GEMINI_API_KEY", "openai": "OPENAI_API_KEY", "anthropic": "ANTHROPIC_API_KEY"}
    env_name = env_map.get(provider, "")
    if not env_name:
        return ""
    val = os.environ.get(env_name, "").strip()
    if val:
        return val
    ef = WORKSPACE / ".env"
    if ef.exists():
        for line in ef.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith(f"{env_name}="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""

def _load_default_google_key():
    return _load_server_key("google")

def _load_google_client_id_env():
    val = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
    if val:
        return val
    ef = WORKSPACE / ".env"
    if ef.exists():
        for line in ef.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("GOOGLE_CLIENT_ID="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""

def _effective_google_client_id(cfg=None):
    cfg = cfg or {}
    return (
        _load_google_client_id_env()
        or (cfg.get("google_client_id") or "").strip()
        or LEGACY_DEFAULT_GOOGLE_CLIENT_ID
    )

def _get_current_user_plan():
    uid = session.get("user_id")
    if not uid:
        return "guest" if session.get("guest") else "none"
    user = _load_user_by_id(uid)
    return user.get("plan", "free") if user else "free"

def resolve_provider_key(settings, provider):
    saved = (settings.get("keys", {}).get(provider, "") or "").strip()
    if saved:
        return saved, "user"
    if provider != "custom":
        server_key = _load_server_key(provider)
        if server_key:
            return server_key, "server"
    return "", ""

def model_access(model_id, settings):
    plan = _get_current_user_plan()

    if model_id.startswith("custom:"):
        ep_name = model_id.split(":", 1)[1]
        endpoint = next((e for e in settings.get("custom_endpoints", []) if e.get("name") == ep_name), None)
        if not endpoint:
            return False, "Custom endpoint not found.", ""
        api_key, source = resolve_provider_key(settings, "custom")
        if api_key:
            return True, "", source
        return False, "Add your own gateway API key to use custom endpoints.", ""

    info = MODELS.get(model_id)
    if not info:
        return False, f"Unknown model: {model_id}", ""

    provider = info["provider"]
    tier = info.get("tier", "pro")

    # User-provided key always works regardless of plan
    user_key = (settings.get("keys", {}).get(provider, "") or "").strip()
    if user_key:
        return True, "", "user"

    if tier == "free":
        server_key = _load_server_key(provider)
        if server_key:
            return True, "", "server"
        return False, f"No {provider} API key configured on this server.", ""

    # Pro-tier model — requires pro/max/dev plan
    if plan in ("pro", "max", "dev"):
        server_key = _load_server_key(provider)
        if server_key:
            return True, "", "server"
        return False, f"No server-side {provider.title()} key configured. Contact the site admin.", ""

    # Plan insufficient
    return False, "upgrade_required", ""

def normalize_selected_model(settings):
    selected = settings.get("selected_model") or DEFAULT_MODEL
    allowed, _, _ = model_access(selected, settings)
    return selected if allowed else DEFAULT_MODEL

def load_memory():
    uid = session.get("user_id")
    default = {"facts": [], "updated": None}
    if not uid: return default
    if not FIREBASE_ENABLED:
        m = _load_json(_local_user_dir(uid) / "memory.json", default)
        m.setdefault("facts", [])
        return m
    ref = _uid_doc("memory")
    if not ref: return default
    snap = ref.get()
    if snap.exists:
        data = snap.to_dict()
        data.setdefault("facts", [])
        return data
    return default

def save_memory(m):
    if not FIREBASE_ENABLED:
        uid = session.get("user_id")
        if not uid: return
        m["updated"] = datetime.datetime.now().isoformat()
        _save_json(_local_user_dir(uid) / "memory.json", m)
        return
    ref = _uid_doc("memory")
    if not ref: return
    m["updated"] = datetime.datetime.now().isoformat()
    ref.set(m)

# --- Connectors (HuggingFace, etc.) ------------------------------------------

def load_connectors():
    uid = session.get("user_id")
    defaults = {"huggingface": {"token": "", "enabled": False}}
    if not uid: return defaults
    if not FIREBASE_ENABLED:
        c = _load_json(_local_user_dir(uid) / "connectors.json", {})
        for k, v in defaults.items(): c.setdefault(k, v)
        return c
    ref = _uid_doc("connectors")
    if not ref: return defaults
    snap = ref.get()
    c = snap.to_dict() if snap.exists else {}
    for k, v in defaults.items(): c.setdefault(k, v)
    return c

def save_connectors(c):
    if not FIREBASE_ENABLED:
        uid = session.get("user_id")
        if not uid: return
        _save_json(_local_user_dir(uid) / "connectors.json", c)
        return
    ref = _uid_doc("connectors")
    if ref: ref.set(c)

def _hf_token():
    """Return the user's HuggingFace token if configured, or empty string."""
    c = load_connectors()
    hf = c.get("huggingface", {})
    if hf.get("enabled") and hf.get("token"):
        return hf["token"]
    return ""

def load_profile():
    default = {
        "onboarding_complete": False,
        "preferred_name": "",
        "what_you_do": "",
        "hobbies": "",
        "current_focus": "",
        "origin_story": "",
        "updated": None,
    }
    uid = session.get("user_id")
    if not uid: return default
    if not FIREBASE_ENABLED:
        p = _load_json(_local_user_dir(uid) / "profile.json", {})
        for k, v in default.items(): p.setdefault(k, v)
        return p
    ref = _uid_doc("profile")
    if not ref: return default
    snap = ref.get()
    p = snap.to_dict() if snap.exists else {}
    for k, v in default.items(): p.setdefault(k, v)
    return p

def save_profile(p):
    if not FIREBASE_ENABLED:
        uid = session.get("user_id")
        if not uid: return
        p["updated"] = datetime.datetime.now().isoformat()
        _save_json(_local_user_dir(uid) / "profile.json", p)
        return
    ref = _uid_doc("profile")
    if not ref: return
    p["updated"] = datetime.datetime.now().isoformat()
    ref.set(p)

def _save_user_name(name):
    uid = session.get("user_id")
    if not uid: return False
    _update_user_field(uid, name=name)
    return True

def _chats_col():
    if not FIREBASE_ENABLED: return None
    uid = session.get("user_id")
    if not uid: return None
    return _user_doc(uid).collection("chats")

def _is_transient_empty_chat(chat_obj):
    """Hide placeholder chats that were created but never used."""
    if not isinstance(chat_obj, dict):
        return False
    title = (chat_obj.get("title") or "").strip().lower()
    folder = (chat_obj.get("folder") or "").strip()
    has_messages = bool(chat_obj.get("messages") or [])
    return (not has_messages) and title in ("", "new chat") and not folder

def list_chats():
    if session.get("guest") and not session.get("user_id"):
        guest_id = session.get("guest_id")
        if not guest_id:
            return []
        state = _guest_runtime_state() or {}
        chats = []
        for c in (state.get("chats") or {}).values():
            if _is_transient_empty_chat(c):
                continue
            chats.append({"id": c.get("id"), "title": c.get("title", "Untitled"),
                "created": c.get("created"), "updated": c.get("updated"),
                "model": c.get("model", ""), "folder": c.get("folder", ""),
                "message_count": len(c.get("messages", []))})
        chats.sort(key=lambda x: x.get("updated") or "", reverse=True)
        return chats
    uid = session.get("user_id")
    if not uid: return []
    if not FIREBASE_ENABLED:
        chats_dir = _local_user_dir(uid) / "chats"
        if not chats_dir.exists(): return []
        chats = []
        for f in chats_dir.glob("*.json"):
            try:
                m = _load_json(f, {})
                if m:
                    if _is_transient_empty_chat(m):
                        continue
                    chats.append({"id": m.get("id", f.stem), "title": m.get("title", "Untitled"),
                        "created": m.get("created"), "updated": m.get("updated"),
                        "model": m.get("model", ""), "folder": m.get("folder", ""),
                        "message_count": len(m.get("messages", []))})
            except Exception: pass
        chats.sort(key=lambda x: x.get("updated") or "", reverse=True)
        return chats
    col = _chats_col()
    if not col: return []
    docs = col.order_by("updated", direction=firestore.Query.DESCENDING).stream()
    chats = []
    for doc in docs:
        m = doc.to_dict()
        if _is_transient_empty_chat(m):
            continue
        chats.append({"id": doc.id, "title": m.get("title", "Untitled"),
            "created": m.get("created"), "updated": m.get("updated"),
            "model": m.get("model", ""), "folder": m.get("folder", ""),
            "message_count": len(m.get("messages", []))})
    return chats

def load_chat(cid):
    if not _safe_id(cid): return None, "invalid_id"
    if session.get("guest") and not session.get("user_id"):
        state = _guest_runtime_state() or {}
        chat = (state.get("chats") or {}).get(cid)
        if chat:
            return chat, None
        # Fallback: try loading from disk
        guest_id = session.get("guest_id")
        if guest_id:
            disk_chat = _load_json(_guest_dir(guest_id) / "chats" / f"{cid}.json", None)
            if disk_chat:
                state.setdefault("chats", {})[cid] = disk_chat
                return disk_chat, None
            return None, f"guest_chat_missing|guest_id={guest_id}|chat_id={cid}"
        return None, "no_guest_id_in_session"
    uid = session.get("user_id")
    if not uid:
        has_guest = session.get("guest", False)
        return None, f"no_user_id|guest={has_guest}|session_keys={list(session.keys())}"
    if not FIREBASE_ENABLED:
        path = _local_user_dir(uid) / "chats" / f"{cid}.json"
        data = _load_json(path, None)
        if data:
            return data, None
        return None, f"file_missing|uid={uid}|path={path}|exists={path.exists()}|dir_exists={path.parent.exists()}"
    col = _chats_col()
    if not col: return None, "no_firestore_collection"
    snap = col.document(cid).get()
    if snap.exists:
        return snap.to_dict(), None
    return None, f"firestore_doc_missing|uid={uid}|chat_id={cid}"

def save_chat(c):
    if session.get("guest") and not session.get("user_id"):
        state = _guest_runtime_state()
        if not state: return
        c["updated"] = datetime.datetime.now().isoformat()
        state.setdefault("chats", {})[c["id"]] = c
        # Persist to disk so chats survive server restarts
        guest_id = session.get("guest_id")
        if guest_id:
            _save_json(_guest_dir(guest_id) / "chats" / f"{c['id']}.json", c)
        return
    uid = session.get("user_id")
    if not uid: return
    if not FIREBASE_ENABLED:
        c["updated"] = datetime.datetime.now().isoformat()
        _save_json(_local_user_dir(uid) / "chats" / f"{c['id']}.json", c)
        return
    col = _chats_col()
    if not col: return
    c["updated"] = datetime.datetime.now().isoformat()
    col.document(c["id"]).set(c)

def delete_chat(cid):
    if not _safe_id(cid): return False
    if session.get("guest") and not session.get("user_id"):
        state = _guest_runtime_state() or {}
        chats = state.get("chats") or {}
        deleted = False
        if cid in chats:
            del chats[cid]; deleted = True
        guest_id = session.get("guest_id")
        if guest_id:
            cf = _guest_dir(guest_id) / "chats" / f"{cid}.json"
            if cf.exists(): cf.unlink(); deleted = True
        return deleted
    uid = session.get("user_id")
    if not uid: return False
    if not FIREBASE_ENABLED:
        cf = _local_user_dir(uid) / "chats" / f"{cid}.json"
        if cf.exists(): cf.unlink(); return True
        return False
    col = _chats_col()
    if not col: return False
    col.document(cid).delete()
    return True

def create_new_chat(model=None, folder=""):
    s = load_settings()
    if session.get("guest") and not session.get("user_id"):
        model = GUEST_MODEL
    return {"id": str(uuid.uuid4())[:12], "title": "New Chat",
            "created": datetime.datetime.now().isoformat(),
            "updated": datetime.datetime.now().isoformat(),
            "model": model or normalize_selected_model(s),
            "messages": [], "folder": folder}

# --- Workspace (shared) ------------------------------------------------------

def read_workspace_files():
    files = {}; total = 0
    for root, dirs, fnames in os.walk(WORKSPACE):
        dirs[:] = [d for d in dirs if d not in IGNORED_DIRS]
        for fn in sorted(fnames):
            if fn in IGNORED_FILES: continue
            if not fn.endswith((".md", ".txt", ".yaml", ".yml", ".json")): continue
            fp = Path(root) / fn; rp = fp.relative_to(WORKSPACE)
            try: content = fp.read_text(encoding="utf-8")
            except: continue
            if total + len(content) > MAX_CONTEXT_CHARS: break
            files[str(rp)] = content; total += len(content)
    return files

def format_workspace_context(files):
    if not files: return "(The command center is empty.)"
    return "\n".join(f"=== FILE: {p} ===\n{c}\n" for p, c in sorted(files.items()))

# --- KAIRO System Prompt -----------------------------------------------------

def _build_cross_chat_context(current_chat_id, max_chats=8):
    """Build a brief summary of other recent chats for cross-chat awareness."""
    try:
        all_chats = list_chats()
        lines = []
        count = 0
        for c in all_chats:
            if c["id"] == current_chat_id:
                continue
            title = c.get("title", "Untitled")
            if title in ("New Chat", "Untitled"):
                continue
            lines.append(f"- \"{title}\"")
            count += 1
            if count >= max_chats:
                break
        if not lines:
            return ""
        return (
            "\n\n[OTHER RECENT CONVERSATIONS]\n"
            "These are titles of the user's OTHER chats — completely separate conversations with their own context. "
            "CRITICAL RULES:\n"
            "- NEVER bring up topics from these other chats unless the user EXPLICITLY asks about them.\n"
            "- NEVER assume this conversation is related to or a continuation of any other chat.\n"
            "- NEVER reference, summarize, or hint at content from other conversations unprompted.\n"
            "- These titles are ONLY here so you can help if the user says something like \"remember that chat about X?\"\n"
            "- If the user does reference another chat, clarify that you can only see the title, not the full conversation.\n"
            + "\n".join(lines)
        )
    except Exception:
        return ""

def build_system_prompt(memory=None):
    custom = ""

    mem_section = ""
    if memory and memory.get("facts"):
        facts = [
            f for f in memory.get("facts", [])
            if not str(f).startswith("Why I built Gyro:")
            and not str(f).startswith("Why Gyro was built:")
        ]
        if facts:
            mem_section = (
                "[PERSISTENT MEMORY]\n"
                "These are facts the user previously asked you to remember.\n"
                "Rules: Only reference a fact when it is DIRECTLY relevant to the current request. "
                "Never volunteer memory facts in unrelated conversations. Never invent facts not listed here.\n"
                + "\n".join(f"{i}. {f}" for i, f in enumerate(facts, 1))
            )

    profile_section = ""
    try:
        p = load_profile()
        lines = []
        if p.get("preferred_name"):
            lines.append(f"Preferred name: {p.get('preferred_name')}")
        if p.get("what_you_do"):
            lines.append(f"Work: {p.get('what_you_do')}")
        if p.get("hobbies"):
            lines.append(f"Hobbies: {p.get('hobbies')}")
        if p.get("current_focus"):
            lines.append(f"Current focus: {p.get('current_focus')}")
        if lines:
            profile_section = (
                "[USER PROFILE CONTEXT]\n"
                "Use for personalization only (greeting by name, tailoring examples). "
                "Do NOT use profile info to guess what the user is asking about.\n"
                + "\n".join(lines)
            )
    except Exception:
        profile_section = ""

    user = _cur_user()
    is_guest = user.get("provider") == "guest" if user else False
    is_creator = user.get("email", "").lower().strip() == CREATOR_EMAIL if user else False
    if is_guest:
        uname = "there"
    else:
        uname = user.get("name", "there") if user else "there"
        if uname == "Guest" or not uname:
            uname = "there"

    if is_creator:
        creator_section = (
            f"[CREATOR ACCOUNT]\n"
            f"This user ({uname}) is the verified creator/developer of Gyro. "
            f"{DEFAULT_CREATOR_ORIGIN_STORY}"
        )
    else:
        creator_section = (
            "[IDENTITY PROTECTION]\n"
            "This user is not the verified creator account. "
            "Do not reveal creator personal details or private origin-story specifics."
        )

    if is_guest:
        session_name_line = (
            "The user is on a guest account. Do not treat 'Guest' as their name; "
            "use neutral greeting like 'hey there'."
        )
    else:
        session_name_line = f"The user you are talking to is named {uname}. Address them by this name when appropriate. Remember: YOU are Gyro, not {uname}."

    custom_block = ("Custom instructions:\n" + custom) if custom else ""

    return _build_system_prompt_template(
        session_name_line=session_name_line,
        today_iso=datetime.date.today().isoformat(),
        creator_section=creator_section,
        mem_section=mem_section,
        profile_section=profile_section,
        custom_block=custom_block,
    )

def fallback_chat_title(user_text, assistant_text=""):
    text = (user_text or assistant_text or "New Chat").strip()
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"^[^A-Za-z0-9]+", "", text)
    if not text:
        return "New Chat"
    words = text.split()
    title = " ".join(words[:6])
    return title[:48].strip(" -:,.?") or "New Chat"


def _clean_raw_title(raw_title, user_text="", assistant_text=""):
    """Clean AI-generated title text."""
    title = re.sub(r"\s+", " ", (raw_title or "").strip())
    title = title.strip('"\'` ')
    title = re.sub(r"[\r\n]+", " ", title)
    title = re.sub(r"[.!?]+$", "", title)
    if not title:
        return fallback_chat_title(user_text, assistant_text)
    return title[:48]

def generate_chat_title_fast(user_text):
    """Generate a title quickly using only the user's message with the lite model.
    Uses a direct minimal API call (no thinking, small max_tokens) for speed."""
    genai, types = _import_google()
    settings = load_settings()
    g_key = settings.get("keys", {}).get("google", "") or _load_server_key("google") or ""
    if not g_key:
        print("  [title] No Google API key found for title generation")
        raise ValueError("No Google API key")

    prompt = (
        "Create a short, friendly chat title for this message. "
        "Return only the title, no quotes, no punctuation at the end, 2 to 6 words max.\n\n"
        f"User: {user_text[:400]}"
    )
    client = genai.Client(api_key=g_key, http_options={"timeout": 15_000})
    contents = [types.Content(role="user", parts=[types.Part.from_text(text=prompt)])]
    cfg = types.GenerateContentConfig(
        system_instruction="You write concise conversation titles. Keep them specific, natural, and easy to scan. Return ONLY the title text, nothing else.",
        max_output_tokens=60,
    )
    for model_name in ("gemini-3.1-flash-lite-preview", "gemini-2.5-flash-lite", "gemini-2.5-flash"):
        try:
            r = client.models.generate_content(model=model_name, contents=contents, config=cfg)
            raw_title = r.text or ""
            if raw_title.strip():
                print(f"  [title] Generated with {model_name}: {raw_title.strip()!r}")
                return _clean_raw_title(raw_title, user_text)
        except Exception as e:
            print(f"  [title] {model_name} failed: {type(e).__name__}: {str(e)[:120]}")
            continue
    raise ValueError("All title generation models failed")

def generate_chat_title(api_key, provider, model_name, base_url, user_text, assistant_text):
    """Generate title using lite model directly (same approach as fast version)."""
    prompt = (
        "Create a short, friendly chat title for this conversation. "
        "Return only the title, no quotes, no punctuation at the end, 2 to 6 words max.\n\n"
        f"User: {user_text[:400]}\n"
        f"Assistant: {assistant_text[:400]}"
    )
    try:
        genai, types = _import_google()
        g_key = load_settings().get("keys", {}).get("google", "") or _load_server_key("google") or ""
        if g_key:
            client = genai.Client(api_key=g_key, http_options={"timeout": 15_000})
            contents = [types.Content(role="user", parts=[types.Part.from_text(text=prompt)])]
            cfg = types.GenerateContentConfig(
                system_instruction="You write concise conversation titles. Return ONLY the title text.",
                max_output_tokens=60,
            )
            for mn in ("gemini-flash-lite-latest", "gemini-2.5-flash-lite", "gemini-2.5-flash"):
                try:
                    r = client.models.generate_content(model=mn, contents=contents, config=cfg)
                    raw_title = r.text or ""
                    if raw_title.strip():
                        return _clean_raw_title(raw_title, user_text, assistant_text)
                except Exception:
                    continue
        # Non-Google fallback
        title_messages = [{"role": "user", "text": prompt}]
        title_system = "You write concise conversation titles. Return ONLY the title text."
        raw_title = PROVIDERS.get(provider, call_openai)(
            api_key, model_name, title_system, title_messages, base_url=base_url
        )
        return _clean_raw_title(raw_title, user_text, assistant_text)
    except Exception:
        return fallback_chat_title(user_text, assistant_text)

# --- File Operations ---------------------------------------------------------

def execute_file_operations(text):
    ops = []
    for pat in (r'<<<FILE_CREATE:\s*(.+?)>>>\n(.*?)<<<END_FILE>>>',
                r'<<<FILE_UPDATE:\s*(.+?)>>>\n(.*?)<<<END_FILE>>>'):
        for m in re.finditer(pat, text, re.DOTALL):
            ops.append((m.group(1).strip(), m.group(2).strip()))
    executed = []
    for rel, content in ops:
        clean = Path(rel).as_posix()
        if ".." in clean or clean.startswith("/"): continue
        # Block writes to protected server files
        if Path(clean).name in SERVER_FILES:
            continue
        fp = WORKSPACE / clean
        action = "Created" if not fp.exists() else "Updated"
        fp.parent.mkdir(parents=True, exist_ok=True)
        fp.write_text(content + "\n", encoding="utf-8")
        executed.append({"action": action, "path": clean, "content": content})
    return executed

def extract_memory_ops(text):
    return [m.group(1).strip() for m in re.finditer(r'<<<MEMORY_ADD:\s*(.+?)>>>', text)]


def extract_reminders(text):
    """Extract <<<REMINDER: datetime | message>>> tags from AI response.
    Returns (cleaned_text, [{'due': str, 'text': str}])."""
    pattern = re.compile(r'<<<REMINDER:\s*(.+?)\s*\|\s*(.+?)>>>')
    reminders = []
    def _replace(m):
        due = m.group(1).strip()
        msg = m.group(2).strip()
        if due and msg:
            reminders.append({"due": due, "text": msg})
        return ""
    cleaned = pattern.sub(_replace, text)
    return cleaned, reminders

# --- Code Execution ----------------------------------------------------------

def _save_uploaded_images(ctx):
    """Save uploaded images from user's message to _uploads/ so code execution can access them.
    Returns list of saved file paths (relative to WORKSPACE) or empty list."""
    user_msg = ctx.get("user_msg", {})
    images = user_msg.get("images", [])
    if not images:
        return []
    uploads_dir = WORKSPACE / "_uploads"
    # Clean any previous uploads first
    if uploads_dir.exists():
        import shutil
        shutil.rmtree(uploads_dir, ignore_errors=True)
    uploads_dir.mkdir(exist_ok=True)
    saved = []
    for i, img in enumerate(images):
        data = img.get("data", "")
        mime = img.get("mime", "image/png")
        orig_name = img.get("name", "")
        ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp"}.get(mime, ".png")
        # Use original filename (sanitized) so AI can see meaningful names
        if orig_name:
            safe_name = re.sub(r'[^\w\s\-.]', '_', orig_name)
            fname = f"upload_{i+1}_{safe_name}"
            # Ensure correct extension
            if not fname.lower().endswith(ext):
                fname = os.path.splitext(fname)[0] + ext
        else:
            fname = f"upload_{i+1}{ext}"
        fpath = uploads_dir / fname
        try:
            fpath.write_bytes(base64.b64decode(data))
            saved.append(f"_uploads/{fname}")
        except Exception:
            pass
    return saved

def _cleanup_uploaded_images():
    """Remove uploaded files older than 24 hours from _uploads/ directory."""
    uploads_dir = WORKSPACE / "_uploads"
    if not uploads_dir.exists():
        return
    import time as _time
    cutoff = _time.time() - 86400  # 24 hours
    any_remaining = False
    for f in uploads_dir.iterdir():
        try:
            if f.stat().st_mtime < cutoff:
                f.unlink(missing_ok=True)
            else:
                any_remaining = True
        except Exception:
            pass
    # Only remove the directory if it's empty
    if not any_remaining:
        try:
            uploads_dir.rmdir()
        except Exception:
            pass

def execute_code_blocks(text, exclude_paths=None, uploaded_image_paths=None):
    """Extract <<<CODE_EXECUTE: lang>>>...<<<END_CODE>>> blocks, execute them, and return results.
    Also detects files created/modified by the code and includes them in results.
    exclude_paths: set of relative paths to ignore (e.g. files created by FILE_CREATE/FILE_UPDATE).
    uploaded_image_paths: list of relative paths to uploaded images available in _uploads/."""
    import subprocess, tempfile, os
    # Tolerant pattern: closing >>> on opening tag is optional, END_CODE closing >>> is optional
    pattern = r'<<<CODE_EXECUTE:\s*(\w+)(?:>>>|>>|>)?\s*\r?\n(.*?)<<<END_CODE(?:>>>|>>|>)?'
    # Fallback: if model forgot <<<END_CODE>>> entirely, grab everything after the opening tag
    # up to the next <<< tag or end of string
    fallback_pattern = r'<<<CODE_EXECUTE:\s*(\w+)(?:>>>|>>|>)?\s*\r?\n(.*?)(?=<<<[A-Z_]|$)'
    results = []
    _exclude = set(exclude_paths or [])
    # Protected dirs/files that code shouldn't claim credit for
    _ignore_dirs = {'.git', '__pycache__', '.venv', 'static', 'node_modules', '.gyro_data', 'notes', '_uploads'}
    _ignore_files = {'app.py', 'requirements.txt', 'Procfile', 'render.yaml', '.env', '.gitignore', 'system_prompt.py', 'prompts.md'}
    matches = list(re.finditer(pattern, text, re.DOTALL))
    if not matches:
        # Try fallback pattern for missing END_CODE tags
        matches = list(re.finditer(fallback_pattern, text, re.DOTALL))
    for m in matches:
        lang = m.group(1).strip().lower()
        code = m.group(2).strip()
        if lang not in ("python", "py"):
            results.append({"language": lang, "code": code, "output": f"Execution not supported for '{lang}'.", "success": False, "files": []})
            continue
        try:
            # Snapshot workspace files before execution to detect new/modified files
            code_output_dir_pre = WORKSPACE / "_code_output"
            code_output_dir_pre.mkdir(exist_ok=True)
            pre_snapshot = {}
            for p in code_output_dir_pre.rglob('*'):
                if p.is_file():
                    try:
                        pre_snapshot[str(p.relative_to(WORKSPACE))] = p.stat().st_mtime
                    except Exception:
                        pass

            # Build optimised wrapper: pre-import heavy libs so cached .pyc is used
            _needs_sympy = 'sympy' in code or ' sp.' in code or 'sp.Symbol' in code
            _needs_numpy = 'numpy' in code or ' np.' in code or 'np.array' in code
            _needs_matplotlib = 'matplotlib' in code or 'pyplot' in code or 'plt.' in code
            prelude_lines = []
            if _needs_sympy:
                prelude_lines.append("import sympy")
            if _needs_numpy:
                prelude_lines.append("import numpy")
            if _needs_matplotlib:
                prelude_lines.append("import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot")
            prelude = "\n".join(prelude_lines) + "\n" if prelude_lines else ""

            with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as tmp:
                tmp.write(prelude + code)
                tmp_path = tmp.name
            # Inherit env; allow .pyc caching for faster repeated imports
            exec_env = {**os.environ}
            # Pass uploaded image paths so code can find them
            if uploaded_image_paths:
                exec_env["UPLOADED_IMAGES"] = ",".join(uploaded_image_paths)
            # Run code in _code_output/ subfolder to keep workspace root clean
            code_output_dir = WORKSPACE / "_code_output"
            code_output_dir.mkdir(exist_ok=True)
            result = subprocess.run(
                [sys.executable, "-u", tmp_path],
                capture_output=True, text=True, timeout=180,
                env=exec_env,
                cwd=str(code_output_dir),
            )
            os.unlink(tmp_path)
            output = result.stdout
            if result.stderr:
                # Filter out pip install noise from stderr
                stderr_lines = [l for l in result.stderr.splitlines()
                                if not l.strip().startswith(("Requirement already", "WARNING:", "[notice]", "Successfully installed"))]
                filtered_stderr = "\n".join(stderr_lines).strip()
                if filtered_stderr:
                    output += ("\n" if output else "") + filtered_stderr
            # Detect new/modified files after execution (only in _code_output/)
            generated_files = []
            for p in code_output_dir.rglob('*'):
                if p.is_file() and not p.name.startswith('.'):
                    try:
                        rel = str(p.relative_to(WORKSPACE)).replace('\\', '/')
                        if rel in _exclude:
                            continue
                        mtime = p.stat().st_mtime
                        if rel not in pre_snapshot or mtime > pre_snapshot[rel]:
                            ext = p.suffix.lower()
                            is_image = ext in ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp')
                            generated_files.append({
                                "path": rel,
                                "name": p.name,
                                "size": p.stat().st_size,
                                "is_image": is_image,
                            })
                    except Exception:
                        pass
            # Embed file data as base64 so files persist in chat even after server restart
            for gf in generated_files:
                try:
                    fp = WORKSPACE / gf["path"]
                    if fp.exists() and gf["size"] <= 2_000_000:  # Cap at 2MB
                        gf["data"] = base64.b64encode(fp.read_bytes()).decode()
                        gf["mime"] = mimetypes.guess_type(gf["name"])[0] or "application/octet-stream"
                except Exception:
                    pass
            results.append({"language": lang, "code": code, "output": output.strip() or "(no output)", "success": result.returncode == 0, "files": generated_files})
        except subprocess.TimeoutExpired:
            try: os.unlink(tmp_path)
            except Exception: pass
            results.append({"language": lang, "code": code, "output": "Execution timed out (3 minute limit).", "success": False, "files": []})
        except Exception as e:
            results.append({"language": lang, "code": code, "output": f"Error: {e}", "success": False, "files": []})
    return results

def _strip_thinking_blocks(text):
    """Remove <<<THINKING>>>...<<<END_THINKING>>> blocks so trigger extraction doesn't match inside AI reasoning."""
    return re.sub(r'<<<THINKING>>>.*?<<<END_THINKING>>>', '', text, flags=re.DOTALL)

def extract_research_trigger(text):
    """Extract <<<DEEP_RESEARCH: query>>> from AI response and return (cleaned_text, query_or_None)."""
    # Search in text with thinking blocks removed, so we don't match triggers
    # the AI merely discussed in its reasoning (e.g. "triggered by <<<DEEP_RESEARCH: ...>>>")
    search_text = _strip_thinking_blocks(text)
    m = re.search(r'<<<DEEP_RESEARCH:\s*(.+?)>>>', search_text)
    if m:
        query = m.group(1).strip()
        cleaned = re.sub(r'<<<DEEP_RESEARCH:\s*.+?>>>', '', text).strip()
        return cleaned, query
    return text, None

def extract_image_generation(text):
    """Extract <<<IMAGE_GENERATE: prompt>>> or <<<IMAGE_GENERATE: prompt | size=WxH>>> tags.
    Returns (cleaned_text, [{'prompt': str, 'aspect_ratio': str, 'index': int}])."""
    pattern = re.compile(r'<<<IMAGE_GENERATE:\s*(.+?)>>>')
    generations = []
    idx = 0
    def _replace(m):
        nonlocal idx
        raw = m.group(1).strip()
        aspect_ratio = "1:1"
        prompt = raw
        if '|' in raw:
            parts = [p.strip() for p in raw.split('|', 1)]
            prompt = parts[0]
            for param in parts[1].split(','):
                param = param.strip()
                if param.lower().startswith('aspect_ratio=') or param.lower().startswith('ratio='):
                    val = param.split('=', 1)[1].strip()
                    if val in ("1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9"):
                        aspect_ratio = val
        generations.append({'prompt': prompt, 'aspect_ratio': aspect_ratio, 'index': idx})
        placeholder = f'%%%IMGGEN:{idx}%%%'
        idx += 1
        return placeholder
    result_text = pattern.sub(_replace, text)
    return result_text, generations

def generate_image_gemini(prompt, aspect_ratio="1:1", api_key=None, reference_images=None):
    """Generate an image using Gemini 2.5 Flash Image model.
    reference_images: optional list of {data: base64_str, mime: str} to use as visual references.
    Returns (image_base64, mime_type) or (None, error_str)."""
    try:
        genai, types = _import_google()
        if not api_key:
            settings = load_settings()
            api_key, _ = resolve_provider_key(settings, "google")
        if not api_key:
            api_key = _load_server_key("google")
        if not api_key:
            return None, "No Google API key configured"
        client = genai.Client(api_key=api_key)
        # Build contents: text prompt + optional reference images
        if reference_images:
            parts = [types.Part.from_text(text=prompt)]
            for img in reference_images:
                try:
                    parts.append(types.Part.from_bytes(
                        data=base64.b64decode(img["data"]),
                        mime_type=img["mime"]
                    ))
                except Exception:
                    pass
            contents = types.Content(role="user", parts=parts)
        else:
            contents = prompt
        response = client.models.generate_content(
            model="gemini-2.5-flash-image",
            contents=contents,
            config=types.GenerateContentConfig(
                response_modalities=['TEXT', 'IMAGE'],
                image_config=types.ImageConfig(aspect_ratio=aspect_ratio),
            ),
        )
        text_parts = []
        for part in (response.candidates[0].content.parts if response.candidates else []):
            if getattr(part, 'inline_data', None) and part.inline_data.mime_type.startswith('image/'):
                img_data = base64.b64encode(part.inline_data.data).decode('utf-8')
                return img_data, part.inline_data.mime_type
            elif getattr(part, 'text', None):
                text_parts.append(part.text)
        # No image returned
        return None, "Model did not generate an image" + (f": {' '.join(text_parts)}" if text_parts else "")
    except Exception as e:
        return None, f"Image generation failed: {str(e)[:200]}"

# --- HuggingFace Space Connector ---------------------------------------------

def extract_hf_space_calls(text):
    """Extract <<<HF_SPACE: space_id | input text or JSON>>> tags from AI response.
    Returns (text_with_placeholders, [{'space': str, 'input': str, 'params': dict, 'index': int}])."""
    pattern = re.compile(r'<<<HF_SPACE:\s*(.+?)>>>')
    calls = []
    idx = 0
    def _replace(m):
        nonlocal idx
        raw = m.group(1).strip()
        space_id = raw
        user_input = ""
        params = {}
        if '|' in raw:
            parts = [p.strip() for p in raw.split('|')]
            space_id = parts[0]
            if len(parts) > 1:
                user_input = parts[1]
            # Parse optional key=value params after the second pipe
            for extra in parts[2:]:
                if '=' in extra:
                    k, v = extra.split('=', 1)
                    params[k.strip()] = v.strip()
        calls.append({'space': space_id, 'input': user_input, 'params': params, 'index': idx})
        placeholder = f'%%%HFBLOCK:{idx}%%%'
        idx += 1
        return placeholder
    result_text = pattern.sub(_replace, text)
    return result_text, calls


def run_hf_space(space_id, user_input, params=None, hf_token=None):
    """Call a HuggingFace Space via gradio_client. Returns a dict with results.
    
    Returns:
      {"success": True, "type": "image"|"text"|"video"|"audio"|"file", "data": ..., "mime": ...}
      or {"success": False, "error": "..."}
    """
    if not hf_token:
        return {"success": False, "error": "No HuggingFace token configured. Set up the HuggingFace connector in Settings > Connectors."}
    try:
        from gradio_client import Client, handle_file
        client = Client(space_id, hf_token=hf_token)
        api_info = client.view_api(return_format="dict")
        
        # Find the main prediction endpoint
        endpoints = api_info.get("named_endpoints", {})
        unnamed = api_info.get("unnamed_endpoints", {})
        
        # Prefer /predict, /generate, /run, or the first unnamed endpoint
        endpoint_name = None
        for name in ("/predict", "/generate", "/run", "/infer", "/process"):
            if name in endpoints:
                endpoint_name = name
                break
        if not endpoint_name and endpoints:
            endpoint_name = next(iter(endpoints))
        
        # Build the input - try to be smart about what the Space expects
        api_name = endpoint_name
        fn_index = None
        if not api_name and unnamed:
            fn_index = int(next(iter(unnamed)))
        
        # Call the Space
        if api_name:
            result = client.predict(user_input, api_name=api_name)
        elif fn_index is not None:
            result = client.predict(user_input, fn_index=fn_index)
        else:
            result = client.predict(user_input)

        return _process_hf_result(result, space_id)
    except Exception as e:
        err = str(e)
        if "token" in err.lower() or "401" in err or "403" in err:
            return {"success": False, "error": f"HuggingFace authentication failed. Check your token in Settings > Connectors. ({err[:150]})"}
        if "not found" in err.lower() or "404" in err:
            return {"success": False, "error": f"Space '{space_id}' not found. Check the Space ID (format: username/space-name). ({err[:150]})"}
        if "queue" in err.lower() or "timeout" in err.lower():
            return {"success": False, "error": f"Space '{space_id}' is busy or timed out. Try again in a moment. ({err[:150]})"}
        return {"success": False, "error": f"HuggingFace Space error: {err[:200]}"}


def run_hf_inference(task, model_id, user_input, hf_token=None, params=None):
    """Call HuggingFace Inference API for standard tasks.
    
    Supported tasks: text-to-image, image-to-image, text-to-video, text-to-speech, etc.
    Returns same format as run_hf_space.
    """
    if not hf_token:
        return {"success": False, "error": "No HuggingFace token configured."}
    try:
        from huggingface_hub import InferenceClient
        client = InferenceClient(token=hf_token)
        
        if task == "text-to-image":
            image = client.text_to_image(user_input, model=model_id, **(params or {}))
            buf = io.BytesIO()
            image.save(buf, format="PNG")
            img_b64 = base64.b64encode(buf.getvalue()).decode()
            return {"success": True, "type": "image", "data": f"data:image/png;base64,{img_b64}", "mime": "image/png"}
        
        elif task == "text-to-speech":
            audio_bytes = client.text_to_speech(user_input, model=model_id)
            audio_b64 = base64.b64encode(audio_bytes).decode()
            return {"success": True, "type": "audio", "data": f"data:audio/wav;base64,{audio_b64}", "mime": "audio/wav"}
        
        elif task == "text-to-video":
            # Most video models use Spaces, not the Inference API directly
            return {"success": False, "error": "Text-to-video typically requires a HuggingFace Space. Use <<<HF_SPACE: space_id | prompt>>> instead."}
        
        elif task == "image-to-text":
            result = client.image_to_text(user_input, model=model_id)
            text = result if isinstance(result, str) else str(result)
            return {"success": True, "type": "text", "data": text}
        
        elif task == "summarization":
            result = client.summarization(user_input, model=model_id)
            text = result.summary_text if hasattr(result, 'summary_text') else str(result)
            return {"success": True, "type": "text", "data": text}
        
        elif task == "translation":
            result = client.translation(user_input, model=model_id)
            text = result.translation_text if hasattr(result, 'translation_text') else str(result)
            return {"success": True, "type": "text", "data": text}
        
        else:
            return {"success": False, "error": f"Unsupported task: {task}. Use <<<HF_SPACE>>> for custom Spaces."}
    
    except Exception as e:
        return {"success": False, "error": f"HuggingFace Inference API error: {str(e)[:200]}"}


def _process_hf_result(result, space_id):
    """Process gradio_client result into a standardized format."""
    if result is None:
        return {"success": True, "type": "text", "data": "(Space returned no output)"}
    
    # Tuple results (multiple outputs) — take the most interesting one
    if isinstance(result, tuple):
        for item in result:
            processed = _process_hf_result(item, space_id)
            if processed.get("success") and processed.get("type") != "text":
                return processed
        # Fall back to first item
        return _process_hf_result(result[0], space_id) if result else {"success": True, "type": "text", "data": ""}
    
    # String result — could be a file path or text
    if isinstance(result, str):
        if os.path.isfile(result):
            return _process_hf_file(result)
        return {"success": True, "type": "text", "data": result}
    
    # Dict result (gradio returns these sometimes)
    if isinstance(result, dict):
        if "path" in result and os.path.isfile(result["path"]):
            return _process_hf_file(result["path"])
        if "url" in result:
            return {"success": True, "type": "url", "data": result["url"]}
        return {"success": True, "type": "text", "data": json.dumps(result, default=str)[:2000]}
    
    # List of results
    if isinstance(result, list):
        items = []
        for item in result[:5]:
            processed = _process_hf_result(item, space_id)
            if processed.get("success"):
                items.append(processed)
        if items:
            return items[0] if len(items) == 1 else {"success": True, "type": "multi", "data": items}
    
    return {"success": True, "type": "text", "data": str(result)[:2000]}


def _process_hf_file(filepath):
    """Read a file returned by gradio_client and convert to base64 data URI."""
    try:
        mime = mimetypes.guess_type(filepath)[0] or "application/octet-stream"
        with open(filepath, "rb") as f:
            data = f.read()
        b64 = base64.b64encode(data).decode()
        
        if mime.startswith("image/"):
            return {"success": True, "type": "image", "data": f"data:{mime};base64,{b64}", "mime": mime}
        elif mime.startswith("video/"):
            return {"success": True, "type": "video", "data": f"data:{mime};base64,{b64}", "mime": mime}
        elif mime.startswith("audio/"):
            return {"success": True, "type": "audio", "data": f"data:{mime};base64,{b64}", "mime": mime}
        else:
            # Save to workspace for download
            fname = os.path.basename(filepath)
            dest = WORKSPACE / fname
            if not dest.exists():
                import shutil
                shutil.copy2(filepath, str(dest))
            return {"success": True, "type": "file", "data": fname, "mime": mime}
    except Exception as e:
        return {"success": False, "error": f"Failed to process output file: {str(e)[:200]}"}

# --- End HuggingFace Connector -----------------------------------------------

def extract_image_searches(text):
    """Extract <<<IMAGE_SEARCH: query>>> or <<<IMAGE_SEARCH: query | count=N>>> tags.
    Returns (text_with_placeholders, [{'query': str, 'count': int, 'index': int}]).
    Tags are replaced with %%%IMGBLOCK:index%%% placeholders so images render inline."""
    # Also catch common malformations: %%%, <<, or mismatched brackets
    pattern = re.compile(r'(?:<<<|%%%|<<)IMAGE_SEARCH:\s*(.+?)(?:>>>|%%%)') 
    searches = []
    idx = 0
    def _replace(m):
        nonlocal idx
        raw = m.group(1).strip()
        # Parse optional | count=N
        count = 8  # default
        query = raw
        if '|' in raw:
            parts = [p.strip() for p in raw.split('|', 1)]
            query = parts[0]
            for param in parts[1].split(','):
                param = param.strip()
                if param.lower().startswith('count='):
                    try:
                        count = max(1, min(int(param.split('=', 1)[1].strip()), 20))
                    except ValueError:
                        pass
        searches.append({'query': query, 'count': count, 'index': idx})
        placeholder = f'%%%IMGBLOCK:{idx}%%%'
        idx += 1
        return placeholder
    result_text = pattern.sub(_replace, text)
    return result_text, searches


def extract_stock_tickers(text):
    """Extract <<<STOCK: TICKER>>> tags from AI response.
    Returns (text_with_placeholders, [{'ticker': str, 'index': int}]).
    Tags are replaced with %%%STOCKBLOCK:index%%% placeholders."""
    pattern = re.compile(r'(?:<<<|%%%|<<)STOCK:\s*(.+?)(?:>>>|%%%)')
    tickers = []
    idx = 0
    def _replace(m):
        nonlocal idx
        ticker = m.group(1).strip().upper()
        ticker = re.sub(r'[^A-Za-z0-9.\-^=]', '', ticker)
        if ticker:
            tickers.append({'ticker': ticker, 'index': idx})
            placeholder = f'%%%STOCKBLOCK:{idx}%%%'
            idx += 1
            return placeholder
        return m.group(0)
    result_text = pattern.sub(_replace, text)
    return result_text, tickers


def search_images(query, num=8):
    """Search images with DuckDuckGo (single fast attempt) + Bing fallback."""
    # --- Attempt 1: DuckDuckGo via library (single attempt, fast timeout) ---
    try:
        try:
            from ddgs import DDGS
        except ImportError:
            from duckduckgo_search import DDGS
        with DDGS(timeout=8) as ddgs:
            raw = list(ddgs.images(query, max_results=num, safesearch="moderate"))
        if raw:
            results = []
            for item in raw:
                results.append({
                    "url": item.get("image", ""),
                    "title": item.get("title", ""),
                    "thumbnail": item.get("thumbnail", item.get("image", "")),
                    "context_url": item.get("url", ""),
                    "width": item.get("width", 0),
                    "height": item.get("height", 0),
                })
            return results
    except Exception as e:
        print(f"  [image-search] DDG error: {e}")

    # --- Attempt 2: Bing image scraping fallback ---
    try:
        import requests as _req
        from bs4 import BeautifulSoup as _BS
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        }
        url = f"https://www.bing.com/images/search?q={_req.utils.quote(query)}&first=1&count={num}"
        resp = _req.get(url, headers=headers, timeout=5)
        soup = _BS(resp.text, "html.parser")
        results = []
        for a_tag in soup.select("a.iusc"):
            import json as _json
            m_attr = a_tag.get("m")
            if not m_attr:
                continue
            try:
                m_data = _json.loads(m_attr)
            except Exception:
                continue
            img_url = m_data.get("murl", "")
            thumb = m_data.get("turl", img_url)
            title = m_data.get("t", "")
            if img_url:
                results.append({
                    "url": img_url,
                    "title": title,
                    "thumbnail": thumb,
                    "context_url": m_data.get("purl", ""),
                    "width": 0,
                    "height": 0,
                })
            if len(results) >= num:
                break
        if results:
            print(f"  [image-search] Bing fallback returned {len(results)} results for '{query}'")
            return results
    except Exception as e:
        print(f"  [image-search] Bing fallback error: {e}")

    print(f"  [image-search] ALL methods failed for '{query}'")
    return []

def clean_response(text, keep_img_placeholders=False):
    text = re.sub(r'<<<THINKING>>>[\s\S]*?<<<END_THINKING>>>', '', text, flags=re.DOTALL)
    text = re.sub(r'<<</?THINKING/?>>>', '', text)
    text = re.sub(r'<<</?END_THINKING/?>>>', '', text)
    text = re.sub(r'<<<FILE_CREATE:\s*.+?>>>.*?<<<END_FILE>>>', '', text, flags=re.DOTALL)
    text = re.sub(r'<<<FILE_UPDATE:\s*.+?>>>.*?<<<END_FILE>>>', '', text, flags=re.DOTALL)
    text = re.sub(r'<<<CODE_EXECUTE:\s*\w+(?:>>>|>>|>)?\s*\r?\n.*?<<<END_CODE(?:>>>|>>|>)?', '', text, flags=re.DOTALL)
    # Also strip malformed CODE_EXECUTE blocks missing END_CODE
    text = re.sub(r'<<<CODE_EXECUTE:\s*\w+(?:>>>|>>|>)?\s*\r?\n.*?(?=<<<[A-Z_]|$)', '', text, flags=re.DOTALL)
    text = re.sub(r'<<<MEMORY_ADD:\s*.+?>>>', '', text)
    text = re.sub(r'<<<DEEP_RESEARCH:\s*.+?>>>', '', text)
    text = re.sub(r'(?:<<<|%%%|<<)IMAGE_SEARCH:\s*.+?(?:>>>|%%%)', '', text)
    text = re.sub(r'<<<IMAGE_GENERATE:\s*.+?>>>', '', text)
    text = re.sub(r'<<<HF_SPACE:\s*.+?>>>', '', text)
    text = re.sub(r'<<<CONTINUE>>>', '', text)
    # Strip image/stock/hf placeholders so saved messages are clean (unless caller needs them)
    if not keep_img_placeholders:
        text = re.sub(r'%%%IMGBLOCK:\d+%%%', '', text)
        text = re.sub(r'%%%IMGGEN:\d+%%%', '', text)
        text = re.sub(r'%%%STOCKBLOCK:\d+%%%', '', text)
        text = re.sub(r'%%%HFBLOCK:\d+%%%', '', text)
    return text.strip()

_YT_RE = re.compile(r'(?:https?://)?(?:www\.)?(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/shorts/)([\w-]{11})')

def _extract_youtube_urls(text):
    """Return list of full YouTube URLs found in text."""
    urls = []
    for m in _YT_RE.finditer(text or ""):
        vid = m.group(1)
        urls.append(f"https://www.youtube.com/watch?v={vid}")
    return urls

def _google_contents_from_messages(messages, types):
    contents = []
    for msg in messages:
        role = "user" if msg["role"] == "user" else "model"
        parts = []
        if msg.get("text"):
            parts.append(types.Part.from_text(text=msg["text"]))
        # YouTube URLs ? Gemini FileData so the model can watch the video
        for yt_url in msg.get("youtube_urls", []):
            try:
                parts.append(types.Part.from_uri(file_uri=yt_url, mime_type="video/*"))
            except Exception:
                pass
        for img in msg.get("images", []):
            try:
                raw = img["data"]
                # Strip data-URI prefix if present (e.g. "data:image/png;base64,...")
                if raw and raw.startswith("data:") and "," in raw:
                    raw = raw.split(",", 1)[1]
                parts.append(types.Part.from_bytes(data=base64.b64decode(raw), mime_type=img["mime"]))
            except Exception:
                pass
        for doc in msg.get("documents", []):
            try:
                raw = doc["data"]
                if raw and raw.startswith("data:") and "," in raw:
                    raw = raw.split(",", 1)[1]
                parts.append(types.Part.from_text(text=f"[Attached document: {doc.get('name', 'document')}]"))
                parts.append(types.Part.from_bytes(data=base64.b64decode(raw), mime_type=doc["mime"]))
            except Exception:
                pass
        if msg.get("file_text"):
            parts.append(types.Part.from_text(text=f"[Attached: {msg.get('file_name','')}]\n{msg['file_text']}"))
        if parts:
            # Merge with previous Content if same role (Google API rejects consecutive same-role entries)
            if contents and contents[-1].role == role:
                contents[-1].parts.extend(parts)
            else:
                contents.append(types.Content(role=role, parts=parts))
    return contents

def resolve_chat_model(chat, settings):
    # Guests are always on the lite model regardless of what they select
    if session.get("guest") and not session.get("user_id"):
        model_id = GUEST_MODEL
    else:
        model_id = chat.get("model") or normalize_selected_model(settings)
    allowed, reason, source = model_access(model_id, settings)
    if not allowed:
        return {"error": reason, "model_id": model_id}

    if model_id.startswith("custom:"):
        ep_name = model_id.split(":", 1)[1]
        ep = next((e for e in settings.get("custom_endpoints", []) if e["name"] == ep_name), None)
        if not ep:
            return {"error": "Custom endpoint not found.", "model_id": model_id}
        api_key, _ = resolve_provider_key(settings, "custom")
        return {
            "model_id": model_id,
            "provider": ep.get("provider_type", "openai"),
            "actual_model": ep.get("model", ""),
            "base_url": ep.get("base_url"),
            "api_key": api_key,
            "key_source": source,
        }

    model_info = MODELS.get(model_id)
    provider = model_info["provider"]
    api_key, source = resolve_provider_key(settings, provider)
    return {
        "model_id": model_id,
        "provider": provider,
        "actual_model": model_id,
        "base_url": None,
        "api_key": api_key,
        "key_source": source,
    }


def _build_tool_instructions(active_tools):
    """Build additional system prompt instructions based on which tools the user activated."""
    return _build_tool_instructions_template(active_tools)

def _extract_price_criteria(user_query):
    """Parse user query for price constraints. Returns dict with 'max_price', 'min_price' if found."""
    if not user_query:
        return {}
    criteria = {}
    q = user_query.lower()
    # Match "under $25", "below $50", "less than $100", "< $30", "max $20", "cheaper than $15"
    max_patterns = [
        r'(?:under|below|less\s+than|cheaper\s+than|max|<|at\s+most|no\s+more\s+than|up\s+to)\s*\$?\s*(\d+(?:\.\d+)?)',
        r'\$?\s*(\d+(?:\.\d+)?)\s*(?:or\s+(?:less|under|below|cheaper))',
        r'(?:price\s*(?:range|limit)?)\s*(?:under|below|<)\s*\$?\s*(\d+(?:\.\d+)?)',
    ]
    for pat in max_patterns:
        m = re.search(pat, q)
        if m:
            try:
                criteria['max_price'] = float(m.group(1))
                break
            except ValueError:
                pass
    # Match "over $10", "above $5", "more than $20", "> $15", "min $10"
    min_patterns = [
        r'(?:over|above|more\s+than|greater\s+than|min|>|at\s+least)\s*\$?\s*(\d+(?:\.\d+)?)',
        r'\$?\s*(\d+(?:\.\d+)?)\s*(?:or\s+(?:more|above|over))',
    ]
    for pat in min_patterns:
        m = re.search(pat, q)
        if m:
            try:
                criteria['min_price'] = float(m.group(1))
                break
            except ValueError:
                pass
    return criteria


def _validate_stocks_against_criteria(stock_data_list, criteria):
    """Check which stocks pass/fail user criteria. Returns (passing, failing) lists."""
    if not criteria:
        return stock_data_list, []
    passing = []
    failing = []
    for d in stock_data_list:
        if d.get('error'):
            failing.append(d)
            continue
        price = d.get('price') or d.get('currentPrice') or 0
        failed = False
        if criteria.get('max_price') and price > criteria['max_price']:
            failed = True
        if criteria.get('min_price') and price < criteria['min_price']:
            failed = True
        if failed:
            failing.append(d)
        else:
            passing.append(d)
    return passing, failing


def _assess_chart_health(stock_data):
    """Evaluate chart/technical quality of a stock. Returns score 0-100 and verdict string."""
    t = stock_data.get('technicals', {})
    perf = stock_data.get('perf', {})
    price = stock_data.get('price', 0)
    score = 50  # neutral baseline

    # Trend: price vs SMA 50/200
    sma50 = t.get('sma50')
    sma200 = t.get('sma200')
    if sma50 and price:
        if price > sma50:
            score += 8
        else:
            score -= 8
    if sma200 and price:
        if price > sma200:
            score += 10
        else:
            score -= 12  # below 200 SMA is bad
    # Golden/death cross
    if sma50 and sma200:
        if sma50 > sma200:
            score += 5  # golden cross territory
        else:
            score -= 8  # death cross territory

    # RSI
    rsi = t.get('rsi14')
    if rsi is not None:
        if 40 <= rsi <= 60:
            score += 3  # neutral
        elif 30 <= rsi < 40:
            score += 5  # oversold bounce potential
        elif rsi < 30:
            score += 2  # deeply oversold — risky
        elif 60 < rsi <= 70:
            score += 4  # bullish momentum
        elif rsi > 70:
            score -= 2  # overbought risk

    # MACD
    macd_hist = t.get('macd_hist')
    if macd_hist is not None:
        if macd_hist > 0:
            score += 5
        else:
            score -= 5

    # Performance trend
    perf_1m = perf.get('1m')
    perf_3m = perf.get('3m')
    perf_ytd = perf.get('ytd')
    perf_1y = perf.get('1y')
    if perf_1m is not None:
        if perf_1m > 5: score += 4
        elif perf_1m > 0: score += 2
        elif perf_1m > -5: score -= 2
        else: score -= 5
    if perf_3m is not None:
        if perf_3m > 10: score += 5
        elif perf_3m > 0: score += 2
        elif perf_3m > -10: score -= 3
        else: score -= 6
    if perf_ytd is not None:
        if perf_ytd < -20: score -= 8
        elif perf_ytd < -10: score -= 4
        elif perf_ytd > 20: score += 5
        elif perf_ytd > 0: score += 2

    # 52-week position
    high52 = stock_data.get('week52High')
    low52 = stock_data.get('week52Low')
    if high52 and low52 and price and high52 > low52:
        position = (price - low52) / (high52 - low52)
        if position < 0.2:
            score -= 8  # near 52-week low = terrible chart
        elif position < 0.4:
            score -= 3
        elif position > 0.8:
            score += 5  # near highs = strong chart
        elif position > 0.6:
            score += 3

    # Bollinger Band %B
    bb_pctb = t.get('bb_pctB')
    if bb_pctb is not None:
        if bb_pctb < 0:
            score -= 5  # below lower band
        elif bb_pctb > 1:
            score -= 2  # above upper band (overbought)
        elif 0.4 <= bb_pctb <= 0.6:
            score += 2  # middle of bands

    score = max(0, min(100, score))
    if score >= 70:
        verdict = "strong"
    elif score >= 55:
        verdict = "decent"
    elif score >= 40:
        verdict = "weak"
    else:
        verdict = "poor"
    return score, verdict


def _build_stock_reprompt_summary(stock_results):
    """Build a concise summary of fetched stock data for auto-reprompt."""
    lines = []
    for sr in stock_results:
        d = sr.get("data", {})
        if not d or d.get("error"):
            continue
        line = f"{d['ticker']} ({d.get('name','')}) — ${d['price']:.2f}"
        if d.get('changePct') is not None:
            sign = '+' if d['changePct'] >= 0 else ''
            line += f" ({sign}{d['changePct']:.2f}%)"
        if d.get('verdict'): line += f" | Verdict: {d['verdict'].upper()}"
        if d.get('health', {}).get('score') is not None:
            line += f" | Health: {d['health']['score']}/100"
        if d.get('pe'): line += f" | P/E: {d['pe']:.1f}"
        if d.get('marketCap'):
            mc = d['marketCap']
            if mc >= 1e12: line += f" | MCap: ${mc/1e12:.2f}T"
            elif mc >= 1e9: line += f" | MCap: ${mc/1e9:.2f}B"
        if d.get('recommendation'): line += f" | Analyst: {d['recommendation']}"
        perf = d.get('perf', {})
        perf_parts = []
        for k, label in [('1m','1M'),('ytd','YTD'),('1y','1Y')]:
            if perf.get(k) is not None:
                perf_parts.append(f"{label}: {'+' if perf[k]>=0 else ''}{perf[k]:.1f}%")
        if perf_parts: line += f" | {', '.join(perf_parts)}"
        h = d.get('health', {})
        if h.get('profitMargin') is not None: line += f" | Margin: {h['profitMargin']*100:.1f}%"
        if h.get('revenueGrowth') is not None: line += f" | RevGrowth: {h['revenueGrowth']*100:.1f}%"
        if d.get('risk'): line += f" | Risk: {d['risk']}"
        lines.append(line)
    return "\n".join(lines) if lines else ""


def _build_full_stock_dump(stock_data_list):
    """Build a comprehensive data dump of ALL stock fields for the agent to analyze."""
    def _fmt_big(v):
        if v is None: return "N/A"
        try:
            v = float(v)
        except (TypeError, ValueError):
            return "N/A"
        if abs(v) >= 1e12: return f"${v/1e12:.2f}T"
        if abs(v) >= 1e9: return f"${v/1e9:.2f}B"
        if abs(v) >= 1e6: return f"${v/1e6:.2f}M"
        return f"${v:,.0f}"

    def _fmt_pct(v):
        if v is None: return "N/A"
        try:
            v = float(v)
        except (TypeError, ValueError):
            return "N/A"
        return f"{v*100:.2f}%"

    sections = []
    for d in stock_data_list:
        if not d or d.get("error"):
            continue
        try:
            lines = [f"{'-'*60}", f"  {d.get('ticker','?')} — {d.get('name','Unknown')}", f"{'-'*60}"]

            # -- Price & Trading --
            lines.append("\n📈 PRICE & TRADING")
            lines.append(f"  Price: ${d.get('price',0):.2f} | Change: ${d.get('change',0):.2f} ({d.get('changePct',0):+.2f}%)")
            lines.append(f"  Open: ${d['open']:.2f}" if d.get('open') else "  Open: N/A")
            lines.append(f"  Day Range: ${d['dayLow']:.2f} – ${d['dayHigh']:.2f}" if d.get('dayLow') and d.get('dayHigh') else "  Day Range: N/A")
            lines.append(f"  52-Week: ${d['low52']:.2f} – ${d['high52']:.2f} (Position: {d['pos52']:.1f}%)" if d.get('low52') and d.get('high52') and d.get('pos52') is not None else "  52-Week: N/A")
            vol = d.get('volume'); avg_vol = d.get('avgVolume')
            lines.append(f"  Volume: {vol:,}" if vol else "  Volume: N/A")
            lines.append(f"  Avg Volume (10D): {avg_vol:,}" if avg_vol else "  Avg Volume: N/A")
            if vol and avg_vol and avg_vol > 0:
                vol_vs_avg = vol / avg_vol
                lines.append(f"  Volume vs Average: {vol_vs_avg:.2f}x ({'? UNUSUAL' if vol_vs_avg > 1.5 else '?? BELOW NORMAL' if vol_vs_avg < 0.5 else '?? Normal'})")
            lines.append(f"  Currency: {d.get('currency','USD')} | Exchange: {d.get('exchange','N/A')}")
            lines.append(f"  Sector: {d.get('sector','N/A')} | Industry: {d.get('industry','N/A')}")
            mc = d.get('marketCap')
            if mc:
                cap_category = "Mega Cap" if mc >= 200e9 else "Large Cap" if mc >= 10e9 else "Mid Cap" if mc >= 2e9 else "Small Cap" if mc >= 300e6 else "Micro Cap"
                lines.append(f"  Market Cap: {_fmt_big(mc)} ({cap_category})")

            # -- Valuation --
            lines.append("\n💰 VALUATION")
            lines.append(f"  P/E (TTM): {d['pe']:.2f}" if d.get('pe') else "  P/E (TTM): N/A")
            lines.append(f"  Forward P/E: {d['forwardPe']:.2f}" if d.get('forwardPe') else "  Forward P/E: N/A")
            lines.append(f"  PEG Ratio: {d['health']['pegRatio']:.2f}" if d.get('health',{}).get('pegRatio') else "  PEG Ratio: N/A")
            lines.append(f"  EPS (TTM): ${d['eps']:.2f}" if d.get('eps') else "  EPS (TTM): N/A")
            lines.append(f"  Forward EPS: ${d['forwardEps']:.2f}" if d.get('forwardEps') else "  Forward EPS: N/A")
            lines.append(f"  Price/Book: {d['health']['priceToBook']:.2f}" if d.get('health',{}).get('priceToBook') else "  P/B: N/A")
            lines.append(f"  Book Value/Share: ${d['health']['bookValue']:.2f}" if d.get('health',{}).get('bookValue') else "  Book Value: N/A")
            ev = d.get('health',{}).get('enterpriseValue')
            lines.append(f"  Enterprise Value: {_fmt_big(ev)}" if ev else "  EV: N/A")
            lines.append(f"  EV/Revenue: {d['health']['evToRevenue']:.2f}" if d.get('health',{}).get('evToRevenue') else "  EV/Revenue: N/A")
            lines.append(f"  EV/EBITDA: {d['health']['evToEbitda']:.2f}" if d.get('health',{}).get('evToEbitda') else "  EV/EBITDA: N/A")

            # -- Dividends --
            if d.get('dividend') or d.get('dividendRate'):
                lines.append("\n💵 DIVIDENDS")
                lines.append(f"  Yield: {d['dividend']*100:.2f}%" if d.get('dividend') else "  Yield: N/A")
                lines.append(f"  Annual Rate: ${d['dividendRate']:.2f}" if d.get('dividendRate') else "")
                lines.append(f"  Payout Ratio: {_fmt_pct(d.get('health',{}).get('payoutRatio'))}")
                lines.append(f"  Ex-Dividend Date: {d.get('exDividendDate','N/A')}")

            # -- Technical Indicators --
            lines.append("\n📊 TECHNICAL INDICATORS")
            perf = d.get('perf', {})
            tech = d.get('technicals', {})
            # Moving averages
            sma50 = perf.get('sma50'); sma200 = perf.get('sma200')
            p = d.get('price', 0)
            if sma50:
                above50 = "ABOVE ✅" if p > sma50 else "BELOW ❌"
                lines.append(f"  SMA 50: ${sma50:.2f} (Price {above50}, {((p-sma50)/sma50*100):+.1f}%)")
            if sma200:
                above200 = "ABOVE ✅" if p > sma200 else "BELOW ❌"
                lines.append(f"  SMA 200: ${sma200:.2f} (Price {above200}, {((p-sma200)/sma200*100):+.1f}%)")
            if sma50 and sma200:
                cross = "🟢 GOLDEN CROSS (Bullish)" if sma50 > sma200 else "🔴 DEATH CROSS (Bearish)"
                lines.append(f"  MA Cross: {cross}")
            if tech.get('ema12'):
                lines.append(f"  EMA 12: ${tech['ema12']:.2f} | EMA 26: ${tech.get('ema26',0):.2f}")
            # MACD
            if tech.get('macd') is not None:
                macd_signal = "Bullish 🟢" if tech['macd'] > tech.get('macd_signal', 0) else "Bearish 🔴"
                lines.append(f"  MACD Line: {tech['macd']:.4f} | Signal: {tech.get('macd_signal',0):.4f} | Histogram: {tech.get('macd_histogram',0):.4f}")
                lines.append(f"  MACD Signal: {macd_signal}")
            # RSI
            if perf.get('rsi') is not None:
                rsi = perf['rsi']
                rsi_label = "🔴 OVERBOUGHT (>70)" if rsi > 70 else "🟢 OVERSOLD (<30)" if rsi < 30 else "🟡 Neutral"
                lines.append(f"  RSI(14): {rsi:.1f} — {rsi_label}")
            if tech.get('stoch_rsi') is not None:
                lines.append(f"  Stochastic RSI: {tech['stoch_rsi']:.1f}")
            # Bollinger Bands
            if tech.get('bb_upper'):
                lines.append(f"  Bollinger Bands: ${tech['bb_lower']:.2f} / ${tech['bb_middle']:.2f} / ${tech['bb_upper']:.2f}")
                if tech.get('bb_pctb') is not None:
                    pctb = tech['bb_pctb']
                    bb_pos = "Near Upper (Overbought)" if pctb > 0.8 else "Near Lower (Oversold)" if pctb < 0.2 else "Mid-Band"
                    lines.append(f"  %B: {pctb:.3f} — {bb_pos}")
            # ATR
            if tech.get('atr14'):
                lines.append(f"  ATR(14): ${tech['atr14']:.2f} ({tech.get('atr_pct',0):.2f}% daily volatility)")
            # Volume trend
            if tech.get('vol_ratio_5d_20d'):
                vr = tech['vol_ratio_5d_20d']
                vol_trend = "📈 Rising volume" if vr > 1.2 else "📉 Declining volume" if vr < 0.8 else "Stable"
                lines.append(f"  Volume Trend (5D/20D): {vr:.2f}x — {vol_trend}")
            # Support/Resistance
            if tech.get('support_20d'):
                lines.append(f"  Support: ${tech['support_20d']:.2f} (20D) / ${tech.get('support_50d',0):.2f} (50D)" if tech.get('support_50d') else f"  Support: ${tech['support_20d']:.2f} (20D)")
            if tech.get('resistance_20d'):
                lines.append(f"  Resistance: ${tech['resistance_20d']:.2f} (20D) / ${tech.get('resistance_50d',0):.2f} (50D)" if tech.get('resistance_50d') else f"  Resistance: ${tech['resistance_20d']:.2f} (20D)")

            # -- Performance --
            if perf:
                lines.append("\n📈 PERFORMANCE")
                perf_items = [('1w','1W'),('1m','1M'),('3m','3M'),('6m','6M'),('ytd','YTD'),('1y','1Y')]
                perf_parts = []
                for k, label in perf_items:
                    if perf.get(k) is not None:
                        emoji = "🟢" if perf[k] > 0 else "🔴"
                        perf_parts.append(f"  {label}: {perf[k]:+.2f}% {emoji}")
                if perf_parts:
                    lines.extend(perf_parts)

            # -- Recent 5-Day Prices --
            rp = d.get('recentPrices', [])
            if rp:
                lines.append("\n📅 LAST 5 TRADING DAYS")
                lines.append("  Date       | Open    | High    | Low     | Close   | Volume")
                lines.append("  " + "-"*65)
                for dp in rp:
                    lines.append(f"  {dp['date']} | ${dp['open']:>7.2f} | ${dp['high']:>7.2f} | ${dp['low']:>7.2f} | ${dp['close']:>7.2f} | {dp['volume']:>10,}")

            # -- Financial Health --
            h = d.get('health', {})
            if h:
                lines.append("\n🏦 FINANCIAL HEALTH")
                lines.append(f"  Health Score: {h['score']}/100" if h.get('score') is not None else "  Health Score: N/A")
                lines.append(f"  Gross Margin: {_fmt_pct(h.get('grossMargin'))}")
                lines.append(f"  Operating Margin: {_fmt_pct(h.get('operatingMargin'))}")
                lines.append(f"  Profit Margin: {_fmt_pct(h.get('profitMargin'))}")
                lines.append(f"  EBITDA Margin: {_fmt_pct(h.get('ebitdaMargins'))}")
                lines.append(f"  Revenue Growth: {_fmt_pct(h.get('revenueGrowth'))}")
                lines.append(f"  Earnings Growth: {_fmt_pct(h.get('earningsGrowth'))}")
                lines.append(f"  ROE: {_fmt_pct(h.get('returnOnEquity'))}")
                lines.append(f"  ROA: {_fmt_pct(h.get('returnOnAssets'))}")
                lines.append(f"  Debt/Equity: {h['debtToEquity']:.1f}" if h.get('debtToEquity') is not None else "  Debt/Equity: N/A")
                lines.append(f"  Current Ratio: {h['currentRatio']:.2f}" if h.get('currentRatio') is not None else "  Current Ratio: N/A")
                lines.append(f"  Quick Ratio: {h['quickRatio']:.2f}" if h.get('quickRatio') is not None else "  Quick Ratio: N/A")
                lines.append(f"  Total Revenue: {_fmt_big(h.get('totalRevenue'))}")
                lines.append(f"  EBITDA: {_fmt_big(h.get('ebitda'))}")
                lines.append(f"  Free Cash Flow: {_fmt_big(h.get('freeCashflow'))}")
                lines.append(f"  Operating Cash Flow: {_fmt_big(h.get('operatingCashflow'))}")
                lines.append(f"  Total Cash: {_fmt_big(h.get('totalCash'))}")
                lines.append(f"  Total Debt: {_fmt_big(h.get('totalDebt'))}")
                lines.append(f"  Revenue/Share: ${h['revenuePerShare']:.2f}" if h.get('revenuePerShare') is not None else "")

            # -- Shares & Ownership --
            sh = d.get('shares', {})
            if sh and any(v for v in sh.values() if v is not None):
                lines.append("\n??? SHARES & OWNERSHIP")
                if sh.get('outstanding'): lines.append(f"  Shares Outstanding: {sh['outstanding']:,}")
                if sh.get('float'): lines.append(f"  Float: {sh['float']:,}")
                if sh.get('institutionPct') is not None: lines.append(f"  Institutional Ownership: {sh['institutionPct']*100:.1f}%")
                if sh.get('insiderPct') is not None: lines.append(f"  Insider Ownership: {sh['insiderPct']*100:.1f}%")
                if sh.get('shortShares'): lines.append(f"  Short Interest: {sh['shortShares']:,} shares")
                if sh.get('shortPctFloat') is not None: lines.append(f"  Short % of Float: {sh['shortPctFloat']*100:.2f}%")
                if sh.get('shortRatio') is not None: lines.append(f"  Short Ratio (Days to Cover): {sh['shortRatio']:.1f}")

            # -- Analyst Consensus --
            lines.append("\n🎯 ANALYST CONSENSUS")
            lines.append(f"  Recommendation: {d.get('recommendation','N/A').upper()}")
            lines.append(f"  Number of Analysts: {d.get('numAnalysts','N/A')}")
            lines.append(f"  Target Mean: ${d['targetPrice']:.2f}" if d.get('targetPrice') else "  Target Mean: N/A")
            lines.append(f"  Target Median: ${d['targetMedian']:.2f}" if d.get('targetMedian') else "")
            if d.get('targetLow') and d.get('targetHigh'):
                lines.append(f"  Target Range: ${d['targetLow']:.2f} – ${d['targetHigh']:.2f}")
            if d.get('targetPrice') and p:
                upside = (d['targetPrice'] - p) / p * 100
                lines.append(f"  Implied Upside/Downside: {upside:+.1f}%")
            lines.append(f"  Earnings Date: {d.get('earningsDate','N/A')}")
            lines.append(f"  System Verdict: {d.get('verdict','N/A').upper()}")
            lines.append(f"  Risk Level: {d.get('risk','N/A')}")
            lines.append(f"  Beta: {d['beta']:.2f}" if d.get('beta') else "  Beta: N/A")

            # -- Earnings History --
            eh = d.get('earningsHistory', [])
            if eh:
                lines.append("\n📋 RECENT EARNINGS")
                for e in eh:
                    eps_est = e.get('epsEstimate') or e.get('Earnings Estimate')
                    eps_act = e.get('epsActual') or e.get('Reported EPS')
                    surprise = e.get('surprisePercent') or e.get('Surprise(%)')
                    qtr = e.get('quarter') or e.get('Quarter') or '?'
                    if eps_act is not None:
                        try:
                            surprise_f = float(surprise) if surprise is not None else None
                        except (TypeError, ValueError):
                            surprise_f = None
                        beat = "✅ BEAT" if (surprise_f and surprise_f > 0) else "❌ MISS" if (surprise_f and surprise_f < 0) else ""
                        lines.append(f"  {qtr}: Est ${eps_est} ? Actual ${eps_act} ({surprise_f:+.1f}% {beat})" if surprise_f is not None else f"  {qtr}: ${eps_act}")

            # -- Insider Trades --
            ins = d.get('insiderTrades', [])
            if ins:
                lines.append("\n👤 RECENT INSIDER TRADES")
                for t in ins[:5]:
                    insider = t.get('Insider Trading') or t.get('insider') or t.get('Text') or '?'
                    action = t.get('Transaction') or t.get('transaction') or '?'
                    shares_t = t.get('Shares') or t.get('shares') or ''
                    val = t.get('Value') or t.get('value') or ''
                    lines.append(f"  {insider}: {action}" + (f" ({shares_t:,} shares, {_fmt_big(val)})" if isinstance(shares_t, (int, float)) and shares_t else f" {shares_t} {val}"))

            sections.append("\n".join([l for l in lines if l]))  # filter empty lines
        except Exception:
            sections.append(f"  {d.get('ticker','?')} — Error formatting data")
    return "\n\n".join(sections)


def _stock_agent_steps(stock_data_list, user_query):
    """Return the multi-step prompts for the stock analysis agent. 10 steps with Winner Deep Dive and web search for deep research."""
    tickers = [d.get('ticker', '?') for d in stock_data_list if not d.get('error')]
    ticker_str = ", ".join(tickers)
    is_comparison = len(tickers) > 1
    uq = user_query.strip() if user_query else ""
    uq_note = f'\n\n⚡ USER\'S QUESTION: "{uq}"\nTailor your analysis to directly answer this. Reference it explicitly.' if uq and len(uq) > 3 else ''

    base_system = (
        "You are an elite institutional equity research analyst at a top Wall Street firm. "
        "You write like a Goldman Sachs/Morgan Stanley research note — authoritative, data-dense, no fluff. "
        "You are given REAL market data pulled from Yahoo Finance seconds ago.\n\n"
        "ABSOLUTE RULES:\n"
        "1. Use ONLY the data provided for financial numbers. NEVER fabricate, estimate, or hallucinate any number.\n"
        "2. Cite EXACT values from the data: '$142.50', 'P/E of 28.3x', 'RSI at 67.2'\n"
        "3. INTERPRET every number — don't just restate it. What does it MEAN?\n"
        "4. Use markdown: **bold** key figures, use tables for comparisons, emoji for quick signals\n"
        "5. NO disclaimers, NO 'I'm an AI', NO 'this is not financial advice'\n"
        "6. NO restating the raw data dump — synthesize and add insight\n"
        "7. Be DECISIVE — give clear signals, not wishy-washy hedge-everything language\n"
        "8. If a data point is N/A, skip it — don't say 'data not available'"
    )

    news_system = (
        "You are a senior financial journalist and market intelligence analyst. "
        "You have access to web search to find the LATEST news, developments, and market sentiment. "
        "Search the web thoroughly to find recent and relevant information.\n\n"
        "RULES:\n"
        "1. Search for and report ONLY real, verifiable news from credible sources\n"
        "2. Always mention the source and approximate date of each news item\n"
        "3. Focus on RECENT news (last 1-4 weeks) that could impact the stock\n"
        "4. Distinguish between confirmed facts and analyst speculation\n"
        "5. Use markdown formatting with **bold** for key points\n"
        "6. NO disclaimers, NO 'I'm an AI'"
    )

    research_system = (
        "You are a deep research analyst who combines web intelligence with hard data. "
        "You have access to web search. Use it to research the companies thoroughly. "
        "Cross-reference what you find online with the financial data provided.\n\n"
        "RULES:\n"
        "1. Search the web for competitive analysis, industry trends, and company developments\n"
        "2. Verify claims against the hard financial data provided\n"
        "3. Look for information that ISN'T in the financial data — partnerships, products, lawsuits, management changes\n"
        "4. Be specific with sources and dates\n"
        "5. Use markdown formatting\n"
        "6. NO disclaimers, NO 'I'm an AI'"
    )

    # Build chart health summary for agent context
    chart_summary_lines = []
    for d in stock_data_list:
        if not d.get('error'):
            cs = d.get('_chart_score')
            cv = d.get('_chart_verdict')
            if cs is not None:
                chart_summary_lines.append(f"{d.get('ticker','?')}: chart_health={cs}/100 ({cv})")
    chart_summary = "\n".join(chart_summary_lines) if chart_summary_lines else ""

    # Screening step — validates stocks against user criteria before deep analysis
    screening_step = {
        "title": "Stock Screening",
        "system": (
            "You are a stock screener and validator. Your job is to quickly evaluate whether the stocks provided "
            "meet the user's stated criteria BEFORE doing deep analysis. Be ruthless — if a stock doesn't match what "
            "the user asked for, say so immediately. Look at the REAL prices, chart health scores, and performance data.\n\n"
            "RULES:\n"
            "1. Check EVERY stock against the user's criteria (price range, sector, growth, etc.)\n"
            "2. Evaluate chart health using the provided chart_health scores and performance data\n"
            "3. Flag stocks with POOR charts (declining trends, below 200 SMA, negative YTD) as risky\n"
            "4. Be STRICT about price criteria — a $50 stock doesn't qualify for 'under $25'\n"
            "5. Give a clear PASS/FAIL for each stock with brief reasoning\n"
            "6. Use markdown tables for clarity"
        ),
        "web_search": False,
        "prompt": (
            f"SCREEN these stocks against the user's request.{uq_note}\n\n"
            + (f"📊 CHART HEALTH:\n{chart_summary}\n\n" if chart_summary else "")
            + "For EACH stock, evaluate:\n\n"
            "**Screening Table:**\n"
            "| Stock | Price | Criteria Match | Chart Health | Performance Trend | Verdict |\n"
            "|-------|-------|----------------|--------------|-------------------|---------|\n\n"
            "For each stock:\n"
            "1. **Price Check**: Does the current price match what the user asked for?\n"
            "2. **Chart Check**: Is the chart healthy? Look at:\n"
            "   - Price vs SMA 50 & 200 (above = good, below = bad)\n"
            "   - RSI (30-70 normal, <30 oversold, >70 overbought)\n"
            "   - MACD direction (positive histogram = bullish)\n"
            "   - Performance trend (1M/3M/YTD — is it trending up or down?)\n"
            "   - 52-week position (near lows = weak, near highs = strong)\n"
            "3. **Quick Fundamental Check**: Health score, analyst recommendation, revenue growth\n\n"
            "**Verdict for each stock:** ? PASS / ?? CAUTION / ? FAIL\n\n"
            "**📊 Power Ranking** (CRITICAL — rank ALL stocks from best to worst candidate):\n"
            "| Rank | Stock | Score /10 | Key Strength | Key Weakness |\n\n"
            "**Screening Summary:** Which stocks survived screening and deserve deep analysis? "
            "Which should the user avoid? Be honest and direct — don't waste the user's time on bad stocks.\n\n"
            "**🎯 Narrowing the Field:** If there are 5+ stocks, explicitly identify the TOP 3 candidates "
            "that deserve the deepest analysis. Explain WHY the others are weaker.\n\n"
            "If a stock has a terrible chart (declining, below key moving averages, negative performance), "
            "say so CLEARLY — even if it's 'cheap', a bad chart means it's cheap for a reason."
        ),
    }

    if is_comparison:
        return [
            screening_step,
            {
                "title": "Market Snapshot",
                "system": base_system,
                "web_search": False,
                "prompt": (
                    f"Compare the current market position of {ticker_str}.{uq_note}\n\n"
                    "Create a **Snapshot Table**:\n"
                    "| Metric | " + " | ".join(tickers) + " |\n"
                    "|--------|" + "|".join(["--------|"] * len(tickers)) + "\n"
                    "| Price | | |\n"
                    "| Daily Change | | |\n"
                    "| Market Cap | | |\n"
                    "| Volume vs Avg | | |\n"
                    "| 52W Position | | |\n"
                    "| Sector | | |\n\n"
                    "Then interpret:\n"
                    "- Who's having a better day and why?\n"
                    "- Any unusual volume? What could it signal?\n"
                    "- Who has more room to run based on 52-week positioning?\n\n"
                    "**Opening Take:** 1-2 sentences on who looks stronger at first glance."
                ),
            },
            {
                "title": "News & Headlines",
                "system": news_system,
                "web_search": True,
                "prompt": (
                    f"Search the web for the LATEST news and headlines about {ticker_str}.{uq_note}\n\n"
                    "Search AGGRESSIVELY — do at least 2-3 separate web searches to cover all stocks.\n\n"
                    "For EACH stock, search for and report:\n\n"
                    "**📰 Recent Headlines** (last 1-4 weeks):\n"
                    "- List 3-5 most important recent news stories for each company\n"
                    "- Include source name and approximate date\n"
                    "- Focus on: earnings reports, product launches, partnerships, management changes, regulatory news, analyst upgrades/downgrades\n\n"
                    "**📊 Market Sentiment:**\n"
                    "- What's the overall media/analyst sentiment? Bullish, bearish, or mixed?\n"
                    "- Any viral social media buzz or Reddit/WallStreetBets attention?\n"
                    "- Recent analyst rating changes or price target updates?\n\n"
                    "**⚡ Catalysts & Events:**\n"
                    "- Upcoming earnings dates, FDA decisions, product launches, conferences\n"
                    "- Any pending lawsuits, investigations, or regulatory decisions?\n"
                    "- Sector-wide trends affecting these stocks\n\n"
                    "**🔥 News Impact Assessment:**\n"
                    "For each stock: is the news flow Positive / Neutral / Negative?\n"
                    "Which company has the better news momentum right now?"
                ),
            },
            {
                "title": "Technical Analysis",
                "system": base_system + "\nYou are a technical analysis specialist. Think in terms of trends, momentum, and chart patterns. A stock with a terrible chart should NEVER be recommended, no matter how cheap it is — cheap stocks with bad charts are cheap for a reason.",
                "web_search": False,
                "prompt": (
                    f"Deep technical comparison of {ticker_str}.{uq_note}\n\n"
                    "**CHART HEALTH ASSESSMENT** (CRITICAL — this determines if a stock is even worth considering):\n"
                    "For each stock, evaluate the overall chart picture:\n"
                    "- Is the stock in an UPTREND, DOWNTREND, or SIDEWAYS consolidation?\n"
                    "- Is price ABOVE or BELOW the 50-day and 200-day moving averages?\n"
                    "- Golden cross (50 > 200) or Death cross (50 < 200)?\n"
                    "- Is the stock making HIGHER highs/lows or LOWER highs/lows?\n"
                    "?? A stock below BOTH its 50 and 200 SMA with negative YTD performance has a TERRIBLE chart. Flag it.\n\n"
                    "**Indicator Table:**\n"
                    "| Technical | " + " | ".join(tickers) + " | Edge |\n"
                    "|-----------|" + "|".join(["--------|"] * len(tickers)) + "------|\n"
                    "Fill in: SMA 50/200 position, MA Cross signal, RSI reading, MACD direction, "
                    "Bollinger Band position, ATR volatility, Volume trend.\n\n"
                    "**Momentum Comparison** (use emoji 🟢🔴🟡):\n"
                    "- 1W / 1M / 3M / YTD / 1Y performance side-by-side\n"
                    "- Who's accelerating? Who's decelerating?\n"
                    "- Any stock with ALL RED performance numbers is a clear ❌\n\n"
                    "**Support & Resistance**:\n"
                    "- Key levels for each stock\n"
                    "- Which is closer to support (safer entry)? Which is near resistance (risky)?\n\n"
                    "**Chart Verdict per Stock:** 🟢 Strong Chart / 🟡 Neutral / 🔴 Weak Chart — with specific reasoning\n\n"
                    "**Technical Edge:** 🏆 [TICKER] — one paragraph explaining the technical advantage. "
                    "DO NOT give the technical edge to a stock with a bad chart."
                ),
            },
            {
                "title": "Fundamental Deep Dive",
                "system": base_system + "\nYou are a fundamental analysis expert. Focus on what makes a business strong or weak.",
                "web_search": False,
                "prompt": (
                    f"Head-to-head fundamental battle: {ticker_str}.{uq_note}\n\n"
                    "**Valuation Table:**\n"
                    "| Metric | " + " | ".join(tickers) + " | Winner |\n"
                    "P/E, Forward P/E, PEG, P/B, EV/Revenue, EV/EBITDA\n\n"
                    "**Profitability Table:**\n"
                    "Gross Margin, Operating Margin, Profit Margin, EBITDA Margin, ROE, ROA\n\n"
                    "**Growth Table:**\n"
                    "Revenue Growth, Earnings Growth, Forward EPS vs Current EPS\n\n"
                    "**Balance Sheet Table:**\n"
                    "Debt/Equity, Current Ratio, Quick Ratio, Total Cash vs Total Debt, FCF\n\n"
                    "**Health Score:** Compare the scores and explain what they mean.\n\n"
                    "Declare category winners, then:\n"
                    "**Fundamental Edge:** 🏆 [TICKER] — one paragraph on why they're the better business."
                ),
            },
            {
                "title": "Deep Research",
                "system": research_system,
                "web_search": True,
                "prompt": (
                    f"Do deep research on {ticker_str} to find information NOT in the financial data.{uq_note}\n\n"
                    "Search the web and investigate:\n\n"
                    "**🏢 Company Deep Dive** (for each):\n"
                    "- What does the company actually DO? Core products/services and competitive moat\n"
                    "- Recent product launches, partnerships, or strategic moves\n"
                    "- Management quality — any recent executive changes?\n"
                    "- Competitive landscape — who are the main rivals and how do they compare?\n\n"
                    "**📈 Industry & Macro Context:**\n"
                    "- What sector trends are helping or hurting these companies?\n"
                    "- Any regulatory changes or government policies affecting them?\n"
                    "- How does the current macro environment (interest rates, inflation, economy) impact them?\n\n"
                    "**🔍 Hidden Risks & Opportunities:**\n"
                    "- Anything the financial data doesn't show — pending lawsuits, patent issues, supply chain problems?\n"
                    "- Growth catalysts not yet priced in?\n"
                    "- Insider sentiment beyond just the trade data\n\n"
                    "**Cross-Reference with Data:**\n"
                    "Connect your web research findings with the actual financial data provided. "
                    "Does the news confirm or contradict what the numbers show?\n\n"
                    "**🎯 Research Edge:** After all this digging, which stock has the most HIDDEN UPSIDE "
                    "that the basic financial data doesn't capture? Which has hidden risks?"
                ),
            },
            {
                "title": "Risk & Ownership",
                "system": base_system + "\nYou are a risk management specialist. Focus on what could go wrong and who's betting on these stocks.",
                "web_search": False,
                "prompt": (
                    f"Risk and ownership deep dive for {ticker_str}.{uq_note}\n\n"
                    "**Risk Comparison:**\n"
                    "| Risk Factor | " + " | ".join(tickers) + " |\n"
                    "Beta, ATR (daily volatility %), Short interest, Debt levels, Earnings risk\n\n"
                    "**Smart Money Signals:**\n"
                    "- Institutional ownership: who has more backing?\n"
                    "- Insider ownership: are insiders aligned with shareholders?\n"
                    "- Short interest: anyone betting against these?\n"
                    "- Recent insider trades: buying or selling?\n\n"
                    "**Catalysts & Risks:**\n"
                    "For each stock:\n"
                    "- 🔼 Next catalyst (earnings date, etc.)\n"
                    "- ?? Biggest risk factor\n\n"
                    "**Risk-Adjusted Winner:** Which offers better risk/reward?"
                ),
            },
            {
                "title": "Valuation & Price Targets",
                "system": base_system + "\nYou are a valuation specialist. Think about fair value and margin of safety.",
                "web_search": False,
                "prompt": (
                    f"Valuation analysis of {ticker_str}.{uq_note}\n\n"
                    "For each stock:\n"
                    "**Current vs Fair Value:**\n"
                    "- Analyst consensus target and implied upside/downside\n"
                    "- Target range (low to high) — what does the spread tell us?\n"
                    "- P/E vs forward P/E — is earnings growth being priced in?\n"
                    "- PEG ratio interpretation — paying too much for growth?\n\n"
                    "**Value Comparison Table:**\n"
                    "| Metric | " + " | ".join(tickers) + " | Better Value |\n"
                    "Price vs Target, Upside %, P/E, Forward P/E, PEG, P/B, EV/EBITDA\n\n"
                    "**Who's Cheaper?** Clear determination of which stock offers more value for the price."
                ),
            },
            {
                "title": "Winner Deep Dive",
                "system": research_system + (
                    "\n\nYou have completed 8 steps of analysis. You now know which stock is the frontrunner. "
                    "Your job is to do an EXTRA round of deep web research specifically on the leading candidate — "
                    "the one that scored best across screening, technicals, fundamentals, and valuation. "
                    "Search aggressively for anything that could change the verdict, either positively or negatively."
                ),
                "web_search": True,
                "prompt": (
                    f"WINNER DEEP DIVE for the top candidate among {ticker_str}.{uq_note}\n\n"
                    "Based on your 8 steps of analysis, identify the FRONTRUNNER — the stock that has "
                    "consistently scored best across screening, technicals, fundamentals, valuation, and risk.\n\n"
                    "**State your frontrunner:** 🏆 [TICKER] is the clear leader because [1 sentence summary].\n\n"
                    "Now do EXTRA deep research specifically on this stock:\n\n"
                    "**🔎 Competitive Moat Analysis** (search the web):\n"
                    "- What makes this company defensible? Patents, network effects, switching costs, brand, scale?\n"
                    "- Who are the top 3 competitors and how does this company compare on key metrics?\n"
                    "- Is the moat widening or narrowing?\n\n"
                    "**📊 Earnings & Growth Deep Dive** (search the web):\n"
                    "- Last 4 quarters: did they beat or miss estimates? By how much?\n"
                    "- Revenue growth trajectory — accelerating, stable, or decelerating?\n"
                    "- What are analysts saying about next quarter expectations?\n"
                    "- Any guidance updates from management?\n\n"
                    "**🔍 Bear Case Investigation** (search the web):\n"
                    "- What are the bears and short sellers saying about this stock?\n"
                    "- Search for '[TICKER] bearish case' or '[TICKER] risks'\n"
                    "- Are there any red flags you may have missed in earlier steps?\n"
                    "- Any upcoming headwinds (regulation, competition, macro)?\n\n"
                    "**💡 Catalyst Timeline:**\n"
                    "- List the next 3-5 potential catalysts with approximate dates\n"
                    "- Which catalyst could move the stock the most?\n"
                    "- Any events in the next 30/60/90 days the investor should know about?\n\n"
                    "**🏁 Deep Dive Conclusion:**\n"
                    "After this extra research, is the frontrunner STILL the best pick? "
                    "Did you find anything that changes your conviction? Rate your confidence: High / Medium / Low."
                ),
            },
            {
                "title": "Final Verdict",
                "system": base_system + "\nThis is your FINAL CALL. Incorporate ALL previous analysis including news and research. Be bold, be decisive. Your reputation depends on this call. NEVER recommend a stock with a terrible chart — cheap and falling is not a buying opportunity, it's a trap.",
                "web_search": False,
                "prompt": (
                    f"FINAL VERDICT: {ticker_str}.{uq_note}\n\n"
                    "You have completed: Stock Screening, Market Snapshot, News & Headlines, Technical Analysis, Fundamental Deep Dive, "
                    "Deep Research, Risk & Ownership, Valuation & Price Targets, and Winner Deep Dive.\n\n"
                    "Now synthesize EVERYTHING — data, news, research, technicals, fundamentals, AND the deep dive findings on the frontrunner — into your final call.\n\n"
                    "?? CRITICAL RULES FOR YOUR VERDICT:\n"
                    "1. If the user specified price criteria and a stock FAILS it, rate it SELL regardless of other merits.\n"
                    "2. If a stock has a TERRIBLE CHART (below both SMAs, negative YTD, negative 1Y, near 52-week lows), "
                    "it should NOT receive a BUY rating. A cheap stock with a bad chart is cheap for a reason.\n"
                    "3. Only recommend stocks that PASS the screening step AND have decent chart health.\n"
                    "4. If NO stocks deserve a BUY rating, say so honestly — don't force a recommendation.\n\n"
                    "Structure EXACTLY like this:\n\n"
                    "---\n\n"
                    "## 🏆 Winner: [TICKER]\n\n"
                    "**Why [TICKER] wins** (1 punchy paragraph — weave together your best data points AND recent news/research findings)\n\n"
                    "### Scoreboard\n"
                    "| Category | " + " | ".join(tickers) + " |\n"
                    "Technical, Fundamental, Valuation, Risk/Reward, Momentum, News Sentiment, **Chart Health** — rate each A/B/C/D/F\n\n"
                    "### For each stock:\n"
                    "**[TICKER]: 🟢 BUY / 🟡 HOLD / 🔴 SELL — Rating: [X]/100**\n"
                    "Give a precise numeric rating from 1-100 where:\n"
                    "- 90-100: STRONG BUY, 75-89: BUY, 60-74: LEAN BUY, 45-59: HOLD, 30-44: LEAN SELL, 15-29: SELL, 1-14: STRONG SELL\n\n"
                    "- 3 bullet **Bull Case** (mix data + news + research)\n"
                    "- 3 bullet **Bear Case** (mix data + news + research)\n"
                    "- **Trade Setup:** Entry $X – $X | Target $X (X% upside) | Stop $X (X% risk) | R:R X:1\n"
                    "- Risk level with beta reference\n"
                    "- Ideal investor type (growth, value, income, swing trader)\n\n"
                    "### Bottom Line\n"
                    "2-3 sentences. Clear winner, clear action, specific price levels. "
                    "Reference the most compelling news/catalyst that tips the scale.\n\n"
                    "### ?? MACHINE-READABLE RATINGS (REQUIRED — emit this EXACT format at the very end):\n"
                    "<<<STOCK_RATINGS>>>\n"
                    '{"ratings":{' + ','.join(f'"{t}":{{"score":0,"verdict":"hold"}}' for t in tickers) + '},"winner":"' + (tickers[0] if tickers else '?') + '"}\n'
                    "<<<END_STOCK_RATINGS>>>\n"
                    "Replace each score with your ACTUAL rating (1-100) and verdict with buy/hold/sell. "
                    "Replace winner with the actual winning ticker. This data block is parsed by the UI — do NOT skip it."
                ),
            },
            {
                "title": "Buying Plan",
                "system": base_system + "\nYou are now a personal investment advisor giving an actionable buying plan. Be specific, practical, and clear. The user needs step-by-step instructions they can follow RIGHT NOW.",
                "web_search": False,
                "prompt": (
                    f"BUYING PLAN for the user.{uq_note}\n\n"
                    "You just completed a full stock analysis. Now give the user a SPECIFIC, ACTIONABLE buying plan.\n\n"
                    "Structure EXACTLY like this:\n\n"
                    "## 💰 Your Buying Plan\n\n"
                    "**Your Budget:** [reference the user's stated budget if mentioned]\n\n"
                    "### Step-by-Step Instructions:\n"
                    "1. **Open your brokerage app** (Robinhood, Fidelity, Schwab, etc.)\n"
                    "2. **Search for [TICKER]** — this is your primary buy\n"
                    "3. **Order type:** [Market order / Limit order at $X.XX] — explain why\n"
                    "4. **Number of shares:** [X shares at ~$X.XX = $X.XX total] — show the math\n"
                    "   - If the stock is too expensive for full shares, explain fractional shares\n"
                    "5. **Set a stop-loss** at $X.XX to protect your downside\n\n"
                    "### If you want to split your money:\n"
                    "Show an alternative portfolio split with exact dollar amounts and share counts.\n\n"
                    "### When to Buy:\n"
                    "- Is now a good entry or should they wait for a dip?\n"
                    "- Any upcoming events (earnings, etc.) to be aware of?\n\n"
                    "### When to Sell:\n"
                    "- Target price to take profits: $X.XX (X% gain)\n"
                    "- Stop-loss price to cut losses: $X.XX (X% loss)\n\n"
                    "### Important Reminders:\n"
                    "- Don't invest money you can't afford to lose\n"
                    "- This is AI analysis, not professional financial advice\n"
                    "- Consider your risk tolerance and time horizon"
                ),
            },
        ]
    else:
        d0 = stock_data_list[0] if stock_data_list else {}
        h0 = d0.get('health', {})
        t0 = d0.get('technicals', {})
        p0 = d0.get('perf', {})
        return [
            screening_step,
            {
                "title": "Market Snapshot",
                "system": base_system,
                "web_search": False,
                "prompt": (
                    f"Market snapshot for {ticker_str}.{uq_note}\n\n"
                    "**Quick Stats Box:**\n"
                    f"Create a clean summary table:\n"
                    "| Metric | Value | Signal |\n"
                    "Price & daily change, Day range, Volume vs average, 52-week position, "
                    "Market cap category, Sector/Industry\n\n"
                    "**Interpretation** (3-5 sentences):\n"
                    "- What's the STORY today? Is this a breakout, pullback, consolidation, or trend day?\n"
                    "- Is volume confirming or contradicting the price move?\n"
                    "- Where in the 52-week range is it and what does that suggest?\n"
                    "- Any recent catalysts (look at the 5-day price action for clues)?"
                ),
            },
            {
                "title": "News & Headlines",
                "system": news_system,
                "web_search": True,
                "prompt": (
                    f"Search the web for the LATEST news and headlines about {ticker_str}.{uq_note}\n\n"
                    "Search AGGRESSIVELY — do at least 2-3 separate web searches to find comprehensive coverage.\n\n"
                    "**📰 Recent Headlines** (last 1-4 weeks):\n"
                    "- Include source name (e.g., Reuters, Bloomberg, CNBC, WSJ) and approximate date\n"
                    "- Focus on: earnings reports, product launches, partnerships, management changes, "
                    "regulatory news, analyst upgrades/downgrades, SEC filings\n\n"
                    "**📊 Market Sentiment:**\n"
                    "- What's the overall media/analyst sentiment? Bullish, bearish, or mixed?\n"
                    "- Any social media buzz or retail investor attention?\n"
                    "- Recent analyst rating changes or price target updates?\n\n"
                    "**⚡ Upcoming Catalysts:**\n"
                    "- Upcoming earnings dates, product launches, conferences\n"
                    "- Any pending lawsuits, investigations, or regulatory decisions?\n"
                    "- Sector-wide trends or macro events that could move the stock\n\n"
                    "**🔥 News Verdict:** Is the recent news flow Positive / Neutral / Negative for this stock?"
                ),
            },
            {
                "title": "Technical Analysis",
                "system": base_system + "\nYou are a CMT-certified technical analyst. Think in terms of trend, momentum, volatility, and key levels. A stock with a terrible chart should NOT be recommended regardless of how cheap it looks — bad charts mean the market is telling you something.",
                "web_search": False,
                "prompt": (
                    f"Full technical breakdown of {ticker_str}.{uq_note}\n\n"
                    "**CHART HEALTH CHECK** (CRITICAL — evaluate this first):\n"
                    "- Is the stock in an UPTREND, DOWNTREND, or SIDEWAYS?\n"
                    "- Price vs 50 SMA and 200 SMA — above both = healthy, below both = sick chart\n"
                    "- Golden cross or death cross?\n"
                    "- 52-week position — near highs = strong trend, near lows = danger\n"
                    "- YTD performance — is this stock delivering returns or destroying value?\n"
                    "?? If the stock is below BOTH moving averages with negative YTD/1Y performance, "
                    "this is a TERRIBLE chart and should be flagged as high-risk regardless of price.\n\n"
                    "**Trend Analysis:**\n"
                    "- Moving averages: Price vs SMA 50, SMA 200, EMA 12, EMA 26\n"
                    "- Golden cross or death cross? What does the MA alignment tell us?\n\n"
                    "**Momentum Indicators:**\n"
                    "| Indicator | Value | Reading |\n"
                    "RSI(14), Stochastic RSI, MACD (line vs signal + histogram direction)\n\n"
                    "**Volatility:**\n"
                    "- Bollinger Bands position (%B) — squeezing, expanding, or normal?\n"
                    "- ATR(14) and daily volatility % — is this a choppy or smooth mover?\n\n"
                    "**Key Levels:**\n"
                    "- Support: 20D and 50D support levels\n"
                    "- Resistance: 20D and 50D resistance levels\n"
                    "- How far from each? Which is the stock gravitating toward?\n\n"
                    "**Performance Momentum** (use table with emoji):\n"
                    "1W ? 1M ? 3M ? YTD ? 1Y — is the trend accelerating or fading?\n\n"
                    "**Technical Verdict:** 🟢 Bullish / 🟡 Neutral / 🔴 Bearish\n"
                    "One paragraph connecting all the dots. Be HONEST — if the chart looks bad, say it clearly."
                ),
            },
            {
                "title": "Fundamental Analysis",
                "system": base_system + "\nYou are a CFA-certified fundamental analyst. Think about business quality, competitive advantages, and intrinsic value.",
                "web_search": False,
                "prompt": (
                    f"Fundamental deep dive on {ticker_str}.{uq_note}\n\n"
                    "**Valuation Assessment:**\n"
                    "| Metric | Value | Grade |\n"
                    "P/E (TTM), Forward P/E, PEG Ratio, P/B, EV/Revenue, EV/EBITDA\n"
                    "Grade: 🟢 Cheap / 🟡 Fair / 🔴 Expensive (vs typical ranges for this sector)\n\n"
                    "**Profitability Scorecard:**\n"
                    "| Metric | Value | Rating |\n"
                    "Gross Margin, Operating Margin, Net Margin, EBITDA Margin, ROE, ROA\n"
                    "Rating: **Strong** / **Average** / **Weak**\n\n"
                    "**Growth Profile:**\n"
                    "- Revenue growth + earnings growth — accelerating or decelerating?\n"
                    "- Forward EPS vs trailing EPS — what's the market expecting?\n"
                    "- Earnings history: has it beaten estimates recently?\n\n"
                    "**Balance Sheet Health:**\n"
                    "- Debt/Equity, Current Ratio, Quick Ratio\n"
                    "- Cash vs Debt — net cash or net debt position?\n"
                    "- Free cash flow — is the business generating real money?\n\n"
                    f"**Health Score: {h0.get('score', 'N/A')}/100** — explain what this means and how it was derived.\n\n"
                    "**Fundamental Grade:** A through F, with justification."
                ),
            },
            {
                "title": "Deep Research",
                "system": research_system,
                "web_search": True,
                "prompt": (
                    f"Do deep research on {ticker_str} to find information NOT in the financial data.{uq_note}\n\n"
                    "Search the web THOROUGHLY — do at least 3-4 separate searches covering different angles "
                    "(company news, industry analysis, competitive landscape, recent developments).\n\n"
                    "Search the web and investigate:\n\n"
                    "**🏢 Company Deep Dive:**\n"
                    "- What does the company actually DO? Core products/services and competitive moat\n"
                    "- Recent product launches, partnerships, or strategic moves\n"
                    "- Management quality — any recent executive changes? CEO track record?\n"
                    "- Competitive landscape — who are the main rivals and how do they stack up?\n\n"
                    "**📈 Industry & Macro Context:**\n"
                    "- What sector trends are helping or hurting this company?\n"
                    "- Total addressable market (TAM) — how big is the opportunity?\n"
                    "- Any regulatory changes or government policies affecting them?\n"
                    "- How does the current macro environment (interest rates, inflation, economy) impact them?\n\n"
                    "**🔍 Hidden Risks & Opportunities:**\n"
                    "- Anything the financial data doesn't show — pending lawsuits, patent issues, supply chain problems?\n"
                    "- Growth catalysts not yet priced in?\n"
                    "- What are bears saying about this stock? What are bulls saying?\n\n"
                    "**Cross-Reference with Data:**\n"
                    "Connect your web research findings with the actual financial data provided. "
                    "Does the research confirm or contradict what the numbers show?\n\n"
                    "**🎯 Research Edge:** What did you find that the basic financial data DOESN'T show? "
                    "Any hidden upside or hidden risks?"
                ),
            },
            {
                "title": "Risk & Ownership",
                "system": base_system + "\nYou are a risk analyst. Think about what could go wrong, who's invested, and hidden dangers.",
                "web_search": False,
                "prompt": (
                    f"Risk and ownership analysis for {ticker_str}.{uq_note}\n\n"
                    "**Risk Profile:**\n"
                    "| Factor | Value | Assessment |\n"
                    "Beta, ATR daily volatility %, Short interest/float %, Debt/Equity\n\n"
                    "**Smart Money:**\n"
                    "- Institutional ownership % — do the big boys believe?\n"
                    "- Insider ownership % — is management eating their own cooking?\n"
                    "- Short interest and days to cover — any squeeze potential or danger signal?\n"
                    "- Recent insider trades — net buying or selling?\n\n"
                    "**Upcoming Events:**\n"
                    "- Next earnings date and what to watch for\n"
                    "- Dividend schedule if applicable\n\n"
                    "**Key Risks** (3 bullet points — specific, not generic):\n"
                    "- What specific data points concern you?\n\n"
                    "**Risk Rating:** Low / Moderate / High / Very High — with reasoning."
                ),
            },
            {
                "title": "Valuation & Price Targets",
                "system": base_system + "\nYou are a valuation expert. Focus on where the stock SHOULD be trading.",
                "web_search": False,
                "prompt": (
                    f"Valuation and price target analysis for {ticker_str}.{uq_note}\n\n"
                    "**Analyst Consensus:**\n"
                    "- Number of analysts covering\n"
                    "- Mean target price and implied move %\n"
                    "- Target range (low to high) — what does the spread tell us about uncertainty?\n"
                    "- Current recommendation\n\n"
                    "**Valuation Math:**\n"
                    "- Current P/E vs Forward P/E ? Are earnings expected to grow or shrink?\n"
                    "- PEG ratio ? Paying a fair price for growth?\n"
                    "- Book value vs price ? Any margin of safety?\n"
                    "- EV/EBITDA ? How does the enterprise value compare?\n\n"
                    "**Fair Value Range:**\n"
                    "Based on the data, give a specific price range you consider fair value.\n"
                    "Explain your reasoning using the metrics above.\n\n"
                    "**Entry / Exit Points:**\n"
                    "- Ideal entry price (where you'd buy)\n"
                    "- Target price (where you'd take profit)\n"
                    "- Stop-loss level (where you'd cut losses)"
                ),
            },
            {
                "title": "Winner Deep Dive",
                "system": research_system + (
                    "\n\nYou have completed 8 steps of analysis on this stock. "
                    "Now do one final round of aggressive web research to find anything that could "
                    "change the investment thesis — for better or worse. Search for angles you haven't covered yet."
                ),
                "web_search": True,
                "prompt": (
                    f"WINNER DEEP DIVE on {ticker_str}.{uq_note}\n\n"
                    "You've done 8 steps of rigorous analysis. Now it's time for one final deep research push "
                    "to leave no stone unturned.\n\n"
                    "**🔎 Competitive Moat Analysis** (search the web):\n"
                    "- What makes this company defensible? Patents, network effects, switching costs, brand, scale?\n"
                    "- Who are the top 3 competitors and how does this company compare on key metrics?\n"
                    "- Is the moat widening or narrowing?\n\n"
                    "**📊 Earnings & Growth Deep Dive** (search the web):\n"
                    "- Last 4 quarters: did they beat or miss estimates? By how much?\n"
                    "- Revenue growth trajectory — accelerating, stable, or decelerating?\n"
                    "- Any guidance updates from management?\n"
                    "- What are analysts saying about future expectations?\n\n"
                    "**🔍 Bear Case Investigation** (search the web):\n"
                    "- What are the bears and short sellers saying about this stock?\n"
                    "- Are there any red flags you may have missed in earlier steps?\n"
                    "- Any upcoming headwinds (regulation, competition, macro)?\n"
                    "- Search for recent negative articles or downgrades\n\n"
                    "**💡 Catalyst Timeline:**\n"
                    "- List the next 3-5 potential catalysts with approximate dates\n"
                    "- Which catalyst could move the stock the most?\n"
                    "- Any events in the next 30/60/90 days investors should know about?\n\n"
                    "**🏁 Deep Dive Conclusion:**\n"
                    "After this extra research, has your thesis changed at all? "
                    "Rate your overall conviction: High / Medium / Low, and explain why."
                ),
            },
            {
                "title": "Final Verdict",
                "system": base_system + "\nThis is YOUR call. Incorporate ALL previous analysis including news and research. Your reputation is on the line. Be bold and decisive. No hedging. NEVER recommend a stock with a terrible chart. Cheap + bad chart = value trap.",
                "web_search": False,
                "prompt": (
                    f"FINAL VERDICT on {ticker_str}.{uq_note}\n\n"
                    "You have completed: Stock Screening, Market Snapshot, News & Headlines, Technical Analysis, Fundamental Analysis, "
                    "Deep Research, Risk & Ownership, Valuation & Price Targets, and Winner Deep Dive.\n\n"
                    "Now synthesize EVERYTHING — data, news, research, technicals, fundamentals, AND the deep dive findings — into your final call.\n\n"
                    "?? CRITICAL RULES FOR YOUR VERDICT:\n"
                    "1. If the user specified price criteria and this stock FAILS it, rate it SELL regardless of other merits.\n"
                    "2. If the chart is TERRIBLE (below both SMAs, negative YTD/1Y, near 52-week lows), "
                    "it should NOT receive a BUY rating — cheap + bad chart = value trap.\n"
                    "3. Refer back to your Stock Screening step — did this stock pass or fail?\n"
                    "4. If this stock doesn't deserve a BUY, say so honestly. Don't force a recommendation.\n\n"
                    "Structure EXACTLY like this:\n\n"
                    "---\n\n"
                    "## Verdict: 🟢 BUY / 🟡 HOLD / 🔴 SELL\n"
                    "## Rating: [X]/100\n\n"
                    "Give a precise numeric rating from 1-100 where:\n"
                    "- 90-100: 🟢 STRONG BUY — exceptional opportunity, strong on all fronts\n"
                    "- 75-89: 🟢 BUY — solid fundamentals, good entry, more upside than downside\n"
                    "- 60-74: 🟢 LEAN BUY — decent opportunity with some risks, but net positive\n"
                    "- 45-59: 🟡 HOLD — balanced risk/reward, wait for better entry or catalyst\n"
                    "- 30-44: 🔴 LEAN SELL — more downside risk than upside, concerning signals\n"
                    "- 15-29: 🔴 SELL — significant red flags, poor fundamentals or technicals\n"
                    "- 1-14: 🔴 STRONG SELL — avoid completely, major structural problems\n\n"
                    "**The Case** (one powerful paragraph — weave together your best data points AND recent news/research findings. "
                    "If the stock contradicts the user's stated requirements, lead with that.)\n\n"
                    "### Scorecard\n"
                    "| Category | Grade | Key Reason |\n"
                    "|----------|-------|------------|\n"
                    "| Chart Health | A-F | ... |\n"
                    "| Technical Momentum | A-F | ... |\n"
                    "| Fundamental Quality | A-F | ... |\n"
                    "| Valuation | A-F | ... |\n"
                    "| Risk/Reward | A-F | ... |\n"
                    "| News & Catalysts | A-F | ... |\n"
                    "| **Overall** | **A-F** | **...** |\n\n"
                    "### Bull Case 🐂\n"
                    "1. [strongest reason — specific number + news support]\n"
                    "2. [second reason — specific data point]\n"
                    "3. [third reason — catalyst or research finding]\n\n"
                    "### Bear Case 🐻\n"
                    "1. [biggest risk — specific number + news context]\n"
                    "2. [second risk — data-backed concern]\n"
                    "3. [third risk — research finding or macro headwind]\n\n"
                    "### Trade Setup\n"
                    "- **Entry:** $X.XX – $X.XX\n"
                    "- **Target:** $X.XX (X% upside)\n"
                    "- **Stop-Loss:** $X.XX (X% downside)\n"
                    "- **Risk/Reward Ratio:** X:1\n"
                    "- **Time Horizon:** [short/medium/long term]\n"
                    "- **Ideal For:** [growth investor / value investor / swing trader / income investor]\n\n"
                    "### Bottom Line\n"
                    "2-3 sentences. Crystal clear. No ambiguity. What should the investor DO? "
                    "Reference the most compelling news/catalyst that tips the scale.\n\n"
                    "### ?? MACHINE-READABLE RATINGS (REQUIRED — emit this EXACT format at the very end):\n"
                    "<<<STOCK_RATINGS>>>\n"
                    + ('{"ratings":{"' + tickers[0] + '":{"score":0,"verdict":"hold"}},"winner":"' + tickers[0] + '"}\n' if tickers else '{"ratings":{},"winner":""}\n') +
                    "<<<END_STOCK_RATINGS>>>\n"
                    "Replace score with your ACTUAL rating (1-100) and verdict with buy/hold/sell. "
                    "This data block is parsed by the UI — do NOT skip it."
                ),
            },
            {
                "title": "Buying Plan",
                "system": base_system + "\nYou are now a personal investment advisor giving an actionable buying plan. Be specific, practical, and clear. The user needs step-by-step instructions they can follow RIGHT NOW.",
                "web_search": False,
                "prompt": (
                    f"BUYING PLAN for the user.{uq_note}\n\n"
                    "You just completed a full stock analysis. Now give the user a SPECIFIC, ACTIONABLE buying plan.\n\n"
                    "Structure EXACTLY like this:\n\n"
                    "## 💰 Your Buying Plan\n\n"
                    "**Your Budget:** [reference the user's stated budget if mentioned]\n\n"
                    "### Step-by-Step Instructions:\n"
                    "1. **Open your brokerage app** (Robinhood, Fidelity, Schwab, etc.)\n"
                    "2. **Search for [TICKER]** — this is your primary buy\n"
                    "3. **Order type:** [Market order / Limit order at $X.XX] — explain why\n"
                    "4. **Number of shares:** [X shares at ~$X.XX = $X.XX total] — show the math\n"
                    "   - If the stock is too expensive for full shares, explain fractional shares\n"
                    "5. **Set a stop-loss** at $X.XX to protect your downside\n\n"
                    "### If you want to split your money:\n"
                    "Show an alternative portfolio split with exact dollar amounts and share counts.\n\n"
                    "### When to Buy:\n"
                    "- Is now a good entry or should they wait for a dip?\n"
                    "- Any upcoming events (earnings, etc.) to be aware of?\n\n"
                    "### When to Sell:\n"
                    "- Target price to take profits: $X.XX (X% gain)\n"
                    "- Stop-loss price to cut losses: $X.XX (X% loss)\n\n"
                    "### Important Reminders:\n"
                    "- Don't invest money you can't afford to lose\n"
                    "- This is AI analysis, not professional financial advice\n"
                    "- Consider your risk tolerance and time horizon"
                ),
            },
        ]


def _prefetch_stock_context(user_text):
    """Detect stock tickers in user message and pre-fetch data so the AI can analyze real numbers."""
    if not user_text:
        return ""
    # Match $TICKER, explicit ticker mentions like "AAPL stock", or common patterns
    ticker_pattern = re.compile(r'\$([A-Z]{1,5})\b')
    tickers = set(ticker_pattern.findall(user_text.upper()))
    # Also match "TICKER stock" or "TICKER shares" patterns
    word_pattern = re.compile(r'\b([A-Z]{1,5})\s+(?:stock|shares?|price|ticker|chart)\b', re.IGNORECASE)
    for m in word_pattern.finditer(user_text):
        t = m.group(1).upper()
        if len(t) >= 2:
            tickers.add(t)
    if not tickers or len(tickers) > 10:
        return ""
    # Fetch data in parallel
    results = []
    from concurrent.futures import ThreadPoolExecutor, as_completed
    def _fetch(t):
        return t, _fetch_stock_data_dict(t)
    with ThreadPoolExecutor(max_workers=min(len(tickers), 4)) as pool:
        futs = {pool.submit(_fetch, t): t for t in tickers}
        for fut in as_completed(futs):
            ticker, data = fut.result()
            if data and not data.get("error"):
                results.append(data)
    if not results:
        return ""
    # Build a concise summary for the AI
    lines = ["Below is real-time stock data fetched from Yahoo Finance. Use these exact numbers in your analysis."]
    for d in results:
        line = f"• {d['ticker']} ({d.get('name','')}) — ${d['price']:.2f}"
        if d.get('changePct') is not None:
            sign = '+' if d['changePct'] >= 0 else ''
            line += f" ({sign}{d['changePct']:.2f}%)"
        if d.get('marketCap'):
            mc = d['marketCap']
            if mc >= 1e12: line += f" | MCap ${mc/1e12:.2f}T"
            elif mc >= 1e9: line += f" | MCap ${mc/1e9:.2f}B"
        if d.get('pe'): line += f" | P/E {d['pe']:.1f}"
        if d.get('health', {}).get('score') is not None:
            line += f" | Health {d['health']['score']}/100"
        if d.get('verdict'): line += f" | Verdict: {d['verdict'].upper()}"
        if d.get('recommendation'): line += f" | Analyst: {d['recommendation']}"
        perf = d.get('perf', {})
        perf_parts = []
        for k, label in [('1w','1W'),('1m','1M'),('3m','3M'),('ytd','YTD'),('1y','1Y')]:
            if perf.get(k) is not None:
                perf_parts.append(f"{label}: {'+' if perf[k]>=0 else ''}{perf[k]:.1f}%")
        if perf_parts: line += f" | Perf: {', '.join(perf_parts)}"
        lines.append(line)
    return "\n".join(lines)


def prepare_chat_turn(chat, payload):
    user_text = (payload.get("message") or "").strip()
    attached = payload.get("files", [])
    is_continue = bool(payload.get("is_continue"))
    if not user_text and not attached:
        return None, jsonify({"error": "Empty"}), 400

    # --- Truncate chat history if editing a previous message ---
    truncate_at = payload.get("truncate_at")
    if truncate_at is not None:
        try:
            idx = int(truncate_at)
            if 0 <= idx < len(chat.get("messages", [])):
                chat["messages"] = chat["messages"][:idx]
                save_chat(chat)
        except (ValueError, TypeError):
            pass

    settings = load_settings()
    resolved = resolve_chat_model(chat, settings)
    if resolved.get("error"):
        return None, jsonify({"reply": resolved["error"], "files": [], "locked": True}), 403

    # Store the raw user text (without canvas/reply context) for display in chat history
    display_text = (payload.get("raw_text") or user_text).strip()
    user_msg = {"role": "user", "text": display_text, "timestamp": datetime.datetime.now().isoformat()}
    if is_continue or payload.get("is_system"):
        user_msg["hidden"] = True
    images = []
    file_texts = []
    documents = []
    for f in attached:
        mime = f.get("mime", "")
        # Reply images from search results — download from URL
        if f.get("url") and not f.get("data"):
            try:
                import requests as _req
                resp = _req.get(f["url"], timeout=10, headers={"User-Agent": "Mozilla/5.0"})
                if resp.status_code == 200 and resp.headers.get("content-type", "").startswith("image/"):
                    img_b64 = base64.b64encode(resp.content).decode()
                    img_mime = resp.headers.get("content-type", "image/jpeg").split(";")[0]
                    images.append({"data": img_b64, "mime": img_mime})
            except Exception:
                pass
            continue
        if mime.startswith("image/") and f.get("data"):
            images.append({"data": f["data"], "mime": mime, "name": f.get("name", "")})
        elif f.get("doc_data"):
            documents.append({"data": f["doc_data"], "mime": mime, "name": f.get("name", "document")})
        elif f.get("text"):
            file_texts.append(f"[File: {f['name']}]\n{f['text']}")
    if images:
        user_msg["images"] = images
    if documents:
        user_msg["documents"] = documents
    if file_texts:
        user_msg["file_text"] = "\n\n".join(file_texts)
        user_msg["file_name"] = ", ".join(f["name"] for f in attached if f.get("text"))

    # --- Thinking & web-search flags ---
    thinking_level = payload.get("thinking_level", "off")
    if thinking_level == "off" and user_text:
        auto = _detect_complex_query(user_text)
        if auto:
            thinking_level = auto
    web_search = payload.get("web_search", False)
    active_tools = payload.get("active_tools", [])

    # --- Auto-enable stock analysis for stock/ticker/financial queries ---
    if 'stock' not in active_tools and user_text:
        _is_system_reprompt = user_text.startswith('[SYSTEM]')
        if not _is_system_reprompt:
            _stock_indicators = re.search(
                r'(?i)\b(stock\s+(?:ticker|price|analysis|data|chart|info|card|quote)|'
                r'ticker\s+(?:for|of|symbol)|'
                r'(?:show|get|pull up|look up|check)\s+(?:me\s+)?(?:the\s+)?(?:stock|ticker)|'
                r'(?:how\s+is|how\'s)\s+\w+\s+(?:stock|doing\s+in\s+the\s+market)|'
                r'(?:stock|share)\s+(?:market|performance|overview)|'
                r'(?:buy|sell|hold|invest)\s+(?:in\s+)?\w+\s+(?:stock|shares)|'
                r'(?:market\s+cap|p/?e\s+ratio|earnings|dividend|52.week)|'
                r'\b[A-Z]{1,5}\s+(?:stock|shares|ticker|price))',
                user_text
            )
            if _stock_indicators:
                active_tools = list(active_tools) + ['stock']

    # --- Auto-enable mindmap for mind map / visual map requests ---
    if 'mindmap' not in active_tools and user_text:
        _is_system_reprompt = user_text.startswith('[SYSTEM]')
        if not _is_system_reprompt:
            _mindmap_indicators = re.search(
                r'(?i)\b(mind\s*map|mindmap|visual\s*map|concept\s*map|branch\s*diagram|'
                r'(?:create|make|draw|show|generate)\s+(?:a\s+)?(?:mind\s*map|concept\s*map|visual\s*map|map\s+of))',
                user_text
            )
            if _mindmap_indicators:
                active_tools = list(active_tools) + ['mindmap']

    # --- Auto-enable code execution for math queries ---
    if 'code' not in active_tools and user_text:
        _math_indicators = re.search(
            r'(?i)\b(solve|equation|graph|plot|factor|integral|derivative|calculus|'
            r'algebra|polynomial|quadratic|linear|exponential|logarithm|trig|'
            r'sin|cos|tan|sqrt|root|matrix|vector|determinant|eigenvalue|'
            r'y\s*=|f\s*\(x\)|limit|series|sum of|area under|slope|'
            r'intercept|vertex|asymptote|domain|range|zero[s]? of|'
            r'inequality|system of|simultaneous|binomial|permutation|combination|'
            r'probability|standard deviation|variance|regression|correlation|'
            r'mean|median|mode|histogram|scatter|parabola|hyperbola|ellipse|'
            r'circle equation|pythagorean|angle|radian|degree|'
            r'arithmetic sequence|geometric sequence|fibonacci|'
            r'differentiate|integrate|simplify|expand|'
            r'x\s*[\+\-\*\/\^]\s*\d|(?:find|what is|calculate|compute|evaluate)\s.*(?:\d[\+\-\*\/\^]|\bx\b))',
            user_text
        )
        if _math_indicators:
            active_tools = list(active_tools) + ['code']

    # --- Auto-enable research agent for deep research requests ---
    # Don't auto-enable for system reprompts (code execution results, etc.)
    if 'research' not in active_tools and user_text:
        _is_system_reprompt = user_text.startswith('[SYSTEM]')
        if not _is_system_reprompt:
            _research_indicators = re.search(
                r'(?i)\b(deep\s+research|research\s+report|comprehensive\s+research|'
                r'investigat(?:e|ion)\s+(?:and|on|into)|in[- ]?depth\s+(?:research|analysis|report))\b',
                user_text
            )
            if _research_indicators:
                active_tools = list(active_tools) + ['research']

    # --- Auto-enable research_go if chat has pending research (AI asked questions, user answered) ---
    # Only activate once — clear the flag immediately so it doesn't persist across multiple turns
    if 'research' not in active_tools and 'research_go' not in active_tools:
        if chat.get("research_pending"):
            active_tools = list(active_tools) + ['research_go']
            del chat["research_pending"]
            save_chat(chat)

    # Strip research/research_go from active_tools for system reprompts to prevent re-triggering
    if user_text and user_text.startswith('[SYSTEM]'):
        active_tools = [t for t in active_tools if t not in ('research', 'research_go')]

    # --- Enable web search if search or research tools are active ---
    # Also enable by default for all queries so AI can access current info
    if not web_search:
        web_search = True

    # --- YouTube URL detection ---
    yt_urls = _extract_youtube_urls(user_text)
    if yt_urls:
        user_msg["youtube_urls"] = yt_urls

    # --- Workspace context: inject only relevant files (capped at 40k chars, 120k for code) ---
    all_files = read_workspace_files()
    _is_code_task = 'code' in active_tools or bool(attached and any(
        (f.get('mime','').startswith('text/') or f.get('text')) for f in attached
    )) or '```' in user_text
    _ws_cap = 120_000 if _is_code_task else 40_000
    relevant = select_relevant_files(user_text, all_files, max_chars=_ws_cap)
    ws = format_workspace_context(relevant)

    memory = load_memory()
    sysprompt = build_system_prompt(memory)

    # --- Cross-chat context disabled: titles from other chats were causing
    #     the AI to confuse conversations and act on unrelated topics ---

    # --- Per-chat custom instructions ---
    if chat.get("custom_instructions"):
        sysprompt += f"\n\n[CHAT-SPECIFIC INSTRUCTIONS]\n{chat['custom_instructions']}"

    # --- Folder custom instructions ---
    _folder_instr = payload.get("folder_instructions", "").strip()
    if _folder_instr:
        sysprompt += f"\n\n[FOLDER INSTRUCTIONS]\nThis chat is in a folder with these custom instructions. Follow them for all responses:\n{_folder_instr}"

    # --- Folder context files (uploaded to folder as reference material) ---
    _folder_files = payload.get("folder_context_files") or []
    if _folder_files and isinstance(_folder_files, list):
        file_parts = []
        for ff in _folder_files[:10]:  # Cap at 10 files
            fname = (ff.get("name") or "file").strip()
            fdata = (ff.get("data") or "").strip()
            if not fdata:
                continue
            # Strip data URI prefix if present (e.g. data:text/plain;base64,...)
            if fdata.startswith("data:"):
                # It's a data URI — decode base64 for text files, skip binary
                try:
                    _comma = fdata.index(",")
                    _meta = fdata[:_comma]
                    _b64 = fdata[_comma + 1:]
                    import base64 as _b64mod
                    _decoded = _b64mod.b64decode(_b64)
                    if "image/" in _meta:
                        # Image files — note them but don't dump binary into prompt
                        file_parts.append(f"[File: {fname}] (image file — uploaded as visual reference)")
                        continue
                    fdata = _decoded.decode("utf-8", errors="replace")[:50000]
                except Exception:
                    continue
            if fdata:
                file_parts.append(f"[File: {fname}]\n{fdata[:50000]}")
        if file_parts:
            sysprompt += "\n\n[FOLDER CONTEXT FILES]\nThe following files were uploaded as reference material for this folder:\n\n" + "\n\n".join(file_parts)

    # --- Active tool instructions (injected silently into system prompt) ---
    tool_instructions = _build_tool_instructions(active_tools)
    if tool_instructions:
        sysprompt += tool_instructions

    # --- HuggingFace Connector context ---
    try:
        hf_token = _hf_token()
        sysprompt += build_hf_connector_instructions(bool(hf_token))
    except Exception:
        pass

    # --- Reminder system ---
    sysprompt += build_reminder_instructions(
        datetime.datetime.now(),
        payload.get("reminders", []),
    )

    # --- User location context ---
    sysprompt += build_location_instructions(payload.get("user_location"))

    # --- Per-chat pinned files context ---
    pinned = chat.get("pinned_files") or []
    if pinned:
        pinned_ctx = []
        for pf in pinned:
            path = pf if isinstance(pf, str) else pf.get("path", "")
            if not path:
                continue
            fp = WORKSPACE / Path(path).as_posix()
            if fp.exists() and fp.is_file():
                try:
                    content = fp.read_text(encoding="utf-8")[:50000]
                    pinned_ctx.append(f"=== PINNED FILE: {path} ===\n{content}")
                except Exception:
                    pass
        if pinned_ctx:
            ws = "[PINNED FILES]\n" + "\n\n".join(pinned_ctx) + "\n\n" + ws

    # --- Chat history: summarize old messages if conversation is long ---
    messages = chat["messages"]
    if len(messages) > 20:
        if ("summary_cache" not in chat or
                chat.get("summary_at") != len(messages) - 10):
            chat["summary_cache"] = _summarize_messages(messages[:-10], resolved)
            chat["summary_at"] = len(messages) - 10
        api_msgs = [
            {"role": "user", "text": f"[CONVERSATION SUMMARY — older messages in this chat, use for continuity only]\n{chat['summary_cache']}"},
            {"role": "assistant", "text": "Got it, I have the context from our earlier conversation."},
        ] + list(messages[-10:])
    else:
        api_msgs = list(messages[-20:])

    cur = dict(user_msg)
    # --- Pre-fetch stock data for tickers mentioned in user message ---
    stock_context = _prefetch_stock_context(user_text)
    cur["text"] = f"[WORKSPACE CONTEXT — reference only when user asks about their project/files]\n{ws}\n\n"
    if stock_context:
        cur["text"] += f"[LIVE STOCK DATA — present when user asks about stocks]\n{stock_context}\n\n"
    cur["text"] += f"[USER MESSAGE — this is the actual request, respond to THIS]\n{user_text}"
    if file_texts:
        cur["text"] += "\n\n" + "\n\n".join(file_texts)
    api_msgs.append(cur)

    return {
        "user_text": user_text,
        "attached": attached,
        "settings": settings,
        "resolved": resolved,
        "user_msg": user_msg,
        "memory": memory,
        "sysprompt": sysprompt,
        "api_msgs": api_msgs,
        "thinking": thinking_level not in ("off", False, None),
        "thinking_level": thinking_level,
        "web_search": web_search,
        "active_tools": active_tools,
    }, None, None

def finalize_chat_response(chat, ctx, raw_response, original_raw=None):
    executed = execute_file_operations(raw_response)
    # Pass file_operations paths to code execution so it excludes them from "generated files"
    _file_op_paths = {f["path"] for f in executed} if executed else set()
    # Save uploaded images to disk so code execution can access them
    _uploaded_paths = _save_uploaded_images(ctx)
    code_results = execute_code_blocks(raw_response, exclude_paths=_file_op_paths, uploaded_image_paths=_uploaded_paths)
    _cleanup_uploaded_images()
    new_facts = extract_memory_ops(raw_response)
    if new_facts:
        for fact in new_facts:
            if fact not in ctx["memory"]["facts"]:
                ctx["memory"]["facts"].append(fact)
        save_memory(ctx["memory"])

    clean = clean_response(raw_response)
    # Build a second version that keeps %%%IMGBLOCK:N%%% placeholders for the frontend
    clean_with_placeholders = clean_response(raw_response, keep_img_placeholders=True)

    # When code was executed, truncate display text to before the first CODE_EXECUTE block.
    # The auto-reprompt mechanism will send execution results back to the AI so it can
    # respond accurately instead of pre-emptively claiming success/failure.
    if code_results:
        code_idx = raw_response.find('<<<CODE_EXECUTE')
        if code_idx >= 0:
            pre_code_raw = raw_response[:code_idx]
            clean = clean_response(pre_code_raw).strip()
            clean_with_placeholders = clean_response(pre_code_raw, keep_img_placeholders=True).strip()

    if not chat["messages"] and ctx["user_text"]:
        # Re-read title from storage to check if the frontend's async generate-title already set it
        _fresh_chat, _ = load_chat(chat["id"])
        _fresh_title = (_fresh_chat.get("title") if _fresh_chat else chat.get("title")) or ""
        _fresh_title = _fresh_title.strip().lower()
        if _fresh_title in ("", "new chat"):
            # Use fast fallback (no AI call — instant) so we don't block the done event
            chat["title"] = fallback_chat_title(ctx["user_text"], clean)
        else:
            chat["title"] = _fresh_chat["title"]

    # Only append user_msg if it wasn't pre-saved by the stream endpoint
    if not chat.get("_streaming"):
        chat["messages"].append(ctx["user_msg"])
    else:
        chat.pop("_streaming", None)
    # Clean up periodic auto-save fields
    chat.pop("_partial_text", None)
    chat.pop("_partial_thinking", None)
    msg_obj = {
        "role": "model",
        "text": clean_with_placeholders,
        "raw_text": original_raw or raw_response,
        "timestamp": datetime.datetime.now().isoformat(),
        "files_modified": executed,
        "memory_added": new_facts or None,
    }
    if code_results:
        msg_obj["code_results"] = code_results
    # image_results is injected by the caller after finalize returns
    chat["messages"].append(msg_obj)
    # Track generated files on the chat object for per-chat file listing
    if executed:
        chat_files = chat.get("generated_files") or []
        existing = {f["path"] for f in chat_files}
        for f in executed:
            if f["path"] not in existing:
                chat_files.append({"path": f["path"], "action": f["action"],
                                   "when": datetime.datetime.now().isoformat()})
                existing.add(f["path"])
        chat["generated_files"] = chat_files
    save_chat(chat)
    # Track token usage for guests (estimate: 1 token ˜ 4 chars)
    if session.get("guest") and not session.get("user_id"):
        _add_guest_tokens((len(ctx.get("user_text", "")) + len(clean)) // 4)
    return clean, executed, new_facts, code_results, clean_with_placeholders

# --- Context Helpers --------------------------------------------------------

import re as _re
_STOPWORDS = {"the","and","for","that","this","with","from","have","will","are",
              "you","your","can","not","but","was","its","his","her","they",
              "how","why","what","when","where","which","who","been","has"}

def _detect_complex_query(text):
    """Return a thinking level string if the query looks complex, else None."""
    lo = text.lower()
    # High-complexity signals ? medium thinking
    deep_signals = ["prove ","derive ","proof","formal ","theorem","contradict",
                    "critique ","evaluate the ","what are the flaws","steel man",
                    "compare and contrast","trade-offs","tradeoffs","implications of",
                    "step by step","walk me through","break down","in depth",
                    "comprehensive","thorough","detailed analysis","deep dive"]
    if any(s in lo for s in deep_signals): return "medium"
    # Medium-complexity signals ? low thinking
    signals = ["why ","how does","analyze","analyse","compare","difference",
               "explain","debug ","optimize","design ","architecture","algorithm",
               "prove","calculate","implement","refactor","what if ",
               "should i","which is better","pros and cons","best approach",
               "help me understand","can you explain","figure out"]
    if any(s in lo for s in signals): return "low"
    if text.count("?") >= 2: return "low"
    if len(text) > 300: return "low"
    if "```" in text: return "low"
    return None


def select_relevant_files(user_text, files, max_chars=40_000):
    """Return workspace files most relevant to user_text, capped at max_chars."""
    if not files:
        return {}
    words = set(w.lower() for w in _re.findall(r"\b\w{3,}\b", user_text)
                if w.lower() not in _STOPWORDS)

    def score(path, content):
        tokens = set(w.lower() for w in _re.findall(r"\b\w{3,}\b", content))
        tokens |= set(w.lower() for w in _re.split(r"[/\\._]", path) if len(w) >= 3)
        return len(words & tokens)

    priority_names = {"status.md", "principles.md", "readme.md"}
    # Only include files that are relevant (score > 0) or are priority files
    scored = {}
    for path in files:
        s = score(path, files[path]) if words else 0
        is_priority = Path(path).name.lower() in priority_names
        if s > 0 or is_priority:
            scored[path] = (0 if is_priority else -s, path)
    prioritised = sorted(scored.keys(), key=lambda p: scored[p])
    result = {}; total = 0
    for path in prioritised:
        content = files[path]
        if total + len(content) <= max_chars:
            result[path] = content; total += len(content)
    return result


def _summarize_messages(old_messages, resolved):
    """Summarize older chat turns into a digest using a cheap model call."""
    lines = []
    for msg in old_messages[-30:]:
        prefix = "User" if msg.get("role") == "user" else "Assistant"
        text = (msg.get("text") or "")[:400]
        if text:
            lines.append(f"{prefix}: {text}")
    if not lines:
        return ""
    prompt = ("Summarize the following conversation into 4-6 concise bullet points. "
              "Focus on key topics, decisions, and context needed to continue it:\n\n"
              + "\n".join(lines))
    try:
        fast = {"google": "gemini-3-flash-preview", "openai": "gpt-5.4-mini",
                "anthropic": "claude-sonnet-4-6"}
        fn = PROVIDERS.get(resolved.get("provider"), call_openai)
        return fn(resolved["api_key"],
                  fast.get(resolved.get("provider"), resolved.get("actual_model")),
                  "You are a conversation summarizer. Output only brief bullet points.",
                  [{"role": "user", "text": prompt}],
                  base_url=resolved.get("base_url"))
    except Exception:
        return "\n".join(f"- {l}" for l in lines[-6:])


def _detect_friction_points(chats, todos, profile):
    """Analyze workspace state and surface friction: stale chats, piling tasks, status friction, predictive signals."""
    now = datetime.datetime.now()
    nudges = []

    # --- Stale chats: updated > 3 days ago with real messages ---
    for c in (chats or []):
        updated_str = c.get("updated") or c.get("created") or ""
        msg_count = c.get("message_count", 0) or 0
        if not updated_str or msg_count < 2:
            continue
        try:
            updated_dt = datetime.datetime.fromisoformat(updated_str)
            days_stale = (now - updated_dt).days
            if days_stale >= 3:
                nudges.append({
                    "category": "stale_chat",
                    "message": f"\"{c.get('title','Untitled')}\" — untouched for {days_stale} day{'s' if days_stale!=1 else ''}",
                    "next_step": "Review where you left off and decide: continue, archive, or close it out.",
                    "action": {"type": "open_chat", "chat_id": c.get("id", "")},
                })
        except Exception:
            continue
    # Keep only the top 2 stalest
    nudges.sort(key=lambda n: -int(''.join(filter(str.isdigit, n["message"])) or 0))
    stale_nudges = nudges[:2]
    nudges = stale_nudges

    # --- Piling todos: too many open tasks signals decision paralysis ---
    pending = [t for t in (todos or []) if not t.get("done")]
    if len(pending) >= 6:
        nudges.append({
            "category": "task_overload",
            "message": f"{len(pending)} open tasks — time to triage",
            "next_step": "Pick the 1-2 that actually move the needle today and defer the rest.",
            "action": {"type": "prompt", "text": "Help me triage my open tasks and pick the top priorities for today"},
        })

    # --- Scope creep: todos growing fast without completions ---
    done_count = len([t for t in (todos or []) if t.get("done")])
    total_count = len(todos or [])
    if total_count >= 8 and done_count < total_count * 0.2:
        nudges.append({
            "category": "scope_creep",
            "message": f"Only {done_count}/{total_count} tasks done — scope may be expanding faster than execution",
            "next_step": "Consider trimming low-value tasks or breaking big ones into smaller wins.",
            "action": {"type": "prompt", "text": "Help me identify which tasks I can cut or defer — I'm adding faster than finishing"},
        })

    # --- Stalled project files: project .md files not updated in 7+ days ---
    projects_dir = Path(__file__).parent / "projects"
    if projects_dir.exists():
        try:
            for pf in projects_dir.glob("*.md"):
                mtime = datetime.datetime.fromtimestamp(pf.stat().st_mtime)
                days_stale = (now - mtime).days
                if days_stale >= 7:
                    name = pf.stem.replace("_", " ").replace("-", " ").title()
                    nudges.append({
                        "category": "stalled_project",
                        "message": f"Project \"{name}\" hasn't been updated in {days_stale} days",
                        "next_step": "Quick check: still active, paused, or done? One line update keeps it alive.",
                        "action": {"type": "prompt", "text": f"Help me do a quick status check on my \"{name}\" project — is it still active?"},
                    })
        except Exception:
            pass

    # --- Deadline proximity: scan workspace files for upcoming dates ---
    try:
        date_pattern = re.compile(
            r'(?:deadline|due|by|before|target)[:\s]+(\d{4}-\d{2}-\d{2})', re.IGNORECASE)
        all_files = read_workspace_files()
        for fpath, content in all_files.items():
            for m in date_pattern.finditer(content[:5000]):
                try:
                    dt = datetime.datetime.strptime(m.group(1), "%Y-%m-%d")
                    days_left = (dt - now).days
                    if 0 <= days_left <= 3:
                        fname = Path(fpath).name
                        plural = "s" if days_left != 1 else ""
                        time_note = "today!" if days_left == 0 else f"{days_left} day{plural} away"
                        nudges.append({
                            "category": "deadline_soon",
                            "message": f"Deadline in {fname}: {m.group(1)} — {time_note}",
                            "next_step": "Make sure this is on track — what's the one thing to finish first?",
                            "action": {"type": "prompt", "text": f"I have a deadline on {m.group(1)} mentioned in {fname}. Help me make sure I'm on track."},
                        })
                except ValueError:
                    continue
    except Exception:
        pass

    # --- Resource spread: too many active projects ---
    if projects_dir.exists():
        try:
            recent_projects = [
                pf for pf in projects_dir.glob("*.md")
                if (now - datetime.datetime.fromtimestamp(pf.stat().st_mtime)).days < 7
            ]
            if len(recent_projects) >= 5:
                nudges.append({
                    "category": "resource_spread",
                    "message": f"{len(recent_projects)} active projects in the last week — spreading thin?",
                    "next_step": "Pick your top 2-3 priorities and pause the rest to protect focus.",
                    "action": {"type": "prompt", "text": "I have too many active projects. Help me pick the top 2-3 to focus on and pause the rest."},
                })
        except Exception:
            pass

    # --- STATUS.md friction items ---
    status_path = Path(__file__).parent / "STATUS.md"
    if status_path.exists():
        try:
            raw = status_path.read_text(encoding="utf-8")
            in_friction = False
            for line in raw.splitlines():
                stripped = line.strip()
                if "friction" in stripped.lower() and stripped.startswith("#"):
                    in_friction = True
                    continue
                if in_friction:
                    if stripped.startswith("#"):
                        break
                    if stripped.startswith("- ") and len(stripped) > 4:
                        nudges.append({
                            "category": "status_friction",
                            "message": stripped[2:].strip(),
                            "next_step": "Break this into one concrete 15-minute action you can do right now.",
                            "action": {"type": "prompt", "text": f"I'm stuck on: {stripped[2:].strip()}. What's the smallest concrete step I can take right now?"},
                        })
        except Exception:
            pass

    # --- No active focus set ---
    focus = (profile.get("current_focus") or "").strip() if profile else ""
    if not focus and (chats or todos):
        nudges.append({
            "category": "no_focus",
            "message": "No current focus set — easy to drift without a north star",
            "next_step": "Set a one-line focus for this week in your profile.",
            "action": {"type": "prompt", "text": "Help me define my current focus for this week"},
        })

    return nudges[:6]


def _build_cross_references(files):
    """Scan workspace files and find cross-references between them."""
    refs = []
    file_topics = {}  # path -> set of key terms
    for path, content in files.items():
        words = set(w.lower() for w in re.findall(r'\b[A-Za-z]{4,}\b', content))
        # Also extract mentioned file paths
        mentioned = set(re.findall(r'(?:notes|projects|decisions|people)/[\w\-/]+\.md', content))
        file_topics[path] = {"words": words, "mentions": mentioned}

    # Find connections: files that reference each other or share significant topic overlap
    paths = list(files.keys())
    for i, p1 in enumerate(paths):
        t1 = file_topics.get(p1, {})
        # Direct mentions
        for mentioned_path in t1.get("mentions", set()):
            if mentioned_path in files and mentioned_path != p1:
                refs.append({
                    "type": "direct_reference",
                    "source": p1,
                    "target": mentioned_path,
                    "summary": f"{p1} directly references {mentioned_path}"
                })
        # Topic overlap between project files and decision files
        for j in range(i + 1, len(paths)):
            p2 = paths[j]
            t2 = file_topics.get(p2, {})
            w1, w2 = t1.get("words", set()), t2.get("words", set())
            overlap = w1 & w2 - {"this", "that", "with", "from", "have", "been", "will", "they", "their", "about", "would", "could", "should", "which", "there", "other", "just", "some", "than", "into", "only", "also", "very", "when", "what", "your", "more", "make", "like", "over", "such", "take", "each", "them"}
            # Only flag if significant overlap and different directories
            dir1 = str(Path(p1).parent)
            dir2 = str(Path(p2).parent)
            if len(overlap) >= 8 and dir1 != dir2:
                shared = sorted(overlap, key=lambda w: -len(w))[:5]
                refs.append({
                    "type": "topic_overlap",
                    "source": p1,
                    "target": p2,
                    "shared_topics": shared,
                    "summary": f"{p1} and {p2} share topics: {', '.join(shared)}"
                })
    return refs[:20]


def _detect_workflow_patterns(chats):
    """Analyze recent chat history to detect common workflow sequences and suggest next actions."""
    patterns = []
    if not chats or len(chats) < 2:
        return patterns

    # --- Phase 1: Classify chats by activity type using titles AND message content ---
    recent_titles = [c.get("title", "").lower() for c in chats[:15]]

    research_kw = {"research", "investigate", "study", "analyze", "report", "sources", "deep dive"}
    brainstorm_kw = {"brainstorm", "ideas", "ideate", "creative", "options", "mind map"}
    plan_kw = {"plan", "organize", "schedule", "roadmap", "strategy", "priorities"}
    write_kw = {"write", "draft", "document", "create", "update", "edit"}
    decide_kw = {"decide", "decision", "choose", "compare", "evaluate"}

    def title_matches(title, keywords):
        return any(kw in title for kw in keywords)

    recent_types = []
    for t in recent_titles:
        if title_matches(t, research_kw): recent_types.append("research")
        elif title_matches(t, brainstorm_kw): recent_types.append("brainstorm")
        elif title_matches(t, plan_kw): recent_types.append("plan")
        elif title_matches(t, write_kw): recent_types.append("write")
        elif title_matches(t, decide_kw): recent_types.append("decide")

    # --- Phase 2: Analyze actual actions from recent chats (files, code, research) ---
    action_counts = {"file_ops": 0, "code_runs": 0, "research": 0, "mind_maps": 0, "todos": 0, "memory": 0}
    for c in chats[:10]:
        gen_files = c.get("generated_files") or []
        action_counts["file_ops"] += len(gen_files)
        msgs = c.get("messages") or []
        for msg in msgs[-10:]:
            text = msg.get("text") or ""
            if msg.get("code_results"):
                action_counts["code_runs"] += 1
            if "<<<DEEP_RESEARCH" in text or msg.get("research_id"):
                action_counts["research"] += 1
            if "```mermaid" in text:
                action_counts["mind_maps"] += 1
            if "```todolist" in text:
                action_counts["todos"] += 1
            if msg.get("memory_added"):
                action_counts["memory"] += len(msg["memory_added"]) if isinstance(msg.get("memory_added"), list) else 1

    # --- Phase 3: Suggest next step based on recent activity type ---
    if recent_types:
        latest = recent_types[0]
        suggestions = {
            "research": {
                "detected": "You've been doing research",
                "suggestion": "Ready to brainstorm or create a mind map from your findings?",
                "action": {"type": "prompt", "text": "Create a mind map summarizing my recent research findings"},
            },
            "brainstorm": {
                "detected": "You've been brainstorming",
                "suggestion": "Want to turn those ideas into a structured project plan with tasks?",
                "action": {"type": "prompt", "text": "Turn my brainstorming ideas into a structured project plan with actionable tasks"},
            },
            "plan": {
                "detected": "You've been planning",
                "suggestion": "Time to start executing? Want to create task breakdowns?",
                "action": {"type": "prompt", "text": "Break down my plan into actionable tasks with a todo list"},
            },
            "decide": {
                "detected": "You've been evaluating options",
                "suggestion": "Ready to document the decision and update STATUS.md?",
                "action": {"type": "prompt", "text": "Help me write a decision record for the choice I just made and update STATUS.md"},
            },
            "write": {
                "detected": "You've been writing",
                "suggestion": "Want to review, get feedback, or share this work?",
                "action": {"type": "prompt", "text": "Review what I just wrote and suggest improvements"},
            },
        }
        if latest in suggestions:
            patterns.append(suggestions[latest])

    # --- Phase 4: Action-based workflow suggestions ---
    if action_counts["mind_maps"] >= 1 and action_counts["todos"] == 0:
        patterns.append({
            "detected": "Mind maps created but no task lists yet",
            "suggestion": "Convert your mind maps into actionable todo lists to start executing.",
            "action": {"type": "prompt", "text": "Turn my recent mind maps into an actionable todo list with clear next steps"},
        })

    if action_counts["research"] >= 1 and action_counts["file_ops"] < 2:
        patterns.append({
            "detected": "Research done but few files saved",
            "suggestion": "Save your key findings to workspace files so they're always accessible.",
            "action": {"type": "prompt", "text": "Summarize my recent research findings and save them to organized workspace files"},
        })

    if action_counts["file_ops"] >= 5 and action_counts["todos"] == 0:
        patterns.append({
            "detected": "Lots of file activity but no task tracking",
            "suggestion": "You're creating content fast — a todo list could help you stay organized.",
            "action": {"type": "prompt", "text": "Create a todo list based on the files I've been working on recently"},
        })

    if action_counts["code_runs"] >= 3:
        patterns.append({
            "detected": "Active coding session detected",
            "suggestion": "Want to document what you've built or create tests?",
            "action": {"type": "prompt", "text": "Help me document the code I've been working on and suggest next improvements"},
        })

    # --- Phase 5: Detect recurring workflow sequences ---
    if len(recent_types) >= 2:
        pair = f"{recent_types[1]}?{recent_types[0]}"
        common_flows = {
            "research?brainstorm": "You often brainstorm after research — this is becoming your flow!",
            "brainstorm?plan": "You like to plan right after brainstorming — nice workflow!",
            "plan?write": "Planning then writing — your systematic approach is working!",
            "decide?write": "Making decisions then documenting — great habit!",
            "research?write": "Research then write — you work fast from findings to output!",
            "brainstorm?write": "Brainstorm then write — creative to concrete, solid pattern!",
        }
        if pair in common_flows:
            patterns.append({
                "detected": "Workflow pattern recognized",
                "suggestion": common_flows[pair],
                "action": None,
            })

    return patterns[:4]


def _widget_has_content(w):
    """Check if a widget has meaningful content to display."""
    wtype = (w.get("type") or "focus").lower()
    if wtype in ("recent", "todos", "nudge", "workflow", "reminders"):
        items = w.get("items") or []
        return isinstance(items, list) and len(items) > 0
    if wtype in ("vision", "motivation", "focus"):
        text = (w.get("text") or "").strip()
        return bool(text)
    return True

def _fallback_home_widgets(user_name, profile, chats, todos, visions, reminders=None):
    first_name = (user_name or "").split()[0] or "there"
    heading = f"Welcome back, {first_name}."
    widgets = []

    # Reminders — show pending/overdue ones prominently
    active_reminders = [r for r in (reminders or []) if not r.get("done")]
    if active_reminders:
        now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
        overdue = [r for r in active_reminders if (r.get("due") or "") <= now_str]
        upcoming = [r for r in active_reminders if (r.get("due") or "") > now_str]
        reminder_items = (overdue + upcoming)[:6]
        cnt = len(active_reminders)
        overdue_cnt = len(overdue)
        sub = f"{cnt} active"
        if overdue_cnt:
            sub += f" · {overdue_cnt} overdue!"
        widgets.append({
            "type": "reminders",
            "size": "medium",
            "title": "⏰ Reminders",
            "subtitle": sub,
            "items": reminder_items,
        })

    # Proactive friction detection — surface nudges early
    nudges = _detect_friction_points(chats, todos, profile)
    if nudges:
        widgets.append({
            "type": "nudge",
            "size": "medium",
            "title": "Needs your attention",
            "subtitle": f"{len(nudges)} item{'s' if len(nudges)!=1 else ''}",
            "items": nudges,
        })

    pending_todos = [t for t in (todos or []) if not t.get("done")]
    if pending_todos:
        widgets.append({
            "type": "todos",
            "size": "medium",
            "title": "Priority tasks",
            "subtitle": f"{len(pending_todos)} open",
            "items": pending_todos[:5],
        })

    if chats:
        widgets.append({
            "type": "recent",
            "size": "medium",
            "title": "Continue where you left off",
            "items": [{"id": c.get("id"), "title": c.get("title", "Untitled")} for c in chats[:5]],
        })

    focus = (profile.get("current_focus") or "").strip()
    if focus:
        widgets.append({
            "type": "focus",
            "size": "small",
            "title": "Current focus",
            "text": focus[:180],
        })

    if visions:
        v = visions[0]
        widgets.append({
            "type": "vision",
            "size": "small",
            "title": "Vision target",
            "text": (v.get("title") or "").strip()[:140],
            "meta": (v.get("when") or "").strip()[:80],
        })

    if not widgets:
        widgets = [{
            "type": "focus",
            "size": "large",
            "title": "Your command center is ready",
            "text": "Add tasks or start a chat to make this dashboard uniquely yours.",
        }]

    # Workflow automation — surface detected patterns
    wf_patterns = _detect_workflow_patterns(chats)
    if wf_patterns:
        widgets.append({
            "type": "workflow",
            "size": "medium",
            "title": "Workflow Insights",
            "subtitle": "Based on your recent activity",
            "items": wf_patterns,
        })

    widgets = [w for w in widgets if _widget_has_content(w)]
    return {"heading": heading, "widgets": widgets[:6]}


def _ai_home_widgets(user_name, profile, chats, todos, visions):
    settings = load_settings()
    selected = normalize_selected_model(settings)
    resolved = resolve_chat_model({"model": selected}, settings)
    if resolved.get("error"):
        return None

    provider = resolved.get("provider")
    if provider not in ("google", "openai", "anthropic", "custom"):
        return None

    payload = {
        "user_name": user_name,
        "profile": {
            "preferred_name": profile.get("preferred_name", ""),
            "what_you_do": profile.get("what_you_do", ""),
            "hobbies": profile.get("hobbies", ""),
            "current_focus": profile.get("current_focus", ""),
        },
        "recent_chats": [{"id": c.get("id"), "title": c.get("title", "Untitled")} for c in chats[:8]],
        "todos": todos[:10],
        "visions": visions[:5],
    }

    prompt = (
        "You are designing a dynamic AI homepage dashboard. "
        "Choose 3 to 5 useful widgets and sizes based on the provided user data. "
        "Output STRICT JSON only with this schema:\n"
        "{\n"
        "  \"heading\": \"string\",\n"
        "  \"widgets\": [\n"
        "    {\n"
        "      \"type\": \"todos|recent|focus|vision|motivation\",\n"
        "      \"size\": \"small|medium|large\",\n"
        "      \"title\": \"string\",\n"
        "      \"subtitle\": \"string (optional)\",\n"
        "      \"text\": \"string (optional)\",\n"
        "      \"items\": []\n"
        "    }\n"
        "  ]\n"
        "}\n"
        "Rules: pick practical widgets first, reflect upcoming schedule and todos if present, and keep it concise.\n\n"
        f"DATA:\n{json.dumps(payload, ensure_ascii=False)}"
    )

    try:
        raw = PROVIDERS.get(provider, call_openai)(
            resolved["api_key"],
            resolved["actual_model"],
            "You return clean JSON only.",
            [{"role": "user", "text": prompt}],
            base_url=resolved.get("base_url"),
        )
        txt = (raw or "").strip()
        m = re.search(r"\{[\s\S]*\}", txt)
        if m:
            txt = m.group(0)
        out = json.loads(txt)
        widgets = out.get("widgets") if isinstance(out, dict) else None
        if not isinstance(widgets, list) or not widgets:
            return None
        widgets = [w for w in widgets if _widget_has_content(w)]
        if not widgets:
            return None
        return {
            "heading": str(out.get("heading") or f"Welcome back, {(user_name or 'there').split()[0]}.")[:120],
            "widgets": widgets[:5],
        }
    except Exception:
        return None


# --- Provider Calls ----------------------------------------------------------

def call_google(api_key, model, sysprompt, messages, base_url=None, thinking=False, web_search=False, thinking_level=None, **kwargs):
    genai, types = _import_google()
    _timeout = 300_000 if (thinking or (thinking_level and thinking_level != "off")) else 120_000
    client = genai.Client(api_key=api_key, http_options={"timeout": _timeout})
    contents = _google_contents_from_messages(messages, types)
    cfg = dict(system_instruction=sysprompt)
    _level = thinking_level if thinking_level and thinking_level != "off" else ("low" if thinking else None)
    # For extended mode, use high budget on individual passes
    if _level == "extended":
        _level = "high"
    if _level:
        _budgets = {"low": 8192, "medium": 16384, "high": 32768}
        _budget = _budgets.get(_level, 10000)
        cfg["thinking_config"] = types.ThinkingConfig(thinking_budget=_budget, include_thoughts=True)
        cfg["max_output_tokens"] = 65536
        print(f"  [thinking] Google non-stream: thinking enabled, level={_level}, budget={_budget}")
    else:
        cfg["max_output_tokens"] = 65536
    if web_search:
        _tools = [types.Tool(google_search=types.GoogleSearch())]
        try:
            _tools.append(types.Tool(url_context=types.UrlContext()))
        except Exception:
            pass  # url_context not available in this SDK version
        cfg["tools"] = _tools
    r = client.models.generate_content(model=model, contents=contents,
        config=types.GenerateContentConfig(**cfg))
    # Extract thinking parts if present
    result_parts = []
    try:
        for candidate in (r.candidates or []):
            for part in (candidate.content.parts or []):
                is_thought = getattr(part, "thought", None)
                if is_thought and part.text:
                    print(f"  [thinking] Google: got thought part ({len(part.text)} chars)")
                    result_parts.append(f"<<<THINKING>>>\n{part.text}\n<<<END_THINKING>>>\n")
                elif part.text:
                    result_parts.append(part.text)
    except Exception as e:
        print(f"  [thinking] Google: error extracting parts: {e}")
        return r.text
    return "".join(result_parts) if result_parts else (r.text or "")

def call_google_stream(api_key, model, sysprompt, messages, base_url=None, thinking=False, web_search=False, thinking_level=None, **kwargs):
    genai, types = _import_google()
    # Use a longer timeout when thinking is enabled — large thinking budgets can take 3-5 minutes
    _timeout = 300_000 if (thinking or (thinking_level and thinking_level != "off")) else 120_000
    client = genai.Client(api_key=api_key, http_options={"timeout": _timeout})
    contents = _google_contents_from_messages(messages, types)
    cfg = dict(system_instruction=sysprompt)
    _level = thinking_level if thinking_level and thinking_level != "off" else ("low" if thinking else None)
    if _level == "extended":
        _level = "high"
    use_thinking = bool(_level)
    if use_thinking:
        _budgets = {"low": 8192, "medium": 16384, "high": 32768}
        _budget = _budgets.get(_level, 10000)
        cfg["thinking_config"] = types.ThinkingConfig(thinking_budget=_budget, include_thoughts=True)
        cfg["max_output_tokens"] = 65536
        print(f"  [thinking] Google stream: thinking enabled, level={_level}, budget={_budget}, timeout={_timeout}ms")
    else:
        cfg["max_output_tokens"] = 65536
    if web_search:
        _tools = [types.Tool(google_search=types.GoogleSearch())]
        try:
            _tools.append(types.Tool(url_context=types.UrlContext()))
        except Exception:
            pass  # url_context not available in this SDK version
        cfg["tools"] = _tools

    # Try streaming; on 400 errors with thinking+tools, retry without thinking
    _had_thinking = use_thinking
    _had_tools = "tools" in cfg
    for _attempt in range(3):
        try:
            stream = client.models.generate_content_stream(
                model=model,
                contents=contents,
                config=types.GenerateContentConfig(**cfg),
            )
            _thought_count = 0
            _content_count = 0
            for chunk in stream:
                try:
                    for candidate in (chunk.candidates or []):
                        for part in (candidate.content.parts or []):
                            is_thought = getattr(part, "thought", None)
                            if is_thought and part.text:
                                _thought_count += 1
                                if _thought_count == 1:
                                    print(f"  [thinking] Google stream: first thought chunk received")
                                yield {"__thinking__": True, "text": part.text}
                                continue
                            if part.text:
                                _content_count += 1
                                yield part.text
                except (AttributeError, TypeError) as e:
                    if thinking and _thought_count == 0:
                        print(f"  [thinking] Google stream: exception in part extraction: {e}")
                    text = getattr(chunk, "text", "") or ""
                    if text:
                        _content_count += 1
                        yield text
            if thinking or use_thinking:
                print(f"  [thinking] Google stream: total thought chunks={_thought_count}, content chunks={_content_count}")
            # If thinking produced output but content didn't, retry without thinking
            # (regardless of web_search — this can happen with any thinking+model combo)
            if _thought_count > 0 and _content_count == 0 and _attempt < 2 and use_thinking:
                print(f"  [thinking] Google stream: thinking produced output but no content — retrying without thinking (attempt {_attempt+1})")
                cfg.pop("thinking_config", None)
                use_thinking = False
                # Also try without tools if we have them, as the combo may be causing issues
                if _attempt >= 1 and "tools" in cfg:
                    cfg.pop("tools", None)
                continue
            return  # success
        except Exception as e:
            err_str = str(e)
            if _attempt == 0 and "400" in err_str and use_thinking:
                print(f"  [thinking] Google stream: 400 error with thinking ({err_str[:100]}), retrying without thinking")
                cfg.pop("thinking_config", None)
                use_thinking = False
                continue
            if _attempt <= 1 and "400" in err_str and "tools" in cfg:
                print(f"  [google] 400 error with tools ({err_str[:100]}), retrying without tools")
                cfg.pop("tools", None)
                continue
            raise

def call_openai(api_key, model, sysprompt, messages, base_url=None, web_search=False, **kwargs):
    openai = _import_openai()
    kw = {"api_key": api_key, "timeout": 120.0}
    if base_url: kw["base_url"] = base_url
    client = openai.OpenAI(**kw)
    msgs = [{"role": "system", "content": sysprompt}]
    for msg in messages:
        role = msg["role"] if msg["role"] in ("user", "assistant") else ("assistant" if msg["role"] == "model" else "user")
        parts = []
        if msg.get("text"): parts.append({"type": "text", "text": msg["text"]})
        for img in msg.get("images", []):
            parts.append({"type": "image_url", "image_url": {"url": f"data:{img['mime']};base64,{img['data']}"}})
        if msg.get("file_text"):
            parts.append({"type": "text", "text": f"[Attached: {msg.get('file_name','')}]\n{msg['file_text']}"})
        if len(parts) == 1 and parts[0]["type"] == "text":
            msgs.append({"role": role, "content": parts[0]["text"]})
        elif parts:
            msgs.append({"role": role, "content": parts})
    create_kw = dict(model=model, messages=msgs, max_tokens=32768)
    if web_search:
        create_kw["tools"] = [{"type": "web_search_preview"}]
        create_kw["tool_choice"] = "auto"
    r = client.chat.completions.create(**create_kw)
    return r.choices[0].message.content

def call_anthropic(api_key, model, sysprompt, messages, base_url=None, thinking=False, **kwargs):
    anthropic = _import_anthropic()
    kw = {"api_key": api_key, "timeout": 120.0}
    if base_url: kw["base_url"] = base_url
    client = anthropic.Anthropic(**kw)
    msgs = []
    for msg in messages:
        role = msg["role"] if msg["role"] in ("user", "assistant") else ("assistant" if msg["role"] == "model" else "user")
        parts = []
        for img in msg.get("images", []):
            parts.append({"type": "image", "source": {"type": "base64", "media_type": img["mime"], "data": img["data"]}})
        if msg.get("file_text"):
            parts.append({"type": "text", "text": f"[Attached: {msg.get('file_name','')}]\n{msg['file_text']}"})
        if msg.get("text"): parts.append({"type": "text", "text": msg["text"]})
        if parts: msgs.append({"role": role, "content": parts})
    create_kw = dict(model=model, max_tokens=64000, system=sysprompt, messages=msgs)
    if thinking:
        _ant_budget = 32000 if kwargs.get("thinking_level") in ("high", "extended") else 16000
        create_kw["thinking"] = {"type": "enabled", "budget_tokens": _ant_budget}
        print(f"  [thinking] Anthropic non-stream: thinking enabled, budget={_ant_budget}")
    r = client.messages.create(**create_kw)
    if thinking:
        parts_out = []
        for block in r.content:
            if block.type == "thinking" and getattr(block, "thinking", None):
                print(f"  [thinking] Anthropic: got thinking block ({len(block.thinking)} chars)")
                parts_out.append(f"<<<THINKING>>>\n{block.thinking}\n<<<END_THINKING>>>\n")
            elif block.type == "text" and block.text:
                parts_out.append(block.text)
        return "".join(parts_out)
    return r.content[0].text

PROVIDERS = {"google": call_google, "openai": call_openai,
             "anthropic": call_anthropic, "custom": call_openai}

def call_openai_stream(api_key, model, sysprompt, messages, base_url=None, web_search=False, **kwargs):
    openai = _import_openai()
    kw = {"api_key": api_key, "timeout": 120.0}
    if base_url: kw["base_url"] = base_url
    client = openai.OpenAI(**kw)
    msgs = [{"role": "system", "content": sysprompt}]
    for msg in messages:
        role = msg["role"] if msg["role"] in ("user", "assistant") else ("assistant" if msg["role"] == "model" else "user")
        parts = []
        if msg.get("text"): parts.append({"type": "text", "text": msg["text"]})
        for img in msg.get("images", []):
            parts.append({"type": "image_url", "image_url": {"url": f"data:{img['mime']};base64,{img['data']}"}})
        if msg.get("file_text"):
            parts.append({"type": "text", "text": f"[Attached: {msg.get('file_name','')}]\n{msg['file_text']}"})
        if len(parts) == 1 and parts[0]["type"] == "text":
            msgs.append({"role": role, "content": parts[0]["text"]})
        elif parts:
            msgs.append({"role": role, "content": parts})
    create_kw = dict(model=model, messages=msgs, stream=True, max_tokens=32768)
    if web_search:
        create_kw["tools"] = [{"type": "web_search_preview"}]
        create_kw["tool_choice"] = "auto"
    stream = client.chat.completions.create(**create_kw)
    for chunk in stream:
        if chunk.choices and chunk.choices[0].delta.content:
            yield chunk.choices[0].delta.content

def call_anthropic_stream(api_key, model, sysprompt, messages, base_url=None, thinking=False, **kwargs):
    anthropic = _import_anthropic()
    kw = {"api_key": api_key, "timeout": 120.0}
    if base_url: kw["base_url"] = base_url
    client = anthropic.Anthropic(**kw)
    msgs = []
    for msg in messages:
        role = msg["role"] if msg["role"] in ("user", "assistant") else ("assistant" if msg["role"] == "model" else "user")
        parts = []
        for img in msg.get("images", []):
            parts.append({"type": "image", "source": {"type": "base64", "media_type": img["mime"], "data": img["data"]}})
        if msg.get("file_text"):
            parts.append({"type": "text", "text": f"[Attached: {msg.get('file_name','')}]\n{msg['file_text']}"})
        if msg.get("text"): parts.append({"type": "text", "text": msg["text"]})
        if parts: msgs.append({"role": role, "content": parts})
    if thinking:
        _ant_budget = 32000 if kwargs.get("thinking_level") in ("high", "extended") else 16000
        print(f"  [thinking] Anthropic stream: thinking enabled, budget={_ant_budget}")
        # Stream with thinking enabled — iterate raw events
        _thought_count = 0
        with client.messages.stream(
            model=model, max_tokens=64000, system=sysprompt, messages=msgs,
            thinking={"type": "enabled", "budget_tokens": _ant_budget}
        ) as s:
            current_block_type = None
            for event in s:
                etype = getattr(event, "type", "")
                if etype == "content_block_start":
                    block = getattr(event, "content_block", None)
                    current_block_type = getattr(block, "type", "") if block else ""
                elif etype == "content_block_delta":
                    delta = getattr(event, "delta", None)
                    if delta:
                        dt = getattr(delta, "type", "")
                        if dt == "thinking_delta":
                            text = getattr(delta, "thinking", "") or ""
                            if text:
                                _thought_count += 1
                                if _thought_count == 1:
                                    print(f"  [thinking] Anthropic stream: first thinking delta")
                                yield {"__thinking__": True, "text": text}
                        elif dt == "text_delta":
                            yield getattr(delta, "text", "")
                elif etype == "content_block_stop":
                    current_block_type = None
        print(f"  [thinking] Anthropic stream: total thinking deltas={_thought_count}")
    else:
        with client.messages.stream(model=model, max_tokens=64000, system=sysprompt, messages=msgs) as stream:
            for text in stream.text_stream:
                yield text

STREAM_PROVIDERS = {"google": call_google_stream, "openai": call_openai_stream,
                    "anthropic": call_anthropic_stream, "custom": call_openai_stream}

def generate_image_google(api_key, prompt):
    genai, types = _import_google()
    client = genai.Client(api_key=api_key)
    r = client.models.generate_images(model="imagen-3.0-generate-002", prompt=prompt,
        config=types.GenerateImagesConfig(number_of_images=1))
    if r.generated_images:
        return base64.b64encode(r.generated_images[0].image.image_bytes).decode()
    return None

# --- Routes: Static ----------------------------------------------------------

@app.route("/")
def index():
    html = open(os.path.join("static", "index.html"), encoding="utf-8").read()
    html = html.replace("__CACHE_BUST__", _BOOT_TS)
    return html, 200, {"Content-Type": "text/html; charset=utf-8"}

@app.route("/api/ping")
def ping():
    """Lightweight keep-alive endpoint to prevent Render from sleeping."""
    return jsonify({"ok": True, "ts": int(time.time())})

@app.after_request
def add_no_cache_headers(resp):
    path = request.path or ""
    if path == "/" or path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
    # Anti-proxy-buffering for all streaming (ndjson) responses
    ct = resp.headers.get("Content-Type", "")
    if "ndjson" in ct or "event-stream" in ct:
        resp.headers.setdefault("X-Accel-Buffering", "no")
        resp.headers.setdefault("Cache-Control", "no-cache, no-transform")
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    return resp

# --- Routes: Auth -------------------------------------------------------------

@app.route("/api/auth/register", methods=["POST"])
def register():
    return jsonify({"error": "Email/password sign-up is disabled. Please sign in with Google."}), 403

@app.route("/api/auth/login", methods=["POST"])
def login():
    return jsonify({"error": "Email/password sign-in is disabled. Please sign in with Google."}), 403

@app.route("/api/auth/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"ok": True})

@app.route("/api/auth/guest", methods=["POST"])
def guest_login():
    d = request.get_json() or {}
    # Reuse a previously-stored guest_id so chats survive session loss
    prev_gid = (d.get("guest_id") or "").strip()
    if prev_gid and re.match(r'^[a-zA-Z0-9\-_]{1,36}$', prev_gid):
        gid = prev_gid
    else:
        gid = str(uuid.uuid4())[:12]
    session["guest"] = True
    session["guest_id"] = gid
    session.permanent = True
    return jsonify({"ok": True, "guest": True, "plan": "guest", "guest_id": gid})

@app.route("/api/auth/guest/status")
def guest_status():
    if not session.get("guest"):
        return jsonify({"guest": False})
    used = _guest_tokens_used()
    return jsonify({"guest": True, "used_tokens": used, "token_limit": GUEST_TOKEN_LIMIT, "remaining_tokens": max(0, GUEST_TOKEN_LIMIT - used)})

@app.route("/api/auth/me")
def auth_me():
    uid = session.get("user_id")
    if not uid:
        if session.get("guest"):
            used = _guest_tokens_used()
            return jsonify({"authenticated": False, "guest": True, "guest_tokens_remaining": max(0, GUEST_TOKEN_LIMIT - used), "plan": "guest"})
        return jsonify({"authenticated": False})
    user = _cur_user()
    if not user: session.clear(); return jsonify({"authenticated": False})
    profile = load_profile()
    if user["email"].lower().strip() == CREATOR_EMAIL:
        if not (profile.get("origin_story") or "").strip():
            profile["origin_story"] = DEFAULT_CREATOR_ORIGIN_STORY
            save_profile(profile)
    return jsonify({"authenticated": True, "user": {
        "id": user["id"], "email": user["email"], "name": user["name"],
        "theme": user.get("theme", "dark"), "provider": user.get("provider", "local"),
        "created": user.get("created"), "plan": user.get("plan", "free")},
        "onboarding_complete": bool(profile.get("onboarding_complete"))})

@app.route("/api/auth/google", methods=["POST"])
def auth_google():
    cred = (request.get_json() or {}).get("credential", "")
    if not cred: return jsonify({"error": "No credential"}), 400
    try:
        url = f"https://oauth2.googleapis.com/tokeninfo?id_token={urllib.parse.quote(cred)}"
        with urllib.request.urlopen(url, timeout=10) as resp:
            info = json.loads(resp.read().decode())
        cfg = _load_oauth()
        expected_client_id = _effective_google_client_id(cfg)
        if info.get("aud") != expected_client_id:
            return jsonify({"error": "Google token audience mismatch."}), 400
        email = info.get("email")
        name = info.get("name", info.get("given_name", ""))
        if not email: return jsonify({"error": "No email from Google"}), 400
    except Exception as e:
        return jsonify({"error": f"Google verification failed: {e}"}), 400
    user = oauth_user(email, name, "google")
    # Generate a remember token so the frontend can re-auth after session loss
    remember_token = secrets.token_hex(32)
    tokens = user.get("remember_tokens", [])
    tokens = tokens[-4:]  # Keep last 5 tokens max
    tokens.append(_hash_remember_token(remember_token))
    user["remember_tokens"] = tokens
    _save_user(user)
    session.permanent = True
    session.pop("guest", None); session.pop("guest_id", None)
    session["user_id"] = user["id"]; session["email"] = user["email"]
    return jsonify({"user": {"id": user["id"], "email": user["email"],
                             "name": user["name"], "theme": user.get("theme", "dark"), "plan": user.get("plan", "free")},
                    "remember_token": remember_token})

@app.route("/api/auth/resume", methods=["POST"])
def auth_resume():
    """Re-establish a session using a remember token stored in the browser."""
    d = request.get_json() or {}
    uid = (d.get("user_id") or "").strip()
    token = (d.get("remember_token") or "").strip()
    if not uid or not token:
        return jsonify({"authenticated": False}), 401
    user = _load_user_by_id(uid)
    if not user:
        return jsonify({"authenticated": False}), 401
    stored = user.get("remember_tokens", [])
    hashed = _hash_remember_token(token)
    if hashed not in stored:
        return jsonify({"authenticated": False}), 401
    session.permanent = True
    session.pop("guest", None); session.pop("guest_id", None)
    session["user_id"] = user["id"]
    session["email"] = user["email"]
    profile = load_profile()
    return jsonify({"authenticated": True, "user": {
        "id": user["id"], "email": user["email"], "name": user["name"],
        "theme": user.get("theme", "dark"), "provider": user.get("provider", "local"),
        "created": user.get("created"), "plan": user.get("plan", "free")},
        "onboarding_complete": bool(profile.get("onboarding_complete"))})

@app.route("/api/auth/github")
def auth_github_start():
    return jsonify({"error": "GitHub sign-in is disabled for now."}), 400

@app.route("/api/auth/github/callback")
def auth_github_cb():
    return "GitHub sign-in is disabled for now.", 400

@app.route("/api/auth/data")
@require_auth
def get_user_data():
    user = _cur_user(); mem = load_memory(); s = load_settings()
    chats = list_chats()
    # Count uploads from Firebase Storage
    bucket = _storage_bucket()
    uid = session.get("user_id", "")
    upload_count = 0
    if bucket:
        try:
            blobs = list(bucket.list_blobs(prefix=f"uploads/{uid}/"))
            upload_count = len(blobs)
        except Exception:
            pass
    return jsonify({
        "user": {"email": user.get("email"), "name": user.get("name"),
                 "provider": user.get("provider"), "created": user.get("created"), "theme": user.get("theme","dark")},
        "stats": {"chats": len(chats), "messages": sum(c.get("message_count",0) for c in chats),
                  "memory_facts": len(mem.get("facts",[])),
                  "uploaded_files": upload_count,
                  "api_keys": sum(1 for v in s.get("keys",{}).values() if v)},
        "memory": mem.get("facts", []),
        "chats": [{"id":c["id"],"title":c["title"],"messages":c["message_count"],"created":c["created"]} for c in chats]
    })

@app.route("/api/auth/data", methods=["DELETE"])
@require_auth
def reset_data():
    """Permanently delete the user's account and all associated data."""
    uid = session.get("user_id")
    if not uid:
        return jsonify({"error": "Not authenticated"}), 401
    if FIREBASE_ENABLED:
        # Delete all chats
        col = _chats_col()
        if col:
            for doc in col.stream():
                doc.reference.delete()
        # Delete memory, settings, profile
        for doc_name in ("memory", "settings", "profile"):
            ref = _uid_doc(doc_name)
            if ref:
                try: ref.delete()
                except Exception: pass
        # Delete uploaded files
        bucket = _storage_bucket()
        if bucket:
            try:
                blobs = bucket.list_blobs(prefix=f"uploads/{uid}/")
                for blob in blobs:
                    blob.delete()
            except Exception:
                pass
        # Delete the user document itself
        try:
            user_ref = db.collection("users").document(uid)
            user_ref.delete()
        except Exception:
            pass
    else:
        import shutil
        user_dir = _local_user_dir(uid)
        if user_dir.exists():
            shutil.rmtree(user_dir)
    # Clear server session
    session.clear()
    return jsonify({"ok": True, "message": "Account deleted."})

@app.route("/api/auth/theme", methods=["POST"])
@require_auth
def set_theme():
    theme = (request.get_json() or {}).get("theme", "dark")
    if theme not in ("dark", "light"): theme = "dark"
    uid = session.get("user_id")
    if uid:
        _update_user_field(uid, theme=theme)
    return jsonify({"ok": True})

@app.route("/api/auth/name", methods=["POST"])
@require_auth
def set_name():
    name = (request.get_json() or {}).get("name", "").strip()
    if not name: return jsonify({"error": "Name required"}), 400
    _save_user_name(name)
    return jsonify({"ok": True})

@app.route("/api/auth/plan", methods=["POST"])
@require_auth
def update_plan():
    plan = (request.get_json() or {}).get("plan", "").strip()
    if plan not in ("free", "pro", "max", "dev"):
        return jsonify({"error": "Invalid plan. Must be: free, pro, max, or dev"}), 400
    uid = session.get("user_id")
    if uid:
        _update_user_field(uid, plan=plan)
    return jsonify({"ok": True, "plan": plan})

@app.route("/api/profile-onboarding")
@require_auth
def get_profile_onboarding():
    p = load_profile()
    return jsonify({
        "onboarding_complete": bool(p.get("onboarding_complete")),
        "profile": {
            "preferred_name": p.get("preferred_name", ""),
            "what_you_do": p.get("what_you_do", ""),
            "hobbies": p.get("hobbies", ""),
            "current_focus": p.get("current_focus", ""),
            "origin_story": p.get("origin_story", ""),
        },
    })

@app.route("/api/profile-onboarding", methods=["POST"])
@require_auth
def save_profile_onboarding():
    d = request.get_json() or {}
    preferred_name = (d.get("preferred_name") or "").strip()
    what_you_do = (d.get("what_you_do") or "").strip()
    hobbies = (d.get("hobbies") or "").strip()
    current_focus = (d.get("current_focus") or "").strip()
    if not preferred_name or not what_you_do or not hobbies:
        return jsonify({"error": "Name, what you do, and hobbies are required."}), 400

    profile = load_profile()
    profile.update({
        "onboarding_complete": True,
        "preferred_name": preferred_name[:120],
        "what_you_do": what_you_do[:300],
        "hobbies": hobbies[:300],
        "current_focus": current_focus[:300],
        "origin_story": profile.get("origin_story", ""),
    })
    save_profile(profile)
    _save_user_name(profile["preferred_name"])

    mem = load_memory()
    prefixes = ("Preferred name: ", "Work: ", "Hobbies: ", "Current focus: ", "Why I built Gyro:")
    facts = [f for f in mem.get("facts", []) if not any(f.startswith(pfx) for pfx in prefixes)]
    facts.append(f"Preferred name: {profile['preferred_name']}")
    facts.append(f"Work: {profile['what_you_do']}")
    facts.append(f"Hobbies: {profile['hobbies']}")
    if profile["current_focus"]:
        facts.append(f"Current focus: {profile['current_focus']}")
    user = _cur_user()
    if user and user.get("email", "").lower().strip() == CREATOR_EMAIL:
        profile["origin_story"] = DEFAULT_CREATOR_ORIGIN_STORY
        save_profile(profile)
        facts.append(f"Why I built Gyro: {DEFAULT_CREATOR_ORIGIN_STORY}")
    mem["facts"] = facts
    save_memory(mem)

    return jsonify({"ok": True, "profile": profile, "user": {"name": profile["preferred_name"]}})

# --- Routes: OAuth Config ----------------------------------------------------

@app.route("/api/oauth-config")
def get_oauth_cfg():
    try:
        cfg = _load_oauth()
    except Exception:
        cfg = {}
    return jsonify({"google_client_id": _effective_google_client_id(cfg),
                    "github_available": False,
                    "apple_available": False})

@app.route("/api/oauth-config", methods=["POST"])
@require_auth
def save_oauth_cfg():
    d = request.get_json(); cfg = _load_oauth()
    for k in ("google_client_id",):
        if k in d: cfg[k] = d[k]
    _save_oauth(cfg)
    return jsonify({"ok": True})

# --- Routes: Settings --------------------------------------------------------

@app.route("/api/settings")
@require_auth
def get_settings():
    s = load_settings()
    safe_keys = {k: ("••••" + v[-4:] if len(v) > 4 else "••••") for k, v in s.get("keys", {}).items() if v}
    key_sources = {}
    for provider in ("google", "openai", "anthropic", "custom"):
        api_key, source = resolve_provider_key(s, provider)
        key_sources[provider] = source if api_key else ""
    return jsonify({"keys": safe_keys, "selected_model": s.get("selected_model"),
                    "custom_endpoints": s.get("custom_endpoints", []),
                    "key_sources": key_sources})

@app.route("/api/settings", methods=["POST"])
@require_auth
def update_settings():
    d = request.get_json(); s = load_settings()
    if "selected_model" in d:
        allowed, reason, _ = model_access(d["selected_model"], s)
        if not allowed:
            s["selected_model"] = DEFAULT_MODEL
            save_settings(s)
            return jsonify({"error": reason, "selected_model": DEFAULT_MODEL}), 400
        s["selected_model"] = d["selected_model"]
    if "keys" in d:
        for p, k in d["keys"].items():
            if p in ("google", "openai", "anthropic", "custom") and isinstance(k, str):
                s.setdefault("keys", {})[p] = k
    if "custom_endpoints" in d:
        s["custom_endpoints"] = [{"name": e["name"], "base_url": e["base_url"],
            "model": e.get("model", ""), "provider_type": e.get("provider_type", "openai")}
            for e in d["custom_endpoints"] if isinstance(e, dict) and e.get("name") and e.get("base_url")]
    save_settings(s)
    return jsonify({"ok": True})

@app.route("/api/settings/key", methods=["DELETE"])
@require_auth
def delete_key():
    p = (request.get_json() or {}).get("provider")
    s = load_settings()
    if p in s.get("keys", {}): del s["keys"][p]; save_settings(s)
    return jsonify({"ok": True})

@app.route("/api/models")
@require_auth_or_guest
def get_models():
    s = load_settings(); result = []
    for mid, info in MODELS.items():
        available, reason, key_source = model_access(mid, s)
        result.append({"id": mid, "label": info["label"], "provider": info["provider"],
                       "tier": info["tier"], "available": available,
                       "locked_reason": reason, "key_source": key_source})
    for ep in s.get("custom_endpoints", []):
        model_id = f"custom:{ep['name']}"
        available, reason, key_source = model_access(model_id, s)
        result.append({"id": f"custom:{ep['name']}", "label": ep["name"], "provider": "custom",
                       "tier": "custom", "available": available,
                       "locked_reason": reason, "key_source": key_source,
                       "base_url": ep.get("base_url"), "model": ep.get("model")})
    return jsonify({"models": result, "selected": normalize_selected_model(s)})

# --- Routes: Connectors ------------------------------------------------------

@app.route("/api/connectors")
@require_auth
def get_connectors():
    c = load_connectors()
    # Mask the token for security
    safe = {}
    for name, cfg in c.items():
        safe[name] = dict(cfg)
        if safe[name].get("token"):
            t = safe[name]["token"]
            safe[name]["token"] = "••••" + t[-4:] if len(t) > 4 else "••••"
    return jsonify({"connectors": safe})

@app.route("/api/connectors", methods=["POST"])
@require_auth
def update_connectors():
    d = request.get_json() or {}
    c = load_connectors()
    connector = d.get("connector")
    if connector == "huggingface":
        token = d.get("token")
        enabled = d.get("enabled")
        if token is not None:
            c.setdefault("huggingface", {})["token"] = token
        if enabled is not None:
            c.setdefault("huggingface", {})["enabled"] = bool(enabled)
    save_connectors(c)
    return jsonify({"ok": True})

@app.route("/api/connectors/huggingface/test", methods=["POST"])
@require_auth
def test_hf_connector():
    """Test that the HuggingFace token is valid."""
    c = load_connectors()
    token = c.get("huggingface", {}).get("token", "")
    if not token:
        return jsonify({"ok": False, "error": "No token configured"})
    try:
        from huggingface_hub import HfApi
        api = HfApi(token=token)
        info = api.whoami()
        username = info.get("name", info.get("fullname", "Unknown"))
        return jsonify({"ok": True, "username": username})
    except Exception as e:
        return jsonify({"ok": False, "error": f"Token invalid: {str(e)[:200]}"})

@app.route("/api/connectors/huggingface/spaces/search", methods=["POST"])
@require_auth
def search_hf_spaces():
    """Search HuggingFace Spaces by query."""
    d = request.get_json() or {}
    query = (d.get("query") or "").strip()
    if not query:
        return jsonify({"spaces": []})
    token = _hf_token()
    try:
        from huggingface_hub import HfApi
        api = HfApi(token=token or None)
        spaces = api.list_spaces(search=query, limit=10, sort="likes")
        results = []
        for s in spaces:
            results.append({
                "id": s.id,
                "likes": getattr(s, 'likes', 0),
                "sdk": getattr(s, 'sdk', ''),
            })
        return jsonify({"spaces": results})
    except Exception as e:
        return jsonify({"spaces": [], "error": str(e)[:200]})

@app.route("/api/connectors/huggingface/run", methods=["POST"])
@require_auth
def run_hf_space_route():
    """Run a HuggingFace Space with given input."""
    d = request.get_json() or {}
    space_id = (d.get("space") or "").strip()
    user_input = (d.get("input") or "").strip()
    if not space_id:
        return jsonify({"error": "No space_id provided"}), 400
    token = _hf_token()
    if not token:
        return jsonify({"error": "HuggingFace connector not configured. Go to Settings ? Connectors to set up your HuggingFace token."}), 400
    result = run_hf_space(space_id, user_input, hf_token=token)
    return jsonify(result)

@app.route("/api/connectors/huggingface/delete", methods=["POST"])
@require_auth
def delete_hf_connector():
    """Remove the HuggingFace connector."""
    c = load_connectors()
    c["huggingface"] = {"token": "", "enabled": False}
    save_connectors(c)
    return jsonify({"ok": True})

# --- Routes: Chats ------------------------------------------------------------

@app.route("/api/chats")
@require_auth_or_guest
def get_chats():
    return jsonify({"chats": list_chats()})

@app.route("/api/chats", methods=["POST"])
@require_auth_or_guest
def new_chat():
    d = request.get_json() or {}
    requested_model = d.get("model")
    settings = load_settings()
    if requested_model:
        allowed, _, _ = model_access(requested_model, settings)
        if not allowed:
            requested_model = DEFAULT_MODEL
    c = create_new_chat(model=requested_model, folder=d.get("folder", ""))
    save_chat(c)
    return jsonify(c)

@app.route("/api/chats/<chat_id>/generate-title", methods=["POST"])
@require_auth_or_guest
def generate_title_endpoint(chat_id):
    """Quick-generate a chat title from the user's first message using the lite model."""
    d = request.get_json() or {}
    user_text = (d.get("text") or "").strip()
    if not user_text:
        return jsonify({"title": "New Chat"})
    chat, _ = load_chat(chat_id)
    if not chat:
        return jsonify({"title": "New Chat"})
    try:
        title = generate_chat_title_fast(user_text)
        chat["title"] = title
        save_chat(chat)
        return jsonify({"title": title})
    except Exception as e:
        print(f"  [title] generate-title endpoint failed: {type(e).__name__}: {e}")
        title = fallback_chat_title(user_text, "")
        chat["title"] = title
        save_chat(chat)
        return jsonify({"title": title})

@app.route("/api/chats/<chat_id>")
@require_auth_or_guest
def get_chat(chat_id):
    c, reason = load_chat(chat_id)
    if not c: return jsonify({"error": f"Chat not found ({reason})"}), 404
    # Recover interrupted streams: if _streaming is set but no active generator,
    # the stream was lost (server restart, crash, etc.). Recover partial content.
    if c.get("_streaming"):
        partial = c.pop("_partial_text", None)
        partial_think = c.pop("_partial_thinking", None)
        c.pop("_streaming", None)
        if partial and partial.strip():
            text = partial.strip()
            if partial_think and partial_think.strip():
                text = f"<<<THINKING>>>\n{partial_think.strip()}\n<<<END_THINKING>>>\n{text}"
            # Strip unresolved media placeholders from interrupted text
            _clean_partial = re.sub(r'%%%IMGBLOCK:\d+%%%', '', partial).strip()
            _clean_partial = re.sub(r'%%%IMGGEN:\d+%%%', '', _clean_partial).strip()
            c["messages"].append({
                "role": "model",
                "text": _clean_partial + "\n\n*[Response interrupted — connection was lost]*",
                "raw_text": text,
                "timestamp": datetime.datetime.now().isoformat(),
                "interrupted": True,
            })
        save_chat(c)
    return jsonify(c)

@app.route("/api/chats/<chat_id>", methods=["PATCH"])
@require_auth_or_guest
def patch_chat(chat_id):
    c, reason = load_chat(chat_id)
    if not c: return jsonify({"error": f"Chat not found ({reason})"}), 404
    d = request.get_json()
    for f in ("title", "folder", "custom_instructions", "pinned_files"):
        if f in d: c[f] = d[f]
    if "model" in d:
        settings = load_settings()
        allowed, reason, _ = model_access(d["model"], settings)
        if not allowed:
            return jsonify({"error": reason}), 400
        c["model"] = d["model"]
    save_chat(c)
    return jsonify({"ok": True})

@app.route("/api/chats/<chat_id>/file")
@require_auth_or_guest
def chat_embedded_file(chat_id):
    """Serve a file embedded in chat message data (persists across server restarts)."""
    chat, reason = load_chat(chat_id)
    if not chat:
        return jsonify({"error": "Chat not found"}), 404
    msg_idx = request.args.get("msg", type=int)
    file_idx = request.args.get("file", type=int)
    ftype = request.args.get("type", "code")
    msgs = chat.get("messages", [])
    if msg_idx is None or msg_idx < 0 or msg_idx >= len(msgs):
        return jsonify({"error": "Invalid message index"}), 400
    msg = msgs[msg_idx]
    if ftype == "code":
        idx = 0
        for cr in (msg.get("code_results") or []):
            for gf in (cr.get("files") or []):
                if idx == file_idx:
                    data = gf.get("data")
                    if not data:
                        # Fallback: try serving from disk
                        disk_path = WORKSPACE / gf.get("path", "")
                        if disk_path.exists() and disk_path.is_file():
                            return send_from_directory(str(disk_path.parent), disk_path.name, as_attachment=True)
                        return jsonify({"error": "File data not available"}), 404
                    mime = gf.get("mime", "application/octet-stream")
                    name = gf.get("name", "file")
                    resp = Response(base64.b64decode(data), mimetype=mime)
                    resp.headers["Content-Disposition"] = f'attachment; filename="{name}"'
                    return resp
                idx += 1
    elif ftype == "image":
        images = msg.get("images") or []
        if file_idx is not None and 0 <= file_idx < len(images):
            img = images[file_idx]
            data = img.get("data")
            if not data:
                return jsonify({"error": "Image data not available"}), 404
            mime = img.get("mime", "image/png")
            resp = Response(base64.b64decode(data), mimetype=mime)
            return resp
    elif ftype == "document":
        documents = msg.get("documents") or []
        if file_idx is not None and 0 <= file_idx < len(documents):
            doc = documents[file_idx]
            data = doc.get("data")
            if not data:
                return jsonify({"error": "Document data not available"}), 404
            mime = doc.get("mime", "application/octet-stream")
            name = doc.get("name", "document")
            resp = Response(base64.b64decode(data), mimetype=mime)
            resp.headers["Content-Disposition"] = f'attachment; filename="{name}"'
            return resp
    return jsonify({"error": "File not found"}), 404

@app.route("/api/chats/<chat_id>/partial", methods=["POST"])
@require_auth_or_guest
def save_partial_response(chat_id):
    """Save a partial AI response during streaming.
    
    Called periodically via sendBeacon during streaming (every ~15s) and on beforeunload.
    When final=true, marks the response as interrupted (user left the page).
    Otherwise just updates _partial_text for recovery without ending the stream.
    """
    chat, reason = load_chat(chat_id)
    if not chat:
        return jsonify({"error": "Chat not found"}), 404
    # Only save if the chat is in streaming state (user msg already saved, no model reply yet)
    if not chat.get("_streaming"):
        return jsonify({"ok": True, "skipped": True}), 200
    try:
        data = request.get_json(silent=True) or {}
    except Exception:
        data = {}
    partial_text = (data.get("text") or "").strip()
    if not partial_text:
        return jsonify({"ok": True, "skipped": True}), 200
    is_final = data.get("final", False)
    if is_final:
        # User is leaving — append as interrupted message
        chat.pop("_streaming", None)
        chat.pop("_partial_text", None)
        chat.pop("_partial_thinking", None)
        # Strip unresolved media placeholders from interrupted text
        _clean_partial = re.sub(r'%%%IMGBLOCK:\d+%%%', '', partial_text).strip()
        _clean_partial = re.sub(r'%%%IMGGEN:\d+%%%', '', _clean_partial).strip()
        chat["messages"].append({
            "role": "model",
            "text": _clean_partial + "\n\n*[Response interrupted]*",
            "raw_text": partial_text,
            "timestamp": datetime.datetime.now().isoformat(),
            "interrupted": True,
        })
    else:
        # Periodic save — just update partial text for recovery
        chat["_partial_text"] = partial_text
    save_chat(chat)
    return jsonify({"ok": True}), 200

@app.route("/api/chats/<chat_id>", methods=["DELETE"])
@require_auth_or_guest
def del_chat(chat_id):
    delete_chat(chat_id)
    return jsonify({"ok": True})


@app.route("/api/chats/<chat_id>/stream/join")
@require_auth_or_guest
def stream_join(chat_id):
    """Cross-device sync: return buffered streaming events so another device can join.

    Query params:
        cursor (int): position in event buffer to read from (0 = start)
    Returns:
        events: list of NDJSON event strings from cursor onward
        cursor: new cursor position for next poll
        done: whether the main stream has finished
        research_id / research_query: if a research agent is active
        stock_agent_id: if a stock agent is active
    """
    cursor = int(request.args.get("cursor", 0))

    # 1. Check in-memory stream buffer
    with _active_streams_lock:
        stream = _active_streams.get(chat_id)

    if stream:
        events = stream["events"][cursor:]
        new_cursor = cursor + len(events)
        is_done = stream["done"] and new_cursor >= len(stream["events"])
        resp = {"events": events, "cursor": new_cursor, "done": is_done}
        if stream.get("research_id"):
            resp["research_id"] = stream["research_id"]
            resp["research_query"] = stream.get("research_query", "")
        if stream.get("stock_agent_id"):
            resp["stock_agent_id"] = stream["stock_agent_id"]
        return jsonify(resp)

    # 2. No in-memory buffer — check the chat object for active agents
    chat, _ = load_chat(chat_id)
    if not chat:
        return jsonify({"events": [], "cursor": 0, "done": True, "error": "not_found"}), 404

    resp = {"events": [], "cursor": 0, "done": True}

    # Check for active research agent
    _rid = chat.get("_active_research_id")
    if _rid:
        with _active_research_lock:
            if _active_research.get(_rid) and not _active_research[_rid]["done"]:
                resp["research_id"] = _rid
                resp["research_query"] = chat.get("_active_research_query", "")

    # Check for active stock agent
    _sid = chat.get("_active_stock_agent_id")
    if _sid:
        with _active_stock_agents_lock:
            if _active_stock_agents.get(_sid) and not _active_stock_agents[_sid]["done"]:
                resp["stock_agent_id"] = _sid

    # If chat has _streaming flag but no buffer, the server restarted — clean up
    if chat.get("_streaming") and not resp.get("research_id") and not resp.get("stock_agent_id"):
        # Check if there's a partial text we can use
        _partial = chat.get("_partial_text", "").strip()
        if _partial:
            chat.pop("_streaming", None)
            chat.pop("_partial_text", None)
            chat.pop("_partial_thinking", None)
            # Strip unresolved media placeholders from interrupted text
            _clean_partial = re.sub(r'%%%IMGBLOCK:\d+%%%', '', _partial).strip()
            _clean_partial = re.sub(r'%%%IMGGEN:\d+%%%', '', _clean_partial).strip()
            chat["messages"].append({
                "role": "model",
                "text": _clean_partial + "\n\n*[Response interrupted — reconnected from another device]*",
                "raw_text": _partial,
                "timestamp": datetime.datetime.now().isoformat(),
                "interrupted": True,
            })
            save_chat(chat)
        else:
            chat.pop("_streaming", None)
            save_chat(chat)
        resp["recovered"] = True

    return jsonify(resp)


@app.route("/api/chats/bulk-delete", methods=["POST"])
@require_auth_or_guest
def bulk_delete_chats():
    """Delete multiple chats at once."""
    d = request.get_json() or {}
    ids = d.get("chat_ids", [])
    if not isinstance(ids, list) or not ids:
        return jsonify({"error": "No chat IDs provided"}), 400
    deleted = 0
    for cid in ids:
        if isinstance(cid, str) and _safe_id(cid):
            if delete_chat(cid):
                deleted += 1
    return jsonify({"ok": True, "deleted": deleted})

@app.route("/api/chats/delete-all", methods=["POST"])
@require_auth_or_guest
def delete_all_chats():
    """Delete every chat for the current user, including transient/empty ones."""
    deleted = 0
    # First delete via list_chats (handles Firebase and runtime state)
    chats = list_chats()
    for c in chats:
        if delete_chat(c["id"]):
            deleted += 1
    # Also directly purge ALL json files from the local chats directory
    # (catches transient empty chats that list_chats filters out)
    if session.get("guest") and not session.get("user_id"):
        guest_id = session.get("guest_id")
        if guest_id:
            chats_dir = _guest_dir(guest_id) / "chats"
            if chats_dir.exists():
                for f in chats_dir.glob("*.json"):
                    try: f.unlink(); deleted += 1
                    except Exception: pass
        state = _guest_runtime_state()
        if state and "chats" in state:
            state["chats"] = {}
    else:
        uid = session.get("user_id")
        if uid and not FIREBASE_ENABLED:
            chats_dir = _local_user_dir(uid) / "chats"
            if chats_dir.exists():
                for f in chats_dir.glob("*.json"):
                    try: f.unlink(); deleted += 1
                    except Exception: pass
    return jsonify({"ok": True, "deleted": deleted})

# --- Chat Export / Import -----------------------------------------------------

@app.route("/api/chats/export", methods=["GET"])
@require_auth_or_guest
def export_chats():
    """Export all chats as a JSON download."""
    chat_list = list_chats()
    full_chats = []
    for c in chat_list:
        data, _ = load_chat(c["id"])
        if data:
            full_chats.append(data)
    payload = {
        "format": "Gyro",
        "version": 1,
        "exported": datetime.datetime.now().isoformat(),
        "chat_count": len(full_chats),
        "chats": full_chats,
    }
    return app.response_class(
        json.dumps(payload, ensure_ascii=False, default=str),
        mimetype="application/json",
        headers={"Content-Disposition": "attachment; filename=Gyro-all-chats-export.json"},
    )


@app.route("/api/chats/export/<chat_id>", methods=["GET"])
@require_auth_or_guest
def export_single_chat(chat_id):
    """Export a single chat as a JSON download."""
    data, _ = load_chat(chat_id)
    if not data:
        return jsonify({"error": "Chat not found"}), 404
    title = data.get("title", "chat")
    # Sanitize filename
    safe_title = re.sub(r'[^\w\s\-]', '', title).strip().replace(' ', '-')[:60] or "chat"
    payload = {
        "format": "Gyro",
        "version": 1,
        "exported": datetime.datetime.now().isoformat(),
        "chat_count": 1,
        "chats": [data],
    }
    return app.response_class(
        json.dumps(payload, ensure_ascii=False, default=str),
        mimetype="application/json",
        headers={"Content-Disposition": f"attachment; filename={safe_title}.json"},
    )


def _convert_chatgpt_export(data):
    """Convert a ChatGPT conversations.json export to Gyro format."""
    chats = []
    items = data if isinstance(data, list) else [data]
    for conv in items:
        if not isinstance(conv, dict):
            continue
        messages = []
        mapping = conv.get("mapping") or {}
        for node in mapping.values():
            msg = node.get("message")
            if not msg or not isinstance(msg, dict):
                continue
            author = (msg.get("author") or {}).get("role", "")
            content = msg.get("content") or {}
            parts = content.get("parts") or []
            text = ""
            for p in parts:
                if isinstance(p, str):
                    text += p
                elif isinstance(p, dict) and p.get("text"):
                    text += p["text"]
            if not text.strip():
                continue
            role = "user" if author == "user" else "kairo"
            messages.append({"role": role, "content": text.strip()})
        if not messages:
            continue
        created = ""
        ts = conv.get("create_time")
        if ts:
            try:
                created = datetime.datetime.fromtimestamp(ts).isoformat()
            except Exception:
                pass
        chats.append({
            "id": str(uuid.uuid4())[:12],
            "title": conv.get("title") or "Imported Chat",
            "created": created or datetime.datetime.now().isoformat(),
            "updated": datetime.datetime.now().isoformat(),
            "model": conv.get("default_model_slug") or "",
            "messages": messages,
            "folder": "Imported",
        })
    return chats


def _convert_claude_export(data):
    """Convert a Claude export to Gyro format."""
    chats = []
    items = data if isinstance(data, list) else [data]
    for conv in items:
        if not isinstance(conv, dict):
            continue
        messages = []
        for msg in conv.get("chat_messages") or conv.get("messages") or []:
            if not isinstance(msg, dict):
                continue
            sender = msg.get("sender") or msg.get("role") or ""
            text = ""
            content = msg.get("content") or msg.get("text") or ""
            if isinstance(content, str):
                text = content
            elif isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and part.get("text"):
                        text += part["text"]
                    elif isinstance(part, str):
                        text += part
            if not text.strip():
                continue
            role = "user" if sender in ("human", "user") else "kairo"
            messages.append({"role": role, "content": text.strip()})
        if not messages:
            continue
        chats.append({
            "id": str(uuid.uuid4())[:12],
            "title": conv.get("name") or conv.get("title") or "Imported Chat",
            "created": conv.get("created_at") or datetime.datetime.now().isoformat(),
            "updated": datetime.datetime.now().isoformat(),
            "model": conv.get("model") or "",
            "messages": messages,
            "folder": "Imported",
        })
    return chats


def _convert_generic_export(data):
    """Best-effort conversion for other AI export formats (Gemini, etc.)."""
    chats = []
    items = data if isinstance(data, list) else [data]
    for conv in items:
        if not isinstance(conv, dict):
            continue
        messages = []
        for msg in conv.get("messages") or conv.get("history") or []:
            if not isinstance(msg, dict):
                continue
            role_raw = msg.get("role") or msg.get("author") or msg.get("sender") or ""
            text = ""
            content = msg.get("content") or msg.get("text") or msg.get("parts") or ""
            if isinstance(content, str):
                text = content
            elif isinstance(content, list):
                for part in content:
                    if isinstance(part, str):
                        text += part
                    elif isinstance(part, dict):
                        text += part.get("text") or ""
            if not text.strip():
                continue
            role = "user" if role_raw.lower() in ("user", "human") else "kairo"
            messages.append({"role": role, "content": text.strip()})
        if not messages:
            continue
        chats.append({
            "id": str(uuid.uuid4())[:12],
            "title": conv.get("title") or conv.get("name") or "Imported Chat",
            "created": conv.get("created") or conv.get("create_time") or datetime.datetime.now().isoformat(),
            "updated": datetime.datetime.now().isoformat(),
            "model": conv.get("model") or "",
            "messages": messages,
            "folder": "Imported",
        })
    return chats


def _detect_and_convert(data):
    """Auto-detect the export format and convert to Gyro chats."""
    # Already Gyro format
    if isinstance(data, dict) and data.get("format") == "Gyro":
        return data.get("chats") or []

    # ChatGPT: has 'mapping' key with message nodes
    if isinstance(data, list) and data and isinstance(data[0], dict) and "mapping" in data[0]:
        return _convert_chatgpt_export(data)
    if isinstance(data, dict) and "mapping" in data:
        return _convert_chatgpt_export(data)

    # Claude: has 'chat_messages' key
    if isinstance(data, list) and data and isinstance(data[0], dict) and ("chat_messages" in data[0] or "sender" in (data[0].get("messages") or [{}])[0] if data[0].get("messages") else False):
        return _convert_claude_export(data)
    if isinstance(data, dict) and "chat_messages" in data:
        return _convert_claude_export(data)

    # Generic fallback
    return _convert_generic_export(data)


MAX_IMPORT_SIZE = 50 * 1024 * 1024  # 50 MB

@app.route("/api/chats/import", methods=["POST"])
@require_auth_or_guest
def import_chats():
    """Import chats from a JSON file (supports Gyro, ChatGPT, Claude formats)."""
    if request.content_length and request.content_length > MAX_IMPORT_SIZE:
        return jsonify({"error": "File too large (max 50 MB)"}), 413
    try:
        data = request.get_json(force=True)
    except Exception:
        return jsonify({"error": "Invalid JSON file"}), 400
    if not data:
        return jsonify({"error": "Empty file"}), 400

    try:
        chats_to_import = _detect_and_convert(data)
    except Exception as e:
        return jsonify({"error": f"Could not parse export: {str(e)[:200]}"}), 400

    if not chats_to_import:
        return jsonify({"error": "No chats found in the file"}), 400

    imported = 0
    for chat in chats_to_import:
        if not isinstance(chat, dict) or not chat.get("messages"):
            continue
        chat["id"] = str(uuid.uuid4())[:12]
        chat.setdefault("title", "Imported Chat")
        chat.setdefault("created", datetime.datetime.now().isoformat())
        chat["updated"] = datetime.datetime.now().isoformat()
        chat.setdefault("model", "")
        chat.setdefault("folder", "Imported")
        save_chat(chat)
        imported += 1

    return jsonify({"ok": True, "imported": imported})

@app.route("/api/cross-references")
@require_auth
def cross_references_route():
    """Analyze workspace files and return cross-references."""
    files = read_workspace_files()
    refs = _build_cross_references(files)
    return jsonify({"references": refs})

@app.route("/api/workflow-patterns")
@require_auth_or_guest
def workflow_patterns_route():
    """Analyze recent chat history and return detected workflow patterns."""
    chats = list_chats()
    patterns = _detect_workflow_patterns(chats)
    return jsonify({"patterns": patterns})

@app.route("/api/chats/<chat_id>/message", methods=["POST"])
@require_auth_or_guest
def chat_message(chat_id):
    if session.get("guest") and not session.get("user_id"):
        if _guest_tokens_used() >= GUEST_TOKEN_LIMIT:
            return jsonify({"reply": "You've reached your daily token limit for guest access. Sign in with Google for unlimited access!", "files": [], "guest_limit": True})
    chat, reason = load_chat(chat_id)
    if not chat: return jsonify({"error": f"Chat not found ({reason})"}), 404
    ctx, err_resp, status = prepare_chat_turn(chat, request.get_json() or {})
    if err_resp:
        return err_resp, status

    try:
        resolved = ctx["resolved"]
        resp = PROVIDERS.get(resolved["provider"], call_openai)(
            resolved["api_key"],
            resolved["actual_model"],
            ctx["sysprompt"],
            ctx["api_msgs"],
            base_url=resolved["base_url"],
        )
    except Exception as e:
        err = str(e)
        if any(w in err.lower() for w in ("429", "quota", "rate")):
            return jsonify({"error": f"Rate limit hit — wait a moment and try again. ({err[:120]})", "files": []})
        return jsonify({"error": f"API error: {err}", "files": []})

    original_resp = resp
    # Separate thinking from response text before extracting triggers,
    # because thinking may reference trigger syntax (e.g. AI discussing <<<DEEP_RESEARCH: ...>>>)
    _think_blocks = re.findall(r'<<<THINKING>>>.*?<<<END_THINKING>>>\n?', resp, re.DOTALL)
    _resp_no_think = re.sub(r'<<<THINKING>>>.*?<<<END_THINKING>>>\n?', '', resp, flags=re.DOTALL)
    _resp_no_think, research_query = extract_research_trigger(_resp_no_think)
    # Clear research_pending flag once research actually triggers
    if research_query and chat.get("research_pending"):
        del chat["research_pending"]
    _resp_no_think, image_searches = extract_image_searches(_resp_no_think)
    _resp_no_think, image_generations = extract_image_generation(_resp_no_think)
    _resp_no_think, stock_tickers_sync = extract_stock_tickers(_resp_no_think)
    _resp_no_think, hf_calls_sync = extract_hf_space_calls(_resp_no_think)
    _resp_no_think, extracted_reminders = extract_reminders(_resp_no_think)
    resp = "".join(_think_blocks) + _resp_no_think
    # Fetch stock data synchronously for non-streaming path
    stock_results_sync = []
    if stock_tickers_sync:
        for entry in stock_tickers_sync:
            sdata = _fetch_stock_data_dict(entry['ticker'])
            if sdata and not sdata.get("error"):
                stock_results_sync.append({"ticker": entry['ticker'], "index": entry['index'], "data": sdata})
    image_results = []
    if image_searches:
        from concurrent.futures import ThreadPoolExecutor, as_completed
        def _img_search(entry):
            imgs = search_images(entry['query'], num=entry['count'])
            return entry, imgs
        with ThreadPoolExecutor(max_workers=min(len(image_searches), 4)) as pool:
            futs = {pool.submit(_img_search, entry): entry for entry in image_searches}
            for fut in as_completed(futs):
                entry, imgs = fut.result()
                if imgs:
                    image_results.append({"query": entry['query'], "images": imgs, "index": entry['index'], "count": entry['count']})
    gen_results = []
    if image_generations:
        api_key = ctx["resolved"].get("api_key", "")
        _ref_imgs = ctx.get("user_msg", {}).get("images") or None
        for entry in image_generations:
            img_b64, result_or_err = generate_image_gemini(entry['prompt'], entry['aspect_ratio'], api_key=api_key, reference_images=_ref_imgs)
            if img_b64:
                data_uri = f"data:{result_or_err};base64,{img_b64}"
                gen_results.append({"prompt": entry['prompt'], "index": entry['index'], "url": data_uri, "mime": result_or_err})
    hf_results_sync = []
    if hf_calls_sync:
        token = _hf_token()
        for entry in hf_calls_sync:
            hf_res = run_hf_space(entry['space'], entry['input'], entry.get('params'), hf_token=token)
            if hf_res.get("success"):
                hf_results_sync.append({"space": entry['space'], "index": entry['index'], "result": hf_res})
    clean, executed, new_facts, code_results, clean_wp = finalize_chat_response(chat, ctx, resp, original_raw=original_resp)
    # If research tool was active but AI didn't trigger it (asked questions instead), set pending flag
    if 'research' in ctx.get('active_tools', []) and not research_query:
        chat["research_pending"] = True
        save_chat(chat)
    if image_results:
        chat["messages"][-1]["image_results"] = image_results
    if gen_results:
        chat["messages"][-1]["generated_images"] = gen_results
    if stock_results_sync:
        chat["messages"][-1]["stock_results"] = stock_results_sync
    if hf_results_sync:
        chat["messages"][-1]["hf_results"] = hf_results_sync
    if image_results or gen_results or stock_results_sync or hf_results_sync:
        save_chat(chat)
    # Clean up %%%IMGGEN:N%%% placeholders for failed image generations
    if image_generations and len(gen_results) < len(image_generations):
        _ok_indices = {g["index"] for g in gen_results}
        _failed = [g for g in image_generations if g["index"] not in _ok_indices]
        if _failed and chat["messages"]:
            _msg = chat["messages"][-1]
            _txt = _msg.get("text", "")
            for g in _failed:
                _txt = re.sub(rf'%%%IMGGEN:{g["index"]}%%%\s*', '', _txt)
            _msg["text"] = _txt.strip()
            save_chat(chat)
    result = {"reply": clean_wp if (image_searches or image_generations or stock_tickers_sync or hf_calls_sync) else clean, "files": executed, "memory_added": new_facts}
    if code_results:
        result["code_results"] = code_results
    if research_query:
        result["research_trigger"] = research_query
    if image_results:
        result["image_results"] = image_results
    if gen_results:
        result["generated_images"] = gen_results
    if stock_results_sync:
        result["stock_results"] = stock_results_sync
    if hf_results_sync:
        result["hf_results"] = hf_results_sync
    if extracted_reminders:
        result["reminders_set"] = extracted_reminders
    return jsonify(result)


def _fetch_stock_data_dict(ticker):
    """Fetch comprehensive stock data for a ticker. Returns dict or {'error': str}."""
    ticker = re.sub(r'[^A-Za-z0-9.\-^=]', '', ticker).upper()
    if not ticker or len(ticker) > 12:
        return {"error": "Invalid ticker"}
    try:
        import yfinance as yf
        tk = yf.Ticker(ticker)
        info = tk.info or {}
        if not info.get("regularMarketPrice") and not info.get("currentPrice"):
            return {"error": f"No data found for {ticker}"}
        price = info.get("regularMarketPrice") or info.get("currentPrice") or 0
        prev_close = info.get("regularMarketPreviousClose") or info.get("previousClose") or price
        change = price - prev_close if price and prev_close else 0
        change_pct = (change / prev_close * 100) if prev_close else 0

        # Historical performance + advanced technicals
        perf = {}
        technicals = {}
        recent_prices = []
        try:
            hist = tk.history(period="1y")
            if not hist.empty and len(hist) > 1:
                cur = hist["Close"].iloc[-1]
                def _perf(days):
                    if len(hist) > days:
                        old = hist["Close"].iloc[-days-1]
                        return round((cur - old) / old * 100, 2) if old else None
                    return None
                perf["1w"] = _perf(5)
                perf["1m"] = _perf(21)
                perf["3m"] = _perf(63)
                perf["6m"] = _perf(126)
                perf["1y"] = _perf(252) if len(hist) >= 252 else _perf(len(hist)-1)
                import datetime as _dt
                ytd_start = _dt.date(datetime.datetime.now().year, 1, 1)
                ytd_data = hist[hist.index.date >= ytd_start]
                if len(ytd_data) > 1:
                    perf["ytd"] = round((cur - ytd_data["Close"].iloc[0]) / ytd_data["Close"].iloc[0] * 100, 2)
                # SMA 50, 200
                if len(hist) >= 50:
                    perf["sma50"] = round(hist["Close"].iloc[-50:].mean(), 2)
                if len(hist) >= 200:
                    perf["sma200"] = round(hist["Close"].iloc[-200:].mean(), 2)
                # EMA 12, 26 (for MACD)
                closes = hist["Close"]
                if len(hist) >= 26:
                    ema12 = closes.ewm(span=12, adjust=False).mean()
                    ema26 = closes.ewm(span=26, adjust=False).mean()
                    macd_line = ema12 - ema26
                    signal_line = macd_line.ewm(span=9, adjust=False).mean()
                    technicals["ema12"] = round(float(ema12.iloc[-1]), 2)
                    technicals["ema26"] = round(float(ema26.iloc[-1]), 2)
                    technicals["macd"] = round(float(macd_line.iloc[-1]), 4)
                    technicals["macd_signal"] = round(float(signal_line.iloc[-1]), 4)
                    technicals["macd_histogram"] = round(float(macd_line.iloc[-1] - signal_line.iloc[-1]), 4)
                # Bollinger Bands (20-day, 2 std)
                if len(hist) >= 20:
                    sma20 = closes.rolling(20).mean()
                    std20 = closes.rolling(20).std()
                    technicals["bb_upper"] = round(float(sma20.iloc[-1] + 2 * std20.iloc[-1]), 2)
                    technicals["bb_middle"] = round(float(sma20.iloc[-1]), 2)
                    technicals["bb_lower"] = round(float(sma20.iloc[-1] - 2 * std20.iloc[-1]), 2)
                    # %B indicator: where price sits in the bands (0 = lower, 1 = upper)
                    bb_range = technicals["bb_upper"] - technicals["bb_lower"]
                    if bb_range > 0:
                        technicals["bb_pctb"] = round((float(cur) - technicals["bb_lower"]) / bb_range, 3)
                # RSI(14)
                if len(hist) >= 15:
                    delta = closes.diff()
                    gain = delta.clip(lower=0).rolling(14).mean()
                    loss = (-delta.clip(upper=0)).rolling(14).mean()
                    rs = gain / loss
                    rsi_series = 100 - (100 / (1 + rs))
                    rsi_val = rsi_series.iloc[-1]
                    if not (rsi_val != rsi_val):
                        perf["rsi"] = round(float(rsi_val), 1)
                # Stochastic RSI (14-period)
                if len(hist) >= 16 and perf.get("rsi") is not None:
                    try:
                        rsi_full = 100 - (100 / (1 + gain / loss))
                        rsi_min = rsi_full.rolling(14).min()
                        rsi_max = rsi_full.rolling(14).max()
                        rsi_range = rsi_max - rsi_min
                        stoch_rsi = ((rsi_full - rsi_min) / rsi_range).iloc[-1]
                        if not (stoch_rsi != stoch_rsi):
                            technicals["stoch_rsi"] = round(float(stoch_rsi) * 100, 1)
                    except Exception:
                        pass
                # ATR(14) — Average True Range (volatility)
                if len(hist) >= 15:
                    try:
                        h_c = hist["High"]
                        l_c = hist["Low"]
                        cl = closes.shift(1)
                        tr1 = h_c - l_c
                        tr2 = (h_c - cl).abs()
                        tr3 = (l_c - cl).abs()
                        tr = tr1.copy()
                        tr[tr2 > tr] = tr2[tr2 > tr]
                        tr[tr3 > tr] = tr3[tr3 > tr]
                        atr_val = tr.rolling(14).mean().iloc[-1]
                        if not (atr_val != atr_val):
                            technicals["atr14"] = round(float(atr_val), 2)
                            technicals["atr_pct"] = round(float(atr_val) / float(cur) * 100, 2)
                    except Exception:
                        pass
                # Volume trend: avg volume last 5 days vs 20-day avg
                if len(hist) >= 20:
                    vol5 = hist["Volume"].iloc[-5:].mean()
                    vol20 = hist["Volume"].iloc[-20:].mean()
                    if vol20 > 0:
                        technicals["vol_ratio_5d_20d"] = round(vol5 / vol20, 2)
                # Recent 5-day price history
                tail = hist.tail(5)
                for _, row in tail.iterrows():
                    recent_prices.append({
                        "date": str(row.name.date()),
                        "open": round(float(row["Open"]), 2),
                        "high": round(float(row["High"]), 2),
                        "low": round(float(row["Low"]), 2),
                        "close": round(float(row["Close"]), 2),
                        "volume": int(row["Volume"]),
                    })
                # Support/resistance from recent highs/lows
                if len(hist) >= 20:
                    r20_high = round(float(hist["High"].iloc[-20:].max()), 2)
                    r20_low = round(float(hist["Low"].iloc[-20:].min()), 2)
                    technicals["resistance_20d"] = r20_high
                    technicals["support_20d"] = r20_low
                if len(hist) >= 50:
                    technicals["resistance_50d"] = round(float(hist["High"].iloc[-50:].max()), 2)
                    technicals["support_50d"] = round(float(hist["Low"].iloc[-50:].min()), 2)
        except Exception:
            pass

        # Financial health indicators
        health = {}
        health["profitMargin"] = info.get("profitMargins")
        health["operatingMargin"] = info.get("operatingMargins")
        health["grossMargin"] = info.get("grossMargins")
        health["revenueGrowth"] = info.get("revenueGrowth")
        health["earningsGrowth"] = info.get("earningsGrowth")
        health["debtToEquity"] = info.get("debtToEquity")
        health["currentRatio"] = info.get("currentRatio")
        health["quickRatio"] = info.get("quickRatio")
        health["returnOnEquity"] = info.get("returnOnEquity")
        health["returnOnAssets"] = info.get("returnOnAssets")
        health["freeCashflow"] = info.get("freeCashflow")
        health["operatingCashflow"] = info.get("operatingCashflow")
        health["totalCash"] = info.get("totalCash")
        health["totalDebt"] = info.get("totalDebt")
        health["totalRevenue"] = info.get("totalRevenue")
        health["ebitda"] = info.get("ebitda")
        health["ebitdaMargins"] = info.get("ebitdaMargins")
        health["revenuePerShare"] = info.get("revenuePerShare")
        health["bookValue"] = info.get("bookValue")
        health["priceToBook"] = info.get("priceToBook")
        health["pegRatio"] = info.get("pegRatio")
        health["enterpriseValue"] = info.get("enterpriseValue")
        health["evToRevenue"] = info.get("enterpriseToRevenue")
        health["evToEbitda"] = info.get("enterpriseToEbitda")
        health["payoutRatio"] = info.get("payoutRatio")

        # Shares & ownership info
        shares = {}
        shares["outstanding"] = info.get("sharesOutstanding")
        shares["float"] = info.get("floatShares")
        shares["shortRatio"] = info.get("shortRatio")
        shares["shortPctFloat"] = info.get("shortPercentOfFloat")
        shares["insiderPct"] = info.get("heldPercentInsiders")
        shares["institutionPct"] = info.get("heldPercentInstitutions")
        shares["shortShares"] = info.get("sharesShort")

        # Compute a simple health score (0-100) — weighing more factors
        score_parts = []
        pm = health.get("profitMargin")
        if pm is not None:
            score_parts.append(min(max(pm * 200, 0), 100))
        rg = health.get("revenueGrowth")
        if rg is not None:
            score_parts.append(min(max((rg + 0.1) * 200, 0), 100))
        dte = health.get("debtToEquity")
        if dte is not None:
            score_parts.append(max(100 - dte * 0.5, 0))
        cr = health.get("currentRatio")
        if cr is not None:
            score_parts.append(min(cr * 40, 100))
        roe = health.get("returnOnEquity")
        if roe is not None:
            score_parts.append(min(max(roe * 300, 0), 100))
        pe_val = info.get("trailingPE")
        if pe_val and pe_val > 0:
            score_parts.append(max(100 - pe_val * 2, 0))
        rec = info.get("recommendationKey")
        rec_scores = {"strong_buy": 95, "buy": 80, "hold": 50, "sell": 20, "strong_sell": 5}
        if rec and rec in rec_scores:
            score_parts.append(rec_scores[rec])
        # Extra factors
        eg = health.get("earningsGrowth")
        if eg is not None:
            score_parts.append(min(max((eg + 0.1) * 200, 0), 100))
        gm = health.get("grossMargin")
        if gm is not None:
            score_parts.append(min(max(gm * 130, 0), 100))
        health["score"] = round(sum(score_parts) / len(score_parts)) if score_parts else None

        # Compute verdict
        _hs = health.get("score")
        rec = info.get("recommendationKey")
        _rec_verdict = {"strong_buy": "buy", "buy": "buy", "hold": "hold", "sell": "sell", "strong_sell": "sell"}
        if _hs is not None:
            if _hs >= 65:
                verdict = "buy"
            elif _hs >= 40:
                verdict = "hold"
            else:
                verdict = "sell"
            if rec in _rec_verdict:
                av = _rec_verdict[rec]
                if av != verdict:
                    verdict = "hold"
        elif rec in _rec_verdict:
            verdict = _rec_verdict[rec]
        else:
            verdict = "hold"

        # Risk level from beta
        beta_val = info.get("beta")
        risk = None
        if beta_val is not None:
            if beta_val < 0.8:
                risk = "low"
            elif beta_val < 1.2:
                risk = "moderate"
            elif beta_val < 1.8:
                risk = "high"
            else:
                risk = "very_high"

        # 52-week position (0-100%)
        h52 = info.get("fiftyTwoWeekHigh")
        l52 = info.get("fiftyTwoWeekLow")
        pos52 = None
        if h52 and l52 and h52 != l52 and price:
            pos52 = round((price - l52) / (h52 - l52) * 100, 1)

        # Earnings date
        earnings_date = None
        try:
            cal = tk.calendar
            if cal is not None:
                if isinstance(cal, dict):
                    ed_list = cal.get("Earnings Date", [])
                    if ed_list:
                        earnings_date = str(ed_list[0])[:10]
                elif hasattr(cal, 'iloc'):
                    earnings_date = str(cal.iloc[0, 0])[:10] if cal.shape[0] > 0 else None
        except Exception:
            pass

        # Recent earnings surprises
        earnings_history = []
        try:
            eh = tk.earnings_history
            if eh is not None and hasattr(eh, 'iterrows'):
                for _, row in eh.tail(4).iterrows():
                    rec_e = {}
                    for col in eh.columns:
                        val = row[col]
                        if hasattr(val, 'item'):
                            val = val.item()
                        if val != val:  # NaN
                            val = None
                        rec_e[col] = val
                    earnings_history.append(rec_e)
        except Exception:
            pass

        # Insider transactions (recent)
        insider_trades = []
        try:
            ins = tk.insider_transactions
            if ins is not None and hasattr(ins, 'iterrows') and not ins.empty:
                for _, row in ins.head(5).iterrows():
                    tr = {}
                    for col in ins.columns:
                        val = row[col]
                        if hasattr(val, 'isoformat'):
                            val = str(val)[:10]
                        elif hasattr(val, 'item'):
                            val = val.item()
                        if val != val:
                            val = None
                        tr[col] = val
                    insider_trades.append(tr)
        except Exception:
            pass

        return {
            "ticker": ticker,
            "name": info.get("shortName") or info.get("longName") or ticker,
            "price": round(price, 2),
            "change": round(change, 2),
            "changePct": round(change_pct, 2),
            "currency": info.get("currency", "USD"),
            "marketCap": info.get("marketCap"),
            "volume": info.get("volume") or info.get("regularMarketVolume"),
            "avgVolume": info.get("averageVolume"),
            "pe": info.get("trailingPE"),
            "forwardPe": info.get("forwardPE"),
            "eps": info.get("trailingEps"),
            "forwardEps": info.get("forwardEps"),
            "dividend": info.get("dividendYield"),
            "dividendRate": info.get("dividendRate"),
            "exDividendDate": str(info["exDividendDate"])[:10] if info.get("exDividendDate") else None,
            "high52": info.get("fiftyTwoWeekHigh"),
            "low52": info.get("fiftyTwoWeekLow"),
            "dayHigh": info.get("dayHigh"),
            "dayLow": info.get("dayLow"),
            "open": info.get("open") or info.get("regularMarketOpen"),
            "sector": info.get("sector"),
            "industry": info.get("industry"),
            "exchange": info.get("exchange"),
            "beta": info.get("beta"),
            "targetPrice": info.get("targetMeanPrice"),
            "targetLow": info.get("targetLowPrice"),
            "targetHigh": info.get("targetHighPrice"),
            "targetMedian": info.get("targetMedianPrice"),
            "numAnalysts": info.get("numberOfAnalystOpinions"),
            "recommendation": info.get("recommendationKey"),
            "perf": perf,
            "technicals": technicals,
            "health": health,
            "shares": shares,
            "risk": risk,
            "pos52": pos52,
            "earningsDate": earnings_date,
            "earningsHistory": earnings_history[:4] if earnings_history else [],
            "insiderTrades": insider_trades[:5] if insider_trades else [],
            "recentPrices": recent_prices,
            "verdict": verdict,
        }
    except Exception as e:
        return {"error": f"Failed to fetch stock data: {str(e)[:200]}"}


@app.route("/api/stock/<ticker>")
@require_auth_or_guest
def stock_data(ticker):
    """Fetch comprehensive stock data for a ticker using yfinance."""
    data = _fetch_stock_data_dict(ticker)
    if data.get("error"):
        return jsonify(data), 404 if "No data" in data.get("error", "") else 400
    return jsonify(data)


@app.route("/api/stock-agent", methods=["POST"])
@require_auth_or_guest
def stock_agent():
    """Multi-step stock analysis agent. Runs multiple AI prompts sequentially to deeply analyze stock data."""
    data = request.get_json() or {}
    chat_id = data.get("chat_id")
    stock_data_list = data.get("stock_data", [])
    user_query = data.get("query", "Analyze this stock")

    if not stock_data_list:
        return jsonify({"error": "No stock data provided"}), 400

    settings = load_settings()
    selected = normalize_selected_model(settings)
    resolved = resolve_chat_model({"model": selected}, settings)
    if resolved.get("error"):
        return jsonify({"error": resolved["error"]}), 403

    provider = resolved.get("provider")
    api_key = resolved.get("api_key")
    model = resolved.get("actual_model")
    base_url = resolved.get("base_url")

    # -- Validate stocks against user criteria (price range etc.) --
    criteria = _extract_price_criteria(user_query)
    passing, failing = _validate_stocks_against_criteria(stock_data_list, criteria)

    # Build criteria summary for the agent to reference
    criteria_note = ""
    if criteria:
        parts = []
        if criteria.get('max_price'):
            parts.append(f"MAX price: ${criteria['max_price']:.2f}")
        if criteria.get('min_price'):
            parts.append(f"MIN price: ${criteria['min_price']:.2f}")
        criteria_note = f"?? USER'S PRICE CRITERIA: {', '.join(parts)}\n"

    # Build screening report for stocks that fail criteria
    screening_report = ""
    if failing:
        fail_lines = []
        for d in failing:
            price = d.get('price') or d.get('currentPrice') or 0
            fail_lines.append(f"  ? {d.get('ticker','❌')} — ${price:.2f} (FAILS criteria)")
        screening_report = "STOCKS THAT FAIL USER'S CRITERIA:\n" + "\n".join(fail_lines) + "\n"
    if passing:
        pass_lines = []
        for d in passing:
            price = d.get('price') or d.get('currentPrice') or 0
            chart_score, chart_verdict = _assess_chart_health(d)
            pass_lines.append(f"  ? {d.get('ticker','✅')} — ${price:.2f} (passes criteria) | Chart: {chart_verdict} ({chart_score}/100)")
        screening_report += "STOCKS THAT PASS USER'S CRITERIA:\n" + "\n".join(pass_lines) + "\n"

    # Assess chart health for all stocks and add to dump
    chart_assessments = []
    for d in stock_data_list:
        if not d.get('error'):
            chart_score, chart_verdict = _assess_chart_health(d)
            d['_chart_score'] = chart_score
            d['_chart_verdict'] = chart_verdict
            chart_assessments.append(f"{d.get('ticker','?')}: chart_health={chart_score}/100 ({chart_verdict})")

    # If all stocks fail criteria, still analyze them but flag heavily
    # If only some fail, focus analysis on passing stocks but mention failures
    if criteria and failing and not passing:
        # ALL stocks fail — analyze them anyway but the screening step will flag this
        analysis_stocks = stock_data_list
    elif criteria and passing:
        # Some pass — analyze only passing stocks to not waste time on bad picks
        analysis_stocks = passing
    else:
        analysis_stocks = stock_data_list

    full_dump = _build_full_stock_dump(analysis_stocks)
    # Prepend chart health and screening info to the data dump
    if chart_assessments:
        full_dump = "📊 CHART HEALTH ASSESSMENT:\n" + "\n".join(chart_assessments) + "\n\n" + full_dump
    if screening_report:
        full_dump = screening_report + "\n" + full_dump
    if criteria_note:
        full_dump = criteria_note + full_dump

    steps = _stock_agent_steps(analysis_stocks, user_query)
    tickers = [d.get("ticker", "?") for d in analysis_stocks if not d.get("error")]

    def evt(payload):
        return json.dumps(payload) + "\n"

    def generate(cancel_event=None):
        import time as _time
        all_analysis = []

        yield evt({"type": "agent_start", "total_steps": len(steps), "tickers": tickers})

        for i, step in enumerate(steps):
            if cancel_event and cancel_event.is_set():
                yield evt({"type": "agent_error", "error": "Stock analysis cancelled by user."})
                return
            step_start = _time.time()
            yield evt({"type": "agent_step", "step": i + 1, "title": step["title"], "status": "running"})

            # Only include previous analysis for steps 2+ to save tokens on step 1
            if all_analysis:
                prev_text = "\n\n".join(all_analysis)
                prev_section = f"[YOUR ANALYSIS SO FAR]\n{prev_text}\n\nBuild on this — don't repeat what you've already said.\n\n"
            else:
                prev_section = ""

            messages = [{
                "role": "user",
                "text": (
                    f"[REAL-TIME STOCK DATA FROM YAHOO FINANCE]\n{full_dump}\n\n"
                    f"{prev_section}"
                    f"[YOUR TASK]\n{step['prompt']}"
                ),
            }]

            try:
                step_pieces = []
                use_web = step.get("web_search", False)
                stream_fn = STREAM_PROVIDERS.get(provider)
                if stream_fn:
                    for chunk in stream_fn(
                        api_key, model, step["system"], messages,
                        base_url=base_url, thinking=True, thinking_level="high", web_search=use_web,
                    ):
                        if isinstance(chunk, dict) and chunk.get("__thinking__"):
                            yield evt({"type": "agent_thinking", "step": i + 1, "text": chunk.get("text", "")})
                            continue
                        step_pieces.append(chunk)
                        yield evt({"type": "agent_delta", "step": i + 1, "text": chunk})
                else:
                    full = PROVIDERS.get(provider, call_openai)(
                        api_key, model, step["system"], messages,
                        base_url=base_url, thinking=True, thinking_level="high", web_search=use_web,
                    )
                    step_pieces.append(full)
                    yield evt({"type": "agent_delta", "step": i + 1, "text": full})

                step_result = "".join(step_pieces)
                all_analysis.append(f"## {step['title']}\n{step_result}")
                elapsed = round(_time.time() - step_start, 1)
                yield evt({"type": "agent_step", "step": i + 1, "title": step["title"], "status": "complete", "elapsed": elapsed})
            except Exception as e:
                elapsed = round(_time.time() - step_start, 1)
                all_analysis.append(f"## {step['title']}\n*Analysis failed for this step: {str(e)[:100]}*")
                yield evt({"type": "agent_step", "step": i + 1, "title": step["title"], "status": "failed", "error": str(e)[:200], "elapsed": elapsed})
                # Continue to next step instead of stopping

        full_analysis = "\n\n".join(all_analysis)
        full_analysis += "\n\n---\n*Not financial advice. AI analysis may be inaccurate. Always do your own research and consult a licensed financial advisor. You could lose money.*"
        yield evt({"type": "agent_done", "analysis": full_analysis, "tickers": tickers})

    # --- Poll-based architecture (mirrors research agent) ---
    _s_guest = session.get("guest")
    _s_uid = session.get("user_id")
    _s_gid = session.get("guest_id")

    def _bg_load_chat_sa(cid):
        if not _safe_id(cid): return None, "invalid_id"
        if _s_guest and not _s_uid:
            if _s_gid:
                return _load_json(_guest_dir(_s_gid) / "chats" / f"{cid}.json", None), None
            return None, "no_guest_id"
        if not _s_uid: return None, "no_user_id"
        if not FIREBASE_ENABLED:
            path = _local_user_dir(_s_uid) / "chats" / f"{cid}.json"
            data = _load_json(path, None)
            return (data, None) if data else (None, "file_missing")
        col = _chats_col()
        if not col: return None, "no_firestore"
        snap = col.document(cid).get()
        return (snap.to_dict(), None) if snap.exists else (None, "not_found")

    def _bg_save_chat_sa(c):
        c["updated"] = datetime.datetime.now().isoformat()
        if _s_guest and not _s_uid:
            if _s_gid:
                _save_json(_guest_dir(_s_gid) / "chats" / f"{c['id']}.json", c)
            return
        if not _s_uid: return
        if not FIREBASE_ENABLED:
            _save_json(_local_user_dir(_s_uid) / "chats" / f"{c['id']}.json", c)
            return
        col = _chats_col()
        if col: col.document(c["id"]).set(c)

    stock_agent_id = str(uuid.uuid4())
    cancel_event = threading.Event()
    _cleanup_stale_stock_agents()

    with _active_stock_agents_lock:
        _active_stock_agents[stock_agent_id] = {
            "events": [],
            "done": False,
            "started": time.time(),
            "cancel": cancel_event,
        }

    # Cross-device sync: store stock_agent_id on chat
    if chat_id:
        try:
            _sc, _ = load_chat(chat_id)
            if _sc:
                _sc["_active_stock_agent_id"] = stock_agent_id
                save_chat(_sc)
        except Exception:
            pass
        with _active_streams_lock:
            _sb = _active_streams.get(chat_id)
            if _sb is not None:
                _sb["stock_agent_id"] = stock_agent_id

    def _bg_runner():
        sa_ref = _active_stock_agents.get(stock_agent_id)
        if not sa_ref:
            return
        try:
            for event_str in generate(cancel_event=cancel_event):
                sa_ref["events"].append(event_str)
                if cancel_event.is_set():
                    sa_ref["events"].append(json.dumps({"type": "agent_error", "error": "Stock analysis cancelled."}) + "\n")
                    break
            # Save to chat history
            if chat_id:
                try:
                    chat, _ = _bg_load_chat_sa(chat_id)
                    if chat:
                        # Reconstruct full analysis from events
                        all_analysis_text = []
                        for ev_str in sa_ref["events"]:
                            try:
                                ev = json.loads(ev_str.strip())
                                if ev.get("type") == "agent_done":
                                    all_analysis_text = [ev.get("analysis", "")]
                                    break
                            except Exception:
                                pass
                        full_analysis = all_analysis_text[0] if all_analysis_text else ""
                        # Build step breakdown from events
                        step_breakdown = []
                        _step_content = {}
                        for ev_str in sa_ref["events"]:
                            try:
                                ev = json.loads(ev_str.strip())
                                if ev.get("type") == "agent_delta":
                                    sn = ev.get("step", 0)
                                    _step_content.setdefault(sn, []).append(ev.get("text", ""))
                                elif ev.get("type") == "agent_step" and ev.get("status") == "running":
                                    sn = ev.get("step", 0)
                                    _step_content.setdefault(sn, [])
                            except Exception:
                                pass
                        # Build from agent_step events for titles
                        for ev_str in sa_ref["events"]:
                            try:
                                ev = json.loads(ev_str.strip())
                                if ev.get("type") == "agent_step" and ev.get("status") in ("complete", "failed"):
                                    sn = ev.get("step", 0)
                                    body = "".join(_step_content.get(sn, []))
                                    step_breakdown.append({"title": ev.get("title", f"Step {sn}"), "body": body})
                            except Exception:
                                pass
                        slim_stock = []
                        for sd in stock_data_list:
                            slim_stock.append({k: sd.get(k) for k in (
                                "ticker","currentPrice","revenueGrowth","earningsGrowth",
                                "forwardEps","trailingEps","targetMeanPrice","error"
                            ) if sd.get(k) is not None})
                        chat["messages"].append({
                            "role": "model",
                            "text": full_analysis,
                            "timestamp": datetime.datetime.now().isoformat(),
                            "stock_agent": True,
                            "stock_agent_steps": step_breakdown,
                            "stock_agent_tickers": tickers,
                            "stock_agent_data": slim_stock,
                        })
                        chat.pop("_active_stock_agent_id", None)
                        _bg_save_chat_sa(chat)
                        print(f"  [stock-agent] Saved analysis to chat {chat_id}")
                except Exception as save_err:
                    print(f"  [stock-agent] Failed to save analysis: {save_err}")
        except Exception as e:
            print(f"  [stock-agent] FATAL error: {e}")
            import traceback; traceback.print_exc()
            try:
                sa_ref["events"].append(json.dumps({"type": "agent_error", "error": str(e)[:300]}) + "\n")
            except Exception:
                pass
            # Clear active flag on error
            if chat_id:
                try:
                    chat, _ = _bg_load_chat_sa(chat_id)
                    if chat:
                        chat.pop("_active_stock_agent_id", None)
                        _bg_save_chat_sa(chat)
                except Exception:
                    pass
        finally:
            sa_ref["done"] = True
            print(f"  [stock-agent] Session {stock_agent_id} finished ({len(sa_ref['events'])} events)")

    t = threading.Thread(target=_bg_runner, daemon=True)
    t.start()

    return jsonify({"stock_agent_id": stock_agent_id})


@app.route("/api/stock-agent/poll")
@require_auth_or_guest
def stock_agent_poll():
    """Return accumulated events for a running stock analysis session."""
    stock_agent_id = request.args.get("id", "")
    cursor = int(request.args.get("cursor", 0))

    with _active_stock_agents_lock:
        sa_session = _active_stock_agents.get(stock_agent_id)

    if not sa_session:
        return jsonify({"events": [], "cursor": cursor, "done": True, "error": "not_found"}), 404

    events = sa_session["events"][cursor:]
    new_cursor = cursor + len(events)
    is_done = sa_session["done"] and new_cursor >= len(sa_session["events"])

    resp_data = {"events": events, "cursor": new_cursor, "done": is_done}

    if is_done:
        def _deferred_cleanup():
            time.sleep(30)
            with _active_stock_agents_lock:
                _active_stock_agents.pop(stock_agent_id, None)
        threading.Thread(target=_deferred_cleanup, daemon=True).start()

    return jsonify(resp_data)


@app.route("/api/stock-agent/cancel", methods=["POST"])
@require_auth_or_guest
def stock_agent_cancel():
    """Cancel a running stock analysis session."""
    data = request.get_json() or {}
    stock_agent_id = data.get("stock_agent_id", "")

    with _active_stock_agents_lock:
        sa_session = _active_stock_agents.get(stock_agent_id)

    if not sa_session:
        return jsonify({"error": "not_found"}), 404

    sa_session["cancel"].set()
    return jsonify({"ok": True})


@app.route("/api/detect-tools", methods=["POST"])
@require_auth_or_guest
def detect_tools():
    """Tool detection endpoint — now tools are user-activated only."""
    return jsonify({"tool": None})


@app.route("/api/chats/<chat_id>/stream", methods=["POST"])
@require_auth_or_guest
def chat_message_stream(chat_id):
    if session.get("guest") and not session.get("user_id"):
        if _guest_tokens_used() >= GUEST_TOKEN_LIMIT:
            return jsonify({"reply": "You've reached your daily token limit for guest access. Sign in with Google for unlimited access!", "files": [], "guest_limit": True})
    chat, reason = load_chat(chat_id)
    if not chat:
        return jsonify({"error": f"Chat not found ({reason})"}), 404

    payload = request.get_json() or {}
    ctx, err_resp, status = prepare_chat_turn(chat, payload)
    if err_resp:
        return err_resp, status

    thinking = ctx.get("thinking", False)
    thinking_level = ctx.get("thinking_level", "off")
    web_search = ctx.get("web_search", False)
    print(f"  [stream] thinking={thinking}, thinking_level={thinking_level}, web_search={web_search}, provider={ctx['resolved'].get('provider')}, model={ctx['resolved'].get('actual_model')}")
    ctx["sysprompt"] += build_stream_thinking_instructions(
        provider=ctx["resolved"].get("provider"),
        thinking=thinking,
        thinking_level=thinking_level,
    )

    resolved = ctx["resolved"]

    # Pre-save the user message so it persists even if the user refreshes mid-stream
    if ctx["user_msg"] not in chat.get("messages", []):
        chat.setdefault("messages", []).append(ctx["user_msg"])
        # Set a title if this is the first message
        if len(chat["messages"]) == 1:
            chat["title"] = fallback_chat_title(ctx.get("user_text", ""), "")
        chat["_streaming"] = True  # Mark that we're mid-stream
        save_chat(chat)

    # Cross-device sync: create stream buffer for this chat
    _stream_chat_id = chat_id
    _cleanup_stale_streams()
    with _active_streams_lock:
        _active_streams[_stream_chat_id] = {
            "events": [], "done": False, "started": time.time(),
            "research_id": None, "stock_agent_id": None,
        }

    def event(payload):
        line = json.dumps(payload) + "\n"
        with _active_streams_lock:
            s = _active_streams.get(_stream_chat_id)
            if s is not None:
                s["events"].append(line)
        return line

    @stream_with_context
    def generate():
        pieces = []
        thinking_pieces = []
        _in_openai_think = False
        # -- Mid-stream media detection: detect image/stock/gen tags AS tokens arrive,
        #    start async fetches immediately, and yield result events interleaved with
        #    text deltas so the frontend can render media inline while streaming. --
        from concurrent.futures import ThreadPoolExecutor
        emit_buffer = ""
        _media_executor = ThreadPoolExecutor(max_workers=4)
        _media_fetches = []   # [(kind, entry, future), ...]
        _fetched_images = []
        _fetched_stocks = []
        _fetched_gens = []
        _media_idx = {"img": 0, "gen": 0, "stock": 0}
        _MEDIA_TAG_RE = re.compile(r'<<<(IMAGE_SEARCH|IMG_SEARCH|IMAGE_GENERATE|STOCK):\s*(.*?)>>>')

        def _start_media_fetch(tag_type, tag_value):
            """Parse a detected media tag and start async fetch. Returns event dict or None."""
            if tag_type in ("IMAGE_SEARCH", "IMG_SEARCH"):
                parts = [p.strip() for p in tag_value.split('|', 1)]
                query = parts[0]
                count = 8
                if len(parts) > 1:
                    for param in parts[1].split(','):
                        p = param.strip()
                        if p.lower().startswith('count='):
                            try: count = max(1, min(int(p.split('=', 1)[1].strip()), 20))
                            except: pass
                idx = _media_idx["img"]
                _media_idx["img"] += 1
                entry = {"query": query, "index": idx, "count": count}
                future = _media_executor.submit(search_images, query, num=count)
                _media_fetches.append(("image_search", entry, future))
                return {"type": "media_loading", "kind": "image_search", "index": idx, "query": query}
            elif tag_type == "IMAGE_GENERATE":
                prompt = tag_value
                aspect = "1:1"
                if '|' in tag_value:
                    parts = [p.strip() for p in tag_value.split('|', 1)]
                    prompt = parts[0]
                    for param in parts[1].split(','):
                        p = param.strip()
                        if p.lower().startswith(('aspect_ratio=', 'ratio=')):
                            val = p.split('=', 1)[1].strip()
                            if val in ("1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9"):
                                aspect = val
                idx = _media_idx["gen"]
                _media_idx["gen"] += 1
                entry = {"prompt": prompt, "index": idx, "aspect_ratio": aspect}
                _api_key = resolved.get("api_key", "")
                _ref_imgs = ctx.get("user_msg", {}).get("images") or None
                future = _media_executor.submit(generate_image_gemini, prompt, aspect, api_key=_api_key, reference_images=_ref_imgs)
                _media_fetches.append(("image_gen", entry, future))
                return {"type": "media_loading", "kind": "image_gen", "index": idx, "prompt": prompt}
            elif tag_type == "STOCK":
                ticker = re.sub(r'[^A-Za-z0-9.\-^=]', '', tag_value).upper()
                if ticker:
                    idx = _media_idx["stock"]
                    _media_idx["stock"] += 1
                    entry = {"ticker": ticker, "index": idx}
                    future = _media_executor.submit(_fetch_stock_data_dict, ticker)
                    _media_fetches.append(("stock", entry, future))
                    return {"type": "media_loading", "kind": "stock", "index": idx, "ticker": ticker}
            return None

        def _drain_completed():
            """Check for completed async fetches. Returns list of event dicts."""
            events = []
            still_pending = []
            for kind, entry, future in _media_fetches:
                if future.done():
                    try:
                        result = future.result()
                        if kind == "image_search":
                            if result:
                                ir = {"query": entry['query'], "images": result, "index": entry['index'], "count": entry['count']}
                                _fetched_images.append(ir)
                                events.append({"type": "image_result", "image": ir})
                            else:
                                events.append({"type": "image_failed", "query": entry['query'], "index": entry['index']})
                        elif kind == "stock":
                            if result and not result.get("error"):
                                sr = {"ticker": entry['ticker'], "index": entry['index'], "data": result}
                                _fetched_stocks.append(sr)
                                events.append({"type": "stock_data", "stock": sr})
                            else:
                                events.append({"type": "stock_failed", "ticker": entry['ticker'], "index": entry['index'], "error": (result or {}).get("error", "Unknown error")})
                        elif kind == "image_gen":
                            img_b64, gen_result = result
                            if img_b64:
                                data_uri = f"data:{gen_result};base64,{img_b64}"
                                gr = {"prompt": entry['prompt'], "index": entry['index'], "url": data_uri, "mime": gen_result}
                                _fetched_gens.append(gr)
                                events.append({"type": "image_generated", "image": gr})
                            else:
                                events.append({"type": "image_gen_failed", "prompt": entry['prompt'], "index": entry['index'], "error": gen_result})
                    except Exception as _drain_exc:
                        # Report failure for completed-but-crashed fetches
                        if kind == "stock":
                            events.append({"type": "stock_failed", "ticker": entry.get('ticker', '?'), "index": entry.get('index', 0), "error": str(_drain_exc)[:100]})
                        elif kind == "image_search":
                            events.append({"type": "image_failed", "query": entry.get('query', '?'), "index": entry.get('index', 0)})
                        elif kind == "image_gen":
                            events.append({"type": "image_gen_failed", "prompt": entry.get('prompt', '?'), "index": entry.get('index', 0), "error": str(_drain_exc)[:100]})
                else:
                    still_pending.append((kind, entry, future))
            _media_fetches[:] = still_pending
            return events

        try:
            stream_fn = STREAM_PROVIDERS.get(resolved["provider"])
            if stream_fn:
                # Use a queue + thread so we can emit heartbeat events during
                # long gaps (e.g. between thinking and content) to prevent
                # Render's proxy from killing the connection.
                import queue, threading
                _SENTINEL = object()
                _HEARTBEAT_INTERVAL = 3           # seconds — aggressive keepalive to defeat proxy timeouts
                _MAX_STALL_HEARTBEATS = 200       # give up after 200 heartbeats (~10min) with no data from model
                _AUTOSAVE_INTERVAL = 15           # seconds — periodic auto-save of partial content
                _last_autosave = time.time()
                _stall_count = 0
                _got_any_content = False           # track if we ever got a real chunk
                _chunk_q = queue.Queue()

                def _stream_worker():
                    try:
                        for chunk in stream_fn(
                            resolved["api_key"],
                            resolved["actual_model"],
                            ctx["sysprompt"],
                            ctx["api_msgs"],
                            base_url=resolved["base_url"],
                            thinking=thinking,
                            thinking_level=thinking_level,
                            web_search=web_search,
                        ):
                            _chunk_q.put(chunk)
                    except Exception as exc:
                        _chunk_q.put(exc)
                    finally:
                        _chunk_q.put(_SENTINEL)

                _worker = threading.Thread(target=_stream_worker, daemon=True)
                _worker.start()

                # Send immediate heartbeat so the connection is established
                # before the API starts processing (defeats proxy buffering)
                yield event({"type": "heartbeat", "ts": int(time.time())})

                while True:
                    try:
                        chunk = _chunk_q.get(timeout=_HEARTBEAT_INTERVAL)
                    except queue.Empty:
                        _stall_count += 1
                        if _stall_count >= _MAX_STALL_HEARTBEATS:
                            print(f"  [stream] Stall detected — {_stall_count} heartbeats (~{_stall_count*_HEARTBEAT_INTERVAL}s) with no data. Ending stream.")
                            # Save any partial content before giving up
                            _stall_partial = "".join(pieces).strip() if pieces else ""
                            if _stall_partial:
                                chat.pop("_streaming", None)
                                chat.pop("_partial_text", None)
                                chat.pop("_partial_thinking", None)
                                chat["messages"].append({
                                    "role": "model",
                                    "text": _stall_partial + "\n\n*[Response interrupted — model stalled]*",
                                    "raw_text": _stall_partial,
                                    "timestamp": datetime.datetime.now().isoformat(),
                                    "interrupted": True,
                                })
                                try: save_chat(chat)
                                except: pass
                            if not _got_any_content:
                                yield event({"type": "error", "error": "The model took too long to respond. Try sending your message again."})
                            break
                        # No data — send padded heartbeat to keep connection alive
                        # Padding defeats proxy buffering (some proxies wait for N bytes)
                        yield event({"type": "heartbeat", "ts": int(time.time()), "_pad": "k" * 256})
                        # Periodic auto-save during heartbeats
                        if time.time() - _last_autosave >= _AUTOSAVE_INTERVAL and (pieces or thinking_pieces):
                            _last_autosave = time.time()
                            try:
                                _partial = "".join(pieces)
                                if _partial.strip():
                                    chat["_partial_text"] = _partial
                                    chat["_partial_thinking"] = "".join(thinking_pieces) if thinking_pieces else ""
                                    save_chat(chat)
                            except Exception:
                                pass
                        continue
                    _stall_count = 0  # reset on any real data
                    _got_any_content = True
                    if chunk is _SENTINEL:
                        break
                    if isinstance(chunk, Exception):
                        raise chunk
                    if isinstance(chunk, dict) and chunk.get("__thinking__"):
                        thinking_pieces.append(chunk["text"])
                        if chunk["text"]:
                            yield event({"type": "thinking_delta", "text": chunk["text"]})
                        continue
                    pieces.append(chunk)
                    emit_buffer += chunk
                    # Periodic auto-save after receiving content
                    if time.time() - _last_autosave >= _AUTOSAVE_INTERVAL and pieces:
                        _last_autosave = time.time()
                        try:
                            _partial = "".join(pieces)
                            if _partial.strip():
                                chat["_partial_text"] = _partial
                                chat["_partial_thinking"] = "".join(thinking_pieces) if thinking_pieces else ""
                                save_chat(chat)
                        except Exception:
                            pass
                    # -- Extract <<<THINKING>>> blocks for OpenAI-style inline thinking --
                    _THINK_OPEN = "<<<THINKING>>>"
                    _THINK_CLOSE = "<<<END_THINKING>>>"
                    while _THINK_OPEN in emit_buffer or (_in_openai_think and _THINK_CLOSE in emit_buffer):
                        if not _in_openai_think:
                            idx = emit_buffer.find(_THINK_OPEN)
                            if idx < 0:
                                break
                            before = emit_buffer[:idx]
                            if before:
                                yield event({"type": "delta", "text": before})
                            emit_buffer = emit_buffer[idx + len(_THINK_OPEN):]
                            _in_openai_think = True
                        if _in_openai_think:
                            close_idx = emit_buffer.find(_THINK_CLOSE)
                            if close_idx >= 0:
                                thought_chunk = emit_buffer[:close_idx]
                                if thought_chunk:
                                    thinking_pieces.append(thought_chunk)
                                    yield event({"type": "thinking_delta", "text": thought_chunk})
                                emit_buffer = emit_buffer[close_idx + len(_THINK_CLOSE):]
                                _in_openai_think = False
                            else:
                                # Still inside thinking block — emit what we have so far as thinking
                                if emit_buffer:
                                    thinking_pieces.append(emit_buffer)
                                    yield event({"type": "thinking_delta", "text": emit_buffer})
                                emit_buffer = ""
                                break
                    if _in_openai_think:
                        # Buffer is mid-thinking, everything is a thinking delta
                        if emit_buffer:
                            thinking_pieces.append(emit_buffer)
                            yield event({"type": "thinking_delta", "text": emit_buffer})
                        emit_buffer = ""
                        # Drain any completed async media fetches
                        for evt in _drain_completed():
                            yield event(evt)
                        continue
                    # Extract complete media tags from the buffer
                    while True:
                        m = _MEDIA_TAG_RE.search(emit_buffer)
                        if not m:
                            break
                        before = emit_buffer[:m.start()]
                        if before:
                            yield event({"type": "delta", "text": before})
                        tag_evt = _start_media_fetch(m.group(1), m.group(2).strip())
                        if tag_evt:
                            yield event(tag_evt)
                        emit_buffer = emit_buffer[m.end():]
                    # Emit text that is safe (not part of an incomplete <<<...>>> tag)
                    open_pos = emit_buffer.rfind('<<<')
                    if open_pos >= 0 and '>>>' not in emit_buffer[open_pos:]:
                        safe = emit_buffer[:open_pos]
                        if safe:
                            yield event({"type": "delta", "text": safe})
                        emit_buffer = emit_buffer[open_pos:]
                    else:
                        if emit_buffer:
                            yield event({"type": "delta", "text": emit_buffer})
                        emit_buffer = ""
                    # Drain any completed async media fetches
                    for evt in _drain_completed():
                        yield event(evt)
            else:
                full = PROVIDERS.get(resolved["provider"], call_openai)(
                    resolved["api_key"],
                    resolved["actual_model"],
                    ctx["sysprompt"],
                    ctx["api_msgs"],
                    base_url=resolved["base_url"],
                    thinking=thinking,
                    thinking_level=thinking_level,
                    web_search=web_search,
                )
                pieces.append(full)
                emit_buffer = full
                while True:
                    m = _MEDIA_TAG_RE.search(emit_buffer)
                    if not m:
                        break
                    before = emit_buffer[:m.start()]
                    if before:
                        yield event({"type": "delta", "text": before})
                    tag_evt = _start_media_fetch(m.group(1), m.group(2).strip())
                    if tag_evt:
                        yield event(tag_evt)
                    emit_buffer = emit_buffer[m.end():]
                if emit_buffer:
                    yield event({"type": "delta", "text": emit_buffer})
                emit_buffer = ""

            # Flush any remaining buffer
            if emit_buffer:
                yield event({"type": "delta", "text": emit_buffer})

            # Wait for all remaining pending media fetches
            for kind, entry, future in _media_fetches:
                try:
                    result = future.result(timeout=30)
                    if kind == "image_search":
                        if result:
                            ir = {"query": entry['query'], "images": result, "index": entry['index'], "count": entry['count']}
                            _fetched_images.append(ir)
                            yield event({"type": "image_result", "image": ir})
                        else:
                            yield event({"type": "image_failed", "query": entry['query'], "index": entry['index']})
                    elif kind == "stock":
                        if result and not result.get("error"):
                            sr = {"ticker": entry['ticker'], "index": entry['index'], "data": result}
                            _fetched_stocks.append(sr)
                            yield event({"type": "stock_data", "stock": sr})
                        else:
                            yield event({"type": "stock_failed", "ticker": entry['ticker'], "index": entry['index'], "error": (result or {}).get("error", "Unknown error")})
                    elif kind == "image_gen":
                        img_b64, gen_result = result
                        if img_b64:
                            data_uri = f"data:{gen_result};base64,{img_b64}"
                            gr = {"prompt": entry['prompt'], "index": entry['index'], "url": data_uri, "mime": gen_result}
                            _fetched_gens.append(gr)
                            yield event({"type": "image_generated", "image": gr})
                        else:
                            yield event({"type": "image_gen_failed", "prompt": entry['prompt'], "index": entry['index'], "error": gen_result})
                except Exception as _fetch_exc:
                    # Emit failure events for timed-out or crashed fetches
                    if kind == "stock":
                        yield event({"type": "stock_failed", "ticker": entry.get('ticker', '?'), "index": entry.get('index', 0), "error": f"Fetch timed out or failed: {str(_fetch_exc)[:100]}"})
                    elif kind == "image_search":
                        yield event({"type": "image_failed", "query": entry.get('query', '?'), "index": entry.get('index', 0)})
                    elif kind == "image_gen":
                        yield event({"type": "image_gen_failed", "prompt": entry.get('prompt', '?'), "index": entry.get('index', 0), "error": f"Generation failed: {str(_fetch_exc)[:100]}"})
            _media_fetches.clear()
            _media_executor.shutdown(wait=False)

            # -- Post-stream processing --
            raw_text = "".join(pieces)
            # Extract triggers from response text BEFORE prepending thinking,
            # because thinking may reference trigger syntax like <<<DEEP_RESEARCH: ...>>>
            # and the regex would incorrectly match the thinking discussion instead of the real trigger.
            raw_text, research_query = extract_research_trigger(raw_text)
            raw_text, image_searches = extract_image_searches(raw_text)
            raw_text, image_generations = extract_image_generation(raw_text)
            raw_text, stock_tickers = extract_stock_tickers(raw_text)
            raw_text, hf_space_calls = extract_hf_space_calls(raw_text)
            raw_text, stream_reminders = extract_reminders(raw_text)
            all_thinking = thinking_pieces
            if all_thinking:
                think_text = "".join(all_thinking).strip()
                if think_text:
                    raw_text = f"<<<THINKING>>>\n{think_text}\n<<<END_THINKING>>>\n{raw_text}"
            original_raw_text = raw_text
            # Clear research_pending flag once research triggers
            if research_query and chat.get("research_pending"):
                del chat["research_pending"]
            _hf_results_stream = []
            if hf_space_calls:
                hf_token = _hf_token()
                yield event({"type": "hf_executing", "count": len(hf_space_calls)})
                for call in hf_space_calls:
                    yield event({"type": "hf_loading", "space": call['space'], "index": call['index'], "input": call['input']})
                    if hf_token:
                        try:
                            result = run_hf_space(call['space'], call['input'], call.get('params'), hf_token)
                            hr = {"space": call['space'], "index": call['index'], "result": result}
                            _hf_results_stream.append(hr)
                            if result and result.get("success"):
                                yield event({"type": "hf_space_result", "hf": hr})
                            else:
                                yield event({"type": "hf_space_failed", "space": call['space'], "index": call['index'], "error": (result or {}).get("error", "Unknown error")})
                        except Exception as e:
                            yield event({"type": "hf_space_failed", "space": call['space'], "index": call['index'], "error": str(e)[:200]})
                    else:
                        yield event({"type": "hf_space_failed", "space": call['space'], "index": call['index'], "error": "HuggingFace connector not configured. Go to Settings ? Connectors to add your token."})

            has_pending_ops = bool(image_searches or image_generations or stock_tickers or hf_space_calls)
            clean, executed, new_facts, code_results, clean_wp = finalize_chat_response(chat, ctx, raw_text, original_raw=original_raw_text)
            # If research tool was active but AI didn't trigger it (asked questions), set pending flag
            if 'research' in ctx.get('active_tools', []) and not research_query:
                chat["research_pending"] = True
                save_chat(chat)
            done_payload = {
                "type": "done",
                "reply": clean_wp if (image_searches or image_generations or stock_tickers or hf_space_calls) else clean,
                "files": executed,
                "memory_added": new_facts,
                "title": chat.get("title", "New Chat"),
            }
            if code_results:
                done_payload["code_results"] = code_results
                summary_parts = []
                all_success = True
                for i, cr in enumerate(code_results):
                    if cr["success"]:
                        file_names = [f["name"] for f in cr.get("files", [])]
                        files_str = f" Files created/modified: {', '.join(file_names)}." if file_names else ""
                        summary_parts.append(f"Code block {i+1} ({cr['language']}): SUCCESS. Output: {cr['output']}{files_str}")
                    else:
                        all_success = False
                        summary_parts.append(f"Code block {i+1} ({cr['language']}): FAILED. Error: {cr['output']}")
                done_payload["code_auto_reprompt"] = True
                done_payload["code_all_success"] = all_success
                done_payload["code_execution_summary"] = "\n".join(summary_parts)
            if research_query:
                done_payload["research_trigger"] = research_query
            if image_searches:
                done_payload["pending_images"] = [{"query": s["query"], "index": s["index"], "count": s["count"]} for s in image_searches]
            if image_generations:
                done_payload["pending_generations"] = [{"prompt": g["prompt"], "index": g["index"], "aspect_ratio": g["aspect_ratio"]} for g in image_generations]
            if stock_tickers:
                done_payload["pending_stocks"] = [{"ticker": s["ticker"], "index": s["index"]} for s in stock_tickers]
            if stream_reminders:
                done_payload["reminders_set"] = stream_reminders
            # Tell frontend which results were already delivered mid-stream
            if _fetched_images:
                done_payload["preloaded_image_indices"] = [r["index"] for r in _fetched_images]
            if _fetched_stocks:
                done_payload["preloaded_stock_indices"] = [r["index"] for r in _fetched_stocks]
            if _fetched_gens:
                done_payload["preloaded_gen_indices"] = [r["index"] for r in _fetched_gens]
            if _hf_results_stream:
                done_payload["hf_results"] = _hf_results_stream
            yield event(done_payload)

            # Persist mid-stream results in chat history
            if _fetched_images:
                chat["messages"][-1]["image_results"] = _fetched_images
            if _fetched_stocks:
                chat["messages"][-1]["stock_results"] = _fetched_stocks
            if _fetched_gens:
                chat["messages"][-1]["generated_images"] = _fetched_gens
            if _hf_results_stream:
                chat["messages"][-1]["hf_results"] = _hf_results_stream
            if _fetched_images or _fetched_stocks or _fetched_gens or _hf_results_stream:
                save_chat(chat)

            # Clean up %%%IMGGEN:N%%% placeholders for failed image generations
            if image_generations and len(_fetched_gens) < len(image_generations):
                _ok_indices = {g["index"] for g in _fetched_gens}
                _failed = [g for g in image_generations if g["index"] not in _ok_indices]
                if _failed and chat["messages"]:
                    _msg = chat["messages"][-1]
                    _txt = _msg.get("text", "")
                    for g in _failed:
                        _txt = re.sub(rf'%%%IMGGEN:{g["index"]}%%%\s*', '', _txt)
                    _msg["text"] = _txt.strip()
                    save_chat(chat)

            # gen_ops_complete signal
            if image_searches or image_generations or stock_tickers:
                total_ops = len(image_searches) + len(image_generations) + len(stock_tickers)
                total_success = len(_fetched_images) + len(_fetched_gens) + len(_fetched_stocks)
                _gen_complete = {"type": "gen_ops_complete", "success": total_success > 0, "total": total_ops, "succeeded": total_success, "failed": total_ops - total_success}
                if stock_tickers and _fetched_stocks:
                    _gen_complete["stock_reprompt"] = _build_stock_reprompt_summary(_fetched_stocks)
                    _gen_complete["fetched_stocks"] = _fetched_stocks
                    _gen_complete["user_query"] = ctx.get("user_text", "")
                yield event(_gen_complete)

            # Mark stream buffer as done for cross-device sync
            with _active_streams_lock:
                _s = _active_streams.get(_stream_chat_id)
                if _s is not None:
                    _s["done"] = True
            def _cleanup_stream_buf():
                time.sleep(300)
                with _active_streams_lock:
                    _active_streams.pop(_stream_chat_id, None)
            threading.Thread(target=_cleanup_stream_buf, daemon=True).start()

        except Exception as e:
            try: _media_executor.shutdown(wait=False)
            except: pass
            # Clean up the _streaming flag so the chat isn't stuck
            chat.pop("_streaming", None)
            chat.pop("_partial_text", None)
            chat.pop("_partial_thinking", None)
            # Save whatever partial content we got so the user doesn't lose it
            _err_partial = "".join(pieces).strip() if pieces else ""
            if _err_partial:
                chat["messages"].append({
                    "role": "model",
                    "text": _err_partial + "\n\n*[Response interrupted due to error]*",
                    "raw_text": _err_partial,
                    "timestamp": datetime.datetime.now().isoformat(),
                    "interrupted": True,
                })
            save_chat(chat)
            err = str(e)
            if any(w in err.lower() for w in ("429", "quota", "rate")):
                yield event({"type": "error", "error": f"Rate limit hit \u2014 wait a moment and try again. ({err[:200]})"})
            else:
                yield event({"type": "error", "error": f"API error: {err}"})
            # Mark stream buffer as done on error too
            with _active_streams_lock:
                _s = _active_streams.get(_stream_chat_id)
                if _s is not None:
                    _s["done"] = True

    resp = Response(generate(), mimetype="application/x-ndjson")
    # Anti-proxy-buffering headers — critical for school/corporate WiFi
    resp.headers["X-Accel-Buffering"] = "no"           # Nginx
    resp.headers["Cache-Control"] = "no-cache, no-transform"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Connection"] = "keep-alive"
    resp.headers["Transfer-Encoding"] = "chunked"
    return resp

@app.route("/api/canvas/apply", methods=["POST"])
@require_auth
def canvas_apply():
    d = request.get_json() or {}
    content = (d.get("content") or "")
    instruction = (d.get("instruction") or "").strip()
    language = (d.get("language") or "text").strip()
    if not content.strip():
        return jsonify({"error": "Canvas is empty."}), 400
    if not instruction:
        return jsonify({"error": "Add an instruction for the canvas."}), 400

    settings = load_settings()
    selected_model = normalize_selected_model(settings)
    allowed, reason, _ = model_access(selected_model, settings)
    if not allowed:
        return jsonify({"error": reason}), 400

    resolved = resolve_chat_model({"model": selected_model}, settings)
    if resolved.get("error"):
        return jsonify({"error": resolved["error"]}), 400

    canvas_prompt = (
        "You are editing a document inside a side-by-side AI canvas. "
        "Return only the updated document content. Do not wrap it in markdown fences. "
        "Preserve useful structure, improve clarity, and follow the user's request exactly.\n\n"
        f"Document language: {language}\n"
        f"Instruction: {instruction}\n\n"
        "[CURRENT DOCUMENT]\n"
        f"{content}"
    )
    try:
        updated = PROVIDERS.get(resolved["provider"], call_openai)(
            resolved["api_key"],
            resolved["actual_model"],
            build_system_prompt(load_memory()),
            [{"role": "user", "text": canvas_prompt}],
            base_url=resolved["base_url"],
        )
        return jsonify({"content": (updated or "").strip()})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/canvas/apply-stream", methods=["POST"])
@require_auth
def canvas_apply_stream():
    d = request.get_json() or {}
    content = (d.get("content") or "")
    instruction = (d.get("instruction") or "").strip()
    language = (d.get("language") or "text").strip()
    if not content.strip():
        return jsonify({"error": "Canvas is empty."}), 400
    if not instruction:
        return jsonify({"error": "Add an instruction for the canvas."}), 400

    settings = load_settings()
    selected_model = normalize_selected_model(settings)
    allowed, reason, _ = model_access(selected_model, settings)
    if not allowed:
        return jsonify({"error": reason}), 400

    resolved = resolve_chat_model({"model": selected_model}, settings)
    if resolved.get("error"):
        return jsonify({"error": resolved["error"]}), 400

    canvas_prompt = (
        "You are editing a document inside a side-by-side AI canvas. "
        "Return only the updated document content. Do not wrap it in markdown fences. "
        "Preserve useful structure, improve clarity, and follow the user's request exactly.\n\n"
        f"Document language: {language}\n"
        f"Instruction: {instruction}\n\n"
        "[CURRENT DOCUMENT]\n"
        f"{content}"
    )

    def _stream():
        try:
            g_key = resolve_provider_key(settings, "google")
            genai = _import_google()
            client = genai.Client(api_key=g_key)
            resp = client.models.generate_content_stream(
                model=resolved["actual_model"],
                contents=[{"role": "user", "parts": [{"text": canvas_prompt}]}],
                config={"system_instruction": "You edit documents. Return only the updated content, no fences."},
            )
            full = ""
            for chunk in resp:
                token = chunk.text or ""
                if token:
                    full += token
                    yield json.dumps({"token": token}) + "\n"
            yield json.dumps({"done": True, "content": full.strip()}) + "\n"
        except Exception as e:
            # Fallback to non-streaming
            try:
                updated = PROVIDERS.get(resolved["provider"], call_openai)(
                    resolved["api_key"],
                    resolved["actual_model"],
                    build_system_prompt(load_memory()),
                    [{"role": "user", "text": canvas_prompt}],
                    base_url=resolved["base_url"],
                )
                yield json.dumps({"done": True, "content": (updated or "").strip()}) + "\n"
            except Exception as e2:
                yield json.dumps({"error": str(e2)}) + "\n"

    return Response(stream_with_context(_stream()), mimetype="application/x-ndjson")


@app.route("/api/canvas/run", methods=["POST"])
@require_auth
def canvas_run():
    d = request.get_json() or {}
    code = (d.get("code") or "").strip()
    language = (d.get("language") or "").strip().lower()
    if not code:
        return jsonify({"error": "No code to run."}), 400
    if language != "python":
        return jsonify({"error": f"Run not supported for '{language}'."}), 400

    import subprocess, tempfile, os
    try:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as tmp:
            tmp.write(code)
            tmp_path = tmp.name
        result = subprocess.run(
            [sys.executable, tmp_path],
            capture_output=True, text=True, timeout=15,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        os.unlink(tmp_path)
        output = result.stdout
        if result.stderr:
            output += ("\n" if output else "") + result.stderr
        return jsonify({"output": output.strip()})
    except subprocess.TimeoutExpired:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass
        return jsonify({"output": "Execution timed out (15s limit)."})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# --- Routes: Image, Upload, Memory, Files ------------------------------------

@app.route("/api/generate-image", methods=["POST"])
@require_auth
def gen_image():
    prompt = (request.get_json() or {}).get("prompt", "").strip()
    if not prompt: return jsonify({"error": "No prompt"}), 400
    settings = load_settings()
    api_key = settings.get("keys", {}).get("google", "") or _load_server_key("google")
    if not api_key: return jsonify({"error": "Google API key required."}), 400
    try:
        img_b64, result_or_err = generate_image_gemini(prompt, api_key=api_key)
        if img_b64:
            return jsonify({"image": img_b64, "mime": result_or_err})
        return jsonify({"error": result_or_err or "No image generated"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/folders/enhance-instructions", methods=["POST"])
@require_auth_or_guest
def enhance_folder_instructions():
    d = request.get_json() or {}
    instructions = (d.get("instructions") or "").strip()
    if not instructions:
        return jsonify({"error": "No instructions provided."}), 400
    settings = load_settings() if session.get("user_id") else {"keys": {}}
    api_key = settings.get("keys", {}).get("google", "") or _load_server_key("google")
    if not api_key:
        return jsonify({"error": "No API key available."}), 400
    try:
        genai, types = _import_google()
        client = genai.Client(api_key=api_key)
        prompt = (
            "You are helping a user write better custom instructions for an AI chat folder. "
            "The user wrote a brief description of what the folder is for. "
            "Expand it into clear, detailed, well-structured instructions that an AI assistant should follow "
            "for all conversations in this folder. Keep it practical and specific. "
            "Return ONLY the enhanced instructions text, nothing else.\n\n"
            f"User's description:\n{instructions}"
        )
        r = client.models.generate_content(
            model="gemini-3.1-flash-lite-preview",
            contents=prompt,
        )
        enhanced = r.text.strip() if r.text else ""
        if not enhanced:
            return jsonify({"error": "No enhancement generated."}), 500
        return jsonify({"enhanced": enhanced})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/upload", methods=["POST"])
@require_auth_or_guest
def upload_file():
    uid = session.get("user_id") or session.get("guest_id", "guest")
    if not uid: return jsonify({"error": "Not authenticated"}), 401
    if "file" not in request.files: return jsonify({"error": "No file"}), 400
    f = request.files["file"]
    if not f.filename: return jsonify({"error": "No filename"}), 400
    safe = re.sub(r'[^\w\s\-.]', '_', f.filename)
    fid = str(uuid.uuid4())[:8]
    file_bytes = f.read()
    mime = f.content_type or mimetypes.guess_type(safe)[0] or "application/octet-stream"
    # Upload to Firebase Storage (non-guest only; guests keep data in-memory)
    if session.get("user_id"):
        bucket = _storage_bucket()
        if bucket:
            blob = bucket.blob(f"uploads/{uid}/{fid}_{safe}")
            blob.upload_from_string(file_bytes, content_type=mime)
    TEXT_EXTS = (".md",".txt",".json",".yaml",".yml",".py",".js",".ts",".html",".css",
                 ".csv",".xml",".log",".ini",".cfg",".sh",".bat",".ps1",".sql",".java",
                 ".c",".cpp",".h",".go",".rs",".rb",".php",".swift",".kt")
    text = None
    if mime.startswith("text/") or safe.lower().endswith(TEXT_EXTS):
        try: text = file_bytes.decode("utf-8", errors="replace")
        except: pass
    img_data = None
    doc_data = None
    if mime.startswith("image/"):
        # Convert unsupported image formats (SVG, BMP, TIFF, WebP, ICO, etc.) to PNG
        # so the AI can reliably process them
        NATIVE_IMAGE_MIMES = ("image/png", "image/jpeg", "image/gif", "image/webp")
        converted = False
        if mime not in NATIVE_IMAGE_MIMES:
            try:
                from PIL import Image
                if mime == "image/svg+xml":
                    # SVG ? PNG via cairosvg if available, else Pillow can't handle SVG
                    try:
                        import cairosvg  # type: ignore[import-unresolved]  # optional dependency
                        png_bytes = cairosvg.svg2png(bytestring=file_bytes, output_width=1024)
                        file_bytes = png_bytes
                        mime = "image/png"
                        safe = re.sub(r'\.[^.]+$', '.png', safe)
                        converted = True
                    except (ImportError, OSError):
                        # cairosvg not available — send SVG as text so AI can still read it
                        try:
                            text = file_bytes.decode("utf-8", errors="replace")
                        except Exception:
                            pass
                        converted = True  # skip base64 image encoding for SVG text
                else:
                    # BMP, TIFF, ICO, etc. ? PNG via Pillow
                    img = Image.open(io.BytesIO(file_bytes))
                    if img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info):
                        img = img.convert('RGBA')
                    else:
                        img = img.convert('RGB')
                    buf = io.BytesIO()
                    img.save(buf, format='PNG')
                    file_bytes = buf.getvalue()
                    mime = "image/png"
                    safe = re.sub(r'\.[^.]+$', '.png', safe)
                    converted = True
            except Exception as conv_err:
                print(f"  [!] Image conversion failed for {safe}: {conv_err}")
        if not (converted and text):
            img_data = base64.b64encode(file_bytes).decode()
    elif not text:
        # Non-text, non-image files (PDFs, Word docs, etc.) — store raw bytes
        DOC_MIMES = ("application/pdf", "application/msword",
                     "application/vnd.openxmlformats-officedocument",
                     "application/rtf", "application/epub", "text/rtf")
        if any(mime.startswith(dm) for dm in DOC_MIMES) or safe.lower().endswith(('.pdf','.doc','.docx','.rtf','.epub')):
            doc_data = base64.b64encode(file_bytes).decode()
    return jsonify({"id": fid, "name": f.filename, "mime": mime,
                    "size": len(file_bytes), "text": text, "image_data": img_data,
                    "doc_data": doc_data})

@app.route("/api/memory")
@require_auth
def get_memory():
    return jsonify(load_memory())

@app.route("/api/memory", methods=["POST"])
@require_auth
def add_memory():
    fact = (request.get_json() or {}).get("fact", "").strip()
    if not fact: return jsonify({"error": "Empty"}), 400
    m = load_memory()
    if fact not in m["facts"]: m["facts"].append(fact); save_memory(m)
    return jsonify({"ok": True})

@app.route("/api/memory/<int:idx>", methods=["DELETE"])
@require_auth
def del_memory(idx):
    m = load_memory()
    if 0 <= idx < len(m["facts"]): m["facts"].pop(idx); save_memory(m)
    return jsonify({"ok": True})

@app.route("/api/files")
@require_auth
def list_files_route():
    files = read_workspace_files()
    return jsonify({"files": [{"path": p, "size": len(c), "preview": c[:200],
        "folder": str(Path(p).parent) if str(Path(p).parent) != "." else ""}
        for p, c in sorted(files.items())]})

@app.route("/api/user-files")
@require_auth_or_guest
def list_user_files():
    """Return only user-facing files (notes, projects, etc.) in a tree structure."""
    tree = []
    for root, dirs, fnames in os.walk(WORKSPACE):
        dirs[:] = [d for d in sorted(dirs) if d not in SERVER_DIRS]
        rel_root = Path(root).relative_to(WORKSPACE)
        for fn in sorted(fnames):
            if fn.startswith(".") or fn in SERVER_FILES:
                continue
            fp = Path(root) / fn
            rp = str(rel_root / fn) if str(rel_root) != "." else fn
            try:
                size = fp.stat().st_size
            except Exception:
                size = 0
            tree.append({"path": rp, "name": fn, "size": size,
                         "folder": str(rel_root) if str(rel_root) != "." else ""})
    return jsonify({"files": tree})

@app.route("/api/user-files/folder", methods=["POST"])
@require_auth
def create_user_folder():
    """Create a custom folder in the workspace."""
    d = request.get_json() or {}
    name = (d.get("path") or "").strip()
    if not name or ".." in name or name.startswith("/"):
        return jsonify({"error": "Invalid folder name"}), 400
    clean = Path(name).as_posix()
    fp = WORKSPACE / clean
    fp.mkdir(parents=True, exist_ok=True)
    return jsonify({"ok": True, "path": clean})

@app.route("/api/user-files/delete", methods=["POST"])
@require_auth
def delete_user_file():
    d = request.get_json() or {}
    path = (d.get("path") or "").strip()
    if not path or ".." in path or path.startswith("/"):
        return jsonify({"error": "Invalid path"}), 400
    clean = Path(path).as_posix()
    fp = WORKSPACE / clean
    if not fp.exists():
        return jsonify({"error": "Not found"}), 404
    if fp.name in SERVER_FILES or any(part in SERVER_DIRS for part in Path(clean).parts):
        return jsonify({"error": "Access denied"}), 403
    if fp.is_dir():
        import shutil
        shutil.rmtree(fp)
    else:
        fp.unlink()
    return jsonify({"ok": True})

@app.route("/api/files/content")
@require_auth_or_guest
def get_file_content_route():
    path = (request.args.get("path") or "").strip()
    if not path:
        return jsonify({"error": "Path required"}), 400
    files = read_workspace_files()
    if path not in files:
        return jsonify({"error": "File not found"}), 404
    return jsonify({"path": path, "content": files[path]})

@app.route("/api/files/download")
@require_auth_or_guest
def download_workspace_file():
    """Download any user-facing workspace file."""
    path = (request.args.get("path") or "").strip()
    if not path or ".." in path or path.startswith("/"):
        return jsonify({"error": "Invalid path"}), 400
    clean = Path(path).as_posix()
    fp = WORKSPACE / clean
    if not fp.exists() or not fp.is_file():
        return jsonify({"error": "File not found"}), 404
    # Don't allow downloading server files or files in protected directories
    if fp.name in SERVER_FILES:
        return jsonify({"error": "Access denied"}), 403
    if any(part in SERVER_DIRS for part in Path(clean).parts):
        return jsonify({"error": "Access denied"}), 403
    return send_from_directory(str(fp.parent), fp.name, as_attachment=True)


@app.route("/api/files/view")
@require_auth_or_guest
def view_workspace_file():
    """Serve a workspace file inline (for images, etc). Same security as download."""
    path = (request.args.get("path") or "").strip()
    if not path or ".." in path or path.startswith("/"):
        return jsonify({"error": "Invalid path"}), 400
    clean = Path(path).as_posix()
    fp = WORKSPACE / clean
    if not fp.exists() or not fp.is_file():
        return jsonify({"error": "File not found"}), 404
    if fp.name in SERVER_FILES:
        return jsonify({"error": "Access denied"}), 403
    if any(part in SERVER_DIRS for part in Path(clean).parts):
        return jsonify({"error": "Access denied"}), 403
    return send_from_directory(str(fp.parent), fp.name, as_attachment=False)

@app.route("/api/folders")
@require_auth
def get_folders():
    folders = set()
    for c in list_chats():
        if c.get("folder"): folders.add(c["folder"])
    for p in read_workspace_files():
        parent = str(Path(p).parent)
        if parent != ".": folders.add(parent)
    return jsonify({"folders": sorted(folders)})

# --- Version & Changelog ------------------------------------------------------
gyro_VERSION = "3.4"
gyro_CHANGELOG = [
    {
        "version": "3.4",
        "date": "2026-03-22",
        "title": "Code Execution & Dev Mode",
        "changes": [
            "Code execution now reliably runs, detects generated files, and shows output inline",
            "Generated files (images, PDFs) auto-display with preview and download links in chat",
            "Developer mode is now live-toggleable — switch back and forth without creating a new chat",
            "DEV indicator in topbar when developer mode is active",
            "AI has better 'common sense' for code execution — just does it instead of explaining",
        ]
    },
    {
        "version": "3.3",
        "date": "2026-03-21",
        "title": "Image Search",
        "changes": [
            "Gyro can now search and show real images from Google in a carousel",
            "Ask to see what anything looks like and get visual results inline",
        ]
    },
    {
        "version": "3.2",
        "date": "2026-03-21",
        "title": "Intelligence & Management Upgrade",
        "changes": [
            "Intelligent Cross-Referencing: Gyro now draws connections across all your files automatically",
            "Workflow Pattern Learning: detects your work sequences and suggests next steps",
            "New cross-references & workflow pattern widgets on home screen",
            "Delete folders and all their chats at once",
            "Multi-select mode: select and bulk-delete chats and folders",
            "Delete All Chats button in settings",
            "Account deletion now properly removes everything",
        ]
    },
    {
        "version": "3.1",
        "date": "2026-03-21",
        "title": "Quality-of-Life Improvements",
        "changes": [
            "Fixed duplicate chat reload when clicking an already-open chat",
            "Sessions now stay alive during inactivity — no more random logouts",
            "Added update notification system so you never miss new features",
        ]
    },
    {
        "version": "3.0",
        "date": "2026-03-01",
        "title": "Initial Release",
        "changes": [
            "Gyro launched with multi-model AI chat",
            "Deep research mode",
            "Canvas & workspace tools",
        ]
    },
]

@app.route("/api/status")
def status_route():
    return jsonify({"version": gyro_VERSION, "name": "gyro"})

@app.route("/api/changelog")
def changelog_route():
    """Return current version + full changelog for the update modal."""
    return jsonify({"version": gyro_VERSION, "changelog": gyro_CHANGELOG})

@app.route("/api/greeting")
@require_auth_or_guest
def get_greeting():
    user = _cur_user()
    raw_name = user.get("name", "") if user else ""
    # Don't use "Guest" as a real name for guest accounts
    if raw_name == "Guest" or (user and user.get("provider") == "guest"):
        uname = ""
    else:
        uname = raw_name.split()[0] if raw_name else ""
    h = None
    # Prefer client-provided local hour so greetings are correct across server regions.
    try:
        hour_raw = (request.args.get("hour") or "").strip()
        if hour_raw:
            parsed = int(hour_raw)
            if 0 <= parsed <= 23:
                h = parsed
    except Exception:
        h = None
    if h is None:
        h = datetime.datetime.now().hour
    if h < 6: period = "late night"
    elif h < 12: period = "morning"
    elif h < 17: period = "afternoon"
    elif h < 22: period = "evening"
    else: period = "late night"
    name_part = f", {uname}" if uname else ""
    presets = {
        "late night": [
            f"Burning the midnight oil{name_part}?",
            f"Late-night focus{name_part}?",
            f"Quiet hours, clear mind{name_part}.",
            f"The world sleeps{name_part}. You build.",
            f"Night owl mode activated{name_part}.",
            f"Still going strong{name_part}? 🌙",
            f"Deep into the night{name_part}.",
            f"Midnight clarity{name_part}.",
            f"The best ideas come late{name_part}.",
            f"No distractions now{name_part}.",
        ],
        "morning": [
            f"Early start today{name_part}?",
            f"Morning focus, steady pace{name_part}.",
            f"Fresh morning energy{name_part}.",
            f"New day, new momentum{name_part}.",
            f"Rise and build{name_part}. ??",
            f"Sharp and ready{name_part}. Let's build.",
            f"Let's make today count{name_part}.",
            f"Good morning{name_part}. What's the plan?",
            f"The day is yours{name_part}.",
            f"Coffee and ideas{name_part}? ?",
            f"Starting fresh{name_part}.",
            f"Clear mind, full day ahead{name_part}.",
        ],
        "afternoon": [
            f"Afternoon rhythm holding up{name_part}?",
            f"Midday focus check{name_part}.",
            f"Keeping momentum this afternoon{name_part}?",
            f"Halfway through the day{name_part}.",
            f"Afternoon push{name_part}. Let's go.",
            f"Post-lunch productivity{name_part}? 🚀",
            f"Still crushing it{name_part}.",
            f"The afternoon stretch{name_part}.",
            f"Second wind kicking in{name_part}?",
            f"Keep the energy up{name_part}.",
        ],
        "evening": [
            f"Evening stretch ahead{name_part}.",
            f"Winding down or diving in{name_part}?",
            f"Golden hour thoughts{name_part}.",
            f"Evening mode{name_part}. Time to reflect or create.",
            f"Wrapping up the day{name_part}?",
            f"One more thing before tonight{name_part}?",
            f"Good evening{name_part}. What's on your mind?",
            f"The quiet part of the day{name_part}. 🌅",
            f"End-of-day clarity{name_part}.",
            f"Evening glow, fresh perspective{name_part}.",
        ],
    }
    return jsonify({"greeting": random.choice(presets.get(period, [f"Ready when you are{name_part}."]))})  


@app.route("/api/home-widgets", methods=["POST"])
@require_auth_or_guest
def home_widgets_route():
    body = request.get_json() or {}
    todos = body.get("todos", []) if isinstance(body.get("todos", []), list) else []
    visions = body.get("visions", []) if isinstance(body.get("visions", []), list) else []
    reminders = body.get("reminders", []) if isinstance(body.get("reminders", []), list) else []

    user = _cur_user() or {}
    profile = load_profile() if session.get("user_id") else {
        "preferred_name": "",
        "what_you_do": "",
        "hobbies": "",
        "current_focus": "",
        "origin_story": "",
    }
    chats = list_chats() if session.get("user_id") else []

    plan = _fallback_home_widgets(user.get("name", ""), profile, chats, todos, visions, reminders=reminders)
    return jsonify(plan)

# --- Research Agent (multi-step with web search + URL context) ----------------

# ── Cross-device sync: buffer streaming events so another device can join ──
_active_streams = {}   # chat_id -> {"events": [], "done": bool, "started": float, "research_id": str|None, "stock_agent_id": str|None}
_active_streams_lock = threading.Lock()

def _cleanup_stale_streams():
    """Remove stream sessions older than 10 minutes."""
    cutoff = time.time() - 600
    with _active_streams_lock:
        stale = [cid for cid, s in _active_streams.items() if s["started"] < cutoff]
        for cid in stale:
            del _active_streams[cid]
            print(f"  [stream-sync] Cleaned up stale stream buffer {cid}")

# Poll-based architecture: research runs in background thread, frontend polls for events.
# This avoids Render free-tier's 30-second request timeout killing streaming connections.
_active_research = {}  # research_id -> { "events": [], "done": bool, "started": float, "cancel": threading.Event }
_active_research_lock = threading.Lock()

# Poll-based stock agent (mirrors research pattern)
_active_stock_agents = {}  # stock_agent_id -> { "events": [], "done": bool, "started": float, "cancel": threading.Event }
_active_stock_agents_lock = threading.Lock()

def _cleanup_stale_stock_agents():
    """Remove stock agent sessions older than 30 minutes."""
    cutoff = time.time() - 1800
    with _active_stock_agents_lock:
        stale = [sid for sid, s in _active_stock_agents.items() if s["started"] < cutoff]
        for sid in stale:
            del _active_stock_agents[sid]
            print(f"  [stock-agent] Cleaned up stale session {sid}")

def _cleanup_stale_research():
    """Remove research sessions older than 30 minutes."""
    cutoff = time.time() - 1800
    with _active_research_lock:
        stale = [rid for rid, s in _active_research.items() if s["started"] < cutoff]
        for rid in stale:
            del _active_research[rid]
            print(f"  [research] Cleaned up stale session {rid}")

def _research_agent_steps(query):
    """Return the multi-step prompts for the research agent. 9 steps with web search and URL context."""

    base_system = (
        "You are an elite intelligence analyst at a Tier-1 research firm. "
        "Your reports are used by executives, policymakers, and domain experts to make critical decisions. "
        "You have access to Google Search and deep URL reading — USE THEM AGGRESSIVELY. "
        "Search the web multiple times with different queries. Read full pages for primary evidence.\n\n"
        "ABSOLUTE RULES:\n"
        "1. ALWAYS search the web — never rely on training data alone. Search multiple angles.\n"
        "2. Cite EVERY major claim with [Source Title](URL). No uncited assertions.\n"
        "3. Use exact numbers, dates, names, direct quotes from sources. Vague claims = failure.\n"
        "4. Clearly distinguish: confirmed fact vs. expert opinion vs. analysis vs. speculation\n"
        "5. Rich markdown: **bold** key findings, bullet lists for data points\n"
        "6. NO disclaimers, NO 'I'm an AI', NO hedging. Be authoritative and decisive.\n"
        "7. When sources conflict: present both sides, explain which is more credible and why\n"
        "8. At the end of your response, include a SOURCE LIST in this exact format:\n"
        "   <<<SOURCES>>>\n"
        "   - [Source Title](URL) — one-line description\n"
        "   - [Source Title](URL) — one-line description\n"
        "   <<<END_SOURCES>>>\n"
        "   This helps track all references across steps.\n\n"
        "TABLE FORMAT:\n"
        "Use standard markdown tables when tabular data helps clarity.\n"
        "Example:\n"
        "| Metric | Value | Source | Trend |\n"
        "|---|---:|---|---|\n"
        "| GDP Growth | 3.2% | [BLS](https://bls.gov) | 📈 |\n"
        "| Unemployment | 4.1% | [Fed](https://fed.gov) | 📉 |\n"
    )

    return [
        {
            "title": "Intelligence Gathering",
            "icon": "🔍",
            "system": (
                "You are a research intelligence operative at an elite intelligence agency. "
                "Your job is to conduct the first wave of information gathering — cast the WIDEST possible net. "
                "Search for the topic from EVERY angle: breaking news, academic papers, industry reports, "
                "government documents, social media discourse, expert blogs, think tank publications, "
                "and international perspectives. Leave no stone unturned. "
                "You MUST search the web at least 6 times with different queries. "
                "Search in DIFFERENT CATEGORIES: factual queries, opinion queries, statistical queries, "
                "historical queries, and counter-argument queries. Use quotation marks for exact phrases."
            ),
            "web_search": True,
            "url_context": False,
            "prompt": (
                f"RESEARCH MISSION: {query}\n\n"
                "Execute the initial intelligence sweep. TARGET: 15+ diverse sources.\n\n"
                "**1. Multi-Angle Search** (search the web AT LEAST 6 TIMES with DIFFERENT query types):\n"
                "Run these specific types of searches:\n"
                f"- FACTUAL: \"{query}\" — core topic\n"
                f"- STATISTICAL: \"{query} statistics data numbers 2024 2025\"\n"
                f"- EXPERT: \"{query} expert analysis opinion\"\n"
                f"- CRITICAL: \"{query} criticism problems controversy\"\n"
                f"- RECENT: \"{query} latest news developments\"\n"
                f"- ACADEMIC: \"{query} research study report\"\n"
                "Also search for specific sub-topics, related terminology, and key people/organizations involved.\n\n"
                "**2. Source Mapping** (REQUIRED — create this exact table):\n"
                "| # | Source | Type | Date | Credibility | Key Contribution |\n"
                "|---|---|---|---|---|---|\n"
                "| 1 | [Title](URL) | News/Academic/Gov/Industry | YYYY-MM | High/Med/Low | What this source uniquely adds |\n\n"
                "Aim for 15+ sources across at least 4 different source types.\n\n"
                "**3. Initial Findings** (bullet list of 8-12 key facts discovered):\n"
                "For each finding, include the specific source: \"[fact statement] — [Source](URL)\"\n\n"
                "**4. Research Gaps & Priority Targets:**\n"
                "- List 3-5 specific unanswered questions\n"
                "- Name 3-5 specific URLs that need deep reading in the next step\n"
                "- Identify what specific data/statistics/quotes are still needed"
            ),
        },
        {
            "title": "Deep Source Analysis",
            "icon": "📖",
            "system": base_system + (
                "\n\nYour role: PRIMARY SOURCE ANALYST. "
                "You have URL context ability — you can READ FULL WEB PAGES. Use this power. "
                "Read the most important sources found in the previous step in their entirety. "
                "Extract detailed data, statistics, quotes, methodologies, and evidence. "
                "Don't just skim — read deeply and extract everything valuable. "
                "For each source you read, write a detailed extraction brief with exact data."
            ),
            "web_search": True,
            "url_context": True,
            "prompt": (
                f"RESEARCH MISSION: {query}\n\n"
                "Deep-read the 5 most important sources from Step 1. Also search for 3-5 new sources.\n\n"
                "**1. Primary Source Deep Dive** (read 5 key pages in full):\n"
                "For EACH source, write a detailed extraction brief:\n"
                "---\n"
                "**Source: [Title](URL)**\n"
                "- **Publisher/Author**: Who created this and their credibility\n"
                "- **Date**: When published/updated\n"
                "- **Key Data Points**: List every specific number, statistic, percentage, dollar amount\n"
                "- **Direct Quotes** (copy exact words): \"quote\" — attribution\n"
                "- **Methodology**: How did they get their data? Sample size? Timeframe?\n"
                "- **Key Arguments**: What does this source argue/conclude?\n"
                "- **Potential Bias**: Any agenda, funding source, or perspective bias?\n"
                "- **Unique Contribution**: What does this source add that others don't?\n"
                "---\n\n"
                "**2. Gap-Filling Search** (search 3-5 more times for missing info):\n"
                "Specifically search for:\n"
                "- Statistics that were referenced but not fully detailed in initial sources\n"
                "- The opposing viewpoint to the dominant narrative you found\n"
                "- The most recent data available (last 3 months)\n"
                "- Primary/original sources that secondary sources cited\n\n"
                "**3. Evidence Inventory Table:**\n"
                "| Evidence | Type | Source | Confidence | Verified By |\n"
                "|---|---|---|---|---|\n"
                "| [specific fact/stat] | Stat/Quote/Claim | [Source](URL) | 🟢/🟡/🔴 | [cross-ref] |"
            ),
        },
        {
            "title": "Fact Verification",
            "icon": "✅",
            "system": base_system + (
                "\n\nYour role: FACT CHECKER AND SKEPTIC. "
                "Cross-reference every major claim against multiple independent sources. "
                "Look for contradictions, outdated information, and unsupported assertions. "
                "Verify statistics by finding their ORIGINAL source (not a secondary citation). "
                "Rate confidence in each finding. Be brutally honest about what's confirmed vs. uncertain. "
                "If a claim cannot be independently verified, flag it explicitly."
            ),
            "web_search": True,
            "url_context": True,
            "prompt": (
                f"RESEARCH MISSION: {query}\n\n"
                "Verify and cross-reference ALL major findings from Steps 1-2.\n\n"
                "**1. Claim Verification Matrix** (REQUIRED — check every major claim):\n"
                "| # | Claim | Original Source | Confirming Sources | Contradicting Sources | Verdict |\n"
                "|---|---|---|---|---|---|\n"
                "| 1 | [Specific claim] | [Source](URL) | [Src2](URL), [Src3](URL) | None OR [Src](URL) | 🟢 Confirmed / 🟡 Partially / 🔴 Disputed |\n\n"
                "Check at least 8-10 key claims.\n\n"
                "**2. Contradiction Deep-Dive:**\n"
                "For EACH contradiction found:\n"
                "- What exactly do the sources disagree about?\n"
                "- Search for the original/primary data source\n"
                "- Read both sources in full to understand context\n"
                "- Which source is more credible and why? (methodology, recency, authority)\n"
                "- Final verdict with justification\n\n"
                "**3. Recency Audit:**\n"
                "- Search for the absolute latest developments (last 30 days if possible)\n"
                "- Flag any findings based on data older than 12 months\n"
                "- Note if the landscape has changed since sources were published\n\n"
                "**4. Overall Confidence Assessment:**\n"
                "| Area | Confidence | Basis | What Would Change This |\n"
                "|---|---|---|---|\n"
                "| [topic area] | 🟢/🟡/🔴 | [why] | [what evidence would change rating] |"
            ),
        },
        {
            "title": "Perspectives & Context",
            "icon": "👥",
            "system": base_system + (
                "\n\nYour role: EXPERT OPINION ANALYST AND CONTEXTUALIZER. "
                "Find what the leading experts, institutions, and stakeholders say about this topic. "
                "Search for interviews, papers, and commentary from domain authorities. "
                "Map out the different perspectives and schools of thought. "
                "Search for expert names specifically — find their published positions and direct quotes. "
                "Provide historical context: how did we get here, and what trajectory are we on?"
            ),
            "web_search": True,
            "url_context": True,
            "prompt": (
                f"RESEARCH MISSION: {query}\n\n"
                "Map the expert and stakeholder landscape comprehensively.\n\n"
                "**1. Expert Voices** (search for experts BY NAME):\n"
                "Identify and document the top 5-7 authorities:\n"
                "| Expert | Title/Affiliation | Position | Key Quote | Source |\n"
                "|---|---|---|---|---|\n"
                "| [Name] | [Role at Org] | Pro/Against/Nuanced | \"exact quote\" | [Source](URL) |\n\n"
                "Search for each expert by name + the topic to find their latest statements.\n\n"
                "**2. Stakeholder Analysis:**\n"
                "| Stakeholder | Interest | Position | Power/Influence | Likely Action |\n"
                "|---|---|---|---|---|\n"
                "| [Organization/Group] | [What they want] | [Support/Oppose/Neutral] | High/Med/Low | [What they'll do] |\n\n"
                "**3. Competing Narratives:**\n"
                "Map out 2-4 distinct perspectives/schools of thought:\n"
                "For each:\n"
                "- **Perspective name/label**: One-line summary\n"
                "- **Key proponents**: Who champions this view?\n"
                "- **Core arguments**: What evidence do they cite?\n"
                "- **Weaknesses**: Where does this perspective fall short?\n"
                "- **Resonance**: Who finds this perspective persuasive and why?\n\n"
                "**4. Historical Timeline:**\n"
                "Build a chronological context (key events, milestones, turning points):\n"
                "| Date | Event | Significance | Source |\n"
                "|---|---|---|---|\n\n"
                "**5. Trajectory Analysis:**\n"
                "- Where was this topic 5 years ago vs. now?\n"
                "- What direction is momentum heading?\n"
                "- What are the key inflection points coming up?"
            ),
        },
        {
            "title": "Evidence & Data Analysis",
            "icon": "📊",
            "system": base_system + (
                "\n\nYour role: SENIOR DATA ANALYST. "
                "Compile ALL quantitative data found across all previous steps into structured tables. "
                "Search for additional statistics, benchmarks, and metrics that haven't been found yet. "
                "Look specifically for: government databases, industry reports with numbers, "
                "academic papers with methodology, and official statistics. "
                "Present data clearly using markdown tables. Identify trends, patterns, and outliers."
            ),
            "web_search": True,
            "url_context": True,
            "prompt": (
                f"RESEARCH MISSION: {query}\n\n"
                "Compile, analyze, and present ALL data. Search for additional statistics.\n\n"
                "**1. Master Data Table** (compile ALL numbers from every step):\n"
                "| # | Metric/Indicator | Value | Date | Source | Trend | Notes |\n"
                "|---|---|---:|---|---|---|---|\n"
                "| 1 | [metric name] | [exact number] | [date] | [Source](URL) | ↑/↓/→ | [context] |\n\n"
                "Include EVERY statistic, percentage, dollar amount, count, etc. found.\n\n"
                "**2. Missing Data Search** (search 3-4 more times for gaps):\n"
                f"Search specifically for: \"{query} statistics report data\" and variations.\n"
                "Look for government data, industry reports, and academic datasets.\n\n"
                "**3. Comparative Analysis Tables:**\n"
                "Create comparison tables for the most meaningful dimensions:\n"
                "- By time period (5y ago vs. 3y ago vs. now vs. projected)\n"
                "- By region/market/entity (if applicable)\n"
                "- By approach/method/option (if comparing alternatives)\n\n"
                "**4. Pattern & Trend Analysis:**\n"
                "- What are the 3-5 most significant trends in the data?\n"
                "- Any surprising outliers or anomalies? What might explain them?\n"
                "- What correlations are visible between different metrics?\n"
                "- What does the data trajectory suggest about the future?\n\n"
                "**5. Data Quality & Gaps:**\n"
                "| Data Area | Coverage | Quality | Key Gap |\n"
                "|---|---|---|---|\n"
                "| [area] | Complete/Partial/Missing | High/Med/Low | [what's missing] |"
            ),
        },
        {
            "title": "Synthesis & Insights",
            "icon": "🧠",
            "system": (
                "You are a master strategist and synthesizer at a Tier-1 intelligence firm. "
                "Your job is to transform all previous research into crystal-clear, actionable intelligence. "
                "Identify the key themes, connect dots between different findings, and surface non-obvious insights. "
                "Think like a senior advisor briefing a decision-maker. "
                "Be BOLD — state what the evidence means, don't just summarize it. "
                "Identify what others would miss. Challenge conventional wisdom where the evidence supports it. "
                "Your output should contain ZERO new searches — only synthesis of what's been found."
            ),
            "web_search": False,
            "url_context": False,
            "prompt": (
                f"RESEARCH MISSION: {query}\n\n"
                "Synthesize ALL research from Steps 1-5 into actionable intelligence.\n\n"
                "**1. Core Findings** (exactly 6-8 of the MOST important discoveries):\n"
                "For each finding:\n"
                "- 📌 **Finding**: Clear, one-sentence statement of the finding\n"
                "- **Why It Matters**: One sentence on significance\n"
                "- **Evidence**: 2-3 specific data points/quotes that support this\n"
                "- **Confidence**: 🟢 High / 🟡 Medium / 🔴 Low — with reason\n"
                "- **Source(s)**: [Citation1](URL), [Citation2](URL)\n\n"
                "**2. Non-Obvious Connections:**\n"
                "Identify 3-5 insights that only emerge from combining different research threads:\n"
                "- What pattern connects findings from different steps?\n"
                "- What does the combination of expert opinions + data + historical context reveal?\n"
                "- What is everyone missing? What's the elephant in the room?\n\n"
                "**3. Risk & Opportunity Matrix:**\n"
                "| Factor | Type | Likelihood | Impact | Time Horizon | Evidence |\n"
                "|---|---|---|---|---|---|\n"
                "| [specific factor] | Risk/Opportunity | High/Med/Low | High/Med/Low | Near/Med/Long | [source] |\n\n"
                "**4. Confidence Dashboard:**\n"
                "- Overall research confidence: [High/Medium/Low] — [justification]\n"
                "- Strongest evidence: [top 3 areas where evidence is rock-solid]\n"
                "- Weakest evidence: [top 3 areas where evidence is thin]\n"
                "- Total independent sources: [count from all steps]\n"
                "- Cross-referencing success rate: [how many claims verified?]\n\n"
                "**5. Open Questions** (3-5 things that remain genuinely uncertain):\n"
                "For each: what specific evidence would resolve the uncertainty?"
            ),
        },
        {
            "title": "Conclusions & Assessment",
            "icon": "🎯",
            "system": (
                "You are a strategic advisor delivering forward-looking analysis to a senior decision-maker. "
                "Based on all research, provide scenario planning, actionable recommendations, and "
                "an assessment of what comes next. Think about implications, second-order effects, "
                "and what the reader should actually DO with this information. "
                "Be specific and concrete — no vague advice. Each recommendation must be actionable."
            ),
            "web_search": False,
            "url_context": False,
            "prompt": (
                f"RESEARCH MISSION: {query}\n\n"
                "Provide strategic analysis, scenarios, and concrete recommendations.\n\n"
                "**1. Bottom Line Assessment:**\n"
                "In 3-4 sentences, what is the definitive answer/conclusion from all this research?\n\n"
                "**2. Scenario Analysis:**\n"
                "| Scenario | Description | Probability | Key Drivers | Indicators |\n"
                "|---|---|---|---|---|\n"
                "| 🟢 Best Case | [specific outcome] | [X]% | [what causes this] | [early signs] |\n"
                "| 🟡 Base Case | [most likely outcome] | [X]% | [why likely] | [current trajectory] |\n"
                "| 🔴 Worst Case | [specific negative outcome] | [X]% | [what causes this] | [warning signs] |\n\n"
                "**3. Actionable Recommendations** (5-8, numbered, specific):\n"
                "For each recommendation:\n"
                "1. **[Action verb] [Specific action]**\n"
                "   - *Rationale*: Why this matters (cite evidence)\n"
                "   - *Priority*: High/Medium/Low\n"
                "   - *Timeline*: When to act\n"
                "   - *Expected outcome*: What this achieves\n\n"
                "**4. What to Watch — Monitor Board:**\n"
                "| # | Indicator | Why It Matters | Trigger Level | Check Frequency |\n"
                "|---|---|---|---|---|\n"
                "| 1 | [specific metric/event] | [significance] | [what threshold matters] | Daily/Weekly/Monthly |\n\n"
                "**5. Second-Order Effects:**\n"
                "Map 3-5 ripple effects that aren't immediately obvious:\n"
                "- [Primary event] → [Direct impact] → [Second-order effect] → [Why this matters]"
            ),
        },
        {
            "title": "Final Intelligence Brief",
            "icon": "📋",
            "system": (
                "You are a senior intelligence briefing writer at a world-class consultancy. "
                "Produce the final, publication-quality intelligence brief. It must be comprehensive "
                "yet scannable, authoritative yet accessible, and immediately actionable. "
                "This brief will be the PRIMARY REFERENCE DOCUMENT for the reader. "
                "Include ALL sources with clickable URLs. Use clear hierarchy, bold key points, "
                "and markdown tables for tabular data. Write with precision — every sentence must earn its place."
            ),
            "web_search": False,
            "url_context": False,
            "prompt": (
                f"RESEARCH MISSION: {query}\n\n"
                "You have completed 7 research steps. Now produce the DEFINITIVE intelligence brief.\n"
                "This must be a COMPLETE, standalone document — the reader should not need to look elsewhere.\n\n"
                "## 📋 Intelligence Brief\n"
                f"**Subject:** {query}\n\n"
                "---\n\n"
                "### TL;DR\n"
                "3-4 sentences maximum. The absolute most critical information. **Bold** the key facts and numbers.\n\n"
                "### Executive Summary\n"
                "6-8 sentences covering: the question, key findings, data highlights, expert consensus, "
                "areas of disagreement, and bottom-line assessment.\n\n"
                "### Key Findings\n"
                "Organize by theme (3-5 major themes). For each theme:\n"
                "- **Theme heading**: Clear subheading\n"
                "- Key facts with source citations: [Title](URL)\n"
                "- Data tables (markdown) where numbers tell the story\n"
                "- Expert quotes with attribution\n"
                "- Confidence tag: 🟢 High / 🟡 Medium / 🔴 Low\n\n"
                "### Analysis & Implications\n"
                "- What the findings MEAN (not just what they are)\n"
                "- Key trends and where they're heading\n"
                "- Risks and opportunities with likelihood/impact\n"
                "- Scenario analysis (best/base/worst with probabilities)\n\n"
                "### Actionable Takeaways\n"
                "Numbered list of 5-8 specific, concrete actions/conclusions.\n"
                "Each must be directly supported by evidence from the research.\n\n"
                "### What to Watch\n"
                "Table of key indicators, events, and monitoring recommendations.\n\n"
                "### Sources & References\n"
                "Complete list of ALL sources used across ALL steps:\n"
                "- [Source Title](URL) — one-line summary of what it contributed\n\n"
                "List every single URL discovered. Be exhaustive."
            ),
        },
        {
            "title": "Comprehensive Report",
            "icon": "📝",
            "system": (
                "You are an expert report writer producing the definitive comprehensive document. "
                "Combine ALL findings from the previous 8 research steps into one unified, "
                "well-structured, publication-ready report. Use rich markdown formatting. "
                "Every claim must be cited with [Source Title](URL). "
                "This is the LONGEST output — be thorough and detailed. Cover everything."
            ),
            "web_search": False,
            "url_context": False,
            "prompt": (
                f"RESEARCH MISSION: {query}\n\n"
                "Write the COMPREHENSIVE FINAL REPORT. This is the complete, detailed reference document.\n"
                "Cover EVERYTHING from all 8 previous steps. Be thorough — aim for maximum detail.\n\n"
                f"## Comprehensive Research Report: {query}\n\n"
                "---\n\n"
                "### Executive Overview\n"
                "8-12 sentences covering the full scope of research.\n\n"
                "### Detailed Findings\n"
                "Organize into 4-6 major sections. For each:\n"
                "- Descriptive subheading\n"
                "- Detailed explanation with specific facts, dates, exact numbers\n"
                "- Direct quotes from sources: \"quote\" — [Source](URL)\n"
                "- Data tables where applicable\n"
                "- Expert perspectives from Step 4\n"
                "- Verification status from Step 3: 🟢/🟡/🔴\n\n"
                "### Data & Evidence\n"
                "Include the key data tables from Step 5.\n"
                "Add comparative analyses and trend data.\n\n"
                "### Analysis & Implications\n"
                "- Synthesis insights from Step 6\n"
                "- Non-obvious connections identified\n"
                "- Risk/opportunity assessment\n\n"
                "### Conclusions & Recommendations\n"
                "- Bottom-line assessment from Step 7\n"
                "- Numbered actionable recommendations with evidence basis\n"
                "- Scenario analysis with probabilities\n"
                "- What to monitor going forward\n\n"
                "### Complete Source Index\n"
                "List ALL sources with clickable links and brief descriptions.\n\n"
                "Make this report comprehensive, authoritative, and immediately useful."
            ),
        },
    ]


@app.route("/api/research-plan", methods=["POST"])
@require_auth_or_guest
def research_plan():
    """Return a research plan with AI-generated clarifying questions."""
    data = request.get_json() or {}
    query = (data.get("query") or "").strip()
    if not query:
        return jsonify({"error": "No research query provided"}), 400

    # Always use the preset 8-step plan
    default_steps = _research_agent_steps(query)

    # Generate clarifying questions via a quick AI call
    questions = []
    try:
        genai, types = _import_google()
        settings = load_settings()
        g_key = settings.get("keys", {}).get("google", "") or _load_server_key("google") or ""
        if g_key:
            client = genai.Client(api_key=g_key, http_options={"timeout": 15_000})
            q_prompt = (
                "The user wants deep research on this topic:\n\n"
                f"\"{query}\"\n\n"
                "Generate 2-3 clarifying questions that would help focus and improve the research. "
                "For EACH question, provide 2-4 quick-tap answer choices plus an open-ended option.\n\n"
                "Return ONLY valid JSON — an array of objects, each with:\n"
                "  \"question\": the question text,\n"
                "  \"choices\": array of short answer strings (2-4 choices, last one can be broader like \"All of the above\" or \"Other\")\n\n"
                "Example:\n"
                "[{\"question\": \"What time period?\", \"choices\": [\"Last 5 years\", \"Last decade\", \"All time\"]},\n"
                " {\"question\": \"What angle?\", \"choices\": [\"Economic impact\", \"Social impact\", \"Both\"]}]\n\n"
                "Return ONLY the JSON array, nothing else."
            )
            contents = [types.Content(role="user", parts=[types.Part.from_text(text=q_prompt)])]
            cfg = types.GenerateContentConfig(
                system_instruction="You generate focused research clarification questions with multiple-choice answers. Return only valid JSON.",
                max_output_tokens=500,
            )
            for model_name in ("gemini-2.5-flash-lite", "gemini-2.5-flash"):
                try:
                    r = client.models.generate_content(model=model_name, contents=contents, config=cfg)
                    raw = (r.text or "").strip()
                    # Strip markdown code fences if present
                    if raw.startswith("```"):
                        raw = re.sub(r'^```\w*\n?', '', raw)
                        raw = re.sub(r'\n?```$', '', raw).strip()
                    parsed = json.loads(raw)
                    if isinstance(parsed, list):
                        questions = []
                        for item in parsed[:3]:
                            if isinstance(item, dict) and item.get("question"):
                                q_obj = {"question": str(item["question"]).strip()}
                                choices = item.get("choices", [])
                                if isinstance(choices, list) and choices:
                                    q_obj["choices"] = [str(c).strip() for c in choices[:5]]
                                questions.append(q_obj)
                        if questions:
                            break
                except Exception:
                    continue
    except Exception as e:
        print(f"  [research-plan] Failed to generate questions: {e}")

    return jsonify({
        "questions": questions,
        "plan": [{"title": s["title"], "description": s["prompt"][:120]} for s in default_steps],
        "refined_query": query,
    })


@app.route("/api/research-agent", methods=["POST"])
@require_auth_or_guest
def research_agent():
    """Multi-step research agent with web search and URL context. Streams NDJSON events."""
    data = request.get_json() or {}
    chat_id = data.get("chat_id")
    query = (data.get("query") or "").strip()

    if not query:
        return jsonify({"error": "No research query provided"}), 400

    settings = load_settings()
    selected = normalize_selected_model(settings)

    # Force the INTERNAL deep-research steps to Gemini 3.1 Pro.
    # The user's selected model is still used for normal chat before/after research.
    forced_step_model = "gemini-3.1-pro-preview"
    print(f"  [research] User selected model (intro/outro): {selected}")
    print(f"  [research] Forced step model: {forced_step_model}")

    resolved = resolve_chat_model({"model": forced_step_model}, settings)
    if resolved.get("error"):
        print(f"  [research] Forced model resolution error: {resolved['error']}")
        return jsonify({"error": "Deep Research requires Gemini 3.1 Pro access on this server."}), 403

    provider = resolved.get("provider")
    api_key = resolved.get("api_key")
    model = resolved.get("actual_model")
    base_url = resolved.get("base_url")
    print(f"  [research] Using provider={provider}, model={model}, has_key={bool(api_key)}")

    steps = _research_agent_steps(query)

    def evt(payload):
        return json.dumps(payload) + "\n"

    def _extract_sources(text):
        """Extract URLs from markdown links and <<<SOURCES>>> blocks."""
        sources = []
        seen = set()
        src_blocks = re.findall(r'<<<SOURCES>>>(.*?)<<<END_SOURCES>>>', text, re.DOTALL)
        for block in src_blocks:
            for m in re.finditer(r'\[([^\]]+)\]\((https?://[^)]+)\)', block):
                url = m.group(2).strip()
                if url not in seen:
                    seen.add(url)
                    sources.append({"title": m.group(1).strip(), "url": url})
        for m in re.finditer(r'\[([^\]]+)\]\((https?://[^)]+)\)', text):
            url = m.group(2).strip()
            if url not in seen:
                seen.add(url)
                sources.append({"title": m.group(1).strip(), "url": url})
        return sources

    def _extract_key_findings(text):
        """Extract key findings / important statements from step output."""
        findings = []
        seen = set()

        # Skip patterns that are clearly from prompt templates / instructions
        _SKIP_PHRASES = [
            'research mission', 'specific research', 'the topic', 'your task',
            'execute the', 'search the web', 'for each', 'run at least',
            'key claims, findings', 'preceding steps', 'clear list of',
            'one-sentence statement', 'supporting data', 'direct quotes',
            'search for', 'example query', 'source mapping', 'evidence inventory',
            'initial findings', 'research gaps', 'primary source', 'deep dive',
            'additional discovery', 'claim verification', 'contradiction analysis',
            'recency check', 'confidence summary', 'expert voices', 'stakeholder map',
            'schools of thought', 'historical context', 'key metrics', 'comparative analysis',
            'pattern recognition', 'implications of data', 'core findings',
            'non-obvious connections', 'risk & opportunity', 'confidence dashboard',
            'open questions', 'scenario analysis', 'actionable recommendations',
            'what to watch', 'second-order effects', 'intelligence brief',
            'executive summary', 'analysis & implications', 'actionable takeaways',
            'sources & references', 'tell me what topic', 'please tell me',
            'not been provided', 'have not been', 'topic i need',
        ]
        def _is_instructional(txt):
            low = txt.lower()
            return any(p in low for p in _SKIP_PHRASES)

        # 📌 Finding pattern
        for m in re.finditer(r'📌\s*\*\*([^*]+)\*\*[:\s]*([^\n]*)', text):
            f = m.group(1).strip()
            desc = m.group(2).strip()
            if desc:
                f += ": " + desc
            key = f.lower()[:50]
            if key not in seen and len(f) > 10 and not _is_instructional(f):
                seen.add(key)
                findings.append(f)
        # **Bold Key**: description pattern
        for m in re.finditer(r'\*\*([^*]{5,60})\*\*[:\s]+([^\n]{15,})', text):
            label = m.group(1).strip()
            desc = m.group(2).strip()[:120]
            # skip table headers and format labels
            if any(x in label.lower() for x in ['source', 'metric', 'claim', 'stakeholder', 'indicator', '|', 'finding']):
                continue
            f = label + ": " + desc
            key = f.lower()[:50]
            if key not in seen and not _is_instructional(f):
                seen.add(key)
                findings.append(f)
        # 🟢/🟡/🔴 confidence-tagged items
        for m in re.finditer(r'[🟢🟡🔴]\s*\*\*([^*]{5,80})\*\*', text):
            f = m.group(1).strip()
            key = f.lower()[:50]
            if key not in seen and len(f) > 10 and not _is_instructional(f):
                seen.add(key)
                findings.append(f)
        # Numbered findings: "1. **..." or "- **..."
        for m in re.finditer(r'(?:^|\n)\s*(?:\d+[\.\)]\s*|[-•]\s*)\*\*([^*]{8,80})\*\*', text):
            f = m.group(1).strip()
            key = f.lower()[:50]
            if key not in seen and len(f) > 10 and not _is_instructional(f):
                seen.add(key)
                findings.append(f)
        # Key insight / key takeaway / key finding / important patterns
        for m in re.finditer(r'(?:key\s+(?:insight|takeaway|finding|conclusion)|important)[:\s]+([^\n]{15,120})', text, re.IGNORECASE):
            f = m.group(1).strip().rstrip('.')
            key = f.lower()[:50]
            if key not in seen and len(f) > 10 and not _is_instructional(f):
                seen.add(key)
                findings.append(f)
        return findings[:12]

    # Shared state for partial save on disconnect
    _research_state = {"all_research": [], "all_sources": [], "all_findings": [],
                        "step_durations": [], "total_word_count": 0, "done": False}

    def generate():
        import time as _time
        import itertools
        import threading
        import queue as _queue
        all_research = _research_state["all_research"]
        all_sources = _research_state["all_sources"]
        all_findings = _research_state["all_findings"]
        step_durations = _research_state["step_durations"]
        seen_urls = set()
        total_word_count = 0
        STEP_TIMEOUT = 300  # 5 minute timeout per step
        _HEARTBEAT_SEC = 3  # Send keepalive every 3s to prevent proxy/browser timeouts

        print(f"  [research] Starting research with {len(steps)} steps, model={model}, query={query[:80]}")
        # Immediate first byte — prevents Render's 30s proxy timeout from killing the connection
        yield evt({"type": "heartbeat"})
        yield evt({"type": "agent_start", "total_steps": len(steps), "query": query,
                    "step_meta": [{"title": s["title"], "icon": s.get("icon", "📄")} for s in steps]})

        for i, step in enumerate(steps):
            step_start = _time.time()
            yield evt({"type": "agent_step", "step": i + 1, "title": step["title"],
                        "icon": step.get("icon", "📄"), "status": "running"})

            # Smart context: summarize earlier steps to avoid token overflow
            if len(all_research) <= 3:
                prev_text = "\n\n".join(all_research)
            else:
                # Keep first 2 and last 2 in full, summarize middle
                early = "\n\n".join(all_research[:2])
                recent = "\n\n".join(all_research[-2:])
                prev_text = f"{early}\n\n[... earlier research steps omitted for brevity — key findings are incorporated in the recent steps below ...]\n\n{recent}"

            if all_research:
                prev_section = (
                    f"[YOUR RESEARCH SO FAR — {len(all_research)} steps completed]\n"
                    f"{prev_text}\n\n"
                    f"Build on this research — don't repeat what you've already found. Go deeper, find NEW information.\n\n"
                )
            else:
                prev_section = ""

            messages = [{
                "role": "user",
                "text": f"{prev_section}[YOUR TASK — STEP {i+1}/{len(steps)}: {step['title']}]\n{step['prompt']}",
            }]

            use_web = step.get("web_search", False)
            use_url_ctx = step.get("url_context", False)

            # Progressive fallback attempts for resilience:
            # 1. Thinking + all tools  2. No thinking + all tools
            # 3. No thinking + web only (no url_context)  4. No thinking + no tools
            _attempts = []
            if provider == "google" and (use_web or use_url_ctx):
                _attempts.append({"thinking": True, "web": use_web, "url_ctx": use_url_ctx, "label": "thinking+tools"})
                _attempts.append({"thinking": False, "web": use_web, "url_ctx": use_url_ctx, "label": "tools"})
                if use_url_ctx:
                    _attempts.append({"thinking": False, "web": use_web, "url_ctx": False, "label": "web-only"})
                _attempts.append({"thinking": False, "web": False, "url_ctx": False, "label": "no-tools"})
            elif provider == "google":
                _attempts.append({"thinking": True, "web": False, "url_ctx": False, "label": "thinking"})
                _attempts.append({"thinking": False, "web": False, "url_ctx": False, "label": "plain"})
            else:
                _attempts.append({"thinking": True, "label": "thinking"})
                _attempts.append({"thinking": False, "label": "plain"})

            step_pieces = []
            step_success = False
            _last_err = None
            _grounding_sources = []  # Collect actual URLs from Gemini grounding metadata
            MAX_TURNS_PER_STEP = 3  # Allow multi-turn per step

            for _att_idx, _att in enumerate(_attempts):
                if _att_idx > 0:
                    _time.sleep(1)
                    yield evt({"type": "heartbeat"})
                    step_pieces = []  # Reset for retry
                    print(f"  [research] Step {i+1} attempt {_att_idx+1} ({_att['label']})...")

                try:
                    if provider == "google":
                        genai, types = _import_google()
                        _tools = []
                        if _att.get("web"):
                            _tools.append(types.Tool(google_search=types.GoogleSearch()))
                        if _att.get("url_ctx"):
                            try:
                                _tools.append(types.Tool(url_context=types.UrlContext()))
                            except (AttributeError, TypeError):
                                pass  # url_context not available in this SDK version

                        _client = genai.Client(api_key=api_key, http_options={"timeout": 300_000})
                        _turn_contents = _google_contents_from_messages(messages, types)
                        _cfg_args = dict(
                            system_instruction=step["system"],
                            max_output_tokens=65536,
                        )
                        if _tools:
                            _cfg_args["tools"] = _tools
                        if _att.get("thinking"):
                            try:
                                _cfg_args["thinking_config"] = types.ThinkingConfig(
                                    thinking_budget=16000, include_thoughts=True
                                )
                            except (AttributeError, TypeError):
                                pass  # thinking config not supported
                        _cfg = types.GenerateContentConfig(**_cfg_args)

                        # Multi-turn loop: let the model do multiple rounds per step
                        # Track for repetition detection
                        _repetition_detected = False
                        def _check_repetition(pieces):
                            """Detect streaming glitches like endless separator runs with tiny noise.
                            Allows up to 5 non-separator chars between long runs (e.g. random '/')."""
                            text = "".join(pieces[-30:]) if len(pieces) > 30 else "".join(pieces)
                            if len(text) < 500:
                                return False
                            tail = text[-1500:]

                            # Legit markdown tables should not be treated as repetition glitches.
                            if re.search(r'(?m)^\|.*\|\s*\n\|[\s:\-]+\|\s*$', tail):
                                return False

                            def _noisy_separator_run(buf, ch):
                                # Repeated long runs like -----/-----/----- where noise chunks are <=5 chars.
                                rx = rf'(?:{re.escape(ch)}{{25,}}(?:[^{re.escape(ch)}\n]{{1,5}}{re.escape(ch)}{{25,}}){{4,}})'
                                return re.search(rx, buf) is not None

                            if _noisy_separator_run(tail, '-') or _noisy_separator_run(tail, '='):
                                return True

                            # Fallback: if almost everything is separator characters, it's likely glitched.
                            last600 = tail[-600:]
                            sep_count = sum(1 for c in last600 if c in '-=_*/~')
                            non_sep = re.sub(r'[-=_*/~\s\n]', '', last600)
                            if sep_count >= 280 and len(non_sep) <= 5:
                                return True
                            return False

                        for _turn in range(MAX_TURNS_PER_STEP):
                            _turn_pieces = []

                            # Run API streaming in a background thread with heartbeat
                            # to prevent proxy/browser timeouts during slow API calls
                            _chunk_q = _queue.Queue()
                            _SENTINEL = object()

                            def _stream_worker(_client, _model, _contents, _cfg, _q, _sentinel):
                                try:
                                    _s = _client.models.generate_content_stream(
                                        model=_model, contents=_contents, config=_cfg,
                                    )
                                    for _c in _s:
                                        _q.put(_c)
                                except Exception as _e:
                                    _q.put(_e)
                                finally:
                                    _q.put(_sentinel)

                            _worker = threading.Thread(
                                target=_stream_worker,
                                args=(_client, model, _turn_contents, _cfg, _chunk_q, _SENTINEL),
                                daemon=True,
                            )
                            _worker.start()

                            while True:
                                try:
                                    chunk = _chunk_q.get(timeout=_HEARTBEAT_SEC)
                                except _queue.Empty:
                                    # No data for a while — send heartbeat to keep connection alive
                                    yield evt({"type": "heartbeat"})
                                    continue
                                if chunk is _SENTINEL:
                                    break
                                if isinstance(chunk, Exception):
                                    raise chunk
                                try:
                                    for candidate in (chunk.candidates or []):
                                        # Extract grounding metadata (actual source URLs from Google Search)
                                        try:
                                            gm = getattr(candidate, 'grounding_metadata', None)
                                            if gm:
                                                for gc in getattr(gm, 'grounding_chunks', []) or []:
                                                    web = getattr(gc, 'web', None)
                                                    if web:
                                                        uri = getattr(web, 'uri', '') or ''
                                                        title = getattr(web, 'title', '') or ''
                                                        if uri and 'vertexaisearch' not in uri:
                                                            _grounding_sources.append({"title": title.strip() or uri, "url": uri.strip()})
                                        except Exception:
                                            pass
                                        for part in (candidate.content.parts or []):
                                            if getattr(part, "thought", None) and part.text:
                                                yield evt({"type": "agent_thinking", "step": i + 1, "text": part.text})
                                                continue
                                            if part.text:
                                                _turn_pieces.append(part.text)
                                                step_pieces.append(part.text)
                                                yield evt({"type": "agent_delta", "step": i + 1, "text": part.text})
                                                if _check_repetition(step_pieces):
                                                    _repetition_detected = True
                                except (AttributeError, TypeError):
                                    text = getattr(chunk, "text", "") or ""
                                    if text:
                                        _turn_pieces.append(text)
                                        step_pieces.append(text)
                                        yield evt({"type": "agent_delta", "step": i + 1, "text": text})
                                        if _check_repetition(step_pieces):
                                            _repetition_detected = True
                                if _repetition_detected:
                                    print(f"  [research] Step {i+1}: repetition detected, restarting")
                                    break

                            _turn_text = "".join(_turn_pieces).strip()
                            if not _turn_text:
                                break  # Empty response, stop turns
                            if _repetition_detected:
                                break  # Repetitive content detected, stop this step

                            # Check if the model wants to continue (has search results to analyze, etc.)
                            # Continue if: response is short AND has web tools AND this isn't the last allowed turn
                            _needs_more = (
                                _turn < MAX_TURNS_PER_STEP - 1
                                and _att.get("web")
                                and len(_turn_text) < 800
                                and _turn_text.rstrip().endswith(("...", "…", ":"))
                            )
                            if not _needs_more:
                                break

                            # Feed response back as context for next turn
                            _turn_contents.append(types.Content(
                                role="model",
                                parts=[types.Part.from_text(text=_turn_text)]
                            ))
                            _turn_contents.append(types.Content(
                                role="user",
                                parts=[types.Part.from_text(
                                    text="Continue your research. Search for more information, read additional sources, and expand your analysis. Go deeper."
                                )]
                            ))
                            yield evt({"type": "agent_thinking", "step": i + 1,
                                       "text": "\n\n[Continuing research — additional turn...]\n"})
                    else:
                        stream_fn = STREAM_PROVIDERS.get(provider)
                        if stream_fn:
                            for chunk in stream_fn(
                                api_key, model, step["system"], messages,
                                base_url=base_url, thinking=_att.get("thinking", False),
                                thinking_level="high", web_search=use_web,
                            ):
                                if isinstance(chunk, dict) and chunk.get("__thinking__"):
                                    yield evt({"type": "agent_thinking", "step": i + 1, "text": chunk.get("text", "")})
                                    continue
                                step_pieces.append(chunk)
                                yield evt({"type": "agent_delta", "step": i + 1, "text": chunk})
                        else:
                            full = PROVIDERS.get(provider, call_openai)(
                                api_key, model, step["system"], messages,
                                base_url=base_url, thinking=_att.get("thinking", False),
                                thinking_level="high", web_search=use_web,
                            )
                            step_pieces.append(full)
                            yield evt({"type": "agent_delta", "step": i + 1, "text": full})

                    # If we got here with content, success — UNLESS repetition was detected
                    if _repetition_detected:
                        # Repetition detected = treat as failure, RESTART the step
                        _last_err = Exception("Repetitive pattern detected — restarting step")
                        print(f"  [research] Step {i+1} attempt {_att_idx+1}: repetition detected, RESTARTING step...")
                        # Re-emit agent_step running to tell frontend to CLEAR old content
                        yield evt({"type": "agent_step", "step": i + 1, "title": step["title"],
                                    "icon": step.get("icon", "📄"), "status": "running"})
                        continue  # Try next attempt
                    elif "".join(step_pieces).strip():
                        step_success = True
                        break
                    else:
                        _last_err = Exception("Empty response")
                        print(f"  [research] Step {i+1} attempt {_att_idx+1} returned empty, trying next...")
                except Exception as _att_err:
                    _last_err = _att_err
                    print(f"  [research] Step {i+1} attempt {_att_idx+1} ({_att['label']}) failed: {str(_att_err)[:200]}")
                    continue

            if step_success:
                step_result = "".join(step_pieces)
                display_result = re.sub(r'<<<SOURCES>>>.*?<<<END_SOURCES>>>', '', step_result, flags=re.DOTALL).strip()
                display_result = re.sub(r'<<<FOLLOWUPS>>>.*?<<<END_FOLLOWUPS>>>', '', display_result, flags=re.DOTALL).strip()
                all_research.append(f"## {step['title']}\n{display_result}")

                new_sources = _extract_sources(step_result)
                # Add grounding metadata sources (actual URLs from Google Search, not vertex proxies)
                for gs in _grounding_sources:
                    if gs["url"] not in seen_urls and 'vertexaisearch' not in gs["url"]:
                        new_sources.append(gs)
                # Filter out vertexaisearch proxy URLs from all sources
                new_sources = [s for s in new_sources if 'vertexaisearch.cloud.google.com' not in s.get("url", "") and 'vertexaisearch.google.com' not in s.get("url", "")]
                for src in new_sources:
                    if src["url"] not in seen_urls:
                        seen_urls.add(src["url"])
                        all_sources.append(src)
                if new_sources:
                    yield evt({"type": "agent_sources", "step": i + 1,
                               "sources": [s for s in new_sources if s["url"] in seen_urls],
                               "total_sources": len(all_sources)})

                findings = _extract_key_findings(step_result)
                if findings:
                    all_findings.extend(findings)
                    yield evt({"type": "agent_findings", "step": i + 1,
                               "findings": findings, "total_findings": len(all_findings)})

                step_word_count = len(step_result.split())
                total_word_count += step_word_count
                _research_state["total_word_count"] = total_word_count
                elapsed = round(_time.time() - step_start, 1)
                step_durations.append({"step": i + 1, "title": step["title"], "elapsed": elapsed})
                yield evt({"type": "agent_step", "step": i + 1, "title": step["title"],
                            "icon": step.get("icon", "📄"), "status": "complete", "elapsed": elapsed,
                            "word_count": step_word_count, "source_count": len(new_sources)})
            else:
                elapsed = round(_time.time() - step_start, 1)
                err_msg = str(_last_err)[:200] if _last_err else "All attempts failed"
                all_research.append(f"## {step['title']}\n*Research step failed: {err_msg[:100]}*")
                yield evt({"type": "agent_step", "step": i + 1, "title": step["title"],
                            "icon": step.get("icon", "📄"), "status": "failed",
                            "error": err_msg, "elapsed": elapsed})

        full_report = "\n\n".join(all_research)

        yield evt({"type": "agent_done", "report": full_report, "query": query,
                    "sources": all_sources, "total_sources": len(all_sources),
                    "total_words": total_word_count, "step_durations": step_durations,
                    "findings": all_findings})

        _research_state["done"] = True
        # NOTE: Saving to chat history is handled by _safe_generate_to_list
        # since generate() runs in a background thread without Flask session.

    def _safe_generate_to_list(events_list, cancel_event):
        """Run generate() and collect all events into events_list. Designed for background thread."""
        try:
            for event_str in generate():
                events_list.append(event_str)
                if cancel_event.is_set():
                    events_list.append(json.dumps({"type": "agent_error", "error": "Research cancelled by user."}) + "\n")
                    break
            # Save completed research to chat history
            if _research_state["done"] and chat_id and _research_state["all_research"]:
                try:
                    chat, _ = _bg_load_chat(chat_id)
                    if chat:
                        all_r = _research_state["all_research"]
                        step_breakdown = []
                        for entry in all_r:
                            nl = entry.find('\n')
                            if nl > 0:
                                step_breakdown.append({"title": entry[3:nl].strip(), "body": entry[nl+1:]})
                            else:
                                step_breakdown.append({"title": entry[3:].strip(), "body": ""})
                        chat["messages"].append({
                            "role": "model",
                            "text": "\n\n".join(all_r),
                            "timestamp": datetime.datetime.now().isoformat(),
                            "research_agent": True,
                            "research_agent_steps": step_breakdown,
                            "research_agent_query": query,
                            "research_agent_sources": _research_state["all_sources"],
                            "research_agent_findings": _research_state["all_findings"],
                            "research_agent_durations": _research_state["step_durations"],
                            "research_agent_words": _research_state["total_word_count"],
                        })
                        _bg_save_chat(chat)
                        print(f"  [research] Saved completed research ({len(all_r)} steps) to chat {chat_id}")
                except Exception as save_err:
                    print(f"  [research] Failed to save completed research: {save_err}")
            # Clear the active research flags from the chat
            if chat_id:
                try:
                    _rc2, _ = _bg_load_chat(chat_id)
                    if _rc2:
                        _rc2.pop("_active_research_id", None)
                        _rc2.pop("_active_research_query", None)
                        _bg_save_chat(_rc2)
                except Exception:
                    pass
        except Exception as e:
            print(f"  [research] FATAL generator error: {e}")
            import traceback; traceback.print_exc()
            try:
                events_list.append(json.dumps({"type": "agent_error", "error": str(e)[:300]}) + "\n")
            except Exception:
                pass
            # Save partial results on error
            if not _research_state["done"] and chat_id and _research_state["all_research"]:
                try:
                    chat, _ = _bg_load_chat(chat_id)
                    if chat:
                        all_r = _research_state["all_research"]
                        step_breakdown = []
                        for entry in all_r:
                            nl = entry.find('\n')
                            if nl > 0:
                                step_breakdown.append({"title": entry[3:nl].strip(), "body": entry[nl+1:]})
                            else:
                                step_breakdown.append({"title": entry[3:].strip(), "body": ""})
                        chat["messages"].append({
                            "role": "model",
                            "text": "\n\n".join(all_r),
                            "timestamp": datetime.datetime.now().isoformat(),
                            "research_agent": True,
                            "research_agent_steps": step_breakdown,
                            "research_agent_query": query,
                            "research_agent_sources": _research_state["all_sources"],
                            "research_agent_findings": _research_state["all_findings"],
                            "research_agent_durations": _research_state["step_durations"],
                            "research_agent_words": _research_state["total_word_count"],
                            "research_agent_partial": True,
                        })
                        _bg_save_chat(chat)
                        print(f"  [research] Saved partial results ({len(all_r)} steps) on error")
                except Exception as save_err:
                    print(f"  [research] Failed to save partial results: {save_err}")
            # Clear the active research flags even on error
            if chat_id:
                try:
                    _rc3, _ = _bg_load_chat(chat_id)
                    if _rc3:
                        _rc3.pop("_active_research_id", None)
                        _rc3.pop("_active_research_query", None)
                        _bg_save_chat(_rc3)
                except Exception:
                    pass

    # --- Poll-based architecture ---
    # Capture session data for background thread (load_chat/save_chat need session)
    _s_guest = session.get("guest")
    _s_uid = session.get("user_id")
    _s_gid = session.get("guest_id")

    def _bg_load_chat(cid):
        if not _safe_id(cid): return None, "invalid_id"
        if _s_guest and not _s_uid:
            if _s_gid:
                return _load_json(_guest_dir(_s_gid) / "chats" / f"{cid}.json", None), None
            return None, "no_guest_id"
        if not _s_uid: return None, "no_user_id"
        if not FIREBASE_ENABLED:
            path = _local_user_dir(_s_uid) / "chats" / f"{cid}.json"
            data = _load_json(path, None)
            return (data, None) if data else (None, "file_missing")
        col = _chats_col()
        if not col: return None, "no_firestore"
        snap = col.document(cid).get()
        return (snap.to_dict(), None) if snap.exists else (None, "not_found")

    def _bg_save_chat(c):
        c["updated"] = datetime.datetime.now().isoformat()
        if _s_guest and not _s_uid:
            if _s_gid:
                _save_json(_guest_dir(_s_gid) / "chats" / f"{c['id']}.json", c)
            return
        if not _s_uid: return
        if not FIREBASE_ENABLED:
            _save_json(_local_user_dir(_s_uid) / "chats" / f"{c['id']}.json", c)
            return
        col = _chats_col()
        if col: col.document(c["id"]).set(c)

    research_id = str(uuid.uuid4())
    cancel_event = threading.Event()
    _cleanup_stale_research()  # Housekeeping: remove old sessions

    with _active_research_lock:
        _active_research[research_id] = {
            "events": [],
            "done": False,
            "started": time.time(),
            "cancel": cancel_event,
        }

    # Cross-device sync: store research_id on chat so other devices can discover it
    if chat_id:
        try:
            _rc, _ = load_chat(chat_id)
            if _rc:
                _rc["_active_research_id"] = research_id
                _rc["_active_research_query"] = query
                save_chat(_rc)
        except Exception:
            pass
        # Also store in the active stream buffer if one exists
        with _active_streams_lock:
            _sb = _active_streams.get(chat_id)
            if _sb is not None:
                _sb["research_id"] = research_id
                _sb["research_query"] = query

    def _bg_runner():
        session_ref = _active_research.get(research_id)
        if not session_ref:
            return
        try:
            _safe_generate_to_list(session_ref["events"], cancel_event)
        finally:
            session_ref["done"] = True
            print(f"  [research] Session {research_id} finished ({len(session_ref['events'])} events)")

    t = threading.Thread(target=_bg_runner, daemon=True)
    t.start()

    return jsonify({"research_id": research_id})


@app.route("/api/research-agent/poll")
@require_auth_or_guest
def research_agent_poll():
    """Return accumulated events for a running research session. Lightweight JSON response."""
    research_id = request.args.get("id", "")
    cursor = int(request.args.get("cursor", 0))

    with _active_research_lock:
        rsession = _active_research.get(research_id)

    if not rsession:
        return jsonify({"events": [], "cursor": cursor, "done": True, "error": "not_found"}), 404

    events = rsession["events"][cursor:]
    new_cursor = cursor + len(events)
    is_done = rsession["done"] and new_cursor >= len(rsession["events"])

    resp_data = {"events": events, "cursor": new_cursor, "done": is_done}

    # Clean up completed sessions after final poll
    if is_done:
        def _deferred_cleanup():
            time.sleep(30)
            with _active_research_lock:
                _active_research.pop(research_id, None)
        threading.Thread(target=_deferred_cleanup, daemon=True).start()

    return jsonify(resp_data)


@app.route("/api/research-agent/cancel", methods=["POST"])
@require_auth_or_guest
def research_agent_cancel():
    """Cancel a running research session."""
    data = request.get_json() or {}
    research_id = data.get("research_id", "")

    with _active_research_lock:
        rsession = _active_research.get(research_id)

    if not rsession:
        return jsonify({"error": "not_found"}), 404

    rsession["cancel"].set()
    return jsonify({"ok": True})



# --- Pre-warm heavy modules (.pyc compilation) ------------------------------
def _prewarm_modules():
    """Background thread that imports heavy packages once so .pyc files are cached."""
    def _warm():
        try:
            import subprocess as _sp
            _sp.run(
                [sys.executable, "-c",
                 "import sympy; import numpy; import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot"],
                capture_output=True, timeout=60,
                cwd=str(WORKSPACE),
            )
        except Exception:
            pass
    threading.Thread(target=_warm, daemon=True).start()

# Pre-warm on import (covers gunicorn and direct run)
_prewarm_modules()


# --- Main ---------------------------------------------------------------------
if __name__ == "__main__":
    _ensure_dirs()
    print("\n  +----------------------------------------------+")
    print("  |   PROJECT gyro - Flow-State Architect v3   |")
    print("  |                                             |")
    print("  |   Open http://localhost:5000 in browser     |")
    print("  +----------------------------------------------+\n")
    app.run(host="127.0.0.1", port=5000, debug=False)

