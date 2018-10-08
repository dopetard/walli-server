import fs from 'fs';
import grpc, { Server } from 'grpc';
import Logger from '../Logger';
import Errors from './Errors';
import GrpcService from './GrpcService';
import Service from '../service/Service';
import { WalliService } from '../proto/wallirpc_grpc_pb';
import assert from 'assert';

type GrpcConfig = {
  host: string,
  port: number,
  certPath: string,
  keyPath: string,
};

class GrpcServer {
  private server: Server;
  private logger: Logger;
  private grpcConfig: GrpcConfig;

  constructor(logger: Logger, service: Service, grpcConfig: GrpcConfig) {
    this.server = new grpc.Server();
    this.logger = logger;
    this.grpcConfig = grpcConfig;

    const grpcService = new GrpcService(service);
    this.server.addService(WalliService, {
      getInfo: grpcService.getInfo,
      createSubmarine: grpcService.createSubmarine,
    });
  }

  public listen = async () => {
    const { port, host, certPath, keyPath } = this.grpcConfig;
    const cert = fs.readFileSync(certPath);
    const key = fs.readFileSync(keyPath);

    assert(Number.isInteger(port) && port > 1023 && port < 65536, 'port must be an integer between 1024 and 65536');
    // tslint:disable-next-line:no-null-keyword
    const serverCert = grpc.ServerCredentials.createSsl(null,
      [{
        cert_chain: cert,
        private_key: key,
      }], false);
    const bindCode = this.server.bind(`${host}:${port}`, serverCert);

    if (bindCode !== port) {
      const error = Errors.COULD_NOT_BIND(host , port.toString());
      throw(error);
    } else {
      this.server.start();
      this.logger.info(`gRPC server listening on: ${host}:${port}`);
      return true;
    }
  }

  public close = async () => {
    return new Promise((resolve) => {
      this.server.tryShutdown(() => {
        this.logger.info('GRPC server completed shutdown');
        resolve();
      });
    });
  }
}

export default GrpcServer;
export { GrpcConfig };
