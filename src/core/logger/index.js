import pino from 'pino';

export function createLogger({ level, isPretty = false } = {}) {
  if (!level) {
    throw new TypeError('createLogger({ level }) requires a log level');
  }

  return pino({
    level,
    ...(isPretty && {
      transport: {
        target: 'pino-pretty',
      },
    }),
  });
}
