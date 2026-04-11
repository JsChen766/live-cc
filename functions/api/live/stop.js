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
  const providedToken = context.request.headers.get("x-host-token") ?? (await context.request.json().catch(() => null))?.hostToken ?? "";
  if (expectedToken && providedToken !== expectedToken) {
    return fail("Host token is invalid.", 403);
  }

  await context.env.LIVE_STATE.delete(LIVE_KEY);
  return ok({ cleared: true });
}
