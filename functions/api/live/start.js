const LIVE_KEY = "current-live";

function ok(data, status = 200) {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function fail(message, status = 400) {
  return new Response(
    JSON.stringify({
      success: false,
      error: { code: "BAD_REQUEST", message }
    }),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      }
    }
  );
}

export async function onRequest(context) {
  if (context.request.method !== "POST") {
    return fail("Method Not Allowed", 405);
  }

  const expectedToken = context.env.HOST_TOKEN;
  const providedToken = context.request.headers.get("x-host-token") ?? "";
  if (expectedToken && providedToken !== expectedToken) {
    return fail("Host token is invalid.", 403);
  }

  const body = await context.request.json().catch(() => null);
  if (!body?.sessionId || !Array.isArray(body?.tracks)) {
    return fail("sessionId and tracks are required.");
  }

  const live = {
    sessionId: body.sessionId,
    tracks: body.tracks,
    startedAt: body.startedAt ?? new Date().toISOString()
  };

  await context.env.LIVE_STATE.put(LIVE_KEY, JSON.stringify(live));
  return ok({ stored: true, live });
}
