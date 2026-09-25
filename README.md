<div align="center">

<img src="https://mailfornet.com/assets/img/logo.png" width="64" height="64" alt="" />

# mailfornet

**Disposable email inboxes for automated tests.**
Create an address, sign up with it, read the verification code back out — from your test code.

[![npm](https://img.shields.io/npm/v/mailfornet?color=2563eb)](https://www.npmjs.com/package/mailfornet)
[![types](https://img.shields.io/badge/types-included-2563eb)](https://www.npmjs.com/package/mailfornet)
[![dependencies](https://img.shields.io/badge/dependencies-0-2563eb)](https://www.npmjs.com/package/mailfornet)
[![license](https://img.shields.io/npm/l/mailfornet?color=2563eb)](./LICENSE)

[Documentation](https://mailfornet.com/developers) ·
[API reference](https://mailfornet.com/api) ·
[Quickstart](https://mailfornet.com/developers/quickstart) ·
[Pricing](https://mailfornet.com/developers/pricing)

</div>

---

```bash
npm install mailfornet
```

```js
import { Mailfornet } from 'mailfornet';

const mf = new Mailfornet();                        // reads MAILFORNET_API_KEY

const inbox = await mf.createInbox();               // a fresh address
await signUpOnYourApp(inbox.address);
const code = await mf.waitForCode(inbox.address);   // "493021"
```

That's the whole thing. `waitForCode` holds the connection open until the mail arrives and returns the moment it does — there is no polling loop to write and nothing to tune.

## Why

A test that signs a user up needs a real inbox to read the code out of, and a **different** address on every run so two runs never collide.

The usual answers all have a catch. A shared team mailbox breaks the moment tests run in parallel. Plus-addressing (`you+test1@gmail.com`) is rejected by a growing number of signup forms. IMAP means credentials in CI, a polling loop, and mail from last week still sitting there.

This gives each run its own inbox, over HTTP, and hands the mail back as JSON.

## Contents

- [Getting a key](#getting-a-key)
- [In a real test](#in-a-real-test)
- [When the mail isn't a 6-digit code](#when-the-mail-isnt-a-6-digit-code)
- [Webhooks](#webhooks)
- [Errors](#errors)
- [Usage and quota](#usage-and-quota)
- [API](#api)
- [TypeScript](#typescript)
- [Requirements](#requirements)

## Getting a key

Create a developer account at [mailfornet.com/developers/signup](https://mailfornet.com/developers/signup), then make a key in your account.

```bash
export MAILFORNET_API_KEY="mfk_..."
```

The client reads `MAILFORNET_API_KEY` automatically, or you can pass the key in: `new Mailfornet(key)`.

For CI, create the key with an **expiry date**, and an **IP allowlist** if your runners have fixed addresses. A key that only works from your CI is a far smaller problem if it ever leaks. Read-only keys are available too, for anything that should never create or delete.

## In a real test

```js
import { test, expect } from '@playwright/test';
import { Mailfornet } from 'mailfornet';

const mf = new Mailfornet();

test('a new user can verify their email', async ({ page }) => {
  const { address } = await mf.createInbox({ ttlMinutes: 15 });

  await page.goto('/signup');
  await page.fill('#email', address);
  await page.click('button[type=submit]');

  const code = await mf.waitForCode(address, { subject: 'verify', timeout: 60 });

  await page.fill('#code', code);
  await page.click('button[type=submit]');
  await expect(page.locator('.welcome')).toBeVisible();
});
```

Every run gets its own address, so tests can run in parallel without treading on each other. It works the same way in Cypress, Jest, Vitest or a plain script — there is nothing framework-specific in the client.

<details>
<summary>Cypress</summary>

Cypress commands run in the browser, so call the client from a task in `cypress.config.js`:

```js
import { defineConfig } from 'cypress';
import { Mailfornet } from 'mailfornet';

const mf = new Mailfornet();

export default defineConfig({
  e2e: {
    setupNodeEvents(on) {
      on('task', {
        createInbox: () => mf.createInbox(),
        waitForCode: (address) => mf.waitForCode(address),
      });
    },
  },
});
```

```js
cy.task('createInbox').then(({ address }) => {
  cy.get('#email').type(address);
  cy.get('button[type=submit]').click();
  cy.task('waitForCode', address, { timeout: 70000 }).then((code) => {
    cy.get('#code').type(code);
  });
});
```

Give the task a Cypress `timeout` longer than the one you pass the client, or Cypress gives up first.

</details>

<details>
<summary>Jest / Vitest</summary>

```js
import { Mailfornet } from 'mailfornet';

const mf = new Mailfornet();

test('password reset emails a working link', async () => {
  const { address } = await mf.createInbox();
  await registerUser(address);

  await requestPasswordReset(address);
  const mail = await mf.waitForMessage(address, { subject: 'Reset' });

  const link = mail.html.match(/https:\/\/[^"']+\/reset\/[^"']+/)[0];
  expect(link).toBeTruthy();
}, 90_000);   // the test timeout must outlast the wait
```

</details>

## When the mail isn't a 6-digit code

```js
// A confirmation, magic-login or reset link: the server finds it, no regex needed
const link = await mf.waitForLink(address, { subject: 'Confirm' });

// Code and link together, plus who sent it. Mail with neither (a welcome email) is skipped.
const { code, link: confirmUrl, subject } = await mf.waitForVerification(address);

// Every message also carries what was extracted from it
const mail = await mf.waitForMessage(address);
console.log(mail.code, mail.verificationLink, mail.links);

// A code that isn't six digits
const token = await mf.waitForCode(address, { pattern: /[A-Z0-9]{8}/ });

// A code that is, say, four digits
const pin = await mf.waitForCode(address, { digits: 4 });
```

If your app sends more than one email, filter with `from` or `subject` so the test doesn't grab whichever arrived first.

## Webhooks

Rather than waiting, be told. Register an endpoint and Mailfornet posts to it the moment mail lands:

```js
const hook = await mf.createWebhook('https://your-app.com/hooks/mail');
console.log(hook.secret);        // shown once — store it

await mf.testWebhook(hook.id);   // sends a signed sample event
```

Verify every delivery before trusting it. Pass the **raw** body — parsing and re-serialising it changes the bytes, and the signature will not match:

```js
import { verifyWebhook } from 'mailfornet';

app.post('/hooks/mail', express.raw({ type: 'application/json' }), async (req, res) => {
  const ok = await verifyWebhook({
    secret: process.env.MAILFORNET_WEBHOOK_SECRET,
    body: req.body.toString(),
    signature: req.get('mailfornet-signature'),
    timestamp: req.get('mailfornet-timestamp'),
  });
  if (!ok) return res.status(400).end();

  const { data } = JSON.parse(req.body);
  console.log('mail for', data.address, 'from', data.from);
  res.sendStatus(200);
});
```

`verifyWebhook` checks the timestamp as well as the signature, so a correctly signed delivery replayed days later is still rejected.

## Errors

Failures throw a `MailfornetError` carrying a stable `code`. Branch on that, never on the message, which may be reworded:

```js
import { MailfornetError } from 'mailfornet';

try {
  await mf.createInbox({ username: 'taken' });
} catch (err) {
  if (err instanceof MailfornetError) {
    if (err.code === 'address_taken')   { /* pick another */ }
    if (err.code === 'quota_exceeded')  { /* out of requests this month */ }
    if (err.code === 'message_timeout') { /* nothing arrived in time */ }
    console.log(err.status, err.requestId);   // quote the request id to support
  }
}
```

## Usage and quota

Every response carries the quota headers, read off a non-enumerable `rateLimit` property:

```js
const usage = await mf.usage();
console.log(usage.rateLimit.limit, usage.rateLimit.remaining, usage.rateLimit.credits);
```

Worth logging in CI: a run that starts failing near the end of the month then explains itself.

One HTTP call is one request. A long-poll that holds open for a minute is still **one** request, not one a second — which is why waiting costs less than polling.

## API

| | |
|---|---|
| `createInbox({ username?, domain?, ttlMinutes?, idempotencyKey? })` | A disposable address. 1–1440 minutes, default 60. |
| `waitForCode(address, { timeout?, from?, subject?, digits?, pattern? })` | Waits for mail, returns the code. |
| `waitForVerification(address, { timeout?, from?, subject?, since? })` | Waits for a verification mail, returns `{ code, link, messageId, from, subject }`. |
| `waitForLink(address, { timeout?, from?, subject?, since? })` | Waits for a confirm/magic/reset link, returns the URL. |
| `waitForMessage(address, { timeout?, from?, subject?, since? })` | Waits for mail, returns the whole message. |
| `listMessages(address, { wait?, limit?, since?, from?, subject? })` | What has arrived. |
| `getMessage(address, id)` | One message, with text, HTML, attachments, and the extracted `code`, `links` and `verificationLink`. |
| `deleteInbox(address)` | Delete it now rather than waiting for it to expire. |
| `domains()` | Domains you can create addresses on. |
| `usage()` | Requests used this month, and what's left. |
| `webhooks()` / `createWebhook(url)` / `deleteWebhook(id)` | Manage endpoints. |
| `testWebhook(id)` / `webhookDeliveries(id)` | Send a sample event; see what was delivered. |
| `verifyWebhook({ secret, body, signature, timestamp })` | Standalone. Returns a boolean. |

Retrying a create is safe: pass an `idempotencyKey` and a repeated call returns the first inbox instead of making a second.

Full reference: **[mailfornet.com/api](https://mailfornet.com/api)** · OpenAPI spec: **[mailfornet.com/openapi.json](https://mailfornet.com/openapi.json)**

## TypeScript

Types ship with the package — nothing to install.

```ts
import { Mailfornet, MailfornetError, verifyWebhook } from 'mailfornet';

const mf = new Mailfornet(process.env.MAILFORNET_API_KEY, {
  baseUrl: 'https://api.mailfornet.com/v1',   // optional
  fetch: customFetch,                          // optional
});
```

## Requirements

Node 18 or newer, or any runtime with `fetch` and Web Crypto — Deno, Bun and Cloudflare Workers included. **No dependencies.**

## Support

Questions or a problem: [mailfornet.com/contact](https://mailfornet.com/contact). Include the `requestId` from the error and we can find the exact request.

## License

MIT © [Mubarah Solutions LLC](https://mailfornet.com)
