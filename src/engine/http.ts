/**
 * An HTTP/1.1 message, as plain data. A client sends one GET and the server answers it, then
 * closes the connection, as `Connection: close` asks. The wire text derives from these fields.
 */
export type HttpMessage = HttpRequest | HttpResponse;

export type HttpRequest = {
  readonly kind: 'http';
  readonly type: 'request';
  readonly method: 'GET';
  /** The path and query, such as `/` or `/index.html`. */
  readonly path: string;
  /** The `Host` header: the name the user typed, or the address when they typed one. */
  readonly host: string;
};

export type HttpResponse = {
  readonly kind: 'http';
  readonly type: 'response';
  readonly status: number;
  readonly reason: string;
  readonly contentType: string;
  readonly body: string;
};

const encoder = new TextEncoder();

/** How many bytes `text` takes as UTF-8, which is what HTTP and TCP count. */
export const byteLength = (text: string) => encoder.encode(text).length;

/** The message as it goes on the wire: start line, headers, a blank line, then the body. */
export function httpText(message: HttpMessage): string {
  const lines =
    message.type === 'request'
      ? [`${message.method} ${message.path} HTTP/1.1`, `Host: ${message.host}`, 'Connection: close']
      : [
          `HTTP/1.1 ${message.status} ${message.reason}`,
          `Content-Type: ${message.contentType}`,
          `Content-Length: ${byteLength(message.body)}`,
          'Connection: close',
        ];
  const body = message.type === 'response' ? message.body : '';
  return `${lines.join('\r\n')}\r\n\r\n${body}`;
}
