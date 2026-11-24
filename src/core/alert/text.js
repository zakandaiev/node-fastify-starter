import { truncate } from '#utils/string.js';

// The text is cut before it is escaped, so neither an escape nor an entity of the markup is ever split, and the cut
// falls between graphemes. "measure" gives the length of a text once escaped: the cut is shortened in proportion
// until that fits.
function cutToMeasure(text, maxLength, measure) {
  let limit = maxLength;
  let cut = truncate(text, limit);

  while (measure(cut) > maxLength && limit > 0) {
    limit = Math.floor(limit * (maxLength / measure(cut)));
    cut = truncate(text, limit);
  }

  return cut;
}

// Each text keeps its share of the budget: a short one stays whole, and the long ones share what is left.
export function fitTexts(texts, budget, measure) {
  const lengths = texts.map((text) => measure(text));
  const order = lengths
    .map((length, index) => index)
    .sort((left, right) => lengths[left] - lengths[right]);
  const fitted = [...texts];

  order.reduce((remaining, index, position) => {
    const share = Math.floor(remaining / (order.length - position));

    if (lengths[index] <= share) {
      return remaining - lengths[index];
    }

    fitted[index] = cutToMeasure(texts[index], share, measure);

    return remaining - measure(fitted[index]);
  }, Math.max(budget, 0));

  return fitted;
}
