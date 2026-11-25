import { expect, type Locator, type Page } from '@playwright/test';

/** The dev handle `src/features/inspector/devHandle.ts` puts on `window`, as far as these tests use it. */
type DevWindow = {
  __TRACER_DEV__?: boolean;
  tracer: {
    editorStore: {
      getState(): {
        load(topology: unknown): void;
        select(selection: { devices: string[]; links: string[] }): void;
        topology: { devices: Record<string, { config: { hostname: string } } | undefined> };
      };
    };
    parseTopology(input: unknown): { ok: true; value: unknown } | { ok: false; error: unknown };
  };
};

let macs = 0;
const mac = () =>
  `02:00:00:00:${Math.floor(++macs / 256)
    .toString(16)
    .padStart(2, '0')}:${(macs % 256).toString(16).padStart(2, '0')}`;

const ethernet = (kind: string, names: string[]) => names.map((id) => ({ kind, id, mac: mac() }));
const range = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

function router(id: string, hostname: string, x: number, console?: { password: string }) {
  const ports = ethernet('gigabitEthernet', range('GigabitEthernet0/', 0, 3));
  return {
    id,
    kind: 'router',
    model: 'router-4g',
    position: { x, y: 0 },
    powered: true,
    ports,
    config: {
      hostname,
      interfaces: Object.fromEntries(ports.map((port) => [port.id, { shutdown: true }])),
      unknownLines: [],
      ...(console && {
        lines: {
          console: {
            password: console.password,
            login: 'password',
            transportInput: { ssh: true, telnet: true },
          },
          aux: { login: 'none', transportInput: { ssh: true, telnet: true } },
          vty: Array.from({ length: 16 }, () => ({
            login: 'password',
            transportInput: { ssh: true, telnet: true },
          })),
        },
      }),
    },
  };
}

function switch24(id: string, hostname: string, x: number) {
  const ports = [
    ...ethernet('fastEthernet', range('FastEthernet0/', 1, 24)),
    ...ethernet('gigabitEthernet', range('GigabitEthernet0/', 1, 2)),
  ];
  return {
    id,
    kind: 'switch',
    model: 'switch-24',
    position: { x, y: 0 },
    powered: true,
    ports,
    config: {
      hostname,
      interfaces: Object.fromEntries(
        ports.map((port) => [
          port.id,
          { shutdown: false, switchport: { mode: 'access', vlan: 1 } },
        ]),
      ),
      vlans: { 1: { name: 'default' } },
      unknownLines: [],
    },
  };
}

/** R1 cabled to SW1, and R2 whose console line asks for the password `cisco`. */
export const LAB = {
  version: 1,
  meta: {
    name: 'Sessions',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  devices: {
    dev_R1: router('dev_R1', 'R1', 0),
    dev_SW1: switch24('dev_SW1', 'SW1', 200),
    dev_R2: router('dev_R2', 'R2', 400, { password: 'cisco' }),
  },
  links: {
    lnk_1: {
      id: 'lnk_1',
      cable: 'straight',
      a: { device: 'dev_R1', port: 'GigabitEthernet0/0' },
      b: { device: 'dev_SW1', port: 'GigabitEthernet0/1' },
    },
  },
  annotations: {},
};

/** Opens the app and waits for the canvas, which loads after the shell. */
export async function gotoCanvas(page: Page) {
  await page.goto('./');
  await expect(page.locator('.react-flow__pane')).toBeVisible();
}

export async function openLab(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as DevWindow).__TRACER_DEV__ = true;
  });
  await gotoCanvas(page);
  // Through the app's own parser, as opening a saved file does, so schema defaults apply.
  await page.evaluate((topology) => {
    const { tracer } = window as unknown as DevWindow;
    const parsed = tracer.parseTopology(topology);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    tracer.editorStore.getState().load(parsed.value);
  }, LAB);
}

export async function select(page: Page, device: string) {
  await page.evaluate((id) => {
    (window as unknown as DevWindow).tracer.editorStore
      .getState()
      .select({ devices: [id], links: [] });
  }, device);
}

export const hostnameInStore = (page: Page, device: string) =>
  page.evaluate((id) => {
    const { topology } = (window as unknown as DevWindow).tracer.editorStore.getState();
    return topology.devices[id]?.config.hostname;
  }, device);

/** One xterm on the page, found inside `scope`. */
export function terminalIn(page: Page, scope: Locator) {
  // xterm's screen-reader mode mirrors each visible row into this tree.
  const rows = async () =>
    (await scope.locator('.xterm-accessibility-tree > div').allTextContents())
      .map((row) => row.trimEnd())
      .filter(Boolean);
  const lastRow = async () => (await rows()).at(-1);
  return {
    rows,
    lastRow,
    input: scope.locator('.xterm-helper-textarea'),
    /** Types a line, presses Enter and waits for its echo and the next prompt. */
    async run(line: string, prompt: string) {
      const echo = `${await lastRow()}${line}`;
      await page.keyboard.type(line);
      await page.keyboard.press('Enter');
      await expect
        .poll(async () => {
          const shown = await rows();
          return shown.includes(echo) && shown.at(-1) === prompt;
        })
        .toBe(true);
    },
  };
}
