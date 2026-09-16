/** Carries state between calls. The shuffled second pass should flag this. */
let issued = 0;
export function nextTicket(queue: string): string {
  issued += 1;
  return `${queue}-${String(issued).padStart(4, '0')}`;
}
