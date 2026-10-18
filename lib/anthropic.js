/**
 * Anthropic API Client & Helpers for Tennis Group Bot.
 * Centralizes all Anthropic LLM calls, authentication headers,
 * model defaults, and JSON response extraction.
 */

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA_HEADER = 'prompt-caching-2024-07-31';

/**
 * Checks whether an Anthropic API key is configured in environment.
 */
function isAnthropicConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim());
}

/**
 * Base method to call Anthropic Messages API.
 * Supports Anthropic Prompt Caching via cache_control breakpoints on tools, system blocks, or messages.
 *
 * @param {Object} options
 * @param {Array} options.messages - Array of { role, content } message objects.
 * @param {string|Array} [options.system] - Optional system prompt (string or array of content blocks).
 * @param {Array} [options.tools] - Optional array of tool definitions.
 * @param {string} [options.model] - Model name (defaults to DEFAULT_MODEL or process.env.ANTHROPIC_MODEL).
 * @param {number} [options.maxTokens=400] - Max tokens to generate.
 * @param {number} [options.temperature] - Optional temperature parameter.
 * @returns {Promise<Object>} Raw Anthropic JSON response.
 */
async function callAnthropicMessages({
  messages,
  system = null,
  tools = null,
  model = DEFAULT_MODEL,
  maxTokens = 400,
  temperature = undefined
}) {
  if (!isAnthropicConfigured()) {
    throw new Error('ANTHROPIC_API_KEY is not configured in environment.');
  }

  // Construct payload in logical prompt processing order: tools -> system -> messages
  const payload = {
    model: model || DEFAULT_MODEL,
    max_tokens: maxTokens
  };

  if (Array.isArray(tools) && tools.length > 0) {
    payload.tools = tools;
  }

  if (system) {
    payload.system = system;
  }

  payload.messages = messages;

  if (typeof temperature === 'number') {
    payload.temperature = temperature;
  }

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY.trim(),
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': ANTHROPIC_BETA_HEADER
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errBody}`);
  }

  const data = await response.json();
  if (data?.usage) {
    const { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens } = data.usage;
    const cacheStats = (cache_creation_input_tokens || cache_read_input_tokens)
      ? ` [cache: created=${cache_creation_input_tokens || 0}, read=${cache_read_input_tokens || 0}]`
      : '';
    console.log(`[anthropic] Tokens: in=${input_tokens}, out=${output_tokens}${cacheStats}`);
  }
  return data;
}

/**
 * Extracts plain text from an Anthropic message response content blocks.
 *
 * @param {Object} data - Raw Anthropic response JSON.
 * @returns {string} Concatenated text content.
 */
function extractTextFromResponse(data) {
  if (!data?.content || !Array.isArray(data.content)) return '';
  return data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/**
 * Calls Claude and parses the output as a JSON object.
 * Automatically handles stripping markdown code fences (```json ... ```).
 *
 * @param {Object} options
 * @param {string} [options.prompt] - Single prompt string for the user role.
 * @param {Array} [options.messages] - Array of { role, content } messages.
 * @param {string|Array} [options.system] - Optional system prompt (string or array of blocks).
 * @param {string} [options.model] - Model name.
 * @param {number} [options.maxTokens=300] - Max tokens to generate.
 * @returns {Promise<Object>} Parsed JSON object.
 */
async function callAnthropicJson({
  prompt,
  messages,
  system = null,
  model = DEFAULT_MODEL,
  maxTokens = 300
}) {
  const jsonSystemPrompt = 'You MUST respond with raw, valid JSON only. Do not include markdown code block formatting (like ```json), no preamble, no conversational filler, and no text outside the JSON object.';
  let effectiveSystem;
  if (Array.isArray(system)) {
    effectiveSystem = [...system, { type: 'text', text: jsonSystemPrompt }];
  } else if (typeof system === 'string' && system.trim()) {
    effectiveSystem = system + '\n\n' + jsonSystemPrompt;
  } else {
    effectiveSystem = jsonSystemPrompt;
  }

  const msgs = messages || [{ role: 'user', content: prompt }];
  const data = await callAnthropicMessages({
    messages: msgs,
    system: effectiveSystem,
    model,
    maxTokens
  });

  const rawText = extractTextFromResponse(data);
  let cleaned = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i)
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    // Robust extraction: isolate outermost JSON object or array
    const jsonMatch = rawText.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw err;
  }
}

module.exports = {
  DEFAULT_MODEL,
  ANTHROPIC_API_URL,
  isAnthropicConfigured,
  callAnthropicMessages,
  extractTextFromResponse,
  callAnthropicJson
};
