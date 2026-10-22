
const SESSION_SECONDS = 8 * 60 * 60;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers
    }
  });
}

const encoder = new TextEncoder();

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(value))
  );
}

async function createSession(secret) {
  const payload = base64url(encoder.encode(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS
  })));
  return payload + "." + base64url(await sign(payload, secret));
}

async function validSession(request, secret) {
  if (!secret) return false;

  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)zar_admin=([A-Za-z0-9_.-]+)/);
  if (!match) return false;

  const parts = match[1].split(".");
  if (parts.length !== 2) return false;

  try {
    const expected = await sign(parts[0], secret);
    const supplied = fromBase64url(parts[1]);
    if (expected.length !== supplied.length) return false;

    let difference = 0;
    for (let i = 0; i < expected.length; i++) {
      difference |= expected[i] ^ supplied[i];
    }
    if (difference !== 0) return false;

    const payload = JSON.parse(
      new TextDecoder().decode(fromBase64url(parts[0]))
    );
    return Number.isInteger(payload.exp) &&
      payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function sameOrigin(request, url) {
  return request.headers.get("Origin") === url.origin;
}

async function readJson(request, limit = 4096) {
  if (!request.headers.get("content-type")?.toLowerCase()
    .includes("application/json")) {
    throw new Error("Send JSON data.");
  }
  const body = await request.text();
  if (body.length > limit) throw new Error("Request too large.");
  return JSON.parse(body);
}

async function ensureTables(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS site_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      launch_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    INSERT OR IGNORE INTO site_settings (id, launch_at) VALUES (1, NULL)
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS zar_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK (type IN ('preorder','giveaway')),
      label TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','disabled')),
      max_uses INTEGER NOT NULL DEFAULT 1,
      uses INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS zar_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_ref TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      product TEXT NOT NULL DEFAULT 'The ZAR Early Access',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','paid','fulfilled','cancelled','refunded')),
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS zar_game_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      place_id TEXT NOT NULL DEFAULT '138362141815839',
      universe_id TEXT NOT NULL DEFAULT '',
      access_mode TEXT NOT NULL DEFAULT 'code'
        CHECK (access_mode IN ('code','closed','open')),
      remember_mode TEXT NOT NULL DEFAULT 'account'
        CHECK (remember_mode IN ('account','session')),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO zar_game_settings
      (id, place_id, universe_id, access_mode, remember_mode)
    VALUES (1, '138362141815839', '', 'code', 'account')
  `).run();
}

function makeCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return "ZAR-" + out.slice(0, 5) + "-" + out.slice(5);
}

function makeRef() {
  return "ZAR-" + crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
}

function cleanText(value, max = 160) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === "/admin" || path === "/admin/") {
      return env.ASSETS.fetch(new Request(new URL("/admin.html", url), request));
    }

    // Public pre-registration
    if (path === "/api/register") {
      if (method !== "POST") return json({ message: "Method not allowed." }, 405);

      let data;
      try {
        data = await readJson(request);
      } catch (e) {
        return json({ message: e.message || "Invalid request." }, 400);
      }

      if (typeof data.website === "string" && data.website.trim()) {
        return json({ ok: true, message: "Thanks for your interest in The ZAR!" });
      }
      if (data.consent !== true) {
        return json({ message: "Please confirm your consent first." }, 400);
      }
      if (typeof data.email !== "string") {
        return json({ message: "Please enter a valid email." }, 400);
      }

      const email = data.email.trim().toLowerCase();
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ message: "Please enter a valid email." }, 400);
      }
      if (!env.DB) return json({ message: "Registration unavailable." }, 503);

      try {
        await env.DB.prepare(`
          INSERT INTO registrations (email, consent)
          VALUES (?, 1) ON CONFLICT(email) DO NOTHING
        `).bind(email).run();
        return json({ ok: true, message: "Thanks for your interest in The ZAR!" });
      } catch {
        return json({ message: "Registration unavailable." }, 503);
      }
    }

    // Public launch countdown API
    if (path === "/api/launch" && method === "GET") {
      try {
        await ensureTables(env);
        const result = await env.DB.prepare(
          "SELECT launch_at FROM site_settings WHERE id = 1"
        ).first();
        return json({ launch_at: result?.launch_at ?? null });
      } catch {
        return json({ message: "Launch settings unavailable." }, 503);
      }
    }

    // Roblox server-only configuration endpoint. It never returns the API secret.
    if (path === "/api/game/config") {
      if (method !== "GET") return json({ message: "Method not allowed." }, 405);
      if (!env.GAME_API_KEY) return json({ message: "Game integration is not configured." }, 503);
      if (request.headers.get("Authorization") !== `Bearer ${env.GAME_API_KEY}`) {
        return json({ message: "Unauthorized." }, 401);
      }
      try {
        await ensureTables(env);
        const settings = await env.DB.prepare(
          "SELECT place_id, universe_id, access_mode, remember_mode, updated_at FROM zar_game_settings WHERE id = 1"
        ).first();
        return json({
          place_id: settings?.place_id || "138362141815839",
          universe_id: settings?.universe_id || "",
          access_mode: settings?.access_mode || "code",
          remember_mode: settings?.remember_mode || "account",
          updated_at: settings?.updated_at || null
        });
      } catch {
        return json({ message: "Game settings unavailable." }, 503);
      }
    }

    // Roblox server-to-server code redemption.
    // Set GAME_API_KEY as a Worker secret; never put it in a LocalScript.
    if (path === "/api/game/redeem") {
      if (method !== "POST") return json({ message: "Method not allowed." }, 405);
      if (!env.GAME_API_KEY) {
        return json({ message: "Game integration is not configured." }, 503);
      }
      if (request.headers.get("Authorization") !== `Bearer ${env.GAME_API_KEY}`) {
        return json({ message: "Unauthorized." }, 401);
      }

      let data;
      try {
        data = await readJson(request, 2048);
      } catch (e) {
        return json({ message: e.message || "Invalid request." }, 400);
      }

      const code = cleanText(data.code, 40).toUpperCase();
      if (!code) return json({ message: "Enter a code." }, 400);

      try {
        await ensureTables(env);
        const now = new Date().toISOString();

        // A single conditional update prevents a code from exceeding its use limit.
        const result = await env.DB.prepare(`
          UPDATE zar_codes
          SET uses = uses + 1
          WHERE code = ?
            AND status = 'active'
            AND uses < max_uses
            AND (expires_at IS NULL OR expires_at > ?)
        `).bind(code, now).run();

        if (!result.meta || result.meta.changes !== 1) {
          return json({ ok: false, message: "Invalid, expired, disabled, or already-used code." }, 400);
        }

        const redeemed = await env.DB.prepare(
          "SELECT type, label FROM zar_codes WHERE code = ?"
        ).bind(code).first();

        return json({
          ok: true,
          type: redeemed.type,
          reward: redeemed.label || (redeemed.type === "giveaway" ? "Giveaway reward" : "Early access")
        });
      } catch {
        return json({ message: "Code redemption unavailable." }, 503);
      }
    }

    // Admin API
    if (path.startsWith("/api/admin/")) {
      if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET || !env.DB) {
        return json({ message: "Admin configuration is incomplete." }, 503);
      }

      if (method !== "GET" && !sameOrigin(request, url)) {
        return json({ message: "Request rejected." }, 403);
      }

      if (path === "/api/admin/login" && method === "POST") {
        let data;
        try {
          data = await readJson(request, 2048);
        } catch (e) {
          return json({ message: e.message || "Invalid request." }, 400);
        }

        if (typeof data.password !== "string" ||
            data.password.length > 1024 ||
            data.password !== env.ADMIN_PASSWORD) {
          return json({ message: "Incorrect password." }, 401);
        }

        const token = await createSession(env.SESSION_SECRET);
        return json({ ok: true }, 200, {
          "Set-Cookie": `zar_admin=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}`
        });
      }

      if (path === "/api/admin/logout" && method === "POST") {
        return json({ ok: true }, 200, {
          "Set-Cookie": "zar_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"
        });
      }

      if (!(await validSession(request, env.SESSION_SECRET))) {
        return json({ message: "Please log in again." }, 401);
      }

      try {
        await ensureTables(env);
      } catch {
        return json({ message: "Database setup failed." }, 503);
      }

      if (path === "/api/admin/me" && method === "GET") {
        return json({ ok: true });
      }

      if (path === "/api/admin/stats" && method === "GET") {
        try {
          const registrations = await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM registrations"
          ).first();
          const codes = await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM zar_codes"
          ).first();
          const orders = await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM zar_orders"
          ).first();
          const pending = await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM zar_orders WHERE status = 'pending'"
          ).first();

          return json({
            registrations: registrations?.n ?? 0,
            codes: codes?.n ?? 0,
            orders: orders?.n ?? 0,
            pending_orders: pending?.n ?? 0
          });
        } catch {
          return json({ message: "Could not load dashboard." }, 503);
        }
      }

      if (path === "/api/admin/registrations" && method === "GET") {
        try {
          const result = await env.DB.prepare(`
            SELECT email, created_at FROM registrations
            ORDER BY created_at DESC LIMIT 500
          `).all();
          const count = await env.DB.prepare(
            "SELECT COUNT(*) AS count FROM registrations"
          ).first();
          return json({ total: count?.count ?? 0, registrations: result.results ?? [] });
        } catch {
          return json({ message: "Could not load registrations." }, 503);
        }
      }

      if (path === "/api/admin/settings" && method === "GET") {
        const result = await env.DB.prepare(
          "SELECT launch_at, updated_at FROM site_settings WHERE id = 1"
        ).first();
        return json({
          launch_at: result?.launch_at ?? null,
          updated_at: result?.updated_at ?? null
        });
      }

      if (path === "/api/admin/settings" && method === "POST") {
        let data;
        try {
          data = await readJson(request, 2048);
        } catch (e) {
          return json({ message: e.message || "Invalid request." }, 400);
        }

        let launchAt = null;
        if (data.launch_at !== null && data.launch_at !== "") {
          if (typeof data.launch_at !== "string" ||
              !Number.isFinite(Date.parse(data.launch_at))) {
            return json({ message: "Enter a valid launch date and time." }, 400);
          }
          launchAt = new Date(data.launch_at).toISOString();
        }

        await env.DB.prepare(`
          UPDATE site_settings
          SET launch_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = 1
        `).bind(launchAt).run();

        return json({ ok: true, launch_at: launchAt });
      }

      // List or create access/giveaway codes
      if (path === "/api/admin/codes" && method === "GET") {
        const type = url.searchParams.get("type");
        const result = type === "preorder" || type === "giveaway"
          ? await env.DB.prepare(
              "SELECT * FROM zar_codes WHERE type = ? ORDER BY id DESC LIMIT 500"
            ).bind(type).all()
          : await env.DB.prepare(
              "SELECT * FROM zar_codes ORDER BY id DESC LIMIT 500"
            ).all();
        return json({ codes: result.results ?? [] });
      }

      if (path === "/api/admin/codes" && method === "POST") {
        let data;
        try {
          data = await readJson(request, 2048);
        } catch (e) {
          return json({ message: e.message || "Invalid request." }, 400);
        }

        const type = data.type;
        const quantity = Number(data.quantity ?? 1);
        const maxUses = Number(data.max_uses ?? 1);
        const label = cleanText(data.label, 120);
        const expiresAt = data.expires_at
          ? new Date(data.expires_at)
          : null;

        if (!["preorder", "giveaway"].includes(type)) {
          return json({ message: "Choose a valid code type." }, 400);
        }
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
          return json({ message: "Quantity must be between 1 and 100." }, 400);
        }
        if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10000) {
          return json({ message: "Maximum uses must be between 1 and 10000." }, 400);
        }
        if (data.expires_at && !Number.isFinite(expiresAt.getTime())) {
          return json({ message: "Invalid expiry date." }, 400);
        }

        const created = [];
        for (let i = 0; i < quantity; i++) {
          const code = makeCode();
          await env.DB.prepare(`
            INSERT INTO zar_codes (code, type, label, max_uses, expires_at)
            VALUES (?, ?, ?, ?, ?)
          `).bind(code, type, label, maxUses, expiresAt?.toISOString() ?? null).run();
          created.push(code);
        }
        return json({ ok: true, codes: created });
      }

      if (path === "/api/admin/codes/update" && method === "POST") {
        let data;
        try {
          data = await readJson(request, 2048);
        } catch (e) {
          return json({ message: e.message || "Invalid request." }, 400);
        }
        const id = Number(data.id);
        const status = data.status;
        if (!Number.isInteger(id) || !["active", "disabled"].includes(status)) {
          return json({ message: "Invalid code update." }, 400);
        }
        const result = await env.DB.prepare(
          "UPDATE zar_codes SET status = ? WHERE id = ?"
        ).bind(status, id).run();
        if (!result.meta || result.meta.changes !== 1) {
          return json({ message: "Code not found." }, 404);
        }
        return json({ ok: true });
      }

      // Orders are currently managed manually; no payment processor is connected.
      if (path === "/api/admin/orders" && method === "GET") {
        const result = await env.DB.prepare(
          "SELECT * FROM zar_orders ORDER BY id DESC LIMIT 500"
        ).all();
        return json({ orders: result.results ?? [] });
      }

      if (path === "/api/admin/orders" && method === "POST") {
        let data;
        try {
          data = await readJson(request, 2048);
        } catch (e) {
          return json({ message: e.message || "Invalid request." }, 400);
        }

        const email = cleanText(data.email, 254).toLowerCase();
        const product = cleanText(data.product, 120) || "The ZAR Early Access";
        const notes = cleanText(data.notes, 500);

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return json({ message: "Enter a valid customer email." }, 400);
        }

        const orderRef = makeRef();
        await env.DB.prepare(`
          INSERT INTO zar_orders (order_ref, email, product, notes)
          VALUES (?, ?, ?, ?)
        `).bind(orderRef, email, product, notes).run();

        return json({ ok: true, order_ref: orderRef });
      }

      if (path === "/api/admin/orders/update" && method === "POST") {
        let data;
        try {
          data = await readJson(request, 2048);
        } catch (e) {
          return json({ message: e.message || "Invalid request." }, 400);
        }

        const id = Number(data.id);
        const status = data.status;
        const allowed = ["pending", "paid", "fulfilled", "cancelled", "refunded"];

        if (!Number.isInteger(id) || !allowed.includes(status)) {
          return json({ message: "Invalid order update." }, 400);
        }

        const result = await env.DB.prepare(
          "UPDATE zar_orders SET status = ? WHERE id = ?"
        ).bind(status, id).run();

        if (!result.meta || result.meta.changes !== 1) {
          return json({ message: "Order not found." }, 404);
        }
        return json({ ok: true });
      }

      if (path === "/api/admin/game-settings" && method === "GET") {
        const settings = await env.DB.prepare(
          "SELECT place_id, universe_id, access_mode, remember_mode, updated_at FROM zar_game_settings WHERE id = 1"
        ).first();
        return json({
          place_id: settings?.place_id || "138362141815839",
          universe_id: settings?.universe_id || "",
          access_mode: settings?.access_mode || "code",
          remember_mode: settings?.remember_mode || "account",
          updated_at: settings?.updated_at || null
        });
      }

      if (path === "/api/admin/game-settings" && method === "POST") {
        let data;
        try { data = await readJson(request, 2048); }
        catch (e) { return json({ message: e.message || "Invalid request." }, 400); }
        const placeId = cleanText(data.place_id, 24);
        const universeId = cleanText(data.universe_id, 24);
        const accessMode = cleanText(data.access_mode, 16);
        const rememberMode = cleanText(data.remember_mode, 16);
        if (!/^\d{1,24}$/.test(placeId)) return json({ message: "Enter a valid numeric Roblox Place ID." }, 400);
        if (universeId && !/^\d{1,24}$/.test(universeId)) return json({ message: "Universe ID must be numeric." }, 400);
        if (!["code", "closed", "open"].includes(accessMode)) return json({ message: "Choose a valid access mode." }, 400);
        if (!["account", "session"].includes(rememberMode)) return json({ message: "Choose a valid authorization duration." }, 400);
        await env.DB.prepare(`
          UPDATE zar_game_settings
          SET place_id = ?, universe_id = ?, access_mode = ?, remember_mode = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = 1
        `).bind(placeId, universeId, accessMode, rememberMode).run();
        return json({ ok: true, place_id: placeId, universe_id: universeId, access_mode: accessMode, remember_mode: rememberMode });
      }

      if (path === "/api/admin/game-status" && method === "GET") {
        const settings = await env.DB.prepare(
          "SELECT place_id, universe_id, access_mode, remember_mode, updated_at FROM zar_game_settings WHERE id = 1"
        ).first();
        return json({
          endpoint: "/api/game/redeem",
          config_endpoint: "/api/game/config",
          configured: Boolean(env.GAME_API_KEY),
          place_id: settings?.place_id || "138362141815839",
          universe_id: settings?.universe_id || "",
          access_mode: settings?.access_mode || "code",
          remember_mode: settings?.remember_mode || "account",
          note: "Use these endpoints only from a trusted Roblox server script."
        });
      }

      return json({ message: "Not found." }, 404);
    }

    if (path.startsWith("/api/")) {
      return json({ message: "Not found." }, 404);
    }

    return env.ASSETS.fetch(request);
  }
};
