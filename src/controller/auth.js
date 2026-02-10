import { OUTPUT_COLUMNS as USER_OUTPUT_COLUMNS } from '#src/controller/user.js';
import { createUser, getUserByConditions } from '#src/model/user.js';
import { generateAccessToken, generateRefreshToken } from '#src/util/jwt.js';
import {
  normalizeDataByColumns,
  replyError,
  replyErrorAuthentication,
  replyErrorAuthorization,
  replySuccess,
} from '#src/util/response.js';
import { generateSchema } from '#src/util/schema.js';
import bcrypt from 'bcryptjs';

// NORMALIZATION
const OUTPUT_COLUMNS = ['accessToken'];

// CHECK JWT AUTH
async function checkJwtAuth(request, reply) {
  try {
    const payload = await request.jwtVerify();
    if (payload.tokenType !== 'access') {
      return replyErrorAuthentication(reply);
    }
  } catch {
    return replyErrorAuthentication(reply);
  }
}

// CHECK ORIGIN AUTH
async function checkOriginAuth(request, reply) {
  if (!request.headers.origin) {
    return replyErrorAuthentication(reply);
  }

  const frontendDomainList = process.env.APP_FRONTEND_DOMAINS
    ? process.env.APP_FRONTEND_DOMAINS.split(',')
    : false;

  if (!frontendDomainList.includes(request.headers.origin)) {
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

// LOGIN
async function postLogin(request, reply) {
  const { email, password } = request.body;

  const user = await getUserByConditions({ email }, { conditions: ['email'] });
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

  const accessToken = generateAccessToken(request.server, user);
  const refreshToken = generateRefreshToken(request.server, user);

  reply.setCookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/api/auth/refresh',
  });

  return replySuccess(reply, {
    data: {
      accessToken,
      user: normalizeDataByColumns(user, USER_OUTPUT_COLUMNS),
    },
  });
}
const postLoginSchema = generateSchema(
  ['auth', 'user'],
  {
    bodyKeys: ['email', 'password'],
    bodyRequiredKeys: ['email', 'password'],
    responseSuccessDataExample: OUTPUT_COLUMNS.concat(USER_OUTPUT_COLUMNS),
    responseSuccessDataExampleFormat: (objExample) => ({
      accessToken: objExample.accessToken,
      user: normalizeDataByColumns(objExample, USER_OUTPUT_COLUMNS),
    }),
    overwrite: {
      tags: ['Auth'],
      summary: 'User login via email and password',
      description: 'Returns access token and sets refresh token to http cookie',
    },
  },
);

async function postLoginDev(request, reply) {
  if (process.env.APP_MODE !== 'dev') {
    return replyError(reply, {
      code: 404,
      message: `Route ${request.method} ${request.url} not found`,
      data: 'ROUTE_NOT_FOUND',
    });
  }

  const user = {
    id: 'dev-user',
    email: request.body.email || 'dev@local.test',
    role: 'admin',
  };

  const accessTokenOptions = {
    expiresIn: '1d',
  };

  const accessToken = generateAccessToken(request.server, user, { options: accessTokenOptions });
  const refreshToken = generateRefreshToken(request.server, user);

  reply.setCookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/api/auth/refresh',
  });

  return replySuccess(reply, {
    data: {
      accessToken,
      user,
    },
  });
}
const postLoginDevSchema = generateSchema(
  ['auth', 'user'],
  {
    bodyKeys: ['email'],
    responseSuccessDataExample: OUTPUT_COLUMNS,
    responseSuccessDataExampleFormat: (objExample) => ({
      accessToken: objExample.accessToken,
      user: {
        id: 'dev-user',
        email: 'dev@local.test',
        role: 'admin',
      },
    }),
    overwrite: {
      tags: ['Auth'],
      summary: '[DEV ONLY] User login via email',
      description: 'Returns access token and sets refresh token to http cookie',
    },
  },
);

async function postLogout(request, reply) {
  reply.clearCookie('refreshToken', {
    path: '/api/auth/refresh',
  });

  return replySuccess(reply, {
    data: true,
  });
}
const postLogoutSchema = generateSchema(
  'user',
  {
    responseCodeKeys: [200, 500],
    responseCodeOverwrite: {
      200: {
        dataExample: true,
      },
    },
    overwrite: {
      tags: ['Auth'],
      summary: 'User logout',
      description: 'Flushes access and refresh tokens',
    },
  },
);

async function postRefresh(request, reply) {
  const invalidReply = () => replyError(reply, {
    message: 'Invalid refresh token',
    data: 'INVALID_REFRESH_TOKEN',
  });

  try {
    const payload = await request.refreshJwtVerify({
      onlyCookie: true,
    });

    if (payload.tokenType !== 'refresh') {
      return invalidReply();
    }

    let user;

    if (process.env.APP_MODE === 'dev' && payload.id === 'dev-user') {
      user = { ...payload };
    } else {
      user = await getUserByConditions({ id: payload.id }, { conditions: ['id'] });
    }

    if (!user) {
      return invalidReply();
    }

    const newAccessToken = generateAccessToken(request.server, user);

    return replySuccess(reply, {
      data: newAccessToken,
    });
  } catch {
    return invalidReply();
  }
}
const postRefreshSchema = generateSchema(
  'auth',
  {
    cookieKeys: ['refreshToken'],
    // cookieRequiredKeys: ['refreshToken'],
    responseCodeKeys: [200, 400, 500],
    responseSuccessDataExample: OUTPUT_COLUMNS,
    responseSuccessDataExampleFormat: 'string',
    responseCodeOverwrite: {
      400: {
        messageExample: 'Invalid refresh token',
        dataExample: 'INVALID_REFRESH_TOKEN',
        validationExample: [{
          column: 'refreshToken',
          operator: 'required',
          operatorValue: null,
        }],
      },
    },
    overwrite: {
      tags: ['Auth'],
      summary: 'User refresh access token',
      description: 'Returns new access token based on cookie\'s refresh token',
    },
  },
);

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

  const accessToken = generateAccessToken(request.server, user);
  const refreshToken = generateRefreshToken(request.server, user);

  reply.setCookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/api/auth/refresh',
  });

  return replySuccess(reply, {
    data: {
      accessToken,
      user: normalizeDataByColumns(user, USER_OUTPUT_COLUMNS),
    },
  });
}
const postRegisterSchema = generateSchema(
  ['auth', 'user'],
  {
    bodyKeys: ['email', 'password', 'name', 'phone'],
    bodyRequiredKeys: ['email', 'password', 'name'],
    responseSuccessDataExample: OUTPUT_COLUMNS.concat(USER_OUTPUT_COLUMNS),
    responseSuccessDataExampleFormat: (objExample) => ({
      accessToken: objExample.accessToken,
      user: normalizeDataByColumns(objExample, USER_OUTPUT_COLUMNS),
    }),
    overwrite: {
      tags: ['Auth'],
      summary: 'User registration via email, password and name',
      description: 'Returns created user',
    },
  },
);

export {
  checkJwtAuth,
  checkOriginAuth,
  checkUserRole,
  OUTPUT_COLUMNS,
  postLogin,
  postLoginDev,
  postLoginDevSchema,
  postLoginSchema,
  postLogout,
  postLogoutSchema,
  postRefresh,
  postRefreshSchema,
  postRegister,
  postRegisterSchema,
};
