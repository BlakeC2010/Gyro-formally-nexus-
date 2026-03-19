#!/usr/bin/env python3
"""
Minimum Viable nexus - Free AI Command Center
Uses Google Gemini (free tier via Google AI Studio) as the brain.

Usage:
    python nexus.py                  # Interactive chat mode
    python nexus.py --briefing       # Get a briefing from your command center
    python nexus.py --dump "text"    # Brain dump - route info to the right files
"""

import os
import sys
import json
import argparse
import datetime
import re
from pathlib import Path

try:
    from google import genai
    from google.genai import types
except ImportError:
    print("\n[!] google-genai package not installed.")
    print("    Run: pip install google-genai\n")
    sys.exit(1)

# ─── Configuration ────────────────────────────────────────────────────────────

WORKSPACE = Path(__file__).parent.resolve()
IGNORED_DIRS = {".git", "__pycache__", ".venv", "venv", "node_modules", ".nexus_history"}
IGNORED_FILES = {"nexus.py", "requirements.txt", ".env", ".gitignore"}
HISTORY_DIR = WORKSPACE / ".nexus_history"
MAX_CONTEXT_CHARS = 900_000  # Stay well within Gemini's context window
MODEL_NAME = "gemini-3-flash-preview"  # Free tier model with good capabilities

# ─── API Setup ────────────────────────────────────────────────────────────────

def get_api_key():
    """Load API key from environment or .env file."""
    key = os.environ.get("GEMINI_API_KEY")
    if key:
        return key

    env_file = WORKSPACE / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("GEMINI_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")

    print("\n[!] No API key found.")
    print("    1. Go to https://aistudio.google.com/apikey")
    print("    2. Create a free API key")
    print("    3. Create a .env file in this folder with:")
    print("       GEMINI_API_KEY=your_key_here\n")
    sys.exit(1)


def init_client():
    """Initialize the Gemini client."""
    api_key = get_api_key()
    client = genai.Client(api_key=api_key)
    return client


# ─── Workspace Reading ────────────────────────────────────────────────────────

def read_workspace_files():
    """Read all markdown/text files in the workspace for context."""
    files = {}
    total_chars = 0

    for root, dirs, filenames in os.walk(WORKSPACE):
        # Skip ignored directories
        dirs[:] = [d for d in dirs if d not in IGNORED_DIRS]

        for fname in sorted(filenames):
            if fname in IGNORED_FILES:
                continue
            if not fname.endswith((".md", ".txt", ".yaml", ".yml", ".json")):
                continue

            filepath = Path(root) / fname
            rel_path = filepath.relative_to(WORKSPACE)

            try:
                content = filepath.read_text(encoding="utf-8")
            except (UnicodeDecodeError, PermissionError):
                continue

            if total_chars + len(content) > MAX_CONTEXT_CHARS:
                break

            files[str(rel_path)] = content
            total_chars += len(content)

    return files


def format_workspace_context(files):
    """Format workspace files into a context string for the AI."""
    if not files:
        return "(The command center is empty. No files have been created yet.)"

    parts = []
    for path, content in sorted(files.items()):
        parts.append(f"=== FILE: {path} ===\n{content}\n")
    return "\n".join(parts)


# ─── System Prompt ────────────────────────────────────────────────────────────

def build_system_prompt():
    """Build the system prompt that makes Gemini act as nexus."""
    instructions_file = WORKSPACE / "nexus_INSTRUCTIONS.md"
    custom_instructions = ""
    if instructions_file.exists():
        custom_instructions = instructions_file.read_text(encoding="utf-8")

    return f"""You are nexus, a personal AI command center assistant. You help the user manage their "Sovereign Command Center" — a structured workspace of markdown files that serves as their persistent memory, knowledge base, and operational truth.

Your capabilities:
1. READ the user's workspace files (provided as context) to understand their world
2. CREATE new files when the user shares new information that needs a home
3. UPDATE existing files when information changes or needs to be added
4. GENERATE briefings, summaries, and insights from everything in the workspace
5. ROUTE brain dumps — when the user speaks freely, figure out which files to update/create

When you need to create or modify files, output FILE OPERATIONS in this exact format:

<<<FILE_CREATE: path/to/file.md>>>
(full file content here)
<<<END_FILE>>>

<<<FILE_UPDATE: path/to/existing_file.md>>>
(full updated file content here - provide the COMPLETE file, not just changes)
<<<END_FILE>>>

Rules:
- Always use relative paths from the workspace root
- For people files, use the format: people/firstname_lastname.md
- For decision records, use: decisions/YYYY-MM-DD_short_description.md
- Keep STATUS.md as the central operational status document
- Keep PRINCIPLES.md for core values and decision heuristics
- Be conversational but substantive. You're a chief of staff, not a chatbot.
- When generating briefings, be specific and actionable, referencing actual content from the files.
- Today's date is {datetime.date.today().isoformat()}

{f"Additional custom instructions from nexus_INSTRUCTIONS.md:{chr(10)}{custom_instructions}" if custom_instructions else ""}"""


# ─── File Operations ──────────────────────────────────────────────────────────

def execute_file_operations(response_text):
    """Parse and execute file operations from the AI response."""
    operations = []

    # Match FILE_CREATE operations
    create_pattern = r'<<<FILE_CREATE:\s*(.+?)>>>\n(.*?)<<<END_FILE>>>'
    for match in re.finditer(create_pattern, response_text, re.DOTALL):
        filepath = match.group(1).strip()
        content = match.group(2).strip()
        operations.append(("create", filepath, content))

    # Match FILE_UPDATE operations
    update_pattern = r'<<<FILE_UPDATE:\s*(.+?)>>>\n(.*?)<<<END_FILE>>>'
    for match in re.finditer(update_pattern, response_text, re.DOTALL):
        filepath = match.group(1).strip()
        content = match.group(2).strip()
        operations.append(("update", filepath, content))

    if not operations:
        return []

    executed = []
    for op_type, rel_path, content in operations:
        # Security: prevent path traversal
        clean_path = Path(rel_path).as_posix()
        if ".." in clean_path or clean_path.startswith("/"):
            print(f"  [!] Skipped unsafe path: {rel_path}")
            continue

        full_path = WORKSPACE / clean_path
        full_path.parent.mkdir(parents=True, exist_ok=True)

        action = "Created" if not full_path.exists() else "Updated"
        full_path.write_text(content + "\n", encoding="utf-8")
        executed.append((action, clean_path))
        print(f"  [{action}] {clean_path}")

    return executed


def clean_response_for_display(text):
    """Remove file operation blocks from response for cleaner display."""
    text = re.sub(r'<<<FILE_CREATE:\s*.+?>>>.*?<<<END_FILE>>>', '', text, flags=re.DOTALL)
    text = re.sub(r'<<<FILE_UPDATE:\s*.+?>>>.*?<<<END_FILE>>>', '', text, flags=re.DOTALL)
    return text.strip()


# ─── Chat History ─────────────────────────────────────────────────────────────

def save_history(messages):
    """Save conversation history for continuity."""
    HISTORY_DIR.mkdir(exist_ok=True)
    today = datetime.date.today().isoformat()
    history_file = HISTORY_DIR / f"session_{today}.json"

    # Keep only the last 50 messages to avoid bloat
    recent = messages[-50:]
    serializable = []
    for msg in recent:
        serializable.append({"role": msg["role"], "text": msg["text"]})

    history_file.write_text(json.dumps(serializable, indent=2), encoding="utf-8")


def load_history():
    """Load today's conversation history if it exists."""
    today = datetime.date.today().isoformat()
    history_file = HISTORY_DIR / f"session_{today}.json"

    if not history_file.exists():
        return []

    try:
        data = json.loads(history_file.read_text(encoding="utf-8"))
        return [{"role": m["role"], "text": m["text"]} for m in data]
    except (json.JSONDecodeError, KeyError):
        return []


# ─── Core Commands ────────────────────────────────────────────────────────────

def do_chat(client, user_input, history):
    """Send a message to nexus and handle the response."""
    # Build context from workspace
    files = read_workspace_files()
    context = format_workspace_context(files)

    # Build the full prompt with workspace context
    full_prompt = f"""[WORKSPACE CONTEXT - Current files in the command center]
{context}

[USER MESSAGE]
{user_input}"""

    # Build chat contents for the model
    contents = []
    for msg in history[-10:]:  # Last 10 messages for continuity
        contents.append(types.Content(
            role=msg["role"],
            parts=[types.Part.from_text(text=msg["text"])]
        ))
    contents.append(types.Content(
        role="user",
        parts=[types.Part.from_text(text=full_prompt)]
    ))

    try:
        response = client.models.generate_content(
            model=MODEL_NAME,
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=build_system_prompt(),
            ),
        )
        response_text = response.text
    except Exception as e:
        error_msg = str(e)
        if "429" in error_msg or "quota" in error_msg.lower():
            print("\n[!] Rate limit hit. Google AI Studio free tier allows ~15 requests/minute.")
            print("    Wait a moment and try again.\n")
            return None
        elif "API_KEY" in error_msg.upper() or "authentication" in error_msg.lower():
            print("\n[!] API key issue. Check your GEMINI_API_KEY in the .env file.")
            print("    Get a key at: https://aistudio.google.com/apikey\n")
            return None
        else:
            print(f"\n[!] Error: {e}\n")
            return None

    # Execute any file operations in the response
    executed = execute_file_operations(response_text)

    # Display the clean response
    clean_text = clean_response_for_display(response_text)
    if clean_text:
        print(f"\n{clean_text}")

    if executed:
        print(f"\n  --- {len(executed)} file(s) modified ---")

    # Update history
    history.append({"role": "user", "text": user_input})
    history.append({"role": "model", "text": response_text})

    return response_text


def do_briefing(client):
    """Generate a full briefing from the command center."""
    print("\n  Generating briefing from your command center...\n")
    prompt = """Based on everything in this workspace, give me a comprehensive briefing. Cover:

1. **Key Relationships** - Who are my key people? Any follow-ups needed?
2. **Current State** - What am I working on? What's the honest situation?
3. **Decisions Made** - What have I decided recently? Any open questions?
4. **What Needs Attention** - What should I be paying attention to right now?
5. **Recommendations** - Based on everything you see, what would you suggest?

Be specific. Reference actual content from the files. If the command center is sparse, tell me what I should add first."""

    do_chat(client, prompt, [])


def do_brain_dump(client, text):
    """Route a brain dump to the right files."""
    print("\n  Processing brain dump...\n")
    prompt = f"""I'm doing a brain dump. Route this information to the right places in my command center. 
Create new files if needed, update existing ones if relevant. Tell me what you did and why.

Here's my brain dump:

{text}"""

    do_chat(client, prompt, [])


# ─── Interactive Mode ─────────────────────────────────────────────────────────

def interactive_mode(client):
    """Run nexus in interactive chat mode."""
    print("""
╔══════════════════════════════════════════════════════╗
║              nexus - Command Center AI              ║
║──────────────────────────────────────────────────────║
║  Commands:                                           ║
║    /briefing  - Get a full briefing                  ║
║    /dump      - Start a brain dump                   ║
║    /status    - Show workspace file list             ║
║    /help      - Show this help                       ║
║    /quit      - Exit                                 ║
║                                                      ║
║  Or just type naturally — nexus will handle it.     ║
╚══════════════════════════════════════════════════════╝
""")

    history = load_history()
    if history:
        print(f"  (Resumed today's session — {len(history)} previous messages)\n")

    while True:
        try:
            user_input = input("\nYou > ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n\n  Goodbye. Your command center persists.\n")
            break

        if not user_input:
            continue

        if user_input.lower() == "/quit":
            print("\n  Goodbye. Your command center persists.\n")
            break

        elif user_input.lower() == "/help":
            print("""
  /briefing  - Get a comprehensive briefing from your command center
  /dump      - Enter brain dump mode (type freely, nexus routes it)
  /status    - List all files in your command center
  /quit      - Exit nexus
  
  Or just type/paste anything. nexus reads your entire workspace as context.""")

        elif user_input.lower() == "/briefing":
            do_briefing(client)

        elif user_input.lower() == "/dump":
            print("\n  Brain dump mode. Type or paste your thoughts. Enter a blank line when done.\n")
            lines = []
            while True:
                try:
                    line = input("  ... ")
                except (EOFError, KeyboardInterrupt):
                    break
                if line.strip() == "":
                    break
                lines.append(line)

            if lines:
                do_brain_dump(client, "\n".join(lines))
            else:
                print("  (Empty dump, nothing to process)")

        elif user_input.lower() == "/status":
            files = read_workspace_files()
            if files:
                print("\n  Files in your command center:")
                for path in sorted(files.keys()):
                    size = len(files[path])
                    print(f"    {path} ({size:,} chars)")
            else:
                print("\n  Command center is empty. Start by telling nexus about yourself!")

        else:
            do_chat(client, user_input, history)
            save_history(history)


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="nexus - Your free AI Command Center (powered by Google Gemini)"
    )
    parser.add_argument("--briefing", action="store_true", help="Generate a briefing from your command center")
    parser.add_argument("--dump", type=str, help="Brain dump text to route to your files")
    args = parser.parse_args()

    model = init_client()

    if args.briefing:
        do_briefing(model)
    elif args.dump:
        do_brain_dump(model, args.dump)
    else:
        interactive_mode(model)


if __name__ == "__main__":
    main()
