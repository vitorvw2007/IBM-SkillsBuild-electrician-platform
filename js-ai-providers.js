/**
 * AI PROVIDERS (optional)
 * ----------------------------------------------------------------------------
 * Unified, browser-direct wrapper over several LLM APIs so the user can bring whatever
 * key they have. The platform is compatible with IBM watsonx.ai alongside the major
 * hosted models. Four engines cover every supported provider:
 *   - "ibm":       IBM watsonx.ai. Exchanges the API key for an IBM Cloud IAM token,
 *                  then calls the watsonx /ml/v1/text/chat endpoint with a region base
 *                  URL and a project_id. Routed through the proxy so the proxy can stay
 *                  a generic forwarder.
 *   - "anthropic": Anthropic Messages API. Supports a server-side web_search tool.
 *   - "openai":    OpenAI-compatible /chat/completions (OpenAI, Groq, xAI, Google's
 *                  OpenAI-compat endpoint, or any custom base URL). OpenAI, xAI and
 *                  Google can also do live web search via their own request shapes.
 *   - "azure":     Azure OpenAI (Microsoft): the openai body with an api-key header and
 *                  a full deployment URL the user supplies.
 *
 * Providers exposed by AIProvider.list(): IBM watsonx.ai, Anthropic (Claude), OpenAI,
 * Google (Gemini), xAI (Grok), Groq, Azure OpenAI, and any custom OpenAI-compatible
 * endpoint. Web search (for live purchase prices + real store links) runs on Anthropic,
 * OpenAI, Google and xAI.
 *
 * Pure and network-only: takes a prompt + a provider config, returns { text, citations }
 * or rejects with a descriptive Error. Never touches the DOM or app state.
 *
 * CORS note: Anthropic (with the dangerous-direct-browser-access header) and Groq work
 * directly from a static page. IBM watsonx.ai, OpenAI, Azure, Google and xAI block
 * browser-origin requests, so those calls are routed automatically through a shared
 * CORS relay (DEFAULT_PROXY_URL, a Supabase Edge Function — see
 * supabase-edge-function-ai-proxy.ts). No per-user setup required; a custom cfg.proxyUrl
 * still overrides the default if one is ever supplied.
 */
const AIProvider = (function () {

  // Requests are aborted after this long so a hung provider/proxy does not spin forever.
  const REQUEST_TIMEOUT_MS = 60000;

  // Shared CORS-relay (a Supabase Edge Function, see supabase-edge-function-ai-proxy.ts)
  // used automatically for any provider that isn't reachable directly from a browser, so
  // no user ever has to set up their own proxy. A per-user custom proxyUrl (if one is ever
  // set) still takes priority over this default.
  const DEFAULT_PROXY_URL = 'https://cfswnifxmbihogusphdt.supabase.co/functions/v1/ai-proxy/?url={url}';

  // defaultModel for non-Anthropic providers is a placeholder hint only; the user can
  // edit it in Settings. Anthropic's default is known-good.
  // webSearch marks providers that can pull live prices + real source links (each via its
  // own request shape). browserDirect marks the ones that work without a proxy.
  const PROVIDERS = {
    anthropic: { label: 'Anthropic (Claude)', engine: 'anthropic', url: 'https://api.anthropic.com/v1/messages', defaultModel: 'claude-opus-4-8', webSearch: true, browserDirect: true },
    openai:    { label: 'OpenAI',             engine: 'openai',    url: 'https://api.openai.com/v1/chat/completions',                          defaultModel: 'gpt-4.1-mini',            webSearch: true,  browserDirect: false },
    google:    { label: 'Google (Gemini)',    engine: 'openai',    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', defaultModel: 'gemini-2.0-flash',  webSearch: true,  browserDirect: false },
    xai:       { label: 'xAI (Grok)',         engine: 'openai',    url: 'https://api.x.ai/v1/chat/completions',                                defaultModel: 'grok-3-latest',           webSearch: true,  browserDirect: false },
    groq:      { label: 'Groq',               engine: 'openai',    url: 'https://api.groq.com/openai/v1/chat/completions',                     defaultModel: 'llama-3.3-70b-versatile', webSearch: false, browserDirect: true },
    azure:     { label: 'Azure OpenAI (Microsoft)', engine: 'azure', url: '',                                                                 defaultModel: '', webSearch: false, browserDirect: false, needsBaseUrl: true },
    ibm:       { label: 'IBM watsonx.ai',     engine: 'ibm',       url: '',                                                                    defaultModel: 'ibm/granite-3-8b-instruct', webSearch: false, browserDirect: false, needsBaseUrl: true, needsProjectId: true },
    custom:    { label: 'Custom (OpenAI-compatible)', engine: 'openai', url: '',                                                              defaultModel: '', webSearch: false, browserDirect: false, needsBaseUrl: true }
  };

  function list() {
    return Object.keys(PROVIDERS).map(id => ({ id, label: PROVIDERS[id].label }));
  }

  function get(id) { return PROVIDERS[id] || null; }

  function supportsWebSearch(id) {
    const p = PROVIDERS[id];
    return !!(p && p.webSearch);
  }

  function defaultModel(id) {
    const p = PROVIDERS[id];
    return p ? p.defaultModel : '';
  }


  // Pull the outermost { ... } span out of a model reply and parse it (tolerates
  // ```json fences and any prose the model wraps around it).
  function extractJson(text) {
    if (!text) return null;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1] : text;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch (_) {
      return null;
    }
  }


  // Route a request through the user's optional CORS proxy. Two conventions are supported:
  // a "{url}" placeholder (target URL-encoded into it) or a bare prefix the target is
  // appended to (for example a self-hosted cors-anywhere ending in "/").
  function applyProxy(url, proxyUrl) {
    if (!proxyUrl || !proxyUrl.trim()) return url;
    const px = proxyUrl.trim();
    if (px.indexOf('{url}') !== -1) return px.replace('{url}', encodeURIComponent(url));
    return px + url;
  }


  // POST JSON with a timeout and proxy support. On an HTTP error it throws an Error whose
  // .status/.detail carry the response code + message so callers can react (see the
  // param-fallback retry). Network/timeout failures map to a clear, actionable message.
  async function postJson(url, headers, body, cfg) {
    const target = applyProxy(url, cfg && cfg.proxyUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(target, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    } catch (networkErr) {
      if (networkErr && networkErr.name === 'AbortError') {
        throw new Error('The AI provider did not respond in time (timed out). Try again, or check your network/proxy.');
      }
      throw new Error('Could not reach the AI provider. This is usually a browser CORS block (the provider refuses direct calls from a web page) or a network error. Anthropic and Groq work directly; other providers need a proxy URL in Settings.');
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      let detail = '';
      try {
        const errJson = await response.json();
        detail = (errJson && errJson.error && (errJson.error.message || errJson.error)) || '';
      } catch (_) { /* body not JSON */ }
      const err = new Error(`AI provider error (${response.status})${detail ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}.`);
      err.status = response.status;
      err.detail = typeof detail === 'string' ? detail : JSON.stringify(detail || '');
      throw err;
    }
    return response.json();
  }


  // Some OpenAI-compatible models reject `temperature` or `response_format`. On a 400 that
  // names one of them, drop it and retry once so those models still work.
  async function postJsonWithParamFallback(url, headers, body, cfg) {
    try {
      return await postJson(url, headers, body, cfg);
    } catch (err) {
      if (err && err.status === 400 && err.detail) {
        const d = String(err.detail).toLowerCase();
        const nb = { ...body };
        let retry = false;
        if (d.indexOf('temperature') !== -1 && 'temperature' in nb) { delete nb.temperature; retry = true; }
        if ((d.indexOf('response_format') !== -1 || d.indexOf('json') !== -1) && 'response_format' in nb) { delete nb.response_format; retry = true; }
        if (retry) return postJson(url, headers, nb, cfg);
      }
      throw err;
    }
  }


  // ---- Anthropic Messages API (optionally with the server-side web search tool) ----
  async function completeAnthropic(opts, cfg) {
    const model = (cfg.model || PROVIDERS.anthropic.defaultModel).trim();
    const body = {
      model,
      max_tokens: opts.maxTokens || 2048,
      system: opts.system || undefined,
      messages: [{ role: 'user', content: opts.user }]
    };
    if (opts.webSearch) {
      body.tools = [{ type: 'web_search_20260209', name: 'web_search' }];
    }
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    };
    const data = await postJson(PROVIDERS.anthropic.url, headers, body, cfg);

    const blocks = Array.isArray(data && data.content) ? data.content : [];
    let text = '';
    const citations = [];
    blocks.forEach(b => {
      if (!b) return;
      if (b.type === 'text' && typeof b.text === 'string') text += b.text;
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        b.content.forEach(r => {
          if (r && r.url) citations.push({ title: r.title || r.url, url: r.url });
        });
      }
    });
    if (!text.trim()) throw new Error('Anthropic returned an empty response.');
    return { text, citations };
  }


  // Web-search request shapes differ per provider. These follow each provider's documented
  // spec but were NOT verified against the live APIs (no keys, and these providers are
  // CORS-blocked browser-direct, so they only run through a proxy). They are isolated here
  // so a shape can be corrected without touching the rest of the engine.
  function applyOpenAiWebSearch(body, providerId) {
    if (providerId === 'xai') {
      // xAI Live Search: turn search on and ask for the sources back.
      body.search_parameters = { mode: 'auto', return_citations: true };
    } else if (providerId === 'google') {
      // Gemini grounding with Google Search, expressed in the OpenAI-compat tools array.
      body.tools = [...(body.tools || []), { type: 'google_search' }];
    } else if (providerId === 'openai') {
      // OpenAI hosted web search tool.
      body.tools = [...(body.tools || []), { type: 'web_search' }];
    }
  }


  // Message content is usually a string, but some providers return an array of parts.
  function extractContentText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      }).join('');
    }
    return '';
  }


  // Collect source links from whichever place the provider put them: xAI's top-level
  // `citations`, a message-level `citations`, or OpenAI-style annotation `url_citation`s.
  function parseOpenAiCitations(data) {
    const out = [];
    const seen = new Set();
    const push = (url, title) => {
      if (!url || seen.has(url)) return;
      seen.add(url);
      out.push({ title: title || url, url });
    };
    const addList = list => {
      if (!Array.isArray(list)) return;
      list.forEach(c => {
        if (typeof c === 'string') push(c);
        else if (c && c.url) push(c.url, c.title);
      });
    };
    addList(data && data.citations);
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    if (msg) {
      addList(msg.citations);
      if (Array.isArray(msg.annotations)) {
        msg.annotations.forEach(a => {
          const u = a && a.url_citation;
          if (u && u.url) push(u.url, u.title);
        });
      }
    }
    return out;
  }


  // ---- OpenAI-compatible chat completions (OpenAI, Groq, xAI, Google, Azure, custom) ----
  async function completeOpenAI(opts, cfg, engine) {
    const provider = PROVIDERS[cfg.provider] || {};
    const url = (cfg.baseUrl && cfg.baseUrl.trim()) || provider.url;
    if (!url) throw new Error('No API endpoint configured for this provider.');
    const model = (cfg.model || provider.defaultModel || '').trim();
    if (!model) throw new Error('No model configured for this provider. Set one in Settings.');

    const body = {
      model,
      temperature: 0.2,
      messages: [
        ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
        { role: 'user', content: opts.user }
      ]
    };
    if (opts.json) body.response_format = { type: 'json_object' };
    if (opts.webSearch) applyOpenAiWebSearch(body, cfg.provider);

    const headers = { 'Content-Type': 'application/json' };
    if (engine === 'azure') headers['api-key'] = cfg.apiKey;
    else headers['Authorization'] = `Bearer ${cfg.apiKey}`;

    const data = await postJsonWithParamFallback(url, headers, body, cfg);
    const choice = data && data.choices && data.choices[0];
    const text = extractContentText(choice && choice.message && choice.message.content);
    if (!text.trim()) throw new Error('The AI provider returned an empty response.');
    return { text, citations: parseOpenAiCitations(data) };
  }


  // ---- IBM watsonx.ai (IAM token exchange + /ml/v1/text/chat) ----
  // watsonx needs: a region base URL, a project_id in the body, and an IAM bearer token
  // that is exchanged from the API key. All calls go through the user's proxy (watsonx is
  // CORS-blocked from a browser), which lets the proxy stay a generic forwarder. Built to
  // IBM's documented spec but NOT verified against a live account (no key available).
  async function ibmIamToken(cfg) {
    const tokenUrl = applyProxy('https://iam.cloud.ibm.com/identity/token', cfg.proxyUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: 'grant_type=urn:ibm:params:oauth:grant-type:apikey&apikey=' + encodeURIComponent(cfg.apiKey),
        signal: controller.signal
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('IBM IAM token request timed out.');
      throw new Error('Could not reach IBM IAM. IBM watsonx is CORS-blocked from a browser and needs a proxy URL in Settings.');
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) throw new Error(`IBM IAM token exchange failed (${resp.status}). Check the API key.`);
    const data = await resp.json();
    if (!data || !data.access_token) throw new Error('IBM IAM did not return an access token.');
    return data.access_token;
  }

  async function completeIBM(opts, cfg) {
    const base = (cfg.baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('IBM watsonx needs a region endpoint URL (for example https://us-south.ml.cloud.ibm.com). Add it in Settings.');
    if (!(cfg.projectId && cfg.projectId.trim())) throw new Error('IBM watsonx needs a Project ID. Add it in Settings.');
    const model = (cfg.model || PROVIDERS.ibm.defaultModel || '').trim();
    if (!model) throw new Error('No IBM model configured. Set one in Settings.');

    const token = await ibmIamToken(cfg);
    const url = base + '/ml/v1/text/chat?version=2023-05-29';
    const body = {
      model_id: model,
      project_id: cfg.projectId.trim(),
      messages: [
        ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
        { role: 'user', content: opts.user }
      ]
    };
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`
    };
    const data = await postJson(url, headers, body, cfg);
    const choice = data && data.choices && data.choices[0];
    const text = extractContentText(choice && choice.message && choice.message.content);
    if (!text.trim()) throw new Error('IBM watsonx returned an empty response.');
    return { text, citations: [] };
  }


  // opts: { system, user, json?, webSearch?, maxTokens? }
  // cfg:  { provider, apiKey, model?, baseUrl?, proxyUrl?, projectId? }
  async function complete(opts, cfg) {
    if (!cfg || !cfg.apiKey) throw new Error('No API key configured.');
    if (!opts || !opts.user) throw new Error('No prompt to send.');
    const provider = PROVIDERS[cfg.provider];
    if (!provider) throw new Error(`Unknown AI provider "${cfg.provider}".`);
    if (provider.needsBaseUrl && !(cfg.baseUrl && cfg.baseUrl.trim())) {
      throw new Error('This provider needs an endpoint URL. Add it in Settings.');
    }
    // Providers that can't be called directly from a browser are routed through the
    // shared proxy automatically; browser-direct providers (Anthropic, Groq) never need it.
    const effectiveCfg = provider.browserDirect
      ? cfg
      : { ...cfg, proxyUrl: (cfg.proxyUrl && cfg.proxyUrl.trim()) || DEFAULT_PROXY_URL };
    if (provider.engine === 'ibm') return completeIBM({ ...opts }, effectiveCfg);
    // Only turn on web search for providers that actually support it.
    const wantWeb = !!opts.webSearch && !!provider.webSearch;
    if (provider.engine === 'anthropic') return completeAnthropic({ ...opts, webSearch: wantWeb }, effectiveCfg);
    return completeOpenAI({ ...opts, webSearch: wantWeb }, effectiveCfg, provider.engine);
  }

  return { list, get, supportsWebSearch, defaultModel, extractJson, complete };
})();

//Made with Bob