import fastifyMysql from '@fastify/mysql';

export default async function useMysql(fastify) {
  const host = process.env.APP_DATABASE_HOST;
  const port = process.env.APP_DATABASE_PORT;
  const database = process.env.APP_DATABASE_NAME;
  const user = process.env.APP_DATABASE_USER;
  const password = process.env.APP_DATABASE_PASSWORD;

  await fastify.register(fastifyMysql, {
    host,
    port,
    database,
    user,
    password,
    charset: 'utf8mb4',
    namedPlaceholders: true,
    promise: true,
    typeCast(field, useDefaultTypeCasting) {
      // CONVERT TINYINT 0/1 TO BOOLEAN true/false
      if (field.type === 'TINY' && field.length === 1) {
        return field.string() === '1';
      }
      return useDefaultTypeCasting();
    },
  });
}
