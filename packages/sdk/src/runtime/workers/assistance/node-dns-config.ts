import { formatAddress, ipVersion, parseAddress } from "./node-dns-address.ts";
import { invalidIpAddress } from "./node-dns-errors.ts";
import { invalidInstance, validateString } from "./node-util-validators.ts";

/** One nameserver: a numeric address, without an IPv6 zone, and its port. */
export interface DnsServer { readonly address: string; readonly family: 4 | 6; readonly port: number }

export const DNS_PORT = 53;
export const RESOLV_CONF = "/etc/resolv.conf", HOSTS = "/etc/hosts", SERVICES = "/etc/services";

function server(text: string, port: number): DnsServer | undefined {
  const parsed = parseAddress(text);
  // inet_ntop's text: lower case, compressed, no zone.
  return parsed === undefined ? undefined : { address: formatAddress(parsed.family, parsed.bytes), family: parsed.family, port };
}

/** What a resolver takes from `/etc/resolv.conf`. */
export interface ResolvConf {
  readonly nameservers: readonly DnsServer[];
  readonly search: readonly string[];
  readonly ndots: number;
  /** Seconds per attempt (`options timeout:n`), for `getaddrinfo`. */
  readonly timeout: number;
  readonly attempts: number;
}

const bounded = (value: string | undefined, low: number, high: number, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) ? Math.min(high, Math.max(low, parsed)) : fallback;
};

/**
 * `/etc/resolv.conf` as c-ares reads it for Node (recorded from Node 24.18.1): every `nameserver` line with a numeric
 * address, which may carry a port (`1.2.3.4:54`, `[::1]:5353`); `#` and `;` start a comment. `search`, `domain` and
 * `options` serve `dns.lookup` only: Node's `resolve*` functions ask for the name as given.
 */
export function parseResolvConf(text: string): ResolvConf {
  const nameservers: DnsServer[] = [];
  let search: readonly string[] = [], ndots = 1, timeout = 5, attempts = 2;
  for (const raw of text.split("\n")) {
    const [keyword, ...rest] = raw.replace(/[#;].*$/u, "").trim().split(/\s+/u);
    if (keyword === "nameserver" && rest[0] !== undefined) {
      const parsed = serverFromText(rest[0]);
      if (parsed !== undefined) nameservers.push(parsed);
    } else if (keyword === "search") search = rest.filter(domain => domain !== "").slice(0, 6);
    else if (keyword === "domain" && rest[0] !== undefined) search = [rest[0]];
    else if (keyword === "options") for (const option of rest) {
      const [name, value] = option.split(":");
      if (name === "ndots") ndots = bounded(value, 0, 15, ndots);
      if (name === "timeout") timeout = bounded(value, 1, 30, timeout);
      if (name === "attempts") attempts = bounded(value, 1, 5, attempts);
    }
  }
  return { nameservers, search, ndots, timeout, attempts };
}

/**
 * How libc's resolver (`getaddrinfo`, `getnameinfo`) waits, as channel options. In musl `options timeout:n` is the
 * whole wait for a question and `attempts:m` the number of times it is sent within it, one every n/m seconds; measured
 * in the VM with the default 5 s and 2 attempts: a name nobody answers fails after 5 s, not 10.
 */
export function libcChannelOptions(conf: ResolvConf): { readonly timeout: number; readonly tries: number; readonly maxTimeout: number } {
  const each = Math.floor(conf.timeout * 1000 / conf.attempts);
  return { timeout: each, tries: conf.attempts, maxTimeout: each };
}

/** `address`, `address:port` or `[address]:port`; undefined for anything else. */
function serverFromText(text: string): DnsServer | undefined {
  const bracketed = /^\[([^[\]]*)\](?::(\d+))?$/u.exec(text);
  if (bracketed !== null) return server(bracketed[1] ?? "", port(bracketed[2]));
  const whole = server(text, DNS_PORT);
  if (whole !== undefined) return whole;
  const split = /^(.+?):(\d+)$/u.exec(text);
  return split === null ? undefined : server(split[1] ?? "", port(split[2]));
}
/** The native layer keeps a port's low 16 bits; none, or zero, is the DNS port. */
function port(digits: string | undefined): number {
  const value = digits === undefined ? 0 : Number(BigInt(digits) & 0xffffn);
  return value === 0 ? DNS_PORT : value;
}

/**
 * `resolver.setServers()`'s argument (Node lib/internal/dns/utils.js): each entry is an address, a bracketed IPv6
 * address with an optional port, or `address:port`. The first entry that is none of these is ERR_INVALID_IP_ADDRESS.
 */
export function parseServerList(servers: unknown): DnsServer[] {
  if (!Array.isArray(servers)) throw invalidInstance("servers", "Array", servers);
  return servers.map((entry: unknown, index) => {
    validateString(entry, `servers[${String(index)}]`);
    if (ipVersion(entry) !== 0) return server(entry, DNS_PORT) ?? fail(entry);
    const bracketed = /^\[([^[\]]*)\]/u.exec(entry);
    if (bracketed !== null && ipVersion(bracketed[1] ?? "") !== 0) {
      // Node reads the digits that end the entry, whatever stands before them.
      return server(bracketed[1] ?? "", port(/:(\d+)$/u.exec(entry)?.[1])) ?? fail(entry);
    }
    const split = /^(.+?)(?::(\d+))?$/u.exec(entry);
    return (split === null ? undefined : server(split[1] ?? "", port(split[2]))) ?? fail(entry);
  });
}
function fail(entry: string): never { throw invalidIpAddress(entry); }

/** `resolver.getServers()`: the address alone on port 53, else `address:port` with an IPv6 address in brackets. */
export function formatServers(servers: readonly DnsServer[]): string[] {
  return servers.map(entry => entry.port === DNS_PORT ? entry.address : `${entry.family === 6 ? `[${entry.address}]` : entry.address}:${String(entry.port)}`);
}

/** One line of `/etc/hosts`. */
export interface HostsLine { readonly address: string; readonly family: 4 | 6; readonly names: readonly string[] }

export function parseHosts(text: string): HostsLine[] {
  const lines: HostsLine[] = [];
  for (const raw of text.split("\n")) {
    const [first, ...names] = raw.replace(/#.*$/u, "").trim().split(/\s+/u);
    const parsed = first === undefined ? undefined : parseAddress(first);
    if (parsed === undefined || names.length === 0) continue;
    lines.push({ address: formatAddress(parsed.family, parsed.bytes), family: parsed.family, names });
  }
  return lines;
}

/** The addresses the hosts file gives a name, in file order, compared without case. */
export function hostsAddresses(lines: readonly HostsLine[], name: string): { readonly address: string; readonly family: 4 | 6 }[] {
  const wanted = name.toLowerCase(), found: { readonly address: string; readonly family: 4 | 6 }[] = [];
  for (const line of lines) {
    if (!line.names.some(entry => entry.toLowerCase() === wanted) || found.some(entry => entry.address === line.address)) continue;
    found.push({ address: line.address, family: line.family });
  }
  return found;
}

/**
 * The names c-ares' hosts table holds for an address. Lines that share an address, or a name, are one entry there, so
 * `127.0.0.1 localhost` and `::1 localhost ip6-localhost` answer either address with all three names.
 */
export function hostsNames(lines: readonly HostsLine[], address: string): readonly string[] | undefined {
  const entries: { readonly addresses: string[]; readonly names: string[] }[] = [];
  for (const line of lines) {
    const known = (name: string, names: readonly string[]): boolean => names.some(entry => entry.toLowerCase() === name.toLowerCase());
    const entry = entries.find(candidate => candidate.addresses.includes(line.address)) ?? entries.find(candidate => line.names.some(name => known(name, candidate.names)));
    if (entry === undefined) { entries.push({ addresses: [line.address], names: [...line.names] }); continue; }
    if (!entry.addresses.includes(line.address)) entry.addresses.push(line.address);
    for (const name of line.names) if (!known(name, entry.names)) entry.names.push(name);
  }
  return entries.find(entry => entry.addresses.includes(address))?.names;
}

/** The name `/etc/services` gives a TCP port, as `getnameinfo` reports it. */
export function serviceName(text: string, port: number): string | undefined {
  for (const raw of text.split("\n")) {
    const [name, entry] = raw.replace(/#.*$/u, "").trim().split(/\s+/u);
    if (name !== undefined && name !== "" && entry === `${String(port)}/tcp`) return name;
  }
  return undefined;
}
