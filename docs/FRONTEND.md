# Frontend contract

What a browser frontend needs to know to talk to this backend: how a person signs in, how the session lives, how to read
an answer. The frontend is served from the same site as the API (`https://<APP_HOST>`, the API under `/api`); a frontend
on another origin is not supported out of the box.

## Answers

Every JSON answer is an envelope:

```jsonc
// success
{ "status": "success", "data": { "id": "…" }, "meta": { "requestId": "…" } }

// error
{ "status": "error", "code": "VALIDATION_ERROR", "message": "Validation error",
  "validation": [{ "column": "email", "columnValue": "anna.example.com", "operator": "format", "operatorValue": "email" }],
  "meta": { "requestId": "…" } }
```

- **Show text by `code`**, never by `message` (English text for developers and logs) or by the HTTP status alone. `code` is
  the key of your translations. It is there only in errors: a success is told by its status.
- `data` is in every success, `null` when there is nothing to give. A list also has `pagination`, `sort` and `filters`.
- `422 VALIDATION_ERROR` carries `validation[]`: bind each entry to the form field named by `column` (a dotted path).
- `204` has no body: do not parse it.
- `401` and `403` mean the session or the rights, nothing else. An overload is `503 SERVICE_UNAVAILABLE_ERROR` and a limit
  is `429 RATE_LIMIT_ERROR`, both with `Retry-After`. Judge by the `code` of our envelope: a `503` from a proxy in front of
  the API has none.
- `X-Request-Id` (also `meta.requestId`) names the request in the logs of the server: show it with an error report.

Rules for requests:

- A request without a body sends no `Content-Type: application/json`: an empty body under that type is answered `400`.
- Check an id before you put it into a path (`/api/v1/users/${id}`): take only a lower-case UUID. A value from the address
  bar or from storage can hold `../` or `?` and reach another route.

**If you know the old starter (v1):** `code` is no longer inside `data` and is never on a success; validation errors are
`422` (not `400`) with `validation[]`; `204` has no body.

## Signing in

There are no passwords: a person signs in with an OIDC provider (Google and Telegram are ready-made, any other is one
record of the backend config).

1. **Buttons.** `GET /api/v1/auth/providers` lists the providers that are on: `data: [{ "id": "google", "name": "Google" }]`.
   Draw one button per entry. The list is empty when none has its credentials.
2. **Start.** A button is a **top-level navigation** (a link or `location.assign`), never a `fetch`:
   `/api/v1/auth/<id>?redirect=<path>`. The backend sets a short-lived cookie for the flow and sends the browser to the
   provider. `redirect` is where to come back to: a path of this site (`/orders/42?tab=1`) that starts with a single `/`, of
   printable ASCII without spaces or `\`, without `.` or `..` segments and outside `/auth`. A target that breaks one of these
   is ignored and the person lands on `/`; one longer than 512 characters fails the start with `VALIDATION_ERROR`, so cut a
   long query off before you pass it.
3. **Back.** The provider returns the browser to the backend, and the backend answers with a redirect again, never with
   JSON:
   - success: to the `redirect` path (or `/`), with the session cookies set;
   - failure: to `/auth/login?authError=<code>`.
4. Once back, read the state with `GET /api/v1/auth/me` (`id` and `scopes`; the profile is `GET /api/v1/users/me`).

One flow at a time per provider in one browser: a second start replaces the cookie of the first, and the first then ends
with `AUTHENTICATION_ERROR`. The flow cookie lives 10 minutes.

`authError` codes of a sign-in:

| Code | Meaning | What to show |
|---|---|---|
| `AUTHENTICATION_ERROR` | cancelled at the provider, too slow (over 10 minutes), the flow cookie is gone or replaced, the code of the provider was spent | "Sign-in did not finish, try again" |
| `AUTHORIZATION_ERROR` | the account is blocked | "The account is blocked" |
| `CONTACT_TAKEN` | the email the provider confirmed belongs to another account that has not confirmed it; nothing was created | "This email is used by another account: sign in to it and confirm the email, or contact support" |
| `UPSTREAM_ERROR` | the provider failed or refused the backend | "The provider is not available, try another way or later" |
| `SERVICE_UNAVAILABLE_ERROR` | the backend is overloaded | "Try again in a minute" |
| `RATE_LIMIT_ERROR` | too many attempts | "Too many attempts, wait a little" |
| `VALIDATION_ERROR`, `SERVER_ERROR` | a broken callback, a fault of the backend | a generic error with a retry |

Accounts merge by email only when both the provider and this backend have confirmed it; otherwise a sign-in never joins
an existing account.

### Linking another provider

A signed-in person can add another way to sign in (for example Google to an account made through Telegram):

1. Refresh first (`POST /api/v1/auth/refresh`, see below): the access token is checked again when the provider sends the
   browser back, and it lives only 10 minutes.
2. Navigate to `/api/v1/auth/<id>?link=true&redirect=<page>`.
3. Back on `<page>`: `?linked=<id>` on success; `?authError=<code>` on failure:
   - `IDENTITY_TAKEN` — that provider account is already linked to another account;
   - `SESSION_REVOKED` — the session is over: delete both markers and go to sign-in;
   - `AUTHENTICATION_ERROR` — as for a sign-in (cancelled, too slow, the flow cookie gone or replaced), or the access token
     ran out or belongs to another session than the one that started the link: refresh and start again;
   - any other code of the table above.

## The session

Both tokens live in httpOnly cookies the page cannot read; the browser sends them by itself (same site). Two marker cookies
the page can read say what is there, and hold no secret:

| Cookie | Lives | Means |
|---|---|---|
| `hasSession` | as long as the refresh token (30 days, sliding) | a session can be refreshed |
| `hasAccess` | as long as the access token (10 minutes) | the access token is still valid |

- **Guest** (no `hasSession`): do not call `/auth/me` or `/auth/refresh`. SSR redirects a guest away from private pages
  before it renders, by the markers alone.
- **`hasSession` without `hasAccess`**: refresh before the first request. The lifetime of `hasAccess` replaces "refresh
  shortly before `exp`", which the page cannot read.
- **`AUTHENTICATION_ERROR` from any other route while `hasSession` is there**: one refresh (`refreshSession({ force: true })`
  below), then the request once more, whatever `hasAccess` says (a marker can outlive its token by a moment).
- **`SESSION_REVOKED` from any route**: the session is over (signed out elsewhere, revoked, blocked). Delete both markers
  and go to sign-in, without retries.

### Refresh

`POST /api/v1/auth/refresh`, no body, no `Content-Type`. The refresh token rides only in its cookie.

Run it **under a Web Lock**, once for all tabs. Before a request (`hasSession` without `hasAccess`), look at `hasAccess`
again once you hold the lock — another tab may have refreshed meanwhile. After an `AUTHENTICATION_ERROR` from a route,
refresh whatever the marker says (`force`): it may have outlived its token.

```js
async function refreshSession({ force = false } = {}) {
  return navigator.locks.request('auth-refresh', async () => {
    if (!force && hasCookie('hasAccess')) {
      return 'refreshed';
    }

    const response = await fetch('/api/v1/auth/refresh', { method: 'POST' });

    if (response.ok) {
      return 'refreshed';
    }

    const code = await readCode(response); // the envelope's code, or null when the answer is not ours

    if (code === 'SESSION_REVOKED') {
      deleteMarkers();
      return 'signed-out';
    }

    if (code === 'AUTHENTICATION_ERROR') {
      if (hasCookie('hasAccess')) {
        return 'refreshed';
      }

      deleteMarkers();
      return 'signed-out';
    }

    // RATE_LIMIT_ERROR, SERVICE_UNAVAILABLE_ERROR: not a sign-out, try again later.
    // A 500, a broken connection or an answer that is not ours: the result is unknown; refresh once more, and a
    // SESSION_REVOKED on that one means sign-in.
    return 'unknown';
  });
}
```

- A refresh token is good for one use. Do not let an HTTP client, a service worker or a proxy repeat
  `POST /api/v1/auth/refresh` by itself: a second use of a replaced token is taken for theft and ends the session.
- `SESSION_REVOKED` from `/refresh` has cleared the session cookies already; the markers are yours to delete.

### Sign-out

`POST /api/v1/auth/logout` needs a live access token: when `hasAccess` is gone, refresh first. It answers `204` and clears
the cookies of its session. Other devices: `GET /api/v1/sessions` lists them (`isCurrent` marks this one),
`DELETE /api/v1/sessions/:id` ends one, `DELETE /api/v1/sessions?except=current` all others,
`DELETE /api/v1/sessions?scope=all` all of them.

## Development

- **Dev sign-in.** With `APP_MODE=dev` the backend has `POST /api/v1/auth/login-dev` with `{ "email": "anna@example.com" }`:
  it signs in as that email (and creates the account with the email confirmed). It sets the cookies like any sign-in and
  also gives `data.accessToken`, for the Authorize button of Swagger (`/docs`) and for curl
  (`Authorization: Bearer <token>`). It answers only requests that come from this machine; to anything else it is a
  missing route.
- **Dev proxy.** A dev server that proxies `/api` must pass on the address of the browser and keep its `Host`, or every
  device that reaches the dev server would count as this machine:

  ```js
  // vite.config.js
  export default {
    server: {
      proxy: {
        '/api': { target: 'http://127.0.0.1:4173', xfwd: true, changeOrigin: false },
      },
    },
  };
  ```

  With nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` and `proxy_set_header Host $host;`.
