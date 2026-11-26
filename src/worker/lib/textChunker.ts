export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function chunkTelegramText(text: string, maxUnits = 3800): string[] {
  if (!text || text.length === 0) {
    return [''];
  }
  if (text.length <= maxUnits) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  const segmenter =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
      ? new Intl.Segmenter('my', { granularity: 'grapheme' })
      : null;

  while (remaining.length > 0) {
    if (remaining.length <= maxUnits) {
      chunks.push(remaining);
      break;
    }

    // 1. Prefer paragraph boundary \n\n
    const sliceWindow = remaining.slice(0, maxUnits);
    let splitIdx = sliceWindow.lastIndexOf('\n\n');
    if (splitIdx >= Math.floor(maxUnits * 0.4)) {
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx + 2);
      continue;
    }

    // 2. Prefer newline boundary \n
    splitIdx = sliceWindow.lastIndexOf('\n');
    if (splitIdx >= Math.floor(maxUnits * 0.4)) {
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx + 1);
      continue;
    }

    // 3. Prefer Burmese sentence stop ။ or space
    const burmeseStopIdx = sliceWindow.lastIndexOf('။');
    const spaceIdx = sliceWindow.lastIndexOf(' ');
    const punctIdx = Math.max(burmeseStopIdx, spaceIdx);
    if (punctIdx >= Math.floor(maxUnits * 0.4)) {
      chunks.push(remaining.slice(0, punctIdx + 1));
      remaining = remaining.slice(punctIdx + 1);
      continue;
    }

    // 4. Grapheme-safe boundary using Intl.Segmenter
    if (segmenter) {
      let acc = '';
      for (const seg of segmenter.segment(remaining)) {
        if (acc.length + seg.segment.length > maxUnits) {
          break;
        }
        acc += seg.segment;
      }
      if (acc.length > 0) {
        chunks.push(acc);
        remaining = remaining.slice(acc.length);
        continue;
      }
    }

    chunks.push(remaining.slice(0, maxUnits));
    remaining = remaining.slice(maxUnits);
  }

  return chunks;
}
