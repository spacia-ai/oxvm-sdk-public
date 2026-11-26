import { describe, expect, it } from "vitest";
import { formatIPv6, ipVersion, parseIPv6, parseLegacyIPv4, reverseName } from "./node-dns-address.ts";
import { encodeResponse, type EncodedRecord } from "./node-dns-wire-encode.ts";
import { decodeMessage, DnsNameError, DnsWireError, encodeQuery, peekQuestion, RR_TYPE } from "./node-dns-wire.ts";
import { controls, hex, object, recordedQueries, unhex } from "./node-dns-replay.test-support.ts";

const recorded = controls("node-dns-resolver");
/** Every reply the recorder's server sent Node 24.18.1, which c-ares parsed (or refused) there. */
const replies = Object.values(object(recorded["resolve"])).flatMap(entry => recordedQueries(object(entry)["queries"]));

describe("the query Node 24 sends", () => {
  it("is a header with recursion desired and one question, without an EDNS record", () => {
    const first = replies.find(entry => entry.name === "a.test" && entry.type === 1);
    expect(hex(encodeQuery(0xbeef, "a.test", RR_TYPE.A))).toBe(`beef${first?.query ?? ""}`);
    expect(hex(encodeQuery(1, "", RR_TYPE.A))).toBe("0001" + "0100" + "0001" + "000000000000" + "00" + "0001" + "0001");
    expect(encodeQuery(1, "a.test.", RR_TYPE.MX)).toEqual(encodeQuery(1, "a.test", RR_TYPE.MX));
  });
  it("refuses the names c-ares refuses", () => {
    for (const name of ["a..test", `${"x".repeat(64)}.test`, `${`${"x".repeat(60)}.`.repeat(5)}test`, "a b.test", "a\\.b.test", ".test"]) expect(() => encodeQuery(1, name, RR_TYPE.A), name).toThrow(DnsNameError);
    for (const name of ["_sip._udp.a.test", "*.a.test", "a/b.test", `${"x".repeat(63)}.test`]) expect(() => encodeQuery(1, name, RR_TYPE.A), name).not.toThrow();
  });
});

describe("decoding replies", () => {
  it("reads every record type from the recorded replies, with compressed owner names", () => {
    const answers = (name: string, type: number): unknown[] => {
      const entry = replies.find(item => item.name === name && item.type === type && item.reply !== null);
      return decodeMessage(unhex(`0000${entry?.reply ?? ""}`)).answers.map(record => ({ ...record.data, ttl: record.ttl, name: record.name }));
    };
    expect(answers("a.test", 1)).toEqual([{ type: "A", address: "192.0.2.1", ttl: 300, name: "a.test" }, { type: "A", address: "192.0.2.2", ttl: 60, name: "a.test" }]);
    expect(answers("alias.test", 1)).toEqual([{ type: "CNAME", value: "mid.test", ttl: 30, name: "alias.test" }, { type: "CNAME", value: "a.test", ttl: 40, name: "mid.test" }, { type: "A", address: "192.0.2.9", ttl: 50, name: "a.test" }]);
    expect(answers("soa.test", 6)).toEqual([{ type: "SOA", nsname: "ns.soa.test", hostmaster: "hostmaster.soa.test", serial: 2026112501, refresh: 7200, retry: 3600, expire: 1209600, minttl: 300, ttl: 10, name: "soa.test" }]);
    expect(answers("txt.test", 16)[1]).toMatchObject({ type: "TXT", entries: ["part one ", "part two", ""] });
    expect(answers("any.test", 255).map(record => object(record)["type"])).toEqual(["A", "AAAA", "MX", "NS", "TXT", "SRV", "PTR", "CNAME", "SOA", "NAPTR", "CAA", "TLSA", "OTHER"]);
  });

  it("round-trips its own encoder for every record type", () => {
    const records: EncodedRecord[] = [
      { ttl: 1, data: { type: "A", address: "10.1.2.3" } }, { ttl: 2, data: { type: "AAAA", address: "2001:db8::1:0:0:ff" } },
      { name: "other.test", ttl: 3, data: { type: "CNAME", value: "c.test" } }, { data: { type: "NS", value: "ns.test" } }, { data: { type: "PTR", value: "p.test" } },
      { data: { type: "MX", priority: 10, exchange: "mx.test" } }, { data: { type: "TXT", entries: ["a", "", "ÿ"] } },
      { data: { type: "SRV", priority: 1, weight: 2, port: 443, name: "s.test" } },
      { data: { type: "SOA", nsname: "ns.test", hostmaster: "h.test", serial: 4294967295, refresh: 2, retry: 3, expire: 4, minttl: 5 } },
      { data: { type: "NAPTR", order: 1, preference: 2, flags: "U", service: "E2U+sip", regexp: "!^.*$!sip:x@y!", replacement: "" } },
      { data: { type: "CAA", critical: 128, tag: "issue", value: "ca.test; x=y" } }, { data: { type: "TLSA", certUsage: 3, selector: 1, match: 1, data: Uint8Array.of(1, 2, 3) } },
      { data: { type: "OTHER", code: 99, data: Uint8Array.of(9) } },
    ];
    const message = decodeMessage(encodeResponse({ id: 0x4242, name: "q.test", type: RR_TYPE.ANY, rcode: 0, truncated: true, answers: records, authorities: [{ name: "test", data: { type: "NS", value: "ns.test" } }] }));
    expect(message).toMatchObject({ id: 0x4242, response: true, truncated: true, rcode: 0, question: { name: "q.test", type: 255, class: 1 } });
    expect(message.answers.map(record => record.data)).toEqual(records.map(record => record.data));
    expect(message.answers.map(record => record.name)).toEqual(records.map(record => record.name ?? "q.test"));
    expect(message.authorities).toEqual([{ name: "test", class: 1, ttl: 0, data: { type: "NS", value: "ns.test" } }]);
  });

  it("writes names as c-ares does: bytes outside printable ASCII as \\DDD, its reserved characters behind a backslash", () => {
    const head = "000081800001000100000000" + "0171" + "00" + "00020001", name = `05${hex(Uint8Array.of(0x61, 0x2e, 0x01, 0xff, 0x5c))}0340242900`;
    const reply = unhex(`${head}c00c0002000100000005000b${name}`);
    expect(decodeMessage(reply).answers[0]?.data).toEqual({ type: "NS", value: "a\\.\\001\\255\\\\.\\@\\$\\)" });
  });

  it("rejects what is not a DNS message as a wire error, never anything else", () => {
    const question = "0161047465737400" + "00010001", header = (answers: number, questions = 1): string => `00008180${questions.toString(16).padStart(4, "0")}${answers.toString(16).padStart(4, "0")}00000000`;
    const cases: Record<string, string> = {
      "nothing": "", "half a header": "000081800001", "no question": header(0, 0), "two questions": header(0, 2) + question + question,
      "a pointer to itself": `${header(1)}${question}c0180001000100000001000401020304`,
      "a pointer forwards": `${header(1)}${question}c0300001000100000001000401020304`,
      "a label past the end": `${header(0)}3f6161`, "a reserved label type": `${header(0)}80610000010001`,
      "a record cut short": `${header(1)}${question}c00c000100010000000a0004c000`,
      "an address longer than its record": `${header(1)}${question}c00c000100010000000a0003c00002`,
      "a string past its record": `${header(1)}${question}c00c001000010000000a00030a6162`,
      "a TLSA record without data": `${header(1)}${question}c00c003400010000000a0003030101`,
      "a missing record": `${header(2)}${question}c00c000100010000000a000401020304`,
    };
    for (const [label, digits] of Object.entries(cases)) expect(() => decodeMessage(unhex(digits)), label).toThrow(DnsWireError);
    // A name of more than 255 bytes.
    expect(() => decodeMessage(unhex(`${header(0)}${`3f${"61".repeat(63)}`.repeat(5)}0000010001`))).toThrow(DnsWireError);
    // Every prefix of every recorded reply either decodes or is a wire error.
    for (const entry of replies) {
      if (entry.reply === null) continue;
      const bytes = unhex(`0000${entry.reply}`);
      for (let length = 0; length < bytes.length; length += 1) {
        try { decodeMessage(bytes.subarray(0, length)); } catch (error) { expect(error, `${entry.name} cut at ${String(length)}`).toBeInstanceOf(DnsWireError); }
        expect(() => peekQuestion(bytes.subarray(0, length))).not.toThrow();
      }
    }
  });
});

describe("addresses as inet_pton reads and inet_ntop writes them", () => {
  it("accepts what net.isIP accepts", () => {
    expect(["1.2.3.4", "01.2.3.4", "1.2.3", "256.1.1.1", "::", "::1", "2001:DB8::1", "fe80::1%eth0", "::ffff:1.2.3.4", "1::2::3", "12345::", "::1:53", "%eth0", "1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7", "1.2.3.4::"].map(ipVersion)).toEqual([4, 0, 0, 0, 6, 6, 6, 6, 6, 0, 0, 6, 0, 6, 0, 0]);
  });
  it("prints IPv6 in the BIND form c-ares and libuv share", () => {
    const print = (text: string): string => formatIPv6(parseIPv6(text) ?? new Uint8Array(16));
    expect(["2001:DB8::1", "2001:db8:0:0:1:0:0:ff", "::ffff:1.2.3.4", "::1", "::", "::1:53", "1:0:0:2:0:0:0:3", "1:2:3:4:5:6:7:0", "0:1:2:3:4:5:6:7", "fe80::1%eth0", "::1.2.3.4"].map(print))
      .toEqual(["2001:db8::1", "2001:db8::1:0:0:ff", "::ffff:1.2.3.4", "::1", "::", "::0.1.0.83", "1:0:0:2::3", "1:2:3:4:5:6:7:0", "0:1:2:3:4:5:6:7", "fe80::1", "::1.2.3.4"]);
  });
  it("names reverse lookups and reads inet_aton's short forms", () => {
    expect(reverseName(4, Uint8Array.of(1, 2, 3, 4))).toBe("4.3.2.1.in-addr.arpa");
    expect(reverseName(6, parseIPv6("2001:db8::1") ?? new Uint8Array(16))).toBe("1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa");
    expect(["1.2.3", "0x7f.1", "127.1", "010.0.0.1", "16909060", "1.2.3.256", "a.b", "1.2.3.4.5", "09.1.1.1"].map(text => { const bytes = parseLegacyIPv4(text); return bytes === undefined ? null : Array.from(bytes).join("."); }))
      .toEqual(["1.2.0.3", "127.0.0.1", "127.0.0.1", "8.0.0.1", "1.2.3.4", null, null, null, null]);
  });
});
