const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());

app.get("/api/price", (req, res) => {
  res.json({ price: 100 });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log("Server running"));