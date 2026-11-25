import { endAuthCookies } from '#core/auth/cookie.js';
import { listSessions, revokeAllSessions, revokeSession } from '#core/auth/session.js';
import { AppError } from '#core/error/index.js';
import { createSchema } from '#core/schema/create-schema.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { enumOf } from '#schemas/common/field.js';
import * as sessionSchema from '#schemas/entity/session.js';
import { freezeDeep } from '#utils/object.js';

const EXCEPT_CURRENT = 'current';
const SCOPE_OF_ALL = 'all';

const ONE_OF = 'oneOf';

const choice = freezeDeep({
  properties: {
    except: enumOf([EXCEPT_CURRENT], 'End every session but the current one'),
    scope: enumOf([SCOPE_OF_ALL], 'End every session, the current one too'),
  },
});

const CHOICE_KEYS = Object.freeze(Object.keys(choice.properties));

export async function getSessions(request, reply) {
  const sessions = await listSessions(request.user.id);

  return reply.list({
    data: sessions.map((session) => ({ ...session, isCurrent: session.id === request.session.id })),
  });
}

export const getSessionsSchema = createSchema(sessionSchema)
  .meta({ tags: ['Sessions'], summary: 'List the live sessions of the user, the last active first' })
  .response(HTTP_STATUS.OK, { data: Object.keys(sessionSchema.properties), format: 'array' })
  .defaultResponses()
  .build();

export async function deleteSession(request, reply) {
  const { id } = request.params;

  if (!(await revokeSession({ sid: id, userId: request.user.id }))) {
    throw new AppError(ERROR_CODE.NOT_FOUND_ERROR);
  }

  if (id === request.session.id) {
    endAuthCookies(request, reply);
  }

  return reply.noContent();
}

export const deleteSessionSchema = createSchema(sessionSchema)
  .meta({ tags: ['Sessions'], summary: 'End one session of the user' })
  .params(['id'])
  .response(HTTP_STATUS.NO_CONTENT)
  .defaultResponses()
  .build();

// Neither of them must not end everything, and both contradict each other. Not for the schema: it drops an unknown
// parameter only after it has counted them.
function assertOneChoice({ except, scope }) {
  if ((except === undefined) === (scope === undefined)) {
    throw new AppError(ERROR_CODE.VALIDATION_ERROR, {
      validation: [{
        column: 'scope',
        columnValue: scope ?? null,
        operator: ONE_OF,
        operatorValue: CHOICE_KEYS,
      }],
    });
  }
}

// Each branch names its value: no "else" here may end every session.
export async function deleteSessions(request, reply) {
  const { except, scope } = request.query;

  assertOneChoice({ except, scope });

  if (except === EXCEPT_CURRENT) {
    await revokeAllSessions(request.user.id, { except: request.session.id });
  }

  if (scope === SCOPE_OF_ALL) {
    await revokeAllSessions(request.user.id);
    endAuthCookies(request, reply);
  }

  return reply.noContent();
}

export const deleteSessionsSchema = createSchema(choice)
  .meta({
    tags: ['Sessions'],
    summary: 'End many sessions of the user',
    description: 'Takes exactly one of the parameters',
  })
  .query([...CHOICE_KEYS])
  .response(HTTP_STATUS.NO_CONTENT)
  .defaultResponses()
  .build();
