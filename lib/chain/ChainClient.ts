import BaseClient from '../BaseClient';
import Logger from '../Logger';
import RpcClient, { RpcConfig } from '../RpcClient';
import { ClientStatus } from '../consts/ClientStatus';
import ChainClientInterface, { Info, Block } from './ChainClientInterface';

interface ChainClientEvents {
  on(event: 'error', listener: (error: string) => void): this;
  on(event: 'transaction.relevant', listener: (transactionHex: string) => void): this;
  emit(event: 'error', error: string): boolean;
  emit(event: 'transaction.relevant', transactionHex: string): boolean;
}

class ChainClient extends BaseClient implements ChainClientInterface, ChainClientEvents {
  private rpcClient: RpcClient;
  private uri: string;

  constructor(private logger: Logger, config: RpcConfig, public readonly symbol: string) {
    super();

    this.rpcClient = new RpcClient(config);
    this.uri = `${config.host}:${config.port}`;
    this.bindWs();
  }

  private bindWs = () => {
    this.rpcClient.on('error', error => this.emit('error', error));
    this.rpcClient.on('message.orphan', (data) => {
      if (data.method === 'relevanttxaccepted') {
        const transactions = data.params;

        transactions.forEach((transaction) => {
          this.emit('transaction.relevant', transaction);
        });
      }
    });
  }

  public connect = async () => {
    if (this.isDisconnected) {
      await this.rpcClient.connect();
      try {
        const info = await this.getInfo();
        if (info.version) {
          await this.rpcClient.connect();
          this.setClientStatus(ClientStatus.Connected);
          if (this.reconnectionTimer) {
            clearTimeout(this.reconnectionTimer);
            this.reconnectionTimer = undefined;
          }
        } else {
          this.setClientStatus(ClientStatus.Disconnected);
          this.logger.error(`${this.symbol} at ${this.uri} is not able to connect, retrying in ${this.RECONNECT_TIMER} ms`);
          this.reconnectionTimer = setTimeout(this.connect, this.RECONNECT_TIMER);
        }
      } catch (error) {
        this.setClientStatus(ClientStatus.Disconnected);
        this.logger.error(`could not verify connection to ${this.symbol} at ${this.uri}, error: ${JSON.stringify(error)},
        retrying in ${this.RECONNECT_TIMER} ms`);
        this.reconnectionTimer = setTimeout(this.connect, this.RECONNECT_TIMER);
      }
    }
  }

  public disconnect = async () => {
    await this.rpcClient.close();
    this.setClientStatus(ClientStatus.Disconnected);
  }

  public getInfo = (): Promise<Info> => {
    return this.rpcClient.call<Info>('getinfo');
  }

  public sendRawTransaction = (rawTransaction: string, allowHighFees = true): Promise<string> => {
    return this.rpcClient.call<string>('sendrawtransaction', rawTransaction, allowHighFees);
  }

  public loadTxFiler = (reload: boolean, addresses: string[], outpoints: string[]): Promise<null> => {
    // tslint:disable-next-line no-null-keyword
    return this.rpcClient.call<null>('loadtxfilter', reload, addresses, outpoints);
  }

  public getBlock = (blockHash: string): Promise<Block> => {
    return this.rpcClient.call<Block>('getblock', blockHash);
  }

  public getRawTransaction = (transactionHash: string) => {
    return this.rpcClient.call<any>('getrawtransaction', transactionHash);
  }

  public generate = (blocks: number): Promise<string[]> => {
    return this.rpcClient.call<string[]>('generate', blocks);
  }
}

export default ChainClient;
