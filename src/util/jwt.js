function normalizeUser(user, opt = {}) {
  return {
    id: user.id,
    email: user.email,
    role: user.role || 'user',
    ...opt,
  };
}

function generateAccessToken(fastify, user) {
  return fastify.jwt.sign(
    normalizeUser(user, { tokenType: 'access' }),
    { expiresIn: process.env.APP_JWT_ACCESS_EXPIRE },
  );
}

function generateRefreshToken(fastify, user) {
  return fastify.jwt.refresh.sign(
    normalizeUser(user, { tokenType: 'refresh' }),
    { expiresIn: process.env.APP_JWT_REFRESH_EXPIRE },
  );
}

export {
  generateAccessToken,
  generateRefreshToken,
  normalizeUser,
};
