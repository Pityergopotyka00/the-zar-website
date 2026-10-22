
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
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
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

async function ensureSettingsTable(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS site_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      launch_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    INSERT OR IGNORE INTO site_settings (id, launch_at)
    VALUES (1, NULL)
  `).run();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/admin" || path === "/admin/") {
      return env.ASSETS.fetch(
        new Request(new URL("/admin.html", url), request)
      );
    }

    if (path === "/api/register") {
      if (request.method !== "POST") {
        return json({ message: "Method not allowed." }, 405);
      }

      if (!request.headers.get("content-type")?.toLowerCase()
        .includes("application/json")) {
        return json({ message: "Invalid request." }, 415);
      }

      let data;
      try {
        const body = await request.text();
        if (body.length > 4096) {
          return json({ message: "Request too large." }, 413);
        }
        data = JSON.parse(body);
      } catch {
        return json({ message: "Invalid request." }, 400);
      }

      if (typeof data.website === "string" && data.website.trim()) {
        return json({
          ok: true,
          message: "Thanks for your interest in The ZAR!"
        });
      }

      if (data.consent !== true) {
        return json({ message: "Please confirm your consent first." }, 400);
      }

      if (typeof data.email !== "string") {
        return json({ message: "Please enter a valid email." }, 400);
      }

      const email = data.email.trim().toLowerCase();
      if (
        email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      ) {
        return json({ message: "Please enter a valid email." }, 400);
      }

      if (!env.DB) {
        return json({ message: "Registration is temporarily unavailable." }, 503);
      }

      try {
        await env.DB.prepare(`
          INSERT INTO registrations (email, consent)
          VALUES (?, 1)
          ON CONFLICT(email) DO NOTHING
        `).bind(email).run();

        return json({
          ok: true,
          message: "Thanks for your interest in The ZAR!"
        });
      } catch {
        return json({ message: "Registration is temporarily unavailable." }, 503);
      }
    }

    if (path === "/api/launch" && request.method === "GET") {
      try {
        await ensureSettingsTable(env);
        const result = await env.DB.prepare(
          "SELECT launch_at FROM site_settings WHERE id = 1"
        ).first();
        return json({ launch_at: result?.launch_at ?? null });
      } catch {
        return json({ message: "Launch settings unavailable." }, 503);
      }
    }

    if (path.startsWith("/api/admin/")) {
      if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET || !env.DB) {
        return json({ message: "Admin configuration is incomplete." }, 503);
      }

      if (request.method !== "GET" && !sameOrigin(request, url)) {
        return json({ message: "Request rejected." }, 403);
      }

      if (path === "/api/admin/login" && request.method === "POST") {
        let data;
        try {
          const body = await request.text();
          if (body.length > 2048) return json({ message: "Request too large." }, 413);
          data = JSON.parse(body);
        } catch {
          return json({ message: "Invalid request." }, 400);
        }

        if (
          typeof data.password !== "string" ||
          data.password.length > 1024 ||
          data.password !== env.ADMIN_PASSWORD
        ) {
          return json({ message: "Incorrect password." }, 401);
        }

        const token = await createSession(env.SESSION_SECRET);
        return json(
          { ok: true },
          200,
          {
            "Set-Cookie": `zar_admin=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}`
          }
        );
      }

      if (path === "/api/admin/logout" && request.method === "POST") {
        return json({ ok: true }, 200, {
          "Set-Cookie": "zar_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"
        });
      }

      if (!(await validSession(request, env.SESSION_SECRET))) {
        return json({ message: "Please log in again." }, 401);
      }

      if (path === "/api/admin/me" && request.method === "GET") {
        return json({ ok: true });
      }

      if (path === "/api/admin/registrations" && request.method === "GET") {
        try {
          const result = await env.DB.prepare(`
            SELECT email, created_at
            FROM registrations
            ORDER BY created_at DESC
            LIMIT 500
          `).all();

          const count = await env.DB.prepare(
            "SELECT COUNT(*) AS count FROM registrations"
          ).first();

          return json({
            total: count?.count ?? 0,
            registrations: result.results ?? []
          });
        } catch {
          return json({ message: "Could not load registrations." }, 503);
        }
      }

      if (path === "/api/admin/settings" && request.method === "GET") {
        try {
          await ensureSettingsTable(env);
          const result = await env.DB.prepare(
            "SELECT launch_at, updated_at FROM site_settings WHERE id = 1"
          ).first();
          return json({
            launch_at: result?.launch_at ?? null,
            updated_at: result?.updated_at ?? null
          });
        } catch {
          return json({ message: "Could not load settings." }, 503);
        }
      }

      if (path === "/api/admin/settings" && request.method === "POST") {
        let data;
        try {
          const body = await request.text();
          if (body.length > 2048) return json({ message: "Request too large." }, 413);
          data = JSON.parse(body);
        } catch {
          return json({ message: "Invalid request." }, 400);
        }

        let launchAt = null;
        if (data.launch_at !== null && data.launch_at !== "") {
          if (typeof data.launch_at !== "string" ||
              !Number.isFinite(Date.parse(data.launch_at))) {
            return json({ message: "Enter a valid launch date and time." }, 400);
          }
          launchAt = new Date(data.launch_at).toISOString();
        }

        try {
          await ensureSettingsTable(env);
          await env.DB.prepare(`
            UPDATE site_settings
            SET launch_at = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = 1
          `).bind(launchAt).run();

          return json({ ok: true, launch_at: launchAt });
        } catch {
          return json({ message: "Could not save launch settings." }, 503);
        }
      }

      return json({ message: "Not found." }, 404);
    }

    if (path.startsWith("/api/")) {
      return json({ message: "Not found." }, 404);
    }

    return env.ASSETS.fetch(request);
  }
};
