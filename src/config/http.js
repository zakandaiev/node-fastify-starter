export function createHttpConfig() {
  return Object.freeze({
    // An upstream that has not answered, its body included, within this long has failed: the request that
    // waits for it must not wait for ever.
    timeout: '5s',

    // An answer of an API, not a download: a larger body is a failure, read no further.
    maxResponseBytes: 1024 * 1024,

    // How much of the body of a refusal goes into the error: enough for the code an upstream gives.
    errorBodyMaxLength: 512,

    // A value of the query this short is a page, a language or a limit, not a key: masked in the address,
    // it is left in the body of a refusal, where every "2" or "en" would be masked with it.
    echoMinLength: 8,

    // An address that came from outside, such as the avatar of a provider.
    external: Object.freeze({
      timeout: '10s',
      maxBytes: 5 * 1024 * 1024,
      maxRedirects: 3,

      // Private networks a fetch may still reach, as CIDR: none, unless a service of our own lives there.
      allowedPrivateNetworks: Object.freeze([]),
    }),
  });
}
