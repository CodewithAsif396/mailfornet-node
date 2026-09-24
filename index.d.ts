export interface Inbox {
  address: string;
  createdAt: string;
  expiresAt: string;
}

export interface MessageSummary {
  id: string;
  from: string;
  subject: string;
  /** The first line, so you can match a message without fetching it in full. */
  intro?: string;
  date?: string;
  seen?: boolean;
}

export interface Message extends MessageSummary {
  text?: string;
  html?: string;
  attachments?: Array<{ filename?: string; mimeType?: string; size?: number }>;
}

export interface Usage {
  month: string;
  used: number;
  quota: number;
  remaining: number;
  /** Unix seconds: when the monthly quota resets. */
  resetsAt: number;
  /** Prepaid requests, spent once the quota is gone. */
  credits: number;
}

export interface Webhook {
  id: number;
  url: string;
  createdAt: string;
  disabled: boolean;
  failCount: number;
}

export interface WebhookWithSecret extends Webhook {
  /** Shown once, when the webhook is created. */
  secret: string;
}

export interface Delivery {
  event: string;
  /** The HTTP status your endpoint returned; 0 if the request never completed. */
  status: number;
  error: string;
  at: string;
}

export class MailfornetError extends Error {
  status?: number;
  /** Stable machine-readable code, e.g. "quota_exceeded". Branch on this, not on the message. */
  code?: string;
  type?: string;
  requestId?: string;
}

export interface MailfornetOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface CreateInboxOptions {
  username?: string;
  domain?: string;
  /** 1 to 1440. Defaults to 60. */
  ttlMinutes?: number;
  /** Makes the call safe to retry: the same key returns the original inbox. */
  idempotencyKey?: string;
}

export interface ListMessagesOptions {
  /** Seconds to hold the request open waiting for mail, 0 to 60. */
  wait?: number;
  limit?: number;
  /** Only mail received after this unix timestamp in milliseconds. */
  since?: number;
  /** Substring match on the sender. */
  from?: string;
  /** Substring match on the subject. */
  subject?: string;
}

export interface WaitOptions {
  /** Seconds to keep waiting overall. Defaults to 60. */
  timeout?: number;
  from?: string;
  subject?: string;
  since?: number;
}

export interface WaitForCodeOptions extends WaitOptions {
  /** Defaults to a run of exactly this many digits. */
  digits?: number;
  /** Overrides `digits` when the code isn't numeric. */
  pattern?: RegExp;
}

export class Mailfornet {
  constructor(apiKey?: string, options?: MailfornetOptions);
  createInbox(options?: CreateInboxOptions): Promise<Inbox>;
  deleteInbox(address: string): Promise<{ deleted: boolean; address: string }>;
  listMessages(address: string, options?: ListMessagesOptions): Promise<MessageSummary[]>;
  getMessage(address: string, id: string): Promise<Message>;
  /** Waits for a message to arrive and returns it in full. Throws after `timeout`. */
  waitForMessage(address: string, options?: WaitOptions): Promise<Message>;
  /** Waits for a message and pulls the verification code out of it. */
  waitForCode(address: string, options?: WaitForCodeOptions): Promise<string>;
  domains(): Promise<string[]>;
  usage(): Promise<Usage>;
  webhooks(): Promise<Webhook[]>;
  createWebhook(url: string): Promise<WebhookWithSecret>;
  deleteWebhook(id: number | string): Promise<{ deleted: boolean }>;
  testWebhook(id: number | string): Promise<{ delivery: Delivery }>;
  webhookDeliveries(id: number | string): Promise<Delivery[]>;
}

/** Verifies a webhook signature. Pass the raw body exactly as received. */
export function verifyWebhook(args: {
  secret: string;
  body: string;
  signature: string;
  timestamp: string | number;
  toleranceSeconds?: number;
}): Promise<boolean>;

export default Mailfornet;
