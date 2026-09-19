/** A plausible rewrite of examples/slugify.ts that forgets to strip accents. */
export function slugify(input: string, maxLength = 48): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength);
}
