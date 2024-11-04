// src/types/SecureAccount.ts
import { VectorBufferStream } from '@shardus/core'
import { AccountType } from '../shardeum/shardeumTypes'
import { TypeIdentifierEnum } from './enum/TypeIdentifierEnum'

import { SecureAccount } from '../shardeum/secureAccounts'
import { deserializeBaseAccount, serializeBaseAccount } from './BaseAccount'

const cSecureAccountVersion = 1
export function serializeSecureAccount(stream: VectorBufferStream, obj: SecureAccount, root = false): void {
  if (root) {
    stream.writeUInt16(TypeIdentifierEnum.cSecureAccount)
  }
  stream.writeUInt8(cSecureAccountVersion)

  serializeBaseAccount(stream, obj, false)
  stream.writeString(obj.id)
  stream.writeString(obj.hash)
  stream.writeBigUInt64(BigInt(obj.timestamp))

  stream.writeString(obj.name)
  stream.writeBigUInt64(obj.nextTransferAmount)
  stream.writeBigUInt64(BigInt(obj.nextTransferTime))
  stream.writeUInt32(obj.nonce)

  console.log('Serialized Secure Account:', stream.getBuffer().toString('utf8'));
}

export function deserializeSecureAccount(stream: VectorBufferStream): SecureAccount {
  const version = stream.readUInt8()
  if (version > cSecureAccountVersion) {
    throw new Error('SecureAccount version mismatch')
  }

  const baseAccount = deserializeBaseAccount(stream)
  // Check if we have enough bytes remaining for the rest of the data
  const remainingBytes = (stream as any).buffer.length - stream.position;
  const minimumBytesNeeded = 
    8 + // id (String)
    8 + // hash (String)
    8 + // timestamp (BigUInt64)
    4 + // minimum for string length fields
    8 + // nextTransferAmount (BigUInt64)
    8 + // nextTransferTime (BigUInt64)
    4;  // nonce (UInt32)

  if (remainingBytes < minimumBytesNeeded) {
    throw new Error(`Unexpected end of buffer: remaining bytes: ${remainingBytes}, needed ${minimumBytesNeeded}`);
  }

  const foo = {
    ...baseAccount,
    id: stream.readString(),
    hash: stream.readString(),
    timestamp: Number(stream.readBigUInt64()),
    name: stream.readString(),
    nextTransferAmount: stream.readBigUInt64(),
    nextTransferTime: Number(stream.readBigUInt64()),
    nonce: stream.readUInt32(),
  };
  console.log('FOO IS', foo);
  return foo;
}

