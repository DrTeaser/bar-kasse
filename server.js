/**
 * NFC Kassensystem – Server
 * - ACR122U via nfc-pcsc
 * - SQLite Datenbank (users + orders)
 * - WebSocket für Echtzeit-Updates
 * - HTTP für statische Dateien
 */

const { NFC }    = require('nfc-pcsc');
const WebSocket  = require('ws');
const http       = require('http');
const fs         = require('fs');
const path       = require('path');
const Database   = require('better-sqlite3');

// ─── Konfiguration ────────────────────────────────────────────────────────────
const PORT    = 3001;
const DB_FILE = path.join(__dirname, 'bar.db');

// ─── Reader Status (wird gleich am Anfang deklariert) ──────────────────────────
let readerStatus = { connected: false, name: '' };

// ─── Datenbank einrichten ─────────────────────────────────────────────────────
const db = new Database(DB_FILE);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    uid  TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS drinks (
    id    TEXT PRIMARY KEY,
    name  TEXT NOT NULL,
    emoji TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    uid        TEXT    NOT NULL,
    drink_id   TEXT    NOT NULL,
    timestamp  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (drink_id) REFERENCES drinks(id)
  );
`);

// Standard-Getränkekarte beim ersten Start anlegen
const drinkCount = db.prepare('SELECT COUNT(*) as c FROM drinks').get().c;
if (drinkCount === 0) {
  const insert = db.prepare('INSERT INTO drinks (id, name, emoji) VALUES (?, ?, ?)');
  [
    ['beer',      'Bier',      '🍺'],
    ['wine',      'Wein',      '🍷'],
    ['water',     'Wasser',    '💧'],
    ['softdrink', 'Softdrink', '🥤'],
    ['shot',      'Shot',      '🥃'],
    ['cocktail',  'Cocktail',  '🍹'],
  ].forEach(r => insert.run(...r));
}

// ─── DB-Hilfsfunktionen ───────────────────────────────────────────────────────
function getDrinks() {
  const rows = db.prepare('SELECT * FROM drinks').all();
  const map = {};
  rows.forEach(r => { map[r.id] = r; });
  return map;
}

function getOrders() {
  return db.prepare(`
    SELECT o.id, o.uid, o.drink_id, o.timestamp,
           d.name AS drink_name, d.emoji,
           u.name AS user_name
    FROM   orders o
    JOIN   drinks d ON d.id = o.drink_id
    LEFT JOIN users u ON u.uid = o.uid
    ORDER  BY o.id DESC
    LIMIT  200
  `).all().map(normalizeOrder);
}

function getUsers() {
  return db.prepare('SELECT uid, name FROM users ORDER BY name').all();
}

function getStats() {
  return db.prepare(`
    SELECT 
      u.name,
      u.uid,
      d.name AS drink_name,
      d.emoji,
      COUNT(*) AS count
    FROM orders o
    JOIN users u ON u.uid = o.uid
    JOIN drinks d ON d.id = o.drink_id
    GROUP BY u.uid, o.drink_id
    ORDER BY u.name, d.name
  `).all();
}

function normalizeOrder(row) {
  return {
    id:        row.id,
    uid:       row.uid,
    drinkId:   row.drink_id,
    timestamp: row.timestamp,
    userName:  row.user_name || null,
    drink: {
      id:    row.drink_id,
      name:  row.drink_name,
      emoji: row.emoji,
    },
  };
}

// ─── HTTP-Server (statische Dateien) ──────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const safePath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(__dirname, safePath);

  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript',
    '.css':  'text/css',
    '.json': 'application/json',
    '.png':  'image/png',
    '.ico':  'image/x-icon',
  };

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ─── WebSocket-Server ─────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server: httpServer });

function broadcast(msg) {
  const raw = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(raw); });
}

wss.on('connection', ws => {
  console.log('Browser verbunden');

  ws.send(JSON.stringify({
    type:         'init',
    drinks:       getDrinks(),
    orders:       getOrders(),
    users:        getUsers(),
    stats:        getStats(),
    readerStatus,
  }));

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── Getränk buchen ──────────────────────────────────────────
    if (msg.type === 'book') {
      const { uid, drinkId } = msg;
      const drink = db.prepare('SELECT * FROM drinks WHERE id = ?').get(drinkId);
      if (!drink) return;

      const result = db.prepare(
        'INSERT INTO orders (uid, drink_id) VALUES (?, ?)'
      ).run(uid, drinkId);

      const order = db.prepare(`
        SELECT o.id, o.uid, o.drink_id, o.timestamp,
               d.name AS drink_name, d.emoji,
               u.name AS user_name
        FROM   orders o
        JOIN   drinks d ON d.id = o.drink_id
        LEFT JOIN users u ON u.uid = o.uid
        WHERE  o.id = ?
      `).get(result.lastInsertRowid);

      broadcast({ type: 'order_added', order: normalizeOrder(order) });
      broadcast({ type: 'stats_updated', stats: getStats() });
    }

    // ── Bestellung stornieren ───────────────────────────────────
    if (msg.type === 'cancel') {
      db.prepare('DELETE FROM orders WHERE id = ?').run(msg.orderId);
      broadcast({ type: 'order_removed', orderId: msg.orderId });
      broadcast({ type: 'stats_updated', stats: getStats() });
    }

    // ── Benutzer anlegen / umbenennen ───────────────────────────
    if (msg.type === 'upsert_user') {
      const { uid, name } = msg;
      db.prepare(`
        INSERT INTO users (uid, name) VALUES (?, ?)
        ON CONFLICT(uid) DO UPDATE SET name = excluded.name
      `).run(uid, name.trim());

      const users = getUsers();
      broadcast({ type: 'users_updated', users });
      broadcast({ type: 'orders_updated', orders: getOrders() });
      broadcast({ type: 'stats_updated', stats: getStats() });
    }

    // ── Benutzer löschen ────────────────────────────────────────
    if (msg.type === 'delete_user') {
      db.prepare('DELETE FROM users WHERE uid = ?').run(msg.uid);
      broadcast({ type: 'users_updated', users: getUsers() });
      broadcast({ type: 'orders_updated', orders: getOrders() });
      broadcast({ type: 'stats_updated', stats: getStats() });
    }

    // ── Getränkekarte aktualisieren ─────────────────────────────
    if (msg.type === 'update_drinks') {
      const upsert = db.prepare(`
        INSERT INTO drinks (id, name, emoji) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, emoji=excluded.emoji
      `);
      Object.values(msg.drinks).forEach(d => upsert.run(d.id, d.name, d.emoji));
      broadcast({ type: 'drinks_updated', drinks: getDrinks() });
    }
  });

  ws.on('close', () => console.log('Browser getrennt'));
});

// ─── NFC-Reader (Hot-Plug) ────────────────────────────────────────────────────
let nfcInstance  = null;
let nfcPolling   = null;

function attachNFC() {
  if (nfcInstance) return;

  try {
    const nfc = new NFC();
    nfcInstance = nfc;

    nfc.on('reader', reader => {
      console.log(`✅ NFC-Reader erkannt: ${reader.reader.name}`);
      readerStatus = { connected: true, name: reader.reader.name };
      broadcast({ type: 'reader_status', ...readerStatus });

      reader.on('card', card => {
        const uid = card.uid;
        console.log('📶 Karte gescannt, UID:', uid);
        const user = db.prepare('SELECT name FROM users WHERE uid = ?').get(uid);
        broadcast({ type: 'card_scanned', uid, userName: user ? user.name : null });
      });

      reader.on('card.off', () => broadcast({ type: 'card_removed' }));

      reader.on('end', () => {
        console.log('Reader entfernt');
        readerStatus = { connected: false, name: '' };
        broadcast({ type: 'reader_status', connected: false });
      });

      reader.on('error', err => console.error('Reader Fehler:', err.message));
    });

    nfc.on('error', err => {
      console.warn('NFC Fehler (wird automatisch erneut versucht):', err.message);
      detachNFC();
    });

    console.log('✅ NFC-Dienst gestartet – warte auf Lesegerät …');
    if (nfcPolling) { clearInterval(nfcPolling); nfcPolling = null; }

  } catch (err) {
    nfcInstance = null;
  }
}

function detachNFC() {
  if (nfcInstance) {
    try { nfcInstance.close(); } catch (_) {}
    nfcInstance = null;
  }
  readerStatus = { connected: false, name: '' };
  startPolling();
}

function startPolling() {
  if (nfcPolling) return;
  console.log('🔄 Warte auf NFC-Lesegerät (prüfe alle 3 s) …');
  nfcPolling = setInterval(() => {
    if (!nfcInstance) attachNFC();
  }, 3000);
}

httpServer.listen(PORT, () => {
  console.log(`\n🍺 NFC Kassensystem läuft`);
  console.log(`   → http://localhost:${PORT}`);
  console.log(`   → Datenbank: /home/jerry/kassensystem/bar.db\n`);

  setTimeout(() => {
    attachNFC();
    if (!nfcInstance) startPolling();
  }, 500);
});
