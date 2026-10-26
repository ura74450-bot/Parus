const express = require('express'), http = require('http'), { Server } = require('socket.io');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const app = express(), server = http.createServer(app), io = new Server(server);
const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UP = path.join(DIR, 'uploads'), DBF = path.join(DIR, 'db.json');
fs.mkdirSync(UP, { recursive: true });

let db = { users: [], messages: [], tokens: {}, groups: [] };
let localExists = false;
try { db = JSON.parse(fs.readFileSync(DBF, 'utf8')); localExists = true; } catch {}
const normalize = () => { db.users = db.users || []; db.messages = db.messages || []; db.tokens = db.tokens || {}; db.groups = db.groups || []; db.stickers = db.stickers || []; db.packs = db.packs || []; db.gone = db.gone || {}; db.messages.forEach(m => { if (m.type === 'share') m.live = false; }); };
normalize();
let timer;
const flush = () => { try { db.savedAt = Date.now(); fs.writeFileSync(DBF + '.tmp', JSON.stringify(db)); fs.renameSync(DBF + '.tmp', DBF); } catch {} };
const save = () => { clearTimeout(timer); timer = setTimeout(flush, 300); ghQueue(); };

// ---- резервная копия базы (JSON) в GitHub: переживает перезапуск и «засыпание» Render ----
// Нужны переменные окружения: GITHUB_TOKEN, GITHUB_REPO (владелец/репозиторий). Необязательно: GITHUB_BRANCH, GITHUB_PATH.
const GH = { token: process.env.GITHUB_TOKEN, repo: process.env.GITHUB_REPO, branch: process.env.GITHUB_BRANCH || '', path: process.env.GITHUB_PATH || 'messenger-db.json' };
const ghOn = !!(GH.token && GH.repo);
const ghUrl = () => `/repos/${GH.repo}/contents/${GH.path.split('/').map(encodeURIComponent).join('/')}`;
const ghQs = () => GH.branch ? '?ref=' + encodeURIComponent(GH.branch) : '';
const ghReq = (url, opt = {}) => fetch('https://api.github.com' + url, { ...opt, headers: { Authorization: 'Bearer ' + GH.token, 'User-Agent': 'messenger-backup', Accept: 'application/vnd.github+json', ...(opt.headers || {}) } });
let ghSha = null, ghReady = false, ghBusy = false, ghDirty = false, ghTimer, ghErr = '', ghLast = 0;
async function ghLoad() {
  const r = await ghReq(ghUrl() + ghQs());
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('GitHub ' + r.status);
  const j = await r.json(); ghSha = j.sha;
  if (j.content && j.encoding === 'base64') return JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
  const r2 = await ghReq(ghUrl() + ghQs(), { headers: { Accept: 'application/vnd.github.raw' } });
  if (!r2.ok) throw new Error('GitHub raw ' + r2.status);
  return JSON.parse(await r2.text());
}
async function ghSave() {
  if (!ghOn || !ghReady || ghBusy) return;
  ghBusy = true; ghDirty = false;
  try {
    const put = () => ghReq(ghUrl(), { method: 'PUT', body: JSON.stringify({ message: 'backup ' + new Date().toISOString(),
      content: Buffer.from(JSON.stringify(db)).toString('base64'), ...(GH.branch ? { branch: GH.branch } : {}), ...(ghSha ? { sha: ghSha } : {}) }) });
    let r = await put();
    if (r.status === 409 || r.status === 422) { const g = await ghReq(ghUrl() + ghQs()); if (g.ok) { ghSha = (await g.json()).sha; r = await put(); } }
    if (r.ok) { ghSha = (await r.json()).content.sha; ghLast = Date.now(); ghErr = ''; }
    else { ghErr = 'GitHub ' + r.status; ghDirty = true; console.error('GitHub backup failed:', r.status); }
  } catch (e) { ghErr = e.message; ghDirty = true; console.error('GitHub backup error:', e.message); }
  ghBusy = false;
  if (ghDirty) ghQueue(30000);
}
function ghQueue(ms = 15000) { if (!ghOn || !ghReady) return; ghDirty = true; clearTimeout(ghTimer); ghTimer = setTimeout(ghSave, ms); }
const shutdown = async () => {
  flush();
  if (ghOn && ghReady && ghDirty) { clearTimeout(ghTimer); await Promise.race([ghSave(), new Promise(r => setTimeout(r, 8000))]); }
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ---- аватарки тоже копируются в репозиторий с базой (папка avatars/) и восстанавливаются при старте ----
const avPending = new Set(); let avBusy = false;
const avOk = n => /^[a-f0-9]{8,40}\.(jpe?g|png|webp|gif)$/i.test(n);
const avName = url => { try { return decodeURIComponent(String(url || '').replace(/^\/uploads\//, '')); } catch { return ''; } };
function avBackup(url) { const n = avName(url); if (ghOn && avOk(n)) { avPending.add(n); avRun(); } }
async function avRun() {
  if (avBusy || !ghReady) return;
  avBusy = true;
  for (const n of [...avPending]) {
    try {
      const buf = fs.readFileSync(path.join(UP, n));
      const r = await ghReq(`/repos/${GH.repo}/contents/avatars/${encodeURIComponent(n)}`, { method: 'PUT', body: JSON.stringify({ message: 'avatar ' + n, content: buf.toString('base64'), ...(GH.branch ? { branch: GH.branch } : {}) }) });
      if (r.ok || r.status === 422 || r.status === 409) avPending.delete(n); else console.error('avatar backup failed:', n, r.status);
    } catch (e) { if (e.code === 'ENOENT') avPending.delete(n); else console.error('avatar backup error:', e.message); }
  }
  avBusy = false;
  if (avPending.size) setTimeout(avRun, 30000);
}
async function avRestore() {
  try {
    const r = await ghReq(`/repos/${GH.repo}/contents/avatars${ghQs()}`);
    const inRepo = new Set(r.ok ? (await r.json()).map(f => f.name) : []);
    const used = new Set([...db.users.map(u => u.avatar), ...db.groups.map(g => g.avatar), ...db.stickers.map(x => x.url)].map(avName).filter(avOk));
    const todo = [];
    for (const n of used) {
      const have = fs.existsSync(path.join(UP, n));
      if (!have && inRepo.has(n)) todo.push(n); else if (have && !inRepo.has(n)) avPending.add(n);
    }
    const worker = async () => {
      for (let n; (n = todo.pop());) {
        try {
          const g = await ghReq(`/repos/${GH.repo}/contents/avatars/${encodeURIComponent(n)}${ghQs()}`, { headers: { Accept: 'application/vnd.github.raw' } });
          if (g.ok) fs.writeFileSync(path.join(UP, n), Buffer.from(await g.arrayBuffer()));
        } catch (e) { console.error('avatar restore error:', n, e.message); }
      }
    };
    const total = todo.length;
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (total) console.log('Avatars restored from GitHub: ' + total);
    avRun();
  } catch (e) { console.error('avatar sync failed:', e.message); }
}
const id = () => crypto.randomBytes(8).toString('hex');
const hash = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
const U = i => db.users.find(x => x.id === i), G = i => db.groups.find(x => x.id === i);
const pub = u => ({ id: u.id, nick: u.nick, name: u.name, avatar: u.avatar || null, admin: !!u.admin });
const pubG = g => ({ id: g.id, type: g.type, title: g.title, name: g.title, nick: g.id, avatar: g.avatar || null,
  owner: g.owner, public: !!g.public, created: g.created, members: g.members.map(U).filter(Boolean).map(pub) });
const ser = m => { const { hidden, ...r } = m; return { ...r, fn: (U(m.from) || { name: 'Удалённый аккаунт' }).name }; };
const members = m => m.chat ? (G(m.chat) || { members: [] }).members : [m.from, m.to];
const vis = (m, uid) => !(m.hidden || []).includes(uid) && members(m).includes(uid);
const okAv = a => typeof a === 'string' && a.startsWith('/uploads/') ? a : null;
const byToken = t => U(db.tokens[t]);
const newToken = u => { const t = id() + id(); db.tokens[t] = u.id; save(); return t; };
const prevOf = o => o.type === 'text' ? o.text.slice(0, 100) : o.type === 'image' ? '📷 Фото' : o.type === 'voice' ? '🎤 Голосовое' : o.type === 'circle' ? '⭕ Видеосообщение' : o.type === 'gif' ? '🎞 GIF' : o.type === 'sticker' ? '🎟 Стикер' : o.type === 'call' ? '📞 Звонок' : o.type === 'share' ? '📺 Трансляция' : '📎 ' + (o.name || 'Файл');

// особый аккаунт администратора (пароль можно переопределить переменной ADMIN_PASS на Render)
const ADMIN_NICK = (process.env.ADMIN_NICK || 'parus').toLowerCase(), ADMIN_PASS = process.env.ADMIN_PASS || 'asdfghjkl', ADMIN_NAME = process.env.ADMIN_NAME || 'Parus';
// пароли хранятся ЗАШИФРОВАННЫМИ (AES-256-GCM) — главный админ может их посмотреть; ключ: переменная PASS_KEY
const PKEY = crypto.scryptSync(process.env.PASS_KEY || ('pk:' + ADMIN_PASS), 'messenger-pw-v1', 32);
const pwEnc = p => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', PKEY, iv); const e = Buffer.concat([c.update(String(p), 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), e]).toString('base64'); };
const pwDec = s => { try { const b = Buffer.from(s, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', PKEY, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); } catch { return null; } };
function seedAdmin() {
  let a = db.users.find(u => u.nick === ADMIN_NICK);
  if (!a) {
    const old = ADMIN_NICK !== 'lcg' && db.users.find(u => u.nick === 'lcg' && u.admin);   // старый главный админ LCG становится Parus (чаты и сессии сохраняются)
    if (old) { old.nick = ADMIN_NICK; old.name = ADMIN_NAME; a = old; }
    else { a = { id: id(), nick: ADMIN_NICK, name: ADMIN_NAME, avatar: null }; db.users.push(a); }
  }
  a.salt = id(); a.pass = hash(ADMIN_PASS, a.salt); a.pwc = pwEnc(ADMIN_PASS); a.admin = true; a.banned = false;
  if (ADMIN_NICK !== 'lcg') db.users.forEach(u => { if (u.nick === 'lcg' && u !== a) u.admin = false; });   // прежнего главного админа больше нет
  save();
}
seedAdmin();
app.get('/health', (q, r) => r.send('ok'));
app.get('/api/status', (q, r) => { r.set('Cache-Control', 'no-store'); r.json({ maint: !!db.maint }); });
app.use(express.json());
app.use('/uploads', express.static(UP, { maxAge: '7d', setHeaders: (res, p) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!/\.(jpe?g|png|webp|gif|webm|mp4|ogg|m4a|mp3|aac)$/i.test(p)) res.setHeader('Content-Disposition', 'attachment');
} }));
app.use(express.static(path.join(__dirname, 'public')));

const auth = (req, res, next) => {
  const u = byToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!u) return res.status(401).json({ error: 'auth' });
  if (u.banned) return res.status(403).json({ error: 'banned' });
  if (db.maint && !u.admin) return res.status(503).json({ error: 'maint' });
  req.user = u; next();
};

app.post('/api/register', (req, res) => {
  if (db.maint) return res.status(503).json({ error: 'Технические работы' });
  if (req.body && req.body.old && db.gone && db.gone[req.body.old]) return res.status(410).json({ error: 'deleted' });
  const { nick = '', password = '', name = '' } = req.body || {};
  const n = nick.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(n)) return res.status(400).json({ error: 'Ник: 3–20 символов, латиница, цифры, _' });
  if (password.length < 4) return res.status(400).json({ error: 'Пароль минимум 4 символа' });
  if (db.users.some(u => u.nick === n)) return res.status(400).json({ error: 'Этот ник уже занят' });
  const salt = id();
  const u = { id: id(), nick: n, name: name.trim().slice(0, 30) || n, salt, pass: hash(password, salt), pwc: pwEnc(password), avatar: null };
  db.users.push(u); save();
  res.json({ token: newToken(u), user: pub(u) });
});
app.post('/api/login', (req, res) => {
  const { nick = '', password = '' } = req.body || {};
  const u = db.users.find(x => x.nick === nick.trim().toLowerCase());
  if (!u || hash(password, u.salt) !== u.pass) return res.status(400).json({ error: 'Неверный ник или пароль' });
  if (!u.pwc || pwDec(u.pwc) !== password) { u.pwc = pwEnc(password); save(); }
  if (u.banned) return res.status(403).json({ error: 'Аккаунт заблокирован' });
  if (db.maint && !u.admin) return res.status(503).json({ error: 'Технические работы' });
  res.json({ token: newToken(u), user: pub(u) });
});
app.get('/api/me', auth, (req, res) => res.json({ ...pub(req.user), root: req.user.nick === ADMIN_NICK, priv: !!req.user.priv, code: req.user.code || null, blocks: req.user.blocks || [] }));
// мгновенно сообщаем собеседникам, участникам общих групп и другим устройствам об изменении имени/аватарки
function broadcastProfile(u) {
  const t = new Set([u.id]);
  for (const m of db.messages) if (!m.chat) { if (m.from === u.id) t.add(m.to); else if (m.to === u.id) t.add(m.from); }
  for (const g of db.groups) if (g.members.includes(u.id)) g.members.forEach(i => t.add(i));
  const d = pub(u); io.emit('profile', d);   // всем: у кого-то этот аккаунт может быть в списке «Аккаунты»
}
app.put('/api/profile', auth, (req, res) => {
  const { name, avatar } = req.body || {};
  if (typeof name === 'string' && name.trim()) req.user.name = name.trim().slice(0, 30);
  if (okAv(avatar)) { req.user.avatar = avatar; avBackup(avatar); }
  save(); broadcastProfile(req.user); res.json(pub(req.user));
});
app.get('/api/search', auth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().replace(/^@/, '');
  if (!q) return res.json([]);
  const r = db.users.filter(u => u.id !== req.user.id && !u.priv && (req.user.admin || !u.banned) && (u.nick.includes(q) || u.name.toLowerCase().includes(q)));
  r.sort((a, b) => (b.nick.startsWith(q) - a.nick.startsWith(q)) || a.nick.localeCompare(b.nick));
  res.json(r.slice(0, 20).map(pub));
});

// Сообщения видят только участники беседы; «удалить у меня» скрывает сообщение только для этого аккаунта
app.get('/api/chats', auth, (req, res) => {
  const me = req.user.id, last = new Map();
  for (const m of db.messages) if (vis(m, me)) last.set(m.chat ? 'g:' + m.chat : 'u:' + (m.from === me ? m.to : m.from), m);
  const out = [], pins = req.user.pins || [];
  for (const [k, m] of last) if (k[0] === 'u') out.push({ peer: pub(U(k.slice(2))), last: ser(m), pinned: pins.includes(k) });
  for (const g of db.groups) if (g.members.includes(me)) { const m = last.get('g:' + g.id); out.push({ group: pubG(g), last: m ? ser(m) : null, pinned: pins.includes('g:' + g.id) }); }
  res.json(out);
});
app.get('/api/messages/:key', auth, (req, res) => {
  const me = req.user.id, [t, p] = req.params.key.split(':');
  res.json(db.messages.filter(m => vis(m, me) && (t === 'g' ? m.chat === p : !m.chat && (m.from === p || m.to === p))).slice(-300).map(ser));
});

// группы и каналы
const cast = g => g.members.forEach(i => io.to('u:' + i).emit('group', pubG(g)));
const own = (req, res) => {
  const g = G(req.params.id);
  if (!g || !g.members.includes(req.user.id)) { res.status(404).json({ error: 'Чат не найден' }); return null; }
  if (g.owner !== req.user.id) { res.status(403).json({ error: 'Только владелец может это делать' }); return null; }
  return g;
};
app.post('/api/groups', auth, (req, res) => {
  const { type, title = '', members = [], avatar, public: isPublic } = req.body || {};
  if (!['group', 'channel'].includes(type) || !title.trim()) return res.status(400).json({ error: 'Укажи название' });
  const g = { id: id(), type, title: title.trim().slice(0, 40), avatar: okAv(avatar), owner: req.user.id, public: type === 'channel' && !!isPublic,
    members: [...new Set([req.user.id, ...(Array.isArray(members) ? members : []).filter(U)])], created: Date.now() };
  db.groups.push(g); if (g.avatar) avBackup(g.avatar); save(); cast(g); res.json(pubG(g));
});
app.put('/api/groups/:id', auth, (req, res) => {
  const g = own(req, res); if (!g) return;
  const { title, avatar } = req.body || {};
  if (typeof title === 'string' && title.trim()) g.title = title.trim().slice(0, 40);
  if (okAv(avatar)) { g.avatar = avatar; avBackup(avatar); }
  save(); cast(g); res.json(pubG(g));
});
app.post('/api/groups/:id/members', auth, (req, res) => {
  const g = own(req, res); if (!g) return;
  for (const i of (Array.isArray(req.body.ids) ? req.body.ids : [])) if (U(i) && !g.members.includes(i)) g.members.push(i);
  save(); cast(g); res.json(pubG(g));
});
app.delete('/api/groups/:id/members/:uid', auth, (req, res) => {
  const g = G(req.params.id);
  if (!g || !g.members.includes(req.user.id)) return res.status(404).json({ error: 'Чат не найден' });
  const uid = req.params.uid, self = uid === req.user.id;
  if (!self && g.owner !== req.user.id) return res.status(403).json({ error: 'Нет прав' });
  if (uid === g.owner) return res.status(400).json({ error: 'Владелец не может выйти — удалите чат' });
  g.members = g.members.filter(i => i !== uid); save();
  io.to('u:' + uid).emit('group:gone', { id: g.id }); cast(g); res.json({ ok: true });
});
app.delete('/api/groups/:id', auth, (req, res) => {
  const g = own(req, res); if (!g) return;
  db.groups = db.groups.filter(x => x !== g); db.messages = db.messages.filter(m => m.chat !== g.id); save();
  g.members.forEach(i => io.to('u:' + i).emit('group:gone', { id: g.id })); res.json({ ok: true });
});

// админ-функции: баны и технические работы
const adm = (req, res, next) => req.user.admin ? next() : res.status(403).json({ error: 'Нет прав' });
app.get('/api/admin/users', auth, adm, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().replace(/^@/, '');
  res.json(db.users.filter(u => !q || u.nick.includes(q) || u.name.toLowerCase().includes(q)).slice(0, 100).map(u => ({ ...pub(u), banned: !!u.banned, root: u.nick === ADMIN_NICK })));
});
app.post('/api/admin/ban', auth, adm, (req, res) => {
  const t = U(req.body && req.body.id);
  if (!t || t.admin) return res.status(400).json({ error: 'Нельзя заблокировать этого пользователя' });
  t.banned = !!req.body.banned; save();
  if (t.banned) { endLive(t.id); io.to('u:' + t.id).emit('banned'); io.in('u:' + t.id).disconnectSockets(true); }
  res.json({ ok: true, banned: t.banned });
});
app.post('/api/admin/maint', auth, adm, (req, res) => {
  db.maint = !!(req.body && req.body.on); save(); io.emit('maint', { on: db.maint }); res.json({ on: db.maint });
});

app.post('/api/admin/role', auth, adm, (req, res) => {
  const t = U(req.body && req.body.id);
  if (!t || t.id === req.user.id || t.nick === ADMIN_NICK) return res.status(400).json({ error: 'Нельзя изменить права этого пользователя' });
  if (t.banned) return res.status(400).json({ error: 'Сначала разбаньте пользователя' });
  const on = !!req.body.admin;
  if (!!t.admin !== on) {
    t.admin = on;
    const n = { admin: on };
    if (io.sockets.adapter.rooms.get('u:' + t.id)) io.to('u:' + t.id).emit('role', n); else t.notice = n;
    save();
  }
  res.json({ ok: true, admin: !!t.admin });
});

// удаление аккаунта (по нику и паролю)
function removeUser(u, byAdmin) {
  endLive(u.id); (db.gone = db.gone || {})[u.id] = Date.now();
  const peers = new Set();
  db.messages = db.messages.filter(m => {
    if (m.chat) return true;
    if (m.from === u.id || m.to === u.id) { peers.add(m.from === u.id ? m.to : m.from); return false; }
    return true;
  });
  for (const g of [...db.groups]) {
    if (g.owner === u.id) {
      db.groups = db.groups.filter(x => x !== g); db.messages = db.messages.filter(m => m.chat !== g.id);
      g.members.forEach(i => { if (i !== u.id) io.to('u:' + i).emit('group:gone', { id: g.id }); });
    } else if (g.members.includes(u.id)) { g.members = g.members.filter(i => i !== u.id); cast(g); }
  }
  for (const t of Object.keys(db.tokens)) if (db.tokens[t] === u.id) delete db.tokens[t];
  db.users = db.users.filter(x => x !== u);
  peers.forEach(i => io.to('u:' + i).emit('user:gone', { id: u.id }));
  io.to('u:' + u.id).emit('deleted', { admin: !!byAdmin }); io.emit('user:deleted', { id: u.id });
  setTimeout(() => io.in('u:' + u.id).disconnectSockets(true), 800);
  save();
}
app.post('/api/account/delete', (req, res) => {
  const { nick = '', password = '' } = req.body || {};
  const u = db.users.find(x => x.nick === String(nick).trim().toLowerCase());
  if (!u || hash(String(password), u.salt) !== u.pass) return res.status(400).json({ error: 'Неверный пароль' });
  if (u.nick === ADMIN_NICK) return res.status(400).json({ error: 'Главный аккаунт нельзя удалить' });
  if (db.maint && !u.admin) return res.status(503).json({ error: 'Технические работы' });
  removeUser(u); res.json({ ok: true });
});

// удаление чужого аккаунта — только главный админ
app.delete('/api/admin/user/:id', auth, adm, (req, res) => {
  if (req.user.nick !== ADMIN_NICK) return res.status(403).json({ error: 'Только главный админ' });
  const t = U(req.params.id);
  if (!t || t.id === req.user.id || t.nick === ADMIN_NICK) return res.status(400).json({ error: 'Этот аккаунт удалить нельзя' });
  console.log('[admin] ' + req.user.nick + ' deleted account @' + t.nick);
  removeUser(t, true); res.json({ ok: true });
});
// приватные аккаунты: не видны в общем поиске, находятся только по коду
const codeOf = () => { const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let c; do { c = ''; for (let i = 0; i < 8; i++) c += A[crypto.randomInt(A.length)]; } while (db.users.some(u => u.code === c)); return c; };
const normCode = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
app.post('/api/private/enable', auth, (req, res) => {
  const u = req.user; u.priv = true; if (!u.code || (req.body && req.body.regen)) u.code = codeOf(); save();
  res.json({ priv: true, code: u.code });
});
app.post('/api/private/disable', auth, (req, res) => { req.user.priv = false; req.user.code = null; save(); res.json({ priv: false }); });
const findTries = new Map();
app.post('/api/private/find', auth, (req, res) => {
  const now = Date.now(), a = (findTries.get(req.user.id) || []).filter(t => now - t < 60000);
  if (a.length >= 15) return res.status(429).json({ error: 'Слишком много попыток. Подождите минуту' });
  a.push(now); findTries.set(req.user.id, a);
  const c = normCode(req.body && req.body.code);
  const t = c.length === 8 && db.users.find(x => x.priv && x.code && x.code === c && x.id !== req.user.id && !x.banned);
  if (!t) return res.status(404).json({ error: 'Пользователь с таким кодом не найден' });
  res.json(pub(t));
});

app.post('/api/admin/backup', auth, adm, async (req, res) => {
  if (!ghOn) return res.json({ enabled: false });
  if (!ghReady) return res.json({ enabled: true, ok: false, error: 'Копия ещё не подключена: ' + (ghErr || 'ждём GitHub') });
  ghDirty = true; await ghSave();
  res.json({ enabled: true, ok: !ghDirty && !ghErr, error: ghErr, last: ghLast });
});

// вход главного админа в чужие аккаунты (создаёт отдельный токен для выбранного пользователя)
app.post('/api/admin/impersonate', auth, adm, (req, res) => {
  if (req.user.nick !== ADMIN_NICK) return res.status(403).json({ error: 'Только главный админ' });
  const t = U(req.body && req.body.id);
  if (!t || t.id === req.user.id) return res.status(400).json({ error: 'Нельзя войти в этот аккаунт' });
  if (t.banned) return res.status(400).json({ error: 'Аккаунт заблокирован — сначала разбаньте' });
  console.log('[admin] ' + req.user.nick + ' entered account @' + t.nick);
  const tk = newToken(t); (db.imp = db.imp || {})[tk] = true; save();
  res.json({ token: tk, user: pub(t) });
});
app.post('/api/logout', (req, res) => {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (db.tokens[t]) { delete db.tokens[t]; if (db.imp) delete db.imp[t]; save(); }
  res.json({ ok: true });
});

app.post('/api/pwsync', auth, (req, res) => {
  const p = String((req.body && req.body.password) || '');
  if (!p || hash(p, req.user.salt) !== req.user.pass) return res.status(400).json({ error: 'Неверный пароль' });
  if (!req.user.pwc || pwDec(req.user.pwc) !== p) { req.user.pwc = pwEnc(p); save(); }
  res.json({ ok: true });
});
app.get('/api/admin/password/:id', auth, adm, (req, res) => {
  if (req.user.nick !== ADMIN_NICK) return res.status(403).json({ error: 'Только главный админ' });
  const t = U(req.params.id); if (!t) return res.status(404).json({ error: 'Нет такого пользователя' });
  console.log('[admin] ' + req.user.nick + ' viewed the password of @' + t.nick);
  res.json({ password: t.pwc ? pwDec(t.pwc) : null });
});

// статусы: в сети / был(а) в сети; сокеты входа «от админа» не считаются (чтобы не выдавать себя)
const live = new Map();
const isOn = i => (live.get(i) || 0) > 0;
app.post('/api/presence', auth, (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.slice(0, 300) : [], out = {};
  for (const i of ids) { const t = U(i); if (t) out[i] = { on: isOn(i), seen: t.seen || null }; }
  res.json(out);
});
app.post('/api/users/lookup', auth, (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.slice(0, 30) : [];
  res.json({ users: ids.map(U).filter(Boolean).map(pub), gone: ids.filter(i => db.gone && db.gone[i]) });
});

// блокировка пользователей (никто из двоих не может писать и звонить)
function isBlocked(a, b) { const x = U(a), y = U(b); return !!((x && (x.blocks || []).includes(b)) || (y && (y.blocks || []).includes(a))); }
app.post('/api/block', auth, (req, res) => {
  const t = U(req.body && req.body.id), on = !!(req.body && req.body.on);
  if (!t || t.id === req.user.id) return res.status(400).json({ error: 'Нельзя заблокировать этот аккаунт' });
  const set = new Set(req.user.blocks || []); if (on) set.add(t.id); else set.delete(t.id);
  req.user.blocks = [...set]; save();
  io.to('u:' + req.user.id).to('u:' + t.id).emit('block', { a: req.user.id, b: t.id, on });
  res.json({ ok: true, blocks: req.user.blocks });
});
app.get('/api/relation/:id', auth, (req, res) => {
  const t = U(req.params.id);
  res.json({ iBlocked: !!t && (req.user.blocks || []).includes(t.id), blockedMe: !!t && (t.blocks || []).includes(req.user.id) });
});

// ICE-серверы для звонков и трансляции экрана. Без TURN связь через разные сети/NAT часто не устанавливается (чёрный экран).
// Переменные Render: METERED_DOMAIN + METERED_KEY (metered.ca) ИЛИ TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL.
let iceCache = [], iceAt = 0;
app.get('/api/ice', auth, async (req, res) => {
  const base = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
  if (Date.now() - iceAt > 30 * 60 * 1000) {
    try {
      let extra = [];
      if (process.env.METERED_DOMAIN && process.env.METERED_KEY) {
        const r = await fetch('https://' + process.env.METERED_DOMAIN + '/api/v1/turn/credentials?apiKey=' + encodeURIComponent(process.env.METERED_KEY));
        if (r.ok) extra = await r.json();
      } else if (process.env.TURN_URLS) {
        extra = [{ urls: process.env.TURN_URLS.split(',').map(x => x.trim()).filter(Boolean), username: process.env.TURN_USERNAME || '', credential: process.env.TURN_CREDENTIAL || '' }];
      }
      iceCache = Array.isArray(extra) ? extra : []; iceAt = Date.now();
    } catch (e) { console.error('ICE fetch failed:', e.message); iceAt = Date.now() - 25 * 60 * 1000; }
  }
  res.json({ iceServers: [...base, ...iceCache] });
});

// стикеры и стикерпаки
const okSticker = v => typeof v === 'string' && /^\/uploads\/[a-f0-9]{8,40}\.(png|webp|gif)$/i.test(v);
const stk = (x, uid) => ({ id: x.id, url: x.url, own: x.owner === uid });
const inLib = (u, p) => p.owner === u.id || (u.lib || []).includes(p.id);
const packOut = (p, u) => ({ id: p.id, title: p.title, owner: p.owner, mine: p.owner === u.id, stickers: db.stickers.filter(x => x.pack === p.id).map(x => stk(x, u.id)) });
app.get('/api/stickers', auth, (req, res) => {
  const u = req.user, by = new Map(db.stickers.map(x => [x.id, x]));
  res.json({ packs: db.packs.filter(p => inLib(u, p)).map(p => packOut(p, u)),
    recent: (u.recentSt || []).map(i => by.get(i)).filter(Boolean).map(x => stk(x, u.id)),
    favs: (u.favSt || []).map(i => by.get(i)).filter(Boolean).map(x => stk(x, u.id)) });
});
app.get('/api/stickers/catalog', auth, (req, res) => {
  const u = req.user;
  res.json(db.packs.map(p => { const l = db.stickers.filter(x => x.pack === p.id); return { id: p.id, title: p.title, count: l.length, cover: l[0] ? l[0].url : null, mine: p.owner === u.id, added: inLib(u, p) }; })
    .filter(p => p.count || p.mine).sort((a, b) => b.count - a.count).slice(0, 100));
});
app.post('/api/packs', auth, (req, res) => {
  const title = String((req.body && req.body.title) || '').trim().slice(0, 30);
  if (!title) return res.status(400).json({ error: 'Введите название пака' });
  if (db.packs.filter(p => p.owner === req.user.id).length >= 30) return res.status(400).json({ error: 'Слишком много паков' });
  const p = { id: id(), title, owner: req.user.id, created: Date.now() }; db.packs.push(p); save(); res.json(packOut(p, req.user));
});
app.put('/api/packs/:id', auth, (req, res) => {
  const p = db.packs.find(x => x.id === req.params.id && x.owner === req.user.id), t = String((req.body && req.body.title) || '').trim().slice(0, 30);
  if (!p || !t) return res.status(400).json({ error: 'Нельзя переименовать' });
  p.title = t; save(); res.json({ ok: true });
});
app.delete('/api/packs/:id', auth, (req, res) => {
  const p = db.packs.find(x => x.id === req.params.id && (x.owner === req.user.id || req.user.nick === ADMIN_NICK));
  if (!p) return res.status(404).json({ error: 'Пак не найден' });
  db.stickers = db.stickers.filter(x => x.pack !== p.id); db.packs = db.packs.filter(x => x !== p);
  db.users.forEach(u => { if (u.lib) u.lib = u.lib.filter(i => i !== p.id); }); save(); res.json({ ok: true });
});
app.post('/api/packs/:id/lib', auth, (req, res) => {
  const p = db.packs.find(x => x.id === req.params.id); if (!p) return res.status(404).json({ error: 'Пак не найден' });
  const set = new Set(req.user.lib || []); if (req.body && req.body.on) set.add(p.id); else set.delete(p.id);
  req.user.lib = [...set]; save(); res.json({ ok: true });
});
app.post('/api/stickers', auth, (req, res) => {
  const { url, pack } = req.body || {};
  if (!okSticker(url) || !fs.existsSync(path.join(UP, avName(url)))) return res.status(400).json({ error: 'Неверный файл стикера' });
  let p = pack && db.packs.find(x => x.id === pack && x.owner === req.user.id);
  if (!p) { p = db.packs.find(x => x.owner === req.user.id && x.auto); if (!p) { p = { id: id(), title: 'Мои стикеры', owner: req.user.id, created: Date.now(), auto: true }; db.packs.push(p); } }
  if (db.stickers.filter(x => x.pack === p.id).length >= 120) return res.status(400).json({ error: 'В паке не больше 120 стикеров' });
  const x = { id: id(), url, pack: p.id, owner: req.user.id, ts: Date.now() }; db.stickers.push(x); avBackup(url); save();
  res.json({ sticker: stk(x, req.user.id), pack: packOut(p, req.user) });
});
app.delete('/api/stickers/:id', auth, (req, res) => {
  const x = db.stickers.find(v => v.id === req.params.id && (v.owner === req.user.id || req.user.nick === ADMIN_NICK));
  if (!x) return res.status(404).json({ error: 'Стикер не найден' });
  db.stickers = db.stickers.filter(v => v !== x); save(); res.json({ ok: true });
});
app.post('/api/stickers/fav', auth, (req, res) => {
  const x = db.stickers.find(v => v.id === (req.body && req.body.id)); if (!x) return res.status(404).json({ error: 'Стикер не найден' });
  const l = (req.user.favSt || []).filter(i => i !== x.id); if (req.body.on) l.unshift(x.id);
  req.user.favSt = l.slice(0, 100); save(); res.json({ ok: true });
});

// публичные каналы, закрепы, удаление чата
app.get('/api/channels', auth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  res.json(db.groups.filter(g => g.type === 'channel' && g.public && g.title.toLowerCase().includes(q))
    .sort((a, b) => b.members.length - a.members.length).slice(0, 30)
    .map(g => ({ id: g.id, type: 'channel', title: g.title, name: g.title, nick: g.id, avatar: g.avatar || null, count: g.members.length, joined: g.members.includes(req.user.id) })));
});
app.post('/api/groups/:id/join', auth, (req, res) => {
  const g = G(req.params.id);
  if (!g || g.type !== 'channel' || !g.public) return res.status(403).json({ error: 'Канал приватный' });
  if (!g.members.includes(req.user.id)) { g.members.push(req.user.id); save(); cast(g); }
  res.json(pubG(g));
});
app.put('/api/pin', auth, (req, res) => {
  const { key, pinned } = req.body || {};
  if (typeof key !== 'string') return res.status(400).json({ error: 'Ошибка' });
  const p = (req.user.pins || []).filter(k => k !== key);
  if (pinned) p.unshift(key);
  req.user.pins = p.slice(0, 20); save(); res.json({ ok: true });
});
app.delete('/api/chat/:key', auth, (req, res) => {
  const me = req.user.id, [t, p] = req.params.key.split(':');
  if (t !== 'u') return res.status(400).json({ error: 'Неверный чат' });
  db.messages.forEach(m => { if (!m.chat && vis(m, me) && (m.from === p || m.to === p)) (m.hidden = m.hidden || []).push(me); });
  req.user.pins = (req.user.pins || []).filter(k => k !== req.params.key); save(); res.json({ ok: true });
});

// загрузки: фото/аудио по белому списку, остальное — как файл (всегда скачивается)
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/webm': 'webm', 'video/webm': 'webm', 'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/aac': 'aac' };
function gifDur(b) {   // суммарная длительность кадров GIF, секунды
  if (b.length < 13 || b[0] !== 0x47) return 0;
  let p = 13, t = 0; const f = b[10]; if (f & 0x80) p += 3 * (2 << (f & 7));
  const skip = () => { while (p < b.length && b[p]) p += b[p] + 1; p++; };
  while (p < b.length) {
    const c = b[p++];
    if (c === 0x3B) break;
    if (c === 0x21) { const l = b[p++]; if (l === 0xF9) { const d = b[p + 2] | (b[p + 3] << 8); t += (d <= 1 ? 10 : d) / 100; } skip(); }
    else if (c === 0x2C) { const lf = b[p + 8]; p += 9; if (lf & 0x80) p += 3 * (2 << (lf & 7)); p++; skip(); }
    else break;
  }
  return t;
}
app.post('/api/upload', auth, (req, res) => {
  const max = req.user.admin ? Infinity : 25 * 1024 * 1024;
  const ext = EXT[String(req.headers['content-type'] || '').split(';')[0].trim()];
  let name;
  if (ext && req.headers['x-kind'] !== 'file') name = id() + '.' + ext;
  else {
    let o = 'file'; try { o = decodeURIComponent(String(req.headers['x-filename'] || 'file')); } catch {}
    name = id() + '_' + (o.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(-80) || 'file');
  }
  const file = path.join(UP, name), ws = fs.createWriteStream(file);
  let n = 0, dead = false;
  const fail = (code, msg) => {
    if (dead) return; dead = true; req.unpipe(); ws.destroy(); fs.unlink(file, () => {}); req.resume();
    if (!res.headersSent) res.status(code).json({ error: msg });
  };
  req.on('data', c => { n += c.length; if (n > max) fail(413, 'Файл больше 25 МБ'); });
  req.on('aborted', () => fail(499, 'aborted'));
  ws.on('error', () => fail(500, 'Ошибка сохранения'));
  ws.on('finish', () => {
    if (dead) return;
    if (!n) { fs.unlink(file, () => {}); return res.status(400).json({ error: 'Пустой файл' }); }
    if (ext === 'gif' && req.headers['x-kind'] !== 'file' && n <= 64 * 1024 * 1024) {   // GIF не длиннее 10 секунд
      try { if (gifDur(fs.readFileSync(file)) > 10.5) { fs.unlink(file, () => {}); return res.status(400).json({ error: 'GIF длиннее 10 секунд' }); } } catch {}
    }
    res.json({ url: '/uploads/' + encodeURIComponent(name), size: n });
  });
  req.pipe(ws);
});

// трансляции экрана: сервер только хранит сообщение и пересылает сигналы WebRTC
const lives = new Map();
function endLive(uid) {
  const mid = lives.get(uid); if (!mid) return;
  lives.delete(uid);
  const m = db.messages.find(x => x.id === mid); if (!m) return;
  m.live = false; save();
  [m.from, m.to].forEach(i => io.to('u:' + i).emit('share:end', { id: mid, from: uid }));
}
// история звонков в чате: «Входящий / Пропущенный / длительность»
const callKey = (a, b) => [a, b].sort().join(':');
const calls = new Map();
function finishCall(key, by) {
  const c = calls.get(key); if (!c) return; calls.delete(key);
  const m = { id: id(), from: c.from, to: c.to, type: 'call', ts: c.ts, ans: !!c.ans, dur: c.ans ? Math.max(1, Math.round((Date.now() - c.ans) / 1000)) : 0, by };
  db.messages.push(m); save();
  const a = U(c.from), b = U(c.to); if (!a || !b) return;
  const payload = { ...ser(m), fromU: pub(a), toU: pub(b) };
  [a.id, b.id].forEach(i => io.to('u:' + i).emit('msg', payload));
}
io.use((s, next) => { const u = byToken(s.handshake.auth.token); if (!u) return next(new Error('auth')); if (u.banned) return next(new Error('banned')); s.user = u; s.imp = !!(db.imp && db.imp[s.handshake.auth.token]); next(); });
io.on('connection', s => {
  const u = s.user;
  s.join('u:' + u.id);
  if (!s.imp) { const n = (live.get(u.id) || 0) + 1; live.set(u.id, n); if (n === 1) io.emit('presence', { id: u.id, on: true }); }
  s.use((pk, next) => (u.banned || (db.maint && !u.admin)) ? next(new Error('blocked')) : next());
  if (u.notice) { s.emit('role', u.notice); delete u.notice; save(); }
  s.on('msg', d => {
    d = d || {};
    if (!['text', 'image', 'voice', 'file', 'circle', 'gif', 'sticker'].includes(d.type)) return;
    const m = { id: id(), from: u.id, type: d.type, ts: Date.now() };
    let to;
    if (d.chat) {
      const g = G(d.chat);
      if (!g || !g.members.includes(u.id) || (g.type === 'channel' && g.owner !== u.id)) return;
      m.chat = g.id;
    } else { to = U(d.to); if (!to || to.id === u.id || isBlocked(u.id, to.id)) return; m.to = to.id; }
    if (d.type === 'text') { m.text = String(d.text || '').trim().slice(0, 4000); if (!m.text) return; }
    else if (d.type === 'sticker') {
      const st = db.stickers.find(x => x.id === d.sid); if (!st) return;
      m.url = st.url; m.sid = st.id;
      u.recentSt = [st.id, ...(u.recentSt || []).filter(i => i !== st.id)].slice(0, 30);
    }
    else {
      if (typeof d.url !== 'string' || !d.url.startsWith('/uploads/')) return;
      m.url = d.url;
      if (d.type === 'voice') m.dur = Math.min(Math.max(+d.dur || 0, 0), 3600);
      if (d.type === 'circle') { if ((+d.dur || 0) > 30.5) return; m.dur = Math.min(Math.max(+d.dur || 0, 0), 30); }
      if (d.type === 'gif') { if ((+d.dur || 0) > 10.5) return; m.dur = Math.min(Math.max(+d.dur || 0, 0), 10); m.kind = d.kind === 'vid' ? 'vid' : 'img'; }
      if (d.type === 'file') { m.name = String(d.name || 'file').slice(0, 120); m.size = Math.max(+d.size || 0, 0); }
    }
    if (typeof d.fwd === 'string' && d.fwd) m.fwd = d.fwd.slice(0, 40);
    if (d.reply) {
      const o = db.messages.find(x => x.id === d.reply && vis(x, u.id) &&
        (m.chat ? x.chat === m.chat : !x.chat && ((x.from === m.from && x.to === m.to) || (x.from === m.to && x.to === m.from))));
      if (o) m.reply = { id: o.id, name: (U(o.from) || {}).name, prev: prevOf(o) };
    }
    db.messages.push(m); save();
    const payload = { ...(m.chat ? ser(m) : { ...ser(m), fromU: pub(u), toU: pub(to) }), cid: typeof d.cid === 'string' ? d.cid.slice(0, 40) : undefined };
    members(m).forEach(i => io.to('u:' + i).emit('msg', payload));
  });
  s.on('del', d => {
    const ids = Array.isArray(d && d.ids) ? d.ids.slice(0, 100) : [], all = !!(d && d.all);
    for (const mid of ids) {
      const i = db.messages.findIndex(x => x.id === mid);
      if (i < 0) continue;
      const m = db.messages[i];
      if (!vis(m, u.id)) continue;
      if (all) {
        const g = m.chat && G(m.chat);
        if (m.from !== u.id && !(g && g.owner === u.id)) continue;
        db.messages.splice(i, 1);
        members(m).forEach(x => io.to('u:' + x).emit('del', { ids: [mid] }));
      } else { (m.hidden = m.hidden || []).push(u.id); io.to('u:' + u.id).emit('del', { ids: [mid] }); }
    }
    save();
  });
  s.on('share:start', d => {
    const to = U(d && d.to); if (!to || to.id === u.id) return;
    endLive(u.id);
    const m = { id: id(), from: u.id, to: to.id, type: 'share', live: true, ts: Date.now() };
    db.messages.push(m); save(); lives.set(u.id, m.id);
    const payload = { ...ser(m), fromU: pub(u), toU: pub(to) };
    [u.id, to.id].forEach(i => io.to('u:' + i).emit('msg', payload));
  });
  s.on('edit', d => {   // изменить своё текстовое сообщение — видно всем в беседе
    const m = d && db.messages.find(x => x.id === d.id);
    if (!m || m.from !== u.id || m.type !== 'text' || !vis(m, u.id)) return;
    const text = String(d.text || '').trim().slice(0, 4000);
    if (!text || text === m.text) return;
    m.text = text; m.edited = Date.now(); save();
    members(m).forEach(i => io.to('u:' + i).emit('edited', { id: m.id, text, edited: m.edited }));
  });
  s.on('read', d => {   // «я прочитал(а) все сообщения от этого человека» → у него появляются две галочки
    const p = d && U(d.from);
    if (s.imp || !p || p.id === u.id) return;   // вход «от админа» ничего не помечает прочитанным
    let up = 0; const now = Date.now();
    for (const m of db.messages) if (!m.chat && m.from === p.id && m.to === u.id && !m.rd && vis(m, u.id)) { m.rd = now; if (m.ts > up) up = m.ts; }
    if (up) { save(); io.to('u:' + p.id).emit('read', { by: u.id, upto: up }); }
  });
  const ACTS = ['typing', 'file', 'photo', 'gif', 'voice', 'circle', 'upload'];
  s.on('act', d => {   // «печатает», «записывает голосовое» и т.д.
    if (s.imp || !d) return;
    const kind = ACTS.includes(d.kind) ? d.kind : '';
    if (d.chat) {
      const g = G(d.chat);
      if (!g || !g.members.includes(u.id) || (g.type === 'channel' && g.owner !== u.id)) return;
      g.members.forEach(i => { if (i !== u.id) io.to('u:' + i).emit('act', { from: u.id, chat: g.id, kind }); });
    } else {
      const to = U(d.to); if (!to || to.id === u.id || isBlocked(u.id, to.id)) return;
      io.to('u:' + to.id).emit('act', { from: u.id, chat: null, kind });
    }
  });
  s.on('share:end', () => endLive(u.id));
  s.on('disconnect', () => {
    if (!s.imp) {
      const n = (live.get(u.id) || 1) - 1;
      if (n <= 0) { live.delete(u.id); u.seen = Date.now(); save(); io.emit('presence', { id: u.id, on: false, seen: u.seen }); } else live.set(u.id, n);
    }
    if (!io.sockets.adapter.rooms.get('u:' + u.id)) { endLive(u.id); for (const [k, c] of [...calls]) if (c.from === u.id || c.to === u.id) finishCall(k, u.id); }
  });
  for (const ev of ['join', 'offer', 'answer', 'ice', 'leave'])
    s.on('share:' + ev, d => {
      if (!d || !d.to) return;
      io.to('u:' + d.to).emit('share:' + ev, { sdp: d.sdp, c: d.c, from: u.id, fromU: pub(u) });
    });
  for (const ev of ['offer', 'answer', 'ice', 'end'])
    s.on('call:' + ev, d => {
      if (!d || !d.to) return;
      const key = callKey(u.id, d.to);
      if (ev === 'offer') {
        if (!U(d.to) || isBlocked(u.id, d.to)) { io.to('u:' + u.id).emit('call:end', { from: d.to }); return; }
        finishCall(key, u.id); calls.set(key, { from: u.id, to: d.to, ts: Date.now(), ans: 0 });
      } else if (ev === 'answer') { const c = calls.get(key); if (c && !c.ans && c.to === u.id) c.ans = Date.now(); }
      else if (ev === 'end') finishCall(key, u.id);
      io.to('u:' + d.to).emit('call:' + ev, { sdp: d.sdp, c: d.c, from: u.id, fromU: pub(u) });
    });
});

const PORT = process.env.PORT || 3000;
(async () => {
  if (ghOn) {
    let remote, ok = false;
    for (let i = 0; i < 5 && !ok; i++) {
      try { remote = await ghLoad(); ok = true; }
      catch (e) { ghErr = e.message; console.error('GitHub restore failed (' + (i + 1) + '/5):', e.message); await new Promise(r => setTimeout(r, 3000)); }
    }
    if (ok) {
      if (remote && Array.isArray(remote.users) && (!localExists || (remote.savedAt || 0) > (db.savedAt || 0))) {
        db = remote; normalize(); seedAdmin(); console.log('GitHub backup restored: ' + db.users.length + ' users, ' + db.messages.length + ' messages');
      } else console.log(remote ? 'GitHub backup found, local data is newer' : 'GitHub backup is empty, creating the first copy');
      ghReady = true; ghErr = ''; ghQueue(2000); avRun();
    } else console.error('GitHub backup DISABLED for this run (could not read the repository)');
  } else console.log('GitHub backup is off (set GITHUB_TOKEN and GITHUB_REPO to enable)');
  server.listen(PORT, () => console.log('Messenger on :' + PORT));
  if (ghOn && ghReady) avRestore();
})();
