import { expect, test, type Page } from '@playwright/test';
import { gotoCanvas, terminalIn } from './lab';

test.use({ viewport: { width: 1440, height: 900 } });

type DevWindow = {
  __TRACER_DEV__?: boolean;
  tracer: {
    editorStore: {
      getState(): {
        select(selection: { devices: string[]; links: string[] }): void;
        topology: {
          devices: Record<string, { kind: string; config: { hostname: string } } | undefined>;
        };
      };
    };
    loadLab(input: unknown): void;
  };
};

const canvas = (page: Page) => page.getByRole('main', { name: 'Canvas' });
const device = (page: Page, hostname: string) =>
  page.getByRole('group', { name: new RegExp(`^${hostname},`) });
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' });

async function dropDevice(page: Page, name: string, x: number, y: number) {
  await page
    .getByRole('complementary', { name: 'Device palette' })
    .getByText(name, { exact: true })
    .dragTo(canvas(page), { targetPosition: { x, y } });
}

const select = (page: Page, id: string) =>
  page.evaluate((target) => {
    (window as unknown as DevWindow).tracer.editorStore
      .getState()
      .select({ devices: [target], links: [] });
  }, id);

const idOf = (page: Page, hostname: string) =>
  page.evaluate((name) => {
    const { devices } = (window as unknown as DevWindow).tracer.editorStore.getState().topology;
    return Object.entries(devices).find(([, d]) => d?.config.hostname === name)![0];
  }, hostname);

async function openApp(page: Page, hostId: string, app: RegExp) {
  await select(page, hostId);
  await inspector(page).getByRole('tab', { name: 'Desktop' }).click();
  await inspector(page).getByRole('button', { name: app }).click();
}

test('console-cables a PC to a fresh router and configures it from the Terminal app', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as unknown as DevWindow).__TRACER_DEV__ = true;
  });
  await gotoCanvas(page);
  await dropDevice(page, '1941', 520, 200);
  await dropDevice(page, 'PC-PT', 220, 420);

  await page.keyboard.press('c');
  await page
    .getByRole('radiogroup', { name: 'Cable type' })
    .getByRole('radio', { name: 'Console' })
    .click();
  // Each end has one port a console cable fits, so neither asks which.
  await device(page, 'PC0').locator('.device-tile').click();
  await device(page, 'Router0').locator('.device-tile').click();
  await expect(
    page.getByRole('group', { name: 'Console cable from PC0 RS232 to Router0 Console' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  const pc = await idOf(page, 'PC0');
  await openApp(page, pc, /^Terminal/);
  const form = inspector(page).getByRole('form', { name: 'Terminal configuration' });
  await expect(form.getByLabel('Bits Per Second:')).toHaveValue('9600');
  await form.getByRole('button', { name: 'OK' }).click();

  const terminal = terminalIn(page, inspector(page));
  await expect.poll(terminal.lastRow).toBe('Router0>');
  await terminal.input.focus();
  await terminal.run('enable', 'Router0#');
  await terminal.run('configure terminal', 'Router0(config)#');
  await terminal.run('hostname Core', 'Core(config)#');
  await terminal.run('line con 0', 'Core(config-line)#');
  await terminal.run('password cisco', 'Core(config-line)#');
  await terminal.run('login', 'Core(config-line)#');
  await terminal.run('end', 'Core#');
  await expect.poll(() => idOf(page, 'Core')).toBeTruthy();
});

test('says so when the PC has no console cable', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as DevWindow).__TRACER_DEV__ = true;
  });
  await gotoCanvas(page);
  await dropDevice(page, 'PC-PT', 220, 420);
  await openApp(page, await idOf(page, 'PC0'), /^Terminal/);
  await inspector(page).getByRole('button', { name: 'OK' }).click();
  await expect(inspector(page).getByText('No console cable')).toBeVisible();
});

const mac = (n: number) => `02:00:00:00:02:${n.toString(16).padStart(2, '0')}`;
const LINE = { transportInput: { ssh: true, telnet: true }, login: 'none' };

/** PC1 192.168.1.10 crossover-cabled to R1 Gi0/0 192.168.1.1, which takes SSH only, for admin. */
const SSH_LAB = {
  version: 1,
  meta: {
    name: 'SSH',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  devices: {
    dev_R1: {
      id: 'dev_R1',
      kind: 'router',
      model: 'router-4g',
      position: { x: 400, y: 0 },
      powered: true,
      ports: [0, 1].map((n) => ({
        kind: 'gigabitEthernet',
        id: `GigabitEthernet0/${n}`,
        mac: mac(n + 1),
      })),
      config: {
        hostname: 'R1',
        interfaces: {
          'GigabitEthernet0/0': {
            shutdown: false,
            ipv4: { address: '192.168.1.1', prefixLength: 24 },
          },
          'GigabitEthernet0/1': { shutdown: true },
        },
        domainName: 'lab.local',
        rsaModulus: 1024,
        sshVersion: 2,
        users: { admin: { privilege: 15, credential: { kind: 'password', text: 'cisco123' } } },
        lines: {
          console: LINE,
          aux: LINE,
          vty: Array.from({ length: 16 }, () => ({
            login: 'local',
            transportInput: { ssh: true, telnet: false },
          })),
        },
        unknownLines: [],
      },
    },
    dev_PC1: {
      id: 'dev_PC1',
      kind: 'pc',
      model: 'pc',
      position: { x: 0, y: 0 },
      powered: true,
      ports: [{ kind: 'fastEthernet', id: 'FastEthernet0', mac: mac(9) }],
      config: {
        hostname: 'PC1',
        ipv4: {
          mode: 'static',
          address: { address: '192.168.1.10', prefixLength: 24 },
          gateway: '192.168.1.1',
        },
      },
    },
  },
  links: {
    lnk_1: {
      id: 'lnk_1',
      cable: 'crossover',
      a: { device: 'dev_PC1', port: 'FastEthernet0' },
      b: { device: 'dev_R1', port: 'GigabitEthernet0/0' },
    },
  },
  annotations: {},
};

test('SSHes from a PC as a local user, and Telnet is refused on SSH-only vty lines', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as unknown as DevWindow).__TRACER_DEV__ = true;
  });
  await gotoCanvas(page);
  await page.evaluate((topology) => {
    (window as unknown as DevWindow).tracer.loadLab(topology);
  }, SSH_LAB);
  await openApp(page, 'dev_PC1', /^Command Prompt/);

  const prompt = terminalIn(page, inspector(page));
  await expect.poll(prompt.lastRow).toBe('C:\\>');
  await prompt.input.focus();
  await prompt.run('telnet 192.168.1.1', 'C:\\>');
  // The inspector's prompt is narrow: rows joined undo its wrapping.
  await expect
    .poll(async () => (await prompt.rows()).join(''))
    .toContain('telnet 192.168.1.1Trying 192.168.1.1 ...% Connection refused by remote hostC:\\>');

  await prompt.run('ssh -l admin 192.168.1.1', 'Password:');
  // A password is not echoed.
  await page.keyboard.type('cisco123');
  await page.keyboard.press('Enter');
  await expect.poll(prompt.lastRow).toBe('R1#');
  await prompt.run('show users', 'R1#');
  // Spaces at a wrap are lost, so compare without them.
  expect((await prompt.rows()).join('').replace(/\s+/g, '')).toContain(
    '*2vty0adminidle00:00:00192.168.1.10',
  );
  await prompt.run('exit', 'C:\\>');
  expect((await prompt.rows()).join('')).toContain(
    'R1#exit[Connection to 192.168.1.1 closed by foreign host]C:\\>',
  );
});
