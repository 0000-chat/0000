// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(packageRoot, "release", "documentation-tools.tgz");
const files = ["LICENSE", "README.md", "cli.mjs", "package-lock.json", "package.json"];
const executableFiles = new Set(["cli.mjs"]);
const blockSize = 512;

function octal(value, width) {
  const rendered = Math.trunc(value).toString(8).padStart(width - 1, "0");
  if (rendered.length >= width) throw new Error(`tar field ${value} does not fit`);
  return `${rendered}\0`;
}

function writeString(target, offset, length, value) {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length > length) throw new Error(`tar header string is too long: ${value}`);
  buffer.copy(target, offset);
}

function tarHeader(name, size, mode) {
  const header = Buffer.alloc(blockSize, 0);
  writeString(header, 0, 100, name);
  writeString(header, 100, 8, octal(mode, 8));
  writeString(header, 108, 8, octal(0, 8));
  writeString(header, 116, 8, octal(0, 8));
  writeString(header, 124, 12, octal(size, 12));
  writeString(header, 136, 12, octal(0, 12));
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function buildTar() {
  const parts = [];
  for (const file of files) {
    const filePath = path.join(packageRoot, file);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${file} must be a regular package-owned file`);
    const contents = fs.readFileSync(filePath);
    parts.push(tarHeader(file, contents.length, executableFiles.has(file) ? 0o755 : 0o644));
    parts.push(contents);
    const paddingLength = (blockSize - (contents.length % blockSize)) % blockSize;
    if (paddingLength > 0) parts.push(Buffer.alloc(paddingLength, 0));
  }
  parts.push(Buffer.alloc(blockSize * 2, 0));
  return Buffer.concat(parts);
}

function crc32(contents) {
  let crc = 0xffffffff;
  for (const byte of contents) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildArtifact() {
  const tar = buildTar();
  const parts = [Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff])];
  for (let offset = 0; offset < tar.length; offset += 0xffff) {
    const end = Math.min(offset + 0xffff, tar.length);
    const size = end - offset;
    const finalBlock = end === tar.length;
    const blockHeader = Buffer.alloc(5);
    blockHeader[0] = finalBlock ? 1 : 0;
    blockHeader.writeUInt16LE(size, 1);
    blockHeader.writeUInt16LE(size ^ 0xffff, 3);
    parts.push(blockHeader, tar.subarray(offset, end));
  }
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(tar), 0);
  trailer.writeUInt32LE(tar.length >>> 0, 4);
  parts.push(trailer);
  return Buffer.concat(parts);
}

const artifact = buildArtifact();
const digest = crypto.createHash("sha256").update(artifact).digest("hex");
if (process.argv.includes("--check")) {
  if (!fs.existsSync(outputPath) || !fs.readFileSync(outputPath).equals(artifact)) {
    console.error("documentation tools artifact differs from its reproducible build");
    process.exitCode = 1;
  } else {
    console.log(`documentation tools artifact is reproducible (sha256 ${digest})`);
  }
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, artifact, { mode: 0o644 });
  console.log(`wrote ${path.relative(packageRoot, outputPath)} (sha256 ${digest})`);
}
