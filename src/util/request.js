import {
  isArray,
  isNumber,
  isObject,
  toNumber,
} from '#src/util/misc.js';
import sleep from '#src/util/sleep.js';

function getApiTimeout(timeout) {
  if (isNumber(timeout)) {
    return timeout;
  }
  return toNumber(process.env.APP_API_EXTERNAL_TIMEOUT_MS) ?? 15000;
}

function getApiDelay(delay) {
  if (isNumber(delay)) {
    return delay;
  }
  return toNumber(process.env.APP_API_EXTERNAL_DELAY_MS) ?? 500;
}

async function fetchWithTimeout(resource, options = {}, timeout = null) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getApiTimeout(timeout));

  const response = await fetch(resource, {
    ...options,
    signal: controller.signal,
  });

  clearTimeout(timeoutId);

  return response;
}

async function request(resource, opt = {}, timeout = null, delay = null) {
  const startTime = performance.now();

  const options = {
    ...opt,
    headers: opt.headers || { 'Content-Type': 'application/json' },
    method: opt.method || 'GET',
  };

  if (options.headers.Authorization === undefined && process.env.APP_API_EXTERNAL_KEY) {
    options.headers.Authorization = process.env.APP_API_EXTERNAL_KEY;
  }

  if (options.method.toUpperCase() === 'GET' && isObject(options.body)) {
    const url = new URL(resource, window.location.origin);
    Object.entries(options.body).forEach(([key, value]) => {
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
    delete options.body;
  }

  if (isObject(options.body) && !(options.body instanceof FormData)) {
    options.body = JSON.stringify(options.body);
  }

  const result = {
    code: null,
    status: null,
    message: null,
    data: null,
    error: null,
  };

  let response = {};

  try {
    response = await fetchWithTimeout(resource, options, getApiTimeout(timeout));
    result.code = response.status;
  } catch {
    result.status = 'error';
    result.message = 'Request failed: resource is not reachable or response time was exceeded';
    return result;
  }

  try {
    const responseData = await response.json() || {};
    if (responseData.constructor.name === 'Object') {
      Object.assign(result, responseData);
    }

    result.status = responseData.status || null;
    result.message = responseData.message || null;
    result.data = responseData.data || responseData.payload || responseData || null;
  } catch {
    result.status = 'error';
    result.message = 'Request failed: the response is not valid JSON';
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

export {
  fetchWithTimeout,
  request,
};

export default request;
