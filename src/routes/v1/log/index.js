import {
  checkSource,
  postError,
  postErrorSchema,
  readReportMax,
} from './controller.js';

// A quota of its own: a page in a loop of errors must not take the quota its user needs for everything else.
export default async function useLogRoutes(fastify) {
  const { report } = fastify.config.rateLimit.routes;

  fastify.post('/error', {
    schema: postErrorSchema,
    security: { auth: false, rateLimit: { max: readReportMax, window: report.window } },
    bodyLimit: fastify.config.alert.intake.bodyLimit,
    preParsing: checkSource,
  }, postError);
}
