# Recipes

## Add a module

A module is a domain of the app: its table, its schema, its rules and its routes. `users` is the example to copy:
`src/modules/users/` holds the rules, `src/routes/v1/users/` the endpoints. Look in `docs/CORE-API.md` before you
write a function: what the core already does is not written again.

### 1. The table

```sh
npm run migrate:make -- --names=invoices
```

The command makes `migrations/mariadb/<version>_invoices.up.sql` and `.down.sql`. A table of this project:

- is named in the plural, in `snake_case`, and has a comment;
- has the primary key `id UUID NOT NULL DEFAULT UUID_v7()`: the code gives the id (`uuidv7()`), the default is there for
  seeds;
- has `created_at` and `updated_at` as `DATETIME(3)` in UTC, `updated_at` with `ON UPDATE CURRENT_TIMESTAMP(3)`;
- is `DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`, and a text for people (a name, a title) names
  `COLLATE utf8mb4_uca1400_ai_ci` on its column; no other charset;
- names every index, `CHECK` and foreign key (`uq_invoices_number`, `idx_invoices_user`, `fk_invoices_user`), and every
  foreign key names its `ON DELETE`;
- writes a list of values as `VARCHAR` with `CHECK (status COLLATE utf8mb4_nopad_bin IN ('draft', 'paid'))`.

Then name the table where the code looks for it:

- `TABLE` in `src/enums/table.js`, and in `TABLE_DEPENDENTS` the tables a delete of a row reaches through `CASCADE` or
  `SET NULL`: a test compares them with the foreign keys;
- every unique index in `UNIQUE_INDEX` of `src/enums/unique-index.js`.

`npm run migrate:up` applies it; `npm run migrate:verify` compares the database with what the files build.

### 2. The entity schema

`src/schemas/entity/user.js` is the one description of a user. It exports:

- `properties`: the fields of the API in camelCase, built with the factories of `#schemas/common/field.js` (`uuid`,
  `email`, `text`, `personName`, `enumOf`, `dateTimeUtc`, `url`, `json`, `nullable`). A field of a column has the length
  of the column;
- `filters`: what a list may be filtered by (`text` searches a fragment, `options`, ranges of dates and numbers);
- `sort`: the orders of a list, each ending with `id` so that a page never shuffles;
- `unique`: the index that reports a duplicate, and the field it is reported on: a taken email answers `422` with
  `validation[]` on `email`, no code needed;
- `example`: what the docs show.

The same object feeds the validation of the routes, Swagger, the `WHERE` of the filters and the `ORDER BY` of the sort.

### 3. The names of closed lists

- A scope per action in `src/enums/scope.js`: `users:read` and `users:manage`, with an entry of `SCOPE_CATALOG`; a
  resource with several actions gets its wildcard `users:*` there too. A route names actions only.
- An audit action per sensitive change in `src/enums/audit-action.js` (`user.block`).
- An error code in `src/enums/error-code.js` only for a business conflict the client tells apart.

### 4. The repository

`users.repository.js` holds the SQL of the module, written by hand, with the columns taken from the fields:

```js
const query = await createQuery(LIST_SQL)
  .filter(userSchema, payload)
  .sort(userSchema, payload)
  .paginate(payload)
  .cache({ tables: [TABLE.USERS] })
  .execute();

return query.getAll();
```

- A read names in `.cache({ tables })` every table it reads: a write to any of them makes the entry stale.
- A write goes through `createQuery(...).cache({ tables })`, `insertReturning`, `updateReturning` or `upsert`: they move
  the cache versions of the table and of its dependents. A write past them leaves stale data in the cache.
- Values are bound (`:id`), never concatenated; a column name comes from the code, never from the request.

### 5. The service

`users.service.js` holds the rules and knows nothing of HTTP.

- A public function checks its arguments before any statement (`assertUuid`, a `TypeError`) and refuses a request with
  `AppError(ERROR_CODE.…)`.
- A `PATCH` takes `buildPatch(input, { allowed })`: a key that is missing leaves its column alone, `null` clears it, an
  empty body is `409 NO_CHANGES`. Values equal to the stored ones write nothing.
- A change runs in `withTransaction(fn, SESSION_TRANSACTION)` when it touches users, their groups or their sessions. It
  locks the rows of the users first, in the order of the key, then its own rows, and only then writes. `#core/auth/user.js`
  has the locks: `lockUsers(userIds)`, `lockAccount(userId)` for one's own account, `lockActorAndUser({ actorId, userId })`
  for one user acting on another, with `assertOtherUser()` before the transaction.
- Rights that matter are judged by the database under that lock, not by the token: `assertActorHolds(actor, { requirement,
  scopes })` of `#core/authz/scope.js`. A demoted actor keeps their token for up to 10 minutes.
- A sensitive change writes `writeAudit()` in the same transaction. Its `meta` holds ids and the names of the changed
  fields, never a person's email or name: the record outlives the person.
- Redis, HTTP calls and mail wait for the commit: `afterCommit()`.
- A status that ends access is an action of its own, not a field of `PATCH`: a block revokes the sessions of the user
  (`revokeAllSessions`), a write of the column would leave them alive until their tokens end.
- A delete is physical, and is no ban: whoever signs in again gets a new account. A block keeps a person out.

### 6. The routes

`src/routes/v1/users/` is served at `/api/v1/users`: the folder names the prefix.

`index.js` declares each route with its schema and its `security`, which every route must have:

```js
const READ = Object.freeze({ auth: true, scopes: [SCOPE.USERS_READ, SCOPE.USERS_MANAGE] });

fastify.get('/:id', { schema: getUserSchema, security: READ }, getUser);
fastify.get('/me', { schema: getMeSchema, security: { auth: true } }, getMe);
```

`{ auth: false }` makes a route public; `scopes: ['a', 'b']` takes either, `[['a', 'b']]` both. A static segment
(`/me`) wins over a parameter (`/:id`).

`controller.js` holds each handler with its schema right below it:

```js
export async function patchUser(request, reply) {
  return reply.ok(await updateUser({
    id: request.params.id,
    input: request.body,
    actorId: request.user.id,
    request,
  }));
}

export const patchUserSchema = createSchema(userSchema)
  .meta({ tags: ['Users'], summary: 'Change a user', description: 'Who may, and what it refuses' })
  .params(['id'])
  .body(['email', 'firstName', 'lastName'], { isPatch: true })
  .response(HTTP_STATUS.OK, { data: [...USER_FIELDS] })
  .response(HTTP_STATUS.CONFLICT, { codes: [ERROR_CODE.NO_CHANGES] })
  .defaultResponses()
  .build();
```

- The response schema is also the filter of what leaves: a field it does not name is not sent.
- Answer through `reply.ok`, `reply.list(query.getAll())`, `reply.created` and `reply.noContent` only.
- Name in `.response(409, { codes })` each conflict the route answers: `.defaultResponses()` adds no 409.
- An object of another user answers `404`, never `403`: its owner is part of the `WHERE`. A path parameter that is no
  UUID is `404` too.
- Cookies are set or cleared by the route, as its last step after the service has committed (`endAuthCookies` after
  `DELETE /me`).

### 7. The tests

- `tests/unit/routes/users.test.js`: the contract and the `security` of every route, a guest's `401`, the `403` of a
  missing scope, what the validation refuses before the database, `503` with the services down, the Swagger spec.
- `tests/integration/routes/users*.test.js`: each promise of the module end to end on MariaDB and Redis, with a database
  per test file (`createTestDb()`); `users-lifecycle.test.js` also runs the races, with `Promise.all` and a connection
  that holds a row (`testDb.openKeeper`).
- `tests/integration/modules/users.test.js`: the rules of the service.
- Helpers shared by test files live in `tests/helper/`, not in a copy per file.

`npm run lint && npm test` runs them all; without MariaDB and Redis the integration tests are skipped with a message.
Swagger documents the routes by itself in dev mode (`/docs`). After you export a new function from `src/core` or
`src/utils`, `npm run api:index` updates `docs/CORE-API.md`.

## Add a file field to a route

A file comes in the body of the route that writes its row, beside the other fields: there is no upload route and no
table of files. `PATCH /api/v1/users/me` with `avatar` is the example to copy: the option in
`src/routes/v1/users/index.js`, the handler `patchMe` in `controller.js`, the rules in `updateOwnProfile()` of
`src/modules/users/users.service.js`.

### 1. The column

The row holds the key of its file in the storage, never the URL: the URL follows the address of the app, the key stays.

- The migration adds a column for the key with its comment, `avatar_key VARCHAR(64) NULL`. A key is no text for people:
  it keeps the collation of the table.
- The entity schema gives the URL in its place, `avatarUrl: nullable(url('…'))`, with an example. No column holds it:
  `tests/integration/schemas/entity.test.js` lists it among the computed fields and `avatar_key` among the columns the
  API does not tell.

### 2. The option

`files` stands beside `security`, on a `POST`, `PUT` or `PATCH` route:

```js
function readProfileFiles(uploadConfig) {
  return freezeDeep({
    fields: {
      avatar: { maxSize: uploadConfig.avatarMaxSize, mime: [...IMAGE_INPUT_TYPES], image: IMAGE_PROFILE.AVATAR },
    },
  });
}

fastify.patch('/me', { schema: patchMeSchema, security: OWN, files: readProfileFiles(fastify.config.upload) }, patchMe);
```

A size someone may tune lives in `src/config/upload.js`, as `avatarMaxSize` (5 MB) does, and the route reads it from
`fastify.config`.

Each key of `fields` is a field of the body, in camelCase:

- `max`: how many files the field takes, 1 by default; above 1 the handler gets a list.
- `maxSize`, required: the largest file, a size with a unit B, KB, MB, GB or TB of 1024 (`'512KB'`, `'5MB'`).
- `mime`, required: the types the field takes, of those the app tells by the first bytes of a file (`MIME_WHITELIST` of
  `#utils/mime.js`): a type without a signature, such as SVG or text, is never taken. An image is JPEG, PNG or WebP
  (`IMAGE_INPUT_TYPES`), the types the decoder reads; a PDF is stored as it came.
- `image`: the profile an image is encoded by; required when `mime` names an image, refused otherwise.

Beside `fields`, `totalMaxSize` bounds the bytes of all the files of a body (by default the sum of `max × maxSize` of
every field) and `maxFiles` their count (by default the sum of `max`).

A profile is a name in `src/enums/image-profile.js` and an entry of `config.upload.image.profiles`: `format` (`webp`,
`jpeg` or `png`), `quality` (1 to 100, 80 by default) and `maxSize`, the longest side in pixels; `avatar` is a WebP of
512 pixels at most. The same section caps every decode: `maxPixels`, `maxDecodeBytes`, `maxJpegScans` and `timeout`.

`src/config/upload.js` holds the ceilings of every route: `maxFileSize` and `maxTotalSize` (10 MB each), `maxBodySize`
(12 MB of a whole form, the parts it drops included), `maxPartHeaderSize` (2 KB of the header of a part), `maxParts` (50
text fields and files in one body) and `maxActiveFiles` (3 files read, decoded and stored at once in a process). A
process holds up to `maxActiveFiles` files of `maxFileSize` in memory, and `config.app.requestTimeout` (2 minutes) must
carry a body of `maxBodySize` over a slow link: raise them together.

An option the core cannot work with stops the start, with the route in the message: an unknown key, a size over a
ceiling (a default `totalMaxSize` too), a type the app cannot tell, an image without a profile, a method other than
those three.

### 3. What the core does

Write the body schema without the file fields, as for JSON alone: `.body(['firstName', 'lastName'], { isPatch: true })`.
The core adds them from `files`, and a body that names one stops the start. The route then takes the same fields in two
media types:

- `application/json`: a file field takes `null` alone, which removes the file; a missing field leaves it. A string there
  could name a file of somebody else: `422` with `operator: 'type'`.
- `multipart/form-data`: the text fields pass the same schema, coerced as a query is, and a name given twice is a list.
  The text `null` is `null` in a field that takes `null`; elsewhere it stays the text, which a number or a boolean
  refuses as it refuses `null` of JSON. Blank text of a field of numbers is no value, as in a query. A file field takes
  files, or the text `null` alone (`422` with `operator: 'const'`).

Swagger documents both, the form with a file picker. A form sent to a route without `files` is
`415 UNSUPPORTED_MEDIA_TYPE_ERROR`, and one to a path or a method with no route `404`, as JSON is.

`src/plugins/180.multipart.js` reads the form in `preValidation`, after the auth and the guard of `onRequest`: the form
of a guest is `401` before any file is stored. The validation and the hooks of the route come after it, and see the text
of the form as `request.body`.

- Every part is read to its end before the answer: an answer before the end of the body is a 502 behind a proxy. A
  refusal of `onRequest` (`401`, `403`, `429`) waits for the end of the form too, and so does one past `maxBodySize`,
  whose rest is read and dropped unparsed.
- A file is read into memory up to its `maxSize`, and its type is told by its bytes, never by its name or the type the
  client gave.
- An image goes through `processImage()` of `#core/image`: decoded under the caps of `config.upload.image`, turned
  upright, scaled down to its profile and encoded again without its metadata, EXIF and GPS included. The original never
  reaches the disk.
- A file is stored under a key of its own, a UUIDv7 with the extension of its type (`toStorageKey()`). The name the
  client gave is kept nowhere.
- A field the route does not name, and a file input with nothing chosen, are read and dropped.

A form is refused once it has been read, and the files it stored are removed:

- `422 VALIDATION_ERROR`, with an entry per field and check, `columnValue: null` and an operator of
  `src/enums/file-check.js`. `maxSize`, `maxFiles` and `totalMaxSize` give their limit in `operatorValue`, `mime` the
  types of the field, `image` `null` (the decoder refuses the file) and `maxPixels` the pixel limit that applied. A text
  `null` beside a file counts as one of its files. These come before the validation of the text, which runs once the
  files pass.
- `413 PAYLOAD_TOO_LARGE_ERROR`: text over the `bodyLimit` of the route (16 KB by default), the names of the fields
  counted in, more parts than `maxParts`, or a form past `maxBodySize`.
- `503 SERVICE_UNAVAILABLE_ERROR` with `Retry-After`: `maxActiveFiles` files are at work in the process.
- `400 BAD_REQUEST_ERROR`: a body the parser cannot read. A failure of the storage or of the decoder is a `500` with an
  alert.

`src/plugins/190.static.js` serves the files at `GET /upload/:key` (the `publicPath` of `config.upload.storage`), with no
auth and no limiter. They are cached as `immutable` for `maxAge`, since a key never changes its content. Only an image
the app has encoded is shown in place; any other file is offered to save. Every file goes with `nosniff`,
`X-Robots-Tag: noindex` and `Cross-Origin-Resource-Policy: cross-origin`, and nothing lists the folder.

### 4. The handler

```js
export async function patchMe(request, reply) {
  const user = await commitUploadedFiles(request, () => updateOwnProfile({
    userId: request.user.id,
    input: request.body,
    avatar: request.uploadedFiles?.avatar,
  }));

  return reply.ok(user);
}
```

- `request.uploadedFiles` holds the stored files by field: `{ key, url, mime, size }`, with `width` and `height` for an
  image, and a list of them for `max` above 1. It is `{}` for a form without files and `null` for JSON. The body never
  holds a file, at most `null` in its place.
- `commitUploadedFiles(request, run)` runs the service and keeps the files once it has committed: they belong to the row
  then, and a failure of the serializer after it keeps them. Any other failure of the request (a status of 400 or above)
  removes them in `onSend` or `onResponse`, unless the connection to the database was lost while a write was on its way
  (`isOutcomeUnknown()` of `#core/db/error.js`): the row may name them, and an orphan file costs less than a row that
  names a removed one. `keepUploadedFiles(request)` is the bare step, for a handler that commits in its own way.

### 5. The service

- The new file is an argument of its own (`avatar`), and its key joins the patch: a form with a file alone is a change,
  not `409 NO_CHANGES`. The input only removes, with `null`; a string there is a `TypeError`.
- The key it replaces is read under the lock of the row (`lockAccount()` gives `avatarKey`): of two changes at once, the
  later one removes the file of the earlier.
- The replaced file, and the file of a deleted row, are removed once the transaction has committed. `updateOwnProfile()`
  calls this when the key has changed, `removeLocked()` for both deletions:

```js
// Once the row names it no more: a rollback keeps the row and the file as they were.
async function removeAvatarFile(avatarKey) {
  if (avatarKey === null) {
    return false;
  }

  return afterCommit(() => getStorage().delete(avatarKey));
}
```

- The repository writes the key and gives the URL: a row it reads maps `avatarKey` to `getStorage().url(avatarKey)`, or
  to `null`. A list does the same through `toUserList()`, which the members of a group share.

### 6. The tests

- A form is built by hand, byte by byte, with `tests/helper/multipart.js`: `textPart(name, value)`,
  `filePart(name, bytes, { filename, type })` and `withForm(request, parts)` for `inject()`. An image is made by the test
  with sharp, `await createImage(64, 48).png().toBuffer()`, never committed as a file.
- Nothing is stored into the repository. `createTestConfig()` points the storage at `PROCESS_UPLOAD_ROOT`, a folder of
  the test process under the temporary folder of the system, and a test file that stores removes it:
  `after(() => removeTestUploads())`. `createUploadSection()` is an upload section whose root is a folder of its own
  under `PROCESS_UPLOAD_ROOT`, and `openUploadApp(t, testDb)` opens a route app on the database with one:
  `listStored(root)` then lists what the test stored. `createTestConfig({ upload: { storage } })` replaces the whole
  storage section: spread `createUploadConfig().storage` into a root of your own.
- Prove each promise of the field: the same change as JSON and as a form; a string in place of the file is `422`;
  `null` removes the file and a missing field keeps it; the replaced file and that of a deleted row are gone; the stored
  image has no EXIF; a program renamed `a.png` is `422` of `mime`, a file over `maxSize` `422` of `maxSize`; the form of
  a guest is `401` and a form whose text is refused `422`. Each refusal leaves no file in the root.
  `tests/unit/routes/users.test.js` and `tests/integration/routes/users.test.js` do it for the avatar. The parser
  itself, broken bodies over a socket included, is tested in `tests/unit/plugins/multipart.test.js` and
  `tests/unit/core/upload/index.test.js`.
