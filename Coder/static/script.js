/* ═══════════════════════════════════════════════════════════════════════════
   Coder — Frontend Application
   ═══════════════════════════════════════════════════════════════════════════ */

// ── State ───────────────────────────────────────────────────────────────────
let monacoEditor = null;
let currentConvId = localStorage.getItem("coder_conv") || null;
let openTabs = [];       // [{path, model, modified}]
let activeTabPath = null;
let isStreaming = false;
let config = {};
let browsePath = "";

const LANG_MAP = {
    py:'python',js:'javascript',ts:'typescript',tsx:'typescriptreact',
    jsx:'javascriptreact',html:'html',css:'css',json:'json',md:'markdown',
    yaml:'yaml',yml:'yaml',sh:'shell',bat:'bat',ps1:'powershell',
    java:'java',c:'c',cpp:'cpp',h:'c',hpp:'cpp',rs:'rust',go:'go',
    rb:'ruby',php:'php',swift:'swift',kt:'kotlin',cs:'csharp',
    sql:'sql',xml:'xml',toml:'plaintext',cfg:'ini',ini:'ini',
    txt:'plaintext',log:'plaintext',csv:'plaintext',env:'plaintext',
};

const FILE_ICONS = {
    py:'🐍',js:'📜',ts:'📘',html:'🌐',css:'🎨',json:'📋',md:'📝',
    rs:'🦀',go:'🔷',java:'☕',rb:'💎',php:'🐘',
    jpg:'🖼️',png:'🖼️',gif:'🖼️',svg:'🖼️',webp:'🖼️',
    zip:'📦',tar:'📦',gz:'📦',
    default:'📄',folder:'📁',folderOpen:'📂',
};

function fileIcon(name, isDir) {
    if (isDir) return FILE_ICONS.folder;
    const ext = name.split('.').pop().toLowerCase();
    return FILE_ICONS[ext] || FILE_ICONS.default;
}

function langFromPath(path) {
    const ext = path.split('.').pop().toLowerCase();
    return LANG_MAP[ext] || 'plaintext';
}

// ── Init ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    await loadConfig();
    await loadModels();
    initMonaco();
    initSidebarTabs();
    initResizers();
    initChatInput();
    initTerminalInput();
    initSettingsModal();
    initBrowseModal();
    loadFileTree();
    loadConversations();
    updateStatusBar();

    // Show settings if not configured
    if (!config.api_key || !config.project_path) {
        document.getElementById('settings-overlay').classList.remove('hidden');
    }
});

// ── API helpers ─────────────────────────────────────────────────────────────
async function api(url, opts = {}) {
    const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json', ...opts.headers },
        ...opts,
    });
    return res.json();
}

// ── Config ──────────────────────────────────────────────────────────────────
async function loadConfig() {
    config = await api('/api/config');
    document.getElementById('mode-select').value = config.mode || 'auto';
    syncModelSelect();
    updateStatusBar();
}

async function saveConfig(updates) {
    await api('/api/config', { method: 'POST', body: JSON.stringify(updates) });
    await loadConfig();
}

function syncModelSelect() {
    const sel = document.getElementById('model-select');
    if (sel.options.length > 0) sel.value = config.model || 'gemma-4-31b-it';
}

// ── Models ──────────────────────────────────────────────────────────────────
async function loadModels() {
    const models = await api('/api/models');
    const populate = (sel) => {
        sel.innerHTML = '';
        for (const [id, info] of Object.entries(models)) {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = info.label;
            opt.title = info.desc;
            sel.appendChild(opt);
        }
    };
    populate(document.getElementById('model-select'));
    populate(document.getElementById('cfg-model'));
    syncModelSelect();
}

// ── Monaco Editor ───────────────────────────────────────────────────────────
function initMonaco() {
    require(['vs/editor/editor.main'], function () {
        // Editor will be created when a file is opened
        monaco.editor.defineTheme('coder-dark', {
            base: 'vs-dark',
            inherit: true,
            rules: [],
            colors: {
                'editor.background': '#1e1e1e',
                'editor.foreground': '#cccccc',
            }
        });
    });
}

function openFileInEditor(path, content) {
    // Check if tab already open
    let tab = openTabs.find(t => t.path === path);
    if (!tab) {
        const lang = langFromPath(path);
        let model;
        if (typeof monaco !== 'undefined') {
            model = monaco.editor.createModel(content, lang);
            model.onDidChangeContent(() => {
                const t = openTabs.find(x => x.path === path);
                if (t && !t.modified) { t.modified = true; renderTabs(); }
            });
        }
        tab = { path, model, modified: false };
        openTabs.push(tab);
    }
    activeTabPath = path;
    renderTabs();
    showEditor(tab);
}

function showEditor(tab) {
    const container = document.getElementById('editor-container');
    const welcome = document.getElementById('editor-welcome');
    if (welcome) welcome.style.display = 'none';

    if (!monacoEditor && typeof monaco !== 'undefined') {
        monacoEditor = monaco.editor.create(container, {
            theme: 'coder-dark',
            fontSize: 13,
            fontFamily: "'JetBrains Mono', 'Consolas', monospace",
            minimap: { enabled: true },
            automaticLayout: true,
            wordWrap: 'on',
            scrollBeyondLastLine: false,
            renderLineHighlight: 'line',
            padding: { top: 8 },
        });

        // Ctrl+S to save
        monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
            saveCurrentFile();
        });
    }
    if (monacoEditor && tab.model) {
        monacoEditor.setModel(tab.model);
    }
    updateStatusBar();
}

function renderTabs() {
    const bar = document.getElementById('editor-tabs');
    bar.innerHTML = '';
    openTabs.forEach(tab => {
        const el = document.createElement('button');
        el.className = 'editor-tab' + (tab.path === activeTabPath ? ' active' : '');
        const name = tab.path.split('/').pop();
        el.innerHTML = `
            ${name}${tab.modified ? '<span class="tab-modified">●</span>' : ''}
            <span class="tab-close" data-path="${tab.path}">✕</span>
        `;
        el.addEventListener('click', (e) => {
            if (e.target.classList.contains('tab-close')) {
                closeTab(e.target.dataset.path);
            } else {
                activeTabPath = tab.path;
                renderTabs();
                showEditor(tab);
            }
        });
        bar.appendChild(el);
    });
}

function closeTab(path) {
    const idx = openTabs.findIndex(t => t.path === path);
    if (idx < 0) return;
    const tab = openTabs[idx];
    if (tab.model) tab.model.dispose();
    openTabs.splice(idx, 1);
    if (activeTabPath === path) {
        if (openTabs.length > 0) {
            activeTabPath = openTabs[Math.min(idx, openTabs.length - 1)].path;
            showEditor(openTabs.find(t => t.path === activeTabPath));
        } else {
            activeTabPath = null;
            if (monacoEditor) { monacoEditor.setModel(null); }
            const welcome = document.getElementById('editor-welcome');
            if (welcome) welcome.style.display = '';
        }
    }
    renderTabs();
}

async function saveCurrentFile() {
    const tab = openTabs.find(t => t.path === activeTabPath);
    if (!tab || !tab.model) return;
    const content = tab.model.getValue();
    await api(`/api/file/${tab.path}`, {
        method: 'PUT',
        body: JSON.stringify({ content }),
    });
    tab.modified = false;
    renderTabs();
    appendTerminal(`Saved: ${tab.path}`, 'info');
}

// ── File Tree ───────────────────────────────────────────────────────────────
async function loadFileTree(rel = '.') {
    if (!config.project_path) return;
    const data = await api(`/api/files${rel === '.' ? '' : '/' + rel}`);
    if (data.error) return;
    const container = document.getElementById('file-tree');
    if (rel === '.') container.innerHTML = '';
    renderTree(container, data.items, 0);
}

function renderTree(container, items, depth) {
    items.forEach(item => {
        const el = document.createElement('div');
        el.className = `tree-item tree-${item.type}`;
        el.style.paddingLeft = `${12 + depth * 16}px`;
        el.innerHTML = `
            <span class="tree-icon">${item.type === 'dir' ? '▶' : fileIcon(item.name)}</span>
            <span class="tree-name">${item.name}</span>
        `;
        if (item.type === 'dir') {
            let loaded = false;
            let open = false;
            const childContainer = document.createElement('div');
            childContainer.style.display = 'none';
            el.addEventListener('click', async () => {
                open = !open;
                el.querySelector('.tree-icon').textContent = open ? '▼' : '▶';
                if (!loaded) {
                    const data = await api(`/api/files/${item.path}`);
                    if (data.items) renderTree(childContainer, data.items, depth + 1);
                    loaded = true;
                }
                childContainer.style.display = open ? '' : 'none';
            });
            container.appendChild(el);
            container.appendChild(childContainer);
        } else {
            el.addEventListener('click', async () => {
                const data = await api(`/api/file/${item.path}`);
                if (data.content !== undefined) {
                    openFileInEditor(item.path, data.content);
                    // Highlight active file
                    document.querySelectorAll('.tree-item').forEach(n => n.classList.remove('active'));
                    el.classList.add('active');
                }
            });
            container.appendChild(el);
        }
    });
}

document.getElementById('refresh-files')?.addEventListener('click', () => {
    document.getElementById('file-tree').innerHTML = '';
    loadFileTree();
});

// ── Sidebar Tabs ────────────────────────────────────────────────────────────
function initSidebarTabs() {
    document.querySelectorAll('.sidebar-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.sidebar-tab').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.panel).classList.add('active');
        });
    });
    document.getElementById('sidebar-toggle').addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('collapsed');
    });
}

// ── Resize Handles ──────────────────────────────────────────────────────────
function initResizers() {
    // Sidebar resize
    makeResizer('sidebar-resize', (dx) => {
        const sb = document.getElementById('sidebar');
        const w = Math.max(160, Math.min(500, sb.offsetWidth + dx));
        sb.style.width = w + 'px';
    }, 'col');

    // Chat panel resize
    makeResizer('chat-resize', (dx) => {
        const cp = document.getElementById('chat-panel');
        const w = Math.max(280, Math.min(700, cp.offsetWidth - dx));
        cp.style.width = w + 'px';
    }, 'col');

    // Terminal resize
    makeResizer('terminal-resize', (dy) => {
        const ts = document.getElementById('terminal-section');
        const h = Math.max(60, Math.min(500, ts.offsetHeight - dy));
        ts.style.height = h + 'px';
    }, 'row');
}

function makeResizer(id, onMove, dir) {
    const el = document.getElementById(id);
    if (!el) return;
    let startPos = 0;
    el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        startPos = dir === 'col' ? e.clientX : e.clientY;
        el.classList.add('dragging');
        const onMouseMove = (e2) => {
            const delta = (dir === 'col' ? e2.clientX : e2.clientY) - startPos;
            startPos = dir === 'col' ? e2.clientX : e2.clientY;
            onMove(delta);
        };
        const onMouseUp = () => {
            el.classList.remove('dragging');
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

// ── Conversations ───────────────────────────────────────────────────────────
async function loadConversations() {
    const convs = await api('/api/conversations');
    const list = document.getElementById('chat-list');
    list.innerHTML = '';
    convs.forEach(c => {
        const el = document.createElement('div');
        el.className = 'chat-item' + (c.id === currentConvId ? ' active' : '');
        el.textContent = c.title || 'Untitled';
        el.addEventListener('click', () => switchConversation(c.id));
        list.appendChild(el);
    });
}

async function switchConversation(cid) {
    currentConvId = cid;
    localStorage.setItem('coder_conv', cid);
    const conv = await api(`/api/conversations/${cid}`);
    if (conv.error) return;
    renderConversation(conv);
    loadConversations();
}

function renderConversation(conv) {
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';
    if (!conv.messages || conv.messages.length === 0) {
        container.innerHTML = `
            <div class="welcome-message">
                <h3>👋 Hello! I'm Coder.</h3>
                <p>I can help you build, debug, and refactor code. Tell me what you need!</p>
                <div class="mode-hints">
                    <div class="mode-hint"><strong>🟢 Auto:</strong> I'll execute changes immediately</div>
                    <div class="mode-hint"><strong>🟡 Ask:</strong> I'll ask before making changes</div>
                    <div class="mode-hint"><strong>🔵 Plan:</strong> I'll create a full plan first</div>
                </div>
            </div>`;
        return;
    }
    conv.messages.forEach(msg => {
        if (msg.role === 'user') {
            appendUserMessage(msg.content);
        } else {
            appendAssistantMessage(msg.content, msg.tools || []);
        }
    });
    scrollChat();
}

document.getElementById('new-chat-btn')?.addEventListener('click', async () => {
    const conv = await api('/api/conversations', { method: 'POST' });
    currentConvId = conv.id;
    localStorage.setItem('coder_conv', conv.id);
    renderConversation(conv);
    loadConversations();
});

// ── Chat Input ──────────────────────────────────────────────────────────────
function initChatInput() {
    const input = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');

    // Auto-resize textarea
    input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 180) + 'px';
    });

    // Enter to send, Shift+Enter for newline
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    sendBtn.addEventListener('click', sendMessage);

    // Mode/model changes
    document.getElementById('mode-select').addEventListener('change', (e) => {
        saveConfig({ mode: e.target.value });
    });
    document.getElementById('model-select').addEventListener('change', (e) => {
        saveConfig({ model: e.target.value });
    });
}

async function sendMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text || isStreaming) return;

    // Ensure we have a conversation
    if (!currentConvId) {
        const conv = await api('/api/conversations', { method: 'POST' });
        currentConvId = conv.id;
        localStorage.setItem('coder_conv', conv.id);
        document.getElementById('chat-messages').innerHTML = '';
    }

    input.value = '';
    input.style.height = 'auto';

    appendUserMessage(text);
    scrollChat();

    // Stream response
    isStreaming = true;
    document.getElementById('send-btn').disabled = true;
    setAgentStatus('thinking...');

    const msgEl = createAssistantMessageEl();
    const contentEl = msgEl.querySelector('.message-content');
    let fullText = '';

    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                conversation_id: currentConvId,
                message: text,
            }),
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // keep incomplete line

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    handleSSE(data, contentEl, msgEl, { fullText: () => fullText, setFullText: (t) => fullText = t });
                } catch (e) { /* skip malformed */ }
            }
        }
    } catch (err) {
        contentEl.innerHTML += `<p style="color:var(--red)">Connection error: ${escapeHtml(err.message)}</p>`;
    }

    isStreaming = false;
    document.getElementById('send-btn').disabled = false;
    setAgentStatus('');
    scrollChat();
    loadConversations();
}

function handleSSE(data, contentEl, msgEl, state) {
    switch (data.type) {
        case 'text': {
            const newText = state.fullText() + data.content;
            state.setFullText(newText);
            contentEl.innerHTML = renderMarkdown(newText);
            scrollChat();
            break;
        }
        case 'tool_start': {
            const block = document.createElement('div');
            block.className = 'tool-block';
            block.dataset.name = data.name;
            const label = toolLabel(data.name, data.args);
            block.innerHTML = `
                <div class="tool-header" onclick="this.parentElement.classList.toggle('open')">
                    <span class="tool-chevron">▶</span>
                    ${label}
                    <span class="tool-status">running...</span>
                </div>
                <div class="tool-body">Executing...</div>
            `;
            contentEl.appendChild(block);
            setAgentStatus(`${data.name}...`);
            scrollChat();
            break;
        }
        case 'tool_result': {
            const blocks = contentEl.querySelectorAll('.tool-block');
            const block = blocks[blocks.length - 1];
            if (block) {
                const body = block.querySelector('.tool-body');
                const status = block.querySelector('.tool-status');
                const result = data.result;
                if (result.error) {
                    body.textContent = `Error: ${result.error}`;
                    status.textContent = '✗ error';
                    status.className = 'tool-status err';
                } else {
                    body.textContent = formatToolResult(data.name, result);
                    status.textContent = '✓ done';
                    status.className = 'tool-status ok';
                }
            }
            setAgentStatus('thinking...');
            scrollChat();
            break;
        }
        case 'file_changed':
            loadFileTree();
            // Refresh open tab if it matches
            refreshOpenTab(data.path);
            break;
        case 'status':
            setAgentStatus(data.content);
            break;
        case 'title':
            // Conversation title updated
            break;
        case 'error':
            contentEl.innerHTML += `<p style="color:var(--red)">⚠ ${escapeHtml(data.content)}</p>`;
            scrollChat();
            break;
        case 'done':
            setAgentStatus('');
            break;
    }
}

async function refreshOpenTab(path) {
    const tab = openTabs.find(t => t.path === path);
    if (tab && tab.model) {
        const data = await api(`/api/file/${path}`);
        if (data.content !== undefined) {
            tab.model.setValue(data.content);
            tab.modified = false;
            renderTabs();
        }
    }
}

// ── Message rendering ───────────────────────────────────────────────────────
function appendUserMessage(text) {
    const container = document.getElementById('chat-messages');
    const el = document.createElement('div');
    el.className = 'message user';
    el.innerHTML = `
        <div class="message-avatar">U</div>
        <div class="message-body">
            <div class="message-content">${escapeHtml(text)}</div>
        </div>
    `;
    container.appendChild(el);
}

function createAssistantMessageEl() {
    const container = document.getElementById('chat-messages');
    const el = document.createElement('div');
    el.className = 'message assistant';
    el.innerHTML = `
        <div class="message-avatar">C</div>
        <div class="message-body">
            <div class="message-content">
                <div class="thinking-indicator">
                    <div class="thinking-dots"><span></span><span></span><span></span></div>
                    <span>Thinking...</span>
                </div>
            </div>
        </div>
    `;
    container.appendChild(el);
    scrollChat();
    return el;
}

function appendAssistantMessage(text, tools) {
    const container = document.getElementById('chat-messages');
    const el = document.createElement('div');
    el.className = 'message assistant';
    let toolsHtml = '';
    if (tools && tools.length > 0) {
        toolsHtml = tools.map(t => {
            const label = toolLabel(t.name, t.args);
            const result = t.result || {};
            const isErr = !!result.error;
            const body = isErr ? `Error: ${result.error}` : formatToolResult(t.name, result);
            return `
                <div class="tool-block">
                    <div class="tool-header" onclick="this.parentElement.classList.toggle('open')">
                        <span class="tool-chevron">▶</span>
                        ${label}
                        <span class="tool-status ${isErr ? 'err' : 'ok'}">${isErr ? '✗ error' : '✓ done'}</span>
                    </div>
                    <div class="tool-body">${escapeHtml(body)}</div>
                </div>
            `;
        }).join('');
    }
    el.innerHTML = `
        <div class="message-avatar">C</div>
        <div class="message-body">
            <div class="message-content">${renderMarkdown(text)}${toolsHtml}</div>
        </div>
    `;
    container.appendChild(el);
}

function toolLabel(name, args) {
    const icons = {
        read_file: '📖', write_file: '✏️', edit_file: '🔧',
        run_command: '⚡', list_dir: '📂', search: '🔍', delete: '🗑️',
    };
    const icon = icons[name] || '🔧';
    let detail = '';
    if (args) {
        if (args.path) detail = args.path;
        else if (args.command) detail = args.command;
        else if (args.query) detail = `"${args.query}"`;
    }
    return `${icon} <strong>${name}</strong>${detail ? ' — ' + escapeHtml(detail) : ''}`;
}

function formatToolResult(name, result) {
    if (name === 'read_file' && result.content) return result.content;
    if (name === 'list_dir' && result.items) return result.items.map(i => `${i.type === 'dir' ? '📁' : '📄'} ${i.name}`).join('\n');
    if (name === 'run_command') {
        let out = '';
        if (result.stdout) out += result.stdout;
        if (result.stderr) out += (out ? '\n' : '') + result.stderr;
        if (result.code !== undefined) out += `\n[exit code: ${result.code}]`;
        return out || '(no output)';
    }
    if (name === 'search' && result.results) {
        return result.results.map(r => `${r.file}:${r.line}  ${r.text}`).join('\n');
    }
    return JSON.stringify(result, null, 2);
}

function setAgentStatus(text) {
    const el = document.getElementById('agent-status');
    if (text) {
        el.innerHTML = `<span class="status-dot"></span>${text}`;
    } else {
        el.innerHTML = '';
    }
}

function scrollChat() {
    const el = document.getElementById('chat-messages');
    requestAnimationFrame(() => el.scrollTop = el.scrollHeight);
}

// ── Markdown rendering ──────────────────────────────────────────────────────
function renderMarkdown(text) {
    if (!text) return '';
    if (typeof marked !== 'undefined') {
        marked.setOptions({
            breaks: true,
            gfm: true,
            highlight: function(code, lang) {
                if (typeof hljs !== 'undefined') {
                    if (lang && hljs.getLanguage(lang)) {
                        try { return hljs.highlight(code, { language: lang }).value; } catch(e) {}
                    }
                    try { return hljs.highlightAuto(code).value; } catch(e) {}
                }
                return code;
            }
        });
        return marked.parse(text);
    }
    return escapeHtml(text).replace(/\n/g, '<br>');
}

function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
}

// ── Terminal ────────────────────────────────────────────────────────────────
function initTerminalInput() {
    const input = document.getElementById('terminal-input');
    input.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            const cmd = input.value.trim();
            if (!cmd) return;
            input.value = '';
            appendTerminal(`$ ${cmd}`, 'cmd');
            const result = await api('/api/terminal', {
                method: 'POST',
                body: JSON.stringify({ command: cmd }),
            });
            if (result.error) {
                appendTerminal(result.error, 'err');
            } else {
                if (result.stdout) appendTerminal(result.stdout);
                if (result.stderr) appendTerminal(result.stderr, 'err');
                if (result.code !== undefined && result.code !== 0) {
                    appendTerminal(`[exit code: ${result.code}]`, 'info');
                }
            }
        }
    });

    document.getElementById('clear-terminal')?.addEventListener('click', () => {
        document.getElementById('terminal-output').innerHTML = '';
    });
}

function appendTerminal(text, cls = '') {
    const el = document.getElementById('terminal-output');
    const line = document.createElement('div');
    if (cls) line.className = `term-${cls}`;
    line.textContent = text;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
}

// ── Settings Modal ──────────────────────────────────────────────────────────
function initSettingsModal() {
    const overlay = document.getElementById('settings-overlay');
    const close = () => overlay.classList.add('hidden');

    document.getElementById('settings-btn').addEventListener('click', () => {
        // Populate fields
        document.getElementById('cfg-api-key').value = '';
        document.getElementById('cfg-api-key').placeholder = config.api_key_display || 'AIza...';
        document.getElementById('cfg-project-path').value = config.project_path || '';
        document.getElementById('cfg-model').value = config.model || 'gemma-4-31b-it';
        document.getElementById('cfg-mode').value = config.mode || 'auto';
        overlay.classList.remove('hidden');
    });

    document.getElementById('settings-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    document.getElementById('settings-save').addEventListener('click', async () => {
        const updates = {};
        const key = document.getElementById('cfg-api-key').value.trim();
        if (key) updates.api_key = key;
        const path = document.getElementById('cfg-project-path').value.trim();
        if (path) updates.project_path = path;
        updates.model = document.getElementById('cfg-model').value;
        updates.mode = document.getElementById('cfg-mode').value;
        await saveConfig(updates);
        close();
        loadFileTree();
        loadConversations();
    });
}

// ── Browse Modal ────────────────────────────────────────────────────────────
function initBrowseModal() {
    const overlay = document.getElementById('browse-overlay');
    const close = () => overlay.classList.add('hidden');

    document.getElementById('browse-btn').addEventListener('click', async () => {
        const startPath = document.getElementById('cfg-project-path').value.trim() || '';
        await browseTo(startPath || '');
        overlay.classList.remove('hidden');
    });

    document.getElementById('browse-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    document.getElementById('browse-select').addEventListener('click', () => {
        document.getElementById('cfg-project-path').value = browsePath;
        close();
    });
}

async function browseTo(path) {
    const data = await api(`/api/browse?path=${encodeURIComponent(path)}`);
    if (data.error) return;
    browsePath = data.path;
    document.getElementById('browse-path').textContent = data.path;
    const list = document.getElementById('browse-list');
    list.innerHTML = '';

    // Parent directory
    if (data.parent) {
        const el = document.createElement('div');
        el.className = 'browse-item';
        el.innerHTML = '<span class="browse-item-icon">⬆️</span> ..';
        el.addEventListener('click', () => browseTo(data.parent));
        list.appendChild(el);
    }

    data.dirs.forEach(d => {
        const el = document.createElement('div');
        el.className = 'browse-item';
        el.innerHTML = `<span class="browse-item-icon">📁</span> ${escapeHtml(d.name)}`;
        el.addEventListener('click', () => browseTo(d.path));
        list.appendChild(el);
    });
}

// ── Status bar ──────────────────────────────────────────────────────────────
function updateStatusBar() {
    const mode = config.mode || 'auto';
    const modeLabels = { auto: '🟢 Auto', ask: '🟡 Ask', plan: '🔵 Plan' };
    document.getElementById('status-mode').textContent = modeLabels[mode] || mode;
    document.getElementById('status-model').textContent = config.model || '';
    document.getElementById('status-project').textContent = config.project_path || 'No project';
    document.getElementById('status-file').textContent = activeTabPath || '';
}
