// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { AnnotationId, type Annotation, type Topology } from '@/model';
import { createAnnotationMapper, NEW_ANNOTATION_ID } from './flow';

const id = (name: string) => AnnotationId.parse(`ann_${name}`);

const building: Annotation = {
  id: id('building'),
  kind: 'area',
  position: { x: 0, y: 0 },
  size: { width: 640, height: 400 },
  label: 'Building A',
  color: 'blue',
};
const vlan: Annotation = {
  id: id('vlan'),
  kind: 'area',
  position: { x: 32, y: 48 },
  size: { width: 256, height: 160 },
  label: 'VLAN 10',
  color: 'green',
};
const ellipse: Annotation = {
  id: id('cloud'),
  kind: 'shape',
  shape: 'ellipse',
  position: { x: 700, y: 0 },
  size: { width: 160, height: 96 },
  color: 'slate',
};
const note: Annotation = {
  id: id('note'),
  kind: 'note',
  position: { x: 0, y: 420 },
  text: 'Uplink',
  width: 192,
  color: 'amber',
};

// Insertion order on purpose: the small area first, as if "VLAN 10" were drawn before its building.
const annotations: Topology['annotations'] = {
  [note.id]: note,
  [vlan.id]: vlan,
  [ellipse.id]: ellipse,
  [building.id]: building,
};

describe('annotation layers', () => {
  const toNodes = createAnnotationMapper();
  const nodes = toNodes(annotations, new Set(), undefined, undefined);

  it('draws area boxes behind links, which React Flow draws at z 0', () => {
    const z = Object.fromEntries(nodes.map((node) => [node.id, node.zIndex]));
    expect(z[building.id]).toBeLessThan(0);
    expect(z[vlan.id]).toBeLessThan(0);
    expect(z[note.id]).toBe(0);
    expect(z[ellipse.id]).toBe(0);
  });

  it('puts the larger of two areas behind the smaller, and areas before everything else', () => {
    expect(nodes.map((node) => node.id)).toEqual([building.id, vlan.id, note.id, ellipse.id]);
  });

  it('keeps a draft being typed on top of the other annotations', () => {
    const draft = {
      kind: 'text',
      position: { x: 0, y: 0 },
      text: '',
      textSize: 'large',
      color: 'slate',
    } as const;
    const withDraft = toNodes(annotations, new Set(), undefined, draft);
    expect(withDraft.at(-1)).toMatchObject({ id: NEW_ANNOTATION_ID, type: 'text', zIndex: 0 });
    expect(withDraft.at(-1)?.data.editing).toBe(true);
  });

  it('sizes frames from the lab, so React Flow never has to measure them', () => {
    const area = nodes.find((node) => node.id === building.id);
    expect(area).toMatchObject({ width: 640, height: 400, position: { x: 0, y: 0 } });
  });
});
