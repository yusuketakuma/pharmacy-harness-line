/** Encode one opaque identifier without allowing URL dot-segment normalization. */
export function encodePathSegment(id: string): string {
  if (!id || id === '.' || id === '..') throw new Error('Invalid path identifier');
  return encodeURIComponent(id);
}
