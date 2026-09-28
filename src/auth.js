import { Router } from "express";
import bcrypt from "bcrypt";
import cryptoRandomString from "crypto-random-string";
import { stmts } from "./db.js";

const SALT_ROUNDS = 12;
const SESSION_TTL = 30 * 24 * 60 * 60;
const RESET_TTL = 60 * 60;
const TOKEN_LENGTH = 48;
const COOKIE_NAME = "umbrella_session";

function genToken() {
  return cryptoRandomString({ length: TOKEN_LENGTH, type: "url-safe" });
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development",
    sameSite: "lax",
    maxAge: SESSION_TTL * 1000,
    path: "/",
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

const USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(username, email, password) {
  const errors = [];
  if (!USERNAME_RE.test(username))
    errors.push("username must be 3-24 chars, letters/numbers/underscores only");
  if (!EMAIL_RE.test(email)) errors.push("invalid email");
  if (!password || password.length < 8) errors.push("password must be at least 8 characters");
  if (password && password.length > 128) errors.push("password too long");
  return errors;
}

export function authMiddleware(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (token) {
    const session = stmts.findSession.get(token);
    if (session) {
      req.user = { id: session.uid, username: session.username, email: session.email };
    }
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "not logged in" });
  next();
}

export function createAuthRouter() {
  const router = Router();
  router.use(express_json_middleware());

  router.post("/signup", async (req, res) => {
    const { username, email, password } = req.body || {};
    const errors = validate(username || "", email || "", password || "");
    if (errors.length) return res.status(400).json({ error: errors[0] });

    if (stmts.findByUsername.get(username))
      return res.status(409).json({ error: "username already taken" });
    if (stmts.findByEmail.get(email))
      return res.status(409).json({ error: "email already registered" });

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = stmts.createUser.run(username, email, hash);
    const token = genToken();
    stmts.createSession.run(token, result.lastInsertRowid, Math.floor(Date.now() / 1000) + SESSION_TTL);
    setSessionCookie(res, token);
    res.json({ ok: true, user: { id: result.lastInsertRowid, username, email } });
  });

  router.post("/login", async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password)
      return res.status(400).json({ error: "username and password required" });

    const user = stmts.findByUsername.get(username) || stmts.findByEmail.get(username);
    if (!user) return res.status(401).json({ error: "invalid username or password" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: "invalid username or password" });

    const token = genToken();
    stmts.createSession.run(token, user.id, Math.floor(Date.now() / 1000) + SESSION_TTL);
    setSessionCookie(res, token);
    res.json({ ok: true, user: { id: user.id, username: user.username, email: user.email } });
  });

  router.post("/logout", (req, res) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (token) stmts.deleteSession.run(token);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get("/me", (req, res) => {
    if (!req.user) return res.json({ user: null });
    res.json({ user: req.user });
  });

  router.post("/forgot-password", (req, res) => {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: "email required" });

    const user = stmts.findByEmail.get(email);
    res.json({ ok: true, message: "if that email exists, a reset link has been generated" });
    if (!user) return;

    const token = genToken();
    stmts.createReset.run(token, user.id, Math.floor(Date.now() / 1000) + RESET_TTL);
    console.log(`[umbrella] password reset token for ${user.username}: ${token}`);
    console.log(`[umbrella] reset link: /reset-password?token=${token}`);
  });

  router.post("/reset-password", async (req, res) => {
    const { token, password } = req.body || {};
    if (!token || !password)
      return res.status(400).json({ error: "token and new password required" });
    if (password.length < 8)
      return res.status(400).json({ error: "password must be at least 8 characters" });
    if (password.length > 128)
      return res.status(400).json({ error: "password too long" });

    const reset = stmts.findReset.get(token);
    if (!reset) return res.status(400).json({ error: "invalid or expired reset token" });

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    stmts.updatePassword.run(hash, reset.user_id);
    stmts.markResetUsed.run(token);
    stmts.deleteUserSessions.run(reset.user_id);
    res.json({ ok: true, message: "password reset successfully" });
  });

  router.post("/change-password", requireAuth, async (req, res) => {
    const { current, password } = req.body || {};
    if (!current || !password)
      return res.status(400).json({ error: "current and new password required" });
    if (password.length < 8)
      return res.status(400).json({ error: "new password must be at least 8 characters" });
    if (password.length > 128)
      return res.status(400).json({ error: "password too long" });

    const user = stmts.findByUsername.get(req.user.username);
    const ok = await bcrypt.compare(current, user.password);
    if (!ok) return res.status(401).json({ error: "current password is incorrect" });

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    stmts.updatePassword.run(hash, user.id);
    stmts.deleteUserSessions.run(user.id);

    const token = genToken();
    stmts.createSession.run(token, user.id, Math.floor(Date.now() / 1000) + SESSION_TTL);
    setSessionCookie(res, token);
    res.json({ ok: true, message: "password changed" });
  });

  return router;
}

function express_json_middleware() {
  return (req, res, next) => {
    if (req.is("json") || req.is("application/json")) {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1e6) {
          req.destroy();
          return;
        }
      });
      req.on("end", () => {
        try {
          req.body = JSON.parse(body);
        } catch {
          req.body = {};
        }
        next();
      });
    } else {
      next();
    }
  };
}
