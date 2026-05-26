import { isArray, isObject, isStringValidJson } from '#src/util/misc.js';

export function encodeToBase64(data) {
  if (isArray(data) || isObject(data)) {
    data = JSON.stringify(data);
  }
  return btoa(encodeURIComponent(data));
}

export function decodeFromBase64(data) {
  data = decodeURIComponent(atob(data));

  if (data.charAt(0) === '[' || data.charAt(0) === '{') {
    if (isStringValidJson(data)) {
      data = JSON.parse(data);
    } else if (data.charAt(0) === '[') {
      data = [];
    } else if (data.charAt(0) === '{') {
      data = {};
    }
  }

  return data;
}
