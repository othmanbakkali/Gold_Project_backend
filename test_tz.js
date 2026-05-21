const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.sqlite');

const offset = 1; // Casablanca offset
const offsetSign = offset >= 0 ? '+' : '-';
const offsetStr = `${offsetSign}${Math.abs(offset)} hours`;
const negOffsetStr = `${offset >= 0 ? '-' : '+'}${Math.abs(offset)} hours`;

// Let's test SQLite timezone query
db.all(`
  SELECT datetime('now', '${offsetStr}', 'start of day', '${negOffsetStr}') as start_of_day_utc
`, [], (err, rows) => {
  console.log("Result:", err || rows);
  db.close();
});
