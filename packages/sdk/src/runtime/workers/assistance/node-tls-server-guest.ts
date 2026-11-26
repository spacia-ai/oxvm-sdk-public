import { nativeGuestArguments, nativeGuestFrames } from "./native-guest.ts";

/** How many accepted TCP connections one helper holds, handshakes included (`server.maxConnections`). */
export const TLS_SERVER_MAX_CONNECTIONS = 256;
/** Plaintext bytes a connection may send to the worker before the worker acknowledges them. */
export const TLS_SERVER_WINDOW = 262144;
/** The largest options record (start, setSecureContext, addContext), as JSON. */
export const TLS_SERVER_MAX_OPTIONS = 1048576;

/**
 * Runs only in the managed guest's original Node, one process per listening server. TLS, certificates, the
 * listening socket and every connection stay Linux-owned. Stdin carries data frames (a 4-byte connection id,
 * then plaintext; id 0 stages an options record, so key material never reaches argv or the environment) and
 * control records. Stdout carries plaintext per connection (an id alone ends that connection's stream), stderr
 * carries events. A connection is read only while the worker has acknowledged all but one window of its bytes.
 */
export const tlsServerGuestSource = String.raw`
'use strict';
const tls = require('node:tls');
const MAX_DATA = 65536, MAX_CONTROL = 16384, MAX_BLOB = ${String(TLS_SERVER_MAX_OPTIONS)}, MAX_CONNECTIONS = ${String(TLS_SERVER_MAX_CONNECTIONS)}, WINDOW = ${String(TLS_SERVER_WINDOW)};
function protocol() { return Object.assign(new Error('Invalid TLS server bridge frame'), { code: 'ERR_TLS_BRIDGE_PROTOCOL' }); }
function object(value, required, optional = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw protocol();
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw protocol();
  return value;
}
function id(value) { if (!Number.isSafeInteger(value) || value < 1 || value > 4294967295) throw protocol(); return value; }
function json(bytes) { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw protocol(); } }
${nativeGuestFrames}
let events = Promise.resolve();
function lost() { process.exit(1); }
function event(value) { const bytes = Buffer.from(JSON.stringify(value)); events = events.then(() => send(1, bytes)).catch(lost); return events; }
function errorInfo(error) {
  const out = { code: typeof error.code === 'string' ? error.code.slice(0, 128) : 'ERR_TLS_BRIDGE', message: String(error.message).slice(0, 4096) };
  if (Number.isSafeInteger(error.errno)) out.errno = error.errno;
  if (Number.isSafeInteger(error.port)) out.port = error.port;
  for (const key of ['syscall', 'address', 'library', 'reason']) if (typeof error[key] === 'string') out[key] = error[key].slice(0, 256);
  return out;
}
function material(value, nested = false) {
  if (Array.isArray(value)) { if (nested || value.length > 64) throw protocol(); return value.map(item => material(item, true)); }
  object(value, ['t', 'v'], ['passphrase']);
  if (typeof value.v !== 'string' || (value.t !== 's' && value.t !== 'b')) throw protocol();
  const bytes = value.t === 's' ? value.v : Buffer.from(value.v, 'base64');
  if (value.passphrase === undefined) return bytes;
  if (typeof value.passphrase !== 'string') throw protocol();
  return { pem: bytes, buf: bytes, passphrase: value.passphrase };
}
const MATERIAL = ['key', 'cert', 'ca', 'pfx', 'crl', 'dhparam'];
const TEXT = ['passphrase', 'minVersion', 'maxVersion', 'ciphers', 'ecdhCurve', 'sigalgs', 'secureProtocol', 'sessionIdContext'];
const FLAGS = ['requestCert', 'rejectUnauthorized', 'honorCipherOrder', 'noDelay', 'keepAlive'];
const NUMBERS = ['sessionTimeout', 'handshakeTimeout', 'secureOptions', 'keepAliveInitialDelay'];
function options(value) {
  object(value, [], [...MATERIAL, ...TEXT, ...FLAGS, ...NUMBERS, 'ALPNProtocols', 'ticketKeys']);
  const out = {};
  for (const [name, item] of Object.entries(value)) {
    if (MATERIAL.includes(name)) out[name] = material(item);
    else if (TEXT.includes(name)) { if (typeof item !== 'string' || item.length > 16384) throw protocol(); out[name] = item; }
    else if (FLAGS.includes(name)) { if (typeof item !== 'boolean') throw protocol(); out[name] = item; }
    else if (NUMBERS.includes(name)) { if (typeof item !== 'number' || !Number.isFinite(item)) throw protocol(); out[name] = item; }
    else if (name === 'ticketKeys') { if (typeof item !== 'string') throw protocol(); out[name] = Buffer.from(item, 'base64'); }
    else {
      if (!Array.isArray(item) || item.length > 32 || item.some(entry => typeof entry !== 'string' || Buffer.byteLength(entry) === 0 || Buffer.byteLength(entry) > 255)) throw protocol();
      out[name] = item;
    }
  }
  return out;
}
const connections = new Map();
let server, nextId = 0, started = false, closing = false, serverClosed = false, finishing = false, failed = false, blob = [], blobSize = 0;
function takeBlob() { const bytes = Buffer.concat(blob); blob = []; blobSize = 0; return json(bytes); }
function finish() {
  if (finishing || !serverClosed || connections.size !== 0) return;
  finishing = true;
  void event({ kind: 'done' }).then(() => { process.stdin.destroy(); });
}
function peer(socket) {
  let certificate;
  try { certificate = socket.getPeerCertificate(false); } catch { return null; }
  if (!certificate || Object.keys(certificate).length === 0) return null;
  const out = {};
  for (const [name, item] of Object.entries(certificate)) {
    if (item === undefined || item === null) out[name] = null;
    else if (Buffer.isBuffer(item)) out[name] = { base64: item.toString('base64') };
    else if (typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number') out[name] = item;
    else if (Array.isArray(item)) out[name] = item.map(String);
    else if (item && typeof item === 'object') out[name] = Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, Array.isArray(entry) ? entry.map(String) : String(entry)]));
  }
  const fits = () => Buffer.byteLength(JSON.stringify(out)) <= 12000;
  for (const name of ['pubkey', 'modulus', 'infoAccess', 'raw', 'subjectaltname']) { if (fits()) break; delete out[name]; }
  return fits() ? out : null;
}
function marker(key) { const payload = Buffer.allocUnsafe(4); payload.writeUInt32BE(key, 0); return payload; }
function progress(state) {
  if (state.retired || state.sending || !state.accepted) return;
  if ((state.ended || state.closed) && !state.marked) { state.marked = true; send(0, marker(state.key)).catch(lost); }
  if (state.closed) {
    state.retired = true; connections.delete(state.key);
    void event({ kind: 'conn-close', id: state.key, hadError: state.failed }); finish();
  }
}
function pump(state) {
  if (state.sending || state.retired || state.closed || !state.accepted) return;
  const available = state.socket.readableLength;
  if (available === 0) { state.socket.read(); return; }
  if (state.credit === 0) return;
  const bytes = state.socket.read(Math.min(available, MAX_DATA - 4, state.credit));
  if (!bytes) return;
  state.credit -= bytes.length; state.sending = true;
  const payload = Buffer.allocUnsafe(bytes.length + 4); payload.writeUInt32BE(state.key, 0); bytes.copy(payload, 4);
  send(0, payload).then(() => { state.sending = false; pump(state); progress(state); }, lost);
}
function accept(socket) {
  if (typeof socket.remoteAddress !== 'string' || typeof socket.localAddress !== 'string' || nextId >= 4294967295) { socket.destroy(); return; }
  const key = ++nextId;
  const state = { key, socket, credit: 0, accepted: false, sending: false, ended: false, marked: false, closed: false, failed: false, retired: false };
  connections.set(key, state);
  socket.on('readable', () => pump(state));
  socket.on('end', () => { state.ended = true; progress(state); });
  socket.on('error', error => { state.failed = true; void event({ kind: 'conn-error', id: key, error: errorInfo(error) }); });
  socket.on('timeout', () => { void event({ kind: 'timeout', id: key }); });
  socket.on('close', () => { state.closed = true; progress(state); });
  const cipher = socket.getCipher() ?? {}, problem = socket.authorizationError;
  void event({ kind: 'open', id: key, localAddress: socket.localAddress, localPort: socket.localPort, localFamily: socket.localFamily,
    remoteAddress: socket.remoteAddress, remotePort: socket.remotePort, remoteFamily: socket.remoteFamily,
    authorized: socket.authorized === true, authorizationError: typeof problem === 'string' ? problem : problem == null ? null : String(problem.code ?? problem.message ?? problem),
    alpnProtocol: typeof socket.alpnProtocol === 'string' ? socket.alpnProtocol : false, servername: typeof socket.servername === 'string' ? socket.servername : false,
    protocol: socket.getProtocol(), cipher: { name: String(cipher.name), standardName: String(cipher.standardName), version: String(cipher.version) }, peer: peer(socket) });
}
function start(config) {
  object(config, ['options', 'contexts', 'listen']);
  const listen = object(config.listen, ['port'], ['host', 'backlog', 'ipv6Only']);
  if (!Number.isSafeInteger(listen.port) || listen.port < 0 || listen.port > 65535) throw protocol();
  if (listen.host !== undefined && (typeof listen.host !== 'string' || listen.host.length === 0 || listen.host.length > 4096 || listen.host.includes('\0'))) throw protocol();
  if (listen.backlog !== undefined && (!Number.isSafeInteger(listen.backlog) || listen.backlog < 1 || listen.backlog > 2147483647)) throw protocol();
  if (listen.ipv6Only !== undefined && typeof listen.ipv6Only !== 'boolean') throw protocol();
  if (!Array.isArray(config.contexts) || config.contexts.length > 64) throw protocol();
  const base = options(config.options);
  const contexts = config.contexts.map(entry => {
    object(entry, ['hostname', 'options']);
    if (typeof entry.hostname !== 'string' || entry.hostname.length > 4096) throw protocol();
    return [entry.hostname, options(entry.options)];
  });
  try {
    server = tls.createServer({ ...base, allowHalfOpen: true });
    for (const [hostname, context] of contexts) server.addContext(hostname, context);
  } catch (error) {
    // OpenSSL refused the key material or an option: the program sees Node's own error, and the helper retires.
    server = undefined; serverClosed = true; void event({ kind: 'error', error: errorInfo(error) }); finish(); return;
  }
  server.maxConnections = MAX_CONNECTIONS;
  server.on('secureConnection', accept);
  server.on('tlsClientError', (error, socket) => {
    void event({ kind: 'client-error', error: errorInfo(error), remoteAddress: typeof socket?.remoteAddress === 'string' ? socket.remoteAddress : null,
      remotePort: Number.isSafeInteger(socket?.remotePort) ? socket.remotePort : null });
  });
  server.on('error', error => { void event({ kind: 'error', error: errorInfo(error) }); if (!server.listening && !serverClosed) { serverClosed = true; finish(); } });
  server.on('close', () => { if (serverClosed) return; serverClosed = true; void event({ kind: 'closed' }); finish(); });
  server.on('listening', () => { const bound = server.address(); void event({ kind: 'listening', address: bound.address, port: bound.port, family: bound.family }); });
  server.listen(listen);
}
function command(value) {
  const kind = value.kind;
  if (kind === 'start') { object(value, ['kind']); if (started) throw protocol(); started = true; start(takeBlob()); return; }
  if (!started) throw protocol();
  if (kind === 'close') { object(value, ['kind']); if (server && !closing && !serverClosed) { closing = true; server.close(); } return; }
  if (kind === 'ticket-keys') {
    object(value, ['kind', 'keys']); if (typeof value.keys !== 'string') throw protocol();
    const keys = Buffer.from(value.keys, 'base64'); if (keys.length !== 48) throw protocol();
    if (server) server.setTicketKeys(keys);
    return;
  }
  if (kind === 'secure-context' || kind === 'add-context') {
    object(value, kind === 'secure-context' ? ['kind', 'request'] : ['kind', 'request', 'hostname']); id(value.request);
    if (kind === 'add-context' && (typeof value.hostname !== 'string' || value.hostname.length > 4096)) throw protocol();
    const context = options(takeBlob()); let failure = null;
    try { if (server) { if (kind === 'secure-context') server.setSecureContext(context); else server.addContext(value.hostname, context); } }
    catch (error) { failure = errorInfo(error); }
    void event({ kind: 'applied', request: value.request, error: failure }); return;
  }
  const state = connections.get(id(value.id));
  if (!state) return;
  const socket = state.socket;
  if (kind === 'accept') {
    object(value, ['kind', 'id']); if (state.accepted) throw protocol();
    state.accepted = true; state.credit = WINDOW; pump(state); progress(state);
  } else if (kind === 'ack') {
    object(value, ['kind', 'id', 'count']);
    if (!Number.isSafeInteger(value.count) || value.count < 1 || state.credit + value.count > WINDOW) throw protocol();
    state.credit += value.count; pump(state);
  } else if (kind === 'end') {
    object(value, ['kind', 'id']);
    if (!socket.destroyed && !socket.writableEnded) socket.end(error => { if (!error) void event({ kind: 'finished', id: state.key }); });
  } else if (kind === 'destroy') { object(value, ['kind', 'id']); socket.destroy(); }
  else if (kind === 'timeout') {
    object(value, ['kind', 'id', 'duration']);
    if (typeof value.duration !== 'number' || !Number.isFinite(value.duration) || value.duration < 0) throw protocol();
    socket.setTimeout(value.duration);
  } else if (kind === 'no-delay') {
    object(value, ['kind', 'id', 'enabled']); if (typeof value.enabled !== 'boolean') throw protocol();
    socket.setNoDelay(value.enabled);
  } else if (kind === 'keep-alive') {
    object(value, ['kind', 'id', 'enabled', 'delay']);
    if (typeof value.enabled !== 'boolean' || typeof value.delay !== 'number' || !Number.isFinite(value.delay)) throw protocol();
    socket.setKeepAlive(value.enabled, value.delay);
  } else throw protocol();
}
async function main() {
  for await (const [tag, payload] of frames()) {
    if (tag === 1) { command(object(json(payload), ['kind'], ['id', 'count', 'duration', 'enabled', 'delay', 'request', 'hostname', 'keys'])); continue; }
    if (payload.length < 5) throw protocol();
    const key = payload.readUInt32BE(0);
    if (key === 0) {
      blobSize += payload.length - 4; if (blobSize > MAX_BLOB) throw protocol();
      blob.push(payload.subarray(4)); continue;
    }
    if (!started) throw protocol();
    const state = connections.get(key);
    if (!state || state.closed || state.socket.destroyed || state.socket.writableEnded) continue;
    const count = payload.length - 4;
    state.socket.write(payload.subarray(4), error => { if (!error) void event({ kind: 'written', id: key, count }); });
  }
}
main().catch(error => { if (!finishing) { failed = true; void event({ kind: 'fatal', error: errorInfo(error) }); } }).finally(() => {
  for (const state of connections.values()) state.socket.destroy();
  if (server && !serverClosed) { serverClosed = true; try { server.close(); } catch {} }
  // Connections still in their handshake would hold the process until the handshake timeout: leave once the events are out.
  void events.then(() => { process.stdout.write('', () => { process.stderr.write('', () => { process.exit(failed ? 1 : 0); }); }); });
});
`;

/** Only the fixed program is on the command line; options, keys and certificates travel on framed stdin. */
export function tlsServerGuestArguments(): string[] { return nativeGuestArguments(tlsServerGuestSource, {}); }
