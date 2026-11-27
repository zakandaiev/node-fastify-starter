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
  `email`, `text`, `personName`, `enumOf`, `dateTimeUtc`, `json`, `nullable`). A field of a column has the length of the
  column;
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
