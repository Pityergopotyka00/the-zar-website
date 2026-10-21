
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/register") {
      if (request.method !== "POST") {
        return json({ message: "Method not allowed." }, 405);
      }

      if (!request.headers.get("content-type")
          ?.toLowerCase().includes("application/json")) {
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

      // Silently discard submissions caught by the honeypot.
      if (typeof data.website === "string" && data.website.trim()) {
        return json({
          ok: true,
          message: "Thanks for your interest in The ZAR!"
        });
      }

      if (data.consent !== true) {
        return json({
          message: "Please confirm your consent first."
        }, 400);
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
        await env.DB.prepare(
          `INSERT INTO registrations (email, consent)
           VALUES (?, 1)
           ON CONFLICT(email) DO NOTHING`
        ).bind(email).run();

        return json({
          ok: true,
          message: "Thanks for your interest in The ZAR!"
        });
      } catch {
        return json({
          message: "Registration is temporarily unavailable."
        }, 503);
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ message: "Not found." }, 404);
    }

    return env.ASSETS.fetch(request);
  }
};
