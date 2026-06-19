import { isArray, toNumber } from '#src/util/misc.js';

const CYR_TO_LAT_MAP = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'tz',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ы: 'y',
  э: 'e',
  ю: 'iu',
  я: 'ia',
  А: 'A',
  Б: 'B',
  В: 'V',
  Г: 'G',
  Д: 'D',
  Е: 'E',
  Ё: 'E',
  Ж: 'Zh',
  З: 'Z',
  И: 'I',
  Й: 'Y',
  К: 'K',
  Л: 'L',
  М: 'M',
  Н: 'N',
  О: 'O',
  П: 'P',
  Р: 'R',
  С: 'S',
  Т: 'T',
  У: 'U',
  Ф: 'F',
  Х: 'Kh',
  Ц: 'Tz',
  Ч: 'Ch',
  Ш: 'Sh',
  Щ: 'Sch',
  Ы: 'Y',
  Э: 'E',
  Ю: 'Iu',
  Я: 'Ia',
  ь: '',
  Ь: '',
  ъ: '',
  Ъ: '',
  ї: 'yi',
  і: 'i',
  ґ: 'g',
  є: 'e',
  Ї: 'Yi',
  І: 'I',
  Ґ: 'G',
  Є: 'E',
};

export function cyrToLat(text = '') {
  return text.split('')
    .map((ch) => CYR_TO_LAT_MAP[ch] ?? ch)
    .join('');
}

export function escapeHtml(text = '') {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };

  return text.replace(/[&<>"']/g, (m) => map[m]);
}

export function encodeUrl(url = '') {
  return encodeURIComponent(url);
}

export function normalizePhone(phone = '') {
  return phone.replace(/[^\d]+/g, '');
}

export function slugify(text = '', delimiter = '-') {
  let slug = cyrToLat(text);

  slug = slug.replace(new RegExp(`[^A-Za-z0-9${delimiter} ]+`, 'g'), '')
    .trim()
    .replace(/\s+/g, delimiter)
    .toLowerCase();

  return slug;
}

export function sanitizeWords(text = '') {
  return text.replace(/[^\p{L}\d ]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getExcerpt(text = '', maxChars = 100, end = '...') {
  const chars = [...text];

  if (chars.length <= maxChars) {
    return text;
  }

  const words = text.split(/\s+/);
  let output = '';

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if ([...output, ...word].length > maxChars) {
      break;
    }
    output += (output ? ' ' : '') + word;
  }

  return output + end;
}

export function getPluralForm(number, values = []) {
  // 'one' - 1 коментар
  // 'few' - 4 коментарі
  // 'many' - 5 коментарів

  const n = Math.abs(toNumber(number));
  const hasValues = isArray(values) && values.length === 3;

  const ratioHundreds = (n % 100) / 10;

  if (n > 10 && ratioHundreds >= 1 && ratioHundreds <= 2) {
    return hasValues ? values[2] : 'many';
  }

  const ratioDecimal = n % 10;

  if (ratioDecimal === 1) {
    return hasValues ? values[0] : 'one';
  }

  if (ratioDecimal >= 2 && ratioDecimal <= 4) {
    return hasValues ? values[1] : 'few';
  }

  return hasValues ? values[2] : 'many';
}
