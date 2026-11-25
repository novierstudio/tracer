import { useState } from 'react';
import type { IosDevice, SwitchDevice } from '@/cli';
import { err, Ipv4Address, ok } from '@/model';
import { safeStorage } from '@/app/storage';
import type { PortRow } from '../view';
import { ConfigSection, IosPreview, TextSetting, Toggle } from './controls';
import { GeneralSection } from './GeneralSection';
import { InterfacesSection } from './InterfacesSection';
import { ShowIosContext, useSectionIos } from './ios';
import { defaultGatewayLines } from './lines';
import { LinesSection } from './LinesSection';
import { RoutesSection } from './RoutesSection';
import { VlansSection } from './VlansSection';

const SHOW_IOS_KEY = 'tracer.inspector.showIos';

/**
 * Forms for a router or switch. Each form builds IOS lines and runs them through the CLI, so the
 * forms and the console write the config the same way, and each apply is one undo step.
 */
export function IosConfigTab({ device, rows }: { device: IosDevice; rows: PortRow[] }) {
  const [showIos, setShowIos] = useState(() => safeStorage.getItem(SHOW_IOS_KEY) === 'true');
  return (
    <ShowIosContext value={showIos}>
      <label className="flex h-9 items-center justify-between gap-2 border-b border-line px-3 text-xs text-fg-2">
        Show equivalent IOS
        <Toggle
          label="Show equivalent IOS"
          checked={showIos}
          onChange={(on) => {
            setShowIos(on);
            safeStorage.setItem(SHOW_IOS_KEY, String(on));
          }}
        />
      </label>
      <GeneralSection device={device} />
      <InterfacesSection device={device} rows={rows} />
      {device.kind === 'router' ? (
        <RoutesSection device={device} />
      ) : (
        <>
          <GatewaySection device={device} />
          <VlansSection device={device} />
        </>
      )}
      <LinesSection device={device} />
      <UnknownLines lines={device.config.unknownLines} />
    </ShowIosContext>
  );
}

function GatewaySection({ device }: { device: SwitchDevice }) {
  const ios = useSectionIos(device.id);
  const current = device.config.defaultGateway;
  return (
    <ConfigSection title="Default gateway">
      <TextSetting
        label="Gateway"
        value={current ?? ''}
        mono
        placeholder="Not set"
        ios={ios}
        plan={(text) => {
          const input = text.trim();
          if (input === '') return ok(current === undefined ? [] : defaultGatewayLines(undefined));
          const parsed = Ipv4Address.safeParse(input);
          if (!parsed.success) return err('Invalid IPv4 address');
          return ok(parsed.data === current ? [] : defaultGatewayLines(parsed.data));
        }}
      />
      <p className="text-2xs text-fg-3">
        Where the switch sends its own traffic for other networks, such as SSH replies.
      </p>
      <IosPreview ios={ios} hostname={device.config.hostname} />
    </ConfigSection>
  );
}

/** Lines an import or the CLI kept verbatim because the model has no field for them. */
function UnknownLines({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <ConfigSection title={`Unrecognised lines (${lines.length})`}>
      <pre className="overflow-x-auto rounded-md bg-surface-2 p-2 font-mono text-[0.6875rem] text-fg-2">
        {lines.join('\n')}
      </pre>
    </ConfigSection>
  );
}
