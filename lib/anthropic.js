/**
 * Anthropic API Client & Helpers for Tennis Group Bot.
 * Centralizes all Anthropic LLM calls, authentication headers,
 * model defaults, and JSON response extraction.
 */

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Checks whether an Anthropic API key is configured in environment.
 */
function isAnthropicConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim());
}

/**
 * Base method to call Anthropic Messages API.
 *
 * @param {Object} options
 * @param {Array} options.messages - Array of { role, content } message objects.
 * @param {string} [options.system] - Optional system prompt.
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

  const payload = {
    model: model || DEFAULT_MODEL,
    max_tokens: maxTokens,
    messages
  };

  if (system) {
    payload.system = system;
  }

  if (Array.isArray(tools) && tools.length > 0) {
    payload.tools = tools;
  }

  if (typeof temperature === 'number') {
    payload.temperature = temperature;
  }

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY.trim(),
      'anthropic-version': ANTHROPIC_VERSION
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errBody}`);
  }

  return await response.json();
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
 * @param {string} [options.system] - Optional system prompt.
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
  const msgs = messages || [{ role: 'user', content: prompt }];
  const data = await callAnthropicMessages({
    messages: msgs,
    system,
    model,
    maxTokens
  });

  const rawText = extractTextFromResponse(data);
  const cleaned = rawText
    .replace(/^```json\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  return JSON.parse(cleaned);
}

module.exports = {
  DEFAULT_MODEL,
  ANTHROPIC_API_URL,
  isAnthropicConfigured,
  callAnthropicMessages,
  extractTextFromResponse,
  callAnthropicJson
};
