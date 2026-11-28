import type { TftpEvent, TftpFailure } from '../../engine/api';
import type { TftpStream } from './query';

/** Why IOS says a transfer failed, in the brackets after `%Error opening`. */
function reason(why: TftpFailure): string {
  switch (why.kind) {
    case 'timeout':
      return 'Timed out';
    case 'cancelled':
      return 'Socket error';
    case 'error':
      if (why.code === 1) return 'No such file or directory';
      if (why.code === 2) return 'Permission denied';
      return why.message;
  }
}

/** `1053 bytes copied in 0.009 secs (117000 bytes/sec)`, counting at least a millisecond. */
function copied(bytes: number, elapsed: number): string {
  const millis = Math.max(Math.round(elapsed), 1);
  const rate = Math.floor((bytes * 1000) / millis);
  return `${bytes} bytes copied in ${(millis / 1000).toFixed(3)} secs (${rate} bytes/sec)`;
}

/**
 * IOS `copy` to or from TFTP, a piece at a time: what it is doing, a `!` per block, then the bytes
 * copied or why it failed. Pieces break lines with `\n`.
 */
export function tftpOutput({ request, file }: TftpStream) {
  const url = `tftp://${request.server}/${request.file}`;
  const put = request.op === 'put';
  let blocks = 0;
  return {
    head: put ? `\nWriting ${file}...` : `\nAccessing ${url}...\n`,
    /** The text for one event. `done` and `failed` end the output. */
    next(event: TftpEvent): string {
      switch (event.kind) {
        case 'block':
          blocks += 1;
          return !put && blocks === 1 ? `Loading ${request.file} from ${request.server}: !` : '!';
        case 'done':
          return `\n[OK - ${event.bytes} bytes]\n\n${copied(event.bytes, event.elapsed)}\n`;
        case 'failed':
          return `${put || blocks > 0 ? '\n' : ''}%Error opening ${url} (${reason(event.why)})\n`;
      }
    },
    /** Ends the line the marks are on. The transfer itself runs on. */
    abort: () => '\n',
  };
}
