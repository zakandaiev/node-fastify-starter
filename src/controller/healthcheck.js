import { replySuccess } from '#src/util/response.js';
import { generateSchema } from '#src/util/schema.js';

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
const getHealthCheckSchema = generateSchema(
  'healthcheck',
  {
    responseCodeKeys: [200, 500],
    responseSuccessDataExample: OUTPUT_COLUMNS,
    overwrite: {
      tags: ['Healthcheck'],
      summary: 'System health check',
      description: 'Returns system health',
    },
  },
);

export {
  getHealthCheck,
  getHealthCheckSchema,
  OUTPUT_COLUMNS,
};
