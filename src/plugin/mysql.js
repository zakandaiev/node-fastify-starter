import fastifyMysql from '@fastify/mysql';

async function useMysql(fastify) {
  const host = process.env.APP_DATABASE_HOST;
  const database = process.env.APP_DATABASE_NAME;
  const user = process.env.APP_DATABASE_USER;
  const password = process.env.APP_DATABASE_PASSWORD;

  const connectionString = `mysql://${user}:${password}@${host}/${database}?charset=utf8mb4`;

  await fastify.register(fastifyMysql, {
    uri: connectionString,
    namedPlaceholders: true,
    promise: true,
    timezone: '+00:00',
  });
}

export default useMysql;
