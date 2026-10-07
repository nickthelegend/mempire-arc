/**
 * Scroll a section into view, honouring the reduced-motion preference.
 *
 * The `prefers-reduced-motion` block in tokens.css only neutralises CSS
 * animations and transitions — a JS `behavior: 'smooth'` still animates, so the
 * preference has to be read here too.
 */
export function revealSection(el: HTMLElement | null): void {
  if (!el) return;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
}
