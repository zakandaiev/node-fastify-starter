import { fitTexts } from '#core/alert/text.js';
import { isString } from '#utils/type.js';

const LINE_BREAK = '\n';
const JSON_INDENT = 2;
const BACKTICK = '`';

// Three backticks in a row would close a code block of Slack and Discord, and neither escapes inside one:
// a zero-width space after each backtick keeps the text as it reads.
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200B);

export const SUPPRESSED_LABEL = 'Suppressed by throttle:';
export const SUPPRESSED_ICON = '⏳';

// A lone surrogate of a text would make Telegram refuse the whole message as not UTF-8; JSON escapes it by itself.
export function toBlockText(value) {
  return isString(value)
    ? value.toWellFormed()
    : JSON.stringify(value, null, JSON_INDENT);
}

export function breakBacktickRuns(text) {
  return text.replaceAll(BACKTICK, `${BACKTICK}${ZERO_WIDTH_SPACE}`);
}

// The count of the suppressed is the last line of a message, when there is one.
export function readFooter(message, format) {
  return message.suppressedCount > 0
    ? format(message.suppressedCount)
    : '';
}

// The markup of a channel around texts that are cut to its ceiling first: the header, the footer and the frame
// of every block are counted whole, and the texts of the blocks share what is left. "measure" gives the length
// of a text once "escape" has escaped it.
export function renderBlocks(message, {
  maxLength,
  header,
  footer,
  frame,
  escape,
  measure,
}) {
  const texts = message.blocks.map((block) => toBlockText(block.value));
  const frames = message.blocks.map((block) => frame(block));
  const edges = [header, ...(footer ? [footer] : [])];
  const frameLength = frames.reduce((total, { before, after }) => total + before.length + after.length, 0);
  const breakLength = (frames.length + edges.length) * LINE_BREAK.length;
  const edgeLength = edges.reduce((total, edge) => total + edge.length, 0);
  const fitted = fitTexts(texts, maxLength - frameLength - breakLength - edgeLength, measure);
  const blockLines = frames.map(({ before, after }, index) => `${before}${escape(fitted[index])}${after}`);

  return [header, ...blockLines, ...(footer ? [footer] : [])].join(LINE_BREAK);
}
