import { serverServices } from '@/model/defaults';
import type { HttpResponse } from '../http';
import { TCP_PORT, type TcpPayload } from '../tcp';
import type { IpContext } from './context';
import { tcpClose, tcpSend } from './tcpStack';
import type { TcpConnection } from './transport';

/** The paths the server's one page answers at. */
const PAGE_PATHS = new Set(['/', '/index.html']);

const NOT_FOUND_PAGE = `<!doctype html>
<html>
  <head><title>404 Not Found</title></head>
  <body>
    <h1>Not Found</h1>
    <p>This server has only one page, at /index.html.</p>
  </body>
</html>
`;

/** Whether this device's HTTP service listens on `port`: a server with HTTP on, on port 80. */
export const httpListening = (ctx: IpContext, port: number) =>
  port === TCP_PORT.http &&
  ctx.device.kind === 'server' &&
  serverServices(ctx.device.config).http.enabled;

/** A request arrived on a connection to the HTTP service: answer it, then close, as HTTP/1.0 did. */
export function onHttpRequest(ctx: IpContext, connection: TcpConnection, message: TcpPayload) {
  if (message.type !== 'request' || ctx.device.kind !== 'server') return;
  const path = message.path.split(/[?#]/)[0]!;
  const response: HttpResponse = PAGE_PATHS.has(path)
    ? {
        kind: 'http',
        type: 'response',
        status: 200,
        reason: 'OK',
        contentType: 'text/html',
        body: serverServices(ctx.device.config).http.indexHtml,
      }
    : {
        kind: 'http',
        type: 'response',
        status: 404,
        reason: 'Not Found',
        contentType: 'text/html',
        body: NOT_FOUND_PAGE,
      };
  tcpSend(ctx, connection, response);
  tcpClose(ctx, connection);
}
