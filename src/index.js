
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Keep API routes handled by the backend.
    if (url.pathname === "/api/health") {
      return Response.json({
        status: "ok",
        app: "The ZAR",
        databaseConfigured: Boolean(env.DB)
      });
    }

    // Do not expose unfinished API routes.
    if (url.pathname.startsWith("/api/")) {
      return Response.json(
        { error: "API endpoint not ready yet" },
        { status: 404 }
      );
    }

    // Serve the existing website.
    return env.ASSETS.fetch(request);
  }
};
