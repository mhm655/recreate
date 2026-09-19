/** A from-scratch rewrite of examples/slugify.ts: different code, passes the captured challenge. */
export function slugify(input: string, maxLength = 48): string {
  const ascii = input.normalize('NFKD').replace(/\p{M}/gu, '');
  const words = ascii.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.join('-').slice(0, maxLength);
}
