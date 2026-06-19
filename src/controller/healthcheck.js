import { replySuccess } from '#src/service/response.js';
import { createSchema, loadSchemaFiles } from '#src/service/schema.js';

// NORMALIZATION
export const OUTPUT_COLUMNS = [
  'health',
  'mysqlStatus',
  'redisStatus',
  'requestDate',
];

// UTILS
export async function getMysqlStatus(fastify) {
  const { mysql } = fastify;
  if (!mysql) {
    return 'uninstalled';
  }

  let connection;
  try {
    connection = await mysql.getConnection();
    await connection.ping();
    return 'ready';
  } catch {
    return 'down';
  } finally {
    connection?.release();
  }
}

export async function getRedisStatus(fastify) {
  const { redis } = fastify;
  if (!redis) {
    return 'uninstalled';
  }

  return redis.status;
}

// GET HEALTH CHECK
export async function getHealthCheck(request, reply) {
  const mysqlStatus = await getMysqlStatus(request.server);
  const redisStatus = await getRedisStatus(request.server);

  const systemStatus = mysqlStatus !== 'down'
    && redisStatus !== 'close'
    && redisStatus !== 'end'
    ? 'healthy'
    : 'unhealthy';

  return replySuccess(reply, {
    data: {
      health: systemStatus,
      mysqlStatus,
      redisStatus,
      requestDate: new Date().toISOString(),
    },
  });
}

export const getHealthCheckSchema = createSchema('healthcheck')
  .defaultResponses({
    exclude: [400, 401, 403],
  })
  .response(200, {
    data: {
      type: 'object',
      properties: loadSchemaFiles('healthcheck').property,
    },
    dataExampleKeys: OUTPUT_COLUMNS,
  })
  .meta({
    tags: ['Healthcheck'],
    summary: 'System health check',
    description: 'Returns system health',
  })
  .build();
