import {
  assertScopeRequirement,
  isEveryScopeGranted,
  isGrantableScope,
  isRequirementMet,
  readGroupGrants,
  readScopeTerms,
} from '#core/authz/match.js';
import { SCOPE, SCOPE_ALL, SCOPE_CATALOG } from '#enums/scope.js';
import { freezeDeep } from '#utils/object.js';
import { createHoled } from '#root/tests/helper/object.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { inspect } from 'node:util';

const REQUIREMENT_SIGNATURE = 'assertScopeRequirement(requirement)';
const TERMS_SIGNATURE = 'readScopeTerms(requirement)';
const ROUTE_SIGNATURE = 'security.scopes';
const EVERY_SIGNATURE = 'isEveryScopeGranted(scopes, wanted)';
const MET_SIGNATURE = 'isRequirementMet(scopes, requirement)';

const REQUIREMENT_FORM = "['a', 'b'] for one of them, [['a', 'b']] for both";
const WANTED_MESSAGE = `${EVERY_SIGNATURE} requires the scopes to look for as a list of strings`;
const GRANTS_MESSAGE = 'readGroupGrants({ isSuperadmin, scopes }) requires the flag of full access and the scopes of a group';

const ACTIONS = Object.freeze([SCOPE.GROUPS_READ, SCOPE.GROUPS_MANAGE, SCOPE.USERS_READ]);
const WILDCARDS = Object.freeze([SCOPE.GROUPS_ALL, SCOPE.USERS_ALL]);

const RESOURCE_WILDCARD = 'res:*';
const RESOURCE_ACTION = 'res:x';
const LOOKALIKE_ACTION = 'resx:y';
const OTHER_ACTION = 'other:x';
const LATER_ACTION = 'groups:archive';

const ANY_OF = freezeDeep([SCOPE.GROUPS_READ, SCOPE.GROUPS_MANAGE]);
const ALL_OF = freezeDeep([[SCOPE.GROUPS_READ, SCOPE.USERS_READ]]);
const MIXED = freezeDeep([SCOPE.GROUPS_MANAGE, [SCOPE.GROUPS_READ, SCOPE.USERS_READ]]);
const MEMBERS = freezeDeep([[SCOPE.GROUPS_READ, SCOPE.USERS_READ], [SCOPE.GROUPS_MANAGE, SCOPE.USERS_READ]]);

const NOT_SCOPE_LISTS = Object.freeze([
  undefined,
  null,
  SCOPE_ALL,
  1,
  {},
  new Set([SCOPE_ALL]),
  { 0: SCOPE_ALL, length: 1 },
  [1],
  [SCOPE_ALL, null],
  [[SCOPE_ALL]],
]);

const NOT_SCOPES = Object.freeze([undefined, null, 1, true, [SCOPE.GROUPS_READ], { code: SCOPE.GROUPS_READ }]);

const NOT_REQUIREMENTS = Object.freeze([
  undefined,
  null,
  SCOPE.GROUPS_READ,
  1,
  true,
  {},
  new Set([SCOPE.GROUPS_READ]),
  { 0: SCOPE.GROUPS_READ, length: 1 },
  [],
  [1],
  [null],
  [undefined],
  [true],
  [{ code: SCOPE.GROUPS_READ }],
  [new Set([SCOPE.GROUPS_READ])],
  [{ 0: SCOPE.GROUPS_READ, length: 1 }],
]);

const BAD_TERMS = Object.freeze([
  [[]],
  [SCOPE.GROUPS_READ, []],
  [[SCOPE.GROUPS_READ, 1]],
  [[SCOPE.GROUPS_READ, null]],
  [[SCOPE.GROUPS_READ, undefined]],
  [[[SCOPE.GROUPS_READ]]],
  [[SCOPE.GROUPS_READ, [SCOPE.USERS_READ]]],
]);

const UNKNOWN_CODES = Object.freeze([
  [['groups:write'], 'groups:write'],
  [['Groups:Read'], 'Groups:Read'],
  [['groups'], 'groups'],
  [[''], ''],
  [[SCOPE.GROUPS_READ, 'nope:a', 'nope:b'], 'nope:a'],
  [[[SCOPE.USERS_READ, 'users:write']], 'users:write'],
  [[SCOPE.GROUPS_ALL], SCOPE.GROUPS_ALL],
  [[[SCOPE.GROUPS_READ, SCOPE.USERS_ALL]], SCOPE.USERS_ALL],
  [[SCOPE_ALL], SCOPE_ALL],
  [[SCOPE.GROUPS_READ, [SCOPE_ALL]], SCOPE_ALL],
]);

const HELD_LISTS = Object.freeze([
  [],
  [SCOPE_ALL],
  [...WILDCARDS],
  [SCOPE.GROUPS_ALL],
  [SCOPE.USERS_ALL, SCOPE.GROUPS_READ],
  [SCOPE.GROUPS_READ],
  [SCOPE.GROUPS_MANAGE, SCOPE.USERS_READ],
  [...ACTIONS],
  ['groupsx:read', LATER_ACTION],
]);

function refusal(message) {
  return { name: 'TypeError', message };
}

function heldRefusal(signature) {
  return refusal(`${signature} requires the scopes a user holds as a list of strings`);
}

function shapeRefusal(signature) {
  return refusal(`${signature} requires a non-empty list of scopes: ${REQUIREMENT_FORM}`);
}

function unknownRefusal(signature, scope) {
  return refusal(`${signature} names "${scope}", which is no action of the scope catalog in src/enums/scope.js: a typo would leave the route to full access alone`);
}

// No literal holds a hole: the linter refuses a sparse array.
function listRequirementHoles() {
  return [
    new Array(1),
    new Array(2),
    createHoled(2, { 0: SCOPE.GROUPS_READ }),
    createHoled(2, { 1: [SCOPE.USERS_READ] }),
    createHoled(3, { 0: SCOPE.GROUPS_READ, 2: [SCOPE.USERS_READ] }),
  ];
}

function listTermHoles() {
  return [
    [new Array(1)],
    [new Array(2)],
    [createHoled(2, { 0: SCOPE.GROUPS_READ })],
    [createHoled(2, { 1: SCOPE.USERS_READ })],
    [SCOPE.GROUPS_MANAGE, createHoled(3, { 0: SCOPE.GROUPS_READ, 2: SCOPE.USERS_READ })],
  ];
}

function listSparseScopes() {
  return [
    new Array(1),
    new Array(2),
    createHoled(2, { 0: SCOPE.GROUPS_READ }),
    createHoled(2, { 1: SCOPE_ALL }),
    createHoled(3, { 0: SCOPE.USERS_READ, 2: SCOPE.GROUPS_ALL }),
  ];
}

function createShiftingRequirement(values) {
  const reads = [];
  const requirement = Object.defineProperty([], 0, {
    enumerable: true,
    get() {
      reads.push(values[Math.min(reads.length, values.length - 1)]);

      return reads.at(-1);
    },
  });

  return { requirement, reads };
}

function assertGrants(scopes, granted, refused) {
  granted.forEach((scope) => assert.equal(isEveryScopeGranted(scopes, [scope]), true, `${inspect(scopes)} grants ${scope}`));
  refused.forEach((scope) => assert.equal(isEveryScopeGranted(scopes, [scope]), false, `${inspect(scopes)} does not grant ${scope}`));
}

function assertMeets(requirement, met, unmet) {
  met.forEach((scopes) => assert.equal(isRequirementMet(scopes, requirement), true, inspect(scopes)));
  unmet.forEach((scopes) => assert.equal(isRequirementMet(scopes, requirement), false, inspect(scopes)));
}

describe('isGrantableScope', () => {
  test('takes every code of the catalog, the wildcard of a resource among them', () => {
    SCOPE_CATALOG.forEach(({ code }) => assert.equal(isGrantableScope(code), true, code));
    [...ACTIONS, ...WILDCARDS].forEach((code) => assert.equal(isGrantableScope(code), true, code));
  });

  test('refuses "*": full access is the flag of a group, not a scope it lists', () => {
    assert.equal(isGrantableScope(SCOPE_ALL), false);
  });

  test('refuses a code the catalog does not have, a lookalike of one and what is not a string', () => {
    const others = ['groups:write', LATER_ACTION, 'groups', 'groups:', ':*', 'GROUPS:READ', ' groups:read', 'groups:read ', ''];

    [...others, ...NOT_SCOPES].forEach((scope) => assert.equal(isGrantableScope(scope), false, inspect(scope)));
  });
});

describe('isEveryScopeGranted', () => {
  test('"*" grants every scope: an action, a wildcard, "*" itself and one the catalog does not have yet', () => {
    assertGrants([SCOPE_ALL], [...ACTIONS, ...WILDCARDS, SCOPE_ALL, LATER_ACTION, RESOURCE_WILDCARD, RESOURCE_ACTION], []);
  });

  test('the wildcard of a resource grants every scope of that resource and itself, an action the catalog gains later too', () => {
    assertGrants([RESOURCE_WILDCARD], [RESOURCE_ACTION, RESOURCE_WILDCARD], []);
    assertGrants([SCOPE.GROUPS_ALL], [SCOPE.GROUPS_READ, SCOPE.GROUPS_MANAGE, SCOPE.GROUPS_ALL, LATER_ACTION], []);
  });

  test('the wildcard of a resource grants nothing of another resource, of one whose name it starts, nor "*"', () => {
    assertGrants([RESOURCE_WILDCARD], [], [LOOKALIKE_ACTION, 'resx:*', OTHER_ACTION, 'res', SCOPE_ALL]);
    assertGrants([SCOPE.GROUPS_ALL], [], [SCOPE.USERS_READ, SCOPE.USERS_ALL, 'groupsx:read', 'groups', SCOPE_ALL]);
  });

  test('an exact scope grants itself only: not another action, not one it starts, not its wildcard, not "*"', () => {
    assertGrants([SCOPE.GROUPS_READ], [SCOPE.GROUPS_READ], [SCOPE.GROUPS_MANAGE, 'groups:reader', SCOPE.GROUPS_ALL, SCOPE.USERS_READ, SCOPE_ALL]);
    assertGrants([RESOURCE_ACTION], [RESOURCE_ACTION], [RESOURCE_WILDCARD, 'res:xy', LOOKALIKE_ACTION, SCOPE_ALL]);
  });

  test('grants no scope from an empty list, and grants what any one of the held scopes grants', () => {
    assertGrants([], [], [...ACTIONS, ...WILDCARDS, SCOPE_ALL]);
    assertGrants([SCOPE.USERS_READ, SCOPE.GROUPS_ALL], [SCOPE.USERS_READ, SCOPE.GROUPS_MANAGE, SCOPE.GROUPS_ALL], [SCOPE.USERS_ALL, SCOPE_ALL]);
  });

  test('grants a list when every scope of it is granted, each by any of the held ones', () => {
    assert.equal(isEveryScopeGranted([SCOPE.GROUPS_ALL, SCOPE.USERS_READ], [SCOPE.GROUPS_READ, SCOPE.GROUPS_MANAGE, SCOPE.USERS_READ]), true);
    assert.equal(isEveryScopeGranted([SCOPE_ALL], [...ACTIONS, ...WILDCARDS, SCOPE_ALL]), true);
    assert.equal(isEveryScopeGranted([...ACTIONS], [...ACTIONS]), true);
  });

  test('refuses a list when one scope of it is not granted', () => {
    assert.equal(isEveryScopeGranted([SCOPE.GROUPS_READ], [SCOPE.GROUPS_READ, SCOPE.GROUPS_MANAGE]), false);
    assert.equal(isEveryScopeGranted([SCOPE.GROUPS_ALL], [SCOPE.GROUPS_READ, SCOPE.USERS_READ]), false);
  });

  test('takes neither every action of a resource for its wildcard nor every wildcard for "*"', () => {
    assert.equal(isEveryScopeGranted([SCOPE.GROUPS_READ, SCOPE.GROUPS_MANAGE], [SCOPE.GROUPS_ALL]), false);
    assert.equal(isEveryScopeGranted([...ACTIONS, ...WILDCARDS], [SCOPE_ALL]), false);
    assert.equal(isEveryScopeGranted([SCOPE.GROUPS_ALL], [SCOPE.GROUPS_ALL]), true);
    assert.equal(isEveryScopeGranted([SCOPE_ALL], [SCOPE_ALL]), true);
  });

  test('grants an empty list whatever is held, and nothing but it from an empty list', () => {
    assert.equal(isEveryScopeGranted([], []), true);
    assert.equal(isEveryScopeGranted([SCOPE.USERS_READ], []), true);
    assert.equal(isEveryScopeGranted([], [SCOPE.GROUPS_READ]), false);
    assert.equal(isEveryScopeGranted([], [SCOPE_ALL]), false);
  });

  test('refuses either list when it is not a list of strings, a scope that is not a string among the wanted ones too, naming its signature', () => {
    NOT_SCOPE_LISTS.forEach((scopes) => {
      assert.throws(() => isEveryScopeGranted(scopes, [SCOPE.GROUPS_READ]), heldRefusal(EVERY_SIGNATURE), inspect(scopes));
      assert.throws(() => isEveryScopeGranted([SCOPE_ALL], scopes), refusal(WANTED_MESSAGE), inspect(scopes));
    });
    NOT_SCOPES.forEach((scope) => {
      assert.throws(() => isEveryScopeGranted([SCOPE_ALL], [scope]), refusal(WANTED_MESSAGE), inspect(scope));
    });
    assert.throws(() => isEveryScopeGranted(null, null), heldRefusal(EVERY_SIGNATURE));
  });

  // every() skips a hole: a wanted list of holes alone would be granted by an empty list.
  test('refuses either list when it has a hole, as it refuses undefined there', () => {
    listSparseScopes().forEach((scopes) => {
      assert.throws(() => isEveryScopeGranted(scopes, [SCOPE.GROUPS_READ]), heldRefusal(EVERY_SIGNATURE), inspect(scopes));
      assert.throws(() => isEveryScopeGranted([SCOPE_ALL], scopes), refusal(WANTED_MESSAGE), inspect(scopes));
      assert.throws(() => isEveryScopeGranted([], scopes), refusal(WANTED_MESSAGE), inspect(scopes));
    });
  });
});

describe('assertScopeRequirement', () => {
  test('accepts any one of a list of actions, all the actions of a term, and both forms mixed', () => {
    [ANY_OF, ALL_OF, MIXED, MEMBERS, ...ACTIONS.map((action) => [action]), [ACTIONS], [[SCOPE.USERS_READ], SCOPE.GROUPS_READ]].forEach((requirement) => {
      assert.equal(assertScopeRequirement(requirement), true, inspect(requirement));
    });
  });

  test('refuses what is not a list, a list with an item that is neither a scope nor a term, and an empty one', () => {
    NOT_REQUIREMENTS.forEach((requirement) => {
      assert.throws(() => assertScopeRequirement(requirement), shapeRefusal(REQUIREMENT_SIGNATURE), inspect(requirement));
    });
  });

  test('refuses an empty term and a term nested deeper than a list of scopes', () => {
    BAD_TERMS.forEach((requirement) => {
      assert.throws(() => assertScopeRequirement(requirement), shapeRefusal(REQUIREMENT_SIGNATURE), inspect(requirement, { depth: null }));
    });
  });

  test('refuses a code that is no action of the catalog and names the first one: an unknown code, the wildcard of a resource, "*"', () => {
    UNKNOWN_CODES.forEach(([requirement, scope]) => {
      assert.throws(() => assertScopeRequirement(requirement), unknownRefusal(REQUIREMENT_SIGNATURE, scope), inspect(requirement));
    });
  });

  test('names the signature it is given in either refusal', () => {
    assert.throws(() => assertScopeRequirement([], ROUTE_SIGNATURE), shapeRefusal(ROUTE_SIGNATURE));
    assert.throws(() => assertScopeRequirement([[]], ROUTE_SIGNATURE), shapeRefusal(ROUTE_SIGNATURE));
    assert.throws(() => assertScopeRequirement([SCOPE.GROUPS_ALL], ROUTE_SIGNATURE), unknownRefusal(ROUTE_SIGNATURE, SCOPE.GROUPS_ALL));
  });

  // A route that started with such a requirement would refuse every user, a holder of "*" too.
  test('reads a hole as no scope: a requirement of holes alone is refused as one that is not a list of scopes', () => {
    const holes = new Array(2);

    assert.throws(() => assertScopeRequirement(holes), shapeRefusal(REQUIREMENT_SIGNATURE));
    assert.throws(() => isRequirementMet([SCOPE_ALL], holes), shapeRefusal(MET_SIGNATURE));
  });

  // An empty term is met by every user: a term of holes alone must not read as one.
  test('refuses a hole among the terms of a requirement and a term of holes alone', () => {
    const requirements = [
      createHoled(2, { 0: SCOPE.GROUPS_READ }),
      createHoled(3, { 0: SCOPE.GROUPS_READ, 2: [SCOPE.USERS_READ] }),
      [new Array(2)],
      [SCOPE.GROUPS_READ, new Array(1)],
    ];

    requirements.forEach((requirement) => {
      assert.throws(() => assertScopeRequirement(requirement), shapeRefusal(REQUIREMENT_SIGNATURE), inspect(requirement));
      assert.throws(() => isRequirementMet([SCOPE_ALL], requirement), shapeRefusal(MET_SIGNATURE), inspect(requirement));
    });
  });

  test('refuses a hole inside a term as it refuses undefined there: the scope left out would leave the term to the others alone', () => {
    const requirement = [createHoled(2, { 0: SCOPE.GROUPS_READ })];

    assert.throws(() => assertScopeRequirement([[SCOPE.GROUPS_READ, undefined]]), shapeRefusal(REQUIREMENT_SIGNATURE));
    assert.throws(() => assertScopeRequirement(requirement), shapeRefusal(REQUIREMENT_SIGNATURE));
  });
});

describe('isRequirementMet', () => {
  test('meets a list of scopes with any one of them', () => {
    assertMeets(ANY_OF, [[SCOPE.GROUPS_READ], [SCOPE.GROUPS_MANAGE], [SCOPE.USERS_READ, SCOPE.GROUPS_MANAGE]], [[], [SCOPE.USERS_READ], [SCOPE.USERS_ALL]]);
  });

  test('meets a term only with every scope of it', () => {
    assertMeets(ALL_OF, [[SCOPE.GROUPS_READ, SCOPE.USERS_READ], [SCOPE.GROUPS_ALL, SCOPE.USERS_READ]], [[], [SCOPE.GROUPS_READ], [SCOPE.USERS_READ]]);
  });

  test('meets a mixed requirement by any one of its terms', () => {
    assertMeets(MIXED, [[SCOPE.GROUPS_MANAGE], [SCOPE.GROUPS_READ, SCOPE.USERS_READ]], [[SCOPE.GROUPS_READ], [SCOPE.USERS_READ]]);
    assertMeets(
      MEMBERS,
      [[SCOPE.GROUPS_READ, SCOPE.USERS_READ], [SCOPE.GROUPS_MANAGE, SCOPE.USERS_READ]],
      [[SCOPE.GROUPS_READ, SCOPE.GROUPS_MANAGE], [SCOPE.USERS_READ], [SCOPE.GROUPS_ALL]],
    );
  });

  test('meets every requirement with "*", and one with the wildcards of the resources it names', () => {
    [ANY_OF, ALL_OF, MIXED, MEMBERS].forEach((requirement) => assertMeets(requirement, [[SCOPE_ALL], [...WILDCARDS]], []));
    assertMeets(MEMBERS, [[SCOPE.GROUPS_ALL, SCOPE.USERS_READ], [SCOPE.GROUPS_READ, SCOPE.USERS_ALL]], [[SCOPE.GROUPS_ALL], [SCOPE.USERS_ALL]]);
  });

  test('says of one action what isEveryScopeGranted says of it, and of a term what it says of the whole term', () => {
    const cases = [...ACTIONS.map((action) => [[action], [action]]), [[ACTIONS], ACTIONS]];
    const verdicts = HELD_LISTS.flatMap((scopes) => cases.map(([requirement, wanted]) => {
      const isMet = isRequirementMet(scopes, requirement);

      assert.equal(isMet, isEveryScopeGranted(scopes, wanted), `${inspect(scopes)} ${inspect(requirement)}`);

      return isMet;
    }));

    assert.deepEqual([...new Set(verdicts)].toSorted(), [false, true]);
  });

  test('checks the held scopes first and then the requirement, refusing either under its own signature', () => {
    NOT_SCOPE_LISTS.forEach((scopes) => {
      assert.throws(() => isRequirementMet(scopes, ANY_OF), heldRefusal(MET_SIGNATURE), inspect(scopes));
    });
    [...NOT_REQUIREMENTS, ...BAD_TERMS].forEach((requirement) => {
      assert.throws(() => isRequirementMet([SCOPE_ALL], requirement), shapeRefusal(MET_SIGNATURE), inspect(requirement, { depth: null }));
    });
    UNKNOWN_CODES.forEach(([requirement, scope]) => {
      assert.throws(() => isRequirementMet([SCOPE_ALL], requirement), unknownRefusal(MET_SIGNATURE, scope), inspect(requirement));
    });
    assert.throws(() => isRequirementMet(SCOPE_ALL, []), heldRefusal(MET_SIGNATURE));
  });

  test('reads frozen lists as it reads any other: the guard hands it a frozen copy of the requirement', () => {
    const scopes = Object.freeze([SCOPE.GROUPS_MANAGE, SCOPE.USERS_READ]);

    assert.equal(Object.isFrozen(MEMBERS[0]), true);
    assert.equal(isRequirementMet(scopes, MEMBERS), true);
    assert.equal(isRequirementMet(scopes, ALL_OF), false);
    assert.equal(isRequirementMet(scopes, Object.freeze([SCOPE.USERS_READ])), true);
    assert.equal(isEveryScopeGranted(scopes, scopes), true);
  });

  test('refuses held scopes with a hole, as it refuses undefined among them', () => {
    listSparseScopes().forEach((scopes) => {
      assert.throws(() => isRequirementMet(scopes, ANY_OF), heldRefusal(MET_SIGNATURE), inspect(scopes));
    });
  });

  // Read twice, a requirement could be checked as one action and matched as an empty term, which anyone meets.
  test('reads the requirement once and matches what it checked', () => {
    const shifting = createShiftingRequirement([SCOPE.GROUPS_MANAGE, []]);
    const unknownLater = createShiftingRequirement([SCOPE.GROUPS_MANAGE, 'groups:write']);

    assert.equal(isRequirementMet([], shifting.requirement), false);
    assert.equal(isRequirementMet([SCOPE.GROUPS_MANAGE], unknownLater.requirement), true);
    assert.deepEqual([shifting.reads, unknownLater.reads], [[SCOPE.GROUPS_MANAGE], [SCOPE.GROUPS_MANAGE]]);
  });
});

describe('readScopeTerms', () => {
  test('reads a term as the list of scopes it is and a single scope as a list of one, in the order of the requirement', () => {
    const reversed = ACTIONS.toReversed();

    assert.deepEqual(readScopeTerms([SCOPE.GROUPS_READ]), [[SCOPE.GROUPS_READ]]);
    assert.deepEqual(readScopeTerms(ANY_OF), [[SCOPE.GROUPS_READ], [SCOPE.GROUPS_MANAGE]]);
    assert.deepEqual(readScopeTerms(ALL_OF), [[SCOPE.GROUPS_READ, SCOPE.USERS_READ]]);
    assert.deepEqual(readScopeTerms(MIXED), [[SCOPE.GROUPS_MANAGE], [SCOPE.GROUPS_READ, SCOPE.USERS_READ]]);
    assert.deepEqual(readScopeTerms(MEMBERS), [[SCOPE.GROUPS_READ, SCOPE.USERS_READ], [SCOPE.GROUPS_MANAGE, SCOPE.USERS_READ]]);
    assert.deepEqual(readScopeTerms(reversed), reversed.map((action) => [action]));
    assert.deepEqual(readScopeTerms([reversed, SCOPE.GROUPS_READ]), [reversed, [SCOPE.GROUPS_READ]]);
  });

  test('gives lists of its own, for a frozen requirement as for any other: changing them leaves the requirement as it was', () => {
    const requirement = [SCOPE.GROUPS_MANAGE, [SCOPE.GROUPS_READ, SCOPE.USERS_READ]];
    const terms = readScopeTerms(requirement);
    const frozenTerms = readScopeTerms(MIXED);

    assert.deepEqual(frozenTerms, terms);
    assert.notEqual(terms, requirement);
    assert.notEqual(terms[1], requirement[1]);
    assert.notEqual(frozenTerms[1], MIXED[1]);
    terms[1].push(SCOPE.GROUPS_MANAGE);
    terms.push([SCOPE.USERS_READ]);
    frozenTerms[0].push(SCOPE.USERS_READ);
    frozenTerms[1].push(SCOPE.GROUPS_MANAGE);
    assert.deepEqual(requirement, [SCOPE.GROUPS_MANAGE, [SCOPE.GROUPS_READ, SCOPE.USERS_READ]]);
    assert.deepEqual(MIXED, [SCOPE.GROUPS_MANAGE, [SCOPE.GROUPS_READ, SCOPE.USERS_READ]]);
  });

  test('refuses what assertScopeRequirement refuses, with the same TypeError under its own signature', () => {
    [...NOT_REQUIREMENTS, ...BAD_TERMS].forEach((requirement) => {
      assert.throws(() => readScopeTerms(requirement), shapeRefusal(TERMS_SIGNATURE), inspect(requirement, { depth: null }));
    });
    UNKNOWN_CODES.forEach(([requirement, scope]) => {
      assert.throws(() => readScopeTerms(requirement), unknownRefusal(TERMS_SIGNATURE, scope), inspect(requirement));
    });
  });

  // every() and flat() skip a hole: the scope left out would leave a term to the others, and an empty term to anyone.
  test('refuses a hole of the requirement and a hole inside a term, as it refuses undefined there', () => {
    [...listRequirementHoles(), ...listTermHoles()].forEach((requirement) => {
      assert.throws(() => readScopeTerms(requirement), shapeRefusal(TERMS_SIGNATURE), inspect(requirement));
    });
    assert.throws(() => readScopeTerms([undefined]), shapeRefusal(TERMS_SIGNATURE));
    assert.throws(() => readScopeTerms([[SCOPE.GROUPS_READ, undefined]]), shapeRefusal(TERMS_SIGNATURE));
  });

  test('names the signature it is given in either TypeError, and its own when it is given none', () => {
    [ROUTE_SIGNATURE, MET_SIGNATURE].forEach((signature) => {
      assert.throws(() => readScopeTerms([], signature), shapeRefusal(signature), signature);
      assert.throws(() => readScopeTerms(new Array(1), signature), shapeRefusal(signature), signature);
      assert.throws(() => readScopeTerms([createHoled(2, { 0: SCOPE.GROUPS_READ })], signature), shapeRefusal(signature), signature);
      assert.throws(() => readScopeTerms([SCOPE.USERS_ALL], signature), unknownRefusal(signature, SCOPE.USERS_ALL), signature);
    });
    assert.throws(() => readScopeTerms(SCOPE.GROUPS_READ, undefined), shapeRefusal(TERMS_SIGNATURE));
    assert.throws(() => readScopeTerms([[]], undefined), shapeRefusal(TERMS_SIGNATURE));
    assert.throws(() => readScopeTerms(['groups:write'], undefined), unknownRefusal(TERMS_SIGNATURE, 'groups:write'));
  });
});

describe('readGroupGrants', () => {
  test('grants "*" alone to a group of full access, whatever scopes it lists', () => {
    [[], [SCOPE.GROUPS_READ], [...ACTIONS, ...WILDCARDS], [SCOPE_ALL]].forEach((scopes) => {
      assert.deepEqual(readGroupGrants({ isSuperadmin: true, scopes }), [SCOPE_ALL], inspect(scopes));
    });
  });

  test('grants a group without full access the scopes it lists in their order, as a copy that does not share their list', () => {
    const scopes = [SCOPE.USERS_READ, SCOPE.GROUPS_ALL];
    const grants = readGroupGrants({ isSuperadmin: false, scopes });

    assert.deepEqual(grants, [SCOPE.USERS_READ, SCOPE.GROUPS_ALL]);
    assert.notEqual(grants, scopes);
    grants.push(SCOPE_ALL);
    assert.deepEqual(scopes, [SCOPE.USERS_READ, SCOPE.GROUPS_ALL]);
    assert.deepEqual(readGroupGrants({ isSuperadmin: false, scopes: [] }), []);
  });

  test('reads frozen scopes as any other', () => {
    const scopes = Object.freeze([SCOPE.GROUPS_READ, SCOPE.USERS_READ]);
    const grants = readGroupGrants({ isSuperadmin: false, scopes });

    assert.deepEqual(grants, scopes);
    assert.notEqual(grants, scopes);
  });

  test('refuses a flag of full access that is not a boolean, the 1 and 0 of a column among them, and scopes that are not a list of strings', () => {
    [undefined, null, 1, 0, 'true', 'false'].forEach((isSuperadmin) => {
      assert.throws(() => readGroupGrants({ isSuperadmin, scopes: [] }), refusal(GRANTS_MESSAGE), inspect(isSuperadmin));
    });
    NOT_SCOPE_LISTS.forEach((scopes) => {
      [true, false].forEach((isSuperadmin) => {
        assert.throws(() => readGroupGrants({ isSuperadmin, scopes }), refusal(GRANTS_MESSAGE), `${isSuperadmin} ${inspect(scopes)}`);
      });
    });
    [undefined, {}].forEach((group) => assert.throws(() => readGroupGrants(group), refusal(GRANTS_MESSAGE), inspect(group)));
  });

  // The copy would turn a hole into undefined, a grant that is no scope.
  test('refuses scopes with a hole whatever the flag, as it refuses undefined among them', () => {
    listSparseScopes().forEach((scopes) => {
      [true, false].forEach((isSuperadmin) => {
        assert.throws(() => readGroupGrants({ isSuperadmin, scopes }), refusal(GRANTS_MESSAGE), `${isSuperadmin} ${inspect(scopes)}`);
      });
    });
    assert.throws(() => readGroupGrants({ isSuperadmin: false, scopes: [SCOPE.GROUPS_READ, undefined] }), refusal(GRANTS_MESSAGE));
  });
});
