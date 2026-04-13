const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
app.use(cors());

// ✅ route test (IMPORTANT)
app.get("/", (req, res) => {
  res.send("Backend is running 🚀");
});

// ✅ API
let price = 100;

app.get("/api/price", (req, res) => {
  res.json({ price });
});

// ✅ créer serveur HTTP
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

// ✅ simulation temps réel
setInterval(() => {
  price = price + (Math.random() * 2 - 1);

  io.emit("priceUpdate", {
    price: Number(price.toFixed(2))
  });
}, 5000);

// ✅ PORT Render
const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});