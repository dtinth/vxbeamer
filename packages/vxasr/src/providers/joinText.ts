/**
 * Join two pieces of text a streaming vendor cut apart (utterances, committed
 * segments). Thai has no inter-word spaces, so a space goes in only where a
 * Latin letter or digit meets something that is not already a space.
 */
export function joinText(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const latin = /[A-Za-z0-9]/;
  const edge = latin.test(a.at(-1)!) || latin.test(b[0]!);
  return edge && !/\s/.test(a.at(-1)!) && !/\s/.test(b[0]!) ? `${a} ${b}` : a + b;
}
