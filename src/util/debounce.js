export function debounce(callback, delay = 100) {
  let timeoutId = null;

  return (...args) => new Promise((resolve) => {
    clearTimeout(timeoutId);

    timeoutId = setTimeout(async () => {
      const result = await callback(...args);
      resolve(result);
    }, delay);
  });
}
