import { OUTPUT_COLUMNS } from '#src/controller/user.js';
import { normalizeDataByColumns } from '#src/util/response.js';

function generateAccessToken(fastify, user, opt = {}) {
  return fastify.jwt.sign(
    {
      ...normalizeDataByColumns(user, OUTPUT_COLUMNS),
      tokenType: 'access',
      ...opt.payload || {},
    },
    {
      expiresIn: process.env.APP_JWT_ACCESS_EXPIRE,
      ...opt.options || {},
    },
  );
}

function generateRefreshToken(fastify, user, opt = {}) {
  return fastify.jwt.refresh.sign(
    {
      ...normalizeDataByColumns(user, OUTPUT_COLUMNS),
      tokenType: 'refresh',
      ...opt.payload || {},
    },
    {
      expiresIn: process.env.APP_JWT_REFRESH_EXPIRE,
      ...opt.options || {},
    },
  );
}

export {
  generateAccessToken,
  generateRefreshToken,
};
