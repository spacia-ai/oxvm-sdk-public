import { DNS_PORT, parseResolvConf, RESOLV_CONF, type DnsServer } from "./node-dns-config.ts";
import { DnsFailure, type DnsStatus } from "./node-dns-errors.ts";
import { decodeMessage, DnsNameError, DnsWireError, encodeQuery, nameLabels, peekQuestion, type DnsMessage } from "./node-dns-wire.ts";
import { nodePunycode } from "./node-punycode.ts";

/** One question and the wait for its reply. */
export interface DnsExchange {
  readonly timeoutMs: number;
  /** Aborted by `resolver.cancel()`; the transport rejects with the signal's reason. */
  readonly signal: AbortSignal;
  /** False for a datagram that does not answer this question; the transport keeps waiting for one that does. */
  accept(reply: Uint8Array): boolean;
}

/**
 * What the resolver needs of Linux: one question to one server over UDP or over TCP (RFC 1035 4.2.2, a two-byte length
 * before each message), and the VM's configuration files. Each call owns its socket and closes it.
 */
export interface DnsTransport {
  /** Resolves with the first accepted reply datagram from that server; rejects with `DnsTransportError`. */
  udp(server: DnsServer, query: Uint8Array, exchange: DnsExchange): Promise<Uint8Array>;
  tcp(server: DnsServer, query: Uint8Array, exchange: DnsExchange): Promise<Uint8Array>;
  /** A guest file's text, or undefined when it cannot be read. */
  readFile(path: string): string | undefined;
}

/** `timeout`: no reply in time. `failed`: the socket could not be opened, connected, written or read. */
export class DnsTransportError extends Error {
  constructor(readonly kind: "timeout" | "failed", message: string, options?: ErrorOptions) { super(message, options); }
}

/** `new Resolver({ timeout, tries, maxTimeout })` as Node passes them to c-ares: -1 and 0 mean its defaults. */
export interface DnsChannelOptions { readonly timeout: number; readonly tries: number; readonly maxTimeout: number }
export interface DnsChannelRandom {
  /** A query ID: 16 random bits. */
  id(): number;
  /** The share, 0 to 1, of the allowed jitter a retry's timeout is shortened by. */
  jitter(): number;
}

const cryptoRandom: DnsChannelRandom = {
  id: () => crypto.getRandomValues(new Uint16Array(1))[0] ?? 0,
  jitter: () => (crypto.getRandomValues(new Uint8Array(1))[0] ?? 0) / 255,
};

/** c-ares 1.34's defaults and bounds (ares_metrics.c): 2 s per attempt, never under 250 ms, at most 5 s before back-off. */
const DEFAULT_TIMEOUT_MS = 2000, MIN_TIMEOUT_MS = 250, MAX_TIMEOUT_MS = 5000;

/** Node's `toASCII`: lower case, and Punycode for a label outside ASCII; a name it cannot convert goes out as given. */
export function queryName(name: string): string {
  let ascii = true;
  for (let index = 0; index < name.length && ascii; index += 1) ascii = name.charCodeAt(index) < 0x80;
  if (ascii) return name.toLowerCase();
  try { return nodePunycode.toASCII(name.normalize("NFC").toLowerCase()); } catch { return name; }
}

interface ServerState { readonly server: DnsServer; failures: number }

/**
 * One resolver's channel, modelled on c-ares as Node 24 configures it (behaviour recorded from Node 24.18.1 against a
 * scripted server): the name is asked as given, without search domains; up to `tries` attempts per server, each to the
 * server with the fewest failures; a timeout that doubles per round, capped by `maxTimeout` and shortened by up to half
 * as jitter; an unreadable reply or a socket error moves on at once; a truncated reply repeats the question over TCP
 * without spending an attempt; and an answer with an error code is final (Node sets ARES_FLAG_NOCHECKRESP).
 */
export class DnsChannel {
  readonly #transport: DnsTransport;
  readonly #options: DnsChannelOptions;
  readonly #random: DnsChannelRandom;
  #servers: ServerState[] | undefined;
  #cancel = new AbortController();
  /** `setLocalAddress`: kept for the record; the VM's sockets choose their own source address. */
  localAddress: { readonly ipv4?: string; readonly ipv6?: string } = {};

  constructor(transport: DnsTransport, options: DnsChannelOptions, random: DnsChannelRandom = cryptoRandom) {
    this.#transport = transport; this.#options = options; this.#random = random;
  }

  /**
   * The configured servers; until `setServers`, those of the VM's resolv.conf, or 127.0.0.1 when it names none.
   * c-ares keeps them ordered by failures, and `getServers()` shows that order.
   */
  get servers(): readonly DnsServer[] {
    return this.#state().map((state, index) => ({ state, index })).sort((left, right) => left.state.failures - right.state.failures || left.index - right.index).map(item => item.state.server);
  }
  set servers(list: readonly DnsServer[]) { this.#servers = list.map(entry => ({ server: entry, failures: 0 })); }
  #state(): ServerState[] {
    if (this.#servers !== undefined) return this.#servers;
    const configured = parseResolvConf(this.#transport.readFile(RESOLV_CONF) ?? "").nameservers;
    const list = configured.length === 0 ? [{ address: "127.0.0.1", family: 4 as const, port: DNS_PORT }] : configured;
    return this.#servers = list.map(entry => ({ server: entry, failures: 0 }));
  }

  /** Every pending query fails with ECANCELLED. */
  cancel(): void { const current = this.#cancel; this.#cancel = new AbortController(); current.abort(); }

  #timeout(rounds: number): number {
    const { timeout, maxTimeout } = this.#options;
    const base = Math.min(Math.max(timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS), maxTimeout > 0 ? maxTimeout : MAX_TIMEOUT_MS);
    if (rounds === 0) return base;
    let wait = base * 2 ** Math.min(rounds, 20);
    if (maxTimeout > 0 && wait > maxTimeout) wait = maxTimeout;
    wait -= Math.floor(wait * this.#random.jitter() * 0.5);
    return Math.max(wait, base);
  }

  /** Asks for `name`/`type` and resolves with the reply, whatever its response code; rejects with a `DnsFailure`. */
  async query(name: string, type: number): Promise<DnsMessage> {
    const asked = queryName(name), signal = this.#cancel.signal, cancelled = (): boolean => signal.aborted;
    let wanted: string;
    try { wanted = nameLabels(asked).join(".").toLowerCase(); }
    catch (error) { if (error instanceof DnsNameError) throw new DnsFailure("EBADNAME"); throw error; }
    const servers = this.#state();
    if (servers.length === 0) throw new DnsFailure("UNKNOWN_ARES_ERROR");
    let status: DnsStatus = "ETIMEOUT", overTcp = false;
    for (let attempt = 0; attempt < this.#options.tries * servers.length;) {
      if (cancelled()) throw new DnsFailure("ECANCELLED");
      const target = servers.reduce((best, candidate) => candidate.failures < best.failures ? candidate : best);
      const id = this.#random.id() & 0xffff, query = encodeQuery(id, asked, type);
      const answers = (reply: Uint8Array): boolean => {
        const peeked = peekQuestion(reply);
        // An unreadable datagram from the server ends the attempt; a readable one for another question is ignored.
        return peeked === undefined || (peeked.id === id && peeked.response && peeked.question.type === type && peeked.question.name.toLowerCase() === wanted);
      };
      const exchange: DnsExchange = { timeoutMs: this.#timeout(Math.floor(attempt / servers.length)), signal, accept: answers };
      let message: DnsMessage;
      try {
        const reply = await (overTcp ? this.#transport.tcp(target.server, query, exchange) : this.#transport.udp(target.server, query, exchange));
        if (!answers(reply)) throw new DnsWireError("The reply answers another question");
        message = decodeMessage(reply);
      } catch (error) {
        if (cancelled()) throw new DnsFailure("ECANCELLED");
        status = error instanceof DnsWireError ? "EBADRESP" : error instanceof DnsTransportError && error.kind === "timeout" ? "ETIMEOUT" : "ECONNREFUSED";
        target.failures += 1; attempt += 1;
        continue;
      }
      if (message.truncated && !overTcp) { overTcp = true; continue; }
      target.failures = 0;
      return message;
    }
    throw new DnsFailure(status);
  }
}
