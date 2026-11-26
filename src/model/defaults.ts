// No runtime imports: the simulation worker uses these, and must not pull in zod.
import type { DhcpLease, LabSettings, ServerConfig, ServerServices, Topology } from './topology';

/** The lease IOS gives a pool with no `lease` line: one day. */
export const DEFAULT_DHCP_LEASE = 1440 as DhcpLease;

export const DEFAULT_LAB_SETTINGS: LabSettings = { stpTimers: 'fast', routingTimers: 'fast' };

/** The lab's settings, with the defaults for a lab that names none. */
export const labSettings = (topology: Topology): LabSettings =>
  topology.settings ?? DEFAULT_LAB_SETTINGS;

/** The page a new server's HTTP service serves. */
export const DEFAULT_INDEX_HTML = `<!doctype html>
<html>
  <head>
    <title>Tracer web server</title>
  </head>
  <body>
    <h1>It works!</h1>
    <p>This page is served by a Tracer server. Edit it in the server's Services tab.</p>
  </body>
</html>
`;

/** A server as it ships: HTTP on with the default page, DNS off with no records. */
export const DEFAULT_SERVER_SERVICES: ServerServices = {
  dns: { enabled: false, records: [] },
  http: { enabled: true, indexHtml: DEFAULT_INDEX_HTML },
};

/** The services a server runs, with the factory ones for a server whose config names none. */
export const serverServices = (config: ServerConfig): ServerServices =>
  config.services ?? DEFAULT_SERVER_SERVICES;
