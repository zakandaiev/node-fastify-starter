import { createHttpConfig } from '#config/http.js';
import { createContext, runInContext } from '#core/context/index.js';
import { fetchExternal } from '#core/http/external.js';
import { fetchUpstream } from '#core/http/index.js';
import { createLogger } from '#core/logger/index.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { argv, stdout } from 'node:process';

// node tests/fixture/read-byte-by-byte.js <client> <url> <length of the body>
const [, , clientName, url, length] = argv;

const SERVICE = 'byte-by-byte';
const TIMEOUT = '10s';

const http = createHttpConfig();
const config = createTestConfig({
  http: { external: { ...http.external, allowedPrivateNetworks: ['127.0.0.1/32'] } },
  logger: { level: 'fatal' },
});

async function readUpstream(options) {
  const { text } = await fetchUpstream(url, options);

  return text.length;
}

async function readExternal(options) {
  const { bytes } = await fetchExternal(url, { ...options, allowedHosts: ['127.0.0.1'], allowedTypes: ['image/png'] });

  return bytes.length;
}

const CLIENTS = Object.freeze({
  upstream: readUpstream,
  external: readExternal,
});

const received = await runInContext(
  createContext({ config, log: createLogger(config.logger) }),
  () => CLIENTS[clientName]({ service: SERVICE, timeout: TIMEOUT, maxBytes: Number(length) }),
);

stdout.write(String(received));
