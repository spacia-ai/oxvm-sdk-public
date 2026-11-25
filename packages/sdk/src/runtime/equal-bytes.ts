/** Compares the bytes of two views, including views that start at different offsets. */
export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  const length = left.byteLength;
  if (length !== right.byteLength) return false;
  let index = 0;
  if (length >= 512) {
    const leftView = new DataView(left.buffer, left.byteOffset, length);
    const rightView = new DataView(right.buffer, right.byteOffset, length);
    for (; index + 4 <= length; index += 4) {
      if (leftView.getUint32(index, true) !== rightView.getUint32(index, true)) return false;
    }
  } else if (length === 0) {
    // Preserve detached-buffer validation when an empty view appears valid.
    return left.every(() => true) && right.every(() => true);
  }
  for (; index < length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
