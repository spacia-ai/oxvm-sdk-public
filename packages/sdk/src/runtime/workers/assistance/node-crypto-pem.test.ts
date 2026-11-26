import { describe, expect, it } from "vitest";
import { base64Decode, base64Encode, pemBlocks, pemDecode, pemEncode } from "./node-crypto-pem.js";

const body = Uint8Array.from({ length: 100 }, (_, index) => (index * 37 + 11) & 0xff);
// What Buffer.from(body).toString('base64') gives in Node.js v24.18.1.
const encoded = "CzBVep/E6Q4zWH2ix+wRNluApcrvFDleg6jN8hc8YYar0PUaP2SJrtP4HUJnjLHW+yBFao+02f4jSG2St9wBJktwlbrfBClOc5i94gcsUXabwOUKL1R5nsPoDTJXfKHG6xA1Wg==";

describe("base64", () => {
  it("encodes with and without padding", () => {
    const cases: [number[], string, string][] = [[[], "", ""], [[0xfb], "+w==", "-w"], [[0xfb, 0xff], "+/8=", "-_8"], [[0xfb, 0xff, 0xbf], "+/+/", "-_-_"]];
    for (const [input, standard, url] of cases) {
      expect(base64Encode(Uint8Array.from(input))).toBe(standard);
      expect(base64Encode(Uint8Array.from(input), true)).toBe(url);
      expect(base64Decode(standard, true)).toEqual(Uint8Array.from(input));
      expect(base64Decode(url)).toEqual(Uint8Array.from(input));
      expect(base64Decode(standard)).toEqual(Uint8Array.from(input));
    }
    expect(base64Encode(body)).toBe(encoded);
  });
  it("decodes leniently for JWK members and strictly for PEM bodies", () => {
    expect(base64Decode("-w=\n=")).toEqual(Uint8Array.of(0xfb));
    expect(base64Decode("+w!!")).toEqual(Uint8Array.of(0xfb));
    expect(base64Decode("+")).toEqual(new Uint8Array());
    for (const refused of ["-w==", "+w=", "+w", "+w===", "+", "!!!!", "+w==+w=="]) expect(base64Decode(refused, true)).toBeUndefined();
  });
});

describe("PEM", () => {
  const pem = pemEncode("PUBLIC KEY", body);
  it("writes 64-column lines as OpenSSL does", () => {
    expect(pem).toBe(`-----BEGIN PUBLIC KEY-----\n${encoded.slice(0, 64)}\n${encoded.slice(64, 128)}\n${encoded.slice(128)}\n-----END PUBLIC KEY-----\n`);
    expect(pemEncode("X", new Uint8Array(48)).split("\n")).toHaveLength(4);
    expect(pemEncode("EC PRIVATE KEY", Uint8Array.of(1), [{ name: "Proc-Type", value: "4,ENCRYPTED" }, { name: "DEK-Info", value: "AES-128-CBC,00" }]))
      .toBe("-----BEGIN EC PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00\n\nAQ==\n-----END EC PRIVATE KEY-----\n");
  });
  it("reads what OpenSSL reads: surrounding text, CRLF, trailing blanks, long lines, headers, several blocks", () => {
    expect(pemDecode(pem)).toEqual({ label: "PUBLIC KEY", headers: [], body });
    expect(pemDecode(`junk\n\n${pem.replace(/\n/gu, "\r\n")}more junk`)?.body).toEqual(body);
    expect(pemDecode(pem.split("\n").map(line => `${line} \t`).join("\n"))?.body).toEqual(body);
    expect(pemDecode(pem.trimEnd())?.body).toEqual(body);
    expect(pemDecode(`-----BEGIN PUBLIC KEY-----\n${encoded}\n-----END PUBLIC KEY-----`)?.body).toEqual(body);
    const encrypted = pemDecode("-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,AABB\n\nAQID\n-----END RSA PRIVATE KEY-----\n");
    expect(encrypted).toEqual({ label: "RSA PRIVATE KEY", headers: [{ name: "Proc-Type", value: "4,ENCRYPTED" }, { name: "DEK-Info", value: "AES-256-CBC,AABB" }], body: Uint8Array.of(1, 2, 3) });
    const both = pemEncode("CERTIFICATE", Uint8Array.of(9)) + pem;
    expect(pemBlocks(both).map(block => block.label)).toEqual(["CERTIFICATE", "PUBLIC KEY"]);
    expect(pemDecode(both, "PUBLIC KEY")?.body).toEqual(body);
    expect(pemDecode(both, "PRIVATE KEY", "RSA PRIVATE KEY")).toBeUndefined();
  });
  it("refuses what OpenSSL refuses: indented or mismatched boundary lines, a missing end, a body that is not base64", () => {
    expect(pemDecode(pem.split("\n").map(line => `  ${line}`).join("\n"))).toBeUndefined();
    expect(pemDecode(pem.replace("END PUBLIC", "END PRIVATE"))).toBeUndefined();
    expect(pemDecode(pem.replace(/-----END.*\n/u, ""))).toBeUndefined();
    expect(pemDecode("-----BEGIN PUBLIC KEY-----\n!!!!\n-----END PUBLIC KEY-----\n")).toBeUndefined();
    expect(pemDecode("-----BEGIN PUBLIC KEY-----\nAQI\n-----END PUBLIC KEY-----\n")).toBeUndefined();
    expect(pemDecode("")).toBeUndefined();
    // Reading stops at a malformed block; the blocks before it stand.
    expect(pemBlocks(`${pem}-----BEGIN X-----\n!!!!\n-----END X-----\n${pem}`)).toHaveLength(1);
  });
});
