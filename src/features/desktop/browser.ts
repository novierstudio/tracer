import { DomainName, err, Ipv4Address, ok, type Result } from '@/model';
import type { BrowseTarget, FetchEvent, FetchFailure } from './backend';

const HTTP_PORT = 80;

/** A scheme such as `https:`, but not the `host:` of `www.lab.local:8080`. */
const SCHEME = /^([a-z][a-z0-9+.-]*):(?!\d)/i;

/**
 * What the address bar's text points at: `www.lab.local`, `http://www.lab.local/` or
 * `http://192.168.1.20:8080/index.html`. Only plain HTTP, since Tracer's servers speak nothing else.
 */
export function parseUrl(text: string): Result<BrowseTarget, string> {
  const input = text.trim();
  if (!input) return err('Type an address, such as www.lab.local.');
  const scheme = SCHEME.exec(input)?.[1]?.toLowerCase();
  if (scheme === 'https') {
    return err('Tracer servers speak plain HTTP. Try the address with http:// instead.');
  }
  if (scheme !== undefined && scheme !== 'http') {
    return err(`The browser opens http:// addresses only, not ${scheme}:.`);
  }
  const invalid = err(`${input} is not a web address. Try one like www.lab.local.`);
  let url: URL;
  try {
    url = new URL(scheme === undefined ? `http://${input}` : input);
  } catch {
    return invalid;
  }
  if (url.username || url.password) return invalid;
  const address = Ipv4Address.safeParse(url.hostname);
  const name = DomainName.safeParse(url.hostname);
  const host = address.success ? address.data : name.success ? name.data : undefined;
  if (host === undefined) return invalid;
  return ok({
    host,
    port: url.port ? Number(url.port) : HTTP_PORT,
    path: `${url.pathname || '/'}${url.search}`,
  });
}

/** The address bar's text for a target, as browsers show it once a page opens. */
export const formatUrl = ({ host, port, path }: BrowseTarget) =>
  `http://${host}${port === HTTP_PORT ? '' : `:${port}`}${path}`;

const withPort = (address: string, port: number) =>
  port === HTTP_PORT ? address : `${address}:${port}`;

/** The status line for a page load's step so far. */
export function loadingStatus(step: FetchEvent | undefined, target: BrowseTarget): string {
  switch (step?.kind) {
    case 'resolving':
      return `Resolving ${step.name} with DNS server ${step.server}…`;
    case 'connecting':
      return `Connecting to ${withPort(step.address, step.port)}…`;
    default:
      return `Opening ${formatUrl(target)}…`;
  }
}

/** Why a page did not load, in words a student can act on. */
export function describeFailure(failure: FetchFailure): { title: string; detail: string } {
  switch (failure.kind) {
    case 'no-dns-server':
      return {
        title: 'No DNS server',
        detail:
          'This host has no DNS server to ask for the address. Set one in IP Configuration, or type the web server’s IP address instead.',
      };
    case 'name-not-found':
      return {
        title: 'Server not found',
        detail: `The DNS server ${failure.server} has no record for ${failure.name}. Check the name, or add an A record for it on the DNS server.`,
      };
    case 'dns-timeout':
      return {
        title: 'DNS server not responding',
        detail: `${failure.server} did not answer within 2 seconds. Check that it is reachable (try ping) and that its DNS service is on.`,
      };
    case 'refused':
      return {
        title: 'Connection refused',
        detail: `${failure.address} answered, but nothing listens on port ${failure.port}. Check that its HTTP service is on.`,
      };
    case 'timeout':
      return {
        title: 'Connection timed out',
        detail: `${failure.address} did not answer. Check the cables, addresses and routes between this host and the server (try ping).`,
      };
    case 'reset':
      return {
        title: 'Connection reset',
        detail: `${failure.address} closed the connection before sending a page.`,
      };
    case 'cancelled':
      return {
        title: 'Page load stopped',
        detail: 'The device turned off, or the simulation stepped back, before the page arrived.',
      };
  }
}
