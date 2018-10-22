import fs from 'fs';
import grpc, { ClientReadableStream } from 'grpc';
import { EventEmitter } from 'events';
import Logger from '../Logger';
import Errors from '../consts/Errors';
import LightningClient from './LightningClient';
import * as lndrpc from '../proto/lndrpc_pb';
import { LightningClient as GrpcClient } from '../proto/lndrpc_grpc_pb';

// TODO: error handling

/** The configurable options for the lnd client. */
type LndConfig = {
  host: string;
  port: number;
  certpath: string;
  macaroonpath?: string;
};

enum ClientStatus {
  Disconnected,
  Connected,
  OutOfSync,
}

/** General information about the state of this lnd client. */
type Info = {
  version?: string;
  syncedtochain?: boolean;
  chainsList?: string[];
  channels?: ChannelCount;
  blockheight?: number;
  uris?: string[];
  error?: string;
};

type ChannelCount = {
  active: number,
  inactive?: number,
  pending: number,
};

interface GrpcResponse {
  toObject: Function;
}

interface LightningMethodIndex extends GrpcClient {
  [methodName: string]: Function;
}

interface LndClient {
  on(event: 'invoice.settled', listener: (rHash: string) => void): this;
  emit(event: 'invoice.settled', rHash: string);
}

/** A class representing a client to interact with lnd. */
class LndClient extends EventEmitter implements LightningClient {
  public static readonly serviceName = 'LND';
  private status = ClientStatus.Disconnected;
  private readonly disconnectedError = Errors.IS_DISCONNECTED(LndClient.serviceName);
  private reconnectionTimer?: NodeJS.Timer;

  private uri!: string;
  private credentials!: grpc.ChannelCredentials;

  private lightning!: GrpcClient | LightningMethodIndex;
  private meta!: grpc.Metadata;
  private invoiceSubscription?: ClientReadableStream<lndrpc.InvoiceSubscription>;

  private static RECONNECT_TIMER = 5000;
  /**
   * Create an lnd client.
   * @param config the lnd configuration
   */
  constructor(private logger: Logger, config: LndConfig) {
    super();

    const { host, port, certpath, macaroonpath } = config;

    if (fs.existsSync(certpath)) {
      this.uri = `${host}:${port}`;

      const lndCert = fs.readFileSync(certpath);
      this.credentials = grpc.credentials.createSsl(lndCert);

      this.meta = new grpc.Metadata();

      if (macaroonpath) {
        if (fs.existsSync(macaroonpath)) {
          const adminMacaroon = fs.readFileSync(macaroonpath);
          this.meta.add('macaroon', adminMacaroon.toString('hex'));
        } else {
          this.throwFilesNotFound();
        }
      }

      // this.lightning = new GrpcClient(uri, credentials);
    } else {
      this.throwFilesNotFound();
    }
  }

  private throwFilesNotFound = () => {
    this.logger.error('could not find required files for LND');
    throw(this.disconnectedError);
  }

  public connect = async () => {
    if (this.isDisconnected()){
      this.lightning = new GrpcClient(this.uri, this.credentials);

      try {
        const response = await this.getInfo();
        if(response.syncedToChain) {
          this.setClientStatus(ClientStatus.Connected);
          this.subscribeInvoices();
          if (this.reconnectionTimer) {
            clearTimeout(this.reconnectionTimer);
            this.reconnectionTimer = undefined;
          }
        } else {
          this.setClientStatus(ClientStatus.OutOfSync);
          this.logger.error(`lnd at ${this.uri} is out of sync with chain, retrying in ${LndClient.RECONNECT_TIMER} ms`);
          this.reconnectionTimer = setTimeout(this.connect, LndClient.RECONNECT_TIMER);
        } 
      } catch (error) {
        this.setClientStatus(ClientStatus.Disconnected);
        this.logger.error(`could not verify connection to lnd at ${this.uri}, error: ${JSON.stringify(error)},
        retrying in ${LndClient.RECONNECT_TIMER} ms`);
        this.reconnectionTimer = setTimeout(this.connect, LndClient.RECONNECT_TIMER); 
      }
    }
  }

  /** End all subscriptions and reconnection attempts. */
  public close = () => {
    if (this.invoiceSubscription) {
      this.invoiceSubscription.cancel();
    }
  }

  private unaryCall = <T, U>(methodName: string, params: T): Promise<U> => {
    return new Promise((resolve, reject) => {
      (this.lightning as LightningMethodIndex)[methodName](params, this.meta, (err: grpc.ServiceError, response: GrpcResponse) => {
        if (err) {
          reject(err);
        } else {
          resolve(response.toObject());
        }
      });
    });
  }

  public getLndInfo = async (): Promise<Info> => {
    let channels: ChannelCount | undefined;
    let chainsList: string[] | undefined;
    let blockheight: number | undefined;
    let uris: string[] | undefined;
    let version: string | undefined;
    let syncedtochain: boolean | undefined;
    try {
      const lnd = await this.getInfo();
      channels = {
        active: lnd.numActiveChannels,
        pending: lnd.numPendingChannels,
      };
      chainsList = lnd.chainsList,
      blockheight = lnd.blockHeight,
      uris = lnd.urisList,
      version = lnd.version;
      syncedtochain = lnd.syncedToChain;
      return {
        version,
        syncedtochain,
        chainsList,
        channels,
        blockheight,
        uris,
      };
    } catch (err) {
      this.logger.error(`LND error: ${err}`);
      return {
        version,
        syncedtochain,
        chainsList,
        channels,
        blockheight,
        uris,
        error: err,
      };
    }
  }

  /**
   * Return general information concerning the lightning node including it’s identity pubkey, alias, the chains it
   * is connected to, and information concerning the number of open+pending channels.
   */
  public getInfo = (): Promise<lndrpc.GetInfoResponse.AsObject> => {
    return this.unaryCall<lndrpc.GetInfoRequest, lndrpc.GetInfoResponse.AsObject>('getInfo', new lndrpc.GetInfoRequest());
  }

  /**
   * Attempt to add a new invoice to the lnd invoice database.
   * @param value the value of this invoice in satoshis
   */
  public addInvoice = (value: number): Promise<lndrpc.AddInvoiceResponse.AsObject> => {
    const request = new lndrpc.Invoice();
    request.setValue(value);
    return this.unaryCall<lndrpc.Invoice, lndrpc.AddInvoiceResponse.AsObject>('addInvoice', request);
  }

  /**
   * Pay an invoice through the Lightning Network.
   * @param payment_request an invoice for a payment within the Lightning Network
   */
  public payInvoice = (paymentRequest: string): Promise<lndrpc.SendResponse.AsObject> => {
    const request = new lndrpc.SendRequest();
    request.setPaymentRequest(paymentRequest);
    return this.unaryCall<lndrpc.SendRequest, lndrpc.SendResponse.AsObject>('sendPaymentSync', request);
  }

  /**
   * Decode an encoded payment request.
   * @param paymentRequest encoded payment request
   */
  public decodePayReq = (paymentRequest: string): Promise<lndrpc.PayReq.AsObject> => {
    const request = new lndrpc.PayReqString();
    request.setPayReq(paymentRequest);
    return this.unaryCall<lndrpc.PayReqString, lndrpc.PayReq.AsObject>('decodePayReq', request);
  }

  /**
   * Establish a connection to a remote peer
   * @param pubKey identity public key of the remote peer
   * @param host host of the remote peer
   */
  public connectPeer = (pubKey: string, host: string): Promise<lndrpc.ConnectPeerResponse.AsObject> => {
    const request = new lndrpc.ConnectPeerRequest();
    const address = new lndrpc.LightningAddress();
    address.setPubkey(pubKey);
    address.setHost(host);
    request.setAddr(address);

    return this.unaryCall<lndrpc.ConnectPeerRequest, lndrpc.ConnectPeerResponse.AsObject>('connectPeer', request);
  }

  /**
   * Creates a new address
   * @param addressType type of the address
   */
  public newAddress = (addressType = lndrpc.NewAddressRequest.AddressType.NESTED_PUBKEY_HASH): Promise<lndrpc.NewAddressResponse.AsObject> => {
    const request = new lndrpc.NewAddressRequest();
    request.setType(addressType);

    return this.unaryCall<lndrpc.NewAddressRequest, lndrpc.NewAddressResponse.AsObject>('newAddress', request);
  }

  /**
   * Attempts to open a channel to a remote peer
   * @param pubKey identity public key of the remote peer
   * @param fundingAmount the number of satohis the local wallet should commit
   * @param pushSat the number of satoshis that should be pushed to the remote side
   */
  public openChannel = (pubKey: string, fundingAmount: number, pushSat?: number): Promise<lndrpc.ChannelPoint.AsObject> => {
    const request = new lndrpc.OpenChannelRequest();
    request.setNodePubkeyString(pubKey);
    request.setLocalFundingAmount(fundingAmount);

    if (pushSat) {
      request.setPushSat(pushSat);
    }

    return this.unaryCall<lndrpc.OpenChannelRequest, lndrpc.ChannelPoint.AsObject>('openChannelSync', request);
  }

  /**
   * Subscribe to events for when invoices are settled.
   */
  private subscribeInvoices = (): void => {
    this.invoiceSubscription = this.lightning.subscribeInvoices(new lndrpc.InvoiceSubscription(), this.meta)
      .on('data', (invoice: lndrpc.Invoice) => {
        this.logger.info(`invoice update: ${invoice.getRHash_asB64()}`);

        if (invoice.getSettled()) {
          this.emit('invoice.settled', String(invoice.getRHash_asB64()));
        }
      })
      .on('error', (error) => {
        if (error.message !== '1 CANCELLED: Cancelled') {
          this.logger.error(`Invoice subscription ended: ${error}`);
        }
      });
  }
  public setClientStatus = (status: ClientStatus): void => {
    this.status = status;
  }

  public isConnected(): boolean {
    return this.status === ClientStatus.Connected;
  }
  public isDisconnected(): boolean {
    return this.status === ClientStatus.Disconnected;
  }
  public isOutOfSync(): boolean {
    return this.status === ClientStatus.OutOfSync;
  }
}

export default LndClient;
export { LndConfig, Info };
