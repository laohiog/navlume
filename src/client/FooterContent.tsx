import type { ReactNode } from 'react';

// Recognize only a quoted href and a text label. Extra attributes and nested
// markup stay escaped text rather than entering a general-purpose HTML parser.
const linkPattern = /<a\s+href\s*=\s*(?:"([^"]*)"|'([^']*)')\s*>([^<>]*)<\/a\s*>/gi;

/** Decode entities only inside recognized links; legacy plain text stays intact. */
function decodeLinkEntities(value: string): string {
  return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x';
      const number = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(number) || number <= 0 || number > 0x10ffff || (number >= 0xd800 && number <= 0xdfff)) {
        return whole;
      }
      return String.fromCodePoint(number);
    }

    const named: Record<string, string> = {
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    };
    return named[entity.toLowerCase()] ?? whole;
  });
}

function safeLinkUrl(rawHref: string): string | null {
  try {
    const url = new URL(decodeLinkEntities(rawHref));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Build React elements with fixed attributes; never insert user-supplied HTML. */
export function FooterContent({ text }: { text: string }): ReactNode {
  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const match of text.matchAll(linkPattern)) {
    const position = match.index;
    if (position > cursor) {
      nodes.push(text.slice(cursor, position));
    }

    const href = safeLinkUrl(match[1] ?? match[2]);
    nodes.push(href === null ? match[0] : (
      <a key={position} href={href} target="_blank" rel="noopener noreferrer">
        {decodeLinkEntities(match[3])}
      </a>
    ));
    cursor = position + match[0].length;
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return <>{nodes}</>;
}
