/// <reference types="node" />
// Decrypts real Packet Tracer files. Point PKT_SAMPLES_DIR at a folder of .pkt / .pka files to
// run it, and set PKT_XML_OUT to also write each decrypted XML there. Skipped when unset.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decryptPkt } from './codec';

const samplesDir = process.env.PKT_SAMPLES_DIR;
const xmlOut = process.env.PKT_XML_OUT;
const files = samplesDir
  ? readdirSync(samplesDir)
      .filter((name) => /\.pk[ta]$/i.test(name))
      .sort()
  : [];

describe.runIf(samplesDir)('local samples in PKT_SAMPLES_DIR', () => {
  it.each(files)('%s decrypts to well-formed Packet Tracer XML', (name) => {
    const bytes = readFileSync(join(samplesDir!, name));
    const start = performance.now();
    const result = decryptPkt(bytes);
    const ms = performance.now() - start;
    if (!result.ok) throw new Error(`${name}: ${JSON.stringify(result.error)}`);

    const doc = new DOMParser().parseFromString(result.xml, 'application/xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    // .pka activity files wrap the network in <PACKETTRACER5_ACTIVITY>.
    expect(doc.documentElement.nodeName).toMatch(/^PACKETTRACER5(_ACTIVITY)?$/);

    const version = doc.querySelector('VERSION')?.textContent;
    console.log(
      [name, bytes.length, result.format, version, result.xml.length, ms.toFixed(1)].join('\t'),
    );
    if (xmlOut) writeFileSync(join(xmlOut, `${name}.xml`), result.xml);
  });
});
