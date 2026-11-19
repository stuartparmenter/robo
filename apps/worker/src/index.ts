import { gameIdPattern, gameIdSource, makeGameId } from "./games";
import { serveMcp } from "./mcp";

export { RunRelay } from "./relay";

const hostRoute = new RegExp(`^/api/runs/(${gameIdSource})/host$`);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/runs" && request.method === "POST") {
      if (request.headers.get("Origin") !== url.origin) return new Response("Forbidden", { status: 403 });
      const client = request.headers.get("CF-Connecting-IP") ?? "local";
      if (!(await env.CREATE_LIMITER.limit({ key: client })).success) {
        return new Response("Too many new runs. Try again in a minute.", { status: 429 });
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const gameId = makeGameId();
        const secrets = await env.RUNS.getByName(gameId).create(gameId);
        if (secrets) {
          return Response.json(
            { socket: `/api/runs/${gameId}/host?host=${secrets.host}`, mcp: "/mcp", gameId },
            { headers: { "Cache-Control": "no-store" } },
          );
        }
      }
      return new Response("Could not allocate a game. Try again.", { status: 503 });
    }
    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      return serveMcp(request, async (code) => {
        if (!code || !gameIdPattern.test(code)) return;
        const run = env.RUNS.getByName(code);
        if (await run.authorize(code)) return run;
      });
    }
    const host = hostRoute.exec(url.pathname);
    if (host) {
      if (request.headers.get("Origin") !== url.origin) return new Response("Forbidden", { status: 403 });
      return env.RUNS.getByName(host[1]).fetch(request);
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/mcp/")) {
      return new Response("Not found", { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
