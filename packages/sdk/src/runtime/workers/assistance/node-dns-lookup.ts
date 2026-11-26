import { formatIPv4, mappedIPv6, parseIPv4, parseLegacyIPv4 } from "./node-dns-address.ts";
import { HOSTS, hostsAddresses, libcChannelOptions, parseHosts, parseResolvConf, RESOLV_CONF, type ResolvConf } from "./node-dns-config.ts";
import { DnsFailure, UV_ERRNO } from "./node-dns-errors.ts";
import { DnsChannel, queryName, type DnsChannelRandom, type DnsTransport } from "./node-dns-resolver.ts";
import { sortAddresses, vmAddressSources, type AddressSources } from "./node-dns-sort.ts";
import { DnsNameError, nameLabels, RR_TYPE, type DnsMessage } from "./node-dns-wire.ts";

/**
 * `getaddrinfo` for `dns.lookup`, answered in the process instead of by a spawned Node: numeric forms, the VM's
 * `/etc/hosts`, then A and AAAA questions to the nameservers of its `/etc/resolv.conf` with its search list. Results
 * and error numbers follow musl, the guest's libc: recorded from Node 24.18.1 on musl in a container and, for the
 * order of addresses and the waits, from the guest's own Node inside a relay-connected VM (node-dns-lookup-vm.controls.json).
 */
export interface LookupAddress { readonly address: string; readonly family: 4 | 6 }
export interface LookupQuestion { readonly hostname: string; readonly family: 0 | 4 | 6; readonly hints: number }
export type LookupAnswer =
  | { readonly kind: "addresses"; readonly addresses: readonly LookupAddress[] }
  /** A libuv `EAI_*` number. */
  | { readonly kind: "error"; readonly errno: number }
  /** The VM's resolver configuration cannot be read here; the caller asks the guest's own Node. */
  | { readonly kind: "unavailable" };

export const LOOKUP_HINTS = { ADDRCONFIG: 32, V4MAPPED: 8, ALL: 16 } as const;
const LOOPBACK: readonly LookupAddress[] = [{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }];
/** libc asks at most three nameservers. */
const MAX_NAMESERVERS = 3;

/**
 * musl's `__lookup_name` after the addresses are found: a request for IPv6 with AI_V4MAPPED keeps the IPv6 addresses
 * alone when there are some (unless AI_ALL) and turns the IPv4 ones into `::ffff:a.b.c.d`; then the list is sorted,
 * except for a request for IPv4. Recorded in the VM: `multi.test` gives its AAAA address before its A addresses.
 */
function select(found: readonly LookupAddress[], question: LookupQuestion, sources: AddressSources): LookupAddress[] {
  if (question.family === 4) return found.filter(entry => entry.family === 4);
  let list = found;
  if (question.family === 6) {
    const six = found.filter(entry => entry.family === 6);
    if ((question.hints & LOOKUP_HINTS.V4MAPPED) === 0 || (six.length > 0 && (question.hints & LOOKUP_HINTS.ALL) === 0)) list = six;
    else list = found.map(entry => entry.family === 6 ? entry : { address: mappedIPv6(parseIPv4(entry.address) ?? new Uint8Array(4)), family: 6 as const });
  }
  return sortAddresses(list, sources);
}

/**
 * The full names to ask for, as musl's `name_from_dns_search` orders them: the name alone when it has `ndots` dots or
 * ends in one, else the search list first and then the name. (glibc also searches after a name with enough dots.)
 */
function candidates(name: string, conf: ResolvConf): string[] {
  const dots = name.split(".").length - 1;
  if (name.endsWith(".") || dots >= conf.ndots) return [name];
  return [...conf.search.map(domain => `${name}.${domain.replace(/\.$/u, "")}`), name];
}

type Round = { readonly kind: "found"; readonly addresses: LookupAddress[] } | { readonly kind: "no-name" | "no-data" | "again" };
/**
 * musl's `name_from_dns` over the replies in the order asked: a question without a reply is "try again" even when the
 * other family answered, and musl takes only NOERROR and NXDOMAIN for a reply (it keeps waiting after SERVFAIL, REFUSED
 * and the rest); NXDOMAIN is no such name. The AAAA reply is read before the A reply.
 */
function conclude(replies: readonly (DnsMessage | undefined)[]): Round {
  for (const reply of replies) {
    if (reply === undefined || (reply.rcode !== 0 && reply.rcode !== 3)) return { kind: "again" };
    if (reply.rcode === 3) return { kind: "no-name" };
  }
  const addresses: LookupAddress[] = [];
  for (const reply of [...replies].reverse()) for (const record of reply?.answers ?? []) {
    if (record.data.type === "A") addresses.push({ address: record.data.address, family: 4 });
    if (record.data.type === "AAAA") addresses.push({ address: record.data.address, family: 6 });
  }
  return addresses.length > 0 ? { kind: "found", addresses } : { kind: "no-data" };
}

export async function lookupAddresses(transport: DnsTransport, question: LookupQuestion, random?: DnsChannelRandom, sources: AddressSources = vmAddressSources): Promise<LookupAnswer> {
  const error = (errno: number): LookupAnswer => ({ kind: "error", errno });
  const answer = (found: readonly LookupAddress[]): LookupAnswer => {
    const addresses = select(found, question, sources);
    return addresses.length === 0 ? error(UV_ERRNO.EAI_NODATA) : { kind: "addresses", addresses };
  };
  // inet_aton's forms (`127.1`, `0x7f.1`) are addresses to getaddrinfo, though not to net.isIP.
  const legacy = parseLegacyIPv4(question.hostname);
  if (legacy !== undefined) return answer([{ address: formatIPv4(legacy), family: 4 }]);
  const name = queryName(question.hostname);
  try { nameLabels(name); } catch (failure) { if (failure instanceof DnsNameError) return error(UV_ERRNO.EAI_NONAME); throw failure; }
  if (!name.endsWith(".")) {
    // A name the hosts file knows is answered from it alone, also when it has no address of the family (musl).
    const hosts = hostsAddresses(parseHosts(transport.readFile(HOSTS) ?? ""), name);
    if (hosts.length > 0) return answer(hosts);
    // RFC 6761: localhost is the loopback even when the hosts file does not say so.
    if (name === "localhost") return answer(LOOPBACK);
  }
  const text = transport.readFile(RESOLV_CONF), conf = text === undefined ? undefined : parseResolvConf(text);
  if (conf === undefined || conf.nameservers.length === 0) return { kind: "unavailable" };
  const channel = new DnsChannel(transport, libcChannelOptions(conf), random);
  channel.servers = conf.nameservers.slice(0, MAX_NAMESERVERS);
  const types = question.family === 4 ? [RR_TYPE.A] : question.family === 6 && (question.hints & LOOKUP_HINTS.V4MAPPED) === 0 ? [RR_TYPE.AAAA] : [RR_TYPE.A, RR_TYPE.AAAA];
  for (const full of candidates(name, conf)) {
    const round = conclude(await Promise.all(types.map(type => channel.query(full, type).catch((failure: unknown) => {
      if (failure instanceof DnsFailure) return undefined;
      throw failure;
    }))));
    // musl ends the search at the first name that is not NXDOMAIN, whatever it answered.
    if (round.kind === "found") return answer(round.addresses);
    if (round.kind === "again") return error(UV_ERRNO.EAI_AGAIN);
    if (round.kind === "no-data") return error(UV_ERRNO.EAI_NODATA);
  }
  return error(UV_ERRNO.EAI_NONAME);
}

/** `dns.lookup`'s `order`: the resolver's own order, or one family first. */
export function ordered(addresses: readonly LookupAddress[], order: "verbatim" | "ipv4first" | "ipv6first"): LookupAddress[] {
  if (order === "verbatim") return [...addresses];
  const first = order === "ipv4first" ? 4 : 6;
  return [...addresses.filter(entry => entry.family === first), ...addresses.filter(entry => entry.family !== first)];
}
