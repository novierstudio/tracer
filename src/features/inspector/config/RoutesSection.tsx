import { ArrowRightIcon, XIcon } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import type { RouterDevice } from '@/cli';
import {
  err,
  Ipv4Address,
  ok,
  type InterfaceId,
  type PortId,
  type Result,
  type StaticRoute,
} from '@/model';
import { Button } from '@/ui/button';
import { Segmented } from '@/ui/segmented';
import { Field } from '../Field';
import { classfulMask, formatCidr, networkOf, parseMask } from '../ipv4';
import { Mono } from '../parts';
import { shortPortName } from '../view';
import { ConfigSection, IosPreview, Select } from './controls';
import { useSectionIos } from './ios';
import { addRouteLines, removeRouteLines, routeLine } from './lines';

type NewRoute = Pick<StaticRoute, 'prefix' | 'nextHop'>;
type Form = {
  network: string;
  mask: string;
  via: 'address' | 'interface';
  nextHop: string;
  exit: string;
};
type Errors = Partial<Record<'network' | 'mask' | 'nextHop' | 'form', string>>;

const EMPTY: Form = { network: '', mask: '', via: 'address', nextHop: '', exit: '' };

function parseRoute(form: Form, routes: readonly StaticRoute[]): Result<NewRoute, Errors> {
  const errors: Errors = {};
  const network = Ipv4Address.safeParse(form.network.trim());
  if (!form.network.trim()) errors.network = 'Enter the destination network';
  else if (!network.success) errors.network = 'Invalid IPv4 address';
  const mask = form.mask.trim() ? parseMask(form.mask.trim()) : err('Enter a subnet mask');
  if (!mask.ok) errors.mask = mask.error;

  let nextHop: NewRoute['nextHop'] | undefined;
  if (form.via === 'address') {
    const address = Ipv4Address.safeParse(form.nextHop.trim());
    if (!form.nextHop.trim()) errors.nextHop = 'Enter the next-hop address';
    else if (!address.success) errors.nextHop = 'Invalid IPv4 address';
    else nextHop = { kind: 'address', address: address.data };
  } else if (!form.exit) {
    errors.nextHop = 'Pick an exit interface';
  } else {
    nextHop = { kind: 'interface', interface: form.exit as InterfaceId };
  }

  if (!network.success || !mask.ok || !nextHop) return err(errors);
  const prefix = { address: network.data, prefixLength: mask.value };
  const base = networkOf(prefix);
  if (base !== prefix.address) {
    return err({ network: `Host bits are set for this mask. The network is ${base}` });
  }
  const route = { prefix, nextHop };
  if (routes.some((existing) => routeLine(existing) === routeLine(route))) {
    return err({ form: 'This route already exists' });
  }
  return ok(route);
}

const interfacesOf = (device: RouterDevice): InterfaceId[] => [
  ...device.ports.map((port) => port.id),
  ...(Object.keys(device.config.virtualInterfaces) as InterfaceId[]),
];

const viaLabel = ({ nextHop }: StaticRoute) =>
  nextHop.kind === 'address' ? nextHop.address : shortPortName(nextHop.interface as PortId);

export function RoutesSection({ device }: { device: RouterDevice }) {
  const { staticRoutes } = device.config;
  const ios = useSectionIos(device.id);
  const [form, setForm] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const [removeError, setRemoveError] = useState<string>();
  const id = useId();

  const edit = (patch: Partial<Form>) => {
    const next = { ...form, ...patch };
    setForm(next);
    setErrors({});
    const parsed = parseRoute(next, staticRoutes);
    ios.setPending(parsed.ok ? addRouteLines(parsed.value) : undefined);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseRoute(form, staticRoutes);
    if (!parsed.ok) return setErrors(parsed.error);
    const refused = ios.commit(addRouteLines(parsed.value));
    if (refused) return setErrors({ form: refused });
    setForm(EMPTY);
  };

  return (
    <ConfigSection
      title="Static routes"
      summary={staticRoutes.length === 0 ? 'None' : String(staticRoutes.length)}
    >
      {staticRoutes.length > 0 && (
        <ul aria-label="Static routes" className="flex flex-col rounded-md border border-line">
          {staticRoutes.map((route) => {
            const name = `${formatCidr(route.prefix)} via ${viaLabel(route)}`;
            return (
              <li
                key={routeLine(route)}
                aria-label={name}
                className="flex h-8 items-center gap-2 border-b border-line pr-1 pl-2.5 text-xs last:border-b-0"
              >
                <Mono className="min-w-0 truncate text-fg-1">{formatCidr(route.prefix)}</Mono>
                <ArrowRightIcon aria-hidden="true" className="size-3 shrink-0 text-fg-3" />
                <Mono className="min-w-0 flex-1 truncate text-fg-2">{viaLabel(route)}</Mono>
                {route.distance !== undefined && (
                  <span className="text-2xs text-fg-3" title="Administrative distance">
                    AD {route.distance}
                  </span>
                )}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove route ${name}`}
                  className="size-6 [&_svg:not([class*='size-'])]:size-3.5"
                  onClick={() => setRemoveError(ios.commit(removeRouteLines(route)))}
                >
                  <XIcon />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {removeError && (
        <p role="alert" className="text-2xs text-err">
          {removeError}
        </p>
      )}
      <form aria-label="Add a static route" onSubmit={submit} className="flex flex-col gap-2.5">
        <div className="grid grid-cols-2 gap-2">
          <Field
            id={`${id}-network`}
            label="Network"
            value={form.network}
            error={errors.network}
            placeholder="10.0.0.0"
            onChange={(network) => edit({ network })}
          />
          <Field
            id={`${id}-mask`}
            label="Mask"
            value={form.mask}
            error={errors.mask}
            placeholder={classfulMask(form.network) ?? '255.0.0.0'}
            onChange={(mask) => edit({ mask })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-2xs text-fg-3">Send to</span>
            <Segmented
              label="Send to"
              value={form.via}
              onValueChange={(via) => edit({ via })}
              options={[
                { value: 'address', label: 'Next hop' },
                { value: 'interface', label: 'Exit interface' },
              ]}
              className="h-6 [&>button]:px-1.5 [&>button]:text-2xs"
            />
          </div>
          {form.via === 'address' ? (
            <Field
              id={`${id}-next-hop`}
              label="Next-hop address"
              value={form.nextHop}
              error={errors.nextHop}
              placeholder="192.168.1.2"
              onChange={(nextHop) => edit({ nextHop })}
            />
          ) : (
            <div className="flex flex-col gap-1">
              <label htmlFor={`${id}-exit`} className="text-2xs text-fg-3">
                Exit interface
              </label>
              <Select
                id={`${id}-exit`}
                value={form.exit}
                aria-invalid={errors.nextHop !== undefined}
                onChange={(event) => edit({ exit: event.target.value })}
                className="font-mono text-[0.6875rem]"
              >
                <option value="">Pick an interface</option>
                {interfacesOf(device).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
              {errors.nextHop && <p className="text-2xs text-err">{errors.nextHop}</p>}
            </div>
          )}
        </div>
        {errors.form && (
          <p role="alert" className="text-2xs text-err">
            {errors.form}
          </p>
        )}
        <div className="flex justify-end">
          <Button size="sm" type="submit">
            Add route
          </Button>
        </div>
      </form>
      <IosPreview ios={ios} hostname={device.config.hostname} />
    </ConfigSection>
  );
}
