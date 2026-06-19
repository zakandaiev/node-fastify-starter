const SENSITIVE_KEY_FRAGMENTS = [
  'auth',
  'token',
  'pass',
  'secret',
  'key',
  'jwt',
  'session',
  'cookie',
  'credential',
];

export function normalizeSensitive(source) {
  if (!source || typeof source !== 'object') {
    return {};
  }

  return Object.keys(source).reduce((output, key) => {
    const normalizedKey = key.toLowerCase();
    output[key] = SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalizedKey.includes(fragment))
      ? '[hidden]'
      : source[key];
    return output;
  }, {});
}

export function getRequestContext(request) {
  if (!request) {
    return false;
  }

  const {
    origin,
    referer,
    'user-agent': userAgent,
  } = request.headers;

  return {
    method: request.method,
    url: `${request.protocol}://${request.host}${request.url}`,
    cookies: normalizeSensitive(request.cookies),
    body: normalizeSensitive(request.body),
    params: normalizeSensitive(request.params),
    query: normalizeSensitive(request.query),
    ip: request.ip,
    origin: origin || referer,
    userAgent,
  };
}
