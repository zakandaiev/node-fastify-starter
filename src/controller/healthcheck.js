import { replySuccess } from '#src/util/response.js';
import { generateSchemaFromProperties } from '#src/util/schema.js';

import healthcheckProperties from '#src/schema/healthcheck.json' with { type: 'json' };

// GET HEALTH CHECK
const getHealthCheckSchema = generateSchemaFromProperties(
  healthcheckProperties,
  {
    successSchemaOptions: {
      dataExample: {
        health: 'healthy',
        requestDate: '2026-01-01T01:01:01.000Z',
      },
    },
  },
  {
    tags: ['Healthcheck'],
    summary: 'System health check',
    description: 'Returns system health',
  },
);

async function getHealthCheck(request, reply) {
  return replySuccess(reply, {
    data: {
      health: 'healthy',
      requestDate: new Date().toISOString(),
    },
  });
}

export {
  getHealthCheck,
  getHealthCheckSchema,
};
