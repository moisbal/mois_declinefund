const INTEGER_PATTERN = /^-?\d+$/;
const WON_PER_MANWON = BigInt('10000');

export function formatIntegerString(value: string) {
  if (!INTEGER_PATTERN.test(value)) {
    return value;
  }

  const isNegative = value.startsWith('-');
  const digits = isNegative ? value.slice(1) : value;
  const formattedDigits = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${isNegative ? '-' : ''}${formattedDigits}`;
}

export function formatAuditAmount(value: string | null) {
  return value === null ? null : formatIntegerString(value);
}

export function formatWonWithUnit(value: string | null | undefined) {
  if (value === null || value === undefined || !INTEGER_PATTERN.test(value)) {
    return value ?? '-';
  }
  return `${formatIntegerString(value)}원`;
}

export function formatWonAsManwon(value: string | null | undefined) {
  if (value === null || value === undefined || !INTEGER_PATTERN.test(value)) {
    return value ?? '-';
  }

  const amount = BigInt(value);
  const isNegative = amount < BigInt(0);
  const absoluteAmount = isNegative ? -amount : amount;
  const wholeManwon = absoluteAmount / WON_PER_MANWON;
  const wholePart = formatIntegerString(wholeManwon.toString());

  // Display values are intentionally truncated below 10,000 won. Raw won
  // values remain untouched for persistence, calculations, tooltips, and CSV.
  return `${isNegative ? '-' : ''}${wholePart}`;
}

export function formatWonAsManwonWithUnit(value: string | null | undefined) {
  if (value === null || value === undefined || !INTEGER_PATTERN.test(value)) {
    return value ?? '-';
  }
  return `${formatWonAsManwon(value)}만원`;
}

export function formatWonAsKorean(value: string | null | undefined) {
  if (value === null || value === undefined || !INTEGER_PATTERN.test(value)) {
    return value ?? '-';
  }

  const amount = BigInt(value);
  const isNegative = amount < BigInt(0);
  const absoluteAmount = isNegative ? -amount : amount;
  const wonPerEok = BigInt('100000000');
  const eok = absoluteAmount / wonPerEok;
  const manwon = (absoluteAmount % wonPerEok) / WON_PER_MANWON;
  const prefix = isNegative ? '-' : '';

  if (eok === BigInt(0)) {
    return `${prefix}${formatIntegerString(manwon.toString())}만원`;
  }
  if (manwon === BigInt(0)) {
    return `${prefix}${formatIntegerString(eok.toString())}억원`;
  }
  return `${prefix}${formatIntegerString(eok.toString())}억 ${formatIntegerString(manwon.toString())}만원`;
}
