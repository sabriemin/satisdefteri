(() => {
'use strict';
/* ============ CONFIG / STATE ============ */
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};
let cfg = LS.get('sd_cfg', { api: '', pin: '', ad: '' });
// A setup link (?api=...&pin=...) fills the settings in one tap, then is removed from the address bar.
(() => {
  const p = new URLSearchParams(location.search);
  if (p.get('api')) { cfg.api = p.get('api'); if (p.get('pin')) cfg.pin = p.get('pin'); LS.set('sd_cfg', cfg); history.replaceState(null, '', location.pathname); }
})();

const EMPTY = { urunler: [], musteriler: [], alislar: [], satislar: [], fireler: [], tahsilatlar: [] };
let S = Object.assign({}, EMPTY, LS.get('sd_data', {}));
let outbox = LS.get('sd_outbox', []);
let sheetUrl = LS.get('sd_sheet', '');
let lastSync = LS.get('sd_lastsync', 0);
let syncState = 'idle'; // idle | syncing | offline | error | pin
let tab = LS.get('sd_tab', 'satis'), stokSeg = 'urun', period = 'bugun', q = '', dirty = true, D = null;
let cart = LS.get('sd_cart', []);
const saveCart = () => LS.set('sd_cart', cart);
const persist = () => { LS.set('sd_data', S); LS.set('sd_outbox', outbox); };

/* ============ HELPERS ============ */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r2 = n => Math.round((+n || 0) * 100) / 100;
const r3 = n => Math.round((+n || 0) * 1000) / 1000;
const tl = n => new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(+n || 0);
const nf = (n, d = 3) => (+n || 0).toLocaleString('tr-TR', { maximumFractionDigits: d });
const U = b => b === 'kg' ? 'kg' : 'adet';
const qty = (n, b) => nf(n) + ' ' + U(b);
const parseNum = v => { v = String(v ?? '').trim().replace(/\s|₺|TL/gi, ''); if (!v) return NaN; if (v.includes(',')) v = v.replace(/\./g, '').replace(',', '.'); return Number(v); };
const numVal = v => v === undefined || v === null || v === '' ? '' : String(r3(v)).replace('.', ',');
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => ymd(new Date());
const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDate = s => { if (!s) return ''; const [y, m, d] = String(s).split('-'); return d ? `${d}.${m}.${y}` : s; };
const GUN = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
const AY = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const dayTitle = s => { if (s === today()) return 'Bugün'; const y = new Date(); y.setDate(y.getDate() - 1); if (s === ymd(y)) return 'Dün'; const d = new Date(s + 'T12:00:00'); return isNaN(d) ? s : `${d.getDate()} ${AY[d.getMonth()]} ${GUN[d.getDay()]}`; };
const initials = s => (s || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toLocaleUpperCase('tr-TR');
const low = s => String(s || '').toLocaleLowerCase('tr-TR');
const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function toast(m) { document.querySelectorAll('.toast').forEach(t => t.remove()); const t = document.createElement('div'); t.className = 'toast'; t.textContent = m; document.body.appendChild(t); setTimeout(() => t.remove(), 2600); }

/* ============ SYNC WITH GOOGLE SHEETS ============ */
function fromServer(data) {
  const sales = (data.satislar || []).map(s => ({ ...s, kalemler: [] }));
  const byId = {}; for (const s of sales) byId[s.id] = s;
  const groups = {};
  for (const k of (data.kalemler || [])) {
    const s = byId[k.satisId]; if (!s) continue;
    const key = k.satisId + '|' + k.kalemNo;
    let item = groups[key];
    if (!item) { item = groups[key] = { urunId: k.urunId, urunAd: k.urunAd, birim: k.birim, miktar: 0, birimFiyat: +k.birimFiyat || 0, partiler: [], _n: +k.kalemNo || 0 }; s.kalemler.push(item); }
    item.miktar = r3(item.miktar + (+k.miktar || 0));
    item.partiler.push({ alisId: k.alisId || '', lotNo: k.lotNo || '', miktar: +k.miktar || 0, birimMaliyet: +k.birimMaliyet || 0 });
  }
  for (const s of sales) s.kalemler.sort((a, b) => a._n - b._n);
  return { urunler: data.urunler || [], musteriler: data.musteriler || [], alislar: data.alislar || [], satislar: sales, fireler: data.fireler || [], tahsilatlar: data.tahsilatlar || [] };
}
async function api(method, body) {
  const url = method === 'GET' ? `${cfg.api}?action=all&pin=${encodeURIComponent(cfg.pin)}&_=${Date.now()}` : cfg.api;
  const res = await fetch(url, method === 'GET' ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ ...body, pin: cfg.pin }) });
  if (!res.ok) throw Object.assign(new Error('http'), { net: true });
  let j; try { j = await res.json(); } catch (e) { throw Object.assign(new Error('Bağlantı adresi yanlış görünüyor'), { bad: true }); }
  return j;
}
function applyServer(j) {
  if (j.sheetUrl) { sheetUrl = j.sheetUrl; LS.set('sd_sheet', sheetUrl); }
  const fresh = fromServer(j.data || {});
  // Re-apply anything still waiting to be sent, so the screen never loses an entry the server has not seen yet.
  S = fresh; for (const op of outbox) applyLocal(op);
  lastSync = Date.now(); LS.set('sd_lastsync', lastSync);
  persist(); dirty = true;
}
let flushing = false;
async function flush() {
  if (flushing || !cfg.api) return;
  flushing = true; setSync('syncing');
  let posted = false;
  try {
    while (outbox.length) {
      posted = true;
      const op = outbox[0];
      const j = await api('POST', { action: op.action, payload: op.payload });
      if (!j.ok) {
        if (j.error === 'pin') { setSync('pin'); return; }
        if (j.error === 'busy') { await new Promise(r => setTimeout(r, 1500)); continue; }
        outbox.shift(); persist(); toast('Bir kayıt tabloya yazılamadı: ' + (j.message || j.error)); continue;
      }
      outbox.shift();
      applyServer(j);
    }
    if (!posted) { const j = await api('GET'); if (j.ok) applyServer(j); else if (j.error === 'pin') { setSync('pin'); return; } }
    setSync('idle');
  } catch (e) {
    setSync(e.bad ? 'error' : 'offline');
  } finally { flushing = false; render(); }
}
function setSync(s) { syncState = s; renderStatus(); }
function renderStatus() {
  const el = $('#sync'); if (!el) return;
  const n = outbox.length;
  const map = {
    idle: n ? ['wait', `${n} bekliyor`] : ['ok', 'Eşitlendi'],
    syncing: ['wait', 'Gönderiliyor…'],
    offline: ['off', n ? `Çevrimdışı · ${n}` : 'Çevrimdışı'],
    error: ['off', 'Bağlantı hatası'],
    pin: ['off', 'PIN yanlış'],
  };
  const [cls, txt] = map[syncState] || map.idle;
  el.className = 'sync ' + cls; el.textContent = txt;
  el.title = syncState === 'offline' && n ? `İnternet yok. ${n} kayıt telefonda bekliyor, bağlantı gelince tabloya yazılacak.` : txt;
}
// Optimistic local change, queued for the sheet; works offline.
function applyLocal(op) {
  const p = op.payload;
  if (op.action === 'upsert') { const arr = S[p.table]; const i = arr.findIndex(x => x.id === p.row.id); if (i >= 0) arr[i] = { ...arr[i], ...p.row }; else arr.push(p.row); }
  else if (op.action === 'delete') S[p.table] = S[p.table].filter(x => x.id !== p.id);
  else if (op.action === 'addSale') { if (!S.satislar.some(x => x.id === p.sale.id)) S.satislar.push(p.sale); }
  else if (op.action === 'deleteSale') S.satislar = S.satislar.filter(x => x.id !== p.id);
}
function queue(action, payload) {
  const op = { id: rid(), action, payload };
  outbox.push(op); applyLocal(op); dirty = true; persist(); render(); flush();
  return true;
}
const saveRow = (table, row) => queue('upsert', { table, row });
const delRow = (table, id) => queue('delete', { table, id });
window.addEventListener('online', flush);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') flush(); });
setInterval(() => { if (document.visibilityState === 'visible' && navigator.onLine !== false) flush(); }, 30000);

/* ============ DERIVED DATA ============ */
function compute() {
  if (!dirty && D) return D;
  const P = {}; for (const u of S.urunler) P[u.id] = { ...u, satisFiyati: +u.satisFiyati || 0, alinan: 0, satilan: 0, fire: 0, adetSatis: 0, ciro: 0, kar: 0, lots: [] };
  const L = {}; for (const a of S.alislar) { L[a.id] = { ...a, miktar: +a.miktar || 0, birimFiyat: +a.birimFiyat || 0, cikan: 0 }; if (P[a.urunId]) { P[a.urunId].lots.push(L[a.id]); P[a.urunId].alinan += +a.miktar || 0; } }
  const byTime = (a, b) => String(b.tarih || '').localeCompare(String(a.tarih || '')) || String(b.saat || '').localeCompare(String(a.saat || '')) || (b.ts || 0) - (a.ts || 0);
  const sales = [...S.satislar].sort(byTime), fires = [...S.fireler].sort(byTime), pays = [...S.tahsilatlar].sort(byTime);
  for (const s of sales) for (const k of (s.kalemler || [])) {
    const p = P[k.urunId]; const tut = (+k.miktar || 0) * (+k.birimFiyat || 0); const mal = (k.partiler || []).reduce((a, x) => a + (+x.miktar || 0) * (+x.birimMaliyet || 0), 0);
    if (p) { p.satilan += +k.miktar || 0; p.ciro += tut; p.kar += tut - mal; p.adetSatis++; }
    for (const x of (k.partiler || [])) if (L[x.alisId]) L[x.alisId].cikan += +x.miktar || 0;
  }
  for (const f of fires) { if (P[f.urunId]) P[f.urunId].fire += +f.miktar || 0; if (L[f.alisId]) L[f.alisId].cikan += +f.miktar || 0; }
  for (const id in L) L[id].kalan = r3(L[id].miktar - L[id].cikan);
  for (const id in P) {
    const p = P[id]; p.stok = r3(p.alinan - p.satilan - p.fire);
    p.lots.sort((a, b) => String(a.tarih || '').localeCompare(String(b.tarih || '')) || (a.ts || 0) - (b.ts || 0));
    let qn = 0, val = 0; for (const l of p.lots) { const k = Math.max(0, l.kalan); qn += k; val += k * l.birimFiyat; }
    const last = p.lots[p.lots.length - 1]; p.sonMaliyet = last ? last.birimFiyat : 0;
    p.maliyet = qn > 0 ? val / qn : p.sonMaliyet; p.stokDeger = val;
  }
  const C = {}; for (const c of S.musteriler) C[c.id] = { ...c, alisveris: 0, odenen: 0, tahsilat: 0, son: '', adet: 0 };
  for (const s of sales) { const c = C[s.musteriId]; if (!c) continue; c.alisveris += +s.toplam || 0; c.odenen += +s.odenen || 0; c.adet++; if (String(s.tarih || '') > c.son) c.son = s.tarih; }
  for (const p of pays) { const c = C[p.musteriId]; if (c) c.tahsilat += +p.tutar || 0; }
  for (const id in C) { const c = C[id]; c.borc = r2(c.alisveris - c.odenen - c.tahsilat); }
  D = { P, L, C, sales, fires, pays }; dirty = false; return D;
}
const saleCost = s => (s.kalemler || []).reduce((a, k) => a + (k.partiler || []).reduce((b, x) => b + (+x.miktar || 0) * (+x.birimMaliyet || 0), 0), 0);
function allocate(urunId, miktar, reserved) {
  const p = compute().P[urunId]; const parts = []; let rest = +miktar || 0;
  if (p) for (const l of p.lots) { if (rest <= 1e-9) break; const avail = l.kalan - (reserved[l.id] || 0); if (avail <= 1e-9) continue; const take = Math.min(avail, rest); parts.push({ alisId: l.id, lotNo: l.lotNo || '', miktar: r3(take), birimMaliyet: l.birimFiyat }); reserved[l.id] = (reserved[l.id] || 0) + take; rest -= take; }
  if (rest > 1e-9) parts.push({ alisId: '', lotNo: '', miktar: r3(rest), birimMaliyet: p ? p.sonMaliyet : 0 });
  return parts;
}

/* ============ RENDER ============ */
function setTab(t) { tab = t; q = ''; LS.set('sd_tab', t); closeSheet(); render(); window.scrollTo(0, 0); }
document.querySelectorAll('nav.tabs button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));

function render() {
  renderStatus();
  if (!cfg.api || !cfg.pin) { $('#app').innerHTML = setupHtml(); bindSetup(); $('#cartbar').hidden = true; $('#fab').hidden = true; document.body.classList.add('nosetup'); return; }
  document.body.classList.remove('nosetup');
  document.querySelectorAll('nav.tabs button').forEach(b => b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'));
  let banner = '';
  if (syncState === 'pin') banner = `<div class="banner err">PIN yanlış. Ayarlardan doğru PIN'i girin. <button class="btn sm alt" data-a="settings">Ayarlar</button></div>`;
  else if (syncState === 'error') banner = `<div class="banner err">Google Tablo bağlantı adresi çalışmıyor. Adresin /exec ile bittiğini ve dağıtımda erişimin "Herkes" olduğunu kontrol edin. <button class="btn sm alt" data-a="settings">Ayarlar</button></div>`;
  else if (syncState === 'offline' && outbox.length) banner = `<div class="banner">İnternet yok. ${outbox.length} kayıt telefonda bekliyor; bağlantı gelince Google Tabloya kendiliğinden yazılacak.</div>`;
  else if (!cfg.ad) banner = `<div class="banner">Satışlarda kimin sattığı görünsün diye adınızı girin. <button class="btn sm alt" data-a="settings">Adımı gir</button></div>`;
  else if (!lastSync && !S.urunler.length && syncState === 'syncing') banner = `<div class="banner">Google Tablodan kayıtlar alınıyor…</div>`;
  const fn = { satis: vSatis, gecmis: vGecmis, stok: vStok, musteri: vMusteri, rapor: vRapor }[tab] || vSatis;
  $('#app').innerHTML = `<div class="screen">${banner}${fn()}</div>`;
  renderBars(); bindSearch();
}
function renderBars() {
  const cb = $('#cartbar'), fab = $('#fab');
  if (tab === 'satis' && cart.length) { cb.hidden = false; cb.innerHTML = `<button data-a="checkout"><div><div class="c">${cart.length} ürün</div><div class="tot num">${tl(cartTotal())}</div></div><span class="go">Ödeme al →</span></button>`; }
  else cb.hidden = true;
  const fabs = { stok: stokSeg === 'fire' ? ['+ Fire kaydet', 'newFire'] : stokSeg === 'parti' ? ['+ Mal girişi', 'newLot'] : ['+ Yeni ürün', 'newProduct'], musteri: ['+ Yeni müşteri', 'newCustomer'] };
  if (fabs[tab]) { fab.hidden = false; fab.textContent = fabs[tab][0]; fab.dataset.a = fabs[tab][1]; } else fab.hidden = true;
}
function bindSearch() { const s = $('#q'); if (!s) return; s.oninput = () => { q = s.value; const area = $('#listArea'); if (area) area.innerHTML = ({ satis: tilesHtml, gecmis: gecmisList, stok: stokList, musteri: musteriList }[tab])(); }; }
const match = (...f) => !q || low(f.join(' ')).includes(low(q));
const searchBox = ph => `<input class="search" id="q" type="search" placeholder="${ph}" value="${esc(q)}" autocomplete="off">`;

/* ---- setup ---- */
function setupHtml() {
  return `<div class="screen"><div class="setup">
    <div class="logo big" aria-hidden="true">₺</div>
    <h2 style="margin:0">Google Tabloya bağlanın</h2>
    <p class="hint" style="font-size:14px;margin:0">Kayıtlar Google E-Tablonuzda tutulur. Tablodaki Apps Script'i yayınladığınızda verilen adresi ve PIN'i girin. Ortağınıza bağlantı linki gönderirseniz bu adımı atlayabilir.</p>
    <form id="setupF" style="display:grid;gap:12px">
      <div class="field"><label for="sApi">Bağlantı adresi</label><input id="sApi" inputmode="url" autocomplete="off" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(cfg.api)}"></div>
      <div class="two"><div class="field"><label for="sPin">PIN</label><input id="sPin" inputmode="numeric" autocomplete="off" value="${esc(cfg.pin)}"></div>
      <div class="field"><label for="sAd">Adınız</label><input id="sAd" autocomplete="name" placeholder="Satışlarda görünür" value="${esc(cfg.ad)}"></div></div>
      <button class="btn" type="submit" id="sBtn">Bağlan</button><span class="hint" id="sMsg"></span>
    </form></div></div>`;
}
function bindSetup() {
  $('#setupF').onsubmit = async e => {
    e.preventDefault();
    const api = $('#sApi').value.trim(), pin = $('#sPin').value.trim(), ad = $('#sAd').value.trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(api)) { $('#sMsg').textContent = 'Adres https://script.google.com/macros/s/ ile başlamalı ve /exec ile bitmeli.'; return; }
    if (!pin) { $('#sMsg').textContent = 'PIN girin.'; return; }
    $('#sBtn').disabled = true; $('#sMsg').textContent = 'Bağlanılıyor…';
    const old = cfg; cfg = { api, pin, ad };
    try { const j = await api_test(); if (!j.ok) { cfg = old; $('#sMsg').textContent = j.error === 'pin' ? 'PIN yanlış.' : 'Bağlanılamadı.'; $('#sBtn').disabled = false; return; }
      LS.set('sd_cfg', cfg); applyServer(j); setSync('idle'); closeSheet(); render(); toast('Google Tabloya bağlandı'); flush();
    } catch (err) { cfg = old; $('#sMsg').textContent = err.bad ? 'Bu adres bir Satış Defteri bağlantısı değil. Dağıtımın "Web uygulaması" ve erişimin "Herkes" olduğunu kontrol edin.' : 'Bağlanılamadı. İnterneti kontrol edin.'; $('#sBtn').disabled = false; }
  };
}
const api_test = () => api('GET');

/* ---- SATIŞ ---- */
const cartTotal = () => r2(cart.reduce((a, c) => a + (+c.miktar || 0) * (+c.birimFiyat || 0), 0));
function vSatis() {
  if (!S.urunler.length) return `<div class="empty"><b>Hoş geldiniz</b><span>Satışa başlamak için:</span><ol><li>Ürün ekleyin (kg veya adet, satış fiyatı)</li><li>Mal girişi yapın (alış fiyatı ve miktar, her giriş bir parti olur)</li><li>Bu ekrandan ürüne dokunup satış yapın</li></ol><button class="btn sm" data-a="newProduct">İlk ürünü ekle</button></div>`;
  return `${searchBox('Ürün ara')}<div id="listArea">${tilesHtml()}</div>`;
}
function tilesHtml() {
  const { P } = compute();
  const list = Object.values(P).filter(p => match(p.ad)).sort((a, b) => b.adetSatis - a.adetSatis || String(a.ad).localeCompare(String(b.ad), 'tr'));
  const inCart = {}; for (const c of cart) inCart[c.urunId] = (inCart[c.urunId] || 0) + (+c.miktar || 0);
  return `<div class="tiles">${list.map(p => `<button class="tile" data-a="pick" data-id="${esc(p.id)}">
    ${inCart[p.id] ? `<span class="incart num">${nf(inCart[p.id])}</span>` : ''}
    <span class="n">${esc(p.ad)}</span>
    <span class="s ${p.stok <= 0 ? 'out' : ''} num">${p.stok <= 0 ? 'Stok yok' : 'Stok ' + qty(p.stok, p.birim)}</span>
    <span class="p num">${tl(p.satisFiyati)} <small>/ ${U(p.birim)}</small></span></button>`).join('')}
    ${!q ? `<button class="tile add" data-a="newProduct">+ Ürün ekle</button>` : ''}</div>
    ${!list.length ? '<div class="empty">Bu isimde ürün yok.</div>' : ''}`;
}

/* ---- GEÇMİŞ ---- */
function vGecmis() {
  if (!compute().sales.length) return `<div class="empty"><b>Henüz satış yok</b><span>Satış ekranından yaptığınız her satış burada gün gün listelenir.</span></div>`;
  return `${searchBox('Müşteri, ürün veya parti no ara')}<div id="listArea">${gecmisList()}</div>`;
}
function saleItem(s) {
  const borc = r2((+s.toplam || 0) - (+s.odenen || 0));
  const urunler = (s.kalemler || []).map(k => `${k.urunAd} ${nf(k.miktar)} ${U(k.birim)}`).join(', ');
  return `<button class="it" data-a="sale" data-id="${esc(s.id)}"><div class="m"><div class="t">${esc(s.musteriAd || 'Peşin satış')}</div><div class="d">${esc(s.saat || '')} · ${esc(urunler)}${s.ekleyen ? ' · ' + esc(s.ekleyen) : ''}</div></div>
  <div class="r"><span class="t num">${tl(s.toplam)}</span>${borc > 0.009 ? `<span class="tag red num">${tl(borc)} veresiye</span>` : `<span class="tag grey">${esc(s.odemeSekli || '')}</span>`}</div></button>`;
}
function gecmisList() {
  const { sales } = compute();
  const list = sales.filter(s => match(s.musteriAd, (s.kalemler || []).map(k => k.urunAd + ' ' + (k.partiler || []).map(x => x.lotNo).join(' ')).join(' '), s.not, fmtDate(s.tarih), s.ekleyen)).slice(0, 400);
  if (!list.length) return '<div class="empty">Sonuç yok.</div>';
  const days = {}; for (const s of list) (days[s.tarih] = days[s.tarih] || []).push(s);
  return Object.keys(days).sort().reverse().map(d => {
    const arr = days[d]; const t = arr.reduce((a, s) => a + (+s.toplam || 0), 0);
    return `<div class="dayhead"><div>${dayTitle(d)}</div><span class="num">${arr.length} satış · ${tl(t)}</span></div><div class="list">${arr.map(saleItem).join('')}</div>`;
  }).join('');
}

/* ---- STOK ---- */
function vStok() {
  if (!S.urunler.length) return `<div class="empty"><b>Henüz ürün yok</b><span>Ürünü kg veya adet olarak ekleyin.</span><button class="btn sm" data-a="newProduct">Ürün ekle</button></div>`;
  const { P } = compute(); const deger = Object.values(P).reduce((a, p) => a + p.stokDeger, 0);
  return `<div class="stats"><div class="stat"><span class="lbl">Stok değeri (alış)</span><span class="v num">${tl(deger)}</span></div><div class="stat"><span class="lbl">Ürün</span><span class="v num">${S.urunler.length}</span></div></div>
  <div class="chips" role="group">${[['urun', 'Ürünler'], ['parti', 'Partiler'], ['fire', 'Fireler']].map(([k, l]) => `<button class="chip" data-a="seg" data-v="${k}" aria-pressed="${stokSeg === k}">${l}</button>`).join('')}</div>
  ${searchBox(stokSeg === 'urun' ? 'Ürün ara' : stokSeg === 'parti' ? 'Parti no, ürün veya tedarikçi ara' : 'Ürün veya sebep ara')}
  <div id="listArea">${stokList()}</div>`;
}
function stokList() {
  const { P, L, fires } = compute();
  if (stokSeg === 'urun') {
    const list = Object.values(P).filter(p => match(p.ad)).sort((a, b) => String(a.ad).localeCompare(String(b.ad), 'tr'));
    return `<div class="list">${list.map(p => {
      const m = p.satisFiyati > 0 && p.maliyet > 0 ? (p.satisFiyati - p.maliyet) / p.satisFiyati : null; const open = p.lots.filter(l => l.kalan > 1e-9).length;
      return `<button class="it" data-a="product" data-id="${esc(p.id)}"><div class="m"><div class="t">${esc(p.ad)}</div><div class="d num">Satış ${tl(p.satisFiyati)} · Maliyet ${p.maliyet ? tl(p.maliyet) : '-'}${m !== null ? ' · %' + Math.round(m * 100) + ' kâr' : ''}</div></div>
      <div class="r"><span class="t num ${p.stok <= 0 ? 'neg' : ''}">${qty(p.stok, p.birim)}</span><span class="tag ${open ? 'green' : 'grey'}">${open} açık parti</span></div></button>`;
    }).join('') || '<div class="it">Sonuç yok.</div>'}</div>`;
  }
  if (stokSeg === 'parti') {
    const list = Object.values(L).filter(l => match(l.lotNo, l.urunAd, l.tedarikci, fmtDate(l.tarih))).sort((a, b) => (a.kalan > 1e-9 ? 0 : 1) - (b.kalan > 1e-9 ? 0 : 1) || String(b.tarih || '').localeCompare(String(a.tarih || '')) || (b.ts || 0) - (a.ts || 0));
    if (!list.length) return `<div class="empty"><b>Parti yok</b><span>Her mal girişi bir parti olarak kaydedilir; satışta önce en eski parti kullanılır.</span><button class="btn sm" data-a="newLot">Mal girişi yap</button></div>`;
    return `<div class="list">${list.map(lotItem).join('')}</div>`;
  }
  const list = fires.filter(f => match(f.urunAd, f.sebep, f.lotNo));
  if (!list.length) return `<div class="empty"><b>Fire kaydı yok</b><span>Bozulan veya atılan malı buradan stoktan düşün; zarar raporda görünür.</span><button class="btn sm" data-a="newFire">Fire kaydet</button></div>`;
  return `<div class="list">${list.map(f => `<button class="it" data-a="fire" data-id="${esc(f.id)}"><div class="m"><div class="t">${esc(f.urunAd)} · ${esc(f.sebep || 'Fire')}</div><div class="d">${fmtDate(f.tarih)}${f.lotNo ? ' · Parti ' + esc(f.lotNo) : ''}${f.ekleyen ? ' · ' + esc(f.ekleyen) : ''}</div></div><div class="r"><span class="t num neg">−${qty(f.miktar, f.birim)}</span><span class="d num">${tl((+f.miktar || 0) * (+f.birimMaliyet || 0))} zarar</span></div></button>`).join('')}</div>`;
}
function lotItem(l) {
  const pct = l.miktar > 0 ? Math.max(0, Math.min(1, l.kalan / l.miktar)) : 0;
  return `<button class="it" data-a="lot" data-id="${esc(l.id)}"><div class="m"><div class="t">${esc(l.lotNo || 'Parti')} · ${esc(l.urunAd)}</div><div class="d">${fmtDate(l.tarih)}${l.tedarikci ? ' · ' + esc(l.tedarikci) : ''} · ${tl(l.birimFiyat)}/${U(l.birim)}${l.skt ? ' · SKT ' + fmtDate(l.skt) : ''}</div></div>
  <div class="r"><span class="t num">${qty(Math.max(0, l.kalan), l.birim)}</span>${l.kalan > 1e-9 ? `<span class="tag green num">%${Math.round(pct * 100)} kaldı</span>` : `<span class="tag grey">Bitti</span>`}</div></button>`;
}

/* ---- MÜŞTERİ ---- */
function vMusteri() {
  if (!S.musteriler.length) return `<div class="empty"><b>Henüz müşteri yok</b><span>Veresiye satış ve tahsilat için müşteri ekleyin. Peşin satışlarda müşteri seçmek gerekmez.</span><button class="btn sm" data-a="newCustomer">Müşteri ekle</button></div>`;
  const { C } = compute(); const alacak = Object.values(C).reduce((a, c) => a + Math.max(0, c.borc), 0); const borclu = Object.values(C).filter(c => c.borc > 0.009).length;
  return `<div class="stats"><div class="stat ${alacak > 0 ? 'red' : ''}"><span class="lbl">Toplam alacak</span><span class="v num">${tl(alacak)}</span></div><div class="stat"><span class="lbl">Borçlu müşteri</span><span class="v num">${borclu} / ${S.musteriler.length}</span></div></div>
  ${searchBox('Müşteri veya telefon ara')}<div id="listArea">${musteriList()}</div>`;
}
function musteriList() {
  const { C } = compute();
  const list = Object.values(C).filter(c => match(c.ad, c.telefon, c.not)).sort((a, b) => (b.borc > 0.009) - (a.borc > 0.009) || b.borc - a.borc || String(a.ad).localeCompare(String(b.ad), 'tr'));
  return `<div class="list">${list.map(c => `<button class="it" data-a="customer" data-id="${esc(c.id)}"><div class="av">${esc(initials(c.ad))}</div><div class="m"><div class="t">${esc(c.ad)}</div><div class="d num">${c.telefon ? esc(c.telefon) + ' · ' : ''}${c.adet} alışveriş${c.son ? ' · son ' + fmtDate(c.son) : ''}</div></div>
  <div class="r">${c.borc > 0.009 ? `<span class="tag red num">${tl(c.borc)}</span>` : `<span class="tag green">Borcu yok</span>`}</div></button>`).join('') || '<div class="it">Sonuç yok.</div>'}</div>`;
}

/* ---- RAPOR ---- */
function periodRange() {
  const t = today();
  if (period === 'bugun') return [t, t];
  if (period === 'hafta') { const x = new Date(); x.setDate(x.getDate() - (x.getDay() + 6) % 7); return [ymd(x), t]; }
  if (period === 'ay') return [t.slice(0, 8) + '01', t];
  if (period === 'yil') return [t.slice(0, 5) + '01-01', t];
  return ['0000', '9999'];
}
function vRapor() {
  const { P, C, sales, fires, pays } = compute(); const [a, b] = periodRange(); const inR = x => String(x.tarih) >= a && String(x.tarih) <= b;
  const ss = sales.filter(inR), ff = fires.filter(inR), pp = pays.filter(inR);
  const ciro = ss.reduce((t, s) => t + (+s.toplam || 0), 0), mal = ss.reduce((t, s) => t + saleCost(s), 0), brut = ciro - mal;
  const fireZ = ff.reduce((t, f) => t + (+f.miktar || 0) * (+f.birimMaliyet || 0), 0), net = brut - fireZ;
  const alacak = Object.values(C).reduce((t, c) => t + Math.max(0, c.borc), 0), stokD = Object.values(P).reduce((t, p) => t + p.stokDeger, 0);
  const kasa = {}; for (const s of ss) { if (+s.odenen > 0) { const k = s.odemeSekli === 'Veresiye' ? 'Nakit' : s.odemeSekli; kasa[k] = (kasa[k] || 0) + (+s.odenen || 0); } }
  for (const p of pp) kasa[p.sekil || 'Nakit'] = (kasa[p.sekil || 'Nakit'] || 0) + (+p.tutar || 0);
  const acilan = ss.reduce((t, s) => t + Math.max(0, (+s.toplam || 0) - (+s.odenen || 0)), 0), tahsil = pp.reduce((t, p) => t + (+p.tutar || 0), 0);
  const top = {}; for (const s of ss) for (const k of (s.kalemler || [])) { const x = top[k.urunId] || (top[k.urunId] = { ad: k.urunAd, birim: k.birim, m: 0, c: 0, k: 0 }); const t = (+k.miktar || 0) * (+k.birimFiyat || 0); x.m += +k.miktar || 0; x.c += t; x.k += t - (k.partiler || []).reduce((q2, y) => q2 + (+y.miktar || 0) * (+y.birimMaliyet || 0), 0); }
  const topL = Object.values(top).sort((x, y) => y.c - x.c).slice(0, 8); const mx = Math.max(1, ...topL.map(x => x.c));
  const kim = {}; for (const s of ss) { const k = s.ekleyen || 'Adsız'; kim[k] = kim[k] || { n: 0, c: 0 }; kim[k].n++; kim[k].c += +s.toplam || 0; }
  const kimL = Object.entries(kim);
  return `<div class="chips" role="group">${[['bugun', 'Bugün'], ['hafta', 'Bu hafta'], ['ay', 'Bu ay'], ['yil', 'Bu yıl'], ['hepsi', 'Tümü']].map(([k, l]) => `<button class="chip" data-a="period" data-v="${k}" aria-pressed="${period === k}">${l}</button>`).join('')}</div>
  <div class="stats">
    <div class="stat big"><span class="lbl">Ciro · ${ss.length} satış</span><span class="v num">${tl(ciro)}</span></div>
    <div class="stat"><span class="lbl">Brüt kâr</span><span class="v num ${brut < 0 ? 'neg' : 'pos'}">${tl(brut)}</span></div>
    <div class="stat"><span class="lbl">Fire zararı</span><span class="v num ${fireZ > 0 ? 'neg' : ''}">${fireZ > 0 ? '−' : ''}${tl(fireZ)}</span></div>
    <div class="stat"><span class="lbl">Net kâr</span><span class="v num ${net < 0 ? 'neg' : 'pos'}">${tl(net)}</span></div>
    <div class="stat"><span class="lbl">Kâr marjı</span><span class="v num">%${ciro > 0 ? nf(net / ciro * 100, 1) : '0'}</span></div>
  </div>
  <h2>Kasa</h2>
  <div class="list">${['Nakit', 'Kart', 'Havale'].map(k => `<div class="kv"><span>${k} giren</span><b class="num">${tl(kasa[k] || 0)}</b></div>`).join('')}
    <div class="kv"><span>Bu dönem verilen veresiye</span><b class="num neg">${tl(acilan)}</b></div>
    <div class="kv"><span>Bu dönem tahsil edilen</span><b class="num pos">${tl(tahsil)}</b></div></div>
  <div class="stats"><div class="stat ${alacak > 0 ? 'red' : ''}"><span class="lbl">Toplam alacak (bugün)</span><span class="v num">${tl(alacak)}</span></div><div class="stat"><span class="lbl">Stok değeri (bugün)</span><span class="v num">${tl(stokD)}</span></div></div>
  ${topL.length ? `<h2>En çok satanlar</h2><div class="list">${topL.map(x => `<div class="barrow"><div class="top"><b>${esc(x.ad)}</b><span class="num">${tl(x.c)}</span></div><div class="track"><div class="fill" style="width:${Math.round(x.c / mx * 100)}%"></div></div><div class="top" style="color:var(--muted);font-size:13px"><span class="num">${qty(x.m, x.birim)}</span><span class="num">kâr ${tl(x.k)}</span></div></div>`).join('')}</div>` : ''}
  ${kimL.length > 1 ? `<h2>Kim sattı</h2><div class="list">${kimL.map(([n, v]) => `<div class="kv"><span>${esc(n)}</span><b class="num">${v.n} satış · ${tl(v.c)}</b></div>`).join('')}</div>` : ''}
  ${sheetUrl ? `<a class="btn alt" href="${esc(sheetUrl)}" target="_blank" rel="noopener">Google Tabloyu aç</a>` : ''}`;
}

/* ============ SHEETS (bottom panels) ============ */
function openSheet(title, body, onMount) {
  $('#sheetRoot').innerHTML = `<div class="ov" id="ov"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="grab"></div><div class="sh"><h3>${esc(title)}</h3><button class="x" data-a="close" aria-label="Kapat">×</button></div>${body}</div></div>`;
  $('#ov').addEventListener('click', e => { if (e.target.id === 'ov') closeSheet(); });
  onMount && onMount($('#sheetRoot .sheet'));
}
function closeSheet() { $('#sheetRoot').innerHTML = ''; }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
function armDelete(btn, fn, label = 'Sil') { btn.addEventListener('click', () => { if (btn.dataset.armed) { fn(); return; } btn.dataset.armed = '1'; btn.textContent = 'Emin misiniz? Tekrar dokunun'; setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = label; } }, 3500); }); }
function segButtons(name, opts, val) { return `<div class="chips" data-seg="${name}">${opts.map(([k, l]) => `<button type="button" class="chip" data-v="${k}" aria-pressed="${k === val}">${l}</button>`).join('')}</div>`; }
function bindSeg(root, name, on) { const g = root.querySelector(`[data-seg="${name}"]`); g.querySelectorAll('button').forEach(b => b.onclick = () => { g.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b)); on && on(b.dataset.v); }); return () => g.querySelector('[aria-pressed="true"]')?.dataset.v; }

/* ---- settings ---- */
function openSettings() {
  const share = `${location.origin}${location.pathname}?api=${encodeURIComponent(cfg.api)}&pin=${encodeURIComponent(cfg.pin)}`;
  openSheet('Ayarlar', `
    <div class="list"><div class="kv"><span>Durum</span><span id="sync2"></span></div><div class="kv"><span>Son eşitleme</span><span class="num">${lastSync ? new Date(lastSync).toLocaleString('tr-TR') : '-'}</span></div><div class="kv"><span>Bekleyen kayıt</span><b class="num">${outbox.length}</b></div></div>
    <div class="row-btns"><button class="btn alt" type="button" id="syncNow">Şimdi eşitle</button>${sheetUrl ? `<a class="btn alt" href="${esc(sheetUrl)}" target="_blank" rel="noopener">Tabloyu aç</a>` : ''}</div>
    <div class="field"><label for="stAd">Adınız (satışlarda "kaydeden" olarak görünür)</label><input id="stAd" value="${esc(cfg.ad)}"></div>
    ${installEvt ? '<button class="btn" type="button" data-a="install">Uygulamayı telefona yükle</button>' : ''}
    <div class="field"><span class="lbl">Ortağınız için bağlantı linki</span><div class="hint">Bu linki açan kişi doğrudan bu tabloya bağlanır. İçinde PIN olduğu için sadece güvendiğiniz kişiye gönderin.</div>
      <div class="row-btns"><input class="search" id="shareL" readonly value="${esc(share)}" style="font-size:13px"><button class="btn alt sm" type="button" id="copyL">Kopyala</button></div></div>
    <details><summary class="lbl" style="cursor:pointer">Bağlantı adresi ve PIN</summary><div style="display:grid;gap:10px;margin-top:10px">
      <div class="field"><label for="stApi">Bağlantı adresi</label><input id="stApi" value="${esc(cfg.api)}"></div>
      <div class="field"><label for="stPin">PIN</label><input id="stPin" value="${esc(cfg.pin)}"></div></div></details>
    <button class="btn" type="button" id="stSave">Kaydet</button>`, () => {
    const s2 = $('#sync2'); const s1 = $('#sync'); if (s1 && s2) { s2.className = s1.className; s2.textContent = s1.textContent; }
    $('#syncNow').onclick = () => { closeSheet(); flush(); };
    $('#copyL').onclick = async () => { const i = $('#shareL'); try { await navigator.clipboard.writeText(i.value); toast('Link kopyalandı'); } catch (e) { i.select(); toast('Linki seçip kopyalayın'); } };
    $('#stSave').onclick = () => { cfg.ad = $('#stAd').value.trim(); const api = $('#stApi').value.trim(), pin = $('#stPin').value.trim(); const changed = api !== cfg.api || pin !== cfg.pin; cfg.api = api; cfg.pin = pin; LS.set('sd_cfg', cfg); closeSheet(); if (changed) { S = Object.assign({}, EMPTY); lastSync = 0; persist(); dirty = true; } render(); flush(); toast('Ayarlar kaydedildi'); };
  });
}

/* ---- keypad ---- */
function openPick(urunId, cartKey) {
  const p = compute().P[urunId]; if (!p) return;
  const existing = cartKey ? cart.find(c => c.key === cartKey) : null;
  let mode = 'm', str = existing ? numVal(existing.miktar) : '', price = existing ? +existing.birimFiyat : p.satisFiyati;
  const kg = p.birim === 'kg';
  const quick = kg ? ['0,25', '0,5', '1', '2'] : ['1', '2', '5', '10'];
  openSheet(p.ad, `
    <div class="chips" data-seg="mode"><button type="button" class="chip" data-v="m" aria-pressed="true">Miktar (${U(p.birim)})</button><button type="button" class="chip" data-v="t" aria-pressed="false">Tutar (₺)</button></div>
    <div class="disp"><div class="q num" id="kq"></div><div class="calc num" id="kc"></div></div>
    <div class="quick" id="kquick">${quick.map(v => `<button type="button" data-q="${v}">${v}${kg ? ' kg' : ''}</button>`).join('')}</div>
    <div class="keys">${['1', '2', '3', '4', '5', '6', '7', '8', '9', kg ? ',' : '', '0', '⌫'].map(k => k ? `<button type="button" data-k="${k}">${k}</button>` : '<span></span>').join('')}</div>
    <div class="row-btns"><button class="btn alt" type="button" id="kprice">Fiyat: <span class="num" id="kpv"></span></button></div>
    <div class="row-btns">${existing ? '<button class="btn warn" type="button" id="krm">Sepetten çıkar</button>' : ''}<button class="btn" type="button" id="kok">${existing ? 'Güncelle' : 'Sepete ekle'}</button></div>
    <span class="hint" id="kwarn"></span>`,
  root => {
    const getQty = () => { const v = parseNum(str); if (isNaN(v)) return 0; if (mode === 't') return price > 0 ? r3(v / price) : 0; return v; };
    const upd = () => {
      const m = getQty(); const tot = r2(m * price);
      $('#kq').innerHTML = `${esc(str || '0')} <small>${mode === 'm' ? U(p.birim) : '₺'}</small>`;
      $('#kc').innerHTML = mode === 'm' ? `${nf(m)} ${U(p.birim)} × ${tl(price)} = <b>${tl(tot)}</b>` : `${tl(parseNum(str) || 0)} ÷ ${tl(price)} = <b>${qty(m, p.birim)}</b>`;
      $('#kpv').textContent = `${tl(price)} / ${U(p.birim)}`;
      const inOther = cart.filter(c => c.urunId === urunId && c.key !== cartKey).reduce((a, c) => a + (+c.miktar || 0), 0);
      $('#kwarn').textContent = (m + inOther > p.stok + 1e-9) ? (p.stok > 0 ? `Stokta ${qty(p.stok, p.birim)} görünüyor. Yine de satabilirsiniz; eksik kısım son alış fiyatından maliyetlenir.` : `Bu ürün için stok görünmüyor. Mal girişi yapmadan satarsanız son alış fiyatı maliyet kabul edilir.`) : '';
      $('#kok').disabled = !(m > 0);
    };
    bindSeg(root, 'mode', v => { mode = v; str = ''; $('#kquick').hidden = v === 't'; upd(); });
    root.querySelectorAll('[data-k]').forEach(b => b.onclick = () => {
      const k = b.dataset.k;
      if (k === '⌫') str = str.slice(0, -1);
      else if (k === ',') { if (!str.includes(',')) str = (str || '0') + ','; }
      else { const dec = str.split(',')[1]; if (dec !== undefined && dec.length >= (mode === 't' ? 2 : 3)) return; if (str === '0') str = k; else if (str.length < 9) str += k; }
      upd();
    });
    root.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { str = b.dataset.q; upd(); });
    $('#kprice').onclick = () => { const area = $('#kprice').parentElement; area.innerHTML = `<div class="field" style="flex:1"><label for="kpin">Bu satış için fiyat (TL / ${U(p.birim)})</label><input id="kpin" inputmode="decimal" value="${numVal(price)}"></div>`; const i = $('#kpin'); i.focus(); i.select(); i.oninput = () => { const v = parseNum(i.value); if (v >= 0) { price = v; upd(); } }; };
    if (existing) $('#krm').onclick = () => { cart = cart.filter(c => c.key !== cartKey); saveCart(); closeSheet(); render(); if (cart.length) openCheckout(); };
    $('#kok').onclick = () => {
      const m = getQty(); if (!(m > 0)) return;
      if (existing) { existing.miktar = r3(m); existing.birimFiyat = price; } else cart.push({ key: rid(), urunId, miktar: r3(m), birimFiyat: price });
      saveCart(); closeSheet(); render(); if (existing) openCheckout(); else toast(`${p.ad} sepete eklendi`);
    };
    upd();
  });
}

/* ---- checkout ---- */
let co = { musteriId: '', sekil: 'Nakit', pesinat: '', tarih: '', not: '' };
function openCheckout() {
  const { P, C } = compute(); cart = cart.filter(c => P[c.urunId]); saveCart(); if (!cart.length) { closeSheet(); render(); return; }
  const total = cartTotal(); if (!co.tarih) co.tarih = today();
  const recent = Object.values(C).sort((a, b) => String(b.son || '').localeCompare(String(a.son || '')) || String(a.ad).localeCompare(String(b.ad), 'tr')).slice(0, 6);
  if (co.musteriId && C[co.musteriId] && !recent.find(c => c.id === co.musteriId)) recent.unshift(C[co.musteriId]);
  openSheet('Ödeme', `
    <div class="list">${cart.map(c => { const p = P[c.urunId]; return `<button class="it" data-a="editLine" data-id="${c.key}"><div class="m"><div class="t">${esc(p.ad)}</div><div class="d num">${qty(c.miktar, p.birim)} × ${tl(c.birimFiyat)}</div></div><div class="r"><span class="t num">${tl((+c.miktar) * (+c.birimFiyat))}</span></div></button>`; }).join('')}
      <div class="kv" style="font-size:18px"><b>Toplam</b><b class="num">${tl(total)}</b></div></div>
    <div class="field"><span class="lbl">Müşteri</span><div class="chips"><button type="button" class="chip" data-cust="" aria-pressed="${!co.musteriId}">Peşin müşteri</button>${recent.map(c => `<button type="button" class="chip" data-cust="${esc(c.id)}" aria-pressed="${co.musteriId === c.id}">${esc(c.ad)}${c.borc > 0.009 ? ' · borç ' + tl(c.borc) : ''}</button>`).join('')}<button type="button" class="chip" data-a="custPick">Diğer / yeni…</button></div></div>
    <div class="field"><span class="lbl">Ödeme</span><div class="pay">${['Nakit', 'Kart', 'Havale', 'Veresiye'].map(k => `<button type="button" class="${k === 'Veresiye' ? 'ver' : ''}" data-pay="${k}" aria-pressed="${co.sekil === k}">${k}</button>`).join('')}</div></div>
    <div id="verBox" ${co.sekil === 'Veresiye' ? '' : 'hidden'} class="field"><label for="pes">Şimdi ödenen (peşinat, TL)</label><input id="pes" inputmode="decimal" placeholder="0" value="${esc(co.pesinat)}"><span class="hint" id="verHint"></span></div>
    <details><summary class="lbl" style="cursor:pointer">Tarih ve not</summary><div class="two" style="margin-top:8px"><div class="field"><label for="cot">Tarih</label><input id="cot" type="date" value="${co.tarih}"></div><div class="field"><label for="con">Not</label><input id="con" value="${esc(co.not)}"></div></div></details>
    <div class="row-btns"><button class="btn alt" type="button" data-a="clearCart">Sepeti boşalt</button><button class="btn yellow" type="button" id="finish" style="flex:2;white-space:nowrap">Tamamla · <span class="num">${tl(total)}</span></button></div>`,
  root => {
    const vh = () => { const h = $('#verHint'); if (!h) return; const pes = parseNum(co.pesinat) || 0; h.textContent = co.musteriId ? `${tl(Math.max(0, total - pes))} müşterinin borcuna yazılacak.` : 'Veresiye için bir müşteri seçin.'; };
    root.querySelectorAll('[data-cust]').forEach(b => b.onclick = () => { co.musteriId = b.dataset.cust; root.querySelectorAll('[data-cust]').forEach(x => x.setAttribute('aria-pressed', x === b)); vh(); });
    root.querySelectorAll('[data-pay]').forEach(b => b.onclick = () => { co.sekil = b.dataset.pay; root.querySelectorAll('[data-pay]').forEach(x => x.setAttribute('aria-pressed', x === b)); $('#verBox').hidden = co.sekil !== 'Veresiye'; vh(); });
    $('#pes').oninput = e => { co.pesinat = e.target.value; vh(); };
    $('#cot').onchange = e => { co.tarih = e.target.value || today(); };
    $('#con').oninput = e => { co.not = e.target.value; };
    vh();
    $('#finish').onclick = () => {
      if (co.sekil === 'Veresiye' && !co.musteriId) { toast('Veresiye için müşteri seçin'); return; }
      const pes = co.sekil === 'Veresiye' ? (parseNum(co.pesinat) || 0) : total;
      if (pes < 0 || pes > total + 0.009) { toast('Peşinat tutarını kontrol edin'); return; }
      const reserved = {};
      const kalemler = cart.map(c => { const p = P[c.urunId]; return { urunId: p.id, urunAd: p.ad, birim: p.birim, miktar: +c.miktar, birimFiyat: +c.birimFiyat, partiler: allocate(p.id, +c.miktar, reserved) }; });
      const c = C[co.musteriId];
      const sale = { id: rid(), tarih: co.tarih || today(), saat: nowTime(), musteriId: c?.id || '', musteriAd: c?.ad || '', kalemler, toplam: total, odenen: r2(pes), odemeSekli: co.sekil, not: co.not.trim(), ekleyen: cfg.ad || '', ts: Date.now() };
      sale.maliyet = r2(saleCost(sale)); sale.kar = r2(total - sale.maliyet); sale.kalan = r2(total - sale.odenen);
      queue('addSale', { sale });
      cart = []; saveCart(); co = { musteriId: '', sekil: 'Nakit', pesinat: '', tarih: '', not: '' }; closeSheet(); render(); toast(`Satış kaydedildi · ${tl(total)}`);
    };
  });
}
function openCustPick() {
  const { C } = compute(); const all = Object.values(C).sort((a, b) => String(a.ad).localeCompare(String(b.ad), 'tr'));
  openSheet('Müşteri seç', `<input class="search" id="cq" type="search" placeholder="Ara"><div class="list" id="cl"></div><button class="btn alt" type="button" data-a="newCustomerCo">+ Yeni müşteri ekle</button>`, () => {
    const draw = () => { const v = low($('#cq').value); $('#cl').innerHTML = all.filter(c => !v || low(c.ad + ' ' + (c.telefon || '')).includes(v)).map(c => `<button class="it" data-pickc="${esc(c.id)}"><div class="av">${esc(initials(c.ad))}</div><div class="m"><div class="t">${esc(c.ad)}</div><div class="d">${esc(c.telefon || '')}</div></div>${c.borc > 0.009 ? `<span class="tag red num">${tl(c.borc)}</span>` : ''}</button>`).join('') || '<div class="it">Müşteri yok</div>';
      document.querySelectorAll('[data-pickc]').forEach(b => b.onclick = () => { co.musteriId = b.dataset.pickc; openCheckout(); }); };
    $('#cq').oninput = draw; draw();
  });
}

/* ---- sale detail ---- */
function openSale(id) {
  const s = compute().sales.find(x => x.id === id); if (!s) return;
  const mal = saleCost(s), borc = r2((+s.toplam || 0) - (+s.odenen || 0));
  openSheet(`${dayTitle(s.tarih)} · ${s.saat || ''}`, `
    <div class="list">${(s.kalemler || []).map(k => `<div class="kv" style="display:grid;gap:4px"><div style="display:flex;justify-content:space-between;gap:10px"><b>${esc(k.urunAd)}</b><b class="num">${tl((+k.miktar) * (+k.birimFiyat))}</b></div>
      <div class="num" style="color:var(--muted);font-size:13px">${qty(k.miktar, k.birim)} × ${tl(k.birimFiyat)}</div>
      ${(k.partiler || []).map(x => `<div class="num" style="color:var(--muted);font-size:13px">↳ ${x.lotNo ? 'Parti ' + esc(x.lotNo) : '<span class="neg">Partisiz (stok yoktu)</span>'}: ${qty(x.miktar, k.birim)} · maliyet ${tl(x.birimMaliyet)}</div>`).join('')}</div>`).join('')}</div>
    <div class="list">
      <div class="kv"><span>Müşteri</span><b>${esc(s.musteriAd || 'Peşin müşteri')}</b></div>
      <div class="kv"><span>Toplam</span><b class="num">${tl(s.toplam)}</b></div>
      <div class="kv"><span>Maliyet</span><span class="num">${tl(mal)}</span></div>
      <div class="kv"><span>Kâr</span><b class="num ${s.toplam - mal < 0 ? 'neg' : 'pos'}">${tl(s.toplam - mal)}</b></div>
      <div class="kv"><span>Ödeme</span><span>${esc(s.odemeSekli)} · <span class="num">${tl(s.odenen)}</span></span></div>
      ${borc > 0.009 ? `<div class="kv"><span>Veresiyeye yazılan</span><b class="num neg">${tl(borc)}</b></div>` : ''}
      ${s.ekleyen ? `<div class="kv"><span>Kaydeden</span><span>${esc(s.ekleyen)}</span></div>` : ''}
      ${s.not ? `<div class="kv"><span>Not</span><span>${esc(s.not)}</span></div>` : ''}
    </div>
    <button class="btn warn" type="button" id="del">Satışı sil (stok geri döner)</button>`,
  () => armDelete($('#del'), () => { queue('deleteSale', { id }); closeSheet(); toast('Satış silindi'); }, 'Satışı sil (stok geri döner)'));
}

/* ---- product ---- */
function openProductForm(id) {
  const u = id ? S.urunler.find(x => x.id === id) : null;
  openSheet(u ? 'Ürünü düzenle' : 'Yeni ürün', `<form id="f" style="display:grid;gap:12px">
    <div class="field"><label for="pad">Ürün adı</label><input id="pad" value="${esc(u?.ad)}" placeholder="Örn. Beyaz peynir" required></div>
    <div class="field"><span class="lbl">Satış birimi</span>${segButtons('birim', [['kg', 'Kilogram (kg)'], ['adet', 'Adet']], u?.birim || 'kg')}</div>
    <div class="field"><label for="pfy" id="pfl">Satış fiyatı (TL / ${U(u?.birim || 'kg')})</label><input id="pfy" inputmode="decimal" value="${numVal(u?.satisFiyati)}" placeholder="0,00"><span class="hint">Satışta bu fiyat gelir; istediğiniz satışta değiştirebilirsiniz.</span></div>
    <div class="row-btns">${u ? '<button type="button" class="btn warn" id="del">Sil</button>' : ''}<button class="btn" type="submit">Kaydet</button></div></form>`,
  root => {
    const gb = bindSeg(root, 'birim', v => { $('#pfl').textContent = `Satış fiyatı (TL / ${U(v)})`; });
    if (u) armDelete($('#del'), () => { if (S.alislar.some(a => a.urunId === u.id)) { toast('Bu ürünün partileri var; önce partileri silin'); return; } delRow('urunler', u.id); closeSheet(); toast('Ürün silindi'); });
    $('#f').onsubmit = e => {
      e.preventDefault(); const ad = $('#pad').value.trim(); const f = parseNum($('#pfy').value);
      if (!ad) { toast('Ürün adını yazın'); return; } if (S.urunler.some(x => x.id !== id && low(x.ad) === low(ad))) { toast('Bu isimde ürün var'); return; }
      if (u && u.birim !== gb() && S.alislar.some(a => a.urunId === u.id)) { toast('Partisi olan ürünün birimi değiştirilemez'); return; }
      saveRow('urunler', { id: u?.id || rid(), ad, birim: gb(), satisFiyati: isNaN(f) ? 0 : f, ts: u?.ts || Date.now() }); closeSheet(); toast(u ? 'Ürün güncellendi' : 'Ürün eklendi');
    };
  });
}
function openProduct(id) {
  const p = compute().P[id]; if (!p) return;
  openSheet(p.ad, `
    <div class="stats"><div class="stat"><span class="lbl">Stok</span><span class="v num ${p.stok <= 0 ? 'neg' : ''}">${qty(p.stok, p.birim)}</span></div><div class="stat"><span class="lbl">Satış fiyatı</span><span class="v num">${tl(p.satisFiyati)}</span></div>
    <div class="stat"><span class="lbl">Ort. maliyet (eldeki)</span><span class="v num">${tl(p.maliyet)}</span></div><div class="stat"><span class="lbl">Toplam kâr</span><span class="v num pos">${tl(p.kar)}</span></div></div>
    <div class="row-btns"><button class="btn" type="button" data-a="newLot" data-id="${esc(p.id)}">+ Mal girişi</button><button class="btn alt" type="button" data-a="newFire" data-id="${esc(p.id)}">Fire</button><button class="btn alt" type="button" data-a="editProduct" data-id="${esc(p.id)}">Düzenle</button></div>
    <h2>Partiler</h2>${p.lots.length ? `<div class="list">${[...p.lots].reverse().map(lotItem).join('')}</div>` : '<div class="empty">Henüz mal girişi yok.</div>'}
    <div class="hint">Satılan: ${qty(p.satilan, p.birim)} · Fire: ${qty(p.fire, p.birim)} · Alınan: ${qty(p.alinan, p.birim)}</div>`);
}

/* ---- lot ---- */
function nextLotNo(date) { const base = 'P' + date.slice(2).replace(/-/g, ''); const n = S.alislar.filter(a => String(a.lotNo || '').startsWith(base)).length + 1; return `${base}-${n}`; }
function openLotForm(id, urunId) {
  if (!S.urunler.length) { toast('Önce ürün ekleyin'); openProductForm(); return; }
  const { L } = compute(); const a = id ? L[id] : null; const sel = a?.urunId || urunId || '';
  const ted = [...new Set(S.alislar.map(x => x.tedarikci).filter(Boolean))];
  openSheet(a ? 'Partiyi düzenle' : 'Mal girişi', `<form id="f" style="display:grid;gap:12px">
    <div class="field"><label for="lu">Ürün</label><select id="lu" ${a ? 'disabled' : ''}><option value="">Ürün seçin</option>${[...S.urunler].sort((x, y) => String(x.ad).localeCompare(String(y.ad), 'tr')).map(u => `<option value="${esc(u.id)}" ${u.id === sel ? 'selected' : ''}>${esc(u.ad)} (${U(u.birim)})</option>`).join('')}</select></div>
    <div class="two"><div class="field"><label for="lm" id="lml">Miktar</label><input id="lm" inputmode="decimal" value="${numVal(a?.miktar)}"></div><div class="field"><label for="lf" id="lfl">Alış fiyatı</label><input id="lf" inputmode="decimal" value="${numVal(a?.birimFiyat)}"></div></div>
    <div class="list"><div class="kv"><span>Toplam maliyet</span><b class="num" id="ltot">${tl(0)}</b></div></div>
    <div class="two"><div class="field"><label for="ld">Tarih</label><input id="ld" type="date" value="${a?.tarih || today()}"></div><div class="field"><label for="lt">Tedarikçi</label><input id="lt" list="tedl" value="${esc(a?.tedarikci)}"><datalist id="tedl">${ted.map(t => `<option value="${esc(t)}">`).join('')}</datalist></div></div>
    <div class="two"><div class="field"><label for="ln">Parti no</label><input id="ln" value="${esc(a?.lotNo || nextLotNo(today()))}"><span class="hint">Otomatik verilir; üreticinin parti numarasını da yazabilirsiniz.</span></div><div class="field"><label for="ls">Son kullanma (isteğe bağlı)</label><input id="ls" type="date" value="${esc(a?.skt || '')}"></div></div>
    ${a ? `<div class="hint">Bu partiden ${qty(a.cikan, a.birim)} satıldı veya fire oldu.</div>` : ''}
    <div class="row-btns">${a ? '<button type="button" class="btn warn" id="del">Sil</button>' : ''}<button class="btn" type="submit">Kaydet</button></div></form>`,
  () => {
    const upd = () => { const u = S.urunler.find(x => x.id === $('#lu').value); const b = u?.birim || 'kg'; $('#lml').textContent = `Miktar (${U(b)})`; $('#lfl').textContent = `Alış fiyatı (TL / ${U(b)})`; $('#ltot').textContent = tl((parseNum($('#lm').value) || 0) * (parseNum($('#lf').value) || 0)); };
    ['lu', 'lm', 'lf'].forEach(i => $('#' + i).addEventListener('input', upd)); upd();
    $('#ld').addEventListener('change', () => { if (!a) $('#ln').value = nextLotNo($('#ld').value || today()); });
    if (a) armDelete($('#del'), () => { if (a.cikan > 1e-9) { toast('Bu partiden satış/fire var; silinemez'); return; } delRow('alislar', a.id); closeSheet(); toast('Parti silindi'); });
    $('#f').onsubmit = e => {
      e.preventDefault();
      const u = S.urunler.find(x => x.id === (a ? a.urunId : $('#lu').value)); const m = parseNum($('#lm').value), f = parseNum($('#lf').value);
      if (!u) { toast('Ürün seçin'); return; } if (!(m > 0)) { toast('Miktarı yazın'); return; } if (!(f >= 0)) { toast('Alış fiyatını yazın'); return; }
      if (a && m < a.cikan - 1e-9) { toast(`En az ${qty(a.cikan, a.birim)} olmalı (çıkan miktar)`); return; }
      const lotNo = $('#ln').value.trim() || nextLotNo($('#ld').value || today());
      if (S.alislar.some(x => x.id !== id && x.lotNo === lotNo)) { toast('Bu parti no kullanılmış'); return; }
      saveRow('alislar', { id: a?.id || rid(), tarih: $('#ld').value || today(), urunId: u.id, urunAd: u.ad, birim: u.birim, miktar: m, birimFiyat: f, toplam: r2(m * f), tedarikci: $('#lt').value.trim(), lotNo, skt: $('#ls').value || '', ekleyen: a?.ekleyen || cfg.ad || '', ts: a?.ts || Date.now() });
      closeSheet(); toast(a ? 'Parti güncellendi' : `Mal girişi kaydedildi · ${lotNo}`);
    };
  });
}
function openLot(id) {
  const { L, sales, fires } = compute(); const l = L[id]; if (!l) return;
  const used = [];
  for (const s of sales) for (const k of (s.kalemler || [])) for (const x of (k.partiler || [])) if (x.alisId === id) used.push({ t: s.tarih, s: s.saat || '', who: s.musteriAd || 'Peşin', m: x.miktar, b: k.birim });
  for (const f of fires) if (f.alisId === id) used.push({ t: f.tarih, s: '', who: 'Fire · ' + (f.sebep || ''), m: f.miktar, b: f.birim, fire: true });
  openSheet(`Parti ${l.lotNo || ''}`, `
    <div class="list"><div class="kv"><span>Ürün</span><b>${esc(l.urunAd)}</b></div><div class="kv"><span>Giriş</span><span class="num">${fmtDate(l.tarih)} · ${qty(l.miktar, l.birim)}</span></div>
    <div class="kv"><span>Alış fiyatı</span><span class="num">${tl(l.birimFiyat)} / ${U(l.birim)}</span></div><div class="kv"><span>Kalan</span><b class="num">${qty(Math.max(0, l.kalan), l.birim)}</b></div>
    ${l.tedarikci ? `<div class="kv"><span>Tedarikçi</span><span>${esc(l.tedarikci)}</span></div>` : ''}${l.skt ? `<div class="kv"><span>Son kullanma</span><span>${fmtDate(l.skt)}</span></div>` : ''}
    ${l.ekleyen ? `<div class="kv"><span>Kaydeden</span><span>${esc(l.ekleyen)}</span></div>` : ''}</div>
    <div class="row-btns"><button class="btn alt" type="button" data-a="editLot" data-id="${esc(l.id)}">Düzenle</button><button class="btn alt" type="button" data-a="newFire" data-id="${esc(l.urunId)}" data-lot="${esc(l.id)}">Fire düş</button></div>
    <h2>Bu partiden çıkanlar</h2>${used.length ? `<div class="list">${used.sort((a, b) => (String(b.t) + b.s).localeCompare(String(a.t) + a.s)).map(u => `<div class="it"><div class="m"><div class="t">${esc(u.who)}</div><div class="d">${fmtDate(u.t)} ${esc(u.s)}</div></div><div class="r"><span class="t num ${u.fire ? 'neg' : ''}">${qty(u.m, u.b)}</span></div></div>`).join('')}</div>` : '<div class="empty">Henüz çıkış yok.</div>'}`);
}

/* ---- fire ---- */
function openFireForm(urunId, lotId) {
  const { P } = compute(); if (!S.urunler.length) { toast('Önce ürün ekleyin'); return; }
  openSheet('Fire kaydet', `<form id="f" style="display:grid;gap:12px">
    <div class="field"><label for="fu">Ürün</label><select id="fu"><option value="">Ürün seçin</option>${[...S.urunler].sort((x, y) => String(x.ad).localeCompare(String(y.ad), 'tr')).map(u => `<option value="${esc(u.id)}" ${u.id === urunId ? 'selected' : ''}>${esc(u.ad)} · stok ${qty(P[u.id].stok, u.birim)}</option>`).join('')}</select></div>
    <div class="field"><label for="fl">Parti</label><select id="fl"></select></div>
    <div class="two"><div class="field"><label for="fm" id="fml">Miktar</label><input id="fm" inputmode="decimal"></div><div class="field"><label for="fd">Tarih</label><input id="fd" type="date" value="${today()}"></div></div>
    <div class="field"><span class="lbl">Sebep</span>${segButtons('sebep', [['Bozuldu', 'Bozuldu'], ['SKT geçti', 'SKT geçti'], ['Hasarlı', 'Hasarlı'], ['Tartı farkı', 'Tartı farkı'], ['Diğer', 'Diğer']], 'Bozuldu')}</div>
    <div class="list"><div class="kv"><span>Zarar (alış fiyatıyla)</span><b class="num neg" id="fz">${tl(0)}</b></div></div>
    <button class="btn" type="submit">Fireyi kaydet</button></form>`,
  root => {
    const gs = bindSeg(root, 'sebep');
    const upd = () => { const l = compute().L[$('#fl').value]; $('#fz').textContent = tl((parseNum($('#fm').value) || 0) * (l ? l.birimFiyat : (P[$('#fu').value]?.sonMaliyet || 0))); };
    const fillLots = () => { const p = P[$('#fu').value]; const open = p ? p.lots.filter(l => l.kalan > 1e-9) : []; $('#fl').innerHTML = open.length ? open.map(l => `<option value="${esc(l.id)}" ${l.id === lotId ? 'selected' : ''}>${esc(l.lotNo || 'Parti')} · ${fmtDate(l.tarih)} · kalan ${qty(l.kalan, l.birim)}</option>`).join('') : '<option value="">Açık parti yok</option>'; $('#fml').textContent = `Miktar (${U(p?.birim || 'kg')})`; upd(); };
    $('#fu').onchange = fillLots; $('#fl').onchange = upd; $('#fm').oninput = upd; fillLots();
    $('#f').onsubmit = e => {
      e.preventDefault(); const p = P[$('#fu').value]; const m = parseNum($('#fm').value); const l = compute().L[$('#fl').value];
      if (!p) { toast('Ürün seçin'); return; } if (!(m > 0)) { toast('Miktarı yazın'); return; }
      if (l && m > l.kalan + 1e-9) { toast(`Bu partide ${qty(l.kalan, l.birim)} kaldı`); return; }
      const bm = l ? l.birimFiyat : p.sonMaliyet;
      saveRow('fireler', { id: rid(), tarih: $('#fd').value || today(), urunId: p.id, urunAd: p.ad, birim: p.birim, alisId: l?.id || '', lotNo: l?.lotNo || '', miktar: m, birimMaliyet: bm, zarar: r2(m * bm), sebep: gs(), ekleyen: cfg.ad || '', ts: Date.now() });
      closeSheet(); toast('Fire kaydedildi, stoktan düşüldü');
    };
  });
}
function openFire(id) {
  const f = compute().fires.find(x => x.id === id); if (!f) return;
  openSheet('Fire', `<div class="list"><div class="kv"><span>Ürün</span><b>${esc(f.urunAd)}</b></div><div class="kv"><span>Miktar</span><span class="num">${qty(f.miktar, f.birim)}</span></div><div class="kv"><span>Parti</span><span>${esc(f.lotNo || '-')}</span></div><div class="kv"><span>Sebep</span><span>${esc(f.sebep)}</span></div><div class="kv"><span>Tarih</span><span>${fmtDate(f.tarih)}</span></div><div class="kv"><span>Zarar</span><b class="num neg">${tl((+f.miktar) * (+f.birimMaliyet))}</b></div></div>
  <button class="btn warn" type="button" id="del">Fireyi sil (stok geri döner)</button>`, () => armDelete($('#del'), () => { delRow('fireler', id); closeSheet(); toast('Fire silindi'); }, 'Fireyi sil (stok geri döner)'));
}

/* ---- customer ---- */
function openCustomerForm(id, back) {
  const c = id ? S.musteriler.find(x => x.id === id) : null;
  openSheet(c ? 'Müşteriyi düzenle' : 'Yeni müşteri', `<form id="f" style="display:grid;gap:12px">
    <div class="field"><label for="ca">Ad soyad / işletme</label><input id="ca" value="${esc(c?.ad)}" required></div>
    <div class="field"><label for="ct">Telefon</label><input id="ct" type="tel" inputmode="tel" value="${esc(c?.telefon)}" placeholder="05xx xxx xx xx"></div>
    <div class="field"><label for="cn">Not</label><input id="cn" value="${esc(c?.not)}" placeholder="Adres, özel fiyat…"></div>
    <div class="row-btns">${c ? '<button type="button" class="btn warn" id="del">Sil</button>' : ''}<button class="btn" type="submit">Kaydet</button></div></form>`,
  () => {
    if (c) armDelete($('#del'), () => { const x = compute().C[c.id]; if (x && Math.abs(x.borc) > 0.009) { toast('Borcu olan müşteri silinemez'); return; } delRow('musteriler', c.id); closeSheet(); toast('Müşteri silindi'); });
    $('#f').onsubmit = e => {
      e.preventDefault(); const ad = $('#ca').value.trim(); if (!ad) { toast('Adı yazın'); return; }
      const nid = c?.id || rid();
      saveRow('musteriler', { id: nid, ad, telefon: $('#ct').value.trim(), not: $('#cn').value.trim(), ts: c?.ts || Date.now() });
      toast(c ? 'Müşteri güncellendi' : 'Müşteri eklendi');
      if (back === 'co') { co.musteriId = nid; openCheckout(); } else closeSheet();
    };
  });
}
function openCustomer(id) {
  const { C, sales, pays } = compute(); const c = C[id]; if (!c) return;
  const hist = [...sales.filter(s => s.musteriId === id).map(s => ({ ...s, _k: 's' })), ...pays.filter(p => p.musteriId === id).map(p => ({ ...p, _k: 'p' }))].sort((a, b) => String(b.tarih || '').localeCompare(String(a.tarih || '')) || (b.ts || 0) - (a.ts || 0)).slice(0, 60);
  openSheet(c.ad, `
    ${c.telefon ? `<div class="num" style="font-size:15px;user-select:all">${esc(c.telefon)}</div>` : ''}${c.not ? `<div class="hint">${esc(c.not)}</div>` : ''}
    <div class="stats"><div class="stat ${c.borc > 0.009 ? 'red' : ''}"><span class="lbl">Kalan borç</span><span class="v num">${tl(c.borc)}</span></div><div class="stat"><span class="lbl">Toplam alışveriş</span><span class="v num">${tl(c.alisveris)}</span></div></div>
    <div class="row-btns"><button class="btn" type="button" data-a="pay" data-id="${esc(id)}" ${c.borc > 0.009 ? '' : 'disabled'}>Tahsilat al</button><button class="btn alt" type="button" data-a="sellTo" data-id="${esc(id)}">Satış yap</button><button class="btn alt" type="button" data-a="editCustomer" data-id="${esc(id)}">Düzenle</button></div>
    <h2>Hareketler</h2>${hist.length ? `<div class="list">${hist.map(h => h._k === 's' ? saleItem(h) : `<button class="it" data-a="payDetail" data-id="${esc(h.id)}"><div class="m"><div class="t">Tahsilat · ${esc(h.sekil)}</div><div class="d">${fmtDate(h.tarih)}${h.not ? ' · ' + esc(h.not) : ''}${h.ekleyen ? ' · ' + esc(h.ekleyen) : ''}</div></div><div class="r"><span class="t num pos">−${tl(h.tutar)}</span></div></button>`).join('')}</div>` : '<div class="empty">Henüz hareket yok.</div>'}`);
}
function openPay(custId) {
  const c = compute().C[custId]; if (!c) return;
  openSheet('Tahsilat al', `<form id="f" style="display:grid;gap:12px">
    <div class="list"><div class="kv"><span>${esc(c.ad)}</span><b class="num neg">Borç ${tl(c.borc)}</b></div></div>
    <div class="field"><label for="pt">Alınan tutar (TL)</label><input id="pt" inputmode="decimal" value="${numVal(c.borc)}"></div>
    <div class="field"><span class="lbl">Ödeme şekli</span>${segButtons('sekil', [['Nakit', 'Nakit'], ['Kart', 'Kart'], ['Havale', 'Havale']], 'Nakit')}</div>
    <div class="two"><div class="field"><label for="pd">Tarih</label><input id="pd" type="date" value="${today()}"></div><div class="field"><label for="pn">Not</label><input id="pn"></div></div>
    <button class="btn" type="submit">Tahsilatı kaydet</button></form>`,
  root => {
    const gs = bindSeg(root, 'sekil');
    $('#f').onsubmit = e => {
      e.preventDefault(); const t = parseNum($('#pt').value); if (!(t > 0)) { toast('Tutarı yazın'); return; }
      saveRow('tahsilatlar', { id: rid(), tarih: $('#pd').value || today(), musteriId: custId, musteriAd: c.ad, tutar: r2(t), sekil: gs(), not: $('#pn').value.trim(), ekleyen: cfg.ad || '', ts: Date.now() });
      toast(`Tahsilat kaydedildi · ${tl(t)}`); openCustomer(custId);
    };
  });
}
function openPayDetail(id) {
  const p = compute().pays.find(x => x.id === id); if (!p) return; const c = compute().C[p.musteriId];
  openSheet('Tahsilat', `<div class="list"><div class="kv"><span>Müşteri</span><b>${esc(c?.ad || p.musteriAd || '')}</b></div><div class="kv"><span>Tutar</span><b class="num pos">${tl(p.tutar)}</b></div><div class="kv"><span>Şekil</span><span>${esc(p.sekil)}</span></div><div class="kv"><span>Tarih</span><span>${fmtDate(p.tarih)}</span></div>${p.not ? `<div class="kv"><span>Not</span><span>${esc(p.not)}</span></div>` : ''}</div>
  <button class="btn warn" type="button" id="del">Tahsilatı sil</button>`, () => armDelete($('#del'), () => { delRow('tahsilatlar', id); toast('Tahsilat silindi'); openCustomer(p.musteriId); }, 'Tahsilatı sil'));
}

/* ============ ACTIONS ============ */
const A = {
  close: closeSheet, checkout: openCheckout, custPick: openCustPick, settings: openSettings,
  pick: id => openPick(id), editLine: id => { const c = cart.find(x => x.key === id); if (c) openPick(c.urunId, id); },
  clearCart: () => { cart = []; saveCart(); closeSheet(); render(); toast('Sepet boşaltıldı'); },
  sale: id => openSale(id), product: id => openProduct(id), lot: id => openLot(id), fire: id => openFire(id), customer: id => openCustomer(id),
  newProduct: () => openProductForm(), editProduct: id => openProductForm(id),
  newLot: id => openLotForm(null, id), editLot: id => openLotForm(id),
  newFire: (id, el) => openFireForm(id, el?.dataset.lot), newCustomer: () => openCustomerForm(), newCustomerCo: () => openCustomerForm(null, 'co'), editCustomer: id => openCustomerForm(id),
  pay: id => openPay(id), payDetail: id => openPayDetail(id),
  sellTo: id => { co.musteriId = id; closeSheet(); setTab('satis'); toast('Ürünleri seçin, ödemede müşteri hazır'); },
  seg: (_, el) => { stokSeg = el.dataset.v; q = ''; render(); }, period: (_, el) => { period = el.dataset.v; render(); },
  install: async () => { if (!installEvt) return; installEvt.prompt(); try { await installEvt.userChoice; } catch (e) {} installEvt = null; renderInstall(); closeSheet(); },
};
document.addEventListener('click', e => { const el = e.target.closest('[data-a]'); if (!el) return; const f = A[el.dataset.a]; if (f) { e.preventDefault(); f(el.dataset.id, el); } });

/* ============ PWA ============ */
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; renderInstall(); });
window.addEventListener('appinstalled', () => { installEvt = null; renderInstall(); toast('Uygulama yüklendi'); });
function renderInstall() { const b = $('#installBtn'); if (b) b.hidden = !installEvt; }
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

/* ============ BOOT ============ */
render(); renderInstall();
if (cfg.api && cfg.pin) flush();
})();
