// Supabase Edge Function: "ai-proxy"
// ----------------------------------------------------------------------------
// Generic CORS-bypassing forwarder for AI provider calls (OpenAI, Google, xAI,
// Azure, IBM watsonx) that block direct browser requests. Hosted on Supabase so
// every user of the app gets it automatically with no setup of their own.
//
// DEPLOY (no CLI/Node needed):
//   1. Supabase dashboard > Edge Functions > Create a new function.
//   2. Name it exactly "ai-proxy" (the app's hardcoded proxy URL expects this).
//   3. Delete the starter code and paste this whole file in its place. Deploy.
//   4. Open the function's Settings and turn OFF "Enforce JWT Verification".
//      This is required: the app forwards each AI provider's own Authorization
//      header (its API key) through this function untouched, and Supabase's
//      JWT check would otherwise reject that header as an invalid Supabase
//      token before the request ever reaches this code.
//
// Your function's URL is:
//   https://<project-ref>.supabase.co/functions/v1/ai-proxy

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors() });
  }

  const target = new URL(req.url).searchParams.get("url");
  if (!target) {
    return new Response("Missing ?url=", { status: 400, headers: cors() });
  }

  const headers = new Headers(req.headers);
  headers.delete("host");

  const init: RequestInit = {
    method: req.method,
    headers,
    body: (req.method === "GET" || req.method === "HEAD")
      ? undefined
      : await req.arrayBuffer(),
  };

  const resp = await fetch(target, init);
  const out = new Headers(resp.headers);
  const c = cors();
  for (const [k, v] of Object.entries(c)) out.set(k, v);
  return new Response(resp.body, { status: resp.status, headers: out });
});

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "*",
    "Access-Control-Allow-Headers": "*",
  };
}

//Made with Bob