const LIVE_KEY = "current-live";

function json(data, init = {}) {
  return new Response(JSON.stringify({ success: true, data }), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...init.headers
    }
  });
}

export async function onRequest(context) {
  if (context.request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const raw = await context.env.LIVE_STATE.get(LIVE_KEY);
  if (!raw) {
    return json({ live: null });
  }

  try {
    return json({ live: JSON.parse(raw) });
  } catch {
    await context.env.LIVE_STATE.delete(LIVE_KEY);
    return json({ live: null });
  }
}
