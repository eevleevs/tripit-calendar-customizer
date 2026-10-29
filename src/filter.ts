/**
 * Raw-line iCalendar filtering.
 *
 * VEVENT blocks are matched on raw lines but classified on an unfolded copy,
 * and kept blocks are re-emitted byte-for-byte, so RFC 5545 line folding,
 * escaping and mixed line endings in untouched events survive intact.
 */

export interface Rule {
  name: string;
  /** Return true to drop the event. Receives the event's unfolded lines. */
  drop: (unfoldedEvent: string[]) => boolean;
}

export function filterCalendar(
  ics: string,
  rules: Rule[] = defaultRules,
): string {
  if (!/BEGIN:VCALENDAR/i.test(ics)) return ics;

  // Each segment carries its own line ending, so rejoining is byte-preserving.
  const parts = ics.split(/(\r\n|\n|\r)/);
  const segments: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    segments.push((parts[i] ?? "") + (parts[i + 1] ?? ""));
  }

  const out: string[] = [];
  let block: string[] | null = null;
  for (const segment of segments) {
    const line = stripEol(segment);
    if (!block) {
      if (/^BEGIN:VEVENT$/i.test(line)) block = [segment];
      else out.push(segment);
      continue;
    }
    block.push(segment);
    if (/^END:VEVENT$/i.test(line)) {
      const event = unfold(block.map(stripEol));
      if (!rules.some((rule) => rule.drop(event))) out.push(...block);
      block = null;
    }
  }
  if (block) out.push(...block); // unclosed VEVENT: fail open

  return out.join("");
}

/** An event is all-day iff its own DTSTART value is a bare RFC 5545 DATE. */
const isAllDay: Rule["drop"] = (event) => {
  for (const line of event) {
    const dtstart = /^DTSTART(?:;[^:]*)?:(.*)$/i.exec(line);
    if (dtstart) return /^\d{8}$/.test(dtstart[1]?.trim() ?? "");
  }
  return false;
};

export const defaultRules: Rule[] = [{ name: "all-day", drop: isAllDay }];

const stripEol = (segment: string): string =>
  segment.replace(/\r\n$|\n$|\r$/, "");

/** Reverse RFC 5545 folding on a copy: continuation lines start with one WSP. */
const unfold = (lines: string[]): string[] =>
  lines.reduce<string[]>((out, line) => {
    if (out.length && (line.startsWith(" ") || line.startsWith("\t"))) {
      out[out.length - 1] = (out[out.length - 1] ?? "") + line.slice(1);
    } else out.push(line);
    return out;
  }, []);
