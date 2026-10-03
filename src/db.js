import Database from "better-sqlite3";
import path from "node:path";
import { ROOT } from "./config.js";

const DB_PATH = process.env.DB_PATH || path.join(ROOT, "data", "umbrella.db");

import fs from "node:fs";
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH, { fileMustExist: false });

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id);
  CREATE INDEX IF NOT EXISTS idx_resets_expires ON password_resets(expires_at);
`);

const stmts = {
  createUser: db.prepare(
    "INSERT INTO users (username, email, password) VALUES (?, ?, ?)"
  ),
  findByUsername: db.prepare("SELECT * FROM users WHERE username = ?"),
  findByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
  findById: db.prepare("SELECT id, username, email, created_at FROM users WHERE id = ?"),
  updatePassword: db.prepare(
    "UPDATE users SET password = ?, updated_at = unixepoch() WHERE id = ?"
  ),

  createSession: db.prepare(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)"
  ),
  findSession: db.prepare(
    "SELECT s.*, u.id as uid, u.username, u.email FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > unixepoch()"
  ),
  deleteSession: db.prepare("DELETE FROM sessions WHERE token = ?"),
  deleteUserSessions: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
  cleanExpiredSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= unixepoch()"),

  createReset: db.prepare(
    "INSERT INTO password_resets (token, user_id, expires_at) VALUES (?, ?, ?)"
  ),
  findReset: db.prepare(
    "SELECT * FROM password_resets WHERE token = ? AND expires_at > unixepoch() AND used = 0"
  ),
  markResetUsed: db.prepare("UPDATE password_resets SET used = 1 WHERE token = ?"),
  cleanExpiredResets: db.prepare(
    "DELETE FROM password_resets WHERE expires_at <= unixepoch() OR used = 1"
  ),
};

setInterval(() => {
  stmts.cleanExpiredSessions.run();
  stmts.cleanExpiredResets.run();
}, 60 * 60 * 1000).unref();

export { db, stmts };
