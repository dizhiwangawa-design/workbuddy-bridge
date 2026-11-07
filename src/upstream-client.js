import { randomUUID } from 'node:crypto';
import { loadConfig } from './paths.js';

const DEFAULT_BASE_URL = 'https://copilot.tencent.com';
const DEFAULT_TIMEOUT_MS = 900_000;
const PRODUCT_VERSION = '5.5.6';
const USER_AGENT = 'WorkBuddy/5.5.6 (CLI/2.137.1)';

const SIGNATURES = [
  ['You are an AI agent powered by DeepSeek Harness.', 'You are an AI coding agent.'],
  ['Tokens prefixed with @ are paths the user explicitly referenced.', 'Paths may begin with @ when the user references them.'],
  ['DeepSeek Harness Web GUI', 'Web GUI'],
  [
    'Codex CLI is an open source project led by OpenAI.',
    'Codex CLI is an open source coding interface.',
  ],
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scrubValue(value) {
  if (typeof value === 'string') {
    const before = value;
    for (const [from, to] of SIGNATURES) {
      value = value.replace(new RegExp(escapeRegExp(from), 'gi'), to);
    }
    return { value, changed: value !== before };
  }

  if (Array.isArray(value)) {
    let changed = false;
    for (let i = 0; i < value.length; i += 1) {
      const next = scrubValue(value[i]);
      value[i] = next.value;
      changed ||= next.changed;
    }
    return { value, changed };
  }

  if (value && typeof value === 'object') {
    let changed = false;
    for (const key of Object.keys(value)) {
      const next = scrubValue(value[key]);
      value[key] = next.value;
      changed ||= next.changed;
    }
    return { value, changed };
  }

  return { value, changed: false };
}

export function sanitizeChatBody(input) {
  const body = structuredClone(input);
  let developerRoles = 0;
  let scrubbedStrings = 0;

  for (const message of body?.messages || []) {
    if (message?.role === 'developer') {
      message.role = 'system';
      developerRoles += 1;
    }
    if (message?.role === 'system' && message?.content !== undefined) {
      const next = scrubValue(message.content);
      message.content = next.value;
      if (next.changed) scrubbedStrings += 1;
    }
  }

  return { body, developerRoles, scrubbedStrings };
}

async function request(fetchImpl, url, init, {
  signal,
  timeoutMs,
}) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener('abort', onAbort, { once: true });

  const timer = setTimeout(() => {
    controller.abort(new Error('upstream timeout'));
  }, timeoutMs);

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function baseHeaders(credentials) {
  const headers = {
    'x-product': 'WorkBuddy',
    'x-product-version': PRODUCT_VERSION,
    'x-ide-type': 'WorkBuddy',
    'x-ide-name': 'WorkBuddy',
    'x-ide-version': PRODUCT_VERSION,
    'user-agent': USER_AGENT,
  };
  if (credentials.uid) headers['x-user-id'] = String(credentials.uid);
  return headers;
}

function workbuddyToolChoice(choice) {
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return choice;
  if (choice.type === 'function' && choice.function?.name) {
    return String(choice.function.name);
  }
  if (choice.type === 'auto' || choice.type === 'none') return choice.type;
  if (choice.type === 'any' || choice.type === 'required') return 'required';
  return choice;
}

async function readJsonResponse(response, operation) {
  if (!response.ok) {
    throw Object.assign(
      new Error(`upstream ${operation} HTTP ${response.status}`),
      { status: response.status },
    );
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`upstream ${operation} returned invalid JSON`);
  }
}

export function createUpstreamClient({
  fetchImpl = globalThis.fetch,
  baseUrl,
  timeoutMs,
} = {}) {
  const apiConfig = loadConfig().apiCompat || {};
  const endpoint = String(baseUrl || apiConfig.upstreamBaseUrl || DEFAULT_BASE_URL)
    .replace(/\/+$/, '');
  const requestTimeoutMs = Number(timeoutMs ?? apiConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  return {
    async chat({
      accountId,
      credentials,
      model,
      body,
      sanitize = true,
      signal,
    }) {
      const outbound = { ...body, model, stream: true };
      delete outbound.stream_options;
      outbound.tool_choice = workbuddyToolChoice(outbound.tool_choice);
      const prepared = sanitize
        ? sanitizeChatBody(outbound).body
        : outbound;
      const requestId = randomUUID();
      const accountSuffix = String(accountId || '')
        .replace(/[^a-zA-Z0-9]/g, '')
        .slice(0, 12);
      const headers = {
        ...baseHeaders(credentials),
        authorization: `Bearer ${credentials.accessToken}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-requested-with': 'XMLHttpRequest',
        'x-model-id': model,
        'x-request-id': requestId,
        'x-agent-intent': 'craft',
        'x-agent-type': 'main',
        'x-codebuddy-request': '1',
        'x-conversation-id': `wbbridge-${accountSuffix}`,
        'x-conversation-request-id': requestId,
        'x-conversation-message-id': requestId,
      };

      return request(
        fetchImpl,
        `${endpoint}/v2/chat/completions`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(prepared),
        },
        { signal, timeoutMs: requestTimeoutMs },
      );
    },

    async refresh(credentials) {
      if (!credentials.refreshToken) throw new Error('账号没有可用的 refresh token');
      const response = await request(
        fetchImpl,
        `${endpoint}/v2/plugin/auth/token/refresh`,
        {
          method: 'POST',
          headers: {
            ...baseHeaders(credentials),
            'x-refresh-token': credentials.refreshToken,
            'x-auth-refresh-source': 'plugin',
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: '{}',
        },
        { timeoutMs: requestTimeoutMs },
      );
      const document = await readJsonResponse(response, 'token refresh');
      const data = document?.data;
      if (typeof data?.accessToken !== 'string' || !data.accessToken) {
        throw new Error('upstream token refresh response is missing accessToken');
      }
      return {
        accessToken: data.accessToken,
        refreshToken: typeof data.refreshToken === 'string' ? data.refreshToken : undefined,
        expiresIn: data.expiresIn,
        refreshExpiresIn: data.refreshExpiresIn,
      };
    },

    async models(credentials) {
      const response = await request(
        fetchImpl,
        `${endpoint}/v2/enterprises/personal/models`,
        {
          method: 'GET',
          headers: {
            ...baseHeaders(credentials),
            authorization: `Bearer ${credentials.accessToken}`,
            accept: 'application/json',
          },
        },
        { timeoutMs: requestTimeoutMs },
      );
      return readJsonResponse(response, 'models');
    },
  };
}
