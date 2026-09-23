const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const SPECIAL = '!@#$%^&*()-_+=~[]{}<>?';

export function generateSecurePassword(length = 14) {
  const allChars = `${UPPER}${LOWER}${DIGITS}${SPECIAL}`;
  const getRandom = (chars: string) => chars[Math.floor(Math.random() * chars.length)];

  const password = [
    getRandom(UPPER),
    getRandom(LOWER),
    getRandom(DIGITS),
    getRandom(SPECIAL),
  ];

  while (password.length < length) {
    password.push(getRandom(allChars));
  }

  return shuffle(password).join('');
}

function shuffle(array: string[]) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function normalizeLoginId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
