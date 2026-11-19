import { resolvePath } from '#config/path.js';
import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import nodePath from 'node:path';

// Module level, not inside initEnv(): tests and scripts that read env without calling it run in UTC too.
process.env.TZ = 'UTC';

const ENV_PREFIX = 'APP_';
const ENV_FILE = '.env';
const BYTE_ORDER_MARK = String.fromCharCode(0xFEFF);
const SECRET_MIN_LENGTH = 32;

const HOST_REGEXP = /^[A-Za-z0-9.-]+(:[0-9]{1,5})?$/;
const INTEGER_REGEXP = /^[0-9]+$/;
const SWALLOWED_LINE_REGEXP = new RegExp(`^(export\\s+)?${ENV_PREFIX}[A-Z0-9_]*=`);

export const MODE = Object.freeze({
  DEV: 'dev',
  PROD: 'prod',
});

function isPublicHost(value) {
  return HOST_REGEXP.test(value) && URL.canParse(`http://${value}`);
}

const FORMATS = Object.freeze({
  // docker compose interpolates $ " \ in env files, base64url has none of them
  base64url: /^[A-Za-z0-9_-]+$/,
  'host[:port]': isPublicHost,
});

const TEXT = { type: 'string' };
const PORT = { type: 'integer', minimum: 1, maximum: 65535 };
const SIGNING_SECRET = { type: 'string', minLength: SECRET_MIN_LENGTH, format: 'base64url' };
const PUBLIC_HOST = { type: 'string', format: 'host[:port]' };

export const ENV_SCHEMA = Object.freeze({
  type: 'object',
  required: [
    'APP_HOST',
    'APP_DATABASE_HOST',
    'APP_DATABASE_PORT',
    'APP_DATABASE_NAME',
    'APP_DATABASE_USER',
    'APP_DATABASE_PASSWORD',
    'APP_REDIS_HOST',
    'APP_REDIS_PORT',
    'APP_JWT_ACCESS_SECRET',
    'APP_JWT_REFRESH_SECRET',
  ],
  properties: {
    APP_MODE: { type: 'string', enum: Object.values(MODE), default: MODE.PROD },

    APP_NAME: TEXT,
    APP_NAME_FORMATTED: TEXT,
    APP_VERSION: TEXT,
    APP_AUTHOR: TEXT,
    APP_REPOSITORY: TEXT,
    APP_DESCRIPTION: TEXT,

    APP_PROTOCOL: { type: 'string', enum: ['http', 'https'], default: 'https' },
    APP_HOST: PUBLIC_HOST,
    APP_HEALTH_PORT: PORT,

    APP_ADMIN_EMAILS: TEXT,

    APP_DATABASE_HOST: TEXT,
    APP_DATABASE_PORT: PORT,
    APP_DATABASE_NAME: TEXT,
    APP_DATABASE_USER: TEXT,
    APP_DATABASE_PASSWORD: TEXT,

    APP_REDIS_HOST: TEXT,
    APP_REDIS_PORT: PORT,
    APP_REDIS_USER: TEXT,
    APP_REDIS_PASSWORD: TEXT,

    APP_CACHE_REDIS_HOST: TEXT,
    APP_CACHE_REDIS_PORT: PORT,
    APP_CACHE_REDIS_USER: TEXT,
    APP_CACHE_REDIS_PASSWORD: TEXT,

    APP_JWT_ACCESS_SECRET: SIGNING_SECRET,
    APP_JWT_ACCESS_SECRET_PREVIOUS: SIGNING_SECRET,
    APP_JWT_REFRESH_SECRET: SIGNING_SECRET,
    APP_JWT_REFRESH_SECRET_PREVIOUS: SIGNING_SECRET,

    APP_ALERT_WEBHOOK_URL: TEXT,
    APP_ALERT_SLACK_URL: TEXT,
    APP_ALERT_DISCORD_URL: TEXT,

    APP_LOG_API_KEY: TEXT,
  },
  // A setting of the cache Redis without its host would leave the cache in the main Redis without a word.
  dependencies: {
    APP_CACHE_REDIS_HOST: ['APP_CACHE_REDIS_PORT'],
    APP_CACHE_REDIS_PORT: ['APP_CACHE_REDIS_HOST'],
    APP_CACHE_REDIS_USER: ['APP_CACHE_REDIS_HOST'],
    APP_CACHE_REDIS_PASSWORD: ['APP_CACHE_REDIS_HOST'],
  },
});

const validate = new Ajv({
  allErrors: true,
  coerceTypes: true,
  useDefaults: true,
  formats: FORMATS,
}).compile(ENV_SCHEMA);

function getVariableName(error) {
  return error.instancePath.slice(1);
}

function formatRequired(error) {
  return `${error.params.missingProperty} is required`;
}

function formatEnum(error) {
  return `${getVariableName(error)} must be one of: ${error.params.allowedValues.join(', ')}`;
}

function formatMinLength(error) {
  return `${getVariableName(error)} must be at least ${error.params.limit} characters long: generate it with "npm run keygen"`;
}

function formatDependency(error) {
  return `${error.params.missingProperty} is required when ${error.params.property} is set`;
}

const ERROR_FORMATTERS = Object.freeze({
  required: formatRequired,
  enum: formatEnum,
  minLength: formatMinLength,
  dependencies: formatDependency,
});

function formatError(error) {
  const format = ERROR_FORMATTERS[error.keyword];

  return format
    ? format(error)
    : `${getVariableName(error)} ${error.message}`;
}

// The .env parser of Node reads "APP_A=<spaces>" as a value that continues on the next line:
// APP_A becomes "APP_B=..." and APP_B disappears without a word.
function findSwallowedLines(env) {
  return Object.entries(env)
    .filter(([, value]) => SWALLOWED_LINE_REGEXP.test(String(value)))
    .map(([key]) => `${key} swallowed the next line of ${ENV_FILE}: remove the whitespace after "${key}="`);
}

// AJV coerces "0x10", "1e3" and "Infinity" to numbers, and a non-finite one slips past minimum and maximum.
function findMalformedIntegers(env) {
  return Object.entries(ENV_SCHEMA.properties)
    .filter(([key, schema]) => schema.type === 'integer' && Object.hasOwn(env, key))
    .filter(([key]) => !INTEGER_REGEXP.test(String(env[key])))
    .map(([key]) => `${key} must be integer`);
}

// Runs before validate(): it coerces the values of env in place.
function findProblems(env) {
  const problems = [...findSwallowedLines(env), ...findMalformedIntegers(env)];

  return validate(env)
    ? problems
    : [...problems, ...validate.errors.map(formatError)];
}

function formatProblems(problems) {
  return [
    'Invalid environment variables:',
    ...[...new Set(problems)].map((problem) => `  - ${problem}`),
    `Set them in ${nodePath.resolve(ENV_FILE)} (see ${ENV_FILE}.example) or in the process environment.`,
  ].join('\n');
}

function formatName(name) {
  return name
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .replace(/(^\w|\s\w)/g, (letter) => letter.toUpperCase());
}

function readPackageDefaults() {
  const packageData = JSON.parse(readFileSync(resolvePath('package.json'), 'utf8'));

  return {
    APP_NAME: packageData.name,
    APP_NAME_FORMATTED: formatName(packageData.name ?? ''),
    APP_VERSION: packageData.version,
    APP_AUTHOR: packageData.author?.name ?? packageData.author,
    APP_REPOSITORY: packageData.repository?.url ?? packageData.repository,
    APP_DESCRIPTION: packageData.description,
  };
}

function filterEntries(source, isMatch) {
  return Object.fromEntries(Object.entries(source).filter(isMatch));
}

function isSet([, value]) {
  return value !== undefined && String(value).trim() !== '';
}

function loadEnvFile() {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  // With a byte order mark the first key is read as "<BOM>APP_...": the variable looks unset.
  if (Object.keys(process.env).some((key) => key.startsWith(BYTE_ORDER_MARK))) {
    throw new Error(`${nodePath.resolve(ENV_FILE)} starts with a UTF-8 byte order mark: save it as UTF-8 without BOM`);
  }
}

export function readEnv() {
  loadEnvFile();

  return filterEntries(process.env, ([key]) => key.startsWith(ENV_PREFIX));
}

export function readSystemEnv() {
  return filterEntries(process.env, ([key]) => !key.startsWith(ENV_PREFIX));
}

export function isCi() {
  return Boolean(process.env.CI) && !['false', '0'].includes(process.env.CI);
}

export function parseEnv(values) {
  const env = {
    ...filterEntries(readPackageDefaults(), isSet),
    ...filterEntries(values, isSet),
  };
  const problems = findProblems(env);

  if (problems.length) {
    throw new Error(formatProblems(problems));
  }

  return Object.freeze(env);
}

export function initEnv() {
  return parseEnv(readEnv());
}
