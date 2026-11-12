import { readFile } from 'node:fs/promises';

type Section = { address: number; data: Buffer };
type Range = { start: number; end: number };
const marker = Buffer.from('NodeISendSsoCmdReqCallback.cpp\0');
const sendCalls = 'napi_typeof,napi_get_value_int32,napi_coerce_to_string';
const legacyCalls = 'napi_create_object,napi_create_int32,napi_set_named_property,napi_get_last_error_info,napi_create_string_utf8,napi_set_named_property,napi_get_last_error_info,napi_create_string_utf8,napi_set_named_property,napi_resolve_deferred,napi_get_last_error_info,napi_is_exception_pending,napi_throw_error';

function upperBound(ranges: Range[], address: number): number {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (ranges[mid]!.start <= address) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}

export async function resolveWindowsX64Offsets(path: string): Promise<[string, string]> {
  const file = await readFile(path);
  if (file.readUInt16LE(0) !== 0x5a4d) throw new Error('QQ 内核缺少 DOS 标头');
  const pe = file.readUInt32LE(0x3c);
  if (file.readUInt32LE(pe) !== 0x4550 || file.readUInt16LE(pe + 4) !== 0x8664 ||
      file.readUInt16LE(pe + 24) !== 0x20b) throw new Error('当前内核不是 Windows x64 PE');

  const sections = new Map<string, Section>();
  const table = pe + 24 + file.readUInt16LE(pe + 20);
  for (let i = 0; i < file.readUInt16LE(pe + 6); i++) {
    const pos = table + i * 40;
    const name = file.toString('ascii', pos, pos + 8).replace(/\0.*$/, '');
    const size = file.readUInt32LE(pos + 16);
    const start = file.readUInt32LE(pos + 20);
    sections.set(name, { address: file.readUInt32LE(pos + 12), data: file.subarray(start, start + size) });
  }
  const text = sections.get('.text');
  const pdata = sections.get('.pdata');
  const rdata = sections.get('.rdata');
  if (!text || !pdata || !rdata) throw new Error('QQ 内核缺少必需的 PE 节');
  function readRva(rva: number): Buffer {
    for (const section of sections.values()) {
      const offset = rva - section.address;
      if (offset >= 0 && offset < section.data.length) return section.data.subarray(offset);
    }
    throw new Error('QQ 内核包含无效 RVA');
  }
  const imports = new Map<number, string>();
  const importRva = file.readUInt32LE(pe + 24 + 120);
  if (!importRva) throw new Error('QQ 内核缺少导入表');
  const descriptors = readRva(importRva);
  for (let i = 0; i + 20 <= descriptors.length; i += 20) {
    const iat = descriptors.readUInt32LE(i + 16);
    if (!iat) break;
    const thunk = readRva(descriptors.readUInt32LE(i) || iat);
    for (let j = 0; j + 8 <= thunk.length; j += 8) {
      const name = thunk.readUInt32LE(j);
      const high = thunk.readUInt32LE(j + 4);
      if (!high && !name) break;
      if (high) continue;
      const value = readRva(name + 2);
      if (value.subarray(0, 5).toString('ascii') !== 'napi_') continue;
      imports.set(iat + j, value.toString('ascii', 0, value.indexOf(0)));
    }
  }

  const ranges: Range[] = [];
  const code = text.data;
  const base = text.address;
  for (let i = 0; i + 12 <= pdata.data.length; i += 12) {
    const start = pdata.data.readUInt32LE(i);
    const end = pdata.data.readUInt32LE(i + 4);
    if (start >= base && end > start && end <= base + code.length) ranges.push({ start, end });
  }
  ranges.sort((a, b) => a.start - b.start);
  const sourcePaths = new Set<number>();
  for (let pos = rdata.data.indexOf(marker); pos >= 0; pos = rdata.data.indexOf(marker, pos + marker.length)) {
    sourcePaths.add(rdata.address + pos);
    sourcePaths.add(rdata.address + rdata.data.lastIndexOf(0, pos - 1) + 1);
  }

  function getImport(i: number): string | undefined {
    if (code[i] === 0xff && code[i + 1] === 0x15 && i + 6 <= code.length) {
      return imports.get(base + i + 6 + code.readInt32LE(i + 2));
    }
    if (code[i] !== 0xe8 || i + 5 > code.length) return undefined;
    const target = i + 5 + code.readInt32LE(i + 1);
    if (target < 0 || target + 6 > code.length || code[target] !== 0xff || code[target + 1] !== 0x25) {
      return undefined;
    }
    return imports.get(base + target + 6 + code.readInt32LE(target + 2));
  }

  function reference(i: number): number {
    if (i + 7 > code.length || (code[i]! & 0xf8) !== 0x48 ||
        code[i + 1] !== 0x8d || (code[i + 2]! & 0xc7) !== 5) return -1;
    return base + i + 7 + code.readInt32LE(i + 3);
  }

  const replyLabels = new Map<number, string>();
  for (const label of ['result', 'errMsg', 'rsp']) {
    const value = Buffer.from(label + '\0');
    for (let pos = rdata.data.indexOf(value); pos >= 0; pos = rdata.data.indexOf(value, pos + value.length)) {
      replyLabels.set(rdata.address + pos, label);
    }
  }
  const sendEntries = new Set<Range>();
  const recvEntries = new Set<Range>();
  for (let i = 0; i + 5 <= code.length; i++) {
    const imported = getImport(i);
    const ref = reference(i);
    if (imported !== 'napi_typeof' && !sourcePaths.has(ref) && replyLabels.get(ref) !== 'result') continue;
    const entry = ranges[upperBound(ranges, base + i)];
    if (!entry || entry.end <= base + i) continue;
    if (imported === 'napi_typeof') sendEntries.add(entry);
    if (sourcePaths.has(ref) || replyLabels.get(ref) === 'result') recvEntries.add(entry);
  }

  function inspect(entry: Range): { calls: string[]; labels: Set<string>; source: boolean } {
    const calls: string[] = [];
    const labels = new Set<string>();
    let source = false;
    for (let i = entry.start - base; i < entry.end - base; i++) {
      const name = getImport(i);
      if (name) calls.push(name);
      const ref = reference(i);
      if (sourcePaths.has(ref)) source = true;
      const label = replyLabels.get(ref);
      if (label) labels.add(label);
    }
    return { calls, labels, source };
  }
  const send = [...sendEntries].filter(entry => inspect(entry).calls.join(',') === sendCalls);
  const recv = [...recvEntries].filter(entry => {
    const { calls, labels, source } = inspect(entry);
    if (!labels.has('result') || !labels.has('errMsg')) return false;
    if (!sourcePaths.size) return labels.has('rsp') && calls.join(',') === legacyCalls;
    return source && ['napi_create_object', 'napi_create_int32', 'napi_create_string_utf8',
      'napi_set_named_property', 'napi_resolve_deferred'].every(name => calls.includes(name));
  });
  if (send.length !== 1 || recv.length !== 1) {
    throw new Error(`QQ 偏移匹配需要唯一结果，send=${send.length}，recv=${recv.length}`);
  }
  return [send[0]!.start.toString(16).toUpperCase(), recv[0]!.start.toString(16).toUpperCase()];
}
