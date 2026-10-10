"use strict";

// The crypto addresses in config.js are copied by visitors straight into a
// wallet, so a typo sends money somewhere unrecoverable. Each address format
// carries a checksum; verify it here so a bad edit fails `npm test`.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadSite() {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "public", "assets", "js", "config.js"), "utf8"), ctx);
  return ctx.window.SITE;
}

// ---------- Keccak-256 (EIP-55 uses Keccak, not NIST SHA3-256) ----------
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const M = (1n << 64n) - 1n;
const rotl = (x, n) => (n ? ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M : x);

function keccakF(s) {
  for (let r = 0; r < 24; r++) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    const b = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 25; y += 5) s[x + y] = b[x + y] ^ (~b[(x + 1) % 5 + y] & M & b[(x + 2) % 5 + y]);
    s[0] ^= RC[r];
  }
}

function keccak256(bytes) {
  const rate = 136, s = new Array(25).fill(0n);
  const msg = Buffer.alloc(Math.ceil((bytes.length + 1) / rate) * rate);
  Buffer.from(bytes).copy(msg);
  msg[bytes.length] ^= 0x01;
  msg[msg.length - 1] ^= 0x80;
  for (let off = 0; off < msg.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) s[i] ^= msg.readBigUInt64LE(off + i * 8);
    keccakF(s);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(s[i], i * 8);
  return out.toString("hex");
}

// ---------- Address checks ----------
// EIP-55: a hex letter is upper case exactly when the matching nibble of
// keccak256(lowercase address) is 8 or more.
function isEip55(addr) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return false;
  const hex = addr.slice(2), hash = keccak256(Buffer.from(hex.toLowerCase(), "ascii"));
  return [...hex].every((ch, i) => !/[a-f]/i.test(ch) || (parseInt(hash[i], 16) >= 8 ? ch === ch.toUpperCase() : ch === ch.toLowerCase()));
}

// BIP-173 bech32 (SegWit v0, which native "bc1q" addresses are).
const BECH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32Polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i];
  }
  return chk >>> 0;
}
function isBitcoinSegwitV0(addr) {
  const m = /^(bc)1([qpzry9x8gf2tvdw0s3jn54khce6mua7l]+)$/.exec(addr);
  if (!m) return false;
  const data = [...m[2]].map((c) => BECH.indexOf(c));
  const hrp = [...m[1]].map((c) => c.charCodeAt(0));
  const expanded = hrp.map((c) => c >> 5).concat([0], hrp.map((c) => c & 31));
  if (bech32Polymod(expanded.concat(data)) !== 1) return false;
  const program = data.slice(1, -6).length * 5;
  return data[0] === 0 && (program === 160 + (program % 8) || program === 256 + (program % 8));
}

// Solana: base58 of a 32-byte ed25519 public key (no checksum, so check length).
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Bytes(str) {
  let n = 0n;
  for (const c of str) {
    const i = B58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const hex = n ? n.toString(16) : "";
  const body = Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex");
  const zeros = /^1*/.exec(str)[0].length;
  return Buffer.concat([Buffer.alloc(zeros), body]);
}
const isSolana = (addr) => (base58Bytes(addr) || []).length === 32;

function checkerFor(networks) {
  const n = networks.join(" ");
  if (/Bitcoin/i.test(n)) return isBitcoinSegwitV0;
  if (/Solana/i.test(n)) return isSolana;
  if (/Ethereum|BNB|Arbitrum|Polygon|Base|Optimism/i.test(n)) return isEip55;
  return null;
}

// ---------- Tests ----------
test("keccak256 matches known vectors", () => {
  assert.equal(keccak256(Buffer.alloc(0)), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccak256(Buffer.from("abc")), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
});

test("address checkers accept known-good and reject corrupted addresses", () => {
  assert.ok(isEip55("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"));
  assert.ok(!isEip55("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD"));
  assert.ok(isBitcoinSegwitV0("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"));
  assert.ok(!isBitcoinSegwitV0("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5"));
  assert.ok(isSolana("11111111111111111111111111111111"));
  assert.ok(!isSolana("1111111111111111111111111111111"));
});

test("every support address in config.js is valid for its network", () => {
  const list = (loadSite().support || {}).crypto || [];
  assert.ok(list.length > 0, "no support addresses configured");
  for (const entry of list) {
    assert.ok(Array.isArray(entry.networks) && entry.networks.length, "entry without networks: " + entry.address);
    const check = checkerFor(entry.networks);
    assert.ok(check, "no address check for " + entry.networks.join(", "));
    assert.ok(check(entry.address), "invalid address for " + entry.networks.join(", ") + ": " + entry.address);
  }
});
