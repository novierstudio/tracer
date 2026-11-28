// No runtime imports: the simulation worker uses these, and must not pull in zod.
import type {
  DhcpLease,
  HostConfig,
  LabSettings,
  ServerConfig,
  ServerServices,
  StoredFile,
  Topology,
} from './topology';

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

/** Every service, each one set: what `serverServices` gives. */
export type FullServerServices = Required<ServerServices>;

/** A server's clock when a simulation starts, unless its NTP service sets another. */
export const DEFAULT_NTP_EPOCH = Date.UTC(2026, 0, 1);

/**
 * A server as it ships, as in Packet Tracer: HTTP, TFTP, FTP, email, NTP and syslog on, DNS off.
 * FTP has one account, `cisco` with password `cisco`, that may do everything.
 */
export const DEFAULT_SERVER_SERVICES: FullServerServices = {
  dns: { enabled: false, records: [] },
  http: { enabled: true, indexHtml: DEFAULT_INDEX_HTML },
  tftp: { enabled: true, files: [] },
  ftp: {
    enabled: true,
    users: [
      {
        username: 'cisco',
        password: 'cisco',
        permissions: { write: true, read: true, delete: true, rename: true, list: true },
      },
    ],
    files: [],
  },
  email: { smtp: true, pop3: true, domain: '', users: [] },
  ntp: { enabled: true, epoch: DEFAULT_NTP_EPOCH },
  syslog: { enabled: true },
};

/** The services a server runs, with the factory ones for any its config leaves out. */
export const serverServices = (config: ServerConfig): FullServerServices => ({
  ...DEFAULT_SERVER_SERVICES,
  ...config.services,
});

/**
 * The IOS images a TFTP or FTP server lists before anything is uploaded, as Packet Tracer's do,
 * with their sizes in bytes. They are names only: nothing can download one.
 */
export const SERVER_IMAGES: readonly { readonly name: string; readonly size: number }[] = [
  { name: 'asa842-k8.bin', size: 5571584 },
  { name: 'asa923-k8.bin', size: 30468096 },
  { name: 'c1841-advipservicesk9-mz.124-15.T1.bin', size: 33591768 },
  { name: 'c1841-ipbase-mz.123-14.T7.bin', size: 13832032 },
  { name: 'c1841-ipbasek9-mz.124-12.bin', size: 16599160 },
  { name: 'c1900-universalk9-mz.SPA.155-3.M4a.bin', size: 33591768 },
  { name: 'c2600-advipservicesk9-mz.124-15.T1.bin', size: 33591768 },
  { name: 'c2600-i-mz.122-28.bin', size: 5571584 },
  { name: 'c2600-ipbasek9-mz.124-8.bin', size: 13169700 },
  { name: 'c2800nm-advipservicesk9-mz.124-15.T1.bin', size: 50938004 },
  { name: 'c2800nm-advipservicesk9-mz.151-4.M4.bin', size: 33591768 },
  { name: 'c2800nm-ipbase-mz.123-14.T7.bin', size: 5571584 },
  { name: 'c2800nm-ipbasek9-mz.124-8.bin', size: 15522644 },
  { name: 'c2950-i6q4l2-mz.121-22.EA4.bin', size: 3058048 },
  { name: 'c2950-i6q4l2-mz.121-22.EA8.bin', size: 3117390 },
  { name: 'c2960-lanbase-mz.122-25.FX.bin', size: 4414921 },
  { name: 'c2960-lanbase-mz.122-25.SEE1.bin', size: 4670455 },
  { name: 'c2960-lanbasek9-mz.150-2.SE4.bin', size: 4670455 },
  { name: 'c3560-advipservicesk9-mz.122-37.SE1.bin', size: 8662192 },
  { name: 'c3560-advipservicesk9-mz.122-46.SE.bin', size: 10713279 },
  { name: 'pt1000-i-mz.122-28.bin', size: 5571584 },
  { name: 'pt3000-i6q4l2-mz.121-22.EA4.bin', size: 3117390 },
];

/** The text file every PC's disk ships with, as in Packet Tracer. */
export const SAMPLE_FILE: StoredFile = {
  name: 'sampleFile.txt',
  content: 'This is a sample text file',
};

/** The files on a host's disk, with the one it ships with for a host whose config names none. */
export const hostFiles = (config: HostConfig): readonly StoredFile[] =>
  config.files ?? [SAMPLE_FILE];
