/**
 * AI ENRICHMENT (optional)
 * ----------------------------------------------------------------------------
 * Classifies a customer's free-text request with whichever AI provider the user
 * configured (via AIProvider). When an AI provider is set the app uses this for
 * 100% of imported jobs: every request message is (re)read by the model, which
 * returns the same output shape as InferenceEngine.analyze() (jobType, partOfHouse,
 * urgency, laborEstimate, materials, tools, uncertainties, inScope). With no provider
 * the app falls back to the offline InferenceEngine, so classification always works.
 *
 * The prompt encodes the app's rules: repair-vs-new-install scope, a safety override
 * (sparking / smoke / burning smell / shock / total power loss force "high" urgency),
 * and uncertainties limited to what the message does NOT already answer, most relevant
 * first (because a short client message rarely pins down the exact fault).
 *
 * Pure and network-only: takes a message + a provider config, returns a promise for the
 * classification, or rejects with a descriptive Error. Never touches the DOM or app
 * state (js-app.js merges the result into the job and guarantees a non-empty
 * uncertainties list).
 */
const AIEnrichment = (function () {

  const SYSTEM_PROMPT = `You are a classification assistant for a residential electrician job dispatch platform.
You are re-classifying a customer's free-text service request (your result replaces the offline rules engine's first pass), so make a best-effort judgment call.

Scope: residential electrical FIXES and REPAIRS. If the message clearly describes a NEW installation or project rather than something broken, set inScope to false.

Safety override: if the message mentions sparking, smoke, a burning smell, shock, arcing, or a total loss of power, urgency must be "high".

Respond with ONLY a single JSON object (no markdown, no commentary) with this exact shape:
{
  "jobType": "short label, for example 'Outlet repair'",
  "partOfHouse": "short label, for example 'Kitchen', or 'Not specified'",
  "urgency": "low" or "medium" or "high",
  "laborEstimate": { "min": number of hours, "max": number of hours },
  "materials": [ { "name": string, "prob": "surely" or "likely" or "maybe" } ],
  "tools": [ string, ... ],
  "uncertainties": { "phoneCall": [string, ...], "onSite": [string, ...] },
  "inScope": boolean
}

"materials" should list parts likely needed, ranked by confidence. "tools" should list any tools beyond a standard electrician toolkit (voltage tester, screwdrivers, wire strippers, pliers). "uncertainties.phoneCall" are questions to ask before booking; "uncertainties.onSite" are checks to make on arrival. ALWAYS include at least one phoneCall item and at least one onSite item, even when the message seems clear: a short client message rarely pins down the exact fault or fix, so there is always something worth confirming before booking and on arrival. Include ONLY items the message does not already answer (for example, if the customer says "electric water heater", do not ask "electric or gas?"; if they say "4-prong dryer outlet", do not ask the prong count). List the most decision-relevant items first, and keep each list to the 2 to 4 that matter most. If you genuinely cannot determine anything useful, set jobType to "Not determined".`;


  function buildUserPrompt(message, context) {
    return [
      `Customer message: """${message}"""`,
      `Customer name provided: ${context && context.name ? 'yes' : 'no'}`,
      `Customer address provided: ${context && context.address ? 'yes' : 'no'}`
    ].join('\n');
  }


  // Coerce and defend against a malformed or partially-shaped AI response.
  function validateResult(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('AI response was not a JSON object.');

    const jobType = String(raw.jobType || '').trim();
    if (!jobType || /^not determined/i.test(jobType)) {
      throw new Error('AI could not determine a job type either.');
    }

    const urgency = ['low', 'medium', 'high'].includes(raw.urgency) ? raw.urgency : 'medium';

    const laborEstimate = (raw.laborEstimate && typeof raw.laborEstimate === 'object')
      ? { min: Number(raw.laborEstimate.min) || 0, max: Number(raw.laborEstimate.max) || 0 }
      : { min: 1, max: 2 };

    const materials = Array.isArray(raw.materials)
      ? raw.materials
          .filter(m => m && typeof m.name === 'string' && m.name.trim())
          .map(m => ({ name: m.name.trim(), prob: ['surely', 'likely', 'maybe'].includes(m.prob) ? m.prob : 'maybe' }))
      : [];

    const tools = Array.isArray(raw.tools) ? raw.tools.filter(t => typeof t === 'string' && t.trim()) : [];

    const uncertainties = (raw.uncertainties && typeof raw.uncertainties === 'object')
      ? {
          phoneCall: Array.isArray(raw.uncertainties.phoneCall) ? raw.uncertainties.phoneCall.filter(s => typeof s === 'string' && s.trim()) : [],
          onSite: Array.isArray(raw.uncertainties.onSite) ? raw.uncertainties.onSite.filter(s => typeof s === 'string' && s.trim()) : []
        }
      : { phoneCall: [], onSite: [] };

    const partOfHouse = String(raw.partOfHouse || '').trim() || 'Not specified';
    const inScope = raw.inScope !== false;

    return { jobType, partOfHouse, urgency, laborEstimate, materials, tools, uncertainties, inScope };
  }


  // config: { provider, apiKey, model, baseUrl } (see AIProvider).
  async function classify(message, context, config) {
    if (!config || !config.apiKey) throw new Error('No AI API key configured.');
    if (!message || !message.trim()) throw new Error('No message to classify.');

    const { text } = await AIProvider.complete({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(message, context),
      json: true,
      maxTokens: 1024
    }, config);

    const raw = AIProvider.extractJson(text);
    if (!raw) throw new Error('Could not parse the AI response as JSON.');
    return validateResult(raw);
  }

  return { classify };
})();

//Made with Bob