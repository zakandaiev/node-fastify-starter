import { OUTPUT_COLUMNS as USER_OUTPUT_COLUMNS } from '#root/src/controller/v1/user.js';
import { createUser, getUserByEmail, getUserById } from '#root/src/model/v1/user.js';
import { generateAccessToken, generateRefreshToken } from '#src/util/jwt.js';
import {
  normalizeDataByColumns,
  replyError,
  replyErrorAuthentication,
  replyErrorAuthorization,
  replyErrorNotFound,
  replySuccess,
} from '#src/util/response.js';
import { createSchema } from '#src/util/schema.js';
import bcrypt from 'bcryptjs';

// TODO
// 1. JWT ROTATION
// 2. JWT REVOKE

// CONST
const AUTH_API_PATH = '/api/v1';

// NORMALIZATION
const OUTPUT_COLUMNS = ['accessToken'];

// CHECK JWT AUTH
async function checkJwtAuth(request, reply) {
  try {
    const payload = await request.jwtVerify();

    if (payload.tokenType !== 'access') {
      return replyErrorAuthentication(reply);
    }

    request.user = payload;
  } catch {
    return tryRefreshJwtToken(request, reply);
  }
}

async function tryRefreshJwtToken(request, reply) {
  try {
    const payload = await request.refreshJwtVerify({
      onlyCookie: true,
    });

    if (payload.tokenType !== 'refresh') {
      return replyErrorAuthentication(reply);
    }

    const user = await getUserById(payload.id);
    if (!user) {
      return replyErrorAuthentication(reply);
    }
    if (!user.isEnabled) {
      return replyErrorAuthorization(reply);
    }

    const normalizedUser = normalizeDataByColumns(user, USER_OUTPUT_COLUMNS);
    const accessToken = generateAccessToken(request.server, normalizedUser);
    setTokenToCookie(reply, { accessToken });

    request.user = user;
  } catch {
    return replyErrorAuthentication(reply);
  }
}

// CHECK ORIGIN AUTH
async function checkOriginAuth(request, reply) {
  if (!request.headers.origin) {
    return replyErrorAuthentication(reply);
  }

  const frontendDomainList = process.env.APP_CORS_ALLOWED_DOMAINS
    ? process.env.APP_CORS_ALLOWED_DOMAINS.split(',')
    : false;

  if (!frontendDomainList || !frontendDomainList.includes(request.headers.origin)) {
    return replyErrorAuthentication(reply);
  }
}

// CHECK ROLE
function checkUserRole(allowedRolesOneOrMany) {
  const allowedRoles = Array.isArray(allowedRolesOneOrMany)
    ? allowedRolesOneOrMany
    : [allowedRolesOneOrMany];

  const checkUserRoleMiddleware = async (request, reply) => {
    const { role } = request.user || {};

    if (!allowedRoles.includes(role)) {
      return replyErrorAuthorization(reply);
    }
  };

  return checkUserRoleMiddleware;
}

// SET/UNSET JWT TOKENS TO COOKIE
function setTokenToCookie(reply, { accessToken, refreshToken } = {}) {
  const isDev = process.env.APP_MODE === 'dev';

  const options = {
    path: AUTH_API_PATH,
    httpOnly: true,
    secure: !isDev,
    sameSite: isDev ? 'lax' : 'strict',
  };

  if (accessToken) {
    reply.setCookie('accessToken', accessToken, options);
  }

  if (refreshToken) {
    reply.setCookie('refreshToken', refreshToken, options);
  }

  return true;
}
function unsetTokenFromCookie(reply, { accessToken, refreshToken } = {}) {
  if (accessToken) {
    reply.clearCookie('accessToken', {
      path: AUTH_API_PATH,
    });
  }

  if (refreshToken) {
    reply.clearCookie('refreshToken', {
      path: AUTH_API_PATH,
    });
  }

  return true;
}

// GET CURRENT USER
async function getCurrentUser(request, reply) {
  const { id } = request.user;

  const user = await getUserById(id);
  if (!user) {
    return replyErrorAuthentication(reply);
  }
  if (!user.isEnabled) {
    return replyErrorAuthorization(reply);
  }

  return replySuccess(reply, {
    data: normalizeDataByColumns(user, USER_OUTPUT_COLUMNS),
  });
}
const getCurrentUserSchema = createSchema('auth', 'user')
  .cookies(['accessToken'])
  .defaultResponses()
  .response(200, {
    dataExampleKeys: USER_OUTPUT_COLUMNS,
  })
  .meta({
    tags: ['Auth', 'v1'],
    summary: 'Get current user',
    description: 'Returns current user if logged in',
  })
  .build();

// POST LOGIN
async function postLogin(request, reply) {
  const { email, password } = request.body;

  const user = await getUserByEmail(email);
  if (!user) {
    return replyError(reply, {
      message: 'Invalid credentials',
      data: 'INVALID_CREDENTIALS',
    });
  }

  const isPasswordValid = await bcrypt.compare(password, user.password);
  if (!isPasswordValid) {
    return replyError(reply, {
      message: 'Invalid credentials',
      data: 'INVALID_CREDENTIALS',
    });
  }

  const normalizedUser = normalizeDataByColumns(user, USER_OUTPUT_COLUMNS);
  const accessToken = generateAccessToken(request.server, normalizedUser);
  const refreshToken = generateRefreshToken(request.server, normalizedUser);
  setTokenToCookie(reply, { accessToken, refreshToken });

  return replySuccess(reply, {
    data: normalizedUser,
  });
}
const postLoginSchema = createSchema('user')
  .body(['email', 'password'], ['email', 'password'])
  .defaultResponses({
    include: [200, 400, 500],
  })
  .response(200, {
    dataExampleKeys: USER_OUTPUT_COLUMNS,
  })
  .meta({
    tags: ['Auth', 'v1'],
    summary: 'User login via email and password',
    description: 'Returns user and sets access token & refresh token to http cookie',
  })
  .build();

// POST LOGIN DEV
async function postLoginDev(request, reply) {
  if (process.env.APP_MODE !== 'dev') {
    return replyErrorNotFound(request, reply);
  }

  const { email, password } = request.body;

  const user = await getUserByEmail(email);
  if (!user) {
    return replyError(reply, {
      message: 'Invalid credentials',
      data: 'INVALID_CREDENTIALS',
    });
  }

  const isPasswordValid = await bcrypt.compare(password, user.password);
  if (!isPasswordValid) {
    return replyError(reply, {
      message: 'Invalid credentials',
      data: 'INVALID_CREDENTIALS',
    });
  }

  const normalizedUser = normalizeDataByColumns(user, USER_OUTPUT_COLUMNS);
  const accessToken = generateAccessToken(request.server, normalizedUser, { expiresIn: '1d' });

  return replySuccess(reply, {
    data: {
      accessToken,
      user: normalizedUser,
    },
  });
}
const postLoginDevSchema = createSchema('auth', 'user')
  .body(['email', 'password'], ['email', 'password'])
  .defaultResponses({
    include: [200, 400, 500],
  })
  .response(200, {
    dataExampleKeys: OUTPUT_COLUMNS.concat(USER_OUTPUT_COLUMNS),
    dataExampleKeysFormat: (example) => ({
      accessToken: example.accessToken,
      user: (() => {
        const userExample = { ...example };
        delete userExample.accessToken;
        return userExample;
      })(),
    }),
  })
  .meta({
    tags: ['Auth', 'v1', 'DEV ONLY'],
    summary: '[DEV ONLY] User login via email and password',
    description: 'Returns user and prolonged accessToken up to 1 day of expiry. Only for API testing, no http cookies setup',
  })
  .build();

// POST LOGOUT
async function postLogout(_request, reply) {
  unsetTokenFromCookie(reply, {
    accessToken: true,
    refreshToken: true,
  });

  return replySuccess(reply, {
    data: true,
  });
}
const postLogoutSchema = createSchema('user')
  .defaultResponses({
    include: [200, 500],
  })
  .response(200, {
    dataExample: true,
  })
  .meta({
    tags: ['Auth', 'v1'],
    summary: 'User logout',
    description: 'Flushes access and refresh tokens',
  })
  .build();

// POST REGISTER
async function postRegister(request, reply) {
  const {
    email,
    password,
    name,
    phone,
  } = request.body;

  const passwordHashed = await bcrypt.hash(password, 10);
  const user = await createUser({
    email,
    password: passwordHashed,
    name,
    phone,
  });

  const normalizedUser = normalizeDataByColumns(user, USER_OUTPUT_COLUMNS);
  const accessToken = generateAccessToken(request.server, normalizedUser);
  const refreshToken = generateRefreshToken(request.server, normalizedUser);
  setTokenToCookie(reply, { accessToken, refreshToken });

  return replySuccess(reply, {
    data: normalizedUser,
  });
}
const postRegisterSchema = createSchema('user')
  .body(['email', 'password', 'name', 'phone'], ['email', 'password', 'name'])
  .defaultResponses()
  .response(200, {
    dataExampleKeys: USER_OUTPUT_COLUMNS,
  })
  .meta({
    tags: ['Auth', 'v1'],
    summary: 'User registration via email, password and name',
    description: 'Returns created user',
  })
  .build();

export {
  checkJwtAuth,
  checkOriginAuth,
  checkUserRole,
  getCurrentUser,
  getCurrentUserSchema,
  OUTPUT_COLUMNS,
  postLogin,
  postLoginDev,
  postLoginDevSchema,
  postLoginSchema,
  postLogout,
  postLogoutSchema,
  postRegister,
  postRegisterSchema,
  setTokenToCookie,
};
