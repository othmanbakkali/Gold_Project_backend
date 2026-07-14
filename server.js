const express = require('express');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// ─── Firebase Admin SDK ───────────────────────────────────────────────────────
let firebaseAdmin = null;
let firebaseMessaging = null;

try {
  const admin = require('firebase-admin');
  let serviceAccount = null;

  // 1. Essayer de charger depuis une variable d'environnement (Sécurisé pour GitHub/Production)
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      console.log('📡 Firebase: Chargement via variable d\'environnement.');
    } catch (parseErr) {
      console.error('❌ Erreur lors du parsing de FIREBASE_SERVICE_ACCOUNT:', parseErr.message);
    }
  }

  // Initialisation détaillée avec logs
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      firebaseAdmin = admin;
      firebaseMessaging = admin.messaging();
      console.log('✅ Firebase Admin initialisé avec succès via variable d\'environnement.');
    } else if (fs.existsSync(path.resolve(__dirname, './firebase-service-account.json'))) {
      const serviceAccount = require('./firebase-service-account.json');
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      firebaseAdmin = admin;
      firebaseMessaging = admin.messaging();
      console.log('✅ Firebase Admin initialisé avec succès via fichier local.');
    } else {
      console.warn('⚠️ Firebase: Aucune configuration trouvée (ni variable d\'env, ni fichier json). Notifications DÉSACTIVÉES.');
    }
  } catch (error) {
    console.error('❌ Erreur critique lors de l\'initialisation de Firebase:', error.message);
  }
} catch (e) {
  console.warn('⚠️ Firebase Admin SDK non disponible:', e.message);
}
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*", // En production, restreindre aux domaines autorisés
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"]
});

// ─── Active Connections Tracking ─────────────────────────────────────────────
const activeConnections = new Map();

io.on('connection', (socket) => {
  const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
  const platform = socket.handshake.query.platform || 'android';
  
  console.log(`🔌 Client connecté: ID=${socket.id}, IP=${ip}, Platform=${platform}`);

  activeConnections.set(socket.id, {
    id: socket.id,
    ip: ip,
    platform: platform,
    connectedAt: new Date().toISOString()
  });

  // Enregistrer dans l'historique
  db.run('INSERT INTO connection_history (ip_address) VALUES (?)', [ip], (err) => {
    if (err) {
      console.error(`❌ Erreur enregistrement historique connexion pour ${ip}:`, err.message);
    } else {
      console.log(`💾 Connexion de ${ip} enregistrée dans l'historique.`);
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`🔌 Client déconnecté: ID=${socket.id}, Raison=${reason}`);
    activeConnections.delete(socket.id);
  });
});
// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'goldadmin';

// Configuration de la base de données SQLite
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'database.sqlite');

// S'assurer que le dossier parent existe (utile pour les volumes Railway)
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let dbConnected = false;

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Erreur lors de la connexion à la base de données:', err.message);
    dbConnected = false;
  } else {
    dbConnected = true;
    console.log(`Base de données connectée : ${dbPath}`);
    console.log('Connecté à la base de données SQLite (Persistance Activée).');

    // Création de la table gold_prices si elle n'existe pas
    db.run(`CREATE TABLE IF NOT EXISTS gold_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      price REAL NOT NULL,
      currency TEXT DEFAULT 'MAD',
      unit TEXT DEFAULT 'g',
      date DATETIME DEFAULT CURRENT_TIMESTAMP,
      ip_address TEXT,
      username TEXT
    )`, (err) => {
      if (err) {
        console.error('Erreur lors de la création de la table:', err.message);
      } else {
        // Ajouter les colonnes si la table existait déjà sans elles (migration simple)
        db.run(`ALTER TABLE gold_prices ADD COLUMN ip_address TEXT`, () => {});
        db.run(`ALTER TABLE gold_prices ADD COLUMN username TEXT`, () => {});

        // Initialiser avec un prix par défaut si la table est vide
        db.get('SELECT COUNT(*) as count FROM gold_prices', (err, row) => {
          if (row.count === 0) {
            db.run(`INSERT INTO gold_prices (price, currency, unit) VALUES (?, ?, ?)`, [1080.00, 'MAD', 'g']);
          }
        });
      }
    });

    // ── Création de la table FCM tokens ───────────────────────────────────────
    db.run(`CREATE TABLE IF NOT EXISTS fcm_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT UNIQUE NOT NULL,
      device_id TEXT,
      platform TEXT DEFAULT 'android',
      lang TEXT DEFAULT 'ar',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) {
        console.error('Erreur création table fcm_tokens:', err.message);
      } else {
        console.log('Table fcm_tokens prête.');
      }
    });
    // ─────────────────────────────────────────────────────────────────────────

    // ── Création de la table settings ─────────────────────────────────────────
    db.run(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )`, (err) => {
      if (err) {
        console.error('Erreur création table settings:', err.message);
      } else {
        // Initialiser le message de pied de page si vide
        db.get("SELECT value FROM settings WHERE key = 'footer_message'", (err, row) => {
          if (!row) {
            db.run("INSERT INTO settings (key, value) VALUES ('footer_message', '')");
          }
        });
      }
    });
    // ─────────────────────────────────────────────────────────────────────────

    // ── Création de la table users ───────────────────────────────────────────
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      is_superuser INTEGER DEFAULT 0
    )`, (err) => {
      if (err) {
        console.error('Erreur création table users:', err.message);
      } else {
        // Migration: ajouter is_superuser si n'existe pas
        db.run(`ALTER TABLE users ADD COLUMN is_superuser INTEGER DEFAULT 0`, () => {});

        db.get('SELECT COUNT(*) as count FROM users', (err, row) => {
          if (row && row.count === 0) {
            db.run(`INSERT INTO users (username, password, is_active, is_superuser) VALUES (?, ?, ?, ?)`, ['admin', ADMIN_PASSWORD, 1, 1]);
            console.log('Utilisateur admin par défaut (superuser) créé.');
          }
        });
      }
    });

    // ── Création de la table connection_history ──────────────────────────────
    db.run(`CREATE TABLE IF NOT EXISTS connection_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip_address TEXT,
      connected_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    // ─────────────────────────────────────────────────────────────────────────
  }
});

// Middlewares
app.use(cors());
app.use(express.json());
// Middleware de redirection HTTPS (essentiel pour la PWA)
app.use((req, res, next) => {
  if (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] !== 'https' && process.env.NODE_ENV === 'production') {
    return res.redirect('https://' + req.headers.host + req.url);
  }
  next();
});

// Middleware de vérification de la connexion à la base de données
app.use((req, res, next) => {
  if (req.path === '/health') {
    return next();
  }

  if (!dbConnected) {
    res.status(503);
    if (req.path.startsWith('/api/')) {
      return res.json({ error: 'Le site est en maintenance. Veuillez contacter votre administrateur.' });
    }
    return res.send(`
      <!DOCTYPE html>
      <html lang="fr">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Maintenance / صيانة</title>
        <style>
          body {
            background: #0f0f12;
            color: #fff;
            font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            text-align: center;
          }
          .container {
            max-width: 550px;
            padding: 40px;
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid rgba(251, 191, 36, 0.2);
            border-radius: 20px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.7);
            backdrop-filter: blur(12px);
            margin: 20px;
          }
          h1 {
            background: linear-gradient(135deg, #fbbf24, #d97706);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            font-size: 2.2rem;
            margin-bottom: 20px;
            font-weight: 700;
          }
          p {
            color: #cbd5e1;
            font-size: 1.2rem;
            line-height: 1.7;
            margin: 15px 0;
          }
          .icon {
            font-size: 4.5rem;
            margin-bottom: 20px;
            animation: pulse 2s infinite ease-in-out;
          }
          .divider {
            height: 1px;
            background: linear-gradient(90deg, transparent, rgba(251, 191, 36, 0.3), transparent);
            margin: 25px 0;
          }
          @keyframes pulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.05); }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="icon">🥇</div>
          <h1>Site en Maintenance</h1>
          <p dir="rtl" style="font-size: 1.4rem; font-weight: 500;">الموقع في فترة صيانة. يرجى الاتصال بالمسؤول عن النظام.</p>
          <div class="divider"></div>
          <p>Le site est en maintenance. Veuillez contacter votre administrateur.</p>
        </div>
      </body>
      </html>
    `);
  }
  next();
});

// Configuration des fichiers statiques (Frontend)
const clientDistPath = path.resolve(__dirname, './public/dist');
console.log('Serving static files from:', clientDistPath);

app.use(express.static(clientDistPath));

// Routes pour le téléchargement des APK
app.get('/PrixOr.apk', (req, res) => {
  const apkPath = path.resolve(__dirname, './public/PrixOr.apk');
  if (fs.existsSync(apkPath)) {
    res.download(apkPath, 'PrixOr.apk');
  } else {
    // Essayer aussi le nom avec -Client
    const clientPath = path.resolve(__dirname, './public/PrixOr-Client.apk');
    if (fs.existsSync(clientPath)) {
      res.download(clientPath, 'PrixOr.apk');
    } else {
      res.status(404).send('APK Client non trouvé');
    }
  }
});

app.get('/PrixOr-Admin.apk', (req, res) => {
  const apkPath = path.resolve(__dirname, './public/PrixOr-Admin.apk');
  if (fs.existsSync(apkPath)) {
    res.download(apkPath, 'PrixOr-Admin.apk');
  } else {
    res.status(404).send('APK Admin non trouvé');
  }
});

// Route de santé pour vérifier que le serveur est vivant
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Server is running',
    dirname: __dirname,
    staticPath: clientDistPath,
    staticPathExists: fs.existsSync(clientDistPath),
    apkExists: fs.existsSync(path.join(__dirname, './public/PrixOr.apk')),
    filesInPublic: fs.existsSync(path.join(__dirname, './public')) ? fs.readdirSync(path.join(__dirname, './public')) : 'public folder not found'
  });
});

app.get('/', (req, res) => {
  if (fs.existsSync(path.join(clientDistPath, 'index.html'))) {
    res.sendFile(path.join(clientDistPath, 'index.html'));
  } else {
    res.send(`<h1>Serveur PrixOr actif</h1>
              <p>Le dossier site web n'a pas été trouvé, mais le serveur fonctionne.</p>
              <p><a href="/PrixOr.apk" style="padding: 10px 20px; background: gold; color: black; text-decoration: none; font-weight: bold; border-radius: 5px;">Télécharger l'APK directement ici</a></p>
              <hr>
              <p>Diagnostic: ${clientDistPath}</p>`);
  }
});

// ── API: Enregistrer un token FCM ─────────────────────────────────────────────
app.post('/api/fcm/register', (req, res) => {
  const { token, deviceId, platform = 'android', lang = 'ar' } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'Token FCM manquant' });
  }

  const now = new Date().toISOString();
  db.run(
    `INSERT INTO fcm_tokens (token, device_id, platform, lang, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET last_seen = ?, device_id = ?, lang = ?, platform = ?`,
    [token, deviceId || null, platform, lang, now, now, now, deviceId || null, lang, platform],
    function (err) {
      if (err) {
        console.error('Erreur enregistrement token FCM:', err.message);
        return res.status(500).json({ error: err.message });
      }
      console.log(`📱 Token FCM enregistré: ${token.slice(0, 20)}...`);
      res.json({ success: true, message: 'Token enregistré' });
    }
  );
});

// ── API: Supprimer un token FCM (désinscription) ──────────────────────────────
app.post('/api/fcm/unregister', (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'Token manquant' });
  }
  db.run('DELETE FROM fcm_tokens WHERE token = ?', [token], function (err) {
    if (err) {
      console.error(`❌ Erreur lors de la désinscription du token FCM:`, err.message);
      return res.status(500).json({ error: err.message });
    }
    console.log(`🗑️ Token FCM désinscrit: ${token.slice(0, 20)}... (lignes affectées: ${this.changes})`);
    res.json({ success: true });
  });
});

// ── API: Nombre de devices enregistrés (pour l'admin) ────────────────────────
app.get('/api/fcm/count', (req, res) => {
  db.get('SELECT COUNT(*) as count FROM fcm_tokens', (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ count: row.count });
  });
});

// ── Fonction utilitaire: Envoyer notification FCM à tous les devices ──────────
async function sendPriceNotification(priceData) {
  if (!firebaseMessaging) return;

  db.all('SELECT token, lang FROM fcm_tokens', async (err, rows) => {
    if (err || !rows || rows.length === 0) return;

    const price = Math.floor(priceData.price);

    // Group tokens by language
    const langGroups = rows.reduce((acc, row) => {
      const l = row.lang || 'ar';
      if (!acc[l]) acc[l] = [];
      acc[l].push(row.token);
      return acc;
    }, {});

    const translations = {
      ar: { title: '🥇 سعر جديد للذهب', body: `سعر الذهب الآن هو ${price} درهم/غرام` },
      fr: { title: '🥇 Nouveau prix de l\'or', body: `Le prix de l'or est maintenant ${price} MAD/g` },
      en: { title: '🥇 New Gold Price', body: `Gold price is now ${price} MAD/g` },
      es: { title: '🥇 Nuevo precio del oro', body: `El precio del oro es ahora ${price} MAD/g` }
    };

    for (const [lang, tokens] of Object.entries(langGroups)) {
      const t = translations[lang] || translations['ar'];

      const message = {
        notification: {
          title: t.title,
          body: t.body,
        },
        data: {
          price: String(priceData.price),
          currency: priceData.currency || 'MAD',
          unit: priceData.unit || 'g',
          date: priceData.date || new Date().toISOString(),
          type: 'priceUpdate',
        },
        android: {
          priority: 'high',
          notification: {
            channelId: 'gold_price_updates',
            color: '#fbbf24',
            icon: 'ic_notification',
            sound: 'default',
          },
        },
        tokens: tokens,
      };

      try {
        const response = await firebaseMessaging.sendEachForMulticast(message);
        console.log(`📲 Notifications [${lang}] envoyées: ${response.successCount}/${tokens.length} succès`);

        // Clean invalid tokens
        if (response.failureCount > 0) {
          const tokensToDelete = [];
          response.responses.forEach((resp, idx) => {
            if (!resp.success) {
              const code = resp.error && resp.error.code;
              if (code === 'messaging/invalid-registration-token' || code === 'messaging/registration-token-not-registered') {
                tokensToDelete.push(tokens[idx]);
              }
            }
          });
          if (tokensToDelete.length > 0) {
            const placeholders = tokensToDelete.map(() => '?').join(',');
            db.run(`DELETE FROM fcm_tokens WHERE token IN (${placeholders})`, tokensToDelete);
          }
        }
      } catch (fcmErr) {
        console.error(`Erreur envoi FCM [${lang}]:`, fcmErr.message);
      }
    }
  });
}
// ─────────────────────────────────────────────────────────────────────────────

// Obtenir le prix actuel
app.get('/api/price', (req, res) => {
  db.get('SELECT * FROM gold_prices ORDER BY id DESC LIMIT 1', (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(row || { price: 0, currency: 'MAD', unit: 'g' });
  });
});

// Obtenir l'historique des prix
app.get('/api/price/history', (req, res) => {
  const { period = 'week' } = req.query;
  let days = 7;
  if (period === 'month') days = 30;

  const dateLimit = new Date();
  dateLimit.setDate(dateLimit.getDate() - days);
  const isoLimit = dateLimit.toISOString();

  db.all('SELECT price, date, ip_address, username FROM gold_prices WHERE date >= ? ORDER BY date ASC', [isoLimit], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// ── API: Dashboard Stats (Admin) ──────────────────────────────────────────────
app.get('/api/dashboard/stats', (req, res) => {
  const { username, password } = req.query;
  
  db.get('SELECT * FROM users WHERE username = ? AND password = ? AND is_active = 1', [username, password], (err, admin) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!admin) return res.status(401).json({ error: 'Non autorisé' });

    // 1. Get FCM Tokens by platform
    db.all('SELECT platform, COUNT(*) as count FROM fcm_tokens GROUP BY platform', (err, platformRows) => {
      if (err) return res.status(500).json({ error: err.message });
      
      let androidCount = 0;
      let iosCount = 0;
      
      platformRows.forEach(row => {
        if (row.platform && row.platform.toLowerCase() === 'ios') iosCount = row.count;
        else androidCount += row.count; // Default to android
      });

      // 2. Get Recent Price Changes
      db.all('SELECT id, price, date, ip_address, username FROM gold_prices ORDER BY id DESC LIMIT 50', (err, priceRows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        // 3. Get Recent Connection History
        db.all('SELECT id, ip_address, connected_at FROM connection_history ORDER BY id DESC LIMIT 100', (err, connHistoryRows) => {
          if (err) return res.status(500).json({ error: err.message });

          res.json({
            activeConnections: Array.from(activeConnections.values()),
            connectionHistory: connHistoryRows,
            installations: {
              android: androidCount,
              ios: iosCount,
              total: androidCount + iosCount
            },
            priceHistory: priceRows
          });
        });
      });
    });
  });
});
// ─────────────────────────────────────────────────────────────────────────────

// Mettre à jour le prix (Nécessite authentification)
app.post('/api/price', (req, res) => {
  const { username, password, price, newPrice, currency = 'MAD', unit = 'g' } = req.body;

  if (!username || !password) {
    return res.status(401).json({ error: "Nom d'utilisateur et mot de passe requis" });
  }

  db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (err, user) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!user) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }
    if (user.is_active !== 1) {
      return res.status(403).json({ error: 'Ce compte utilisateur est désactivé' });
    }

    const finalPrice = price || newPrice;
    if (!finalPrice || isNaN(finalPrice)) {
      return res.status(400).json({ error: 'Prix invalide' });
    }

    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
    const currentDate = new Date().toISOString();
    
    db.run(`INSERT INTO gold_prices (price, currency, unit, date, ip_address, username) VALUES (?, ?, ?, ?, ?, ?)`, 
      [finalPrice, currency, unit, currentDate, ipAddress, user.username], 
      function (err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      const newRecord = {
        id: this.lastID,
        price: parseFloat(finalPrice),
        currency,
        unit,
        date: currentDate,
        ip_address: ipAddress,
        username: user.username
      };

      console.log(`💰 Nouveau prix de l'or enregistré par ${user.username} : ${finalPrice} ${currency}/${unit} (${ipAddress})`);

      // 1. Émettre le nouveau prix à tous les clients connectés via WebSockets
      io.emit('priceUpdate', newRecord);

      // 2. Envoyer notification push FCM à tous les appareils Android enregistrés
      sendPriceNotification(newRecord);

      res.json({ success: true, data: newRecord });
    });
  });
});

// ── API: Sauvegarde locale de la base de données ─────────────────────────────
app.post('/api/backup', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(401).json({ error: "Nom d'utilisateur et mot de passe requis" });
  }

  db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (err, user) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!user || user.is_active !== 1) {
      return res.status(401).json({ error: 'Identifiants incorrects ou compte désactivé' });
    }

    const targetBackupPath = '/app/data/database.sqlite';
    const targetBackupDir = path.dirname(targetBackupPath);

    try {
      if (!fs.existsSync(targetBackupDir)) {
        fs.mkdirSync(targetBackupDir, { recursive: true });
      }

      const resolvedDbPath = path.resolve(dbPath);
      const resolvedBackupPath = path.resolve(targetBackupPath);

      let actualBackupPath = resolvedBackupPath;
      if (resolvedDbPath === resolvedBackupPath) {
        actualBackupPath = resolvedBackupPath + '.bak';
      }

      fs.copyFileSync(resolvedDbPath, actualBackupPath);
      console.log(`💾 Base de données sauvegardée avec succès sous ${actualBackupPath}`);

      res.json({ 
        success: true, 
        message: `Base de données sauvegardée avec succès sous ${actualBackupPath.replace(/\\/g, '/')}`,
        path: actualBackupPath 
      });
    } catch (copyErr) {
      console.error('Erreur lors de la sauvegarde de la base de données:', copyErr.message);
      res.status(500).json({ error: `Erreur lors de la sauvegarde: ${copyErr.message}` });
    }
  });
});

// ── API: Télécharger la base de données active ────────────────────────────────
app.get('/api/backup/download', (req, res) => {
  const { username, password } = req.query;

  if (!username || !password) {
    return res.status(401).json({ error: "Nom d'utilisateur et mot de passe requis" });
  }

  db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (err, user) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!user || user.is_active !== 1) {
      return res.status(401).json({ error: 'Identifiants incorrects ou compte désactivé' });
    }

    const resolvedDbPath = path.resolve(dbPath);
    if (!fs.existsSync(resolvedDbPath)) {
      return res.status(404).json({ error: "Fichier de base de données introuvable" });
    }

    res.download(resolvedDbPath, 'database.sqlite', (err) => {
      if (err) {
        console.error('Erreur lors du téléchargement du fichier de base de données:', err.message);
        if (!res.headersSent) {
          res.status(500).json({ error: `Erreur lors du téléchargement: ${err.message}` });
        }
      }
    });
  });
});

// ── API: Modifier un prix existant ───────────────────────────────────────────
app.put('/api/price/:id', (req, res) => {
  const { username, password, price } = req.body;
  const targetId = req.params.id;

  if (!username || !password) {
    return res.status(401).json({ error: "Nom d'utilisateur et mot de passe requis" });
  }

  db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (err, user) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!user || user.is_active !== 1) {
      return res.status(401).json({ error: 'Identifiants incorrects ou compte désactivé' });
    }

    if (price === undefined || isNaN(price)) {
      return res.status(400).json({ error: 'Prix invalide' });
    }

    db.run('UPDATE gold_prices SET price = ? WHERE id = ?', [price, targetId], function (err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Prix non trouvé' });
      }

      console.log(`✏️ Prix ID ${targetId} modifié par ${user.username} : nouveau prix = ${price}`);

      // Vérifier si c'est le dernier prix inséré (actuel) pour notifier les clients
      db.get('SELECT * FROM gold_prices ORDER BY id DESC LIMIT 1', (err, latestPrice) => {
        if (!err && latestPrice && latestPrice.id === parseInt(targetId, 10)) {
          io.emit('priceUpdate', latestPrice);
        }
      });

      res.json({ success: true, message: 'Prix modifié avec succès' });
    });
  });
});

// ── API: Supprimer un prix existant ──────────────────────────────────────────
app.delete('/api/price/:id', (req, res) => {
  const { username, password } = req.body;
  const targetId = req.params.id;

  if (!username || !password) {
    return res.status(401).json({ error: "Nom d'utilisateur et mot de passe requis" });
  }

  db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (err, user) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!user || user.is_active !== 1) {
      return res.status(401).json({ error: 'Identifiants incorrects ou compte désactivé' });
    }

    // Récupérer le dernier prix avant suppression pour vérifier si on supprime le prix actuel
    db.get('SELECT id FROM gold_prices ORDER BY id DESC LIMIT 1', (err, latestBeforeDelete) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      db.run('DELETE FROM gold_prices WHERE id = ?', [targetId], function (err) {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
          return res.status(404).json({ error: 'Prix non trouvé' });
        }

        console.log(`🗑️ Prix ID ${targetId} supprimé par ${user.username}`);

        // Si le prix supprimé était le plus récent, on émet le nouveau prix actuel
        if (latestBeforeDelete && latestBeforeDelete.id === parseInt(targetId, 10)) {
          db.get('SELECT * FROM gold_prices ORDER BY id DESC LIMIT 1', (err, newLatest) => {
            if (!err) {
              io.emit('priceUpdate', newLatest || { price: 0, currency: 'MAD', unit: 'g' });
            }
          });
        }

        res.json({ success: true, message: 'Prix supprimé avec succès' });
      });
    });
  });
});

// ── API: Gestion des utilisateurs ─────────────────────────────────────────────
// ── API: Paramètres (Message de pied de page) ───────────────────────────────
app.get('/api/settings/footer', (req, res) => {
  db.get("SELECT value FROM settings WHERE key = 'footer_message'", (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: row ? row.value : '' });
  });
});

app.post('/api/settings/footer', (req, res) => {
  const { username, password, message } = req.body;
  
  db.get('SELECT * FROM users WHERE username = ? AND password = ? AND is_active = 1', [username, password], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(401).json({ error: 'Non autorisé' });

    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('footer_message', ?)", [message], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      
      // Émettre le changement via WebSockets
      io.emit('settingsUpdate', { key: 'footer_message', value: message });
      
      res.json({ success: true });
    });
  });
});
// ─────────────────────────────────────────────────────────────────────────────

// ── API: Liste des prix pour administration (avec ID) ───────────────────────
app.get('/api/admin/prices', (req, res) => {
  const { username, password } = req.query;
  db.get('SELECT * FROM users WHERE username = ? AND password = ? AND is_active = 1', [username, password], (err, admin) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!admin) return res.status(401).json({ error: 'Non autorisé' });

    db.all('SELECT id, price, currency, unit, date, ip_address, username FROM gold_prices ORDER BY id DESC LIMIT 500', (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  });
});

app.get('/api/users', (req, res) => {
  const { username, password } = req.query;
  db.get('SELECT * FROM users WHERE username = ? AND password = ? AND is_active = 1', [username, password], (err, admin) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!admin) return res.status(401).json({ error: 'Non autorisé' });

    db.all('SELECT id, username, is_active, is_superuser FROM users ORDER BY id ASC', (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  });
});

app.post('/api/users', (req, res) => {
  const { adminUser, adminPass, newUsername, newPassword, isActive } = req.body;
  db.get('SELECT * FROM users WHERE username = ? AND password = ? AND is_active = 1', [adminUser, adminPass], (err, admin) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!admin) return res.status(401).json({ error: 'Non autorisé' });

    if (!newUsername || !newPassword) return res.status(400).json({ error: 'Données manquantes' });

    const isNewSuper = req.body.isSuperUser ? 1 : 0;

    db.run('INSERT INTO users (username, password, is_active, is_superuser) VALUES (?, ?, ?, ?)', [newUsername, newPassword, isActive ? 1 : 0, isNewSuper], function(err) {
      if (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
          return res.status(400).json({ error: "Ce nom d'utilisateur existe déjà" });
        }
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true, id: this.lastID });
    });
  });
});

app.put('/api/users/:id', (req, res) => {
  const { adminUser, adminPass, username, password, isActive } = req.body;
  const targetId = req.params.id;

  db.get('SELECT * FROM users WHERE username = ? AND password = ? AND is_active = 1', [adminUser, adminPass], (err, requester) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!requester) return res.status(401).json({ error: 'Non autorisé' });

    // Vérifier si la cible est un superuser
    db.get('SELECT is_superuser FROM users WHERE id = ?', [targetId], (err, target) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!target) return res.status(404).json({ error: 'Utilisateur non trouvé' });

      // Règle de sécurité : Seul un superuser peut modifier un autre superuser (incluant son mot de passe)
      if (target.is_superuser === 1 && requester.is_superuser !== 1) {
        return res.status(403).json({ error: 'Seul un Super Utilisateur peut modifier un compte administrateur principal.' });
      }

      // Construire la requête de mise à jour dynamiquement
      let query = 'UPDATE users SET is_active = ?';
      let params = [isActive !== undefined ? (isActive ? 1 : 0) : target.is_active];

      if (username) {
        query += ', username = ?';
        params.push(username);
      }
      if (password) {
        query += ', password = ?';
        params.push(password);
      }
      
      // Permettre de changer le rang superuser seulement si le demandeur est superuser
      if (req.body.isSuperUser !== undefined && requester.is_superuser === 1) {
        query += ', is_superuser = ?';
        params.push(req.body.isSuperUser ? 1 : 0);
      }

      query += ' WHERE id = ?';
      params.push(targetId);

      db.run(query, params, function(err) {
        if (err) {
          if (err.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: "Ce nom d'utilisateur est déjà utilisé" });
          }
          return res.status(500).json({ error: err.message });
        }
        res.json({ success: true });
      });
    });
  });
});

function getCasablancaOffsetHours() {
  const date = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Casablanca',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false
  });
  const parts = formatter.formatToParts(date);
  const getVal = (type) => parseInt(parts.find(p => p.type === type).value, 10);
  const year = getVal('year');
  const month = getVal('month') - 1;
  const day = getVal('day');
  let hour = getVal('hour');
  if (hour === 24) hour = 0;
  const minute = getVal('minute');
  const second = getVal('second');
  const casaUtcTime = Date.UTC(year, month, day, hour, minute, second);
  const actualUtcTime = date.getTime();
  const diffMs = casaUtcTime - actualUtcTime;
  return Math.round(diffMs / (1000 * 60 * 60));
}

// ── API: Connection Stats (Graphs) ──────────────────────────────────────────
app.get('/api/dashboard/connection-stats', (req, res) => {
  const { username, password } = req.query;
  
  db.get('SELECT * FROM users WHERE username = ? AND password = ? AND is_active = 1', [username, password], (err, admin) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!admin) return res.status(401).json({ error: 'Non autorisé' });

    const offset = getCasablancaOffsetHours();
    const offsetSign = offset >= 0 ? '+' : '-';
    const offsetStr = `${offsetSign}${Math.abs(offset)} hours`;
    const negOffsetStr = `${offset >= 0 ? '-' : '+'}${Math.abs(offset)} hours`;

    const runQuery = (sql) => new Promise((resolve, reject) => {
      db.all(sql, [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    const hourlySql = `
      SELECT strftime('%H:00', datetime(connected_at, '${offsetStr}')) as label, COUNT(*) as count 
      FROM connection_history 
      WHERE connected_at >= datetime('now', '${offsetStr}', 'start of day', '${negOffsetStr}')
      GROUP BY label ORDER BY label ASC`;
    
    const dailySql = `
      SELECT strftime('%Y-%m-%d', datetime(connected_at, '${offsetStr}')) as label, COUNT(*) as count 
      FROM connection_history 
      WHERE connected_at >= datetime('now', '${offsetStr}', '-30 days', 'start of day', '${negOffsetStr}')
      GROUP BY label ORDER BY label ASC`;

    const weeklySql = `
      SELECT strftime('%Y-W%W', datetime(connected_at, '${offsetStr}')) as label, COUNT(*) as count 
      FROM connection_history 
      WHERE connected_at >= datetime('now', '${offsetStr}', '-84 days', 'start of day', '${negOffsetStr}')
      GROUP BY label ORDER BY label ASC`;

    const monthlySql = `
      SELECT strftime('%Y-%m', datetime(connected_at, '${offsetStr}')) as label, COUNT(*) as count 
      FROM connection_history 
      WHERE connected_at >= datetime('now', '${offsetStr}', '-12 months', 'start of day', '${negOffsetStr}')
      GROUP BY label ORDER BY label ASC`;

    Promise.all([
      runQuery(hourlySql),
      runQuery(dailySql),
      runQuery(weeklySql),
      runQuery(monthlySql)
    ]).then(([hourlyRows, daily, weekly, monthly]) => {
      // Pre-populate hourly stats from 00:00 up to current Casablanca hour
      let currentHour = parseInt(new Intl.DateTimeFormat('en-US', { 
        timeZone: 'Africa/Casablanca', 
        hour: 'numeric', 
        hour12: false 
      }).format(new Date()), 10);
      if (currentHour === 24) currentHour = 0;

      const hourlyDataMap = new Map();
      for (let h = 0; h <= currentHour; h++) {
        const hourStr = String(h).padStart(2, '0') + ':00';
        hourlyDataMap.set(hourStr, 0);
      }

      hourlyRows.forEach(row => {
        if (hourlyDataMap.has(row.label)) {
          hourlyDataMap.set(row.label, row.count);
        }
      });

      const hourly = Array.from(hourlyDataMap.entries()).map(([label, count]) => ({ label, count }));

      res.json({ hourly, daily, weekly, monthly });
    }).catch(err => {
      res.status(500).json({ error: err.message });
    });
  });
});
// ─────────────────────────────────────────────────────────────────────────────


// Route Fallback pour les applications React (SPA)
app.use((req, res) => {
  res.sendFile(path.join(clientDistPath, 'index.html'));
});

// Lancement du serveur
server.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});