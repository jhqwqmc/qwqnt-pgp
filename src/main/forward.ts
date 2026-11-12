import { gzipSync, gunzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';

export interface ForwardNode {
  uin: string | number;
  name: string;
  groupId?: number;
  time: number;
  text: string;
}

export interface UploadResult {
  resId: string;
}

export const CMD_SEND_LONG_MSG = 'trpc.group.long_msg_interface.MsgService.SsoSendLongMsg';
export const CMD_RECV_LONG_MSG = 'trpc.group.long_msg_interface.MsgService.SsoRecvLongMsg';

function varint(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error('合并转发字段超出 uint32 范围');
  }
  const bytes: number[] = [];
  while (value > 127) {
    bytes.push((value & 127) | 128);
    value >>>= 7;
  }
  bytes.push(value);
  return Buffer.from(bytes);
}

function number(writer: Buffer[], field: number, value: number): void {
  writer.push(varint(field * 8), varint(value));
}

function bytes(writer: Buffer[], field: number, value: Buffer): void {
  writer.push(varint(field * 8 + 2), varint(value.length), value);
}

function text(writer: Buffer[], field: number, value: string): void {
  bytes(writer, field, Buffer.from(value, 'utf8'));
}

function message(writer: Buffer[], field: number, write: (writer: Buffer[]) => void): void {
  const nested: Buffer[] = [];
  write(nested);
  bytes(writer, field, Buffer.concat(nested));
}

function writeForwardNode(writer: Buffer[], node: ForwardNode, selfUid: string): void {
  const uin = Number(node.uin) || 0;
  const seq = randomBytes(4).readUInt32LE(0);
  const avatar = `https://q.qlogo.cn/headimg_dl?dst_uin=${uin}&spec=0&img_type=jpg`;

  message(writer, 1, header => {
    if (uin) number(header, 1, uin);
    text(header, 2, '');
    const groupId = node.groupId;
    if (groupId) {
      message(header, 8, group => {
        number(group, 1, groupId);
        if (node.name) text(group, 4, node.name);
        number(group, 5, 2);
      });
    } else {
      text(header, 6, selfUid);
      message(header, 7, contact => text(contact, 6, node.name));
    }
  });
  message(writer, 2, header => {
    number(header, 1, node.groupId ? 82 : 9);
    if (!node.groupId) number(header, 2, 4);
    number(header, 5, seq);
    number(header, 6, node.time);
    message(header, 15, preview => {
      number(preview, 1, 0);
      number(preview, 2, 0);
      number(preview, 3, node.groupId ? 1 : 2);
      text(preview, 5, avatar);
      text(preview, 6, avatar);
    });
  });
  message(writer, 3, body => {
    message(body, 1, richText => {
      message(richText, 2, element => {
        message(element, 1, content => text(content, 1, node.text));
      });
    });
  });
}

export function buildUploadPacket(selfUid: string, nodes: ForwardNode[], groupUin: number): { cmd: string; data: Buffer } {
  if (!selfUid.trim()) throw new Error('上传合并转发需要登录 UID');
  if (!nodes.length) throw new Error('合并转发至少需要一条消息');
  if (groupUin !== 0 && (!Number.isSafeInteger(groupUin) || groupUin < 0)) {
    throw new Error('群号必须是有效的非负整数');
  }
  if (nodes.some(n => !Number.isFinite(n.time) || !String(n.text).length)) {
    throw new Error('转发节点时间或文本无效');
  }

  const content: Buffer[] = [];
  message(content, 2, action => {
    text(action, 1, 'MultiMsg');
    message(action, 2, records => {
      for (const node of nodes) message(records, 1, record => writeForwardNode(record, node, selfUid));
    });
  });
  const payload = gzipSync(Buffer.concat(content));

  const request: Buffer[] = [];
  message(request, 2, info => {
    number(info, 1, groupUin ? 3 : 1);
    message(info, 2, uid => text(uid, 2, groupUin ? String(groupUin) : selfUid));
    number(info, 3, groupUin);
    bytes(info, 4, payload);
  });
  message(request, 15, settings => {
    number(settings, 1, 4);
    number(settings, 2, 1);
    number(settings, 3, 7);
  });
  return { cmd: CMD_SEND_LONG_MSG, data: Buffer.concat(request) };
}

export function buildRecvPacket(selfUid: string, resId: string): { cmd: string; data: Buffer } {
  const request: Buffer[] = [];
  message(request, 1, info => {
    message(info, 1, uid => text(uid, 2, selfUid));
    text(info, 2, resId);
    number(info, 3, 1);
  });
  message(request, 15, settings => number(settings, 1, 2));
  return { cmd: CMD_RECV_LONG_MSG, data: Buffer.concat(request) };
}

function* readMessages(data: Uint8Array, field: number): Generator<Uint8Array> {
  let position = 0;
  function readVarint(maxBytes: number): number {
    let value = 0;
    for (let i = 0; i < maxBytes && position < data.length; i++) {
      const byte = data[position++]!;
      if (maxBytes === 5) value += (byte & 127) * 128 ** i;
      if (byte < 128) {
        if (value > 0xffffffff || (i === 9 && byte > 1)) break;
        return value;
      }
    }
    throw new Error('合并转发回包中的 varint 无效');
  }
  const groups: number[] = [];
  while (position < data.length) {
    const key = readVarint(5);
    const tag = key >>> 3;
    const wire = key & 7;
    if (!tag || wire > 5) throw new Error('合并转发回包字段无效');
    if (wire === 0) readVarint(10);
    if (wire === 1) position += 8;
    if (wire === 2) {
      const length = readVarint(5);
      const start = position;
      position += length;
      if (position <= data.length && !groups.length && tag === field) yield data.subarray(start, position);
    }
    if (wire === 3) groups.push(tag);
    if (wire === 4 && groups.pop() !== tag) throw new Error('合并转发回包字段无效');
    if (wire === 5) position += 4;
    if (position > data.length) throw new Error('合并转发回包被截断');
  }
  if (groups.length) throw new Error('合并转发回包被截断');
}

function lastField(data: Uint8Array, outer: number, inner: number): Uint8Array | undefined {
  let result: Uint8Array | undefined;
  for (const message of readMessages(data, outer)) {
    for (const field of readMessages(message, inner)) result = field;
  }
  return result;
}

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

export function parseUploadResponse(data: Uint8Array): UploadResult {
  const resId = decoder.decode(lastField(data, 2, 3));
  if (!resId) throw new Error('上传合并转发失败：回包里没有 resId');
  return { resId };
}

export function parseRecvResponse(data: Uint8Array): string[] {
  const payload = lastField(data, 1, 4);
  if (!payload?.length) return [];
  const texts: string[] = [];
  for (const action of readMessages(gunzipSync(payload), 2)) {
    for (const records of readMessages(action, 2)) {
      for (const record of readMessages(records, 1)) {
        for (const body of readMessages(record, 3)) {
          for (const richText of readMessages(body, 1)) {
            for (const element of readMessages(richText, 2)) {
              const value = decoder.decode(lastField(element, 1, 1));
              if (value) texts.push(value);
            }
          }
        }
      }
    }
  }
  return texts;
}
