import { describe, expect, it } from "vitest";
import {
  Asn1Error, DerReader, TAG, contextTag, der, derBitString, derExplicit, derImplicit, derInteger, derIntegerBytes, derNull, derOctetString, derOid,
  derPrintableString, derSequence, derSet, derUtf8String, integerFromBytes, readDer, unsignedFromBytes, unsignedToBytes,
} from "./node-crypto-asn1.js";

function hex(value: Uint8Array): string { return Array.from(value, byte => byte.toString(16).padStart(2, "0")).join(""); }
function bytes(text: string): Uint8Array { return Uint8Array.from(text.match(/../gu) ?? [], pair => Number.parseInt(pair, 16)); }

describe("DER writer", () => {
  it("writes INTEGERs minimally in two's complement", () => {
    const expected: [bigint, string][] = [[0n, "020100"], [1n, "020101"], [127n, "02017f"], [128n, "02020080"], [255n, "020200ff"], [256n, "02020100"], [65537n, "0203010001"],
      [-1n, "0201ff"], [-128n, "020180"], [-129n, "0202ff7f"], [-256n, "0202ff00"], [-32768n, "02028000"]];
    for (const [value, encoding] of expected) {
      expect(hex(derInteger(value))).toBe(encoding);
      expect(new DerReader(bytes(encoding)).integer()).toBe(value);
    }
    expect(hex(derIntegerBytes(bytes("00ff")))).toBe("020200ff");
  });
  it("writes minimal definite lengths", () => {
    expect(hex(der(TAG.octetString, new Uint8Array(127))).slice(0, 4)).toBe("047f");
    expect(hex(der(TAG.octetString, new Uint8Array(128))).slice(0, 6)).toBe("048180");
    expect(hex(der(TAG.octetString, new Uint8Array(255))).slice(0, 6)).toBe("0481ff");
    expect(hex(der(TAG.octetString, new Uint8Array(256))).slice(0, 8)).toBe("04820100");
    expect(hex(der(TAG.octetString, new Uint8Array(65536))).slice(0, 10)).toBe("0483010000");
  });
  it("writes object identifiers, strings, NULL, BIT STRING and tagged values", () => {
    expect(hex(derOid("1.2.840.113549.1.1.1"))).toBe("06092a864886f70d010101");
    expect(hex(derOid("1.3.101.112"))).toBe("06032b6570");
    expect(hex(derOid("2.16.840.1.101.3.4.2.1"))).toBe("0609608648016503040201");
    expect(hex(derOid("2.999.3"))).toBe("0603883703");
    expect(() => derOid("3.1")).toThrow(RangeError);
    expect(() => derOid("1.40")).toThrow(RangeError);
    expect(() => derOid("1.x")).toThrow(RangeError);
    expect(hex(derNull())).toBe("0500");
    expect(hex(derBitString(bytes("0102")))).toBe("0303000102");
    expect(hex(derOctetString(bytes("0102")))).toBe("04020102");
    expect(hex(derUtf8String("é"))).toBe("0c02c3a9");
    expect(hex(derPrintableString("Example CA"))).toBe("130a4578616d706c65204341");
    expect(() => derPrintableString("a@b")).toThrow(RangeError);
    expect(hex(derExplicit(0, derInteger(2n)))).toBe("a003020102");
    expect(hex(derImplicit(1, bytes("0102")))).toBe("81020102");
    expect(hex(derImplicit(1, derInteger(2n), true))).toBe("a103020102");
    expect(hex(derSequence(derInteger(1n), derSet(derNull())))).toBe("300702010131020500");
    expect(contextTag(2)).toBe(0xa2);
    expect(contextTag(2, false)).toBe(0x82);
  });
});

describe("DER reader", () => {
  it("reads what the writer writes", () => {
    const reader = readDer(derSequence(derInteger(-5n), derOid("1.2.840.10045.3.1.7"), derBitString(bytes("04aa")), derOctetString(bytes("bb")), derNull(),
      derExplicit(0, derInteger(7n)), derImplicit(1, bytes("cc")), derUtf8String("ü"), derPrintableString("ok"), derSet(derInteger(1n)), derExplicit(3, derNull())));
    expect(reader.depth).toBe(1);
    expect(reader.integer()).toBe(-5n);
    expect(reader.oid()).toBe("1.2.840.10045.3.1.7");
    expect(hex(reader.bitString())).toBe("04aa");
    expect(hex(reader.octetString())).toBe("bb");
    reader.null();
    expect(reader.optionalExplicit(5)).toBeUndefined();
    expect(reader.explicit(0).smallInteger()).toBe(7);
    expect(hex(reader.implicit(1))).toBe("cc");
    expect(reader.utf8String()).toBe("ü");
    expect(reader.printableString()).toBe("ok");
    expect(reader.set().integer()).toBe(1n);
    expect(reader.optional(TAG.integer)).toBeUndefined();
    expect(reader.peekTag()).toBe(0xa3);
    expect(hex(reader.read().raw)).toBe("a3020500");
    expect(reader.atEnd).toBe(true);
    reader.end();
    expect(readDer(bytes("0603883703"), TAG.oid).atEnd).toBe(false);
    expect(new DerReader(bytes("0603883703")).oid()).toBe("2.999.3");
  });
  it("refuses non-minimal and indefinite lengths, trailing bytes and malformed values", () => {
    const refused = (encoding: string, reason: string, read: (reader: DerReader) => unknown = reader => reader.read()): void => {
      expect(() => read(new DerReader(bytes(encoding)))).toThrow(expect.objectContaining({ name: "Asn1Error", reason }));
    };
    refused("04810100", "invalid");             // 1 as a long-form length
    refused("0482007f" + "00".repeat(127), "invalid"); // leading zero length byte
    refused("048000", "invalid");               // indefinite
    refused("1f0100", "invalid");               // multi-byte tag
    refused("0485ffffffffff", "too-long");      // five length bytes
    refused("0403aabb", "too-long");            // value past the end
    refused("04", "not-enough-data");
    refused("0482", "not-enough-data");
    refused("", "not-enough-data");
    refused("0200", "invalid", reader => reader.integer());
    refused("02020001", "invalid", reader => reader.integer());
    refused("0202ff80", "invalid", reader => reader.integer());
    refused("0201ff", "invalid", reader => reader.smallInteger());
    refused("03020100", "invalid", reader => reader.bitString());
    refused("0300", "invalid", reader => reader.bitString());
    refused("050100", "invalid", reader => { reader.null(); });
    refused("0600", "invalid", reader => reader.oid());
    refused("06028001", "invalid", reader => reader.oid());
    refused("060181", "invalid", reader => reader.oid());
    refused("0c01ff", "invalid", reader => reader.utf8String());
    refused("020101", "wrong-tag", reader => reader.sequence());
    expect(() => readDer(bytes("3003020101" + "00"))).toThrow(/trailing bytes/u);
    expect(() => { const reader = readDer(bytes("3006020101020102")); reader.integer(); reader.end(); }).toThrow(/trailing bytes/u);
  });
  it("reports how deep a failure is", () => {
    const depthOf = (work: () => unknown): number => {
      try { work(); }
      catch (error) { if (error instanceof Asn1Error) return error.depth; }
      return -1;
    };
    expect(depthOf(() => readDer(bytes("020101")))).toBe(0);
    expect(depthOf(() => readDer(bytes("3003020101")).sequence())).toBe(1);
    expect(depthOf(() => readDer(bytes("30053003020101")).sequence().oid())).toBe(2);
  });
  it("converts integers to and from bytes", () => {
    expect(integerFromBytes(bytes("ff"))).toBe(-1n);
    expect(integerFromBytes(bytes("00ff"))).toBe(255n);
    expect(unsignedFromBytes(bytes("ff00"))).toBe(65280n);
    expect(hex(unsignedToBytes(0n))).toBe("00");
    expect(hex(unsignedToBytes(255n))).toBe("ff");
    expect(hex(unsignedToBytes(1n, 4))).toBe("00000001");
    expect(hex(unsignedToBytes(0n, 2))).toBe("0000");
    expect(() => unsignedToBytes(65536n, 2)).toThrow(RangeError);
    expect(() => unsignedToBytes(-1n)).toThrow(RangeError);
  });
});
