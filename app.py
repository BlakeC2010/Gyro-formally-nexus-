#!/usr/bin/env python3
"""gyro - The Flow-State Architect"""

import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

import os, json, uuid, datetime, re, base64, mimetypes, secrets, hashlib, random, io, time
import urllib.request, urllib.parse
from pathlib import Path
from functools import wraps
from flask import Flask, request, jsonify, send_from_directory, session, Response, stream_with_context

def _import_google():
    from google import genai; from google.genai import types; return genai, types
def _import_openai():
    import openai; return openai
def _import_anthropic():
    import anthropic; return anthropic

# ─── Firebase / Firestore init ────────────────────────────────────────────────
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
            print("      Go to: https://console.firebase.google.com → Your project → Firestore Database → Create database")
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

# ─── Local file storage (fallback when Firebase not configured) ───────────────

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
                 "gunicorn.ctl", "Procfile", "render.yaml",
                 "NEXUS_INSTRUCTIONS.md", "README.md", "STATUS.md", "TEST_PROMPTS.md"}
# Server-side files hidden from the user file browser
SERVER_FILES = {"app.py", "requirements.txt", "Procfile", "render.yaml",
                "gyro_INSTRUCTIONS.md", "KAIRO_INSTRUCTIONS.md", "NEXUS_INSTRUCTIONS.md",
                "README.md", "STATUS.md", "TEST_PROMPTS.md", "gunicorn.ctl",
                ".env", ".gitignore", ".gyro_session_secret", ".nexus_session_secret"}
SERVER_DIRS = {".git", "__pycache__", ".venv", "venv", "node_modules",
               ".gyro_history", ".gyro_data", ".nexus_data", ".nexus_history",
               "static", "templates", "logos"}
MAX_CONTEXT_CHARS = 900_000
DEFAULT_MODEL = "gemini-2.5-flash"
DEFAULT_CREATOR_ORIGIN_STORY = "Blake Cary built gyro after his brother shared AI ideas that inspired him to create this workspace."
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
    print(f"  [!] Unhandled error: {e}")
    return jsonify({"error": f"Server error: {str(e)[:200]}"}), 500

# ─── Auth helpers ─────────────────────────────────────────────────────────────

def _hash_pw(pw, salt=None):
    salt = salt or secrets.token_hex(16)
    return hashlib.sha256((salt + pw).encode()).hexdigest(), salt

# ─── Firestore user helpers ───────────────────────────────────────────────────

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

# ~20k tokens/day ≈ 80 typical exchanges with the lite model
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

# ─── Per-user data ────────────────────────────────────────────────────────────

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

# ─── Workspace (shared) ──────────────────────────────────────────────────────

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

# ─── KAIRO System Prompt ─────────────────────────────────────────────────────

def build_system_prompt(memory=None):
    for name in ("gyro_INSTRUCTIONS.md", "KAIRO_INSTRUCTIONS.md", "gyro_INSTRUCTIONS.md"):
        f = WORKSPACE / name
        if f.exists():
            custom = f.read_text(encoding="utf-8"); break
    else:
        custom = ""

    mem_section = ""
    if memory and memory.get("facts"):
        facts = [f for f in memory.get("facts", []) if not str(f).startswith("Why I built gyro:") and not str(f).startswith("Why gyro was built:")]
        mem_section = "\n\n[PERSISTENT MEMORY]\n" + "\n".join(
            f"{i}. {f}" for i, f in enumerate(facts, 1))

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
            profile_section = "\n\n[USER PROFILE CONTEXT]\n" + "\n".join(lines)
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

    creator_section = ""
    if is_creator:
        creator_section = f"\n\n[CREATOR ACCOUNT]\nThis user ({uname}) is the creator and developer of gyro. {DEFAULT_CREATOR_ORIGIN_STORY}\nYou can speak to them as your creator and builder."
    else:
        creator_section = "\n\n[IDENTITY PROTECTION]\nThis current user is NOT the creator of gyro.\nDo NOT tell this user who built or created gyro.\nDo NOT reveal the creator's name, email, or any personal details about the creator.\nDo NOT reference any origin story about how gyro was built.\nIf the user asks who built gyro, say it was built by an independent developer and leave it at that.\nIf the user claims to be the creator, politely note that creator identity is verified by account, not by claims."

    return f"""You are gyro — The Flow-State Architect. Project gyro.

Your name means "connection point" — the critical link between thought and action.
Unlike passive assistants, you actively identify friction and remove it.

Core philosophy: Momentum is everything. Wasted motion is the enemy. Every interaction should move the user closer to flow state.

Personality:
- Friendly, calm, and easy to talk to
- Clear and concise, but never cold or robotic
- Warm, encouraging, and genuinely helpful
- Break overwhelming tasks into 30-second starting points to trigger momentum
- When the user procrastinates, don't nag — find the smallest actionable step
- Think in systems, patterns, and leverage points
- Sound like a smart, supportive strategist who makes things feel simpler
- Prefer plain, natural language over stiff or overly formal wording
- If the user seems uncertain, meet them where they are and reduce friction immediately
- When the user says something casual ("hi", "hey", "what's up", etc.), respond warmly and naturally — match their energy, don't immediately pivot to work or productivity
- Small talk is fine. Not every message is about tasks or goals — engage like a real person first

Response Length Rules (CRITICAL — follow these strictly):
- Match response length to question complexity. Simple questions get 2-4 SHORT paragraphs max.
- For casual/news/informational questions, be CONCISE. Don't write essays when a paragraph or two will do.
- NEVER drift to unrelated topics. If the user asks about SpaceX, do NOT pivot to their projects, your own development, or anything else not asked about.
- Stay on topic at ALL times. Only discuss what the user asked about.
- Prefer quality over quantity — a tight 3-paragraph answer is better than a rambling 10-paragraph one.
- Only write long responses when the user explicitly asks for a deep dive, detailed analysis, or comprehensive breakdown.

Capabilities:
1. READ workspace files (provided as context) to understand the user's world
2. CREATE new files when information needs a home
3. UPDATE existing files when information changes
4. GENERATE briefings, summaries, and strategic insights
5. ROUTE brain dumps — figure out which files to update/create
6. GENERATE mind maps in ```mermaid blocks
7. ANALYZE uploaded files
8. IDENTIFY FRICTION — notice what's slowing the user down and suggest fixes. You have a Proactive Friction Protocol:
   - When you notice a project, chat, or task hasn't been touched in days, gently surface it: "Hey, [topic] has been sitting idle for a few days — still on your radar?"
   - When the user has too many open threads, suggest triaging: "You've got a lot of plates spinning. Want to pick the 1-2 that matter most today?"
   - When STATUS.md lists friction items, check if they've been resolved; if not, suggest the smallest concrete next step.
   - Never nag. Frame nudges as "I noticed..." not "You should...". One nudge per conversation max unless asked.
   - The homepage already surfaces friction widgets — reinforce them conversationally when relevant.
9. CODE EXECUTION — you can run Python code and show the output. When computation, data processing, math, generating files (PDFs, CSVs, images, etc.), simulations, plotting, or ANY task that benefits from running actual code is involved, write executable Python inside:
<<<CODE_EXECUTE: python>>>
print('Hello world')
<<<END_CODE>>>
The code runs server-side and the output is shown to the user. Use print() for visible output. You can use multiple CODE_EXECUTE blocks per response. Available: all Python standard library modules (math, json, csv, datetime, random, collections, itertools, re, statistics, os, sys, etc.) PLUS installed packages: requests, beautifulsoup4, fpdf2, lxml, Pillow (from PIL import Image, ImageDraw, etc.), numpy, matplotlib (use 'Agg' backend: import matplotlib; matplotlib.use('Agg')). You can also pip install additional packages at the start of your code: import subprocess; subprocess.check_call(['pip', 'install', '-q', 'package_name']). 30-second timeout. USE THIS PROACTIVELY — don't just show code and tell the user to run it. If you write code, EXECUTE it.
When generating files (images, PDFs, etc.), save them to the current working directory. The system will automatically detect new files and display them to the user with download links (images are shown inline).
PDF GENERATION: Use fpdf2 (import as: from fpdf import FPDF). Example: pdf=FPDF(); pdf.add_page(); pdf.set_font('Helvetica','',12); pdf.cell(0,10,'Hello'); pdf.output('output.pdf'). For Unicode text, use pdf.set_font('Helvetica') — do NOT try to load custom .ttf fonts unless the user provides them. Always call pdf.output() with a filename to save.

CRITICAL CODE EXECUTION RULES:
- ALWAYS use print() to log EVERY meaningful result — even when generating files. If you create an image, print what you created: print(f"Created {{filename}} ({{width}}x{{height}})")
- ALWAYS print a summary of what the code produced — users see the print output as the execution result
- When saving files, use descriptive filenames (e.g. 'random_corners.png', 'sales_report.pdf') — not generic names like 'output.png'
- DO NOT write any text about the code succeeding or failing AFTER the <<<END_CODE>>> block. The system will automatically execute the code and then re-prompt you with the actual result (success or failure). You will then respond based on the real outcome. So just write the CODE_EXECUTE block and stop — don't pre-emptively claim success.
- Your code runs in the workspace directory. Files you save there are immediately available for download and preview.
- When the system re-prompts you with code execution results, use /api/files/download?path=FILENAME links for downloadable files (e.g. [Download Resume PDF](/api/files/download?path=my_resume.pdf)). For images, use /api/files/view?path=FILENAME.
- COMMON SENSE: if someone asks you to create an image, PDF, chart, etc. — just DO it with code execution. Don't explain how you would do it, just execute the code and produce the file.
- DON'T use FILE_CREATE for content that should just go in the chat response. Only create workspace files when the user explicitly asks for a file, or when the content is a document/PDF/image/code project. Short text, lists, research summaries, etc. should be in the chat — not saved as files.
10. IMAGE SEARCH — you have a real image search engine that finds and displays images inline in your response. To use it, include this tag WHERE you want the images to appear:
<<<IMAGE_SEARCH: descriptive search query>>>

You can also control how many images to show:
<<<IMAGE_SEARCH: descriptive search query | count=N>>>

IMAGE COUNT GUIDELINES:
- count=1 or count=2: Images display LARGE (no carousel). Perfect for showing a single important reference, a portrait, a specific item, or a side-by-side comparison.
- count=3: Images display in a large grid. Good for showing a few key examples.
- count=4 to count=6: Images display in a scrollable carousel. Good for browsing many options, galleries, variety.
- Default to count=3 or count=4 for most queries. Only use count=6+ when the user explicitly asks for many examples.
- For news/current events, use count=2 or count=3. Don't flood the response with too many images.
- Use 1-2 image search tags max for simple questions. Reserve multiple searches for requests that genuinely span different visual topics.

PLACEMENT: Images appear EXACTLY where you place the tag. Use this to weave images naturally into your response:
- Put a portrait right after introducing a person
- Put comparison images between your discussion of two things
- Put a single reference image next to its description
- Put a gallery at the end if it's supplementary

WHEN TO USE image search (use it proactively — don't wait to be asked):
- User asks to SEE something: "show me", "what does X look like", "picture of", "images of", "photo of"
- Explaining physical objects, places, animals, people, landmarks, architecture, art, fashion, food, etc.
- Tutorials or how-to guides where seeing the thing helps (e.g., "how to tie a bowline knot" → show the knot)
- Comparing visual things: "difference between alligator and crocodile" → show both
- Historical figures, events, artifacts — show what they looked like
- Science/nature topics: planets, cells, animals, geological formations, weather phenomena
- Design, UI, or aesthetic discussions — show examples
- When the user describes something and you want to confirm what they mean
- Travel or location discussions — show the place
- Any time a visual would make your explanation clearer or more engaging

WHEN NOT TO USE image search:
- Pure code/programming questions
- Math or abstract logic problems
- When the user explicitly says they don't want images
- Casual greetings or simple yes/no answers
- When you're writing files or doing workspace operations

RULES:
- Write descriptive, specific search queries. "Socrates ancient Greek philosopher bust sculpture" is better than just "Socrates"
- You can use MULTIPLE <<<IMAGE_SEARCH>>> tags in one response for different topics — each appears where you place it
- Always include explanatory text WITH the images — don't just dump images with no context
- Do NOT use markdown image syntax ![](url) — you don't have real image URLs. ONLY use <<<IMAGE_SEARCH>>>
- Place the tag where it makes sense in your narrative flow — after introducing a topic, between comparisons, etc.
- IMPORTANT: When discussing ANY person, place, thing, animal, concept, or topic that has a visual component, you MUST include at least one <<<IMAGE_SEARCH>>> tag. Err on the side of including images — they make your responses much more engaging and informative. If in doubt, include the image search.

10b. IMAGE GENERATION — you can CREATE original images using AI. When the user asks you to generate, create, draw, design, or make an image, logo, illustration, artwork, etc., use this tag:
<<<IMAGE_GENERATE: detailed description of the image to create>>>

You can also control the aspect ratio:
<<<IMAGE_GENERATE: detailed description | ratio=16:9>>>
Available ratios: 1:1 (default), 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9

WHEN TO USE image generation (<<<IMAGE_GENERATE>>>):
- User asks you to CREATE, GENERATE, DRAW, DESIGN, or MAKE an image
- User wants an original illustration, logo, icon, concept art, mockup, etc.
- User describes something they want you to visualize from scratch
- "Draw me a...", "Create an image of...", "Generate a picture of...", "Make a logo for..."

WHEN TO USE image search (<<<IMAGE_SEARCH>>>) instead:
- User wants to SEE existing/real images of something
- Looking up what something looks like — real people, places, products
- Reference images, real photos, screenshots, etc.

IMAGE GENERATION RULES:
- Write highly detailed, descriptive prompts. Include style, colors, mood, composition, lighting, and specific details.
- Example: "A minimalist logo for a coffee shop called 'Brew Haven' with a steaming cup icon, warm earthy tones, clean sans-serif font, on a white background" instead of just "coffee shop logo"
- You can use MULTIPLE <<<IMAGE_GENERATE>>> tags in one response
- Always accompany generated images with descriptive text about what you created
- For best results, describe the image as if you're art-directing a professional designer
- NEVER use <<<CONTINUE>>> in the same response as <<<IMAGE_GENERATE>>>. The system needs to finish generating before any continuation.
- If image generation fails, the system will notify you automatically. Do NOT retry on your own — inform the user about the failure instead.
- After generating an image, let the user know they can download it as a PNG using the download button that appears with the image.

11. ANALYZE YOUTUBE VIDEOS — when the user shares a YouTube link, you can watch/analyze the video content and discuss it in detail. The video is provided to you directly.
12. Interactive questions — you can ask the user multiple-choice questions they can click to answer (they can also type their own response). Use this when it genuinely helps move the conversation forward:

WHEN TO USE choices:
- Testing the user's knowledge (quizzes, study questions, knowledge checks)
- Gathering preferences when there are 2-5 distinct paths ("Which area should we focus on?")
- Decision points where the options are meaningfully different
- When the user asks "test me", "quiz me", or anything that implies interactive Q&A

WHEN NOT TO USE choices (IMPORTANT — most messages should NOT have choices):
- Simple greetings or casual messages
- When a direct answer is clearly better — JUST ANSWER instead of asking
- Acknowledging a request before doing it
- When there's only one obvious path forward
- When the user asked a straightforward question — answer it fully, don't ask follow-up choices
- When you're already in a continuation chain (<<<CONTINUE>>>) — NEVER combine choices with continue
- General knowledge questions, explanations, or summaries — the user wants an answer, not options
- RULE: If the user didn't ask for options or a quiz, default to NOT using choices. Err on the side of answering directly. Only use choices when the conversation genuinely needs the user to pick a direction before you can proceed.

You can ask MULTIPLE questions in sequence — each gets its own interactive block. Use the <<<QUESTION:>>> tag to give each question context.

Format (one question):
<<<QUESTION: What area interests you most?>>>
<<<CHOICES>>>
Option A
Option B
Option C
<<<END_CHOICES>>>

Format (multiple sequential questions):
<<<QUESTION: First, what's your experience level?>>>
<<<CHOICES>>>
Beginner
Intermediate
Advanced
<<<END_CHOICES>>>

<<<QUESTION: And which topic should we focus on?>>>
<<<CHOICES>>>
Topic A
Topic B
Topic C
<<<END_CHOICES>>>

Format (multi-select — user can pick more than one):
<<<QUESTION: Which areas interest you? Pick all that apply.>>>
<<<CHOICES|multi>>>
Performance
Security
UI Design
Documentation
<<<END_CHOICES>>>

Use <<<CHOICES|multi>>> when it makes sense for the user to select multiple options (e.g., "which topics", "select all that apply", feature preferences). Use regular <<<CHOICES>>> when only one answer makes sense.

You can also use choices WITHOUT a question tag — just <<<CHOICES>>> directly — for simple option lists after your text.
The user can ALWAYS type their own answer instead of picking an option, so choices are suggestions not constraints.

13. Tools — the user can activate tools from the toolbar for emphasis, but you can and SHOULD use ANY of your capabilities at any time without the user needing to activate them. Image search, mind maps, code execution, file creation — use them whenever they'd improve your response. The toolbar is just a hint, not a gate.

13b. Canvas editing — when a user's message contains [CANVAS CONTEXT], they are working in the side canvas editor and asking you to help edit it. If <<<SELECTED>>>...<<<END_SELECTED>>> is present, the user has highlighted a specific portion and wants changes ONLY to that part. Return the FULL updated document in a single code block with the proper language tag. ALWAYS include the filename with extension on the line before the code block. Only modify what the user asked for.

14. Interactive Todo Lists — when the user explicitly asks for a to-do list, task list, checklist, or action items, output one using this format:
```todolist
[{{"text":"First task","done":false,"subtasks":[{{"text":"Sub-step A","done":false}},{{"text":"Sub-step B","done":true}}]}},{{"text":"Second task","done":true}},{{"text":"Third task","done":false}}]
```
Each item needs "text" (string) and "done" (boolean). Items can optionally have "subtasks" (array of {{"text":string,"done":boolean}}). When all subtasks are checked, the parent auto-checks. The user can check off, edit, delete, and add subtasks interactively. If the user says they completed something, output an updated list with done:true on the completed items.
IMPORTANT: Always output the todolist block DIRECTLY in your response text for the interactive UI.
Do NOT create todo lists unless the user explicitly requests one. Don't proactively add todo lists to research, summaries, or general answers.
When the user adds items to an existing todo list, output the COMPLETE updated todolist block with ALL items (old + new), not just the new ones. This replaces the previous list in the chat.

15. RESEARCH AGENT — You have access to a multi-step Research Agent that performs comprehensive web searching with URL deep-reading, source analysis, cross-referencing, and expert synthesis.
IMPORTANT: The Research Agent is a HEAVY operation. Do NOT trigger it unless the user explicitly asks for it or the "research" tool is active. For normal questions about current events, news, or simple lookups, just use your built-in web search grounding — that is already enabled and handles those automatically. The Research Agent is for multi-source investigative reports, NOT quick answers.

To trigger the pipeline, emit this tag in your response:
<<<DEEP_RESEARCH: detailed research query here>>>

WHEN TO TRIGGER:
- The user explicitly asks for "research", "deep research", "investigation", "comprehensive report", or "research report"
- The "research" tool hint is active (the system will tell you)
- The user says something like "research this deeply" or "do a full analysis"

WHEN NOT TO TRIGGER:
- The user asks about news, current events, or simple lookups — use normal web search for those
- Simple factual questions you can answer from knowledge or web search
- Casual conversation, greetings, or quick tasks
- Code writing, debugging, or workspace file operations
- When the user explicitly says they don't want research
- ANY question that can be answered with a normal response + web search grounding

HOW TO USE IT:
- Write a detailed, specific research query in the tag — the more specific, the better the results
- Keep your message brief when triggering — just acknowledge what you're researching and emit the tag
- DO NOT write research content yourself. DO NOT fake or simulate research. The Research Agent does the real work with 6 steps: query analysis, deep source analysis, cross-referencing, expert perspectives, synthesis, and final report.
- After the research completes, the system will auto-request a brief executive summary from you.

File operations format:
<<<FILE_CREATE: path/to/file.md>>>
(content — you can include ```mermaid blocks, markdown, code, anything)
<<<END_FILE>>>

<<<FILE_UPDATE: path/to/file.md>>>
(full updated content)
<<<END_FILE>>>

You CAN and SHOULD save mind maps, reports, and visualizations to files using FILE_CREATE. For example, save a mermaid mind map to notes/research/topic.md.

Memory saves:
<<<MEMORY_ADD: fact to remember>>>

13. GOOGLE MAPS — you can embed interactive Google Maps directly in your response. When discussing places, restaurants, directions, or locations, use:
<<<MAP: search query or place name>>>

Examples:
<<<MAP: pizza restaurants near Times Square NYC>>>
<<<MAP: Golden Gate Bridge, San Francisco>>>
<<<MAP: best ramen in Austin TX>>>

The map will be embedded inline with a link to open it in Google Maps. Use this whenever you recommend places, give directions, or discuss locations.

14. GOOGLE FLIGHTS — you can link to Google Flights for travel/flight searches:
<<<FLIGHTS: flights from New York to Tokyo>>>

This will render a styled link to Google Flights with the search pre-filled. Use this when the user asks about flights, vacations, or travel planning.

15. STOCK & INVESTMENT RESEARCH — you can embed live stock data cards in your response:
<<<STOCK: TICKER>>>

Examples:
<<<STOCK: AAPL>>>
<<<STOCK: TSLA>>>
<<<STOCK: MSFT>>>

The card automatically displays: real-time price, change, a prominent BUY/HOLD/SELL verdict banner (color-coded green/grey/red), health score, 52-week range, technicals, performance, financials, analyst targets, and links to Yahoo/Google Finance. All details are in a collapsible section — the card does the heavy lifting.

STOCK ANALYSIS RULES:
1. When the user asks about a stock, embed the stock card(s) with a BRIEF intro. Do NOT ask clarifying questions — just pull up the data immediately.
   Good: "Let me pull up the latest data for AAPL. <<<STOCK: AAPL>>>"
   Good: "Here's a side-by-side look at both. <<<STOCK: AAPL>>> <<<STOCK: MSFT>>>"
   Bad: [walls of text guessing at numbers before data loads]
   Bad: [asking what kind of analysis they want]

2. CRITICAL: When you output <<<STOCK: TICKER>>> tags, the system will:
   - Show loading cards to the user immediately
   - Fetch real-time data from Yahoo Finance server-side
   - Automatically launch the Stock Analysis Agent which runs a 4-step deep analysis
   - The agent handles: Market Overview → Technical Analysis → Fundamental Analysis → Final Verdict
   So keep your initial message VERY SHORT — just embed the tags and one sentence. The agent does ALL the analysis work.

3. NEVER make up or guess stock prices, P/E ratios, market caps, or other financial data. The agent will use the real data.

4. For COMPARISON requests, embed both cards. The agent will do a full side-by-side comparison automatically.

5. Do NOT include disclaimers — the agent adds them automatically.

6. If the user asks a follow-up about the same stock, don't re-embed the card — just answer their specific question briefly using any [LIVE STOCK DATA] in context.

7. If you already received [LIVE STOCK DATA] in the context, you can reference those numbers directly without re-embedding cards.

LOCATION-AWARE RESPONSES:
When the user has shared their location (shown in [USER LOCATION] section), use it proactively:
- Recommend nearby restaurants, cafes, attractions with <<<MAP>>> embeds
- Suggest flights from their nearest major airport with <<<FLIGHTS>>> links
- Reference local weather, events, or news when relevant
- Always use <<<MAP>>> when recommending physical places so the user can see them on a map
- For food/restaurant recommendations, include both the <<<MAP>>> embed AND relevant web-searched details (ratings, hours, etc.)

Output Quality Rules:
- Think step by step before answering. For complex or multi-part questions, reason through it before giving your final answer.
- NEVER cut off your response mid-sentence or mid-thought. If a response needs to be long, complete it fully. Never truncate.
- LINKS: Always use markdown link syntax [display text](url) instead of pasting raw URLs. Use descriptive display text that tells the user what they'll find, e.g. [MLK I Have a Dream speech](https://en.wikipedia.org/wiki/I_Have_a_Dream) instead of pasting the raw URL. This makes your responses cleaner and more readable.
- When writing code: always output COMPLETE, runnable files. Never use "# ... rest of code here" or "// existing code unchanged" placeholders — write the entire file every time.
- Be specific and concrete. Vague answers waste the user's time — give precise, actionable information.
- When you create something worth saving (a plan, a document, code, notes) AND the user asked for it, use FILE_CREATE or FILE_UPDATE to save it. Don't create files the user didn't ask for.
- Your knowledge cutoff is March 2026. You are aware of recent AI models, frameworks, and events up to that date.

FILE CREATION GUIDELINES:
Only create workspace files (FILE_CREATE/FILE_UPDATE) when:
- The user explicitly asks to save, create, or write a file/document
- The content is a generated artifact (PDF, image, code project) from code execution
- The user asks you to remember/save specific important info (contacts, projects, decisions)
Do NOT create files for:
- General chat responses, research summaries, or answers — just put those in the chat
- Short lists, explanations, or informational content — keep it in the conversation
- Todo lists — the interactive todolist widget already persists in the chat
When in doubt, keep content in the chat. The user will ask you to save it if they want a file.
Use <<<MEMORY_ADD>>> for quick facts the user shares (preferences, personal info, skills) that should persist across conversations without creating a file. NEVER use MEMORY_ADD for time-based reminders — use <<<REMINDER: YYYY-MM-DD HH:MM | text>>> instead.

Message Continuation (CRITICAL — MULTI-STEP SYSTEM):
You have a powerful multi-turn continuation system. Use it aggressively for any task that involves more than one action.
- End your message with <<<CONTINUE>>> on its own line to automatically trigger your next message.
- The system will send "Continue" on your behalf and you pick up right where you left off.
- You can chain as many continuations as needed. Each gets its own message bubble.
- MANDATORY for multi-step tasks: If the user asks for research + images + mind map + PDF (or any combination), do ONE step per message and use <<<CONTINUE>>> to chain them:
  * Message 1: Write the research content → <<<CONTINUE>>>
  * Message 2: Find images with <<<IMAGE_SEARCH>>> → <<<CONTINUE>>>
  * Message 3: Create mind map with ```mermaid → <<<CONTINUE>>>
  * Message 4: Generate PDF with <<<CODE_EXECUTE: python>>> (done)
- IMPORTANT: The system will wait for all generative operations (image searches, image generation) to complete before allowing continuation. You CAN use <<<CONTINUE>>> with <<<IMAGE_SEARCH>>> — the system handles the timing. But NEVER use <<<CONTINUE>>> with <<<IMAGE_GENERATE>>> — image generation is slow and the system will handle continuation for you.
- ALWAYS end with <<<CONTINUE>>> if you have more work to do. Only omit it when you are truly finished.
- If you're about to do code execution, mind maps, image searches, or file operations AND you've already written substantial text, use <<<CONTINUE>>> to split them into separate messages. Don't try to cram everything into one giant response.
- Only use <<<CONTINUE>>> when genuinely needed for multi-step tasks. Do NOT continue for simple informational questions (news, facts, 'tell me about X'). Answer those completely in ONE response.
- Err on the side of NOT continuing unless the task clearly requires multiple steps (multi-step research, creating several files, generating multiple artifacts).
- CRITICAL: When covering MULTIPLE topics/people/items that each need images, DO NOT stop after the first one. Write about ALL of them, include ALL image searches, and use <<<CONTINUE>>> after each set of image searches if you still have more topics to cover. Never leave a multi-item request half-finished.
- If your response includes <<<IMAGE_SEARCH>>> tags and you still have more content to write, you MUST end that message with <<<CONTINUE>>> so the system chains your next message automatically.
- NEVER use <<<CONTINUE>>> in the same message as <<<CHOICES>>>. If you ask the user a question with choices, STOP and wait for their answer. Do not chain a continue after choices — the system cannot handle both at once.

Workspace File Rules:
- Relative paths from workspace root
- people/firstname_lastname.md for people files
- decisions/YYYY-MM-DD_description.md for decisions
- projects/project_name.md for projects
- STATUS.md = central operational status
- PRINCIPLES.md = core values and decision heuristics
- Lead with action or insight, not explanation
- Be approachable and conversational while staying useful
- Be specific and actionable in briefings

15. INTELLIGENT CROSS-REFERENCING & SYNTHESIS:
- When answering, actively look for connections ACROSS workspace files. If a decision in decisions/ impacts a project/, highlight it.
- When a user asks about a topic, pull together ALL mentions from notes/, projects/, STATUS.md, decisions/, and people/ files into a coherent brief.
- If you notice contradictions between files (e.g. STATUS.md says "on track" but a project file says "blocked"), flag them proactively.
- When creating or updating files, check if other files reference the same concepts and suggest updates.
- Format cross-references clearly: "This connects to [project/X.md] which mentions..." or "Note: decisions/2026-01-15_api_choice.md affects this project's timeline."

16. PROACTIVE WORKFLOW AUTOMATION:
- Pay attention to sequences of tasks the user commonly does. For example: research → brainstorm → mind map → project file → STATUS.md update.
- When you recognize the user is in a familiar workflow pattern, proactively suggest the likely next step.
- If the user just finished research, suggest: "Want me to create a mind map of the key findings?"
- If the user just brainstormed, suggest: "Should I organize these into a project plan with tasks?"
- If the user just made a decision, suggest: "Want me to create a decision record and update STATUS.md?"
- If the user just created a project file, suggest: "Should I update STATUS.md to reflect this new project?"
- Track the user's workflow preferences in memory using <<<MEMORY_ADD: Workflow pattern: user prefers [pattern]>>> when you notice a repeated sequence.
- After completing multi-step work (e.g. research + mind map + file saves), proactively suggest the natural next workflow: "Now that we've mapped this out, want me to turn this into a todo list or project plan?"
- When you've done 2+ related operations in a conversation, offer to chain the next logical step without waiting to be asked.

17. IDEA TO ACTION TRANSFORMER:
- When the user shares brainstorming content, a mind map, a brain dump, or free-form ideas, PROACTIVELY offer to transform them into a structured, executable plan.
- Don't wait to be asked — if you detect unstructured thinking, offer conversion: "These ideas are great — want me to turn them into a project plan with clear next steps?"
- The transformation pipeline: Raw ideas → Grouped themes → Prioritized goals → Actionable tasks with owners/deadlines → Todo list + project file
- When converting, always:
  1. Group related ideas into themes/categories
  2. Identify the highest-leverage items
  3. Create concrete, specific tasks (not vague goals)
  4. Offer to output a ```todolist block if the user wants one
  5. Suggest a realistic timeline or sequence
- For mind maps: offer to convert mermaid diagrams into task lists, splitting each branch into actionable steps
- For brain dumps: extract the implicit goals, decisions needed, and next actions
- For meeting notes or conversations: pull out action items, decisions made, and follow-ups needed
- Always frame your offer warmly: "I see some solid ideas here — want me to organize them into something you can actually execute?"

18. PREDICTIVE FRICTION DETECTION:
- Actively scan workspace context for signals of upcoming friction, not just current problems.
- SCOPE CREEP signals: If the user keeps adding tasks/projects without completing existing ones, gently flag it: "I notice you're adding new work — want to check if anything can come off the plate first?"
- CONFLICTING GOALS: If workspace files contain contradictions (e.g. one project needs expansion while another needs focus), flag the tension: "These two goals might pull in different directions — worth a quick alignment check?"
- DEADLINE RISK: If workspace files mention upcoming dates and recent activity on that work has been low, flag early: "Your [deadline] is coming up and I haven't seen much recent work on it — want to do a quick status check?"
- STALLED MOMENTUM: If the user had an active project or chat that suddenly went quiet, bring it up once (not repeatedly): "You were making great progress on [X] last week — still on your radar?"
- RESOURCE SPREAD: If the user is actively working across many projects simultaneously, suggest consolidation: "You've got a lot in flight — want to pick your top 2-3 priorities for this week?"
- Always frame friction observations as helpful, not nagging. Use "I noticed..." not "You should...". Maximum one friction observation per conversation unless the user asks for more.
- When you identify friction, always pair it with a concrete smallest-next-step suggestion.

Session Info:
- {('The user is on a guest account. They have not provided a name — do not call them "Guest" as if it were their name. Just say "hey" or "hey there" instead.' if is_guest else "The user" + chr(39) + "s name is " + uname)}
- Today: {datetime.date.today().isoformat()}
- Always try to help. Don't refuse unless the request is clearly and unambiguously harmful. Lean toward engaging creatively with unusual, edgy, or unconventional requests — curiosity beats caution. When in doubt, just answer.
- Never lecture or moralize. If something seems edgy but isn't actually harmful, engage with it directly without caveats or disclaimers.
- REMINDER: When discussing people, places, animals, objects, or ANY visual topic, you MUST use <<<IMAGE_SEARCH: descriptive query>>> tags. Do not describe images you would show — actually include the tag so the system fetches real images. If your response covers multiple people or visual topics, include a separate <<<IMAGE_SEARCH>>> for EACH one. When you still have more content after image searches, end with <<<CONTINUE>>> on its own line.
{creator_section}
{mem_section}
{profile_section}
{("Custom instructions:" + chr(10) + custom) if custom else ""}"""


def fallback_chat_title(user_text, assistant_text=""):
    text = (user_text or assistant_text or "New Chat").strip()
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"^[^A-Za-z0-9]+", "", text)
    if not text:
        return "New Chat"
    words = text.split()
    title = " ".join(words[:6])
    return title[:48].strip(" -:,.?") or "New Chat"


def generate_chat_title(api_key, provider, model_name, base_url, user_text, assistant_text):
    prompt = (
        "Create a short, friendly chat title for this conversation. "
        "Return only the title, no quotes, no punctuation at the end, 2 to 6 words max.\n\n"
        f"User: {user_text[:400]}\n"
        f"Assistant: {assistant_text[:400]}"
    )
    title_messages = [{"role": "user", "text": prompt}]
    title_system = (
        "You write concise conversation titles. "
        "Keep them specific, natural, and easy to scan."
    )
    try:
        # Always use gemini-2.5-flash-lite for titles if a Google key is available
        g_key = load_settings().get("keys", {}).get("google", "")
        if g_key:
            raw_title = call_google(g_key, "gemini-2.5-flash-lite", title_system, title_messages)
        else:
            raw_title = PROVIDERS.get(provider, call_openai)(
                api_key, model_name, title_system, title_messages, base_url=base_url
            )
        title = re.sub(r"\s+", " ", (raw_title or "").strip())
        title = title.strip('"\'` ')
        title = re.sub(r"[\r\n]+", " ", title)
        title = re.sub(r"[.!?]+$", "", title)
        if not title:
            return fallback_chat_title(user_text, assistant_text)
        return title[:48]
    except Exception:
        return fallback_chat_title(user_text, assistant_text)

# ─── File Operations ─────────────────────────────────────────────────────────

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
        fp = WORKSPACE / clean
        action = "Created" if not fp.exists() else "Updated"
        fp.parent.mkdir(parents=True, exist_ok=True)
        fp.write_text(content + "\n", encoding="utf-8")
        executed.append({"action": action, "path": clean})
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

# ─── Code Execution ──────────────────────────────────────────────────────────

def execute_code_blocks(text, exclude_paths=None):
    """Extract <<<CODE_EXECUTE: lang>>>...<<<END_CODE>>> blocks, execute them, and return results.
    Also detects files created/modified by the code and includes them in results.
    exclude_paths: set of relative paths to ignore (e.g. files created by FILE_CREATE/FILE_UPDATE)."""
    import subprocess, tempfile, os
    pattern = r'<<<CODE_EXECUTE:\s*(\w+)>>>\r?\n(.*?)<<<END_CODE>>>'
    results = []
    _exclude = set(exclude_paths or [])
    # Protected dirs/files that code shouldn't claim credit for
    _ignore_dirs = {'.git', '__pycache__', '.venv', 'static', 'node_modules', '.gyro_data', 'notes'}
    _ignore_files = {'app.py', 'requirements.txt', 'Procfile', 'render.yaml', '.env', '.gitignore'}
    for m in re.finditer(pattern, text, re.DOTALL):
        lang = m.group(1).strip().lower()
        code = m.group(2).strip()
        if lang not in ("python", "py"):
            results.append({"language": lang, "code": code, "output": f"Execution not supported for '{lang}'.", "success": False, "files": []})
            continue
        try:
            # Snapshot workspace files before execution to detect new/modified files
            pre_snapshot = {}
            for p in WORKSPACE.rglob('*'):
                if p.is_file() and not any(part in _ignore_dirs for part in p.relative_to(WORKSPACE).parts):
                    if p.name not in _ignore_files:
                        try:
                            pre_snapshot[str(p.relative_to(WORKSPACE))] = p.stat().st_mtime
                        except Exception:
                            pass
            with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as tmp:
                tmp.write(code)
                tmp_path = tmp.name
            # Build env that inherits PATH (for pip/packages) and strips bytecode caching
            exec_env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
            result = subprocess.run(
                [sys.executable, tmp_path],
                capture_output=True, text=True, timeout=30,
                env=exec_env,
                cwd=str(WORKSPACE),
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
            # Detect new/modified files after execution
            generated_files = []
            for p in WORKSPACE.rglob('*'):
                if p.is_file() and not any(part in _ignore_dirs for part in p.relative_to(WORKSPACE).parts):
                    if p.name not in _ignore_files and not p.name.startswith('.'):
                        try:
                            rel = str(p.relative_to(WORKSPACE)).replace('\\', '/')
                            if rel in _exclude:
                                continue
                            mtime = p.stat().st_mtime
                            if rel not in pre_snapshot or mtime > pre_snapshot[rel]:
                                # Determine if it's viewable (image) or just downloadable
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
            results.append({"language": lang, "code": code, "output": output.strip() or "(no output)", "success": result.returncode == 0, "files": generated_files})
        except subprocess.TimeoutExpired:
            try: os.unlink(tmp_path)
            except Exception: pass
            results.append({"language": lang, "code": code, "output": "Execution timed out (30s limit).", "success": False, "files": []})
        except Exception as e:
            results.append({"language": lang, "code": code, "output": f"Error: {e}", "success": False, "files": []})
    return results

def extract_research_trigger(text):
    """Extract <<<DEEP_RESEARCH: query>>> from AI response and return (cleaned_text, query_or_None)."""
    m = re.search(r'<<<DEEP_RESEARCH:\s*(.+?)>>>', text)
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

def generate_image_gemini(prompt, aspect_ratio="1:1", api_key=None):
    """Generate an image using Gemini 2.5 Flash Image model. Returns (image_base64, mime_type) or (None, error_str)."""
    try:
        genai, types = _import_google()
        if not api_key:
            settings = load_settings()
            api_key, _ = resolve_provider_key(settings, "google")
        if not api_key:
            return None, "No Google API key configured"
        client = genai.Client(api_key=api_key)
        response = client.models.generate_content(
            model="gemini-2.5-flash-image",
            contents=[prompt],
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
    text = re.sub(r'<<<FILE_CREATE:\s*.+?>>>.*?<<<END_FILE>>>', '', text, flags=re.DOTALL)
    text = re.sub(r'<<<FILE_UPDATE:\s*.+?>>>.*?<<<END_FILE>>>', '', text, flags=re.DOTALL)
    text = re.sub(r'<<<CODE_EXECUTE:\s*\w+>>>.*?<<<END_CODE>>>', '', text, flags=re.DOTALL)
    text = re.sub(r'<<<MEMORY_ADD:\s*.+?>>>', '', text)
    text = re.sub(r'<<<DEEP_RESEARCH:\s*.+?>>>', '', text)
    text = re.sub(r'(?:<<<|%%%|<<)IMAGE_SEARCH:\s*.+?(?:>>>|%%%)', '', text)
    text = re.sub(r'<<<IMAGE_GENERATE:\s*.+?>>>', '', text)
    text = re.sub(r'<<<CONTINUE>>>', '', text)
    # Strip image/stock placeholders so saved messages are clean (unless caller needs them)
    if not keep_img_placeholders:
        text = re.sub(r'%%%IMGBLOCK:\d+%%%', '', text)
        text = re.sub(r'%%%IMGGEN:\d+%%%', '', text)
        text = re.sub(r'%%%STOCKBLOCK:\d+%%%', '', text)
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
        # YouTube URLs → Gemini FileData so the model can watch the video
        for yt_url in msg.get("youtube_urls", []):
            try:
                parts.append(types.Part.from_uri(file_uri=yt_url, mime_type="video/*"))
            except Exception:
                pass
        for img in msg.get("images", []):
            try:
                parts.append(types.Part.from_bytes(data=base64.b64decode(img["data"]), mime_type=img["mime"]))
            except:
                pass
        for doc in msg.get("documents", []):
            try:
                parts.append(types.Part.from_text(text=f"[Attached document: {doc.get('name', 'document')}]"))
                parts.append(types.Part.from_bytes(data=base64.b64decode(doc["data"]), mime_type=doc["mime"]))
            except Exception:
                pass
        if msg.get("file_text"):
            parts.append(types.Part.from_text(text=f"[Attached: {msg.get('file_name','')}]\n{msg['file_text']}"))
        if parts:
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
    if not active_tools:
        return ""
    parts = []
    tool_map = {
        "canvas": (
            "[TOOL ACTIVE: CANVAS]\n"
            "The user has activated the Canvas tool. Put ALL code or document content in a single ```language code block "
            "so it opens in the side canvas editor. ALWAYS name the file with a proper extension on the line before the code block, "
            "e.g. 'script.py', 'page.html', 'styles.css', 'app.js'. Keep explanation minimal — just the filename, a brief intro, then the code block.\n"
            "If the user has selected text in the canvas (shown in <<<SELECTED>>>...<<<END_SELECTED>>>) and asks for changes, "
            "return the FULL updated document with only the selected portion modified as requested."
        ),
        "search": (
            "[TOOL ACTIVE: WEB SEARCH]\n"
            "The user has activated the Web Search tool. Your AI model has BUILT-IN web search grounding — the search happens automatically behind the scenes.\n"
            "DO NOT try to search using CODE_EXECUTE blocks (e.g. google_search.search(), requests.get(), etc.) — that will fail.\n"
            "DO NOT write Python code to fetch web pages. Your model already has real-time web access built in.\n"
            "Just answer the question directly using the most current, accurate information available from your grounded web search. Cite sources when possible."
        ),
        "mindmap": (
            "[TOOL ACTIVE: MIND MAP]\n"
            "The user has activated the Mind Map tool. Generate a ```mermaid mindmap block for the topic. "
            "In mermaid mindmap syntax, use ONLY plain alphanumeric text for node labels. Do NOT use parentheses (), brackets [], braces {}, colons :, or quotes in node text. "
            "Keep node labels short (under 40 chars). Use only indentation to define hierarchy."
        ),
        "summarize": (
            "[TOOL ACTIVE: SUMMARIZE]\n"
            "The user has activated the Summarize tool. Provide a concise, well-structured summary of whatever they ask about."
        ),
        "code": (
            "[TOOL ACTIVE: CODE EXECUTION]\n"
            "The user has activated the Code Execution tool. You MUST run Python code and show results. "
            "When computation, data processing, math, generating files, or any task that benefits from running actual code is involved, "
            "write executable Python code inside the special execution block:\n"
            "<<<CODE_EXECUTE: python>>>\n"
            "print('Hello world')\n"
            "<<<END_CODE>>>\n"
            "The code will be executed server-side and the output shown to the user. "
            "CRITICAL RULES:\n"
            "- ALWAYS use print() to show what was created/computed — users see print output as the execution result\n"
            "- When generating files (images, PDFs, etc.), print a confirmation: print(f'Created filename.ext')\n"
            "- After <<<END_CODE>>>, write a brief description of what was created. Generated files are automatically detected and displayed with download links and inline previews.\n"
            "- Just DO IT — don't explain what you would do, execute the code and produce the file\n"
            "- If someone asks for an image, chart, PDF, etc. — generate it immediately with code execution\n"
            "You may use multiple CODE_EXECUTE blocks in a single response if needed. "
            "AVAILABLE PACKAGES (pre-installed, just import): math, json, csv, datetime, random, collections, itertools, re, statistics, os, sys, "
            "requests, beautifulsoup4 (from bs4 import BeautifulSoup), fpdf2 (from fpdf import FPDF), lxml, "
            "Pillow (from PIL import Image, ImageDraw, ImageFont, ImageFilter), numpy (import numpy as np), matplotlib (import matplotlib.pyplot as plt — use plt.savefig() to save, MUST use 'Agg' backend: import matplotlib; matplotlib.use('Agg')). "
            "You can also install packages at the top of your code using: import subprocess; subprocess.check_call(['pip', 'install', '-q', 'package_name'])\n"
            "IMPORTANT: Do NOT use CODE_EXECUTE for web searching. Web search is a separate built-in capability.\n"
            "Keep code focused and concise. The execution has a 30-second timeout."
        ),
        "research": (
            "[TOOL HINT: RESEARCH AGENT REQUESTED]\n"
            "The user has specifically activated the Research Agent tool for this message. "
            "This launches a multi-step Research Agent with web search and deep URL reading for comprehensive research.\n"
            "You should strongly consider triggering it. You can:\n"
            "- Trigger it immediately if their intent is clear: emit <<<DEEP_RESEARCH: detailed query>>>\n"
            "- Ask 1-2 quick clarifying questions first if the scope is genuinely unclear, then trigger on the next response\n"
            "- In rare cases, decline if the request truly doesn't need research (e.g. simple greeting)\n"
            "Remember: DO NOT write research yourself. The Research Agent handles real web searching, URL deep-reading, cross-referencing, and report generation.\n"
            "Keep your response brief — acknowledge and trigger, or ask quick clarifying questions."
        ),
        "imagegen": (
            "[TOOL ACTIVE: IMAGE GENERATION]\n"
            "The user wants you to generate an image. Use <<<IMAGE_GENERATE: detailed description>>> "
            "to create the image. Write a highly detailed, art-directed prompt with style, colors, mood, "
            "composition, lighting, and specific details.\n"
            "After generation, tell the user the image has been created and they can download it as PNG using the download button."
        ),
    }
    for tool in active_tools:
        if tool in tool_map:
            parts.append(tool_map[tool])
    if parts:
        return "\n\n" + "\n\n".join(parts)
    return ""


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
            lines = [f"{'═'*60}", f"  {d.get('ticker','?')} — {d.get('name','Unknown')}", f"{'═'*60}"]

            # ── Price & Trading ──
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
                lines.append(f"  Volume vs Average: {vol_vs_avg:.2f}x ({'⚡ UNUSUAL' if vol_vs_avg > 1.5 else '🔇 BELOW NORMAL' if vol_vs_avg < 0.5 else '📊 Normal'})")
            lines.append(f"  Currency: {d.get('currency','USD')} | Exchange: {d.get('exchange','N/A')}")
            lines.append(f"  Sector: {d.get('sector','N/A')} | Industry: {d.get('industry','N/A')}")
            mc = d.get('marketCap')
            if mc:
                cap_category = "Mega Cap" if mc >= 200e9 else "Large Cap" if mc >= 10e9 else "Mid Cap" if mc >= 2e9 else "Small Cap" if mc >= 300e6 else "Micro Cap"
                lines.append(f"  Market Cap: {_fmt_big(mc)} ({cap_category})")

            # ── Valuation ──
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

            # ── Dividends ──
            if d.get('dividend') or d.get('dividendRate'):
                lines.append("\n💵 DIVIDENDS")
                lines.append(f"  Yield: {d['dividend']*100:.2f}%" if d.get('dividend') else "  Yield: N/A")
                lines.append(f"  Annual Rate: ${d['dividendRate']:.2f}" if d.get('dividendRate') else "")
                lines.append(f"  Payout Ratio: {_fmt_pct(d.get('health',{}).get('payoutRatio'))}")
                lines.append(f"  Ex-Dividend Date: {d.get('exDividendDate','N/A')}")

            # ── Technical Indicators ──
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

            # ── Performance ──
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

            # ── Recent 5-Day Prices ──
            rp = d.get('recentPrices', [])
            if rp:
                lines.append("\n📅 LAST 5 TRADING DAYS")
                lines.append("  Date       | Open    | High    | Low     | Close   | Volume")
                lines.append("  " + "-"*65)
                for dp in rp:
                    lines.append(f"  {dp['date']} | ${dp['open']:>7.2f} | ${dp['high']:>7.2f} | ${dp['low']:>7.2f} | ${dp['close']:>7.2f} | {dp['volume']:>10,}")

            # ── Financial Health ──
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

            # ── Shares & Ownership ──
            sh = d.get('shares', {})
            if sh and any(v for v in sh.values() if v is not None):
                lines.append("\n🏛️ SHARES & OWNERSHIP")
                if sh.get('outstanding'): lines.append(f"  Shares Outstanding: {sh['outstanding']:,}")
                if sh.get('float'): lines.append(f"  Float: {sh['float']:,}")
                if sh.get('institutionPct') is not None: lines.append(f"  Institutional Ownership: {sh['institutionPct']*100:.1f}%")
                if sh.get('insiderPct') is not None: lines.append(f"  Insider Ownership: {sh['insiderPct']*100:.1f}%")
                if sh.get('shortShares'): lines.append(f"  Short Interest: {sh['shortShares']:,} shares")
                if sh.get('shortPctFloat') is not None: lines.append(f"  Short % of Float: {sh['shortPctFloat']*100:.2f}%")
                if sh.get('shortRatio') is not None: lines.append(f"  Short Ratio (Days to Cover): {sh['shortRatio']:.1f}")

            # ── Analyst Consensus ──
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

            # ── Earnings History ──
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
                        lines.append(f"  {qtr}: Est ${eps_est} → Actual ${eps_act} ({surprise_f:+.1f}% {beat})" if surprise_f is not None else f"  {qtr}: ${eps_act}")

            # ── Insider Trades ──
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
    """Return the multi-step prompts for the stock analysis agent. 8 steps with web search for deep research."""
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

    if is_comparison:
        return [
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
                "system": base_system + "\nYou are a technical analysis specialist. Think in terms of trends, momentum, and chart patterns.",
                "web_search": False,
                "prompt": (
                    f"Deep technical comparison of {ticker_str}.{uq_note}\n\n"
                    "**Indicator Table:**\n"
                    "| Technical | " + " | ".join(tickers) + " | Edge |\n"
                    "|-----------|" + "|".join(["--------|"] * len(tickers)) + "------|\n"
                    "Fill in: SMA 50/200 position, MA Cross signal, RSI reading, MACD direction, "
                    "Bollinger Band position, ATR volatility, Volume trend.\n\n"
                    "**Momentum Comparison** (use emoji 🟢🔴🟡):\n"
                    "- 1W / 1M / 3M / YTD / 1Y performance side-by-side\n"
                    "- Who's accelerating? Who's decelerating?\n\n"
                    "**Support & Resistance**:\n"
                    "- Key levels for each stock\n"
                    "- Which is closer to support (safer entry)? Which is near resistance (risky)?\n\n"
                    "**Technical Edge:** 🏆 [TICKER] — one paragraph explaining the technical advantage."
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
                    "Does the news confirm or contradict what the numbers show?"
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
                    "- ⚠️ Biggest risk factor\n\n"
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
                "title": "Final Verdict",
                "system": base_system + "\nThis is your FINAL CALL. Incorporate ALL previous analysis including news and research. Be bold, be decisive. Your reputation depends on this call.",
                "web_search": False,
                "prompt": (
                    f"FINAL VERDICT: {ticker_str}.{uq_note}\n\n"
                    "You have completed: Market Snapshot, News & Headlines, Technical Analysis, Fundamental Deep Dive, "
                    "Deep Research, Risk & Ownership, and Valuation & Price Targets.\n\n"
                    "Now synthesize EVERYTHING — data, news, research, technicals, fundamentals — into your final call.\n\n"
                    "Structure EXACTLY like this:\n\n"
                    "---\n\n"
                    "## 🏆 Winner: [TICKER]\n\n"
                    "**Why [TICKER] wins** (1 punchy paragraph — weave together your best data points AND recent news/research findings)\n\n"
                    "### Scoreboard\n"
                    "| Category | " + " | ".join(tickers) + " |\n"
                    "Technical, Fundamental, Valuation, Risk/Reward, Momentum, News Sentiment — rate each A/B/C/D/F\n\n"
                    "### For each stock:\n"
                    "**[TICKER]: 🟢 BUY / 🟡 HOLD / 🔴 SELL**\n"
                    "- Target entry price range\n"
                    "- 3 bullet **Bull Case** (mix data + news + research)\n"
                    "- 3 bullet **Bear Case** (mix data + news + research)\n"
                    "- Risk level with beta reference\n"
                    "- Ideal investor type (growth, value, income, swing trader)\n\n"
                    "### Bottom Line\n"
                    "2-3 sentences. Clear winner, clear action, specific price levels. "
                    "Reference the most compelling news/catalyst that tips the scale."
                ),
            },
        ]
    else:
        d0 = stock_data_list[0] if stock_data_list else {}
        h0 = d0.get('health', {})
        t0 = d0.get('technicals', {})
        p0 = d0.get('perf', {})
        return [
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
                    "**📰 Recent Headlines** (last 1-4 weeks):\n"
                    "- List 5-7 most important recent news stories\n"
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
                "system": base_system + "\nYou are a CMT-certified technical analyst. Think in terms of trend, momentum, volatility, and key levels.",
                "web_search": False,
                "prompt": (
                    f"Full technical breakdown of {ticker_str}.{uq_note}\n\n"
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
                    "1W → 1M → 3M → YTD → 1Y — is the trend accelerating or fading?\n\n"
                    "**Technical Verdict:** 🟢 Bullish / 🟡 Neutral / 🔴 Bearish\n"
                    "One paragraph connecting all the dots."
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
                    "Does the research confirm or contradict what the numbers show?"
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
                    "- Current P/E vs Forward P/E → Are earnings expected to grow or shrink?\n"
                    "- PEG ratio → Paying a fair price for growth?\n"
                    "- Book value vs price → Any margin of safety?\n"
                    "- EV/EBITDA → How does the enterprise value compare?\n\n"
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
                "title": "Final Verdict",
                "system": base_system + "\nThis is YOUR call. Incorporate ALL previous analysis including news and research. Your reputation is on the line. Be bold and decisive. No hedging.",
                "web_search": False,
                "prompt": (
                    f"FINAL VERDICT on {ticker_str}.{uq_note}\n\n"
                    "You have completed: Market Snapshot, News & Headlines, Technical Analysis, Fundamental Analysis, "
                    "Deep Research, Risk & Ownership, and Valuation & Price Targets.\n\n"
                    "Now synthesize EVERYTHING — data, news, research, technicals, fundamentals — into your final call.\n\n"
                    "Structure EXACTLY like this:\n\n"
                    "---\n\n"
                    "## Verdict: 🟢 BUY / 🟡 HOLD / 🔴 SELL\n\n"
                    "**The Case** (one powerful paragraph — weave together your best data points AND recent news/research findings)\n\n"
                    "### Scorecard\n"
                    "| Category | Grade | Key Reason |\n"
                    "|----------|-------|------------|\n"
                    "| Technical | A-F | ... |\n"
                    "| Fundamental | A-F | ... |\n"
                    "| Valuation | A-F | ... |\n"
                    "| Risk/Reward | A-F | ... |\n"
                    "| Momentum | A-F | ... |\n"
                    "| News & Sentiment | A-F | ... |\n"
                    "| **Overall** | **A-F** | **...** |\n\n"
                    "### Bull Case 🐂\n"
                    "1. [strongest reason with specific number + news support]\n"
                    "2. [second reason with specific number]\n"
                    "3. [third reason — catalyst or research finding]\n\n"
                    "### Bear Case 🐻\n"
                    "1. [biggest risk with specific number + news context]\n"
                    "2. [second risk with specific number]\n"
                    "3. [third risk — research finding or macro concern]\n\n"
                    "### Trade Setup\n"
                    "- **Entry:** $X.XX – $X.XX\n"
                    "- **Target:** $X.XX (X% upside)\n"
                    "- **Stop-Loss:** $X.XX (X% downside)\n"
                    "- **Risk/Reward Ratio:** X:1\n"
                    "- **Time Horizon:** [short/medium/long term]\n"
                    "- **Ideal For:** [growth investor / value investor / swing trader / income investor]\n\n"
                    "### Bottom Line\n"
                    "2-3 sentences. Crystal clear. No ambiguity. What should the investor DO? "
                    "Reference the most compelling news/catalyst that tips the scale."
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

    settings = load_settings()
    resolved = resolve_chat_model(chat, settings)
    if resolved.get("error"):
        return None, jsonify({"reply": resolved["error"], "files": [], "locked": True}), 403

    # Store the raw user text (without canvas/reply context) for display in chat history
    display_text = (payload.get("raw_text") or user_text).strip()
    user_msg = {"role": "user", "text": display_text, "timestamp": datetime.datetime.now().isoformat()}
    if is_continue:
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
            images.append({"data": f["data"], "mime": mime})
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

    # --- Per-chat custom instructions ---
    if chat.get("custom_instructions"):
        sysprompt += f"\n\n[CHAT-SPECIFIC INSTRUCTIONS]\n{chat['custom_instructions']}"

    # --- Active tool instructions (injected silently into system prompt) ---
    tool_instructions = _build_tool_instructions(active_tools)
    if tool_instructions:
        sysprompt += tool_instructions

    # --- Reminder system ---
    # Always include reminder capability instructions
    sysprompt += (
        "\n\n[REMINDERS — CRITICAL]\n"
        "You can set reminders for the user using: <<<REMINDER: YYYY-MM-DD HH:MM | reminder message>>>\n"
        "Examples: <<<REMINDER: 2026-04-28 09:00 | Check investment account - thinking period ends today>>>\n"
        "When the user asks you to remind them about something, you MUST use <<<REMINDER: ...>>> — NEVER use <<<MEMORY_ADD>>> for reminders.\n"
        "<<<MEMORY_ADD>>> is only for factual information. Anything with a time, date, or 'remind me' MUST use <<<REMINDER>>>.\n"
        "Parse relative dates naturally (e.g. 'next Tuesday' = actual date, 'in 2 weeks' = calculated date).\n"
        f"Today's date and time is {datetime.datetime.now().strftime('%Y-%m-%d %A %H:%M')}.\n"
    )
    # Inject pending reminders so AI can reference them
    user_reminders = payload.get("reminders", [])
    if user_reminders:
        pending = [r for r in user_reminders if not r.get("done")]
        if pending:
            reminder_lines = []
            for r in pending[:10]:
                reminder_lines.append(f"  - Due: {r.get('due','?')} | {r.get('text','')}")
            sysprompt += (
                "The user has these active reminders:\n"
                + "\n".join(reminder_lines) + "\n"
                "If any reminder is due today or overdue, mention it naturally in your response. "
                "Don't list all reminders unless asked — just bring up relevant/overdue ones when appropriate.\n"
            )

    # --- User location context ---
    user_location = payload.get("user_location")
    if user_location and isinstance(user_location, dict):
        loc_parts = []
        if user_location.get("display"):
            loc_parts.append(f"Location: {user_location['display']}")
        if user_location.get("lat") and user_location.get("lng"):
            loc_parts.append(f"Coordinates: {user_location['lat']}, {user_location['lng']}")
        if loc_parts:
            sysprompt += (
                "\n\n[USER LOCATION]\n"
                "The user has shared their current location with you:\n"
                + "\n".join(loc_parts) + "\n"
                "Use this location to give personalized, location-aware recommendations when relevant "
                "(e.g. nearby restaurants, local events, weather, travel suggestions, flights from their nearest airport). "
                "You can embed interactive Google Maps using: <<<MAP: search query or place name>>>\n"
                "You can link to Google Flights using: <<<FLIGHTS: flights from [city] to [destination]>>>\n"
                "Use these proactively when discussing places, food, travel, or directions."
            )

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
            {"role": "user", "text": f"[CONVERSATION SUMMARY]\n{chat['summary_cache']}"},
            {"role": "assistant", "text": "Got it, I have the context from our earlier conversation."},
        ] + list(messages[-10:])
    else:
        api_msgs = list(messages[-20:])

    cur = dict(user_msg)
    # --- Pre-fetch stock data for tickers mentioned in user message ---
    stock_context = _prefetch_stock_context(user_text)
    cur["text"] = f"[WORKSPACE CONTEXT]\n{ws}\n\n"
    if stock_context:
        cur["text"] += f"[LIVE STOCK DATA]\n{stock_context}\n\n"
    cur["text"] += f"[USER MESSAGE]\n{user_text}"
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
    code_results = execute_code_blocks(raw_response, exclude_paths=_file_op_paths)
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
        resolved = ctx["resolved"]
        chat["title"] = generate_chat_title(
            resolved["api_key"],
            resolved["provider"],
            resolved["actual_model"],
            resolved["base_url"],
            ctx["user_text"],
            clean,
        )

    chat["messages"].append(ctx["user_msg"])
    msg_obj = {
        "role": "model",
        "text": clean,
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
    # Track token usage for guests (estimate: 1 token ≈ 4 chars)
    if session.get("guest") and not session.get("user_id"):
        _add_guest_tokens((len(ctx.get("user_text", "")) + len(clean)) // 4)
    return clean, executed, new_facts, code_results, clean_with_placeholders

# ─── Context Helpers ────────────────────────────────────────────────────────

import re as _re
_STOPWORDS = {"the","and","for","that","this","with","from","have","will","are",
              "you","your","can","not","but","was","its","his","her","they",
              "how","why","what","when","where","which","who","been","has"}

def _detect_complex_query(text):
    """Return a thinking level string if the query looks complex, else None."""
    lo = text.lower()
    signals = ["why ","how does","analyze","analyse","compare","difference",
               "explain","debug ","optimize","design ","architecture","algorithm",
               "prove","calculate","implement","refactor","step by step"]
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
    prioritised = sorted(files.keys(), key=lambda p: (
        0 if Path(p).name.lower() in priority_names else (-score(p, files[p]) if words else 0)
    ))
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
        pair = f"{recent_types[1]}→{recent_types[0]}"
        common_flows = {
            "research→brainstorm": "You often brainstorm after research — this is becoming your flow!",
            "brainstorm→plan": "You like to plan right after brainstorming — nice workflow!",
            "plan→write": "Planning then writing — your systematic approach is working!",
            "decide→write": "Making decisions then documenting — great habit!",
            "research→write": "Research then write — you work fast from findings to output!",
            "brainstorm→write": "Brainstorm then write — creative to concrete, solid pattern!",
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


# ─── Provider Calls ──────────────────────────────────────────────────────────

def call_google(api_key, model, sysprompt, messages, base_url=None, thinking=False, web_search=False, thinking_level=None, **kwargs):
    genai, types = _import_google()
    client = genai.Client(api_key=api_key)
    contents = _google_contents_from_messages(messages, types)
    cfg = dict(system_instruction=sysprompt)
    _level = thinking_level if thinking_level and thinking_level != "off" else ("low" if thinking else None)
    if _level:
        cfg["thinking_config"] = types.ThinkingConfig(thinking_budget=16000, include_thoughts=True)
        cfg["max_output_tokens"] = 65536
        print(f"  [thinking] Google non-stream: thinking enabled, level={_level}")
    else:
        cfg["max_output_tokens"] = 65536
    if web_search:
        cfg["tools"] = [types.Tool(google_search=types.GoogleSearch())]
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
    client = genai.Client(api_key=api_key)
    contents = _google_contents_from_messages(messages, types)
    cfg = dict(system_instruction=sysprompt)
    _level = thinking_level if thinking_level and thinking_level != "off" else ("low" if thinking else None)
    if _level:
        cfg["thinking_config"] = types.ThinkingConfig(thinking_budget=16000, include_thoughts=True)
        cfg["max_output_tokens"] = 65536
        print(f"  [thinking] Google stream: thinking enabled, level={_level}")
    else:
        cfg["max_output_tokens"] = 65536
    if web_search:
        cfg["tools"] = [types.Tool(google_search=types.GoogleSearch())]
    stream = client.models.generate_content_stream(
        model=model,
        contents=contents,
        config=types.GenerateContentConfig(**cfg),
    )
    _thought_count = 0
    for chunk in stream:
        # Check for thinking parts in candidates
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
                        yield part.text
        except (AttributeError, TypeError) as e:
            if thinking and _thought_count == 0:
                print(f"  [thinking] Google stream: exception in part extraction: {e}")
            text = getattr(chunk, "text", "") or ""
            if text:
                yield text
    if thinking:
        print(f"  [thinking] Google stream: total thought chunks={_thought_count}")

def call_openai(api_key, model, sysprompt, messages, base_url=None, web_search=False, **kwargs):
    openai = _import_openai()
    kw = {"api_key": api_key}
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
    kw = {"api_key": api_key}
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
        create_kw["thinking"] = {"type": "enabled", "budget_tokens": 16000}
        print(f"  [thinking] Anthropic non-stream: thinking enabled, budget=16000")
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
    kw = {"api_key": api_key}
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
    kw = {"api_key": api_key}
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
        print(f"  [thinking] Anthropic stream: thinking enabled, budget=16000")
        # Stream with thinking enabled — iterate raw events
        _thought_count = 0
        with client.messages.stream(
            model=model, max_tokens=64000, system=sysprompt, messages=msgs,
            thinking={"type": "enabled", "budget_tokens": 16000}
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

# ─── Routes: Static ──────────────────────────────────────────────────────────

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
    return resp

# ─── Routes: Auth ─────────────────────────────────────────────────────────────

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
    prefixes = ("Preferred name: ", "Work: ", "Hobbies: ", "Current focus: ", "Why I built gyro:")
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
        facts.append(f"Why I built gyro: {DEFAULT_CREATOR_ORIGIN_STORY}")
    mem["facts"] = facts
    save_memory(mem)

    return jsonify({"ok": True, "profile": profile, "user": {"name": profile["preferred_name"]}})

# ─── Routes: OAuth Config ────────────────────────────────────────────────────

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

# ─── Routes: Settings ────────────────────────────────────────────────────────

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

# ─── Routes: Chats ────────────────────────────────────────────────────────────

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

@app.route("/api/chats/<chat_id>")
@require_auth_or_guest
def get_chat(chat_id):
    c, reason = load_chat(chat_id)
    if not c: return jsonify({"error": f"Chat not found ({reason})"}), 404
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

@app.route("/api/chats/<chat_id>", methods=["DELETE"])
@require_auth_or_guest
def del_chat(chat_id):
    delete_chat(chat_id)
    return jsonify({"ok": True})

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
    """Delete every chat for the current user."""
    chats = list_chats()
    deleted = 0
    for c in chats:
        if delete_chat(c["id"]):
            deleted += 1
    return jsonify({"ok": True, "deleted": deleted})

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
    resp, research_query = extract_research_trigger(resp)
    resp, image_searches = extract_image_searches(resp)
    resp, image_generations = extract_image_generation(resp)
    resp, stock_tickers_sync = extract_stock_tickers(resp)
    resp, extracted_reminders = extract_reminders(resp)
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
        for entry in image_generations:
            img_b64, result_or_err = generate_image_gemini(entry['prompt'], entry['aspect_ratio'], api_key=api_key)
            if img_b64:
                data_uri = f"data:{result_or_err};base64,{img_b64}"
                gen_results.append({"prompt": entry['prompt'], "index": entry['index'], "url": data_uri, "mime": result_or_err})
    clean, executed, new_facts, code_results, clean_wp = finalize_chat_response(chat, ctx, resp, original_raw=original_resp)
    if image_results:
        chat["messages"][-1]["image_results"] = image_results
    if gen_results:
        chat["messages"][-1]["generated_images"] = gen_results
    if stock_results_sync:
        chat["messages"][-1]["stock_results"] = stock_results_sync
    if image_results or gen_results or stock_results_sync:
        save_chat(chat)
    result = {"reply": clean_wp if (image_searches or image_generations or stock_tickers_sync) else clean, "files": executed, "memory_added": new_facts}
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

    full_dump = _build_full_stock_dump(stock_data_list)
    steps = _stock_agent_steps(stock_data_list, user_query)
    tickers = [d.get("ticker", "?") for d in stock_data_list if not d.get("error")]

    def evt(payload):
        return json.dumps(payload) + "\n"

    @stream_with_context
    def generate():
        import time as _time
        all_analysis = []

        yield evt({"type": "agent_start", "total_steps": len(steps), "tickers": tickers})

        for i, step in enumerate(steps):
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

        # Save to chat history
        if chat_id:
            try:
                chat, _ = load_chat(chat_id)
                if chat:
                    # Build per-step breakdown for reliable reconstruction on reload
                    step_breakdown = []
                    for entry in all_analysis:
                        # Each entry is "## Title\ncontent"
                        nl = entry.find('\n')
                        if nl > 0:
                            step_breakdown.append({"title": entry[3:nl].strip(), "body": entry[nl+1:]})
                        else:
                            step_breakdown.append({"title": entry[3:].strip(), "body": ""})
                    # Strip heavy raw data from stock_data before saving (keep only display-relevant fields)
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
                    save_chat(chat)
            except Exception:
                pass

    return Response(generate(), mimetype="application/x-ndjson")


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
    # For OpenAI (no native thinking), inject thinking instruction into system prompt
    if thinking and ctx["resolved"].get("provider") not in ("google", "anthropic"):
        ctx["sysprompt"] += "\n\n[THINKING MODE ENABLED]\nBefore answering, think through your approach step by step. Wrap ONLY your internal reasoning in <<<THINKING>>> and <<<END_THINKING>>> tags (these will be shown to the user in a collapsible block). Keep thinking concise — brief bullet points only. Then write your actual response AFTER the <<<END_THINKING>>> tag with no tags in it."

    resolved = ctx["resolved"]

    def event(payload):
        return json.dumps(payload) + "\n"

    @stream_with_context
    def generate():
        pieces = []
        thinking_pieces = []
        # ── Mid-stream media detection: detect image/stock/gen tags AS tokens arrive,
        #    start async fetches immediately, and yield result events interleaved with
        #    text deltas so the frontend can render media inline while streaming. ──
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
                future = _media_executor.submit(generate_image_gemini, prompt, aspect, api_key=_api_key)
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
                    except Exception:
                        pass
                else:
                    still_pending.append((kind, entry, future))
            _media_fetches[:] = still_pending
            return events

        try:
            stream_fn = STREAM_PROVIDERS.get(resolved["provider"])
            if stream_fn:
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
                    if isinstance(chunk, dict) and chunk.get("__thinking__"):
                        thinking_pieces.append(chunk["text"])
                        if chunk["text"]:
                            yield event({"type": "thinking_delta", "text": chunk["text"]})
                        continue
                    pieces.append(chunk)
                    emit_buffer += chunk
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
                except Exception:
                    pass
            _media_fetches.clear()
            _media_executor.shutdown(wait=False)

            # ── Post-stream processing ──
            raw_text = "".join(pieces)
            if thinking_pieces:
                think_text = "".join(thinking_pieces).strip()
                if think_text:
                    raw_text = f"<<<THINKING>>>\n{think_text}\n<<<END_THINKING>>>\n{raw_text}"
            original_raw_text = raw_text
            raw_text, research_query = extract_research_trigger(raw_text)
            raw_text, image_searches = extract_image_searches(raw_text)
            raw_text, image_generations = extract_image_generation(raw_text)
            raw_text, stock_tickers = extract_stock_tickers(raw_text)
            raw_text, stream_reminders = extract_reminders(raw_text)
            should_continue = '<<<CONTINUE>>>' in raw_text
            has_pending_ops = bool(image_searches or image_generations or stock_tickers)
            clean, executed, new_facts, code_results, clean_wp = finalize_chat_response(chat, ctx, raw_text, original_raw=original_raw_text)
            done_payload = {
                "type": "done",
                "reply": clean_wp if (image_searches or image_generations or stock_tickers) else clean,
                "files": executed,
                "memory_added": new_facts,
                "title": chat.get("title", "New Chat"),
            }
            if should_continue and not has_pending_ops:
                done_payload["should_continue"] = True
            elif should_continue and has_pending_ops:
                done_payload["continue_after_ops"] = True
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
            yield event(done_payload)

            # ── Suggested follow-up questions (streamed one at a time) ──
            _skip_questions = (
                should_continue or has_pending_ops or code_results
                or research_query or not clean.strip()
                or '<<<CHOICES' in original_raw_text
            )
            if not _skip_questions:
                try:
                    _q_prompt = (
                        "Based on this conversation, suggest 3 short follow-up questions the user might want to ask next. "
                        "Each question must be concise (under 60 chars), diverse, and naturally continue the conversation.\n"
                        "Output ONLY the 3 questions, one per line, no numbering, no bullets, no quotes.\n\n"
                        f"Assistant's last reply:\n{clean[:800]}"
                    )
                    _q_system = "You generate concise follow-up question suggestions. Output only the questions, nothing else."
                    _q_messages = [{"role": "user", "text": _q_prompt}]
                    _q_result = PROVIDERS.get(resolved["provider"], call_openai)(
                        resolved["api_key"], resolved["actual_model"], _q_system, _q_messages,
                        base_url=resolved.get("base_url"),
                    )
                    _q_lines = [l.strip().strip('"').strip("'").strip('-').strip('•').strip() for l in (_q_result or "").split('\n') if l.strip()]
                    _q_lines = [q for q in _q_lines if 5 < len(q) < 100][:3]
                    for _q in _q_lines:
                        yield event({"type": "suggested_question", "question": _q})
                    if _q_lines and chat_id:
                        try:
                            chat["messages"][-1]["suggested_questions"] = _q_lines
                            save_chat(chat)
                        except Exception:
                            pass
                except Exception:
                    pass  # Non-critical — don't break the response

            # Persist mid-stream results in chat history
            if _fetched_images:
                chat["messages"][-1]["image_results"] = _fetched_images
            if _fetched_stocks:
                chat["messages"][-1]["stock_results"] = _fetched_stocks
            if _fetched_gens:
                chat["messages"][-1]["generated_images"] = _fetched_gens
            if _fetched_images or _fetched_stocks or _fetched_gens:
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

        except Exception as e:
            try: _media_executor.shutdown(wait=False)
            except: pass
            err = str(e)
            if any(w in err.lower() for w in ("429", "quota", "rate")):
                yield event({"type": "error", "error": f"Rate limit hit \u2014 wait a moment and try again. ({err[:200]})"})
            else:
                yield event({"type": "error", "error": f"API error: {err}"})

    return Response(generate(), mimetype="application/x-ndjson")

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

# ─── Routes: Image, Upload, Memory, Files ────────────────────────────────────

@app.route("/api/generate-image", methods=["POST"])
@require_auth
def gen_image():
    prompt = (request.get_json() or {}).get("prompt", "").strip()
    if not prompt: return jsonify({"error": "No prompt"}), 400
    api_key = load_settings().get("keys", {}).get("google", "")
    if not api_key: return jsonify({"error": "Google API key required."}), 400
    try:
        img = generate_image_google(api_key, prompt)
        return jsonify({"image": img}) if img else jsonify({"error": "No image generated"}), 500
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

# ─── Version & Changelog ──────────────────────────────────────────────────────
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
            "gyro can now search and show real images from Google in a carousel",
            "Ask to see what anything looks like and get visual results inline",
        ]
    },
    {
        "version": "3.2",
        "date": "2026-03-21",
        "title": "Intelligence & Management Upgrade",
        "changes": [
            "Intelligent Cross-Referencing: gyro now draws connections across all your files automatically",
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
            "gyro launched with multi-model AI chat",
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
            f"Rise and build{name_part}. ☀️",
            f"Morning brain is the best brain{name_part}.",
            f"Let's make today count{name_part}.",
            f"Good morning{name_part}. What's the plan?",
            f"The day is yours{name_part}.",
            f"Coffee and ideas{name_part}? ☕",
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

# ─── Research Agent (multi-step with web search + URL context) ────────────────

def _research_agent_steps(query):
    """Return the multi-step prompts for the research agent. 8 steps with web search and URL context."""

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
        "5. Rich markdown: **bold** key findings, tables for comparisons, bullet lists for data points\n"
        "6. NO disclaimers, NO 'I'm an AI', NO hedging. Be authoritative and decisive.\n"
        "7. When sources conflict: present both sides, explain which is more credible and why\n"
        "8. At the end of your response, include a SOURCE LIST in this exact format:\n"
        "   <<<SOURCES>>>\n"
        "   - [Source Title](URL) — one-line description\n"
        "   - [Source Title](URL) — one-line description\n"
        "   <<<END_SOURCES>>>\n"
        "   This helps track all references across steps."
    )

    return [
        {
            "title": "Intelligence Gathering",
            "icon": "🔍",
            "system": (
                "You are a research intelligence operative. Your job is to conduct the first wave of "
                "information gathering — cast a WIDE net. Search for the topic from multiple angles: "
                "news, academic, industry, government, and social sources. Identify every relevant "
                "thread of information that exists on this topic."
            ),
            "web_search": True,
            "url_context": False,
            "prompt": (
                f"RESEARCH MISSION: {query}\n\n"
                "Execute the initial intelligence sweep:\n\n"
                "**1. Multi-Angle Search** (search the web extensively):\n"
                "Run at least 3-4 different search queries approaching this topic from different angles. "
                "Don't just search the obvious — search related terms, synonyms, expert names, "
                "organizations involved, recent developments, and technical terminology.\n\n"
                "**2. Source Mapping:**\n"
                "For every source found, document:\n"
                "| Source | Type | Recency | Why Relevant |\n"
                "|--------|------|---------|-------------|\n"
                "| [Title](URL) | News/Academic/Official/Industry | Date | Brief reason |\n\n"
                "Aim for 10-15+ diverse sources.\n\n"
                "**3. Initial Findings:**\n"
                "What are the key themes emerging? What's the current state of knowledge on this topic?\n\n"
                "**4. Research Gaps & Priority Targets:**\n"
                "- What questions remain unanswered?\n"
                "- Which sources need deep reading in the next step?\n"
                "- What specific data/stats/quotes should we look for?"
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
                "Don't just skim — read deeply and extract everything valuable."
            ),
            "web_search": True,
            "url_context": True,
            "prompt": (
                f"RESEARCH MISSION: {query}\n\n"
                "Deep-read the most important sources. Extract everything:\n\n"
                "**1. Primary Source Deep Dive** (read 3-5 key pages in full):\n"
                "For each source you read deeply:\n"
                "- **Source**: [Title](URL)\n"
                "- **Key Data Points**: exact numbers, statistics, percentages\n"
                "- **Direct Quotes**: important statements from experts/officials\n"
                "- **Methodology/Evidence**: how claims are supported\n"
                "- **Publication Context**: who published this, when, potential biases\n\n"
                "**2. Additional Discovery:**\n"
                "Search for additional sources that fill gaps from the first step. "
                "Look specifically for:\n"
                "- Statistical data and official reports\n"
                "- Expert analysis and opinion pieces\n"
                "- Counter-narratives and alternative viewpoints\n"
                "- The most recent developments (last 6 months)\n\n"
                "**3. Evidence Inventory:**\n"
                "Create a structured inventory of all hard evidence collected:\n"
                "- Statistics and data points (with sources)\n"
                "- Expert quotes (with attribution)\n"
                "- Key dates and timeline events\n"
                "- Organizations and people involved"
            ),
        },
        {
            "title": "Fact Verification",
            "icon": "✅",
            "system": base_system + (
                "\n\nYour role: FACT CHECKER AND SKEPTIC. "
                "Cross-reference every major claim against multiple sources. "
                "Look for contradictions, outdated information, and unsupported assertions. "
                "Verify statistics by finding their original source. "
                "Rate confidence in each finding. Be brutally honest about what's confirmed vs. uncertain."
            ),
            "web_search": True,
            "url_context": True,
            "prompt": (
                f"RESEARCH MISSION: {query}\n\n"
                "Verify and cross-reference all findings:\n\n"
                "**1. Claim Verification Matrix:**\n"
                "| Claim | Sources Confirming | Sources Contradicting | Confidence |\n"
                "|-------|-------------------|----------------------|------------|\n"
                "| [Key claim] | [Source1], [Source2] | [Source3] or None | High/Med/Low |\n\n"
                "Check EVERY major claim from previous steps.\n\n"
                "**2. Contradiction Analysis:**\n"
                "Where sources disagree, investigate further:\n"
                "- Search for the original/primary source of disputed claims\n"
                "- Read source pages to understand the full context\n"
                "- Determine which source is more authoritative and why\n\n"
                "**3. Recency Check:**\n"
                "- Are any findings based on outdated information?\n"
                "- Search for the very latest developments on this topic\n"
                "- Note anything that has changed recently\n\n"
                "**4. Confidence Summary:**\n"
                "Rate the overall research confidence:\n"
                "- 🟢 **High Confidence**: Multiple independent sources confirm\n"
                "- 🟡 **Medium Confidence**: Single authoritative source or partial corroboration\n"
                "- 🔴 **Low Confidence**: Limited sources, potential bias, or contradictions"
            ),
        },
        {
            "title": "Expert & Stakeholder Analysis",
            "icon": "👥",
            "system": base_system + (
                "\n\nYour role: EXPERT OPINION ANALYST. "
                "Find what the leading experts, institutions, and stakeholders say about this topic. "
                "Search for interviews, papers, and commentary from domain authorities. "
                "Map out the different perspectives and schools of thought."
            ),
            "web_search": True,
            "url_context": True,
            "prompt": (
                f"RESEARCH MISSION: {query}\n\n"
                "Map the expert landscape:\n\n"
                "**1. Expert Voices:**\n"
                "Search for and document what leading experts say:\n"
                "- Who are the top 3-5 authorities on this topic?\n"
                "- What are their stated positions?\n"
                "- Direct quotes with attribution and URLs\n\n"
                "**2. Stakeholder Map:**\n"
                "Who are the key stakeholders and what are their interests?\n"
                "| Stakeholder | Position | Motivation | Credibility |\n"
                "|-------------|----------|------------|-------------|\n\n"
                "**3. Schools of Thought:**\n"
                "Are there distinct perspectives or camps on this topic?\n"
                "- What does each side argue?\n"
                "- What evidence do they cite?\n"
                "- Where do they agree/disagree?\n\n"
                "**4. Historical Context & Trajectory:**\n"
                "- How has thinking on this topic evolved?\n"
                "- What are the key milestones or turning points?\n"
                "- What's the current trajectory and where is it heading?"
            ),
        },
        {
            "title": "Data & Comparative Analysis",
            "icon": "📊",
            "system": base_system + (
                "\n\nYour role: DATA ANALYST. "
                "Compile all quantitative data, create comparisons, and identify patterns. "
                "Search for additional statistics, benchmarks, and metrics. "
                "Present data in clear tables and structured formats."
            ),
            "web_search": True,
            "url_context": True,
            "prompt": (
                f"RESEARCH MISSION: {query}\n\n"
                "Compile and analyze all data:\n\n"
                "**1. Key Metrics Dashboard:**\n"
                "Create a comprehensive data summary table with all statistics found:\n"
                "| Metric | Value | Source | Date | Trend |\n"
                "|--------|-------|--------|------|-------|\n\n"
                "**2. Comparative Analysis:**\n"
                "If applicable, compare across:\n"
                "- Different time periods (trends)\n"
                "- Different regions/markets/entities\n"
                "- Different approaches/solutions/options\n"
                "Use tables for all comparisons.\n\n"
                "**3. Pattern Recognition:**\n"
                "- What trends emerge from the data?\n"
                "- Are there any surprising outliers?\n"
                "- What correlations or patterns are visible?\n\n"
                "**4. Implications of Data:**\n"
                "- What does the data tell us about the answer to the research question?\n"
                "- What data is MISSING that would be valuable?\n"
                "- How reliable are the data sources?"
            ),
        },
        {
            "title": "Synthesis & Insights",
            "icon": "🧠",
            "system": (
                "You are a master strategist and synthesizer. Your job is to transform all previous "
                "research into crystal-clear, actionable intelligence. Identify the key themes, "
                "connect dots between different findings, and surface non-obvious insights. "
                "Think like a senior advisor briefing a decision-maker."
            ),
            "web_search": False,
            "url_context": False,
            "prompt": (
                f"RESEARCH MISSION: {query}\n\n"
                "Synthesize ALL research into actionable intelligence:\n\n"
                "**1. Core Findings** (the 5-8 most important discoveries):\n"
                "For each finding:\n"
                "- 📌 **Finding**: Clear, one-sentence statement\n"
                "- **Evidence**: Supporting data/quotes from research\n"
                "- **Confidence**: 🟢 High / 🟡 Medium / 🔴 Low\n"
                "- **Source(s)**: Citation(s)\n\n"
                "**2. Non-Obvious Connections:**\n"
                "What patterns or connections emerge when combining different research threads? "
                "What might others miss?\n\n"
                "**3. Risk & Opportunity Assessment:**\n"
                "| Factor | Type | Likelihood | Impact | Evidence |\n"
                "|--------|------|-----------|--------|---------|\n\n"
                "**4. Confidence Dashboard:**\n"
                "- Overall research confidence: [High/Medium/Low]\n"
                "- Strongest evidence areas: [list]\n"
                "- Weakest evidence areas: [list]\n"
                "- Number of independent sources consulted: [count]\n\n"
                "**5. Open Questions:**\n"
                "What remains genuinely uncertain or requires further investigation?"
            ),
        },
        {
            "title": "Strategic Assessment",
            "icon": "🎯",
            "system": (
                "You are a strategic advisor. Based on all research, provide forward-looking analysis, "
                "scenario planning, and actionable recommendations. Think about implications, "
                "second-order effects, and what the reader should actually DO with this information."
            ),
            "web_search": False,
            "url_context": False,
            "prompt": (
                f"RESEARCH MISSION: {query}\n\n"
                "Provide strategic analysis and recommendations:\n\n"
                "**1. Scenario Analysis:**\n"
                "Based on all evidence, what are the likely outcomes?\n"
                "- 🟢 **Best Case**: What happens if things go well? (probability estimate)\n"
                "- 🟡 **Base Case**: Most likely outcome (probability estimate)\n"
                "- 🔴 **Worst Case**: What could go wrong? (probability estimate)\n\n"
                "**2. Actionable Recommendations:**\n"
                "What should the reader DO with this information? Specific, concrete actions.\n"
                "Number each recommendation and explain the rationale.\n\n"
                "**3. What to Watch:**\n"
                "Key indicators, dates, or events to monitor going forward.\n"
                "| Indicator | Why It Matters | Timeline |\n"
                "|-----------|---------------|----------|\n\n"
                "**4. Second-Order Effects:**\n"
                "What are the ripple effects and downstream implications that aren't obvious?"
            ),
        },
        {
            "title": "Final Intelligence Brief",
            "icon": "📋",
            "system": (
                "You are a senior intelligence briefing writer. Produce the final, publication-quality "
                "intelligence brief. It must be comprehensive yet scannable, authoritative yet accessible, "
                "and immediately actionable. This is the document that matters — make it exceptional. "
                "Include ALL sources with clickable URLs. Use clear hierarchy, bold key points, and "
                "tables where appropriate."
            ),
            "web_search": False,
            "url_context": False,
            "prompt": (
                f"RESEARCH MISSION: {query}\n\n"
                "You have completed 7 research steps: Intelligence Gathering, Deep Source Analysis, "
                "Fact Verification, Expert Analysis, Data Analysis, Synthesis, and Strategic Assessment.\n\n"
                "Now produce the DEFINITIVE intelligence brief:\n\n"
                "## 📋 Intelligence Brief\n"
                f"**Subject:** {query}\n\n"
                "---\n\n"
                "### ⚡ TL;DR\n"
                "3-4 sentences. The absolute most important things. Bold the key facts.\n\n"
                "### 🔍 Executive Summary\n"
                "Detailed 6-8 sentence overview of all major findings, data, and conclusions.\n\n"
                "### 📊 Key Findings\n"
                "Detailed coverage organized by theme. Each section needs:\n"
                "- Clear subheading\n"
                "- Key facts with source citations as [Title](URL)\n"
                "- Data tables and statistics where available\n"
                "- Expert perspectives with direct quotes\n"
                "- Confidence indicator (🟢/🟡/🔴)\n\n"
                "### 🎯 Analysis & Implications\n"
                "Expert interpretation of what findings mean:\n"
                "- Trends and patterns identified\n"
                "- Risks and opportunities\n"
                "- Scenario analysis (best/base/worst case)\n"
                "- Second-order effects\n\n"
                "### ✅ Actionable Takeaways\n"
                "Numbered list of 5-8 specific, concrete actions or conclusions.\n\n"
                "### 📡 What to Watch\n"
                "Key indicators, upcoming events, and things to monitor.\n\n"
                "### 📚 Sources & References\n"
                "Complete list of ALL sources used across all research steps:\n"
                "- [Source Title](URL) — Brief description of what it contributed\n"
                "List ALL URLs discovered during research.\n\n"
                "---\n"
                "Make this the kind of intelligence brief that would be presented to a CEO, "
                "policymaker, or board of directors. Every sentence must earn its place."
            ),
        },
    ]


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
    # Prefer models that support url_context
    selected = None
    for mid in ("gemini-2.5-flash", "gemini-2.5-pro", "gemini-3-flash-preview"):
        mi = MODELS.get(mid, {})
        if not mi:
            continue
        ak, _ = resolve_provider_key(settings, mi.get("provider", "google"))
        if ak:
            selected = mid
            break
    if not selected:
        selected = normalize_selected_model(settings)

    resolved = resolve_chat_model({"model": selected}, settings)
    if resolved.get("error"):
        return jsonify({"error": resolved["error"]}), 403

    provider = resolved.get("provider")
    api_key = resolved.get("api_key")
    model = resolved.get("actual_model")
    base_url = resolved.get("base_url")

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
        # 📌 Finding pattern
        for m in re.finditer(r'📌\s*\*\*([^*]+)\*\*[:\s]*([^\n]*)', text):
            f = m.group(1).strip()
            desc = m.group(2).strip()
            if desc:
                f += ": " + desc
            key = f.lower()[:50]
            if key not in seen and len(f) > 10:
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
            if key not in seen:
                seen.add(key)
                findings.append(f)
        # 🟢/🟡/🔴 confidence-tagged items
        for m in re.finditer(r'[🟢🟡🔴]\s*\*\*([^*]{5,80})\*\*', text):
            f = m.group(1).strip()
            key = f.lower()[:50]
            if key not in seen and len(f) > 10:
                seen.add(key)
                findings.append(f)
        return findings[:8]

    @stream_with_context
    def generate():
        import time as _time
        import itertools
        all_research = []
        all_sources = []
        all_findings = []
        step_durations = []
        seen_urls = set()
        total_word_count = 0

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

            try:
                step_pieces = []
                use_web = step.get("web_search", False)
                use_url_ctx = step.get("url_context", False)

                # Build tools list for Google provider
                if provider == "google" and (use_web or use_url_ctx):
                    genai, types = _import_google()
                    tools_list = []
                    if use_web:
                        tools_list.append(types.Tool(google_search=types.GoogleSearch()))
                    if use_url_ctx:
                        tools_list.append(types.Tool(url_context=types.UrlContext()))

                    client = genai.Client(api_key=api_key)
                    contents = _google_contents_from_messages(messages, types)

                    # Try with thinking first, fall back without on 400 errors
                    _ra_stream = None
                    for _ra_attempt in range(2):
                        try:
                            _ra_cfg_args = dict(
                                system_instruction=step["system"],
                                tools=tools_list,
                                max_output_tokens=65536,
                            )
                            if _ra_attempt == 0:
                                _ra_cfg_args["thinking_config"] = types.ThinkingConfig(
                                    thinking_budget=16000, include_thoughts=True
                                )
                            cfg = types.GenerateContentConfig(**_ra_cfg_args)
                            _ra_stream = client.models.generate_content_stream(
                                model=model,
                                contents=contents,
                                config=cfg,
                            )
                            # Pull first chunk to verify the stream is valid
                            _first = next(_ra_stream, None)
                            break
                        except Exception as _ra_err:
                            if _ra_attempt == 0 and "400" in str(_ra_err):
                                print(f"  [research] Thinking failed ({_ra_err}), retrying without thinking...")
                                continue
                            raise

                    import itertools  # noqa: already imported above
                    for chunk in itertools.chain([_first] if _first else [], _ra_stream):
                        try:
                            for candidate in (chunk.candidates or []):
                                for part in (candidate.content.parts or []):
                                    is_thought = getattr(part, "thought", None)
                                    if is_thought and part.text:
                                        yield evt({"type": "agent_thinking", "step": i + 1, "text": part.text})
                                        continue
                                    if part.text:
                                        step_pieces.append(part.text)
                                        yield evt({"type": "agent_delta", "step": i + 1, "text": part.text})
                        except (AttributeError, TypeError):
                            text = getattr(chunk, "text", "") or ""
                            if text:
                                step_pieces.append(text)
                                yield evt({"type": "agent_delta", "step": i + 1, "text": text})
                else:
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
                # Strip source blocks from display text but keep for extraction
                display_result = re.sub(r'<<<SOURCES>>>.*?<<<END_SOURCES>>>', '', step_result, flags=re.DOTALL).strip()
                all_research.append(f"## {step['title']}\n{display_result}")

                # Extract and emit sources
                new_sources = _extract_sources(step_result)
                for src in new_sources:
                    if src["url"] not in seen_urls:
                        seen_urls.add(src["url"])
                        all_sources.append(src)
                if new_sources:
                    yield evt({"type": "agent_sources", "step": i + 1,
                               "sources": [s for s in new_sources if s["url"] in seen_urls],
                               "total_sources": len(all_sources)})

                # Extract key findings
                findings = _extract_key_findings(step_result)
                if findings:
                    all_findings.extend(findings)
                    yield evt({"type": "agent_findings", "step": i + 1,
                               "findings": findings, "total_findings": len(all_findings)})

                step_word_count = len(step_result.split())
                total_word_count += step_word_count
                elapsed = round(_time.time() - step_start, 1)
                step_durations.append({"step": i + 1, "title": step["title"], "elapsed": elapsed})
                yield evt({"type": "agent_step", "step": i + 1, "title": step["title"],
                            "icon": step.get("icon", "📄"), "status": "complete", "elapsed": elapsed,
                            "word_count": step_word_count, "source_count": len(new_sources)})
            except Exception as e:
                elapsed = round(_time.time() - step_start, 1)
                all_research.append(f"## {step['title']}\n*Research step failed: {str(e)[:100]}*")
                yield evt({"type": "agent_step", "step": i + 1, "title": step["title"],
                            "icon": step.get("icon", "📄"), "status": "failed",
                            "error": str(e)[:200], "elapsed": elapsed})

        full_report = "\n\n".join(all_research)
        # Generate follow-up research questions from report content
        followups = []
        for m in re.finditer(r'(?:open question|further (?:investigation|research)|remains? (?:uncertain|unclear|unknown)|what about)[:\s]*([^\n]{15,100})', full_report, re.IGNORECASE):
            q = m.group(1).strip().rstrip('.').strip()
            if '?' not in q:
                q += '?'
            if len(q) > 15 and q not in followups:
                followups.append(q)
        if len(followups) < 2:
            # Fallback: generate from "What to Watch" items
            for m in re.finditer(r'watch[^\n]*\n[^|]*\|\s*([^|]{10,60})\s*\|', full_report, re.IGNORECASE):
                item = m.group(1).strip()
                if item and not any(x in item.lower() for x in ['indicator', '---', 'why']):
                    q = f"What are the latest developments on {item}?"
                    if q not in followups:
                        followups.append(q)
        followups = followups[:4]

        yield evt({"type": "agent_done", "report": full_report, "query": query,
                    "sources": all_sources, "total_sources": len(all_sources),
                    "total_words": total_word_count, "step_durations": step_durations,
                    "findings": all_findings, "followup_questions": followups})

        # Save to chat history
        if chat_id:
            try:
                chat, _ = load_chat(chat_id)
                if chat:
                    step_breakdown = []
                    for entry in all_research:
                        nl = entry.find('\n')
                        if nl > 0:
                            step_breakdown.append({"title": entry[3:nl].strip(), "body": entry[nl+1:]})
                        else:
                            step_breakdown.append({"title": entry[3:].strip(), "body": ""})
                    chat["messages"].append({
                        "role": "model",
                        "text": full_report,
                        "timestamp": datetime.datetime.now().isoformat(),
                        "research_agent": True,
                        "research_agent_steps": step_breakdown,
                        "research_agent_query": query,
                        "research_agent_sources": all_sources,
                        "research_agent_findings": all_findings,
                        "research_agent_durations": step_durations,
                        "research_agent_words": total_word_count,
                        "research_agent_followups": followups,
                    })
                    save_chat(chat)
            except Exception:
                pass

    return Response(generate(), mimetype="application/x-ndjson")



# ─── Main ─────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    _ensure_dirs()
    print("\n  +----------------------------------------------+")
    print("  |   PROJECT gyro - Flow-State Architect v3   |")
    print("  |                                             |")
    print("  |   Open http://localhost:5000 in browser     |")
    print("  +----------------------------------------------+\n")
    app.run(host="127.0.0.1", port=5000, debug=False)
