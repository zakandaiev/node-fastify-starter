import { fastify } from '#core/server.js';
import { normalizeSensitive } from '#src/service/request.js';
import { request } from '#src/util/request.js';

export async function externalRequestDemo(resource, options = {}, { delay = undefined, timeout = undefined } = {}) {
  const externalRequestDemoApi = process.env.APP_EXTERNAL_REQUEST_DEMO_API;
  const externalRequestDemoToken = process.env.APP_EXTERNAL_REQUEST_DEMO_TOKEN;
  if (!externalRequestDemoApi || !externalRequestDemoToken) {
    return {
      code: 500,
      status: 'error',
      message: 'Server error',
      data: 'SERVER_ERROR',
    };
  }

  const resourceOverwrite = externalRequestDemoApi + resource;

  const optionsOverwrite = {
    ...options,
    headers: {
      ...options.headers || {},
      Authorization: `Bearer ${externalRequestDemoToken}`,
      'Content-Type': 'application/json',
    },
  };

  const startTime = performance.now();
  const result = await request(resourceOverwrite, optionsOverwrite, { delay, timeout });
  const endTime = performance.now();

  optionsOverwrite.headers = normalizeSensitive(optionsOverwrite.headers);

  fastify.log.info({
    resource: resourceOverwrite,
    options: optionsOverwrite,
    code: result.code,
    resultTime: endTime - startTime,
  }, 'External request demo');

  const isSuccess = result.code === 200
    ? true
    : false;

  if (isSuccess) {
    return {
      ...result,
      code: 200,
      status: 'success',
    };
  }

  return {
    code: 502,
    status: 'error',
    message: 'External request demo failed',
    data: process.env.APP_MODE === 'dev'
      ? result
      : 'EXTERNAL_REQUEST_DEMO_FAILED',
  };
}
