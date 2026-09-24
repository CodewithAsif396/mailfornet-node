/**
 * Mailfornet — disposable inboxes for automated tests.
 *
 * The whole point of this client is that a test should read like the thing it is testing:
 *
 *   const inbox = await mf.createInbox();
 *   await signUp(inbox.address);
 *   const code = await mf.waitForCode(inbox.address);
 *
 * No polling loop, no IMAP, no shared mailbox that two test runs fight over.
 *
 * Docs: https://mailfornet.com/api
 */

const DEFAULT_BASE_URL = 'https://api.mailfornet.com/v1';

/** An error the API returned, carrying the parts a caller can actually branch on. */
export class MailfornetError extends Error {
  constructor(message, { status, code, type, requestId } = {}) {
    super(message);
    this.name = 'MailfornetError';
    /** HTTP status. */
    this.status = status;
    /** Stable machine-readable code, e.g. "quota_exceeded". Branch on this, never on the message. */
    this.code = code;
    this.type = type;
    /** Quote this to support and they can find the exact request. */
    this.requestId = requestId;
  }
}

export class Mailfornet {
  /**
   * @param {string} [apiKey] Your API key. Defaults to process.env.MAILFORNET_API_KEY.
   * @param {{ baseUrl?: string, fetch?: typeof fetch }} [options]
   */
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey || globalThis.process?.env?.MAILFORNET_API_KEY;
    if (!this.apiKey) {
      throw new Error('Mailfornet: pass an API key, or set MAILFORNET_API_KEY. Create one at https://mailfornet.com/account');
    }
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetch = options.fetch || globalThis.fetch;
  }

  async #request(path, { method = 'GET', body, query, idempotencyKey } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const res = await this.fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new MailfornetError(`Mailfornet returned a non-JSON response (${res.status})`, { status: res.status });
    }
    if (!res.ok) {
      const e = data.error || {};
      throw new MailfornetError(e.message || `Request failed (${res.status})`, {
        status: res.status,
        code: e.code,
        type: e.type,
        requestId: data.requestId || res.headers.get('mailfornet-request-id'),
      });
    }
    // Quota headers are useful in CI logs when a run starts failing near the end of the month
    Object.defineProperty(data, 'rateLimit', {
      enumerable: false,
      value: {
        limit: Number(res.headers.get('x-ratelimit-limit')) || 0,
        remaining: Number(res.headers.get('x-ratelimit-remaining')) || 0,
        credits: res.headers.has('x-credits-remaining') ? Number(res.headers.get('x-credits-remaining')) : null,
      },
    });
    return data;
  }

  /**
   * Creates a disposable inbox.
   * @param {{ username?: string, domain?: string, ttlMinutes?: number, idempotencyKey?: string }} [options]
   */
  createInbox(options = {}) {
    const { idempotencyKey, ...body } = options;
    return this.#request('/inboxes', { method: 'POST', body, idempotencyKey });
  }

  /** Deletes an inbox and everything in it, without waiting for it to expire. */
  deleteInbox(address) {
    return this.#request(`/inboxes/${encodeURIComponent(address)}`, { method: 'DELETE' });
  }

  /**
   * Lists what has arrived. With `wait`, the request holds open until something does — which is why
   * you never have to write a polling loop against this API.
   *
   * @param {string} address
   * @param {{ wait?: number, limit?: number, since?: number, from?: string, subject?: string }} [options]
   */
  async listMessages(address, options = {}) {
    const data = await this.#request(`/inboxes/${encodeURIComponent(address)}/messages`, { query: options });
    return data.messages;
  }

  /** Reads one message in full, with its text, HTML and attachments. */
  getMessage(address, id) {
    return this.#request(`/messages/${encodeURIComponent(id)}`, { query: { address } });
  }

  /**
   * Waits for one message and returns it in full.
   *
   * Long-polls in slices, because a single request can hold for at most a minute; a test that waits two
   * minutes for a slow provider should not have to know that.
   *
   * @param {string} address
   * @param {{ timeout?: number, from?: string, subject?: string, since?: number }} [options]
   * @returns {Promise<object>} the full message
   */
  async waitForMessage(address, options = {}) {
    const { timeout = 60, from, subject, since = Date.now() - 1000 } = options;
    const deadline = Date.now() + timeout * 1000;

    while (Date.now() < deadline) {
      const wait = Math.min(60, Math.ceil((deadline - Date.now()) / 1000));
      const messages = await this.listMessages(address, { wait, from, subject, since, limit: 10 });
      if (messages.length) return this.getMessage(address, messages[0].id);
    }
    throw new MailfornetError(
      `No message arrived at ${address} within ${timeout}s`,
      { code: 'message_timeout' }
    );
  }

  /**
   * Waits for a message and pulls the verification code out of it — the one thing nearly every caller
   * does with the message anyway.
   *
   * @param {string} address
   * @param {{ timeout?: number, from?: string, subject?: string, pattern?: RegExp, digits?: number }} [options]
   * @returns {Promise<string>}
   */
  async waitForCode(address, options = {}) {
    const { pattern, digits = 6, ...rest } = options;
    const message = await this.waitForMessage(address, rest);
    // The plain-text part first: a code in the HTML is usually wrapped in markup that breaks a naive match
    const haystack = `${message.text || ''}\n${message.html || ''}`;
    const re = pattern || new RegExp(`(?<!\\d)\\d{${digits}}(?!\\d)`);
    const found = haystack.match(re);
    if (!found) {
      throw new MailfornetError(
        `Found the message from ${message.from} but no ${digits}-digit code in it`,
        { code: 'code_not_found' }
      );
    }
    return found[0];
  }

  /** Domains you can create addresses on. */
  async domains() {
    const { domains } = await this.#request('/domains');
    return domains;
  }

  /** Requests used this month, what's left, and any credits behind it. */
  usage() {
    return this.#request('/usage');
  }

  /* ---------------- Webhooks ---------------- */

  async webhooks() {
    const { webhooks } = await this.#request('/webhooks');
    return webhooks;
  }

  /** Registers an endpoint. The signing secret comes back once, here — store it. */
  createWebhook(url) {
    return this.#request('/webhooks', { method: 'POST', body: { url } });
  }

  deleteWebhook(id) {
    return this.#request(`/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /** Sends a signed sample event, so you can check your endpoint without emailing yourself. */
  testWebhook(id) {
    return this.#request(`/webhooks/${encodeURIComponent(id)}/test`, { method: 'POST' });
  }

  async webhookDeliveries(id) {
    const { deliveries } = await this.#request(`/webhooks/${encodeURIComponent(id)}/deliveries`);
    return deliveries;
  }
}

/**
 * Verifies that a webhook delivery really came from Mailfornet.
 *
 * Pass the raw request body, exactly as received — parsing and re-serialising it changes the bytes and
 * the signature will not match.
 *
 * @param {{ secret: string, body: string, signature: string, timestamp: string|number, toleranceSeconds?: number }} args
 * @returns {Promise<boolean>}
 */
export async function verifyWebhook({ secret, body, signature, timestamp, toleranceSeconds = 300 }) {
  if (!secret || !body || !signature || !timestamp) return false;
  // An old delivery replayed later is still correctly signed, so the timestamp is checked too
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  const expected = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');

  // Compare in constant time: a fast reject leaks how much of the signature was right
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export default Mailfornet;
