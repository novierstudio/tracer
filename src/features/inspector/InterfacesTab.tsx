import { Switch } from 'radix-ui';
import { useId, useState, type FormEvent } from 'react';
import { formatSubnetMask, type Device, type Ipv4Cidr, type PortId, type Topology } from '@/model';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';
import { setRouterAddress, setShutdown } from './actions';
import { classfulMask, formatCidr, parseInterfaceAddress, type AddressErrors } from './ipv4';
import { Field } from './Field';
import { Mono, PeerButton, STATE_LABELS, StateDot } from './parts';
import { portRows, shortPortName, type PortRow } from './view';

export function InterfacesTab({ device, topology }: { device: Device; topology: Topology }) {
  const [editing, setEditing] = useState<PortId | null>(null);
  return (
    <ul aria-label="Interfaces" className="flex flex-col">
      {portRows(topology, device).map((row) => (
        <InterfaceRow
          key={row.id}
          row={row}
          device={device}
          editing={editing === row.id}
          onEdit={(open) => setEditing(open ? row.id : null)}
        />
      ))}
    </ul>
  );
}

/**
 * Two lines per port, so a 300px panel never truncates an address:
 * name, link partner and admin switch; then address (or VLAN) and MAC.
 */
function InterfaceRow({
  row,
  device,
  editing,
  onEdit,
}: {
  row: PortRow;
  device: Device;
  editing: boolean;
  onEdit: (open: boolean) => void;
}) {
  const short = shortPortName(row.id);
  return (
    <li
      aria-label={short}
      className={cn(
        'flex flex-col gap-1 border-b border-line px-3 py-2 text-xs',
        editing && 'bg-surface-2/60',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex w-[4.5rem] shrink-0 items-center gap-2" title={row.id}>
          <StateDot state={row.state} />
          <Mono className="font-medium text-fg-1">{short}</Mono>
          <span className="sr-only">{STATE_LABELS[row.state]}</span>
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {row.peer ? (
            <>
              <span aria-hidden="true" className="text-fg-3">
                →
              </span>
              <PeerButton device={row.peer.device} port={row.peer.port} />
            </>
          ) : (
            <span className="text-fg-3">free</span>
          )}
        </span>
        {row.admin && (
          <Switch.Root
            aria-label={`${short} enabled`}
            title={row.admin === 'up' ? 'no shutdown' : 'shutdown'}
            checked={row.admin === 'up'}
            onCheckedChange={(on) => setShutdown(device, row.id, !on)}
            className="relative inline-flex h-4 w-7 shrink-0 cursor-default items-center rounded-full bg-surface-3 transition-colors duration-150 data-[state=checked]:bg-ok/80"
          >
            <Switch.Thumb className="block size-3 translate-x-0.5 rounded-full bg-surface-1 shadow-xs transition-transform duration-150 data-[state=checked]:translate-x-3.5" />
          </Switch.Root>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-2 pl-4">
        <span className="min-w-0 flex-1">
          <AddressCell row={row} editing={editing} onEdit={() => onEdit(!editing)} short={short} />
        </span>
        {row.mac && <Mono className="shrink-0 text-[0.625rem] text-fg-3">{row.mac}</Mono>}
      </div>
      {editing && (
        <AddressEditor
          row={row}
          onDone={() => onEdit(false)}
          onSave={(cidr) => setRouterAddress(device, row.id, cidr)}
        />
      )}
    </li>
  );
}

function AddressCell({
  row,
  editing,
  onEdit,
  short,
}: {
  row: PortRow;
  editing: boolean;
  onEdit: () => void;
  short: string;
}) {
  if (row.layer === 'switched') return <span className="text-fg-2">{row.vlan}</span>;
  const text = row.ipv4 ? formatCidr(row.ipv4) : null;
  if (row.layer === 'host') {
    return text ? (
      <Mono className="text-fg-1">{text}</Mono>
    ) : (
      <span className="text-fg-3">No address</span>
    );
  }
  return (
    <button
      type="button"
      onClick={onEdit}
      aria-label={`Edit ${short} IP address`}
      aria-expanded={editing}
      className="-mx-1 -my-0.5 max-w-full cursor-default truncate rounded-sm px-1 py-0.5 text-left hover:bg-surface-3"
    >
      {text ? (
        <Mono className="text-fg-1">{text}</Mono>
      ) : (
        <span className="text-fg-3">Set IP address</span>
      )}
    </button>
  );
}

function AddressEditor({
  row,
  onSave,
  onDone,
}: {
  row: PortRow;
  onSave: (cidr: Ipv4Cidr | undefined) => void;
  onDone: () => void;
}) {
  const initial = row.layer !== 'switched' && row.ipv4 ? row.ipv4 : undefined;
  const [address, setAddress] = useState<string>(initial?.address ?? '');
  const [mask, setMask] = useState(initial ? formatSubnetMask(initial.prefixLength) : '');
  const [errors, setErrors] = useState<AddressErrors>({});
  const id = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = parseInterfaceAddress(address, mask);
    if (!result.ok) return setErrors(result.error);
    onSave(result.value);
    onDone();
  };

  return (
    <form
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onDone();
        }
      }}
      aria-label={`${shortPortName(row.id)} IP address`}
      className="mt-1 flex flex-col gap-2"
    >
      <div className="grid grid-cols-2 gap-2">
        <Field
          id={`${id}-address`}
          label="IP address"
          value={address}
          error={errors.address}
          placeholder="192.168.1.1"
          autoFocus
          onChange={(value) => {
            setAddress(value);
            setErrors((e) => ({ ...e, address: undefined }));
          }}
        />
        <Field
          id={`${id}-mask`}
          label="Subnet mask"
          value={mask}
          error={errors.mask}
          placeholder={classfulMask(address) ?? '255.255.255.0'}
          onChange={(value) => {
            setMask(value);
            setErrors((e) => ({ ...e, mask: undefined }));
          }}
        />
      </div>
      <div className="flex items-center justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit">
          Save
        </Button>
      </div>
    </form>
  );
}
