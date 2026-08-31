// Real model call for order intake. If no ANTHROPIC_API_KEY is set, falls
// back to a regex heuristic — but flags that fallback as low-confidence so
// the agent escalates rather than silently guessing with a weaker parser.

// Real model call for order intake. Tries Gemini first (free tier, no
// credit card needed — get a key at https://aistudio.google.com/apikey),
// falls back to Claude if ANTHROPIC_API_KEY is set instead, and falls back
// further to a regex heuristic if neither key is present. The heuristic
// fallback is deliberately flagged low-confidence so the agent escalates
// rather than silently running on a weaker parser.

const SYSTEM_PROMPT = `You are an order-intake parser for a home baker's AI agent.
Extract ALL cake items from the customer's message — there may be more than one.
Respond with ONLY a JSON object, no other text, in this exact shape:
{"items": [{"weightKg": number, "flavor": string, "date": "YYYY-MM-DD" or null}], "confidence": "high" or "low", "reasoning": string}
Use "low" confidence if any item's weight, flavor, or date is ambiguous, missing, or you had to guess.
Never invent a date that wasn't stated in the message.`;

function heuristicParse(message) {
  const weightMatch = message.match(/(\d+(\.\d+)?)\s*kg/i);
  const dateMatch = message.match(/(\d{4}-\d{2}-\d{2})/);
  const flavors = ['chocolate', 'vanilla', 'red velvet', 'fruit'];
  const flavorMatch = flavors.find(f => message.toLowerCase().includes(f));

  return {
    weightKg: weightMatch ? parseFloat(weightMatch[1]) : 1,
    date: dateMatch ? dateMatch[1] : null,
    flavor: flavorMatch || 'default',
  };
}

function parseModelJSON(raw) {
  const cleaned = raw.replace(/^```json\s*|```\s*$/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    // Normalise: support both new {items:[]} shape and legacy single-item shape
    const rawItems = Array.isArray(parsed.items) && parsed.items.length > 0
      ? parsed.items
      : [{ weightKg: parsed.weightKg, flavor: parsed.flavor, date: parsed.date }];
    const items = rawItems.map(item => ({
      weightKg: typeof item.weightKg === 'number' ? item.weightKg : 1,
      flavor: (item.flavor || 'default').toLowerCase(),
      date: item.date || null,
    }));
    return {
      items,
      confidence: parsed.confidence === 'high' ? 'high' : 'low',
      reasoning: parsed.reasoning || '',
      usedFallback: false,
    };
  } catch (e) {
    return {
      items: [{ weightKg: 1, flavor: 'default', date: null }],
      confidence: 'low',
      reasoning: 'Model response could not be parsed as JSON — escalating rather than guessing.',
    };
  }
}

async function callGemini(message, apiKey) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ parts: [{ text: message }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  return parseModelJSON(raw);
}

async function callClaude(message, apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: message }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  const raw = textBlock ? textBlock.text.trim() : '{}';
  return parseModelJSON(raw);
}

async function parseOrderWithLLM(message) {
  const geminiKey = process.env.GEMINI_API_KEY;
  const claudeKey = process.env.ANTHROPIC_API_KEY;

  try {
    if (geminiKey) return await callGemini(message, geminiKey);
    if (claudeKey) return await callClaude(message, claudeKey);
  } catch (err) {
    // Keep the demo usable when the provider is temporarily unreachable.
    // The deterministic parser is only trusted when all core fields are explicit.
    const fallback = heuristicParse(message);
    const complete = Boolean(message.match(/(\d+(\.\d+)?)\s*kg/i) && fallback.date && fallback.flavor !== 'default');
    return {
      items: [{ weightKg: fallback.weightKg, flavor: fallback.flavor, date: fallback.date }],
      confidence: complete ? 'high' : 'low',
      reasoning: complete
        ? `Model unavailable (${err.message}); used deterministic parser because weight, flavor, and date were explicit.`
        : `Model unavailable (${err.message}); required order fields were not explicit, so review is required.`,
      usedFallback: true,
    };
  }

  console.warn('[llmAgent] No GEMINI_API_KEY or ANTHROPIC_API_KEY set — using regex fallback, forced to low confidence.');
  return {
    ...heuristicParse(message),
    confidence: 'low',
    reasoning: 'No model API key configured — parsed with a regex fallback instead of the model, so treated as low-confidence and escalated for human review.',
    usedFallback: true,
  };
}

function activeProvider() {
  if (process.env.GEMINI_API_KEY) return 'gemini-2.5-flash';
  if (process.env.ANTHROPIC_API_KEY) return 'claude-sonnet-5';
  return 'regex-fallback';
}

module.exports = { parseOrderWithLLM, activeProvider };
