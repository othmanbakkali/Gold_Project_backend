const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();

// ✅ middleware
app.use(cors());
app.use(express.json());

// ✅ Fichier de persistance
const DATA_FILE = path.join(__dirname, "prices.json");

// ✅ Charger les données depuis le fichier
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf-8");
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error("Erreur lecture fichier:", e);
  }
  return { current: { price: 100, date: new Date().toISOString() }, history: [] };
}

// ✅ Sauvegarder les données dans le fichier
function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.error("Erreur écriture fichier:", e);
  }
}

// ✅ Charger au démarrage
let store = loadData();

// ✅ route test
app.get("/", (req, res) => {
  res.send("Backend is running 🚀");
});

// ✅ GET prix actuel
app.get("/api/price", (req, res) => {
  res.json(store.current);
});

// ✅ GET historique des prix
app.get("/api/price/history", (req, res) => {
  const period = req.query.period || "week";
  const now = new Date();
  const cutoff = new Date(now);

  if (period === "month") {
    cutoff.setMonth(cutoff.getMonth() - 1);
  } else {
    cutoff.setDate(cutoff.getDate() - 7);
  }

  const filtered = store.history.filter(entry => {
    return new Date(entry.date) >= cutoff;
  });

  res.json(filtered);
});

// ✅ POST update price
app.post("/api/price", (req, res) => {
  console.log("BODY:", req.body);

  const newPrice = req.body.newPrice ?? req.body.price;

  // 🔐 sécurité simple
  const ADMIN_PASSWORD = "goldadmin";
  if (req.body.password !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  if (newPrice === undefined || isNaN(newPrice)) {
    return res.status(400).json({ error: "Invalid price" });
  }

  const now = new Date().toISOString();

  // ✅ Mettre à jour le prix actuel
  store.current = { price: parseFloat(newPrice), date: now };

  // ✅ Ajouter à l'historique
  store.history.push({ price: parseFloat(newPrice), date: now });

  // ✅ Sauvegarder sur disque
  saveData(store);

  // ✅ Émettre via Socket.IO
  io.emit("priceUpdate", store.current);

  res.json({
    success: true,
    data: store.current
  });
});

// ✅ serveur HTTP
const server = http.createServer(app);

// ✅ Socket.IO
const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

io.on("connection", (socket) => {
  console.log("Client connecté");
  socket.emit("priceUpdate", store.current);
});

// ✅ PORT
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});