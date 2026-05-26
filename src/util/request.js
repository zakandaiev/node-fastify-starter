import {
  isArray,
  isNumber,
  isObject,
  toNumber,
} from '#src/util/misc.js';
import { sleep } from '#src/util/sleep.js';

export async function fetchWithTimeout(resource, options = {}, { timeout = undefined } = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getApiTimeout(timeout));

  const response = await fetch(resource, {
    ...options,
    signal: controller.signal,
  });

  clearTimeout(timeoutId);

  return response;
}

export async function request(resource, options = {}, { delay = undefined, timeout = undefined } = {}) {
  const startTime = performance.now();

  const opt = {
    ...options,
    headers: options.headers || { 'Content-Type': 'application/json' },
    method: options.method || 'GET',
  };

  if (opt.headers.Authorization === undefined && process.env.APP_API_EXTERNAL_KEY) {
    opt.headers.Authorization = process.env.APP_API_EXTERNAL_KEY;
  }

  if (opt.method.toUpperCase() === 'GET' && isObject(opt.body)) {
    const url = new URL(resource);
    Object.entries(opt.body).forEach(([key, value]) => {
      if (value === null || value === undefined) {
        return false;
      }
      if (isArray(value) || isObject(value)) {
        url.searchParams.append(key, JSON.stringify(value));
      } else {
        url.searchParams.append(key, value);
      }
    });
    resource = url.toString();
    delete opt.body;
  }

  if (
    (isArray(opt.body) || isObject(opt.body))
    && opt.body instanceof FormData !== true
  ) {
    opt.body = JSON.stringify(opt.body);
  }

  const result = {
    code: null,
    status: null,
    message: null,
    data: null,
    error: null,
  };

  let response;
  let responseJson;
  let responseText;

  try {
    response = await fetchWithTimeout(resource, opt, { timeout: getApiTimeout(timeout) });
    result.code = response.status;
  } catch (error) {
    result.status = 'error';
    result.message = 'Request failed: resource is not reachable or response time was exceeded';
    result.error = normalizeError(error);
    return result;
  }

  try {
    responseText = await response.text();
  } catch (error) {
    result.status = 'error';
    result.message = `Request failed: ${error.message.toLowerCase()}`;
    result.error = normalizeError(error);
    return result;
  }

  try {
    responseJson = JSON.parse(responseText);
    Object.assign(result, responseJson);
  } catch (error) {
    result.status = 'error';
    result.message = 'Request failed: the response is not valid JSON';
    result.data = responseText;
    result.error = normalizeError(error);
    return result;
  }

  const endTime = performance.now();
  const differenceTime = endTime - startTime;
  const delayTime = getApiDelay(delay);
  if (differenceTime < delayTime) {
    await sleep(delayTime - differenceTime);
  }

  return result;
}

function getApiTimeout(timeout) {
  return isNumber(timeout) ? timeout : (toNumber(process.env.APP_API_EXTERNAL_TIMEOUT_MS) ?? 15000);
}

function getApiDelay(delay) {
  return isNumber(delay) ? delay : (toNumber(process.env.APP_API_EXTERNAL_DELAY_MS) ?? 500);
}

function normalizeError(error) {
  if (!error) {
    return null;
  }

  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}
