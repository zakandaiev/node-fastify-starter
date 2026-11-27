import { readEnvList } from '#config/env.js';

function toOrigin(value) {
  return new URL(value).origin;
}

export function createCorsConfig(env) {
  const origins = [
    toOrigin(`${env.APP_PROTOCOL}://${env.APP_HOST}`),
    ...readEnvList(env.APP_CORS_ORIGINS).map((origin) => toOrigin(origin)),
  ];

  return Object.freeze({
    // Where a browser request may come from, for CORS, the origin check and POST /log/error alike: the app and the
    // origins APP_CORS_ORIGINS adds, such as the dev server of the frontend. As a browser writes an Origin, so a default
    // port in APP_HOST ("app.example.com:443") is left out the same way.
    allowedOrigins: Object.freeze([...new Set(origins)]),

    // How long a browser keeps the answer to a preflight before it asks again.
    preflightMaxAge: '10m',
  });
}
