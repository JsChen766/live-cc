function ok(data, status = 200) {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function fail(message, details, status = 500) {
  return new Response(
    JSON.stringify({
      success: false,
      error: { code: "INTERNAL_ERROR", message, details }
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
  if (context.request.method !== "PUT") {
    return fail("Method Not Allowed", null, 405);
  }

  const appId = context.env.REALTIME_APP_ID;
  const appSecret = context.env.REALTIME_APP_SECRET;
  if (!appId || !appSecret) {
    return fail("Realtime bindings are not configured.", null, 500);
  }

  const sessionId = context.params.sessionId;
  const payload = await context.request.json().catch(() => null);
  const response = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${appId}/sessions/${sessionId}/tracks/close`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${appSecret}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || data?.errorCode) {
    return fail(data?.errorDescription ?? "Realtime tracks/close failed", data, response.status || 500);
  }

  return ok(data);
}
