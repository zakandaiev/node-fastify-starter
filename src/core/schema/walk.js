import { isFunction, isObject } from '#utils/type.js';

export const BODY_PART = 'body';

// Both spellings of the query: Fastify copies "query" to "querystring" only at ready(), after the onRoute hooks.
export const REQUEST_PARTS = Object.freeze([BODY_PART, 'querystring', 'query', 'params', 'headers']);

function mapBody(body, transform) {
  if (!isObject(body) || !isObject(body.content)) {
    return transform(body, BODY_PART);
  }

  return {
    ...body,
    content: Object.fromEntries(
      Object.entries(body.content).map(([mediaType, media]) => [mediaType, { ...media, schema: transform(media?.schema, BODY_PART, mediaType) }]),
    ),
  };
}

function mapPart(routeSchema, part, transform) {
  return part === BODY_PART
    ? mapBody(routeSchema[part], transform)
    : transform(routeSchema[part], part);
}

// Always a new top-level object: Fastify writes the "querystring" alias and a mark of its own into the schema
// of a route, which throws on a frozen one. transform(schema, part, mediaType) gets every schema of a request
// part, each schema of a body in the content form apart.
export function mapRequestSchemas(routeSchema, transform) {
  if (!isObject(routeSchema) || !isFunction(transform)) {
    throw new TypeError('mapRequestSchemas(routeSchema, transform) requires the schema object of a route and a function');
  }

  const parts = REQUEST_PARTS
    .filter((part) => routeSchema[part] !== undefined)
    .map((part) => [part, mapPart(routeSchema, part, transform)]);

  return {
    ...routeSchema,
    ...Object.fromEntries(parts),
  };
}
