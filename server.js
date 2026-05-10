const express = require('express');
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
  
  // 2. Sinon, essayer de charger le fichier local (Développement)
  if (!serviceAccount) {
    try {
      serviceAccount = require('./firebase-service-account.json');
      console.log('🏠 Firebase: Chargement via fichier local.');
    } catch (fileErr) {
      // Le fichier n'existe pas ou erreur de lecture
    }
  }

  if (serviceAccount && serviceAccount.project_id && serviceAccount.project_id !== 'VOTRE_PROJECT_ID') {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    firebaseAdmin = admin;
    firebaseMessaging = admin.messaging();
    console.log('✅ Firebase Admin SDK initialisé avec succès.');
  } else {
    console.warn('⚠️  Configuration Firebase manquante ou invalide. Notifications DÉSACTIVÉES.');
  }
} catch (e) {
  console.warn('⚠️  Firebase Admin SDK non disponible:', e.message);
}
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*", // En production, restreindre aux domaines autorisés
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'goldadmin';

// Configuration de la base de données SQLite
const db = new sqlite3.Database(path.join(__dirname, 'database.sqlite'), (err) => {
  if (err) {
    console.error('Erreur lors de la connexion à la base de données:', err.message);
  } else {
    console.log('Connecté à la base de données SQLite.');
    
    // Création de la table gold_prices si elle n'existe pas
    db.run(`CREATE TABLE IF NOT EXISTS gold_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      price REAL NOT NULL,
      currency TEXT DEFAULT 'MAD',
      unit TEXT DEFAULT 'g',
      date DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) {
        console.error('Erreur lors de la création de la table:', err.message);
      } else {
        // Initialiser avec un prix par défaut si la table est vide
        db.get('SELECT COUNT(*) as count FROM gold_prices', (err, row) => {
          if (row.count === 0) {
            db.run(`INSERT INTO gold_prices (price, currency, unit) VALUES (?, ?, ?)`, [650.00, 'MAD', 'g']);
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
  }
});

// Middlewares
app.use(cors());
app.use(express.json());

// Configuration des fichiers statiques (Frontend)
const clientDistPath = path.resolve(__dirname, '../client/dist');
console.log('Serving static files from:', clientDistPath);

app.use(express.static(clientDistPath));

// Route de santé pour vérifier que le serveur est vivant
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Server is running', 
    staticPath: clientDistPath,
    apkExists: fs.existsSync(path.join(clientDistPath, 'PrixOr.apk'))
  });
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
     ON CONFLICT(token) DO UPDATE SET last_seen = ?, device_id = ?, lang = ?`,
    [token, deviceId || null, platform, lang, now, now, now, deviceId || null, lang],
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
      return res.status(500).json({ error: err.message });
    }
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

  db.all('SELECT price, date FROM gold_prices WHERE date >= ? ORDER BY date ASC', [isoLimit], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Mettre à jour le prix (Nécessite authentification)
app.post('/api/price', (req, res) => {
  const { password, price, newPrice, currency = 'MAD', unit = 'g' } = req.body;
  
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }

  const finalPrice = price || newPrice;
  if (!finalPrice || isNaN(finalPrice)) {
    return res.status(400).json({ error: 'Prix invalide' });
  }

  const currentDate = new Date().toISOString();
  db.run(`INSERT INTO gold_prices (price, currency, unit, date) VALUES (?, ?, ?, ?)`, [finalPrice, currency, unit, currentDate], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    const newRecord = {
      id: this.lastID,
      price: parseFloat(finalPrice),
      currency,
      unit,
      date: currentDate
    };

    // 1. Émettre le nouveau prix à tous les clients connectés via WebSockets
    io.emit('priceUpdate', newRecord);

    // 2. Envoyer notification push FCM à tous les appareils Android enregistrés
    sendPriceNotification(newRecord);
    
    res.json({ success: true, data: newRecord });
  });
});

// Route Fallback pour les applications React (SPA)
app.use((req, res) => {
  res.sendFile(path.join(__dirname, '../client/dist', 'index.html'));
});

// Lancement du serveur
server.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});