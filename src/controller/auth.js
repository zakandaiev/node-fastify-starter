import {
  createUser,
  getUserByConditions,
  getUserByEmail,
  getUserById,
} from '#src/model/user.js';
import authProperties from '#src/schema/auth.json' with { type: 'json' };
import userProperties from '#src/schema/user.json' with { type: 'json' };
import { generateAccessToken, generateRefreshToken } from '#src/util/jwt.js';
import { replyError, replySuccess } from '#src/util/response.js';
import { generateSchemaFromProperties } from '#src/util/schema.js';
import bcrypt from 'bcryptjs';

// CHECK AUTH
async function checkAuth(request, reply) {
  const invalidReply = () => replyError(reply, {
    сode: 401,
    message: 'Authentication Error',
  });

  try {
    const payload = await request.jwtVerify();

    if (payload.tokenType !== 'access') {
      return invalidReply();
    }
  } catch {
    return invalidReply();
  }
}

// CHECK ROLE
function checkRole(allowedRolesOneOrMany) {
  const allowedRoles = Array.isArray(allowedRolesOneOrMany)
    ? allowedRolesOneOrMany
    : [allowedRolesOneOrMany];

  const checkRoleMiddleware = async (request, reply) => {
    const { role } = request.user || {};

    if (!allowedRoles.includes(role)) {
      return replyError(reply, {
        code: 403,
        message: 'Authorization Error',
      });
    }
  };

  return checkRoleMiddleware;
}

// LOGIN
async function postLogin(request, reply) {
  const { email, password } = request.body;

  const user = await getUserByEmail({ email });
  if (!user) {
    return replyError(reply, {
      message: 'Invalid Credentials',
    });
  }

  const isPasswordValid = await bcrypt.compare(password, user.password);
  if (!isPasswordValid) {
    return replyError(reply, {
      message: 'Invalid Credentials',
    });
  }

  const accessToken = generateAccessToken(request.server, user);
  const refreshToken = generateRefreshToken(request.server, user);

  reply.setCookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/auth/refresh',
  });

  return replySuccess(reply, {
    data: {
      accessToken,
      user,
    },
  });
}
const postLoginSchema = generateSchemaFromProperties(
  userProperties,
  {
    bodyKeys: ['email', 'password'],
    bodyRequiredKeys: ['email', 'password'],
    successSchemaOptions: {
      dataExample: {
        accessToken: 'jwt-token',
        user: {
          id: 'id-hash',
          email: 'dummy@email.com',
          name: 'Dummy Name',
          phone: null,
          role: 'user',
        },
      },
    },
  },
  {
    tags: ['Auth'],
    summary: 'User login via email and password',
    description: 'Returns access token and sets refresh token to http cookie',
  },
);

async function postLoginDev(request, reply) {
  if (process.env.APP_MODE !== 'dev') {
    return replyError(reply, {
      code: 404,
      message: `Route ${request.method} ${request.url} not found`,
    });
  }

  const user = {
    id: 'dev-user',
    email: request.body.email || 'dev@local',
    role: 'admin',
  };

  const accessToken = generateAccessToken(request.server, user);
  const refreshToken = generateRefreshToken(request.server, user);

  reply.setCookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/auth/refresh',
  });

  return replySuccess(reply, {
    data: {
      accessToken,
      user,
    },
  });
}
const postLoginDevSchema = generateSchemaFromProperties(
  userProperties,
  {
    bodyKeys: ['email'],
    successSchemaOptions: {
      dataExample: {
        accessToken: 'jwt-token',
        user: {
          id: 'dev-user',
          email: 'dev@local',
          role: 'admin',
        },
      },
    },
  },
  {
    tags: ['Auth'],
    summary: '[DEV ONLY] User login via email',
    description: 'Returns access token and sets refresh token to http cookie',
  },
);

async function postLogout(request, reply) {
  reply.clearCookie('refreshToken', {
    path: '/auth/refresh',
  });

  return replySuccess(reply, {
    data: true,
  });
}
const postLogoutSchema = generateSchemaFromProperties(
  userProperties,
  {
    successSchemaOptions: {
      dataExample: true,
    },
  },
  {
    tags: ['Auth'],
    summary: 'User logout',
    description: 'Flushes access and refresh tokens',
  },
);

async function postRefresh(request, reply) {
  const invalidReply = () => replyError(reply, {
    message: 'Invalid Refresh Token',
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
      user = await getUserById({ id: payload.id });
    }

    if (!user) {
      return invalidReply();
    }

    const newAccessToken = generateAccessToken(request.server, user);

    return replySuccess(reply, {
      data: {
        accessToken: newAccessToken,
      },
    });
  } catch {
    return invalidReply();
  }
}
const postRefreshSchema = generateSchemaFromProperties(
  authProperties,
  {
    cookieKeys: ['refreshToken'],
    // cookieRequiredKeys: ['refreshToken'],
    successSchemaOptions: {
      dataExample: {
        accessToken: 'jwt-token',
      },
    },
  },
  {
    tags: ['Auth'],
    summary: 'User refresh access token',
    description: 'Returns new access token based on cookie\'s refresh token',
  },
);

async function postRegister(request, reply) {
  const {
    email, password, name, phone,
  } = request.body;

  const userExists = await getUserByConditions({
    conditions: ['email', 'phone'],
    condition: 'OR',
    email,
    phone,
  });
  if (userExists) {
    return replyError(reply, {
      message: 'User Already Exists',
    });
  }

  const passwordHashed = await bcrypt.hash(password, 10);
  await createUser({
    email,
    password: passwordHashed,
    name,
  });

  return replySuccess(reply, {
    data: true,
  });
}
const postRegisterSchema = generateSchemaFromProperties(
  userProperties,
  {
    bodyKeys: ['email', 'password', 'name'],
    bodyRequiredKeys: ['email', 'password', 'name'],
    successSchemaOptions: {
      dataExample: true,
    },
  },
  {
    tags: ['Auth'],
    summary: 'User registration via email, password and name',
    description: 'Returns success or error responce',
  },
);

export {
  checkAuth,
  checkRole,
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
