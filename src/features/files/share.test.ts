import { describe, expect, it } from 'vitest';
import { buildLab } from '@/model/testing';
import { decodeLab, encodeLab } from './share';
import { LONG_LINK_CHARS, SHARE_PREFIX } from './sharing';
import { classroomLab } from './testLabs';

describe('share links', () => {
  it('round-trips a 20-device lab exactly, in URL-safe characters', () => {
    const lab = classroomLab(16);
    expect(Object.keys(lab.devices)).toHaveLength(20);
    const data = encodeLab(lab);
    expect(data).toMatch(/^[\w-]+$/);
    expect(decodeLab(data)).toEqual({ ok: true, value: lab });
  });

  it("carries the lab's spanning tree timers setting", () => {
    const lab = {
      ...buildLab().topology,
      settings: { stpTimers: 'ios' as const, routingTimers: 'fast' as const },
    };
    expect(decodeLab(encodeLab(lab))).toEqual({ ok: true, value: lab });
  });

  it('keeps a 20-device lab under the long-link warning', () => {
    const url = `https://novierstudio.github.io/tracer/${SHARE_PREFIX}${encodeLab(classroomLab(16))}`;
    expect(url.length).toBeLessThan(LONG_LINK_CHARS);
  });

  it('explains a link that was cut off', () => {
    const data = encodeLab(buildLab().topology);
    expect(decodeLab(data.slice(0, Math.floor(data.length / 2)))).toMatchObject({
      ok: false,
      error: {
        title: "Couldn't open the shared lab",
        message: expect.stringMatching(/incomplete or damaged/),
      },
    });
  });

  it('explains a link that is not base64', () => {
    expect(decodeLab('not a lab!')).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/incomplete or damaged/) },
    });
  });

  it('explains an empty link', () => {
    expect(decodeLab('')).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/no lab/) },
    });
  });

  it('refuses a link whose lab fails validation', () => {
    const { topology } = buildLab();
    const broken = { ...topology, meta: { ...topology.meta, createdAt: 'yesterday' } };
    expect(decodeLab(encodeLab(broken))).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/not valid/), detail: expect.any(String) },
    });
  });
});
