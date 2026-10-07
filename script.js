const API_BASE = "https://tonir-vault-api.tonirshaik.workers.dev";

async function apiLogin(category, password){
  let res;
  try{
    res = await fetch(`${API_BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, password })
    });
  }catch(networkErr){
    const e = new Error('Network error');
    e.isNetworkError = true;
    throw e;
  }
  const data = await res.json();
  if(!res.ok){
    const e = new Error(data.error || 'Login failed');
    e.status = res.status;
    e.serverMessage = data.error;
    throw e;
  }
  return data.token;
}

function describeAuthError(err, stage){
  if(err.isNetworkError){
    return 'Network error — could not reach the server (check WiFi/DNS)';
  }
  if(err.status === 429){
    return err.serverMessage || 'Too many attempts, please try again in a moment.';
  }
  return 'Incorrect password';
}

let authToken = null;
let authActiveGroup = null;
let authTimerStarted = false;
let authLastRenderedData = null;
let authProgressEls = {};
let authProgressTimer = null;

function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

// ---------- Hidden (deleted) service buttons, persisted locally ----------
let authHiddenGroups = [];
try{ authHiddenGroups = JSON.parse(localStorage.getItem('authHiddenGroups') || '[]'); }catch(e){ authHiddenGroups = []; }
function saveHiddenGroups(){
  try{ localStorage.setItem('authHiddenGroups', JSON.stringify(authHiddenGroups)); }catch(e){}
}
function applyHiddenGroupsToStaticGrid(){
  document.querySelectorAll('#authCategoryGrid > .swipe-item[data-group]').forEach(item => {
    const g = item.getAttribute('data-group');
    item.style.display = authHiddenGroups.includes(g) ? 'none' : '';
  });
  AUTH_GROUPS = AUTH_GROUPS.filter(g => !authHiddenGroups.includes(g));
}

// ---------- Generic swipe-to-reveal engine (mouse + touch via Pointer Events) ----------
let swipeJustDragged = false;
let openSwipeItems = [];

function authCloseAllSwipes(){
  openSwipeItems.forEach(el => { el.style.transition = 'transform .25s var(--ease)'; el.style.transform = 'translateX(0px)'; });
  openSwipeItems = [];
}

function makeSwipeable(item, opts){
  const content = item.querySelector('.swipe-content');
  if(!content) return;
  const maxLeft = opts.rightWidth || 0;   // dragging content left reveals the RIGHT action panel
  const maxRight = opts.leftWidth || 0;   // dragging content right reveals the LEFT action panel
  let startX = 0, startY = 0, baseX = 0, dragging = false, moved = false, axis = null;

  function getX(){
    const m = /translateX\((-?\d+(?:\.\d+)?)px\)/.exec(content.style.transform);
    return m ? parseFloat(m[1]) : 0;
  }
  function setX(x){ content.style.transform = `translateX(${x}px)`; }

  function onDown(e){
    if(e.button !== undefined && e.button !== 0) return;
    const pt = e.touches ? e.touches[0] : e;
    startX = pt.clientX; startY = pt.clientY; baseX = getX();
    dragging = true; moved = false; axis = null;
    content.style.transition = 'none';
  }
  function onMove(e){
    if(!dragging) return;
    const pt = e.touches ? e.touches[0] : e;
    const dx = pt.clientX - startX;
    const dy = pt.clientY - startY;
    if(axis === null){
      if(Math.abs(dx) > 6 || Math.abs(dy) > 6) axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if(axis === 'y') return;
    if(Math.abs(dx) > 4) moved = true;
    if(e.cancelable) e.preventDefault();
    let next = baseX + dx;
    if(next < -maxLeft) next = -maxLeft;
    if(next > maxRight) next = maxRight;
    setX(next);
  }
  function onUp(){
    if(!dragging) return;
    dragging = false;
    content.style.transition = 'transform .25s var(--ease)';
    const x = getX();
    let target = 0;
    if(maxLeft > 0 && x <= -maxLeft / 2) target = -maxLeft;
    else if(maxRight > 0 && x >= maxRight / 2) target = maxRight;
    setX(target);
    if(target !== 0){
      openSwipeItems.filter(el => el !== content).forEach(el => { el.style.transition = 'transform .25s var(--ease)'; el.style.transform = 'translateX(0px)'; });
      openSwipeItems = [content];
    }else{
      openSwipeItems = openSwipeItems.filter(el => el !== content);
    }
    if(moved){
      swipeJustDragged = true;
      setTimeout(() => { swipeJustDragged = false; }, 80);
    }
  }
  content.addEventListener('pointerdown', onDown);
  content.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  content.addEventListener('pointercancel', onUp);
}

// Auto-close any open swipe item when the user taps/clicks somewhere
// that isn't part of that open item (e.g. another card, blank space, etc).
document.addEventListener('pointerdown', (e) => {
  if(openSwipeItems.length === 0) return;
  const stillInside = openSwipeItems.some(content => {
    const wrapper = content.closest('.swipe-item');
    return wrapper && wrapper.contains(e.target);
  });
  if(!stillInside) authCloseAllSwipes();
}, true);

// ---------- Drag-to-reorder for account code boxes ----------
// Order is remembered per-group in localStorage so it survives refreshes
// and re-fetches (the server always returns accounts in its own order).
let authReorderState = null;

function authOrderKey(group){ return 'authOrder:' + group; }

function authApplyCustomOrder(group, accounts){
  let order = [];
  try{ order = JSON.parse(localStorage.getItem(authOrderKey(group)) || '[]'); }catch(e){ order = []; }
  if(!order.length) return accounts;
  const byName = new Map(accounts.map(a => [a.name, a]));
  const ordered = [];
  order.forEach(name => {
    if(byName.has(name)){ ordered.push(byName.get(name)); byName.delete(name); }
  });
  // Any account not in the saved order (newly added) goes at the end,
  // in the order the server returned it.
  byName.forEach(a => ordered.push(a));
  return ordered;
}

function authSaveOrderFromDOM(group){
  const container = document.getElementById('authCodeContainer');
  const order = Array.from(container.children).map(el => el.getAttribute('data-acc-name'));
  try{ localStorage.setItem(authOrderKey(group), JSON.stringify(order)); }catch(e){}
}

function authStartReorder(e, item, group, handle){
  if(e.button !== undefined && e.button !== 0) return;
  e.preventDefault();
  authCloseAllSwipes();
  const rect = item.getBoundingClientRect();
  authReorderState = { item, group, grabOffsetY: e.clientY - rect.top, pointerId: e.pointerId };
  item.classList.add('auth-reordering');
  document.body.style.userSelect = 'none';
  window.addEventListener('pointermove', authReorderMoveListener);
  window.addEventListener('pointerup', authReorderUpListener);
  window.addEventListener('pointercancel', authReorderUpListener);
}

function authReorderMoveListener(e){
  if(!authReorderState || e.pointerId !== authReorderState.pointerId) return;
  if(e.cancelable) e.preventDefault();
  authReorderMove(e);
}

function authReorderUpListener(e){
  if(!authReorderState || e.pointerId !== authReorderState.pointerId) return;
  window.removeEventListener('pointermove', authReorderMoveListener);
  window.removeEventListener('pointerup', authReorderUpListener);
  window.removeEventListener('pointercancel', authReorderUpListener);
  authEndReorder();
}

function authReorderMove(e){
  if(!authReorderState) return;
  const { item, grabOffsetY } = authReorderState;
  const container = item.parentElement;
  if(!container) return;

  // Measure the item's natural (untransformed) position so the visual
  // offset stays correct even after a DOM swap changes its static spot.
  const prevTransform = item.style.transform;
  item.style.transform = 'none';
  const naturalTop = item.getBoundingClientRect().top;
  item.style.transform = prevTransform;

  const desiredTop = e.clientY - grabOffsetY;
  item.style.transform = `translateY(${desiredTop - naturalTop}px)`;

  // Simple edge auto-scroll while dragging near the top/bottom of the list.
  const containerRect = container.getBoundingClientRect();
  const margin = 36;
  if(e.clientY < containerRect.top + margin) container.scrollTop -= 10;
  else if(e.clientY > containerRect.bottom - margin) container.scrollTop += 10;

  // Reorder siblings based on where the pointer currently sits.
  const siblings = Array.from(container.children).filter(el => el !== item);
  let insertBefore = null;
  for(const sib of siblings){
    const r = sib.getBoundingClientRect();
    const mid = r.top + r.height / 2;
    if(e.clientY < mid){ insertBefore = sib; break; }
  }
  if(insertBefore){
    if(item.nextElementSibling !== insertBefore) container.insertBefore(item, insertBefore);
  }else if(container.lastElementChild !== item){
    container.appendChild(item);
  }
}

function authEndReorder(){
  if(!authReorderState) return;
  const { item, group } = authReorderState;
  item.style.transition = 'transform 0.15s var(--ease)';
  item.style.transform = 'translateY(0px)';
  item.classList.remove('auth-reordering');
  document.body.style.userSelect = '';
  setTimeout(() => { item.style.transition = ''; item.style.transform = ''; }, 160);
  authSaveOrderFromDOM(group);
  authReorderState = null;
}

// ---------- Password confirm modal (used for every delete action) ----------
let authPendingDeleteAction = null;
function authOpenConfirmModal(title, action){
  authPendingDeleteAction = action;
  document.getElementById('authPassConfirmTitle').textContent = title;
  const input = document.getElementById('authPassConfirmInput');
  input.value = '';
  document.getElementById('authPassConfirmError').textContent = '';
  document.getElementById('authPassConfirmModal').style.display = 'flex';
  setTimeout(() => input.focus(), 50);
}
function authCloseConfirmModal(){
  const modal = document.getElementById('authPassConfirmModal');
  if(modal) modal.style.display = 'none';
  authPendingDeleteAction = null;
}
let authConfirmInFlight = false;
async function authConfirmPassAction(){
  const input = document.getElementById('authPassConfirmInput');
  const val = input.value.trim();
  const errorEl = document.getElementById('authPassConfirmError');
  if(!val || authConfirmInFlight) return;
  authConfirmInFlight = true;
  const btn = document.querySelector('#authPassConfirmModal .auth-add-save');
  const originalLabel = btn.textContent;
  btn.textContent = 'Checking...';
  btn.disabled = true;
  errorEl.textContent = '';
  try{
    // Verify against the real vault password on the server (same
    // check used to unlock the authenticator) — no hardcoded secret.
    await apiLogin('totp', val);
    const action = authPendingDeleteAction;
    authCloseConfirmModal();
    if(action) action();
  }catch(err){
    errorEl.textContent = describeAuthError(err, 'login');
  }finally{
    btn.textContent = originalLabel;
    btn.disabled = false;
    authConfirmInFlight = false;
  }
}

// ---------- Delete an entire service button from the dashboard ----------
function authRequestDeleteGroup(group, btnEl){
  authOpenConfirmModal(`Delete "${group}"?`, () => authDeleteGroup(group));
}
async function authDeleteGroup(group){
  const item = document.querySelector(`#authCategoryGrid .swipe-item[data-group="${CSS.escape(group)}"]`);
  if(item){
    if(STATIC_GROUPS.some(s => s.toLowerCase() === group.toLowerCase())){
      item.style.display = 'none';
    }else{
      item.remove();
    }
  }
  if(!authHiddenGroups.includes(group)){
    authHiddenGroups.push(group);
    saveHiddenGroups();
  }
  AUTH_GROUPS = AUTH_GROUPS.filter(g => g !== group);

  // best-effort: also remove any custom accounts under this group on the server
  try{
    const entry = authPrefetchCache[group] || await authFetchGroup(group).catch(() => null);
    if(entry && entry.data && Array.isArray(entry.data.accounts)){
      entry.data.accounts.forEach(acc => {
        fetch(`${API_BASE}/totp/remove`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: authToken, group, name: acc.name })
        }).catch(() => {});
      });
    }
  }catch(e){ /* ignore */ }
  delete authPrefetchCache[group];
  delete authPrefetchPromises[group];
}

// ---------- Edit an individual account ----------
function authOpenEditAccountForm(group, oldName){
  document.getElementById('authEditOldGroup').value = group;
  document.getElementById('authEditOldName').value = oldName;
  document.getElementById('authEditName').value = oldName;
  document.getElementById('authEditSecret').value = '';
  document.getElementById('authEditError').textContent = '';
  document.getElementById('authEditModal').style.display = 'flex';
  setTimeout(() => document.getElementById('authEditName').focus(), 50);
}
function authCloseEditModal(){
  const modal = document.getElementById('authEditModal');
  if(modal) modal.style.display = 'none';
}
let authEditInFlight = false;
async function authSaveEditAccount(){
  const group = document.getElementById('authEditOldGroup').value;
  const oldName = document.getElementById('authEditOldName').value;
  const newName = document.getElementById('authEditName').value.trim();
  const newSecret = document.getElementById('authEditSecret').value.trim();
  const errorEl = document.getElementById('authEditError');
  if(authEditInFlight) return;
  if(!newName || !newSecret){
    errorEl.textContent = 'Both name and Secret key are required.';
    return;
  }
  authEditInFlight = true;
  const saveBtn = document.querySelector('#authEditModal .auth-add-save');
  const original = saveBtn.textContent;
  saveBtn.textContent = 'Saving...';
  saveBtn.disabled = true;
  errorEl.textContent = '';
  try{
    const editRes = await fetch(`${API_BASE}/totp/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: authToken, group, oldName, newName, secret: newSecret })
    });
    const editData = await editRes.json().catch(() => ({}));
    if(!editRes.ok) throw new Error(editData.error || 'Could not save.');

    delete authPrefetchCache[group];
    delete authPrefetchPromises[group];
    authCloseEditModal();
    await authOpenCategory(group);
  }catch(err){
    errorEl.textContent = err.message || 'Network error, please try again.';
  }finally{
    saveBtn.textContent = original;
    saveBtn.disabled = false;
    authEditInFlight = false;
  }
}

// ---------- Delete an individual account ----------
async function authDeleteAccount(group, name){
  try{
    await fetch(`${API_BASE}/totp/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: authToken, group, name })
    });
  }catch(e){ /* ignore */ }
  delete authPrefetchCache[group];
  delete authPrefetchPromises[group];
  if(authActiveGroup === group) await authOpenCategory(group);
}

function resetAuthLock(){
  authToken = null;
  authActiveGroup = null;
  authPrefetchCache = {};
  authPrefetchPromises = {};
  authLastRenderedData = null;
  authProgressEls = {};
  if(authProgressTimer){ clearInterval(authProgressTimer); authProgressTimer = null; }
  const passInput = document.getElementById('authMasterPass');
  const errorEl = document.getElementById('authLockError');
  if(passInput){ passInput.value = ''; passInput.type = 'password'; }
  if(errorEl){ errorEl.textContent = ''; }
  document.getElementById('authEyeIcon').innerHTML = '<i class="fa-solid fa-eye"></i>';
  document.querySelectorAll('.auth-screen').forEach(s => s.classList.remove('active'));
  document.getElementById('authLockScreen').classList.add('active');
  document.getElementById('authMainTitle').textContent = '🔒 Authenticator';
  const addForm = document.getElementById('authAddForm');
  const addBtn = document.getElementById('authAddBtn');
  if(addForm) addForm.style.display = 'none';
  if(addBtn) addBtn.style.display = 'flex';
  authCloseSettingsModal();
  authCloseConfirmModal();
  authCloseEditModal();
  document.querySelectorAll('.auth-cat-btn-dynamic').forEach(el => el.parentElement.remove());
  applyHiddenGroupsToStaticGrid();
  authCloseAllSwipes();
}

function authTogglePass(){
  const p = document.getElementById('authMasterPass');
  const eye = document.getElementById('authEyeIcon');
  if(p.type === "password"){
    p.type = "text";
    eye.innerHTML = '<i class="fa-solid fa-eye-slash"></i>';
  } else {
    p.type = "password";
    eye.innerHTML = '<i class="fa-solid fa-eye"></i>';
  }
}

function authClearError(){
  document.getElementById('authLockError').textContent = '';
}

let authInFlight = false;
async function authTryUnlock(){
  const val = document.getElementById('authMasterPass').value.trim();
  const errorEl = document.getElementById('authLockError');
  const btn = document.getElementById('authSubmitBtn');
  if(!val || authInFlight) return;
  authInFlight = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Checking...';
  btn.disabled = true;
  try{
    authToken = await apiLogin('totp', val);
    errorEl.textContent = '';
    authShowMenu();
    authPrefetchAll();
  }catch(err){
    errorEl.textContent = describeAuthError(err, 'login');
  }finally{
    btn.textContent = originalLabel;
    btn.disabled = false;
    authInFlight = false;
  }
}

function authCopyText(text){
  navigator.clipboard?.writeText(text);
  const notice = document.getElementById('authCopyNotice');
  notice.style.display = 'block';
  setTimeout(() => { notice.style.display = 'none'; }, 1300);
}

function authShowMenu(){
  document.getElementById('authMainTitle').textContent = "🔒 Authenticator";
  document.querySelectorAll('.auth-screen').forEach(s => s.classList.remove('active'));
  document.getElementById('authMenuScreen').classList.add('active');
  applyHiddenGroupsToStaticGrid();
  authLoadCustomGroups();
}

// ---------- Auto icon resolver for custom (user-added) services ----------
// 1) If the service name matches a well-known brand, use its real
//    Font Awesome brand icon — instant, no network request needed.
// 2) Otherwise, guess the company's domain from the name and pull its
//    real logo from Clearbit's free logo API. If that image fails to
//    load (unknown domain, offline, etc.) it quietly falls back to the
//    plain key icon so the button never looks broken.
const KNOWN_BRAND_ICONS = {
  shopify:'fa-shopify', paypal:'fa-paypal', spotify:'fa-spotify', discord:'fa-discord',
  github:'fa-github', gitlab:'fa-gitlab', bitbucket:'fa-bitbucket', reddit:'fa-reddit',
  whatsapp:'fa-whatsapp', steam:'fa-steam', amazon:'fa-amazon', apple:'fa-apple',
  microsoft:'fa-microsoft', dropbox:'fa-dropbox', twitter:'fa-x-twitter', x:'fa-x-twitter',
  youtube:'fa-youtube', pinterest:'fa-pinterest', snapchat:'fa-snapchat', slack:'fa-slack',
  twitch:'fa-twitch', vimeo:'fa-vimeo', wordpress:'fa-wordpress', skype:'fa-skype',
  yahoo:'fa-yahoo', tumblr:'fa-tumblr', behance:'fa-behance', figma:'fa-figma',
  trello:'fa-trello', patreon:'fa-patreon', etsy:'fa-etsy', airbnb:'fa-airbnb',
  uber:'fa-uber', google:'fa-google', facebook:'fa-facebook',
  instagram:'fa-instagram', tiktok:'fa-tiktok', linkedin:'fa-linkedin', telegram:'fa-telegram',
  binance:'fa-btc', mega:'fa-cloud'
};

// Manual overrides: real logo URLs for services where auto-guessing the
// domain (or Clearbit's coverage) doesn't work reliably.
const MANUAL_LOGO_URLS = {
  redotpay: 'https://www.redotpay.com/img/favicon.png'
};

function authGetGroupIconHtml(name){
  const key = String(name).toLowerCase().trim();
  const brand = KNOWN_BRAND_ICONS[key];
  if(brand){
    return `<i class="fa-brands ${brand}"></i>`;
  }
  const manualUrl = MANUAL_LOGO_URLS[key];
  const fallback = `this.outerHTML='<i class=&quot;fa-solid fa-key&quot;></i>'`;
  if(manualUrl){
    return `<img class="auth-cat-icon-img" alt="" loading="lazy" src="${manualUrl}" onerror="${fallback}">`;
  }
  // Best-effort domain guess: "RedotPay" -> "redotpay.com"
  const domainGuess = key.replace(/[^a-z0-9]/g, '') + '.com';
  return `<img class="auth-cat-icon-img" alt="" loading="lazy"
            src="https://logo.clearbit.com/${domainGuess}?size=64"
            onerror="${fallback}">`;
}

const STATIC_GROUPS = ['Gmail','Facebook','Instagram','TikTok','Mega','linkedin','Telegram','Binance'];
let AUTH_GROUPS = [...STATIC_GROUPS];
let authPrefetchCache = {};
let authPrefetchPromises = {};

// ---------- Load and render custom (user-created) service buttons ----------
async function authLoadCustomGroups(){
  if(!authToken) return;
  try{
    const res = await fetch(`${API_BASE}/totp-groups?token=${encodeURIComponent(authToken)}`, { cache: 'no-store' });
    const data = await res.json();
    if(!res.ok) return;
    const extra = (data.groups || []).filter(
      g => !STATIC_GROUPS.some(s => s.toLowerCase() === g.toLowerCase())
    );
    renderExtraGroupButtons(extra);
    AUTH_GROUPS = [...STATIC_GROUPS, ...extra];
    extra.forEach(g => authFetchGroup(g).catch(() => {}));
  }catch(e){ /* silently ignore network errors, static buttons still exist */ }
}

function renderExtraGroupButtons(groups){
  const grid = document.getElementById('authCategoryGrid');
  grid.querySelectorAll('.auth-cat-btn-dynamic').forEach(el => el.parentElement.remove());
  groups
    .filter(g => !authHiddenGroups.includes(g))
    .forEach(g => {
      const item = document.createElement('div');
      item.className = 'swipe-item';
      item.setAttribute('data-group', g);
      item.innerHTML = `
        <div class="swipe-actions swipe-actions-right">
          <button class="swipe-action-btn swipe-delete-btn"><i class="fa-solid fa-trash"></i></button>
        </div>
        <div class="auth-cat-btn auth-cat-btn-dynamic swipe-content">${authGetGroupIconHtml(g)} ${escapeHtml(g)}</div>`;
      item.querySelector('.swipe-content').addEventListener('click', () => {
        if(swipeJustDragged) return;
        authOpenCategory(g);
      });
      item.querySelector('.swipe-delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        authRequestDeleteGroup(g, e.currentTarget);
      });
      makeSwipeable(item, { rightWidth: 64 });
      grid.appendChild(item);
    });
}

function authOpenSettingsModal(){
  document.getElementById('authAddGroupError').textContent = '';
  document.getElementById('authSettingsModal').style.display = 'flex';
}

function authCloseSettingsModal(){
  const modal = document.getElementById('authSettingsModal');
  if(modal) modal.style.display = 'none';
  const n1 = document.getElementById('authNewGroupName');
  const n2 = document.getElementById('authNewGroupAccName');
  const n3 = document.getElementById('authNewGroupSecret');
  const err = document.getElementById('authAddGroupError');
  if(n1) n1.value = '';
  if(n2) n2.value = '';
  if(n3) n3.value = '';
  if(err) err.textContent = '';
}

let authAddGroupInFlight = false;
async function authSaveNewGroup(){
  const group = document.getElementById('authNewGroupName').value.trim();
  const name = document.getElementById('authNewGroupAccName').value.trim();
  const secret = document.getElementById('authNewGroupSecret').value.trim();
  const errorEl = document.getElementById('authAddGroupError');
  if(authAddGroupInFlight) return;
  if(!group || !name || !secret){
    errorEl.textContent = 'Service name, Account name and Secret key — all are required.';
    return;
  }
  authAddGroupInFlight = true;
  const saveBtn = document.querySelector('#authAddGroupForm .auth-add-save');
  const originalLabel = saveBtn.textContent;
  saveBtn.textContent = 'Saving...';
  saveBtn.disabled = true;
  errorEl.textContent = '';
  try{
    const res = await fetch(`${API_BASE}/totp/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: authToken, group, name, secret })
    });
    const data = await res.json().catch(() => ({}));
    if(!res.ok) throw new Error(data.error || 'Could not add.');

    authCloseSettingsModal();
    await authLoadCustomGroups();
  }catch(err){
    errorEl.textContent = err.message || 'Network error, please try again.';
  }finally{
    saveBtn.textContent = originalLabel;
    saveBtn.disabled = false;
    authAddGroupInFlight = false;
  }
}

function authFetchGroup(group){
  if(authPrefetchPromises[group]) return authPrefetchPromises[group];
  const p = (async () => {
    const res = await fetch(`${API_BASE}/totp?group=${encodeURIComponent(group)}&token=${encodeURIComponent(authToken)}`, { cache: 'no-store' });
    const data = await res.json();
    if(!res.ok) throw new Error('fetch failed');
    const entry = { data, fetchedAt: Date.now(), group };
    authPrefetchCache[group] = entry;
    return entry;
  })();
  authPrefetchPromises[group] = p;
  p.finally(() => { delete authPrefetchPromises[group]; });
  return p;
}

function authPrefetchAll(){
  authPrefetchCache = {};
  AUTH_GROUPS.forEach(g => authFetchGroup(g).catch(() => {  }));
}

async function authOpenCategory(group){
  if(!authToken || swipeJustDragged) return;
  authCloseAllSwipes();
  authActiveGroup = group;
  document.getElementById('authMainTitle').textContent = group + " Code";
  const container = document.getElementById('authCodeContainer');
  container.innerHTML = "";
  authLastRenderedData = null;
  authProgressEls = {};
  authHideAddForm();

  document.getElementById('authMenuScreen').classList.remove('active');
  document.getElementById('authListScreen').classList.add('active');

  let entry = authPrefetchCache[group];
  if(!entry){
    try{
      entry = await authFetchGroup(group);
    }catch(e){
      container.innerHTML = "<p style='text-align:center;color:var(--text-dim);'>Couldn't load codes — try again.</p>";
      return;
    }
    if(authActiveGroup !== group) return;
  }

  authLastFetch = entry.fetchedAt;
  authRefreshCodes._cache = entry;
  renderCodes(entry, Date.now());

  if(!authTimerStarted){
    authTimerStarted = true;
    setInterval(authRefreshCodes, 1000);
  }
}

function authShowAddForm(){
  document.getElementById('authAddForm').style.display = 'block';
  document.getElementById('authAddBtn').style.display = 'none';
  document.getElementById('authNewName').focus();
}

function authHideAddForm(){
  document.getElementById('authAddForm').style.display = 'none';
  document.getElementById('authAddBtn').style.display = 'flex';
  document.getElementById('authNewName').value = '';
  document.getElementById('authNewSecret').value = '';
  document.getElementById('authAddError').textContent = '';
}

let authAddInFlight = false;
async function authSaveNewAccount(){
  const name = document.getElementById('authNewName').value.trim();
  const secret = document.getElementById('authNewSecret').value.trim();
  const errorEl = document.getElementById('authAddError');
  if(authAddInFlight) return;
  if(!name || !secret){
    errorEl.textContent = 'Both name and Secret key are required.';
    return;
  }
  authAddInFlight = true;
  const saveBtn = document.querySelector('.auth-add-save');
  const originalLabel = saveBtn.textContent;
  saveBtn.textContent = 'Saving...';
  saveBtn.disabled = true;
  errorEl.textContent = '';
  try{
    const res = await fetch(`${API_BASE}/totp/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: authToken, group: authActiveGroup, name, secret })
    });
    const data = await res.json().catch(() => ({}));
    if(!res.ok) throw new Error(data.error || 'Could not add.');

    delete authPrefetchCache[authActiveGroup];
    delete authPrefetchPromises[authActiveGroup];
    authHideAddForm();
    await authOpenCategory(authActiveGroup);
  }catch(err){
    errorEl.textContent = err.message || 'Network error, please try again.';
  }finally{
    saveBtn.textContent = originalLabel;
    saveBtn.disabled = false;
    authAddInFlight = false;
  }
}

let authLastFetch = 0;
async function authRefreshCodes(){
  if(!authToken || !authActiveGroup) return;
  const requestedGroup = authActiveGroup;

  const now = Date.now();
  const cache = authRefreshCodes._cache;
  if(now - authLastFetch < 3000 && cache && cache.group === requestedGroup){
    renderCodes(cache, now);
    return;
  }
  try{
    const entry = await authFetchGroup(requestedGroup);
    if(authActiveGroup !== requestedGroup) return;
    authLastFetch = entry.fetchedAt;
    authRefreshCodes._cache = entry;
    renderCodes(entry, authLastFetch);
  }catch(e){  }
}

function renderCodes(cacheObj, now){
  if(authReorderState) return; // don't touch the DOM while the user is mid-drag
  const container = document.getElementById('authCodeContainer');
  const { data, fetchedAt } = cacheObj;

  if(data !== authLastRenderedData){
    authLastRenderedData = data;
    authProgressEls = {};
    container.innerHTML = "";
    const group = authActiveGroup;
    const orderedAccounts = authApplyCustomOrder(group, data.accounts);
    orderedAccounts.forEach((acc) => {
      const item = document.createElement('div');
      item.className = 'swipe-item acc-swipe-item';
      item.setAttribute('data-acc-name', acc.name);
      item.innerHTML = `
        <div class="swipe-actions swipe-actions-left">
          <button class="swipe-action-btn swipe-edit-btn" title="Edit"><i class="fa-solid fa-pen"></i></button>
        </div>
        <div class="swipe-actions swipe-actions-right">
          <button class="swipe-action-btn swipe-delete-btn" title="Delete"><i class="fa-solid fa-trash"></i></button>
        </div>
        <div class="auth-account-box swipe-content">
          <div class="auth-drag-handle" title="Drag to reorder"><i class="fa-solid fa-grip-lines"></i></div>
          <span class="auth-account-name">${escapeHtml(acc.name)}</span>
          <div class="auth-otp-code">${escapeHtml(acc.code)}</div>
          <div class="auth-progress-bar"><div class="auth-progress-fill"></div></div>
        </div>`;

      item.querySelector('.swipe-content').addEventListener('click', () => {
        if(swipeJustDragged) return;
        authCopyText(acc.code);
      });
      item.querySelector('.swipe-edit-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        authCloseAllSwipes();
        authOpenEditAccountForm(group, acc.name);
      });
      item.querySelector('.swipe-delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        authOpenConfirmModal(`Delete "${acc.name}"?`, () => authDeleteAccount(group, acc.name));
      });
      const handle = item.querySelector('.auth-drag-handle');
      handle.addEventListener('click', (e) => e.stopPropagation());
      handle.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        authStartReorder(e, item, group, handle);
      });
      makeSwipeable(item, { leftWidth: 64, rightWidth: 64 });

      container.appendChild(item);
      authProgressEls[acc.name] = item.querySelector('.auth-progress-fill');
    });
  }

  const elapsedSec = (now - fetchedAt) / 1000;
  data.accounts.forEach((acc) => {
    const fillEl = authProgressEls[acc.name];
    if(!fillEl) return;
    const remaining = Math.max(acc.secondsRemaining - elapsedSec, 0);
    const pct = (remaining / 30) * 100;
    fillEl.style.width = pct + '%';
  });

  if(!authProgressTimer){
    authProgressTimer = setInterval(() => {
      const c = authRefreshCodes._cache;
      if(c) renderCodes(c, Date.now());
    }, 100);
  }
}

// Wire up swipe-to-delete on the built-in (static) dashboard buttons
document.querySelectorAll('#authCategoryGrid > .swipe-item[data-group]').forEach(item => {
  makeSwipeable(item, { rightWidth: 64 });
});
applyHiddenGroupsToStaticGrid();

resetAuthLock();
document.getElementById('authMasterPass')?.focus();


// ===== Fingerprint / Face unlock (passkey) for Authenticator =====
(function () {
  const MAGIC = '__passkey__', CAT = 'totp';
  const supported = !!(window.PublicKeyCredential && navigator.credentials);
  if (!supported) return;
  const enc = s => new TextEncoder().encode(s);
  const b64u = buf => { let s = ''; new Uint8Array(buf).forEach(x => s += String.fromCharCode(x)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const unb64u = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };

  async function post(path, body) {
    const r = await fetch(API_BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ('Error ' + r.status));
    return d;
  }

  // passkey token thakle password-er bodole oita dei
  let pending = null;
  const _apiLogin = apiLogin;
  apiLogin = async function (category, password) {
    if (password === MAGIC && category === CAT && pending) { const t = pending; pending = null; return t; }
    return _apiLogin(category, password);
  };

  let busy = false;
  async function unlock() {
    if (busy) return;
    busy = true;
    const errorEl = document.getElementById('authLockError');
    try {
      const o = await post('/passkey/login-options', { category: CAT });
      let ids = Array.isArray(o.allow) ? o.allow.slice() : [];
      try { const k = localStorage.getItem('pkCredId'); if (!ids.length && k) ids = [k]; } catch (_e) {}
      const pub = { challenge: enc(o.challenge), rpId: o.rpId, userVerification: 'required', timeout: 60000 };
      if (ids.length) pub.allowCredentials = ids.map(id => ({ type: 'public-key', id: unb64u(id), transports: ['internal'] }));
      const cred = await navigator.credentials.get({ publicKey: pub });
      try { localStorage.setItem('pkCredId', cred.id); } catch (_e) {}
      const r = cred.response;
      const d = await post('/passkey/login', {
        category: CAT, id: cred.id,
        clientDataJSON: b64u(r.clientDataJSON), authenticatorData: b64u(r.authenticatorData), signature: b64u(r.signature)
      });
      pending = d.token;
      const f = document.getElementById('authMasterPass');
      f.value = MAGIC;
      authTryUnlock();
      setTimeout(() => { if (f.value === MAGIC) f.value = ''; }, 10000);
    } catch (e) {
      const cancelled = e && (e.name === 'NotAllowedError' || e.name === 'AbortError');
      if (errorEl) errorEl.textContent = cancelled ? 'Fingerprint/Face kaj kore ni. Password din.' : (e.message || 'Passkey error');
    } finally { busy = false; }
  }

  const submit = document.getElementById('authSubmitBtn');
  if (submit && !document.getElementById('authPasskeyBtn')) {
    const b = document.createElement('button');
    b.type = 'button'; b.id = 'authPasskeyBtn'; b.className = 'pk-btn';
    b.innerHTML = '<i class="fa-solid fa-fingerprint"></i> Fingerprint / Face';
    b.onclick = unlock;
    submit.after(b);
  }
})();
