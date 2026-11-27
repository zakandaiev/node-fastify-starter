import { successEnvelope } from '#schemas/common/envelope.js';
import fp from 'fastify-plugin';

const LIVE_PATH = '/live';

const getLiveSchema = {
  tags: ['Health'],
  summary: 'Check that the process is alive, without asking any service',
  response: {
    200: successEnvelope({
      type: 'object',
      properties: {
        isAlive: { type: 'boolean' },
      },
    }),
  },
};

async function getLive(request, reply) {
  return reply.ok({ isAlive: true });
}

// Outside the limiter and the pressure check: an orchestrator that is refused would restart a process that only has to
// catch its breath, and a probe of every few seconds would take the quota of the address it comes from.
async function useHealth(fastify) {
  fastify.get(`${fastify.config.app.healthPrefix}${LIVE_PATH}`, {
    schema: getLiveSchema,
    security: { auth: false, rateLimit: false },
    config: { isPressureExempt: true },
  }, getLive);
}

export default fp(useHealth, { name: 'health' });
