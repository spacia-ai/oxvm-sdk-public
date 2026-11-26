import { PROTOCOL_VERSION } from "./common.ts";
import { USERSPACE_API_VERSION } from "../userspace-abi.js";
import { expect, it } from "vitest";
import { decodeNativeGraphVersion, NATIVE_LOGICAL_CHECKPOINT_VERSION, supportsNativeCheckpointVersion } from "./native-capture.js";

function graph(version: number): Uint8Array {
  const bytes = new Uint8Array(85);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, value: string) => bytes.set(new TextEncoder().encode(value), offset);
  tag(0, "OXUG"); view.setUint32(4, 1, true); view.setUint32(8, 2, true);
  view.setUint32(16, 49, true); tag(20, "OXWA"); view.setUint32(24, 1, true);
  view.setUint32(69, 1, true); view.setUint32(73, 8, true); tag(77, "OXUC");
  view.setUint16(81, version, true);
  return bytes;
}

it("admits native209 number demo state and retains affinity checkpoints", () => {
  expect(decodeNativeGraphVersion(graph(209))).toBe(209);
  expect(supportsNativeCheckpointVersion(209)).toBe(true);
});

it("admits current graph records and retains earlier native continuations", () => {
  expect(NATIVE_LOGICAL_CHECKPOINT_VERSION).toBe(1857);
  for (let version = 219; version <= NATIVE_LOGICAL_CHECKPOINT_VERSION; version += 1) {
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
  }
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("retains native218 bzip2 state", () => {
  expect(decodeNativeGraphVersion(graph(218))).toBe(218);
  expect(supportsNativeCheckpointVersion(218)).toBe(true);
});

it("retains native217 security status state", () => {
  expect(decodeNativeGraphVersion(graph(217))).toBe(217);
  expect(supportsNativeCheckpointVersion(217)).toBe(true);
});

it("retains native216 directory formatting state", () => {
  expect(decodeNativeGraphVersion(graph(216))).toBe(216);
  expect(supportsNativeCheckpointVersion(216)).toBe(true);
});

it("retains native215 ldd state", () => {
  expect(decodeNativeGraphVersion(graph(215))).toBe(215);
  expect(supportsNativeCheckpointVersion(215)).toBe(true);
});

it("retains native214 declaration state", () => {
  expect(decodeNativeGraphVersion(graph(214))).toBe(214);
  expect(supportsNativeCheckpointVersion(214)).toBe(true);
});

it("retains native213 join state", () => {
  expect(decodeNativeGraphVersion(graph(213))).toBe(213);
  expect(supportsNativeCheckpointVersion(213)).toBe(true);
});

it("retains native212 personality state", () => {
  expect(decodeNativeGraphVersion(graph(212))).toBe(212);
  expect(supportsNativeCheckpointVersion(212)).toBe(true);
});

it("retains native211 namespace state", () => {
  expect(decodeNativeGraphVersion(graph(211))).toBe(211);
  expect(supportsNativeCheckpointVersion(211)).toBe(true);
});

it("retains native210 I/O priority state", () => {
  expect(decodeNativeGraphVersion(graph(210))).toBe(210);
  expect(supportsNativeCheckpointVersion(210)).toBe(true);
});

it("admits native208 affinity state and retains pager checkpoints", () => {
  expect(decodeNativeGraphVersion(graph(208))).toBe(208);
  expect(decodeNativeGraphVersion(graph(207))).toBe(207);
  expect(supportsNativeCheckpointVersion(208)).toBe(true);
});

it("admits native207 pager state and retains example checkpoints", () => {
  expect(decodeNativeGraphVersion(graph(207))).toBe(207);
  expect(supportsNativeCheckpointVersion(207)).toBe(true);
});

it("admits native206 example commands and retains filesystem checkpoints", () => {
  expect(decodeNativeGraphVersion(graph(206))).toBe(206);
  expect(decodeNativeGraphVersion(graph(205))).toBe(205);
  expect(supportsNativeCheckpointVersion(206)).toBe(true);
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
});

it("admits native205 filesystem inspection and retains module checkpoints", () => {
  expect(decodeNativeGraphVersion(graph(205))).toBe(205);
  expect(decodeNativeGraphVersion(graph(204))).toBe(204);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native204 module inspection and retains install checkpoints", () => {
  expect(decodeNativeGraphVersion(graph(204))).toBe(204);
  expect(decodeNativeGraphVersion(graph(203))).toBe(203);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native203 install continuations and retains shred checkpoints", () => {
  expect(decodeNativeGraphVersion(graph(203))).toBe(203);
  expect(decodeNativeGraphVersion(graph(202))).toBe(202);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native202 shred continuations and retains scheduler checkpoints", () => {
  expect(decodeNativeGraphVersion(graph(202))).toBe(202);
  expect(decodeNativeGraphVersion(graph(201))).toBe(201);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native201 scheduler continuations and retains Unicode checkpoints", () => {
  expect(decodeNativeGraphVersion(graph(201))).toBe(201);
  expect(decodeNativeGraphVersion(graph(200))).toBe(200);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native200 Unicode continuations and retains dump checkpoints", () => {
  expect(decodeNativeGraphVersion(graph(200))).toBe(200);
  expect(decodeNativeGraphVersion(graph(199))).toBe(199);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native199 dump continuations and retains Csplit checkpoints", () => {
  expect(decodeNativeGraphVersion(graph(199))).toBe(199);
  expect(decodeNativeGraphVersion(graph(198))).toBe(198);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native198 Csplit continuations and retains Iconv checkpoints", () => {
  expect(decodeNativeGraphVersion(graph(198))).toBe(198);
  expect(decodeNativeGraphVersion(graph(197))).toBe(197);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native197 Iconv continuations and retains File checkpoints", () => {
  expect(decodeNativeGraphVersion(graph(197))).toBe(197);
  expect(decodeNativeGraphVersion(graph(196))).toBe(196);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native196 file continuations and retains Killall checkpoints", () => {
  expect(decodeNativeGraphVersion(graph(196))).toBe(196);
  expect(decodeNativeGraphVersion(graph(195))).toBe(195);
  expect(decodeNativeGraphVersion(graph(194))).toBe(194);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native194 pmap continuations and retains hostname checkpoints", () => {
  expect(decodeNativeGraphVersion(graph(194))).toBe(194);
  expect(decodeNativeGraphVersion(graph(193))).toBe(193);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native193 hostname continuations and retains earlier headers", () => {
  expect(decodeNativeGraphVersion(graph(193))).toBe(193);
  expect(decodeNativeGraphVersion(graph(192))).toBe(192);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native192 Find command continuations and retains earlier headers", () => {
  expect(decodeNativeGraphVersion(graph(192))).toBe(192);
  expect(decodeNativeGraphVersion(graph(191))).toBe(191);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native191 Find metadata format continuations and retains earlier headers", () => {
  expect(decodeNativeGraphVersion(graph(191))).toBe(191);
  expect(decodeNativeGraphVersion(graph(190))).toBe(190);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native190 Find inode and date operands and retains earlier headers", () => {
  expect(decodeNativeGraphVersion(graph(190))).toBe(190);
  expect(decodeNativeGraphVersion(graph(189))).toBe(189);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native189 Find account queries and retains earlier checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(189)).toBe(true);
  expect(decodeNativeGraphVersion(graph(189))).toBe(189);
  expect(decodeNativeGraphVersion(graph(188))).toBe(188);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native188 find continuations and retains sed checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(188)).toBe(true);
  expect(decodeNativeGraphVersion(graph(188))).toBe(188);
  expect(decodeNativeGraphVersion(graph(187))).toBe(187);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native187 sed continuations and retains arithmetic checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(187)).toBe(true);
  expect(decodeNativeGraphVersion(graph(187))).toBe(187);
  expect(decodeNativeGraphVersion(graph(186))).toBe(186);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native186 arithmetic text and retains compound-redirection checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(186)).toBe(true);
  expect(decodeNativeGraphVersion(graph(186))).toBe(186);
  expect(decodeNativeGraphVersion(graph(185))).toBe(185);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native185 compound redirections and retains arithmetic checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(185)).toBe(true);
  expect(decodeNativeGraphVersion(graph(185))).toBe(185);
  expect(decodeNativeGraphVersion(graph(184))).toBe(184);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native184 arithmetic expansion state and retains function checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(184)).toBe(true);
  expect(decodeNativeGraphVersion(graph(184))).toBe(184);
  expect(decodeNativeGraphVersion(graph(183))).toBe(183);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native183 compound function state and retains example checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(183)).toBe(true);
  expect(decodeNativeGraphVersion(graph(183))).toBe(183);
  expect(decodeNativeGraphVersion(graph(182))).toBe(182);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native182 example state and retains compound-shell checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(182)).toBe(true);
  expect(decodeNativeGraphVersion(graph(182))).toBe(182);
  expect(decodeNativeGraphVersion(graph(181))).toBe(181);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native181 compound-shell state and retains block-copy checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(181)).toBe(true);
  expect(decodeNativeGraphVersion(graph(181))).toBe(181);
  expect(decodeNativeGraphVersion(graph(180))).toBe(180);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native180 block-copy state and retains pipeline checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(180)).toBe(true);
  expect(decodeNativeGraphVersion(graph(180))).toBe(180);
  expect(decodeNativeGraphVersion(graph(179))).toBe(179);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native179 pipeline statuses and retains configuration-query checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(179)).toBe(true);
  expect(decodeNativeGraphVersion(graph(179))).toBe(179);
  expect(decodeNativeGraphVersion(graph(178))).toBe(178);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native178 configuration queries and retains xargs checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(178)).toBe(true);
  expect(decodeNativeGraphVersion(graph(178))).toBe(178);
  expect(decodeNativeGraphVersion(graph(177))).toBe(177);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native177 xargs continuations and retains timestamp checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(177)).toBe(true);
  expect(decodeNativeGraphVersion(graph(177))).toBe(177);
  expect(decodeNativeGraphVersion(graph(176))).toBe(176);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native176 timestamp continuations and retains Date checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(176)).toBe(true);
  expect(decodeNativeGraphVersion(graph(176))).toBe(176);
  expect(decodeNativeGraphVersion(graph(175))).toBe(175);
});

it("admits native175 Date continuations and rejects future or malformed versions", () => {
  expect(supportsNativeCheckpointVersion(175)).toBe(true);
  expect(decodeNativeGraphVersion(graph(175))).toBe(175);
  expect(decodeNativeGraphVersion(graph(174))).toBe(174);
  for (const version of [NATIVE_LOGICAL_CHECKPOINT_VERSION + 1, 0, -1, 176.5, 177.5, 178.5, 179.5, 180.5, 181.5, 182.5, 183.5, 184.5, 385.5, 386.5, Number.NaN, Infinity]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(false);
  }
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native174 terminal utility continuations and retains earlier checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(174)).toBe(true);
  expect(decodeNativeGraphVersion(graph(174))).toBe(174);
  expect(decodeNativeGraphVersion(graph(173))).toBe(173);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native173 BLAKE2b continuations and retains earlier checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(173)).toBe(true);
  expect(decodeNativeGraphVersion(graph(173))).toBe(173);
  expect(decodeNativeGraphVersion(graph(172))).toBe(172);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native172 timeout continuations and retains earlier checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(172)).toBe(true);
  expect(decodeNativeGraphVersion(graph(172))).toBe(172);
  expect(decodeNativeGraphVersion(graph(171))).toBe(171);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native171 streaming-shell continuations and retains earlier checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(171)).toBe(true);
  expect(decodeNativeGraphVersion(graph(171))).toBe(171);
  expect(decodeNativeGraphVersion(graph(170))).toBe(170);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native170 long-listing continuations and retains earlier checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(170)).toBe(true);
  expect(decodeNativeGraphVersion(graph(170))).toBe(170);
  expect(decodeNativeGraphVersion(graph(169))).toBe(169);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native169 cat option continuations and retains earlier checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(169)).toBe(true);
  expect(decodeNativeGraphVersion(graph(169))).toBe(169);
  expect(decodeNativeGraphVersion(graph(168))).toBe(168);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native168 topological-sort continuations and retains earlier checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(168)).toBe(true);
  expect(decodeNativeGraphVersion(graph(168))).toBe(168);
  expect(decodeNativeGraphVersion(graph(167))).toBe(167);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native167 multicall continuations and retains earlier checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(167)).toBe(true);
  expect(decodeNativeGraphVersion(graph(167))).toBe(167);
  expect(decodeNativeGraphVersion(graph(166))).toBe(166);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native166 SHA-3 continuations and retains earlier checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(166)).toBe(true);
  expect(decodeNativeGraphVersion(graph(166))).toBe(166);
  expect(decodeNativeGraphVersion(graph(165))).toBe(165);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native165 progress command continuations and retains earlier checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(165)).toBe(true);
  expect(decodeNativeGraphVersion(graph(165))).toBe(165);
  expect(decodeNativeGraphVersion(graph(164))).toBe(164);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native164 managed encoding continuations and retains earlier checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(164)).toBe(true);
  expect(decodeNativeGraphVersion(graph(164))).toBe(164);
  expect(decodeNativeGraphVersion(graph(163))).toBe(163);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native163 tree continuations and retains earlier checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(163)).toBe(true);
  expect(decodeNativeGraphVersion(graph(163))).toBe(163);
  expect(decodeNativeGraphVersion(graph(162))).toBe(162);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native124 readonly shell variables and retains earlier checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(124)).toBe(true);
  expect(decodeNativeGraphVersion(graph(124))).toBe(124);
  expect(decodeNativeGraphVersion(graph(123))).toBe(123);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native123 nohup continuations and preserves earlier graphs", () => {
  expect(supportsNativeCheckpointVersion(123)).toBe(true);
  expect(decodeNativeGraphVersion(graph(123))).toBe(123);
  expect(decodeNativeGraphVersion(graph(122))).toBe(122);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native122 command priority continuations and preserves earlier graphs", () => {
  expect(supportsNativeCheckpointVersion(122)).toBe(true);
  expect(decodeNativeGraphVersion(graph(122))).toBe(122);
  expect(decodeNativeGraphVersion(graph(121))).toBe(121);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native121 priority continuations and preserves earlier graphs", () => {
  expect(supportsNativeCheckpointVersion(121)).toBe(true);
  expect(decodeNativeGraphVersion(graph(121))).toBe(121);
  expect(decodeNativeGraphVersion(graph(120))).toBe(120);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native120 path attribute continuations and preserves earlier graphs", () => {
  expect(supportsNativeCheckpointVersion(120)).toBe(true);
  expect(decodeNativeGraphVersion(graph(120))).toBe(120);
  expect(decodeNativeGraphVersion(graph(119))).toBe(119);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native119 split continuations and rejects future graphs", () => {
  expect(supportsNativeCheckpointVersion(119)).toBe(true);
  expect(decodeNativeGraphVersion(graph(119))).toBe(119);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native118 ownership continuations and rejects future graphs", () => {
  expect(supportsNativeCheckpointVersion(118)).toBe(true);
  expect(decodeNativeGraphVersion(graph(118))).toBe(118);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native117 account and supplementary group continuations", () => {
  expect(supportsNativeCheckpointVersion(117)).toBe(true);
  expect(decodeNativeGraphVersion(graph(117))).toBe(117);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native116 shell increment continuations and rejects future versions", () => {
  expect(supportsNativeCheckpointVersion(116)).toBe(true);
  expect(decodeNativeGraphVersion(graph(116))).toBe(116);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native115 permission continuations and rejects future versions", () => {
  expect(supportsNativeCheckpointVersion(115)).toBe(true);
  expect(decodeNativeGraphVersion(graph(115))).toBe(115);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native114 link continuations and rejects future versions", () => {
  expect(supportsNativeCheckpointVersion(114)).toBe(true);
  expect(decodeNativeGraphVersion(graph(114))).toBe(114);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native113 file allocation continuations and rejects future versions", () => {
  expect(supportsNativeCheckpointVersion(113)).toBe(true);
  expect(decodeNativeGraphVersion(graph(113))).toBe(113);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native112 cut selections and rejects unknown checkpoint versions", () => {
  expect(supportsNativeCheckpointVersion(112)).toBe(true);
  expect(decodeNativeGraphVersion(graph(112))).toBe(112);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native111 expression state and rejects unknown checkpoint versions", () => {
  expect(supportsNativeCheckpointVersion(111)).toBe(true);
  expect(decodeNativeGraphVersion(graph(111))).toBe(111);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native110 backtick decoding and rejects unknown checkpoint versions", () => {
  expect(supportsNativeCheckpointVersion(110)).toBe(true);
  expect(decodeNativeGraphVersion(graph(110))).toBe(110);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native109 temporary-name continuations and rejects unknown versions", () => {
  expect(supportsNativeCheckpointVersion(109)).toBe(true);
  expect(decodeNativeGraphVersion(graph(109))).toBe(109);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native108 wrapping and refuses future checkpoint headers", () => {
  expect(supportsNativeCheckpointVersion(108)).toBe(true);
  expect(decodeNativeGraphVersion(graph(108))).toBe(108);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native106 column comparison and native107 numbering continuations", () => {
  for (const version of [106,107]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native105 adjacent-record continuations and retains older graphs", () => {
  expect(supportsNativeCheckpointVersion(105)).toBe(true);
  expect(decodeNativeGraphVersion(graph(105))).toBe(105);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native104 resumable sorting while retaining earlier records", () => {
  expect(supportsNativeCheckpointVersion(104)).toBe(true);
  expect(decodeNativeGraphVersion(graph(104))).toBe(104);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native103 procfs working-directory continuations", () => {
  expect(supportsNativeCheckpointVersion(103)).toBe(true);
  expect(decodeNativeGraphVersion(graph(103))).toBe(103);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits version 102 graph headers and rejects unknown versions", () => {
  expect(supportsNativeCheckpointVersion(102)).toBe(true);
  expect(decodeNativeGraphVersion(graph(102))).toBe(102);
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native94 identity start ticks while keeping native93 checkpoints readable", () => {
  for (const version of [93, 94]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits the combined native98 layout and retains both earlier source header versions", () => {
  for (const version of [94, 97, 98]) expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native100 terminal start columns while keeping native99 checkpoints readable", () => {
  for (const version of [99, 100]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits version 101 graph headers and preserves native100", () => {
  for (const version of [100, 101]) {
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native93 worker-limit cursors while retaining original native92 filter owners", () => {
  for (const version of [92, 93]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("preserves original exec generations with native92 while retaining native91", () => {
  for (const version of [91,92]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native87 final registered-region prefixes within the existing graph framing", () => {
  expect(decodeNativeGraphVersion(graph(87))).toBe(87);
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow();
});

it("admits native88 partial personality owners while retaining the 85-byte graph header", () => {
  expect(decodeNativeGraphVersion(graph(88))).toBe(88);
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow();
});

it("admits native89 original filter program prefixes and native90 task pools", () => {
  expect(decodeNativeGraphVersion(graph(89))).toBe(89);
  expect(supportsNativeCheckpointVersion(90)).toBe(true);
  expect(decodeNativeGraphVersion(graph(90))).toBe(90);
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow();
});

it("keeps historical checkpoint headers through cancellation version 42", () => {
  for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    const framed = new Uint8Array(100);
    framed.set(graph(version), 7);
    expect(decodeNativeGraphVersion(framed.subarray(7, 92))).toBe(version);
  }
  for (const version of [0, NATIVE_LOGICAL_CHECKPOINT_VERSION + 1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(false);
  }
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("retains native74/75 ownership and admits native76 caller continuations", () => {
  expect(supportsNativeCheckpointVersion(74)).toBe(true);
  expect(decodeNativeGraphVersion(graph(74))).toBe(74);
  expect(supportsNativeCheckpointVersion(75)).toBe(true);
  expect(decodeNativeGraphVersion(graph(75))).toBe(75);
  expect(supportsNativeCheckpointVersion(76)).toBe(true);
  expect(decodeNativeGraphVersion(graph(76))).toBe(76);
  expect(supportsNativeCheckpointVersion(77)).toBe(true);
  expect(decodeNativeGraphVersion(graph(77))).toBe(77);
  expect(supportsNativeCheckpointVersion(78)).toBe(true);
  expect(decodeNativeGraphVersion(graph(78))).toBe(78);
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});


it("admits prepared file-operation version 43 and durability continuation version 44", () => {
  expect(supportsNativeCheckpointVersion(43)).toBe(true);
  expect(decodeNativeGraphVersion(graph(43))).toBe(43);
  expect(supportsNativeCheckpointVersion(44)).toBe(true);
  expect(decodeNativeGraphVersion(graph(44))).toBe(44);
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits mapping advice checkpoint 45 and refuses future headers", () => {
  expect(supportsNativeCheckpointVersion(45)).toBe(true);
  expect(decodeNativeGraphVersion(graph(45))).toBe(45);
});

it("admits VMA policy checkpoint 46 and refuses future headers", () => {
  expect(supportsNativeCheckpointVersion(46)).toBe(true);
  expect(decodeNativeGraphVersion(graph(46))).toBe(46);
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
});

it("admits resumable population checkpoint 47", () => {
  expect(supportsNativeCheckpointVersion(47)).toBe(true);
  expect(decodeNativeGraphVersion(graph(47))).toBe(47);
});

it("admits classic provided buffers and removal cursors in checkpoint 48", () => {
  expect(supportsNativeCheckpointVersion(48)).toBe(true);
  expect(decodeNativeGraphVersion(graph(48))).toBe(48);
});

it("admits selected READ entries and retained completion flags in checkpoint 49", () => {
  expect(supportsNativeCheckpointVersion(49)).toBe(true);
  expect(decodeNativeGraphVersion(graph(49))).toBe(49);
});

it("admits full selected READV headers in checkpoint 50", () => {
  expect(supportsNativeCheckpointVersion(50)).toBe(true);
  expect(decodeNativeGraphVersion(graph(50))).toBe(50);
});

it("admits retained pollable reads in checkpoint 51 and refuses future headers", () => {
  expect(supportsNativeCheckpointVersion(51)).toBe(true);
  expect(decodeNativeGraphVersion(graph(51))).toBe(51);
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits pending counter, timer and inotify reads in checkpoint 52", () => {
  expect(supportsNativeCheckpointVersion(52)).toBe(true);
  expect(decodeNativeGraphVersion(graph(52))).toBe(52);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits attached setup state in checkpoint 53", () => {
  expect(supportsNativeCheckpointVersion(53)).toBe(true);
  expect(decodeNativeGraphVersion(graph(53))).toBe(53);
});

it("admits completed task work in checkpoint 54", () => {
  expect(supportsNativeCheckpointVersion(54)).toBe(true);
  expect(decodeNativeGraphVersion(graph(54))).toBe(54);
});

it("admits issuer-owned readiness reissue in checkpoint 55", () => {
  expect(supportsNativeCheckpointVersion(55)).toBe(true);
  expect(decodeNativeGraphVersion(graph(55))).toBe(55);
});

it("admits prepared exec cleanup in checkpoint 56", () => {
  expect(supportsNativeCheckpointVersion(56)).toBe(true);
  expect(decodeNativeGraphVersion(graph(56))).toBe(56);
});

it("admits committed exec failure checkpoint 60 while retaining native59 headers", () => {
  for (const version of [59, 60]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
});

it("admits bounded query native61 headers and rejects the next unknown version", () => {
  expect(supportsNativeCheckpointVersion(61)).toBe(true);
  expect(decodeNativeGraphVersion(graph(61))).toBe(61);
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow();
});

it("admits selected fixed-buffer native63 headers and retains native61/62 compatibility", () => {
  for (const version of [61, 62, 63]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits tagged fixed-buffer native64 headers and rejects unknown future headers", () => {
  expect(supportsNativeCheckpointVersion(64)).toBe(true);
  expect(decodeNativeGraphVersion(graph(64))).toBe(64);
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});


it("preserves native94 combined resource records with the current worker", () => {
  expect(PROTOCOL_VERSION).toBe(187);
  expect(decodeNativeGraphVersion(graph(94))).toBe(94);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits retained TCP urgent marks in native95 and rejects newer socket graphs", () => {
  expect(PROTOCOL_VERSION).toBe(187);
  expect(decodeNativeGraphVersion(graph(95))).toBe(95);
  expect(decodeNativeGraphVersion(graph(94))).toBe(94);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits captured urgent notifications in native96 and rejects newer graphs", () => {
  expect(USERSPACE_API_VERSION).toBe(154);
  expect(PROTOCOL_VERSION).toBe(187);
  expect(decodeNativeGraphVersion(graph(96))).toBe(96);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("pairs retained urgent-pointer announcements with native97 and rejects future peers", () => {
  expect(USERSPACE_API_VERSION).toBe(154);
  expect(PROTOCOL_VERSION).toBe(187);
  expect(decodeNativeGraphVersion(graph(97))).toBe(97);
  expect(decodeNativeGraphVersion(graph(96))).toBe(96);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native99 coarse-clock policy and retains native98 snapshots", () => {
  for (const version of [97, 98, 99]) {
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native125 bounded sequence continuations and preserves older headers", () => {
  expect(supportsNativeCheckpointVersion(125)).toBe(true);
  expect(decodeNativeGraphVersion(graph(125))).toBe(125);
  expect(decodeNativeGraphVersion(graph(124))).toBe(124);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits xxd continuation version 126 and rejects newer records", () => {
  expect(supportsNativeCheckpointVersion(126)).toBe(true);
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(decodeNativeGraphVersion(graph(126))).toBe(126);
});

it("admits UU codec continuations in native127 and rejects future records", () => {
  expect(decodeNativeGraphVersion(graph(127))).toBe(127);
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
});

it("admits od dump continuations in native128 and rejects future records", () => {
  expect(decodeNativeGraphVersion(graph(128))).toBe(128);
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
});

it("admits native129 timed children and rejects future records", () => {
  expect(decodeNativeGraphVersion(graph(129))).toBe(129);
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
});


it("admits native130 shell resource-limit continuations and keeps earlier headers", () => {
  expect(decodeNativeGraphVersion(graph(130))).toBe(130);
  expect(decodeNativeGraphVersion(graph(129))).toBe(129);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});


it("admits native131 external process-limit continuations and preserves earlier headers", () => {
  expect(decodeNativeGraphVersion(graph(131))).toBe(131);
  expect(decodeNativeGraphVersion(graph(130))).toBe(130);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native132 sum continuations and rejects future headers", () => {
  expect(decodeNativeGraphVersion(graph(132))).toBe(132);
  expect(decodeNativeGraphVersion(graph(131))).toBe(131);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native133 tab-conversion continuations and rejects future headers", () => {
  expect(decodeNativeGraphVersion(graph(133))).toBe(133);
  expect(decodeNativeGraphVersion(graph(132))).toBe(132);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});


it("admits native134 device limitation continuations and rejects newer headers", () => {
  for (const version of [132, 133, 134]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native135 gzip codec continuations and retains older process graphs", () => {
  for (const version of [133, 134, 135]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});


it("admits native136 tar continuations while retaining native135 gzip state", () => {
  for (const version of [135, 136]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native137 tar account metadata with older native graphs", () => {
  for (const version of [135, 136, 137]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native138 deferred tar directory timestamps and retains older graphs", () => {
  for (const version of [136, 137, 138]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native139 stat metadata and timezone continuations with older graphs", () => {
  for (const version of [1, 135, 136, 137, 138, 139]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native140 exec options and keeps stat checkpoints readable", () => {
  for (const version of [138, 139, 140]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native141 mountpoint continuations and keeps exec checkpoints readable", () => {
  for (const version of [139, 140, 141]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native142 newline conversion and retains older process graphs", () => {
  for (const version of [1, 139, 140, 141, 142]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native143 factor continuations and retains older process graphs", () => {
  for (const version of [1, 140, 141, 142, 143]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native144 setsid continuations and retains older process graphs", () => {
  for (const version of [1, 140, 141, 142, 143, 144]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native145 chroot continuations and retains older process graphs", () => {
  for (const version of [1, 141, 142, 143, 144, 145]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native146 flock continuations and retains older process graphs", () => {
  for (const version of [1, 142, 143, 144, 145, 146]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native147 readahead continuations and retains older process graphs", () => {
  for (const version of [1, 143, 144, 145, 146, 147]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native148 timestamp continuations and retains older process graphs", () => {
  for (const version of [1, 143, 144, 145, 146, 147, 148]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});


it("admits native149 shuffle continuations and retains older process graphs", () => {
  for (const version of [1, 144, 145, 146, 147, 148, 149]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native150 login-message continuations and retains earlier graphs", () => {
  for (const version of [1, 145, 146, 147, 148, 149, 150]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native151 process-name lookup and retains earlier graphs", () => {
  for (const version of [1, 147, 148, 149, 150, 151]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native152 bounded shell control and rejects future graphs", () => {
  for (const version of [1, 148, 149, 150, 151, 152]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native153 memory-reporting commands and retains earlier graphs", () => {
  for (const version of [1, 149, 150, 151, 152, 153]) {
    expect(supportsNativeCheckpointVersion(version)).toBe(true);
    expect(decodeNativeGraphVersion(graph(version))).toBe(version);
  }
  expect(supportsNativeCheckpointVersion(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1)).toBe(false);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native154 uptime continuations and preserves memory reports", () => {
  expect(supportsNativeCheckpointVersion(154)).toBe(true);
  expect(decodeNativeGraphVersion(graph(154))).toBe(154);
  expect(decodeNativeGraphVersion(graph(153))).toBe(153);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native155 calendar continuations and retains uptime graphs", () => {
  expect(supportsNativeCheckpointVersion(155)).toBe(true);
  expect(decodeNativeGraphVersion(graph(155))).toBe(155);
  expect(decodeNativeGraphVersion(graph(154))).toBe(154);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native156 paragraph formatter continuations and retains calendar graphs", () => {
  expect(supportsNativeCheckpointVersion(156)).toBe(true);
  expect(decodeNativeGraphVersion(graph(156))).toBe(156);
  expect(decodeNativeGraphVersion(graph(155))).toBe(155);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native157 managed Unicode widths and rejects future graph layouts", () => {
  expect(supportsNativeCheckpointVersion(157)).toBe(true);
  expect(decodeNativeGraphVersion(graph(157))).toBe(157);
  expect(decodeNativeGraphVersion(graph(156))).toBe(156);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native158 shell alias state and retains earlier graph headers", () => {
  expect(supportsNativeCheckpointVersion(158)).toBe(true);
  expect(decodeNativeGraphVersion(graph(158))).toBe(158);
  expect(decodeNativeGraphVersion(graph(157))).toBe(157);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native159 path validation state without accepting future graph layouts", () => {
  expect(supportsNativeCheckpointVersion(159)).toBe(true);
  expect(decodeNativeGraphVersion(graph(159))).toBe(159);
  expect(decodeNativeGraphVersion(graph(158))).toBe(158);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native160 disk traversal state and rejects later layouts", () => {
  expect(supportsNativeCheckpointVersion(160)).toBe(true);
  expect(decodeNativeGraphVersion(graph(160))).toBe(160);
  expect(decodeNativeGraphVersion(graph(159))).toBe(159);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});

it("admits native161 shell completion state and preserves earlier headers", () => {
  expect(supportsNativeCheckpointVersion(161)).toBe(true);
  expect(decodeNativeGraphVersion(graph(161))).toBe(161);
  expect(decodeNativeGraphVersion(graph(160))).toBe(160);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});


it("admits native162 help continuations and rejects later layouts", () => {
  expect(supportsNativeCheckpointVersion(162)).toBe(true);
  expect(decodeNativeGraphVersion(graph(162))).toBe(162);
  expect(decodeNativeGraphVersion(graph(161))).toBe(161);
  expect(() => decodeNativeGraphVersion(graph(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).toThrow(/header is invalid/u);
});
