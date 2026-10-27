export function charCount(text: string): number {
  return Array.from(text).length;
}

export function clipChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') : text;
}
