import { describe, expect, test } from "bun:test";
import { defaultRules, filterCalendar } from "../src/filter";

/** Sanitized copy of a real TripIt feed: one all-day trip span + three timed flights. */
const FIXTURE = [
  "BEGIN:VCALENDAR",
  "X-WR-CALNAME:Test User (TripIt)",
  "X-WR-CALDESC:TripIt Calendar",
  "X-PUBLISHED-TTL:PT15M",
  "PRODID:-//John Papaioannou/NONSGML Bennu 0.1//EN",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "DTSTAMP:20261029T190901Z",
  "UID:83312ff4-e41f-9000-0001-000000000000@tripit.com",
  "DTSTART;VALUE=DATE:20261101",
  "DTEND;VALUE=DATE:20261205",
  "SUMMARY:Barcelona and Copenhagen\\, November 2026",
  "LOCATION:Copenhagen\\, Denmark",
  "GEO:55.67594;12.56553",
  "TRANSP:TRANSPARENT",
  "DESCRIPTION:Test User is in Copenhagen\\, Denmark from Nov 1 to Dec 4",
  " 2026\\nView and/or edit details in TripIt : https://www.tripit.com/trip/",
  " show?id=000000000\\nTripIt - organize your travel at https://www.tripit.com",
  "\\n",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTAMP:20261029T190901Z",
  "DTEND:20261101T213000Z",
  "SUMMARY:FR6334 PSA to GRO",
  "LOCATION:Pisa (PSA)",
  "UID:item-fd1444b7-af5c-9000-0003-000000000001@tripit.com",
  "DTSTART:20261101T200500Z",
  "DESCRIPTION:View and/or edit details in TripIt : https://www.tripit.com/tr",
  " ip/show/id=000000000\\n \\n\\nSun\\, Nov 1\\n9:05 PM CET\\n[Flight] PSA to GRO\\n",
  "   \\n\\nTripIt - organize your travel at https://www.tripit.com",
  "GEO:41.98311;2.82493",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTAMP:20261029T190901Z",
  "UID:item-83b9e84e-3cde-9000-0003-000000000002@tripit.com",
  "DTSTART:20261204T120500Z",
  "DTEND:20261204T141500Z",
  "SUMMARY:FR1785 CPH to BGY",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "TRIGGER:-PT30M",
  "DESCRIPTION:Flight reminder",
  "END:VALARM",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

const count = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

describe("filterCalendar", () => {
  test("drops the all-day trip span, keeps every timed flight", () => {
    const out = filterCalendar(FIXTURE);
    expect(out).not.toContain("VALUE=DATE");
    expect(out).not.toContain("Barcelona and Copenhagen");
    expect(out).toContain("FR6334 PSA to GRO");
    expect(out).toContain("FR1785 CPH to BGY");
    expect(count(out, "BEGIN:VEVENT")).toBe(2);
    expect(count(FIXTURE, "BEGIN:VEVENT")).toBe(3);
  });

  test("keeps folded lines of surviving events byte-for-byte", () => {
    const out = filterCalendar(FIXTURE);
    expect(out).toContain(
      " ip/show/id=000000000\\n \\n\\nSun\\, Nov 1\\n9:05 PM CET",
    );
    expect(out).toContain(
      "DESCRIPTION:View and/or edit details in TripIt : https://www.tripit.com/tr",
    );
  });

  test("keeps calendar wrapper and nested VALARM intact", () => {
    const out = filterCalendar(FIXTURE);
    expect(out.startsWith("BEGIN:VCALENDAR")).toBe(true);
    expect(out.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    expect(out).toContain("X-WR-CALNAME:Test User (TripIt)");
    expect(count(out, "BEGIN:VALARM")).toBe(1);
  });

  test("preserves CRLF line endings and trailing newline", () => {
    const out = filterCalendar(FIXTURE);
    expect(out).toContain("\r\n");
    expect(out.endsWith("\r\n")).toBe(true);
    expect(out.split("\n").length).toBe(out.split("\r\n").length);
  });

  test("preserves input without trailing newline", () => {
    const ics = FIXTURE.trimEnd();
    expect(filterCalendar(ics).endsWith("\r\n")).toBe(false);
  });

  test("drops bare-date DTSTART (missing VALUE=DATE param)", () => {
    const ics =
      "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20261101\r\nSUMMARY:Span\r\nEND:VEVENT\r\nEND:VCALENDAR";
    expect(filterCalendar(ics)).not.toContain("Span");
  });

  test("keeps events without DTSTART", () => {
    const ics =
      "BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Odd\nEND:VEVENT\nEND:VCALENDAR";
    expect(filterCalendar(ics)).toContain("Odd");
  });

  test("keeps timed DTSTART with TZID and DATE-TIME value", () => {
    const ics =
      "BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;TZID=Europe/Rome:20261101T210500\nSUMMARY:Timed\nEND:VEVENT\nEND:VCALENDAR";
    expect(filterCalendar(ics)).toContain("Timed");
  });

  test("matches BEGIN/END case-insensitively", () => {
    const ics =
      "begin:vcalendar\r\nbegin:vevent\r\nDTSTART;VALUE=DATE:20261101\r\nend:vevent\r\nend:vcalendar";
    expect(filterCalendar(ics)).not.toContain("DTSTART");
  });

  test("passes non-VCALENDAR input through unchanged", () => {
    expect(filterCalendar("<html>not a calendar</html>")).toBe(
      "<html>not a calendar</html>",
    );
    expect(filterCalendar("")).toBe("");
  });

  test("passes an unclosed VEVENT through (fail-open)", () => {
    const ics =
      "BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:20261101\nEND:VCALENDAR";
    expect(filterCalendar(ics)).toBe(ics);
  });

  test("supports custom rules", () => {
    const dropFlight = defaultRules.concat({
      name: "flights",
      drop: (event) =>
        event.some((line) =>
          /^SUMMARY:/i.test(line) && line.includes("FR6334")
        ),
    });
    const out = filterCalendar(FIXTURE, dropFlight);
    expect(out).not.toContain("FR6334");
    expect(out).toContain("FR1785");
  });
});
