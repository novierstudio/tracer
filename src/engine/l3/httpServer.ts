import { serverServices } from '@/model/defaults';
import { runsIotServer } from '@/model/iot';
import type { HttpResponse } from '../http';
import { TCP_PORT, type TcpPayload } from '../tcp';
import type { IpContext } from './context';
import { iotPage } from './iotPage';
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

/**
 * Whether this device's HTTP service listens on `port`: on port 80, a server with HTTP on, or a
 * Home Gateway, which serves its IoT page.
 */
export const httpListening = (ctx: IpContext, port: number) =>
  port === TCP_PORT.http &&
  ((ctx.device.kind === 'server' && serverServices(ctx.device.config).http.enabled) ||
    runsIotServer(ctx.device));

/**
 * A request arrived on a connection to the HTTP service: answer it, then close, as HTTP/1.0 did.
 * A device running the IoT service answers with its IoT pages, as Packet Tracer's do.
 */
export function onHttpRequest(ctx: IpContext, connection: TcpConnection, message: TcpPayload) {
  if (message.kind !== 'http' || message.type !== 'request') return;
  if (runsIotServer(ctx.device)) {
    tcpSend(ctx, connection, iotPage(ctx, connection.remote, message.path));
    tcpClose(ctx, connection);
    return;
  }
  if (ctx.device.kind !== 'server') return;
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
