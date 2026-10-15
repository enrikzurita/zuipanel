export interface ParsedPlaylist {
  mediaSequence: number;
  segments: Array<{ seq: number; uri: string; duration: number }>;
}

export function parsePlaylist(text: string): ParsedPlaylist {
  const lines = text.split(/\r?\n/);
  let mediaSequence = 0;
  let duration = 0;
  const segments: ParsedPlaylist['segments'] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) mediaSequence = Number(line.split(':')[1]) || 0;
    else if (line.startsWith('#EXTINF:')) duration = parseFloat(line.slice(8)) || 0;
    else if (!line.startsWith('#')) {
      segments.push({ seq: mediaSequence + segments.length, uri: line, duration });
      duration = 0;
    }
  }
  return { mediaSequence, segments };
}

/** Reescribe las URIs de los segmentos para que pasen por el agente con el token. */
export function rewritePlaylist(text: string, segmentUrl: (uri: string) => string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const l = line.trim();
      if (!l || l.startsWith('#')) return line;
      return segmentUrl(l.split('/').pop()!);
    })
    .join('\n');
}
