function generateAccessToken(fastify, payload = {}, options = {}) {
  return fastify.jwt.sign(
    {
      tokenType: 'access',
      ...payload,
    },
    {
      expiresIn: process.env.APP_JWT_ACCESS_TTL,
      ...options,
    },
  );
}

function generateRefreshToken(fastify, payload = {}, options = {}) {
  return fastify.jwt.refresh.sign(
    {
      tokenType: 'refresh',
      ...payload,
    },
    {
      expiresIn: process.env.APP_JWT_REFRESH_TTL,
      ...options,
    },
  );
}

export {
  generateAccessToken,
  generateRefreshToken,
};
