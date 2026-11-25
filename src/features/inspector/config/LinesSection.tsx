import { useId } from 'react';
import type { IosDevice } from '@/cli';
import { err, ok, type LineConfig } from '@/model';
import {
  ConfigSection,
  IosPreview,
  Select,
  SettingRow,
  TextSetting,
  useInstantCommit,
} from './controls';
import { useSectionIos, type SectionIos } from './ios';
import { lineLines, transportOf, type LineName, type Transport } from './lines';

const LOGIN_OPTIONS: readonly [LineConfig['login'], string][] = [
  ['none', 'No login'],
  ['password', 'Line password'],
  ['local', 'Local users'],
];

const TRANSPORT_OPTIONS: readonly [Transport, string][] = [
  ['all', 'SSH and Telnet'],
  ['ssh', 'SSH only'],
  ['telnet', 'Telnet only'],
  ['none', 'None'],
];

const TRANSPORTS: Record<Transport, LineConfig['transportInput']> = {
  all: { ssh: true, telnet: true },
  ssh: { ssh: true, telnet: false },
  telnet: { ssh: false, telnet: true },
  none: { ssh: false, telnet: false },
};

const sameLine = (a: LineConfig, b: LineConfig) =>
  a.password === b.password &&
  a.login === b.login &&
  transportOf(a.transportInput) === transportOf(b.transportInput);

export function LinesSection({ device }: { device: IosDevice }) {
  const { lines } = device.config;
  const ios = useSectionIos(device.id);
  const vty = lines.vty[0]!;
  const mixed = lines.vty.some((line) => !sameLine(line, vty));
  return (
    <ConfigSection title="Lines">
      <LineGroup title="Console" name="console" line={lines.console} ios={ios} />
      <LineGroup
        title="VTY 0–15"
        name="vty"
        line={vty}
        ios={ios}
        note={
          mixed ? 'The VTY lines differ. These show line 0; a change applies to all 16.' : undefined
        }
      />
      <IosPreview ios={ios} hostname={device.config.hostname} />
    </ConfigSection>
  );
}

function LineGroup({
  title,
  name,
  line,
  ios,
  note,
}: {
  title: string;
  name: LineName;
  line: LineConfig;
  ios: SectionIos;
  note?: string;
}) {
  const instant = useInstantCommit(ios);
  const id = useId();
  const change = (patch: Partial<LineConfig>) =>
    instant.run(lineLines(name, line, { ...line, ...patch }));
  return (
    <div role="group" aria-label={title} className="flex flex-col gap-2">
      <h4 className="text-2xs font-medium text-fg-2">{title}</h4>
      {note && <p className="text-2xs text-fg-3">{note}</p>}
      <TextSetting
        label="Password"
        value={line.password ?? ''}
        mono
        placeholder="Not set"
        ios={ios}
        plan={(text) => {
          if (/^\s|\s$/.test(text)) return err('The password cannot start or end with a space');
          const password = text === '' ? undefined : text;
          if (password === line.password) return ok([]);
          const next = { ...line };
          if (password === undefined) delete next.password;
          else next.password = password;
          return ok(lineLines(name, line, next));
        }}
      />
      <SettingRow label="Login" htmlFor={`${id}-login`} error={instant.error}>
        <Select
          id={`${id}-login`}
          value={line.login}
          onChange={(event) => change({ login: event.target.value as LineConfig['login'] })}
        >
          {LOGIN_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </SettingRow>
      {name === 'vty' && (
        <SettingRow label="Transport input" htmlFor={`${id}-transport`}>
          <Select
            id={`${id}-transport`}
            value={transportOf(line.transportInput)}
            onChange={(event) =>
              change({ transportInput: TRANSPORTS[event.target.value as Transport] })
            }
          >
            {TRANSPORT_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </SettingRow>
      )}
    </div>
  );
}
