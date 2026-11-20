import { mapRequestSchemas } from '#core/schema/walk.js';
import { SCHEMA_KEYWORD } from '#enums/schema-keyword.js';
import { omit } from '#utils/object.js';
import { mapSchema } from '#utils/schema.js';
import { isObject } from '#utils/type.js';

// The route schema as its author wrote it, before the gate and the guards: what the API docs show.
const sourceSchemas = new WeakMap();

export function isJsonField(schema) {
  return isObject(schema) && schema[SCHEMA_KEYWORD.JSON] === true;
}

export function rememberSourceSchema(routeSchema, source) {
  if (!isObject(routeSchema) || !isObject(source)) {
    throw new TypeError('rememberSourceSchema(routeSchema, source) requires the schema of a route and the one its author wrote');
  }

  sourceSchemas.set(routeSchema, source);

  return routeSchema;
}

// The json marker is for AJV and the contract only.
export function dropSchemaMarkers(schema) {
  return mapSchema(schema, (subschema) => (isJsonField(subschema)
    ? omit(subschema, [SCHEMA_KEYWORD.JSON])
    : subschema));
}

function documentResponse(response) {
  if (!isObject(response?.content)) {
    return dropSchemaMarkers(response);
  }

  return {
    ...response,
    content: Object.fromEntries(
      Object.entries(response.content).map(([mediaType, media]) => [mediaType, { ...media, schema: dropSchemaMarkers(media?.schema) }]),
    ),
  };
}

function aliasQuery(routeSchema) {
  const { query, ...rest } = routeSchema;

  return query === undefined || rest.querystring !== undefined
    ? routeSchema
    : { ...rest, querystring: query };
}

export function readDocumentedSchema(routeSchema) {
  if (!isObject(routeSchema)) {
    throw new TypeError('readDocumentedSchema(routeSchema) requires the schema object of a route');
  }

  const documented = mapRequestSchemas(aliasQuery(sourceSchemas.get(routeSchema) ?? routeSchema), dropSchemaMarkers);

  if (!isObject(documented.response)) {
    return documented;
  }

  return {
    ...documented,
    response: Object.fromEntries(Object.entries(documented.response).map(([code, response]) => [code, documentResponse(response)])),
  };
}
