import type { Bytes, Text, Struct, Result, Null, Vec, u8 } from '@polkadot/types';
import type { Codec, IEnum, Registry, ISubmittableResult } from '@polkadot/types/types';
import type { SubmittableExtrinsic } from '@polkadot/api/submittable/types';
import type { AccountId, ContractExecResult, EventRecord } from '@polkadot/types/interfaces';
import type { ApiPromise } from '@polkadot/api';
import type { ApiBase } from '@polkadot/api/base';
import type { AbiMessage, ContractOptions, ContractCallOutcome, DecodedEvent } from '@polkadot/api-contract/types';
import type { ContractCallResult, ContractCallSend, MessageMeta } from '@polkadot/api-contract/base/types';
import type { DecorateMethod } from '@polkadot/api/types';

import type { OnChainRegistry } from '../OnChainRegistry';
import type { AbiLike } from '../types';
import type { CertificateData } from '../certificate';

import { Abi } from '@polkadot/api-contract/Abi';
import { toPromiseMethod } from '@polkadot/api';
import { ContractSubmittableResult } from '@polkadot/api-contract/base/Contract';
import { applyOnEvent } from '@polkadot/api-contract/util';
import { withMeta, convertWeight } from '@polkadot/api-contract/base/util'
import { BN, BN_ZERO, hexAddPrefix, u8aToHex, hexToU8a } from '@polkadot/util';
import { sr25519Agree, sr25519KeypairFromSeed } from "@polkadot/wasm-crypto";
import { from } from 'rxjs';

import { encrypt } from "../lib/aes-256-gcm";
import { randomHex } from "../lib/hex";
import assert from '../lib/assert';
import { pinkQuery } from '../pinkQuery';


export type PinkContractCallOutcome<ResultType> = {
  output: ResultType
} & Omit<ContractCallOutcome, 'output'>;

export interface ILooseResult<O, E extends Codec = Codec> extends IEnum {
    readonly asErr: E;
    readonly asOk: O;
    readonly isErr: boolean;
    readonly isOk: boolean;
}

export interface PinkContractQuery<TParams extends Array<any> = any[], DefaultResultType = Codec, DefaultErrType extends Codec = Codec> extends MessageMeta {
  <ResultType = DefaultResultType, ErrType extends Codec = DefaultErrType>(origin: string | AccountId | Uint8Array, options: PinkContractQueryOptions, ...params: TParams): ContractCallResult<
    'promise', PinkContractCallOutcome<ILooseResult<ResultType, ErrType>>
  >;
}

export interface MapMessageInkQuery {
  [message: string]: PinkContractQuery;
}

export interface PinkContractTx<TParams extends Array<any> = any[]> extends MessageMeta {
    (options: ContractOptions, ...params: TParams): SubmittableExtrinsic<'promise'>;
}

export interface MapMessageTx {
    [message: string]: PinkContractTx;
}

export interface PinkContractQueryOptions {
  cert: CertificateData
  salt?: string
  estimating?: boolean
  deposit?: number | bigint | BN | string
  transfer?: number | bigint | BN | string
}

class PinkContractSubmittableResult extends ContractSubmittableResult {

  readonly #registry: OnChainRegistry

  #isFinalized: boolean = false

  constructor(registry: OnChainRegistry, result: ISubmittableResult, contractEvents?: DecodedEvent[]) {
    super(result, contractEvents)
    this.#registry = registry
  }

  async waitFinalized(timeout: number = 120_000) {
    if (this.#isFinalized) {
      return
    }

    if (this.isInBlock || this.isFinalized) {
      const codeHash = this.status.asInBlock.toString()
      const block = await this.#registry.api.rpc.chain.getBlock(codeHash)
      const chainHeight = block.block.header.number.toNumber()

      const t0 = new Date().getTime();
      while (true) {
        const result = await this.#registry.phactory.getInfo({})
        if (result.blocknum > chainHeight) {
          this.#isFinalized = true
          return
        }

        const t1 = new Date().getTime();
        if (t1 - t0 > timeout) {
          throw new Error('Timeout')
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    throw new Error('Contract transaction submit failed.')
  }
}

interface InkQueryOk extends IEnum {
    readonly isInkMessageReturn: boolean;
    readonly asInkMessageReturn: Vec<u8>;
}

interface InkQueryError extends IEnum {
    readonly isBadOrigin: boolean;
    readonly asBadOrigin: Null;

    readonly isRuntimeError: boolean;
    readonly asRuntimeError: Text;

    readonly isSidevmNotFound: boolean;
    readonly asSidevmNotFound: Null;

    readonly isNoResponse: boolean;
    readonly asNoResponse: Null;

    readonly isServiceUnavailable: boolean;
    readonly asServiceUnavailable: Null;

    readonly isTimeout: boolean;
    readonly asTimeout: Null;
}

interface InkResponse extends Struct {
    nonce: Text
    result: Result<InkQueryOk, InkQueryError>
}


function createQuery(
    meta: AbiMessage,
    fn: (origin: string | AccountId | Uint8Array, options: PinkContractQueryOptions, params: unknown[]) => ContractCallResult<'promise', ContractCallOutcome>
): PinkContractQuery {
  return withMeta(meta, (origin: string | AccountId | Uint8Array, options: PinkContractQueryOptions, ...params: unknown[]): ContractCallResult<'promise', ContractCallOutcome> =>
    fn(origin, options, params)
  );
}

function createTx(meta: AbiMessage, fn: (options: ContractOptions, params: unknown[]) => SubmittableExtrinsic<'promise'>): PinkContractTx {
  return withMeta(meta, (options: ContractOptions, ...params: unknown[]): SubmittableExtrinsic<'promise'> =>
    fn(options, params)
  );
}

function createEncryptedData(pk: Uint8Array, data: string, agreementKey: Uint8Array) {
  const iv = hexAddPrefix(randomHex(12));
  return {
    iv,
    pubkey: u8aToHex(pk),
    data: hexAddPrefix(encrypt(data, agreementKey, hexToU8a(iv))),
  };
};

export class PinkContractPromise<TQueries extends Record<string, PinkContractQuery> = Record<string, PinkContractQuery>, TTransactions extends Record<string, PinkContractTx> = Record<string, PinkContractTx>> {

  readonly abi: Abi;
  readonly api: ApiBase<'promise'>;
  readonly address: AccountId;
  readonly contractKey: string;
  readonly phatRegistry: OnChainRegistry;

  protected readonly _decorateMethod: DecorateMethod<'promise'>;

  readonly #query: MapMessageInkQuery = {};
  readonly #tx: MapMessageTx = {};

  constructor (api: ApiBase<'promise'>, phatRegistry: OnChainRegistry, abi: AbiLike, address: string | AccountId, contractKey: string) {
    if (!api || !api.isConnected || !api.tx) {
      throw new Error('Your API has not been initialized correctly and is not connected to a chain');
    }
    if (!phatRegistry.isReady()) {
      throw new Error('Your phatRegistry has not been initialized correctly.');
    }

    this.abi = abi instanceof Abi
      ? abi
      : new Abi(abi, api.registry.getChainProperties());
    this.api = api;
    this._decorateMethod = toPromiseMethod;
    this.phatRegistry = phatRegistry

    this.address = this.registry.createType('AccountId', address);
    this.contractKey = contractKey

    this.abi.messages.forEach((m): void => {
      if (m.isMutating) {
        this.#tx[m.method] = createTx(m, (o, p) => this.#inkCommand(m, o, p));
        this.#query[m.method] = createQuery(m, (f, c, p) => this.#inkQuery(true, m, c, p).send(f));
      } else {
        this.#query[m.method] = createQuery(m, (f, c, p) => this.#inkQuery(false, m, c, p).send(f));
      }
    });
  }

  public get registry (): Registry {
    return this.api.registry;
  }

  public get query (): (TQueries & { [k in keyof TTransactions]: PinkContractQuery }) {
    return this.#query as (TQueries & { [k in keyof TTransactions]: PinkContractQuery });
  }

  public get tx (): TTransactions {
    return this.#tx as TTransactions;
  }

  #inkQuery = (isEstimating: boolean, messageOrId: AbiMessage | string | number, options: PinkContractQueryOptions, params: unknown[]): ContractCallSend<'promise'> => {
    const message = this.abi.findMessage(messageOrId);
    const api = this.api as ApiPromise

    if (!options.cert) {
      throw new Error('You need to provide the `cert` parameter in the options to process a Phat Contract query. Please check the document for a more detailed code snippet: https://www.npmjs.com/package/@phala/sdk')
    }

    const { cert } = options

    // Generate a keypair for encryption
    // NOTE: each instance only has a pre-generated pair now, it maybe better to generate a new keypair every time encrypting
    const seed = hexToU8a(hexAddPrefix(randomHex(32)));
    const pair = sr25519KeypairFromSeed(seed);
    const [sk, pk] = [pair.slice(0, 64), pair.slice(64)];

    const queryAgreementKey = sr25519Agree(
      hexToU8a(hexAddPrefix(this.phatRegistry.remotePubkey)),
      sk
    );

    const inkQueryInternal = async (origin: string | AccountId | Uint8Array): Promise<ContractCallOutcome> => {

      if (typeof origin === 'string') {
        assert(origin === cert.address, 'origin must be the same as the certificate address')
      } else if (origin.hasOwnProperty('verify') && origin.hasOwnProperty('adddress')) {
        throw new Error('Contract query expected AccountId as first parameter but since we got signer object here.')
      } else {
        assert(origin.toString() === cert.address, 'origin must be the same as the certificate address')
      }

      const payload = api.createType("InkQuery", {
        head: {
          nonce: hexAddPrefix(randomHex(32)),
          id: this.address,
        },
        data: {
          InkMessage: {
            payload: message.toU8a(params),
            deposit: options.deposit || 0,
            transfer: options.transfer || 0,
            estimating: (options.estimating !== undefined) ? (!!options.estimating) : isEstimating,
          }
        },
      });
      const data = await pinkQuery(this.phatRegistry.phactory, pk, queryAgreementKey, payload.toHex(), cert);
      const inkResponse = api.createType<InkResponse>("InkResponse", data)
      if (inkResponse.result.isErr) {
        // @FIXME: not sure this is enough as not yet tested
        throw new Error(`InkResponse Error: ${inkResponse.result.asErr.toString()}`)
      }
      if (!inkResponse.result.asOk.isInkMessageReturn) {
        // @FIXME: not sure this is enough as not yet tested
        throw new Error(`Unexpected InkMessageReturn: ${inkResponse.result.asOk.toJSON()?.toString()}`)
      }
      const { debugMessage, gasConsumed, gasRequired, result, storageDeposit } = api.createType<ContractExecResult>(
        "ContractExecResult",
        inkResponse.result.asOk.asInkMessageReturn.toString()
      );
      return {
        debugMessage: debugMessage,
        gasConsumed: gasConsumed,
        gasRequired: gasRequired && !convertWeight(gasRequired).v1Weight.isZero() ? gasRequired : gasConsumed,
        output: result.isOk && message.returnType
          ? this.abi.registry.createTypeUnsafe(message.returnType.lookupName || message.returnType.type, [result.asOk.data.toU8a(true)], { isPedantic: true })
          : null,
        result,
        storageDeposit
      }
    }

    return {
      send: this._decorateMethod((origin: string | AccountId | Uint8Array) => from(inkQueryInternal(origin)))
    };
  };

  #inkCommand = (messageOrId: AbiMessage | string | number, { gasLimit = BN_ZERO, storageDepositLimit = null, value = BN_ZERO }: ContractOptions, params: unknown[]): SubmittableExtrinsic<'promise'> => {
    const api = this.api as ApiPromise

    // Generate a keypair for encryption
    // NOTE: each instance only has a pre-generated pair now, it maybe better to generate a new keypair every time encrypting
    const seed = hexToU8a(hexAddPrefix(randomHex(32)));
    const pair = sr25519KeypairFromSeed(seed);
    const [sk, pk] = [pair.slice(0, 64), pair.slice(64)];

    const commandAgreementKey = sr25519Agree(hexToU8a(this.contractKey), sk);

    const inkCommandInternal = (dest: AccountId, value: BN, gas: { refTime: BN }, storageDepositLimit: BN | undefined, encParams: Uint8Array) => {
      // @ts-ignore
      const payload = api.createType("InkCommand", {
        InkMessage: {
          nonce: hexAddPrefix(randomHex(32)),
          // FIXME: unexpected u8a prefix
          message: api.createType("Vec<u8>", encParams).toHex(),
          transfer: value,
          gasLimit: gas.refTime,
          storageDepositLimit,
        },
      });
      const encodedPayload = api
        .createType("CommandPayload", {
          encrypted: createEncryptedData(pk, payload.toHex(), commandAgreementKey),
        })
        .toHex();
      let deposit = new BN(0);
      const gasFee = new BN(gas.refTime).mul(this.phatRegistry.gasPrice);
      deposit = new BN(value).add(gasFee).add(new BN(storageDepositLimit || 0));

      return api.tx.phalaPhatContracts.pushContractMessage(
        dest,
        encodedPayload,
        deposit
      );
    }

    return inkCommandInternal(
      this.address,
      // @ts-ignore
      value,
      convertWeight(gasLimit).v2Weight,
      storageDepositLimit,
      this.abi.findMessage(messageOrId).toU8a(params)
    ).withResultTransform((result: ISubmittableResult) => {
      return new PinkContractSubmittableResult(
        this.phatRegistry,
        result,
        applyOnEvent(result, ['ContractEmitted', 'ContractExecution'], (records: EventRecord[]) => {
          return records
            .map(({ event: { data: [, data] } }): DecodedEvent | null => {
              try {
                return this.abi.decodeEvent(data as Bytes);
              } catch (error) {
                console.error(`Unable to decode contract event: ${(error as Error).message}`);
                return null;
              }
            })
            .filter((decoded): decoded is DecodedEvent => !!decoded)
        })
      )
    });
  };
}
