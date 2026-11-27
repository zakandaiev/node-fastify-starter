import { IMAGE_OUTPUT_FORMATS } from '#core/image/profile.js';
import { STORAGE_KEY_MAX_LENGTH, STORAGE_KEY_REGEXP } from '#core/storage/key.js';
import { HEADER } from '#enums/header.js';
import { HTTP_METHOD } from '#enums/http-method.js';
import { pathParams } from '#schemas/common/request.js';
import { convertStringToMs } from '#utils/date.js';
import fastifyStatic from '@fastify/static';
import fp from 'fastify-plugin';
import nodePath from 'node:path';

// Another driver serves its files from an address of its own.
const SERVED_DRIVER = 'local';

const PUBLIC_PREFIX = '/';

const INLINE = 'inline';
const ATTACHMENT = 'attachment';

// Only an image the app has encoded itself is shown in place: any other file is saved, never opened on this origin.
const INLINE_EXTENSIONS = Object.freeze(Object.values(IMAGE_OUTPUT_FORMATS).map(({ extension }) => extension));

const FILE_HEADERS = Object.freeze({
  [HEADER.X_CONTENT_TYPE_OPTIONS]: 'nosniff',
  // The same-origin of helmet would keep a page of the frontend, on an origin of its own, from showing the file.
  [HEADER.CROSS_ORIGIN_RESOURCE_POLICY]: 'cross-origin',
  [HEADER.X_ROBOTS_TAG]: 'noindex',
});

// A list shows an image on each of its rows: counted, they would spend the quota of a guest on one page.
const PUBLIC_FILE = Object.freeze({ auth: false, rateLimit: false });

// A name outside the key form never reaches the disk: the upper-case twin of a key on a disk blind to case, a dot file,
// a path out of the root.
const getFileSchema = {
  hide: true,
  params: pathParams({
    key: { type: 'string', maxLength: STORAGE_KEY_MAX_LENGTH, pattern: STORAGE_KEY_REGEXP.source },
  }),
};

function readExtension(filePath) {
  return nodePath.extname(filePath).slice(1);
}

function setFileHeaders(reply, filePath) {
  reply.headers({
    ...FILE_HEADERS,
    [HEADER.CONTENT_DISPOSITION]: INLINE_EXTENSIONS.includes(readExtension(filePath))
      ? INLINE
      : ATTACHMENT,
  });
}

function createFileHandler({ root, maxAge }) {
  const sendOptions = Object.freeze({ maxAge: convertStringToMs(maxAge), immutable: true });

  return async function getFile(request, reply) {
    return reply.sendFile(request.params.key, root, sendOptions);
  };
}

// A route of its own, not the wildcard of @fastify/static: the routes of that one take no security, and so no way out
// of the limiter.
async function serveUploads(fastify, storageConfig) {
  if (storageConfig.driver !== SERVED_DRIVER) {
    return false;
  }

  await fastify.register(fastifyStatic, { serve: false, setHeaders: setFileHeaders });

  fastify.route({
    method: [HTTP_METHOD.GET, HTTP_METHOD.HEAD],
    url: `${storageConfig.publicPath}:key`,
    schema: getFileSchema,
    security: PUBLIC_FILE,
    handler: createFileHandler(storageConfig),
  });

  return true;
}

// A route for each file there at the start: a wildcard at "/" would answer every unknown path, those of the API too, from
// the disk.
async function servePublic(fastify, appConfig) {
  if (!appConfig.isDev) {
    return false;
  }

  await fastify.register(fastifyStatic, {
    root: appConfig.publicRoot,
    prefix: PUBLIC_PREFIX,
    wildcard: false,
    index: false,
    list: false,
    decorateReply: false,
  });

  return true;
}

async function useStatic(fastify) {
  const { app, upload } = fastify.config;

  await serveUploads(fastify, upload.storage);
  await servePublic(fastify, app);
}

export default fp(useStatic, { name: 'static' });
