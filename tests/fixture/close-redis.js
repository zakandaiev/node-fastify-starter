import { createLogger } from '#core/logger/index.js';
import { createRedis } from '#core/redis/index.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { argv, stdout } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

// Prints how long the process lived after close() resolved: a socket or a timer left behind holds it.
// "waiting" keeps a whenReady() pending across close().
const [, , mode, port, waitMs] = argv;
const config = createTestConfig({ env: { APP_REDIS_HOST: '127.0.0.1', APP_REDIS_PORT: port } });
const { cache, ...main } = config.redis;
const redis = createRedis(main, { log: createLogger(config.logger), label: 'Redis' });
const waiting = mode === 'waiting'
  ? redis.whenReady()
  : null;

if (mode !== 'wait') {
  redis.connect();
  await sleep(Number(waitMs));
}

const closedAt = performance.now();
const state = redis.client.status;

await redis.close();

const isReadyAfterWait = await waiting;

process.once('exit', () => {
  stdout.write(JSON.stringify({ state, isReadyAfterWait, lingerMs: Math.round(performance.now() - closedAt) }));
});
