/*
 * The order `getaddrinfo` returns addresses in, as musl 1.2.5 computes it (src/network/lookup_name.c: the policy
 * table, `scopeof`, `prefixmatch` and the sort key are restated from it).
 * musl is Copyright © 2005-2020 Rich Felker, et al., and licensed under the MIT license:
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
 * Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
 * WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import { parseAddress } from "./node-dns-address.ts";

export interface SortableAddress { readonly address: string; readonly family: 4 | 6 }

interface Policy { readonly prefix: readonly number[]; readonly length: number; readonly mask: number; readonly precedence: number; readonly label: number }
/** RFC 6724's default policy table as musl keeps it: `length` whole bytes of `prefix`, then one byte under `mask`. */
const POLICIES: readonly Policy[] = [
  { prefix: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], length: 15, mask: 0xff, precedence: 50, label: 0 },
  { prefix: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], length: 11, mask: 0xff, precedence: 35, label: 4 },
  { prefix: [0x20, 0x02], length: 1, mask: 0xff, precedence: 30, label: 2 },
  { prefix: [0x20, 0x01], length: 3, mask: 0xff, precedence: 5, label: 5 },
  { prefix: [0xfc], length: 0, mask: 0xfe, precedence: 3, label: 13 },
];
/** The last rule matches every address. */
const LAST_POLICY: Policy = { prefix: [], length: 0, mask: 0, precedence: 40, label: 1 };

function policyOf(address: Uint8Array): Policy {
  for (const policy of POLICIES) {
    let same = true;
    for (let index = 0; index < policy.length && same; index += 1) same = (address[index] ?? 0) === (policy.prefix[index] ?? 0);
    if (same && ((address[policy.length] ?? 0) & policy.mask) === (policy.prefix[policy.length] ?? 0)) return policy;
  }
  return LAST_POLICY;
}

const isLoopback6 = (address: Uint8Array): boolean => address[15] === 1 && address.subarray(0, 15).every(byte => byte === 0);
function scopeOf(address: Uint8Array): number {
  const first = address[0] ?? 0, second = address[1] ?? 0;
  if (first === 0xff) return second & 15;
  if (first === 0xfe && (second & 0xc0) === 0x80) return 2;
  if (isLoopback6(address)) return 2;
  if (first === 0xfe && (second & 0xc0) === 0xc0) return 5;
  return 14;
}

/** The bits two addresses share from the left. */
function prefixMatch(source: Uint8Array, destination: Uint8Array): number {
  let bits = 0;
  while (bits < 128 && (((source[bits >> 3] ?? 0) ^ (destination[bits >> 3] ?? 0)) & (128 >> (bits & 7))) === 0) bits += 1;
  return bits;
}

const MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff] as const;
function mapped(four: Uint8Array): Uint8Array {
  const out = new Uint8Array(16);
  out.set(MAPPED_PREFIX); out.set(four.subarray(0, 4), 12);
  return out;
}
const isMapped = (address: Uint8Array): boolean => MAPPED_PREFIX.every((byte, index) => address[index] === byte);

/**
 * What musl learns by connecting a datagram socket of `family` to `destination` (16 bytes, IPv4 as `::ffff:a.b.c.d`)
 * and reading its local address back: that address in the same form, or undefined when the connect fails.
 */
export type AddressSources = (family: 4 | 6, destination: Uint8Array) => Uint8Array | undefined;

/**
 * A VM's answer. Measured in a relay-connected Userspace VM with the guest's Node: the VM's only interface
 * is the loopback, a connect to any other address succeeds, and the socket then reports the unspecified address of its
 * family (`0.0.0.0`, or `::` for an IPv6 socket, also for an IPv4-mapped destination). A loopback destination reports
 * the loopback address. An address a guest adds to an interface itself is not seen here.
 */
export const vmAddressSources: AddressSources = (family, destination) => {
  if (family === 4) return destination[12] === 127 ? mapped(Uint8Array.of(127, 0, 0, 1)) : mapped(new Uint8Array(4));
  if (isLoopback6(destination)) return destination;
  if (isMapped(destination) && destination[12] === 127) return mapped(Uint8Array.of(127, 0, 0, 1));
  return new Uint8Array(16);
};

const USABLE = 0x4000_0000, MATCHING_SCOPE = 0x2000_0000, MATCHING_LABEL = 0x1000_0000, MAX_ADDRESSES = 48;

/**
 * musl's destination address selection: one sort key per address from RFC 6724's rules 1 (usable), 2 (matching scope),
 * 5 (matching label), 6 (precedence), 8 (smaller scope) and 9 (longest matching prefix), then the order found. musl
 * leaves a list with fewer than two entries, or with IPv4 addresses only, as it is. In the VM every destination is
 * usable, so a global IPv6 address (precedence 40) comes before IPv4 (35), and `::1` (50) before everything.
 */
export function sortAddresses<Entry extends SortableAddress>(addresses: readonly Entry[], sources: AddressSources = vmAddressSources): Entry[] {
  if (addresses.length < 2 || addresses.every(entry => entry.family === 4)) return [...addresses];
  const keyed = addresses.slice(0, MAX_ADDRESSES).map((entry, index) => {
    const parsed = parseAddress(entry.address), bytes = parsed === undefined ? new Uint8Array(16) : parsed.family === 4 ? mapped(parsed.bytes) : parsed.bytes;
    const source = sources(entry.family, bytes), policy = policyOf(bytes), scope = scopeOf(bytes);
    let key = 0;
    if (source !== undefined) {
      key |= USABLE;
      if (scope === scopeOf(source)) key |= MATCHING_SCOPE;
      if (policy.label === policyOf(source).label) key |= MATCHING_LABEL;
      key |= prefixMatch(source, bytes) << 8;
    }
    key |= policy.precedence << 20;
    key |= (15 - scope) << 16;
    key |= MAX_ADDRESSES - index;
    return { entry, key };
  });
  return keyed.sort((left, right) => right.key - left.key).map(item => item.entry);
}
