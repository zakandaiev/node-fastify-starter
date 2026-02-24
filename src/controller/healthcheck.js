import { replySuccess } from '#src/util/response.js';
import { createSchema } from '#src/util/schema.js';

// NORMALIZATION
const OUTPUT_COLUMNS = [
  'health',
  'requestDate',
];

// GET HEALTH CHECK
async function getHealthCheck(request, reply) {
  return replySuccess(reply, {
    data: {
      health: 'healthy',
      requestDate: new Date().toISOString(),
    },
  });
}
const getHealthCheckSchema = createSchema('healthcheck')
  .defaultResponses({
    include: [200, 500],
  })
  .response(200, {
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
