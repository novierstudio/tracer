import type { IosDevice } from '@/cli';
import { err, Hostname, ok } from '@/model';
import { Button } from '@/ui/button';
import {
  ConfigSection,
  IosPreview,
  SettingRow,
  TextSetting,
  Toggle,
  useInstantCommit,
} from './controls';
import { useSectionIos } from './ios';
import {
  bannerLines,
  domainLookupLines,
  enableSecretLines,
  hostnameLines,
  passwordEncryptionLines,
} from './lines';

export function GeneralSection({ device }: { device: IosDevice }) {
  const { config } = device;
  const ios = useSectionIos(device.id);
  const instant = useInstantCommit(ios);
  const hasSecret = config.enableSecret !== undefined;

  return (
    <ConfigSection title="General">
      <TextSetting
        label="Hostname"
        value={config.hostname}
        mono
        ios={ios}
        plan={(text) => {
          const parsed = Hostname.safeParse(text.trim());
          if (!parsed.success) return err(parsed.error.issues[0]?.message ?? 'Invalid hostname');
          return ok(parsed.data === config.hostname ? [] : hostnameLines(parsed.data));
        }}
      />
      <TextSetting
        label="Banner MOTD"
        value={config.bannerMotd ?? ''}
        multiline
        placeholder="Authorised access only"
        ios={ios}
        plan={(text) => {
          const banner = text
            .split('\n')
            .map((row) => row.trimEnd())
            .join('\n')
            .replace(/^\n+|\n+$/g, '');
          if (banner === (config.bannerMotd ?? '')) return ok([]);
          if (banner === '' && config.bannerMotd === undefined) return ok([]);
          return ok(bannerLines(banner));
        }}
      />
      <TextSetting
        label="Enable secret"
        value=""
        placeholder={hasSecret ? 'Set · type to replace' : 'Not set'}
        ios={ios}
        plan={(text) => {
          if (text === '') return ok([]);
          if (/^\s|\s$/.test(text)) return err('The secret cannot start or end with a space');
          return ok(enableSecretLines(text));
        }}
        aside={
          hasSecret && (
            <Button
              size="sm"
              variant="ghost"
              className="px-2"
              onClick={() => instant.run(enableSecretLines(undefined))}
            >
              Remove
            </Button>
          )
        }
      />
      <SettingRow label="Encrypt passwords" error={instant.error}>
        <span className="flex h-7 items-center">
          <Toggle
            label="Encrypt passwords"
            title="service password-encryption"
            checked={config.servicePasswordEncryption}
            onChange={(on) => instant.run(passwordEncryptionLines(on))}
          />
        </span>
      </SettingRow>
      <SettingRow label="Domain lookup">
        <span className="flex h-7 items-center">
          <Toggle
            label="Domain lookup"
            title="ip domain-lookup"
            checked={config.domainLookup}
            onChange={(on) => instant.run(domainLookupLines(on))}
          />
        </span>
      </SettingRow>
      <IosPreview ios={ios} hostname={config.hostname} />
    </ConfigSection>
  );
}
