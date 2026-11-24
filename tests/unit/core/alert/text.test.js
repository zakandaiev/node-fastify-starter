import { fitTexts } from '#core/alert/text.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const SUFFIX = '…';
const BACKTICK = '`';
const BACKSLASH = '\\';
const ESCAPED_REGEXP = /[`\\]/g;
const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });

// Built from code points: the file tools write the escape of an invisible mark as the raw character.
const EMOJI = String.fromCodePoint(0x1F600);
const ACCENTED_LETTER = `e${String.fromCharCode(0x0301)}`;
const FAMILY = String.fromCodePoint(0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467);

function measureLength(text) {
  return text.length;
}

// As a code entity of Telegram counts once escaped: a backtick and a backslash take two characters each.
function measureEscaped(text) {
  return text.length + (text.match(ESCAPED_REGEXP)?.length ?? 0);
}

function sumMeasured(texts, measure) {
  return texts.reduce((total, text) => total + measure(text), 0);
}

function readGraphemes(text) {
  return Array.from(GRAPHEMES.segment(text), ({ segment }) => segment);
}

function isCutOf(fitted, text) {
  return fitted === text
    || fitted === ''
    || (fitted.endsWith(SUFFIX) && text.startsWith(fitted.slice(0, -SUFFIX.length)));
}

describe('fitTexts', () => {
  test('keeps every text whole when all of them fit, a budget equal to their sum included', () => {
    const texts = ['one', 'two', 'three'];

    assert.deepEqual(fitTexts(texts, 11, measureLength), texts);
    assert.deepEqual(fitTexts(texts, 1000, measureLength), texts);
    assert.deepEqual(fitTexts([], 10, measureLength), []);
  });

  test('leaves a short text whole and gives the long ones equal shares of the rest', () => {
    const fitted = fitTexts(['a'.repeat(300), 'b'.repeat(1000), 'c'.repeat(1000)], 1200, measureLength);

    assert.deepEqual(fitted, ['a'.repeat(300), `${'b'.repeat(449)}${SUFFIX}`, `${'c'.repeat(449)}${SUFFIX}`]);
  });

  test('keeps the order of the texts whatever their lengths, and leaves the list it was given as it is', () => {
    const texts = Object.freeze(['z'.repeat(1000), 'tiny', 'y'.repeat(50)]);

    assert.deepEqual(fitTexts(texts, 200, measureLength), [`${'z'.repeat(145)}${SUFFIX}`, 'tiny', 'y'.repeat(50)]);
    assert.deepEqual(texts, ['z'.repeat(1000), 'tiny', 'y'.repeat(50)]);
  });

  test('fits the sum of the measured lengths into the budget whatever the budget, and only cuts a text short', () => {
    const texts = [
      'a'.repeat(40),
      `${BACKTICK.repeat(60)}${BACKSLASH.repeat(30)}${'b'.repeat(300)}`,
      'short',
      `${EMOJI.repeat(150)}${ACCENTED_LETTER.repeat(100)}`,
      '',
    ];
    const budgets = Array.from({ length: 200 }, (unused, index) => (index * 7) - 3);

    [measureLength, measureEscaped].forEach((measure) => {
      budgets.forEach((budget) => {
        const fitted = fitTexts(texts, budget, measure);

        assert.equal(fitted.length, texts.length);
        assert.ok(sumMeasured(fitted, measure) <= Math.max(budget, 0), `${measure.name} is over the budget of ${budget}`);
        fitted.forEach((text, index) => {
          assert.ok(isCutOf(text, texts[index]), `${measure.name}: text ${index} is not a cut of its own at the budget of ${budget}`);
          assert.equal(text.isWellFormed(), true);
        });
      });

      assert.deepEqual(fitTexts(texts, sumMeasured(texts, measure), measure), texts);
    });
  });

  test('cuts between graphemes: an emoji of two code units, a letter with a combining mark and a joined emoji stay whole', () => {
    [EMOJI, ACCENTED_LETTER, FAMILY].forEach((grapheme) => {
      const text = grapheme.repeat(40);

      Array.from({ length: 60 }, (unused, index) => index + 1).forEach((budget) => {
        const [fitted] = fitTexts([text], budget, measureLength);
        const kept = readGraphemes(fitted).slice(0, -1);

        assert.equal(fitted.isWellFormed(), true);
        assert.equal(fitted.endsWith(SUFFIX), true);
        assert.ok(fitted.length <= budget);
        assert.ok(kept.every((segment) => segment === grapheme), `a grapheme of ${grapheme.length} code units is split at the budget of ${budget}`);
        assert.equal(kept.length, Math.floor((budget - SUFFIX.length) / grapheme.length));
      });
    });
  });

  test('gives empty texts for a budget of zero and below', () => {
    assert.deepEqual(fitTexts(['abc', 'de', ''], -5, measureLength), ['', '', '']);
    assert.deepEqual(fitTexts(['abc', 'de', ''], 0, measureEscaped), ['', '', '']);
  });

  test('respects a measure that counts some characters twice, as an escape does', () => {
    const [backticks] = fitTexts([BACKTICK.repeat(30)], 40, measureEscaped);
    const [letters, escaped] = fitTexts(['a'.repeat(100), BACKTICK.repeat(100)], 100, measureEscaped);

    assert.match(backticks, /^`+…$/);
    assert.ok(measureEscaped(backticks) <= 40, 'a text that fits by its length but not by its measure is cut');
    assert.ok(measureEscaped(backticks) > 20, 'the cut leaves no more of the budget unused than the measure asks');

    assert.ok(measureEscaped(letters) <= 50);
    assert.ok(measureEscaped(escaped) <= 50);
    assert.match(escaped, /^`+…$/);
    assert.ok(letters.length > escaped.length, 'a text of plain letters keeps more characters than one that is escaped');
  });
});
