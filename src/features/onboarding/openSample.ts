import { fileSession } from '@/features/files/session';
import type { SampleLab } from '@/labs/catalog';
import { onboarding } from './store';

/**
 * Opens a sample through the same path as a `.tracer.json` the user picks, so the lab is validated,
 * autosaved under a new id, and the lab it replaces stays in Recent labs.
 */
export async function openSample(lab: SampleLab) {
  let text: string;
  try {
    // Each opening is a new lab, created now. The canvas also fits the view to a new createdAt.
    const file = JSON.parse(await lab.load()) as object;
    const stamp = new Date().toISOString();
    text = JSON.stringify({
      ...file,
      meta: { name: lab.title, createdAt: stamp, updatedAt: stamp },
    });
  } catch {
    fileSession.state.setState({
      problem: {
        title: `Couldn't open “${lab.title}”`,
        message: 'The sample lab did not download. Check your connection and try again.',
      },
    });
    return;
  }
  onboarding.startChecklist(lab.id);
  await fileSession.openFile(
    new File([text], `${lab.id}.tracer.json`, { type: 'application/json' }),
  );
  onboarding.closeGallery();
  onboarding.releaseWelcome();
}
