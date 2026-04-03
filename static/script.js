// --- State ----------------------------------------
let curChat=null,allChats=[],ttsOn=false,recording=false,recognition=null,pendingFiles=[],pendingFolder='';
let pendingReplies=[];  // reply context: [{type:'image',url,title},{type:'text',text}]
let _uploadsInFlight=0,_pendingSendOpts=null;
let _codeRepromptCount=0;const _MAX_CODE_REPROMPTS=3;
let _nextStreamId=0;
let curUser=null,isGuest=false,authMode='login',theme='dark',googleClientId='';
let googleInitDone=false,thinkingLevel='off',guestAuthMode='register';

function renderMathInElementSafe(root){
  if(!root||typeof renderMathInElement!=='function')return;
  try{
    // Skip KaTeX inside code execution blocks to keep output raw
    root.querySelectorAll('.code-run-block').forEach(el=>{el.dataset.katexSkip='1';});
    renderMathInElement(root,{
      delimiters:[
        {left:'$$',right:'$$',display:true},
        {left:'$',right:'$',display:false},
        {left:'\\(',right:'\\)',display:false},
        {left:'\\[',right:'\\]',display:true}
      ],
      throwOnError:false,
      ignoredTags:['script','noscript','style','textarea','pre','code','annotation','annotation-xml']
    });
  }catch(e){
    console.debug('KaTeX render skipped:',e?.message||e);
  }
}
let deepResearchDepth='standard';
let onboardingChecked=false;
let selectMode=false;
const selectedItems=new Set();
const _collapsedFolders=new Set();
const runningStreams=new Map();
const _activeStreamState=new Map(); // chatId => {fullText, thinkText} for persist-on-unload
window.addEventListener('beforeunload',()=>{
  for(const [chatId,state] of _activeStreamState){
    const text=state.fullText;
    if(!text)continue;
    try{navigator.sendBeacon(`/api/chats/${chatId}/partial`,new Blob([JSON.stringify({text,final:true})],{type:'application/json'}));}catch(e){}
  }
});
const _pendingReprompts=new Map(); // chatId => [timeoutId, ...] — cleared on stop/edit
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

// --- Location -------------------------------------
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
  const btnMic=document.getElementById('btnMic');
  if(btnSend)btnSend.style.display=busy?'none':'';
  if(btnStop)btnStop.style.display=busy?'':'none';
  if(btnMic)btnMic.style.display=busy?'none':'';
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
  if(run?.controller){
    run.controller.abort();
  }
  // Cancel ALL pending auto-reprompts for this chat
  const pending=_pendingReprompts.get(curChat);
  if(pending){pending.forEach(id=>clearTimeout(id));_pendingReprompts.delete(curChat);}
  // Force-clear running state immediately so UI updates even if abort is slow
  setChatRunning(curChat,false);
  setStatus('Generation cancelled.');
}

function editMsg(btn){
  const msgEl=btn.closest('.msg');
  if(window._activeEdit)return; // already editing
  const originalText=msgEl.dataset.text||'';

  // Extract existing file data from the message's image previews so we can preserve them
  const _editFiles=[];
  const filesEl=msgEl.querySelector('.msg-user-files');
  if(filesEl){
    filesEl.querySelectorAll('.user-file-preview').forEach(fp=>{
      const img=fp.querySelector('img');
      if(img&&img.src&&img.src.startsWith('data:')){
        const m=img.src.match(/^data:([^;]+);base64,(.+)$/);
        if(m){_editFiles.push({name:img.alt||'image',mime:m[1],data:m[2],text:'',doc_data:''});}
      }else{
        const span=fp.querySelector('span');
        if(span){_editFiles.push({name:span.textContent||'file',mime:'application/octet-stream',data:'',text:'',doc_data:''});}
      }
    });
  }

  const area=document.getElementById('chatArea');
  const allMsgs=[...area.querySelectorAll('.msg')];

  // Count backend index for truncation
  let backendIndex=0;
  for(let i=0;i<allMsgs.length;i++){
    if(allMsgs[i]===msgEl)break;
    if(!allMsgs[i].classList.contains('thinking'))backendIndex++;
  }

  // Stop any running stream first
  if(curChat&&isChatRunning(curChat)){
    stopStreaming();
  }

  // Store active edit state
  window._activeEdit={
    msgEl,
    backendIndex,
    files:_editFiles
  };

  // Add files from original message to pendingFiles
  const readyFiles=_editFiles.filter(f=>!f._loading);
  if(readyFiles.length){
    pendingFiles.push(...readyFiles);
    renderPF();
  }

  // Populate the main prompt bar with the message text
  const input=document.getElementById('msgInput');
  input.value=originalText;
  autoResize(input);
  input.focus();

  // Show the editing banner above the input
  _showEditBanner();
}

function _showEditBanner(){
  let banner=document.getElementById('editBanner');
  if(banner)return;
  banner=document.createElement('div');
  banner.id='editBanner';
  banner.className='edit-banner';
  banner.innerHTML='<span class="edit-banner-text">✎ Editing message</span><button class="edit-banner-cancel" onclick="_cancelEdit()">Cancel</button>';
  const inputArea=document.querySelector('.input-area');
  inputArea.insertBefore(banner,inputArea.firstChild);
}

function _cancelEdit(){
  if(!window._activeEdit)return;
  // Clear the input
  const input=document.getElementById('msgInput');
  input.value='';
  autoResize(input);
  // Remove any files that were pushed from the edit
  if(window._activeEdit.files?.length){
    for(const ef of window._activeEdit.files){
      const idx=pendingFiles.findIndex(f=>f.name===ef.name&&f.mime===ef.mime);
      if(idx>=0)pendingFiles.splice(idx,1);
    }
    renderPF();
  }
  // Remove banner
  const banner=document.getElementById('editBanner');
  if(banner)banner.remove();
  delete window._activeEdit;
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

function copyMsg(btn){
  const msgEl=btn.closest('.msg');
  if(!msgEl)return;
  const content=msgEl.querySelector('.msg-content')||msgEl;
  const clone=content.cloneNode(true);
  clone.querySelectorAll('.msg-actions').forEach(el=>el.remove());
  const text=clone.innerText||clone.textContent||'';
  // Try rich copy (HTML with images) if images exist
  const imgs=content.querySelectorAll('img[src]');
  if(imgs.length&&navigator.clipboard.write){
    const htmlClone=content.cloneNode(true);
    htmlClone.querySelectorAll('.msg-actions').forEach(el=>el.remove());
    const html=htmlClone.innerHTML;
    const items=[new ClipboardItem({
      'text/html':new Blob([html],{type:'text/html'}),
      'text/plain':new Blob([text.trim()],{type:'text/plain'})
    })];
    navigator.clipboard.write(items).then(()=>{
      btn.textContent='✓ Copied';
      setTimeout(()=>{btn.textContent='Copy'},1500);
    }).catch(()=>{
      navigator.clipboard.writeText(text.trim()).then(()=>{
        btn.textContent='✓ Copied';
        setTimeout(()=>{btn.textContent='Copy'},1500);
      }).catch(()=>{});
    });
  }else{
    navigator.clipboard.writeText(text.trim()).then(()=>{
      btn.textContent='✓ Copied';
      setTimeout(()=>{btn.textContent='Copy'},1500);
    }).catch(()=>{});
  }
}

// --- Auto Resume ----------------------------------
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

// --- Session keep-alive ---------------------------
async function _handleSessionLost(){
  showToast('Session expired. Please sign in again.','info');
  curUser=null; curChat=null;
  document.getElementById('appPage').classList.remove('visible');
  document.getElementById('loginPage').style.display='flex';
  googleInitDone=false;
  await ensureOAuthConfigLoaded();
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
  // Don't interrupt active streams with session checks
  if(runningStreams.size>0) return;
  try{
    const r=await fetch('/api/auth/me');
    const d=await r.json();
    if(!d.authenticated && !d.guest){
      const ok=await tryAutoResume();
      if(!ok) _handleSessionLost();
    }
  }catch{}
});

// --- Init -----------------------------------------
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
  if(btn)btn.textContent=theme==='light'?'🌙':'☀️';
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

/* --- Dev Raw Log Mode ---------------------------- */
let devRawMode=localStorage.getItem('gyro_dev_raw')==='1';
let devButtonVisible=localStorage.getItem('gyro_dev_visible')==='1'||devRawMode;
function toggleDevRaw(on){
  devRawMode=!!on;
  localStorage.setItem('gyro_dev_raw',on?'1':'0');
  // Keep button visible once it's been turned on — user must disable from settings
  if(on&&!devButtonVisible){devButtonVisible=true;localStorage.setItem('gyro_dev_visible','1');}
  const dot=document.getElementById('devRawDot');
  if(dot)dot.style.transform=on?'translateX(18px)':'none';
  if(dot)dot.style.background=on?'var(--accent)':'var(--text-muted)';
  // Update topbar indicator — keep visible but dim when off
  const topDev=document.getElementById('devModeIndicator');
  if(topDev&&devButtonVisible){
    topDev.style.display='';
    topDev.style.opacity=on?'1':'.4';
    topDev.style.color=on?'var(--accent)':'var(--text-muted)';
  }
  // Live re-render: re-render current chat to apply new mode (skip during active streaming)
  if(curChat&&!isChatRunning(curChat)){
    reRenderCurrentChat();
  }else if(!curChat){
    loadWelcome(true);
  }
}
function hideDevButton(){
  devButtonVisible=false;devRawMode=false;
  localStorage.setItem('gyro_dev_visible','0');
  localStorage.setItem('gyro_dev_raw','0');
  const topDev=document.getElementById('devModeIndicator');
  if(topDev)topDev.style.display='none';
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

/* --- School Mode (dev tier only) --- */
let schoolMode=localStorage.getItem('gyro_school_mode')==='1';
function applySchoolMode(){
  document.body.classList.toggle('school-mode',schoolMode);
}
function toggleSchoolMode(on){
  schoolMode=!!on;
  localStorage.setItem('gyro_school_mode',on?'1':'0');
  applySchoolMode();
  const dot=document.getElementById('schoolModeDot');
  if(dot){
    dot.style.transform=on?'translateX(18px)':'none';
    dot.style.background=on?'var(--accent)':'var(--text-muted)';
  }
  const ind=document.getElementById('schoolModeIndicator');
  if(ind)ind.style.display=on?'':'none';
}
function initSchoolModeToggle(){
  const section=document.getElementById('schoolModeSection');
  if(!section)return;
  // Only show for dev tier users
  const isDev=curUser&&curUser.plan==='dev';
  section.style.display=isDev?'block':'none';
  if(!isDev)return;
  const cb=document.getElementById('schoolModeToggle');
  if(cb)cb.checked=schoolMode;
  const dot=document.getElementById('schoolModeDot');
  if(dot){
    dot.style.transform=schoolMode?'translateX(18px)':'none';
    dot.style.background=schoolMode?'var(--accent)':'var(--text-muted)';
  }
}
// Apply school mode immediately on load if saved
if(schoolMode)document.body.classList.add('school-mode');

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
        try{
          const mermaidEls=area.querySelectorAll('pre.mermaid:not([data-processed])');
          if(mermaidEls.length){
            mermaid.run({nodes:mermaidEls}).then(()=>enhanceMermaidDiagrams()).catch(()=>enhanceMermaidDiagrams());
          }
        }catch(e){
          console.log('Mermaid re-render:',e);
          enhanceMermaidDiagrams();
        }
      },200);
    }else{
      _suppressCanvasAutoOpen=false;
    }
  }catch(e){console.log('Re-render error:',e);}
}

// --- Custom Dialog Engine ------------------------
let _dlgResolve=null;
function _dlg({title,msg,icon,iconType='info',confirmText='OK',cancelText=null,inputLabel=null,inputDefault='',inputPlaceholder='',dangerous=false}){
  return new Promise(resolve=>{
    _dlgResolve=resolve;
    document.getElementById('dlgTitle').textContent=title||'';
    document.getElementById('dlgMsg').textContent=msg||'';
    document.getElementById('dlgIconEmoji').textContent=icon||'📁';
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
  // -- Global scroll-to-bottom button --
  const _chatArea=document.getElementById('chatArea');
  const _scrollBtn=document.getElementById('scrollToBottom');
  if(_chatArea&&_scrollBtn){
    _chatArea.addEventListener('scroll',()=>{
      const dist=_chatArea.scrollHeight-_chatArea.scrollTop-_chatArea.clientHeight;
      if(dist>300)_scrollBtn.classList.add('visible');
      else _scrollBtn.classList.remove('visible');
    },{passive:true});
  }
});

function showToast(message,type='info'){
  // Disabled — notifications removed
  return;
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
  applySchoolMode();
  // Show school mode indicator if active
  const schInd=document.getElementById('schoolModeIndicator');
  if(schInd)schInd.style.display=schoolMode?'':'none';
  // Initialize dev mode indicator in topbar
  const topDev=document.getElementById('devModeIndicator');
  if(topDev){
    topDev.style.display=devButtonVisible?'':'none';
    topDev.style.opacity=devRawMode?'1':'.4';
    topDev.style.color=devRawMode?'var(--accent)':'var(--text-muted)';
  }
  if(!curChat){ loadWelcome(); }
  await ensureOAuthConfigLoaded();
  await loadModels();
  await refreshChats();
  updateComposerBusyUI();
  document.getElementById('msgInput').focus();
  checkForUpdates();
  ensureOnboarding();
  // Show HF tool in + menu if connected
  try{const cr=await fetch('/api/connectors');if(cr.ok){const cd=await cr.json();const hf=cd.connectors?.huggingface||{};const hfTool=document.getElementById('hfToolItem');if(hfTool)hfTool.style.display=(hf.enabled&&hf.token)?'':'none';}}catch{}
}

// --- Changelog / Update Notification --------------
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
    {icon:'📋',label:'Plan my day',q:'Help me organize and prioritize everything on my plate today. Ask me 2 quick clarifying questions before building the plan.'},
    {icon:'✏️',label:'Help me write',q:'Help me write or polish something. Start by asking what audience, tone, and outcome I want.'},
    {icon:'💡',label:'Brainstorm',q:'Brainstorm ideas with me for a project or problem. Push for novel options, then rank the top 3.'},
    {icon:'🔬',label:'Research & analyze',q:'Help me research this topic deeply. Outline the scope first, then suggest a strong investigation path.'}
  ];
}

function buildMasterPromptCards(){
  return getMasterPrompts().map(a=>`<div class="wl-action-card" onclick="fillMasterPrompt('${a.q.replace(/'/g,"\\'")}')"><span class="wl-ac-icon">${a.icon}</span><span class="wl-ac-label">${a.label}</span><span class="wl-ac-sub">Editable master prompt</span></div>`).join('');
}

function hasWidgetContent(w){
  const type=(w?.type||'focus').toLowerCase();
  if(type==='recent'||type==='todos'||type==='nudge'||type==='workflow'||type==='reminders')return Array.isArray(w.items)&&w.items.length>0;
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
      // Only link to chat for chat-derived tasks (tl_CHATID_listIdx_itemIdx)
      const isChatTask=(i.id||'').startsWith('tl_');
      const chatId=isChatTask?(i.id||'').split('_')[1]||'':'';
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
    const catIcons={'stale_chat':'⚡','task_overload':'📋','scope_creep':'📈','stalled_project':'🔄','deadline_soon':'🧭','resource_spread':'⏰','status_friction':'?','no_focus':'🎯'};
    const body=items.map(i=>{
      const icon=catIcons[i.category]||'📄';
      const actionAttr=i.action?`data-nudge-action="${esc(JSON.stringify(i.action)).replace(/"/g,'&quot;')}"`:'';;
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
      const actionAttr=i.action?`data-nudge-action="${esc(JSON.stringify(i.action)).replace(/"/g,'&quot;')}"`:'';;
      return `<div class="wl-nudge-item" ${actionAttr}>`
        +`<span class="wl-nudge-icon">🎨</span>`
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
  if(type==='reminders'){
    const items=Array.isArray(w.items)?w.items:[];
    if(!items.length)return'';
    const now=new Date();
    const body=items.map(i=>{
      let isOverdue=false;
      let dueLabel='';
      if(i.due){
        try{
          const d=new Date(i.due);
          isOverdue=d<=now;
          const diff=d-now;
          if(isOverdue){
            const mins=Math.floor(Math.abs(diff)/60000);
            if(mins<60)dueLabel=`${mins}m overdue`;
            else if(mins<1440)dueLabel=`${Math.floor(mins/60)}h overdue`;
            else dueLabel=`${Math.floor(mins/1440)}d overdue`;
          }else{
            const mins=Math.floor(diff/60000);
            if(mins<60)dueLabel=`in ${mins}m`;
            else if(mins<1440)dueLabel=`in ${Math.floor(mins/60)}h`;
            else dueLabel=`in ${Math.floor(mins/1440)}d`;
          }
        }catch{}
      }
      const overdueClass=isOverdue?'wl-reminder-overdue':'';
      return `<div class="wl-reminder-item ${overdueClass}" data-reminder-id="${esc(i.id||'')}">`
        +`<button class="wl-reminder-check" onclick="event.stopPropagation();completeReminder('${esc(i.id||'')}')">✕</button>`
        +`<div class="wl-reminder-body">`
        +`<div class="wl-reminder-text">${esc(i.text||'')}</div>`
        +(dueLabel?`<div class="wl-reminder-due ${overdueClass}">${isOverdue?'? ':''}${esc(dueLabel)}</div>`:'')
        +`</div>`
        +`<div class="wl-reminder-actions">`
        +`<button class="wl-reminder-snooze" onclick="event.stopPropagation();snoozeReminder('${esc(i.id||'')}')" title="Snooze 24h">✕</button>`
        +`<button class="wl-reminder-del" onclick="event.stopPropagation();deleteReminder('${esc(i.id||'')}')" title="Delete">✕</button>`
        +`</div>`
        +`</div>`;
    }).join('');
    return `<div class="${cls} wl-reminder-widget"><div class="wl-widget-hd">${title}</div>${subtitle}<div class="wl-reminder-list">${body}</div></div>`;
  }
  return `<div class="${cls}"><div class="wl-widget-hd">${title}</div>${subtitle}<div class="wl-focus-copy">${esc(w?.text||'Ready when you are.')}</div></div>`;
}

function buildInstantHomePlan(greeting){
  const state=loadProductivityState();
  const todos=[...(state.todos||[]).filter(t=>!t.done),...(state.todos||[]).filter(t=>t.done)].slice(0,5);
  const reminders=(state.reminders||[]).filter(r=>!r.done);
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

  // Reminders widget (high priority — right after nudges)
  if(reminders.length){
    const now=new Date();
    const sorted=[...reminders].sort((a,b)=>{
      if(!a.due&&!b.due)return 0;
      if(!a.due)return 1;
      if(!b.due)return -1;
      return new Date(a.due)-new Date(b.due);
    });
    pool.push({
      type:'reminders',
      size:'medium',
      title:'⏰ Reminders',
      subtitle:`${reminders.length} pending`,
      items:sorted.slice(0,6),
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
  const displayGreeting=(greeting!==undefined?greeting:getLocalTimeGreeting()).replace(/[\u{1F300}-\u{1FAF8}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}]/gu,'').trim();
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
      `Rise and build${namePart}.`,
      `Sharp and ready${namePart}. Let's build.`,
      `Let's make today count${namePart}.`,
      `Good morning${namePart}. What's the plan?`,
      `The day is yours${namePart}.`,
      `Coffee and ideas${namePart}? ?`,
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

/* --- Folder Meta (emoji, color) stored in localStorage --- */
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
  const instructions=meta.instructions||'';
  const ef=esc(folder).replace(/'/g,"\\'");

  // Prompt-style action cards (same grid as main homepage)
  const actionCards=`
    <div class="wl-action-card" onclick="createChat('${ef}')"><span class="wl-ac-icon">+</span><span class="wl-ac-label">New Chat</span><span class="wl-ac-sub">Start a conversation</span></div>
    <div class="wl-action-card" onclick="customizeFolder('${ef}')"><span class="wl-ac-icon">⚙</span><span class="wl-ac-label">Settings</span><span class="wl-ac-sub">Icon, name & instructions</span></div>
    <div class="wl-action-card" onclick="renameFolderFromView('${ef}')"><span class="wl-ac-icon">✏</span><span class="wl-ac-label">Rename</span><span class="wl-ac-sub">Change folder name</span></div>
    <div class="wl-action-card" onclick="deleteFolderAndChats('${ef}')"><span class="wl-ac-icon" style="color:var(--red)">🗑</span><span class="wl-ac-label">Delete</span><span class="wl-ac-sub">Remove folder & chats</span></div>`;

  // Build data widgets
  const widgets=[];
  if(chats.length){
    const items=chats.slice(0,4).map(c=>({id:c.id,title:c.title||'Untitled'}));
    widgets.push(renderHomeWidget({type:'recent',size:'medium',title:`Chats (${chats.length})`,items}));
  }
  if(instructions){
    widgets.push(renderHomeWidget({type:'motivation',size:'medium',title:'Custom Instructions',text:instructions.length>200?instructions.slice(0,200)+'…':instructions}));
  }
  const state=loadProductivityState();
  const allTodos=(state.todos||[]).filter(t=>!t.done);
  const folderTodos=allTodos.filter(t=>{
    const chatId=(t.id||'').split('_')[1]||'';
    return chats.some(c=>c.id===chatId);
  }).slice(0,5);
  if(folderTodos.length){
    widgets.push(renderHomeWidget({type:'todos',size:'medium',title:'Folder Tasks',items:folderTodos}));
  }
  const dataSection=widgets.length?`<div class="wl-data-section"><div class="wl-section-label">Folder overview</div><div class="wl-grid">${widgets.join('')}</div></div>`:'';

  area.innerHTML=`<div class="welcome">
    <div class="wl-hero">
      <h1 class="welcome-greeting">${fIcon} ${esc(folder)}</h1>
      <p class="welcome-sub">${chats.length} chat${chats.length!==1?'s':''}${instructions?' · Custom instructions active':''}</p>
    </div>
    <div class="wl-prompts-section">
      <div class="wl-prompts-grid">${actionCards}</div>
    </div>
    ${dataSection}
  </div>`;
  renderChatList();
}

async function renameFolderFromView(oldName){
  const next=await _dlg({title:'Rename folder',msg:'',icon:'✏️',iconType:'info',inputLabel:'New name',inputDefault:oldName,inputPlaceholder:'Folder name',confirmText:'Rename',cancelText:'Cancel'});
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
  document.querySelector('.sf-menu')?.remove();
  const meta=getFolderMeta(folder);
  const emojis=['📁','💼','🎯','🚀','💡','📝','🎨','🔬','📚','🎮','🏠','💰','🧠','⭐','🔥','🌟','💎','🎵','📸','🌍','💻','🧪','✨','🤖','🛠','📊','🏋','🍳','✈','🎬','📱','🔒','🎓','❤','🏆'];
  const curEmoji=meta.emoji||'📁';
  const curName=folder;
  const curInstructions=meta.instructions||'';
  const curFiles=meta.instructionFiles||[];
  const emojiGrid=emojis.map(e=>{
    const sel=e===curEmoji?' fv-cust-sel':'';
    return `<button class="fv-cust-btn${sel}" data-emoji="${e}" onclick="_custSelectEmoji(this)">${e}</button>`;
  }).join('')+`<button class="fv-cust-btn fv-cust-none${!curEmoji?' fv-cust-sel':''}" data-emoji="" onclick="_custSelectEmoji(this)">✕</button>`;
  const fileChips=curFiles.map((f,i)=>`<div class="fv-cust-file-chip"><span>${esc(f.name)}</span><span class="fc-rm" onclick="this.closest('.fv-cust-file-chip').remove()">✕</span></div>`).join('');

  const popup=document.createElement('div');
  popup.className='fv-cust-popup';
  popup.dataset.emoji=curEmoji;
  popup.dataset.folder=folder;
  popup.innerHTML=`
    <div class="fv-cust-overlay" onclick="this.parentElement.remove()"></div>
    <div class="fv-cust-modal">
      <h3>Customize Folder</h3>
      <div class="fv-cust-section">
        <label>Folder Name</label>
        <input class="fv-cust-input" id="fvCustName" type="text" value="${esc(curName)}" placeholder="Folder name..." maxlength="50">
      </div>
      <div class="fv-cust-section">
        <label>Icon</label>
        <div class="fv-cust-grid">${emojiGrid}</div>
      </div>
      <div class="fv-cust-section">
        <label>Custom Instructions</label>
        <textarea class="fv-cust-textarea" id="fvCustInstructions" placeholder="Describe what this folder is for. The AI will use these instructions for all chats in this folder...">${esc(curInstructions)}</textarea>
        <div class="fv-cust-hint">These instructions will be included in every chat within this folder.</div>
        <div class="fv-cust-file-row">
          <button class="fv-cust-file-btn" onclick="_custUploadFile()">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Upload context file
          </button>
          <input type="file" id="fvCustFileInput" style="display:none" onchange="_custHandleFile(this)" multiple accept=".txt,.md,.json,.pdf,.png,.jpg,.jpeg,.webp">
        </div>
        <div class="fv-cust-files-list" id="fvCustFilesList">${fileChips}</div>
        <button class="fv-cust-enhance-btn" onclick="_custEnhanceInstructions(this)">
          <span>✨</span> Enhance with AI
        </button>
      </div>
      <div class="fv-cust-footer">
        <button class="fv-cust-cancel" onclick="this.closest('.fv-cust-popup').remove()">Cancel</button>
        <button class="fv-cust-save" onclick="saveFolderCustomize(this)">Save</button>
      </div>
    </div>`;
  document.body.appendChild(popup);
  document.getElementById('fvCustName').focus();
}
function _custSelectEmoji(btn){
  btn.closest('.fv-cust-grid').querySelectorAll('.fv-cust-btn').forEach(b=>b.classList.remove('fv-cust-sel'));
  btn.classList.add('fv-cust-sel');
  btn.closest('.fv-cust-popup').dataset.emoji=btn.dataset.emoji;
}
function _custUploadFile(){
  document.getElementById('fvCustFileInput')?.click();
}
function _custHandleFile(input){
  const list=document.getElementById('fvCustFilesList');
  if(!list||!input.files)return;
  for(const f of input.files){
    const chip=document.createElement('div');
    chip.className='fv-cust-file-chip';
    chip.dataset.fileName=f.name;
    const reader=new FileReader();
    reader.onload=()=>{chip.dataset.fileData=reader.result;};
    if(f.type.startsWith('image/'))reader.readAsDataURL(f);
    else reader.readAsText(f);
    chip.innerHTML=`<span>${esc(f.name)}</span><span class="fc-rm" onclick="this.closest('.fv-cust-file-chip').remove()">✕</span>`;
    list.appendChild(chip);
  }
  input.value='';
}
async function _custEnhanceInstructions(btn){
  const textarea=document.getElementById('fvCustInstructions');
  const text=textarea?.value?.trim();
  if(!text){btn.textContent='⚠ Write instructions first';setTimeout(()=>{btn.innerHTML='<span>✨</span> Enhance with AI';},2000);return;}
  btn.disabled=true;
  btn.innerHTML='<span class="spinner"></span> Enhancing...';
  try{
    const r=await apiFetch('/api/folders/enhance-instructions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instructions:text})});
    const d=await r.json();
    if(d.enhanced){textarea.value=d.enhanced;btn.innerHTML='<span>✓</span> Enhanced!';setTimeout(()=>{btn.innerHTML='<span>✨</span> Enhance with AI';},2000);}
    else{btn.textContent='⚠ '+(d.error||'Enhancement failed');setTimeout(()=>{btn.innerHTML='<span>✨</span> Enhance with AI';},3000);}
  }catch{btn.textContent='⚠ Enhancement failed';setTimeout(()=>{btn.innerHTML='<span>✨</span> Enhance with AI';},3000);}
  btn.disabled=false;
}

async function saveFolderCustomize(btn){
  const popup=btn.closest('.fv-cust-popup');
  const oldFolder=popup.dataset.folder;
  if(!oldFolder){popup.remove();return;}
  const emoji=popup.dataset.emoji||'';
  const newName=(document.getElementById('fvCustName')?.value||'').trim()||oldFolder;
  const instructions=(document.getElementById('fvCustInstructions')?.value||'').trim();
  const fileChips=[...document.querySelectorAll('#fvCustFilesList .fv-cust-file-chip')];
  const instructionFiles=fileChips.map(c=>({name:c.dataset.fileName||c.querySelector('span')?.textContent||'file',data:c.dataset.fileData||''})).filter(f=>f.name);
  setFolderMeta(oldFolder,{emoji,instructions,instructionFiles});
  if(newName!==oldFolder){
    renameFolderMeta(oldFolder,newName);
    const chats=allChats.filter(c=>c.folder===oldFolder);
    for(const c of chats){
      await fetch(`/api/chats/${c.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder:newName})});
    }
    await refreshChats();
    _activeFolderView=newName;
  }
  popup.remove();
  renderChatList();
  if(_activeFolderView) openFolderView(_activeFolderView);
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
    reminders:(state.reminders||[]).filter(r=>!r.done).slice(0,10),
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

// --- Auth -----------------------------------------
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
    applyTheme(false); onboardingChecked=false;
    localStorage.removeItem(CHAT_CACHE_KEY);localStorage.removeItem(FOLDER_META_KEY);localStorage.removeItem(HOME_WIDGET_CACHE_KEY);
    showApp();
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
      localStorage.removeItem(CHAT_CACHE_KEY);localStorage.removeItem(FOLDER_META_KEY);localStorage.removeItem(HOME_WIDGET_CACHE_KEY);
      showApp();
    }
    else document.getElementById('loginErr').textContent=d.error||'Guest login failed';
  }catch(e){document.getElementById('loginErr').textContent='Guest login failed'}
}

async function signOut(){
  const ok=await _dlg({title:'Sign out',msg:'Are you sure you want to sign out of gyro?',icon:'🚪',iconType:'warn',confirmText:'Sign out',cancelText:'Cancel'});
  if(!ok)return;
  await fetch('/api/auth/logout',{method:'POST'});
  localStorage.removeItem('gyro_uid');
  localStorage.removeItem('gyro_remember');
  localStorage.removeItem('gyro_guest_id');
  localStorage.removeItem(CHAT_CACHE_KEY);
  localStorage.removeItem(FOLDER_META_KEY);
  localStorage.removeItem(HOME_WIDGET_CACHE_KEY);
  try{localStorage.removeItem('gyro_productivity');localStorage.removeItem('gyro_productivity_v1');}catch{}
  curUser=null;curChat=null;allChats=[];isGuest=false;
  onboardingChecked=false;
  hideSetupReminder();
  document.getElementById('appPage').classList.remove('visible');
  document.getElementById('loginPage').style.display='flex';
  document.getElementById('loginErr').textContent='';
  googleInitDone=false;
  await ensureOAuthConfigLoaded();
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

// --- Sidebar --------------------------------------
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
/* Download a file from base64-embedded chat data */
const _chatFileCache={};
let _chatFileCacheId=0;
function cacheChatFile(data,mime,name){const id=++_chatFileCacheId;_chatFileCache[id]={data,mime,name};return id;}
function downloadChatFile(cacheId){
  const f=_chatFileCache[cacheId];if(!f)return;
  try{
    const bytes=atob(f.data);const arr=new Uint8Array(bytes.length);
    for(let i=0;i<bytes.length;i++)arr[i]=bytes.charCodeAt(i);
    const blob=new Blob([arr],{type:f.mime||'application/octet-stream'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download=f.name||'file';
    document.body.appendChild(a);a.click();
    setTimeout(()=>{URL.revokeObjectURL(url);a.remove();},100);
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
      html+=`<button class="sf-dots" onclick="event.stopPropagation();toggleFolderMenu(this,'${esc(fld)}')" title="Folder options">✕</button></div>`;
      if(isCollapsed) continue;
    }
    for(const c of grouped[fld]){
      const a=c.id===curChat?' active':'';
      const g=(isChatRunning(c.id)||(c._streaming&&!isChatRunning(c.id)))?' generating':'';
      const u=unreadChats.has(c.id)?' unread':'';
      const sel=selectMode&&selectedItems.has(c.id)?' selected':'';
      const inFld=fld?' in-folder':'';
      html+=`<div class="sb-chat${a}${g}${u}${sel}${inFld}" draggable="true" data-chat-id="${c.id}" onclick="${selectMode?`toggleSelectChat('${c.id}')`:"openChat('"+c.id+"')"}">`;
      if(selectMode)html+=`<input type="checkbox" class="sb-sel-cb" ${selectedItems.has(c.id)?'checked':''} onclick="event.stopPropagation();toggleSelectChat('${c.id}')">`;
      html+=`<span class="ct">${esc(c.title)}</span><button class="cd" onclick="event.stopPropagation();showMoveMenu(this,'${c.id}')" title="Move to folder">📁</button><button class="cd" onclick="event.stopPropagation();renameChat('${c.id}')" title="Rename">✎</button><button class="cd" onclick="event.stopPropagation();delChat('${c.id}')">✕</button></div>`;
    }
  }
  el.innerHTML=html||'<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:11px;line-height:1.7">No chats yet.<br>Start a conversation to see it here.</div>';
  // -- Drag-to-folder: wire up after render --
  _initSidebarDrag(el);
  // Update select bar count
  const selBar=document.getElementById('selectBar');
  if(selBar){
    const cnt=selectedItems.size;
    document.getElementById('selCount').textContent=cnt?`${cnt} selected`:'0 selected';
  }
}

// -- Sidebar drag-to-folder --
function _initSidebarDrag(container){
  let _dragChatId=null;
  container.addEventListener('dragstart',e=>{
    const chatEl=e.target.closest('.sb-chat[data-chat-id]');
    if(!chatEl)return;
    _dragChatId=chatEl.dataset.chatId;
    chatEl.classList.add('sb-drag-active');
    e.dataTransfer.effectAllowed='move';
    e.dataTransfer.setData('text/plain',_dragChatId);
  });
  container.addEventListener('dragend',e=>{
    _dragChatId=null;
    container.querySelectorAll('.sb-drag-active').forEach(el=>el.classList.remove('sb-drag-active'));
    container.querySelectorAll('.sb-drag-over').forEach(el=>el.classList.remove('sb-drag-over'));
  });
  container.addEventListener('dragover',e=>{
    if(!_dragChatId)return;
    e.preventDefault();
    e.dataTransfer.dropEffect='move';
    const folderEl=e.target.closest('.sb-folder[data-folder]');
    container.querySelectorAll('.sb-drag-over').forEach(el=>el.classList.remove('sb-drag-over'));
    if(folderEl)folderEl.classList.add('sb-drag-over');
  });
  container.addEventListener('dragleave',e=>{
    const folderEl=e.target.closest('.sb-folder[data-folder]');
    if(folderEl)folderEl.classList.remove('sb-drag-over');
  });
  container.addEventListener('drop',e=>{
    e.preventDefault();
    container.querySelectorAll('.sb-drag-over').forEach(el=>el.classList.remove('sb-drag-over'));
    container.querySelectorAll('.sb-drag-active').forEach(el=>el.classList.remove('sb-drag-active'));
    const folderEl=e.target.closest('.sb-folder[data-folder]');
    if(!_dragChatId||!folderEl)return;
    const targetFolder=folderEl.dataset.folder;
    const chat=allChats.find(c=>c.id===_dragChatId);
    if(chat&&chat.folder!==targetFolder){
      moveChat(_dragChatId,targetFolder);
    }
    _dragChatId=null;
  });
}

function filterChats(){renderChatList(document.getElementById('chatSearch').value)}

async function renameChat(id){
  const chat=allChats.find(c=>c.id===id);
  const next=await _dlg({title:'Rename chat',msg:'',icon:'✏️',iconType:'info',inputLabel:'New title',inputDefault:chat?.title||'',inputPlaceholder:'Chat title…',confirmText:'Rename',cancelText:'Cancel'});
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
  const n=await _dlg({title:'New folder',msg:'',icon:'📁',iconType:'info',inputLabel:'Folder name',inputDefault:'',inputPlaceholder:'e.g. Work, Projects…',confirmText:'Create',cancelText:'Cancel'});
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
  const rect=btn.getBoundingClientRect();
  Object.assign(menu.style,{position:'fixed',top:rect.bottom+'px',left:rect.left+'px',zIndex:'9999'});
  document.body.appendChild(menu);
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
  const rect=btn.getBoundingClientRect();
  Object.assign(menu.style,{position:'fixed',top:rect.bottom+'px',left:rect.left+'px',zIndex:'9999'});
  document.body.appendChild(menu);
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
  const next=await _dlg({title:'Rename folder',msg:'',icon:'✏️',iconType:'info',inputLabel:'New name',inputDefault:oldName,inputPlaceholder:'Folder name',confirmText:'Rename',cancelText:'Cancel'});
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
  const ok=await _dlg({title:'Remove folder',msg:'Chats will be moved out of the folder, not deleted.',icon:'🗑️',iconType:'danger',confirmText:'Remove folder',cancelText:'Cancel',dangerous:true});
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

// --- Multi-Select Mode ----------------------------
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

// --- Smart Home Widgets (async) -----------------
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

// --- Cross-device sync: join an active stream from another device ---
async function joinChatStream(chatId){
  const area=document.getElementById('chatArea');
  // Create a generating msg div
  const msgDiv=document.createElement('div');
  msgDiv.className='msg kairo';
  msgDiv.id='join-stream-msg';
  msgDiv.innerHTML='<div class="lbl">Gyro</div><div class="msg-content"><div class="think-active" style="animation:thinkingIn .5s var(--ease-spring-snappy) both"><div class="dots"><span></span><span></span><span></span></div><span> Generating (syncing from another device)...</span></div></div>';
  area.appendChild(msgDiv);
  area.scrollTop=area.scrollHeight;
  const contentEl=msgDiv.querySelector('.msg-content');

  let cursor=0;
  let fullText='';
  let thinkText='';
  let isThinking=false;
  let _thinkTurn=0;
  let _turnThinkText='';
  let _thinkDisplayed='';
  let _responseDisplayed='';
  let _responseTypewriter=null;
  let _donePayload=null;
  let thinkPanel=null;
  let thinkTextEl=null;

  const _autoScroll=()=>{area.scrollTop=area.scrollHeight;};

  setChatRunning(chatId,true,{type:'join'});

  function ensureThinkPanelJoin(){
    if(thinkPanel) return;
    const ta=contentEl.querySelector('.think-active');
    if(ta) ta.remove();
    thinkPanel=document.createElement('div');
    thinkPanel.className='live-think-panel ltp-collapsed';
    thinkPanel.innerHTML='<div class="ltp-header" style="cursor:pointer"><span class="ltp-icon">💭</span><span class="ltp-label">Thinking...</span><span class="ltp-chevron">▾</span><span class="ltp-dots"><span></span><span></span><span></span></span></div><div class="ltp-body"><div class="ltp-text"></div></div>';
    thinkPanel.querySelector('.ltp-header').onclick=()=>thinkPanel.classList.toggle('ltp-collapsed');
    contentEl.innerHTML='';
    contentEl.appendChild(thinkPanel);
    thinkTextEl=thinkPanel.querySelector('.ltp-text');
  }

  try{
    while(true){
      if(curChat!==chatId) break;
      await new Promise(r=>setTimeout(r,cursor===0?300:1500));
      if(curChat!==chatId) break;

      let data;
      try{
        const resp=await apiFetch(`/api/chats/${chatId}/stream/join?cursor=${cursor}`);
        if(!resp.ok){
          // Chat not found or error
          break;
        }
        data=await resp.json();
      }catch(e){
        console.warn('[gyro] Join stream poll error:',e);
        await new Promise(r=>setTimeout(r,3000));
        continue;
      }

      if(data.error==='not_found'){
        break;
      }

      cursor=data.cursor;

      // Process events
      for(const rawLine of (data.events||[])){
        const line=(typeof rawLine==='string'?rawLine:'').trim();
        if(!line) continue;
        let ev;
        try{ev=JSON.parse(line)}catch(e){continue}

        if(ev.type==='heartbeat'){
          continue;
        }else if(ev.type==='thinking_delta'){
          if(!isThinking){
            isThinking=true;
            _turnThinkText='';
            _thinkDisplayed='';
          }
          _turnThinkText+=ev.text;
          thinkText+=ev.text;
          ensureThinkPanelJoin();
          if(!window._joinThinkTypewriter){
            window._joinThinkTypewriter=setInterval(()=>{
              if(!isThinking&&_thinkDisplayed.length>=_turnThinkText.length){
                clearInterval(window._joinThinkTypewriter);window._joinThinkTypewriter=null;return;
              }
              if(_thinkDisplayed.length<_turnThinkText.length){
                const end=Math.min(_thinkDisplayed.length+8,_turnThinkText.length);
                _thinkDisplayed=_turnThinkText.slice(0,end);
                if(thinkTextEl) thinkTextEl.innerHTML=_fmtThink(_thinkDisplayed);
              }
            },20);
          }
          _autoScroll();
        }else if(ev.type==='delta'){
          if(isThinking&&thinkPanel){
            isThinking=false;
            if(window._joinThinkTypewriter){clearInterval(window._joinThinkTypewriter);window._joinThinkTypewriter=null;}
            if(thinkTextEl&&_turnThinkText) thinkTextEl.innerHTML=_fmtThink(_turnThinkText);
            thinkPanel.classList.add('ltp-done','ltp-collapsed');
            const dotsEl=thinkPanel.querySelector('.ltp-dots');
            if(dotsEl) dotsEl.remove();
            const body=thinkPanel.querySelector('.ltp-body');
            if(body){body.style.maxHeight='0';body.style.padding='0';}
            let respDiv=contentEl.querySelector('.stream-response-area');
            if(!respDiv){
              respDiv=document.createElement('div');
              respDiv.className='stream-response-area';
              contentEl.appendChild(respDiv);
            }
          }
          // Remove thinking indicator on first delta
          const ta=contentEl.querySelector('.think-active');
          if(ta) ta.remove();
          fullText+=ev.text;
          if(!_responseTypewriter){
            _responseTypewriter=setInterval(()=>{
              if(_responseDisplayed.length>=fullText.length) return;
              const end=Math.min(_responseDisplayed.length+12,fullText.length);
              _responseDisplayed=fullText.slice(0,end);
              const targetEl=contentEl.querySelector('.stream-response-area')||contentEl;
              targetEl.innerHTML=fmtLive(_responseDisplayed);
              if(!schoolMode)renderMathInElementSafe(targetEl);
              _autoScroll();
            },20);
          }
        }else if(ev.type==='media_loading'){
          const info=ev.query||ev.ticker||ev.prompt||'';
          fullText+=`\n[[[MEDIA:${ev.kind}:${ev.index}:${info}]]]\n`;
          _responseDisplayed=fullText;
          const targetEl=contentEl.querySelector('.stream-response-area')||contentEl;
          targetEl.innerHTML=fmtLive(fullText);
          _autoScroll();
        }else if(ev.type==='image_result'||ev.type==='stock_data'||ev.type==='image_generated'){
          // Media results — just flush and render
          _responseDisplayed=fullText;
          const targetEl=contentEl.querySelector('.stream-response-area')||contentEl;
          targetEl.innerHTML=fmtLive(fullText);
          _autoScroll();
        }else if(ev.type==='done'){
          _donePayload=ev;
        }else if(ev.type==='error'){
          contentEl.innerHTML=`<div style="color:var(--red);padding:12px 0">${esc(ev.error)}</div>`;
        }
      }

      // Check if we should stop polling
      if(data.done){
        // If the done payload has research_trigger, research agent will start soon
        // Wait a moment for the other device to POST and create the research session
        let _hasAgents=!!data.research_id||!!data.stock_agent_id;
        if(!_hasAgents&&_donePayload&&_donePayload.research_trigger){
          // Research about to start — wait and re-check
          await new Promise(r=>setTimeout(r,3000));
          try{
            const recheck=await apiFetch(`/api/chats/${chatId}/stream/join?cursor=${cursor}`);
            if(recheck.ok){
              const rd=await recheck.json();
              if(rd.research_id){data.research_id=rd.research_id;data.research_query=rd.research_query;_hasAgents=true;}
              if(rd.stock_agent_id){data.stock_agent_id=rd.stock_agent_id;_hasAgents=true;}
            }
          }catch(e){}
        }
        if(!_hasAgents) break;
      }

      // If main stream is done but agents are active, handle them
      if(data.done&&(data.research_id||data.stock_agent_id)){
        // Clean up typewriters
        if(_responseTypewriter){clearInterval(_responseTypewriter);_responseTypewriter=null;}
        if(window._joinThinkTypewriter){clearInterval(window._joinThinkTypewriter);window._joinThinkTypewriter=null;}
        setChatRunning(chatId,false);

        // Reload chat to show final rendered state before starting agents
        try{
          await refreshChats();
          // Don't call openChat (infinite loop) — re-render in place
          const chatResp=await apiFetch(`/api/chats/${chatId}`);
          if(chatResp.ok){
            const chatData=await chatResp.json();
            if(!chatData.error){
              const areaEl=document.getElementById('chatArea');
              areaEl.innerHTML='';
              if(chatData.messages?.length){
                for(const m of chatData.messages){
                  if(m.hidden) continue;
                  if(m.role==='user') addMsg('user',m.text,[],m);
                  else addMsg('kairo',m.text,m.files_modified||[],m);
                }
              }
            }
          }
        }catch(e){console.warn('[gyro] Failed to reload chat after stream join:',e);}

        // Now handle active agents
        if(data.research_id){
          const rQuery=data.research_query||'Research';
          // Create a new msg div for the research agent
          const rMsgDiv=document.createElement('div');
          rMsgDiv.className='msg kairo';
          rMsgDiv.innerHTML='<div class="lbl">Gyro</div><div class="msg-content"></div>';
          document.getElementById('chatArea').appendChild(rMsgDiv);
          area.scrollTop=area.scrollHeight;
          const rContentEl=rMsgDiv.querySelector('.msg-content');
          await runResearchAgent(rQuery, rContentEl, area, chatId, data.research_id);
        }
        if(data.stock_agent_id){
          const sMsgDiv=document.createElement('div');
          sMsgDiv.className='msg kairo';
          sMsgDiv.innerHTML='<div class="lbl">Gyro</div><div class="msg-content"></div>';
          document.getElementById('chatArea').appendChild(sMsgDiv);
          area.scrollTop=area.scrollHeight;
          const sContentEl=sMsgDiv.querySelector('.msg-content');
          await runStockAgent([], '', sContentEl, area, chatId, data.stock_agent_id);
        }
        return;
      }
    }

    // Stream ended — clean up and reload final state
    if(_responseTypewriter){clearInterval(_responseTypewriter);_responseTypewriter=null;}
    if(window._joinThinkTypewriter){clearInterval(window._joinThinkTypewriter);window._joinThinkTypewriter=null;}

    // Reload the chat to get the final rendered state
    if(curChat===chatId){
      await new Promise(r=>setTimeout(r,500));
      try{
        await refreshChats();
        const chatResp=await apiFetch(`/api/chats/${chatId}`);
        if(chatResp.ok){
          const chatData=await chatResp.json();
          if(!chatData.error){
            const areaEl=document.getElementById('chatArea');
            areaEl.innerHTML='';
            if(chatData.messages?.length){
              for(const m of chatData.messages){
                if(m.hidden) continue;
                if(m.role==='user') addMsg('user',m.text,[],m);
                else addMsg('kairo',m.text,m.files_modified||[],m);
              }
            }
            // Re-render mermaid
            setTimeout(()=>{
              try{
                const mermaidEls=areaEl.querySelectorAll('pre.mermaid:not([data-processed])');
                if(mermaidEls.length) mermaid.run({nodes:mermaidEls}).then(()=>enhanceMermaidDiagrams()).catch(()=>enhanceMermaidDiagrams());
              }catch(e){}
            },200);
          }
        }
      }catch(e){console.warn('[gyro] Failed to reload after join:',e);}
    }
  }catch(e){
    console.error('[gyro] Join stream error:',e);
  }finally{
    if(_responseTypewriter){clearInterval(_responseTypewriter);_responseTypewriter=null;}
    if(window._joinThinkTypewriter){clearInterval(window._joinThinkTypewriter);window._joinThinkTypewriter=null;}
    setChatRunning(chatId,false);
    updateComposerBusyUI();
  }
}

async function openChat(id){
  if(curChat===id) return;
  _activeFolderView=null;
  // Cancel any active edit when switching chats
  if(window._activeEdit){_cancelEdit();}
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
        const mermaidEls=area.querySelectorAll('pre.mermaid:not([data-processed])');
        if(mermaidEls.length){
          mermaid.run({nodes:mermaidEls}).then(()=>enhanceMermaidDiagrams()).catch(()=>enhanceMermaidDiagrams());
        }
      }catch(e){
        console.log('Mermaid re-render:',e);
        enhanceMermaidDiagrams();
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
    genDiv.innerHTML='<div class="lbl">Gyro</div><div class="msg-content"><div class="think-active"><div class="dots"><span></span><span></span><span></span></div><span> Generating...</span></div></div>';
    area.appendChild(genDiv);
    area.scrollTop=area.scrollHeight;
  }
  // Cross-device sync: detect active generation from another device
  else if(chat._streaming||chat._active_research_id||chat._active_stock_agent_id){
    // Something is actively running on the server but not on this device
    if(chat._streaming){
      // Main chat stream is active — join it
      joinChatStream(id);
    }else if(chat._active_research_id){
      // Research agent is running — join it
      const rMsgDiv=document.createElement('div');
      rMsgDiv.className='msg kairo';
      rMsgDiv.innerHTML='<div class="lbl">Gyro</div><div class="msg-content"></div>';
      area.appendChild(rMsgDiv);
      area.scrollTop=area.scrollHeight;
      const rContentEl=rMsgDiv.querySelector('.msg-content');
      runResearchAgent(chat._active_research_query||'Research', rContentEl, area, id, chat._active_research_id);
    }else if(chat._active_stock_agent_id){
      // Stock agent is running — join it
      const sMsgDiv=document.createElement('div');
      sMsgDiv.className='msg kairo';
      sMsgDiv.innerHTML='<div class="lbl">Gyro</div><div class="msg-content"></div>';
      area.appendChild(sMsgDiv);
      area.scrollTop=area.scrollHeight;
      const sContentEl=sMsgDiv.querySelector('.msg-content');
      runStockAgent([], '', sContentEl, area, id, chat._active_stock_agent_id);
    }
  }
  renderChatList(document.getElementById('chatSearch').value);
  updateComposerBusyUI();
  document.getElementById('msgInput').focus();
  setStatus('Chat loaded. Continue or ask for a summary.');
}

async function delChat(id){
  const ok=await _dlg({title:'Delete chat',msg:'This chat will be permanently deleted.',icon:'🔥',iconType:'danger',confirmText:'Delete',cancelText:'Cancel',dangerous:true});
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

// --- Models ---------------------------------------
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
  // Update segmented control
  const opts=document.querySelectorAll('.think-opt');
  const track=document.querySelector('.think-track');
  const slider=document.getElementById('thinkSlider');
  const desc=document.getElementById('thinkDesc');
  const descs={off:'Auto-detects when deeper reasoning is needed',low:'Light reasoning for simple analysis',medium:'Balanced depth for most tasks',high:'Maximum reasoning power for complex problems',extended:'Multi-pass deep thinking — analyzes, then verifies & refines'};
  const lvl=thinkingLevel||'off';
  const numOpts=opts.length||5;
  let idx=0;
  opts.forEach((b,i)=>{const a=b.dataset.lvl===lvl;b.classList.toggle('active',a);if(a)idx=i;});
  if(track)track.dataset.active=lvl;
  if(slider)slider.style.left=`calc(${idx*(100/numOpts)}% + 3px)`;
  if(desc)desc.textContent=descs[lvl]||'';
}

function setThinkingLevel(lvl){
  thinkingLevel=lvl;
  refreshModeMenuUI();
  const labels={off:'Thinking off',low:'Low reasoning',medium:'Medium reasoning',high:'Max reasoning',extended:'Extended multi-pass thinking'};
  showToast(labels[lvl]||`Thinking: ${lvl}`, lvl==='off'?'info':'success');
}

document.addEventListener('click',e=>{
  if(!e.target.closest('#cmsContainer')){
    document.getElementById('cmsDropdown')?.classList.remove('show');
  }
  if(!e.target.closest('.plus-menu-wrap')){
    closePlusMenu();
  }
});

// --- File Upload ----------------------------------
// Convert unsupported image files to PNG client-side before uploading
function _convertImageToPng(file){
  return new Promise((resolve)=>{
    const mime=file.type||'';
    // SVG ? render on canvas ? PNG
    if(mime==='image/svg+xml'||file.name.toLowerCase().endsWith('.svg')){
      const reader=new FileReader();
      reader.onload=()=>{
        const svgText=reader.result;
        const img=new Image();
        const blob=new Blob([svgText],{type:'image/svg+xml;charset=utf-8'});
        const url=URL.createObjectURL(blob);
        img.onload=()=>{
          const c=document.createElement('canvas');
          c.width=Math.min(img.naturalWidth||800,2048);
          c.height=Math.min(img.naturalHeight||800,2048);
          if(c.width===0||c.height===0){c.width=800;c.height=800;}
          const ctx=c.getContext('2d');
          ctx.drawImage(img,0,0,c.width,c.height);
          c.toBlob(pngBlob=>{
            URL.revokeObjectURL(url);
            if(pngBlob){
              const pngFile=new File([pngBlob],file.name.replace(/\.svg$/i,'.png'),{type:'image/png'});
              resolve(pngFile);
            }else{resolve(file);}
          },'image/png');
        };
        img.onerror=()=>{URL.revokeObjectURL(url);resolve(file);};
        img.src=url;
      };
      reader.onerror=()=>resolve(file);
      reader.readAsText(file);
      return;
    }
    // BMP, TIFF, ICO, etc. ? canvas ? PNG
    const NON_NATIVE=['image/bmp','image/tiff','image/x-icon','image/vnd.microsoft.icon','image/x-ms-bmp'];
    if(NON_NATIVE.includes(mime)||/\.(bmp|tiff?|ico)$/i.test(file.name)){
      const reader=new FileReader();
      reader.onload=()=>{
        const img=new Image();
        img.onload=()=>{
          const c=document.createElement('canvas');
          c.width=img.naturalWidth;c.height=img.naturalHeight;
          const ctx=c.getContext('2d');
          ctx.drawImage(img,0,0);
          c.toBlob(pngBlob=>{
            if(pngBlob){
              const pngFile=new File([pngBlob],file.name.replace(/\.[^.]+$/,'.png'),{type:'image/png'});
              resolve(pngFile);
            }else{resolve(file);}
          },'image/png');
        };
        img.onerror=()=>resolve(file);
        img.src=reader.result;
      };
      reader.onerror=()=>resolve(file);
      reader.readAsDataURL(file);
      return;
    }
    resolve(file);
  });
}

function handleFiles(input){
  for(const origFile of input.files){
    // Add a loading placeholder immediately so user sees the file
    const idx=pendingFiles.length;
    pendingFiles.push({name:origFile.name,mime:origFile.type||'application/octet-stream',data:'',text:'',doc_data:'',_loading:true});
    renderPF();
    _uploadsInFlight++;
    // Convert unsupported images first, then upload
    _convertImageToPng(origFile).then(file=>{
      const reader=new FileReader();
      reader.onload=async()=>{
        const form=new FormData();form.append('file',file);
        try{
          const r=await fetch('/api/upload',{method:'POST',body:form});
          const d=await r.json();
          // Find and update the placeholder (match by name + _loading)
          const ph=pendingFiles.find(f=>f._loading&&f.name===origFile.name);
          if(ph){ph.name=d.name;ph.mime=d.mime;ph.data=d.image_data||'';ph.text=d.text||'';ph.doc_data=d.doc_data||'';delete ph._loading;}
          renderPF();
        }catch(e){
          console.error('Upload failed',e);
          // Remove the placeholder on failure
          const pi=pendingFiles.findIndex(f=>f._loading&&f.name===origFile.name);
          if(pi>=0)pendingFiles.splice(pi,1);
          renderPF();
        }finally{
          _uploadsInFlight=Math.max(0,_uploadsInFlight-1);
          _checkUploadsComplete();
        }
      };
      reader.readAsArrayBuffer(file);
    });
  }
  input.value='';
}
function _checkUploadsComplete(){
  if(_uploadsInFlight>0)return;
  if(_pendingSendOpts!==null){
    const opts=_pendingSendOpts;
    _pendingSendOpts=null;
    sendMessage(opts);
  }
}

function renderPF(){
  document.getElementById('filePreview').innerHTML=pendingFiles.map((f,i)=>{
    const loading=f._loading;
    const t=loading?'<span class="fc-spinner"></span>':f.mime?.startsWith('image/')&&f.data?`<img src="data:${f.mime};base64,${f.data}">`:f.doc_data?'📄':'▪';
    return`<div class="file-chip${loading?' loading':''}">${t} ${esc(f.name)} <button class="fc-x" onclick="pendingFiles.splice(${i},1);if(pendingFiles.length===0&&_pendingSendOpts)_pendingSendOpts=null;renderPF()">✕</button></div>`;
  }).join('');
  const ready=pendingFiles.filter(f=>!f._loading).length;
  const uploading=pendingFiles.filter(f=>f._loading).length;
  if(uploading)setStatus(`Uploading ${uploading} file${uploading===1?'':'s'}...`);
  else if(ready)setStatus(`${ready} file${ready===1?'':'s'} attached and ready.`);
}

/* --- Reply Context (images + text from chat) --- */
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
        pendingFiles.push({name:'pasted_image.png',mime:blob.type||'image/png',data:'',text:'',doc_data:'',_loading:true});
        renderPF();
        _uploadsInFlight++;
        fetch('/api/upload',{method:'POST',body:form}).then(r=>r.json()).then(d=>{
          const ph=pendingFiles.find(f=>f._loading&&f.name==='pasted_image.png');
          if(ph){ph.name=d.name;ph.mime=d.mime;ph.data=d.image_data||'';ph.text=d.text||'';ph.doc_data=d.doc_data||'';delete ph._loading;}
          renderPF();showToast('Image pasted','success');
        }).catch(()=>{
          const pi=pendingFiles.findIndex(f=>f._loading&&f.name==='pasted_image.png');
          if(pi>=0)pendingFiles.splice(pi,1);
          renderPF();showToast('Paste upload failed','error');
        }).finally(()=>{_uploadsInFlight=Math.max(0,_uploadsInFlight-1);_checkUploadsComplete();});
        break;
      }
    }
  });
}

// --- Plus Menu ------------------------------------
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
  const names={canvas:'Canvas',search:'Web Search',mindmap:'Mind Map',research:'Research Agent',summarize:'Summarize',code:'Code Execution',imagegen:'Image Generation',huggingface:'HuggingFace Spaces'};
  wrap.innerHTML=[...activeTools].map(t=>`<span class="tool-badge" onclick="activateTool('${t}')">${names[t]||t} <span class="tb-x">×</span></span>`).join('');
}

function toggleResearch(){
  activateTool('research');
}

async function showResearchPlan(query, contentEl, area, chatId){
  // Go straight to research — questions are handled in normal chat conversation
  contentEl.innerHTML='';
  await runResearchAgent(query, contentEl, area, chatId);
}

async function runResearchAgent(query, contentEl, area, chatId, existingResearchId){
  // Reset auto-retry counter on fresh invocation (not from auto-retry itself)
  if(!window._raIsAutoRetry) window._raAutoRetryCount=0;
  window._raIsAutoRetry=false;
  const stepIcons=['1','2','3','4','5','6','7','8','9'];
  const stepNames=['Intelligence Gathering','Deep Source Analysis','Fact Verification','Perspectives & Context','Evidence & Data Analysis','Synthesis & Insights','Conclusions & Assessment','Final Intelligence Brief','Comprehensive Report'];
  const totalSteps=9;
  let currentStep=0;
  // Global retry function for all retry buttons
  window._raRetry=function(btn){
    if(btn){btn.disabled=true;btn.textContent='⏳ Retrying...';}
    window._raAutoRetryCount=0;
    contentEl.innerHTML='';
    runResearchAgent(query, contentEl, area, chatId);
  };
  // Smart auto-scroll: only auto-scroll if user is near bottom
  let _raUserScrolledAway=false;
  const _raScrollThreshold=200;
  const _raOnScroll=()=>{
    const dist=area.scrollHeight-area.scrollTop-area.clientHeight;
    _raUserScrolledAway=dist>_raScrollThreshold;
  };
  area.addEventListener('scroll',_raOnScroll,{passive:true});
  const _raAutoScroll=()=>{if(!_raUserScrolledAway)area.scrollTop=area.scrollHeight;};
  // AbortController for cancellation
  const _raAbort=new AbortController();
  const stepTimers={};
  const stepElapsed={};
  const stepWordCounts={};
  const stepSourceCounts={};
  const manualToggles=new Set();
  const completedSteps=new Set();
  window._raManualToggles=manualToggles;
  const discoveredSources=[];
  const discoveredFindings=[];
  let startTime=Date.now();
  let totalWords=0;
  const _raDevRaw=devRawMode;  // Snapshot dev mode at stream start

  const stepsHtml=stepNames.map((name,i)=>`<div class="ra-step" data-ra="${i}"><div class="ra-step-dot" onclick="raScrollToStep(${i+1})">${stepIcons[i]}</div><div class="ra-step-label">${name}</div></div>`).join('');

  contentEl.innerHTML=`
    <div class="ra-container">
      <div class="ra-badge" id="_raBadge">Research Agent — In Progress</div>
      <div class="ra-progress">
        <div class="ra-header">
          <span class="ra-title">${esc(query)}</span>
          <span class="ra-pct" id="_raPct">0%</span>
        </div>
        <div class="ra-bar-track"><div class="ra-bar-fill" id="_raBar" style="width:0%"></div></div>
        <div class="ra-steps" id="_raSteps">
          <div class="ra-steps-line"><div class="ra-steps-line-fill" id="_raLine" style="width:0%"></div></div>
          ${stepsHtml}
        </div>
        <div class="ra-stats-row">
          <span><strong id="_raSourceCount">0</strong> sources</span>
          <span><strong id="_raFindStat">0</strong> findings</span>
          <span><strong id="_raElapsed">0s</strong></span>
        </div>
        <div class="ra-activity" id="_raActivity"><span class="ra-pulse"></span><span id="_raMsg">Initializing research agent...</span></div>
        <div class="ra-card-tabs" id="_raCardTabs" style="display:none">
          <button class="ra-card-tab ra-card-tab-active" data-tab="findings" onclick="(function(b){var w=b.classList.contains('ra-card-tab-active');b.parentElement.querySelectorAll('.ra-card-tab').forEach(function(t){t.classList.remove('ra-card-tab-active')});var p=b.closest('.ra-progress');if(w){p.querySelector('#_raFindPanel').style.display='none';p.querySelector('#_raSrcPanel').style.display='none'}else{b.classList.add('ra-card-tab-active');p.querySelector('#_raFindPanel').style.display='';p.querySelector('#_raSrcPanel').style.display='none'}})(this)">Findings <span class="ra-tab-count" id="_raFindCount">0</span></button>
          <button class="ra-card-tab" data-tab="sources" onclick="(function(b){var w=b.classList.contains('ra-card-tab-active');b.parentElement.querySelectorAll('.ra-card-tab').forEach(function(t){t.classList.remove('ra-card-tab-active')});var p=b.closest('.ra-progress');if(w){p.querySelector('#_raFindPanel').style.display='none';p.querySelector('#_raSrcPanel').style.display='none'}else{b.classList.add('ra-card-tab-active');p.querySelector('#_raFindPanel').style.display='none';p.querySelector('#_raSrcPanel').style.display=''}})(this)">Sources <span class="ra-tab-count" id="_raSrcCount2">0</span></button>
        </div>
        <div class="ra-tab-panel" id="_raFindPanel" style="display:none"><div class="ra-findings-list" id="_raFindList"></div></div>
        <div class="ra-tab-panel" id="_raSrcPanel" style="display:none"><div class="ra-sources-list" id="_raSrcList"></div></div>
      </div>
      <div class="ra-output" id="_raOut"></div>
      <div class="ra-toast-container" id="_raToasts" style="display:none"></div>
    </div>`;
  _raAutoScroll();

  // Live elapsed timer — show as h:m:s format
  const _fmtElapsed=(ms)=>{
    const secs=Math.floor(ms/1000);
    if(secs<60) return secs+'s';
    const mins=Math.floor(secs/60);
    const remSecs=secs%60;
    if(mins<60) return mins+'m '+remSecs+'s';
    const hrs=Math.floor(mins/60);
    const remMins=mins%60;
    return hrs+'h '+remMins+'m';
  };
  const elTimer=setInterval(()=>{
    const el=document.getElementById('_raElapsed');
    if(el) el.textContent=_fmtElapsed(Date.now()-startTime);
  },1000);

  // Toast notification system (disabled)
  const showToast=(msg,icon='')=>{};

  // Milestone tracker (disabled)
  const checkMilestones=()=>{};

  window.raScrollToStep=function(stepNum){
    const section=document.getElementById('_raS'+stepNum);
    if(!section)return;
    const outEl=document.getElementById('_raOut');
    if(outEl){
      outEl.querySelectorAll('.ra-section').forEach(sec=>{
        const sNum=parseInt(sec.id.replace('_raS',''));
        if(sNum===stepNum) sec.classList.remove('ra-collapsed');
        else sec.classList.add('ra-collapsed');
        manualToggles.add(sNum);
      });
    }
    section.scrollIntoView({behavior:'smooth',block:'nearest'});
  };

  const updateProgress=(step,msg)=>{
    currentStep=step;
    const pct=Math.round((step/totalSteps)*100);
    const barEl=document.getElementById('_raBar');
    const lineEl=document.getElementById('_raLine');
    const msgEl=document.getElementById('_raMsg');
    const pctEl=document.getElementById('_raPct');
    if(barEl) barEl.style.width=pct+'%';
    if(pctEl) pctEl.textContent=pct+'%';
    if(lineEl) lineEl.style.width=Math.min((step/(totalSteps-1))*100,100)+'%';
    if(msgEl) msgEl.textContent=msg||'Working...';
    const stepsEl=document.getElementById('_raSteps');
    if(stepsEl){
      stepsEl.querySelectorAll('.ra-step').forEach((dot,i)=>{
        const stepNum=i+1;
        const isDone=completedSteps.has(stepNum);
        const isActive=stepNum===step+1||(stepNum===step&&!isDone);
        dot.className='ra-step'+(isDone?' done':(isActive?' active':''));
        const inner=dot.querySelector('.ra-step-dot');
        if(inner) inner.textContent=isDone?'✓':stepIcons[i];
      });
    }
  };

  const addSource=(src)=>{
    discoveredSources.push(src);
    const tabs=document.getElementById('_raCardTabs');
    if(tabs) tabs.style.display='';
    const cntEl=document.getElementById('_raSourceCount');
    const cnt2=document.getElementById('_raSrcCount2');
    if(cntEl) cntEl.textContent=discoveredSources.length;
    if(cnt2) cnt2.textContent=discoveredSources.length;
    const list=document.getElementById('_raSrcList');
    if(list){
      try{
        const domain=new URL(src.url).hostname.replace('www.','');
        const card=document.createElement('a');
        card.className='ra-src-card ra-src-card-in';
        card.href=src.url;
        card.target='_blank';
        card.rel='noopener noreferrer';
        card.innerHTML=`<img class="ra-src-favicon" src="https://www.google.com/s2/favicons?domain=${esc(domain)}&sz=32" alt="" onerror="this.style.display='none'"><div class="ra-src-info"><div class="ra-src-name">${esc(src.title.length>60?src.title.slice(0,60)+'…':src.title)}</div><div class="ra-src-domain">${esc(domain)}</div></div>`;
        list.appendChild(card);
      }catch(e){}
    }
    checkMilestones();
  };

  const addFinding=(text,step)=>{
    discoveredFindings.push({text,step});
    const tabs=document.getElementById('_raCardTabs');
    if(tabs) tabs.style.display='';
    // Show findings tab panel if findings tab is active
    const findPanel=document.getElementById('_raFindPanel');
    const activeTab=tabs&&tabs.querySelector('.ra-card-tab-active');
    if(findPanel&&activeTab&&activeTab.dataset.tab==='findings') findPanel.style.display='';
    const cntEl=document.getElementById('_raFindCount');
    if(cntEl) cntEl.textContent=discoveredFindings.length;
    const fStatEl=document.getElementById('_raFindStat');
    if(fStatEl) fStatEl.textContent=discoveredFindings.length;
    const list=document.getElementById('_raFindList');
    if(list){
      const item=document.createElement('div');
      item.className='ra-finding-item ra-finding-in';
      const icon=stepIcons[step-1]||'📄';
      item.innerHTML=`<span class="ra-finding-step">${icon}</span><span class="ra-finding-text">${esc(text.length>140?text.slice(0,140)+'…':text)}</span>`;
      list.appendChild(item);
    }
  };

  try{
    // Register abort controller BEFORE fetch so stop button works immediately
    setChatRunning(chatId,true,{type:'research',controller:_raAbort});

    let _raResearchId;
    if(existingResearchId){
      // Cross-device sync: skip POST, use existing research session
      _raResearchId=existingResearchId;
    }else{
      // --- Poll-based architecture: POST to start research, then poll for events ---
      const startResp=await apiFetch('/api/research-agent',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({chat_id:chatId,query:query}),
        signal:_raAbort.signal
      });
      if(!startResp.ok){
        const d=await startResp.json().catch(()=>({error:'Failed to start research'}));
        throw new Error(d.error||'Research failed');
      }
      const _raStartData=await startResp.json();
      _raResearchId=_raStartData.research_id;
      if(!_raResearchId) throw new Error('Server did not return a research_id');
    }

    // Cancel handler: when user clicks stop, also tell server to cancel
    const _cancelHandler=()=>{
      apiFetch('/api/research-agent/cancel',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({research_id:_raResearchId})
      }).catch(()=>{});
    };
    _raAbort.signal.addEventListener('abort',_cancelHandler,{once:true});

    const outEl=document.getElementById('_raOut');
    let currentContentEl=null;
    let stepContent='';
    let stepThinking='';
    let _raThinkDisplayed='';
    let _raThinkTypewriter=null;
    let _raContentDisplayed='';
    let _raContentTypewriter=null;
    let failedSteps=0;
    let followupQuestions=[];
    let _raDoneReceived=false;
    let _pollCursor=0;
    let _pollErrors=0;

    // Poll loop — each request is lightweight and completes in <1s
    while(!_raDoneReceived){
      if(_raAbort.signal.aborted) break;
      await new Promise(r=>setTimeout(r,_pollCursor===0?300:1500));
      if(_raAbort.signal.aborted) break;

      let pollData;
      try{
        const pollResp=await apiFetch('/api/research-agent/poll?id='+encodeURIComponent(_raResearchId)+'&cursor='+_pollCursor);
        if(!pollResp.ok){
          _pollErrors++;
          if(_pollErrors>15) throw new Error('Research polling failed repeatedly');
          continue;
        }
        pollData=await pollResp.json();
        _pollErrors=0;
      }catch(pollErr){
        if(_raAbort.signal.aborted) break;
        _pollErrors++;
        if(_pollErrors>15) throw pollErr;
        await new Promise(r=>setTimeout(r,2000));
        continue;
      }

      _pollCursor=pollData.cursor;

      for(const rawLine of (pollData.events||[])){
        const line=(typeof rawLine==='string'?rawLine:'').trim();
        if(!line) continue;
        let ev;
        try{ev=JSON.parse(line)}catch(e){continue}

        if(ev.type==='agent_start'){
          updateProgress(0,'Starting intelligence gathering on: '+ev.query);
        }else if(ev.type==='agent_step'){
          const icon=ev.icon||stepIcons[(ev.step-1)]||'📄';
          if(ev.status==='running'){
            stepTimers[ev.step]=Date.now();
            if(window._raStepLiveTimer) clearInterval(window._raStepLiveTimer);
            const _liveStep=ev.step;
            window._raStepLiveTimer=setInterval(()=>{
              const tEl=document.getElementById('_raT'+_liveStep);
              if(tEl){tEl.textContent=((Date.now()-stepTimers[_liveStep])/1000|0)+'s';tEl.classList.add('ra-timer-live');}
            },500);
            updateProgress(ev.step-1, icon+' '+ev.title+'...');
            stepContent='';
            stepThinking='';
            _raThinkDisplayed='';
            if(_raThinkTypewriter){clearInterval(_raThinkTypewriter);_raThinkTypewriter=null;}
            _raContentDisplayed='';
            if(_raContentTypewriter){clearInterval(_raContentTypewriter);_raContentTypewriter=null;}
            if(outEl){
              outEl.querySelectorAll('.ra-section').forEach(sec=>{
                const sNum=parseInt(sec.id.replace('_raS',''));
                if(!manualToggles.has(sNum)) sec.classList.add('ra-collapsed');
              });
            }
            // Reuse existing section if retrying (avoid duplicate cards)
            let section=outEl?outEl.querySelector('#_raS'+ev.step):null;
            if(section){
              // Reset existing section for retry
              section.classList.remove('ra-collapsed');
              const stEl=section.querySelector('.ra-section-status');
              if(stEl){stEl.textContent='researching...';stEl.className='ra-section-status ra-running';}
              const ce=section.querySelector('.ra-step-content');
              if(ce) ce.innerHTML='';
            } else {
              section=document.createElement('div');
              section.className='ra-section ra-slide-in';
              section.id='_raS'+ev.step;
              section.innerHTML=`<div class="ra-section-head" onclick="(function(el){var sec=el.parentElement;sec.classList.toggle('ra-collapsed');var n=parseInt(sec.id.replace('_raS',''));if(window._raManualToggles)window._raManualToggles.add(n)})(this)"><span class="ra-section-num">${ev.step}</span><span class="ra-section-title">${esc(ev.title)}</span><span class="ra-section-timer" id="_raT${ev.step}"></span><span class="ra-section-status ra-running">researching...</span><span class="ra-section-chevron">▾</span></div><div class="ra-section-body"><div class="ra-thinking-block ra-thinking-open" id="_raThink${ev.step}" style="display:none"><div class="ra-thinking-toggle" onclick="this.parentElement.classList.toggle('ra-thinking-open')"><span class="ra-thinking-icon">💭</span><span class="ra-thinking-label">${esc(ev.title)}...</span><span class="ra-thinking-chevron">▾</span></div><div class="ra-thinking-content" id="_raThinkC${ev.step}"></div></div><div class="ra-step-content" id="_raC${ev.step}"></div></div>`;
              if(outEl) outEl.appendChild(section);
              showToast(`Step ${ev.step}: ${ev.title}`,icon);
            }
            currentContentEl=section.querySelector('.ra-step-content');
            _raAutoScroll();
          }else if(ev.status==='complete'){
            if(window._raStepLiveTimer){clearInterval(window._raStepLiveTimer);window._raStepLiveTimer=null;}
            completedSteps.add(ev.step);
            // Flush thinking typewriter for this step
            if(_raThinkTypewriter){clearInterval(_raThinkTypewriter);_raThinkTypewriter=null;}
            if(stepThinking){
              _raThinkDisplayed=stepThinking;
              const _flushThC=document.getElementById('_raThinkC'+ev.step);
              if(_flushThC)_flushThC.innerHTML=_fmtThink(stepThinking);
            }
            // Flush content typewriter for this step
            if(_raContentTypewriter){clearInterval(_raContentTypewriter);_raContentTypewriter=null;}
            _raContentDisplayed=stepContent;
            updateProgress(ev.step, '✓ '+ev.title+' complete');
            const statusEl=document.querySelector('#_raS'+ev.step+' .ra-section-status');
            if(statusEl){statusEl.textContent='✓ done';statusEl.className='ra-section-status ra-done';}
            const elapsed=ev.elapsed||(stepTimers[ev.step]?((Date.now()-stepTimers[ev.step])/1000).toFixed(1):null);
            stepElapsed[ev.step]=parseFloat(elapsed)||0;
            if(ev.word_count) stepWordCounts[ev.step]=ev.word_count;
            if(ev.source_count!==undefined) stepSourceCounts[ev.step]=ev.source_count;
            totalWords+=(ev.word_count||0);
            const timerEl=document.getElementById('_raT'+ev.step);
            if(timerEl){timerEl.classList.remove('ra-timer-live');if(elapsed) timerEl.textContent=elapsed+'s';}
            const ce=document.getElementById('_raC'+ev.step);
            if(ce) ce.innerHTML=_raDevRaw?'<pre class="dev-raw-log">'+esc(stepContent)+'</pre>':fmt(stepContent);
            const thEl=document.getElementById('_raThink'+ev.step);
            if(thEl&&stepThinking){
              const lb=thEl.querySelector('.ra-thinking-label');
              if(lb) lb.textContent='View thinking';
            }
            // Auto-collapse completed step
            const completedSection=document.getElementById('_raS'+ev.step);
            if(completedSection&&!manualToggles.has(ev.step)) completedSection.classList.add('ra-collapsed');
            _raAutoScroll();
          }else if(ev.status==='failed'){
            if(window._raStepLiveTimer){clearInterval(window._raStepLiveTimer);window._raStepLiveTimer=null;}
            if(_raThinkTypewriter){clearInterval(_raThinkTypewriter);_raThinkTypewriter=null;}
            if(_raContentTypewriter){clearInterval(_raContentTypewriter);_raContentTypewriter=null;}
            failedSteps++;
            const statusEl=document.querySelector('#_raS'+ev.step+' .ra-section-status');
            if(statusEl){statusEl.textContent='✗ failed';statusEl.className='ra-section-status ra-failed';}
            const elapsed=ev.elapsed||(stepTimers[ev.step]?((Date.now()-stepTimers[ev.step])/1000).toFixed(1):null);
            stepElapsed[ev.step]=parseFloat(elapsed)||0;
            const timerEl=document.getElementById('_raT'+ev.step);
            if(timerEl&&elapsed) timerEl.textContent=elapsed+'s';
            const ce=document.getElementById('_raC'+ev.step);
            if(ce&&ev.error) ce.innerHTML=`<div class="ra-step-error">Step failed: ${esc(ev.error.slice(0,150))}</div>`;
            updateProgress(ev.step, ev.title+' failed — continuing...');
          }
        }else if(ev.type==='agent_thinking'){
          stepThinking+=(ev.text||'');
          const thEl=document.getElementById('_raThink'+ev.step);
          if(thEl){
            thEl.style.display='';
            const thC=document.getElementById('_raThinkC'+ev.step);
            if(thC&&!_raThinkTypewriter){
              _raThinkTypewriter=setInterval(()=>{
                if(_raThinkDisplayed.length>=stepThinking.length){
                  return;
                }
                const end=Math.min(_raThinkDisplayed.length+8,stepThinking.length);
                _raThinkDisplayed=stepThinking.slice(0,end);
                thC.innerHTML=_fmtThink(_raThinkDisplayed);
                thC.parentElement.scrollTop=thC.parentElement.scrollHeight;
              },20);
            }
          }
        }else if(ev.type==='agent_delta'){
          stepContent+=ev.text;
          if(currentContentEl&&!_raContentTypewriter){
            _raContentTypewriter=setInterval(()=>{
              if(_raContentDisplayed.length>=stepContent.length)return;
              const end=Math.min(_raContentDisplayed.length+12,stepContent.length);
              _raContentDisplayed=stepContent.slice(0,end);
              currentContentEl.innerHTML=_raDevRaw?'<pre class="dev-raw-log">'+esc(_raContentDisplayed)+'<span class="stream-cursor"></span></pre>':fmtLive(_raContentDisplayed);
              _raAutoScroll();
            },20);
          }
        }else if(ev.type==='agent_sources'){
          for(const src of (ev.sources||[])){
            if(!discoveredSources.find(s=>s.url.toLowerCase()===src.url.toLowerCase())) addSource(src);
          }
        }else if(ev.type==='agent_findings'){
          for(const f of (ev.findings||[])){
            addFinding(f, ev.step);
          }
        }else if(ev.type==='agent_done'){
          _raDoneReceived=true;
          clearInterval(elTimer);
          if(_raThinkTypewriter){clearInterval(_raThinkTypewriter);_raThinkTypewriter=null;}
          if(_raContentTypewriter){clearInterval(_raContentTypewriter);_raContentTypewriter=null;}
          if(window._raStepLiveTimer){clearInterval(window._raStepLiveTimer);window._raStepLiveTimer=null;}
          updateProgress(totalSteps,'Research complete!');
          followupQuestions=ev.followup_questions||[];
          totalWords=ev.total_words||totalWords;
          const totalTimeMs=Date.now()-startTime;
          const totalTime=(totalTimeMs/1000).toFixed(1);
          const totalTimeFmt=_fmtElapsed(totalTimeMs);
          const elapsedEl=document.getElementById('_raElapsed');
          if(elapsedEl) elapsedEl.textContent=totalTimeFmt;
          const actEl=document.getElementById('_raActivity');
          if(actEl) actEl.innerHTML=`Research complete in <strong>${totalTimeFmt}</strong> — ${discoveredSources.length} sources, ${discoveredFindings.length} findings`;

          // Collapse all sections
          if(outEl) outEl.querySelectorAll('.ra-section').forEach(s=>s.classList.add('ra-collapsed'));

          // Extract TL;DR from final step
          const lastC=document.getElementById('_raC'+totalSteps);
          const reportText=(lastC?lastC.textContent:'').trim();
          let tldr='';
          const tldrMatch=reportText.match(/TL;DR[:\s]*([\s\S]*?)(?=Executive Summary|Key Findings|$)/i);
          if(tldrMatch) tldr=tldrMatch[1].trim().split(/\n\n/)[0].trim();
          if(!tldr){
            const sentences=reportText.split(/(?<=[.!?])\s+/).filter(s=>s.length>15).slice(0,3).join(' ');
            tldr=sentences;
          }

          // Build step timing bars data
          const durations=ev.step_durations||Object.keys(stepElapsed).map(k=>({step:parseInt(k),title:stepNames[parseInt(k)-1]||'Step '+k,elapsed:stepElapsed[k]}));
          const maxDur=Math.max(...durations.map(d=>d.elapsed),1);

          // TL;DR summary card (sa-summary style)
          if(tldr){
            const summaryEl=document.createElement('div');
            summaryEl.className='ra-summary ra-slide-in';
            summaryEl.innerHTML=`<div class="ra-summary-hd">Quick Summary</div><div class="ra-summary-body">${esc(tldr.length>500?tldr.slice(0,500)+'…':tldr)}</div><div class="ra-summary-hint">Click any step below to read the full analysis</div>`;
            if(outEl) outEl.insertBefore(summaryEl,outEl.querySelector('.ra-section'));
          }

          // Build completion dashboard — confidence score (not self-ranked quality)
          // Confidence is based on objective metrics: source count, step completion, depth, findings
          const _srcPct=Math.min(discoveredSources.length/30,1);
          const _stpPct=(totalSteps-failedSteps)/totalSteps;
          const _wrdPct=Math.min(totalWords/8000,1);
          const _fndPct=Math.min(discoveredFindings.length/20,1);
          const confidenceScore=Math.round((_srcPct*30+_stpPct*25+_wrdPct*25+_fndPct*20));
          const confidenceLabel=confidenceScore>=85?'High':confidenceScore>=70?'Good':confidenceScore>=50?'Moderate':confidenceScore>=30?'Low':'Very Low';
          const confidenceColor=confidenceScore>=85?'#22c55e':confidenceScore>=70?'#8b5cf6':confidenceScore>=50?'#eab308':'#ef4444';

          // Source diversity
          const domainCounts={};
          discoveredSources.forEach(s=>{try{const d=new URL(s.url).hostname.replace('www.','');domainCounts[d]=(domainCounts[d]||0)+1}catch(e){}});
          const topDomains=Object.entries(domainCounts).sort((a,b)=>b[1]-a[1]).slice(0,6);
          const maxDomainCount=topDomains.length?topDomains[0][1]:1;

          // SVG confidence gauge
          const _qr=54,_qcx=60,_qcy=60,_qstroke=8;
          const _qcirc=2*Math.PI*_qr;
          const _qarcLen=_qcirc*0.75;
          const _qfilled=_qarcLen*(confidenceScore/100);
          const _qdashArr=`${_qfilled} ${_qarcLen-_qfilled}`;

          const dashboard=document.createElement('div');
          dashboard.className='ra-dashboard ra-slide-in';
          let dashHtml=`<div class="ra-complete-banner"><div class="ra-complete-banner-title">Intelligence Brief Complete</div><div class="ra-complete-banner-sub">${totalSteps-failedSteps} steps completed · ${discoveredSources.length} sources · ${discoveredFindings.length} findings · ${totalTimeFmt}</div></div>`;
          dashHtml+=`<div class="ra-dash-stats">
            <div class="ra-dash-stat"><div class="ra-dash-stat-val">${totalSteps-failedSteps}/${totalSteps}</div><div class="ra-dash-stat-lbl">Steps</div></div>
            <div class="ra-dash-stat"><div class="ra-dash-stat-val">${discoveredSources.length}</div><div class="ra-dash-stat-lbl">Sources</div></div>
            <div class="ra-dash-stat"><div class="ra-dash-stat-val">${discoveredFindings.length}</div><div class="ra-dash-stat-lbl">Findings</div></div>
            <div class="ra-dash-stat"><div class="ra-dash-stat-val">${totalTimeFmt}</div><div class="ra-dash-stat-lbl">Time</div></div>
          </div>`;
          // Source diversity
          if(topDomains.length>0){
            dashHtml+=`<div class="ra-diversity-section"><div class="ra-diversity-hd">🌐 Source Diversity</div><div class="ra-diversity-grid">`;
            topDomains.forEach(([domain,count])=>{
              const pct=Math.round((count/maxDomainCount)*100);
              dashHtml+=`<div class="ra-diversity-row"><img class="ra-diversity-favicon" src="https://www.google.com/s2/favicons?domain=${esc(domain)}&sz=32" alt="" onerror="this.style.display='none'"><span class="ra-diversity-domain">${esc(domain)}</span><div class="ra-diversity-bar-track"><div class="ra-diversity-bar-fill" style="width:${pct}%"></div></div><span class="ra-diversity-count">${count}</span></div>`;
            });
            dashHtml+=`</div></div>`;
          }
          // Step timing chart
          if(durations.length){
            dashHtml+=`<div class="ra-timing-section"><div class="ra-timing-hd">Step Performance</div><div class="ra-timing-chart">`;
            durations.forEach(d=>{
              const pct=Math.round((d.elapsed/maxDur)*100);
              const sIcon=stepIcons[(d.step||1)-1]||'📄';
              dashHtml+=`<div class="ra-timing-row"><span class="ra-timing-label">${sIcon} ${esc(d.title)}</span><div class="ra-timing-bar-track"><div class="ra-timing-bar-fill" style="width:${pct}%"></div></div><span class="ra-timing-val">${d.elapsed}s</span></div>`;
            });
            dashHtml+=`</div></div>`;
          }
          dashboard.innerHTML=dashHtml;
          if(outEl) outEl.insertBefore(dashboard,outEl.querySelector('.ra-summary')||outEl.querySelector('.ra-section'));

          // Search box
          const searchEl=document.createElement('div');
          searchEl.className='ra-search-wrap';
          searchEl.innerHTML=`<input class="ra-search-input" type="text" placeholder="🔍 Search within results..." oninput="(function(inp){var q=inp.value.toLowerCase().trim();var out=document.getElementById('_raOut');if(!out)return;out.querySelectorAll('.ra-section').forEach(function(s){var body=s.querySelector('.ra-step-content');if(!body)return;if(!q){s.style.display='';return}var txt=body.textContent.toLowerCase();if(txt.includes(q)){s.style.display='';s.classList.remove('ra-collapsed')}else{s.style.display='none'}})})(this)">`;

          // Action bar
          const actionBar=document.createElement('div');
          actionBar.className='ra-actions';
          window._raCopyReport=function(){var el=document.getElementById('_raOut');if(!el)return;var t='';el.querySelectorAll('.ra-section').forEach(function(s){var h=s.querySelector('.ra-section-title');var b=s.querySelector('.ra-step-content');t+='## '+(h?h.textContent:'')+String.fromCharCode(10)+(b?b.textContent:'')+String.fromCharCode(10,10)});navigator.clipboard.writeText(t).then(function(){})};
          actionBar.innerHTML=`<button class="ra-action-btn ra-action-primary" onclick="window._raRetry(this)">Re-research</button><button class="ra-action-btn" onclick="(function(){var out=document.getElementById('_raOut');if(out)out.querySelectorAll('.ra-section').forEach(function(s){s.classList.remove('ra-collapsed')})})(this)">Expand All</button><button class="ra-action-btn" onclick="(function(){var out=document.getElementById('_raOut');if(out)out.querySelectorAll('.ra-section').forEach(function(s){s.classList.add('ra-collapsed')})})(this)">Collapse All</button><button class="ra-action-btn" onclick="(function(btn){window._raCopyReport();btn.textContent='Copied!';setTimeout(function(){btn.textContent='Copy Report'},1500)})(this)">Copy Report</button>`;

          // Update badge
          const badge=document.getElementById('_raBadge');
          if(badge){badge.classList.add('ra-badge-done');badge.textContent='Research Complete \u2014 '+totalTimeFmt;}

          if(outEl){
            outEl.appendChild(searchEl);
            outEl.appendChild(actionBar);
          }
          showToast('Research complete!','✅');
          _raAutoScroll();
          // Auto-follow-up is triggered AFTER poll loop ends (see below)
          // to ensure research save is committed before continuation loads the chat.
        }else if(ev.type==='heartbeat'){
          // Keepalive from server — ignore, just prevents connection timeout
        }else if(ev.type==='agent_error'){
          // Fatal server-side error during research
          clearInterval(elTimer);
          if(window._raStepLiveTimer){clearInterval(window._raStepLiveTimer);window._raStepLiveTimer=null;}
          const badge=document.getElementById('_raBadge');
          if(badge){badge.classList.add('ra-badge-done');badge.textContent='❌ Research Error';}
          const actEl=document.getElementById('_raActivity');
          if(actEl) actEl.innerHTML=`<span>Server error: ${esc((ev.error||'Unknown error').slice(0,150))}</span>`;
          contentEl.querySelectorAll('.ra-section-status.ra-running').forEach(el=>{el.textContent='✗ error';el.className='ra-section-status ra-failed';});
        }
      }

      if(pollData.done) break;
    }

    // Poll ended — check if we got a proper completion
    if(!_raDoneReceived){
      if(_raAbort.signal.aborted){
        window._raAutoRetryCount=0;
        const badge=document.getElementById('_raBadge');
        if(badge){badge.classList.add('ra-badge-done');badge.textContent='Research Cancelled';}
        const actEl=document.getElementById('_raActivity');
        if(actEl) actEl.innerHTML='<span>Research cancelled by user.</span>';
        contentEl.querySelectorAll('.ra-section-status.ra-running').forEach(el=>{el.textContent='cancelled';el.className='ra-section-status ra-failed';});
      }else{
        const totalTimeFmtEnd=_fmtElapsed(Date.now()-startTime);
        const badge=document.getElementById('_raBadge');
        if(badge){badge.classList.add('ra-badge-done');badge.textContent='Research Interrupted \u2014 '+totalTimeFmtEnd;}
        const actEl=document.getElementById('_raActivity');
        if(actEl) actEl.innerHTML=`<span>Research ended unexpectedly. <button class="ra-action-btn ra-action-primary" style="display:inline;margin-left:8px;padding:4px 12px;font-size:12px" onclick="window._raAutoRetryCount=0;window._raRetry(this)">Retry</button></span>`;
        contentEl.querySelectorAll('.ra-section-status.ra-running').forEach(el=>{el.textContent='⚠ interrupted';el.className='ra-section-status ra-failed';});
      }
    }

    // Auto-trigger AI follow-up AFTER poll loop ends (research save is committed)
    if(_raDoneReceived&&!_raAbort.signal.aborted){
      const _raReportText=(function(){var t='';var el=document.getElementById('_raOut');if(!el)return '';el.querySelectorAll('.ra-section').forEach(function(s){var h=s.querySelector('.ra-section-title');var b=s.querySelector('.ra-step-content');t+='## '+(h?h.textContent:'')+'\n'+(b?b.textContent:'')+'\n\n';});return t;})();
      const _raFollowTid=setTimeout(()=>{
        if(isChatRunning(chatId))return;
        sendMessage({
          silent: true,
          noThinking: false,
          message: `[SYSTEM] Deep research on "${query}" has been completed with ${discoveredSources.length} sources, ${discoveredFindings.length} findings across ${totalSteps-failedSteps} steps.\n\nHere is the full comprehensive report from the research:\n\n${_raReportText}\n\nThe user's original request was: "${query}"\n\nNow continue helping the user with their original request. Use the comprehensive report above as your knowledge base. Focus on any remaining parts of the user's request (e.g., creating documents, images, mind maps, PDFs, or answering follow-up questions using <<<CODE_EXECUTE: python>>> if needed). Do NOT summarize the research back to the user — it is already visible. Instead, proceed directly with executing whatever the user originally asked for.`,
          targetChat: chatId
        });
      }, 1500);
      const _pListR=_pendingReprompts.get(chatId)||[];_pListR.push(_raFollowTid);_pendingReprompts.set(chatId,_pListR);
    }
  }catch(e){
    const isAbort=e.name==='AbortError'||_raAbort.signal.aborted;
    if(isAbort){
      window._raAutoRetryCount=0;
      const badge=document.getElementById('_raBadge');
      if(badge){badge.classList.add('ra-badge-done');badge.textContent='Research Cancelled';}
      const actEl=document.getElementById('_raActivity');
      if(actEl) actEl.innerHTML='<span>Research cancelled by user.</span>';
      contentEl.querySelectorAll('.ra-section-status.ra-running').forEach(el=>{el.textContent='cancelled';el.className='ra-section-status ra-failed';});
    }else{
      const totalTimeFmtEnd=_fmtElapsed(Date.now()-startTime);
      const badge=document.getElementById('_raBadge');
      if(badge){badge.classList.add('ra-badge-done');badge.textContent='Research Failed \u2014 '+totalTimeFmtEnd;}
      contentEl.innerHTML+=`<div style="color:var(--red);margin-top:12px;padding:12px;border:1px solid rgba(239,68,68,.3);border-radius:8px;background:rgba(239,68,68,.05)">Research failed: ${esc(e.message||'Unknown error')}<br><button class="ra-action-btn ra-action-primary" style="display:inline;margin-top:8px;padding:4px 12px;font-size:12px" onclick="window._raAutoRetryCount=0;window._raRetry(this)">Retry</button></div>`;
      setStatus('Research failed.');
    }
  }finally{
    // Always clean up regardless of how the research ended
    clearInterval(elTimer);
    if(window._raStepLiveTimer){clearInterval(window._raStepLiveTimer);window._raStepLiveTimer=null;}
    area.removeEventListener('scroll',_raOnScroll);
    setChatRunning(chatId,false);
  }
}

// --- Stock Analysis Helpers -----------------------
function _saParseRating(text){
  if(!text)return{label:'Hold',score:50};
  // Try to extract numeric rating X/100 from the text
  const numMatch=text.match(/Rating[:\s]*(\d{1,3})\s*\/\s*100/i)||text.match(/(\d{1,3})\s*\/\s*100/);
  if(numMatch){
    const n=Math.max(1,Math.min(100,parseInt(numMatch[1])));
    let label;
    if(n>=90) label='Strong Buy';
    else if(n>=75) label='Buy';
    else if(n>=60) label='Lean Buy';
    else if(n>=45) label='Hold';
    else if(n>=30) label='Lean Sell';
    else if(n>=15) label='Sell';
    else label='Strong Sell';
    return{label,score:n};
  }
  // Fallback: regex-based
  const t=text.toLowerCase();
  if(/strong\s*buy|very bullish/i.test(text))return{label:'Strong Buy',score:92};
  if(/lean\s*buy/i.test(text))return{label:'Lean Buy',score:67};
  if(/\bbuy\b|bullish|outperform|overweight/i.test(text))return{label:'Buy',score:80};
  if(/strong\s*sell|very bearish/i.test(text))return{label:'Strong Sell',score:8};
  if(/lean\s*sell/i.test(text))return{label:'Lean Sell',score:37};
  if(/\bsell\b|bearish|underperform|underweight/i.test(text))return{label:'Sell',score:22};
  if(/\bhold\b|neutral/i.test(text))return{label:'Hold',score:50};
  return{label:'Hold',score:50};
}

function _saParseStockRatings(text){
  // Extract <<<STOCK_RATINGS>>> JSON block from AI text
  if(!text)return null;
  const m=text.match(/<<<STOCK_RATINGS>>>\s*([\s\S]*?)\s*<<<END_STOCK_RATINGS>>>/);
  if(!m)return null;
  try{
    const data=JSON.parse(m[1].trim());
    if(data&&data.ratings)return data;
  }catch(e){}
  return null;
}

function _scoreToLabel(n){
  if(n>=90)return'Strong Buy';
  if(n>=75)return'Buy';
  if(n>=60)return'Lean Buy';
  if(n>=45)return'Hold';
  if(n>=30)return'Lean Sell';
  if(n>=15)return'Sell';
  return'Strong Sell';
}

function _buildGaugeHTML(pct,label,title){
  const color=pct>=75?'#22c55e':pct>=60?'#86efac':pct>=45?'#eab308':pct>=30?'#f97316':'#ef4444';
  const r=54,cx=60,cy=60,stroke=8;
  const circ=2*Math.PI*r;
  const gapFrac=0.25;
  const arcLen=circ*(1-gapFrac);
  const filled=arcLen*(pct/100);
  // Offset rotates start to bottom-left of gap; gap is centered at top
  const offset=-circ*0.125;
  return `<div class="sa-gauge-arc"><svg viewBox="0 0 120 120" width="160" height="160"><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--border)" stroke-width="${stroke}" stroke-dasharray="${arcLen} ${circ}" stroke-dashoffset="${offset}"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-dasharray="${filled} ${circ}" stroke-dashoffset="${offset}" class="sa-gauge-arc-fill"/><text x="${cx}" y="${cy-4}" text-anchor="middle" fill="${color}" font-size="24" font-weight="800" font-family="var(--mono)">${pct}</text><text x="${cx}" y="${cy+12}" text-anchor="middle" fill="var(--text-muted)" font-size="9" font-weight="600">/100</text></svg><div class="sa-gauge-verdict" style="color:${color}">${esc(label)}</div></div>`;
}

function buildSentimentGauge(rating, stockDataArr, lastStepText){
  if(!rating)return'';
  // Parse AI's structured ratings if available
  const aiRatings=_saParseStockRatings(lastStepText);
  const stocks=(stockDataArr||[]).filter(d=>!d.error);
  if(stocks.length>1){
    const _extractSnippet=(ticker,text)=>{
      if(!text)return'';
      const lines=text.split('\n');
      for(const line of lines){
        if(line.toUpperCase().includes(ticker.toUpperCase())&&line.replace(/[#*_`|>\-\[\]()]/g,' ').trim().length>20){
          let clean=line.replace(/^[-•*#>\s]+/,'').replace(/[*_`]/g,'').trim();
          if(clean.length>120)clean=clean.slice(0,120)+'…';
          return clean;
        }
      }
      return'';
    };
    let panels='';
    for(let i=0;i<stocks.length;i++){
      const sd=stocks[i];
      const ticker=sd.ticker||'?';
      // Use AI rating if available, otherwise fall back to health score
      let hs=sd.health&&sd.health.score!=null?sd.health.score:50;
      if(aiRatings&&aiRatings.ratings&&aiRatings.ratings[ticker]){
        hs=Math.max(1,Math.min(100,aiRatings.ratings[ticker].score||hs));
      }
      const label=_scoreToLabel(hs);
      const hidden=i===0?'':'display:none;';
      const color=hs>=75?'#22c55e':hs>=60?'#86efac':hs>=45?'#eab308':hs>=30?'#f97316':'#ef4444';
      const bgGrad=hs>=75?'linear-gradient(135deg,rgba(34,197,94,.08),rgba(34,197,94,.02))':hs>=45?'linear-gradient(135deg,rgba(234,179,8,.08),rgba(234,179,8,.02))':'linear-gradient(135deg,rgba(239,68,68,.08),rgba(239,68,68,.02))';
      const snippet=_extractSnippet(ticker,lastStepText);
      panels+=`<div class="sa-gauge-panel" data-sa-ticker="${esc(ticker)}" style="${hidden}background:${bgGrad};border-radius:var(--r-sm);padding:12px">${_buildGaugeHTML(hs,label,ticker)}<div class="sa-gauge-bar"><div class="sa-gauge-marker" style="left:${hs}%"><div class="sa-gauge-marker-dot" style="background:${color}"></div></div></div><div class="sa-gauge-labels"><span>Strong Sell</span><span>Sell</span><span>Hold</span><span>Buy</span><span>Strong Buy</span></div>${snippet?`<div class="sa-gauge-snippet">${esc(snippet)}</div>`:''}</div>`;
    }
    return`<div class="sa-extras"><div class="sa-gauge-wrap"><div class="sa-gauge-title">📊 Per-Stock Sentiment</div>${panels}</div></div>`;
  }
  // Single stock — use AI rating if available
  let pct=Math.max(0,Math.min(100,rating.score));
  if(aiRatings&&aiRatings.ratings){
    const keys=Object.keys(aiRatings.ratings);
    if(keys.length===1&&aiRatings.ratings[keys[0]].score){
      pct=Math.max(1,Math.min(100,aiRatings.ratings[keys[0]].score));
    }
  }
  const sLabel=_scoreToLabel(pct);
  const color=pct>=75?'#22c55e':pct>=60?'#86efac':pct>=45?'#eab308':pct>=30?'#f97316':'#ef4444';
  const bgGrad=pct>=75?'linear-gradient(135deg,rgba(34,197,94,.08),rgba(34,197,94,.02))':pct>=45?'linear-gradient(135deg,rgba(234,179,8,.08),rgba(234,179,8,.02))':'linear-gradient(135deg,rgba(239,68,68,.08),rgba(239,68,68,.02))';
  return`<div class="sa-extras"><div class="sa-gauge-wrap" style="background:${bgGrad}"><div class="sa-gauge-title">📊 Overall Sentiment</div>${_buildGaugeHTML(pct,esc(sLabel),'')}<div class="sa-gauge-bar"><div class="sa-gauge-marker" style="left:${pct}%"><div class="sa-gauge-marker-dot" style="background:${color}"></div></div></div><div class="sa-gauge-labels"><span>Strong Sell</span><span>Sell</span><span>Hold</span><span>Buy</span><span>Strong Buy</span></div></div></div>`;
}

function buildGrowthChart(stockDataArr){
  if(!stockDataArr||!stockDataArr.length)return'';
  let html='<div class="sa-growth-wrap sa-growth-collapsed"><div class="sa-growth-header" onclick="this.parentElement.classList.toggle(\'sa-growth-collapsed\')"><div class="sa-growth-title">Key Metrics Comparison</div><span class="sa-growth-chevron">📈</span></div><div class="sa-growth-body">';
  for(let si=0;si<stockDataArr.length;si++){
    const sd=stockDataArr[si];
    const ticker=sd.ticker||'?';
    const h=sd.health||{};
    const p=sd.perf||{};
    if(si>0)html+='<div class="sa-growth-divider"></div>';
    html+=`<div class="sa-growth-ticker"><div class="sa-growth-ticker-label">${esc(ticker)}</div>`;
    const metrics=[
      {label:'Revenue Growth',key:'revenueGrowth',src:h},
      {label:'Earnings Growth',key:'earningsGrowth',src:h},
      {label:'Profit Margin',key:'profitMargin',src:h},
      {label:'ROE',key:'returnOnEquity',src:h},
      {label:'YTD Performance',key:'ytd',src:p,isRaw:true},
    ];
    for(const m of metrics){
      const raw=m.src[m.key];
      if(raw==null||raw===undefined)continue;
      const val=m.isRaw?(typeof raw==='number'?raw:parseFloat(raw)):(typeof raw==='number'?raw*100:parseFloat(raw));
      if(isNaN(val))continue;
      const clamped=Math.max(-100,Math.min(100,val));
      const barPct=Math.abs(clamped)/2;
      const color=val>=0?'#22c55e':'#ef4444';
      const sign=val>=0?'+':'';
      html+=`<div class="sa-growth-row"><span class="sa-growth-label">${m.label}</span><div class="sa-growth-bar-track"><div class="sa-growth-bar-fill" style="width:${barPct}%;background:${color}"></div></div><span class="sa-growth-value" style="color:${color}">${sign}${val.toFixed(1)}%</span></div>`;
    }
    html+='</div>';
  }
  html+='</div></div>';
  return html;
}

// --- Stock Analysis Agent -------------------------
async function runStockAgent(stockDataArray, userQuery, contentEl, chatArea, chatId, existingStockAgentId){
  const stepIcons=['🔍','📊','📰','📉','💰','🔬','⚠','🎯','🔎','🏆','💰'];
  const stepNames=['Stock Screening','Market Snapshot','News & Headlines','Technical Analysis','Fundamental Deep Dive','Deep Research','Risk & Ownership','Valuation & Price Targets','Winner Deep Dive','Final Verdict','Buying Plan'];
  const totalSteps=11;
  let currentStep=0;
  const stepTimers={};
  const stepElapsed={};
  const manualToggles=new Set();
  const completedSteps=new Set();
  window._saManualToggles=manualToggles;
  let startTime=Date.now();

  // AbortController so stop button can cancel stock analysis
  const _saController=new AbortController();
  setChatRunning(chatId,true,{type:'stock_agent',controller:_saController});

  const stepsHtml=stepNames.map((name,i)=>`<div class="sa-step" data-sa="${i}"><div class="sa-step-dot" onclick="saScrollToStep(${i+1})">${stepIcons[i]}</div><div class="sa-step-label">${name}</div></div>`).join('');

  const tickers=stockDataArray.map(d=>d.ticker||'?').filter(t=>t!=='?');
  const tickerStr=tickers.join(', ');
  const shortTitle=tickers.length?tickers.join(', ')+' Analysis':'Stock Analysis';

  contentEl.innerHTML=`
    <div class="sa-container">
      <div class="sa-badge" id="_saBadge">📊 Stock Analysis — In Progress${tickerStr?' — '+esc(tickerStr):''}</div>
      <div class="sa-progress">
        <div class="sa-header">
          <span class="sa-title">${esc(shortTitle)}</span>
          <span class="sa-pct" id="_saPct">0%</span>
        </div>
        <div class="sa-bar-track"><div class="sa-bar-fill" id="_saBar" style="width:0%"></div></div>
        <div class="sa-steps" id="_saSteps">
          <div class="sa-steps-line"><div class="sa-steps-line-fill" id="_saLine" style="width:0%"></div></div>
          ${stepsHtml}
        </div>
        <div class="sa-activity" id="_saActivity"><span class="sa-activity-dot"></span><span id="_saMsg">Initializing stock analysis...</span></div>
      </div>
      <div class="sa-output" id="_saOut"></div>
    </div>`;
  if(window._chatAutoScroll)window._chatAutoScroll();

  const elTimer=setInterval(()=>{
    // Live elapsed timer per active step
    for(const[s,st] of Object.entries(stepTimers)){
      if(!completedSteps.has(+s)){
        const dur=((Date.now()-st)/1000).toFixed(1);
        const tEl=document.getElementById('_saT'+s);
        if(tEl) tEl.textContent=dur+'s';
      }
    }
    // Update total elapsed
    const totalEl=document.getElementById('_saMsg');
    if(totalEl&&currentStep>0){
      const t=((Date.now()-startTime)/1000|0);
      const mins=Math.floor(t/60);
      const secs=t%60;
      const timeStr=mins>0?mins+'m '+secs+'s':t+'s';
      totalEl.textContent=stepNames[currentStep]?stepIcons[currentStep]+' '+stepNames[currentStep]+'... ('+timeStr+')':'Working... ('+timeStr+')';
    }
  },1000);

  window.saScrollToStep=function(stepNum){
    const section=document.getElementById('_saS'+stepNum);
    if(!section)return;
    const outEl=document.getElementById('_saOut');
    if(outEl){
      outEl.querySelectorAll('.sa-section').forEach(sec=>{
        const sNum=parseInt(sec.id.replace('_saS',''));
        if(sNum===stepNum) sec.classList.remove('sa-collapsed');
        else sec.classList.add('sa-collapsed');
        manualToggles.add(sNum);
      });
    }
    section.scrollIntoView({behavior:'smooth',block:'nearest'});
  };

  const updateProgress=(step,msg)=>{
    currentStep=step;
    const pct=Math.round((step/totalSteps)*100);
    const barEl=document.getElementById('_saBar');
    const lineEl=document.getElementById('_saLine');
    const msgEl=document.getElementById('_saMsg');
    const pctEl=document.getElementById('_saPct');
    if(barEl) barEl.style.width=pct+'%';
    if(pctEl) pctEl.textContent=pct+'%';
    if(lineEl) lineEl.style.width=Math.min((step/(totalSteps-1))*100,100)+'%';
    if(msgEl) msgEl.textContent=msg||'Working...';
    const stepsEl=document.getElementById('_saSteps');
    if(stepsEl){
      stepsEl.querySelectorAll('.sa-step').forEach((dot,i)=>{
        const stepNum=i+1;
        const isDone=completedSteps.has(stepNum);
        const isActive=stepNum===step+1||(stepNum===step&&!isDone);
        dot.className='sa-step'+(isDone?' done':(isActive?' active':''));
        const inner=dot.querySelector('.sa-step-dot');
        if(inner) inner.textContent=isDone?'✓':stepIcons[i];
      });
    }
  };

  try{
    let _saStockAgentId;
    if(existingStockAgentId){
      // Cross-device sync: skip POST, use existing stock agent session
      _saStockAgentId=existingStockAgentId;
    }else{
      const response=await apiFetch('/api/stock-agent',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({chat_id:chatId,stock_data:stockDataArray,query:userQuery}),
        signal:_saController.signal
      });
      if(!response.ok){
        const d=await response.json().catch(()=>({error:'Failed to start stock analysis'}));
        throw new Error(d.error||'Stock analysis failed');
      }
      const startData=await response.json();
      _saStockAgentId=startData.stock_agent_id;
      if(!_saStockAgentId) throw new Error('Server did not return a stock_agent_id');
    }

    // Cancel handler: when user clicks stop, also tell server to cancel
    const _saCancelHandler=()=>{
      apiFetch('/api/stock-agent/cancel',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({stock_agent_id:_saStockAgentId})
      }).catch(()=>{});
    };
    _saController.signal.addEventListener('abort',_saCancelHandler,{once:true});

    const outEl=document.getElementById('_saOut');
    let currentContentEl=null;
    let stepContent='';
    let stepThinking='';
    let _saThinkDisplayed='';
    let _saThinkTypewriter=null;
    let _saContentDisplayed='';
    let _saContentTypewriter=null;
    let failedSteps=0;
    let lastStepText='';
    let verdictStepText='';
    let allStepTexts={};
    let _saDoneReceived=false;
    let _pollCursor=0;
    let _pollErrors=0;

    // Poll loop — same pattern as research agent
    while(!_saDoneReceived){
      if(_saController.signal.aborted) break;
      await new Promise(r=>setTimeout(r,_pollCursor===0?300:1500));
      if(_saController.signal.aborted) break;

      let pollData;
      try{
        const pollResp=await apiFetch('/api/stock-agent/poll?id='+encodeURIComponent(_saStockAgentId)+'&cursor='+_pollCursor);
        if(!pollResp.ok){
          _pollErrors++;
          if(_pollErrors>15) throw new Error('Stock analysis polling failed repeatedly');
          continue;
        }
        pollData=await pollResp.json();
        _pollErrors=0;
      }catch(pollErr){
        if(_saController.signal.aborted) break;
        _pollErrors++;
        if(_pollErrors>15) throw pollErr;
        await new Promise(r=>setTimeout(r,2000));
        continue;
      }

      _pollCursor=pollData.cursor;

      for(const rawLine of (pollData.events||[])){
        const line=(typeof rawLine==='string'?rawLine:'').trim();
        if(!line) continue;
        let ev;
        try{ev=JSON.parse(line)}catch(e){continue}

        if(ev.type==='agent_start'){
          updateProgress(0,'Starting stock analysis for: '+(ev.tickers||[]).join(', '));
        }else if(ev.type==='agent_step'){
          const icon=stepIcons[(ev.step-1)]||'📄';
          if(ev.status==='running'){
            stepTimers[ev.step]=Date.now();
            updateProgress(ev.step-1, icon+' '+ev.title+'...');
            stepContent='';
            stepThinking='';
            _saThinkDisplayed='';
            if(_saThinkTypewriter){clearInterval(_saThinkTypewriter);_saThinkTypewriter=null;}
            _saContentDisplayed='';
            if(_saContentTypewriter){clearInterval(_saContentTypewriter);_saContentTypewriter=null;}
            if(outEl){
              outEl.querySelectorAll('.sa-section').forEach(sec=>{
                const sNum=parseInt(sec.id.replace('_saS',''));
                if(!manualToggles.has(sNum)) sec.classList.add('sa-collapsed');
              });
            }
            const section=document.createElement('div');
            section.className='sa-section sa-slide-in';
            section.id='_saS'+ev.step;
            section.innerHTML=`<div class="sa-section-head" onclick="(function(el){var sec=el.parentElement;sec.classList.toggle('sa-collapsed');var n=parseInt(sec.id.replace('_saS',''));if(window._saManualToggles)window._saManualToggles.add(n)})(this)"><span class="sa-section-num">${ev.step}</span><span class="sa-section-title">${esc(ev.title)}</span><span class="sa-section-timer" id="_saT${ev.step}"></span><span class="sa-section-status sa-running">analyzing...</span><span class="sa-section-chevron">▾</span></div><div class="sa-section-body"><div class="sa-thinking-block sa-thinking-open" id="_saThink${ev.step}" style="display:none"><div class="sa-thinking-toggle" onclick="this.parentElement.classList.toggle('sa-thinking-open')"><span class="sa-thinking-icon">💭</span><span class="sa-thinking-label">Thinking...</span><span class="sa-thinking-chevron">▾</span></div><div class="sa-thinking-content" id="_saThinkC${ev.step}"></div></div><div class="sa-step-content" id="_saC${ev.step}"></div></div>`;
            if(outEl) outEl.appendChild(section);
            currentContentEl=section.querySelector('.sa-step-content');
            if(window._chatAutoScroll)window._chatAutoScroll();
          }else if(ev.status==='complete'){
            completedSteps.add(ev.step);
            // Flush thinking typewriter for this step
            if(_saThinkTypewriter){clearInterval(_saThinkTypewriter);_saThinkTypewriter=null;}
            if(stepThinking){
              _saThinkDisplayed=stepThinking;
              const _flushThC=document.getElementById('_saThinkC'+ev.step);
              if(_flushThC)_flushThC.innerHTML=_fmtThink(stepThinking);
            }
            // Flush content typewriter for this step
            if(_saContentTypewriter){clearInterval(_saContentTypewriter);_saContentTypewriter=null;}
            _saContentDisplayed=stepContent;
            updateProgress(ev.step, '✓ '+ev.title+' complete');
            const statusEl=document.querySelector('#_saS'+ev.step+' .sa-section-status');
            if(statusEl){statusEl.textContent='✓ done';statusEl.className='sa-section-status sa-done';}
            const elapsed=ev.elapsed||(stepTimers[ev.step]?((Date.now()-stepTimers[ev.step])/1000).toFixed(1):null);
            stepElapsed[ev.step]=parseFloat(elapsed)||0;
            const timerEl=document.getElementById('_saT'+ev.step);
            if(timerEl&&elapsed) timerEl.textContent=elapsed+'s';
            const ce=document.getElementById('_saC'+ev.step);
            if(ce) ce.innerHTML=fmt(stepContent);
            lastStepText=stepContent;
            allStepTexts[ev.step]=stepContent;
            // Track the Final Verdict step specifically for ratings (step 10 = index before Buying Plan)
            if(ev.title==='Final Verdict')verdictStepText=stepContent;
            const thEl=document.getElementById('_saThink'+ev.step);
            if(thEl&&stepThinking){
              const lb=thEl.querySelector('.sa-thinking-label');
              if(lb) lb.textContent='View thinking';
            }
            if(window._chatAutoScroll)window._chatAutoScroll();
          }else if(ev.status==='failed'){
            if(_saThinkTypewriter){clearInterval(_saThinkTypewriter);_saThinkTypewriter=null;}
            if(_saContentTypewriter){clearInterval(_saContentTypewriter);_saContentTypewriter=null;}
            failedSteps++;
            const statusEl=document.querySelector('#_saS'+ev.step+' .sa-section-status');
            if(statusEl){statusEl.textContent='✗ failed';statusEl.className='sa-section-status sa-failed';}
            const elapsed=ev.elapsed||(stepTimers[ev.step]?((Date.now()-stepTimers[ev.step])/1000).toFixed(1):null);
            stepElapsed[ev.step]=parseFloat(elapsed)||0;
            const timerEl=document.getElementById('_saT'+ev.step);
            if(timerEl&&elapsed) timerEl.textContent=elapsed+'s';
            const ce=document.getElementById('_saC'+ev.step);
            if(ce&&ev.error) ce.innerHTML=`<div class="sa-step-error">Step failed: ${esc(ev.error.slice(0,150))}</div>`;
            updateProgress(ev.step, ''+ev.title+' failed — continuing...');
          }
        }else if(ev.type==='agent_thinking'){
          stepThinking+=(ev.text||'');
          const thEl=document.getElementById('_saThink'+ev.step);
          if(thEl){
            thEl.style.display='';
            const thC=document.getElementById('_saThinkC'+ev.step);
            if(thC&&!_saThinkTypewriter){
              _saThinkTypewriter=setInterval(()=>{
                if(_saThinkDisplayed.length>=stepThinking.length){
                  return;
                }
                const end=Math.min(_saThinkDisplayed.length+8,stepThinking.length);
                _saThinkDisplayed=stepThinking.slice(0,end);
                thC.innerHTML=_fmtThink(_saThinkDisplayed);
                thC.parentElement.scrollTop=thC.parentElement.scrollHeight;
              },20);
            }
          }
        }else if(ev.type==='agent_delta'){
          stepContent+=ev.text;
          if(currentContentEl&&!_saContentTypewriter){
            _saContentTypewriter=setInterval(()=>{
              if(_saContentDisplayed.length>=stepContent.length)return;
              const end=Math.min(_saContentDisplayed.length+12,stepContent.length);
              _saContentDisplayed=stepContent.slice(0,end);
              currentContentEl.innerHTML=fmtLive(_saContentDisplayed);
              if(window._chatAutoScroll)window._chatAutoScroll();
            },20);
          }
        }else if(ev.type==='agent_done'){
          clearInterval(elTimer);
          if(_saThinkTypewriter){clearInterval(_saThinkTypewriter);_saThinkTypewriter=null;}
          if(_saContentTypewriter){clearInterval(_saContentTypewriter);_saContentTypewriter=null;}
          updateProgress(totalSteps,'Stock analysis complete!');
          const totalTime=((Date.now()-startTime)/1000).toFixed(1);

          const actEl=document.getElementById('_saActivity');
          if(actEl) actEl.innerHTML=`<span style="color:#22c55e">✅</span> Analysis complete in <strong>${totalTime}s</strong>`;

          // Collapse all sections
          if(outEl) outEl.querySelectorAll('.sa-section').forEach(s=>s.classList.add('sa-collapsed'));

          // Parse rating from Final Verdict step (not Buying Plan) and build combined overview card
          const ratingText=verdictStepText||lastStepText;
          const rating=_saParseRating(ratingText);
          const aiRatings=_saParseStockRatings(ratingText);
          const gaugeHtml=buildSentimentGauge(rating, stockDataArray, ratingText);
          const chartHtml=buildGrowthChart(stockDataArray);
          const plainLast=(ratingText||'').replace(/<<<STOCK_RATINGS>>>[\s\S]*?<<<END_STOCK_RATINGS>>>/g,'').replace(/[#*_`|>\-\[\]()]/g,' ').replace(/\s+/g,' ').trim();
          const sentences=plainLast?plainLast.split(/(?<=[.!?])\s+/).filter(s=>s.length>15).slice(0,3).join(' '):'';

          if(outEl){
            const overview=document.createElement('div');
            overview.className='sa-overview-card sa-slide-in';
            let ovHtml='';

            // Mini stock cards summary — clickable to switch gauge panels
            if(stockDataArray&&stockDataArray.length){
              ovHtml+='<div class="sa-mini-cards">';
              for(let si=0;si<stockDataArray.length;si++){
                const sd=stockDataArray[si];
                if(sd.error)continue;
                const up=(sd.change||0)>=0;
                const arrow=up?'▲':'▼';
                const cls=up?'stock-up':'stock-down';
                // Use AI rating if available, fall back to health score
                let hs=sd.health&&sd.health.score;
                let vLabel={buy:'BUY',hold:'HOLD',sell:'SELL'}[sd.verdict||'hold']||'HOLD';
                if(aiRatings&&aiRatings.ratings&&aiRatings.ratings[sd.ticker]){
                  const ar=aiRatings.ratings[sd.ticker];
                  hs=ar.score||hs;
                  if(ar.verdict)vLabel={buy:'BUY',hold:'HOLD',sell:'SELL'}[ar.verdict.toLowerCase()]||vLabel;
                }
                const hColor=hs!=null?(hs>=65?'#22c55e':hs>=40?'#eab308':'#ef4444'):'var(--text-muted)';
                const vCls=vLabel==='BUY'?'sa-mini-buy':vLabel==='SELL'?'sa-mini-sell':'sa-mini-hold';
                const activeClass=si===0?' sa-mini-card-active':'';
                const companyName=sd.name||'';
                ovHtml+=`<div class="sa-mini-card ${vCls}${activeClass}" data-sa-card-idx="${si}" data-sa-ticker="${esc(sd.ticker||'?')}" onclick="(function(card){var wrap=card.closest('.sa-overview-card');if(!wrap)return;wrap.querySelectorAll('.sa-mini-card').forEach(function(c){c.classList.remove('sa-mini-card-active')});card.classList.add('sa-mini-card-active');var panels=wrap.querySelectorAll('.sa-gauge-panel');panels.forEach(function(p,j){p.style.display=j==card.dataset.saCardIdx?'':'none'});})(this)"><div class="sa-mini-card-head"><span class="sa-mini-ticker">${esc(sd.ticker||'?')}</span><span class="sa-mini-verdict">${vLabel}</span></div>${companyName?`<div class="sa-mini-company">${esc(companyName)}</div>`:''}<div class="sa-mini-price">$${(sd.price||0).toFixed(2)} <span class="${cls}">${arrow} ${Math.abs(sd.changePct||0).toFixed(2)}%</span></div>${hs!=null?`<div class="sa-mini-health"><span>Health Score</span><span style="color:${hColor};font-weight:700">${hs}/100</span></div>`:''}</div>`;
              }
              ovHtml+='</div>';
            }

            if(gaugeHtml) ovHtml+=gaugeHtml;
            if(chartHtml) ovHtml+=chartHtml;
            if(sentences) ovHtml+=`<div class="sa-summary"><div class="sa-summary-hd">📋 Quick Summary</div><div class="sa-summary-body">${esc(sentences)}</div><div class="sa-summary-hint">Click any step above to expand full details</div></div>`;
            overview.innerHTML=ovHtml;
            outEl.insertBefore(overview,outEl.querySelector('.sa-section'));
          }

          // Step performance timing
          const maxDur=Math.max(...Object.values(stepElapsed),1);
          if(outEl&&Object.keys(stepElapsed).length){
            const timingEl=document.createElement('div');
            timingEl.className='sa-timing-section sa-slide-in';
            let timHtml=`<div class="sa-timing-hd">Step Performance <span style="font-weight:400;opacity:.6">— Total: ${totalTime}s</span></div><div class="sa-timing-chart">`;
            for(let s=1;s<=totalSteps;s++){
              const dur=stepElapsed[s]||0;
              const pct=Math.round((dur/maxDur)*100);
              timHtml+=`<div class="sa-timing-row"><span class="sa-timing-label">${stepNames[s-1]||'Step '+s}</span><div class="sa-timing-bar-track"><div class="sa-timing-bar-fill" style="width:${pct}%"></div></div><span class="sa-timing-val">${dur.toFixed(1)}s</span></div>`;
            }
            timHtml+='</div>';
            timingEl.innerHTML=timHtml;
            outEl.appendChild(timingEl);
          }

          // Disclaimer
          if(outEl){
            const disc=document.createElement('div');
            disc.className='stock-disclaimer sa-disclaimer';
            disc.innerHTML='<strong>Not financial advice.</strong> AI-generated analysis for informational purposes only.';
            outEl.appendChild(disc);
          }

          // Reanalyze + actions
          if(outEl){
            const actions=document.createElement('div');
            actions.style.cssText='display:flex;gap:8px;flex-wrap:wrap;margin-top:8px';
            actions.innerHTML=`<button class="sa-reanalyze" onclick="(function(btn){btn.disabled=true;btn.textContent='Re-analyzing...';var c=btn.closest('.sa-container')||btn.parentElement.parentElement;var contentEl=c.parentElement;contentEl.innerHTML='';runStockAgent(${JSON.stringify(stockDataArray).replace(/</g,'\\u003c')},${JSON.stringify(userQuery).replace(/</g,'\\u003c')},contentEl,contentEl.closest('.msg').parentElement||document.getElementById('chatArea'),${JSON.stringify(chatId).replace(/</g,'\\u003c')})})(this)">Re-analyze</button><button class="sa-reanalyze" onclick="(function(){var out=document.getElementById('_saOut');if(out)out.querySelectorAll('.sa-section').forEach(function(s){s.classList.remove('sa-collapsed')})})(this)">Expand All</button><button class="sa-reanalyze" onclick="(function(){var out=document.getElementById('_saOut');if(out)out.querySelectorAll('.sa-section').forEach(function(s){s.classList.add('sa-collapsed')})})(this)">Collapse All</button>`;
            outEl.appendChild(actions);
          }

          // Update badge
          const badge=document.getElementById('_saBadge');
          if(badge){badge.classList.add('sa-badge-done');badge.textContent='Stock Analysis Complete'+(tickerStr?' — '+tickerStr:'');}

          if(window._chatAutoScroll)window._chatAutoScroll();
          _saDoneReceived=true;
        }else if(ev.type==='agent_error'){
          clearInterval(elTimer);
          if(_saThinkTypewriter){clearInterval(_saThinkTypewriter);_saThinkTypewriter=null;}
          if(_saContentTypewriter){clearInterval(_saContentTypewriter);_saContentTypewriter=null;}
          const badge=document.getElementById('_saBadge');
          if(badge){badge.classList.add('sa-badge-done');badge.textContent='❌ Stock Analysis Error';}
          const actEl=document.getElementById('_saActivity');
          if(actEl) actEl.innerHTML=`<span>Error: ${esc((ev.error||'Unknown error').slice(0,150))}</span>`;
        }
      }

      if(pollData.done) break;
    }
  }catch(e){
    clearInterval(elTimer);
    contentEl.innerHTML+=`<div style="color:var(--red);margin-top:12px;padding:12px;border:1px solid rgba(239,68,68,.3);border-radius:8px;background:rgba(239,68,68,.05)">❌ Stock analysis failed: ${esc(e.message||'Unknown error')}</div>`;
    setStatus('Stock analysis failed.');
  }
}

// --- Messaging ------------------------------------
function handleKey(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage()}}
function autoResize(el){el.style.height='auto';el.style.height=Math.min(el.scrollHeight,120)+'px'}
function sendQ(t){document.getElementById('msgInput').value=t;sendMessage()}

// --- Map Embeds -----------------------------------
function renderMapEmbed(query, label){
  const q=encodeURIComponent(query);
  const loc=getUserLocation();
  let src=`https://www.google.com/maps?q=${q}&output=embed`;
  if(loc&&loc.lat&&loc.lng){
    src=`https://www.google.com/maps?q=${q}&ll=${loc.lat},${loc.lng}&z=13&output=embed`;
  }
  const mapsLink=`https://www.google.com/maps/search/${q}`;
  return `<div class="map-embed-wrap"><div class="map-embed-header"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg><span>${esc(label||query)}</span><a href="${mapsLink}" target="_blank" rel="noopener" class="map-open-btn">Open in Maps ?</a></div><iframe class="map-embed-iframe" src="${src}" allowfullscreen loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe></div>`;
}

function renderFlightsLink(query){
  const q=encodeURIComponent(query);
  return `<div class="flights-link-wrap"><a href="https://www.google.com/travel/flights?q=${q}" target="_blank" rel="noopener" class="flights-link-btn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.8 19.2L16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5 5.2 3 -2 2-1.8-.6c-.4-.1-.8 0-1 .3l-.3.3 2.5 1.5 1.5 2.5.3-.3c.3-.3.4-.7.3-1l-.6-1.8 2-2 3 5.2.5-.3c.4-.2.6-.6.5-1.1z"/></svg> Search flights: ${esc(query)}</a></div>`;
}

// --- HuggingFace Space Results --------------------
function renderHFResult(hfData){
  const result=hfData.result||{};
  const space=esc(hfData.space||'');
  const type=result.type||'text';
  if(type==='image'&&result.data){
    return `<div class="hf-result-card" style="margin:12px 0;border:1px solid var(--border);border-radius:12px;overflow:hidden;background:var(--bg-surface);">
      <div style="padding:8px 12px;display:flex;align-items:center;gap:6px;border-bottom:1px solid var(--border);background:var(--bg-deep);">
        <span style="font-size:14px">🤗</span>
        <span style="font-size:11px;font-weight:500;color:var(--text-primary);">${space}</span>
      </div>
      <div style="padding:8px;text-align:center;">
        <img src="${result.data}" style="max-width:100%;max-height:512px;border-radius:8px;" alt="HuggingFace generated image">
      </div>
      <div style="padding:6px 12px 8px;display:flex;gap:8px;">
        <a href="${result.data}" download="hf_output.png" style="font-size:10px;color:var(--accent);text-decoration:none;display:flex;align-items:center;gap:4px;cursor:pointer;">Download</a>
      </div>
    </div>`;
  }
  if(type==='video'&&result.data){
    return `<div class="hf-result-card" style="margin:12px 0;border:1px solid var(--border);border-radius:12px;overflow:hidden;background:var(--bg-surface);">
      <div style="padding:8px 12px;display:flex;align-items:center;gap:6px;border-bottom:1px solid var(--border);background:var(--bg-deep);">
        <span style="font-size:14px">🤗</span>
        <span style="font-size:11px;font-weight:500;color:var(--text-primary);">${space}</span>
      </div>
      <div style="padding:8px;text-align:center;">
        <video controls style="max-width:100%;max-height:512px;border-radius:8px;"><source src="${result.data}" type="${esc(result.mime||'video/mp4')}">Your browser does not support video.</video>
      </div>
    </div>`;
  }
  if(type==='audio'&&result.data){
    return `<div class="hf-result-card" style="margin:12px 0;border:1px solid var(--border);border-radius:12px;overflow:hidden;background:var(--bg-surface);">
      <div style="padding:8px 12px;display:flex;align-items:center;gap:6px;border-bottom:1px solid var(--border);background:var(--bg-deep);">
        <span style="font-size:14px">🤗</span>
        <span style="font-size:11px;font-weight:500;color:var(--text-primary);">${space}</span>
      </div>
      <div style="padding:12px;">
        <audio controls style="width:100%;"><source src="${result.data}" type="${esc(result.mime||'audio/wav')}">Your browser does not support audio.</audio>
      </div>
    </div>`;
  }
  if(type==='file'&&result.data){
    return `<div class="hf-result-card" style="margin:12px 0;border:1px solid var(--border);border-radius:12px;overflow:hidden;background:var(--bg-surface);">
      <div style="padding:8px 12px;display:flex;align-items:center;gap:6px;border-bottom:1px solid var(--border);background:var(--bg-deep);">
        <span style="font-size:14px">🤗</span>
        <span style="font-size:11px;font-weight:500;color:var(--text-primary);">${space}</span>
      </div>
      <div style="padding:12px;">
        <a href="/api/files/download?path=${encodeURIComponent(result.data)}" style="font-size:12px;color:var(--accent);text-decoration:none;display:flex;align-items:center;gap:6px;">📄 Download ${esc(result.data)}</a>
      </div>
    </div>`;
  }
  // Default: text result
  const text=result.data||'(No output)';
  return `<div class="hf-result-card" style="margin:12px 0;border:1px solid var(--border);border-radius:12px;overflow:hidden;background:var(--bg-surface);">
    <div style="padding:8px 12px;display:flex;align-items:center;gap:6px;border-bottom:1px solid var(--border);background:var(--bg-deep);">
      <span style="font-size:14px">🤗</span>
      <span style="font-size:11px;font-weight:500;color:var(--text-primary);">${space}</span>
    </div>
    <div style="padding:12px;font-size:12px;color:var(--text-primary);white-space:pre-wrap;max-height:300px;overflow-y:auto;">${esc(typeof text==='string'?text:JSON.stringify(text))}</div>
  </div>`;
}

function renderHFLoading(info){
  const space=esc(info||'');
  return `<div class="hf-loading-placeholder" style="margin:12px 0;border:1px solid var(--border);border-radius:12px;overflow:hidden;background:var(--bg-surface);animation:pulse 1.5s ease-in-out infinite;">
    <div style="padding:12px;display:flex;align-items:center;gap:8px;">
      <span style="font-size:16px">🤗</span>
      <div>
        <div style="font-size:11px;font-weight:500;color:var(--text-primary);">Running HuggingFace Space...</div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${space}</div>
      </div>
    </div>
  </div>`;
}

// --- Stock Cards ----------------------------------
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
  return `<div class="stock-card-wrap" id="${cardId}"><div class="stock-card"><div class="stock-card-loading"><div class="stock-shimmer"></div><span>Loading ${esc(ticker)} data...</span></div></div><div class="stock-disclaimer"><strong>Not financial advice.</strong> This is for informational and educational purposes only. AI-generated analysis may be inaccurate or outdated. Always do your own research and consult a licensed financial advisor before making investment decisions. You could lose money.</div></div>`;
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
      if(d.error){el.querySelector('.stock-card').innerHTML=`<div class="stock-card-error">${esc(d.error)}</div>`;return;}
    }
    const up=d.change>=0;
    const arrow=up?'▲':'▼';
    const cls=up?'stock-up':'stock-down';
    const fmtNum=(n)=>{if(n==null)return'—';if(n>=1e12)return'$'+(n/1e12).toFixed(2)+'T';if(n>=1e9)return'$'+(n/1e9).toFixed(2)+'B';if(n>=1e6)return'$'+(n/1e6).toFixed(2)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return n.toLocaleString();};
    const fmtNumRaw=(n)=>{if(n==null)return'—';if(n>=1e12)return(n/1e12).toFixed(2)+'T';if(n>=1e9)return(n/1e9).toFixed(2)+'B';if(n>=1e6)return(n/1e6).toFixed(2)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return n.toLocaleString();};
    const fmtPct=(n)=>n!=null?(n*100).toFixed(2)+'%':'—';

    // -- Verdict banner --
    const verdict=d.verdict||'hold';
    const verdictLabel={buy:'BUY',hold:'HOLD',sell:'SELL'}[verdict]||'HOLD';
    const verdictCls={buy:'stock-verdict-buy',hold:'stock-verdict-hold',sell:'stock-verdict-sell'}[verdict]||'stock-verdict-hold';
    const hs=d.health&&d.health.score;
    const scoreTag=hs!=null?`<span class="stock-verdict-score">${hs}/100</span>`:'';

    // -- Risk badge --
    let riskBadge='';
    if(d.risk){
      const riskMap={low:'Low Risk',moderate:'Moderate',high:'High Risk',very_high:'Very High'};
      const riskCls={low:'stock-risk-low',moderate:'stock-risk-mod',high:'stock-risk-high',very_high:'stock-risk-high'};
      riskBadge=`<span class="stock-risk-badge ${riskCls[d.risk]||'stock-risk-mod'}">${riskMap[d.risk]||d.risk}</span>`;
    }

    // -- Key metrics --
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

    // -- Technical indicators --
    const p=d.perf||{};
    const tc=d.technicals||{};
    const techItems=[];
    if(p.sma50!=null)techItems.push(`<span class="stock-tech-item">SMA50: <b class="${d.price>=p.sma50?'stock-up':'stock-down'}">$${p.sma50.toFixed(2)}</b></span>`);
    if(p.sma200!=null)techItems.push(`<span class="stock-tech-item">SMA200: <b class="${d.price>=p.sma200?'stock-up':'stock-down'}">$${p.sma200.toFixed(2)}</b></span>`);
    if(p.rsi!=null){
      const rsiCls=p.rsi>70?'stock-down':p.rsi<30?'stock-up':'stock-neutral';
      const rsiLabel=p.rsi>70?'Overbought':p.rsi<30?'Oversold':'Neutral';
      techItems.push(`<span class="stock-tech-item">RSI(14): <b class="${rsiCls}">${p.rsi} (${rsiLabel})</b></span>`);
    }
    if(tc.macd!=null){
      const macdUp=tc.macd_histogram>0;
      techItems.push(`<span class="stock-tech-item">MACD: <b class="${macdUp?'stock-up':'stock-down'}">${tc.macd.toFixed(2)}</b> <small style="opacity:.7">(${macdUp?'bullish':'bearish'})</small></span>`);
    }
    if(tc.bb_pctb!=null){
      const bbCls=tc.bb_pctb>0.8?'stock-down':tc.bb_pctb<0.2?'stock-up':'stock-neutral';
      const bbLabel=tc.bb_pctb>0.8?'Near upper':tc.bb_pctb<0.2?'Near lower':'Mid-band';
      techItems.push(`<span class="stock-tech-item">BB %B: <b class="${bbCls}">${(tc.bb_pctb*100).toFixed(0)}% (${bbLabel})</b></span>`);
    }
    if(tc.atr_pct!=null){
      techItems.push(`<span class="stock-tech-item">ATR%: <b>${tc.atr_pct.toFixed(1)}%</b> <small style="opacity:.7">(${tc.atr_pct>3?'High':'Normal'} vol)</small></span>`);
    }
    if(tc.stoch_rsi!=null){
      const srCls=tc.stoch_rsi>80?'stock-down':tc.stoch_rsi<20?'stock-up':'stock-neutral';
      techItems.push(`<span class="stock-tech-item">StochRSI: <b class="${srCls}">${tc.stoch_rsi.toFixed(0)}</b></span>`);
    }
    let techHtml=techItems.length?`<div class="stock-tech-section"><span class="stock-section-title">Technical Indicators</span><div class="stock-tech-row">${techItems.join('')}</div></div>`:'';

    // -- 52-week position --
    let pos52Html='';
    if(d.pos52!=null&&d.low52!=null&&d.high52!=null){
      pos52Html=`<div class="stock-52w"><span class="stock-52w-label">52W Range</span><div class="stock-52w-bar-wrap"><span class="stock-52w-lo">$${d.low52.toFixed(2)}</span><div class="stock-52w-track"><div class="stock-52w-fill" style="width:${Math.max(Math.min(d.pos52,100),0)}%"></div><div class="stock-52w-dot" style="left:${Math.max(Math.min(d.pos52,100),0)}%"></div></div><span class="stock-52w-hi">$${d.high52.toFixed(2)}</span></div></div>`;
    }

    // -- Performance bars --
    const perfItems=[_stockPerfBar('1W',p['1w']),_stockPerfBar('1M',p['1m']),_stockPerfBar('3M',p['3m']),_stockPerfBar('6M',p['6m']),_stockPerfBar('YTD',p['ytd']),_stockPerfBar('1Y',p['1y'])].filter(x=>x);
    let perfHtml=perfItems.length?`<div class="stock-perf-section"><span class="stock-section-title">Performance</span><div class="stock-perf-grid">${perfItems.join('')}</div></div>`:'';

    // -- Financial health --
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

    // -- Analyst targets --
    let targetHtml='';
    if(d.targetPrice){
      const upside=((d.targetPrice-d.price)/d.price*100).toFixed(1);
      const uCls=upside>=0?'stock-up':'stock-down';
      const barMin=d.targetLow||d.price*0.8;
      const barMax=d.targetHigh||d.price*1.2;
      const range=barMax-barMin||1;
      const pricePct=Math.max(0,Math.min(100,((d.price-barMin)/range)*100));
      const meanPct=Math.max(0,Math.min(100,((d.targetPrice-barMin)/range)*100));
      targetHtml=`<div class="stock-target-section"><span class="stock-section-title">Analyst Price Targets${d.numAnalysts?' ('+d.numAnalysts+' analysts)':''}</span>`
        +`<div class="stock-target-bar-wrap">`
          +`<span class="stock-target-lo">$${barMin.toFixed(0)}</span>`
          +`<div class="stock-target-track">`
            +`<div class="stock-target-current" style="left:${pricePct}%"><div class="stock-target-dot stock-target-dot-current"></div><span class="stock-target-price-label">$${d.price.toFixed(2)}</span></div>`
            +`<div class="stock-target-mean" style="left:${meanPct}%"><div class="stock-target-dot stock-target-dot-mean"></div><span class="stock-target-price-label" style="color:var(--accent)">$${d.targetPrice.toFixed(2)}</span></div>`
          +`</div>`
          +`<span class="stock-target-hi">$${barMax.toFixed(0)}</span>`
        +`</div>`
        +`<div class="stock-target-upside ${uCls}">${upside>=0?'+':''}${upside}% upside to mean target</div>`
      +`</div>`;
    }

    // -- Earnings --
    let earningsHtml='';
    if(d.earningsDate) earningsHtml=`<span class="stock-earnings">Earnings: ${esc(d.earningsDate)}</span>`;

    // -- Collapsible details content --
    const detailsContent=pos52Html+techHtml
      +`<div class="stock-card-metrics">${metrics.map(m=>`<div class="stock-metric"><span class="stock-metric-label">${m.label}</span><span class="stock-metric-value">${m.value}</span></div>`).join('')}</div>`
      +perfHtml+healthDetailHtml+targetHtml;

    const detailId=cardId+'_det';

    el.querySelector('.stock-card').innerHTML=
      // -- Verdict banner --
      `<div class="stock-verdict-banner ${verdictCls}">`
        +`<span class="stock-verdict-label">${verdictLabel}</span>`
        +scoreTag
      +`</div>`
      // -- Header: ticker, price, badges --
      +`<div class="stock-card-header">`
        +`<div class="stock-card-title-row">`
          +`<div class="stock-card-title"><span class="stock-ticker">${esc(d.ticker)}</span><span class="stock-name">${esc(d.name)}</span></div>`
          +`<div class="stock-badges">${riskBadge}</div>`
        +`</div>`
        +`<div class="stock-card-price-row">`
          +`<div class="stock-card-price"><span class="stock-price">$${d.price.toFixed(2)}</span><span class="stock-change ${cls}">${arrow} $${Math.abs(d.change).toFixed(2)} (${Math.abs(d.changePct).toFixed(2)}%)</span></div>`
        +`</div>`
      +`</div>`
      // -- Collapsible details toggle --
      +`<button class="stock-details-toggle" onclick="var det=document.getElementById('${detailId}');var open=det.classList.toggle('open');this.querySelector('.stock-toggle-arrow').textContent=open?'▾':'▸';this.querySelector('.stock-toggle-text').textContent=open?'Hide Details':'View Details'">`
        +`<span class="stock-toggle-arrow">▸</span> <span class="stock-toggle-text">View Details</span>`
      +`</button>`
      +`<div class="stock-details-body" id="${detailId}">`
        +detailsContent
      +`</div>`
      // -- Footer --
      +`<div class="stock-card-footer">`
        +earningsHtml
        +`${d.sector?`<span class="stock-sector">${esc(d.sector)}${d.industry?' · '+esc(d.industry):''}</span>`:''}`
        +`<a class="stock-yahoo-link" href="https://finance.yahoo.com/quote/${encodeURIComponent(d.ticker)}" target="_blank" rel="noopener">Yahoo Finance ↗</a>`
      +`</div>`;
  }catch(e){
    if(el)el.querySelector('.stock-card').innerHTML=`<div class="stock-card-error">Failed to load stock data for ${esc(ticker)}</div>`;
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
  const nextBtnHTML=first.multi?`<button class="cq-next-btn" onclick="wizardNext(this)" disabled>Next ?</button>`:'';
  return `<div class="cq-wizard" data-blocks="${blocksJSON}" data-current="0" data-total="${total}" data-answers="[]">`
    +progressHTML
    +`<div class="cq-card" ${multiAttr}>${qHTML}${multiHint}<div class="cq-opts">${optsHTML}</div>`
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
    // All questions answered — highlight chosen options and submit silently
    wizard.querySelectorAll('.cq-opt.cq-selected').forEach(b=>{
      b.style.background='var(--green,#22c55e)';b.style.color='#fff';b.style.borderColor='var(--green,#22c55e)';
    });
    wizard.querySelectorAll('.cq-opt:not(.cq-selected)').forEach(b=>{b.style.opacity='.35';b.style.pointerEvents='none';});
    // Hide progress bar
    const prog=wizard.querySelector('.cq-progress');if(prog)prog.style.display='none';
    // Send answer silently (no visible user message)
    const parts=answers.map(a=>a.question?`${a.question}: ${a.answer}`:a.answer);
    sendMessage({silent:true,message:parts.join('\n')});
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
    const nextBtnHTML=nb.multi?`<button class="cq-next-btn" onclick="wizardNext(this)" disabled>Next ?</button>`:'';
    card.outerHTML=`<div class="cq-card" ${multiAttr}>${qHTML}${multiHint}<div class="cq-opts">${optsHTML}</div>`
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

function stripMetaBlocks(text){
  return (text||'')
    .replace(/<<<THINKING>>>[\s\S]*?(<<<END_THINKING>>>|$)/g,'')
    .replace(/<<<THINKING[\s\S]*$/g,'')
    .replace(/<<<\/?END_THINKING\/?>>>/g,'')
    .replace(/<<<\/?THINKING\/?>>>/g,'')
    .replace(/(?:<<<QUESTION:.*?>>>\n)?<<<CHOICES(?:\|multi)?>>>[\s\S]*?(<<<END_CHOICES>>>|$)/g,'')
    .replace(/<<<IMAGE_SEARCH:\s*.+?>>>/g,'')
    .replace(/%%%IMAGE_SEARCH:\s*.+?(?:>>>|%%%)/g,'')
    .replace(/<<<IMAGE_GENERATE:\s*.+?>>>/g,'')
    .replace(/<<<HF_SPACE:\s*.+?>>>/g,'')
    .replace(/<<<DEEP_RESEARCH[:\s][\s\S]*?>>>/g,'')
    .replace(/<<<DEEP_RESEARCH>>>/g,'')
    .replace(/<<<REMINDER:\s*[\s\S]*?>>>/g,'')
    .replace(/<<<SOURCES>>>[\s\S]*?(<<<END_SOURCES>>>|$)/g,'')
    .replace(/<<<FOLLOWUPS>>>[\s\S]*?(<<<END_FOLLOWUPS>>>|$)/g,'')
    .replace(/<<<\/?SOURCES\/?>>>/g,'')
    .replace(/<<<\/?END_SOURCES\/?>>>/g,'')
    .replace(/<<<\/?FOLLOWUPS\/?>>>/g,'')
    .replace(/<<<\/?END_FOLLOWUPS\/?>>>/g,'')
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

  // -- Inline media markers: [[[MEDIA:kind:index:info]]] --
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
      const lbl=labels[kind]||'Loading...';
      const icon=(lbl).split(' ')[0];
      const text=lbl.split(' ').slice(1).join(' ');
      content=`<div class="stream-placeholder"><span class="sp-icon">${icon}</span> ${text}</div>`;
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
  html=html.replace(/&lt;&lt;&lt;FLIGHTS:[^&]*?&gt;&gt;&gt;/g,'<div class="stream-placeholder"><span class="sp-icon">✈</span> Finding flights...</div>');
  html=html.replace(/&lt;&lt;&lt;STOCK:[^&]*?&gt;&gt;&gt;/g,'<div class="stream-placeholder"><span class="sp-icon">📈</span> Loading stock data...</div>');
  html=html.replace(/%%%STOCKBLOCK:\d+%%%/g,'<div class="stream-placeholder"><span class="sp-icon">📈</span> Loading stock data...</div>');
  html=html.replace(/&lt;&lt;&lt;HF_SPACE:[^&]*?&gt;&gt;&gt;/g,'<div class="stream-placeholder"><span class="sp-icon">🤗</span> Running HuggingFace Space...</div>');
  html=html.replace(/%%%HFBLOCK:\d+%%%/g,'<div class="stream-placeholder"><span class="sp-icon">🤗</span> Running HuggingFace Space...</div>');
  html=html.replace(/&lt;&lt;&lt;CONTINUE&gt;&gt;&gt;/g,'');
  html=html.replace(/&lt;&lt;&lt;STOCK_RATINGS&gt;&gt;&gt;[\s\S]*?&lt;&lt;&lt;END_STOCK_RATINGS&gt;&gt;&gt;/g,'');
  html=html.replace(/&lt;&lt;&lt;STOCK_RATINGS&gt;&gt;&gt;[\s\S]*$/,'');
  // Strip SOURCES/FOLLOWUPS blocks (may still have escaped tags after HTML escaping)
  html=html.replace(/&lt;&lt;&lt;SOURCES&gt;&gt;&gt;[\s\S]*?&lt;&lt;&lt;END_SOURCES&gt;&gt;&gt;/g,'');
  html=html.replace(/&lt;&lt;&lt;SOURCES&gt;&gt;&gt;[\s\S]*$/,'');
  html=html.replace(/&lt;&lt;&lt;FOLLOWUPS&gt;&gt;&gt;[\s\S]*?&lt;&lt;&lt;END_FOLLOWUPS&gt;&gt;&gt;/g,'');
  html=html.replace(/&lt;&lt;&lt;FOLLOWUPS&gt;&gt;&gt;[\s\S]*$/,'');
  // Completed CODE_EXECUTE blocks — show code + executing indicator (stash in _liveBlocks to protect from markdown)
  html=html.replace(/&lt;&lt;&lt;CODE_EXECUTE:\s*(\w+)&gt;&gt;&gt;([\s\S]*?)&lt;&lt;&lt;END_CODE&gt;&gt;&gt;/g,(_,lang,code)=>{
    const langLabel={'python':'Python','javascript':'JavaScript','js':'JavaScript','html':'HTML','css':'CSS','bash':'Shell','sh':'Shell'}[lang.toLowerCase()]||lang;
    const block='<div class="stream-code-exec"><div class="stream-code-exec-header"><span class="sp-icon">⚙</span> '+esc(langLabel)+' — Running...</div><pre class="stream-code-exec-body"><code>'+code+'</code></pre><div class="stream-code-exec-status"><div class="dots"><span></span><span></span><span></span></div> Executing...</div></div>';
    _liveBlocks.push(block);
    return `%%%LIVEBLOCK${_liveBlocks.length-1}%%%`;
  });
  // Unclosed CODE_EXECUTE block (still streaming) — show the code being written (stash to protect from markdown)
  html=html.replace(/&lt;&lt;&lt;CODE_EXECUTE:\s*(\w+)&gt;&gt;&gt;([\s\S]*)$/,(_,lang,code)=>{
    const langLabel={'python':'Python','javascript':'JavaScript','js':'JavaScript','html':'HTML','css':'CSS','bash':'Shell','sh':'Shell'}[lang.toLowerCase()]||lang;
    const block='<div class="stream-code-exec"><div class="stream-code-exec-header"><span class="sp-icon">⚙</span> Writing '+esc(langLabel)+' code...</div><pre class="stream-code-exec-body"><code>'+code+'</code><span class="stream-cursor"></span></pre></div>';
    _liveBlocks.push(block);
    return `%%%LIVEBLOCK${_liveBlocks.length-1}%%%`;
  });
  // Unclosed mermaid block
  if(/```mermaid\n/i.test(html)&&!(/```mermaid\n[\s\S]*?```/.test(html))){
    html=html.replace(/```mermaid\n[\s\S]*$/,'<div class="stream-placeholder"><span class="sp-icon">🗺</span> Generating mind map...</div>');
  }
  // Unclosed todolist block
  if(/```todolist\n/i.test(html)&&!(/```todolist\n[\s\S]*?```/.test(html))){
    html=html.replace(/```todolist\n[\s\S]*$/,'<div class="stream-placeholder"><span class="sp-icon">✅</span> Generating task list...</div>');
  }
  // Unclosed generic code block — show artifact generating
  if(hasUnclosedCodeFence(html)){
    // Get the language hint if present
    const fenceMatch=html.match(/```(\w+)\n(?![\s\S]*```)/);
    const lang=fenceMatch?fenceMatch[1]:'code';
    const langLabel={'python':'Python','javascript':'JavaScript','js':'JavaScript','html':'HTML','css':'CSS','json':'JSON','markdown':'Markdown','md':'Markdown','sql':'SQL','bash':'Shell','sh':'Shell','typescript':'TypeScript','ts':'TypeScript'}[lang.toLowerCase()]||lang;
    html=html.replace(/```\w*\n[^]*$/,'<div class="stream-placeholder"><span class="sp-icon">🗺</span> Writing '+esc(langLabel)+' artifact...</div>');
  }

  // Completed mermaid blocks — show placeholder until fmt() renders the real diagram
  html=html.replace(/```mermaid\n[\s\S]*?```/g,'<div class="stream-placeholder"><span class="sp-icon">🗺</span> Mind map ready — rendering...</div>');
  // Completed todolist blocks — show placeholder until fmt() renders the interactive list
  html=html.replace(/```todolist\n[\s\S]*?```/g,'<div class="stream-placeholder"><span class="sp-icon">✅</span> Task list ready — rendering...</div>');
  // Completed code blocks: render styled
  html=html.replace(/```(\w*)\n([\s\S]*?)```/g,(_,l,c)=>{
    return '<pre class="stream-code"><code>'+c+'</code></pre>';
  });

  // Custom <<<TABLE>>> rendering removed; rely on standard markdown table parsing.

  // Markdown tables — unified handler for both complete and streaming tables (legacy fallback)
  // Matches any table structure: header row + separator + zero or more data rows (even incomplete)
  html=html.replace(/(?:^|\n)(\|[^\n]+\|[ \t]*\n\|[\s|:\-]+\|[ \t]*\n(?:\|[^\n]*(?:\n|$))*)/gm,(match)=>{
    const lines=match.trim().split('\n').filter(l=>l.trim());
    if(lines.length<2)return match;
    const parseRow=line=>line.replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
    const fmtCell=c=>c.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/`(.+?)`/g,'<code style="background:var(--bg-surface);padding:1px 4px;border-radius:3px;font-size:11px">$1</code>');
    const headers=parseRow(lines[0]);
    if(!/^[\s|:\-]+$/.test(lines[1].replace(/\|/g,'')))return match;
    const dataLines=lines.slice(2);
    let tbl='<table style="border-collapse:collapse;width:100%;margin:8px 0;font-size:12px"><thead><tr>'+headers.map(h=>`<th style="background:var(--bg-deep);padding:6px 8px;text-align:left;font-weight:600;border:1px solid var(--border)">${fmtCell(h)}</th>`).join('')+'</tr></thead><tbody>';
    for(const line of dataLines){
      if(!line.trim())continue;
      const cells=parseRow(line);
      // Pad cells to match header count for incomplete rows
      while(cells.length<headers.length)cells.push('');
      tbl+='<tr>'+cells.slice(0,headers.length).map(c=>`<td style="padding:6px 8px;border:1px solid var(--border)">${fmtCell(c)}</td>`).join('')+'</tr>';
    }
    tbl+='</tbody></table>';
    _liveBlocks.push(tbl);
    return `\n%%%LIVEBLOCK${_liveBlocks.length-1}%%%\n`;
  });

  // Catch any remaining partial table row at end of text (orphaned from table above)
  html=html.replace(/\n(\|[^\n]*)$/,(match,row)=>{
    if(row.trim().startsWith('|')){
      _liveBlocks.push('');
      return `\n%%%LIVEBLOCK${_liveBlocks.length-1}%%%`;
    }
    return match;
  });

  // Bold
  html=html.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  // Inline code
  html=html.replace(/`(.+?)`/g,'<code class="stream-inline-code">$1</code>');
  // Links — absolute and relative /api/ URLs
  // First, strip vertexaisearch proxy URLs (they're just google redirects, not useful for display)
  html=html.replace(/\[([^\]]+)\]\(https?:\/\/vertexaisearch[^)]+\)/g,'$1');
  html=html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">$1</a>');
  html=html.replace(/\[([^\]]+)\]\((\/api\/[^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">$1</a>');
  // Workspace file links: [text](filename.ext) — convert to download URLs
  html=html.replace(/\[([^\]]+)\]\((?!https?:\/\/)(?!\/api\/)(?!#)(?!mailto:)([^)]+\.\w+)\)/g,(_,label,path)=>{
    const dlUrl='/api/files/download?path='+encodeURIComponent(path.replace(/&amp;/g,'&'));
    return `<a href="${dlUrl}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">${label}</a>`;
  });
  // Bare URLs — auto-link any https?:// not already inside an <a> tag
  // First strip bare vertexaisearch proxy URLs (long ugly redirects from Google grounding)
  html=html.replace(/(?<!href=")(?<!src=")(?<!">)https?:\/\/vertexaisearch[^\s<"']+/g,'');
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
  // Horizontal rules — collapse consecutive ---/=== lines into a single <hr>
  html=html.replace(/^[\-]{3,}$/gm,'<hr style="border:none;border-top:1px solid var(--border);margin:8px 0">');
  html=html.replace(/^[=]{3,}$/gm,'<hr style="border:none;border-top:1px solid var(--border);margin:8px 0">');
  html=html.replace(/(<hr[^>]*>[\s\n]*){2,}/g,'<hr style="border:none;border-top:1px solid var(--border);margin:8px 0">');
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
  const _retryCount=(opts&&opts._retryCount)||0;
  const _MAX_STREAM_RETRIES=2;
  // Allow background reprompt/continue to target a specific chat
  const _targetChat=opts&&opts.targetChat;
  const input=document.getElementById('msgInput');
  const text=(opts&&opts.message)?opts.message:input.value.trim();
  if(!text&&!pendingFiles.length&&!pendingReplies.length)return;
  // If files are still uploading, defer the actual send until they finish
  if(_uploadsInFlight>0&&!_silent){
    // Capture the text now and clear input so user sees their intent was received
    if(!(opts&&opts.message)){input.value='';input.style.height='auto';}
    _pendingSendOpts=opts&&opts.message?opts:{message:text};
    setStatus(`Waiting for ${_uploadsInFlight} file${_uploadsInFlight===1?'':'s'} to finish uploading...`);
    return;
  }
  if(!_silent){_codeRepromptCount=0;}
  if(!_targetChat&&curChat&&isChatRunning(curChat)&&!_silent){showToast('Already generating in this chat — switch to another chat or wait.','info');return;}
  // Safety: if the welcome screen is visible, force new chat (curChat may be stale)
  if(!_targetChat&&curChat&&isWelcomeScreenVisible()){
    curChat=null;
  }
  // Force-create a new chat if none exists (don't rely on createChat guard)
  let _isFirstMessage=false;
  if(!_targetChat&&!curChat){
    try{
      const cr=await apiFetch('/api/chats',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder:_activeFolderView||pendingFolder||''})});
      const cc=await cr.json();
      if(cc.error){showToast('Could not create chat: '+cc.error,'error');return;}
      curChat=cc.id;
      pendingFolder='';
      _isFirstMessage=true;
      // Immediately set a temp title from user text so it shows in sidebar
      const _tempTitle=text.slice(0,40)+(text.length>40?'…':'');
      document.getElementById('topTitle').textContent=_tempTitle;
      // Add to sidebar immediately (before backend filters it)
      allChats.unshift({id:cc.id,title:_tempTitle,updated:new Date().toISOString(),messages:['pending'],folder:cc.folder||''});
      saveCachedChats(allChats);
      renderChatList();
      // Fire-and-forget: generate proper title with lite model
      apiFetch(`/api/chats/${cc.id}/generate-title`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:text.slice(0,400)})}).then(r=>r.json()).then(d=>{
        if(d.title&&d.title!=='New Chat'){
          document.getElementById('topTitle').textContent=d.title;
          const c=allChats.find(c=>c.id===cc.id);
          if(c)c.title=d.title;
          saveCachedChats(allChats);
          renderChatList();
        }
      }).catch(()=>{});
    }catch(e){showToast('Failed to create chat: '+e.message,'error');return;}
  }
  const targetChatId=_targetChat||curChat;

  // For background reprompt/continue targeting a different chat, skip all DOM work
  const _isBackground=!!(_targetChat&&_targetChat!==curChat);

  const w=!_isBackground&&document.querySelector('#chatArea .welcome');
  if(w){
    if(schoolMode){
      // School mode: remove welcome instantly, no animation
      w.remove();
    }else{
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
  }
  const files=[...pendingFiles].filter(f=>!f._loading);
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

  // Move active chat to top of list on send
  if(!_silent&&!_isFirstMessage&&targetChatId){
    const idx=allChats.findIndex(c=>c.id===targetChatId);
    if(idx>0){
      const [chat]=allChats.splice(idx,1);
      chat.updated=new Date().toISOString();
      allChats.unshift(chat);
      saveCachedChats(allChats);
      renderChatList(document.getElementById('chatSearch')?.value||'');
    }
  }

  // -- Research when explicitly activated via tool --
  // Research agent silently enhances the prompt — no visible plan/modal
  // It's sent as part of activeTools in the normal chat flow

  const controller=new AbortController();
  const streamId=++_nextStreamId;
  setChatRunning(targetChatId,true,{type:'chat',controller,streamId});
  const area=document.getElementById('chatArea');

  // Smart auto-scroll: only scroll to bottom if user is near the bottom already
  let _userScrolledAway=false;
  const _scrollThreshold=150;
  let _isProgrammaticScroll=false;
  const _onUserScroll=()=>{
    if(_isProgrammaticScroll){_isProgrammaticScroll=false;return;}
    const distFromBottom=area.scrollHeight-area.scrollTop-area.clientHeight;
    _userScrolledAway=distFromBottom>_scrollThreshold;
  };
  area.addEventListener('scroll',_onUserScroll,{passive:true});
  const _autoScroll=()=>{if(!_userScrolledAway){_isProgrammaticScroll=true;area.scrollTop=area.scrollHeight;}};
  // Expose for stock agent and other sub-flows
  window._chatAutoScroll=_autoScroll;

  const msgDiv=document.createElement('div');
  msgDiv.className='msg kairo';
  if(_silent){
    // Silent/auto-reprompt: minimal indicator, no "Thinking..." animation
    msgDiv.innerHTML='<div class="lbl">Gyro</div><div class="msg-content"></div>';
  }else{
    msgDiv.innerHTML='<div class="lbl">Gyro</div><div class="msg-content"><div class="think-active" style="animation:thinkingIn .5s var(--ease-spring-snappy) both"><div class="dots"><span></span><span></span><span></span></div></div></div>';
  }
  if(!_isBackground){area.appendChild(msgDiv);_autoScroll();}
  const contentEl=msgDiv.querySelector('.msg-content');
  const canRender=()=>curChat===targetChatId&&msgDiv.isConnected;
  let _onVisChange=null;
  try{
    // Collect active tool names and clear them for next message
    const toolsForMsg=[...activeTools];
    activeTools.clear();
    renderToolBadges();

    // -- Research tool: send to AI with tool hint instead of launching directly --
    // The AI will decide whether to trigger <<<DEEP_RESEARCH: query>>> based on
    // the tool instructions injected into the system prompt by the backend.

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

    let _truncateAt;
    if(window._activeEdit){
      _truncateAt=window._activeEdit.backendIndex;
      // Remove the edited message and all subsequent messages from DOM
      const currentMsgs=[...document.querySelectorAll('#chatArea .msg')];
      const msgIdx=currentMsgs.indexOf(window._activeEdit.msgEl);
      if(msgIdx>=0){
        for(let i=msgIdx;i<currentMsgs.length;i++) currentMsgs[i].remove();
      }
      // Clean up edit banner and state
      const banner=document.getElementById('editBanner');
      if(banner)banner.remove();
      delete window._activeEdit;
    }
    if(window._editTruncateAt!=null){_truncateAt=window._editTruncateAt;delete window._editTruncateAt;}
    const _bodyObj={message:messageToSend,raw_text:_silent?'':text,files,thinking_level:_noThinking?'off':thinkingLevel,web_search:true,active_tools:toolsForMsg,is_system:!!_silent,user_location:getUserLocation(),reminders:_getPendingReminders(),school_mode:schoolMode};
    if(_truncateAt!=null)_bodyObj.truncate_at=_truncateAt;
    // Inject folder custom instructions if chat is in a folder
    const _chatFolder=(allChats.find(c=>c.id===targetChatId)||{}).folder||_activeFolderView||'';
    if(_chatFolder){
      const _fi=getFolderMeta(_chatFolder);
      if(_fi.instructions)_bodyObj.folder_instructions=_fi.instructions;
      // Include uploaded context files as part of folder instructions
      if(_fi.instructionFiles&&_fi.instructionFiles.length){
        _bodyObj.folder_context_files=_fi.instructionFiles.map(f=>({name:f.name,data:f.data||''})).filter(f=>f.data);
      }
    }
    const response=await apiFetch(`/api/chats/${targetChatId}/stream`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(_bodyObj),signal:controller.signal});

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
    _activeStreamState.set(targetChatId,{get fullText(){return fullText;},get thinkText(){return thinkText;}});
    const _streamDevRaw=devRawMode;  // Snapshot dev mode at stream start to prevent mid-stream format switches
    let _genFailures=[];
    // -- Periodic auto-save: save partial content every 15s during streaming --
    const _partialSaveInterval=setInterval(()=>{
      const text=fullText.trim();
      if(!text)return;
      try{
        navigator.sendBeacon(`/api/chats/${targetChatId}/partial`,new Blob([JSON.stringify({text})],{type:'application/json'}));
      }catch(e){}
    },15000);
    // -- Multi-turn thinking state --
    let _thinkTurn=0;              // Current thinking turn number (incremented each time thinking restarts)
    let _thinkTurns={};            // {turnNum: {panel, textEl, text}}
    let _turnThinkText='';         // Current turn's thinking text
    let _thinkDisplayed='';        // How much thinking text has been typewriter-revealed
    // -- Response typewriter state --
    let _responseDisplayed='';     // How much response text has been typewriter-revealed
    let _responseTypewriter=null;  // Interval for response typewriter
    // -- Mid-stream media loading state --
    let _mediaLoadingCount=0;     // How many media items are currently loading
    let _doneReceived=false;      // Whether the 'done' event has been processed
    window._streamMediaResults={};// Results that arrived before 'done' (keyed by "kind-index")
    // Keep rendering alive when tab is hidden — requestAnimationFrame pauses in background tabs
    _onVisChange=()=>{
      if(document.visibilityState==='visible'&&!_doneReceived&&canRender()){
        const targetEl=contentEl.querySelector('.stream-response-area')||contentEl;
        if(fullText){
          // Flush response typewriter
          _responseDisplayed=fullText;
          if(_streamDevRaw){
            targetEl.innerHTML='<pre class="dev-raw-log">'+esc(fullText)+'<span class="stream-cursor"></span></pre>';
          }else{
            targetEl.innerHTML=fmtLive(fullText);
            if(!schoolMode)renderMathInElementSafe(targetEl);
          }
        }
        // Flush thinking typewriter buffer
        if(window._thinkTypewriter&&_turnThinkText){
          _thinkDisplayed=_turnThinkText;
          const thinkTextEl=contentEl.querySelector('.ltp-body');
          if(thinkTextEl)thinkTextEl.innerHTML=_fmtThink(_turnThinkText);
        }
        _autoScroll();
      }
    };
    document.addEventListener('visibilitychange',_onVisChange);
    // Stall detection: if no event (including heartbeats) for 120s, warn the user
    // Increased from 45s to be more tolerant of slow models and poor connections
    let _lastAnyEvent=Date.now();
    let _lastMeaningfulEvent=Date.now();
    let _stallWarned=false;
    let _stallTimer=setInterval(()=>{
      if(_doneReceived){clearInterval(_stallTimer);return;}
      const noEventMs=Date.now()-_lastAnyEvent;
      const noMeaningfulMs=Date.now()-_lastMeaningfulEvent;
      // If no events at all (not even heartbeats) for 120s, connection is dead
      if(noEventMs>120000){
        clearInterval(_stallTimer);
        console.warn('[gyro] Stream stalled — no events for 120s (proxy may have killed connection)');
        // Auto-retry if no content received yet
        if(!fullText.trim()&&!thinkText.trim()&&_retryCount<_MAX_STREAM_RETRIES){
          console.warn(`[gyro] Auto-retrying stalled stream (attempt ${_retryCount+1}/${_MAX_STREAM_RETRIES})`);
          try{controller.abort();}catch(_){}
          msgDiv.remove();
          setChatRunning(targetChatId,false);
          area.removeEventListener('scroll',_onUserScroll);
          const _retryTid=setTimeout(()=>{
            const cur=runningStreams.get(targetChatId);
            if(cur&&cur.streamId!==streamId)return;
            sendMessage({...opts,message:text,_retryCount:_retryCount+1,targetChat:targetChatId});
          },1500*(_retryCount+1));
          const _pList2=_pendingReprompts.get(targetChatId)||[];_pList2.push(_retryTid);_pendingReprompts.set(targetChatId,_pList2);
          return;
        }
        const cur=runningStreams.get(targetChatId);
        if(cur&&cur.streamId===streamId)setChatRunning(targetChatId,false);
        const targetEl=contentEl.querySelector('.stream-response-area')||contentEl;
        if(!fullText.trim()&&!thinkText.trim()){
          targetEl.innerHTML='<div style="color:var(--text-muted);font-size:13px;padding:12px 0;font-style:italic">The response timed out. Please try sending your message again.</div>';
        }
      }
      // If heartbeats are flowing but no meaningful content for 180s, auto-retry once
      // This catches the case where the API is connected but the model is stalled
      if(!_stallWarned&&noMeaningfulMs>180000&&noEventMs<10000){
        _stallWarned=true;
        console.warn(`[gyro] No meaningful content for ${Math.round(noMeaningfulMs/1000)}s — model may be stalled`);
        if(!fullText.trim()&&!thinkText.trim()&&_retryCount<_MAX_STREAM_RETRIES){
          console.warn(`[gyro] Auto-retrying stalled model (attempt ${_retryCount+1}/${_MAX_STREAM_RETRIES})`);
          clearInterval(_stallTimer);
          try{controller.abort();}catch(_){}
          msgDiv.remove();
          setChatRunning(targetChatId,false);
          area.removeEventListener('scroll',_onUserScroll);
          const _retryTid=setTimeout(()=>{
            const cur=runningStreams.get(targetChatId);
            if(cur&&cur.streamId!==streamId)return;
            sendMessage({...opts,message:text,_retryCount:_retryCount+1,targetChat:targetChatId});
          },2000);
          const _pList3=_pendingReprompts.get(targetChatId)||[];_pList3.push(_retryTid);_pendingReprompts.set(targetChatId,_pList3);
          return;
        }
        // If we can't auto-retry, at least warn the user
        setStatus('Model seems to be taking a while... you can stop and try again.');
      }
    },5000);

    // Create a live thinking panel (collapsed by default — click to expand)
    let thinkPanel=null;
    let thinkTextEl=null;
    let _lastThinkLabel='';
    function _extractThinkSubject(text){
      // Extract a short topic heading from the thinking text
      const lines=(text||'').split('\n').filter(l=>l.trim());
      // Priority 1: look for markdown headings (## Something) — walk backwards for most recent
      for(let i=lines.length-1;i>=0;i--){
        const hm=lines[i].match(/^#{1,4}\s+(.+)/);
        if(hm){let h=hm[1].trim();if(h.length>50)h=h.slice(0,50)+'…';return h;}
      }
      // Priority 2: look for bold text (**Something**) as a heading — walk backwards
      for(let i=lines.length-1;i>=Math.max(0,lines.length-15);i--){
        const bm=lines[i].match(/^\*\*(.+?)\*\*/);
        if(bm){let b=bm[1].trim();if(b.length>50)b=b.slice(0,50)+'…';return b;}
      }
      // Priority 3: find a short title-like line (< 45 chars, not a sentence)
      for(let i=lines.length-1;i>=Math.max(0,lines.length-10);i--){
        let line=lines[i].replace(/^[-•*#>\s]+/,'').trim();
        if(line.length>=5&&line.length<=45&&!/[.!?]$/.test(line)&&!/^[\W]+$/.test(line))return line;
      }
      // Fallback: last meaningful short phrase, truncated
      for(let i=lines.length-1;i>=Math.max(0,lines.length-8);i--){
        let line=lines[i].replace(/^[-•*#>\s]+/,'').trim();
        if(line.length<5||/^[\W]+$/.test(line))continue;
        if(line.length>45)line=line.slice(0,45)+'…';
        return line;
      }
      return 'your question';
    }
    function ensureThinkPanel(turnNum){
      turnNum=turnNum||1;
      // If we already have a panel for this turn, reuse it
      if(_thinkTurns[turnNum]&&_thinkTurns[turnNum].panel){
        thinkPanel=_thinkTurns[turnNum].panel;
        thinkTextEl=_thinkTurns[turnNum].textEl;
        return;
      }
      const ta=contentEl.querySelector('.think-active');
      if(ta)ta.remove();
      stopThinkingPhrases();
      const panel=document.createElement('div');
      panel.className='live-think-panel ltp-collapsed';
      const headerLabel=turnNum>1?'Thinking deeper\u2026':'Considering your question';
      panel.innerHTML='<div class="ltp-header" style="cursor:pointer">'
        +'<span class="ltp-icon">\uD83D\uDCAD</span>'
        +'<span class="ltp-label">'+headerLabel+'</span>'
        +'<span class="ltp-chevron">\u25BE</span>'
        +'<span class="ltp-dots"><span></span><span></span><span></span></span>'
        +'</div><div class="ltp-body"><div class="ltp-text"></div></div>';
      const hdr=panel.querySelector('.ltp-header');
      hdr.onclick=()=>{panel.classList.toggle('ltp-collapsed');};
      if(turnNum===1){
        contentEl.innerHTML='';
        contentEl.appendChild(panel);
      }else{
        // Insert before the response area so thinking panels stack above response
        const respArea=contentEl.querySelector('.stream-response-area');
        if(respArea){
          contentEl.insertBefore(panel,respArea);
        }else{
          contentEl.appendChild(panel);
        }
      }
      const textEl=panel.querySelector('.ltp-text');
      _thinkTurns[turnNum]={panel:panel,textEl:textEl,text:''};
      thinkPanel=panel;
      thinkTextEl=textEl;
    }

    while(true){
      const{done,value}=await reader.read();
      if(done){clearInterval(_stallTimer);break;}
      buffer+=decoder.decode(value,{stream:true});
      let nlIdx;
      while((nlIdx=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,nlIdx).trim();
        buffer=buffer.slice(nlIdx+1);
        if(!line)continue;
        try{
          const data=JSON.parse(line);
          if(data.type==='heartbeat'){
            // Keep-alive ping from backend — reset connection timer but not meaningful timer
            _lastAnyEvent=Date.now();
            continue;
          }else if(data.type==='thinking_delta'){
            _lastMeaningfulEvent=Date.now();
            if(!isThinking){
              // Starting a new thinking turn
              _thinkTurn++;
              _turnThinkText='';
              _thinkDisplayed='';
              console.log(`[gyro] thinking turn ${_thinkTurn} starting`);
            }
            isThinking=true;
            _turnThinkText+=data.text;
            thinkText+=data.text;
            if(_thinkTurns[_thinkTurn])_thinkTurns[_thinkTurn].text=_turnThinkText;
            if(canRender()){
              ensureThinkPanel(_thinkTurn);
              // Smooth typewriter: gradually reveal thinking text to avoid chunky appearance
              if(!window._thinkTypewriter){
                window._thinkTypewriter=setInterval(()=>{
                  if(!isThinking&&_thinkDisplayed.length>=_turnThinkText.length){
                    clearInterval(window._thinkTypewriter);window._thinkTypewriter=null;return;
                  }
                  if(_thinkDisplayed.length<_turnThinkText.length){
                    // Reveal 8 chars per tick (20ms interval = ~400 chars/sec for smooth streaming look)
                    const charsPerTick=8;
                    const end=Math.min(_thinkDisplayed.length+charsPerTick,_turnThinkText.length);
                    _thinkDisplayed=_turnThinkText.slice(0,end);
                    if(thinkTextEl){
                      thinkTextEl.innerHTML=_fmtThink(_thinkDisplayed);
                      const _ltpBody=thinkTextEl.parentElement;
                      if(_ltpBody)_ltpBody.scrollTop=_ltpBody.scrollHeight;
                    }
                  }
                },20);
              }
              if(_turnThinkText.length>15){
                const subj=_extractThinkSubject(_turnThinkText);
                if(subj!==_lastThinkLabel){
                  _lastThinkLabel=subj;
                  const lbl=thinkPanel.querySelector('.ltp-label');
                  if(lbl)lbl.textContent=subj;
                }
              }
              _autoScroll();
            }
          }else if(data.type==='delta'){
            _lastMeaningfulEvent=Date.now();
            // Transition from thinking to response
            if(isThinking&&thinkPanel){
              isThinking=false;
              // Stop typewriter and flush remaining thinking text
              if(window._thinkTypewriter){clearInterval(window._thinkTypewriter);window._thinkTypewriter=null;}
              if(thinkTextEl&&_turnThinkText){thinkTextEl.innerHTML=_fmtThink(_turnThinkText);}
              thinkPanel.classList.add('ltp-done');
              thinkPanel.classList.add('ltp-collapsed');
              const dotsEl=thinkPanel.querySelector('.ltp-dots');
              if(dotsEl)dotsEl.remove();
              // Update label to final state
              const lbl=thinkPanel.querySelector('.ltp-label');
              if(lbl){
                const subj=_extractThinkSubject(_turnThinkText);
                lbl.textContent='Thought about '+subj;
              }
              const body=thinkPanel.querySelector('.ltp-body');
              if(body){body.style.maxHeight='0';body.style.padding='0';}
              // Ensure response area exists (always at the end)
              let respDiv=contentEl.querySelector('.stream-response-area');
              if(!respDiv){
                respDiv=document.createElement('div');
                respDiv.className='stream-response-area';
                contentEl.appendChild(respDiv);
              }
            }
            stopThinkingPhrases();
            fullText+=data.text;
            // Start response typewriter if not running
            if(!_responseTypewriter&&canRender()){
              _responseTypewriter=setInterval(()=>{
                if(_doneReceived||!canRender()){clearInterval(_responseTypewriter);_responseTypewriter=null;return;}
                if(_responseDisplayed.length>=fullText.length)return;
                const charsPerTick=12;
                const end=Math.min(_responseDisplayed.length+charsPerTick,fullText.length);
                _responseDisplayed=fullText.slice(0,end);
                const targetEl=contentEl.querySelector('.stream-response-area')||contentEl;
                const ta=contentEl.querySelector('.think-active');
                if(ta){ta.remove();stopThinkingPhrases();}
                if(_streamDevRaw){
                  targetEl.innerHTML='<pre class="dev-raw-log">'+esc(_responseDisplayed)+'<span class="stream-cursor"></span></pre>';
                }else{
                  targetEl.innerHTML=fmtLive(_responseDisplayed);
                  if(!schoolMode)renderMathInElementSafe(targetEl);
                }
                _autoScroll();
              },20);
            }
          // -- Mid-stream media loading event --
          }else if(data.type==='media_loading'){
            _mediaLoadingCount++;
            // Insert an inline marker into fullText so fmtLive renders a loading card
            const info=data.query||data.ticker||data.prompt||'';
            fullText+=`\n[[[MEDIA:${data.kind}:${data.index}:${info}]]]\n`;
            // Flush typewriter and render immediately to show the loading card
            _responseDisplayed=fullText;
            if(canRender()){
              const targetEl=contentEl.querySelector('.stream-response-area')||contentEl;
              targetEl.innerHTML=fmtLive(fullText);
              renderMathInElementSafe(targetEl);
              _autoScroll();
            }
          }else if(data.type==='done'){
            _doneReceived=true;
            _activeStreamState.delete(targetChatId);
            clearInterval(_stallTimer);
            clearInterval(_partialSaveInterval);
            // Clean up thinking typewriter
            if(window._thinkTypewriter){clearInterval(window._thinkTypewriter);window._thinkTypewriter=null;}
            // Clean up response typewriter
            if(_responseTypewriter){clearInterval(_responseTypewriter);_responseTypewriter=null;}
            _responseDisplayed=fullText;
            // Immediately mark chat as not running so UI updates (stop button ? send button)
            {const cur=runningStreams.get(targetChatId);if(!cur||cur.streamId===streamId)setChatRunning(targetChatId,false);}
            // Collapse ALL live thinking panels
            contentEl.querySelectorAll('.live-think-panel').forEach(p=>{
              p.classList.add('ltp-done');
              if(!p.classList.contains('ltp-collapsed'))p.classList.add('ltp-collapsed');
              const dotsEl=p.querySelector('.ltp-dots');
              if(dotsEl)dotsEl.remove();
              const body=p.querySelector('.ltp-body');
              if(body){body.style.maxHeight='0';body.style.padding='0';}
            });
            // Remove ALL thinking/loading indicators
            contentEl.querySelectorAll('.think-active,.live-think-panel:not(.ltp-done),.thinking').forEach(el=>{
              el.classList.add('ltp-done');
              el.style.animation='none';
            });
            stopThinkingPhrases();
            await new Promise(r=>setTimeout(r,150));
            let finalHTML='';
            let displayReply=data.reply||'';
            // Extract thinking from reply if not already streamed live
            let _replyThinkText='';
            if(!thinkText){
              const thinkMatch=displayReply.match(/<<<THINKING>>>([\s\S]*?)<<<END_THINKING>>>/);
              if(thinkMatch) _replyThinkText=thinkMatch[1].trim();
            }
            // Always strip thinking tags from display reply
            displayReply=displayReply.replace(/<<<THINKING>>>[\s\S]*?<<<END_THINKING>>>/g,'').replace(/<<<\/?THINKING\/?>>>/g,'').replace(/<<<\/?END_THINKING\/?>>>/g,'').trim();
            // Render think blocks — one per thinking turn
            const turnKeys=Object.keys(_thinkTurns).sort((a,b)=>a-b);
            if(turnKeys.length>0){
              for(const tn of turnKeys){
                const t=(_thinkTurns[tn].text||'').trim();
                if(t)finalHTML+=renderThinkBlock(t);
              }
            }else if(thinkText){
              finalHTML+=renderThinkBlock(thinkText);
            } else if(_replyThinkText){
              finalHTML+=renderThinkBlock(_replyThinkText);
            }
            // Parse all choice blocks (supports multiple sequential questions)
            const choiceBlockRe=/(?:<<<QUESTION:(.*?)>>>\n)?<<<CHOICES(?:\|multi)?>>>\n([\s\S]*?)<<<END_CHOICES>>>/g;
            let choiceBlockMatch;
            const choiceBlocks=[];
            while((choiceBlockMatch=choiceBlockRe.exec(displayReply))!==null){
              const isMulti=/<<<CHOICES\|multi>>>/.test(choiceBlockMatch[0]);
              choiceBlocks.push({question:(choiceBlockMatch[1]||'').trim(),choices:choiceBlockMatch[2].trim().split('\n').filter(c=>c.trim()),multi:isMulti});
            }
            displayReply=displayReply.replace(/(?:<<<QUESTION:.*?>>>\n)?<<<CHOICES(?:\|multi)?>>>[\s\S]*?<<<END_CHOICES>>>/g,'').trim();
            // Strip any continuation markers from visible output
            displayReply=displayReply.replace(/<<<CONTINUE>>>/g,'').trim();
            if(_streamDevRaw){
              // In dev raw mode, show the full unprocessed AI response with all tags
              finalHTML+='<pre class="dev-raw-log">'+esc(fullText||data.reply||displayReply)+'</pre>';
            }else{
              // If thinking was used but no response was generated, show a helpful message
              if(!displayReply.trim()&&(thinkText||_replyThinkText)){
                finalHTML+='<div style="color:var(--text-muted);font-size:13px;padding:12px 0;font-style:italic">The model used its full output on thinking and didn\'t produce a response. Try sending your message again or reducing the thinking level.</div>';
              }else{
                finalHTML+=fmt(displayReply);
              }
            }
            if(!_streamDevRaw&&choiceBlocks.length){
              const validBlocks=choiceBlocks.filter(cb=>cb.choices.length);
              if(validBlocks.length)finalHTML+=renderChoiceWizard(validBlocks);
            }
            const artifactIds=registerArtifactsFromReply(displayReply,data.files||[]);
            if(!_streamDevRaw&&data.files?.length){
              finalHTML+='<div class="fops">';
              for(const f of data.files){const fname=f.path.split('/').pop().split('\\').pop();finalHTML+=`<div class="fo"><a href="#" onclick="event.preventDefault();openWorkspaceFile('${encodeURIComponent(f.path)}')" class="fo-link">📄 ${esc(f.action==='created'?'Created':'Updated')}: ${esc(fname)}</a></div>`;}
              finalHTML+='</div>';
            }
            if(!_streamDevRaw)finalHTML+=renderArtifactCards(artifactIds,'ready');
            if(!_streamDevRaw&&data.code_results?.length){
              for(const cr of data.code_results){
                const statusCls=cr.success?'code-run-success':'code-run-error';
                let filesHtml='';
                if(cr.files?.length){
                  filesHtml='<div class="crb-files">';
                  for(const gf of cr.files){
                    const hasData=!!gf.data;
                    const viewUrl=hasData?`data:${gf.mime||'image/png'};base64,${gf.data}`:'/api/files/view?path='+encodeURIComponent(gf.path);
                    if(gf.is_image){
                      filesHtml+=`<div class="crb-file crb-file-image"><img src="${viewUrl}" alt="${esc(gf.name)}" style="max-width:100%;max-height:400px;border-radius:var(--r-md);margin:6px 0;cursor:pointer" onclick="openImageLightbox(this.src,'${esc(gf.name).replace(/'/g,"\\'")}')" onerror="this.style.display='none'"><div class="crb-file-link">`;
                      if(hasData){const cid=cacheChatFile(gf.data,gf.mime,gf.name);filesHtml+=`<a href="#" onclick="event.preventDefault();downloadChatFile(${cid})" class="fo-link">📎 ${esc(gf.name)}</a>`;}
                      else{filesHtml+=`<a href="/api/files/download?path=${encodeURIComponent(gf.path)}" target="_blank" class="fo-link">📎 ${esc(gf.name)}</a>`;}
                      filesHtml+=`<span class="crb-file-size">${gf.size>1024?(gf.size/1024).toFixed(1)+'KB':gf.size+'B'}</span></div></div>`;
                    }else{
                      filesHtml+=`<div class="crb-file">`;
                      if(hasData){const cid=cacheChatFile(gf.data,gf.mime||'application/octet-stream',gf.name);filesHtml+=`<a href="#" onclick="event.preventDefault();downloadChatFile(${cid})" class="fo-link">📎 ${esc(gf.name)}</a>`;}
                      else{filesHtml+=`<a href="/api/files/download?path=${encodeURIComponent(gf.path)}" target="_blank" class="fo-link">📎 ${esc(gf.name)}</a>`;}
                      filesHtml+=`<span class="crb-file-size">${gf.size>1024?(gf.size/1024).toFixed(1)+'KB':gf.size+'B'}</span></div>`;
                    }
                  }
                  filesHtml+='</div>';
                }
                finalHTML+=`<div class="code-run-block ${statusCls}"><div class="crb-header"><span class="crb-lang">${esc(cr.language)}</span><span class="crb-status">${cr.success?'Executed':'Error'}</span></div><pre class="crb-code"><code>${esc(cr.code)}</code></pre><div class="crb-output-label">Output</div><pre class="crb-output">${esc(cr.output)}</pre>${filesHtml}</div>`;
              }
            }
            if(data.memory_added?.length)finalHTML+=`<div class="mops">Remembered: ${data.memory_added.map(esc).join('; ')}</div>`;
            // -- Handle reminders set by AI --
            if(data.reminders_set?.length){
              const state=loadProductivityState();
              for(const r of data.reminders_set){
                state.reminders.push({id:'r_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6),due:r.due||'',text:r.text||'',done:false,created:new Date().toISOString()});
              }
              saveProductivityState(state);
              finalHTML+=`<div class="mops">${data.reminders_set.length} reminder${data.reminders_set.length!==1?'s':''} set</div>`;
              refreshHomeWidgets();
            }

            // -- Image search — show loading placeholders for pending images --
            if(!_streamDevRaw&&data.pending_images?.length){
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
            if(!_streamDevRaw&&data.image_results?.length){
              const imgMap={};
              for(const ir of data.image_results){
                imgMap[ir.index]=renderImageBlock(ir);
              }
              finalHTML=finalHTML.replace(/<p>\s*%%%IMGBLOCK:(\d+)%%%\s*<\/p>|%%%IMGBLOCK:(\d+)%%%/g,(match,idx1,idx2)=>{
                const idx=parseInt(idx1||idx2,10);
                return imgMap[idx]||'';
              });
            }
            if(!_streamDevRaw&&data.failed_images?.length){
              for(const fq of data.failed_images){
                finalHTML+=`<div class="img-search-fail"><span class="img-search-fail-icon">🖼</span> Image search for "${esc(fq)}" couldn't load — try again or search manually.</div>`;
              }
            }

            // -- AI image generation — show loading placeholders --
            if(!_streamDevRaw&&data.pending_generations?.length){
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
            if(!_streamDevRaw&&data.generated_images?.length){
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

            // -- Stock data — ensure loading placeholders exist for pending stocks --
            if(!_streamDevRaw&&data.pending_stocks?.length){
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
            if(!_streamDevRaw&&data.stock_results?.length){
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

            // -- HuggingFace results — render inline --
            if(!_streamDevRaw&&data.hf_results?.length){
              for(const hr of data.hf_results){
                const hfHTML=renderHFResult(hr);
                const re=new RegExp(`<p>\\s*%%%HFBLOCK:${hr.index}%%%\\s*</p>|%%%HFBLOCK:${hr.index}%%%`,'g');
                const before=finalHTML;
                finalHTML=finalHTML.replace(re,hfHTML);
                if(finalHTML===before){
                  finalHTML+=hfHTML;
                }
              }
            }

            // -- AI-triggered research agent --
            if(data.research_trigger&&!choiceBlocks.length){
              const rq=data.research_trigger;
              // Show the AI's text first
              if(canRender()){
                contentEl.innerHTML=finalHTML;
                if(data.title&&data.title!=='New Chat')document.getElementById('topTitle').textContent=data.title;
              }
              // Create a SEPARATE message div for the research agent
              const chatArea=document.getElementById('chatArea');
              const researchMsgDiv=document.createElement('div');
              researchMsgDiv.className='msg kairo';
              const researchContentEl=document.createElement('div');
              researchContentEl.className='msg-content';
              researchMsgDiv.innerHTML='';
              researchMsgDiv.appendChild(researchContentEl);
              chatArea.appendChild(researchMsgDiv);
              _autoScroll();
              setChatRunning(targetChatId,false);
              setChatRunning(targetChatId,true,{type:'research'});
              try{
                await showResearchPlan(rq, researchContentEl, chatArea, targetChatId);
                await refreshChats();
                setChatRunning(targetChatId,false);
              }catch(e){
                researchContentEl.innerHTML+=`<div style="color:var(--red);margin-top:12px">${esc(e.message||'Research failed.')}</div>`;
                setStatus('Research failed.');
                setChatRunning(targetChatId,false);
              }
              return;
            }

            if(canRender()){
              contentEl.style.opacity='1';contentEl.style.filter='';contentEl.style.transform='';
              // Only show action buttons on plain AI text responses
              const _hasSpecialContent=!!(data.research_trigger||data.code_auto_reprompt||data.pending_images?.length||data.pending_generations?.length||data.pending_stocks?.length);
              const _actionsHTML=_hasSpecialContent?'':`<div class="msg-actions"><button class="msg-action-btn" onclick="copyMsg(this)">Copy</button><button class="msg-action-btn" onclick="retryMsg(this)">Retry</button></div>`;
              contentEl.innerHTML=finalHTML+_actionsHTML;
              renderMathInElementSafe(contentEl);
              contentEl.querySelectorAll('.stream-cursor').forEach(el=>el.remove());
              if(!schoolMode){
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
              }
              if(data.title&&data.title!=='New Chat')document.getElementById('topTitle').textContent=data.title;
              // Render mermaid diagrams scoped to this message
              setTimeout(()=>{
                const mermaidEls=contentEl.querySelectorAll('pre.mermaid:not([data-processed])');
                if(mermaidEls.length){
                  try{
                    mermaid.run({nodes:mermaidEls}).then(()=>enhanceMermaidDiagrams()).catch(()=>enhanceMermaidDiagrams());
                  }catch(e){
                    console.log('Mermaid render error:',e);
                    enhanceMermaidDiagrams();
                  }
                }
              },100);
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
                      temp.innerHTML=`<div class="img-gen-card" style="position:relative;border-radius:14px;overflow:hidden;border:1px solid var(--border);background:var(--bg-surface);max-width:360px"><img src="${img.url}" alt="${esc(img.prompt||'Generated image')}" style="width:100%;border-radius:14px;display:block;cursor:pointer" onclick="openLightbox(this.src)"><div style="padding:10px 14px;font-size:12px;color:var(--text-secondary)">🎨 ${esc(img.prompt||'Generated image')}</div></div>`;
                      loader.replaceWith(temp.firstElementChild||temp);
                    }
                  }
                }
              }
            }
            refreshChats();
            // -- Auto-reprompt after code execution --
            // When code was executed, automatically send execution results back to the AI
            // so it can respond accurately (present files on success, debug on failure)
            if(data.code_auto_reprompt&&_codeRepromptCount<_MAX_CODE_REPROMPTS){
              _codeRepromptCount++;
              const summary=data.code_execution_summary||'Code execution completed.';
              let repromptMsg;
              if(data.code_all_success){
                repromptMsg=`[SYSTEM] Code execution completed. Results:\n${summary}\n\nPresent the created files to the user. Link to files using [text](/api/files/download?path=FILENAME) format. Do NOT regenerate the code — just describe what was created and provide the download link(s). Do NOT trigger <<<DEEP_RESEARCH>>> or any other tools.`;
              }else{
                repromptMsg=`[SYSTEM] Code execution FAILED. Results:\n${summary}\n\nThe code you wrote failed to execute. Do NOT claim it was successful. Analyze the error, explain what went wrong to the user, and provide a corrected version of the code using <<<CODE_EXECUTE: python>>>...<<<END_CODE>>> tags. Do NOT trigger <<<DEEP_RESEARCH>>> or any other tools.`;
              }
              setStatus(data.code_all_success?'Code executed — presenting results...':'Code failed — retrying...');
              const _repromptChatId=targetChatId;
              const _repromptStreamId=streamId;
              const _tid=setTimeout(()=>{
                // Guard: only fire if this stream is still the active one
                const cur=runningStreams.get(_repromptChatId);
                if(cur&&cur.streamId!==_repromptStreamId)return;
                sendMessage({silent:true,noThinking:data.code_all_success,message:repromptMsg,targetChat:_repromptChatId});
              },800);
              const _pList=_pendingReprompts.get(_repromptChatId)||[];_pList.push(_tid);_pendingReprompts.set(_repromptChatId,_pList);
            }
            setStatus('Done. Ask a follow-up or start something new.');
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
              _responseDisplayed=fullText;
              if(canRender()){
                const targetEl=contentEl.querySelector('.stream-response-area')||contentEl;
                targetEl.innerHTML=fmtLive(fullText);
                _autoScroll();
              }
            }else if(!_streamDevRaw&&canRender()){
              // Post-done: replace DOM loader
              const loader=contentEl.querySelector(`#img-loader-${data.image.index}`);
              if(loader){
                const html=renderImageBlock(data.image);
                const temp=document.createElement('div');
                temp.innerHTML=html;
                loader.replaceWith(temp.firstElementChild||temp);
              }
              _autoScroll();
            }
          }else if(data.type==='image_failed'){
            _genFailures.push({type:'image_search',query:data.query||''});
            if(!_doneReceived){
              _mediaLoadingCount=Math.max(0,_mediaLoadingCount-1);
              if(_mediaLoadingCount===0&&canRender()){
                _responseDisplayed=fullText;
                const targetEl=contentEl.querySelector('.stream-response-area')||contentEl;
                targetEl.innerHTML=fmtLive(fullText);
                _autoScroll();
              }
            }else if(!_streamDevRaw&&canRender()){
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
              _responseDisplayed=fullText;
              if(canRender()){
                const targetEl=contentEl.querySelector('.stream-response-area')||contentEl;
                targetEl.innerHTML=fmtLive(fullText);
                _autoScroll();
              }
            }else if(!_streamDevRaw&&canRender()){
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
              _autoScroll();
            }
          }else if(data.type==='image_gen_failed'){
            _genFailures.push({type:'image_gen',prompt:data.prompt||'',error:data.error||''});
            if(!_doneReceived){
              _mediaLoadingCount=Math.max(0,_mediaLoadingCount-1);
              if(_mediaLoadingCount===0&&canRender()){
                _responseDisplayed=fullText;
                const targetEl=contentEl.querySelector('.stream-response-area')||contentEl;
                targetEl.innerHTML=fmtLive(fullText);
                _autoScroll();
              }
            }else if(!_streamDevRaw&&canRender()){
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
              _responseDisplayed=fullText;
              if(canRender()){
                const targetEl=contentEl.querySelector('.stream-response-area')||contentEl;
                targetEl.innerHTML=fmtLive(fullText);
                _autoScroll();
              }
            }else if(!_streamDevRaw&&canRender()){
              // Post-done: replace DOM loader
              const loader=contentEl.querySelector(`#stock-loader-${data.stock.index}`);
              if(loader){
                const html=renderStockCard(data.stock.ticker, data.stock.data);
                const temp=document.createElement('div');
                temp.innerHTML=html;
                loader.replaceWith(temp.firstElementChild||temp);
              }
              _autoScroll();
            }
          }else if(data.type==='stock_failed'){
            if(!_doneReceived){
              _mediaLoadingCount=Math.max(0,_mediaLoadingCount-1);
              if(_mediaLoadingCount===0&&canRender()){
                _responseDisplayed=fullText;
                const targetEl=contentEl.querySelector('.stream-response-area')||contentEl;
                targetEl.innerHTML=fmtLive(fullText);
                _autoScroll();
              }
            }else if(!_streamDevRaw&&canRender()){
              const loader=contentEl.querySelector(`#stock-loader-${data.index}`);
              if(loader){
                loader.innerHTML=`<div class="stock-card"><div class="stock-card-error">Failed to load ${esc(data.ticker)} stock data: ${esc(data.error||'Unknown error')}</div></div>`;
                loader.classList.remove('stock-loading-placeholder');
              }
            }
          }else if(data.type==='hf_executing'){
            // HF Space execution started post-stream (stop-and-wait)
            if(canRender()){
              const targetEl=contentEl.querySelector('.stream-response-area')||contentEl;
              let hfWrap=contentEl.querySelector('#hf-exec-wrap');
              if(!hfWrap){
                hfWrap=document.createElement('div');
                hfWrap.id='hf-exec-wrap';
                targetEl.appendChild(hfWrap);
              }
              _autoScroll();
            }
          }else if(data.type==='hf_loading'){
            // Individual HF Space starting to execute
            if(canRender()){
              let hfWrap=contentEl.querySelector('#hf-exec-wrap');
              if(!hfWrap){
                const targetEl=contentEl.querySelector('.stream-response-area')||contentEl;
                hfWrap=document.createElement('div');
                hfWrap.id='hf-exec-wrap';
                targetEl.appendChild(hfWrap);
              }
              const loader=document.createElement('div');
              loader.id=`hf-loader-${data.index}`;
              loader.className='hf-loading-placeholder';
              loader.innerHTML=`<div style="margin:12px 0;border:1px solid var(--border);border-radius:12px;overflow:hidden;background:var(--bg-surface);"><div style="padding:12px 16px;display:flex;align-items:center;gap:8px;background:var(--bg-deep);"><span style="font-size:16px">🤗</span><div><div style="font-size:12px;font-weight:600;color:var(--text-primary)">Running ${esc(data.space||'HuggingFace Space')}...</div><div style="font-size:10px;color:var(--text-muted);margin-top:2px">${esc(data.input||'Processing...')}</div></div></div><div style="padding:16px;display:flex;align-items:center;gap:10px;"><div class="dots" style="display:flex;gap:3px"><span></span><span></span><span></span></div><span style="font-size:11px;color:var(--text-muted)">This may take a moment...</span></div></div>`;
              hfWrap.appendChild(loader);
              _autoScroll();
            }
          }else if(data.type==='hf_space_result'){
            // HF result arrived (post-stream, before done)
            if(canRender()){
              const loader=contentEl.querySelector(`#hf-loader-${data.hf.index}`);
              if(loader){
                const html=renderHFResult(data.hf);
                const temp=document.createElement('div');
                temp.innerHTML=html;
                loader.replaceWith(temp.firstElementChild||temp);
              }
              _autoScroll();
            }
          }else if(data.type==='hf_space_failed'){
            if(canRender()){
              const loader=contentEl.querySelector(`#hf-loader-${data.index}`);
              if(loader){
                loader.innerHTML=`<div style="margin:12px 0;padding:12px 16px;border:1px solid var(--error);border-radius:12px;background:rgba(239,68,68,0.08);"><div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;"><span style="font-size:14px">🤗</span><span style="font-size:12px;font-weight:600;color:var(--error)">HuggingFace Space failed</span></div><div style="font-size:11px;color:var(--text-muted)">${esc(data.error||'Unknown error')}</div>${data.space?`<div style="font-size:10px;color:var(--text-muted);margin-top:4px">Space: ${esc(data.space)}</div>`:''}</div>`;
                loader.classList.remove('hf-loading-placeholder');
              }
              _autoScroll();
            }
          }else if(data.type==='gen_ops_complete'){
            // All generative operations (image gen, image search, stock) are done
            // Stock agent: run multi-step analysis instead of simple reprompt
            if(data.stock_reprompt&&!_genFailures.length){
              setChatRunning(targetChatId,false);
              setStatus('Running stock analysis agent...');
              // Collect the fetched stock data objects for the agent
              const agentStockData=[];
              if(window._streamMediaResults){
                for(const [key,result] of Object.entries(window._streamMediaResults)){
                  if(key.startsWith('stock-')&&result&&result.data){
                    agentStockData.push(result.data);
                  }
                }
              }
              // Also try from the _fetched list in done payload
              if(!agentStockData.length&&data.fetched_stocks){
                for(const sr of data.fetched_stocks){
                  if(sr.data&&!sr.data.error)agentStockData.push(sr.data);
                }
              }
              if(agentStockData.length){
                // Create a new message div for the stock analysis
                const chatArea=document.getElementById('chatArea');
                const agentMsgDiv=document.createElement('div');
                agentMsgDiv.className='msg kairo';
                const agentContentEl=document.createElement('div');
                agentContentEl.className='msg-content';
                agentMsgDiv.innerHTML='';
                agentMsgDiv.appendChild(agentContentEl);
                chatArea.appendChild(agentMsgDiv);
                _autoScroll();
                try{
                  const userQ=data.user_query||'Analyze this stock';
                  await runStockAgent(agentStockData, userQ, agentContentEl, chatArea, targetChatId);
                  await refreshChats();
                }catch(e){
                  agentContentEl.innerHTML+=`<div style="color:var(--red);margin-top:12px">${esc(e.message||'Stock analysis failed.')}</div>`;
                }
                setChatRunning(targetChatId,false);
                setStatus('Stock analysis complete.');
              }else{
                // Fallback: simple reprompt if we couldn't collect stock data objects
                try{
                  sendMessage({silent:true,noThinking:true,message:`[SYSTEM] Stock data has been loaded. Here is the live data from Yahoo Finance for the stocks you just displayed:\n\n${data.stock_reprompt}\n\nNow analyze this data for the user. Reference the ACTUAL numbers shown above. The stock cards are already visible to the user — do NOT re-embed <<<STOCK>>> tags. Instead, provide a thorough analysis based on the real data. Include the mandatory disclaimer.`,targetChat:targetChatId});
                }catch(_){}
              }
              return; // skip the normal gen_ops_complete handling below
            }
            if(_genFailures.length>0){
              // Some ops failed — notify the AI so it can report to user
              const failMsgs=_genFailures.map(f=>{
                if(f.type==='image_gen')return `Image generation failed for "${f.prompt}": ${f.error}`;
                return `Image search failed for "${f.query}"`;
              });
              setChatRunning(targetChatId,false);
              setStatus('Some operations failed.');
              try{
                sendMessage({silent:true,noThinking:true,message:`[SYSTEM] The following operations failed:\n${failMsgs.join('\n')}\n\nPlease acknowledge the failures to the user. Do NOT retry automatically. Let them know what happened and suggest they try again if they want.`,targetChat:targetChatId});
              }catch(_){}
            }else{
              // No pending continue, just mark done
              setStatus('Done. Ask a follow-up or start something new.');
            }
          }
        }catch(e){}
      }
    }
  }catch(e){
    if(e.name==='AbortError'||controller.signal.aborted){
      clearInterval(_stallTimer);
      stopThinkingPhrases();
      if(canRender()&&(!contentEl.innerHTML||contentEl.querySelector('.think-active'))){msgDiv.remove();}
    }else{
      stopThinkingPhrases();
      // Auto-retry on connection error if no content was received yet
      const _hasContent=contentEl&&contentEl.textContent&&contentEl.textContent.trim().length>20;
      if(_retryCount<_MAX_STREAM_RETRIES&&!_hasContent){
        console.warn(`[gyro] Stream connection error (attempt ${_retryCount+1}/${_MAX_STREAM_RETRIES}), retrying...`,e.message);
        msgDiv.remove();
        setChatRunning(targetChatId,false);
        area.removeEventListener('scroll',_onUserScroll);
        await new Promise(r=>setTimeout(r,1500*(_retryCount+1)));
        return sendMessage({...opts,message:text,_retryCount:_retryCount+1,targetChat:targetChatId});
      }
      const errDetail=e.message||'Unknown error';
      const retryHint=_retryCount>0?' (retried '+_retryCount+' time'+(_retryCount>1?'s)':')'):'';
      if(canRender())contentEl.innerHTML=`<div style="color:var(--red)">Connection error: ${esc(errDetail)}${retryHint}<br><small>Your network may be blocking streaming responses. Try refreshing the page.</small></div>`;
    }
  }finally{
    clearInterval(_stallTimer);
    clearInterval(_partialSaveInterval);
    if(_responseTypewriter){clearInterval(_responseTypewriter);_responseTypewriter=null;}
    // -- Handle stream ending without a done event (connection drop, timeout, etc.) --
    if(!_doneReceived&&canRender()){
      stopThinkingPhrases();
      // Collapse any still-active thinking panel
      if(thinkPanel){
        thinkPanel.classList.add('ltp-done');
        if(!thinkPanel.classList.contains('ltp-collapsed'))thinkPanel.classList.add('ltp-collapsed');
        const dotsEl=thinkPanel.querySelector('.ltp-dots');
        if(dotsEl)dotsEl.remove();
        const body=thinkPanel.querySelector('.ltp-body');
        if(body){body.style.maxHeight='0';body.style.padding='0';}
        const lbl=thinkPanel.querySelector('.ltp-label');
        if(lbl&&thinkText)lbl.textContent='Thought about '+_extractThinkSubject(thinkText);
      }
      // Build whatever content we have
      let recoveryHTML='';
      if(thinkText)recoveryHTML+=renderThinkBlock(thinkText);
      if(fullText){
        recoveryHTML+=fmt(fullText);
      }else{
        recoveryHTML+='<div style="color:var(--text-muted);font-style:italic;padding:8px 0">Response was interrupted. Try sending your message again.</div>';
      }
      contentEl.innerHTML=recoveryHTML;
      contentEl.querySelectorAll('.stream-cursor').forEach(el=>el.remove());
      setStatus('Response interrupted — try again.');
    }
    const cur=runningStreams.get(targetChatId);
    if(!cur||cur.streamId===streamId)setChatRunning(targetChatId,false);
    _activeStreamState.delete(targetChatId);
    area.removeEventListener('scroll',_onUserScroll);
    document.removeEventListener('visibilitychange',_onVisChange);
  }
}

// Light markdown formatter for thinking text (bold, italic, headers)
function _fmtThink(raw){
  let t=esc(raw);
  // **bold**
  t=t.replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>');
  // *italic*
  t=t.replace(/\*([^*]+)\*/g,'<i>$1</i>');
  return t;
}

function renderThinkBlock(thinkText,opts){
  opts=opts||{};
  const passNum=opts.pass||0;
  const passLabel=opts.label||'';
  const lines=thinkText.split('\n').filter(l=>l.trim());
  // Use last meaningful line as the summary topic
  let summary='your question';
  for(let i=lines.length-1;i>=0;i--){
    let line=lines[i].replace(/^[-•*#>\s]+/,'').trim();
    if(line.length>=5&&!/^[\W]+$/.test(line)){
      summary=line.length>60?line.slice(0,60)+'…':line;
      break;
    }
  }
  const icon=passNum===2?'🔍':'💭';
  const prefix=passNum===2?'Verified: ':passNum===1?'Thought about ':'Thought about ';
  const passBadge=passLabel?`<span class="think-pass-tag">${esc(passLabel)}</span>`:'';
  const passClass=passNum?` think-pass-${passNum}`:'';
  return `<div class="think-block${passClass}" onclick="this.classList.toggle('expanded')">
    <div class="think-header"><span>${icon}</span> ${passBadge}<span>${prefix}${esc(summary)}</span> <span class="think-chevron">▾</span></div>
    <div class="think-content">${_fmtThink(thinkText)}</div>
  </div>`;
}

function addMsg(role,text,files,extra={}){
  const area=document.getElementById('chatArea');const div=document.createElement('div');
  div.className=`msg ${role}`;let html='';
  if(role==='kairo')html+='<div class="lbl">Gyro</div>';
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
  // On reload: render persisted image attachments (stored as extra.images)
  if(role==='user'&&!extra.files?.length&&extra.images?.length){
    const previews=extra.images.map(img=>{
      const name=esc(img.name||'image');
      if(img.data) return `<div class="user-file-preview image"><img src="data:${img.mime||'image/png'};base64,${img.data}" alt="${name}" loading="lazy"></div>`;
      return `<div class="user-file-preview"><span>${name}</span></div>`;
    }).join('');
    html+=`<div class="msg-user-files">${previews}</div>`;
  }
  // On reload: render document attachment chips
  if(role==='user'&&!extra.files?.length&&extra.documents?.length){
    const previews=extra.documents.map(d=>`<div class="user-file-preview"><span>${esc(d.name||'document')}</span></div>`).join('');
    html+=`<div class="msg-user-files">${previews}</div>`;
  }
  // On reload: render text file name chips
  if(role==='user'&&!extra.files?.length&&!extra.images?.length&&extra.file_name){
    const names=extra.file_name.split(', ');
    const previews=names.map(n=>`<div class="user-file-preview"><span>${esc(n)}</span></div>`).join('');
    html+=`<div class="msg-user-files">${previews}</div>`;
  }
  let displayText=text||'';
  // Extract ALL thinking blocks (supports multiple interleaved thinking turns)
  const _thinkBlockRe=/<<<THINKING>>>([\s\S]*?)<<<END_THINKING>>>/g;
  let _tbMatch;
  while((_tbMatch=_thinkBlockRe.exec(displayText))!==null){
    const thinkPart=_tbMatch[1].trim();
    if(thinkPart)html+=renderThinkBlock(thinkPart);
  }
  displayText=displayText.replace(/<<<THINKING>>>[\s\S]*?<<<END_THINKING>>>/g,'');
  // Strip any remaining thinking tags
  displayText=displayText.replace(/<<<\/?THINKING\/?>>>/g,'').replace(/<<<\/?END_THINKING\/?>>>/g,'').trim();
  // Parse all choice blocks (supports multiple sequential questions)
  const choiceBlockRe2=/(?:<<<QUESTION:(.*?)>>>\n)?<<<CHOICES(?:\|multi)?>>>\n([\s\S]*?)<<<END_CHOICES>>>/g;
  let cbm2;
  const cBlocks=[];
  while((cbm2=choiceBlockRe2.exec(displayText))!==null){
    const isMulti=/<<<CHOICES\|multi>>>/.test(cbm2[0]);
    cBlocks.push({question:(cbm2[1]||'').trim(),choices:cbm2[2].trim().split('\n').filter(c=>c.trim()),multi:isMulti});
  }
  displayText=displayText.replace(/(?:<<<QUESTION:.*?>>>\n)?<<<CHOICES(?:\|multi)?>>>[\s\S]*?<<<END_CHOICES>>>/g,'').trim();
  // Detect research/stock agent messages early — skip fmt() for these since the card replaces everything
  const _isResearchMsg=!!(extra.research_agent||(role==='kairo'&&/^## (?:Intelligence Gathering|📋 Intelligence Brief)/m.test(displayText)));
  const _isStockMsg=!!extra.stock_agent;
  // Long user text ? collapsible file block (only for code, not regular text)
  const _looksLikeCode=(function(t){
    if(t.length<=600)return false;
    // Explicit code fences ? definitely code
    if(/```/.test(t))return true;
    const lines=t.split('\n');
    // Single-line pastes are never "code files"
    if(lines.length<4)return false;
    let codeSignals=0;
    const totalLines=lines.length;
    // Check for consistent indentation (spaces/tabs at start)
    const indentedLines=lines.filter(l=>l.length>0&&/^[\t ]{2,}/.test(l)).length;
    if(indentedLines/Math.max(totalLines,1)>0.3)codeSignals+=2;
    // Check for code-like syntax
    const joined=t;
    if(/[{}\[\]];?\s*$/.test(joined))codeSignals++;
    if((joined.match(/[{}();]/g)||[]).length>totalLines*0.3)codeSignals+=2;
    if(/\b(function|const |let |var |import |export |class |def |return |if\s*\(|for\s*\(|while\s*\(|=>|async |await )\b/.test(joined))codeSignals+=2;
    if(/\b(public |private |static |void |int |string |bool |float )\b/i.test(joined))codeSignals++;
    if(/#include|#import|#define|#pragma/.test(joined))codeSignals+=2;
    if(/\b(SELECT |INSERT |UPDATE |DELETE |FROM |WHERE |JOIN )\b/i.test(joined)&&(joined.match(/\b(SELECT|FROM|WHERE)\b/gi)||[]).length>=2)codeSignals+=2;
    // HTML/XML tags
    if(/<\/?[a-z][\w-]*[\s>]/i.test(joined)&&(joined.match(/<\/?[a-z]/gi)||[]).length>3)codeSignals+=2;
    // File paths or URLs in code context
    if(/\b(https?:\/\/|\/[\w]+\/[\w]+|\.\/|\.\.\/)\b/.test(joined)&&codeSignals>0)codeSignals++;
    return codeSignals>=3;
  })(displayText);
  if(role==='user'&&_looksLikeCode){
    const lines=displayText.split('\n');
    const preview=lines.slice(0,3).join('\n');
    html+=`<div class="user-paste-file"><div class="upf-header" onclick="this.parentElement.classList.toggle('upf-expanded')">`
      +`<span class="upf-icon">📄</span><span class="upf-label">Pasted code (${lines.length} lines)</span><span class="upf-chevron">▾</span></div>`
      +`<div class="upf-preview">${esc(preview)}${lines.length>3?'\n…':''}</div>`
      +`<div class="upf-full"><pre>${esc(displayText)}</pre></div></div>`;
  } else if(devRawMode&&role==='kairo'){
    html+='<pre class="dev-raw-log">'+esc(extra.raw_text||text||'')+'</pre>';
  } else if(!_isResearchMsg&&!_isStockMsg){
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
          const hasData=!!gf.data;
          const viewUrl=hasData?`data:${gf.mime||'image/png'};base64,${gf.data}`:'/api/files/view?path='+encodeURIComponent(gf.path);
          if(gf.is_image){
            filesHtml+=`<div class="crb-file crb-file-image"><img src="${viewUrl}" alt="${esc(gf.name)}" style="max-width:100%;max-height:400px;border-radius:var(--r-md);margin:6px 0;cursor:pointer" onclick="openImageLightbox(this.src,'${esc(gf.name).replace(/'/g,"\\'")}')" onerror="this.style.display='none'"><div class="crb-file-link">`;
            if(hasData){const cid=cacheChatFile(gf.data,gf.mime,gf.name);filesHtml+=`<a href="#" onclick="event.preventDefault();downloadChatFile(${cid})" class="fo-link">📎 ${esc(gf.name)}</a>`;}
            else{filesHtml+=`<a href="/api/files/download?path=${encodeURIComponent(gf.path)}" target="_blank" class="fo-link">📎 ${esc(gf.name)}</a>`;}
            filesHtml+=`<span class="crb-file-size">${gf.size>1024?(gf.size/1024).toFixed(1)+'KB':gf.size+'B'}</span></div></div>`;
          }else{
            filesHtml+=`<div class="crb-file">`;
            if(hasData){const cid=cacheChatFile(gf.data,gf.mime||'application/octet-stream',gf.name);filesHtml+=`<a href="#" onclick="event.preventDefault();downloadChatFile(${cid})" class="fo-link">📎 ${esc(gf.name)}</a>`;}
            else{filesHtml+=`<a href="/api/files/download?path=${encodeURIComponent(gf.path)}" target="_blank" class="fo-link">📎 ${esc(gf.name)}</a>`;}
            filesHtml+=`<span class="crb-file-size">${gf.size>1024?(gf.size/1024).toFixed(1)+'KB':gf.size+'B'}</span></div>`;
          }
        }
        filesHtml+='</div>';
      }
      html+=`<div class="code-run-block ${statusCls}"><div class="crb-header"><span class="crb-lang">${esc(cr.language)}</span><span class="crb-status">${cr.success?'Executed':'Error'}</span></div><pre class="crb-code"><code>${esc(cr.code)}</code></pre><div class="crb-output-label">Output</div><pre class="crb-output">${esc(cr.output)}</pre>${filesHtml}</div>`;
    }
  }
  if(extra.memory_added?.length)html+=`<div class="mops">Remembered: ${extra.memory_added.map(esc).join('; ')}</div>`;
  // Render persisted image search results on reload
  if(!devRawMode&&extra.image_results?.length){
    const imgMap={};
    for(const ir of extra.image_results){
      imgMap[ir.index]=renderImageBlock(ir);
    }
    // Check for placeholders BEFORE replacing so we know if inline placement worked
    const hadPlaceholders=/%%%IMGBLOCK:\d+%%%/.test(html);
    html=html.replace(/<p>\s*%%%IMGBLOCK:(\d+)%%%\s*<\/p>|%%%IMGBLOCK:(\d+)%%%/g,(match,idx1,idx2)=>{
      const idx=parseInt(idx1||idx2,10);
      return imgMap[idx]||'';
    });
    // Only append at end if there were NO placeholders to replace
    if(!hadPlaceholders){
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
  // Strip any unresolved %%%IMGGEN:N%%% placeholders (e.g. image gen failed)
  html=html.replace(/<p>\s*%%%IMGGEN:\d+%%%\s*<\/p>|%%%IMGGEN:\d+%%%/g,'');
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
  // Render persisted HuggingFace results on reload
  if(!devRawMode&&extra.hf_results?.length){
    for(const hr of extra.hf_results){
      const hfHTML=renderHFResult(hr);
      const hfRe=new RegExp(`<p>\\s*%%%HFBLOCK:${hr.index}%%%\\s*</p>|%%%HFBLOCK:${hr.index}%%%`,'g');
      const before=html;
      html=html.replace(hfRe,hfHTML);
      if(html===before){
        html+=hfHTML;
      }
    }
  }
  if(role==='user'){}  // No action buttons on user messages
  else if(role==='kairo'){
    // Render stock_agent messages with styled sections on reload
    if(extra.stock_agent){
      // Use pre-split steps if available, otherwise fall back to ## split
      let steps=[];
      if(extra.stock_agent_steps&&extra.stock_agent_steps.length){
        steps=extra.stock_agent_steps;
      }else{
        // Legacy fallback: split on ## that are step-level headers
        // Step headers are joined by \n\n, so top-level ## follows start-of-string or \n\n
        const raw=displayText;
        const parts=raw.split(/(?:^|\n\n)## /);
        for(let p=0;p<parts.length;p++){
          const part=parts[p].trim();
          if(!part)continue;
          // First part may be intro text before any ## if split started at ^
          if(p===0&&!raw.trimStart().startsWith('## '))continue;
          const nlIdx=part.indexOf('\n');
          const title=nlIdx>0?part.slice(0,nlIdx).trim():part.trim();
          const body=nlIdx>0?part.slice(nlIdx+1).trim():'';
          if(body.startsWith('---')&&body.includes('Not financial advice'))continue;
          if(!title)continue;
          steps.push({title,body});
        }
      }
      if(steps.length){
        const tickers=extra.stock_agent_tickers||[];
        const tickerStr=tickers.length?` — ${esc(tickers.join(', '))}`:'';
        let saHtml=`<div class="sa-badge sa-badge-done">✅ Stock Analysis Complete${tickerStr}</div><div class="sa-output">`;
        // Find the Final Verdict step for ratings (prefer it over Buying Plan)
        const verdictStep=steps.find(s=>s.title==='Final Verdict');
        const verdictBody=verdictStep?verdictStep.body:(steps[steps.length-1]?.body||'');
        const rating=_saParseRating(verdictBody);
        const stockDataArr=extra.stock_agent_data||[];
        saHtml+=buildSentimentGauge(rating, stockDataArr, verdictBody);
        // Growth chart if we have stock data
        if(stockDataArr.length)saHtml+=buildGrowthChart(stockDataArr);
        // Quick summary from verdict step
        const plainLast=(verdictBody||lastBody||'').replace(/<<<STOCK_RATINGS>>>[\s\S]*?<<<END_STOCK_RATINGS>>>/g,'').replace(/[#*_`|>\-\[\]()]/g,' ').replace(/\s+/g,' ').trim();
        if(plainLast){
          const sentences=plainLast.split(/(?<=[.!?])\s+/).filter(s=>s.length>15).slice(0,3).join(' ');
          if(sentences)saHtml+=`<div class="sa-summary"><div class="sa-summary-hd">📋 Quick Summary</div><div class="sa-summary-body">${esc(sentences)}</div><div class="sa-summary-hint">Click any step above to expand full details</div></div>`;
        }
        // Step sections — all collapsed by default
        steps.forEach((step,i)=>{
          // Remove disclaimer from body if present
          let body=step.body||'';
          body=body.replace(/\n---\n\*Not financial advice[\s\S]*$/,'').trim();
          saHtml+=`<div class="sa-section sa-collapsed"><div class="sa-section-head" onclick="this.parentElement.classList.toggle('sa-collapsed')"><span class="sa-section-num">${i+1}</span><span class="sa-section-title">${esc(step.title)}</span><span class="sa-section-status sa-done">done</span><span class="sa-section-chevron">✓</span></div><div class="sa-section-body">${fmt(body)}</div></div>`;
        });
        saHtml+='</div><div class="stock-disclaimer sa-disclaimer"><strong>Not financial advice.</strong> AI-generated analysis for informational purposes only.</div>';
        html=`<div class="lbl">Gyro</div>`+saHtml;
      } else if(_isStockMsg) {
        html+=fmt(displayText);
      }
    }
    // Render research_agent messages with styled sections on reload
    if(_isResearchMsg){
      const raIcons=['🔍','📖','✅','👥','📊','🧠','🎯','📋','📝'];
      let steps=[];
      if(extra.research_agent_steps&&extra.research_agent_steps.length){
        steps=extra.research_agent_steps;
      }else{
        const raw=displayText;
        const parts=raw.split(/(?:^|\n\n)## /);
        for(let p=0;p<parts.length;p++){
          const part=parts[p].trim();
          if(!part)continue;
          if(p===0&&!raw.trimStart().startsWith('## '))continue;
          const nlIdx=part.indexOf('\n');
          const title=nlIdx>0?part.slice(0,nlIdx).trim():part.trim();
          const body=nlIdx>0?part.slice(nlIdx+1).trim():'';
          if(!title)continue;
          steps.push({title,body});
        }
      }
      if(steps.length){
        const rQuery=extra.research_agent_query||'Research';
        const sources=extra.research_agent_sources||[];
        const findings=extra.research_agent_findings||[];
        const durations=extra.research_agent_durations||[];
        const totalWordsH=extra.research_agent_words||0;
        const isPartial=!!extra.research_agent_partial;
        const pct=isPartial?Math.round((steps.length/9)*100):100;
        const stepNamesList=['Intelligence Gathering','Deep Source Analysis','Fact Verification','Perspectives & Context','Evidence & Data Analysis','Synthesis & Insights','Conclusions & Assessment','Final Intelligence Brief','Comprehensive Report'];
        // Compute total elapsed
        let totalElapsed='';
        if(durations.length){const totalSec=durations.reduce((a,d)=>a+d.elapsed,0);if(totalSec<60)totalElapsed=Math.round(totalSec)+'s';else{const m=Math.floor(totalSec/60),s=Math.round(totalSec%60);totalElapsed=m+'m '+s+'s';}}

        let raHtml=`<div class="ra-container">`;
        // Badge
        raHtml+=`<div class="ra-badge ra-badge-done">${isPartial?'Research Incomplete':'Research Complete'+(totalElapsed?' — '+totalElapsed:'')}</div>`;
        // Progress container
        raHtml+=`<div class="ra-progress"><div class="ra-header"><span class="ra-title">${esc(rQuery)}</span><span class="ra-pct" style="color:${isPartial?'#eab308':'#22c55e'}">${pct}%</span></div><div class="ra-bar-track"><div class="ra-bar-fill" style="width:${pct}%"></div></div><div class="ra-steps">`;
        raHtml+=`<div class="ra-steps-line"><div class="ra-steps-line-fill" style="width:${pct}%"></div></div>`;
        for(let i=0;i<9;i++){
          const isDone=i<steps.length;
          raHtml+=`<div class="ra-step${isDone?' done':''}"><div class="ra-step-dot">${isDone?'✓':'·'}</div><div class="ra-step-label">${esc(stepNamesList[i]||'Step '+(i+1))}</div></div>`;
        }
        raHtml+=`</div><div class="ra-stats-row"><span><strong>${sources.length}</strong> sources</span><span><strong>${findings.length}</strong> findings</span>${totalElapsed?'<span><strong>'+totalElapsed+'</strong></span>':''}</div><div class="ra-activity">${isPartial?'Research interrupted':'Research complete'}${totalElapsed?' in <strong>'+totalElapsed+'</strong>':''} — ${sources.length} sources, ${findings.length} findings</div></div>`;
        // Output container — matches live version structure
        raHtml+=`<div class="ra-output">`;
        // Dashboard (inside ra-output, before summary — matches live)
        raHtml+=`<div class="ra-dashboard"><div class="ra-complete-banner"><div class="ra-complete-banner-title">Intelligence Brief Complete</div><div class="ra-complete-banner-sub">${steps.length} steps completed · ${sources.length} sources · ${findings.length} findings${totalElapsed?' · '+totalElapsed:''}</div></div>`;
        raHtml+=`<div class="ra-dash-stats"><div class="ra-dash-stat"><div class="ra-dash-stat-val">${steps.length}/9</div><div class="ra-dash-stat-lbl">Steps</div></div><div class="ra-dash-stat"><div class="ra-dash-stat-val">${sources.length}</div><div class="ra-dash-stat-lbl">Sources</div></div><div class="ra-dash-stat"><div class="ra-dash-stat-val">${findings.length}</div><div class="ra-dash-stat-lbl">Findings</div></div><div class="ra-dash-stat"><div class="ra-dash-stat-val">${totalWordsH>=1000?((totalWordsH/1000).toFixed(1)+'k'):totalWordsH}</div><div class="ra-dash-stat-lbl">Words</div></div></div>`;
        // Source diversity
        if(sources.length){
          const domainCounts={};
          sources.forEach(s=>{try{const d=new URL(s.url).hostname.replace('www.','');domainCounts[d]=(domainCounts[d]||0)+1}catch(e){}});
          const topDomains=Object.entries(domainCounts).sort((a,b)=>b[1]-a[1]).slice(0,6);
          if(topDomains.length){
            const maxDC=topDomains[0][1];
            raHtml+=`<div class="ra-diversity-section"><div class="ra-diversity-hd">Source Diversity</div><div class="ra-diversity-grid">`;
            topDomains.forEach(([domain,count])=>{
              const dpct=Math.round((count/maxDC)*100);
              raHtml+=`<div class="ra-diversity-row"><img class="ra-diversity-favicon" src="https://www.google.com/s2/favicons?domain=${esc(domain)}&sz=32" alt="" onerror="this.style.display='none'"><span class="ra-diversity-domain">${esc(domain)}</span><div class="ra-diversity-bar-track"><div class="ra-diversity-bar-fill" style="width:${dpct}%"></div></div><span class="ra-diversity-count">${count}</span></div>`;
            });
            raHtml+=`</div></div>`;
          }
        }
        // Timing chart
        if(durations.length){
          const maxDur=Math.max(...durations.map(d=>d.elapsed),1);
          raHtml+=`<div class="ra-timing-section"><div class="ra-timing-hd">Step Performance</div><div class="ra-timing-chart">`;
          durations.forEach(d=>{
            const dpct=Math.round((d.elapsed/maxDur)*100);
            const sIcon=raIcons[(d.step||1)-1]||'';
            raHtml+=`<div class="ra-timing-row"><span class="ra-timing-label">${sIcon} ${esc(d.title)}</span><div class="ra-timing-bar-track"><div class="ra-timing-bar-fill" style="width:${dpct}%"></div></div><span class="ra-timing-val">${d.elapsed}s</span></div>`;
          });
          raHtml+=`</div></div>`;
        }
        raHtml+=`</div>`;
        // Summary card (TL;DR)
        const lastBody=steps[steps.length-1]?.body||'';
        const plainLast=(lastBody||'').replace(/[#*_`|>\-\[\]()]/g,' ').replace(/\s+/g,' ').trim();
        let tldr='';
        const tldrMatch=plainLast.match(/TL;DR[:\s]*([\s\S]*?)(?=Executive Summary|Key Findings|$)/i);
        if(tldrMatch) tldr=tldrMatch[1].trim().split(/\n\n/)[0].trim();
        if(!tldr) tldr=plainLast.split(/(?<=[.!?])\s+/).filter(s=>s.length>15).slice(0,3).join(' ');
        if(tldr) raHtml+=`<div class="ra-summary"><div class="ra-summary-hd">Quick Summary</div><div class="ra-summary-body">${esc(tldr.length>500?tldr.slice(0,500)+'…':tldr)}</div><div class="ra-summary-hint">Click any step below to read the full analysis</div></div>`;
        // Step sections (collapsed)
        steps.forEach((step,i)=>{
          let body=step.body||'';
          raHtml+=`<div class="ra-section ra-collapsed"><div class="ra-section-head" onclick="this.parentElement.classList.toggle('ra-collapsed')"><span class="ra-section-num">${i+1}</span><span class="ra-section-title">${esc(step.title)}</span><span class="ra-section-status ra-done">✓ done</span><span class="ra-section-chevron">▾</span></div><div class="ra-section-body"><div class="ra-step-content">${devRawMode?'<pre class="dev-raw-log">'+esc(body)+'</pre>':fmt(body)}</div></div></div>`;
        });
        // Search box
        raHtml+=`<div class="ra-search-wrap"><input class="ra-search-input" type="text" placeholder="Search within results..." oninput="(function(inp){var q=inp.value.toLowerCase().trim();var out=inp.closest('.ra-output');if(!out)out=inp.parentElement.parentElement;out.querySelectorAll('.ra-section').forEach(function(s){var body=s.querySelector('.ra-step-content');if(!body)return;if(!q){s.style.display='';return}var txt=body.textContent.toLowerCase();if(txt.includes(q)){s.style.display='';s.classList.remove('ra-collapsed')}else{s.style.display='none'}})})(this)"></div>`;
        // Action bar
        raHtml+=`<div class="ra-actions"><button class="ra-action-btn" onclick="(function(btn){var out=btn.closest('.ra-output');if(!out)out=btn.parentElement.parentElement;out.querySelectorAll('.ra-section').forEach(function(s){s.classList.remove('ra-collapsed')})})(this)">Expand All</button><button class="ra-action-btn" onclick="(function(btn){var out=btn.closest('.ra-output');if(!out)out=btn.parentElement.parentElement;out.querySelectorAll('.ra-section').forEach(function(s){s.classList.add('ra-collapsed')})})(this)">Collapse All</button><button class="ra-action-btn" onclick="(function(btn){var out=btn.closest('.ra-output');if(!out)out=btn.parentElement.parentElement;var t='';out.querySelectorAll('.ra-section').forEach(function(s){var h=s.querySelector('.ra-section-title');var b=s.querySelector('.ra-step-content');t+='## '+(h?h.textContent:'')+String.fromCharCode(10)+(b?b.textContent:'')+String.fromCharCode(10,10)});navigator.clipboard.writeText(t).then(function(){btn.textContent='Copied!';setTimeout(function(){btn.textContent='Copy Report'},1500)})})(this)">Copy Report</button></div>`;
        raHtml+=`</div>`;
        // Key findings panel (collapsible, outside ra-output)
        if(findings.length){
          raHtml+=`<div class="ra-findings-panel ra-menu-bar ra-findings-collapsed"><div class="ra-menu-head" onclick="this.parentElement.classList.toggle('ra-findings-collapsed')"><span class="ra-menu-icon">💡</span><span class="ra-menu-title">Key Findings</span><span class="ra-menu-count">${findings.length}</span><span class="ra-menu-chevron">▾</span></div><div class="ra-menu-body"><div class="ra-findings-list">`;
          findings.forEach(f=>{
            raHtml+=`<div class="ra-finding-item"><span class="ra-finding-step">💡</span><span class="ra-finding-text">${esc(typeof f==='string'?f:(f.text||''))}</span></div>`;
          });
          raHtml+=`</div></div></div>`;
        }
        // Source cards (collapsible)
        if(sources.length){
          raHtml+=`<div class="ra-sources-panel ra-menu-bar ra-src-collapsed"><div class="ra-menu-head" onclick="this.parentElement.classList.toggle('ra-src-collapsed')"><span class="ra-menu-icon">🔗</span><span class="ra-menu-title">Sources</span><span class="ra-menu-count">${sources.length}</span><span class="ra-menu-chevron">▾</span></div><div class="ra-menu-body"><div class="ra-sources-list">`;
          sources.forEach(src=>{
            try{
              const domain=new URL(src.url).hostname.replace('www.','');
              raHtml+=`<a class="ra-src-card" href="${esc(src.url)}" target="_blank" rel="noopener noreferrer"><img class="ra-src-favicon" src="https://www.google.com/s2/favicons?domain=${esc(domain)}&sz=32" alt="" onerror="this.style.display='none'"><div class="ra-src-info"><div class="ra-src-name">${esc(src.title.length>60?src.title.slice(0,60)+'…':src.title)}</div><div class="ra-src-domain">${esc(domain)}</div></div></a>`;
            }catch(e){}
          });
          raHtml+=`</div></div></div>`;
        }
        raHtml+=`</div>`;
        html=`<div class="lbl">Gyro</div>`+raHtml;
      } else {
        // research_agent flag set but no steps parsed — fallback to formatted text
        html+=fmt(displayText);
      }
    }
    // Only show action buttons on plain AI text responses (not research, stock, code-only, interrupted)
    const _isSpecialMsg=!!(extra.stock_agent||extra.research_agent||extra.code_results?.length||extra.interrupted);
    if(!_isSpecialMsg) html+=`<div class="msg-actions"><button class="msg-action-btn" onclick="copyMsg(this)">Copy</button><button class="msg-action-btn" onclick="retryMsg(this)">Retry</button></div>`;
  }
  div.dataset.text=text||'';
  div.innerHTML=html;renderMathInElementSafe(div);area.appendChild(div);area.scrollTop=area.scrollHeight;
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

// --- Inline interactive todo lists -----------------
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
  if(!isSub)h+=`<button class="chat-todo-addsub" onclick="addSubtask('${listId}','${item.id}')" title="Add subtask">✕</button>`;
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
  if(!text)return'';let t=text.replace(/<<<REMINDER:\s*[\s\S]*?>>>/g,'');
  t=t.replace(/<<<DEEP_RESEARCH[:\s][\s\S]*?>>>/g,'');
  t=t.replace(/<<<STOCK_RATINGS>>>[\s\S]*?<<<END_STOCK_RATINGS>>>/g,'');
  t=t.replace(/<<<SOURCES>>>[\s\S]*?<<<END_SOURCES>>>/g,'');
  t=t.replace(/<<<FOLLOWUPS>>>[\s\S]*?<<<END_FOLLOWUPS>>>/g,'');
  t=t.replace(/<<<\/?(?:SOURCES|END_SOURCES|FOLLOWUPS|END_FOLLOWUPS)\/?>>>/g,'');
  // Convert [[[MEDIA:...]]] inline markers to %%%BLOCK%%% placeholders BEFORE HTML escaping
  t=t.replace(/\[\[\[MEDIA:(\w+):(\d+):(.*?)\]\]\]/g,(_,kind,idx,info)=>{
    if(kind==='image_search') return `%%%IMGBLOCK:${idx}%%%`;
    if(kind==='stock') return `%%%STOCKBLOCK:${idx}%%%`;
    if(kind==='image_gen') return `%%%IMGGEN:${idx}%%%`;
    return '';
  });
  t=t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  let blocks=[];
  // Timeline blocks: ```timeline\ndate | title | description\n```
  t=t.replace(/```timeline\n([\s\S]*?)```/g,(_,c)=>{
    const raw=c.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').trim();
    const lines=raw.split('\n').filter(l=>l.trim());
    let html='<div class="timeline">';
    for(const line of lines){
      const parts=line.split('|').map(p=>p.trim());
      if(parts.length>=2){
        const date=parts[0];
        const title=parts[1];
        const desc=parts[2]||'';
        html+=`<div class="timeline-item"><div class="timeline-date">${date}</div><div class="timeline-title">${title}</div>${desc?`<div class="timeline-desc">${desc}</div>`:''}</div>`;
      } else if(parts[0]){
        html+=`<div class="timeline-item"><div class="timeline-title">${parts[0]}</div></div>`;
      }
    }
    html+='</div>';
    blocks.push(html);
    return `%%%BLOCK${blocks.length-1}%%%`;
  });
  t=t.replace(/```mermaid\n([\s\S]*?)```/g,(_,c)=>{
    let restored=c.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').trim();
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
    const raw=c.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").trim();
    const _tryParseTodo=(str)=>{
      // Try direct parse first
      try{ const r=JSON.parse(str); if(Array.isArray(r)) return r; if(r&&typeof r==='object'){ const v=Object.values(r).find(Array.isArray); if(v) return v; } }catch(e){}
      // Fix trailing commas before ] or }
      let fixed=str.replace(/,\s*([}\]])/g,'$1');
      try{ const r=JSON.parse(fixed); if(Array.isArray(r)) return r; if(r&&typeof r==='object'){ const v=Object.values(r).find(Array.isArray); if(v) return v; } }catch(e){}
      // Try extracting array from text (AI sometimes adds explanation around JSON)
      const arrMatch=str.match(/\[[\s\S]*\]/);
      if(arrMatch){ try{ const r=JSON.parse(arrMatch[0].replace(/,\s*([}\]])/g,'$1')); if(Array.isArray(r)) return r; }catch(e){} }
      return null;
    };
    const items=_tryParseTodo(raw);
    if(items&&items.length){
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
    console.warn('[todolist] Failed to parse todolist JSON:',raw.slice(0,200));
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
  // Strip vertexaisearch proxy links (show just the title text)
  t=t.replace(/\[([^\]]+)\]\(https?:\/\/vertexaisearch[^)]+\)/g,'$1');
  t=t.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">$1</a>');
  t=t.replace(/\[([^\]]+)\]\((\/api\/[^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">$1</a>');
  // Workspace file links: [text](filename.ext) or [text](path/file.ext) — convert to download URLs
  t=t.replace(/\[([^\]]+)\]\((?!https?:\/\/)(?!\/api\/)(?!#)(?!mailto:)([^)]+\.\w+)\)/g,(_,label,path)=>{
    const dlUrl='/api/files/download?path='+encodeURIComponent(path.replace(/&amp;/g,'&'));
    return `<a href="${dlUrl}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">${label}</a>`;
  });
  // Bare URLs — strip vertexaisearch proxy URLs, auto-link the rest
  t=t.replace(/(?<!href=")(?<!src=")(?<!">)https?:\/\/vertexaisearch[^\s<"']+/g,'');
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
  // Custom <<<TABLE>>> rendering removed; rely on standard markdown table parsing.
  // Markdown tables — extract to blocks to protect from <br> conversion (legacy fallback)
  t=t.replace(/(?:^|\n)(\|.+\|[ \t]*\n\|[\s|:\-]+\|[ \t]*\n(?:\|.+\|[ \t]*(?:\n|$))+)/gm,(match)=>{
    const lines=match.trim().split('\n').filter(l=>l.trim());
    if(lines.length<3)return match;
    const parseRow=line=>line.replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
    const fmtCell=c=>c.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/`(.+?)`/g,'<code style="background:var(--bg-surface);padding:2px 7px;border-radius:4px;font-family:var(--mono);font-size:11.5px;border:1px solid var(--border)">$1</code>');
    const headers=parseRow(lines[0]);
    if(!/^[\s|:\-]+$/.test(lines[1].replace(/\|/g,'')))return match;
    const rows=lines.slice(2).map(parseRow);
    let tbl='<table><thead><tr>'+headers.map(h=>`<th>${fmtCell(h)}</th>`).join('')+'</tr></thead><tbody>';
    for(const row of rows)tbl+='<tr>'+row.map(c=>`<td>${fmtCell(c)}</td>`).join('')+'</tr>';
    tbl+='</tbody></table>';
    blocks.push(tbl);
    return `\n%%%BLOCK${blocks.length-1}%%%\n`;
  });
  t=t.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  t=t.replace(/`(.+?)`/g,'<code style="background:var(--bg-surface);padding:2px 7px;border-radius:4px;font-family:var(--mono);font-size:11.5px;border:1px solid var(--border)">$1</code>');
  // Headings
  t=t.replace(/^(#{1,4})\s+(.+)$/gm,(_,h,text)=>{const s=['1.3em','1.15em','1.05em','1em'];return `<div style="font-size:${s[h.length-1]||'1em'};font-weight:700;margin:12px 0 4px;color:var(--text-primary)">${text}</div>`;});
  // Horizontal rules
  t=t.replace(/^-{3,}$/gm,'<hr style="border:none;border-top:1px solid var(--border);margin:12px 0">');
  // Bullet lists
  t=t.replace(/^[*\-]\s+(.+)$/gm,'<div style="display:flex;gap:8px;padding:2px 0"><span style="color:var(--accent);flex-shrink:0">•</span><span>$1</span></div>');
  // Numbered lists
  t=t.replace(/^(\d+)\.\s+(.+)$/gm,'<div style="display:flex;gap:8px;padding:2px 0"><span style="color:var(--accent);flex-shrink:0;min-width:16px;text-align:right">$1.</span><span>$2</span></div>');
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
      // Only show if selection is within a bot message (not user's own)
      const anchor=sel.anchorNode?.parentElement?.closest?.('.msg');
      if(!anchor||anchor.classList.contains('user')){tip.classList.remove('visible');return;}
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

// --- Settings -------------------------------------
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
  initSchoolModeToggle();
  loadConnectors();
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

// --- Connectors -----------------------------------
async function loadConnectors(){
  try{
    const r=await fetch('/api/connectors');
    if(!r.ok)return;
    const d=await r.json();
    const hf=d.connectors?.huggingface||{};
    const statusEl=document.getElementById('hfStatus');
    const connectedEl=document.getElementById('hfConnected');
    const setupEl=document.getElementById('hfSetup');
    if(!statusEl)return;
    if(hf.enabled&&hf.token){
      statusEl.textContent='Connected';
      statusEl.style.background='rgba(34,197,94,0.15)';
      statusEl.style.color='#22c55e';
      if(connectedEl)connectedEl.style.display='block';
      if(setupEl)setupEl.style.display='none';
      const hfTool=document.getElementById('hfToolItem');
      if(hfTool)hfTool.style.display='';
      // Fetch username
      try{
        const tr=await fetch('/api/connectors/huggingface/test',{method:'POST'});
        const td=await tr.json();
        const unEl=document.getElementById('hfUsername');
        if(td.ok&&unEl)unEl.textContent=td.username||'your account';
      }catch{}
    }else{
      statusEl.textContent='Not connected';
      statusEl.style.background='var(--bg-surface)';
      statusEl.style.color='var(--text-muted)';
      if(connectedEl)connectedEl.style.display='none';
      if(setupEl)setupEl.style.display='block';
      const hfTool=document.getElementById('hfToolItem');
      if(hfTool)hfTool.style.display='none';
    }
  }catch{}
}

async function connectHF(){
  const inp=document.getElementById('hfTokenInput');
  const errEl=document.getElementById('hfError');
  const token=inp?.value.trim();
  if(!token){if(errEl){errEl.textContent='Please enter your HuggingFace token.';errEl.style.display='block';}return;}
  if(errEl)errEl.style.display='none';
  try{
    // Save token first
    const sr=await fetch('/api/connectors',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({connector:'huggingface',token,enabled:true})});
    if(!sr.ok){if(errEl){errEl.textContent='Failed to save token. Please try again.';errEl.style.display='block';}return;}
    // Test it
    const r=await fetch('/api/connectors/huggingface/test',{method:'POST'});
    if(!r.ok){if(errEl){errEl.textContent=`Server error (${r.status}). Make sure the server is up to date and restart it.`;errEl.style.display='block';}return;}
    const d=await r.json();
    if(d.ok){
      inp.value='';
      showToast(`HuggingFace connected as ${d.username||'your account'}!`,'success');
      loadConnectors();
    }else{
      // Token was bad — remove it
      await fetch('/api/connectors',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({connector:'huggingface',token:'',enabled:false})});
      if(errEl){errEl.textContent=d.error||'Invalid token. Please check and try again.';errEl.style.display='block';}
    }
  }catch(e){
    if(errEl){errEl.textContent='Connection error. Please check the server is running.';errEl.style.display='block';}
  }
}

async function disconnectHF(){
  const ok=await _dlg({title:'Disconnect HuggingFace?',msg:'Gyro will no longer be able to use HuggingFace Spaces. You can reconnect anytime.',icon:'🤗',iconType:'warning',confirmText:'Disconnect',cancelText:'Cancel',dangerous:true});
  if(!ok)return;
  await fetch('/api/connectors/huggingface/delete',{method:'POST'});
  showToast('HuggingFace disconnected.','info');
  loadConnectors();
}

// --- Memory ---------------------------------------
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

// --- My Data --------------------------------------
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
    localStorage.removeItem(FOLDER_META_KEY);
    try{localStorage.removeItem('gyro_productivity');localStorage.removeItem('gyro_productivity_v1');}catch{}
    closeM('settingsModal');
    curChat=null;curUser=null;isGuest=false;
    document.getElementById('appPage').classList.remove('visible');
    document.getElementById('loginPage').style.display='flex';
    googleInitDone=false;
    await ensureOAuthConfigLoaded();
    initGoogleAuthUI();
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

// --- Export / Import Chats ------------------------
async function exportChats(){
  if(!allChats.length){showToast('No chats to export.','info');return;}
  showToast('Preparing export…','info');
  try{
    const r=await apiFetch('/api/chats/export');
    if(!r.ok){showToast('Export failed.','error');return;}
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;a.download='gyro-all-chats-export.json';
    document.body.appendChild(a);a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Exported ${allChats.length} chats.`,'success');
  }catch(e){showToast('Export failed: '+e.message,'error');}
}

async function exportCurrentChat(){
  if(!curChat){showToast('No chat selected.','info');return;}
  showToast('Exporting chat…','info');
  try{
    const r=await apiFetch('/api/chats/export/'+encodeURIComponent(curChat));
    if(!r.ok){showToast('Export failed.','error');return;}
    const disp=r.headers.get('Content-Disposition')||'';
    const fnMatch=disp.match(/filename=(.+)/);
    const fname=fnMatch?fnMatch[1]:'chat.json';
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;a.download=fname;
    document.body.appendChild(a);a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Chat exported.','success');
  }catch(e){showToast('Export failed: '+e.message,'error');}
}

async function importChats(input){
  const file=input.files&&input.files[0];
  if(!file){return;}
  input.value='';
  if(!file.name.endsWith('.json')){showToast('Please select a JSON file.','error');return;}
  if(file.size>50*1024*1024){showToast('File too large (max 50 MB).','error');return;}
  showToast('Importing chats…','info');
  try{
    const text=await file.text();
    const data=JSON.parse(text);
    const r=await fetch('/api/chats/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    const res=await r.json();
    if(res.error){showToast(res.error,'error');return;}
    await refreshChats();
    showToast(`Imported ${res.imported} chat${res.imported===1?'':'s'}.`,'success');
  }catch(e){showToast('Import failed: '+e.message,'error');}
}

// --- Files ----------------------------------------
async function openFiles(){
  document.getElementById('settingsModal').classList.add('open');
  const r=await fetch('/api/files');const d=await r.json();
  document.getElementById('filesList').innerHTML=(d.files||[]).map(f=>
    `<div style="padding:8px 0;border-bottom:1px solid var(--border)"><div style="font-size:12px;color:var(--text-primary);font-weight:500">${esc(f.path)}</div><div style="font-size:10px;color:var(--text-muted);margin-top:2px">${f.size.toLocaleString()} chars</div></div>`
  ).join('')||'<div style="color:var(--text-muted);font-size:11px">No workspace files found.</div>';
}

// --- File Browser ---------------------------------
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
  const panelId=tab==='chats'?'fbChats':'fbWorkspace';
  document.getElementById(panelId).classList.add('active');
  if(tab==='chats')refreshChatsTab();else refreshWorkspaceFiles();
}
async function refreshFileBrowser(){
  refreshWorkspaceFiles();
}
async function refreshChatsTab(){
  const el=document.getElementById('fbChats');
  if(!el)return;
  el.innerHTML='<div class="fbc-loading">Loading chats…</div>';
  try{
    const r=await apiFetch('/api/chats');
    const d=await r.json();
    const chats=(d.chats||[]).filter(c=>!_isTransientEmpty(c));
    if(!chats.length){el.innerHTML='<div class="fb-empty">No chats yet.</div>';return;}
    const folders={};
    chats.forEach(c=>{const f=c.folder||'';if(!folders[f])folders[f]=[];folders[f].push(c);});
    let html='';
    const sortedFolders=['',...Object.keys(folders).filter(f=>f).sort()];
    for(const fld of sortedFolders){
      if(!folders[fld])continue;
      if(fld){
        const meta=getFolderMeta(fld);
        html+=`<div class="fbc-folder"><div class="fbc-folder-head">${meta.emoji||'📁'} ${esc(fld)} <span class="fbc-count">${folders[fld].length}</span></div>`;
      }
      for(const c of folders[fld]){
        const active=c.id===curChat?' fbc-active':'';
        const expanded=c.id===curChat?' fbc-expanded':'';
        const date=c.updated?new Date(c.updated).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'';
        html+=`<div class="fbc-chat-wrap${expanded}" data-chatid="${c.id}">`;
        html+=`<div class="fbc-chat${active}" onclick="toggleChatFiles('${c.id}',this)"><span class="fbc-expand-arrow">›</span><span class="fbc-title">${esc(c.title||'New Chat')}</span><span class="fbc-date">${date}</span></div>`;
        html+=`<div class="fbc-files" id="fbc-files-${c.id}"></div>`;
        html+=`</div>`;
      }
      if(fld)html+='</div>';
    }
    el.innerHTML=html;
    // Auto-load files for the current chat 
    if(curChat){
      const wrap=el.querySelector(`.fbc-chat-wrap[data-chatid="${curChat}"]`);
      if(wrap)loadChatFilesInline(curChat);
    }
  }catch(e){
    el.innerHTML='<div class="fb-empty">Failed to load chats.</div>';
  }
}
async function toggleChatFiles(chatId,chatEl){
  const wrap=chatEl.closest('.fbc-chat-wrap');
  if(!wrap)return;
  const isExpanded=wrap.classList.contains('fbc-expanded');
  // Collapse all others
  document.querySelectorAll('.fbc-chat-wrap.fbc-expanded').forEach(w=>{
    if(w!==wrap)w.classList.remove('fbc-expanded');
  });
  if(isExpanded){
    wrap.classList.remove('fbc-expanded');
  }else{
    wrap.classList.add('fbc-expanded');
    loadChatFilesInline(chatId);
  }
}
async function loadChatFilesInline(chatId){
  const container=document.getElementById(`fbc-files-${chatId}`);
  if(!container)return;
  if(container.dataset.loaded==='1')return; // already loaded
  container.innerHTML='<div class="fbc-files-loading">Loading files…</div>';
  try{
    const r=await apiFetch(`/api/chats/${chatId}`);
    if(!r.ok){container.innerHTML='<div class="fbc-files-empty">Could not load.</div>';return;}
    const data=await r.json();
    const genFiles=data.generated_files||[];
    const uploads=(data.messages||[]).filter(m=>m.file_name).map(m=>({name:m.file_name,when:m.timestamp}));
    let html='';
    if(genFiles.length){
      for(const f of genFiles){
        const name=f.path.split('/').pop()||f.path;
        const ext=(name.split('.').pop()||'').toLowerCase();
        const icon=ext==='md'?'◆':ext==='json'?'◇':ext==='txt'?'▪':ext==='py'?'▸':'▪';
        html+=`<div class="fbc-file" onclick="openWorkspaceFile('${encodeURIComponent(f.path)}');closeFileBrowser()"><span class="fbc-file-icon">${icon}</span><span class="fbc-file-name">${esc(name)}</span><span class="fbc-file-action">${esc(f.action)}</span></div>`;
      }
    }
    if(uploads.length){
      for(const u of uploads){
        html+=`<div class="fbc-file"><span class="fbc-file-icon">📎</span><span class="fbc-file-name">${esc(u.name)}</span><span class="fbc-file-action">Upload</span></div>`;
      }
    }
    if(!html)html='<div class="fbc-files-empty">No files in this chat.</div>';
    // Add a "Go to chat" button
    html+=`<div class="fbc-goto" onclick="loadChat('${chatId}');closeFileBrowser()">Open this chat →</div>`;
    container.innerHTML=html;
    container.dataset.loaded='1';
  }catch{container.innerHTML='<div class="fbc-files-empty">Could not load.</div>';}
}
function _isTransientEmpty(c){
  if(!c||typeof c!=='object')return true;
  const t=(c.title||'').trim().toLowerCase();
  return !c.messages?.length&&(t===''||t==='new chat')&&!c.folder;
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
        html+=`<div class="fb-folder"><div class="fb-folder-head" onclick="this.parentElement.classList.toggle('collapsed')"><span class="fb-folder-arrow">✕</span><span class="fb-folder-icon" style="color:var(--accent)">📁</span><span class="fb-folder-name">${esc(fld)}</span><span class="fb-folder-count">${folders[fld].length}</span><button class="fb-del" onclick="event.stopPropagation();deleteUserFile('${encodeURIComponent(fld)}',true)" title="Delete folder">✕</button></div><div class="fb-folder-body">`;
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
async function createUserFolder(){
  const name=await _dlg({title:'New folder',msg:'',icon:'📁',iconType:'info',inputLabel:'Folder name',inputDefault:'',inputPlaceholder:'e.g. notes/research, projects/web…',confirmText:'Create',cancelText:'Cancel'});
  if(!name?.trim())return;
  await fetch('/api/user-files/folder',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:name.trim()})});
  refreshWorkspaceFiles();
  showToast('Folder created.','success');
}
async function deleteUserFile(encodedPath,isFolder){
  const path=decodeURIComponent(encodedPath);
  const type=isFolder?'folder and all its contents':'file';
  const ok=await _dlg({title:`Delete ${type}?`,msg:`Are you sure you want to delete "${path}"?`,icon:'🗑️',iconType:'warn',confirmText:'Delete',cancelText:'Cancel'});
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

// --- Chat Settings Drawer --------------------------
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
      ?pinned.map(p=>{const path=typeof p==='string'?p:p.path;return`<div class="cd-pinned-item"><span>${esc(path)}</span><button onclick="unpinFile('${encodeURIComponent(path)}')" title="Unpin">▪</button></div>`;}).join('')
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
    const chosen=await _dlg({title:'Pin a file',msg:'Available: '+files.map(f=>f.path).join(', '),icon:'✏️',iconType:'info',inputLabel:'File path',inputDefault:files[0]?.path||'',inputPlaceholder:'e.g. notes/research/topic.md',confirmText:'Pin',cancelText:'Cancel'});
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
  const name=await _dlg({title:'New folder',msg:'',icon:'📁',iconType:'info',inputLabel:'Folder name',inputDefault:'',inputPlaceholder:'e.g. Work, Projects…',confirmText:'Create & Move',cancelText:'Cancel'});
  if(!name?.trim())return;
  await fetch(`/api/chats/${curChat}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder:name.trim()})});
  await refreshChats();
  loadChatDrawer();
  showToast(`Moved to ${name.trim()}.`,'success');
}

// --- Image Gen ------------------------------------
function openImageGen(){document.getElementById('imageModal').classList.add('open')}

async function genImage(){
  const p=document.getElementById('imgPrompt').value.trim();if(!p)return;
  const el=document.getElementById('imgResult');
  el.innerHTML='<div class="dots" style="justify-content:center;padding:12px"><span></span><span></span><span></span></div>';
  try{
    const r=await fetch('/api/generate-image',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:p})});
    const d=await r.json();
    el.innerHTML=d.image?`<img src="data:${d.mime||'image/png'};base64,${d.image}" style="max-width:100%;border-radius:var(--r-md);box-shadow:var(--shadow-md)">`:`<div style="color:var(--red);font-size:12px">${esc(d.error||'Failed')}</div>`;
  }catch(e){el.innerHTML=`<div style="color:var(--red);font-size:12px">${esc(e.message)}</div>`}
}

// --- Modals ---------------------------------------
function closeM(id){document.getElementById(id).classList.remove('open')}

document.addEventListener('DOMContentLoaded',()=>{
  document.querySelectorAll('.ov').forEach(o=>o.addEventListener('click',e=>{
    if(e.target===o&&o.id!=='onboardingModal')o.classList.remove('open');
  }));
});

// --- Voice (stub) ---------------------------------
function toggleTTS(){}
function speak(){}
function toggleMic(){}
function closeOrb(){}

// --- Guest Limit (stub) ---------------------------
function showGuestLimit(){}
function toggleGuestAuthMode(){}
async function doGuestAuth(){}

// --- Canvas ---------------------------------------
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

/* --- Canvas File Explorer ------------------------ */
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
      if(fld) html+=`<div class="cfp-folder-head" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'':'none'">${esc(fld)}</div><div>`;
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

/* --- Image viewing in canvas --------------------- */
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

// --- Canvas drag-to-resize ------------------------
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

// --- Canvas select-to-edit ------------------------
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

// --- Canvas presets -------------------------------
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
  document.getElementById('canvasStatus').textContent='AI is editing…';
  editor.readOnly=true;
  try{
    const r=await apiFetch('/api/canvas/apply-stream',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({content,instruction,language:lang})});
    if(!r.ok){document.getElementById('canvasStatus').textContent='Edit failed';return;}
    const reader=r.body.getReader();
    const decoder=new TextDecoder();
    let buf='',full='';
    while(true){
      const{done,value}=await reader.read();
      if(done)break;
      buf+=decoder.decode(value,{stream:true});
      const lines=buf.split('\n');
      buf=lines.pop();
      for(const line of lines){
        if(!line.trim())continue;
        try{
          const j=JSON.parse(line);
          if(j.token){full+=j.token;editor.value=full;}
          if(j.done){editor.value=j.content||full;}
          if(j.error){document.getElementById('canvasStatus').textContent='Edit failed';}
        }catch(e){}
      }
    }
    const tab=canvasTabs.find(t=>t.id===activeCanvasTabId);
    if(tab)tab.content=editor.value;
    updateCanvasStats();
    document.getElementById('canvasStatus').textContent='Edit applied';
  }catch(e){
    document.getElementById('canvasStatus').textContent='Edit failed';
  }finally{
    editor.readOnly=false;
  }
}

// --- Canvas run / preview -------------------------
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

// --- Canvas: get selection context for main chat --
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
    if(!raw)return {todos:[],visions:[],reminders:[]};
    const parsed=JSON.parse(raw);
    return {
      todos:Array.isArray(parsed.todos)?parsed.todos:[],
      visions:Array.isArray(parsed.visions)?parsed.visions:[],
      reminders:Array.isArray(parsed.reminders)?parsed.reminders:[],
    };
  }catch{
    return {todos:[],visions:[],reminders:[]};
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
      ?state.todos.map(t=>`<div class="todo-item ${t.done?'done':''}"><button class="todo-check" onclick="toggleTodoItem('${t.id}')">${t.done?'✓':'✕'}</button><div class="todo-text">${esc(t.text)}</div><button class="todo-del" onclick="deleteTodoItem('${t.id}')">✕</button></div>`).join('')
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
  // Visual feedback: animate the row before re-rendering
  const row=document.querySelector(`.wl-todo-item[data-todo-id="${CSS.escape(id)}"]`);
  if(row){
    if(item.done){
      row.classList.add('wl-todo-done');
      row.style.transition='opacity .3s, transform .3s';
      row.style.opacity='.4';
      row.style.transform='translateX(8px)';
    }else{
      row.classList.remove('wl-todo-done');
    }
    setTimeout(()=>refreshHomeWidgets(),350);
  }else{
    refreshHomeWidgets();
  }
}

function deleteHomeTodo(id){
  const state=loadProductivityState();
  state.todos=state.todos.filter(t=>t.id!==id);
  saveProductivityState(state);
  // Visual feedback: fade out before re-rendering
  const row=document.querySelector(`.wl-todo-item[data-todo-id="${CSS.escape(id)}"]`);
  if(row){
    row.style.transition='opacity .25s, transform .25s';
    row.style.opacity='0';
    row.style.transform='translateX(-12px)';
    setTimeout(()=>refreshHomeWidgets(),280);
  }else{
    refreshHomeWidgets();
  }
}

function refreshHomeWidgets(){
  if(!curChat)loadWelcome(true);
}

function handleNudgeAction(btn){
  const item=btn.closest('.wl-nudge-item');
  if(!item)return;
  try{
    const raw=item.getAttribute('data-nudge-action')||'{}';
    const action=JSON.parse(raw);
    if(action.type==='open_chat'&&action.chat_id){
      openChat(action.chat_id);
    }else if(action.type==='prompt'&&action.text){
      fillMasterPrompt(action.text);
    }
  }catch(e){console.log('nudge action error:',e);}
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

// --- Reminder CRUD --------------------------------
function addReminder(due,text){
  if(!text)return;
  const state=loadProductivityState();
  state.reminders.push({id:'r_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6),due:due||'',text,done:false,created:new Date().toISOString()});
  saveProductivityState(state);
  refreshHomeWidgets();
}

function completeReminder(id){
  const state=loadProductivityState();
  const item=state.reminders.find(r=>r.id===id);
  if(!item)return;
  item.done=true;
  item.completed_at=new Date().toISOString();
  saveProductivityState(state);
  refreshHomeWidgets();
}

function deleteReminder(id){
  const state=loadProductivityState();
  state.reminders=state.reminders.filter(r=>r.id!==id);
  saveProductivityState(state);
  refreshHomeWidgets();
}

function snoozeReminder(id,hours=24){
  const state=loadProductivityState();
  const item=state.reminders.find(r=>r.id===id);
  if(!item)return;
  const now=new Date();
  now.setHours(now.getHours()+hours);
  item.due=now.toISOString().slice(0,16).replace('T',' ');
  item.snoozed=true;
  saveProductivityState(state);
  refreshHomeWidgets();
  showToast('Reminder snoozed for '+hours+' hours','info');
}

function _getPendingReminders(){
  const state=loadProductivityState();
  return (state.reminders||[]).filter(r=>!r.done);
}

function _getOverdueReminders(){
  const now=new Date();
  return _getPendingReminders().filter(r=>{
    if(!r.due)return false;
    try{return new Date(r.due)<=now;}catch{return false;}
  });
}

function checkAndShowReminderToast(){
  const overdue=_getOverdueReminders();
  if(!overdue.length)return;
  const pick=overdue[Math.floor(Math.random()*overdue.length)];
  showToast('⏰ Reminder: '+pick.text,'info');
}

// --- Mermaid --------------------------------------
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

// --- Reminder Notifications ----------------------
document.addEventListener('DOMContentLoaded',()=>{
  // Check for overdue reminders on page load (small delay so toasts don't pile up on login)
  setTimeout(()=>checkAndShowReminderToast(),3000);
  // Periodically check for overdue reminders (every 5 minutes)
  setInterval(()=>checkAndShowReminderToast(),300000);
});

// --- Keep-alive ping to prevent Render from sleeping while user is active ---
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


