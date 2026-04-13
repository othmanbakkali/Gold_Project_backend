const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const app = express();

// ✅ middleware
app.use(cors());
app.use(express.json());

// ✅ route test
app.get("/", (req, res) => {
  res.send("Backend is running 🚀");
});

// ✅ variable globale
let price = 100;

// ✅ GET price
app.get("/api/price", (req, res) => {
  res.json({ price });
});

// ✅ POST update price
app.post("/api/price", (req, res) => {
  console.log("BODY:", req.body);

  // ✅ accepte les deux formats
  const newPrice = req.body.newPrice ?? req.body.price;

  // 🔐 sécurité simple (optionnel)
  const ADMIN_PASSWORD = "goldadmin"; // change ça !
  if (req.body.password !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  if (newPrice === undefined || isNaN(newPrice)) {
    return res.status(400).json({ error: "Invalid price" });
  }

  price = newPrice;

  io.emit("priceUpdate", { price });

  res.json({ success: true, price });
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
  socket.emit("priceUpdate", { price });
});

// ✅ simulation (optionnel)


// ✅ PORT
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});