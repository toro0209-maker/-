/* =========================================================
   자기계발 장부 — app.js
   디자인 A(클래식 저널) / 5배너 / 달력 진행률 / Firebase 동기화
   ========================================================= */

// ----- 1. 배너 정의 -----
const BANNERS = [
  { id:'wealth',    name:'부자가 되는 생각', color:'#8B3A2F', initial:'富', sub:'마인드 · 루틴 · 결심' },
  { id:'language',  name:'언어 개발',        color:'#5C7A5E', initial:'語', sub:'영어 · 표현 · 학습' },
  { id:'mindset',   name:'마인드셋',         color:'#9C7A3C', initial:'心', sub:'사색 · 명상 · 회고' },
  { id:'specialist',name:'스페셜리스트',     color:'#3B5B6B', initial:'技', sub:'기술사 · 전문성' },
  { id:'invest',    name:'투자',             color:'#6B4C8A', initial:'財', sub:'시장 · 종목 · 기록' },
];

// ----- 2. Firebase 설정 -----
// 주의: 이 프로젝트는 사용자가 본인 Firebase 콘솔에서 새로 생성한 뒤
// 아래 값을 교체해야 동작합니다. (README 참고)
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAI412t3-6RclfyzuIzGLq2M9Al_xeGIzE",
  authDomain: "re-revise.firebaseapp.com",
  projectId: "re-revise",
  storageBucket: "re-revise.firebasestorage.app",
  messagingSenderId: "146827056250",
  appId: "1:146827056250:web:8bd9e2838ffc1c3cda17c3",
  measurementId: "G-74RH24EXS7"
};

let fbApp=null, fbAuth=null, fbDB=null, fbUid=null, syncGroupId=null, syncCode=null;
let entriesUnsub=null;
let firebaseReady=false;

function initFirebase(){
  try{
    if(FIREBASE_CONFIG.apiKey === "REPLACE_ME"){
      console.warn("Firebase 설정이 아직 비어있습니다. README의 안내를 따라 설정해주세요.");
      return;
    }
    fbApp = firebase.initializeApp(FIREBASE_CONFIG);
    fbAuth = firebase.auth();
    fbDB = firebase.firestore();
    firebaseReady = true;
    fbAuth.onAuthStateChanged(async (user)=>{
      if(user){
        fbUid = user.uid;
        await loadOrCreateSyncIdentity();
        attachRealtimeListener();
        updateSyncUI();
      } else {
        await fbAuth.signInAnonymously().catch(e=>console.error("익명 로그인 실패", e));
      }
    });
  }catch(e){
    console.error("Firebase 초기화 실패", e);
  }
}

// 사람이 읽기 쉬운 8자리 코드 생성 (영숫자, 혼동 문자 제외)
function genFriendlyCode(){
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s='';
  for(let i=0;i<8;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s.slice(0,4) + '-' + s.slice(4);
}

async function loadOrCreateSyncIdentity(){
  // localStorage에 이미 그룹 정보가 있으면(연결 이력) 그걸 우선 사용
  const savedGroup = localStorage.getItem('ledger:syncGroupId');
  const savedCode = localStorage.getItem('ledger:syncCode');
  if(savedGroup){
    syncGroupId = savedGroup;
    syncCode = savedCode;
    // codeMap에 내 uid가 매핑돼 있는지 보장
    await fbDB.collection('codeMap').doc(syncCode).set({groupId:syncGroupId}, {merge:true}).catch(()=>{});
    return;
  }
  // 처음 사용하는 기기 → 새 그룹/코드 생성
  syncGroupId = fbUid;
  syncCode = genFriendlyCode();
  localStorage.setItem('ledger:syncGroupId', syncGroupId);
  localStorage.setItem('ledger:syncCode', syncCode);
  await fbDB.collection('codeMap').doc(syncCode).set({groupId:syncGroupId});
}

async function joinByCode(code){
  const cleanCode = code.trim().toUpperCase();
  const doc = await fbDB.collection('codeMap').doc(cleanCode).get();
  if(!doc.exists){
    throw new Error('해당 코드를 찾을 수 없습니다. 코드를 다시 확인해주세요.');
  }
  const groupId = doc.data().groupId;
  syncGroupId = groupId;
  syncCode = cleanCode;
  localStorage.setItem('ledger:syncGroupId', syncGroupId);
  localStorage.setItem('ledger:syncCode', syncCode);
  attachRealtimeListener();
  updateSyncUI();
}

// ----- 3. 로컬 저장 (Firebase 미설정 시 폴백) -----
const LOCAL_KEY = 'ledger:entries:v1';
function localLoad(){
  try{ return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); }catch(e){ return []; }
}
function localSave(entries){
  localStorage.setItem(LOCAL_KEY, JSON.stringify(entries));
}

// ----- 4. 날짜 유틸 -----
function ymd(d){
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), day=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function todayYmd(){ return ymd(new Date()); }
function fmtTime(ts){
  const d=new Date(ts);
  return d.toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'});
}
function fmtKoreanDate(ymdStr){
  const [y,m,d]=ymdStr.split('-').map(Number);
  const dt=new Date(y,m-1,d);
  const days=['일','월','화','수','목','금','토'];
  return `${m}월 ${d}일 (${days[dt.getDay()]})`;
}

/* =========================================================
   5. 전역 상태
   ========================================================= */
let entries = [];           // {id, bannerId, text, attachments:[{type,name,dataUrl|url}], createdAt, dateKey}
let viewDate = new Date();  // 캘린더 표시 기준 월
let selectedDay = todayYmd(); // 현재 선택된 날짜 (day-strip 필터링용; null이면 필터 없음=피드 전체)
let dayFilterActive = false;
let expandedBanner = null;  // 펼쳐진 배너 id
const pendingAttachments = {}; // bannerId -> [attachment,...] (작성 중 임시 첨부)

function entriesForBanner(bannerId){
  return entries.filter(e=>e.bannerId===bannerId).sort((a,b)=>b.createdAt-a.createdAt);
}
function bannerCountsForDate(dateKey){
  const setOfBanners = new Set(entries.filter(e=>e.dateKey===dateKey).map(e=>e.bannerId));
  return setOfBanners.size;
}
function todayCompletedSet(){
  const t = todayYmd();
  return new Set(entries.filter(e=>e.dateKey===t).map(e=>e.bannerId));
}

/* =========================================================
   6. 데이터 영속화 — Firebase 우선, 없으면 localStorage
   ========================================================= */
function attachRealtimeListener(){
  if(!firebaseReady || !syncGroupId) return;
  if(entriesUnsub) entriesUnsub();
  entriesUnsub = fbDB.collection('syncGroups').doc(syncGroupId)
    .collection('entries').orderBy('createdAt','desc').limit(2000)
    .onSnapshot(snap=>{
      const remote = snap.docs.map(d=>({id:d.id, ...d.data()}));
      // 아직 동기화되지 않은 로컬 전용 항목(local-/temp-)은 보존하여 합친다.
      // → Firestore 저장 실패/대용량 사진 항목이 덮어써져 사라지는 것을 방지
      const localOnly = entries.filter(e=>{
        const id = String(e.id);
        return id.startsWith('local-') || id.startsWith('temp-');
      });
      const merged = [...localOnly, ...remote];
      merged.sort((a,b)=>b.createdAt-a.createdAt);
      entries = merged;
      // Firebase 데이터를 받을 때마다 localStorage에도 항상 백업
      localSave(entries);
      renderAll();
    }, err=>{
      console.error('실시간 동기화 오류', err);
      // Firebase 오류 시 localStorage에서 복구
      const saved = localLoad();
      if(saved.length > 0){ entries = saved; renderAll(); }
    });
}

async function addEntry(bannerId, text, attachments){
  const now = Date.now();
  const entry = {
    bannerId,
    text: text || '',
    attachments: attachments || [],
    createdAt: now,
    dateKey: todayYmd(),
  };
  if(firebaseReady && syncGroupId){
    // Firebase 저장 전에 먼저 로컬에 낙관적 저장(Optimistic update)
    // → 네트워크 지연/실패에도 기록이 즉시 보이고 사라지지 않음
    const tempId = 'temp-' + now + '-' + Math.random().toString(36).slice(2,7);
    entry.id = tempId;
    entries.unshift(entry);
    localSave(entries);
    renderAll();

    // Firestore 문서 1MB 한도 점검. 너무 크면 업로드를 건너뛰고 로컬에만 보관.
    const payload = {
      bannerId: entry.bannerId,
      text: entry.text,
      attachments: entry.attachments,
      createdAt: entry.createdAt,
      dateKey: entry.dateKey,
    };
    const approxBytes = JSON.stringify(payload).length;
    if(approxBytes > 950*1024){
      console.warn('기록 용량이 커서 동기화는 건너뛰고 로컬에만 저장합니다.', approxBytes);
      // 동기화 안 된 항목임을 표시(로컬 전용)
      entry.id = 'local-' + now + '-' + Math.random().toString(36).slice(2,7);
      localSave(entries);
      return;
    }

    // Firebase에도 저장 (성공하면 onSnapshot이 실제 ID로 교체)
    fbDB.collection('syncGroups').doc(syncGroupId).collection('entries').add(payload)
    .catch(e=>{
      console.error('Firebase 저장 실패, 로컬에 유지', e);
      // 실패하면 로컬 전용 ID로 고정해 onSnapshot 덮어쓰기로 사라지지 않게 함
      entry.id = 'local-' + now + '-' + Math.random().toString(36).slice(2,7);
      localSave(entries);
      renderAll();
    });
  } else {
    fallbackLocalAdd(entry);
  }
}
function fallbackLocalAdd(entry){
  entry.id = 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2,7);
  entries.unshift(entry);
  localSave(entries);
  renderAll();
}
async function deleteEntry(entry){
  // 로컬에서 먼저 제거 (즉각 반영)
  entries = entries.filter(e=>e.id!==entry.id);
  localSave(entries);
  renderAll();
  // Firebase에서도 제거
  if(firebaseReady && syncGroupId && !String(entry.id).startsWith('local-') && !String(entry.id).startsWith('temp-')){
    fbDB.collection('syncGroups').doc(syncGroupId).collection('entries').doc(entry.id).delete()
      .catch(e=>console.error('Firebase 삭제 실패', e));
  }
}

/* =========================================================
   7. 렌더링 — 달력
   ========================================================= */
function renderCalendar(){
  const grid = document.getElementById('calGrid');
  const label = document.getElementById('calMonthLabel');
  label.textContent = `${viewDate.getFullYear()}년 ${viewDate.getMonth()+1}월`;

  const year = viewDate.getFullYear(), month = viewDate.getMonth();
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const dows = ['일','월','화','수','목','금','토'];

  let html = dows.map(d=>`<div class="cal-dow">${d}</div>`).join('');
  for(let i=0;i<firstDow;i++) html += `<div class="cal-cell pad"></div>`;

  const todayStr = todayYmd();
  for(let day=1; day<=daysInMonth; day++){
    const dateObj = new Date(year, month, day);
    const dateKey = ymd(dateObj);
    const count = bannerCountsForDate(dateKey);
    const isToday = dateKey === todayStr;
    const isSelected = dayFilterActive && dateKey === selectedDay;
    const isFull = count >= 5;

    let cellClass = 'cal-cell';
    if(isToday) cellClass += ' today';
    if(isFull) cellClass += ' full';
    if(isSelected) cellClass += ' selected';

    let inner = '';
    if(isFull){
      inner += `<div class="stamp-fill-bg"></div>`;
    } else if(count > 0){
      const radius = 15, circumference = 2*Math.PI*radius;
      const frac = count/5;
      const offset = circumference * (1-frac);
      inner += `<div class="stamp-ring"><svg viewBox="0 0 36 36">
        <circle class="track" cx="18" cy="18" r="${radius}" fill="none" stroke-width="3"></circle>
        <circle class="fill" cx="18" cy="18" r="${radius}" fill="none" stroke-width="3"
          stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"></circle>
      </svg></div>`;
    }
    inner += `<span class="cal-daynum">${day}</span>`;
    html += `<div class="${cellClass}" data-date="${dateKey}">${inner}</div>`;
  }
  grid.innerHTML = html;

  grid.querySelectorAll('.cal-cell[data-date]').forEach(cell=>{
    cell.addEventListener('click', ()=>{
      const dateKey = cell.getAttribute('data-date');
      if(dayFilterActive && selectedDay === dateKey){
        dayFilterActive = false;
      } else {
        selectedDay = dateKey;
        dayFilterActive = true;
      }
      renderAll();
    });
  });

  renderDayStrip();
}

function renderDayStrip(){
  const strip = document.getElementById('dayStrip');
  if(!dayFilterActive){
    strip.style.display = 'none';
    return;
  }
  strip.style.display = 'flex';
  document.getElementById('dayStripDate').textContent = fmtKoreanDate(selectedDay);
  document.getElementById('dayStripCount').textContent = bannerCountsForDate(selectedDay);
}

document.getElementById('calPrev').addEventListener('click', ()=>{
  viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth()-1, 1);
  renderCalendar();
});
document.getElementById('calNext').addEventListener('click', ()=>{
  viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth()+1, 1);
  renderCalendar();
});
document.getElementById('dayStripClear').addEventListener('click', ()=>{
  dayFilterActive = false;
  renderAll();
});

/* =========================================================
   8. 렌더링 — 배너 리스트 + 피드
   ========================================================= */
function escapeHtml(s){
  return (s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function renderBanners(){
  const container = document.getElementById('banners');
  const completedToday = todayCompletedSet();

  container.innerHTML = BANNERS.map(b=>{
    const isExpanded = expandedBanner === b.id;
    const doneToday = completedToday.has(b.id);
    let feedEntries = entriesForBanner(b.id);
    if(dayFilterActive){
      feedEntries = feedEntries.filter(e=>e.dateKey===selectedDay);
    }

    const feedHtml = feedEntries.length
      ? feedEntries.map((e,idx)=>renderEntry(e, idx===feedEntries.length-1)).join('')
      : `<div class="feed-empty">${dayFilterActive ? '이 날짜에는 기록이 없습니다.' : '아직 기록이 없습니다. 첫 줄을 남겨보세요.'}</div>`;

    const pending = pendingAttachments[b.id] || [];
    const pendingHtml = pending.map((a,i)=>renderAttachChip(b.id,a,i)).join('');

    return `
    <section class="banner ${isExpanded?'expanded':''}" data-banner="${b.id}">
      <div class="banner-head" data-toggle="${b.id}">
        <div class="banner-head-left">
          <div class="banner-stamp" style="background:${b.color}">${b.initial}</div>
          <div class="banner-meta">
            <div class="banner-name">${b.name}</div>
            <div class="banner-sub">${b.sub}</div>
          </div>
        </div>
        <div class="banner-head-right">
          <div class="banner-today-check ${doneToday?'done':''}">${doneToday?'✓':''}</div>
          <span class="chevron">▾</span>
        </div>
      </div>
      <div class="banner-body">
        <div class="composer">
          <textarea placeholder="${b.name}에 오늘의 기록을 남겨보세요" data-textarea="${b.id}" rows="2"></textarea>
          <div class="composer-attach-preview" data-preview="${b.id}">${pendingHtml}</div>
          <div class="link-input-row" data-linkrow="${b.id}">
            <input type="text" placeholder="https://..." data-linkinput="${b.id}" />
            <button data-linkadd="${b.id}">추가</button>
          </div>
          <div class="composer-row">
            <div class="composer-tools">
              <button class="tool-btn" title="이미지 첨부" data-imgbtn="${b.id}">🖼</button>
              <button class="tool-btn" title="파일 첨부" data-filebtn="${b.id}">📎</button>
              <button class="tool-btn" title="링크 첨부" data-linkbtn="${b.id}">🔗</button>
              <input type="file" accept="image/*" style="display:none" data-imginput="${b.id}" />
              <input type="file" style="display:none" data-fileinput="${b.id}" />
            </div>
            <button class="send-btn" data-send="${b.id}">기록</button>
          </div>
        </div>
        <div class="feed" data-feed="${b.id}">${feedHtml}</div>
      </div>
    </section>`;
  }).join('');

  bindBannerEvents();
}

function renderAttachChip(bannerId, att, idx){
  if(att.type==='image'){
    return `<div class="attach-chip"><img src="${att.dataUrl}" /><span>${escapeHtml(att.name)}</span><span class="x" data-rmattach="${bannerId}:${idx}">×</span></div>`;
  }
  if(att.type==='file'){
    return `<div class="attach-chip"><span>📎</span><span>${escapeHtml(att.name)}</span><span class="x" data-rmattach="${bannerId}:${idx}">×</span></div>`;
  }
  return `<div class="attach-chip"><span>🔗</span><span>${escapeHtml(att.url)}</span><span class="x" data-rmattach="${bannerId}:${idx}">×</span></div>`;
}

function renderEntry(e, isLast){
  const mediaHtml = (e.attachments||[]).map(a=>{
    if(a.type==='image'){
      return `<img class="entry-img" src="${a.dataUrl}" alt="${escapeHtml(a.name||'')}" />`;
    }
    if(a.type==='file'){
      return `<a class="entry-file" href="${a.dataUrl}" download="${escapeHtml(a.name)}"><span class="ico">📎</span><span>${escapeHtml(a.name)}</span></a>`;
    }
    if(a.type==='link'){
      return `<a class="entry-link" href="${escapeHtml(a.url)}" target="_blank" rel="noopener"><span class="ico">🔗</span><span>${escapeHtml(a.url)}</span></a>`;
    }
    return '';
  }).join('');

  return `
  <div class="entry" data-entryid="${e.id}">
    <div class="entry-rail">
      <div class="entry-dot"></div>
      ${isLast?'':'<div class="entry-line"></div>'}
    </div>
    <div class="entry-body">
      <div class="entry-time">${fmtTime(e.createdAt)} <span class="entry-del" data-delentry="${e.id}">삭제</span></div>
      ${e.text ? `<div class="entry-text">${escapeHtml(e.text)}</div>` : ''}
      ${mediaHtml ? `<div class="entry-media">${mediaHtml}</div>` : ''}
    </div>
  </div>`;
}

function renderAll(){
  renderCalendar();
  renderBanners();
  updateSyncUI();
}

/* =========================================================
   9. 이벤트 바인딩 — 배너 본문
   ========================================================= */
function fileToDataUrl(file){
  return new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onload = ()=>resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* 이미지 자동 리사이즈 + 압축
   - 긴 변을 maxDim(px) 이하로 축소
   - JPEG 품질을 단계적으로 낮춰 목표 용량(maxBytes) 이하로 맞춤
   - Firestore 문서 1MB 한도를 넘지 않도록 충분히 작게 만든다
   → 원본 사진을 그대로 넣지 않으므로 'invalid nested entity' / 용량 초과를 방지 */
async function compressImage(file, maxDim=1280, maxBytes=380*1024){
  // 이미지가 아니면 그냥 원본 dataUrl 반환
  if(!file.type || !file.type.startsWith('image/')){
    return fileToDataUrl(file);
  }
  const srcUrl = await fileToDataUrl(file);
  const img = await new Promise((res,rej)=>{
    const im = new Image();
    im.onload = ()=>res(im);
    im.onerror = rej;
    im.src = srcUrl;
  });

  let { width, height } = img;
  if(width > maxDim || height > maxDim){
    if(width >= height){ height = Math.round(height * maxDim / width); width = maxDim; }
    else { width = Math.round(width * maxDim / height); height = maxDim; }
  }

  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);

  // base64 길이 ≈ bytes * 1.37. 목표 바이트를 base64 문자열 길이로 환산.
  const targetLen = Math.floor(maxBytes * 1.37);
  let quality = 0.82;
  let out = canvas.toDataURL('image/jpeg', quality);
  // 품질을 낮춰가며 목표 용량 이하로
  while(out.length > targetLen && quality > 0.4){
    quality -= 0.12;
    out = canvas.toDataURL('image/jpeg', quality);
  }
  // 그래도 크면 해상도를 한 번 더 줄여 재시도
  if(out.length > targetLen && maxDim > 720){
    return compressImage(file, 900, maxBytes);
  }
  return out;
}

function bindBannerEvents(){
  // 펼치기/접기
  document.querySelectorAll('[data-toggle]').forEach(head=>{
    head.addEventListener('click', ()=>{
      const id = head.getAttribute('data-toggle');
      expandedBanner = (expandedBanner === id) ? null : id;
      renderBanners();
    });
  });

  // 전송
  document.querySelectorAll('[data-send]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = btn.getAttribute('data-send');
      const ta = document.querySelector(`[data-textarea="${id}"]`);
      const text = ta.value.trim();
      const atts = pendingAttachments[id] || [];
      if(!text && atts.length===0) return;
      btn.disabled = true;
      await addEntry(id, text, atts);
      ta.value='';
      delete pendingAttachments[id];
      btn.disabled = false;
      expandedBanner = id; // 유지
      renderAll();
    });
  });

  // 이미지 첨부
  document.querySelectorAll('[data-imgbtn]').forEach(btn=>{
    const id = btn.getAttribute('data-imgbtn');
    btn.addEventListener('click', ()=>{
      document.querySelector(`[data-imginput="${id}"]`).click();
    });
  });
  document.querySelectorAll('[data-imginput]').forEach(inp=>{
    inp.addEventListener('change', async (ev)=>{
      const id = inp.getAttribute('data-imginput');
      const file = ev.target.files[0];
      if(!file) return;
      const btn = document.querySelector(`[data-imgbtn="${id}"]`);
      const prevLabel = btn ? btn.textContent : null;
      if(btn){ btn.disabled = true; btn.textContent = '⏳'; }
      try{
        const dataUrl = await compressImage(file);
        pendingAttachments[id] = pendingAttachments[id] || [];
        pendingAttachments[id].push({type:'image', name:file.name, dataUrl});
        expandedBanner = id;
        renderBanners();
      }catch(e){
        console.error('이미지 처리 실패', e);
        alert('이미지를 처리하지 못했습니다. 다른 사진으로 시도해주세요.');
      }finally{
        if(btn){ btn.disabled = false; btn.textContent = prevLabel; }
        inp.value = ''; // 같은 파일 다시 선택 가능하도록 초기화
      }
    });
  });

  // 파일 첨부
  document.querySelectorAll('[data-filebtn]').forEach(btn=>{
    const id = btn.getAttribute('data-filebtn');
    btn.addEventListener('click', ()=>{
      document.querySelector(`[data-fileinput="${id}"]`).click();
    });
  });
  document.querySelectorAll('[data-fileinput]').forEach(inp=>{
    inp.addEventListener('change', async (ev)=>{
      const id = inp.getAttribute('data-fileinput');
      const file = ev.target.files[0];
      if(!file) return;
      if(file.size > 800*1024){
        alert('파일이 너무 큽니다 (800KB 이하 권장). 큰 파일은 링크 첨부를 이용해주세요.');
        return;
      }
      const dataUrl = await fileToDataUrl(file);
      pendingAttachments[id] = pendingAttachments[id] || [];
      pendingAttachments[id].push({type:'file', name:file.name, dataUrl});
      expandedBanner = id;
      renderBanners();
    });
  });

  // 링크 첨부 토글 + 추가
  document.querySelectorAll('[data-linkbtn]').forEach(btn=>{
    const id = btn.getAttribute('data-linkbtn');
    btn.addEventListener('click', ()=>{
      const row = document.querySelector(`[data-linkrow="${id}"]`);
      row.classList.toggle('show');
    });
  });
  document.querySelectorAll('[data-linkadd]').forEach(btn=>{
    const id = btn.getAttribute('data-linkadd');
    btn.addEventListener('click', ()=>{
      const input = document.querySelector(`[data-linkinput="${id}"]`);
      let url = input.value.trim();
      if(!url) return;
      if(!/^https?:\/\//i.test(url)) url = 'https://' + url;
      pendingAttachments[id] = pendingAttachments[id] || [];
      pendingAttachments[id].push({type:'link', url});
      input.value='';
      expandedBanner = id;
      renderBanners();
    });
  });

  // 첨부 제거 (전송 전)
  document.querySelectorAll('[data-rmattach]').forEach(x=>{
    x.addEventListener('click', (ev)=>{
      ev.stopPropagation();
      const [id, idx] = x.getAttribute('data-rmattach').split(':');
      pendingAttachments[id].splice(Number(idx),1);
      renderBanners();
    });
  });

  // 기록 삭제
  document.querySelectorAll('[data-delentry]').forEach(x=>{
    x.addEventListener('click', async (ev)=>{
      ev.stopPropagation();
      const id = x.getAttribute('data-delentry');
      const entry = entries.find(e=>e.id===id);
      if(!entry) return;
      if(!confirm('이 기록을 삭제할까요?')) return;
      await deleteEntry(entry);
    });
  });

  // 배너 헤더 클릭이 textarea 클릭으로 전파되지 않도록
  document.querySelectorAll('.composer').forEach(c=>{
    c.addEventListener('click', ev=>ev.stopPropagation());
  });
}

/* =========================================================
   10. 동기화 패널 UI
   ========================================================= */
function updateSyncUI(){
  const dot = document.getElementById('syncDot');
  const label = document.getElementById('syncLabel');
  if(firebaseReady && syncGroupId){
    dot.classList.remove('off');
    label.textContent = '동기화 중';
  } else {
    dot.classList.add('off');
    label.textContent = firebaseReady ? '연결 안 됨' : '로컬 저장';
  }
  const codeDisplay = document.getElementById('myCodeDisplay');
  if(codeDisplay){
    codeDisplay.textContent = syncCode || '— — — —';
  }
}

const syncOverlay = document.getElementById('syncOverlay');
function openSyncPanel(){ syncOverlay.classList.add('show'); updateSyncUI(); }
function closeSyncPanel(){ syncOverlay.classList.remove('show'); }

document.getElementById('syncPillBtn').addEventListener('click', openSyncPanel);
document.getElementById('fabSync').addEventListener('click', openSyncPanel);
document.getElementById('syncCloseBtn').addEventListener('click', closeSyncPanel);
syncOverlay.addEventListener('click', (e)=>{ if(e.target===syncOverlay) closeSyncPanel(); });

document.getElementById('joinCodeBtn').addEventListener('click', async ()=>{
  const input = document.getElementById('joinCodeInput');
  const msg = document.getElementById('syncStatusMsg');
  const code = input.value.trim();
  if(!code){ return; }
  if(!firebaseReady){
    msg.textContent = 'Firebase 설정이 완료되지 않아 동기화를 사용할 수 없습니다.';
    msg.className = 'sync-status-msg err';
    return;
  }
  msg.textContent = '연결 중...';
  msg.className = 'sync-status-msg';
  try{
    await joinByCode(code);
    msg.textContent = '연결되었습니다.';
    msg.className = 'sync-status-msg ok';
    input.value='';
  }catch(e){
    msg.textContent = e.message || '연결에 실패했습니다.';
    msg.className = 'sync-status-msg err';
  }
});

/* =========================================================
   11. 초기 구동
   ========================================================= */
function bootLocalMode(){
  entries = localLoad();
  renderAll();
}

// 항상 로컬 데이터를 먼저 화면에 표시 (Firebase 연결 전에도 기록이 보임)
entries = localLoad();
renderAll();

// Firebase 초기화 (연결되면 onSnapshot이 자동으로 최신 데이터로 교체)
initFirebase();

// 서비스워커 등록 (PWA)
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('service-worker.js').catch(e=>console.warn('SW 등록 실패', e));
  });
}
