import { BufferReader, BufferWriter, reverseBuffer } from './bufferutils';
import * as bcrypto from './crypto';
import * as bscript from './script';
import { OPS as opcodes } from './script';
import * as types from './types';

const typeforce = require('typeforce');
const varuint = require('varuint-bitcoin');

function varSliceSize(someScript: Buffer): number {
  const length = someScript.length;

  return varuint.encodingLength(length) + length;
}

const EMPTY_SCRIPT: Buffer = Buffer.allocUnsafe(0);
const ONE: Buffer = Buffer.from(
  '0000000000000000000000000000000000000000000000000000000000000001',
  'hex',
);
const VALUE_UINT64_MAX: Buffer = Buffer.from('ffffffffffffffff', 'hex');
const BLANK_OUTPUT = {
  script: EMPTY_SCRIPT,
  valueBuffer: VALUE_UINT64_MAX,
};

function isOutput(out: Output): boolean {
  return out.value !== undefined;
}

export interface Output {
  script: Buffer;
  value: number;
}

export interface Input {
  hash: Buffer;
  index: number;
  script: Buffer;
  sequence: number;
}

export class Transaction {
  // * Basic transaction serialization format:
  // * - int32_t nVersion
  // * - uint32_t nTime (or uint64_t if nVersion >= 2)
  // * - std::vector<CTxIn> vin
  // * - std::vector<CTxOut> vout
  // * - uint32_t nLockTime
  static readonly DEFAULT_SEQUENCE = 0xffffffff;
  static readonly SIGHASH_ALL = 0x01;
  static readonly SIGHASH_NONE = 0x02;
  static readonly SIGHASH_SINGLE = 0x03;
  static readonly SIGHASH_ANYONECANPAY = 0x80;
  static readonly ADVANCED_TRANSACTION_MARKER = 0x00;
  static readonly ADVANCED_TRANSACTION_FLAG = 0x01;

  static fromBuffer(buffer: Buffer, _NO_STRICT?: boolean): Transaction {
    const bufferReader = new BufferReader(buffer);

    const tx = new Transaction();
    tx.version = bufferReader.readInt32();

    if (tx.version >= 2) {
      tx.time = bufferReader.readUInt64();
    } else {
      tx.time = bufferReader.readUInt32();
    }

    const vinLen = bufferReader.readVarInt();
    for (let i = 0; i < vinLen; ++i) {
      tx.ins.push({
        hash: bufferReader.readSlice(32),
        index: bufferReader.readUInt32(),
        script: bufferReader.readVarSlice(),
        sequence: bufferReader.readUInt32(),
      });
    }

    const voutLen = bufferReader.readVarInt();
    for (let i = 0; i < voutLen; ++i) {
      tx.outs.push({
        value: bufferReader.readUInt64(),
        script: bufferReader.readVarSlice(),
      });
    }

    tx.locktime = bufferReader.readUInt32();

    if (_NO_STRICT) return tx;
    if (bufferReader.offset !== buffer.length)
      throw new Error('Transaction has unexpected data');

    return tx;
  }

  static fromHex(hex: string): Transaction {
    return Transaction.fromBuffer(Buffer.from(hex, 'hex'), false);
  }

  static isCoinbaseHash(buffer: Buffer): boolean {
    typeforce(types.Hash256bit, buffer);
    for (let i = 0; i < 32; ++i) {
      if (buffer[i] !== 0) return false;
    }
    return true;
  }

  version: number = 2;
  time: number = Math.round(Date.now() / 1000);
  locktime: number = 0;
  ins: Input[] = [];
  outs: Output[] = [];

  isCoinbase(): boolean {
    return (
      this.ins.length === 1 && Transaction.isCoinbaseHash(this.ins[0].hash)
    );
  }

  addInput(
    hash: Buffer,
    index: number,
    sequence?: number,
    scriptSig?: Buffer,
  ): number {
    typeforce(
      types.tuple(
        types.Hash256bit,
        types.UInt32,
        types.maybe(types.UInt32),
        types.maybe(types.Buffer),
      ),
      arguments,
    );

    if (types.Null(sequence)) {
      sequence = Transaction.DEFAULT_SEQUENCE;
    }

    // Add the input and return the input's index
    return (
      this.ins.push({
        hash,
        index,
        script: scriptSig || EMPTY_SCRIPT,
        sequence: sequence as number,
      }) - 1
    );
  }

  addOutput(scriptPubKey: Buffer, value: number): number {
    typeforce(types.tuple(types.Buffer, types.Satoshi), arguments);

    // Add the output and return the output's index
    return (
      this.outs.push({
        script: scriptPubKey,
        value,
      }) - 1
    );
  }

  weight(): number {
    const base = this.byteLength();
    const total = this.byteLength();
    return base * 3 + total;
  }

  virtualSize(): number {
    return Math.ceil(this.weight() / 4);
  }

  byteLength(isGetHash: boolean = false): number {
    return (
      (this.version >= 2 ? 16 : 12) +
      varuint.encodingLength(this.ins.length) +
      varuint.encodingLength(this.outs.length) +
      this.ins.reduce((sum, input) => {
        return sum + 40 + (this.version >= 2 && isGetHash && !this.isCoinbase() ? 1 : varSliceSize(input.script));
      }, 0) +
      this.outs.reduce((sum, output) => {
        return sum + 8 + varSliceSize(output.script);
      }, 0)
    );
  }

  clone(): Transaction {
    const newTx = new Transaction();
    newTx.version = this.version;
    newTx.time = this.time;
    newTx.locktime = this.locktime;

    newTx.ins = this.ins.map(txIn => {
      return {
        hash: txIn.hash,
        index: txIn.index,
        script: txIn.script,
        sequence: txIn.sequence,
      };
    });

    newTx.outs = this.outs.map(txOut => {
      return {
        script: txOut.script,
        value: txOut.value,
      };
    });

    return newTx;
  }

  /**
   * Hash transaction for signing a specific input.
   *
   * Bitcoin uses a different hash for each signed transaction input.
   * This method copies the transaction, makes the necessary changes based on the
   * hashType, and then hashes the result.
   * This hash can then be used to sign the provided transaction input.
   */
  hashForSignature(
    inIndex: number,
    prevOutScript: Buffer,
    hashType: number,
  ): Buffer {
    typeforce(
      types.tuple(types.UInt32, types.Buffer, /* types.UInt8 */ types.Number),
      arguments,
    );

    // https://github.com/bitcoin/bitcoin/blob/master/src/test/sighash_tests.cpp#L29
    if (inIndex >= this.ins.length) return ONE;

    // ignore OP_CODESEPARATOR
    const ourScript = bscript.compile(
      bscript.decompile(prevOutScript)!.filter(x => {
        return x !== opcodes.OP_CODESEPARATOR;
      }),
    );

    const txTmp = this.clone();

    // SIGHASH_NONE: ignore all outputs? (wildcard payee)
    if ((hashType & 0x1f) === Transaction.SIGHASH_NONE) {
      txTmp.outs = [];

      // ignore sequence numbers (except at inIndex)
      txTmp.ins.forEach((input, i) => {
        if (i === inIndex) return;

        input.sequence = 0;
      });

      // SIGHASH_SINGLE: ignore all outputs, except at the same index?
    } else if ((hashType & 0x1f) === Transaction.SIGHASH_SINGLE) {
      // https://github.com/bitcoin/bitcoin/blob/master/src/test/sighash_tests.cpp#L60
      if (inIndex >= this.outs.length) return ONE;

      // truncate outputs after
      txTmp.outs.length = inIndex + 1;

      // "blank" outputs before
      for (let i = 0; i < inIndex; i++) {
        (txTmp.outs as any)[i] = BLANK_OUTPUT;
      }

      // ignore sequence numbers (except at inIndex)
      txTmp.ins.forEach((input, y) => {
        if (y === inIndex) return;

        input.sequence = 0;
      });
    }

    // SIGHASH_ANYONECANPAY: ignore inputs entirely?
    if (hashType & Transaction.SIGHASH_ANYONECANPAY) {
      txTmp.ins = [txTmp.ins[inIndex]];
      txTmp.ins[0].script = ourScript;

      // SIGHASH_ALL: only ignore input scripts
    } else {
      // "blank" others input scripts
      txTmp.ins.forEach(input => {
        input.script = EMPTY_SCRIPT;
      });
      txTmp.ins[inIndex].script = ourScript;
    }

    // serialize and hash
    const buffer: Buffer = Buffer.allocUnsafe(txTmp.byteLength() + 4);
    buffer.writeInt32LE(hashType, buffer.length - 4);
    txTmp.__toBuffer(false, buffer, 0);

    return bcrypto.hash256(buffer);
  }

  getHash(): Buffer {
    const buffer = this.__toBuffer(true, undefined, undefined)
    return bcrypto.hash256(buffer);
  }

  getId(): string {
    // transaction hash's are displayed in reverse order
    return reverseBuffer(this.getHash()).toString('hex');
  }

  toBuffer(buffer?: Buffer, initialOffset?: number): Buffer {
    return this.__toBuffer(false, buffer, initialOffset);
  }

  toHex(): string {
    return this.toBuffer(undefined, undefined).toString('hex');
  }

  setInputScript(index: number, scriptSig: Buffer): void {
    typeforce(types.tuple(types.Number, types.Buffer), arguments);

    this.ins[index].script = scriptSig;
  }

  private __toBuffer(isGetHash: boolean, buffer?: Buffer, initialOffset?: number): Buffer {
    if (isGetHash || !buffer) buffer = Buffer.allocUnsafe(this.byteLength(isGetHash)) as Buffer;

    const bufferWriter = new BufferWriter(buffer, initialOffset || 0);

    bufferWriter.writeInt32(this.version);

    if (this.version >= 2) {
      bufferWriter.writeUInt64(this.time);
    } else {
      bufferWriter.writeUInt32(this.time);
    }

    bufferWriter.writeVarInt(this.ins.length);

    this.ins.forEach(txIn => {
      bufferWriter.writeSlice(txIn.hash);
      bufferWriter.writeUInt32(txIn.index);
      if (this.version >= 2 && isGetHash && !this.isCoinbase()) {
        bufferWriter.writeUInt8(0);
      } else {
        bufferWriter.writeVarSlice(txIn.script);
      }
      bufferWriter.writeUInt32(txIn.sequence);
    });

    bufferWriter.writeVarInt(this.outs.length);
    this.outs.forEach(txOut => {
      if (isOutput(txOut)) {
        bufferWriter.writeUInt64(txOut.value);
      } else {
        bufferWriter.writeSlice((txOut as any).valueBuffer);
      }

      bufferWriter.writeVarSlice(txOut.script);
    });

    bufferWriter.writeUInt32(this.locktime);

    // avoid slicing unless necessary
    if (initialOffset !== undefined)
      return buffer.slice(initialOffset, bufferWriter.offset);
    return buffer;
  }
}
