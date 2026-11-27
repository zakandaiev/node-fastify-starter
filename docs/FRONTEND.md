# Frontend contract

What a browser frontend needs to know to talk to this backend: how a person signs in, how the session lives, how to read
an answer, how to send a file. The frontend is served from the same site as the API (`https://<APP_HOST>`, the API
under `/api`); a frontend on another origin is not supported out of the box.

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
- `401` and `403` mean the session or the rights, but for `403 ORIGIN_ERROR`: a page whose origin the backend does not
  know (see Development). An overload is `503 SERVICE_UNAVAILABLE_ERROR` and a limit
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
| `CONTACT_TAKEN` | the email the provider confirmed belongs to another account that has not confirmed it, or to an account where it is an admin address no provider has confirmed; nothing was created | "This email is used by another account: sign in to it and confirm the email, or contact support" |
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
- **`SESSION_REVOKED` from any route**: the session is over (signed out elsewhere, revoked, blocked, deleted). Delete both
  markers and go to sign-in, without retries.

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

## Rights

`GET /api/v1/auth/me` gives `scopes`: the rights of the session, as codes such as `groups:read`. `*` is full access,
and `groups:*` is every action on groups. Show a control when the scopes grant its code; the backend decides all the
same.

```js
function isGranted(scopes, code) {
  return scopes.some((held) => held === '*' || held === code || (held.endsWith(':*') && code.startsWith(held.slice(0, -1))));
}
```

- The scopes ride in the access token: a change of the groups of a person reaches them with their next refresh, within
  the 10 minutes of the token. A route the session has no rights for answers `403 AUTHORIZATION_ERROR`.
- Groups are under `/api/v1/groups` (Swagger lists every route). `GET /api/v1/groups/scopes` gives what a group may
  grant, as `{ code, name, description }`: translate by `code`, the name and the description are an English fallback.
- One changes a group, its scopes and its members only holding all it grants (full access included), and never one's
  own memberships: `403 AUTHORIZATION_ERROR`. A system group (`isSystem`) keeps its slug and its full access, is never
  deleted and keeps one member at least: `409 GROUP_PROTECTED`; no other group may take its slug.
- A slug is words of lower-case Latin letters and digits joined by hyphens, up to 64 characters; a taken one answers
  `422` with `validation[]` on `slug`. `PATCH` with `scopes` replaces the whole list; an empty `PATCH` answers
  `409 NO_CHANGES`.
- `PUT /api/v1/groups/:groupId/members/:userId` adds a member and answers `204` also for one who is a member already;
  `DELETE` of a user who is no member answers `404`. The list of members also needs `users:read` or `users:manage`.

## Profile and users

- `GET /api/v1/users/me` gives the profile: `id`, `email`, `emailVerifiedAt`, `firstName`, `lastName`, `locale`,
  `timezone`, `avatarUrl`, `status`, `createdAt`, `updatedAt`.
- `PATCH /api/v1/users/me` changes `firstName`, `lastName` and the avatar, as JSON or as a form (see Files): a key that
  is missing keeps its value, `null` clears it, an empty body answers `409 NO_CHANGES`. A name is one word of letters of
  any script, with a hyphen or an apostrophe inside it, up to 40 characters; another answers `422` on that field with
  `operator: 'format'` and `operatorValue: 'person-name'`, or with `operator: 'maxLength'` over 100 characters. The
  email is not changed here.
- `DELETE /api/v1/users/me` deletes the account for good and ends every session. Its `204` clears the session cookies
  and the markers, unless the request came with `Authorization: Bearer`; then go to sign-in. The last active member of
  the admin group gets `409 GROUP_PROTECTED`: another member must stay. Whoever signs in again gets a new, empty account.
- People are managed under `/api/v1/users`: `users:read` or `users:manage` to see them (`GET /` with the filters
  `firstName`, `status`, `createdAtFrom`, `createdAtTo`, `sort`, `limit`, `offset`; `GET /:id`), `users:manage` to
  change them: `PATCH /:id` (`email`, `firstName`, `lastName`), `POST /:id/block`, `POST /:id/unblock`,
  `DELETE /:id`. A new email set here counts as confirmed: a sign-in through a provider that confirms the same address
  signs into this person; one
  another account holds answers `422` on `email`. A block ends every session of the person at once and keeps them
  from signing in; a deletion is no ban.
- One changes only people who hold no scope beyond one's own, and never oneself through these routes:
  `403 AUTHORIZATION_ERROR`. A person whose email is in the admin list of the server, or whose confirmed sign-in
  identity holds such an address while the account has none, counts as holding full access.
  The last active member of the admin group cannot be blocked or deleted: `409 GROUP_PROTECTED`.

## Files

A route that takes files reads its body as JSON or as `multipart/form-data` of the same fields; for now that is
`PATCH /api/v1/users/me` with `avatar`. Any other route answers a form with `415 UNSUPPORTED_MEDIA_TYPE_ERROR`, and a
path with no route with `404`, as it answers JSON.

```js
const form = new FormData();

form.append('firstName', 'Anna');
form.append('avatar', fileInput.files[0]);

// No Content-Type: the browser writes it with the boundary of the form. PATCH in capitals: fetch() upper-cases
// DELETE, GET, HEAD, OPTIONS, POST and PUT, never PATCH.
const response = await fetch('/api/v1/users/me', { method: 'PATCH', body: form });
```

- **Never set the `Content-Type` of a form yourself**: without the boundary the browser writes into it, the body cannot
  be read (`400 BAD_REQUEST_ERROR`).
- **The fields of a form are those of the JSON**, as text: numbers and booleans are read from it as from a query, and a
  name given twice is a list. A field of several files repeats its name, once per file.
- **The text `null` is `null`** in a field that takes `null`: `form.append('avatar', 'null')` removes the avatar, as
  `{ "avatar": null }` does, and the text `null` clears a name the same way. In a field that does not take `null` it
  stays the text, and a number or a boolean answers `422` on it, as on `null` of JSON. An empty text of a number field is
  no value, as in a query. A field that is not there keeps its value, the file too, and so does a file input with nothing
  chosen, which `new FormData(formElement)` sends as an empty file without a name.
- **A file goes as a file only.** A string in a file field, the URL of the file or any other, answers `422`
  (`operator: 'type'` in JSON, `'const'` in a form): the server never takes a file by its name.

### Choosing a file

```html
<input type="file" name="avatar" accept="image/jpeg,image/png,image/webp">
```

- JPEG first: Safari turns a HEIC photo into the first type of the list. No spaces: an Android WebView splits the list
  on commas without trimming.
- The type is told by the bytes of the file, never by its name or by the type the browser gives it: a program renamed
  `photo.png` is still refused.
- The avatar is one file of up to 5 MB, a megabyte being 1024 × 1024 bytes. The server reads a form to its end before it
  answers, a refused file too: check `file.size` before sending. A form over 12 MB in all is answered `413` once it has
  arrived, and the whole request must arrive within 2 minutes.
- The server turns the image upright, scales it down to at most 512 pixels on its longest side and stores it as WebP,
  without its EXIF and so without the place a photo was taken. A larger photo may be scaled down in the page before it
  is sent.
- Swagger (`/docs` in dev mode) describes each file field of a route: its types and its size.

### When a file is refused

`422 VALIDATION_ERROR` names the file field in `column`, with `columnValue: null`. `operator` tells what is wrong, and
`operatorValue` its limit:

| `operator` | `operatorValue` | Meaning | What to show |
|---|---|---|---|
| `maxSize` | the most bytes of a file | the file is larger | "The file is too large: up to 5 MB" |
| `mime` | the types the field takes | the bytes are of none of them | "Choose a JPEG, PNG or WebP image" |
| `image` | `null` | the server cannot read the image: it is damaged, cut short, or not what its first bytes claim | "This image cannot be read: choose another one" |
| `maxPixels` | the most pixels | the image has more | "The image is too large: choose a smaller one" |
| `maxFiles` | the most files of the field, or of the form | more files than that; a text `null` beside a file counts as one | a fault of the page: send one file or `null` per field |
| `totalMaxSize` | the most bytes of all the files of a form | the files are larger together | "The files are too large together" |

- **The files are checked first**, while the form is read, and its text after them: a `422` with an error of a file
  holds no error of the text, which may come once the file passes.
- `413 PAYLOAD_TOO_LARGE_ERROR`: the text of the form is over 16 KB, the names of its fields counted in, the form has
  more than 50 fields and files together, or it is over 12 MB in all. A proxy in front of the API may answer `413` by itself, without our envelope, to a body over its own limit:
  show the size message there too.
- `503 SERVICE_UNAVAILABLE_ERROR` with `Retry-After`: the server is busy with other uploads. It answers once the whole
  form has arrived; send it again after `Retry-After` seconds.
- A refused form stores nothing: send it whole again.

### Showing the avatar

`avatarUrl` of a user (in `GET` and `PATCH` of `/api/v1/users/me`, in `GET /api/v1/users/:id` and in the rows of the
lists of users and of members) is the full address of the file, under `/upload/` of the backend, or `null` without one.

- An address never changes its content: a new avatar comes at a new address, and a browser may keep the file for a year
  (`immutable`). Show the `avatarUrl` of the latest answer: a query to bust a cache is never needed.
- The file is served with `Cross-Origin-Resource-Policy: cross-origin`, so a page of another origin may show it in an
  `<img>`. It needs no cookie or token: whoever has the address gets the file.
- A sign-in or a link through a provider that has a picture (Google, Telegram) copies it into an empty avatar when it
  can; it never replaces one.

## Development

- **Dev sign-in.** With `APP_MODE=dev` the backend has `POST /api/v1/auth/login-dev` with `{ "email": "anna@example.com" }`:
  it signs in as that email (and creates the account with the email confirmed). It sets the cookies like any sign-in and
  also gives `data.accessToken`, for the Authorize button of Swagger (`/docs`) and for curl
  (`Authorization: Bearer <token>`). It answers only requests that come from this machine; to anything else it is a
  missing route.
- **Dev proxy.** A dev server that proxies `/api` must pass on the address of the browser and keep its `Host`, or every
  device that reaches the dev server would count as this machine. `avatarUrl` is built on `APP_PROTOCOL` and `APP_HOST`:
  when they name the dev server, it proxies `/upload` as well.

  ```js
  // vite.config.js
  export default {
    server: {
      proxy: {
        '/api': { target: 'http://127.0.0.1:4173', xfwd: true, changeOrigin: false },
        '/upload': { target: 'http://127.0.0.1:4173', changeOrigin: false },
      },
    },
  };
  ```

  With nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` and `proxy_set_header Host $host;`.
- **Origin of the dev server.** The browser sends the origin of the page (`http://localhost:5173`), and the backend refuses
  every `POST`, `PUT`, `PATCH` and `DELETE` from an origin it does not know with `403 ORIGIN_ERROR`. Make it the origin of
  the backend (`APP_PROTOCOL` and `APP_HOST`) or list it in `APP_CORS_ORIGINS`. A page of another origin still cannot
  read the few answers made before any hook (a malformed path, headers over the limit of Node): they carry no CORS
  headers, and `fetch` sees a network error.
