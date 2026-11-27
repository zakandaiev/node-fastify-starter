import { SCOPE_ALL, SCOPE_CODES, SCOPE_WILDCARD } from '#enums/scope.js';
import {
  isArray,
  isBoolean,
  isNonEmptyArray,
  isString,
} from '#utils/type.js';

// What a route may require: a wildcard grants actions and is none itself.
const ACTION_CODES = Object.freeze(SCOPE_CODES.filter((code) => !code.endsWith(SCOPE_WILDCARD)));

const REQUIREMENT_FORM = "['a', 'b'] for one of them, [['a', 'b']] for both";

// Array.from() reads a hole of a list as undefined, which is no scope: every() and flat() would skip it.
function isScopeList(scopes) {
  return isArray(scopes) && Array.from(scopes).every((scope) => isString(scope));
}

const HELD_SCOPES = 'the scopes a user holds';
const WANTED_SCOPES = 'the scopes to look for';

function assertScopeList(scopes, signature, what) {
  if (!isScopeList(scopes)) {
    throw new TypeError(`${signature} requires ${what} as a list of strings`);
  }

  return true;
}

export function assertWantedScopes(wanted, signature = 'assertWantedScopes(wanted)') {
  return assertScopeList(wanted, signature, WANTED_SCOPES);
}

function grantsScope(held, scope) {
  if (held === SCOPE_ALL || held === scope) {
    return true;
  }

  return held.endsWith(SCOPE_WILDCARD) && scope.startsWith(held.slice(0, -SCOPE_ALL.length));
}

function grantsEvery(scopes, wanted) {
  return wanted.every((scope) => scopes.some((held) => grantsScope(held, scope)));
}

function toTerm(term) {
  return isArray(term)
    ? Array.from(term)
    : [term];
}

export function isGrantableScope(scope) {
  return SCOPE_CODES.includes(scope);
}

// A term is a scope, or a list of scopes that all have to be granted.
export function readScopeTerms(requirement, signature = 'readScopeTerms(requirement)') {
  const terms = isNonEmptyArray(requirement)
    ? Array.from(requirement, (term) => toTerm(term))
    : [];

  if (!terms.length || !terms.every((term) => isNonEmptyArray(term) && isScopeList(term))) {
    throw new TypeError(`${signature} requires a non-empty list of scopes: ${REQUIREMENT_FORM}`);
  }

  const unknown = terms.flat().find((scope) => !ACTION_CODES.includes(scope));

  if (unknown !== undefined) {
    throw new TypeError(`${signature} names "${unknown}", which is no action of the scope catalog in src/enums/scope.js: a typo would leave the route to full access alone`);
  }

  return terms;
}

export function assertScopeRequirement(requirement, signature = 'assertScopeRequirement(requirement)') {
  readScopeTerms(requirement, signature);

  return true;
}

export function readGroupGrants({ isSuperadmin, scopes } = {}) {
  if (!isBoolean(isSuperadmin) || !isScopeList(scopes)) {
    throw new TypeError('readGroupGrants({ isSuperadmin, scopes }) requires the flag of full access and the scopes of a group');
  }

  return isSuperadmin
    ? [SCOPE_ALL]
    : [...scopes];
}

export function isEveryScopeGranted(scopes, wanted) {
  const signature = 'isEveryScopeGranted(scopes, wanted)';

  assertScopeList(scopes, signature, HELD_SCOPES);
  assertWantedScopes(wanted, signature);

  return grantsEvery(scopes, wanted);
}

export function isRequirementMet(scopes, requirement) {
  const signature = 'isRequirementMet(scopes, requirement)';

  assertScopeList(scopes, signature, HELD_SCOPES);

  return readScopeTerms(requirement, signature).some((term) => grantsEvery(scopes, term));
}
