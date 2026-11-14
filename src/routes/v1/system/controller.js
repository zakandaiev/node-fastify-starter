import { successEnvelope } from '#schemas/common/envelope.js';

export async function ping(request, reply) {
  return reply.ok({ isAlive: true });
}

export const pingSchema = {
  tags: ['System'],
  summary: 'Check that the API answers',
  response: {
    200: successEnvelope({
      type: 'object',
      properties: {
        isAlive: { type: 'boolean' },
      },
    }),
  },
};
