import type { PingEvent, SimMode } from '@/engine/api';
import type { SimClient } from '@/engine/client';
import type { EventId, FrameEvent } from '@/engine/events';
import type { Device, DeviceId, Ipv4Address } from '@/model';
import { editorStore } from '@/model/store';
import { protocolOf, type ProtocolId } from './protocols';
import {
  currentFrames,
  receiveBatch,
  simulationStore,
  type Pdu,
  type PduStatus,
  type PlaySpeed,
  type SimulationState,
} from './store';
import { createTraffic } from './traffic';

/** Steps per second at 1×: a cross-router ping's 16 hops play in 8 s. */
export const STEPS_PER_SECOND = 2;
/** How long a step's packets take to slide one hop when stepping by hand. */
export const SLIDE_MS = 450;

/** The chips the canvas overlay draws, fed by the engine's batches and the current moment. */
export const traffic = createTraffic();

let client: SimClient | undefined;

const set = (partial: Partial<SimulationState>) => simulationStore.setState(partial);
const get = () => simulationStore.getState();

const isFrame = (event: { kind: string }): event is FrameEvent => event.kind === 'frame';

function slideMs({ playing, speed }: SimulationState) {
  if (!playing) return SLIDE_MS;
  return Math.min(SLIDE_MS, (0.8 * 1000) / (STEPS_PER_SECOND * speed));
}

/** Shows the moment on screen: what a step brought slides in, what a step back undid slides out. */
function showMoment(state: SimulationState, previous: SimulationState) {
  if (state.mode !== previous.mode) traffic.clear();
  if (state.mode !== 'simulation') return;
  const moved =
    state.mode !== previous.mode ||
    state.frames !== previous.frames ||
    state.now !== previous.now ||
    state.head !== previous.head;
  if (!moved) return;
  const current = currentFrames(state);
  const wall = performance.now();
  if (state.head > previous.head) {
    traffic.showMoment(
      {
        arriving: current.filter((event) => event.id > previous.head),
        resting: current.filter((event) => event.id <= previous.head),
        leaving: [],
      },
      wall,
      slideMs(state),
    );
  } else if (state.head < previous.head) {
    const undone = currentFrames(previous).filter((event) => event.id > state.head);
    traffic.showMoment({ arriving: [], resting: current, leaving: undone }, wall, slideMs(state));
  } else {
    traffic.showMoment({ arriving: [], resting: current, leaving: [] }, wall, slideMs(state));
  }
}

/** Follows the client's batches until the returned function is called. */
export function connectSimulation(next: SimClient): () => void {
  client = next;
  if (get().mode === 'simulation') void next.sim.setMode('simulation');
  const stopBatches = next.onBatch((batch) => {
    const state = get();
    set(receiveBatch(state, batch));
    if (batch.mode !== 'realtime' || state.mode !== 'realtime' || !state.showTraffic) return;
    const frames = batch.events
      .filter(isFrame)
      .filter((event) => !state.hidden.includes(protocolOf(event.frame)));
    if (frames.length > 0) traffic.addRealtime(frames, performance.now());
  });
  const stopMoments = simulationStore.subscribe(showMoment);
  return () => {
    stopBatches();
    stopMoments();
    if (client === next) client = undefined;
  };
}

function playAt(speed: PlaySpeed) {
  void client?.sim.play(STEPS_PER_SECOND * speed);
}

/** The first IPv4 address a device answers on, which the PDU tool sends to. */
export function deviceAddress(device: Device): Ipv4Address | undefined {
  switch (device.kind) {
    case 'pc':
    case 'server':
      return device.config.ipv4.mode === 'static' ? device.config.ipv4.address?.address : undefined;
    case 'router':
      return Object.values(device.config.interfaces).find((iface) => iface?.ipv4 && !iface.shutdown)
        ?.ipv4?.address;
    case 'switch':
      return undefined;
  }
}

function pduProblem(device: Device, role: 'source' | 'destination'): string | undefined {
  const name = device.config.hostname;
  if (device.kind === 'switch') return `${name} is a switch. Pick a PC, server or router.`;
  if (!device.powered) return `${name} is powered off.`;
  if (role === 'destination' && !deviceAddress(device)) return `${name} has no IPv4 address yet.`;
  return undefined;
}

function settlePdu(id: number, status: PduStatus) {
  set({
    pdus: get().pdus.map((pdu) =>
      pdu.id === id && pdu.status === 'in flight' ? { ...pdu, status } : pdu,
    ),
  });
}

let nextPdu = 1;

function sendPdu(source: DeviceId, destination: DeviceId, target: Ipv4Address) {
  const id = nextPdu++;
  const pdu: Pdu = { id, source, destination, status: 'in flight' };
  set({ pdus: [...get().pdus, pdu].slice(-20) });
  const listener = (event: PingEvent) => {
    if (event.kind === 'reply') settlePdu(id, 'successful');
    else if (event.kind !== 'summary') settlePdu(id, 'failed');
    else settlePdu(id, event.received > 0 ? 'successful' : 'failed');
  };
  void client?.ping(source, target, { count: 1, timeoutMs: 2000 }, listener).then((started) => {
    if (!started.ok) settlePdu(id, 'failed');
  });
}

/** What the timeline, the event list and the Add simple PDU tool do. */
export const simulation = {
  setMode(mode: SimMode) {
    if (mode === get().mode) return;
    set(
      mode === 'simulation'
        ? { mode, playing: false, frames: [], selected: undefined, canStepBack: false }
        : { mode, pdu: { step: 'off' } },
    );
    void client?.sim.setMode(mode);
  },
  step() {
    set({ playing: false });
    void client?.sim.step();
  },
  stepBack() {
    set({ playing: false });
    void client?.sim.stepBack();
  },
  togglePlay() {
    const { playing, speed } = get();
    set({ playing: !playing });
    if (playing) void client?.sim.pause();
    else playAt(speed);
  },
  setSpeed(speed: PlaySpeed) {
    set({ speed });
    if (get().playing) playAt(speed);
  },
  toggleProtocol(protocol: ProtocolId) {
    const { hidden } = get();
    set({
      hidden: hidden.includes(protocol)
        ? hidden.filter((other) => other !== protocol)
        : [...hidden, protocol],
    });
  },
  select(event: EventId | undefined) {
    set({ selected: event, focusRequest: get().focusRequest + 1 });
  },
  setShowTraffic(showTraffic: boolean) {
    if (!showTraffic) traffic.clear();
    set({ showTraffic });
  },
  startPdu() {
    set({ pdu: { step: 'source' } });
  },
  cancelPdu() {
    set({ pdu: { step: 'off' } });
  },
  /** A click on a device while the tool is on: the source first, then the destination. */
  pickPduDevice(id: DeviceId) {
    const { pdu } = get();
    const device = editorStore.getState().topology.devices[id];
    if (pdu.step === 'off' || !device) return;
    if (pdu.step === 'source') {
      const problem = pduProblem(device, 'source');
      set({ pdu: problem ? { step: 'source', problem } : { step: 'destination', source: id } });
      return;
    }
    const problem =
      id === pdu.source
        ? 'Pick a different device as the destination.'
        : pduProblem(device, 'destination');
    const target = deviceAddress(device);
    if (problem || !target) {
      set({ pdu: { ...pdu, problem } });
      return;
    }
    set({ pdu: { step: 'off' } });
    sendPdu(pdu.source, id, target);
  },
};
