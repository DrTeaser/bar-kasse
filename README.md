# 🍺 NFC Kassensystem – KlangKo Bar

Getränke-Kassensystem mit ACR122U NFC-Reader, Node.js-Backend und Browser-Frontend.

---

## Dateien

```
nfc-server/
├── server.js       ← Node.js Backend (NFC + WebSocket + HTTP)
├── index.html      ← Frontend (Bar-Interface)
├── package.json    ← Abhängigkeiten
└── orders.json     ← Automatisch generiert (Bestellspeicher)
```

---

## Lokal starten (Mac, zum Testen)

```bash
# 1. Abhängigkeiten installieren
npm install

# 2. ACR122U anstecken, dann:
node server.js

# → http://localhost:3000 im Browser öffnen
```

Falls der Reader nicht erkannt wird:
```bash
sudo killall -9 pcscd   # PC/SC Daemon neu starten
node server.js
```

---

## Deployment auf bar.klangko.de (Linux-Server)

### Voraussetzungen auf dem Server installieren

```bash
# Node.js (v18+)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# PC/SC Daemon (für NFC-Reader)
sudo apt-get install -y pcscd pcsc-tools libpcsclite-dev

# PC/SC Daemon starten & beim Boot aktivieren
sudo systemctl enable pcscd
sudo systemctl start pcscd

# Nginx (Reverse Proxy)
sudo apt-get install -y nginx

# PM2 (Prozessmanager, hält Node.js am Laufen)
sudo npm install -g pm2
```

---

### Projektdateien auf den Server hochladen

```bash
# Vom Mac aus – Dateien per SCP übertragen
scp -r ./nfc-server user@DEINE-SERVER-IP:/home/user/nfc-server

# Auf dem Server: Abhängigkeiten installieren
ssh user@DEINE-SERVER-IP
cd /home/user/nfc-server
npm install
```

---

### Node.js mit PM2 dauerhaft starten

```bash
cd /home/user/nfc-server
pm2 start server.js --name "bar-kasse"
pm2 save               # Autostart bei Neustart
pm2 startup            # PM2 als Systemdienst registrieren
# (Den angezeigten sudo-Befehl ausführen)
```

Nützliche PM2-Befehle:
```bash
pm2 status             # Status anzeigen
pm2 logs bar-kasse     # Live-Logs
pm2 restart bar-kasse  # Neustart
```

---

### Nginx als Reverse Proxy einrichten

`bar.klangko.de` → leitet an `localhost:3000` weiter (inkl. WebSocket-Support).

```bash
sudo nano /etc/nginx/sites-available/bar.klangko.de
```

Inhalt:
```nginx
server {
    listen 80;
    server_name bar.klangko.de;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;

        # WebSocket-Support (wichtig!)
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";

        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
# Konfiguration aktivieren
sudo ln -s /etc/nginx/sites-available/bar.klangko.de /etc/nginx/sites-enabled/
sudo nginx -t          # Syntax prüfen
sudo systemctl reload nginx
```

---

### HTTPS mit Let's Encrypt (empfohlen)

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d bar.klangko.de
# Anweisungen folgen → danach automatisch HTTPS

# Automatische Erneuerung testen:
sudo certbot renew --dry-run
```

Nach HTTPS musst du in `index.html` die WebSocket-URL anpassen:
```js
// Vorher (nur HTTP):
const WS_URL = `ws://${location.host}`;

// Nachher (HTTPS erkennt automatisch wss:// – kein Änderungsbedarf,
// da location.protocol ausgewertet wird):
const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
```

---

### DNS prüfen

Stelle sicher, dass deine Subdomain auf die Server-IP zeigt:
```bash
dig bar.klangko.de     # sollte die IP deines Servers zeigen
```

---

## Getränkekarte anpassen

Die Standardkarte wird beim ersten Start in `orders.json` gespeichert.
Du kannst sie direkt in der JSON-Datei bearbeiten:

```json
{
  "drinks": {
    "beer": { "id": "beer", "name": "Bier", "price": 3.50, "emoji": "🍺" },
    "wine": { "id": "wine", "name": "Wein", "price": 4.00, "emoji": "🍷" }
  },
  "orders": []
}
```

Nach Änderungen den Server neu starten: `pm2 restart bar-kasse`

---

## Troubleshooting

| Problem | Lösung |
|---|---|
| `Error: SCARD_E_NO_SERVICE` | `sudo systemctl restart pcscd` |
| Reader wird nicht erkannt | USB neu einstecken, dann `node server.js` |
| WebSocket verbindet nicht | Nginx-Config prüfen (Upgrade-Header!) |
| `permission denied` für pcscd | User zur Gruppe `pcscd` hinzufügen: `sudo usermod -aG pcscd $USER` |
