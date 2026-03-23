// ─── State ────────────────────────────────────────
let curChat=null,allChats=[],ttsOn=false,recording=false,recognition=null,pendingFiles=[],pendingFolder='';
let pendingReplies=[];  // reply context: [{type:'image',url,title},{type:'text',text}]
let _continueCount=0;const _MAX_CONTINUES=5;
let _codeRepromptCount=0;const _MAX_CODE_REPROMPTS=3;
let _nextStreamId=0;
let curUser=null,isGuest=false,authMode='login',theme='dark',googleClientId='';
let googleInitDone=false,thinkingLevel='off',guestAuthMode='register';
let deepResearchDepth='standard';
let onboardingChecked=false;
let selectMode=false;
const selectedItems=new Set();
const _collapsedFolders=new Set();
const runningStreams=new Map();
const unreadChats=new Set();
const artifactStore=[];
const artifactIndex=new Map();
const mindMapStore=new Map();
const chatTodoStore=new Map();
const uploadedHistory=[];
const workspaceFileCache=new Map();
let canvasTabs=[];
let activeCanvasTabId=null;
const _thinkPhrases=['Thinking this through...','Working on it...','Pulling ideas together...','Reasoning carefully...','Analyzing your request...','Finding the best approach...'];
let _thinkInterval=null;
const ONB_SKIP_KEY='gyro_onboarding_skipped';
const ONB_NO_REMIND_KEY='gyro_onboarding_no_remind';
const ONB_DISMISS_KEY='gyro_onboarding_reminder_dismissed';
const HOME_WIDGET_CACHE_KEY='gyro_home_widgets_cache_v1';
const CHAT_CACHE_KEY='gyro_recent_chats_v1';
const FOLDER_META_KEY='gyro_folder_meta_v1';
let homeWidgetRefreshTimer=null;
let homeWidgetRefreshInFlight=false;

// ─── Location ─────────────────────────────────────
function isLocationEnabled(){ return localStorage.getItem('gyro_location_enabled')==='true'; }
function getUserLocation(){
  if(!isLocationEnabled()) return null;
  try{
    const raw=localStorage.getItem('gyro_user_location');
    return raw?JSON.parse(raw):null;
  }catch{return null;}
}
function toggleLocationSharing(on){
  if(on){
    localStorage.setItem('gyro_location_enabled','true');
    requestUserLocation();
  }else{
    localStorage.setItem('gyro_location_enabled','false');
    localStorage.removeItem('gyro_user_location');
  }
  updateLocationToggleUI();
}
function requestUserLocation(){
  if(!navigator.geolocation){showToast('Geolocation not supported by your browser','error');return;}
  navigator.geolocation.getCurrentPosition(pos=>{
    const loc={lat:pos.coords.latitude,lng:pos.coords.longitude,accuracy:pos.coords.accuracy,ts:Date.now()};
    // Reverse geocode to get city/region
    fetch(`https://nominatim.openstreetmap.org/reverse?lat=${loc.lat}&lon=${loc.lng}&format=json&zoom=10`,{headers:{'User-Agent':'Gyro-AI/1.0'}})
      .then(r=>r.json()).then(d=>{
        loc.city=d.address?.city||d.address?.town||d.address?.village||'';
        loc.state=d.address?.state||'';
        loc.country=d.address?.country||'';
        loc.display=`${loc.city}${loc.state?', '+loc.state:''}${loc.country?', '+loc.country:''}`;
        localStorage.setItem('gyro_user_location',JSON.stringify(loc));
        showToast(`Location set: ${loc.display}`,'success');
        updateLocationToggleUI();
      }).catch(()=>{
        localStorage.setItem('gyro_user_location',JSON.stringify(loc));
        showToast('Location saved (coordinates only)','success');
        updateLocationToggleUI();
      });
  },err=>{
    console.warn('Geolocation error:',err);
    showToast('Could not get your location — check browser permissions','error');
    localStorage.setItem('gyro_location_enabled','false');
    updateLocationToggleUI();
  },{enableHighAccuracy:false,timeout:10000,maximumAge:300000});
}
function updateLocationToggleUI(){
  const tog=document.getElementById('locationToggle');
  const dot=document.getElementById('locationDot');
  const info=document.getElementById('locationInfo');
  if(!tog)return;
  const on=isLocationEnabled();
  tog.checked=on;
  if(dot)dot.style.transform=on?'translateX(18px)':'translateX(0)';
  if(dot)dot.style.background=on?'var(--accent)':'var(--text-muted)';
  if(info){
    const loc=getUserLocation();
    info.textContent=loc&&loc.display?loc.display:(on?'Locating...':'Off');
  }
}
// Refresh location periodically (every 30 min) if enabled
setInterval(()=>{if(isLocationEnabled())requestUserLocation();},1800000);

function startThinkingPhrases(el){
  let i=0;
  if(_thinkInterval)clearInterval(_thinkInterval);
  _thinkInterval=setInterval(()=>{
    if(!el||!el.isConnected){clearInterval(_thinkInterval);_thinkInterval=null;return;}
    i=(i+1)%_thinkPhrases.length;
    el.style.transition='opacity .3s ease, transform .3s ease';
    el.style.opacity='0';
    el.style.transform='translateY(-3px)';
    setTimeout(()=>{
      if(!el.isConnected)return;
      el.textContent=' '+_thinkPhrases[i];
      el.style.transform='translateY(3px)';
      requestAnimationFrame(()=>{
        el.style.opacity='1';
        el.style.transform='translateY(0)';
      });
    },300);
  },2800);
}

function stopThinkingPhrases(){
  if(_thinkInterval){clearInterval(_thinkInterval);_thinkInterval=null;}
}

function isChatRunning(chatId){
  return !!(chatId&&runningStreams.has(chatId));
}

function updateComposerBusyUI(){
  const busy=isChatRunning(curChat);
  const btnSend=document.getElementById('btnSend');
  const btnStop=document.getElementById('btnStop');
  if(btnSend)btnSend.style.display=busy?'none':'';
  if(btnStop)btnStop.style.display=busy?'':'none';
}

function setChatRunning(chatId,state,meta={}){
  if(!chatId)return;
  if(state){runningStreams.set(chatId,meta);}
  else{
    runningStreams.delete(chatId);
    // If this chat finished in the background, mark it unread
    if(chatId!==curChat)unreadChats.add(chatId);
    // Remove background generating indicator if visible
    const ind=document.getElementById('bg-gen-indicator');
    if(ind&&curChat===chatId)ind.remove();
  }
  renderChatList(document.getElementById('chatSearch')?.value||'');
  updateComposerBusyUI();
}

function stopStreaming(){
  if(!curChat)return;
  const run=runningStreams.get(curChat);
  if(run?.type==='research'){
    cancelCurrentResearch();
  }else if(run?.controller){
    run.controller.abort();
  }
}

function editMsg(btn){
  const msgEl=btn.closest('.msg');
  const text=msgEl.dataset.text||'';
  const input=document.getElementById('msgInput');
  input.value=text;autoResize(input);
  const next=msgEl.nextElementSibling;
  if(next&&(next.classList.contains('kairo')||next.classList.contains('msg')))next.remove();
  msgEl.remove();
  input.focus();
}

function retryMsg(btn){
  if(isChatRunning(curChat))return;
  const msgEl=btn.closest('.msg');
  let prev=msgEl.previousElementSibling;
  while(prev&&!prev.classList.contains('user')){prev=prev.previousElementSibling;}
  if(!prev){showToast('No previous message to retry.','info');return;}
  const text=prev.dataset.text||'';
  if(!text){showToast('Nothing to retry.','info');return;}
  msgEl.remove();
  document.getElementById('msgInput').value=text;
  sendMessage();
}

// ─── Auto Resume ──────────────────────────────────
async function tryAutoResume(){
  // Try to resume an authenticated session using a stored remember token
  const savedUid=localStorage.getItem('gyro_uid');
  const savedToken=localStorage.getItem('gyro_remember');
  if(savedUid && savedToken){
    try{
      const r=await fetch('/api/auth/resume',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({user_id:savedUid,remember_token:savedToken})});
      const d=await r.json();
      if(d.authenticated){
        curUser=d.user; curUser.plan=d.user.plan||'free';
        theme=d.user.theme||(window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');
        applyTheme(false);
        onboardingChecked=!!d.onboarding_complete;
        return true;
      }
    }catch{}
  }
  // Try to resume a guest session using stored guest_id
  const savedGid=localStorage.getItem('gyro_guest_id');
  if(savedGid){
    try{
      const r=await fetch('/api/auth/guest',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({guest_id:savedGid})});
      const d=await r.json();
      if(d.ok){
        isGuest=true; curUser={name:'Guest',email:'',plan:'guest'};
        return true;
      }
    }catch{}
  }
  return false;
}

// Wrap API fetch: on 401, try auto-resume once and retry
async function apiFetch(url, opts={}){
  let r=await fetch(url,opts);
  if(r.status===401 && !apiFetch._resuming){
    apiFetch._resuming=true;
    const ok=await tryAutoResume();
    apiFetch._resuming=false;
    if(ok) r=await fetch(url,opts);
    else { _handleSessionLost(); return r; }
  }
  return r;
}

// ─── Session keep-alive ───────────────────────────
function _handleSessionLost(){
  showToast('Session expired. Please sign in again.','info');
  curUser=null; curChat=null;
  document.getElementById('appPage').classList.remove('visible');
  document.getElementById('loginPage').style.display='flex';
  initGoogleAuthUI();
}

// Ping the server periodically to keep the session cookie alive
setInterval(async()=>{
  if(!curUser) return;
  try{ await fetch('/api/auth/me'); }catch{}
}, 10*60*1000); // every 10 minutes

// On tab re-focus, verify the session is still valid
document.addEventListener('visibilitychange', async()=>{
  if(document.visibilityState!=='visible' || !curUser) return;
  try{
    const r=await fetch('/api/auth/me');
    const d=await r.json();
    if(!d.authenticated && !d.guest){
      const ok=await tryAutoResume();
      if(!ok) _handleSessionLost();
    }
  }catch{}
});

// ─── Init ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded',async()=>{
  if(!localStorage.getItem('gyro_theme_override')){
    theme=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';
    applyTheme(false);
  }
  const r=await fetch('/api/auth/me');const d=await r.json();
  if(d.authenticated){
    curUser=d.user; curUser.plan=d.user.plan||'free';
    theme=d.user.theme||(window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');
    applyTheme(false);
    onboardingChecked=!!d.onboarding_complete;
    showApp();
  } else if(d.guest){
    isGuest=true; curUser={name:'Guest',email:'',plan:'guest'};
    showApp();
  } else {
    // Session lost — try to resume from localStorage
    const resumed = await tryAutoResume();
    if(resumed){
      showApp();
    } else {
      try{const o=await fetch('/api/oauth-config').then(r=>r.json());
        googleClientId=o.google_client_id||'';
      }catch{}
      document.getElementById('loginPage').style.display='flex';
      initGoogleAuthUI();
    }
  }
  initDropzone();
  refreshModeMenuUI();
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change',e=>{
    if(!localStorage.getItem('gyro_theme_override')){
      theme=e.matches?'light':'dark'; applyTheme(true);
    }
  });
});

function initGoogleAuthUI(retries=0){
  const wrap=document.getElementById('googleButton');
  const help=document.getElementById('googleHelp');
  if(!wrap||!help)return;
  if(!googleClientId){
    help.textContent='Google sign-in is missing a client ID.';
    return;
  }
  if(!window.google?.accounts?.id){
    if(retries<20){
      window.setTimeout(()=>initGoogleAuthUI(retries+1),250);
    }else{
      help.textContent='Google sign-in failed to load. Refresh the page.';
    }
    return;
  }
  if(!googleInitDone){
    google.accounts.id.initialize({client_id:googleClientId,callback:handleGoogleCred});
    googleInitDone=true;
  }
  wrap.innerHTML='';
  google.accounts.id.renderButton(wrap,{theme:'outline',size:'large',shape:'pill',text:'signin_with',width:250,logo_alignment:'left'});
  help.textContent='Use your Google account to sign in.';
}

function applyTheme(animated=true){
  if(animated){
    document.documentElement.style.setProperty('--theme-transition','background-color .5s ease, border-color .5s ease, color .4s ease');
  } else {
    document.documentElement.style.setProperty('--theme-transition','none');
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      document.documentElement.style.setProperty('--theme-transition','background-color .5s ease, border-color .5s ease, color .4s ease');
    }));
  }
  document.body.classList.toggle('light',theme==='light');
  const btn=document.getElementById('btnTheme');
  if(btn)btn.textContent=theme==='light'?'○':'●';
  const dark=document.getElementById('themeBtn_dark');
  const light=document.getElementById('themeBtn_light');
  if(dark&&light){
    const activeStyle='background:var(--bg-surface);color:var(--text-primary);border-radius:5px;';
    const inactiveStyle='background:transparent;color:var(--text-muted);';
    dark.style.cssText=(theme==='dark'?activeStyle:inactiveStyle)+'padding:7px 14px;font-size:11px;font-weight:500;border:none;cursor:pointer;transition:all .2s;';
    light.style.cssText=(theme==='light'?activeStyle:inactiveStyle)+'padding:7px 14px;font-size:11px;font-weight:500;border:none;cursor:pointer;transition:all .2s;';
  }
  initMermaidTheme();
}

function toggleTheme(){
  theme=theme==='light'?'dark':'light';
  localStorage.setItem('gyro_theme_override','1');
  applyTheme(true);
  fetch('/api/auth/theme',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({theme})});
}

/* ─── Dev Raw Log Mode ──────────────────────────── */
let devRawMode=localStorage.getItem('gyro_dev_raw')==='1';
function toggleDevRaw(on){
  devRawMode=!!on;
  localStorage.setItem('gyro_dev_raw',on?'1':'0');
  const dot=document.getElementById('devRawDot');
  if(dot)dot.style.transform=on?'translateX(18px)':'none';
  if(dot)dot.style.background=on?'var(--accent)':'var(--text-muted)';
  // Update topbar indicator
  const topDev=document.getElementById('devModeIndicator');
  if(topDev)topDev.style.display=on?'':'none';
  // Live re-render: re-render current chat to apply new mode
  if(curChat){
    reRenderCurrentChat();
  }
}
function initDevRawToggle(){
  const cb=document.getElementById('devRawToggle');
  if(!cb)return;
  cb.checked=devRawMode;
  // Update toggle visuals without re-rendering the chat
  const dot=document.getElementById('devRawDot');
  if(dot){
    dot.style.transform=devRawMode?'translateX(18px)':'none';
    dot.style.background=devRawMode?'var(--accent)':'var(--text-muted)';
  }
}

async function reRenderCurrentChat(){
  if(!curChat)return;
  try{
    const r=await apiFetch(`/api/chats/${curChat}`);
    if(!r.ok)return;
    const chat=await r.json();
    if(chat.error)return;
    const area=document.getElementById('chatArea');
    area.innerHTML='';
    _suppressCanvasAutoOpen=true;
    if(chat.messages?.length){
      for(const m of chat.messages){
        if(m.hidden)continue;
        if(m.role==='user')addMsg('user',m.text,[],m);
        else addMsg('kairo',m.text,m.files_modified||[],m);
      }
      _suppressCanvasAutoOpen=false;
      setTimeout(()=>{
        try{Promise.resolve(mermaid.run()).then(()=>enhanceMermaidDiagrams());}catch(e){}
      },200);
    }else{
      _suppressCanvasAutoOpen=false;
    }
  }catch(e){console.log('Re-render error:',e);}
}

// ─── Custom Dialog Engine ────────────────────────
let _dlgResolve=null;
function _dlg({title,msg,icon,iconType='info',confirmText='OK',cancelText=null,inputLabel=null,inputDefault='',inputPlaceholder='',dangerous=false}){
  return new Promise(resolve=>{
    _dlgResolve=resolve;
    document.getElementById('dlgTitle').textContent=title||'';
    document.getElementById('dlgMsg').textContent=msg||'';
    document.getElementById('dlgIconEmoji').textContent=icon||'ℹ️';
    const iconWrap=document.getElementById('dlgIconWrap');
    iconWrap.className='dlg-icon-wrap '+iconType;
    if(!icon){document.getElementById('dlgIconBand').style.display='none'}
    else{document.getElementById('dlgIconBand').style.display='flex'}
    const inputWrap=document.getElementById('dlgInputWrap');
    const input=document.getElementById('dlgInput');
    if(inputLabel!==null){
      inputWrap.style.display='block';
      document.getElementById('dlgInputLabel').textContent=inputLabel;
      input.value=inputDefault;
      input.placeholder=inputPlaceholder;
    } else {
      inputWrap.style.display='none';
      input.value='';
    }
    const actions=document.getElementById('dlgActions');
    actions.innerHTML='';
    if(cancelText!==null){
      const cancel=document.createElement('button');
      cancel.className='dlg-btn secondary';cancel.textContent=cancelText;
      cancel.onclick=()=>{_closeDlg();resolve(null)};
      actions.appendChild(cancel);
    }
    const ok=document.createElement('button');
    ok.className='dlg-btn '+(dangerous?'danger-btn':'primary');
    ok.textContent=confirmText;
    ok.onclick=()=>{
      const val=inputLabel!==null?input.value:true;
      _closeDlg();resolve(val);
    };
    actions.appendChild(ok);
    document.getElementById('dlgOverlay').classList.add('open');
    setTimeout(()=>(inputLabel!==null?input:ok).focus(),60);
    input.onkeydown=e=>{
      if(e.key==='Enter'){e.preventDefault();ok.click()}
      if(e.key==='Escape'){e.preventDefault();if(cancelText!==null){_closeDlg();resolve(null)}}
    };
  });
}

function _closeDlg(){document.getElementById('dlgOverlay').classList.remove('open');_dlgResolve=null}

document.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('dlgOverlay').addEventListener('click',e=>{
    if(e.target===document.getElementById('dlgOverlay')&&document.getElementById('dlgInputWrap').style.display==='none'){
      _closeDlg();if(_dlgResolve)_dlgResolve(null);
    }
  });
});

function showToast(message,type='info'){
  const wrap=document.getElementById('toastWrap');
  if(!wrap)return;
  const toast=document.createElement('div');
  toast.className=`toast ${type}`;
  toast.textContent=message;
  wrap.appendChild(toast);
  window.setTimeout(()=>{
    toast.style.transition='all .35s var(--ease)';
    toast.style.opacity='0';
    toast.style.transform='translateX(24px) scale(.95)';
    setTimeout(()=>toast.remove(),350);
  },2500);
}

function setStatus(message){
  const el=document.getElementById('statusText');
  if(el)el.textContent=message;
}

function setDraft(text){
  const input=document.getElementById('msgInput');
  if(!input)return;
  input.value=text;
  autoResize(input);
  input.focus();
  setStatus('Draft ready — edit it or hit send.');
}

async function showApp(){
  document.getElementById('loginPage').style.display='none';
  document.getElementById('appPage').classList.add('visible');
  allChats=loadCachedChats();
  hideSetupReminder();
  updateUserUI();
  // Initialize dev mode indicator in topbar
  const topDev=document.getElementById('devModeIndicator');
  if(topDev)topDev.style.display=devRawMode?'':'none';
  if(!curChat){ loadWelcome(); }
  await ensureOAuthConfigLoaded();
  await loadModels();
  await refreshChats();
  updateComposerBusyUI();
  document.getElementById('msgInput').focus();
  checkForUpdates();
  ensureOnboarding();
}

// ─── Changelog / Update Notification ──────────────
const LAST_SEEN_VERSION_KEY='gyro_last_seen_version';

async function checkForUpdates(){
  try{
    const r=await fetch('/api/changelog');
    if(!r.ok) return;
    const d=await r.json();
    const current=d.version;
    const lastSeen=localStorage.getItem(LAST_SEEN_VERSION_KEY);
    if(lastSeen===current) return;
    showChangelogModal(d.changelog, lastSeen, current);
  }catch{}
}

function showChangelogModal(changelog, lastSeen, currentVersion){
  const overlay=document.getElementById('changelogOverlay');
  const body=document.getElementById('clBody');
  const verEl=document.getElementById('clVersion');
  if(!overlay||!body) return;
  overlay._currentVersion=currentVersion;
  // Only show the most recent entry
  const latest=changelog[0];
  if(!latest) return;
  verEl.textContent=`v${latest.version} · ${_fmtChangelogDate(latest.date)}`;
  let html=`<div class="cl-entry cl-entry-new"><div class="cl-entry-head"><span class="cl-entry-ver">v${esc(latest.version)}</span><span class="cl-entry-title">${esc(latest.title)}</span><span class="cl-entry-date">${_fmtChangelogDate(latest.date)}</span></div><ul class="cl-changes">`;
  for(const c of latest.changes) html+=`<li>${esc(c)}</li>`;
  html+=`</ul></div>`;
  body.innerHTML=html;
  overlay.classList.add('open');
}

function dismissChangelog(){
  const overlay=document.getElementById('changelogOverlay');
  if(overlay._currentVersion){
    localStorage.setItem(LAST_SEEN_VERSION_KEY, overlay._currentVersion);
  }
  overlay.classList.remove('open');
}

function _versionCompare(a,b){
  const pa=a.split('.').map(Number), pb=b.split('.').map(Number);
  for(let i=0;i<Math.max(pa.length,pb.length);i++){
    const na=pa[i]||0, nb=pb[i]||0;
    if(na>nb) return 1;
    if(na<nb) return -1;
  }
  return 0;
}

function _fmtChangelogDate(dateStr){
  try{
    const d=new Date(dateStr+'T00:00:00');
    return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  }catch{ return dateStr; }
}

async function ensureOAuthConfigLoaded(){
  if(googleClientId)return;
  try{
    const o=await fetch('/api/oauth-config').then(r=>r.json());
    googleClientId=o.google_client_id||'';
  }catch{}
}

function normalizeMasterPrompt(text){
  return (text||'').replace(/\s+/g,' ').trim();
}

function getMasterPrompts(){
  return [
    {icon:'→',label:'Plan my day',q:'Help me organize and prioritize everything on my plate today. Ask me 2 quick clarifying questions before building the plan.'},
    {icon:'→',label:'Help me write',q:'Help me write or polish something. Start by asking what audience, tone, and outcome I want.'},
    {icon:'→',label:'Brainstorm',q:'Brainstorm ideas with me for a project or problem. Push for novel options, then rank the top 3.'},
    {icon:'→',label:'Research & analyze',q:'Help me research this topic deeply. Outline the scope first, then suggest a strong investigation path.'}
  ];
}

function buildMasterPromptCards(){
  return getMasterPrompts().map(a=>`<div class="wl-action-card" onclick="fillMasterPrompt('${a.q.replace(/'/g,"\\'")}')"><span class="wl-ac-icon">${a.icon}</span><span class="wl-ac-label">${a.label}</span><span class="wl-ac-sub">Editable master prompt</span></div>`).join('');
}

function hasWidgetContent(w){
  const type=(w?.type||'focus').toLowerCase();
  if(type==='recent'||type==='todos'||type==='nudge'||type==='workflow')return Array.isArray(w.items)&&w.items.length>0;
  if(type==='vision')return!!(w?.text||'').trim();
  if(type==='motivation')return!!(w?.text||'').trim();
  return true;
}

function renderHomeWidget(w){
  const type=(w?.type||'focus').toLowerCase();
  const size=(w?.size||'medium').toLowerCase();
  const title=esc(w?.title||'Widget');
  const subtitle=w?.subtitle?`<div class="wl-widget-sub">${esc(w.subtitle)}</div>`:'';
  const cls=`wl-widget wl-size-${size}`;

  if(type==='recent'){
    const items=Array.isArray(w.items)?w.items:[];
    if(!items.length)return'';
    const body=items.map(i=>`<div class="wl-recent-item" onclick="openChat('${esc(i.id||'')}')"><span class="wl-ri-title">${esc(i.title||'Untitled')}</span></div>`).join('');
    return `<div class="${cls}"><div class="wl-widget-hd">${title}</div>${subtitle}<div class="wl-recent-list">${body}</div></div>`;
  }
  if(type==='todos'){
    const items=Array.isArray(w.items)?w.items:[];
    if(!items.length)return'';
    const body=items.map(i=>{
      const doneClass=i.done?'wl-todo-done':'';
      const check=i.done?'✓':'○';
      // Extract chat ID from todo item ID (format: tl_CHATID_listIdx_itemIdx)
      const chatId=(i.id||'').split('_')[1]||'';
      const clickChat=chatId?`onclick="openChat('${esc(chatId)}')"`:''
      return `<div class="wl-todo-item ${doneClass}" data-todo-id="${esc(i.id||'')}" ${clickChat} style="${chatId?'cursor:pointer':''}">`
        +`<button class="wl-todo-check" onclick="event.stopPropagation();toggleHomeTodo('${esc(i.id||'')}')">${check}</button>`
        +`<span class="wl-todo-text">${esc(i.text||'')}</span>`
        +`<button class="wl-todo-del" onclick="event.stopPropagation();deleteHomeTodo('${esc(i.id||'')}')" title="Delete">✕</button>`
        +`</div>`;
    }).join('');
    return `<div class="${cls}"><div class="wl-widget-hd">${title}</div>${subtitle}<div class="wl-todo-list">${body}</div></div>`;
  }
  if(type==='nudge'){
    const items=Array.isArray(w.items)?w.items:[];
    if(!items.length)return'';
    const catIcons={'stale_chat':'⏸','task_overload':'📋','scope_creep':'📈','stalled_project':'🔄','deadline_soon':'⏰','resource_spread':'🎯','status_friction':'⚡','no_focus':'🧭'};
    const body=items.map(i=>{
      const icon=catIcons[i.category]||'●';
      const actionAttr=i.action?`data-nudge-action='${esc(JSON.stringify(i.action))}'`:'';
      return `<div class="wl-nudge-item" ${actionAttr}>`
        +`<span class="wl-nudge-icon">${icon}</span>`
        +`<div class="wl-nudge-body">`
        +`<div class="wl-nudge-msg">${esc(i.message||'')}</div>`
        +`<div class="wl-nudge-step">${esc(i.next_step||'')}</div>`
        +`</div>`
        +`<button class="wl-nudge-act" onclick="event.stopPropagation();handleNudgeAction(this)">Go</button>`
        +`</div>`;
    }).join('');
    return `<div class="${cls} wl-nudge-widget"><div class="wl-widget-hd">${title}</div>${subtitle}<div class="wl-nudge-list">${body}</div></div>`;
  }
  if(type==='vision'){
    const text=(w?.text||'').trim();
    if(!text)return'';
    const meta=w?.meta?`<div class="wl-vision-meta">${esc(w.meta)}</div>`:'';
    return `<div class="${cls}"><div class="wl-widget-hd">${title}</div>${subtitle}<div class="wl-vision-main">${esc(text)}</div>${meta}</div>`;
  }
  if(type==='crossref'){
    const items=Array.isArray(w.items)?w.items:[];
    if(!items.length)return'';
    const body=items.map(i=>`<div class="wl-crossref-item"><div class="wl-crossref-summary">${esc(i.summary||'')}</div></div>`).join('');
    return `<div class="${cls}"><div class="wl-widget-hd">${title}</div>${subtitle}<div class="wl-crossref-list">${body}</div></div>`;
  }
  if(type==='workflow'){
    const items=Array.isArray(w.items)?w.items:[];
    if(!items.length)return'';
    const body=items.map(i=>{
      const actionAttr=i.action?`data-nudge-action='${esc(JSON.stringify(i.action))}'`:'';
      return `<div class="wl-nudge-item" ${actionAttr}>`
        +`<span class="wl-nudge-icon">→</span>`
        +`<div class="wl-nudge-body">`
        +`<div class="wl-nudge-msg">${esc(i.detected||'')}</div>`
        +`<div class="wl-nudge-step">${esc(i.suggestion||'')}</div>`
        +`</div>`
        +(i.action?`<button class="wl-nudge-act" onclick="event.stopPropagation();handleNudgeAction(this)">Go</button>`:'')
        +`</div>`;
    }).join('');
    return `<div class="${cls} wl-nudge-widget"><div class="wl-widget-hd">${title}</div>${subtitle}<div class="wl-nudge-list">${body}</div></div>`;
  }
  if(type==='motivation'){
    const text=(w?.text||'').trim();
    if(!text)return'';
    return `<div class="${cls}"><div class="wl-widget-hd">${title}</div>${subtitle}<div class="wl-focus-copy">${esc(text)}</div></div>`;
  }
  return `<div class="${cls}"><div class="wl-widget-hd">${title}</div>${subtitle}<div class="wl-focus-copy">${esc(w?.text||'Ready when you are.')}</div></div>`;
}

function buildInstantHomePlan(greeting){
  const state=loadProductivityState();
  const todos=(state.todos||[]).filter(t=>!t.done).slice(0,5);
  const chats=(allChats||[]).slice(0,4);
  const pool=[];

  // Proactive friction detection — nudges (highest priority)
  const nudges=_detectClientFriction();
  if(nudges.length){
    pool.push({
      type:'nudge',
      size:'medium',
      title:'Needs your attention',
      subtitle:`${nudges.length} item${nudges.length!==1?'s':''}`,
      items:nudges,
    });
  }

  if(todos.length){
    pool.push({
      type:'todos',
      size:'medium',
      title:'Priority tasks',
      subtitle:`${todos.length} open`,
      items:todos,
    });
  }
  if(chats.length){
    pool.push({
      type:'recent',
      size:'medium',
      title:'Recent chats',
      items:chats.map(c=>({id:c.id,title:c.title||'Untitled'})),
    });
  }

  return {
    heading:'What would you like to work on today?',
    widgets:pool.slice(0,3),
  };
}

function getWelcomeHTML(greeting,homePlan){
  const displayGreeting=greeting!==undefined?greeting:getLocalTimeGreeting();
  const aiWidgets=Array.isArray(homePlan?.widgets)?homePlan.widgets:[];
  const validWidgets=aiWidgets.filter(hasWidgetContent);
  const dataCards=validWidgets.map(renderHomeWidget).filter(Boolean).join('');
  const promptCards=buildMasterPromptCards();

  // Only show data section if there are real widgets
  const dataSection=dataCards?`<div class="wl-data-section"><div class="wl-section-label">Your workspace</div><div class="wl-grid">${dataCards}</div></div>`:'';

  return `<div class="welcome">
    <div class="wl-hero">
      <h1 class="welcome-greeting">${displayGreeting}</h1>
      <p class="welcome-sub">What would you like to work on today?</p>
    </div>
    <div class="wl-prompts-section">
      <div class="wl-prompts-grid">${promptCards}</div>
    </div>
    ${dataSection}
  </div>`;
}

function typewriterEffect(el,text,speed=46){
  el.textContent='';
  let i=0;
  const tick=()=>{if(i<text.length){el.textContent+=text[i++];setTimeout(tick,speed)}};
  tick();
}

function loadCachedHomePlan(){
  try{
    const raw=localStorage.getItem(HOME_WIDGET_CACHE_KEY);
    if(!raw)return null;
    const parsed=JSON.parse(raw);
    return parsed&&typeof parsed==='object'?parsed:null;
  }catch{return null;}
}

function saveCachedHomePlan(plan){
  try{localStorage.setItem(HOME_WIDGET_CACHE_KEY,JSON.stringify(plan||{}));}catch{}
}

function hasCachedHomePlan(){
  const plan=loadCachedHomePlan();
  if(!plan||typeof plan!=='object')return false;
  return !!(plan.heading||Array.isArray(plan.widgets));
}

function isWelcomeScreenVisible(){
  const area=document.getElementById('chatArea');
  return !!area?.querySelector('.welcome');
}

async function precomputeHomeWidgets(allowLiveApply=true,greeting=''){
  if(homeWidgetRefreshInFlight)return;
  homeWidgetRefreshInFlight=true;
  try{
    const plan=await fetchHomeWidgetsPlan();
    const resolved=(plan&&typeof plan==='object')?plan:{};
    if(!resolved.heading&&!Array.isArray(resolved.widgets))return;
    saveCachedHomePlan(resolved);
    if(!allowLiveApply)return;
  }catch{}
  finally{homeWidgetRefreshInFlight=false;}
}

function startHomeWidgetPrecomputeLoop(){
  if(homeWidgetRefreshTimer)return;
  homeWidgetRefreshTimer=window.setInterval(()=>{
    precomputeHomeWidgets(false);
  },180000);
}

function widgetSpanForSize(size){
  return 1;
}

function pickWidgetsForGrid(widgets,maxUnits=8){
  const out=[];
  let used=0;
  for(const w of widgets){
    const span=widgetSpanForSize(w?.size);
    if(used+span>maxUnits)continue;
    out.push(w);
    used+=span;
    if(used>=maxUnits)break;
  }
  return out;
}

function getLocalTimeGreeting(){
  const hour=new Date().getHours();
  const rawName=(curUser?.name||'').split(' ')[0]||'';
  const uname=(rawName==='Guest'&&isGuest)?'':rawName;
  const namePart=uname?`, ${uname}`:'';
  const period=hour<5?'late night':hour<12?'morning':hour<17?'afternoon':hour<21?'evening':'late night';
  const presets={
    'late night':[
      `Burning the midnight oil${namePart}?`,
      `Late-night focus${namePart}?`,
      `Quiet hours, clear mind${namePart}.`,
      `The world sleeps${namePart}. You build.`,
      `Night owl mode activated${namePart}.`,
      `Still going strong${namePart}? 🌙`,
      `Deep into the night${namePart}.`,
      `Midnight clarity${namePart}.`,
      `The best ideas come late${namePart}.`,
      `No distractions now${namePart}.`,
    ],
    morning:[
      `Early start today${namePart}?`,
      `Morning focus, steady pace${namePart}.`,
      `Fresh morning energy${namePart}.`,
      `New day, new momentum${namePart}.`,
      `Rise and build${namePart}. ☀️`,
      `Morning brain is the best brain${namePart}.`,
      `Let's make today count${namePart}.`,
      `Good morning${namePart}. What's the plan?`,
      `The day is yours${namePart}.`,
      `Coffee and ideas${namePart}? ☕`,
      `Starting fresh${namePart}.`,
      `Clear mind, full day ahead${namePart}.`,
    ],
    afternoon:[
      `Afternoon rhythm holding up${namePart}?`,
      `Midday focus check${namePart}.`,
      `Keeping momentum this afternoon${namePart}?`,
      `Halfway through the day${namePart}.`,
      `Afternoon push${namePart}. Let's go.`,
      `Post-lunch productivity${namePart}? 🚀`,
      `Still crushing it${namePart}.`,
      `The afternoon stretch${namePart}.`,
      `Second wind kicking in${namePart}?`,
      `Keep the energy up${namePart}.`,
    ],
    evening:[
      `Evening stretch ahead${namePart}.`,
      `Winding down or diving in${namePart}?`,
      `Golden hour thoughts${namePart}.`,
      `Evening mode${namePart}. Time to reflect or create.`,
      `Wrapping up the day${namePart}?`,
      `One more thing before tonight${namePart}?`,
      `Good evening${namePart}. What's on your mind?`,
      `The quiet part of the day${namePart}. 🌅`,
      `End-of-day clarity${namePart}.`,
      `Evening glow, fresh perspective${namePart}.`,
    ],
  };
  const options=presets[period]||[`Ready when you are${namePart}.`];
  return options[Math.floor(Math.random()*options.length)];
}

async function loadWelcome(force=false){
  const area=document.getElementById('chatArea');
  if(curChat&&!force)return;
  _activeFolderView=null;
  const greeting=getLocalTimeGreeting();
  const instantPlan=buildInstantHomePlan(greeting);
  area.innerHTML=getWelcomeHTML(greeting,instantPlan);
}

function goHome(){
  curChat=null;
  _activeFolderView=null;
  document.getElementById('topTitle').textContent='New Chat';
  loadWelcome(true);
  renderChatList();
}

/* ─── Folder Meta (emoji, color) stored in localStorage ─── */
function _loadFolderMeta(){
  try{return JSON.parse(localStorage.getItem(FOLDER_META_KEY)||'{}');}catch{return {};}
}
function _saveFolderMeta(meta){
  try{localStorage.setItem(FOLDER_META_KEY,JSON.stringify(meta||{}));}catch{}
}
function getFolderMeta(folder){
  const all=_loadFolderMeta();
  return all[folder]||{};
}
function setFolderMeta(folder,patch){
  const all=_loadFolderMeta();
  all[folder]={...(all[folder]||{}),...patch};
  _saveFolderMeta(all);
}
function renameFolderMeta(oldName,newName){
  const all=_loadFolderMeta();
  if(all[oldName]){all[newName]=all[oldName];delete all[oldName];_saveFolderMeta(all);}
}
function deleteFolderMeta(folder){
  const all=_loadFolderMeta();
  delete all[folder];
  _saveFolderMeta(all);
}
function getFolderIcon(folder){
  const m=getFolderMeta(folder);
  return m.emoji||'📁';
}
function getFolderColor(folder){
  const m=getFolderMeta(folder);
  return m.color||'';
}

let _activeFolderView=null;

function openFolderView(folder){
  _activeFolderView=folder;
  curChat=null;
  const area=document.getElementById('chatArea');
  const chats=allChats.filter(c=>c.folder===folder);
  document.getElementById('topTitle').textContent=folder;
  const meta=getFolderMeta(folder);
  const fIcon=meta.emoji||'📁';
  const fColor=meta.color||'var(--accent)';
  const chatListHtml=chats.length?chats.map(c=>{
    const preview=c.messages?.length?`${c.messages.length} messages`:'Empty chat';
    return `<div class="fv-chat" onclick="openChat('${esc(c.id)}')">`
      +`<span class="fv-chat-icon">💬</span>`
      +`<div class="fv-chat-info"><div class="fv-chat-title">${esc(c.title||'Untitled')}</div><div class="fv-chat-meta">${preview}</div></div>`
      +`<span class="fv-chat-arrow">→</span></div>`;
  }).join('')
    :'<div class="fv-empty">No chats yet. Start one below.</div>';
  area.innerHTML=`<div class="folder-view">
    <div class="fv-hero">
      <div class="fv-hero-icon" style="background:${fColor}20;color:${fColor}">${fIcon}</div>
      <h1 class="fv-title">${esc(folder)}</h1>
      <p class="fv-subtitle">${chats.length} chat${chats.length!==1?'s':''}</p>
    </div>
    <div class="fv-actions">
      <button class="fv-action-btn fv-action-primary" onclick="createChat('${esc(folder).replace(/'/g,"\\'")}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        New Chat
      </button>
      <button class="fv-action-btn" onclick="customizeFolder('${esc(folder).replace(/'/g,"\\'")}')">🎨 Customize</button>
      <button class="fv-action-btn" onclick="renameFolderFromView('${esc(folder).replace(/'/g,"\\'")}')">✏️ Rename</button>
      <button class="fv-action-btn fv-action-danger" onclick="deleteFolderAndChats('${esc(folder).replace(/'/g,"\\'")}')">🗑 Delete</button>
    </div>
    <div class="fv-chat-list">${chatListHtml}</div>
  </div>`;
  renderChatList();
}

async function renameFolderFromView(oldName){
  const next=await _dlg({title:'Rename folder',msg:'',icon:'▸',iconType:'info',inputLabel:'New name',inputDefault:oldName,inputPlaceholder:'Folder name',confirmText:'Rename',cancelText:'Cancel'});
  if(!next?.trim()||next.trim()===oldName)return;
  const newName=next.trim();
  renameFolderMeta(oldName,newName);
  const chats=allChats.filter(c=>c.folder===oldName);
  for(const c of chats){
    await fetch(`/api/chats/${c.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder:newName})});
  }
  await refreshChats();
  openFolderView(newName);
  showToast('Folder renamed.','success');
}

async function customizeFolder(folder){
  const meta=getFolderMeta(folder);
  const emojis=['📁','💼','🎯','🚀','💡','📝','🎨','🔬','📚','🎮','🏠','❤️','⭐','🔥','🌟','💎','🎵','📸','🌍','🧪','✨','🤖','🛠️','📊',''];
  const colors=['','#bf6b3a','#e74c3c','#e67e22','#f1c40f','#2ecc71','#1abc9c','#3498db','#9b59b6','#e91e63','#00bcd4','#ff5722'];
  const colorNames=['Default','Orange','Red','Amber','Yellow','Green','Teal','Blue','Purple','Pink','Cyan','Deep Orange'];
  const curEmoji=meta.emoji||'📁';
  const curColor=meta.color||'';
  const emojiGrid=emojis.map(e=>{
    const label=e||'None';
    const sel=e===curEmoji||(e===''&&!curEmoji)?' fv-cust-sel':'';
    return `<button class="fv-cust-btn${sel}" onclick="this.closest('.fv-cust-popup').dataset.emoji='${e}';this.closest('.fv-cust-grid').querySelectorAll('.fv-cust-btn').forEach(b=>b.classList.remove('fv-cust-sel'));this.classList.add('fv-cust-sel')">${label}</button>`;
  }).join('');
  const colorGrid=colors.map((c,i)=>{
    const sel=c===curColor||(c===''&&!curColor)?' fv-cust-sel':'';
    const bg=c||'var(--text-muted)';
    return `<button class="fv-cust-color${sel}" style="background:${bg}" title="${colorNames[i]}" onclick="this.closest('.fv-cust-popup').dataset.color='${c}';this.closest('.fv-cust-grid').querySelectorAll('.fv-cust-color').forEach(b=>b.classList.remove('fv-cust-sel'));this.classList.add('fv-cust-sel')"></button>`;
  }).join('');

  const popup=document.createElement('div');
  popup.className='fv-cust-popup';
  popup.dataset.emoji=curEmoji;
  popup.dataset.color=curColor;
  popup.innerHTML=`
    <div class="fv-cust-overlay" onclick="this.parentElement.remove()"></div>
    <div class="fv-cust-modal">
      <h3>Customize "${esc(folder)}"</h3>
      <div class="fv-cust-section">
        <label>Icon</label>
        <div class="fv-cust-grid">${emojiGrid}</div>
      </div>
      <div class="fv-cust-section">
        <label>Color</label>
        <div class="fv-cust-grid">${colorGrid}</div>
      </div>
      <div class="fv-cust-footer">
        <button class="fv-cust-cancel" onclick="this.closest('.fv-cust-popup').remove()">Cancel</button>
        <button class="fv-cust-save" onclick="saveFolderCustomize(this)">Save</button>
      </div>
    </div>`;
  document.body.appendChild(popup);
}

function saveFolderCustomize(btn){
  const popup=btn.closest('.fv-cust-popup');
  const folder=_activeFolderView;
  if(!folder){popup.remove();return;}
  const emoji=popup.dataset.emoji||'';
  const color=popup.dataset.color||'';
  setFolderMeta(folder,{emoji,color});
  popup.remove();
  renderChatList();
  openFolderView(folder);
  showToast('Folder customized.','success');
}

function loadCachedChats(){
  try{
    const raw=localStorage.getItem(CHAT_CACHE_KEY);
    if(!raw)return [];
    const parsed=JSON.parse(raw);
    return Array.isArray(parsed)?parsed:[];
  }catch{return [];}
}

function saveCachedChats(chats){
  try{localStorage.setItem(CHAT_CACHE_KEY,JSON.stringify((chats||[]).slice(0,20)));}catch{}
}

async function fetchHomeWidgetsPlan(){
  const state=loadProductivityState();
  const payload={
    todos:(state.todos||[]).slice(0,10),
    visions:(state.visions||[]).slice(0,6),
  };
  try{
    const r=await fetch('/api/home-widgets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const d=await r.json();
    return d||{};
  }catch{
    return {};
  }
}

async function fillMasterPrompt(text){
  const normalized=normalizeMasterPrompt(text);
  const input=document.getElementById('msgInput');
  if(!input)return;
  input.value=normalized;
  autoResize(input);
  input.focus();
}

function updateUserUI(){
  if(!curUser)return;
  document.getElementById('userName').textContent=curUser.name||'User';
  document.getElementById('userEmail').textContent=curUser.email||'';
  document.getElementById('userAvatar').textContent=(curUser.name||'U')[0].toUpperCase();
  const planEl=document.getElementById('userPlan');
  if(planEl){
    const plan=curUser.plan||'free';
    const labels={guest:'Guest',free:'Free',pro:'Pro',max:'Max',dev:'DEV'};
    planEl.textContent=labels[plan]||'Free';
    planEl.className='plan-badge '+plan;
  }
}

// ─── Auth ─────────────────────────────────────────
async function handleGoogleCred(resp){
  try{
    const r=await fetch('/api/auth/google',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({credential:resp.credential})});
    const d=await r.json();
    if(d.error){document.getElementById('loginErr').textContent=d.error;return}
    curUser=d.user; curUser.plan=d.user.plan||'free';
    // Save remember token for auto-resume on session loss
    if(d.remember_token && d.user.id){
      localStorage.setItem('gyro_uid',d.user.id);
      localStorage.setItem('gyro_remember',d.remember_token);
      localStorage.removeItem('gyro_guest_id');
    }
    theme=d.user.theme||(window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');
    applyTheme(false); onboardingChecked=false; showApp();
  }catch(e){document.getElementById('loginErr').textContent='Google auth failed'}
}

async function guestLogin(){
  try{
    const prevGid=localStorage.getItem('gyro_guest_id')||'';
    const r=await fetch('/api/auth/guest',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({guest_id:prevGid})});
    const d=await r.json();
    if(d.ok){
      isGuest=true;curUser={name:'Guest',email:'',plan:'guest'};
      if(d.guest_id) localStorage.setItem('gyro_guest_id',d.guest_id);
      showApp();
    }
    else document.getElementById('loginErr').textContent=d.error||'Guest login failed';
  }catch(e){document.getElementById('loginErr').textContent='Guest login failed'}
}

async function signOut(){
  const ok=await _dlg({title:'Sign out',msg:'Are you sure you want to sign out of gyro?',icon:'⏻',iconType:'warn',confirmText:'Sign out',cancelText:'Cancel'});
  if(!ok)return;
  await fetch('/api/auth/logout',{method:'POST'});
  localStorage.removeItem('gyro_uid');
  localStorage.removeItem('gyro_remember');
  localStorage.removeItem('gyro_guest_id');
  curUser=null;curChat=null;allChats=[];isGuest=false;
  onboardingChecked=false;
  hideSetupReminder();
  document.getElementById('appPage').classList.remove('visible');
  document.getElementById('loginPage').style.display='flex';
  document.getElementById('loginErr').textContent='';
  googleInitDone=false;
  initGoogleAuthUI();
}

async function ensureOnboarding(force=false){
  if(isGuest||!curUser)return;
  if(onboardingChecked&&!force)return;
  try{
    const r=await fetch('/api/profile-onboarding');
    const d=await r.json();
    onboardingChecked=!!d.onboarding_complete;
    if(onboardingChecked){
      localStorage.removeItem(ONB_SKIP_KEY);
      localStorage.removeItem(ONB_NO_REMIND_KEY);
      sessionStorage.removeItem(ONB_DISMISS_KEY);
      hideSetupReminder();
      if(force){
        openOnboarding(d.profile||{});
      }
      return;
    }
    const skipped=localStorage.getItem(ONB_SKIP_KEY)==='1';
    const noRemind=localStorage.getItem(ONB_NO_REMIND_KEY)==='1';
    const dismissed=sessionStorage.getItem(ONB_DISMISS_KEY)==='1';
    if(force||!skipped){
      openOnboarding(d.profile||{});
      hideSetupReminder();
      return;
    }
    if(!noRemind&&!dismissed){
      showSetupReminder();
    }else{
      hideSetupReminder();
    }
  }catch{}
}

function showSetupReminder(){
  const bar=document.getElementById('setupReminder');
  if(!bar)return;
  bar.style.display='flex';
}

function hideSetupReminder(){
  const bar=document.getElementById('setupReminder');
  if(!bar)return;
  bar.style.display='none';
}

function dismissSetupReminder(){
  const noRemind=!!document.getElementById('setupDoNotRemind')?.checked;
  if(noRemind){
    localStorage.setItem(ONB_NO_REMIND_KEY,'1');
  }
  sessionStorage.setItem(ONB_DISMISS_KEY,'1');
  hideSetupReminder();
}

function openSetupFromReminder(){
  sessionStorage.removeItem(ONB_DISMISS_KEY);
  localStorage.removeItem(ONB_NO_REMIND_KEY);
  hideSetupReminder();
  ensureOnboarding(true);
}

function openSetupFromSettings(){
  closeM('settingsModal');
  sessionStorage.removeItem(ONB_DISMISS_KEY);
  ensureOnboarding(true);
}

function skipOnboarding(){
  localStorage.setItem(ONB_SKIP_KEY,'1');
  document.getElementById('onboardingModal').classList.remove('open');
  const noRemind=localStorage.getItem(ONB_NO_REMIND_KEY)==='1';
  if(!noRemind){
    showSetupReminder();
  }
}

function openOnboarding(profile={}){
  document.getElementById('onbName').value=profile.preferred_name||curUser?.name||'';
  document.getElementById('onbWork').value=profile.what_you_do||'';
  document.getElementById('onbHobbies').value=profile.hobbies||'';
  document.getElementById('onbFocus').value=profile.current_focus||'';
  document.getElementById('onbErr').textContent='';
  document.getElementById('onboardingModal').classList.add('open');
  setTimeout(()=>document.getElementById('onbName')?.focus(),60);
}

async function submitOnboarding(){
  const preferred_name=document.getElementById('onbName').value.trim();
  const what_you_do=document.getElementById('onbWork').value.trim();
  const hobbies=document.getElementById('onbHobbies').value.trim();
  const current_focus=document.getElementById('onbFocus').value.trim();
  const errEl=document.getElementById('onbErr');
  const btn=document.getElementById('onbSaveBtn');
  if(!preferred_name||!what_you_do||!hobbies){
    errEl.textContent='Please fill out your name, what you do, and your hobbies.';
    return;
  }
  btn.disabled=true;errEl.textContent='';
  try{
    const r=await fetch('/api/profile-onboarding',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({preferred_name,what_you_do,hobbies,current_focus})});
    const d=await r.json();
    if(!r.ok||d.error){
      errEl.textContent=d.error||'Failed to save setup.';
      btn.disabled=false;
      return;
    }
    onboardingChecked=true;
    localStorage.removeItem(ONB_SKIP_KEY);
    localStorage.removeItem(ONB_NO_REMIND_KEY);
    sessionStorage.removeItem(ONB_DISMISS_KEY);
    hideSetupReminder();
    if(curUser){curUser.name=(d.user?.name||preferred_name);updateUserUI();}
    document.getElementById('onboardingModal').classList.remove('open');
    showToast('All set! gyro is personalized for you.','success');
  }catch(e){
    errEl.textContent='Failed to save setup.';
    btn.disabled=false;
  }
}

// ─── Sidebar ──────────────────────────────────────
function toggleSB(){
  const sb=document.getElementById('sidebar');
  sb.classList.toggle('closed');
  const overlay=document.getElementById('sidebarOverlay');
  if(overlay){
    if(sb.classList.contains('closed'))overlay.classList.remove('active');
    else if(window.innerWidth<=768)overlay.classList.add('active');
  }
}

/* Download generated image as PNG */
async function downloadGenImage(url,prompt){
  try{
    let blob;
    if(url.startsWith('data:')){
      const resp=await fetch(url);blob=await resp.blob();
    }else{
      const resp=await fetch(url);blob=await resp.blob();
    }
    const name=(prompt||'generated_image').replace(/[^a-zA-Z0-9 ]/g,'').trim().replace(/\s+/g,'_').slice(0,60)||'generated_image';
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=name+'.png';
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }catch(e){showToast('Download failed','error');}
}
/* Download generated image from closest container */
function downloadGenFromEl(btn){
  const wrap=btn.closest('.img-gen-result');
  if(!wrap)return;
  const img=wrap.querySelector('.img-gen-output');
  const prompt=wrap.querySelector('.img-gen-prompt')?.textContent||'generated_image';
  if(img&&img.src)downloadGenImage(img.src,prompt);
}

/* Sidebar — close on outside click (mobile) */
document.addEventListener('click',function(e){
  if(window.innerWidth>768)return;
  const sb=document.getElementById('sidebar');
  if(!sb||sb.classList.contains('closed'))return;
  if(sb.contains(e.target))return;
  // Don't close if clicking the menu button itself
  if(e.target.closest('.btn-menu'))return;
  toggleSB();
});

/* Sidebar — swipe to close (mobile) */
(function(){
  let _swStartX=0,_swStartY=0,_swActive=false;
  document.addEventListener('touchstart',function(e){
    if(window.innerWidth>768)return;
    const sb=document.getElementById('sidebar');
    if(!sb||sb.classList.contains('closed'))return;
    _swStartX=e.touches[0].clientX;
    _swStartY=e.touches[0].clientY;
    _swActive=true;
  },{passive:true});
  document.addEventListener('touchend',function(e){
    if(!_swActive)return;
    _swActive=false;
    const dx=e.changedTouches[0].clientX-_swStartX;
    const dy=Math.abs(e.changedTouches[0].clientY-_swStartY);
    // Swipe left > 80px and more horizontal than vertical
    if(dx<-80&&dy<Math.abs(dx)){
      const sb=document.getElementById('sidebar');
      if(sb&&!sb.classList.contains('closed'))toggleSB();
    }
  },{passive:true});
})();

async function refreshChats(){
  const r=await apiFetch('/api/chats');const d=await r.json();
  allChats=d.chats||[];
  saveCachedChats(allChats);
  renderChatList();
}

function renderChatList(filter=''){
  const el=document.getElementById('chatList');
  const f=filter.toLowerCase();
  const fl=(f?allChats.filter(c=>c.title.toLowerCase().includes(f)):allChats);
  const grouped={};fl.forEach(c=>{const fld=c.folder||'';if(!grouped[fld])grouped[fld]=[];grouped[fld].push(c)});
  // Include empty folders from meta
  const folderMeta=_loadFolderMeta();
  for(const fld of Object.keys(folderMeta)){
    if(fld&&!grouped[fld])grouped[fld]=[];
  }
  let html='';const seen=new Set();
  for(const fld of ['',...Object.keys(grouped).filter(f=>f).sort()]){
    if(seen.has(fld)||!grouped[fld])continue;seen.add(fld);
    if(fld){
      const fldSel=selectMode&&_isFolderSelected(fld)?' selected':'';
      const chatCount=grouped[fld].length;
      const isCollapsed=_collapsedFolders.has(fld);
      const fIcon=getFolderIcon(fld);
      const fColor=getFolderColor(fld);
      const colorStyle=fColor?` style="color:${fColor}"`:'';
      html+=`<div class="sb-folder${fldSel}${isCollapsed?' collapsed':''}" data-folder="${esc(fld)}" onclick="openFolderView('${esc(fld).replace(/'/g,"\\'")}')">`;  
      if(selectMode)html+=`<input type="checkbox" class="sb-sel-cb" ${_isFolderSelected(fld)?'checked':''} onclick="event.stopPropagation();toggleSelectFolder('${esc(fld)}')">`;
      html+=`<span class="sf-arrow" onclick="event.stopPropagation();toggleFolderCollapse('${esc(fld)}')">${isCollapsed?'▸':'▾'}</span>`;
      html+=`<span class="sf-icon"${colorStyle}>${fIcon}</span>`;
      html+=`<span class="sf-label">${esc(fld)}</span>`;
      html+=`<span class="sf-count">${chatCount}</span>`;
      html+=`<button class="sf-dots" onclick="event.stopPropagation();toggleFolderMenu(this,'${esc(fld)}')" title="Folder options">⋮</button></div>`;
      if(isCollapsed) continue;
    }
    for(const c of grouped[fld]){
      const a=c.id===curChat?' active':'';
      const g=isChatRunning(c.id)?' generating':'';
      const u=unreadChats.has(c.id)?' unread':'';
      const sel=selectMode&&selectedItems.has(c.id)?' selected':'';
      html+=`<div class="sb-chat${a}${g}${u}${sel}" onclick="${selectMode?`toggleSelectChat('${c.id}')`:"openChat('"+c.id+"')"}">`;
      if(selectMode)html+=`<input type="checkbox" class="sb-sel-cb" ${selectedItems.has(c.id)?'checked':''} onclick="event.stopPropagation();toggleSelectChat('${c.id}')">`;
      html+=`<span class="ct">${esc(c.title)}</span><button class="cd" onclick="event.stopPropagation();showMoveMenu(this,'${c.id}')" title="Move to folder">📁</button><button class="cd" onclick="event.stopPropagation();renameChat('${c.id}')" title="Rename">✎</button><button class="cd" onclick="event.stopPropagation();delChat('${c.id}')">✕</button></div>`;
    }
  }
  el.innerHTML=html||'<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:11px;line-height:1.7">No chats yet.<br>Start a conversation to see it here.</div>';
  // Update select bar count
  const selBar=document.getElementById('selectBar');
  if(selBar){
    const cnt=selectedItems.size;
    document.getElementById('selCount').textContent=cnt?`${cnt} selected`:'None selected';
  }
}

function filterChats(){renderChatList(document.getElementById('chatSearch').value)}

async function renameChat(id){
  const chat=allChats.find(c=>c.id===id);
  const next=await _dlg({title:'Rename chat',msg:'',icon:'▸',iconType:'info',inputLabel:'New title',inputDefault:chat?.title||'',inputPlaceholder:'Chat title…',confirmText:'Rename',cancelText:'Cancel'});
  if(!next||!next.trim())return;
  await fetch(`/api/chats/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:next.trim()})});
  if(curChat===id)document.getElementById('topTitle').textContent=next.trim();
  await refreshChats();
  showToast('Chat renamed.','success');
}

async function createChat(folder=''){
  if(!curChat && !folder){
    loadWelcome(true);
    document.getElementById('msgInput').focus();
    return;
  }
  pendingFolder='';
  const r=await fetch('/api/chats',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder})});
  const c=await r.json();
  curChat=c.id;
  document.getElementById('chatArea').innerHTML='';
  loadWelcome(true);
  document.getElementById('topTitle').textContent=c.title||'New Chat';
  await refreshChats();
  updateComposerBusyUI();
  document.getElementById('msgInput').focus();
  setStatus('New chat saved. Ask anything to begin.');
}

async function newFolder(){
  const n=await _dlg({title:'New folder',msg:'',icon:'▸',iconType:'info',inputLabel:'Folder name',inputDefault:'',inputPlaceholder:'e.g. Work, Projects…',confirmText:'Create',cancelText:'Cancel'});
  if(!n?.trim())return;
  const name=n.trim();
  // Just create the folder entry in meta and add one empty chat to register the folder on the server
  // Actually - we just need at least one chat with that folder. Create no chat; use a placeholder approach.
  // To make the folder appear even with 0 chats, we store it in folderMeta and render it in sidebar.
  setFolderMeta(name,{emoji:'📁',color:''});
  renderChatList();
  openFolderView(name);
  showToast('Folder created.','success');
}
function toggleFolderCollapse(folder){
  if(_collapsedFolders.has(folder))_collapsedFolders.delete(folder);
  else _collapsedFolders.add(folder);
  renderChatList(document.getElementById('chatSearch')?.value||'');
}
function toggleFolderMenu(btn,folder){
  const existing=document.querySelector('.sf-menu');
  if(existing){existing.remove();return;}
  const menu=document.createElement('div');
  menu.className='sf-menu';
  menu.innerHTML=`<button onclick="renameFolderFromMenu('${folder.replace(/'/g,"\\'")}')">Rename</button><button onclick="customizeFolder('${folder.replace(/'/g,"\\'")}')">Customize</button><button onclick="deleteFolderFromMenu('${folder.replace(/'/g,"\\'")}')">Remove folder</button><button onclick="deleteFolderAndChats('${folder.replace(/'/g,"\\'")}')">Delete folder & chats</button>`;
  btn.parentElement.style.position='relative';
  btn.parentElement.appendChild(menu);
  const close=e=>{if(!menu.contains(e.target)&&e.target!==btn){menu.remove();document.removeEventListener('click',close)}};
  setTimeout(()=>document.addEventListener('click',close),0);
}
function showMoveMenu(btn,chatId){
  const existing=document.querySelector('.sf-menu');
  if(existing){existing.remove();return;}
  const chat=allChats.find(c=>c.id===chatId);
  const curFolder=chat?.folder||'';
  const folders=[...new Set([...allChats.map(c=>c.folder).filter(f=>f),...Object.keys(_loadFolderMeta())])].sort();
  const menu=document.createElement('div');
  menu.className='sf-menu';
  let items='';
  for(const f of folders){
    if(f===curFolder) continue;
    const safe=f.replace(/'/g,"\\'").replace(/</g,'&lt;');
    items+=`<button onclick="moveChat('${chatId}','${safe}')">📁 ${esc(f)}</button>`;
  }
  if(curFolder) items+=`<button onclick="moveChat('${chatId}','')">🚫 Remove from folder</button>`;
  if(!items) items='<div style="padding:8px 12px;color:var(--text-muted);font-size:11px">No folders yet</div>';
  menu.innerHTML=items;
  btn.closest('.sb-chat').style.position='relative';
  btn.closest('.sb-chat').appendChild(menu);
  const close=e=>{if(!menu.contains(e.target)&&e.target!==btn){menu.remove();document.removeEventListener('click',close)}};
  setTimeout(()=>document.addEventListener('click',close),0);
}
async function moveChat(chatId,folder){
  document.querySelector('.sf-menu')?.remove();
  await fetch(`/api/chats/${chatId}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder})});
  await refreshChats();
  if(_activeFolderView) openFolderView(_activeFolderView);
  showToast(folder?`Moved to ${folder}.`:'Removed from folder.','success');
}
async function renameFolderFromMenu(oldName){
  document.querySelector('.sf-menu')?.remove();
  const next=await _dlg({title:'Rename folder',msg:'',icon:'▸',iconType:'info',inputLabel:'New name',inputDefault:oldName,inputPlaceholder:'Folder name',confirmText:'Rename',cancelText:'Cancel'});
  if(!next?.trim()||next.trim()===oldName)return;
  renameFolderMeta(oldName,next.trim());
  const chats=allChats.filter(c=>c.folder===oldName);
  for(const c of chats){await fetch(`/api/chats/${c.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder:next.trim()})});}
  await refreshChats();showToast('Folder renamed.','success');
}
async function openFolderSettings(folder){
  document.querySelector('.sf-menu')?.remove();
  const chats=allChats.filter(c=>c.folder===folder);
  if(!chats.length){showToast('No chats in folder.','info');return;}
  curChat=chats[0].id;
  openChatDrawer();
}
async function deleteFolderFromMenu(folder){
  document.querySelector('.sf-menu')?.remove();
  const ok=await _dlg({title:'Remove folder',msg:'Chats will be moved out of the folder, not deleted.',icon:'▸',iconType:'danger',confirmText:'Remove folder',cancelText:'Cancel',dangerous:true});
  if(!ok)return;
  const chats=allChats.filter(c=>c.folder===folder);
  for(const c of chats){await fetch(`/api/chats/${c.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder:''})});}
  deleteFolderMeta(folder);
  await refreshChats();
  if(_activeFolderView===folder){goHome();}
  showToast('Folder removed.','success');
}

async function deleteFolderAndChats(folder){
  document.querySelector('.sf-menu')?.remove();
  const chats=allChats.filter(c=>c.folder===folder);
  const ok=await _dlg({title:'Delete folder & all chats',msg:`This will permanently delete the folder "${folder}" and ${chats.length} chat${chats.length!==1?'s':''} inside it.`,icon:'🔥',iconType:'danger',confirmText:`Delete ${chats.length} chat${chats.length!==1?'s':''}`,cancelText:'Cancel',dangerous:true});
  if(!ok)return;
  const ids=chats.map(c=>c.id);
  if(ids.length){
    await fetch('/api/chats/bulk-delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_ids:ids})});
  }
  deleteFolderMeta(folder);
  if(ids.includes(curChat)||_activeFolderView===folder){
    goHome();
  }
  await refreshChats();showToast(`Folder "${folder}" deleted.`,'success');
}

// ─── Multi-Select Mode ────────────────────────────
function toggleSelectMode(){
  selectMode=!selectMode;
  selectedItems.clear();
  const bar=document.getElementById('selectBar');
  if(bar)bar.style.display=selectMode?'flex':'none';
  renderChatList(document.getElementById('chatSearch')?.value||'');
}
function _isFolderSelected(folder){
  const chats=allChats.filter(c=>c.folder===folder);
  return chats.length>0&&chats.every(c=>selectedItems.has(c.id));
}
function toggleSelectChat(id){
  if(selectedItems.has(id))selectedItems.delete(id); else selectedItems.add(id);
  renderChatList(document.getElementById('chatSearch')?.value||'');
}
function toggleSelectFolder(folder){
  const chats=allChats.filter(c=>c.folder===folder);
  const allSelected=chats.every(c=>selectedItems.has(c.id));
  for(const c of chats){
    if(allSelected)selectedItems.delete(c.id); else selectedItems.add(c.id);
  }
  renderChatList(document.getElementById('chatSearch')?.value||'');
}
function selectAllChats(){
  for(const c of allChats)selectedItems.add(c.id);
  renderChatList(document.getElementById('chatSearch')?.value||'');
}
function deselectAllChats(){
  selectedItems.clear();
  renderChatList(document.getElementById('chatSearch')?.value||'');
}
async function deleteSelectedChats(){
  if(!selectedItems.size){showToast('Nothing selected.','info');return;}
  const count=selectedItems.size;
  const ok=await _dlg({title:`Delete ${count} chat${count!==1?'s':''}?`,msg:`This will permanently delete ${count} selected chat${count!==1?'s':''}.`,icon:'🔥',iconType:'danger',confirmText:`Delete ${count}`,cancelText:'Cancel',dangerous:true});
  if(!ok)return;
  const ids=[...selectedItems];
  await fetch('/api/chats/bulk-delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_ids:ids})});
  if(ids.includes(curChat)){
    goHome();
  } else if(!curChat){
    loadWelcome(true);
  }
  selectedItems.clear();
  await refreshChats();
  showToast(`${count} chat${count!==1?'s':''} deleted.`,'success');
}

// ─── Smart Home Widgets (async) ─────────────────
async function _loadSmartWidgets(){
  try{
    const [crRes, wfRes]=await Promise.all([
      fetch('/api/cross-references').then(r=>r.ok?r.json():null).catch(()=>null),
      fetch('/api/workflow-patterns').then(r=>r.ok?r.json():null).catch(()=>null),
    ]);
    const grid=document.querySelector('.wl-grid');
    if(!grid)return;
    // Add cross-reference widget if data exists
    if(crRes?.references?.length){
      const w={type:'crossref',size:'medium',title:'Cross-References',subtitle:`${crRes.references.length} connection${crRes.references.length!==1?'s':''}`,items:crRes.references.slice(0,5)};
      const html=renderHomeWidget(w);
      if(html)grid.insertAdjacentHTML('beforeend',html);
    }
    // Add workflow pattern widget if data exists
    if(wfRes?.patterns?.length){
      const w={type:'workflow',size:'medium',title:'Workflow Insights',subtitle:'Based on your recent activity',items:wfRes.patterns};
      const html=renderHomeWidget(w);
      if(html)grid.insertAdjacentHTML('beforeend',html);
    }
  }catch{}
}

async function openChat(id){
  if(curChat===id) return;
  _activeFolderView=null;
  curChat=id;
  unreadChats.delete(id);
  // Auto-close canvas when switching chats
  closeCanvas();
  const r=await apiFetch(`/api/chats/${id}`);
  if(!r.ok){
    // Chat no longer exists on server — remove from list and go to welcome
    showToast('Chat not found. It may have been deleted.','info');
    curChat=null;
    await refreshChats();
    loadWelcome(true);
    return;
  }
  const chat=await r.json();
  if(chat.error){
    showToast('Chat not found.','info');
    curChat=null;
    await refreshChats();
    loadWelcome(true);
    return;
  }
  document.getElementById('topTitle').textContent=chat.title||'New Chat';
  if(chat.model){
    const opts=document.querySelectorAll('.cms-opt');
    for(const opt of opts){
      if(opt.dataset.id===chat.model){
        selectModel(chat.model,opt.dataset.label,opt.dataset.provider,true);
        break;
      }
    }
  }
  const area=document.getElementById('chatArea');area.innerHTML='';
  _suppressCanvasAutoOpen=true;
  if(chat.messages?.length){
    for(const m of chat.messages){
      if(m.hidden)continue;
      if(m.role==='user')addMsg('user',m.text,[],m);
      else addMsg('kairo',m.text,m.files_modified||[],m);
    }
    _suppressCanvasAutoOpen=false;
    setTimeout(()=>{
      try{
        Promise.resolve(mermaid.run()).then(()=>enhanceMermaidDiagrams());
      }catch(e){
        console.log('Mermaid re-render:',e);
      }
    },200);
  }else{
    _suppressCanvasAutoOpen=false;
    loadWelcome(true);
  }
  // If this chat has an active stream, show a generating indicator
  if(isChatRunning(id)){
    const genDiv=document.createElement('div');
    genDiv.className='msg kairo';
    genDiv.id='bg-gen-indicator';
    genDiv.innerHTML='<div class="lbl">gyro</div><div class="msg-content"><div class="think-active"><div class="dots"><span></span><span></span><span></span></div><span> Generating...</span></div></div>';
    area.appendChild(genDiv);
    area.scrollTop=area.scrollHeight;
  }
  renderChatList(document.getElementById('chatSearch').value);
  updateComposerBusyUI();
  document.getElementById('msgInput').focus();
  setStatus('Chat loaded. Continue or ask for a summary.');
}

async function delChat(id){
  const ok=await _dlg({title:'Delete chat',msg:'This chat will be permanently deleted.',icon:'▸',iconType:'danger',confirmText:'Delete',cancelText:'Cancel',dangerous:true});
  if(!ok)return;
  try{
    const run=runningStreams.get(id);
    if(run?.controller)run.controller.abort();
    runningStreams.delete(id);
    await fetch(`/api/chats/${id}`,{method:'DELETE'});
    await refreshChats();
    if(curChat===id){
      goHome();
    } else if(_activeFolderView){
      // Re-render folder view to update the list
      openFolderView(_activeFolderView);
    } else if(!curChat){
      // On homepage — refresh the widget
      loadWelcome(true);
    }
    updateComposerBusyUI();
  }catch{
    showToast('Could not delete chat right now.','error');
  }
}

// ─── Models ───────────────────────────────────────
let currentModel='';
const logoUrls={
  google:'/static/logos/google.svg',
  openai:'/static/logos/openai.svg',
  anthropic:'/static/logos/anthropic.svg',
};

function logoImg(provider){
  const src=logoUrls[provider]||logoUrls.custom;
  return `<img class="plogo" data-p="${esc(provider)}" src="${src}" width="16" height="16">`;
}

async function loadModels(){
  try{
    const r=await fetch('/api/models');const d=await r.json();
    const drop=document.getElementById('cmsDropdown');drop.innerHTML='';
    for(const m of d.models){
      const opt=document.createElement('div');
      const locked=!m.available&&m.locked_reason==='upgrade_required';
      const unavailable=!m.available&&m.locked_reason!=='upgrade_required';
      opt.className='cms-opt'+(locked?' locked':'')+(unavailable?' locked':'');
      opt.dataset.id=m.id;
      opt.dataset.label=m.label;
      opt.dataset.provider=m.provider;
      opt.dataset.locked=locked?'1':'0';
      let badgeHTML=m.tier==='free'
        ?'<span class="cms-badge free">free</span>'
        :m.tier==='pro'?'<span class="cms-badge pro">pro</span>':'';
      const lockIcon=locked?'<span class="lock-icon">•</span>':'';
      opt.innerHTML=`${logoImg(m.provider)} <span>${esc(m.label)}</span>${badgeHTML}${lockIcon}`;
      opt.onclick=()=>{
        if(locked){showUpgradeForModel(m);return;}
        if(unavailable){showToast(m.locked_reason||'Model unavailable','error');return;}
        selectModel(m.id,m.label,m.provider);
      };
      drop.appendChild(opt);
      if(m.id===d.selected){
        document.getElementById('cmsCurrentIcon').innerHTML=logoImg(m.provider);
        document.getElementById('cmsCurrentText').textContent=m.label;
        currentModel=m.id;
      }
    }
  }catch(e){console.error('loadModels failed',e)}
}

function showUpgradeForModel(m){
  document.getElementById('cmsDropdown')?.classList.remove('show');
  openUpgradeModal();
  document.getElementById('upgradeModalSubtitle').textContent=
    `${m.label} requires a Pro or Max plan. Upgrade to unlock all models.`;
}

function openUpgradeModal(){
  const plan=curUser?.plan||'free';
  document.getElementById('upgradeModalSubtitle').textContent='Manage your gyro plan.';
  ['Free','Pro','Max','Dev'].forEach(p=>{
    const el=document.getElementById('uplan'+p);
    if(el)el.classList.toggle('current',plan===p.toLowerCase());
  });
  ['free','pro','max','dev'].forEach(p=>{
    const btn=document.getElementById('upgradeBtn_'+p);
    if(btn)btn.classList.toggle('active',plan===p);
  });
  document.getElementById('upgradeModal').classList.add('open');
}

async function applyPlanChange(plan){
  if(!plan||!['free','pro','max','dev'].includes(plan))return;
  if(isGuest||!curUser){
    showToast('Sign in with Google to change plans.','info');
    return;
  }
  // Warn for non-dev plan changes (payments not available yet)
  if(plan!=='dev'){
    showToast('Plan purchasing is not available yet. Use the Developer plan for full access.','info');
    return;
  }
  try{
    const r=await fetch('/api/auth/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan})});
    const d=await r.json();
    if(!r.ok||d.error){
      showToast(d.error||'Could not update plan.','error');
      return;
    }
    curUser.plan=plan;
    updateUserUI();
    await loadModels();
    ['Free','Pro','Max','Dev'].forEach(p=>{
      const el=document.getElementById('uplan'+p);
      if(el)el.classList.toggle('current',plan===p.toLowerCase());
    });
    ['free','pro','max','dev'].forEach(p=>{
      const btn=document.getElementById('upgradeBtn_'+p);
      if(btn)btn.classList.toggle('active',plan===p);
    });
    showToast(`Plan switched to ${plan.toUpperCase()}.`,'success');
  }catch{
    showToast('Could not update plan.','error');
  }
}

async function selectModel(id,label,provider,skipUpdate=false){
  const drop=document.getElementById('cmsDropdown');
  if(drop)drop.classList.remove('show');
  if(id===currentModel)return;
  currentModel=id;
  const cmsEl=document.getElementById('cmsCurrent');
  cmsEl.classList.add('switching');
  setTimeout(()=>cmsEl.classList.remove('switching'),350);
  document.getElementById('cmsCurrentIcon').innerHTML=logoImg(provider);
  document.getElementById('cmsCurrentText').textContent=label;
  if(!skipUpdate){
    const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({selected_model:id})});
    const d=await r.json();
    if(d.error){
      showToast(d.error,'error');
      await loadModels();
      return;
    }
    if(curChat)await fetch(`/api/chats/${curChat}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:id})});
    showToast(`Switched to ${label}`,'success');
  }
}

function refreshModeMenuUI(){
  const thinkItem=document.getElementById('thinkMenuItem');
  const thinkBadge=document.getElementById('thinkMenuBadge');
  const isOn=thinkingLevel&&thinkingLevel!=='off';
  if(thinkItem)thinkItem.classList.toggle('active',isOn);
  if(thinkBadge)thinkBadge.textContent=isOn?thinkingLevel.toUpperCase():'OFF';
  document.querySelectorAll('.think-lvl').forEach(b=>b.classList.toggle('active',b.dataset.lvl===thinkingLevel));
}

function setThinkingLevel(lvl){
  thinkingLevel=lvl;
  refreshModeMenuUI();
  showToast(`Thinking: ${lvl==='off'?'off':lvl}`,lvl==='off'?'info':'success');
  closePlusMenu();
}

document.addEventListener('click',e=>{
  if(!e.target.closest('#cmsContainer')){
    document.getElementById('cmsDropdown')?.classList.remove('show');
  }
  if(!e.target.closest('.plus-menu-wrap')){
    closePlusMenu();
  }
});

// ─── File Upload ──────────────────────────────────
function handleFiles(input){
  for(const file of input.files){
    const reader=new FileReader();
    reader.onload=async()=>{
      const form=new FormData();form.append('file',file);
      try{
        const r=await fetch('/api/upload',{method:'POST',body:form});
        const d=await r.json();
        pendingFiles.push({name:d.name,mime:d.mime,data:d.image_data||'',text:d.text||'',doc_data:d.doc_data||''});
        renderPF();
      }catch(e){console.error('Upload failed',e)}
    };
    reader.readAsArrayBuffer(file);
  }
  input.value='';
}

function renderPF(){
  document.getElementById('filePreview').innerHTML=pendingFiles.map((f,i)=>{
    const t=f.mime?.startsWith('image/')&&f.data?`<img src="data:${f.mime};base64,${f.data}">`:f.doc_data?'📄':'▪';
    return`<div class="file-chip">${t} ${esc(f.name)} <button class="fc-x" onclick="pendingFiles.splice(${i},1);renderPF()">✕</button></div>`;
  }).join('');
  if(pendingFiles.length)setStatus(`${pendingFiles.length} file${pendingFiles.length===1?'':'s'} attached and ready.`);
}

/* ─── Reply Context (images + text from chat) ─── */
function addReplyImage(url,title){
  if(pendingReplies.some(r=>r.type==='image'&&r.url===url))return;
  pendingReplies.push({type:'image',url:url,title:title||''});
  renderReplyContext();
}
function addReplyText(text){
  if(!text||!text.trim())return;
  pendingReplies.push({type:'text',text:text.trim()});
  renderReplyContext();
}
function removeReply(i){
  pendingReplies.splice(i,1);
  renderReplyContext();
}
function renderReplyContext(){
  const wrap=document.getElementById('replyContext');
  if(!wrap)return;
  if(!pendingReplies.length){wrap.innerHTML='';wrap.style.display='none';return;}
  wrap.style.display='flex';
  wrap.innerHTML=pendingReplies.map((r,i)=>{
    if(r.type==='image'){
      return `<div class="reply-chip reply-chip-img"><img src="${esc(r.url)}" alt="${esc(r.title)}"><span class="reply-chip-label">${esc(r.title?r.title.slice(0,30):'Image')}</span><button class="rc-x" onclick="removeReply(${i})">✕</button></div>`;
    }
    const short=r.text.length>50?r.text.slice(0,50)+'…':r.text;
    return `<div class="reply-chip reply-chip-text"><span class="reply-chip-icon">💬</span><span class="reply-chip-label">${esc(short)}</span><button class="rc-x" onclick="removeReply(${i})">✕</button></div>`;
  }).join('');
}
function clearReplyContext(){pendingReplies=[];renderReplyContext();}

function initDropzone(){
  const area=document.querySelector('.input-area');
  const fileInput=document.getElementById('fileInput');
  if(!area||!fileInput)return;
  ['dragenter','dragover'].forEach(evt=>area.addEventListener(evt,e=>{e.preventDefault();area.classList.add('dragover');}));
  ['dragleave','drop'].forEach(evt=>area.addEventListener(evt,e=>{e.preventDefault();if(evt==='drop')return;area.classList.remove('dragover');}));
  area.addEventListener('drop',e=>{
    area.classList.remove('dragover');
    if(!e.dataTransfer?.files?.length)return;
    fileInput.files=e.dataTransfer.files;
    handleFiles(fileInput);
    showToast('Files added.','success');
  });
  document.addEventListener('paste',e=>{
    const items=e.clipboardData?.items;if(!items)return;
    for(const item of items){
      if(item.type.startsWith('image/')){
        e.preventDefault();
        const blob=item.getAsFile();if(!blob)continue;
        const form=new FormData();
        form.append('file',blob,'pasted_image.png');
        fetch('/api/upload',{method:'POST',body:form}).then(r=>r.json()).then(d=>{
          pendingFiles.push({name:d.name,mime:d.mime,data:d.image_data||'',text:d.text||'',doc_data:d.doc_data||''});
          renderPF();showToast('Image pasted','success');
        }).catch(()=>showToast('Paste upload failed','error'));
        break;
      }
    }
  });
}

// ─── Plus Menu ────────────────────────────────────
function togglePlusMenu(){
  const btn=document.getElementById('plusBtn');
  const popup=document.getElementById('plusPopup');
  const isOpen=popup.classList.contains('open');
  btn.classList.toggle('open',!isOpen);
  popup.classList.toggle('open',!isOpen);
}

function closePlusMenu(){
  document.getElementById('plusBtn')?.classList.remove('open');
  document.getElementById('plusPopup')?.classList.remove('open');
}

async function pasteFromClipboard(){
  try{
    const items=await navigator.clipboard.read();
    for(const item of items){
      for(const type of item.types){
        if(type.startsWith('image/')){
          const blob=await item.getType(type);
          const form=new FormData();form.append('file',blob,'pasted_image.png');
          const r=await fetch('/api/upload',{method:'POST',body:form});const d=await r.json();
          pendingFiles.push({name:d.name,mime:d.mime,data:d.image_data||'',text:d.text||'',doc_data:d.doc_data||''});
          renderPF();showToast('Image pasted','success');return;
        }
      }
    }
    showToast('No image in clipboard','info');
  }catch(e){showToast('Clipboard access denied — try Ctrl+V instead','info')}
}

let activeTools=new Set();

function activateTool(tool){
  if(activeTools.has(tool)){
    activeTools.delete(tool);
    showToast(`${tool.charAt(0).toUpperCase()+tool.slice(1)} tool deactivated`,'info');
  } else {
    activeTools.add(tool);
    showToast(`${tool.charAt(0).toUpperCase()+tool.slice(1)} tool activated`,'success');
  }
  renderToolBadges();
  document.getElementById('msgInput').focus();
}

function renderToolBadges(){
  let wrap=document.getElementById('toolBadges');
  if(!wrap){
    const inputRow=document.querySelector('.input-row');
    if(!inputRow)return;
    wrap=document.createElement('div');
    wrap.id='toolBadges';
    wrap.className='tool-badges';
    inputRow.parentElement.insertBefore(wrap,inputRow);
  }
  if(!activeTools.size){wrap.style.display='none';return;}
  wrap.style.display='flex';
  const names={canvas:'Canvas',search:'Web Search',mindmap:'Mind Map',research:'Deep Research',summarize:'Summarize',code:'Code Execution',imagegen:'Image Generation'};
  wrap.innerHTML=[...activeTools].map(t=>`<span class="tool-badge" onclick="activateTool('${t}')">${names[t]||t} <span class="tb-x">×</span></span>`).join('');
}

function toggleResearch(){
  activateTool('research');
}

function openResearchModal(){
  const q=document.getElementById('msgInput')?.value?.trim()||'';
  const rq=document.getElementById('researchQuery');
  if(rq&&!rq.value.trim()&&q)rq.value=q;
  document.getElementById('researchDepth').value=deepResearchDepth;
  // Reset to phase 1
  document.getElementById('researchPhase1').style.display='';
  document.getElementById('researchPhase2').style.display='none';
  document.getElementById('researchPhaseLoading').style.display='none';
  document.getElementById('researchPlanBtn').disabled=false;
  document.getElementById('researchModal').classList.add('open');
}

let _researchPlanData=null;

async function generateResearchPlan(){
  const q=(document.getElementById('researchQuery').value||'').trim();
  if(!q){showToast('Add a research question first.','info');return;}
  deepResearchDepth=document.getElementById('researchDepth').value||'standard';
  const btn=document.getElementById('researchPlanBtn');
  btn.disabled=true;
  document.getElementById('researchPhase1').style.display='none';
  document.getElementById('researchPhaseLoading').style.display='';
  try{
    const r=await apiFetch('/api/research/plan',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({query:q,depth:deepResearchDepth})});
    const d=await r.json();
    if(!r.ok||d.error){
      showToast(d.error||'Failed to generate plan.','error');
      document.getElementById('researchPhase1').style.display='';
      document.getElementById('researchPhaseLoading').style.display='none';
      btn.disabled=false;
      return;
    }
    _researchPlanData={query:q,depth:deepResearchDepth,angles:d.angles||[]};
    // Show plan editor
    document.getElementById('researchPlanQuery').textContent=q;
    const planText=(d.angles||[]).map((a,i)=>`${i+1}. ${a}`).join('\n');
    document.getElementById('researchPlanEditor').value=planText;
    document.getElementById('researchPhaseLoading').style.display='none';
    document.getElementById('researchPhase2').style.display='';
  }catch(e){
    showToast('Failed to generate plan: '+e.message,'error');
    document.getElementById('researchPhase1').style.display='';
    document.getElementById('researchPhaseLoading').style.display='none';
    btn.disabled=false;
  }
}

function backToResearchInput(){
  document.getElementById('researchPhase2').style.display='none';
  document.getElementById('researchPhase1').style.display='';
  document.getElementById('researchPlanBtn').disabled=false;
}

async function confirmResearchPlan(){
  if(!_researchPlanData)return;
  const planText=document.getElementById('researchPlanEditor').value.trim();
  if(!planText){showToast('Plan cannot be empty.','info');return;}
  closeM('researchModal');
  const input=document.getElementById('msgInput');
  input.value=_researchPlanData.query;
  deepResearchDepth=_researchPlanData.depth;
  if(!activeTools.has('research')) activateTool('research');
  // Pass the plan along through a temporary global
  window._pendingResearchPlan=planText;
  await sendMessage();
  // Note: _pendingResearchPlan is consumed in the research_trigger handler, don't clear here
}

async function startResearchFromModal(){
  const q=(document.getElementById('researchQuery').value||'').trim();
  if(!q){showToast('Add a research question first.','info');return;}
  deepResearchDepth=document.getElementById('researchDepth').value||'standard';
  closeM('researchModal');
  const input=document.getElementById('msgInput');
  input.value=q;
  if(!activeTools.has('research')){
    activateTool('research');
  }
  await sendMessage();
}

let _currentResearchJobId=null;
let _currentResearchReader=null;

async function cancelCurrentResearch(){
  if(!_currentResearchJobId)return;
  try{await apiFetch(`/api/research/cancel/${_currentResearchJobId}`,{method:'POST'})}catch(e){}
}

async function runDeepResearch(query,contentEl,area,planText){
  const depth='standard';

  const stepNames=['Start','Research','Export'];
  const stepIcons=['1','2','3'];
  let currentPct=0, currentStep=0, lastMessage='Initializing Gemini Deep Research...';
  let wasCancelled=false;
  let researchCompleted=false;
  let finalReport='';
  let finalSources=[];
  let finalQuery=query;

  // Build initial progress card HTML once
  const stepsInitHtml=stepNames.map((name,i)=>{
    return `<div class="research-step" data-rs="${i}"><div class="research-step-dot">${i+1}</div><div class="research-step-label">${name}</div></div>`;
  }).join('');
  contentEl.innerHTML=`
    <div class="research-badge">🔬 Gemini Deep Research</div>
    <div class="research-progress" id="_rp">
      <div class="research-progress-header">
        <span class="research-progress-title" id="_rpTitle">Plan...</span>
        <span class="research-progress-pct" id="_rpPct">0%</span>
      </div>
      <div class="research-bar-track">
        <div class="research-bar-fill" id="_rpBar" style="width:0%"></div>
      </div>
      <div class="research-steps" id="_rpSteps">
        <div class="research-steps-line"><div class="research-steps-line-fill" id="_rpLine" style="width:0%"></div></div>
        ${stepsInitHtml}
      </div>
      <div class="research-activity">
        <span class="research-activity-dot"></span>
        <span id="_rpMsg">Initializing Gemini Deep Research...</span>
      </div>
      <div class="research-log" id="_rpLog"><div class="rline">⏳ Starting Gemini Deep Research...</div></div>
    </div>`;
  area.scrollTop=area.scrollHeight;
  let _logLines=1;

  // Update existing DOM nodes in-place — no layout thrash
  const renderProgressBar=()=>{
    const titleEl=document.getElementById('_rpTitle');
    const pctEl=document.getElementById('_rpPct');
    const barEl=document.getElementById('_rpBar');
    const lineEl=document.getElementById('_rpLine');
    const msgEl=document.getElementById('_rpMsg');
    const stepsEl=document.getElementById('_rpSteps');
    const logEl=document.getElementById('_rpLog');
    if(!titleEl)return;
    titleEl.textContent=currentStep<stepNames.length?stepNames[currentStep]+'...':'Complete...';
    pctEl.textContent=Math.round(currentPct)+'%';
    barEl.style.width=currentPct+'%';
    const lineProgress=currentStep>0?Math.min(((currentStep)/(stepNames.length-1))*100,100):0;
    lineEl.style.width=lineProgress+'%';
    msgEl.textContent=lastMessage;
    // Append to activity log
    if(logEl&&lastMessage){
      const line=document.createElement('div');
      line.className='rline';
      line.textContent=`[${Math.round(currentPct)}%] ${lastMessage}`;
      logEl.appendChild(line);
      logEl.scrollTop=logEl.scrollHeight;
      _logLines++;
    }
    // Update step dots
    if(stepsEl){
      const dots=stepsEl.querySelectorAll('.research-step');
      dots.forEach((dot,i)=>{
        dot.className='research-step'+(i<currentStep?' done':(i===currentStep?' active':''));
        const dotInner=dot.querySelector('.research-step-dot');
        if(dotInner)dotInner.textContent=i<currentStep?'✓':(i===currentStep?stepIcons[i]:String(i+1));
      });
    }
  };

  const bodyObj={query};
  const response=await apiFetch('/api/research',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(bodyObj)
  });
  if(!response.ok){
    const d=await response.json().catch(()=>({error:'Failed to start research.'}));
    throw new Error(d.error||'Failed to start research.');
  }

  const reader=response.body.getReader();
  _currentResearchReader=reader;
  const decoder=new TextDecoder();
  let buffer='';
  let lastEventTime=Date.now();
  const STALL_TIMEOUT=600000; // 10 minutes — deep research can take up to 20 min

  while(true){
    // Race between reading and a stall timeout
    let stallTimer;
    const timeoutPromise=new Promise((_,reject)=>{
      stallTimer=setTimeout(()=>reject(new Error('Research appears stalled — no response from server for 10 minutes. Try again with a simpler query.')),STALL_TIMEOUT);
    });
    let readResult;
    try{
      readResult=await Promise.race([reader.read(),timeoutPromise]);
    }catch(e){
      clearTimeout(stallTimer);
      try{reader.cancel()}catch(_){}
      throw e;
    }
    clearTimeout(stallTimer);
    const{done,value}=readResult;
    if(done)break;
    lastEventTime=Date.now();
    buffer+=decoder.decode(value,{stream:true});
    let nl;
    while((nl=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,nl).trim();
      buffer=buffer.slice(nl+1);
      if(!line)continue;
      let evt=null;
      try{evt=JSON.parse(line)}catch(e){continue}

      if(evt.type==='job_id'){
        _currentResearchJobId=evt.job_id;
      }else if(evt.type==='heartbeat'){
        // Keep-alive, ignore
      }else if(evt.type==='progress'){
        lastMessage=evt.message||'Working...';
        if(typeof evt.pct==='number') currentPct=evt.pct;
        if(typeof evt.current_step==='number') currentStep=evt.current_step-1;
        if(currentStep<0)currentStep=0;
        renderProgressBar();
      }else if(evt.type==='cancelled'){
        wasCancelled=true;
        contentEl.innerHTML=`
          <div class="research-badge">⏹ Research stopped</div>
          <div style="margin-top:10px;color:var(--text-secondary)">Research was cancelled.</div>
          <button class="research-regen-btn" onclick="regenerateResearch('${esc(query).replace(/'/g,"\\'")}')">🔄 Regenerate</button>`;
        setStatus('Research cancelled.');
      }else if(evt.type==='done'){
        currentPct=100;
        currentStep=stepNames.length;
        lastMessage='Research complete!';
        const report=evt.report||'';
        const srcs=evt.sources||[];
        const isPartial=!!evt.partial;
        finalReport=report;
        finalSources=srcs;
        const srcHtml=srcs.slice(0,15).map((s,i)=>`<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title||('Source '+(i+1)))}</a></li>`).join('');
        const dl=[];
        if(evt.pdf_file)dl.push(`<a class="choice-btn" href="/api/research/download/${encodeURIComponent(evt.pdf_file)}">Download PDF</a>`);
        if(evt.md_file)dl.push(`<a class="choice-btn" href="/api/research/download/${encodeURIComponent(evt.md_file)}">Download Markdown</a>`);
        // Post-processing buttons (separate pipelines)
        const ppBtns=[];
        if(!evt.pdf_file)ppBtns.push(`<button class="choice-btn" onclick="postprocessPDF(this)" data-query="${esc(query).replace(/"/g,'&quot;')}">📄 Generate PDF</button>`);
        ppBtns.push(`<button class="choice-btn" onclick="postprocessMindmap(this)" data-query="${esc(query).replace(/"/g,'&quot;')}">🧠 Build Mind Map</button>`);
        const partialNote=isPartial?`<div class="research-partial-note" style="background:var(--surface-2);border-left:3px solid var(--amber);padding:8px 12px;margin:8px 0;border-radius:6px;font-size:0.9em;color:var(--text-secondary)">⚠️ This report was generated from partial data. ${evt.error_note||'Research may have been interrupted.'}</div>`:'';
        contentEl.innerHTML=`
          <div class="research-badge">${isPartial?'⚠️ Research (partial)':'✅ Gemini Deep Research complete'} · ${Number(evt.source_count||srcs.length)} sources</div>
          ${partialNote}
          <div class="research-actions">${dl.join('')}</div>
          <div class="research-postprocess" style="margin:8px 0;display:flex;gap:8px;flex-wrap:wrap">${ppBtns.join('')}</div>
          ${srcHtml?`<div class="research-summary"><strong>Top sources</strong><ol style="margin:8px 0 0 18px">${srcHtml}</ol></div>`:''}
          <div style="margin-top:10px">${fmt(report.slice(0,32000))}</div>
          <button class="research-regen-btn" onclick="regenerateResearch('${esc(query).replace(/'/g,"\\'")}')">🔄 Regenerate</button>
        `;
        setStatus(isPartial?'Research completed with partial data.':'Research complete. You can download the report.');
        researchCompleted=true;
        // Store for post-processing
        _lastResearchReport=finalReport;
        _lastResearchSources=finalSources;
      }else if(evt.type==='error'){
        throw new Error(evt.error||'Research failed.');
      }
    }
  }
  _currentResearchJobId=null;
  _currentResearchReader=null;
  // If stream ended but we never got a 'done' event, it stalled
  if(!researchCompleted&&!wasCancelled){
    throw new Error('Research ended unexpectedly. Try again with a different query.');
  }
}

function regenerateResearch(query){
  const input=document.getElementById('msgInput');
  input.value=query;
  if(!activeTools.has('research')) activateTool('research');
  sendMessage();
}

/* ─── Post-Processing (separate from research pipeline) ─────── */
let _lastResearchReport='';
let _lastResearchSources=[];

async function postprocessPDF(btn){
  if(!btn)return;
  // Find the report from the closest research result
  const contentEl=btn.closest('.msg-content')||btn.closest('.msg');
  const reportText=_lastResearchReport||contentEl?.innerText||'';
  if(!reportText||reportText.length<100){showToast('No research report found to export.','info');return;}

  const origText=btn.textContent;
  btn.disabled=true;
  btn.textContent='⏳ Generating PDF...';

  try{
    const r=await apiFetch('/api/research/export/pdf',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({report:_lastResearchReport,title:btn.dataset.query||'Research Report',sources:_lastResearchSources})});
    const d=await r.json();
    if(!r.ok||d.error){
      showToast(d.error||'PDF generation failed.','error');
      btn.textContent=origText;btn.disabled=false;
      return;
    }
    // Replace button with download link
    const link=document.createElement('a');
    link.className='choice-btn';
    link.href=`/api/research/download/${encodeURIComponent(d.pdf_file)}`;
    link.textContent='📄 Download PDF';
    btn.replaceWith(link);
    showToast('PDF generated successfully!','success');
  }catch(e){
    showToast('PDF generation failed: '+e.message,'error');
    btn.textContent=origText;btn.disabled=false;
  }
}

async function postprocessMindmap(btn){
  if(!btn)return;
  if(!_lastResearchReport||_lastResearchReport.length<100){showToast('No research report found.','info');return;}

  const origText=btn.textContent;
  btn.disabled=true;
  btn.textContent='⏳ Building mind map...';

  try{
    const r=await apiFetch('/api/research/export/mindmap',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({report:_lastResearchReport})});
    const d=await r.json();
    if(!r.ok||d.error){
      showToast(d.error||'Mind map generation failed.','error');
      btn.textContent=origText;btn.disabled=false;
      return;
    }
    // Render mind map inline
    const mmData=d.mindmap;
    const mmId='mm_'+Date.now();
    const mmHtml=_renderMindmapNode(mmData,0);
    const container=document.createElement('div');
    container.className='research-mindmap';
    container.id=mmId;
    container.innerHTML=`<div class="research-mindmap-title">🧠 Mind Map</div>${mmHtml}`;
    btn.replaceWith(container);
    showToast('Mind map generated!','success');
  }catch(e){
    showToast('Mind map failed: '+e.message,'error');
    btn.textContent=origText;btn.disabled=false;
  }
}

function _renderMindmapNode(node,level){
  if(!node||!node.title)return'';
  const indent=level*20;
  const isRoot=level===0;
  const cls=isRoot?'mm-root':'mm-node';
  const childHtml=(node.children||[]).map(c=>_renderMindmapNode(c,level+1)).join('');
  return`<div class="${cls}" style="margin-left:${indent}px">
    <div class="mm-label" style="font-weight:${level<2?'600':'400'};font-size:${Math.max(12,15-level)}px;padding:4px 8px;margin:2px 0;border-left:${level>0?'2px solid var(--accent)':'none'};${isRoot?'font-size:16px;font-weight:700;margin-bottom:6px':''}">
      ${esc(node.title)}
    </div>
    ${childHtml?'<div class="mm-children">'+childHtml+'</div>':''}
  </div>`;
}

/* ─── Inline Research Plan (in-chat + canvas) ─────── */
let _inlineResearchState=null; // {query, cardEl, contentEl}

async function startInlineResearchPlan(query,depth){
  // Gemini Deep Research handles planning internally — start directly
  const area=document.getElementById('chatArea');

  // Create inline card in chat
  const msgDiv=document.createElement('div');
  msgDiv.className='msg kairo';
  const contentEl=document.createElement('div');
  contentEl.className='msg-content';
  msgDiv.innerHTML='<div class="lbl">gyro</div>';
  msgDiv.appendChild(contentEl);
  area.appendChild(msgDiv);
  area.scrollTop=area.scrollHeight;

  _inlineResearchState={query,cardEl:msgDiv,contentEl};

  const targetChatId=curChat;
  setChatRunning(targetChatId,true,{type:'research'});
  try{
    await runDeepResearch(query,contentEl,area);
    await refreshChats();
    // Auto-continue with summary
    setChatRunning(targetChatId,false);
    try{
      const inp=document.getElementById('msgInput');
      inp.value='The deep research report above is now complete. Provide a brief executive summary highlighting the 3-5 most important findings, key takeaways, and any actionable recommendations. Be concise.';
      sendMessage({silent:true,noThinking:true});
    }catch(_){}
  }catch(e){
    contentEl.innerHTML=`<div style="color:var(--red)">${esc(e.message||'Research failed.')}</div>`;
    setStatus('Research failed.');
    setChatRunning(targetChatId,false);
  }
  _inlineResearchState=null;
}

function toggleResearchPlan(){
  const wrap=document.getElementById('riAnglesWrap');
  const btn=document.getElementById('riTogglePlan');
  if(!wrap||!btn)return;
  wrap.classList.toggle('expanded');
  btn.classList.toggle('expanded');
}

function editResearchPlanInCanvas(){}

async function confirmInlineResearchPlan(){
  if(!_inlineResearchState)return;
  const {query,contentEl}=_inlineResearchState;
  _inlineResearchState=null;

  const targetChatId=curChat;
  setChatRunning(targetChatId,true,{type:'research'});
  const area=document.getElementById('chatArea');
  try{
    await runDeepResearch(query,contentEl,area);
    await refreshChats();
  }catch(e){
    contentEl.innerHTML=`<div style="color:var(--red)">${esc(e.message||'Research failed.')}</div>`;
    setStatus('Research failed.');
  }finally{
    setChatRunning(targetChatId,false);
  }
}

function cancelInlineResearch(){
  if(_inlineResearchState&&_inlineResearchState.cardEl){
    _inlineResearchState.cardEl.remove();
  }
  // Close canvas plan tab if open
  const tab=canvasTabs.find(t=>t.sourcePath==='__research_plan__');
  if(tab){
    canvasTabs=canvasTabs.filter(t=>t.id!==tab.id);
    if(activeCanvasTabId===tab.id){
      if(canvasTabs.length)switchCanvasTab(canvasTabs[canvasTabs.length-1].id);
      else closeCanvas();
    }else{renderCanvasTabs();}
  }
  _inlineResearchState=null;
  setStatus('Research cancelled.');
}

// ─── Messaging ────────────────────────────────────
function handleKey(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage()}}
function autoResize(el){el.style.height='auto';el.style.height=Math.min(el.scrollHeight,120)+'px'}
function sendQ(t){document.getElementById('msgInput').value=t;sendMessage()}

// ─── Map Embeds ───────────────────────────────────
function renderMapEmbed(query, label){
  const q=encodeURIComponent(query);
  const loc=getUserLocation();
  let src=`https://www.google.com/maps?q=${q}&output=embed`;
  if(loc&&loc.lat&&loc.lng){
    src=`https://www.google.com/maps?q=${q}&ll=${loc.lat},${loc.lng}&z=13&output=embed`;
  }
  const mapsLink=`https://www.google.com/maps/search/${q}`;
  return `<div class="map-embed-wrap"><div class="map-embed-header"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg><span>${esc(label||query)}</span><a href="${mapsLink}" target="_blank" rel="noopener" class="map-open-btn">Open in Maps ↗</a></div><iframe class="map-embed-iframe" src="${src}" allowfullscreen loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe></div>`;
}

function renderFlightsLink(query){
  const q=encodeURIComponent(query);
  return `<div class="flights-link-wrap"><a href="https://www.google.com/travel/flights?q=${q}" target="_blank" rel="noopener" class="flights-link-btn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.8 19.2L16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5 5.2 3 -2 2-1.8-.6c-.4-.1-.8 0-1 .3l-.3.3 2.5 1.5 1.5 2.5.3-.3c.3-.3.4-.7.3-1l-.6-1.8 2-2 3 5.2.5-.3c.4-.2.6-.6.5-1.1z"/></svg> Search flights: ${esc(query)}</a></div>`;
}

// ─── Stock Cards ──────────────────────────────────
function renderStockCard(ticker, prefetchedData){
  ticker=ticker.trim().toUpperCase();
  const cardId='stock_'+ticker+'_'+Date.now().toString(36);
  if(prefetchedData && !prefetchedData.error){
    // Data already fetched server-side — render immediately
    setTimeout(()=>_fetchStockData(ticker,cardId,prefetchedData),0);
  } else {
    // Fallback: client-side fetch (shouldn't happen in normal flow)
    setTimeout(()=>_fetchStockData(ticker,cardId),50);
  }
  return `<div class="stock-card-wrap" id="${cardId}"><div class="stock-card"><div class="stock-card-loading"><div class="stock-shimmer"></div><span>Loading ${esc(ticker)} data...</span></div></div><div class="stock-disclaimer">⚠️ <strong>Not financial advice.</strong> This is for informational and educational purposes only. AI-generated analysis may be inaccurate or outdated. Always do your own research and consult a licensed financial advisor before making investment decisions. You could lose money.</div></div>`;
}
function _stockHealthColor(score){
  if(score>=70)return'#22c55e';
  if(score>=45)return'#eab308';
  return'#ef4444';
}
function _stockPerfBar(label,val){
  if(val==null)return'';
  const up=val>=0;
  const cls=up?'stock-perf-up':'stock-perf-down';
  const sign=up?'+':'';
  return `<div class="stock-perf-item"><span class="stock-perf-label">${label}</span><div class="stock-perf-bar-wrap"><div class="stock-perf-bar ${cls}" style="width:${Math.min(Math.abs(val),50)*2}%"></div></div><span class="stock-perf-val ${cls}">${sign}${val.toFixed(1)}%</span></div>`;
}
async function _fetchStockData(ticker,cardId,prefetchedData){
  const el=document.getElementById(cardId);
  if(!el)return;
  try{
    let d;
    if(prefetchedData && !prefetchedData.error){
      d=prefetchedData;
    } else {
      const r=await fetch('/api/stock/'+encodeURIComponent(ticker));
      d=await r.json();
      if(d.error){el.querySelector('.stock-card').innerHTML=`<div class="stock-card-error">⚠️ ${esc(d.error)}</div>`;return;}
    }
    const up=d.change>=0;
    const arrow=up?'▲':'▼';
    const cls=up?'stock-up':'stock-down';
    const fmtNum=(n)=>{if(n==null)return'—';if(n>=1e12)return'$'+(n/1e12).toFixed(2)+'T';if(n>=1e9)return'$'+(n/1e9).toFixed(2)+'B';if(n>=1e6)return'$'+(n/1e6).toFixed(2)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return n.toLocaleString();};
    const fmtNumRaw=(n)=>{if(n==null)return'—';if(n>=1e12)return(n/1e12).toFixed(2)+'T';if(n>=1e9)return(n/1e9).toFixed(2)+'B';if(n>=1e6)return(n/1e6).toFixed(2)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return n.toLocaleString();};
    const fmtPct=(n)=>n!=null?(n*100).toFixed(2)+'%':'—';

    // ── Verdict banner ──
    const verdict=d.verdict||'hold';
    const verdictLabel={buy:'BUY',hold:'HOLD',sell:'SELL'}[verdict]||'HOLD';
    const verdictCls={buy:'stock-verdict-buy',hold:'stock-verdict-hold',sell:'stock-verdict-sell'}[verdict]||'stock-verdict-hold';
    const hs=d.health&&d.health.score;
    const scoreTag=hs!=null?`<span class="stock-verdict-score">${hs}/100</span>`:'';

    // ── Risk badge ──
    let riskBadge='';
    if(d.risk){
      const riskMap={low:'Low Risk',moderate:'Moderate',high:'High Risk',very_high:'Very High'};
      const riskCls={low:'stock-risk-low',moderate:'stock-risk-mod',high:'stock-risk-high',very_high:'stock-risk-high'};
      riskBadge=`<span class="stock-risk-badge ${riskCls[d.risk]||'stock-risk-mod'}">${riskMap[d.risk]||d.risk}</span>`;
    }

    // ── Key metrics ──
    const metrics=[
      {label:'Open',value:d.open!=null?'$'+d.open.toFixed(2):'—'},
      {label:'Day Range',value:(d.dayLow!=null&&d.dayHigh!=null)?'$'+d.dayLow.toFixed(2)+' – $'+d.dayHigh.toFixed(2):'—'},
      {label:'Volume',value:fmtNumRaw(d.volume)},
      {label:'Avg Volume',value:fmtNumRaw(d.avgVolume)},
      {label:'Mkt Cap',value:d.marketCap?fmtNum(d.marketCap):'—'},
      {label:'P/E (TTM)',value:d.pe!=null?d.pe.toFixed(2):'—'},
      {label:'Fwd P/E',value:d.forwardPe!=null?d.forwardPe.toFixed(2):'—'},
      {label:'EPS',value:d.eps!=null?'$'+d.eps.toFixed(2):'—'},
      {label:'Dividend',value:d.dividend?fmtPct(d.dividend):'—'},
      {label:'Beta',value:d.beta!=null?d.beta.toFixed(2):'—'},
    ];

    // ── Technical indicators ──
    const p=d.perf||{};
    const techItems=[];
    if(p.sma50!=null)techItems.push(`<span class="stock-tech-item">SMA50: <b class="${d.price>=p.sma50?'stock-up':'stock-down'}">$${p.sma50.toFixed(2)}</b></span>`);
    if(p.sma200!=null)techItems.push(`<span class="stock-tech-item">SMA200: <b class="${d.price>=p.sma200?'stock-up':'stock-down'}">$${p.sma200.toFixed(2)}</b></span>`);
    if(p.rsi!=null){
      const rsiCls=p.rsi>70?'stock-down':p.rsi<30?'stock-up':'stock-neutral';
      const rsiLabel=p.rsi>70?'Overbought':p.rsi<30?'Oversold':'Neutral';
      techItems.push(`<span class="stock-tech-item">RSI(14): <b class="${rsiCls}">${p.rsi} (${rsiLabel})</b></span>`);
    }
    let techHtml=techItems.length?`<div class="stock-tech-row">${techItems.join('')}</div>`:'';

    // ── 52-week position ──
    let pos52Html='';
    if(d.pos52!=null&&d.low52!=null&&d.high52!=null){
      pos52Html=`<div class="stock-52w"><span class="stock-52w-label">52W Range</span><div class="stock-52w-bar-wrap"><span class="stock-52w-lo">$${d.low52.toFixed(2)}</span><div class="stock-52w-track"><div class="stock-52w-fill" style="width:${Math.max(Math.min(d.pos52,100),0)}%"></div><div class="stock-52w-dot" style="left:${Math.max(Math.min(d.pos52,100),0)}%"></div></div><span class="stock-52w-hi">$${d.high52.toFixed(2)}</span></div></div>`;
    }

    // ── Performance bars ──
    const perfItems=[_stockPerfBar('1W',p['1w']),_stockPerfBar('1M',p['1m']),_stockPerfBar('3M',p['3m']),_stockPerfBar('6M',p['6m']),_stockPerfBar('YTD',p['ytd']),_stockPerfBar('1Y',p['1y'])].filter(x=>x);
    let perfHtml=perfItems.length?`<div class="stock-perf-section"><span class="stock-section-title">Performance</span><div class="stock-perf-grid">${perfItems.join('')}</div></div>`:'';

    // ── Financial health ──
    const h=d.health||{};
    const hItems=[];
    if(h.profitMargin!=null) hItems.push({l:'Profit Margin',v:fmtPct(h.profitMargin),good:h.profitMargin>0.1});
    if(h.operatingMargin!=null) hItems.push({l:'Operating Margin',v:fmtPct(h.operatingMargin),good:h.operatingMargin>0.15});
    if(h.revenueGrowth!=null) hItems.push({l:'Revenue Growth',v:fmtPct(h.revenueGrowth),good:h.revenueGrowth>0});
    if(h.earningsGrowth!=null) hItems.push({l:'Earnings Growth',v:fmtPct(h.earningsGrowth),good:h.earningsGrowth>0});
    if(h.returnOnEquity!=null) hItems.push({l:'ROE',v:fmtPct(h.returnOnEquity),good:h.returnOnEquity>0.15});
    if(h.debtToEquity!=null) hItems.push({l:'Debt/Equity',v:h.debtToEquity.toFixed(1),good:h.debtToEquity<100});
    if(h.currentRatio!=null) hItems.push({l:'Current Ratio',v:h.currentRatio.toFixed(2),good:h.currentRatio>1.5});
    if(h.freeCashflow!=null) hItems.push({l:'Free Cash Flow',v:fmtNum(h.freeCashflow),good:h.freeCashflow>0});
    if(h.priceToBook!=null) hItems.push({l:'P/B Ratio',v:h.priceToBook.toFixed(2),good:h.priceToBook<3});
    let healthDetailHtml=hItems.length?`<div class="stock-health-detail"><span class="stock-section-title">Financial Health</span><div class="stock-health-grid">${hItems.map(i=>`<div class="stock-health-item"><span>${i.l}</span><span class="${i.good?'stock-up':'stock-down'}">${i.v}</span></div>`).join('')}</div></div>`:'';

    // ── Analyst targets ──
    let targetHtml='';
    if(d.targetPrice){
      const tParts=[`Target: <b>$${d.targetPrice.toFixed(2)}</b>`];
      if(d.targetLow!=null) tParts.push(`Low: $${d.targetLow.toFixed(2)}`);
      if(d.targetHigh!=null) tParts.push(`High: $${d.targetHigh.toFixed(2)}`);
      const upside=((d.targetPrice-d.price)/d.price*100).toFixed(1);
      const uCls=upside>=0?'stock-up':'stock-down';
      tParts.push(`<span class="${uCls}">(${upside>=0?'+':''}${upside}% upside)</span>`);
      targetHtml=`<div class="stock-analyst-target">${tParts.join(' · ')}</div>`;
    }

    // ── Earnings ──
    let earningsHtml='';
    if(d.earningsDate) earningsHtml=`<span class="stock-earnings">Earnings: ${esc(d.earningsDate)}</span>`;

    // ── Collapsible details content ──
    const detailsContent=pos52Html+techHtml
      +`<div class="stock-card-metrics">${metrics.map(m=>`<div class="stock-metric"><span class="stock-metric-label">${m.label}</span><span class="stock-metric-value">${m.value}</span></div>`).join('')}</div>`
      +perfHtml+healthDetailHtml+targetHtml;

    const detailId=cardId+'_det';

    el.querySelector('.stock-card').innerHTML=
      // ── Verdict banner ──
      `<div class="stock-verdict-banner ${verdictCls}">`
        +`<span class="stock-verdict-label">${verdictLabel}</span>`
        +scoreTag
      +`</div>`
      // ── Header: ticker, price, badges ──
      +`<div class="stock-card-header">`
        +`<div class="stock-card-title-row">`
          +`<div class="stock-card-title"><span class="stock-ticker">${esc(d.ticker)}</span><span class="stock-name">${esc(d.name)}</span></div>`
          +`<div class="stock-badges">${riskBadge}</div>`
        +`</div>`
        +`<div class="stock-card-price-row">`
          +`<div class="stock-card-price"><span class="stock-price">$${d.price.toFixed(2)}</span><span class="stock-change ${cls}">${arrow} $${Math.abs(d.change).toFixed(2)} (${Math.abs(d.changePct).toFixed(2)}%)</span></div>`
        +`</div>`
      +`</div>`
      // ── Collapsible details toggle ──
      +`<button class="stock-details-toggle" onclick="var det=document.getElementById('${detailId}');var open=det.classList.toggle('open');this.querySelector('.stock-toggle-arrow').textContent=open?'▾':'▸';this.querySelector('.stock-toggle-text').textContent=open?'Hide Details':'View Details'">`
        +`<span class="stock-toggle-arrow">▸</span> <span class="stock-toggle-text">View Details</span>`
      +`</button>`
      +`<div class="stock-details-body" id="${detailId}">`
        +detailsContent
      +`</div>`
      // ── Footer ──
      +`<div class="stock-card-footer">`
        +`<a href="https://finance.yahoo.com/quote/${encodeURIComponent(d.ticker)}" target="_blank" rel="noopener" class="stock-yahoo-link">Yahoo Finance ↗</a>`
        +`<a href="https://www.google.com/finance/quote/${encodeURIComponent(d.ticker)}" target="_blank" rel="noopener" class="stock-yahoo-link">Google Finance ↗</a>`
        +earningsHtml
        +`${d.sector?`<span class="stock-sector">${esc(d.sector)}${d.industry?' · '+esc(d.industry):''}</span>`:''}`
      +`</div>`;
  }catch(e){
    if(el)el.querySelector('.stock-card').innerHTML=`<div class="stock-card-error">⚠️ Failed to load stock data for ${esc(ticker)}</div>`;
  }
}

function renderImageGrid(query, images){
  if(!images||!images.length)return'';
  const cards=images.map((img,i)=>{
    const safeUrl=esc(img.url||'');
    const safeThumb=esc(img.thumbnail||img.url||'');
    const safeTitle=esc(img.title||'');
    const safeCtx=img.context_url||'';
    const srcLink=safeCtx?`<a class="img-src-link" href="${esc(safeCtx)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="${safeTitle}">${safeTitle}</a>`:`<span>${safeTitle}</span>`;
    return `<div class="img-grid-card" onclick="openImageLightbox('${safeUrl}','${safeTitle}')" data-img-url="${safeUrl}" data-img-title="${safeTitle}">`
      +`<img src="${safeThumb}" alt="${safeTitle}" loading="lazy" onerror="this.parentElement.style.display='none'">`
      +`<div class="img-grid-label">${srcLink}</div>`
      +`</div>`;
  }).join('');
  const countCls=images.length===1?'img-grid-single':'img-grid-pair';
  return `<div class="img-grid-wrap ${countCls}">`
    +`<div class="img-grid-header"><span class="img-car-icon">🖼</span> Images for "${esc(query)}"</div>`
    +`<div class="img-grid-items">${cards}</div>`
    +`</div>`;
}

function renderImageCarousel(query, images){
  if(!images||!images.length)return'';
  const cards=images.map((img,i)=>{
    const safeUrl=esc(img.url||'');
    const safeThumb=esc(img.thumbnail||img.url||'');
    const safeTitle=esc(img.title||'');
    const safeCtx=img.context_url||'';
    const srcLink=safeCtx?`<a class="img-src-link" href="${esc(safeCtx)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="${safeTitle}">${safeTitle}</a>`:`<span>${safeTitle}</span>`;
    return `<div class="img-car-card" onclick="openImageLightbox('${safeUrl}','${safeTitle}')" data-img-url="${safeUrl}" data-img-title="${safeTitle}">`
      +`<img src="${safeThumb}" alt="${safeTitle}" loading="lazy" onerror="this.parentElement.style.display='none'">`
      +`<div class="img-car-label">${srcLink}</div>`
      +`</div>`;
  }).join('');
  return `<div class="img-car-wrap">`
    +`<div class="img-car-header"><span class="img-car-icon">🖼</span> Images for "${esc(query)}"</div>`
    +`<div class="img-car-track">`
    +`<button class="img-car-arrow img-car-left" onclick="event.stopPropagation();this.nextElementSibling.scrollBy({left:-260,behavior:'smooth'})">&lsaquo;</button>`
    +`<div class="img-car-scroll">${cards}</div>`
    +`<button class="img-car-arrow img-car-right" onclick="event.stopPropagation();this.previousElementSibling.scrollBy({left:260,behavior:'smooth'})">&rsaquo;</button>`
    +`</div>`
    +`</div>`;
}

function renderImageBlock(ir){
  if(!ir||!ir.images||!ir.images.length)return'';
  if(ir.images.length<=3)return renderImageGrid(ir.query, ir.images);
  return renderImageCarousel(ir.query, ir.images);
}

function renderChoiceWizard(choiceBlocks){
  // Wizard-style single-card that cycles through questions one at a time
  const total=choiceBlocks.length;
  const blocksJSON=JSON.stringify(choiceBlocks).replace(/'/g,"&#39;").replace(/"/g,'&quot;');
  const first=choiceBlocks[0];
  const letters='ABCDEFGH';
  const qHTML=first.question?`<div class="cq-question">${esc(first.question)}</div>`:'';
  const multiAttr=first.multi?'data-multi="true"':'';
  const optsHTML=first.choices.map((c,i)=>{
    const letter=letters[i]||String(i+1);
    const safeText=esc(c.trim()).replace(/'/g,"\\'");
    return `<button class="cq-opt" onclick="pickWizardChoice(this,'${safeText}')">`
      +`<span class="cq-letter">${letter}</span>`
      +`<span class="cq-text">${esc(c.trim())}</span>`
      +`</button>`;
  }).join('');
  const multiHint=first.multi?'<div class="cq-multi-hint">Select multiple, then press Next</div>':'';
  const progressHTML=total>1?`<div class="cq-progress"><span class="cq-step-label">Question <span class="cq-step-num">1</span> of ${total}</span><div class="cq-progress-bar"><div class="cq-progress-fill" style="width:${(1/total)*100}%"></div></div></div>`:'';
  const nextBtnHTML=first.multi?`<button class="cq-next-btn" onclick="wizardNext(this)" disabled>Next →</button>`:'';
  return `<div class="cq-wizard" data-blocks="${blocksJSON}" data-current="0" data-total="${total}" data-answers="[]">`
    +progressHTML
    +`<div class="cq-card" ${multiAttr}>${qHTML}${multiHint}<div class="cq-opts">${optsHTML}</div>`
    +`<div class="cq-custom"><input class="cq-input" placeholder="Or type your own answer…" onkeydown="if(event.key==='Enter'){event.preventDefault();pickWizardCustom(this)}"/>`
    +`<button class="cq-send" onclick="pickWizardCustom(this.previousElementSibling)" title="Send">→</button></div>`
    +nextBtnHTML
    +`</div></div>`;
}

function renderChoiceBlock(choices,question,multi){
  // Single-block fallback for backwards compat — renders inside wizard
  return renderChoiceWizard([{choices,question,multi}]);
}

function pickWizardChoice(btn,text){
  const card=btn.closest('.cq-card');
  const wizard=btn.closest('.cq-wizard');
  const isMulti=card.dataset.multi==='true';
  if(isMulti){
    btn.classList.toggle('cq-selected');
    const selected=[...card.querySelectorAll('.cq-opt.cq-selected')].map(b=>b.querySelector('.cq-text').textContent.trim());
    card.dataset.answer=selected.join(', ');
    const nextBtn=card.querySelector('.cq-next-btn');
    if(nextBtn)nextBtn.disabled=!selected.length;
  }else{
    card.querySelectorAll('.cq-opt').forEach(b=>b.classList.remove('cq-selected'));
    btn.classList.add('cq-selected');
    card.dataset.answer=text;
    // Auto-advance for single-select
    setTimeout(()=>wizardNext(btn),250);
  }
}

function pickWizardCustom(input){
  const text=(input.value||'').trim();
  if(!text)return;
  const card=input.closest('.cq-card');
  card.querySelectorAll('.cq-opt').forEach(b=>b.classList.remove('cq-selected'));
  card.dataset.answer=text;
  setTimeout(()=>wizardNext(input),150);
}

function wizardNext(el){
  const wizard=el.closest('.cq-wizard');
  if(!wizard)return;
  const card=wizard.querySelector('.cq-card');
  const answer=card.dataset.answer||'';
  if(!answer)return;
  const blocks=JSON.parse(wizard.dataset.blocks.replace(/&quot;/g,'"').replace(/&#39;/g,"'"));
  let answers=JSON.parse(wizard.dataset.answers||'[]');
  const current=parseInt(wizard.dataset.current,10);
  const total=parseInt(wizard.dataset.total,10);
  const q=blocks[current];
  answers.push({question:q.question||'',answer:answer});
  wizard.dataset.answers=JSON.stringify(answers);
  const next=current+1;
  if(next>=total){
    // All questions answered — submit
    card.style.opacity='0';card.style.transform='translateX(-20px)';
    setTimeout(()=>{
      const parts=answers.map(a=>a.question?(a.question+' '+a.answer):a.answer);
      // Disable the wizard
      wizard.innerHTML=`<div class="cq-done"><span class="cq-done-icon">✓</span> Answered ${total} question${total>1?'s':''}</div>`;
      sendQ(parts.join('\n'));
    },200);
    return;
  }
  // Animate to next card
  wizard.dataset.current=String(next);
  card.style.opacity='0';card.style.transform='translateX(-20px)';
  setTimeout(()=>{
    const nb=blocks[next];
    const letters='ABCDEFGH';
    const qHTML=nb.question?`<div class="cq-question">${esc(nb.question)}</div>`:'';
    const multiAttr=nb.multi?'data-multi="true"':'';
    const optsHTML=nb.choices.map((c,i)=>{
      const letter=letters[i]||String(i+1);
      const safeText=esc(c.trim()).replace(/'/g,"\\'");
      return `<button class="cq-opt" onclick="pickWizardChoice(this,'${safeText}')">`
        +`<span class="cq-letter">${letter}</span>`
        +`<span class="cq-text">${esc(c.trim())}</span>`
        +`</button>`;
    }).join('');
    const multiHint=nb.multi?'<div class="cq-multi-hint">Select multiple, then press Next</div>':'';
    const nextBtnHTML=nb.multi?`<button class="cq-next-btn" onclick="wizardNext(this)" disabled>Next →</button>`:'';
    card.outerHTML=`<div class="cq-card" ${multiAttr}>${qHTML}${multiHint}<div class="cq-opts">${optsHTML}</div>`
      +`<div class="cq-custom"><input class="cq-input" placeholder="Or type your own answer…" onkeydown="if(event.key==='Enter'){event.preventDefault();pickWizardCustom(this)}"/>`
      +`<button class="cq-send" onclick="pickWizardCustom(this.previousElementSibling)" title="Send">→</button></div>`
      +nextBtnHTML+`</div>`;
    // Update progress
    const fill=wizard.querySelector('.cq-progress-fill');
    const stepNum=wizard.querySelector('.cq-step-num');
    if(fill)fill.style.width=`${((next+1)/total)*100}%`;
    if(stepNum)stepNum.textContent=String(next+1);
    // Animate in
    const newCard=wizard.querySelector('.cq-card');
    newCard.style.opacity='0';newCard.style.transform='translateX(20px)';
    requestAnimationFrame(()=>{
      newCard.style.transition='opacity .25s ease, transform .25s ease';
      newCard.style.opacity='1';newCard.style.transform='translateX(0)';
    });
  },200);
}

function pickChoice(btn,text){pickWizardChoice(btn,text);}
function pickCustomChoice(input){pickWizardCustom(input);}

function submitAllChoices(btn){
  const wizard=btn.closest('.cq-wizard');
  if(wizard){wizardNext(btn);return;}
  // Legacy fallback
  const group=btn.closest('.cq-group');
  const blocks=group.querySelectorAll('.cq-block');
  const parts=[...blocks].map(b=>{
    const q=b.querySelector('.cq-question');
    const qText=q?q.textContent.trim():'';
    const a=b.dataset.answer||'';
    return qText?qText+' '+a:a;
  });
  blocks.forEach(b=>{
    b.querySelectorAll('.cq-opt').forEach(o=>{o.disabled=true;o.style.pointerEvents='none';});
    const cr=b.querySelector('.cq-custom');if(cr)cr.style.display='none';
  });
  btn.disabled=true;btn.textContent='Submitted ✓';
  sendQ(parts.join('\n'));
}

function _detectTruncation(text){
  if(!text||text.length<200)return false;
  const t=text.trim();
  // Unclosed code blocks (odd number of ```)
  const fenceCount=(t.match(/```/g)||[]).length;
  if(fenceCount%2!==0)return true;
  // Unclosed special tags
  const openTags=['<<<CODE_EXECUTE','<<<FILE_CREATE','<<<FILE_UPDATE','<<<CHOICES>>>'];
  const closeTags=['<<<END_CODE>>>','<<<END_FILE>>>','<<<END_FILE>>>','<<<END_CHOICES>>>'];
  for(let i=0;i<openTags.length;i++){
    const opens=(t.match(new RegExp(openTags[i].replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'))||[]).length;
    const closes=(t.match(new RegExp(closeTags[i].replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'))||[]).length;
    if(opens>closes)return true;
  }
  // Ends with obvious mid-sentence indicators
  const lastLine=t.split('\n').pop().trim();
  if(lastLine&&/[,;:\-–—]$/.test(lastLine))return true;
  // Ends mid-word or mid-sentence (no sentence-ending punctuation)
  if(lastLine&&lastLine.length>20&&!/[.!?)\]"'…]$/.test(lastLine))return true;
  // Numbered list that seems incomplete (ends with a number item, likely more coming)
  const lines=t.split('\n').filter(l=>l.trim());
  const lastThree=lines.slice(-3);
  const numberedCount=lastThree.filter(l=>/^\s*\d+[.)]\s/.test(l)).length;
  if(numberedCount>=2)return true;
  // Sentences like "Stand by." or "Here's" or "I'll now" that promise more content
  if(/(?:stand by|here (?:is|are|comes)|i(?:'ll| will| am going to) (?:now|next)|let me|coming up|let's (?:start|continue|move|look)|first,|next,)[.\s]*$/i.test(lastLine))return true;
  return false;
}

function stripMetaBlocks(text){
  return (text||'')
    .replace(/<<<THINKING>>>[\s\S]*?(<<<END_THINKING>>>|$)/g,'')
    .replace(/<<<THINKING[\s\S]*$/g,'')
    .replace(/(?:<<<QUESTION:.*?>>>\n)?<<<CHOICES(?:\|multi)?>>>[\s\S]*?(<<<END_CHOICES>>>|$)/g,'')
    .replace(/<<<IMAGE_SEARCH:\s*.+?>>>/g,'')
    .replace(/%%%IMAGE_SEARCH:\s*.+?(?:>>>|%%%)/g,'')
    .replace(/<<<IMAGE_GENERATE:\s*.+?>>>/g,'')
    .replace(/<<<DEEP_RESEARCH[:\s][\s\S]*?>>>/g,'')
    .replace(/<<<DEEP_RESEARCH>>>/g,'')
    .trim();
}

function hasUnclosedCodeFence(text){
  return ((text||'').match(/```/g)||[]).length%2===1;
}

// Live markdown formatter for streaming — formats text in-flight
function fmtLive(raw){
  if(!raw)return'<span class="stream-cursor"></span>';
  // Strip meta blocks (thinking/choices tags during stream)
  let t=stripMetaBlocks(raw);
  // Strip <<<CONTINUE>>> tag from live display
  t=t.replace(/<<<CONTINUE>>>/g,'');
  if(!t)return'<span class="stream-cursor"></span>';
  let html=t;
  // Escape HTML entities
  html=html.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  // ── Inline media markers: [[[MEDIA:kind:index:info]]] ──
  // These are injected by the media_loading handler during streaming.
  // Render as actual content (if loaded) or loading card (if still pending).
  const _liveBlocks=[];
  html=html.replace(/\[\[\[MEDIA:(\w+):(\d+):(.*?)\]\]\]/g,(_,kind,idx,info)=>{
    const key=`${kind}-${idx}`;
    const result=window._streamMediaResults&&window._streamMediaResults[key];
    let content;
    if(result){
      if(kind==='image_search') content=renderImageBlock(result);
      else if(kind==='stock') content=renderStockCard(result.ticker,result.data);
      else if(kind==='image_gen') content=`<div class="img-gen-card" style="border-radius:14px;overflow:hidden;border:1px solid var(--border);background:var(--bg-surface)"><img src="${result.url}" style="width:100%;display:block;border-radius:14px"><div style="padding:10px 14px;font-size:12px;color:var(--text-secondary)">🎨 ${esc(result.prompt||'Generated')}</div></div>`;
      else content='';
    }else{
      const labels={image_search:'🔍 Finding images...',stock:'📈 Loading stock data...',image_gen:'🎨 Generating image...'};
      content=`<div class="stream-placeholder"><span class="sp-icon">${(labels[kind]||'⏳').split(' ')[0]}</span> ${labels[kind]||'Loading...'}</div>`;
    }
    _liveBlocks.push(content);
    return `%%%LIVEBLOCK${_liveBlocks.length-1}%%%`;
  });

  // Detect special blocks mid-stream and show placeholders
  // Unclosed DEEP_RESEARCH tag mid-stream (after HTML escaping, <<< becomes &lt;&lt;&lt;)
  if(/&lt;&lt;&lt;DEEP_RESEARCH/i.test(html)){
    html=html.replace(/&lt;&lt;&lt;DEEP_RESEARCH[\s\S]*$/,'');
  }
  // Strip FILE_CREATE / FILE_UPDATE / MEMORY_ADD / IMAGE_SEARCH / CONTINUE / CODE_EXECUTE tags from live display
  html=html.replace(/&lt;&lt;&lt;(?:FILE_CREATE|FILE_UPDATE):[\s\S]*?&lt;&lt;&lt;END_FILE&gt;&gt;&gt;/g,'');
  html=html.replace(/&lt;&lt;&lt;(?:FILE_CREATE|FILE_UPDATE):[\s\S]*$/,''); // unclosed
  html=html.replace(/&lt;&lt;&lt;MEMORY_ADD:[^&]*?&gt;&gt;&gt;/g,'');
  html=html.replace(/&lt;&lt;&lt;IMAGE_SEARCH:[^&]*?&gt;&gt;&gt;/g,'');
  html=html.replace(/%%%IMAGE_SEARCH:[^%]*?(?:&gt;&gt;&gt;|%%%)/g,'');
  html=html.replace(/&lt;&lt;&lt;IMAGE_GENERATE:[^&]*?&gt;&gt;&gt;/g,'<div class="stream-placeholder"><span class="sp-icon">🎨</span> Generating image...</div>');
  html=html.replace(/&lt;&lt;&lt;MAP:[^&]*?&gt;&gt;&gt;/g,'<div class="stream-placeholder"><span class="sp-icon">📍</span> Loading map...</div>');
  html=html.replace(/&lt;&lt;&lt;FLIGHTS:[^&]*?&gt;&gt;&gt;/g,'<div class="stream-placeholder"><span class="sp-icon">✈️</span> Finding flights...</div>');
  html=html.replace(/&lt;&lt;&lt;STOCK:[^&]*?&gt;&gt;&gt;/g,'<div class="stream-placeholder"><span class="sp-icon">📈</span> Loading stock data...</div>');
  html=html.replace(/%%%STOCKBLOCK:\d+%%%/g,'<div class="stream-placeholder"><span class="sp-icon">📈</span> Loading stock data...</div>');
  html=html.replace(/&lt;&lt;&lt;CONTINUE&gt;&gt;&gt;/g,'');
  // Completed CODE_EXECUTE blocks — hide raw tags, show placeholder
  html=html.replace(/&lt;&lt;&lt;CODE_EXECUTE:\s*\w+&gt;&gt;&gt;[\s\S]*?&lt;&lt;&lt;END_CODE&gt;&gt;&gt;/g,'<div class="stream-placeholder"><span class="sp-icon">⚙️</span> Executing code...</div>');
  // Unclosed CODE_EXECUTE block (still streaming)
  html=html.replace(/&lt;&lt;&lt;CODE_EXECUTE:\s*\w+&gt;&gt;&gt;[\s\S]*$/,'<div class="stream-placeholder"><span class="sp-icon">⚙️</span> Writing code to execute...</div>');
  // Unclosed mermaid block
  if(/```mermaid\n/i.test(html)&&!(/```mermaid\n[\s\S]*?```/.test(html))){
    html=html.replace(/```mermaid\n[\s\S]*$/,'<div class="stream-placeholder"><span class="sp-icon">●</span> Generating mind map...</div>');
  }
  // Unclosed todolist block
  if(/```todolist\n/i.test(html)&&!(/```todolist\n[\s\S]*?```/.test(html))){
    html=html.replace(/```todolist\n[\s\S]*$/,'<div class="stream-placeholder"><span class="sp-icon">●</span> Generating task list...</div>');
  }
  // Unclosed generic code block — show artifact generating
  if(hasUnclosedCodeFence(html)){
    // Get the language hint if present
    const fenceMatch=html.match(/```(\w+)\n(?![\s\S]*```)/);
    const lang=fenceMatch?fenceMatch[1]:'code';
    const langLabel={'python':'Python','javascript':'JavaScript','js':'JavaScript','html':'HTML','css':'CSS','json':'JSON','markdown':'Markdown','md':'Markdown','sql':'SQL','bash':'Shell','sh':'Shell','typescript':'TypeScript','ts':'TypeScript'}[lang.toLowerCase()]||lang;
    html=html.replace(/```\w*\n[^]*$/,'<div class="stream-placeholder"><span class="sp-icon">●</span> Writing '+esc(langLabel)+' artifact...</div>');
  }

  // Completed mermaid blocks — show placeholder until fmt() renders the real diagram
  html=html.replace(/```mermaid\n[\s\S]*?```/g,'<div class="stream-placeholder"><span class="sp-icon">🗺️</span> Mind map ready — rendering...</div>');
  // Completed todolist blocks — show placeholder until fmt() renders the interactive list
  html=html.replace(/```todolist\n[\s\S]*?```/g,'<div class="stream-placeholder"><span class="sp-icon">✅</span> Task list ready — rendering...</div>');
  // Completed code blocks: render styled
  html=html.replace(/```(\w*)\n([\s\S]*?)```/g,(_,l,c)=>{
    return '<pre class="stream-code"><code>'+c+'</code></pre>';
  });

  // Bold
  html=html.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  // Inline code
  html=html.replace(/`(.+?)`/g,'<code class="stream-inline-code">$1</code>');
  // Links — absolute and relative /api/ URLs
  html=html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">$1</a>');
  html=html.replace(/\[([^\]]+)\]\((\/api\/[^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">$1</a>');
  // Workspace file links: [text](filename.ext) — convert to download URLs
  html=html.replace(/\[([^\]]+)\]\((?!https?:\/\/)(?!\/api\/)(?!#)(?!mailto:)([^)]+\.\w+)\)/g,(_,label,path)=>{
    const dlUrl='/api/files/download?path='+encodeURIComponent(path.replace(/&amp;/g,'&'));
    return `<a href="${dlUrl}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">${label}</a>`;
  });
  // Bare URLs — auto-link any https?:// not already inside an <a> tag
  html=html.replace(/(?<!href=")(?<!src=")(?<!">)(https?:\/\/[^\s<"']+)/g,'<a href="$1" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">$1</a>');
  // Headings (### at start of line)
  html=html.replace(/^(#{1,3})\s+(.+)$/gm,(_,h,text)=>{
    const level=h.length;
    const sizes=['1.3em','1.15em','1.05em'];
    return `<div style="font-size:${sizes[level-1]||'1em'};font-weight:700;margin:12px 0 4px;color:var(--text-primary)">${text}</div>`;
  });
  // Bullet lists  — * or - at start of line
  html=html.replace(/^([*\-])\s+(.+)$/gm,'<div style="display:flex;gap:8px;padding:1px 0"><span style="color:var(--accent);flex-shrink:0">•</span><span>$2</span></div>');
  // Numbered lists — 1. at start of line
  html=html.replace(/^(\d+)\.\s+(.+)$/gm,'<div style="display:flex;gap:8px;padding:1px 0"><span style="color:var(--accent);flex-shrink:0;min-width:16px;text-align:right">$1.</span><span>$2</span></div>');
  // Newlines
  html=html.replace(/\n/g,'<br>');
  // Restore live media blocks (protected from markdown processing)
  _liveBlocks.forEach((b,i)=>{html=html.replace(`%%%LIVEBLOCK${i}%%%`,b);});
  // Add cursor at end
  html+='<span class="stream-cursor"></span>';
  return html;
}

function registerArtifact(entry){
  const key=entry.path?`path:${entry.path}`:`title:${entry.title}:${entry.isCode?'code':'doc'}`;
  let id=artifactIndex.get(key);
  if(!id){
    id='a_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,7);
    artifactIndex.set(key,id);
    artifactStore.unshift({id,created:Date.now(),...entry});
  }else{
    const i=artifactStore.findIndex(a=>a.id===id);
    if(i>=0)artifactStore[i]={...artifactStore[i],...entry};
  }
  return id;
}

function registerArtifactsFromReply(reply,filesModified=[]){
  const ids=[];
  let m=null; let idx=1;
  const codeRe=/```(\w*)\n([\s\S]*?)```/g;
  const codeBlocks=[];
  while((m=codeRe.exec(reply||''))!==null){
    const lang=(m[1]||'text').toLowerCase();
    if(lang==='todolist'||lang==='mermaid')continue;
    const content=m[2]||'';
    const isCode=true; // all code blocks open in canvas
    // Try to detect a filename from the line before the code block
    const before=reply.substring(0,m.index).trim();
    const lastLine=before.split('\n').pop().trim();
    let title='';
    const fnMatch=lastLine.match(/`?(\w[\w.-]*\.\w+)`?/);
    if(fnMatch)title=fnMatch[1];
    if(!title){
      const extMap={python:'script.py',py:'script.py',javascript:'script.js',js:'script.js',html:'page.html',css:'styles.css',java:'Main.java',cpp:'main.cpp',c:'main.c',typescript:'script.ts',ts:'script.ts',rust:'main.rs',go:'main.go',ruby:'script.rb',php:'script.php',swift:'main.swift',kotlin:'Main.kt',sql:'query.sql',bash:'script.sh',sh:'script.sh',json:'data.json',yaml:'config.yaml',yml:'config.yml',xml:'data.xml',toml:'config.toml'};
      title=extMap[lang]||`snippet_${idx}.${lang||'txt'}`;
    }
    idx++;
    ids.push(registerArtifact({title,content,isCode,path:''}));
    if(isCode)codeBlocks.push({title,content,lang});
  }
  for(const f of(filesModified||[])){
    if(!f?.path)continue;
    ids.push(registerArtifact({title:f.path.split('/').pop()||f.path,path:f.path,content:'',isCode:true,action:f.action||'updated'}));
  }
  // Auto-open first code/file block in canvas
  if(codeBlocks.length>0&&!_suppressCanvasAutoOpen){
    const first=codeBlocks[0];
    setTimeout(()=>openCanvas(first.content,first.title,true,{openPanel:true}),100);
  }
  // Also auto-open first modified file in canvas
  if(!codeBlocks.length&&filesModified?.length&&!_suppressCanvasAutoOpen){
    const firstFile=filesModified[0];
    if(firstFile?.path){
      setTimeout(()=>openWorkspaceFile(encodeURIComponent(firstFile.path)),200);
    }
  }
  return [...new Set(ids)];
}

function renderArtifactCards(ids,state='ready'){
  // No longer rendering artifact cards — canvas auto-opens instead
  return '';
}

async function ensureArtifactContent(artifact){
  if(!artifact||artifact.content)return artifact;
  if(!artifact.path)return artifact;
  if(workspaceFileCache.has(artifact.path)){
    artifact.content=workspaceFileCache.get(artifact.path);
    return artifact;
  }
  try{
    const r=await fetch(`/api/files/content?path=${encodeURIComponent(artifact.path)}`);
    const d=await r.json();
    if(!d.error&&typeof d.content==='string'){
      workspaceFileCache.set(artifact.path,d.content);
      artifact.content=d.content;
    }
  }catch{}
  return artifact;
}

async function openArtifact(id){
  const artifact=artifactStore.find(a=>a.id===id);
  if(!artifact)return;
  await ensureArtifactContent(artifact);
  openCanvas(artifact.content||'',artifact.title||artifact.path||'Artifact',artifact.isCode,{openPanel:true,sourcePath:artifact.path||''});
}

async function sendMessage(opts){
  const _silent=opts&&opts.silent;
  const _noThinking=opts&&opts.noThinking;
  const input=document.getElementById('msgInput');
  const text=(opts&&opts.message)?opts.message:input.value.trim();
  if(!text&&!pendingFiles.length&&!pendingReplies.length)return;
  // Reset continue counter when user sends a new (non-continue) message
  if(!_silent&&!text.startsWith('Continue')){_continueCount=0;_codeRepromptCount=0;}
  if(curChat&&isChatRunning(curChat)&&!_silent){showToast('Already generating in this chat — switch to another chat or wait.','info');return;}
  // Force-create a new chat if none exists (don't rely on createChat guard)
  if(!curChat){
    try{
      const cr=await apiFetch('/api/chats',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder:_activeFolderView||pendingFolder||''})});
      const cc=await cr.json();
      if(cc.error){showToast('Could not create chat: '+cc.error,'error');return;}
      curChat=cc.id;
      pendingFolder='';
      document.getElementById('topTitle').textContent=cc.title||'New Chat';
      refreshChats();
    }catch(e){showToast('Failed to create chat: '+e.message,'error');return;}
  }
  const targetChatId=curChat;

  const w=document.querySelector('#chatArea .welcome');
  if(w){
    // Choreographed exit: widgets shrink first, then hero fades
    const widgets=w.querySelectorAll('.wl-widget');
    const hero=w.querySelector('.wl-hero');
    widgets.forEach((el,i)=>{
      el.style.transition=`all .25s var(--ease) ${i*0.03}s`;
      el.style.opacity='0';
      el.style.transform='translateY(-10px) scale(.96)';
    });
    if(hero){
      hero.style.transition='all .3s var(--ease) .1s';
      hero.style.opacity='0';
      hero.style.transform='translateY(-14px)';
    }
    w.style.transition='all .35s var(--ease) .15s';
    w.style.opacity='0';
    setTimeout(()=>{if(w.parentNode)w.remove();},400);
  }
  const files=[...pendingFiles];
  const replies=[...pendingReplies];

  // Build reply context prefix for the message
  let replyPrefix='';
  let displayPrefix='';
  if(replies.length){
    const apiParts=[];
    const dispParts=[];
    for(const r of replies){
      if(r.type==='text'){
        apiParts.push(`[Replying to text:]\n> ${r.text.replace(/\n/g,'\n> ')}`);
        dispParts.push(`> ${r.text.replace(/\n/g,'\n> ')}`);
      } else if(r.type==='image'){
        apiParts.push(`[Replying to image: ${r.title||'image'}]`);
        dispParts.push(`*Replying to: ${r.title||'image'}*`);
      }
    }
    replyPrefix='[REPLY CONTEXT — the user is referencing the following content from a previous response]\n'+apiParts.join('\n')+'\n\n';
    displayPrefix=dispParts.join('\n')+'\n\n';
  }
  // Add reply images as file attachments so Gemini can see them
  for(const r of replies){
    if(r.type==='image'&&r.url){
      files.push({name:r.title||'image.jpg',mime:'image/jpeg',data:'',text:'',url:r.url});
    }
  }

  const displayText=displayPrefix+text;
  if(!_silent)addMsg('user',displayText,[],{fileNames:files.filter(f=>!f.url).map(f=>f.name),files:files.filter(f=>!f.url),replyImages:replies.filter(r=>r.type==='image')});
  setStatus('Working on it...');
  if(!(opts&&opts.message)){input.value='';input.style.height='auto';}
  pendingFiles=[];renderPF();
  pendingReplies=[];renderReplyContext();
  if(!_silent)for(const f of files)uploadedHistory.unshift({name:f.name,mime:f.mime,when:Date.now()});

  // ── Research when explicitly activated via tool ──
  // Deep research silently enhances the prompt — no visible plan/modal
  // It's sent as part of activeTools in the normal chat flow

  const controller=new AbortController();
  const streamId=++_nextStreamId;
  setChatRunning(targetChatId,true,{type:'chat',controller,streamId});
  const area=document.getElementById('chatArea');

  const msgDiv=document.createElement('div');
  msgDiv.className='msg kairo';
  msgDiv.innerHTML='<div class="lbl">gyro</div><div class="msg-content"><div class="think-active" style="animation:thinkingIn .5s var(--ease-spring-snappy) both"><div class="dots"><span></span><span></span><span></span></div><span id="_thinkPhrase" style="display:inline-block;transition:opacity .3s ease,transform .3s ease"> Thinking...</span></div></div>';
  area.appendChild(msgDiv);area.scrollTop=area.scrollHeight;
  startThinkingPhrases(msgDiv.querySelector('#_thinkPhrase'));
  const contentEl=msgDiv.querySelector('.msg-content');
  const canRender=()=>curChat===targetChatId&&msgDiv.isConnected;
  let _renderScheduled=false;

  try{
    // Collect active tool names and clear them for next message
    const toolsForMsg=[...activeTools];
    activeTools.clear();
    renderToolBadges();

    // If canvas is open, include canvas context for select-to-edit
    let messageToSend=replyPrefix?replyPrefix+text:text;
    const cCtx=getCanvasContext();
    if(cCtx){
      let canvasPrefix='';
      if(cCtx.selectedText){
        canvasPrefix=`[CANVAS CONTEXT — "${cCtx.title}"]\nThe user has selected this portion of the canvas:\n<<<SELECTED>>>\n${cCtx.selectedText}\n<<<END_SELECTED>>>\n\nFull canvas content:\n${cCtx.fullContent}\n\n[USER REQUEST]\n`;
        canvasSelection=null; // clear after use
      }else{
        canvasPrefix=`[CANVAS CONTEXT — "${cCtx.title}"]\nThe canvas currently contains:\n${cCtx.fullContent}\n\n[USER REQUEST]\n`;
      }
      messageToSend=canvasPrefix+messageToSend;
    }

    const response=await apiFetch(`/api/chats/${targetChatId}/stream`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({message:messageToSend,raw_text:text,files,thinking_level:_noThinking?'off':thinkingLevel,web_search:true,active_tools:toolsForMsg,is_continue:!!(opts&&opts.isContinue),user_location:getUserLocation()}),signal:controller.signal});

    const ct=response.headers.get('content-type')||'';
    if(ct.includes('application/json')){
      const d=await response.json();
      if(d.guest_limit){
        msgDiv.remove();
        showGuestLimit();
        setChatRunning(targetChatId,false);
        return;
      }
      if(d.error){
        // If chat was not found, re-create it and retry once
        if(response.status===404 && !sendMessage._retried){
          sendMessage._retried=true;
          msgDiv.remove();
          setChatRunning(targetChatId,false);
          curChat=null;
          await createChat(_activeFolderView||pendingFolder||'');
          document.getElementById('msgInput').value=text;
          pendingFiles=files;
          renderPF();
          await sendMessage(opts);
          sendMessage._retried=false;
          return;
        }
        sendMessage._retried=false;
        if(canRender())contentEl.innerHTML=`<div style="color:var(--red)">${esc(d.error)}</div>`;
        setChatRunning(targetChatId,false);
        return;
      }
    }

    const reader=response.body.getReader();
    const decoder=new TextDecoder();
    let buffer='',fullText='',thinkText='',isThinking=false;
    let _pendingContinueAfterOps=false;
    let _genFailures=[];
    // ── Mid-stream media loading state ──
    let _mediaLoadingCount=0;     // How many media items are currently loading
    let _doneReceived=false;      // Whether the 'done' event has been processed
    window._streamMediaResults={};// Results that arrived before 'done' (keyed by "kind-index")

    // Create a live thinking panel (collapsed by default — click to expand)
    let thinkPanel=null;
    let thinkTextEl=null;
    let _thinkSubjectSet=false;
    function _extractThinkSubject(text){
      const first=(text||'').split('\n').find(l=>l.trim())||'';
      const clean=first.replace(/^[-•*#>\s]+/,'').trim();
      if(clean.length>50)return clean.slice(0,50)+'…';
      return clean||'your question';
    }
    function ensureThinkPanel(){
      if(thinkPanel)return;
      const ta=contentEl.querySelector('.think-active');
      if(ta)ta.remove();
      stopThinkingPhrases();
      thinkPanel=document.createElement('div');
      thinkPanel.className='live-think-panel ltp-collapsed';
      thinkPanel.innerHTML='<div class="ltp-header" style="cursor:pointer"><span class="ltp-icon">💭</span><span class="ltp-label">Considering your question</span><span class="ltp-chevron">▾</span><span class="ltp-dots"><span></span><span></span><span></span></span></div><div class="ltp-body" style="max-height:0;padding:0;overflow:hidden;transition:max-height .3s var(--ease-smooth),padding .3s var(--ease-smooth)"><div class="ltp-text"></div></div>';
      const hdr=thinkPanel.querySelector('.ltp-header');
      const body=thinkPanel.querySelector('.ltp-body');
      hdr.onclick=()=>{
        const collapsed=thinkPanel.classList.contains('ltp-collapsed');
        thinkPanel.classList.toggle('ltp-collapsed',!collapsed);
        body.style.maxHeight=collapsed?'200px':'0';
        body.style.padding=collapsed?'12px 14px':'0';
      };
      contentEl.innerHTML='';
      contentEl.appendChild(thinkPanel);
      thinkTextEl=thinkPanel.querySelector('.ltp-text');
    }

    while(true){
      const{done,value}=await reader.read();
      if(done)break;
      buffer+=decoder.decode(value,{stream:true});
      let nlIdx;
      while((nlIdx=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,nlIdx).trim();
        buffer=buffer.slice(nlIdx+1);
        if(!line)continue;
        try{
          const data=JSON.parse(line);
          if(data.type==='thinking_delta'){
            if(!isThinking)console.log('[gyro] thinking_delta received — thinking panel activating');
            isThinking=true;
            thinkText+=data.text;
            if(canRender()){
              ensureThinkPanel();
              thinkTextEl.textContent=thinkText;
              thinkTextEl.scrollTop=thinkTextEl.scrollHeight;
              // Update the subject label once we have enough text
              if(!_thinkSubjectSet&&thinkText.length>15){
                const subj=_extractThinkSubject(thinkText);
                const lbl=thinkPanel.querySelector('.ltp-label');
                if(lbl)lbl.textContent='Considering '+subj;
                _thinkSubjectSet=true;
              }
              area.scrollTop=area.scrollHeight;
            }
          }else if(data.type==='delta'){
            // Transition from thinking to response
            if(isThinking&&thinkPanel){
              isThinking=false;
              thinkPanel.classList.add('ltp-done');
              const dotsEl=thinkPanel.querySelector('.ltp-dots');
              if(dotsEl)dotsEl.remove();
              // Add response area below
              const responseDiv=document.createElement('div');
              responseDiv.className='stream-response-area';
              contentEl.appendChild(responseDiv);
            }
            stopThinkingPhrases();
            fullText+=data.text;
            // When media is loading, buffer deltas but skip visible rendering
            if(_mediaLoadingCount>0){
              // Text is still accumulated in fullText but not rendered
            }else if(canRender()&&!_renderScheduled){
              _renderScheduled=true;
              requestAnimationFrame(()=>{
                _renderScheduled=false;
                if(!canRender())return;
                const targetEl=contentEl.querySelector('.stream-response-area')||contentEl;
                const ta=contentEl.querySelector('.think-active');
                if(ta){ta.remove();stopThinkingPhrases();}
                if(devRawMode){
                  targetEl.innerHTML='<pre class="dev-raw-log">'+esc(fullText)+'<span class="stream-cursor"></span></pre>';
                }else{
                  targetEl.innerHTML=fmtLive(fullText);
                }
                area.scrollTop=area.scrollHeight;
              });
            }
          // ── Mid-stream media loading event ──
          }else if(data.type==='media_loading'){
            _mediaLoadingCount++;
            // Insert an inline marker into fullText so fmtLive renders a loading card
            const info=data.query||data.ticker||data.prompt||'';
            fullText+=`\n[[[MEDIA:${data.kind}:${data.index}:${info}]]]\n`;
            // Render immediately to show the loading card
            if(canRender()&&!_renderScheduled){
              _renderScheduled=true;
              requestAnimationFrame(()=>{
                _renderScheduled=false;
                if(!canRender())return;
                const targetEl=contentEl.querySelector('.stream-response-area')||contentEl;
                targetEl.innerHTML=fmtLive(fullText);
                area.scrollTop=area.scrollHeight;
              });
            }
          }else if(data.type==='done'){
            _doneReceived=true;
            // Collapse live thinking panel if present
            if(thinkPanel){
              thinkPanel.classList.add('ltp-done');
              if(!thinkPanel.classList.contains('ltp-collapsed'))thinkPanel.classList.add('ltp-collapsed');
              const dotsEl=thinkPanel.querySelector('.ltp-dots');
              if(dotsEl)dotsEl.remove();
              const body=thinkPanel.querySelector('.ltp-body');
              if(body){body.style.maxHeight='0';body.style.padding='0';}
            }
            // Remove ALL thinking/loading indicators
            contentEl.querySelectorAll('.think-active,.live-think-panel:not(.ltp-done),.thinking').forEach(el=>{
              el.classList.add('ltp-done');
              el.style.animation='none';
            });
            stopThinkingPhrases();
            await new Promise(r=>setTimeout(r,150));
            let finalHTML='';
            let displayReply=data.reply||'';
            // If we already showed thinking live, use it for the think block
            if(thinkText){
              finalHTML+=renderThinkBlock(thinkText);
            } else if(displayReply.includes('<<<THINKING>>>')&&displayReply.includes('<<<END_THINKING>>>')){
              const parts=displayReply.split('<<<END_THINKING>>>');
              const thinkPart=parts[0].replace('<<<THINKING>>>','').trim();
              displayReply=parts.slice(1).join('<<<END_THINKING>>>').trim();
              finalHTML+=renderThinkBlock(thinkPart);
            }
            // Strip thinking tags from reply if still present
            displayReply=displayReply.replace(/<<<THINKING>>>[\s\S]*?<<<END_THINKING>>>/g,'').replace(/<<<\/?THINKING\/?>>>/g,'').trim();
            // Parse all choice blocks (supports multiple sequential questions)
            const choiceBlockRe=/(?:<<<QUESTION:(.*?)>>>\n)?<<<CHOICES(?:\|multi)?>>>\n([\s\S]*?)<<<END_CHOICES>>>/g;
            let choiceBlockMatch;
            const choiceBlocks=[];
            while((choiceBlockMatch=choiceBlockRe.exec(displayReply))!==null){
              const isMulti=/<<<CHOICES\|multi>>>/.test(choiceBlockMatch[0]);
              choiceBlocks.push({question:(choiceBlockMatch[1]||'').trim(),choices:choiceBlockMatch[2].trim().split('\n').filter(c=>c.trim()),multi:isMulti});
            }
            displayReply=displayReply.replace(/(?:<<<QUESTION:.*?>>>\n)?<<<CHOICES(?:\|multi)?>>>[\s\S]*?<<<END_CHOICES>>>/g,'').trim();
            // Detect <<<CONTINUE>>> tag — AI wants to chain another message
            let shouldContinue=false;
            // Check backend flag (reliable — detected before clean_response strips tags)
            if(data.should_continue){
              shouldContinue=true;
            }
            // Fallback: check raw accumulated stream text
            if(!shouldContinue&&fullText&&fullText.includes('<<<CONTINUE>>>')){
              shouldContinue=true;
            }
            if(displayReply.includes('<<<CONTINUE>>>')){
              shouldContinue=true;
              displayReply=displayReply.replace(/<<<CONTINUE>>>/g,'').trim();
            }
            if(devRawMode){
              // In dev raw mode, show the full unprocessed AI response with all tags
              finalHTML+='<pre class="dev-raw-log">'+esc(fullText||data.reply||displayReply)+'</pre>';
            }else{
              finalHTML+=fmt(displayReply);
            }
            if(!devRawMode&&choiceBlocks.length){
              const validBlocks=choiceBlocks.filter(cb=>cb.choices.length);
              if(validBlocks.length)finalHTML+=renderChoiceWizard(validBlocks);
            }
            const artifactIds=registerArtifactsFromReply(displayReply,data.files||[]);
            if(!devRawMode&&data.files?.length){
              finalHTML+='<div class="fops">';
              for(const f of data.files){const fname=f.path.split('/').pop().split('\\').pop();finalHTML+=`<div class="fo"><a href="#" onclick="event.preventDefault();openWorkspaceFile('${encodeURIComponent(f.path)}')" class="fo-link">📄 ${esc(f.action==='created'?'Created':'Updated')}: ${esc(fname)}</a></div>`;}
              finalHTML+='</div>';
            }
            if(!devRawMode)finalHTML+=renderArtifactCards(artifactIds,'ready');
            if(!devRawMode&&data.code_results?.length){
              for(const cr of data.code_results){
                const statusCls=cr.success?'code-run-success':'code-run-error';
                let filesHtml='';
                if(cr.files?.length){
                  filesHtml='<div class="crb-files">';
                  for(const gf of cr.files){
                    const dlUrl='/api/files/download?path='+encodeURIComponent(gf.path);
                    const viewUrl='/api/files/view?path='+encodeURIComponent(gf.path);
                    if(gf.is_image){
                      filesHtml+=`<div class="crb-file crb-file-image"><img src="${viewUrl}" alt="${esc(gf.name)}" style="max-width:100%;max-height:400px;border-radius:var(--r-md);margin:6px 0;cursor:pointer" onclick="openImageLightbox(this.src,'${esc(gf.name).replace(/'/g,"\\'")}')" onerror="this.style.display='none'"><div class="crb-file-link"><a href="${dlUrl}" target="_blank" class="fo-link">📎 ${esc(gf.name)}</a><span class="crb-file-size">${gf.size>1024?(gf.size/1024).toFixed(1)+'KB':gf.size+'B'}</span></div></div>`;
                    }else{
                      filesHtml+=`<div class="crb-file"><a href="${dlUrl}" target="_blank" class="fo-link">📎 ${esc(gf.name)}</a><span class="crb-file-size">${gf.size>1024?(gf.size/1024).toFixed(1)+'KB':gf.size+'B'}</span></div>`;
                    }
                  }
                  filesHtml+='</div>';
                }
                finalHTML+=`<div class="code-run-block ${statusCls}"><div class="crb-header"><span class="crb-lang">${esc(cr.language)}</span><span class="crb-status">${cr.success?'✓ Executed':'✗ Error'}</span></div><pre class="crb-code"><code>${esc(cr.code)}</code></pre><div class="crb-output-label">Output</div><pre class="crb-output">${esc(cr.output)}</pre>${filesHtml}</div>`;
              }
            }
            if(data.memory_added?.length)finalHTML+=`<div class="mops">Remembered: ${data.memory_added.map(esc).join('; ')}</div>`;

            // ── Image search — show loading placeholders for pending images ──
            if(!devRawMode&&data.pending_images?.length){
              for(const pi of data.pending_images){
                const loaderId=`img-loader-${pi.index}`;
                const loaderHTML=`<div class="img-grid-wrap img-loading-placeholder" id="${loaderId}" data-img-index="${pi.index}"><div class="img-grid-header"><span class="img-car-icon">🖼</span> Searching images for "${esc(pi.query)}"...</div><div class="img-loading-shimmer"><div class="img-shimmer-bar"></div><div class="img-shimmer-bar"></div><div class="img-shimmer-bar short"></div></div></div>`;
                // Replace %%%IMGBLOCK:N%%% placeholders with loaders
                const re=new RegExp(`<p>\\s*%%%IMGBLOCK:${pi.index}%%%\\s*</p>|%%%IMGBLOCK:${pi.index}%%%`,'g');
                const before=finalHTML;
                finalHTML=finalHTML.replace(re,loaderHTML);
                // Fallback: if placeholder wasn't found in rendered HTML, append loader
                if(finalHTML===before){
                  finalHTML+=loaderHTML;
                }
              }
            }

            // Also replace any remaining image results that came synchronously (reload/history)
            if(!devRawMode&&data.image_results?.length){
              const imgMap={};
              for(const ir of data.image_results){
                imgMap[ir.index]=renderImageBlock(ir);
              }
              finalHTML=finalHTML.replace(/<p>\s*%%%IMGBLOCK:(\d+)%%%\s*<\/p>|%%%IMGBLOCK:(\d+)%%%/g,(match,idx1,idx2)=>{
                const idx=parseInt(idx1||idx2,10);
                return imgMap[idx]||'';
              });
            }
            if(!devRawMode&&data.failed_images?.length){
              for(const fq of data.failed_images){
                finalHTML+=`<div class="img-search-fail"><span class="img-search-fail-icon">🖼</span> Image search for "${esc(fq)}" couldn't load — try again or search manually.</div>`;
              }
            }

            // ── AI image generation — show loading placeholders ──
            if(!devRawMode&&data.pending_generations?.length){
              for(const pg of data.pending_generations){
                const loaderId=`imggen-loader-${pg.index}`;
                const loaderHTML=`<div class="img-grid-wrap img-loading-placeholder" id="${loaderId}" data-imggen-index="${pg.index}"><div class="img-grid-header"><span class="img-gen-icon">🎨</span> Generating image...</div><div class="img-gen-prompt-preview">${esc(pg.prompt.length>80?pg.prompt.slice(0,80)+'…':pg.prompt)}</div><div class="img-loading-shimmer"><div class="img-shimmer-bar"></div><div class="img-shimmer-bar"></div><div class="img-shimmer-bar short"></div></div></div>`;
                const re=new RegExp(`<p>\\s*%%%IMGGEN:${pg.index}%%%\\s*</p>|%%%IMGGEN:${pg.index}%%%`,'g');
                const before=finalHTML;
                finalHTML=finalHTML.replace(re,loaderHTML);
                if(finalHTML===before){
                  finalHTML+=loaderHTML;
                }
              }
            }

            // Handle generated images on reload/history
            if(!devRawMode&&data.generated_images?.length){
              for(const gi of data.generated_images){
                const giPrompt=esc(gi.prompt);
                const genHTML=`<div class="img-gen-result"><div class="img-gen-header"><span class="img-gen-icon">🎨</span><span class="img-gen-title">Generated Image</span><button class="img-gen-dl" onclick="downloadGenFromEl(this)" title="Download PNG"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button></div><img src="${gi.url}" alt="${giPrompt}" class="img-gen-output" onclick="openImageLightbox(this.src,'Generated Image')" onerror="this.onerror=null;this.parentElement.querySelector('.img-gen-footer').innerHTML='<div class=img-gen-prompt>Image no longer available</div>';this.remove()"><div class="img-gen-footer"><div class="img-gen-prompt">${giPrompt}</div><button class="img-gen-dl-full" onclick="downloadGenFromEl(this)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download PNG</button></div></div>`;
                const re=new RegExp(`<p>\\s*%%%IMGGEN:${gi.index}%%%\\s*</p>|%%%IMGGEN:${gi.index}%%%`,'g');
                const before=finalHTML;
                finalHTML=finalHTML.replace(re,genHTML);
                if(finalHTML===before){
                  finalHTML+=genHTML;
                }
              }
            }

            // ── Stock data — ensure loading placeholders exist for pending stocks ──
            if(!devRawMode&&data.pending_stocks?.length){
              for(const ps of data.pending_stocks){
                const loaderId=`stock-loader-${ps.index}`;
                // fmt() should have rendered these already, but update the loading text
                // to show the ticker name, and ensure they exist as fallback
                const loaderHTML=`<div class="stock-card-wrap stock-loading-placeholder" id="${loaderId}" data-stock-index="${ps.index}"><div class="stock-card"><div class="stock-card-loading"><div class="stock-shimmer"></div><span>Loading ${esc(ps.ticker)} data...</span></div></div></div>`;
                // Check if fmt() already created the loader element
                if(!finalHTML.includes(`id="${loaderId}"`)){
                  // Fallback: try to replace raw placeholder or append
                  const re=new RegExp(`%%%STOCKBLOCK:${ps.index}%%%`,'g');
                  const before=finalHTML;
                  finalHTML=finalHTML.replace(re,loaderHTML);
                  if(finalHTML===before){
                    finalHTML+=loaderHTML;
                  }
                }
              }
            }
            // Handle stock results on reload/history
            if(!devRawMode&&data.stock_results?.length){
              for(const sr of data.stock_results){
                const stockHTML=renderStockCard(sr.ticker, sr.data);
                const re=new RegExp(`<p>\\s*%%%STOCKBLOCK:${sr.index}%%%\\s*</p>|%%%STOCKBLOCK:${sr.index}%%%`,'g');
                const before=finalHTML;
                finalHTML=finalHTML.replace(re,stockHTML);
                if(finalHTML===before){
                  finalHTML+=stockHTML;
                }
              }
            }

            // ── AI-triggered deep research ──
            if(data.research_trigger&&!choiceBlocks.length){
              const rq=data.research_trigger;
              // Use pending plan from modal if available
              const planText=window._pendingResearchPlan||undefined;
              window._pendingResearchPlan=null;
              // Show the AI's text first (don't overwrite it)
              if(canRender()){
                contentEl.innerHTML=finalHTML;
                if(data.title&&data.title!=='New Chat')document.getElementById('topTitle').textContent=data.title;
              }
              // Create a SEPARATE message div for the research card so the AI text stays visible
              const chatArea=document.getElementById('chatArea');
              const researchMsgDiv=document.createElement('div');
              researchMsgDiv.className='msg kairo';
              const researchContentEl=document.createElement('div');
              researchContentEl.className='msg-content';
              researchMsgDiv.innerHTML='<div class="lbl">gyro</div>';
              researchMsgDiv.appendChild(researchContentEl);
              chatArea.appendChild(researchMsgDiv);
              chatArea.scrollTop=chatArea.scrollHeight;
              setChatRunning(targetChatId,false);
              setChatRunning(targetChatId,true,{type:'research'});
              try{
                await runDeepResearch(rq,researchContentEl,chatArea,planText);
                await refreshChats();
                // After research completes, silently auto-continue so the AI can add commentary
                setChatRunning(targetChatId,false);
                try{
                  const inp=document.getElementById('msgInput');
                  inp.value='The deep research report above is now complete. Provide a brief executive summary highlighting the 3-5 most important findings, key takeaways, and any actionable recommendations. Be concise.';
                  sendMessage({silent:true,noThinking:true});
                }catch(_){}
              }catch(e){
                researchContentEl.innerHTML+=`<div style="color:var(--red);margin-top:12px">${esc(e.message||'Research failed.')}</div>`;
                setStatus('Research failed.');
                setChatRunning(targetChatId,false);
              }
              return;
            }

            if(canRender()){
              contentEl.style.opacity='1';contentEl.style.filter='';contentEl.style.transform='';
              contentEl.innerHTML=finalHTML;
              // Animate content in smoothly
              contentEl.style.opacity='0';
              contentEl.style.filter='blur(4px)';
              contentEl.style.transform='translateY(6px)';
              requestAnimationFrame(()=>{
                contentEl.style.transition='opacity .4s var(--ease-smooth), filter .4s var(--ease-smooth), transform .4s var(--ease-smooth)';
                contentEl.style.opacity='1';
                contentEl.style.filter='blur(0)';
                contentEl.style.transform='translateY(0)';
                setTimeout(()=>{
                  contentEl.style.transition='';
                  contentEl.style.filter='';
                  contentEl.style.transform='';
                },450);
              });
              if(data.title&&data.title!=='New Chat')document.getElementById('topTitle').textContent=data.title;
              try{Promise.resolve(mermaid.run()).then(()=>enhanceMermaidDiagrams())}catch{}
              // Apply preloaded media results that arrived during streaming (before done)
              if(window._streamMediaResults){
                for(const [key,result] of Object.entries(window._streamMediaResults)){
                  const parts=key.split('-');
                  const kind=parts[0];
                  const idx=parts.slice(1).join('-');
                  let loader=null;
                  if(kind==='image_search'){
                    loader=contentEl.querySelector(`#img-loader-${idx}`);
                    if(loader){
                      const temp=document.createElement('div');
                      temp.innerHTML=renderImageBlock(result);
                      loader.replaceWith(temp.firstElementChild||temp);
                    }
                  }else if(kind==='stock'){
                    loader=contentEl.querySelector(`#stock-loader-${idx}`);
                    if(loader){
                      const temp=document.createElement('div');
                      temp.innerHTML=renderStockCard(result.ticker,result.data);
                      loader.replaceWith(temp.firstElementChild||temp);
                    }
                  }else if(kind==='image_gen'){
                    loader=contentEl.querySelector(`#imggen-loader-${idx}`);
                    if(loader){
                      const img=result;
                      const temp=document.createElement('div');
                      temp.innerHTML=`<div class="img-gen-card" style="position:relative;border-radius:14px;overflow:hidden;border:1px solid var(--border);background:var(--bg-surface)"><img src="${img.url}" alt="${esc(img.prompt||'Generated image')}" style="width:100%;border-radius:14px;display:block;cursor:pointer" onclick="openLightbox(this.src)"><div style="padding:10px 14px;font-size:12px;color:var(--text-secondary)">🎨 ${esc(img.prompt||'Generated image')}</div></div>`;
                      loader.replaceWith(temp.firstElementChild||temp);
                    }
                  }
                }
              }
            }
            refreshChats();
            // ── Auto-reprompt after code execution ──
            // When code was executed, automatically send execution results back to the AI
            // so it can respond accurately (present files on success, debug on failure)
            if(data.code_auto_reprompt&&_codeRepromptCount<_MAX_CODE_REPROMPTS){
              _codeRepromptCount++;
              shouldContinue=false; // code reprompt takes priority over auto-continue
              const summary=data.code_execution_summary||'Code execution completed.';
              let repromptMsg;
              if(data.code_all_success){
                repromptMsg=`[SYSTEM] Code execution completed. Results:\n${summary}\n\nPresent the created files to the user. Link to files using [text](/api/files/download?path=FILENAME) format. Do NOT regenerate the code — just describe what was created and provide the download link(s).`;
              }else{
                repromptMsg=`[SYSTEM] Code execution FAILED. Results:\n${summary}\n\nThe code you wrote failed to execute. Do NOT claim it was successful. Analyze the error, explain what went wrong to the user, and provide a corrected version of the code using <<<CODE_EXECUTE: python>>>...<<<END_CODE>>> tags.`;
              }
              setStatus(data.code_all_success?'Code executed — presenting results...':'Code failed — retrying...');
              setTimeout(()=>{
                const inp=document.getElementById('msgInput');
                inp.value=repromptMsg;
                sendMessage({silent:true,noThinking:data.code_all_success});
              },800);
            }
            // Auto-continue if AI signaled <<<CONTINUE>>> or if the response was truncated
            // NEVER auto-continue when choice blocks are present — user needs to answer first
            // Skip auto-continue if code reprompt is handling the follow-up
            const _codeReprompting=data.code_auto_reprompt&&_codeRepromptCount<=_MAX_CODE_REPROMPTS;
            if(choiceBlocks.length||_codeReprompting){
              shouldContinue=false;
            }
            // If gen ops are pending, defer continue decision until gen_ops_complete event
            if(data.continue_after_ops&&!_codeReprompting){
              // Don't continue yet — wait for gen_ops_complete event
              _pendingContinueAfterOps=true;
              shouldContinue=false;
              setStatus('Generating content...');
            }
            if(!shouldContinue&&!choiceBlocks.length&&!_pendingContinueAfterOps){
              shouldContinue=_detectTruncation(displayReply);
            }
            if(shouldContinue&&_continueCount<_MAX_CONTINUES){
              _continueCount++;
              setStatus(`Continuing... (${_continueCount})`);
              setTimeout(()=>{
                sendMessage({silent:true,noThinking:true,isContinue:true,message:'Continue where you left off. Pick up exactly where you stopped.'});
              },600);
            }else if(!_pendingContinueAfterOps&&!_codeReprompting){
              _continueCount=0;
              setStatus('Done. Ask a follow-up or start something new.');
            }
            // If user navigated away and back, reload the chat so they see the response
            if(curChat===targetChatId&&!msgDiv.isConnected){
              openChat(targetChatId);
            }
          }else if(data.type==='error'){
            if(canRender())contentEl.innerHTML=`<div style="color:var(--red)">${esc(data.error)}</div>`;
          }else if(data.type==='image_result'){
            // Async image result — arrived during stream or after done
            if(!_doneReceived){
              // Pre-done: store for later application, resume rendering
              window._streamMediaResults[`image_search-${data.image.index}`]=data.image;
              _mediaLoadingCount=Math.max(0,_mediaLoadingCount-1);
              if(canRender()&&!_renderScheduled){
                _renderScheduled=true;
                requestAnimationFrame(()=>{
                  _renderScheduled=false;
                  if(!canRender())return;
                  const targetEl=contentEl.querySelector('.stream-response-area')||contentEl;
                  targetEl.innerHTML=fmtLive(fullText);
                  area.scrollTop=area.scrollHeight;
                });
              }
            }else if(!devRawMode&&canRender()){
              // Post-done: replace DOM loader
              const loader=contentEl.querySelector(`#img-loader-${data.image.index}`);
              if(loader){
                const html=renderImageBlock(data.image);
                const temp=document.createElement('div');
                temp.innerHTML=html;
                loader.replaceWith(temp.firstElementChild||temp);
              }
              area.scrollTop=area.scrollHeight;
            }
          }else if(data.type==='image_failed'){
            _genFailures.push({type:'image_search',query:data.query||''});
            if(!_doneReceived){
              _mediaLoadingCount=Math.max(0,_mediaLoadingCount-1);
              if(_mediaLoadingCount===0&&canRender()&&!_renderScheduled){
                _renderScheduled=true;
                requestAnimationFrame(()=>{
                  _renderScheduled=false;
                  if(!canRender())return;
                  const targetEl=contentEl.querySelector('.stream-response-area')||contentEl;
                  targetEl.innerHTML=fmtLive(fullText);
                  area.scrollTop=area.scrollHeight;
                });
              }
            }else if(!devRawMode&&canRender()){
              const loader=contentEl.querySelector(`#img-loader-${data.index}`);
              if(loader){
                loader.innerHTML=`<div class="img-grid-header"><span class="img-search-fail-icon">🖼</span> Image search for "${esc(data.query)}" couldn't load — try again or search manually.</div>`;
                loader.classList.remove('img-loading-placeholder');
                loader.classList.add('img-search-fail-block');
              }
            }
          }else if(data.type==='image_generated'){
            if(!_doneReceived){
              // Pre-done: store for later, resume rendering
              window._streamMediaResults[`image_gen-${data.image.index}`]=data.image;
              _mediaLoadingCount=Math.max(0,_mediaLoadingCount-1);
              if(canRender()&&!_renderScheduled){
                _renderScheduled=true;
                requestAnimationFrame(()=>{
                  _renderScheduled=false;
                  if(!canRender())return;
                  const targetEl=contentEl.querySelector('.stream-response-area')||contentEl;
                  targetEl.innerHTML=fmtLive(fullText);
                  area.scrollTop=area.scrollHeight;
                });
              }
            }else if(!devRawMode&&canRender()){
              // Post-done: replace DOM loader
              const loader=contentEl.querySelector(`#imggen-loader-${data.image.index}`);
              const safePrompt=esc(data.image.prompt);
              const html=`<div class="img-gen-result">`
                +`<div class="img-gen-header">`
                +`<span class="img-gen-icon">🎨</span>`
                +`<span class="img-gen-title">Generated Image</span>`
                +`<button class="img-gen-dl" onclick="downloadGenFromEl(this)" title="Download PNG">`
                +`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`
                +`</button>`
                +`</div>`
                +`<img src="${data.image.url}" alt="${safePrompt}" class="img-gen-output" onclick="openImageLightbox(this.src,'Generated Image')">`
                +`<div class="img-gen-footer">`
                +`<div class="img-gen-prompt">${safePrompt}</div>`
                +`<button class="img-gen-dl-full" onclick="downloadGenFromEl(this)">`
                +`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`
                +` Download PNG</button>`
                +`</div>`
                +`</div>`;
              if(loader){
                const temp=document.createElement('div');
                temp.innerHTML=html;
                loader.replaceWith(temp.firstElementChild||temp);
              }
              area.scrollTop=area.scrollHeight;
            }
          }else if(data.type==='image_gen_failed'){
            _genFailures.push({type:'image_gen',prompt:data.prompt||'',error:data.error||''});
            if(!_doneReceived){
              _mediaLoadingCount=Math.max(0,_mediaLoadingCount-1);
              if(_mediaLoadingCount===0&&canRender()&&!_renderScheduled){
                _renderScheduled=true;
                requestAnimationFrame(()=>{
                  _renderScheduled=false;
                  if(!canRender())return;
                  const targetEl=contentEl.querySelector('.stream-response-area')||contentEl;
                  targetEl.innerHTML=fmtLive(fullText);
                  area.scrollTop=area.scrollHeight;
                });
              }
            }else if(!devRawMode&&canRender()){
              const loader=contentEl.querySelector(`#imggen-loader-${data.index}`);
              if(loader){
                loader.innerHTML=`<div class="img-grid-header"><span class="img-search-fail-icon">🎨</span> Image generation failed: ${esc(data.error||'Unknown error')}</div>`;
                loader.classList.remove('img-loading-placeholder');
                loader.classList.add('img-search-fail-block');
              }
            }
          }else if(data.type==='stock_data'){
            if(!_doneReceived){
              // Pre-done: store for later, resume rendering
              window._streamMediaResults[`stock-${data.stock.index}`]=data.stock;
              _mediaLoadingCount=Math.max(0,_mediaLoadingCount-1);
              if(canRender()&&!_renderScheduled){
                _renderScheduled=true;
                requestAnimationFrame(()=>{
                  _renderScheduled=false;
                  if(!canRender())return;
                  const targetEl=contentEl.querySelector('.stream-response-area')||contentEl;
                  targetEl.innerHTML=fmtLive(fullText);
                  area.scrollTop=area.scrollHeight;
                });
              }
            }else if(!devRawMode&&canRender()){
              // Post-done: replace DOM loader
              const loader=contentEl.querySelector(`#stock-loader-${data.stock.index}`);
              if(loader){
                const html=renderStockCard(data.stock.ticker, data.stock.data);
                const temp=document.createElement('div');
                temp.innerHTML=html;
                loader.replaceWith(temp.firstElementChild||temp);
              }
              area.scrollTop=area.scrollHeight;
            }
          }else if(data.type==='stock_failed'){
            if(!_doneReceived){
              _mediaLoadingCount=Math.max(0,_mediaLoadingCount-1);
              if(_mediaLoadingCount===0&&canRender()&&!_renderScheduled){
                _renderScheduled=true;
                requestAnimationFrame(()=>{
                  _renderScheduled=false;
                  if(!canRender())return;
                  const targetEl=contentEl.querySelector('.stream-response-area')||contentEl;
                  targetEl.innerHTML=fmtLive(fullText);
                  area.scrollTop=area.scrollHeight;
                });
              }
            }else if(!devRawMode&&canRender()){
              const loader=contentEl.querySelector(`#stock-loader-${data.index}`);
              if(loader){
                loader.innerHTML=`<div class="stock-card"><div class="stock-card-error">⚠️ Failed to load ${esc(data.ticker)} stock data: ${esc(data.error||'Unknown error')}</div></div>`;
                loader.classList.remove('stock-loading-placeholder');
              }
            }
          }else if(data.type==='gen_ops_complete'){
            // All generative operations (image gen, image search, stock) are done
            // Stock auto-reprompt: send fetched data back to AI for analysis
            if(data.stock_reprompt&&!_genFailures.length){
              setChatRunning(targetChatId,false);
              _continueCount=0;
              _pendingContinueAfterOps=false;
              setStatus('Analyzing stock data...');
              try{
                const inp=document.getElementById('msgInput');
                inp.value=`[SYSTEM] Stock data has been loaded. Here is the live data from Yahoo Finance for the stocks you just displayed:\n\n${data.stock_reprompt}\n\nNow analyze this data for the user. Reference the ACTUAL numbers shown above. The stock cards are already visible to the user — do NOT re-embed <<<STOCK>>> tags. Instead, provide your analysis, comparison, or recommendation based on the real data. Keep it concise (3-5 sentences max). Include the mandatory disclaimer.`;
                sendMessage({silent:true,noThinking:true});
              }catch(_){}
              return; // skip the normal gen_ops_complete handling below
            }
            if(_genFailures.length>0){
              // Some ops failed — notify the AI so it can report to user
              const failMsgs=_genFailures.map(f=>{
                if(f.type==='image_gen')return `Image generation failed for "${f.prompt}": ${f.error}`;
                return `Image search failed for "${f.query}"`;
              });
              setChatRunning(targetChatId,false);
              _continueCount=0;
              _pendingContinueAfterOps=false;
              setStatus('Some operations failed.');
              try{
                const inp=document.getElementById('msgInput');
                inp.value=`[SYSTEM] The following operations failed:\n${failMsgs.join('\n')}\n\nPlease acknowledge the failures to the user. Do NOT retry automatically. Let them know what happened and suggest they try again if they want.`;
                sendMessage({silent:true,noThinking:true});
              }catch(_){}
            }else if(_pendingContinueAfterOps){
              // All ops succeeded — now safe to continue
              _pendingContinueAfterOps=false;
              if(_continueCount<_MAX_CONTINUES){
                _continueCount++;
                setStatus(`Continuing... (${_continueCount})`);
                setTimeout(()=>{
                  sendMessage({silent:true,noThinking:true,isContinue:true,message:'Continue where you left off. Pick up exactly where you stopped.'});
                },600);
              }else{
                _continueCount=0;
                setStatus('Done. Ask a follow-up or start something new.');
              }
            }else{
              // No pending continue, just mark done
              setStatus('Done. Ask a follow-up or start something new.');
            }
          }
        }catch(e){}
      }
    }
  }catch(e){
    if(e.name==='AbortError'){
      stopThinkingPhrases();
      if(canRender()&&(!contentEl.innerHTML||contentEl.querySelector('.think-active'))){msgDiv.remove();}
    }else{
      stopThinkingPhrases();
      const errDetail=e.message||'Unknown error';
      if(canRender())contentEl.innerHTML=`<div style=\"color:var(--red)\">Connection error: ${esc(errDetail)}<br><small>Is the server running? Check your network.</small></div>`;
    }
  }finally{
    // Only clear running state if this stream is still the active one
    // (a silent continue may have started a new stream already)
    const cur=runningStreams.get(targetChatId);
    if(!cur||cur.streamId===streamId)setChatRunning(targetChatId,false);
  }
}

function renderThinkBlock(thinkText){
  const lines=thinkText.split('\n').filter(l=>l.trim());
  const summary=lines[0]?lines[0].replace(/^[-•*#>\s]+/,'').slice(0,50):'your question';
  return `<div class="think-block" onclick="this.classList.toggle('expanded')">
    <div class="think-header"><span>💭</span> <span>Considered ${esc(summary)}</span> <span class="think-chevron">▾</span></div>
    <div class="think-content">${esc(thinkText)}</div>
  </div>`;
}

function addMsg(role,text,files,extra={}){
  const area=document.getElementById('chatArea');const div=document.createElement('div');
  div.className=`msg ${role}`;let html='';
  if(role==='kairo')html+='<div class="lbl">gyro</div>';
  if(role==='user'&&extra.replyImages?.length){
    const imgs=extra.replyImages.map(r=>`<div class="user-file-preview image reply-img"><img src="${esc(r.url)}" alt="${esc(r.title||'image')}" loading="lazy"></div>`).join('');
    html+=`<div class="msg-user-files">${imgs}</div>`;
  }
  if(role==='user'&&extra.files?.length){
    const previews=extra.files.map(f=>{
      const name=esc(f.name||'upload');
      if(f.mime?.startsWith('image/')&&f.data){
        return `<div class="user-file-preview image"><img src="data:${f.mime};base64,${f.data}" alt="${name}" loading="lazy"></div>`;
      }
      return `<div class="user-file-preview"><span>${name}</span></div>`;
    }).join('');
    html+=`<div class="msg-user-files">${previews}</div>`;
  }
  let displayText=text||'';
  if(displayText.includes('<<<THINKING>>>')&&displayText.includes('<<<END_THINKING>>>')){
    const parts=displayText.split('<<<END_THINKING>>>');
    const thinkPart=parts[0].replace('<<<THINKING>>>','').trim();
    displayText=parts.slice(1).join('<<<END_THINKING>>>').trim();
    html+=renderThinkBlock(thinkPart);
  }
  // Parse all choice blocks (supports multiple sequential questions)
  const choiceBlockRe2=/(?:<<<QUESTION:(.*?)>>>\n)?<<<CHOICES(?:\|multi)?>>>\n([\s\S]*?)<<<END_CHOICES>>>/g;
  let cbm2;
  const cBlocks=[];
  while((cbm2=choiceBlockRe2.exec(displayText))!==null){
    const isMulti=/<<<CHOICES\|multi>>>/.test(cbm2[0]);
    cBlocks.push({question:(cbm2[1]||'').trim(),choices:cbm2[2].trim().split('\n').filter(c=>c.trim()),multi:isMulti});
  }
  displayText=displayText.replace(/(?:<<<QUESTION:.*?>>>\n)?<<<CHOICES(?:\|multi)?>>>[\s\S]*?<<<END_CHOICES>>>/g,'').trim();
  // Long user text → collapsible file block
  if(role==='user'&&displayText.length>600){
    const lines=displayText.split('\n');
    const preview=lines.slice(0,3).join('\n');
    html+=`<div class="user-paste-file"><div class="upf-header" onclick="this.parentElement.classList.toggle('upf-expanded')">`
      +`<span class="upf-icon">📄</span><span class="upf-label">Pasted text (${lines.length} lines)</span><span class="upf-chevron">▾</span></div>`
      +`<div class="upf-preview">${esc(preview)}${lines.length>3?'\n…':''}</div>`
      +`<div class="upf-full"><pre>${esc(displayText)}</pre></div></div>`;
  } else if(devRawMode&&role==='kairo'){
    html+='<pre class="dev-raw-log">'+esc(extra.raw_text||text||'')+'</pre>';
  } else {
    html+=fmt(displayText);
  }
  if(!devRawMode&&cBlocks.length&&role==='kairo'){
    html+='<div class="cq-group">';
    for(const cb of cBlocks){
      if(cb.choices.length)html+=renderChoiceBlock(cb.choices,cb.question,cb.multi);
    }
    if(cBlocks.length>1||cBlocks.some(cb=>cb.multi))html+='<button class="cq-submit-all" onclick="submitAllChoices(this)" disabled>Submit Answers</button>';
    html+='</div>';
  }
  let artifactIds=[];
  if(role==='kairo')artifactIds=registerArtifactsFromReply(displayText,files||[]);
  if(files?.length){html+='<div class="fops">';for(const f of files){const fname=f.path.split('/').pop().split('\\').pop();html+=`<div class="fo"><a href="#" onclick="event.preventDefault();openWorkspaceFile('${encodeURIComponent(f.path)}')" class="fo-link">📄 ${esc(f.action==='created'?'Created':'Updated')}: ${esc(fname)}</a></div>`;}html+='</div>'}
  if(artifactIds.length)html+=renderArtifactCards(artifactIds,'ready');
  if(extra.code_results?.length){
    for(const cr of extra.code_results){
      const statusCls=cr.success?'code-run-success':'code-run-error';
      let filesHtml='';
      if(cr.files?.length){
        filesHtml='<div class="crb-files">';
        for(const gf of cr.files){
          const dlUrl='/api/files/download?path='+encodeURIComponent(gf.path);
          const viewUrl='/api/files/view?path='+encodeURIComponent(gf.path);
          if(gf.is_image){
            filesHtml+=`<div class="crb-file crb-file-image"><img src="${viewUrl}" alt="${esc(gf.name)}" style="max-width:100%;max-height:400px;border-radius:var(--r-md);margin:6px 0;cursor:pointer" onclick="openImageLightbox(this.src,'${esc(gf.name).replace(/'/g,"\\'")}')" onerror="this.style.display='none'"><div class="crb-file-link"><a href="${dlUrl}" target="_blank" class="fo-link">📎 ${esc(gf.name)}</a><span class="crb-file-size">${gf.size>1024?(gf.size/1024).toFixed(1)+'KB':gf.size+'B'}</span></div></div>`;
          }else{
            filesHtml+=`<div class="crb-file"><a href="${dlUrl}" target="_blank" class="fo-link">📎 ${esc(gf.name)}</a><span class="crb-file-size">${gf.size>1024?(gf.size/1024).toFixed(1)+'KB':gf.size+'B'}</span></div>`;
          }
        }
        filesHtml+='</div>';
      }
      html+=`<div class="code-run-block ${statusCls}"><div class="crb-header"><span class="crb-lang">${esc(cr.language)}</span><span class="crb-status">${cr.success?'✓ Executed':'✗ Error'}</span></div><pre class="crb-code"><code>${esc(cr.code)}</code></pre><div class="crb-output-label">Output</div><pre class="crb-output">${esc(cr.output)}</pre>${filesHtml}</div>`;
    }
  }
  if(extra.memory_added?.length)html+=`<div class="mops">Remembered: ${extra.memory_added.map(esc).join('; ')}</div>`;
  // Render persisted image search results on reload
  if(!devRawMode&&extra.image_results?.length){
    const imgMap={};
    for(const ir of extra.image_results){
      imgMap[ir.index]=renderImageBlock(ir);
    }
    html=html.replace(/<p>\s*%%%IMGBLOCK:(\d+)%%%\s*<\/p>|%%%IMGBLOCK:(\d+)%%%/g,(match,idx1,idx2)=>{
      const idx=parseInt(idx1||idx2,10);
      return imgMap[idx]||'';
    });
    // If placeholders were already stripped (clean_response removed tags), append images at end
    const hasPlaceholders=/%%%IMGBLOCK:\d+%%%/.test(html);
    if(!hasPlaceholders){
      for(const ir of extra.image_results){
        html+=renderImageBlock(ir);
      }
    }
  }
  // Render persisted generated images on reload
  if(!devRawMode&&extra.generated_images?.length){
    for(const gi of extra.generated_images){
      const giUrl=esc(gi.url);const giPrompt=esc(gi.prompt);
      const genHTML=`<div class="img-gen-result"><div class="img-gen-header"><span class="img-gen-icon">🎨</span><span class="img-gen-title">Generated Image</span><button class="img-gen-dl" onclick="downloadGenImage('${giUrl}','${giPrompt}')" title="Download PNG"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button></div><img src="${giUrl}" alt="${giPrompt}" class="img-gen-output" onclick="openImageLightbox(this.src,'Generated Image')"><div class="img-gen-footer"><div class="img-gen-prompt">${giPrompt}</div><button class="img-gen-dl-full" onclick="downloadGenImage('${giUrl}','${giPrompt}')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download PNG</button></div></div>`;
      const re=new RegExp(`<p>\\s*%%%IMGGEN:${gi.index}%%%\\s*</p>|%%%IMGGEN:${gi.index}%%%`,'g');
      const before=html;
      html=html.replace(re,genHTML);
      if(html===before){
        html+=genHTML;
      }
    }
  }
  // Render persisted stock results on reload
  if(!devRawMode&&extra.stock_results?.length){
    for(const sr of extra.stock_results){
      const stockHTML=renderStockCard(sr.ticker, sr.data);
      // fmt() renders %%%STOCKBLOCK:N%%% as loading cards with id="stock-loader-N"
      // Replace those loaders with actual rendered cards
      const loaderRe=new RegExp(`<div[^>]*id="stock-loader-${sr.index}"[^>]*>[\\s\\S]*?</div>\\s*</div>\\s*</div>`,'g');
      const before=html;
      html=html.replace(loaderRe,stockHTML);
      if(html===before){
        // Fallback: try raw placeholder or append
        const rawRe=new RegExp(`%%%STOCKBLOCK:${sr.index}%%%`,'g');
        const before2=html;
        html=html.replace(rawRe,stockHTML);
        if(html===before2){
          html+=stockHTML;
        }
      }
      if(html===before){
        html+=stockHTML;
      }
    }
  }
  if(role==='user'&&text)html+=`<div class="msg-actions"><button class="msg-action-btn" onclick="editMsg(this)">✎ Edit</button></div>`;
  else if(role==='kairo')html+=`<div class="msg-actions"><button class="msg-action-btn" onclick="retryMsg(this)">↺ Retry</button></div>`;
  div.dataset.text=text||'';
  div.innerHTML=html;area.appendChild(div);area.scrollTop=area.scrollHeight;
}

function addThinking(){
  const area=document.getElementById('chatArea');const div=document.createElement('div');
  div.className='thinking';div.innerHTML='<div class="dots"><span></span><span></span><span></span></div> gyro is thinking...';
  area.appendChild(div);area.scrollTop=area.scrollHeight;return div;
}

let _canvasBlockId=0;
function sanitizeMermaidSource(src){
  // Fix common mindmap issues: unbalanced parens/brackets in node text
  const lines=src.split('\n');
  const out=[];
  for(const line of lines){
    let l=line;
    // For mindmap nodes (indented lines that aren't the keyword line)
    if(/^\s+/.test(l)&&!/^\s*(mindmap|graph|flowchart|classDiagram|sequenceDiagram|stateDiagram|erDiagram|gantt|journey|pie)\b/i.test(l.trim())){
      // Remove problematic chars in node text that break mermaid mindmap parser
      // But preserve indentation exactly
      const indent=l.match(/^(\s*)/)[1];
      let text=l.slice(indent.length);
      // Strip shape markers like (...), [...], {{...}}, ((...)) and just use plain text
      text=text.replace(/^\(+([^)]*)\)+$/,'$1').replace(/^\[+([^\]]*)\]+$/,'$1').replace(/^\{\{([^}]*)\}\}$/,'$1');
      // Escape remaining problematic chars
      text=text.replace(/[()[\]{}]/g,' ').replace(/:/g,' -').replace(/"/g,"'");
      l=indent+text;
    }
    out.push(l);
  }
  return out.join('\n');
}

// ─── Inline interactive todo lists ─────────────────
function countTodoItems(items){
  let total=0,done=0;
  for(const it of items){total++;if(it.done)done++;if(it.subtasks)for(const s of it.subtasks){total++;if(s.done)done++;}}
  return{total,done};
}

function renderTodoRowHTML(listId,item,isSub,parentId){
  const checked=item.done?'checked':'';
  const doneClass=item.done?'done':'';
  const subClass=isSub?'subtask':'';
  const pAttr=parentId?` data-parent-id="${parentId}"`:'';
  const pArg=parentId?`,'${parentId}'`:'';
  let h=`<div class="chat-todo-row ${doneClass} ${subClass}" data-item-id="${item.id}"${pAttr}>`;
  h+=`<button class="chat-todo-check ${checked}" onclick="toggleChatTodo('${listId}','${item.id}'${pArg})"><span>${item.done?'✓':''}</span></button>`;
  h+=`<span class="chat-todo-text" ondblclick="editChatTodo('${listId}','${item.id}',this${pArg})">${esc(item.text)}</span>`;
  if(!isSub)h+=`<button class="chat-todo-addsub" onclick="addSubtask('${listId}','${item.id}')" title="Add subtask">⊕</button>`;
  h+=`<button class="chat-todo-del" onclick="deleteChatTodo('${listId}','${item.id}'${pArg})" title="Delete">✕</button>`;
  h+=`</div>`;
  return h;
}

function renderChatTodoList(listId){
  const items=chatTodoStore.get(listId)||[];
  const{total,done}=countTodoItems(items);
  const pct=total?Math.round(done/total*100):0;
  let html=`<div class="chat-todo" data-list-id="${listId}">`;
  html+=`<div class="chat-todo-header"><span class="chat-todo-icon">☑</span><span class="chat-todo-title">${done}/${total} completed</span><div class="chat-todo-bar"><div class="chat-todo-bar-fill" style="width:${pct}%"></div></div></div>`;
  html+=`<div class="chat-todo-items">`;
  items.forEach(item=>{
    html+=renderTodoRowHTML(listId,item,false);
    if(item.subtasks&&item.subtasks.length){
      html+=`<div class="chat-todo-subtask-group" data-parent-id="${item.id}">`;
      item.subtasks.forEach(sub=>{html+=renderTodoRowHTML(listId,sub,true,item.id);});
      html+=`</div>`;
    }
  });
  html+=`</div>`;
  html+=`<div class="chat-todo-footer"><button class="chat-todo-add" onclick="addChatTodo('${listId}')">+ Add task</button></div>`;
  html+=`</div>`;
  return html;
}

function updateChatTodoHeader(listId){
  const el=document.querySelector(`.chat-todo[data-list-id="${listId}"]`);
  if(!el)return;
  const items=chatTodoStore.get(listId)||[];
  const{total,done}=countTodoItems(items);
  const pct=total?Math.round(done/total*100):0;
  const title=el.querySelector('.chat-todo-title');
  if(title)title.textContent=`${done}/${total} completed`;
  const fill=el.querySelector('.chat-todo-bar-fill');
  if(fill)fill.style.width=pct+'%';
  syncChatTodosToStorage(listId);
}

function findTodoItem(items,itemId,parentId){
  if(parentId){const p=items.find(i=>i.id===parentId);return p&&p.subtasks?p.subtasks.find(s=>s.id===itemId):null;}
  return items.find(i=>i.id===itemId);
}

function updateRowDOM(listId,itemId,done){
  const el=document.querySelector(`.chat-todo[data-list-id="${listId}"]`);
  if(!el)return;
  const row=el.querySelector(`.chat-todo-row[data-item-id="${itemId}"]`);
  if(!row)return;
  row.classList.toggle('done',done);
  const check=row.querySelector('.chat-todo-check');
  if(check){check.classList.toggle('checked',done);check.querySelector('span').textContent=done?'✓':'';}
}

function autoCheckParent(listId,parentId){
  const items=chatTodoStore.get(listId);
  if(!items)return;
  const parent=items.find(i=>i.id===parentId);
  if(!parent||!parent.subtasks||!parent.subtasks.length)return;
  const allDone=parent.subtasks.every(s=>s.done);
  if(allDone&&!parent.done){parent.done=true;updateRowDOM(listId,parentId,true);}
  else if(!allDone&&parent.done){parent.done=false;updateRowDOM(listId,parentId,false);}
}

function syncChatTodosToStorage(listId){
  const items=chatTodoStore.get(listId)||[];
  const state=loadProductivityState();
  state.todos=state.todos.filter(t=>!t.id.startsWith(listId));
  items.forEach(it=>{
    state.todos.push({id:it.id,text:it.text,done:it.done});
    if(it.subtasks)it.subtasks.forEach(s=>{state.todos.push({id:s.id,text:s.text,done:s.done});});
  });
  saveProductivityState(state);
}

let _todoToggleDebounce=0;
function toggleChatTodo(listId,itemId,parentId){
  // Debounce rapid clicks (prevents double-toggle)
  const now=Date.now();
  if(now-_todoToggleDebounce<200)return;
  _todoToggleDebounce=now;
  const items=chatTodoStore.get(listId);
  if(!items)return;
  const item=findTodoItem(items,itemId,parentId);
  if(!item)return;
  item.done=!item.done;
  updateRowDOM(listId,itemId,item.done);
  // If toggling a parent, cascade to all children
  if(!parentId&&item.subtasks&&item.subtasks.length){
    for(const sub of item.subtasks){
      sub.done=item.done;
      updateRowDOM(listId,sub.id,sub.done);
    }
  }
  if(parentId)autoCheckParent(listId,parentId);
  updateChatTodoHeader(listId);
}

function deleteChatTodo(listId,itemId,parentId){
  const items=chatTodoStore.get(listId);
  if(!items)return;
  const el=document.querySelector(`.chat-todo[data-list-id="${listId}"]`);
  const row=el?.querySelector(`.chat-todo-row[data-item-id="${itemId}"]`);
  if(row){
    row.classList.add('removing');
    row.addEventListener('animationend',()=>{
      row.remove();
      if(!parentId){const sg=el.querySelector(`.chat-todo-subtask-group[data-parent-id="${itemId}"]`);if(sg)sg.remove();}
    },{once:true});
  }
  if(parentId){
    const parent=items.find(i=>i.id===parentId);
    if(parent&&parent.subtasks){
      parent.subtasks=parent.subtasks.filter(s=>s.id!==itemId);
      setTimeout(()=>{const sg=el?.querySelector(`.chat-todo-subtask-group[data-parent-id="${parentId}"]`);if(sg&&!sg.children.length)sg.remove();},250);
      autoCheckParent(listId,parentId);
    }
  }else{
    chatTodoStore.set(listId,items.filter(i=>i.id!==itemId));
  }
  updateChatTodoHeader(listId);
}

function editChatTodo(listId,itemId,el,parentId){
  const items=chatTodoStore.get(listId);
  if(!items)return;
  const item=findTodoItem(items,itemId,parentId);
  if(!item)return;
  const input=document.createElement('input');
  input.type='text';input.value=item.text;
  input.className='chat-todo-edit-input';
  let committed=false;
  const commit=()=>{
    if(committed)return;committed=true;
    const val=input.value.trim();
    if(val){item.text=val;el.textContent=val;}
    else el.textContent=item.text;
    syncChatTodosToStorage(listId);
  };
  input.onblur=commit;
  input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();input.blur();}if(e.key==='Escape'){input.value=item.text;input.blur();}};
  el.textContent='';
  el.appendChild(input);
  input.focus();input.select();
}

function addChatTodo(listId){
  const el=document.querySelector(`.chat-todo[data-list-id="${listId}"]`);
  if(!el)return;
  const container=el.querySelector('.chat-todo-items');
  if(!container)return;
  const row=document.createElement('div');
  row.className='chat-todo-row adding';
  row.innerHTML=`<button class="chat-todo-check"><span></span></button><input class="chat-todo-edit-input" type="text" placeholder="Type task name…"><button class="chat-todo-del" style="opacity:1" title="Cancel">✕</button>`;
  container.appendChild(row);
  const input=row.querySelector('input');
  let committed=false;
  const commit=()=>{
    if(committed)return;committed=true;
    const val=input.value.trim();
    if(val){
      const items=chatTodoStore.get(listId)||[];
      const newId=listId+'_'+Date.now().toString(36);
      const newItem={id:newId,text:val,done:false,subtasks:[]};
      items.push(newItem);
      row.outerHTML=renderTodoRowHTML(listId,newItem,false);
      updateChatTodoHeader(listId);
    }else{
      row.classList.add('removing');
      setTimeout(()=>row.remove(),200);
    }
  };
  input.addEventListener('blur',commit);
  input.addEventListener('keydown',e=>{
    if(e.key==='Enter'){e.preventDefault();input.blur();}
    if(e.key==='Escape'){input.value='';input.blur();}
  });
  row.querySelector('.chat-todo-del').addEventListener('click',()=>{input.value='';input.blur();});
  requestAnimationFrame(()=>input.focus());
}

function addSubtask(listId,parentId){
  const el=document.querySelector(`.chat-todo[data-list-id="${listId}"]`);
  if(!el)return;
  const items=chatTodoStore.get(listId);
  if(!items)return;
  const parent=items.find(i=>i.id===parentId);
  if(!parent)return;
  if(!parent.subtasks)parent.subtasks=[];
  let subGroup=el.querySelector(`.chat-todo-subtask-group[data-parent-id="${parentId}"]`);
  if(!subGroup){
    subGroup=document.createElement('div');
    subGroup.className='chat-todo-subtask-group';
    subGroup.dataset.parentId=parentId;
    const parentRow=el.querySelector(`.chat-todo-row[data-item-id="${parentId}"]`);
    if(parentRow)parentRow.after(subGroup);
  }
  const row=document.createElement('div');
  row.className='chat-todo-row subtask adding';
  row.innerHTML=`<button class="chat-todo-check"><span></span></button><input class="chat-todo-edit-input" type="text" placeholder="Type subtask…"><button class="chat-todo-del" style="opacity:1" title="Cancel">✕</button>`;
  subGroup.appendChild(row);
  const input=row.querySelector('input');
  let committed=false;
  const commit=()=>{
    if(committed)return;committed=true;
    const val=input.value.trim();
    if(val){
      const newId=parentId+'_s'+Date.now().toString(36);
      const newSub={id:newId,text:val,done:false};
      parent.subtasks.push(newSub);
      row.outerHTML=renderTodoRowHTML(listId,newSub,true,parentId);
      updateChatTodoHeader(listId);
    }else{
      row.classList.add('removing');
      setTimeout(()=>{row.remove();if(!subGroup.children.length)subGroup.remove();},200);
    }
  };
  input.addEventListener('blur',commit);
  input.addEventListener('keydown',e=>{
    if(e.key==='Enter'){e.preventDefault();input.blur();}
    if(e.key==='Escape'){input.value='';input.blur();}
  });
  row.querySelector('.chat-todo-del').addEventListener('click',()=>{input.value='';input.blur();});
  requestAnimationFrame(()=>input.focus());
}

function fmt(text){
  if(!text)return'';let t=text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  let blocks=[];
  t=t.replace(/```mermaid\n([\s\S]*?)```/g,(_,c)=>{
    let restored=c.replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
    // Sanitize mindmap source to fix common syntax issues
    if(/^\s*mindmap\b/i.test(restored)) restored=sanitizeMermaidSource(restored);
    const mindId='mm_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,7);
    const title=inferMindMapTitle(restored,blocks.length+1);
    mindMapStore.set(mindId,{title,source:restored});
    blocks.push(`<div class="mermaid-container" data-mindmap-id="${mindId}"><div class="mermaid-toolbar"><button class="mm-copy" onclick="copyMermaidPng(this)" title="Copy to clipboard">📋</button><a class="mm-download" href="#" onclick="return false" title="Download PNG">⬇</a></div><pre class="mermaid">${restored}</pre></div>`);
    // Auto-open in canvas so user can interact with it
    if(!_suppressCanvasAutoOpen) setTimeout(()=>openMindMapCanvas(mindId),150);
    return `%%%BLOCK${blocks.length-1}%%%`;
  });
  // Interactive todo lists
  let _todoBlockIdx=0;
  t=t.replace(/```todolist\n([\s\S]*?)```/g,(_,c)=>{
    const raw=c.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').trim();
    try{
      const items=JSON.parse(raw);
      if(Array.isArray(items)){
        const chatPrefix=curChat||'nochat';
        const listId='tl_'+chatPrefix+'_'+(_todoBlockIdx++);
        // Remove old list with same ID to prevent duplicates
        const oldEl=document.querySelector(`.chat-todo[data-list-id="${listId}"]`);
        if(oldEl)oldEl.remove();
        chatTodoStore.set(listId,items.map((it,i)=>({id:listId+'_'+i,text:it.text||'',done:!!it.done,subtasks:(it.subtasks||[]).map((sub,j)=>({id:listId+'_'+i+'_s'+j,text:sub.text||'',done:!!sub.done}))})));
        syncChatTodosToStorage(listId);
        blocks.push(renderChatTodoList(listId));
        return `%%%BLOCK${blocks.length-1}%%%`;
      }
    }catch(e){}
    blocks.push(`<pre style="background:var(--bg-deep);padding:14px 16px;border-radius:var(--r-sm);overflow-x:auto;font-family:var(--mono);font-size:11.5px;margin:10px 0;border:1px solid var(--border);line-height:1.65"><code>${c}</code></pre>`);
    return `%%%BLOCK${blocks.length-1}%%%`;
  });
  t=t.replace(/```(\w*)\n([\s\S]*?)```/g,(_,l,c)=>{
    const bid=_canvasBlockId++;
    window['_cblk'+bid]=c;
    window['_cblkLang'+bid]=l||'code';
    blocks.push(`<pre style="background:var(--bg-deep);padding:14px 16px;border-radius:var(--r-sm);overflow-x:auto;font-family:var(--mono);font-size:11.5px;margin:10px 0;border:1px solid var(--border);line-height:1.65"><code>${c}</code></pre>`);
    return `%%%BLOCK${blocks.length-1}%%%`;
  });
  // Markdown images: ![alt](url)
  t=t.replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g,(_,alt,url)=>{
    const safeAlt=alt.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
    blocks.push(`<div class="msg-img-wrap"><img src="${url}" alt="${safeAlt}" style="max-width:100%;border-radius:var(--r-md);box-shadow:var(--shadow-sm)" loading="lazy" onerror="this.parentElement.style.display='none'" onclick="openImageLightbox(this.src,this.alt)"><button class="img-expand-btn" onclick="openImageLightbox('${url}','${safeAlt.replace(/'/g,"\\'")}')">⤢</button></div>`);
    return `%%%BLOCK${blocks.length-1}%%%`;
  });
  // Markdown links: [text](url) — supports both absolute and relative URLs
  t=t.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">$1</a>');
  t=t.replace(/\[([^\]]+)\]\((\/api\/[^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">$1</a>');
  // Workspace file links: [text](filename.ext) or [text](path/file.ext) — convert to download URLs
  t=t.replace(/\[([^\]]+)\]\((?!https?:\/\/)(?!\/api\/)(?!#)(?!mailto:)([^)]+\.\w+)\)/g,(_,label,path)=>{
    const dlUrl='/api/files/download?path='+encodeURIComponent(path.replace(/&amp;/g,'&'));
    return `<a href="${dlUrl}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">${label}</a>`;
  });
  // Bare URLs — auto-link any https?:// not already inside an <a> tag
  t=t.replace(/(?<!href=")(?<!src=")(?<!">)(https?:\/\/[^\s<"']+)/g,'<a href="$1" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">$1</a>');
  // Map embeds: <<<MAP: query>>> or <<<MAP: query | label>>>
  t=t.replace(/&lt;&lt;&lt;MAP:\s*(.+?)&gt;&gt;&gt;/g,(_,raw)=>{
    const parts=raw.replace(/&amp;/g,'&').split('|').map(p=>p.trim());
    const query=parts[0];const label=parts[1]||query;
    blocks.push(renderMapEmbed(query,label));
    return `%%%BLOCK${blocks.length-1}%%%`;
  });
  // Flights links: <<<FLIGHTS: query>>>
  t=t.replace(/&lt;&lt;&lt;FLIGHTS:\s*(.+?)&gt;&gt;&gt;/g,(_,raw)=>{
    const query=raw.replace(/&amp;/g,'&').trim();
    blocks.push(renderFlightsLink(query));
    return `%%%BLOCK${blocks.length-1}%%%`;
  });
  // Stock cards: <<<STOCK: TICKER>>> (fallback, shouldn't appear if backend extracted)
  t=t.replace(/&lt;&lt;&lt;STOCK:\s*(.+?)&gt;&gt;&gt;/g,(_,raw)=>{
    const ticker=raw.replace(/&amp;/g,'&').trim();
    blocks.push(renderStockCard(ticker));
    return `%%%BLOCK${blocks.length-1}%%%`;
  });
  // Stock placeholders from server-side extraction: %%%STOCKBLOCK:N%%% — render as loading cards
  t=t.replace(/%%%STOCKBLOCK:(\d+)%%%/g,(_,idx)=>{
    const loaderId=`stock-loader-${idx}`;
    blocks.push(`<div class="stock-card-wrap stock-loading-placeholder" id="${loaderId}" data-stock-index="${idx}"><div class="stock-card"><div class="stock-card-loading"><div class="stock-shimmer"></div><span>Loading stock data...</span></div></div></div>`);
    return `%%%BLOCK${blocks.length-1}%%%`;
  });
  t=t.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  t=t.replace(/`(.+?)`/g,'<code style="background:var(--bg-surface);padding:2px 7px;border-radius:4px;font-family:var(--mono);font-size:11.5px;border:1px solid var(--border)">$1</code>');
  t=t.replace(/\n/g,'<br>');
  blocks.forEach((b,i)=>{t=t.replace(`%%%BLOCK${i}%%%`,b);});
  return t;
}

function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}

let _lbImages=[],_lbIndex=0;
function _collectLightboxImages(){
  _lbImages=[];
  document.querySelectorAll('.img-grid-card[data-img-url], .img-car-card[data-img-url]').forEach(el=>{
    const url=el.getAttribute('data-img-url');
    const title=el.getAttribute('data-img-title')||'';
    if(url)_lbImages.push({url,title});
  });
}
function openImageLightbox(src,alt){
  _collectLightboxImages();
  _lbIndex=_lbImages.findIndex(im=>im.url===src);
  if(_lbIndex<0){_lbImages=[{url:src,title:alt||''}];_lbIndex=0;}
  let lb=document.getElementById('imgLightbox');
  if(!lb){
    lb=document.createElement('div');
    lb.id='imgLightbox';
    lb.className='img-lightbox';
    lb.onclick=e=>{if(e.target===lb)closeImageLightbox()};
    lb.innerHTML=`<div class="img-lb-close" onclick="closeImageLightbox()">\u2715</div>`
      +`<button class="img-lb-nav img-lb-prev" onclick="lbNav(-1)">\u2039</button>`
      +`<img class="img-lb-img">`
      +`<button class="img-lb-nav img-lb-next" onclick="lbNav(1)">\u203a</button>`
      +`<div class="img-lb-actions">`
      +`<button class="img-lb-btn" onclick="lbAskAI()" title="Ask AI about this image">\ud83d\udcac Ask AI</button>`
      +`<span class="img-lb-counter" id="lbCounter"></span>`
      +`</div>`;
    document.body.appendChild(lb);
  }
  _updateLightbox(lb);
  lb.classList.add('open');
  document.body.style.overflow='hidden';
}
function _updateLightbox(lb){
  if(!lb)lb=document.getElementById('imgLightbox');
  if(!lb)return;
  const cur=_lbImages[_lbIndex];
  if(!cur)return;
  lb.querySelector('.img-lb-img').src=cur.url;
  lb.querySelector('.img-lb-img').alt=cur.title;
  const counter=lb.querySelector('#lbCounter');
  if(counter)counter.textContent=_lbImages.length>1?`${_lbIndex+1} / ${_lbImages.length}`:'';
  const prev=lb.querySelector('.img-lb-prev');
  const next=lb.querySelector('.img-lb-next');
  if(prev)prev.style.display=_lbImages.length>1?'':'none';
  if(next)next.style.display=_lbImages.length>1?'':'none';
}
function lbNav(dir){
  _lbIndex=(_lbIndex+dir+_lbImages.length)%_lbImages.length;
  _updateLightbox();
}
function lbAskAI(){
  const cur=_lbImages[_lbIndex];
  if(!cur)return;
  addReplyImage(cur.url,cur.title);
  closeImageLightbox();
  const inp=document.getElementById('msgInput');
  if(inp){inp.focus();}
  showToast('Image added to reply','success');
}
function closeImageLightbox(){
  const lb=document.getElementById('imgLightbox');
  if(lb)lb.classList.remove('open');
  document.body.style.overflow='';
}

/* Text selection reply tooltip */
(function(){
  let _selTooltip=null;
  function getOrCreateTooltip(){
    if(!_selTooltip){
      _selTooltip=document.createElement('div');
      _selTooltip.className='sel-tooltip';
      _selTooltip.innerHTML=`<button class="sel-tooltip-btn" onmousedown="replyToSelection(event)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg> Reply</button>`;
      document.body.appendChild(_selTooltip);
    }
    return _selTooltip;
  }
  document.addEventListener('mouseup',function(e){
    setTimeout(()=>{
      const sel=window.getSelection();
      const text=(sel&&sel.toString()||'').trim();
      const tip=getOrCreateTooltip();
      if(!text||text.length<3){tip.classList.remove('visible');return;}
      // Only show if selection is within a message
      const anchor=sel.anchorNode?.parentElement?.closest?.('.msg');
      if(!anchor){tip.classList.remove('visible');return;}
      const range=sel.getRangeAt(0);
      const rect=range.getBoundingClientRect();
      tip.style.top=(rect.top+window.scrollY-40)+'px';
      tip.style.left=(rect.left+rect.width/2)+'px';
      tip.classList.add('visible');
    },10);
  });
  document.addEventListener('mousedown',function(e){
    if(_selTooltip&&!_selTooltip.contains(e.target)){
      _selTooltip.classList.remove('visible');
    }
  });
})();
function replyToSelection(e){
  e.preventDefault();
  const sel=window.getSelection();
  const text=(sel&&sel.toString()||'').trim();
  if(!text)return;
  const tip=document.querySelector('.sel-tooltip');
  if(tip)tip.classList.remove('visible');
  addReplyText(text);
  const inp=document.getElementById('msgInput');
  if(inp)inp.focus();
  showToast('Text added to reply','success');
  sel.removeAllRanges();
}

function inferMindMapTitle(source,fallbackIndex=1){
  const lines=(source||'').split('\n').map(l=>l.trim()).filter(Boolean);
  for(const line of lines){
    if(/^(mindmap|graph|flowchart|classDiagram|sequenceDiagram|stateDiagram|erDiagram|gantt|journey|pie)\b/i.test(line))continue;
    const cleaned=line
      .replace(/^[\-+*#>\d.\s]+/,'')
      .replace(/:::.+$/,'')
      .replace(/[{}\[\]()]/g,'')
      .replace(/\s+/g,' ')
      .trim();
    if(cleaned.length>=3){
      return `Mind map: ${cleaned.slice(0,56)}`;
    }
  }
  return `Mind map ${fallbackIndex}`;
}

// ─── Settings ─────────────────────────────────────
async function openSettings(){
  document.getElementById('settingsModal').classList.add('open');
  const dark=document.getElementById('themeBtn_dark');
  const light=document.getElementById('themeBtn_light');
  if(dark&&light){
    const activeStyle='background:var(--bg-surface);color:var(--text-primary);border-radius:5px;';
    const inactiveStyle='background:transparent;color:var(--text-muted);';
    dark.style.cssText=(theme==='dark'?activeStyle:inactiveStyle)+'padding:7px 14px;font-size:11px;font-weight:500;border:none;cursor:pointer;transition:all .2s;';
    light.style.cssText=(theme==='light'?activeStyle:inactiveStyle)+'padding:7px 14px;font-size:11px;font-weight:500;border:none;cursor:pointer;transition:all .2s;';
  }
  if(curUser)document.getElementById('profileName').value=curUser.name||'';
  updateLocationToggleUI();
  initDevRawToggle();
}

async function saveKey(p,id){
  const k=document.getElementById(id).value.trim();if(!k)return;
  await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({keys:{[p]:k}})});
  document.getElementById(id).value='';await loadModels();openSettings();
  showToast('API key saved.','success');
}

async function delKey(p){
  await fetch('/api/settings/key',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:p})});
  await loadModels();openSettings();
  showToast('API key removed.','info');
}

async function addEP(){
  const name=await _dlg({title:'Add endpoint',msg:'Enter a label for this endpoint.',icon:'🔌',iconType:'info',inputLabel:'Endpoint name',inputDefault:'',inputPlaceholder:'e.g. OpenRouter',confirmText:'Next',cancelText:'Cancel'});
  if(!name)return;
  const url=await _dlg({title:'Add endpoint',msg:'Enter the base URL for this endpoint.',icon:'🔌',iconType:'info',inputLabel:'Base URL',inputDefault:'',inputPlaceholder:'https://openrouter.ai/api/v1',confirmText:'Next',cancelText:'Cancel'});
  if(!url)return;
  const model=await _dlg({title:'Add endpoint',msg:'Optionally enter a default model name.',icon:'🔌',iconType:'info',inputLabel:'Model name (optional)',inputDefault:'',inputPlaceholder:'e.g. openai/gpt-4o',confirmText:'Add',cancelText:'Skip'});
  const finalModel=model||'';
  const r=await fetch('/api/settings');const s=await r.json();
  const eps=[...(s.custom_endpoints||[]),{name,base_url:url,model:finalModel,provider_type:'openai'}];
  await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({custom_endpoints:eps})});
  await loadModels();openSettings();
  showToast('Endpoint added.','success');
}

async function removeEP(i){
  const r=await fetch('/api/settings');const s=await r.json();
  const eps=s.custom_endpoints||[];eps.splice(i,1);
  await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({custom_endpoints:eps})});
  await loadModels();openSettings();
  showToast('Endpoint removed.','info');
}

async function saveName(){
  const name=document.getElementById('profileName').value.trim();if(!name)return;
  await fetch('/api/auth/name',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
  curUser.name=name;updateUserUI();
  showToast('Profile updated.','success');
}

// ─── Memory ───────────────────────────────────────
async function openMemory(){
  document.getElementById('settingsModal').classList.add('open');
  const r=await fetch('/api/memory');const m=await r.json();
  document.getElementById('memList').innerHTML=(m.facts||[]).map((f,i)=>
    `<div class="mem-item"><span>${esc(f)}</span><button onclick="delMem(${i})">✕</button></div>`
  ).join('')||'<div style="color:var(--text-muted);font-size:11px;padding:8px">No memories yet. Try saying "remember that..." in a chat.</div>';
}

async function addMem(){
  const inp=document.getElementById('memInput');const f=inp.value.trim();if(!f)return;
  await fetch('/api/memory',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fact:f})});
  inp.value='';openMemory();
}

async function delMem(i){await fetch(`/api/memory/${i}`,{method:'DELETE'});openMemory()}

// ─── My Data ──────────────────────────────────────
async function openData(){
  document.getElementById('settingsModal').classList.add('open');
  const r=await fetch('/api/auth/data');const d=await r.json();
  document.getElementById('dataInfo').innerHTML=`<div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">
    <strong style="color:var(--text-primary)">${esc(d.user.name)}</strong> · ${esc(d.user.email)} · ${esc(d.user.provider)} · since ${d.user.created?.split('T')[0]||'?'}</div>`;
  document.getElementById('dataStats').innerHTML=
    `<div class="ds"><span class="num">${d.stats.chats}</span>Chats</div>
     <div class="ds"><span class="num">${d.stats.messages}</span>Messages</div>
     <div class="ds"><span class="num">${d.stats.memory_facts}</span>Memories</div>
     <div class="ds"><span class="num">${d.stats.uploaded_files}</span>Uploads</div>
     <div class="ds"><span class="num">${d.stats.api_keys}</span>API Keys</div>`;
  document.getElementById('dataMemory').innerHTML=(d.memory||[]).map(f=>`<div style="padding:2px 0">• ${esc(f)}</div>`).join('')||'None';
  document.getElementById('dataChats').innerHTML=(d.chats||[]).map(c=>`<div style="padding:2px 0">${esc(c.title)} (${c.messages} msgs)</div>`).join('')||'None';
}

async function resetData(){
  const step1=await _dlg({title:'Delete your account?',msg:'Are you sure? This will permanently delete your account, all your chats, memory, settings, and uploaded files. This cannot be undone.',icon:'🔥',iconType:'danger',confirmText:'Yes, delete my account',cancelText:'Cancel',dangerous:true});
  if(!step1)return;
  const step2=await _dlg({title:'Final confirmation',msg:'Last chance — this will permanently erase everything. There is no way to recover your data.',icon:'🔥',iconType:'danger',confirmText:'Permanently delete',cancelText:'Cancel',dangerous:true});
  if(!step2)return;
  const r=await fetch('/api/auth/data',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});
  const d=await r.json();
  if(d.ok){
    // Clear all local storage
    localStorage.removeItem('gyro_uid');
    localStorage.removeItem('gyro_remember');
    localStorage.removeItem('gyro_guest_id');
    localStorage.removeItem('gyro_theme_override');
    localStorage.removeItem(LAST_SEEN_VERSION_KEY);
    localStorage.removeItem(ONB_SKIP_KEY);
    localStorage.removeItem(ONB_NO_REMIND_KEY);
    localStorage.removeItem(ONB_DISMISS_KEY);
    localStorage.removeItem(HOME_WIDGET_CACHE_KEY);
    localStorage.removeItem(CHAT_CACHE_KEY);
    try{localStorage.removeItem('gyro_productivity');localStorage.removeItem('gyro_productivity_v1');}catch{}
    closeM('settingsModal');
    curChat=null;curUser=null;
    document.getElementById('appPage').classList.remove('visible');
    document.getElementById('loginPage').style.display='flex';
    showToast('Account deleted.','success');
  }else{
    await _dlg({title:'Deletion failed',msg:d.error||'Something went wrong.',icon:'✕',iconType:'danger',confirmText:'OK'});
  }
}

async function deleteAllChats(){
  const count=allChats.length;
  if(!count){showToast('No chats to delete.','info');return;}
  const ok=await _dlg({title:`Delete all ${count} chats?`,msg:`This will permanently delete every chat. Your memory, settings, and account will not be affected.`,icon:'🔥',iconType:'danger',confirmText:`Delete all ${count} chats`,cancelText:'Cancel',dangerous:true});
  if(!ok)return;
  await fetch('/api/chats/delete-all',{method:'POST'});
  curChat=null;
  document.getElementById('topTitle').textContent='gyro';
  document.getElementById('chatArea').innerHTML='';
  await refreshChats();
  loadWelcome(true);
  showToast(`All ${count} chats deleted.`,'success');
}

// ─── Files ────────────────────────────────────────
async function openFiles(){
  document.getElementById('settingsModal').classList.add('open');
  const r=await fetch('/api/files');const d=await r.json();
  document.getElementById('filesList').innerHTML=(d.files||[]).map(f=>
    `<div style="padding:8px 0;border-bottom:1px solid var(--border)"><div style="font-size:12px;color:var(--text-primary);font-weight:500">${esc(f.path)}</div><div style="font-size:10px;color:var(--text-muted);margin-top:2px">${f.size.toLocaleString()} chars</div></div>`
  ).join('')||'<div style="color:var(--text-muted);font-size:11px">No workspace files found.</div>';
}

// ─── File Browser ─────────────────────────────────
function openFileBrowser(){
  document.getElementById('fileBrowser').classList.add('open');
  document.getElementById('fileBrowserOverlay').classList.add('open');
  refreshFileBrowser();
}
function closeFileBrowser(){
  document.getElementById('fileBrowser').classList.remove('open');
  document.getElementById('fileBrowserOverlay').classList.remove('open');
}
function switchFileTab(tab,btn){
  document.querySelectorAll('.fb-tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.fb-panel').forEach(p=>p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById(tab==='chat'?'fbChat':'fbWorkspace').classList.add('active');
  if(tab==='chat')refreshChatFiles();else refreshWorkspaceFiles();
}
async function refreshFileBrowser(){
  refreshWorkspaceFiles();
  refreshChatFiles();
}
async function refreshWorkspaceFiles(){
  const el=document.getElementById('fbWorkspace');
  if(!el)return;
  try{
    const r=await fetch('/api/user-files');
    const d=await r.json();
    const files=d.files||[];
    if(!files.length){el.innerHTML='<div class="fb-empty">No files yet. The AI will create files here as you work.</div>';return;}
    const folders={};
    files.forEach(f=>{const fld=f.folder||'';if(!folders[fld])folders[fld]=[];folders[fld].push(f);});
    let html='';
    const sortedFolders=['',...Object.keys(folders).filter(f=>f).sort()];
    for(const fld of sortedFolders){
      if(!folders[fld])continue;
      if(fld){
        html+=`<div class="fb-folder"><div class="fb-folder-head" onclick="this.parentElement.classList.toggle('collapsed')"><span class="fb-folder-arrow">▾</span><span class="fb-folder-icon" style="color:var(--accent)">▸</span><span class="fb-folder-name">${esc(fld)}</span><span class="fb-folder-count">${folders[fld].length}</span><button class="fb-del" onclick="event.stopPropagation();deleteUserFile('${encodeURIComponent(fld)}',true)" title="Delete folder">✕</button></div><div class="fb-folder-body">`;
      }
      for(const f of folders[fld]){
        const ext=(f.name.split('.').pop()||'').toLowerCase();
        const icon=ext==='md'?'◆':ext==='json'?'◇':ext==='txt'?'▪':ext==='yaml'||ext==='yml'?'▫':'▪';
        html+=`<div class="fb-file" onclick="openWorkspaceFile('${encodeURIComponent(f.path)}')"><span class="fb-file-icon">${icon}</span><span class="fb-file-name">${esc(f.name)}</span><span class="fb-file-size">${formatFileSize(f.size)}</span><button class="fb-del" onclick="event.stopPropagation();deleteUserFile('${encodeURIComponent(f.path)}')" title="Delete">✕</button></div>`;
      }
      if(fld)html+=`</div></div>`;
    }
    el.innerHTML=html;
  }catch{el.innerHTML='<div class="fb-empty">Could not load files.</div>';}
}
function formatFileSize(bytes){
  if(bytes<1024)return bytes+'B';
  if(bytes<1048576)return(bytes/1024).toFixed(1)+'KB';
  return(bytes/1048576).toFixed(1)+'MB';
}
async function refreshChatFiles(){
  const el=document.getElementById('fbChat');
  if(!el)return;
  if(!curChat){el.innerHTML='<div class="fb-empty">Open a chat to see its files.</div>';return;}
  const chat=allChats.find(c=>c.id===curChat);
  // We need full chat data with generated_files
  try{
    const r=await apiFetch(`/api/chats/${curChat}`);
    if(!r.ok){el.innerHTML='<div class="fb-empty">Could not load chat.</div>';return;}
    const data=await r.json();
    const genFiles=data.generated_files||[];
    const uploads=(data.messages||[]).filter(m=>m.file_name).map(m=>({name:m.file_name,when:m.timestamp}));
    let html='';
    if(genFiles.length){
      html+='<div class="fb-section-title">Generated Files</div>';
      for(const f of genFiles){
        const name=f.path.split('/').pop()||f.path;
        html+=`<div class="fb-file" onclick="openWorkspaceFile('${encodeURIComponent(f.path)}')"><span class="fb-file-icon">◆</span><span class="fb-file-name">${esc(name)}</span><span class="fb-file-size">${esc(f.action)}</span></div>`;
      }
    }
    if(uploads.length){
      html+='<div class="fb-section-title">Uploaded Files</div>';
      for(const u of uploads){
        html+=`<div class="fb-file"><span class="fb-file-icon">▪</span><span class="fb-file-name">${esc(u.name)}</span><span class="fb-file-size">${new Date(u.when).toLocaleDateString()}</span></div>`;
      }
    }
    if(!html)html='<div class="fb-empty">No files in this chat yet.</div>';
    el.innerHTML=html;
  }catch{el.innerHTML='<div class="fb-empty">Could not load chat files.</div>';}
}
async function createUserFolder(){
  const name=await _dlg({title:'New folder',msg:'',icon:'▸',iconType:'info',inputLabel:'Folder name',inputDefault:'',inputPlaceholder:'e.g. notes/research, projects/web…',confirmText:'Create',cancelText:'Cancel'});
  if(!name?.trim())return;
  await fetch('/api/user-files/folder',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:name.trim()})});
  refreshWorkspaceFiles();
  showToast('Folder created.','success');
}
async function deleteUserFile(encodedPath,isFolder){
  const path=decodeURIComponent(encodedPath);
  const type=isFolder?'folder and all its contents':'file';
  const ok=await _dlg({title:`Delete ${type}?`,msg:`Are you sure you want to delete "${path}"?`,icon:'▸',iconType:'warn',confirmText:'Delete',cancelText:'Cancel'});
  if(!ok)return;
  await fetch('/api/user-files/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path})});
  refreshWorkspaceFiles();
  showToast('Deleted.','success');
}

async function openWorkspaceFile(encodedPath){
  const path=decodeURIComponent(encodedPath||'');
  if(!path)return;
  const title=path.split('/').pop()||path;
  const ext=(title.split('.').pop()||'').toLowerCase();
  const imgExts=['png','jpg','jpeg','gif','webp','svg','bmp','ico'];
  if(imgExts.includes(ext)){
    // Open image in canvas image viewer
    const imgUrl=`/api/files/view?path=${encodeURIComponent(path)}`;
    const tab={
      id:'tab_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,7),
      title,content:'',isCode:false,sourcePath:path,imageUrl:imgUrl
    };
    const existing=canvasTabs.find(t=>t.sourcePath===path);
    if(existing){existing.imageUrl=imgUrl;activeCanvasTabId=existing.id;switchCanvasTab(existing.id);}
    else{canvasTabs.push(tab);activeCanvasTabId=tab.id;switchCanvasTab(tab.id);}
    closeFileBrowser();
    return;
  }
  try{
    const r=await fetch(`/api/files/content?path=${encodeURIComponent(path)}`);
    const d=await r.json();
    if(d.error){showToast(d.error,'error');return;}
    const codeExts=new Set(['py','js','ts','tsx','jsx','css','html','json','md','yaml','yml','sql','sh','ps1','java','cpp','c','rs','go','php','rb']);
    openCanvas(d.content||'',title,codeExts.has(ext),{openPanel:true,sourcePath:path});
    closeFileBrowser();
  }catch{
    showToast('Could not open file.','error');
  }
}

// ─── Chat Settings Drawer ──────────────────────────
function openChatDrawer(){
  if(!curChat){showToast('Open a chat first.','info');return;}
  document.getElementById('chatDrawer').classList.add('open');
  document.getElementById('chatDrawerOverlay').classList.add('open');
  loadChatDrawer();
}
function closeChatDrawer(){
  document.getElementById('chatDrawer').classList.remove('open');
  document.getElementById('chatDrawerOverlay').classList.remove('open');
}
async function loadChatDrawer(){
  try{
    const r=await apiFetch(`/api/chats/${curChat}`);
    if(!r.ok)return;
    const chat=await r.json();
    document.getElementById('chatInstructions').value=chat.custom_instructions||'';
    // Render pinned files
    const pinnedEl=document.getElementById('pinnedFilesList');
    const pinned=chat.pinned_files||[];
    pinnedEl.innerHTML=pinned.length
      ?pinned.map(p=>{const path=typeof p==='string'?p:p.path;return`<div class="cd-pinned-item"><span>▪ ${esc(path)}</span><button onclick="unpinFile('${encodeURIComponent(path)}')" title="Unpin">✕</button></div>`;}).join('')
      :'<div class="fb-empty">No pinned files.</div>';
    // Populate folder select
    const sel=document.getElementById('chatFolderSelect');
    const foldersR=await fetch('/api/folders');
    const foldersD=await foldersR.json();
    const folders=foldersD.folders||[];
    sel.innerHTML='<option value="">No folder</option>'+folders.map(f=>`<option value="${esc(f)}"${chat.folder===f?' selected':''}>${esc(f)}</option>`).join('');
  }catch{}
}
async function saveChatInstructions(){
  const val=document.getElementById('chatInstructions').value;
  await fetch(`/api/chats/${curChat}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({custom_instructions:val})});
  showToast('Instructions saved.','success');
}
async function openPinFilePicker(){
  try{
    const r=await fetch('/api/user-files');
    const d=await r.json();
    const files=d.files||[];
    if(!files.length){showToast('No files to pin.','info');return;}
    const list=files.map(f=>f.path).join('\n');
    const chosen=await _dlg({title:'Pin a file',msg:'Available: '+files.map(f=>f.path).join(', '),icon:'▸',iconType:'info',inputLabel:'File path',inputDefault:files[0]?.path||'',inputPlaceholder:'e.g. notes/research/topic.md',confirmText:'Pin',cancelText:'Cancel'});
    if(!chosen?.trim())return;
    // Fetch current chat to get existing pins
    const cr=await apiFetch(`/api/chats/${curChat}`);
    const chat=await cr.json();
    const pinned=chat.pinned_files||[];
    const path=chosen.trim();
    if(pinned.some(p=>(typeof p==='string'?p:p.path)===path)){showToast('Already pinned.','info');return;}
    pinned.push(path);
    await fetch(`/api/chats/${curChat}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({pinned_files:pinned})});
    loadChatDrawer();
    showToast('File pinned.','success');
  }catch{showToast('Could not pin file.','error');}
}
async function unpinFile(encodedPath){
  const path=decodeURIComponent(encodedPath);
  const cr=await apiFetch(`/api/chats/${curChat}`);
  const chat=await cr.json();
  const pinned=(chat.pinned_files||[]).filter(p=>(typeof p==='string'?p:p.path)!==path);
  await fetch(`/api/chats/${curChat}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({pinned_files:pinned})});
  loadChatDrawer();
  showToast('File unpinned.','success');
}
async function moveChatToFolder(folder){
  await fetch(`/api/chats/${curChat}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder})});
  await refreshChats();
  showToast(folder?`Moved to ${folder}.`:'Removed from folder.','success');
}
async function createAndMoveFolder(){
  const name=await _dlg({title:'New folder',msg:'',icon:'▸',iconType:'info',inputLabel:'Folder name',inputDefault:'',inputPlaceholder:'e.g. Work, Projects…',confirmText:'Create & Move',cancelText:'Cancel'});
  if(!name?.trim())return;
  await fetch(`/api/chats/${curChat}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder:name.trim()})});
  await refreshChats();
  loadChatDrawer();
  showToast(`Moved to ${name.trim()}.`,'success');
}

// ─── Image Gen ────────────────────────────────────
function openImageGen(){document.getElementById('imageModal').classList.add('open')}

async function genImage(){
  const p=document.getElementById('imgPrompt').value.trim();if(!p)return;
  const el=document.getElementById('imgResult');
  el.innerHTML='<div class="dots" style="justify-content:center;padding:12px"><span></span><span></span><span></span></div>';
  try{
    const r=await fetch('/api/generate-image',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:p})});
    const d=await r.json();
    el.innerHTML=d.image?`<img src="data:image/png;base64,${d.image}" style="max-width:100%;border-radius:var(--r-md);box-shadow:var(--shadow-md)">`:`<div style="color:var(--red);font-size:12px">${esc(d.error||'Failed')}</div>`;
  }catch(e){el.innerHTML=`<div style="color:var(--red);font-size:12px">${esc(e.message)}</div>`}
}

// ─── Modals ───────────────────────────────────────
function closeM(id){document.getElementById(id).classList.remove('open')}

document.addEventListener('DOMContentLoaded',()=>{
  document.querySelectorAll('.ov').forEach(o=>o.addEventListener('click',e=>{
    if(e.target===o&&o.id!=='onboardingModal')o.classList.remove('open');
  }));
});

// ─── Voice (stub) ─────────────────────────────────
function toggleTTS(){}
function speak(){}
function toggleMic(){}
function closeOrb(){}

// ─── Guest Limit (stub) ───────────────────────────
function showGuestLimit(){}
function toggleGuestAuthMode(){}
async function doGuestAuth(){}

// ─── Canvas ───────────────────────────────────────
let canvasIsCode=false;
let canvasSelection=null; // {start,end,text} from user selection in canvas editor
let _suppressCanvasAutoOpen=false; // true during history load to prevent auto-opening

function renderCanvasTabs(){
  const tabsEl=document.getElementById('canvasTabs');
  if(!tabsEl)return;
  tabsEl.innerHTML=canvasTabs.map(t=>`<button class="canvas-tab ${t.id===activeCanvasTabId?'active':''}" onclick="switchCanvasTab('${t.id}')">${esc(t.title||'Document')}</button>`).join('');
}

function detectCanvasLang(title){
  if(!title)return '';
  const ext=(title.match(/\.(\w+)$/)||[])[1];
  if(ext)return ext.toLowerCase();
  return '';
}

function switchCanvasTab(id){
  const tab=canvasTabs.find(t=>t.id===id);
  if(!tab)return;
  activeCanvasTabId=id;
  canvasIsCode=!!tab.isCode;
  const panel=document.getElementById('canvasPanel');
  const editor=document.getElementById('canvasEditor');
  const imgViewer=document.getElementById('canvasImageViewer');
  const langEl=document.getElementById('canvasLang');
  const titleEl=document.getElementById('canvasTitle');
  const runBtn=document.getElementById('canvasRunBtn');
  // Check if this tab is an image
  const lang=detectCanvasLang(tab.title);
  const imgExts=['png','jpg','jpeg','gif','webp','svg','bmp','ico'];
  if(imgExts.includes(lang)&&tab.imageUrl){
    editor.style.display='none';
    if(imgViewer){imgViewer.style.display='flex';document.getElementById('canvasImageEl').src=tab.imageUrl;}
  }else{
    editor.style.display='';
    if(imgViewer)imgViewer.style.display='none';
    editor.value=tab.content||'';
    editor.className=tab.isCode?'canvas-editor code-mode':'canvas-editor';
  }
  langEl.textContent=lang||( tab.isCode?'code':'');
  titleEl.textContent=tab.title||'Document';
  // Show run button for Python and HTML
  const runnable=['py','python','html','htm'].includes(lang);
  runBtn.style.display=runnable?'flex':'none';
  renderCanvasTabs();
  updateCanvasStats();
  closeCanvasOutput();
  panel.classList.add('open');
  document.getElementById('canvasResizer').classList.add('visible');
  if(!imgExts.includes(lang))editor.focus();
  canvasSelection=null;
  editor.oninput=()=>{
    tab.content=editor.value;
    updateCanvasStats();
  };
}

function openCanvas(content,title,isCode,opts={}){
  const options=opts&&typeof opts==='object'?opts:{};
  const sourcePath=options.sourcePath||'';
  const openPanel=options.openPanel!==false;
  let tab=canvasTabs.find(t=>sourcePath&&t.sourcePath===sourcePath);
  if(!tab){
    tab={
      id:'tab_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,7),
      title:title||'Document',
      content:content||'',
      isCode:!!isCode,
      sourcePath,
    };
    canvasTabs.push(tab);
  }else{
    tab.title=title||tab.title;
    tab.content=content||tab.content;
    tab.isCode=!!isCode;
  }
  activeCanvasTabId=tab.id;
  if(openPanel)switchCanvasTab(tab.id);
  else renderCanvasTabs();
}

function closeCanvas(){
  const panel=document.getElementById('canvasPanel');
  const resizer=document.getElementById('canvasResizer');
  panel.classList.remove('open');
  panel.style.width='';
  resizer.classList.remove('visible');
  closeCanvasOutput();
}

/* ─── Canvas File Explorer ──────────────────────── */
function toggleCanvasFiles(){
  const panel=document.getElementById('canvasFilesPanel');
  if(!panel)return;
  const isOpen=panel.classList.toggle('open');
  if(isOpen)refreshCanvasFiles();
}

async function refreshCanvasFiles(){
  const body=document.getElementById('canvasFilesBody');
  if(!body)return;
  try{
    const r=await fetch('/api/user-files');
    const d=await r.json();
    const files=d.files||[];
    if(!files.length){body.innerHTML='<div style="padding:10px;font-size:10px;color:var(--text-muted)">No files yet.</div>';return;}
    const folders={};
    files.forEach(f=>{const fld=f.folder||'';if(!folders[fld])folders[fld]=[];folders[fld].push(f);});
    let html='';
    const sortedFolders=['',...Object.keys(folders).filter(f=>f).sort()];
    for(const fld of sortedFolders){
      if(!folders[fld])continue;
      if(fld) html+=`<div class="cfp-folder-head" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'':'none'">▾ ${esc(fld)}</div><div>`;
      for(const f of folders[fld]){
        const ext=(f.name.split('.').pop()||'').toLowerCase();
        const isImg=['png','jpg','jpeg','gif','webp','svg','bmp','ico'].includes(ext);
        const icon=isImg?'🖼':ext==='md'?'◆':ext==='pdf'?'📄':'▪';
        html+=`<div class="cfp-file" onclick="openWorkspaceFile('${encodeURIComponent(f.path)}')"><span class="cfp-icon">${icon}</span><span class="cfp-name">${esc(f.name)}</span></div>`;
      }
      if(fld) html+='</div>';
    }
    body.innerHTML=html;
  }catch{body.innerHTML='<div style="padding:10px;font-size:10px;color:var(--text-muted)">Error loading files.</div>';}
}

/* ─── Image viewing in canvas ───────────────────── */
function showCanvasImage(url,title){
  const panel=document.getElementById('canvasPanel');
  const editor=document.getElementById('canvasEditor');
  const imgViewer=document.getElementById('canvasImageViewer');
  const imgEl=document.getElementById('canvasImageEl');
  if(!imgViewer||!imgEl)return;
  editor.style.display='none';
  imgViewer.style.display='flex';
  imgEl.src=url;
  imgEl.alt=title||'Image';
  document.getElementById('canvasTitle').textContent=title||'Image';
  document.getElementById('canvasLang').textContent='image';
  panel.classList.add('open');
  document.getElementById('canvasResizer').classList.add('visible');
}

// ─── Canvas drag-to-resize ────────────────────────
(function initCanvasResizer(){
  const resizer=document.getElementById('canvasResizer');
  if(!resizer)return;
  let dragging=false,startX=0,startW=0;
  resizer.addEventListener('mousedown',e=>{
    const panel=document.getElementById('canvasPanel');
    if(!panel.classList.contains('open'))return;
    dragging=true;startX=e.clientX;startW=panel.offsetWidth;
    resizer.classList.add('dragging');
    document.body.style.cursor='col-resize';
    document.body.style.userSelect='none';
    e.preventDefault();
  });
  document.addEventListener('mousemove',e=>{
    if(!dragging)return;
    const panel=document.getElementById('canvasPanel');
    const mainBody=panel.parentElement;
    const diff=startX-e.clientX;
    const newW=Math.min(Math.max(startW+diff,280),mainBody.offsetWidth*0.75);
    panel.style.width=newW+'px';
    panel.style.transition='none';
  });
  document.addEventListener('mouseup',()=>{
    if(!dragging)return;
    dragging=false;
    const panel=document.getElementById('canvasPanel');
    const resizer=document.getElementById('canvasResizer');
    resizer.classList.remove('dragging');
    document.body.style.cursor='';
    document.body.style.userSelect='';
    panel.style.transition='';
  });
  // Touch support
  resizer.addEventListener('touchstart',e=>{
    const panel=document.getElementById('canvasPanel');
    if(!panel.classList.contains('open'))return;
    const t=e.touches[0];
    dragging=true;startX=t.clientX;startW=panel.offsetWidth;
    resizer.classList.add('dragging');
    e.preventDefault();
  },{passive:false});
  document.addEventListener('touchmove',e=>{
    if(!dragging)return;
    const panel=document.getElementById('canvasPanel');
    const mainBody=panel.parentElement;
    const t=e.touches[0];
    const diff=startX-t.clientX;
    const newW=Math.min(Math.max(startW+diff,280),mainBody.offsetWidth*0.75);
    panel.style.width=newW+'px';
    panel.style.transition='none';
  },{passive:false});
  document.addEventListener('touchend',()=>{
    if(!dragging)return;
    dragging=false;
    const panel=document.getElementById('canvasPanel');
    const resizer=document.getElementById('canvasResizer');
    resizer.classList.remove('dragging');
    panel.style.transition='';
  });
})();

// ─── Canvas select-to-edit ────────────────────────
(function initCanvasSelectToEdit(){
  const editor=document.getElementById('canvasEditor');
  if(!editor)return;
  let hintEl=null;
  function ensureHint(){
    if(hintEl)return hintEl;
    hintEl=document.createElement('div');
    hintEl.className='canvas-selection-hint';
    hintEl.textContent='Type in chat to edit selection';
    editor.parentElement.appendChild(hintEl);
    return hintEl;
  }
  editor.addEventListener('mouseup',()=>{
    const s=editor.selectionStart,e=editor.selectionEnd;
    if(s!==e){
      canvasSelection={start:s,end:e,text:editor.value.substring(s,e)};
      const hint=ensureHint();
      hint.classList.add('visible');
      setTimeout(()=>hint.classList.remove('visible'),2500);
    }else{
      canvasSelection=null;
    }
  });
  editor.addEventListener('keyup',()=>{
    const s=editor.selectionStart,e=editor.selectionEnd;
    if(s===e)canvasSelection=null;
  });
})();

function copyCanvas(){
  const text=document.getElementById('canvasEditor').value;
  navigator.clipboard.writeText(text).then(()=>showToast('Copied to clipboard','success'));
}

function downloadCanvas(){
  const text=document.getElementById('canvasEditor').value;
  const rawTitle=document.getElementById('canvasTitle').textContent||'document';
  const hasExt=/\.\w+$/.test(rawTitle);
  const fname=hasExt?rawTitle:(rawTitle.replace(/[^a-zA-Z0-9._-]/g,'_')+(canvasIsCode?'.txt':'.md'));
  const blob=new Blob([text],{type:'text/plain'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download=fname;a.click();
  URL.revokeObjectURL(a.href);
  showToast('Downloaded','success');
}

function updateCanvasStats(){
  const text=document.getElementById('canvasEditor').value;
  const lines=text.split('\n').length;
  const words=text.trim()?text.trim().split(/\s+/).length:0;
  document.getElementById('canvasLines').textContent=lines+' lines';
  document.getElementById('canvasChars').textContent=words+' words · '+text.length+' chars';
}

// ─── Canvas presets ───────────────────────────────
function toggleCanvasPresets(){
  const popup=document.getElementById('canvasPresetsPopup');
  popup.classList.toggle('open');
  if(popup.classList.contains('open')){
    const close=e=>{if(!popup.contains(e.target)&&e.target.id!=='canvasPresetsBtn'){popup.classList.remove('open');document.removeEventListener('click',close);}};
    setTimeout(()=>document.addEventListener('click',close),0);
  }
}

async function canvasPresetEdit(type){
  document.getElementById('canvasPresetsPopup').classList.remove('open');
  const editor=document.getElementById('canvasEditor');
  const content=editor.value;
  if(!content.trim()){showToast('Canvas is empty','info');return;}
  const presetMap={
    shorter:'Make this significantly shorter and more concise while keeping key information.',
    longer:'Expand this with more detail, examples, and explanation.',
    emojis:'Add relevant emojis throughout to make it more expressive and fun.',
    professional:'Rewrite in a professional, polished tone suitable for business communication.',
    casual:'Rewrite in a casual, conversational tone.',
    fix_grammar:'Fix all grammar, spelling, and punctuation errors.',
    simplify:'Simplify the language to make it easier to understand.',
    bullet_points:'Convert this into a well-organized bullet point format.',
    add_comments:'Add helpful code comments explaining what each section does.',
    optimize:'Optimize this code for better performance and cleaner structure.'
  };
  const instruction=presetMap[type]||type;
  const lang=document.getElementById('canvasLang').textContent||'text';
  document.getElementById('canvasStatus').textContent='AI is editing...';
  try{
    const r=await apiFetch('/api/canvas/apply',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({content,instruction,language:lang})});
    const d=await r.json();
    if(d.error){document.getElementById('canvasStatus').textContent='Edit failed';showToast(d.error,'error');return;}
    editor.value=d.content||'';
    const tab=canvasTabs.find(t=>t.id===activeCanvasTabId);
    if(tab)tab.content=editor.value;
    updateCanvasStats();
    document.getElementById('canvasStatus').textContent='Edit applied';
    showToast('Canvas updated','success');
  }catch(e){
    document.getElementById('canvasStatus').textContent='Edit failed';
    showToast('AI edit failed','error');
  }
}

// ─── Canvas run / preview ─────────────────────────
function closeCanvasOutput(){
  const el=document.getElementById('canvasRunOutput');
  if(el)el.style.display='none';
  const body=document.getElementById('canvasRunBody');
  if(body)body.innerHTML='';
}

async function runCanvasCode(){
  const code=document.getElementById('canvasEditor').value;
  if(!code.trim()){showToast('Nothing to run','info');return;}
  const lang=detectCanvasLang(document.getElementById('canvasTitle').textContent||'');
  const outputEl=document.getElementById('canvasRunOutput');
  const bodyEl=document.getElementById('canvasRunBody');
  outputEl.style.display='flex';
  bodyEl.innerHTML='<span style="color:var(--text-muted)">Running...</span>';

  if(['html','htm'].includes(lang)){
    // HTML preview via sandboxed iframe
    const iframe=document.createElement('iframe');
    iframe.sandbox='allow-scripts';
    iframe.style.cssText='width:100%;height:100%;border:none;border-radius:var(--r-sm);background:#fff;min-height:220px';
    bodyEl.innerHTML='';
    bodyEl.appendChild(iframe);
    iframe.srcdoc=code;
    return;
  }

  if(['py','python'].includes(lang)){
    try{
      const r=await apiFetch('/api/canvas/run',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({code,language:'python'})});
      const d=await r.json();
      if(d.error){bodyEl.textContent='Error: '+d.error;return;}
      bodyEl.textContent=d.output||'(no output)';
    }catch(e){
      bodyEl.textContent='Failed to run: '+e.message;
    }
    return;
  }
  bodyEl.textContent='Run not supported for this file type.';
}

// ─── Canvas: get selection context for main chat ──
function getCanvasContext(){
  const panel=document.getElementById('canvasPanel');
  if(!panel||!panel.classList.contains('open'))return null;
  const editor=document.getElementById('canvasEditor');
  const title=document.getElementById('canvasTitle').textContent||'Document';
  const content=editor.value;
  if(!content.trim())return null;
  if(canvasSelection&&canvasSelection.text){
    return {title,fullContent:content,selectedText:canvasSelection.text,selStart:canvasSelection.start,selEnd:canvasSelection.end};
  }
  return {title,fullContent:content,selectedText:null,selStart:null,selEnd:null};
}

function openMindMapCanvas(mindId){
  const item=mindMapStore.get(mindId);
  if(!item)return;
  openCanvas(item.source,(item.title||'mindmap')+'.mmd',true,{openPanel:true});
}

function mermaidSvgToPngDataUrl(svgEl,scale=2){
  return new Promise(resolve=>{
    try{
      // Clone SVG and inline computed styles for accurate rendering
      const clone=svgEl.cloneNode(true);
      const bbox=svgEl.getBBox?svgEl.getBBox():null;
      const vb=svgEl.viewBox?.baseVal;
      const w0=vb?.width||bbox?.width||svgEl.clientWidth||svgEl.getBoundingClientRect().width||900;
      const h0=vb?.height||bbox?.height||svgEl.clientHeight||svgEl.getBoundingClientRect().height||560;
      clone.setAttribute('width',w0);
      clone.setAttribute('height',h0);
      clone.setAttribute('xmlns','http://www.w3.org/2000/svg');
      // Inject stylesheet for fonts
      const styleEl=document.createElementNS('http://www.w3.org/2000/svg','style');
      styleEl.textContent='*{font-family:Inter,Segoe UI,sans-serif}';
      clone.insertBefore(styleEl,clone.firstChild);
      const xml=new XMLSerializer().serializeToString(clone);
      const blob=new Blob([xml],{type:'image/svg+xml;charset=utf-8'});
      const url=URL.createObjectURL(blob);
      const img=new Image();
      img.onload=()=>{
        try{
          const w=Math.max(1,Math.ceil(w0*scale));
          const h=Math.max(1,Math.ceil(h0*scale));
          const canvas=document.createElement('canvas');
          canvas.width=w;canvas.height=h;
          const ctx=canvas.getContext('2d');
          ctx.fillStyle=getComputedStyle(document.body).getPropertyValue('--bg-deep')||'#121014';
          ctx.fillRect(0,0,w,h);
          ctx.drawImage(img,0,0,w,h);
          const dataUrl=canvas.toDataURL('image/png');
          URL.revokeObjectURL(url);
          resolve(dataUrl);
        }catch{
          URL.revokeObjectURL(url);
          resolve('');
        }
      };
      img.onerror=()=>{URL.revokeObjectURL(url);resolve('');};
      img.src=url;
    }catch{
      resolve('');
    }
  });
}

async function copyMermaidPng(btn){
  const container=btn.closest('.mermaid-container');
  if(!container)return;
  const img=container.querySelector('img.mermaid-png');
  const svg=container.querySelector('svg');
  try{
    let blob;
    if(img&&img.src&&img.src.startsWith('data:')){
      const resp=await fetch(img.src);
      blob=await resp.blob();
    }else if(svg){
      const dataUrl=await mermaidSvgToPngDataUrl(svg,2);
      if(!dataUrl){showToast('Failed to copy image.','error');return;}
      const resp=await fetch(dataUrl);
      blob=await resp.blob();
    }else{
      showToast('No image to copy.','error');return;
    }
    await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
    const orig=btn.textContent;
    btn.textContent='✓';
    setTimeout(()=>{btn.textContent=orig;},1500);
    showToast('Copied to clipboard!','success');
  }catch(e){
    showToast('Copy failed — try downloading instead.','error');
  }
}

async function enhanceMermaidDiagrams(){
  const containers=[...document.querySelectorAll('.mermaid-container')];
  for(const container of containers){
    // Check for mermaid parse errors and try to recover
    const errEl=container.querySelector('[id*="mermaid-error"],.error-icon,.error-text,p');
    const svg=container.querySelector('svg');
    if(!svg&&!container.dataset.recovered){
      // Mermaid failed to render — try re-rendering with aggressive sanitization
      container.dataset.recovered='1';
      const pre=container.querySelector('pre.mermaid');
      if(pre){
        const mindId=container.getAttribute('data-mindmap-id')||'';
        const mm=mindMapStore.get(mindId);
        if(mm?.source){
          let src=mm.source;
          // Aggressive cleanup: replace all special chars in non-keyword lines
          const lines=src.split('\n');
          const cleanLines=lines.map(l=>{
            if(/^\s*(mindmap|graph|flowchart|classDiagram|sequenceDiagram|stateDiagram|erDiagram|gantt|journey|pie)\b/i.test(l.trim()))return l;
            if(/^\s*$/.test(l))return l;
            // Keep indentation, strip all non-alpha from text
            const indent=l.match(/^(\s*)/)[1];
            let text=l.slice(indent.length);
            text=text.replace(/[^a-zA-Z0-9\s\-_.,&]/g,' ').replace(/\s+/g,' ').trim();
            return indent+text;
          });
          const cleanSrc=cleanLines.join('\n');
          try{
            const id='mm_retry_'+Date.now().toString(36);
            const{svg:svgStr}=await mermaid.render(id,cleanSrc);
            pre.innerHTML=svgStr;
            pre.classList.remove('mermaid');
            mm.source=cleanSrc;
          }catch(e2){
            // Still failed — show source as text fallback
            pre.innerHTML='<div style="padding:16px;font-size:12px;color:var(--text-muted);white-space:pre-wrap;font-family:var(--mono)">'+mm.source.replace(/</g,'&lt;')+'</div>';
            pre.classList.remove('mermaid');
          }
          continue;
        }
      }
    }
    if(!svg)continue;
    const mindId=container.getAttribute('data-mindmap-id')||'';
    const mm=mindMapStore.get(mindId);
    const png=await mermaidSvgToPngDataUrl(svg,2);
    if(!png)continue;
    let img=container.querySelector('img.mermaid-png');
    if(!img){
      img=document.createElement('img');
      img.className='mermaid-png';
      img.alt=(mm?.title||'Mind map');
      img.loading='lazy';
      if(mindId){
        img.style.cursor='pointer';
        img.onclick=()=>openMindMapCanvas(mindId);
      }
      container.appendChild(img);
    }
    img.src=png;
    svg.style.display='none';
    const dl=container.querySelector('.mm-download');
    if(dl){
      const fn=((mm?.title||'mind_map').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'')||'mind_map')+'.png';
      dl.removeAttribute('href');
      dl.onclick=(e)=>{
        e.preventDefault();
        const a=document.createElement('a');
        a.href=png;a.download=fn;
        document.body.appendChild(a);a.click();document.body.removeChild(a);
      };
    }
  }
}

const PRODUCTIVITY_KEY='gyro_productivity_v1';

function loadProductivityState(){
  try{
    const raw=localStorage.getItem(PRODUCTIVITY_KEY);
    if(!raw)return {todos:[],visions:[]};
    const parsed=JSON.parse(raw);
    return {
      todos:Array.isArray(parsed.todos)?parsed.todos:[],
      visions:Array.isArray(parsed.visions)?parsed.visions:[],
    };
  }catch{
    return {todos:[],visions:[]};
  }
}

function saveProductivityState(state){
  localStorage.setItem(PRODUCTIVITY_KEY,JSON.stringify(state));
}

function openProductivityHub(){
  const modal=document.getElementById('productivityModal');
  if(!modal)return;
  modal.classList.add('open');
  renderProductivityHub();
}

function renderProductivityHub(){
  const state=loadProductivityState();
  const todoList=document.getElementById('todoList');
  const visionList=document.getElementById('visionList');
  if(todoList){
    todoList.innerHTML=state.todos.length
      ?state.todos.map(t=>`<div class="todo-item ${t.done?'done':''}"><button class="todo-check" onclick="toggleTodoItem('${t.id}')">${t.done?'✓':'○'}</button><div class="todo-text">${esc(t.text)}</div><button class="todo-del" onclick="deleteTodoItem('${t.id}')">✕</button></div>`).join('')
      :'<div class="todo-empty">No tasks yet. Add one to get moving.</div>';
  }
  if(visionList){
    visionList.innerHTML=state.visions.length
      ?state.visions.map(v=>`<div class="vision-item"><div class="vision-main"><div class="vision-title">${esc(v.title)}</div><div class="vision-meta">${esc(v.when||'No target date')}</div></div><div class="vision-actions"><button onclick="insertVisionPrompt('${v.id}')">Use</button><button onclick="deleteVisionItem('${v.id}')">✕</button></div></div>`).join('')
      :'<div class="todo-empty">No vision cards yet. Add your next milestone.</div>';
  }
}

function addTodoItem(){
  const input=document.getElementById('todoInput');
  const text=(input?.value||'').trim();
  if(!text)return;
  const state=loadProductivityState();
  state.todos.unshift({id:'t_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6),text,done:false});
  saveProductivityState(state);
  input.value='';
  renderProductivityHub();
  refreshHomeWidgets();
}

function toggleTodoItem(id){
  const state=loadProductivityState();
  const item=state.todos.find(t=>t.id===id);
  if(!item)return;
  item.done=!item.done;
  saveProductivityState(state);
  renderProductivityHub();
  refreshHomeWidgets();
}

function deleteTodoItem(id){
  const state=loadProductivityState();
  state.todos=state.todos.filter(t=>t.id!==id);
  saveProductivityState(state);
  renderProductivityHub();
  refreshHomeWidgets();
}

function toggleHomeTodo(id){
  const state=loadProductivityState();
  const item=state.todos.find(t=>t.id===id);
  if(!item)return;
  item.done=!item.done;
  saveProductivityState(state);
  refreshHomeWidgets();
}

function deleteHomeTodo(id){
  const state=loadProductivityState();
  state.todos=state.todos.filter(t=>t.id!==id);
  saveProductivityState(state);
  refreshHomeWidgets();
}

function refreshHomeWidgets(){
  if(!curChat)loadWelcome(true);
}

function handleNudgeAction(btn){
  const item=btn.closest('.wl-nudge-item');
  if(!item)return;
  try{
    const action=JSON.parse(item.dataset.nudgeAction||'{}');
    if(action.type==='open_chat'&&action.chat_id){
      openChat(action.chat_id);
    }else if(action.type==='prompt'&&action.text){
      fillMasterPrompt(action.text);
    }
  }catch{}
}

function _detectClientFriction(){
  const nudges=[];
  const now=Date.now();
  // Stale chats: updated > 3 days ago with real messages
  for(const c of (allChats||[])){
    const updated=c.updated||c.created||'';
    const msgCount=c.message_count||0;
    if(!updated||msgCount<2)continue;
    try{
      const days=Math.floor((now-new Date(updated).getTime())/(86400000));
      if(days>=3){
        nudges.push({
          category:'stale_chat',
          message:`"${c.title||'Untitled'}" — untouched for ${days} day${days!==1?'s':''}`,
          next_step:'Review where you left off and decide: continue, archive, or close it out.',
          action:{type:'open_chat',chat_id:c.id||''},
        });
      }
    }catch{}
  }
  nudges.sort((a,b)=>{
    const da=parseInt((a.message.match(/(\d+)\s*day/)||[])[1]||'0');
    const db=parseInt((b.message.match(/(\d+)\s*day/)||[])[1]||'0');
    return db-da;
  });
  const stale=nudges.slice(0,2);
  // Task overload
  const state=loadProductivityState();
  const todos=state.todos||[];
  const pending=todos.filter(t=>!t.done);
  if(pending.length>=6){
    stale.push({
      category:'task_overload',
      message:`${pending.length} open tasks — time to triage`,
      next_step:'Pick the 1-2 that actually move the needle today and defer the rest.',
      action:{type:'prompt',text:'Help me triage my open tasks and pick the top priorities for today'},
    });
  }
  // Scope creep: many tasks, very few completed
  const doneCount=todos.filter(t=>t.done).length;
  if(todos.length>=8&&doneCount<todos.length*0.2){
    stale.push({
      category:'scope_creep',
      message:`Only ${doneCount}/${todos.length} tasks completed — adding faster than finishing`,
      next_step:'Consider trimming low-value tasks or breaking big ones into smaller wins.',
      action:{type:'prompt',text:'Help me identify which tasks I can cut or defer — I\'m adding faster than finishing'},
    });
  }
  return stale.slice(0,5);
}

function addVisionItem(){
  const titleEl=document.getElementById('visionTitle');
  const whenEl=document.getElementById('visionWhen');
  const title=(titleEl?.value||'').trim();
  if(!title)return;
  const state=loadProductivityState();
  state.visions.unshift({id:'v_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6),title,when:(whenEl?.value||'').trim()});
  saveProductivityState(state);
  titleEl.value='';
  if(whenEl)whenEl.value='';
  renderProductivityHub();
}

function deleteVisionItem(id){
  const state=loadProductivityState();
  state.visions=state.visions.filter(v=>v.id!==id);
  saveProductivityState(state);
  renderProductivityHub();
}

function insertVisionPrompt(id){
  const state=loadProductivityState();
  const card=state.visions.find(v=>v.id===id);
  if(!card)return;
  closeM('productivityModal');
  setDraft(`Help me create a concrete weekly execution plan for this vision: ${card.title}${card.when?` (target: ${card.when})`:''}`);
}

function insertProductivityPrompt(kind){
  closeM('productivityModal');
  const prompts={
    day:'Create my highest-impact plan for today with 3 priority tasks and time blocks.',
    week:'Build me a realistic weekly plan with milestones, focus sessions, and review checkpoints.',
    focus:'Set up a focused 50-minute sprint plan with a clear objective and done criteria.'
  };
  setDraft(prompts[kind]||prompts.day);
}

// ─── Mermaid ──────────────────────────────────────
function initMermaidTheme(){
  if(!window.mermaid)return;
  const light=theme==='light';
  mermaid.initialize({
    startOnLoad:false,
    theme:'base',
    flowchart:{curve:'basis',htmlLabels:true,nodeSpacing:80,rankSpacing:90,padding:28,diagramPadding:20},
    mindmap:{padding:32,maxNodeWidth:260},
    themeVariables:light?{
      primaryColor:'#fdf6ef',
      primaryTextColor:'#1a1410',
      primaryBorderColor:'#d4a574',
      lineColor:'#c9956a',
      secondaryColor:'#f0e1d0',
      tertiaryColor:'#e8d5c0',
      fontSize:'14px',
      fontFamily:'Inter, Segoe UI, sans-serif',
      nodeBorder:'#d4a574',
      mainBkg:'#fdf6ef',
      clusterBkg:'#f5e8da',
      edgeLabelBackground:'#f3e7d8',
    }:{
      primaryColor:'#1e1b24',
      primaryTextColor:'#f0e8df',
      primaryBorderColor:'#c97b42',
      lineColor:'#9a7a5e',
      secondaryColor:'#252130',
      tertiaryColor:'#2a1f16',
      fontSize:'14px',
      fontFamily:'Inter, Segoe UI, sans-serif',
      nodeBorder:'#8a6d50',
      mainBkg:'#1a1722',
      clusterBkg:'#16131e',
      edgeLabelBackground:'#1a1722',
      nodeTextColor:'#f0e8df',
    }
  });
}

document.addEventListener('DOMContentLoaded',()=>{initMermaidTheme();});
document.addEventListener('DOMContentLoaded',()=>{renderProductivityHub();});

// ─── Keep-alive ping to prevent Render from sleeping while user is active ───
(function(){
  const PING_INTERVAL=4*60*1000; // every 4 minutes
  let pingTimer=null;
  function startPing(){
    if(pingTimer)return;
    pingTimer=setInterval(()=>{
      fetch('/api/ping').catch(()=>{});
    },PING_INTERVAL);
  }
  function stopPing(){
    if(pingTimer){clearInterval(pingTimer);pingTimer=null;}
  }
  // Ping while tab is visible
  startPing();
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden) stopPing();
    else startPing();
  });
})();