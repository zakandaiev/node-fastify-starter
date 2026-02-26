import { replySuccess } from '#src/util/response.js';
import { createSchema, loadSchemaFiles } from '#src/util/schema.js';

// NORMALIZATION
const OUTPUT_COLUMNS = [
  'health',
  'mysqlStatus',
  'redisStatus',
  'requestDate',
];

// GET HEALTH CHECK
async function getHealthCheck(request, reply) {
  return replySuccess(reply, {
    data: {
      health: 'healthy',
      mysqlStatus: request.server.mysql ? 'ready' : 'uninstalled',
      redisStatus: request.server?.redis?.status || 'uninstalled',
      requestDate: new Date().toISOString(),
    },
  });
}
const getHealthCheckSchema = createSchema('healthcheck')
  .defaultResponses({
    include: [200, 500],
  })
  .response(200, {
    data: {
      type: 'object',
      properties: loadSchemaFiles('healthcheck').properties,
    },
    dataExampleKeys: OUTPUT_COLUMNS,
  })
  .meta({
    tags: ['Healthcheck'],
    summary: 'System health check',
    description: 'Returns system health',
  })
  .build();

export {
  getHealthCheck,
  getHealthCheckSchema,
  OUTPUT_COLUMNS,
};
